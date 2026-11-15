/**
 * 天翼云盘（189）原生驱动。
 *
 * 协议来源：Cloudreve 生态里长期在用的 Web 端私有接口（与 OpenList / AList
 * 的 `189Cloud`、`189CloudPC` 驱动同源）：
 *
 *   列表    GET  /api/open/file/listFiles.action?folderId=..
 *   建目录  POST /api/open/file/createFolder.action
 *   直链    GET  /api/portal/getFileInfo.action?fileId=..
 *   删除    POST /api/open/batch/createBatchTask.action {type:DELETE}
 *   上传    upload.cloud.189.cn 的 `/person/initMultiUpload` →
 *           `/person/getMultiUploadUrls` → PUT 预签名地址 →
 *           `/person/commitMultiUploadFile`
 *
 * 上传接口的每个请求都要：
 *   - `params` = 按 key 排序后的 query，用随机 16 位 key 做 AES-128-ECB 加密成 hex；
 *   - `Signature` = HMAC-SHA1(`SessionKey=..&Operate=GET&RequestURI=..&Date=..&params=..`)；
 *   - `EncryptionText` = 用服务端 RSA 公钥加密该随机 key；
 *   - `PkId` / `SessionKey` / `X-Request-Date` / `X-Request-ID` 头。
 * 这套东西在 Worker 里全部可算（crypto-js + BigInt RSA），无需外部服务。
 *
 * 鉴权：优先用管理员填的浏览器 Cookie；没填则用账号密码走
 * open.e.189.cn 的 OAuth2 登录。账号密码登录可能触发滑块/设备锁，
 * 那时接口会返回「验证码」类错误，驱动会提示改用 Cookie。
 *
 * 策略字段映射：
 *   access_key          → 天翼账号（手机号/邮箱）
 *   secret_key          → 密码
 *   settings.c189_cookie→ 浏览器 Cookie（推荐，最稳）
 *   bucket_name         → 根目录路径（如 /cloudreve，不存在会自动建）
 *   settings.c189_root_folder_id → 根目录 ID，默认 -11（个人云根）
 */
import type { StoragePolicyRow } from '../../db/types';
import { assertSafeRemoteUrl, safeFetch } from '../../lib/ssrf';
import type {
  DriverCapabilities,
  GetSourceArgs,
  ObjectContent,
  StorageDriver,
  UploadCredential,
  UploadRequest,
  UploadSession,
  UploadedPart,
} from '../types';
import {
  BROWSER_UA,
  CookieJar,
  Md5Stream,
  PartReader,
  aes128EcbHex,
  hmacSha1Hex,
  joinPath,
  md5Base64,
  md5Hex,
  normalizeRoot,
  parseJsonKeepBigIds,
  randomUuid,
  remotePathOf,
  rsaPkcs1Encode,
  segmentsOf,
  totalFromContentRange,
} from './common';

const ROOT_DEFAULT = '-11';
/** 天翼云盘固定 10 MB 分片（initMultiUpload 的 sliceSize 必须与实际一致）。 */
const SLICE_SIZE = 10 * 1024 * 1024;
const UA = BROWSER_UA;

interface C189File {
  id: string | number;
  name: string;
  size?: number;
  lastOpTime?: string;
}

interface C189Folder {
  id: string | number;
  name: string;
}

interface C189UploadSession {
  cookie: CookieJar;
  sessionKey: string;
  rsa: { pubKey: string; pkId: string; expire: number };
}

/** isolate 级会话缓存：避免每个请求都重新登录（不消耗 KV 写配额）。 */
const sessions = new Map<string, C189UploadSession>();

export class Cloud189Driver implements StorageDriver {
  readonly type: string;
  readonly chunkSize: number;
  readonly settings;

  private readonly jar: CookieJar;
  private readonly username: string;
  private readonly password: string;
  private readonly rootPath: string;
  private readonly rootFolderId: string;
  private readonly cacheKey: string;
  /** 路径 → 目录 ID，仅本请求有效（驱动实例按请求创建）。 */
  private readonly dirCache = new Map<string, string>();

  constructor(readonly policy: StoragePolicyRow) {
    this.type = policy.type;
    this.settings = policy.settings ?? {};
    // 全中转：客户端把整个文件作为 index=0 交给 Worker，驱动内部再切片上云。
    this.chunkSize = 0;

    this.username = (policy.access_key ?? '').trim();
    this.password = (policy.secret_key ?? '').trim();
    this.rootPath = normalizeRoot(policy.bucket_name);
    this.rootFolderId = (this.settings.c189_root_folder_id ?? '').trim() || ROOT_DEFAULT;
    this.cacheKey = `189:${policy.id}`;

    const cached = sessions.get(this.cacheKey);
    const cookie = (this.settings.c189_cookie ?? '').trim();
    this.jar = new CookieJar(cookie || cached?.cookie.get() || '');
    if (!this.jar.get() && !(this.username && this.password)) {
      throw new Error(
        `天翼云盘策略「${policy.name}」缺少凭据：请填 settings.c189_cookie（浏览器 Cookie），` +
          '或 access_key/secret_key（账号密码）',
      );
    }
  }

  capabilities(): DriverCapabilities {
    return {
      proxyRequired: true,
      uploadSentinelRequired: true,
      maxSourceExpire: 0,
      thumbSupportedExts: [],
      thumbSupportAllExts: false,
      thumbMaxSize: 0,
      // 直链的 Content-Disposition 由天翼下发，带不上我们的文件名
      directUrlFilename: false,
    };
  }

  static invalidate(policyId: number): void {
    sessions.delete(`189:${policyId}`);
  }

  // -------------------------------------------------------------------------
  // 会话
  // -------------------------------------------------------------------------

  private session(): C189UploadSession {
    let s = sessions.get(this.cacheKey);
    if (!s) {
      s = { cookie: this.jar, sessionKey: '', rsa: { pubKey: '', pkId: '', expire: 0 } };
      sessions.set(this.cacheKey, s);
    }
    s.cookie = this.jar;
    return s;
  }

  private baseHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json;charset=UTF-8',
      Referer: 'https://cloud.189.cn/',
      'User-Agent': UA,
      ...extra,
    };
    const cookie = this.jar.get();
    if (cookie) headers.Cookie = cookie;
    return headers;
  }

  /** 跟随 30x，同时合并 Set-Cookie；用于登录流程。 */
  private async follow(url: string, headers: Record<string, string>): Promise<string> {
    let current = url;
    for (let hop = 0; hop <= 8; hop++) {
      const res = await safeFetch(current, {
        method: 'GET',
        headers: { ...headers, ...(this.jar.get() ? { Cookie: this.jar.get() } : {}) },
      });
      this.jar.absorb(res.headers);
      await res.body?.cancel().catch(() => {});
      const location = res.headers.get('location');
      const isRedirect = res.status >= 300 && res.status < 400;
      if (!isRedirect || !location) return current;
      const next = new URL(location, current);
      assertSafeRemoteUrl(next.toString());
      current = next.toString();
    }
    return current;
  }

  /** 账号密码登录（可能触发验证码）；失败信息里会提示改用 Cookie。 */
  private async login(): Promise<void> {
    const loginUrl =
      'https://cloud.189.cn/api/portal/loginUrl.action?redirectURL=' +
      encodeURIComponent('https://cloud.189.cn/main.action');

    const landing = await this.follow(loginUrl, {
      'User-Agent': UA,
      Referer: 'https://cloud.189.cn/',
    });
    if (/cloud\.189\.cn\/(web\/main|main\.action)/.test(landing)) return; // 已登录

    let landingUrl: URL;
    try {
      landingUrl = new URL(landing, 'https://open.e.189.cn');
    } catch {
      throw new Error('天翼云盘登录跳转地址无效，请改用 Cookie 方式');
    }
    const lt = landingUrl.searchParams.get('lt') || '';
    const reqId = landingUrl.searchParams.get('reqId') || '';
    const appId = landingUrl.searchParams.get('appId') || 'cloud';
    if (!lt || !reqId) {
      throw new Error('天翼云盘登录参数缺失（lt / reqId），请改用 Cookie 方式');
    }

    const authHeaders: Record<string, string> = {
      'User-Agent': UA,
      lt,
      reqid: reqId,
      referer: landing,
      origin: 'https://open.e.189.cn',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Accept: 'application/json;charset=UTF-8',
    };

    const confRes = await safeFetch('https://open.e.189.cn/api/logbox/oauth2/appConf.do', {
      method: 'POST',
      headers: this.baseHeaders(authHeaders),
      body: new URLSearchParams({ version: '2.0', appKey: appId }).toString(),
    });
    this.jar.absorb(confRes.headers);
    const appConf = (await confRes.json().catch(() => ({}))) as {
      result?: string;
      msg?: string;
      data?: Record<string, string | number | boolean>;
    };
    if (appConf.result !== '0' || !appConf.data) {
      throw new Error(`天翼云盘 appConf 获取失败：${appConf.msg ?? 'unknown'}`);
    }

    const encRes = await safeFetch('https://open.e.189.cn/api/logbox/config/encryptConf.do', {
      method: 'POST',
      headers: this.baseHeaders(authHeaders),
      body: new URLSearchParams({ appId }).toString(),
    });
    this.jar.absorb(encRes.headers);
    const encConf = (await encRes.json().catch(() => ({}))) as {
      result?: number;
      data?: { pubKey?: string; pre?: string };
    };
    if (encConf.result !== 0 || !encConf.data?.pubKey) {
      throw new Error('天翼云盘 encryptConf 获取失败（未拿到 RSA 公钥）');
    }
    const pre = encConf.data.pre || '';
    const pubKey = encConf.data.pubKey;

    const params: Record<string, string> = {
      version: 'v2.0',
      apToken: '',
      appKey: appId,
      accountType: String(appConf.data.accountType ?? '01'),
      userName: pre + rsaPkcs1Encode(this.username, pubKey, true),
      epd: pre + rsaPkcs1Encode(this.password, pubKey, true),
      captchaType: '',
      validateCode: '',
      smsValidateCode: '',
      captchaToken: '',
      returnUrl: String(appConf.data.returnUrl ?? 'https://cloud.189.cn/main.action'),
      mailSuffix: String(appConf.data.mailSuffix ?? '@189.cn'),
      dynamicCheck: 'FALSE',
      clientType: String(appConf.data.clientType ?? '10010'),
      cb_SaveName: '3',
      isOauth2: String(appConf.data.isOauth2 ?? false),
      state: '',
      paramId: String(appConf.data.paramId ?? ''),
    };

    const loginRes = await safeFetch('https://open.e.189.cn/api/logbox/oauth2/loginSubmit.do', {
      method: 'POST',
      headers: this.baseHeaders(authHeaders),
      body: new URLSearchParams(params).toString(),
    });
    this.jar.absorb(loginRes.headers);
    const loginData = (await loginRes.json().catch(() => ({}))) as {
      result?: number;
      msg?: string;
      toUrl?: string;
    };
    if (loginData.result !== 0) {
      const msg = loginData.msg ?? '登录失败';
      if (/验证码|滑块|设备锁/.test(msg)) {
        throw new Error(`天翼云盘登录触发验证码/设备保护（${msg}）。请在浏览器登录 cloud.189.cn 后复制 Cookie 填入策略。`);
      }
      throw new Error(`天翼云盘登录失败：${msg}`);
    }
    if (loginData.toUrl) {
      await this.follow(loginData.toUrl, { 'User-Agent': UA });
    }
    if (!this.jar.get()) {
      throw new Error('天翼云盘登录后未获得 Cookie，请改用 Cookie 方式');
    }
  }

  private async ensureLogin(): Promise<void> {
    if (this.jar.get()) return;
    await this.login();
  }

  /** 普通 API：带 Cookie + noCache，SessionKey 失效时重新登录一次。 */
  private async api<T>(
    url: string,
    options: {
      method?: 'GET' | 'POST';
      params?: Record<string, string>;
      body?: Record<string, string>;
      retry?: boolean;
    } = {},
  ): Promise<T> {
    await this.ensureLogin();
    const target = new URL(url);
    target.searchParams.set('noCache', `0.${Math.floor(Math.random() * 1e17)}`);
    for (const [k, v] of Object.entries(options.params ?? {})) target.searchParams.set(k, v);

    const headers = this.baseHeaders();
    let reqBody: string | undefined;
    if (options.body) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
      reqBody = new URLSearchParams(options.body).toString();
    }

    const res = await safeFetch(target.toString(), {
      method: options.method ?? 'GET',
      headers,
      body: reqBody,
    });
    this.jar.absorb(res.headers);
    const text = await res.text();
    let data: Record<string, unknown>;
    try {
      data = parseJsonKeepBigIds(text) as Record<string, unknown>;
    } catch {
      throw new Error(`天翼云盘返回非 JSON（HTTP ${res.status}）：${text.slice(0, 160)}`);
    }

    const invalidSession =
      data.errorCode === 'InvalidSessionKey' ||
      data.res_code === 'InvalidSessionKey' ||
      String(data.res_code) === '1010';
    if (invalidSession) {
      if (options.retry !== false && this.username && this.password) {
        // 配了账号密码：清掉 Cookie 重新登录一次再重试
        this.jar.clear();
        sessions.delete(this.cacheKey);
        await this.login();
        return this.api<T>(url, { ...options, retry: false });
      }
      sessions.delete(this.cacheKey);
      throw new Error('天翼云盘登录会话已失效（InvalidSessionKey），请更新 Cookie 或账号密码');
    }
    if (data.errorCode) {
      throw new Error(`天翼云盘 API 错误：${String(data.errorMsg ?? data.errorCode)}`);
    }
    if (!res.ok) {
      throw new Error(`天翼云盘 HTTP ${res.status}：${String(data.res_message ?? '')}`);
    }
    if (data.res_code !== undefined && String(data.res_code) !== '0') {
      throw new Error(`天翼云盘 API 错误：${String(data.res_message ?? data.res_code)}`);
    }
    return data as T;
  }

  // ---- 上传接口的签名/加密 ----

  private async sessionKey(): Promise<string> {
    const s = this.session();
    if (s.sessionKey) return s.sessionKey;
    const resp = await this.api<{ sessionKey?: string }>(
      'https://cloud.189.cn/v2/getUserBriefInfo.action',
    );
    const key = String(resp.sessionKey ?? '');
    if (!key) throw new Error('天翼云盘获取上传 SessionKey 失败');
    s.sessionKey = key;
    return key;
  }

  private async rsaKey(): Promise<{ pubKey: string; pkId: string }> {
    const s = this.session();
    if (s.rsa.pubKey && s.rsa.pkId && s.rsa.expire > Date.now()) return s.rsa;
    const resp = await this.api<{ pubKey?: string; pkId?: string; expire?: number }>(
      'https://cloud.189.cn/api/security/generateRsaKey.action',
    );
    const pubKey = String(resp.pubKey ?? '');
    const pkId = String(resp.pkId ?? '');
    if (!pubKey || !pkId) throw new Error('天翼云盘获取上传 RSA 公钥失败');
    s.rsa = { pubKey, pkId, expire: Number(resp.expire) || Date.now() + 5 * 60_000 };
    return s.rsa;
  }

  private async uploadApi<T = Record<string, unknown>>(
    uri: string,
    form: Record<string, string>,
  ): Promise<T> {
    const sessionKey = await this.sessionKey();
    const requestDate = String(Date.now());
    const randomKey = randomUuid() + randomUuid();
    const key16 = randomKey.slice(0, 16);
    const params = Object.keys(form)
      .sort()
      .map((k) => `${k}=${form[k]}`)
      .join('&');
    const encryptedParams = aes128EcbHex(params, key16);
    const signature = hmacSha1Hex(
      `SessionKey=${sessionKey}&Operate=GET&RequestURI=${uri}&Date=${requestDate}&params=${encryptedParams}`,
      randomKey,
    );
    const { pubKey, pkId } = await this.rsaKey();

    const headers: Record<string, string> = {
      accept: 'application/json;charset=UTF-8',
      SessionKey: sessionKey,
      Signature: signature,
      'X-Request-Date': requestDate,
      'X-Request-ID': randomUuid(),
      EncryptionText: rsaPkcs1Encode(randomKey, pubKey, false),
      PkId: pkId,
      'User-Agent': UA,
      Referer: 'https://cloud.189.cn/',
    };
    const cookie = this.jar.get();
    if (cookie) headers.Cookie = cookie;

    const res = await safeFetch(`https://upload.cloud.189.cn${uri}?params=${encryptedParams}`, {
      method: 'GET',
      headers,
    });
    this.jar.absorb(res.headers);
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`天翼云盘上传接口 HTTP ${res.status}：${text.slice(0, 160)}`);
    }
    let data: Record<string, unknown>;
    try {
      data = parseJsonKeepBigIds(text) as Record<string, unknown>;
    } catch {
      throw new Error(`天翼云盘上传接口返回非 JSON：${text.slice(0, 160)}`);
    }
    if (String(data.code ?? '') !== 'SUCCESS') {
      throw new Error(`天翼云盘上传接口失败：${String(data.msg ?? data.message ?? uri)}`);
    }
    return data as T;
  }

  // -------------------------------------------------------------------------
  // 目录 / 文件解析
  // -------------------------------------------------------------------------

  private async listFolder(folderId: string): Promise<{ files: C189File[]; folders: C189Folder[] }> {
    const out = { files: [] as C189File[], folders: [] as C189Folder[] };
    for (let page = 1; page <= 50; page++) {
      const resp = await this.api<{
        fileListAO?: { count?: number; fileList?: C189File[]; folderList?: C189Folder[] };
      }>('https://cloud.189.cn/api/open/file/listFiles.action', {
        params: {
          pageSize: '60',
          pageNum: String(page),
          mediaType: '0',
          folderId,
          iconOption: '5',
          orderBy: 'lastOpTime',
          descending: 'true',
        },
      });
      const ao = resp.fileListAO;
      if (!ao || !Array.isArray(ao.fileList) || !Array.isArray(ao.folderList)) {
        throw new Error('天翼云盘文件列表响应缺少 fileListAO');
      }
      out.files.push(...ao.fileList);
      out.folders.push(...ao.folderList);
      const count = Number(ao.count ?? 0);
      if (count === 0 || ao.fileList.length + ao.folderList.length < 60) break;
    }
    return out;
  }

  private async createFolder(parentId: string, name: string): Promise<string> {
    const resp = await this.api<{ id?: string | number; folder?: { id?: string | number } }>(
      'https://cloud.189.cn/api/open/file/createFolder.action',
      {
        method: 'POST',
        body: { parentFolderId: parentId, folderName: name },
      },
    );
    const id = resp.id ?? resp.folder?.id;
    if (id === undefined || id === null) throw new Error(`天翼云盘创建目录失败：${name}`);
    return String(id);
  }

  /** 逐段解析路径为目录 ID；不存在则创建。 */
  private async resolveDir(segments: string[]): Promise<string> {
    let current = this.rootFolderId;
    let key = '';
    for (const seg of segments) {
      key += `/${seg}`;
      const cached = this.dirCache.get(key);
      if (cached) {
        current = cached;
        continue;
      }
      const { folders } = await this.listFolder(current);
      const hit = folders.find((f) => f.name === seg);
      current = hit ? String(hit.id) : await this.createFolder(current, seg);
      this.dirCache.set(key, current);
    }
    return current;
  }

  private async resolveFile(path: string): Promise<{ id: string; size: number } | null> {
    const segs = segmentsOf(path);
    if (!segs.length) return null;
    const name = segs.pop()!;
    const parentId = await this.resolveDir(segs);
    const { files } = await this.listFolder(parentId);
    const hit = files.find((f) => f.name === name);
    return hit ? { id: String(hit.id), size: Number(hit.size ?? 0) } : null;
  }

  private async downloadUrl(fileId: string): Promise<string> {
    const resp = await this.api<{ fileDownloadUrl?: string; downloadUrl?: string }>(
      'https://cloud.189.cn/api/portal/getFileInfo.action',
      { params: { fileId } },
    );
    const raw = resp.fileDownloadUrl ?? resp.downloadUrl ?? '';
    if (!raw) throw new Error(`天翼云盘未返回下载地址（fileId=${fileId}）`);
    return raw.startsWith('//') ? `https:${raw}` : raw.replace(/^http:\/\//i, 'https://');
  }

  // -------------------------------------------------------------------------
  // 上传
  // -------------------------------------------------------------------------

  private async initUpload(
    parentId: string,
    name: string,
    size: number,
  ): Promise<{ uploadFileId: string; exists: boolean; sessionKey: string }> {
    const sessionKey = await this.sessionKey();
    const base = {
      parentFolderId: parentId,
      fileName: encodeURIComponent(name).replace(/%20/g, '+'),
      fileSize: String(size),
      sliceSize: String(SLICE_SIZE),
    };
    // lazyCheck=1：跳过服务端对 fileMd5 的强校验，init 阶段不需要整文件 MD5。
    // 提交阶段仍带真实 MD5，保证秒传/校验语义正确。
    const resp = await this.uploadApi<{ data?: { uploadFileId?: string; fileDataExists?: string } }>(
      '/person/initMultiUpload',
      { ...base, lazyCheck: '1' },
    );
    const uploadFileId = String(resp.data?.uploadFileId ?? '');
    if (!uploadFileId) throw new Error('天翼云盘创建上传会话失败（缺少 uploadFileId）');
    return {
      uploadFileId,
      exists: String(resp.data?.fileDataExists ?? '0') === '1',
      sessionKey,
    };
  }

  private async uploadPart(
    uploadFileId: string,
    partNumber: number,
    bytes: Uint8Array,
  ): Promise<string> {
    const resp = await this.uploadApi<{
      uploadUrls?: Record<string, { requestURL?: string; requestHeader?: string }>;
    }>('/person/getMultiUploadUrls', {
      partInfo: `${partNumber}-${md5Base64(bytes)}`,
      uploadFileId,
    });
    const part = resp.uploadUrls?.[`partNumber_${partNumber}`];
    if (!part?.requestURL) {
      throw new Error(`天翼云盘获取第 ${partNumber} 片上传地址失败`);
    }
    const headers: Record<string, string> = {};
    if (part.requestHeader) {
      let decoded = part.requestHeader;
      try {
        decoded = decodeURIComponent(decoded);
      } catch {
        // 保持原样
      }
      for (const kv of decoded.split('&')) {
        const eq = kv.indexOf('=');
        if (eq > 0) headers[kv.slice(0, eq)] = kv.slice(eq + 1);
      }
    }
    assertSafeRemoteUrl(part.requestURL);
    const res = await fetch(part.requestURL, { method: 'PUT', headers, body: bytes as unknown as BodyInit });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`天翼云盘上传第 ${partNumber} 片失败：HTTP ${res.status} ${text.slice(0, 120)}`);
    }
    await res.body?.cancel().catch(() => {});
    return md5Base64(bytes);
  }

  private async uploadStream(
    parentId: string,
    name: string,
    stream: ReadableStream,
    size: number,
  ): Promise<void> {
    const init = await this.initUpload(parentId, name, size);
    if (init.exists) return; // 秒传：服务端已有同内容文件，无需再传

    const reader = new PartReader(stream as ReadableStream<Uint8Array>);
    const partMd5: string[] = [];
    // 增量 MD5：整文件 MD5 要在提交时给出，但文件是流式过的。
    const whole = new Md5Stream();
    let index = 1;
    let received = 0;
    for (;;) {
      const chunk = await reader.read(SLICE_SIZE);
      if (!chunk.length) break;
      received += chunk.length;
      whole.update(chunk);
      const partMd5B64 = await this.uploadPart(init.uploadFileId, index, chunk);
      partMd5.push(partMd5B64);
      index++;
      if (chunk.length < SLICE_SIZE) break;
    }
    if (received !== size) {
      throw new Error(`天翼云盘上传字节数不符：收到 ${received}，应为 ${size}`);
    }
    const fileMd5 = whole.hex();
    const partHexes = partMd5.map((b64) => {
      const bin = atob(b64);
      let hex = '';
      for (let i = 0; i < bin.length; i++) hex += bin.charCodeAt(i).toString(16).padStart(2, '0');
      return hex;
    });
    // sliceMd5：单分片就是文件 MD5；多分片是「各分片 MD5 十六进制按行拼接」的 MD5（大写）
    const sliceMd5 =
      partHexes.length <= 1 ? fileMd5 : md5HexUpper(partHexes.join('\n'));

    await this.uploadApi('/person/commitMultiUploadFile', {
      uploadFileId: init.uploadFileId,
      fileMd5,
      sliceMd5,
      lazyCheck: '1',
      opertype: '3',
    });
  }

  // -------------------------------------------------------------------------
  // StorageDriver
  // -------------------------------------------------------------------------

  async token(session: UploadSession, _file: UploadRequest): Promise<UploadCredential> {
    return {
      session_id: session.id,
      chunk_size: 0,
      expires: Math.floor(session.expireAt / 1000),
    };
  }

  async writeChunk(
    session: UploadSession,
    _index: number,
    body: ReadableStream,
    length: number,
  ): Promise<UploadedPart | null> {
    await this.put(
      {
        savePath: session.savePath,
        fileName: '',
        size: length,
        mimeType: session.mimeType,
        overwrite: true,
      },
      body,
      length,
    );
    return null;
  }

  async completeUpload(_session: UploadSession): Promise<void> {
    // 上传在 writeChunk 内一次完成
  }

  async cancelToken(session: UploadSession): Promise<void> {
    try {
      await this.remove([session.savePath]);
    } catch {
      // 上传可能还没落地
    }
  }

  async put(file: UploadRequest, body: ReadableStream, contentLength: number): Promise<void> {
    const path = remotePathOf(this.rootPath, file.savePath);
    const segs = segmentsOf(path);
    const name = segs.pop()!;
    const parentId = await this.resolveDir(segs);
    if (!file.overwrite) {
      const existing = await this.resolveFile(path);
      if (existing) throw new Error('Object existed');
    }
    await this.uploadStream(parentId, name, body, contentLength || file.size);
  }

  async get(source: string, range?: string | null): Promise<ObjectContent | null> {
    const path = remotePathOf(this.rootPath, source);
    const resolved = await this.resolveFile(path);
    if (!resolved) return null;
    const url = await this.downloadUrl(resolved.id);
    const headers: Record<string, string> = { 'User-Agent': UA, Referer: 'https://cloud.189.cn/' };
    const cookie = this.jar.get();
    if (cookie) headers.Cookie = cookie;
    if (range) headers.Range = range;

    const res = await safeFetch(url, { headers });
    if (res.status === 404 || res.status === 416) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`天翼云盘下载失败：HTTP ${res.status}`);
    }
    const contentRange = res.headers.get('content-range');
    let size = Number(res.headers.get('content-length') ?? 0);
    const total = totalFromContentRange(contentRange);
    if (total) size = total;
    if (!Number.isFinite(size) || size <= 0) size = resolved.size;
    return {
      body: res.body!,
      size,
      contentType: res.headers.get('content-type') ?? undefined,
      contentRange,
    };
  }

  async meta(source: string): Promise<{ size: number } | null> {
    const resolved = await this.resolveFile(remotePathOf(this.rootPath, source));
    return resolved ? { size: resolved.size } : null;
  }

  async remove(sources: string[]): Promise<void> {
    for (const src of sources) {
      const path = remotePathOf(this.rootPath, src);
      const segs = segmentsOf(path);
      const name = segs.pop()!;
      const parentId = await this.resolveDir(segs);
      const { files } = await this.listFolder(parentId);
      const hit = files.find((f) => f.name === name);
      if (!hit) continue;
      await this.api('https://cloud.189.cn/api/open/batch/createBatchTask.action', {
        method: 'POST',
        body: {
          type: 'DELETE',
          targetFolderId: '',
          taskInfos: JSON.stringify([{ fileId: String(hit.id), fileName: hit.name, isFolder: 0 }]),
        },
      });
    }
  }

  async delete(sources: string[]): Promise<string[]> {
    const failed: string[] = [];
    for (const src of sources) {
      try {
        await this.remove([src]);
      } catch {
        failed.push(src);
      }
    }
    return failed;
  }

  async source(source: string, _args: GetSourceArgs): Promise<string> {
    const resolved = await this.resolveFile(remotePathOf(this.rootPath, source));
    if (!resolved) throw new Error(`天翼云盘文件不存在：${source}`);
    return this.downloadUrl(resolved.id);
  }

  async list(
    prefix: string,
    options: { continuation?: string; afterKey?: string; limit?: number } = {},
  ): Promise<{
    keys: { key: string; size: number; lastModified: Date }[];
    continuation: string | null;
  }> {
    const dir = prefix ? remotePathOf(this.rootPath, prefix) : this.rootPath;
    const folderId = await this.resolveDir(segmentsOf(dir));
    const { files } = await this.listFolder(folderId);
    const limit = Math.min(1000, Math.max(1, options.limit ?? 200));
    const keys = files
      .slice(0, limit)
      .map((f) => ({
        key: prefix ? joinPath(prefix, f.name).replace(/^\//, '') : f.name,
        size: Number(f.size ?? 0),
        lastModified: f.lastOpTime ? new Date(f.lastOpTime) : new Date(),
      }))
      .filter((k) => !options.afterKey || k.key > options.afterKey);
    return { keys, continuation: null };
  }

  async thumb(): Promise<string | null> {
    return null;
  }

  async setCors(): Promise<void> {
    // 全中转，无需 CORS
  }

  /** 供后台「连接测试」使用：登录 + 读一次根目录。 */
  async probe(): Promise<void> {
    await this.ensureLogin();
    await this.listFolder(this.rootFolderId);
  }
}

/** 与大写 MD5 拼接语义一致的工具（sliceMd5 需要大写）。 */
function md5HexUpper(text: string): string {
  return md5Hex(text).toUpperCase();
}
