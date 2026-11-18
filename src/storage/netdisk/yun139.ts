/**
 * 移动云盘（139）原生驱动。
 *
 * 走 139 新版个人云接口（`personal_new`）：
 *
 *   路由    POST https://user-njs.yun.139.com/user/route/qryRoutePolicy
 *           → 取 modName=personal 的 httpsUrl 作为个人云 host
 *   列表    POST {host}/file/list      {parentFileId, pageInfo}
 *   建目录  POST {host}/file/create    {parentFileId, name, type:'folder'}
 *   直链    POST {host}/file/getDownloadUrl {fileId}
 *   删除    POST {host}/file/delete    {fileIds:[..]}
 *   上传    POST {host}/file/create → {fileId, uploadId, partInfos[{uploadUrl}]}
 *           → PUT 每个 uploadUrl（预签名直传）→ POST {host}/file/complete
 *
 * 每个业务请求都带 `mcloud-sign: <ts>,<rand16>,<sign>`，签名算法：
 *   body → encodeURIComponent → 逐字符排序 → base64 → MD5(base64) +
 *   MD5(ts + ':' + rand) → 再 MD5 后转大写。
 *
 * **整文件 SHA-256 是 create 的必填项**，而 Cloudreve 传给驱动的是单向流。
 * 所以这里把流先落一份到 R2 临时对象（同时增量算 SHA-256），再从 R2 按分片
 * range 读回来上传，最后删掉临时对象。这样既不用把 95 MB 全塞进内存，也不用
 * 让客户端多传一次。**该策略类型要求 Worker 绑定 R2**（内置 R2 策略本来就要
 * 绑定，未绑定时会给出明确错误）。
 *
 * 策略字段映射：
 *   settings.y139_authorization → authorization（必填，base64，别带 "Basic "）
 *   settings.y139_user_domain_id→ userDomainId（可选，用于自动刷新）
 *   settings.y139_root_folder_id→ 根目录 fileId，默认 "/"
 *   bucket_name                 → 根路径（如 /cloudreve，不存在会自动建）
 */
import type { Env } from '../../env';
import type { StoragePolicyRow } from '../../db/types';
import { safeFetch } from '../../lib/ssrf';
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
  Sha256Stream,
  joinPath,
  md5Hex,
  normalizeRoot,
  randomAlnum,
  remotePathOf,
  segmentsOf,
  totalFromContentRange,
} from './common';

const ROUTE_URL = 'https://user-njs.yun.139.com/user/route/qryRoutePolicy';
/** 分片大小：<30 GB 用 100 MB（与官方客户端一致），我们实际只会用到 1 片。 */
const PART_SIZE = 100 * 1024 * 1024;
const ROUTE_RETRY_CODES = new Set(['9000', '9008', '9100']);

interface Y139Item {
  fileId?: string;
  catalogId?: string;
  catalogID?: string;
  name: string;
  size?: number;
  type?: string;
  updatedAt?: string;
}

interface Y139RouteCache {
  host: string;
  expireAt: number;
}

const routeCache = new Map<string, Y139RouteCache>();

export class Yun139Driver implements StorageDriver {
  readonly type: string;
  readonly chunkSize: number;
  readonly settings;

  private readonly authorization: string;
  private readonly account: string;
  private readonly userDomainId: string;
  private readonly rootPath: string;
  private readonly rootFolderId: string;
  private readonly cacheKey: string;
  private host = '';
  private readonly dirCache = new Map<string, string>();

  constructor(
    private readonly env: Env,
    readonly policy: StoragePolicyRow,
  ) {
    this.type = policy.type;
    this.settings = policy.settings ?? {};
    this.chunkSize = 0;

    const raw = (this.settings.y139_authorization ?? '').trim();
    if (!raw) {
      throw new Error(
        `移动云盘策略「${policy.name}」缺少 authorization：请填 settings.y139_authorization` +
          '（浏览器登录 yun.139.com 后从请求头 Authorization 里取 Basic 后面的那串）',
      );
    }
    if (/^basic\s/i.test(raw)) {
      throw new Error('移动云盘 authorization 不要带 "Basic " 前缀');
    }
    this.authorization = raw;
    this.account = decodeAccount(raw);
    if (!this.account) {
      throw new Error('移动云盘 authorization 解析失败（应为 base64 的 account:account:token）');
    }
    this.userDomainId = (this.settings.y139_user_domain_id ?? '').trim();
    this.rootPath = normalizeRoot(policy.bucket_name);
    this.rootFolderId = (this.settings.y139_root_folder_id ?? '').trim() || '/';
    this.cacheKey = `139:${policy.id}`;
  }

  capabilities(): DriverCapabilities {
    return {
      // 下载走 302 直连移动 CDN（getDownloadUrl 直链实测：无需任何请求头即可
      // 访问）；仅「强制下载且存储端文件名与原名不符」时回退站点中转。
      proxyRequired: false,
      uploadSentinelRequired: true,
      maxSourceExpire: 0,
      thumbSupportedExts: [],
      thumbSupportAllExts: false,
      thumbMaxSize: 0,
      directUrlFilename: false,
    };
  }

  static invalidate(policyId: number): void {
    routeCache.delete(`139:${policyId}`);
  }

  // -------------------------------------------------------------------------
  // 协议层
  // -------------------------------------------------------------------------

  private headers(bodyString: string): Record<string, string> {
    const ts = formatTime(new Date());
    const rand = randomAlnum(16);
    const sign = calSign(bodyString, ts, rand);
    return {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      'CMS-DEVICE': 'default',
      Authorization: `Basic ${this.authorization}`,
      Caller: 'web',
      'Mcloud-Channel': '1000101',
      'Mcloud-Client': '10701',
      'Mcloud-Route': '001',
      'mcloud-channel': '1000101',
      'mcloud-client': '10701',
      'mcloud-sign': `${ts},${rand},${sign}`,
      'mcloud-version': '7.14.0',
      Origin: 'https://yun.139.com',
      Referer: 'https://yun.139.com/w/',
      'User-Agent': BROWSER_UA,
      'x-DeviceInfo': '||9|7.14.0|chrome|120.0.0.0|||windows 10||zh-CN|||',
      'x-huawei-channelSrc': '10000034',
      'x-inner-ntwk': '2',
      'x-m4c-caller': 'PC',
      'x-m4c-src': '10002',
      'x-SvcType': '1',
      'Inner-Hcy-Router-Https': '1',
      'X-Yun-Api-Version': 'v1',
      'X-Yun-App-Channel': '10000034',
      'X-Yun-Channel-Source': '10000034',
      'X-Yun-Client-Info': '||9|7.14.0|chrome|120.0.0.0|||windows 10||zh-CN|||dW5kZWZpbmVk||',
      'X-Yun-Module-Type': '100',
      'X-Yun-Svc-Type': '1',
    };
  }

  /** 个人云 host：路由下发，缓存 30 分钟。 */
  private async personalHost(): Promise<string> {
    const hit = routeCache.get(this.cacheKey);
    if (hit && hit.expireAt > Date.now()) return hit.host;

    const body = JSON.stringify({
      userInfo: { userType: 1, accountType: 1, accountName: this.account },
      modAddrType: 1,
    });
    const res = await safeFetch(ROUTE_URL, { method: 'POST', headers: this.headers(body), body });
    const json = (await res.json().catch(() => ({}))) as {
      data?: { routePolicyList?: { modName?: string; httpsUrl?: string }[] };
    };
    const list = json.data?.routePolicyList ?? [];
    const personal = list.find((p) => p.modName === 'personal' && p.httpsUrl)?.httpsUrl;
    if (!personal) {
      throw new Error(
        '移动云盘路由解析失败：queryRoutePolicy 未返回 personal host（authorization 可能已失效）',
      );
    }
    this.host = personal.replace(/\/+$/, '');
    routeCache.set(this.cacheKey, { host: this.host, expireAt: Date.now() + 30 * 60_000 });
    return this.host;
  }

  /** 候选 URL：不同账号下发的 host 形态不同，错误的形态会静默返回父级内容。 */
  private candidates(path: string): string[] {
    const host = this.host || 'https://yun.139.com';
    if (/\/orchestration$/.test(host)) return [`${host}${path}`];
    const hasPath = /^https:\/\/[^/]+\/.+/.test(host) && !/\/orchestration$/.test(host);
    if (hasPath) return [`${host}${path}`, `${host}/orchestration${path}`];
    return [`${host}/orchestration${path}`, `${host}${path}`];
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    await this.personalHost();
    const bodyString = JSON.stringify(body);
    let lastError = '';

    // 139 的路由对同一端点在不同请求间可能表现不一致（实测同一 host 下
    // getDownloadUrl 成功、file/delete 双候选 404；Worker 出口有时拿到
    // 非 JSON 响应）。候选 URL 全部失败时，强制刷新路由 host 重试一轮。
    for (let round = 0; round < 2; round++) {
      if (round > 0) {
        routeCache.delete(this.cacheKey);
        this.host = '';
        await this.personalHost();
      }
      const urls = this.candidates(path);
      for (let i = 0; i < urls.length; i++) {
        const url = urls[i];
        const res = await safeFetch(url, {
          method: 'POST',
          headers: this.headers(bodyString),
          body: bodyString,
        });
        const text = await res.text();
        if (res.status === 404 || /route not found/i.test(text)) {
          lastError = `HTTP ${res.status} ${text.slice(0, 80)}`;
          continue;
        }
        let json: { success?: boolean; code?: string; message?: string; data?: unknown };
        try {
          json = JSON.parse(text);
        } catch {
          lastError = 'non-JSON response';
          continue;
        }
        const code = String(json.code ?? '');
        if (ROUTE_RETRY_CODES.has(code)) {
          lastError = `routing error ${code}`;
          continue;
        }
        if (json.success === false) {
          throw new Error(`移动云盘 API 失败：${json.message ?? code ?? 'unknown'}`);
        }
        if (!res.ok) {
          throw new Error(`移动云盘 HTTP ${res.status}：${text.slice(0, 160)}`);
        }
        return json as T;
      }
    }
    throw new Error(`移动云盘 API 无可用路由（${lastError || 'unknown'}）`);
  }

  // -------------------------------------------------------------------------
  // 目录 / 文件解析
  // -------------------------------------------------------------------------

  private async listFolder(parentFileId: string): Promise<Y139Item[]> {
    const items: Y139Item[] = [];
    let cursor = '';
    for (let page = 0; page < 50; page++) {
      const resp = await this.post<{
        data?: { items?: Y139Item[]; nextPageCursor?: string };
      }>('/file/list', {
        parentFileId,
        pageInfo: { pageCursor: cursor, pageSize: 100 },
        orderBy: 'updated_at',
        orderDirection: 'DESC',
        imageThumbnailStyleList: ['Small', 'Large'],
      });
      const list = resp.data?.items ?? [];
      items.push(...list);
      const next = resp.data?.nextPageCursor ?? '';
      if (!next || next === cursor) break;
      cursor = next;
    }
    return items;
  }

  private async createFolder(parentId: string, name: string): Promise<string> {
    const resp = await this.post<{ data?: { fileId?: string } }>('/file/create', {
      parentFileId: parentId,
      name,
      description: '',
      type: 'folder',
      fileRenameMode: 'force_rename',
    });
    const id = resp.data?.fileId;
    if (!id) throw new Error(`移动云盘创建目录失败：${name}`);
    return id;
  }

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
      const items = await this.listFolder(current);
      const hit = items.find((i) => i.name === seg && i.type === 'folder');
      current = hit ? String(hit.fileId ?? hit.catalogId ?? hit.catalogID) : await this.createFolder(current, seg);
      this.dirCache.set(key, current);
    }
    return current;
  }

  private async resolveFile(path: string): Promise<Y139Item | null> {
    const segs = segmentsOf(path);
    if (!segs.length) return null;
    const name = segs.pop()!;
    const parentId = await this.resolveDir(segs);
    const items = await this.listFolder(parentId);
    return items.find((i) => i.name === name && i.type !== 'folder') ?? null;
  }

  private async downloadUrl(fileId: string): Promise<string> {
    const resp = await this.post<{
      data?: { url?: string; cdnUrl?: string; cdnSwitch?: boolean };
    }>('/file/getDownloadUrl', { fileId });
    const data = resp.data;
    const url = (data?.cdnSwitch ? data.cdnUrl : '') || data?.url || data?.cdnUrl || '';
    if (!url) throw new Error(`移动云盘未返回下载地址（fileId=${fileId}）`);
    return url;
  }

  // -------------------------------------------------------------------------
  // 上传（R2 暂存 + 分片直传）
  // -------------------------------------------------------------------------

  private bucket(): R2Bucket {
    if (!this.env.R2) {
      throw new Error(
        '移动云盘上传需要 R2 绑定作为临时缓冲（整文件 SHA-256 必须在创建上传任务前算出）。' +
          '请在 wrangler.toml 里保留 r2_buckets 的 R2 绑定。',
      );
    }
    return this.env.R2;
  }

  private async uploadStream(
    parentId: string,
    name: string,
    stream: ReadableStream,
    size: number,
  ): Promise<void> {
    const bucket = this.bucket();
    const tempKey = `_netdisk_tmp/139/${crypto.randomUUID()}`;
    const sha = new Sha256Stream();

    try {
      // 1) 落 R2 临时对象，顺路增量算 SHA-256（TransformStream 的 transform
      //    在每次 enqueue 时同步执行，所以哈希不会漏字节）。
      //    注意：pipeThrough 之后流的长度信息会丢失，R2 put 拒收未知长度流，
      //    必须用 FixedLengthStream 把已知长度（size）重新标定回去。
      const hashing = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          sha.update(chunk);
          controller.enqueue(chunk);
        },
      });
      // Workers 提供 FixedLengthStream；Node（单测的 R2 mock）没有，回退普通流。
      const sink: TransformStream<Uint8Array, Uint8Array> =
        typeof FixedLengthStream !== 'undefined' ? new FixedLengthStream(size) : new TransformStream();
      const putPromise = bucket.put(tempKey, sink.readable, {
        httpMetadata: { contentType: 'application/octet-stream' },
      });
      await (stream as ReadableStream<Uint8Array>).pipeThrough(hashing).pipeTo(sink.writable);
      await putPromise;
      const contentHash = sha.hex();
      // 2) 创建上传任务
      const partCount = Math.max(1, Math.ceil(size / PART_SIZE));
      const partInfos = Array.from({ length: Math.min(partCount, 100) }, (_, i) => ({
        partNumber: i + 1,
        partSize: i + 1 === partCount ? size - i * PART_SIZE : PART_SIZE,
        parallelHashCtx: { partOffset: i * PART_SIZE },
      }));

      const created = await this.post<{
        data?: {
          fileId?: string;
          uploadId?: string;
          exist?: boolean;
          /** 秒传命中时为 true（此时 uploadId/partInfos 为 null，无需上传） */
          rapidUpload?: boolean;
          partInfos?: { partNumber: number; uploadUrl: string }[];
        };
      }>('/file/create', {
        contentHash,
        contentHashAlgorithm: 'SHA256',
        contentType: 'application/octet-stream',
        parallelUpload: false,
        partInfos,
        size,
        parentFileId: parentId,
        name,
        type: 'file',
        fileRenameMode: 'auto_rename',
      });
      const data = created.data;
      // exist 与 rapidUpload 都表示服务端已按 contentHash 直接建好文件（秒传），
      // 后者命中时 uploadId / partInfos 为 null，绝不能当作「缺参数」报错
      if (data?.exist || data?.rapidUpload) return;
      if (!data?.fileId || !data?.uploadId) {
        throw new Error('移动云盘创建上传任务失败（缺 fileId / uploadId）');
      }

      const urls = new Map<number, string>();
      for (const p of data.partInfos ?? []) urls.set(p.partNumber, p.uploadUrl);

      // 3) 逐片从 R2 读回来直传
      for (let partNumber = 1; partNumber <= partCount; partNumber++) {
        if (!urls.has(partNumber)) {
          const more = await this.post<{
            data?: { partInfos?: { partNumber: number; uploadUrl: string }[] };
          }>('/file/getUploadUrl', {
            fileId: data.fileId,
            uploadId: data.uploadId,
            partInfos: partInfos.filter((p) => p.partNumber === partNumber),
            commonAccountInfo: { account: this.account, accountType: 1 },
          });
          for (const p of more.data?.partInfos ?? []) urls.set(p.partNumber, p.uploadUrl);
        }
        const url = urls.get(partNumber);
        if (!url) throw new Error(`移动云盘未下发第 ${partNumber} 片的上传地址`);

        const offset = (partNumber - 1) * PART_SIZE;
        const length = partNumber === partCount ? size - offset : PART_SIZE;
        const obj = await bucket.get(tempKey, { range: { offset, length } });
        if (!obj) throw new Error('移动云盘上传中断：R2 临时对象已丢失');
        const buf = new Uint8Array(await obj.arrayBuffer());

        const put = await fetch(url, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/octet-stream',
            Origin: 'https://yun.139.com',
            Referer: 'https://yun.139.com/',
            'User-Agent': BROWSER_UA,
          },
          body: buf as unknown as BodyInit,
        });
        if (!put.ok) {
          const text = await put.text().catch(() => '');
          throw new Error(`移动云盘上传第 ${partNumber} 片失败：HTTP ${put.status} ${text.slice(0, 120)}`);
        }
        await put.body?.cancel().catch(() => {});
      }

      // 4) 完成上传
      await this.post('/file/complete', {
        contentHash,
        contentHashAlgorithm: 'SHA256',
        fileId: data.fileId,
        uploadId: data.uploadId,
      });
    } finally {
      await bucket.delete(tempKey).catch(() => {});
    }
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
    // 单请求内完成
  }

  async cancelToken(session: UploadSession): Promise<void> {
    try {
      await this.remove([session.savePath]);
    } catch {
      // 可能尚未落地
    }
  }

  async put(file: UploadRequest, body: ReadableStream, contentLength: number): Promise<void> {
    const path = remotePathOf(this.rootPath, file.savePath);
    const segs = segmentsOf(path);
    const name = segs.pop()!;
    const parentId = await this.resolveDir(segs);
    const size = contentLength || file.size;

    const existing = await this.resolveFile(path);
    if (existing) {
      if (!file.overwrite) throw new Error('Object existed');
      const id = String(existing.fileId ?? existing.catalogId ?? existing.catalogID ?? '');
      if (id) await this.post('/file/delete', { fileIds: [id] });
    }
    await this.uploadStream(parentId, name, body, size);
  }

  async get(source: string, range?: string | null): Promise<ObjectContent | null> {
    const resolved = await this.resolveFile(remotePathOf(this.rootPath, source));
    if (!resolved) return null;
    const id = String(resolved.fileId ?? resolved.catalogId ?? resolved.catalogID ?? '');
    const url = await this.downloadUrl(id);
    const headers: Record<string, string> = {
      'User-Agent': BROWSER_UA,
      Referer: 'https://yun.139.com/',
    };
    if (range) headers.Range = range;
    const res = await safeFetch(url, { headers });
    if (res.status === 404 || res.status === 416) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`移动云盘下载失败：HTTP ${res.status}`);
    }
    const contentRange = res.headers.get('content-range');
    let size = Number(res.headers.get('content-length') ?? 0);
    const total = totalFromContentRange(contentRange);
    if (total) size = total;
    if (!Number.isFinite(size) || size <= 0) size = Number(resolved.size ?? 0);
    return {
      body: res.body!,
      size,
      contentType: res.headers.get('content-type') ?? undefined,
      contentRange,
    };
  }

  async meta(source: string): Promise<{ size: number } | null> {
    const resolved = await this.resolveFile(remotePathOf(this.rootPath, source));
    return resolved ? { size: Number(resolved.size ?? 0) } : null;
  }

  async remove(sources: string[]): Promise<void> {
    for (const src of sources) {
      const resolved = await this.resolveFile(remotePathOf(this.rootPath, src));
      if (!resolved) continue;
      const id = String(resolved.fileId ?? resolved.catalogId ?? resolved.catalogID ?? '');
      if (id) {
        // 新版个人云没有 /file/delete；删除 = 移入回收站（与官方一致）
        await this.post('/recyclebin/batchTrash', {
          fileIds: [id],
          commonAccountInfo: { account: this.account, accountType: 1 },
        });
      }
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
    if (!resolved) throw new Error(`移动云盘文件不存在：${source}`);
    const id = String(resolved.fileId ?? resolved.catalogId ?? resolved.catalogID ?? '');
    return this.downloadUrl(id);
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
    const items = await this.listFolder(folderId);
    const limit = Math.min(1000, Math.max(1, options.limit ?? 200));
    const keys = items
      .filter((i) => i.type !== 'folder')
      .slice(0, limit)
      .map((i) => ({
        key: prefix ? joinPath(prefix, i.name).replace(/^\//, '') : i.name,
        size: Number(i.size ?? 0),
        lastModified: i.updatedAt ? new Date(i.updatedAt) : new Date(),
      }))
      .filter((k) => !options.afterKey || k.key > options.afterKey);
    return { keys, continuation: null };
  }

  async thumb(): Promise<string | null> {
    return null;
  }

  async setCors(): Promise<void> {
    // 全中转
  }

  /** 供后台「连接测试」使用：只读一次根目录。 */
  async probe(): Promise<void> {
    await this.personalHost();
    const folderId =
      (await this.resolveDir(segmentsOf(this.rootPath))).trim() || this.rootFolderId;
    await this.listFolder(folderId);
  }

}

function decodeAccount(authorization: string): string {
  try {
    const decoded = atob(authorization);
    const pieces = decoded.split(':');
    return pieces.length >= 2 ? pieces[1] : '';
  } catch {
    return '';
  }
}

/** `YYYY-MM-DD HH:mm:ss`（139 的 mcloud-sign 要求）。 */
function formatTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** 139 的签名：encodeURIComponent → 逐字符排序 → base64 → 两级 MD5 → 大写。 */
function calSign(body: string, ts: string, rand: string): string {
  const encoded = encodeURIComponent(body);
  const sorted = encoded.split('').sort().join('');
  let b64 = '';
  const bytes = new TextEncoder().encode(sorted);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  b64 = btoa(bin);
  const first = md5Hex(b64) + md5Hex(`${ts}:${rand}`);
  return md5Hex(first).toUpperCase();
}
