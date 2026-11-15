/**
 * 国内个人网盘原生驱动的共享工具。
 *
 * 四家网盘（天翼 / 移动 / 联通 / 阿里）都没有官方开放存储 API，只有 Web 端
 * 私有接口。共同点：
 *
 *   - 都是「目录 + 文件名」的树形命名空间，而 Cloudreve 的实体键是
 *     `2026/11/1_name.ext` 这种路径，所以每个驱动都要把路径逐段解析成
 *     目录 ID（带 isolate 级缓存，避免每次上传都重走一遍）。
 *   - 上传都是「分片 + 直传预签名地址」，分片大小由对端约定，且部分协议
 *     要求全文件哈希（天翼 MD5、移动 SHA-256）。
 *   - 下载地址短时效 + 防盗链，必须由 Worker 代理。
 *
 * 这里只放与具体网盘无关的东西：路径换算、流式切片、哈希、加解密、
 * Cookie 合并。驱动本身在 cloud189.ts / yun139.ts / wopan.ts /
 * aliyundrive.ts。
 */
// 按需引入 crypto-js：只带真正用到的算法（MD5 / SHA-256 / SHA-1 / HMAC / AES）。
// 全量 `import CryptoJS from 'crypto-js'` 会把 216 KB 的自包含大文件整个打进
// Worker 包（含 DES / Blowfish / Rabbit / RC4 / SHA3 等完全用不到的算法），
// 白白增加包体积与冷启动解析 CPU。各子模块会把自己挂载到共享的 core 上，
// 而 @types/crypto-js 的 core.d.ts 类型即完整命名空间，因此 `Core.AES` 等
// 用法无需改动。
import Core from 'crypto-js/core';
import 'crypto-js/md5';
import 'crypto-js/sha256';
import 'crypto-js/sha1';
import 'crypto-js/hmac';
import 'crypto-js/aes';
import 'crypto-js/mode-ecb';
// CBC 定义在 cipher-core.js 里（aes.js 已依赖，无需单独引）。
import 'crypto-js/pad-pkcs7';
import 'crypto-js/enc-base64';

/** 浏览器 UA：几家网盘的 CDN 对非浏览器 UA 直接 403。 */
export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

/** 归一化策略里填的根路径：`foo//bar/` → `/foo/bar`，空 → `/`。 */
export function normalizeRoot(raw: string | null | undefined): string {
  const parts = (raw ?? '')
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== '.' && s !== '..');
  return parts.length ? `/${parts.join('/')}` : '/';
}

/** 对象键（`2026/11/x.jpg`）→ 远端绝对路径（`/root/2026/11/x.jpg`）。 */
export function remotePathOf(root: string, source: string): string {
  const parts = source
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== '.' && s !== '..');
  if (!parts.length) throw new Error('netdisk: empty object key');
  const base = root === '/' ? '' : root;
  return `${base}/${parts.join('/')}`;
}

/** 只取对象键的安全分段（不含根路径），用于逐段解析。 */
export function segmentsOf(source: string): string[] {
  return source
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== '.' && s !== '..');
}

export function parentOf(path: string): { dir: string; name: string } {
  const idx = path.lastIndexOf('/');
  return { dir: idx > 0 ? path.slice(0, idx) : '/', name: path.slice(idx + 1) };
}

export function joinPath(...parts: string[]): string {
  return `/${parts
    .join('/')
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean)
    .join('/')}`;
}

/** 逐段编码（保留斜杠），用于 CDN 直链。 */
export function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

// ---------------------------------------------------------------------------
// 流式分片读取
// ---------------------------------------------------------------------------

/**
 * 把 `ReadableStream` 按固定大小切片的读取器。
 *
 * 为什么不 `new Response(stream).arrayBuffer()`：上传上限 95 MB，整块进内存
 * 会顶到 Worker 128 MB 的内存上限（并发两个就 1102）。这里只在内存里保留
 * 一个分片。
 */
export class PartReader {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private pending: Uint8Array = new Uint8Array(0);
  private done = false;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }

  /** 读满 `size` 字节；流结束时返回实际读到的（可能更短或空）。 */
  async read(size: number): Promise<Uint8Array> {
    if (size <= 0) return new Uint8Array(0);
    const out = new Uint8Array(size);
    let filled = 0;

    if (this.pending.length) {
      const take = Math.min(this.pending.length, size);
      out.set(this.pending.subarray(0, take), 0);
      this.pending = this.pending.subarray(take);
      filled = take;
    }

    while (filled < size && !this.done) {
      const { value, done } = await this.reader.read();
      if (done) {
        this.done = true;
        break;
      }
      if (!value || value.length === 0) continue;
      const take = Math.min(value.length, size - filled);
      out.set(value.subarray(0, take), filled);
      filled += take;
      if (take < value.length) this.pending = value.subarray(take);
    }

    return filled === size ? out : out.subarray(0, filled);
  }

  /** 读剩余全部内容（用于小文件），超过 cap 抛错。 */
  async readRemaining(cap: number): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const chunk = await this.read(256 * 1024);
      if (!chunk.length) break;
      total += chunk.length;
      if (total > cap) {
        await this.cancel();
        throw new Error(`netdisk: object exceeds in-memory limit (${cap} bytes)`);
      }
      chunks.push(chunk);
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }

  async cancel(): Promise<void> {
    try {
      await this.reader.cancel();
    } catch {
      // 取消失败不影响主流程
    }
  }
}

/** 读取整个流（有上限保护），用于必须整块处理的小对象。 */
export async function readStreamCapped(
  stream: ReadableStream<Uint8Array>,
  cap: number,
): Promise<Uint8Array> {
  return new PartReader(stream).readRemaining(cap);
}

// ---------------------------------------------------------------------------
// 哈希（crypto-js，纯 JS，可在 Workers 运行）
// ---------------------------------------------------------------------------

function bytesToWordArray(bytes: Uint8Array): Core.lib.WordArray {
  const words: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    words[i >>> 2] |= bytes[i] << (24 - (i % 4) * 8);
  }
  return Core.lib.WordArray.create(words, bytes.length);
}

export function md5Hex(data: Uint8Array | string): string {
  return Core.MD5(typeof data === 'string' ? data : bytesToWordArray(data)).toString(
    Core.enc.Hex,
  );
}

export function md5Base64(data: Uint8Array | string): string {
  return Core.MD5(typeof data === 'string' ? data : bytesToWordArray(data)).toString(
    Core.enc.Base64,
  );
}

/** 增量 MD5：天翼云盘 commit 时要整文件 MD5，但文件是流式过的。 */
export class Md5Stream {
  private hasher = Core.algo.MD5.create();

  update(bytes: Uint8Array): void {
    if (bytes.length) this.hasher.update(bytesToWordArray(bytes));
  }

  hex(): string {
    return this.finalize().toString(Core.enc.Hex);
  }

  private finalize(): Core.lib.WordArray {
    // finalize() 会清空内部状态，重复调用需要重新喂数据，故这里只允许一次
    return this.hasher.finalize();
  }
}

/** 增量 SHA-256：移动云盘 create 时要整文件 SHA-256。 */
export class Sha256Stream {
  private hasher = Core.algo.SHA256.create();

  update(bytes: Uint8Array): void {
    if (bytes.length) this.hasher.update(bytesToWordArray(bytes));
  }

  hex(): string {
    return this.hasher.finalize().toString(Core.enc.Hex);
  }
}

// ---------------------------------------------------------------------------
// 加解密
// ---------------------------------------------------------------------------

/** AES-128-ECB + PKCS7，输出十六进制（天翼云盘上传参数加密）。 */
export function aes128EcbHex(text: string, key16: string): string {
  const key = Core.enc.Utf8.parse(key16.slice(0, 16));
  const encrypted = Core.AES.encrypt(Core.enc.Utf8.parse(text), key, {
    mode: Core.mode.ECB,
    padding: Core.pad.Pkcs7,
  });
  return encrypted.ciphertext.toString(Core.enc.Hex);
}

/** AES-CBC + PKCS7（联通云盘 param 加解密）。 */
export function aesCbcEncryptBase64(text: string, key: string, iv: string): string {
  const encrypted = Core.AES.encrypt(Core.enc.Utf8.parse(text), Core.enc.Utf8.parse(key), {
    iv: Core.enc.Utf8.parse(iv),
    mode: Core.mode.CBC,
    padding: Core.pad.Pkcs7,
  });
  return encrypted.toString();
}

export function aesCbcDecryptBase64(cipher: string, key: string, iv: string): string {
  const decrypted = Core.AES.decrypt(cipher, Core.enc.Utf8.parse(key), {
    iv: Core.enc.Utf8.parse(iv),
    mode: Core.mode.CBC,
    padding: Core.pad.Pkcs7,
  });
  return decrypted.toString(Core.enc.Utf8);
}

export function hmacSha1Hex(data: string, key: string): string {
  return Core.HmacSHA1(data, key).toString(Core.enc.Hex);
}

// ---- RSA PKCS#1 v1.5（天翼登录与上传公钥）----
// WebCrypto 不支持 PKCS#1 v1.5 加密，crypto-js 也没有 RSA，这里用 BigInt 实现。

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function bytesToHexStr(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let res = 0n;
  for (let i = 0; i < bytes.length; i++) res = (res << 8n) | BigInt(bytes[i]);
  return res;
}

function bigIntToBytes(num: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let t = num;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(t & 0xffn);
    t >>= 8n;
  }
  return out;
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let res = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e % 2n === 1n) res = (res * b) % mod;
    b = (b * b) % mod;
    e /= 2n;
  }
  return res;
}

function parseRsaPublicKey(pemOrB64: string): { n: bigint; e: bigint; keyLength: number } {
  const clean = pemOrB64
    .replace(/-----BEGIN[^-]+-----/g, '')
    .replace(/-----END[^-]+-----/g, '')
    .replace(/\s+/g, '');
  const der = b64ToBytes(clean);
  const integers: Uint8Array[] = [];

  const scan = (start: number, end: number) => {
    let p = start;
    while (p < end) {
      const tag = der[p++];
      let len = der[p++];
      if (len & 0x80) {
        const n = len & 0x7f;
        len = 0;
        for (let i = 0; i < n; i++) len = (len << 8) | der[p++];
      }
      const dataStart = p;
      p += len;
      if (tag === 0x02) {
        let intData = der.subarray(dataStart, dataStart + len);
        if (intData[0] === 0x00 && intData.length > 1) intData = intData.subarray(1);
        integers.push(intData);
      } else if (tag === 0x30 || (tag & 0x20) !== 0) {
        scan(dataStart, dataStart + len);
      } else if (tag === 0x03) {
        if (der[dataStart] === 0) scan(dataStart + 1, dataStart + len);
      }
    }
  };
  scan(0, der.length);

  if (integers.length < 2) throw new Error('netdisk: cannot parse RSA public key');
  let nBytes = integers[0];
  let eBytes = integers[1];
  if (nBytes.length < eBytes.length) [nBytes, eBytes] = [eBytes, nBytes];
  return { n: bytesToBigInt(nBytes), e: bytesToBigInt(eBytes), keyLength: nBytes.length };
}

/** RSA PKCS#1 v1.5 加密。`toHex` 为真时输出小写十六进制，否则 base64。 */
export function rsaPkcs1Encode(data: string | Uint8Array, pubKeyPem: string, toHex = false): string {
  const { n, e, keyLength } = parseRsaPublicKey(pubKeyPem);
  const dataBytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  if (dataBytes.length > keyLength - 11) {
    throw new Error(`netdisk: RSA payload too long (${dataBytes.length} > ${keyLength - 11})`);
  }
  const psLength = keyLength - dataBytes.length - 3;
  const ps = new Uint8Array(psLength);
  const rnd = new Uint8Array(psLength * 2);
  crypto.getRandomValues(rnd);
  let idx = 0;
  for (let i = 0; i < psLength; i++) {
    let b = rnd[idx++];
    while (b === 0) {
      if (idx >= rnd.length) {
        crypto.getRandomValues(rnd);
        idx = 0;
      }
      b = rnd[idx++];
    }
    ps[i] = b;
  }
  const em = new Uint8Array(keyLength);
  em[0] = 0x00;
  em[1] = 0x02;
  em.set(ps, 2);
  em[2 + psLength] = 0x00;
  em.set(dataBytes, 3 + psLength);

  const cipher = bigIntToBytes(modPow(bytesToBigInt(em), e, n), keyLength);
  return toHex ? bytesToHexStr(cipher) : bytesToB64(cipher);
}

// ---------------------------------------------------------------------------
// Cookie / JSON / 杂项
// ---------------------------------------------------------------------------

/** 简易 Cookie 罐：接受 Set-Cookie 合并进当前 Cookie 串。 */
export class CookieJar {
  private value: string;

  constructor(initial = '') {
    this.value = initial.trim();
  }

  get(): string {
    return this.value;
  }

  /** 清空（Cookie 失效、需要重新登录时用）。 */
  clear(): void {
    this.value = '';
  }

  private set(key: string, val: string): void {
    const parts = this.value ? this.value.split(';').map((s) => s.trim()) : [];
    const idx = parts.findIndex((p) => p.startsWith(`${key}=`));
    const entry = `${key}=${val}`;
    if (idx >= 0) parts[idx] = entry;
    else parts.push(entry);
    this.value = parts.filter(Boolean).join('; ');
  }

  absorb(headers: Headers): void {
    const withGet = headers as Headers & { getSetCookie?: () => string[] };
    const list =
      typeof withGet.getSetCookie === 'function'
        ? withGet.getSetCookie()
        : (() => {
            const raw = headers.get('set-cookie');
            return raw ? [raw] : [];
          })();
    for (const entry of list) {
      // 一条 Set-Cookie 里可能用逗号并列多个 cookie（老网关行为）
      for (const piece of entry.split(/,(?=\s*[A-Za-z0-9_\-]+=[^;]+)/)) {
        const main = piece.split(';')[0].trim();
        const eq = main.indexOf('=');
        if (eq > 0) this.set(main.slice(0, eq).trim(), main.slice(eq + 1).trim());
      }
    }
  }
}

/**
 * 天翼云盘的文件 ID 是 18 位以上数字，JSON.parse 会丢精度。
 * 解析前把 `"id": 1234567890123456789` 变成字符串。
 */
export function parseJsonKeepBigIds(text: string): unknown {
  const protectedText = text.replace(/("id"\s*:\s*)(-?\d{16,})(?=\s*[,}])/g, '$1"$2"');
  return JSON.parse(protectedText);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 生成 n 位随机字母数字串。 */
export function randomAlnum(n: number): string {
  const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < n; i++) out += charset[bytes[i] % charset.length];
  return out;
}

/** 生成 UUID v4 样式的随机串（天翼上传接口要求）。 */
export function randomUuid(): string {
  return crypto.randomUUID();
}

/** 解析 `Content-Range: bytes 0-99/12345` 的总长度。 */
export function totalFromContentRange(value: string | null): number {
  if (!value) return 0;
  const total = Number(value.split('/')[1]);
  return Number.isFinite(total) ? total : 0;
}
