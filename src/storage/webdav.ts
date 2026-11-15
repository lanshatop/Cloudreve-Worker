/**
 * WebDAV 存储驱动（原生实现，不需要 OpenList / AList 之类的网桥）。
 *
 * 为什么可以原生做：WebDAV 是 RFC 4918 开放标准，只用普通 HTTP 方法；
 * Cloudflare Workers 的 Request 支持除 CONNECT 之外的所有方法，因此
 * PROPFIND / MKCOL / MOVE 可以直接由 fetch 发出。项目里已有的
 * `src/routes/dav.ts` 是**服务端**（让客户端挂载 Cloudreve 空间），
 * 本文件是**客户端**（把远程 WebDAV 当存储后端），两者互不相干。
 *
 * 协议映射：
 *   PUT       <root>/<key>               上传（Overwrite: T/F，二进制请求体）
 *   MKCOL     <root>/<dir>              逐级创建父目录，405/409 视为已存在
 *   PROPFIND  Depth: 0 / 1              元信息、单层列举（解析 multistatus XML）
 *   GET       Range: ...                下载，Range 与 206 原样透传
 *   HEAD                                 对象大小；不支持时回退 PROPFIND
 *   DELETE    <root>/<key>             删除，404 视为幂等成功
 *
 * 策略字段映射（复用 Cloudreve 既有列，不新增 migration）：
 *   policy.server        → WebDAV 服务地址，如 https://dav.example.com/remote.php/dav/files/me/
 *   policy.bucket_name   → 服务地址之下的挂载子目录，如 /cloudreve（可留空）
 *   policy.access_key    → Basic 用户名
 *   policy.secret_key    → Basic 密码 / 应用专用密码
 *   settings.token       → Bearer Token（可选，优先级高于 Basic）
 *   settings.dav_headers → 自定义请求头对象（可选，可覆盖 User-Agent 等）
 *   settings.dav_skip_probe → 新建策略时跳过连接测试
 *
 * 上传形态与 UpyunDriver / 网盘原生驱动一致：token() 返回 chunk_size: 0，
 * 整个文件作为 index=0 经 Worker 中转。区别在于**这里不把请求体缓冲成
 * Uint8Array**，而是把 ReadableStream 直接交给 fetch 流式转发 —— 免费档
 * Worker 只有 128 MB 内存，缓冲一个接近 100 MB 的文件会 OOM。代价是 PUT
 * 不能跟随重定向（流不可重放），所以服务地址必须填最终地址（含尾斜杠），
 * 驱动会在遇到 3xx 时给出明确报错。
 *
 * 认证只支持 Basic / Bearer。Digest 需要 challenge-response 多轮往返，
 * 且绝大多数现代服务（Nextcloud / 坚果云 / AList / 群晖）都提供 Basic 或
 * 应用密码，故不实现。Workers 出站要求公网可信证书，自签证书连不上。
 */
import type { PolicySetting, StoragePolicyRow } from '../db/types';
import { assertSafeRemoteUrl, safeFetch } from '../lib/ssrf';
import {
  type DriverCapabilities,
  type GetSourceArgs,
  type ObjectContent,
  type StorageDriver,
  type UploadCredential,
  type UploadRequest,
  type UploadSession,
  type UploadedPart,
} from './types';

/** PROPFIND 请求体：只取列举 / 元信息需要的属性，避免服务端返回大 XML。 */
const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<D:propfind xmlns:D="DAV:"><D:prop>' +
  '<D:displayname/><D:getcontentlength/><D:getlastmodified/><D:resourcetype/>' +
  '</D:prop></D:propfind>';

const DEFAULT_UA = 'Cloudreve-Worker-WebDAV/1.0';

/** isolate 级目录缓存：同一 Worker 实例里不必为每个文件重发 MKCOL。 */
const l1Dirs = new Set<string>();

interface DavEntry {
  href: string;
  size: number;
  lastModified: Date | null;
  isCollection: boolean;
}

/** 把对象键拆成安全的路径段：滤掉空段、`.`、`..`，反斜杠按分隔符处理。 */
function safeSegments(raw: string): string[] {
  return String(raw ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s !== '' && s !== '.' && s !== '..');
}

/** 逐段解码 URL 路径，避免 `%2F` 被误当成目录分隔符。 */
function decodePath(pathname: string): string {
  return pathname
    .split('/')
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    })
    .join('/');
}

/**
 * 极简 multistatus 解析器。Workers 运行时没有 DOMParser，也不值得为一个
 * 导入用的列举功能引入 XML 依赖；这里按 RFC 4918 的固定结构做前缀无关匹配
 * （`D:` / `d:` / `lp1:` / 无前缀都认），只取 200 propstat 里的属性。
 */
export function parseMultistatus(xml: string): DavEntry[] {
  const tag = (name: string) => `(?:[A-Za-z_][\\w.-]*:)?${name}`;
  const blocks =
    xml.match(
      new RegExp(`<${tag('response')}\\b[^>]*>[\\s\\S]*?<\\/${tag('response')}\\s*>`, 'gi'),
    ) ?? [];
  const out: DavEntry[] = [];
  for (const block of blocks) {
    const hrefMatch = block.match(
      new RegExp(`<${tag('href')}\\b[^>]*>([\\s\\S]*?)<\\/${tag('href')}\\s*>`, 'i'),
    );
    if (!hrefMatch) continue;
    let href = hrefMatch[1]!.trim();
    try {
      href = decodeURIComponent(href);
    } catch {
      /* 原样保留 */
    }

    const propstats =
      block.match(
        new RegExp(`<${tag('propstat')}\\b[^>]*>[\\s\\S]*?<\\/${tag('propstat')}\\s*>`, 'gi'),
      ) ?? [];
    const good = propstats
      .filter((p) => new RegExp(`<${tag('status')}\\b[^>]*>[^<]*\\b200\\b`, 'i').test(p))
      .join('\n');
    // 服务端返回了 propstat 但没有任何 200 段 → 该资源的属性全部取不到，
    // 不能回退到整块（否则会把 404 段里的 getcontentlength 当真值）。
    if (propstats.length > 0 && !good) continue;
    // 有些服务不返回 propstat，直接把属性挂在 response 下
    const props = propstats.length > 0 ? good : block;

    const sizeMatch = props.match(
      new RegExp(`<${tag('getcontentlength')}\\b[^>]*>\\s*(\\d+)\\s*<`, 'i'),
    );
    const lmMatch = props.match(
      new RegExp(`<${tag('getlastmodified')}\\b[^>]*>([\\s\\S]*?)<`, 'i'),
    );
    let lastModified: Date | null = null;
    if (lmMatch) {
      const t = Date.parse(lmMatch[1]!.trim());
      if (Number.isFinite(t)) lastModified = new Date(t);
    }
    out.push({
      href,
      size: sizeMatch ? Number(sizeMatch[1]) : 0,
      lastModified,
      isCollection: new RegExp(`<${tag('collection')}\\s*\\/?\\s*>`, 'i').test(props),
    });
  }
  return out;
}

/** Basic 认证的 base64：先按 UTF-8 编码，避免中文用户名/密码直接 btoa 抛错。 */
function basicAuth(user: string, pass: string): string {
  const bytes = new TextEncoder().encode(`${user}:${pass}`);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `Basic ${btoa(bin)}`;
}

export interface WebDavProbeResult {
  ok: boolean;
  status: number;
  message: string;
  /** 对端返回的 DAV 头，用于判断 Class 1/2/3 支持程度 */
  dav?: string;
}

/** 供管理端在新建策略时做一次只读连通性探测，不需要落库。 */
export interface WebDavProbeConfig {
  server?: string | null;
  bucket_name?: string | null;
  access_key?: string | null;
  secret_key?: string | null;
  settings?: PolicySetting | Record<string, unknown> | null;
}

export class WebDavDriver implements StorageDriver {
  readonly type = 'webdav';
  /** 无 multipart / 无可追加分片协议：整个文件一次 PUT。 */
  readonly chunkSize = 0;
  readonly settings: PolicySetting;

  /** 服务地址，pathname 保证以 `/` 结尾，作为所有对象 URL 的前缀。 */
  private readonly base: URL;
  /** 挂载子目录的已解码路径段。 */
  private readonly rootSegs: string[];
  /** 根 URL 的 pathname（解码后），用于把 PROPFIND 的 href 换算成对象键。 */
  private readonly rootPath: string;
  private readonly authHeaders: Record<string, string>;
  private readonly customHeaders: Record<string, string>;
  private readonly cachePrefix: string;

  constructor(readonly policy: StoragePolicyRow) {
    this.settings = policy.settings ?? {};

    const raw = (policy.server ?? '').trim();
    if (!raw) throw new Error('WebDAV policy is missing the server URL');
    let base: URL;
    try {
      base = assertSafeRemoteUrl(raw.includes('://') ? raw : `https://${raw}`);
    } catch (e) {
      throw new Error(`Invalid WebDAV server URL: ${(e as Error).message}`);
    }
    // 统一以 / 结尾，后续直接拼接编码后的相对路径，避免相对 URL 解析吃掉最后一段
    if (!base.pathname.endsWith('/')) base.pathname = `${base.pathname}/`;
    // 凭据写在 URL 里会被 assertSafeRemoteUrl 拒绝，这里再清一遍 query/hash
    base.search = '';
    base.hash = '';
    this.base = base;
    this.rootSegs = safeSegments(policy.bucket_name ?? '');
    this.rootPath = decodePath(base.pathname) + this.rootSegs.join('/');

    const bearer = (this.settings.token ?? '').trim();
    if (bearer) {
      this.authHeaders = { Authorization: `Bearer ${bearer}` };
    } else {
      const user = (policy.access_key ?? '').trim();
      const pass = (policy.secret_key ?? '').trim();
      if (!user) throw new Error('WebDAV policy needs access_key (username) or settings.token (bearer)');
      this.authHeaders = { Authorization: basicAuth(user, pass) };
    }

    const extra = this.settings.dav_headers;
    this.customHeaders = {};
    if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
      for (const [k, v] of Object.entries(extra)) {
        if (/^[A-Za-z0-9-]+$/.test(k) && typeof v === 'string') this.customHeaders[k] = v;
      }
    }
    this.cachePrefix = `${policy.id}|${base.origin}${base.pathname}|`;
  }

  capabilities(): DriverCapabilities {
    return {
      // Basic / Bearer 凭据不能下发给浏览器，下载一律由 Worker 代理
      proxyRequired: true,
      uploadSentinelRequired: true,
      maxSourceExpire: 0,
      thumbSupportedExts: [],
      thumbSupportAllExts: false,
      thumbMaxSize: 0,
    };
  }

  // -------------------------------------------------------------------------
  // URL 与请求
  // -------------------------------------------------------------------------

  private urlFor(segs: string[]): string {
    const u = new URL(this.base.toString());
    u.pathname = u.pathname + segs.map((s) => encodeURIComponent(s)).join('/');
    return u.toString();
  }

  private objectUrl(key: string): string {
    return this.urlFor([...this.rootSegs, ...safeSegments(key)]);
  }

  /** 根路径 URL（不带对象键），PROPFIND 探测与列举都基于它。 */
  private rootUrl(): string {
    return this.urlFor(this.rootSegs);
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      'User-Agent': DEFAULT_UA,
      ...this.authHeaders,
      ...this.customHeaders,
      ...extra,
    };
  }

  private async request(
    method: string,
    url: string,
    extra: Record<string, string> = {},
    body?: string,
  ): Promise<Response> {
    return safeFetch(url, {
      method,
      headers: this.headers(extra),
      ...(body === undefined ? {} : { body }),
    });
  }

  private async drain(res: Response): Promise<void> {
    try {
      await res.body?.cancel();
    } catch {
      /* 忽略 */
    }
  }

  // -------------------------------------------------------------------------
  // 连接测试（管理端新建策略时调用）
  // -------------------------------------------------------------------------

  async probe(): Promise<WebDavProbeResult> {
    let res: Response;
    try {
      res = await this.request('PROPFIND', this.rootUrl(), {
        Depth: '0',
        'Content-Type': 'application/xml; charset=utf-8',
        Accept: 'application/xml, text/xml',
      }, PROPFIND_BODY);
    } catch (e) {
      return { ok: false, status: 0, message: `无法连接：${(e as Error).message}` };
    }
    const dav = res.headers.get('DAV') ?? undefined;
    await this.drain(res);
    if (res.status === 207 || res.status === 200) {
      return { ok: true, status: res.status, dav, message: '连接正常' };
    }
    const hints: Record<number, string> = {
      301: '服务地址发生重定向，请填写最终地址（注意结尾的 /）',
      302: '服务地址发生重定向，请填写最终地址（注意结尾的 /）',
      307: '服务地址发生重定向，请填写最终地址（注意结尾的 /）',
      308: '服务地址发生重定向，请填写最终地址（注意结尾的 /）',
      401: '认证失败：用户名 / 应用密码 / Bearer Token 不正确',
      403: '认证成功但无访问权限，检查账号权限与挂载路径',
      404: '根路径不存在：请在对端先创建该目录，或检查服务地址路径',
      405: '该地址不是 WebDAV 端点（不支持 PROPFIND）',
      409: '根路径的父目录不存在，请在对端创建',
      501: '该地址不是 WebDAV 端点（不支持 PROPFIND）',
    };
    return {
      ok: false,
      status: res.status,
      dav,
      message: hints[res.status] ?? `服务端返回 HTTP ${res.status}`,
    };
  }

  // -------------------------------------------------------------------------
  // 父目录（MKCOL）
  // -------------------------------------------------------------------------

  private dirCacheKey(dir: string): string {
    return `${this.cachePrefix}${dir}`;
  }

  private dropDirCache(key: string): void {
    for (const d of [...l1Dirs]) {
      if (d.startsWith(this.cachePrefix)) l1Dirs.delete(d);
    }
    void key;
  }

  /**
   * 逐级创建父目录。PUT 到不存在的目录时多数 WebDAV 服务返回 409，
   * 而 PUT 的请求体是流（不可重放），所以必须**先建目录再上传**。
   * 405/501/409 都视为「已存在或服务端自动处理」，不阻断上传。
   */
  private async ensureParents(key: string): Promise<void> {
    const segs = safeSegments(key);
    for (let i = 0; i < segs.length - 1; i++) {
      const dir = [...this.rootSegs, ...segs.slice(0, i + 1)].join('/');
      const ck = this.dirCacheKey(dir);
      if (l1Dirs.has(ck)) continue;
      let res: Response;
      try {
        res = await this.request('MKCOL', this.urlFor([...this.rootSegs, ...segs.slice(0, i + 1)]));
      } catch (e) {
        throw new Error(`WebDAV MKCOL failed for "${dir}": ${(e as Error).message}`);
      }
      const status = res.status;
      await this.drain(res);
      if (status === 401 || status === 403) {
        throw new Error(`WebDAV MKCOL denied (HTTP ${status}) for "${dir}"`);
      }
      if (status >= 500) {
        throw new Error(`WebDAV MKCOL failed (HTTP ${status}) for "${dir}"`);
      }
      // 201/204/200 创建成功；405/409/501 目录已存在或服务端无需显式创建
      l1Dirs.add(ck);
    }
  }

  // -------------------------------------------------------------------------
  // 上传（全中转，流式 PUT）
  // -------------------------------------------------------------------------

  async token(session: UploadSession, _file: UploadRequest): Promise<UploadCredential> {
    return {
      session_id: session.id,
      chunk_size: 0,
      expires: Math.floor(session.expireAt / 1000),
    };
  }

  private async writeObject(
    key: string,
    body: ReadableStream,
    mimeType: string,
    overwrite: boolean,
  ): Promise<void> {
    if (!overwrite) {
      const existing = await this.meta(key);
      if (existing) throw new Error('Object existed');
    }
    await this.ensureParents(key);

    const url = this.objectUrl(key);
    // PUT 的 body 是流，不能重放，因此不跟随重定向；初始 URL 仍过 SSRF 校验。
    const safe = assertSafeRemoteUrl(url);
    let res: Response;
    try {
      res = await fetch(safe.toString(), {
        method: 'PUT',
        headers: this.headers({
          'Content-Type': mimeType || 'application/octet-stream',
          Overwrite: overwrite ? 'T' : 'F',
        }),
        body,
        redirect: 'manual',
      } as RequestInit);
    } catch (e) {
      throw new Error(`WebDAV PUT failed for "${key}": ${(e as Error).message}`);
    }

    if (res.status >= 300 && res.status < 400) {
      await this.drain(res);
      throw new Error(
        `WebDAV PUT was redirected (HTTP ${res.status}). ` +
          'Fill in the final URL including the trailing slash; streaming uploads cannot follow redirects.',
      );
    }
    if (res.status === 409 || res.status === 404) {
      await this.drain(res);
      this.dropDirCache(key);
      throw new Error(
        `WebDAV PUT got HTTP ${res.status} for "${key}": parent directory may have been removed, please retry the upload`,
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `WebDAV PUT failed (HTTP ${res.status}) for "${key}": ${text.slice(0, 200)}`,
      );
    }
    await this.drain(res);
  }

  async writeChunk(
    session: UploadSession,
    _index: number,
    body: ReadableStream,
    _length: number,
  ): Promise<UploadedPart | null> {
    await this.writeObject(session.savePath, body, session.mimeType, true);
    return null;
  }

  async completeUpload(_session: UploadSession): Promise<void> {
    // 单请求写入已在 writeChunk 完成
  }

  async cancelToken(session: UploadSession): Promise<void> {
    try {
      const res = await this.request('DELETE', this.objectUrl(session.savePath));
      await this.drain(res);
    } catch {
      // 取消上传是尽力而为，失败由哨兵任务兜底
    }
  }

  async put(file: UploadRequest, body: ReadableStream, _contentLength: number): Promise<void> {
    await this.writeObject(file.savePath, body, file.mimeType, file.overwrite);
  }

  // -------------------------------------------------------------------------
  // 读取 / 元信息 / 删除 / 列举
  // -------------------------------------------------------------------------

  async get(source: string, range?: string | null): Promise<ObjectContent | null> {
    const res = await this.request(
      'GET',
      this.objectUrl(source),
      range ? { Range: range } : {},
    );
    if (res.status === 404 || res.status === 410 || res.status === 416) {
      await this.drain(res);
      return null;
    }
    if (res.status !== 200 && res.status !== 206) {
      await this.drain(res);
      throw new Error(`WebDAV GET failed (HTTP ${res.status}) for "${source}"`);
    }
    let size = Number(res.headers.get('content-length') ?? 0);
    const contentRange = res.headers.get('content-range');
    if (contentRange) {
      const total = Number(contentRange.split('/')[1]);
      if (Number.isFinite(total)) size = total;
    }
    return {
      body: res.body!,
      size,
      contentType: res.headers.get('content-type') ?? undefined,
      contentRange,
    };
  }

  async meta(source: string): Promise<{ size: number } | null> {
    const res = await this.request('HEAD', this.objectUrl(source));
    if (res.status === 404 || res.status === 410) {
      await this.drain(res);
      return null;
    }
    if (res.status === 405 || res.status === 501) {
      await this.drain(res);
      return this.metaByPropfind(source);
    }
    if (!res.ok) {
      await this.drain(res);
      throw new Error(`WebDAV HEAD failed (HTTP ${res.status}) for "${source}"`);
    }
    await this.drain(res);
    const raw = res.headers.get('content-length');
    const size = raw === null ? NaN : Number(raw);
    return Number.isFinite(size) ? { size } : this.metaByPropfind(source);
  }

  private async metaByPropfind(source: string): Promise<{ size: number } | null> {
    const res = await this.request('PROPFIND', this.objectUrl(source), {
      Depth: '0',
      'Content-Type': 'application/xml; charset=utf-8',
      Accept: 'application/xml, text/xml',
    }, PROPFIND_BODY);
    if (res.status === 404 || res.status === 410) {
      await this.drain(res);
      return null;
    }
    if (res.status !== 207 && res.status !== 200) {
      await this.drain(res);
      throw new Error(`WebDAV PROPFIND failed (HTTP ${res.status}) for "${source}"`);
    }
    const xml = await res.text();
    const entries = parseMultistatus(xml);
    const entry = entries.find((e) => !e.isCollection) ?? entries[0];
    return entry ? { size: entry.size } : null;
  }

  async delete(sources: string[]): Promise<string[]> {
    const failed: string[] = [];
    for (const s of sources) {
      try {
        const trailing = s.endsWith('/') ? '/' : '';
        const res = await this.request('DELETE', this.objectUrl(s) + trailing);
        await this.drain(res);
        // 404 幂等；423 Locked 才算失败
        if (!res.ok && res.status !== 404 && res.status !== 410) failed.push(s);
      } catch {
        failed.push(s);
      }
    }
    return failed;
  }

  /**
   * 单层列举（导入任务用）。WebDAV 没有分页令牌，一次 PROPFIND Depth:1
   * 返回该目录全部直接子项，故 continuation 恒为 null；不递归子目录。
   */
  async list(
    prefix: string,
    _options?: { continuation?: string; afterKey?: string; limit?: number },
  ): Promise<{
    keys: { key: string; size: number; lastModified: Date }[];
    continuation: string | null;
  }> {
    const segs = safeSegments(prefix);
    const dirSegs = prefix.endsWith('/') ? segs : segs.slice(0, -1);
    const res = await this.request('PROPFIND', this.urlFor([...this.rootSegs, ...dirSegs]), {
      Depth: '1',
      'Content-Type': 'application/xml; charset=utf-8',
      Accept: 'application/xml, text/xml',
    }, PROPFIND_BODY);
    if (res.status !== 207 && res.status !== 200) {
      await this.drain(res);
      throw new Error(`WebDAV PROPFIND failed (HTTP ${res.status}) for prefix "${prefix}"`);
    }
    const entries = parseMultistatus(await res.text());
    const keys: { key: string; size: number; lastModified: Date }[] = [];
    for (const e of entries) {
      if (e.isCollection) continue;
      const key = this.relativeKey(e.href);
      if (key === null || key === '') continue;
      if (prefix && !key.startsWith(prefix)) continue;
      keys.push({ key, size: e.size, lastModified: e.lastModified ?? new Date(0) });
    }
    return { keys, continuation: null };
  }

  /** 把 PROPFIND 的 href（绝对 URL 或路径）换算成相对挂载根的对象键。 */
  private relativeKey(href: string): string | null {
    let pathname: string;
    try {
      pathname = new URL(href, this.base.toString()).pathname;
    } catch {
      return null;
    }
    const decoded = decodePath(pathname);
    const root = this.rootPath.endsWith('/') ? this.rootPath : `${this.rootPath}/`;
    if (!decoded.startsWith(root)) return null;
    return decoded.slice(root.length);
  }

  /** proxyRequired=true 时下载走 Worker 代理，source 不会被调用。 */
  async source(_source: string, _args: GetSourceArgs): Promise<string> {
    throw new Error('WebDAV credentials cannot be exposed to browsers, use the site proxy instead');
  }

  async setCors(): Promise<void> {
    // 上传 / 下载全部经 Worker 中转，无需在对端配置 CORS
  }

  async thumb(): Promise<string | null> {
    return null;
  }
}

/** 未落库的策略也能测连通性：构造一个最小行交给驱动。 */
export async function probeWebDav(cfg: WebDavProbeConfig): Promise<WebDavProbeResult> {
  try {
    const policy = {
      id: 0,
      created_at: new Date(),
      updated_at: new Date(),
      deleted_at: null,
      name: 'probe',
      type: 'webdav',
      server: cfg.server ?? null,
      bucket_name: cfg.bucket_name ?? null,
      is_private: null,
      access_key: cfg.access_key ?? null,
      secret_key: cfg.secret_key ?? null,
      max_size: 0,
      dir_name_rule: null,
      file_name_rule: null,
      settings: (cfg.settings ?? {}) as PolicySetting,
      node_id: null,
    } satisfies StoragePolicyRow;
    return await new WebDavDriver(policy).probe();
  } catch (e) {
    return { ok: false, status: 0, message: `配置有误：${(e as Error).message}` };
  }
}
