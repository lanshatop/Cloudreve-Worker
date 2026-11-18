/**
 * 联通云盘（沃盘）原生驱动。
 *
 * 接口是联通「沃云」的私有协议：统一 POST 到
 * `https://panservice.mail.wo.cn/<channel>/dispatcher`，
 *
 *   { header: { key, resTime, reqSeq, channel, sign, version },
 *     body:   { param: <AES-CBC 加密后的业务 JSON>, ...附加字段 } }
 *
 *   - `channel=api-user` 用于换取 access_token（key 固定为协议级 AES secret）；
 *   - `channel=wohome`  用于文件操作（key 取 access_token 前 16 位）；
 *   - `sign = MD5(key + resTime + reqSeq + channel + version)`；
 *   - 响应 `RSP.RSP_CODE !== '0000'` 即业务失败，`9999` 表示 token 过期。
 *
 * 上传是纯 multipart 表单：每个分片 POST 一次
 * `https://tjupload.pan.wo.cn/openapi/client/upload2C`，表单里带
 * `totalPart` / `partIndex` / `partSize` 与 AES 加密的 `fileInfo`。
 * 没有「创建上传会话」这一步，所以天然支持流式分片，不需要整文件缓冲。
 *
 * 策略字段映射：
 *   settings.wp_access_token  → access_token（必填）
 *   settings.wp_refresh_token → refresh_token（强烈建议填，否则 2 小时后失效）
 *   bucket_name               → 根目录路径（如 /cloudreve，不存在会自动建）
 *   settings.wp_root_folder_id→ 根目录 ID，默认 0（个人云根）
 *
 * 注意：联通云盘自 2026-10 起对 `go-resty` 默认 UA 做了封禁，这里统一用
 * 浏览器 UA；token 需要用沃盘 App / 扫码登录后抓取（本项目不做短信登录，
 * 因为短信验证码无法在无交互的 Worker 里完成）。
 */
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
  PartReader,
  aesCbcDecryptBase64,
  aesCbcEncryptBase64,
  joinPath,
  md5Hex,
  normalizeRoot,
  randomAlnum,
  remotePathOf,
  segmentsOf,
  totalFromContentRange,
} from './common';

const BASE = 'https://panservice.mail.wo.cn';
const ZONE_DEFAULT = 'https://tjupload.pan.wo.cn';
const CLIENT_ID = '1001000021';
const CLIENT_SECRET = 'XFmi9GS2hzk98jGX';
const APP_ID = '10000001';
const AES_IV = 'wNSOYIB1k1DjY5lA';
const CHANNEL_USER = 'api-user';
const CHANNEL_HOME = 'wohome';
const CHANNEL_CLOUD = 'wocloud';
const SPACE_PERSONAL = '0';
const PART_SIZE = 8 * 1024 * 1024;

interface WoFile {
  fid: string;
  name: string;
  size?: number;
  id: string;
  type: number; // 0 目录 1 文件
  createTime?: string;
}

interface WoTokenState {
  accessToken: string;
  refreshToken: string;
}

const tokenCache = new Map<string, WoTokenState>();

export class WoPanDriver implements StorageDriver {
  readonly type: string;
  readonly chunkSize: number;
  readonly settings;

  private readonly rootPath: string;
  private readonly rootFolderId: string;
  private readonly cacheKey: string;
  private readonly state: WoTokenState;
  private zoneUrl = '';
  private readonly dirCache = new Map<string, string>();
  /** 部分账号 CreateDirectory 恒返回 9999；首次失败后停用建目录，直接扁平化落盘。 */
  private mkdirDisabled = false;
  /** 默认家庭 ID（FamilyUserCurrentEncode.defaultHomeId），CreateDirectory 必传。 */
  private familyIdCache = '';

  constructor(readonly policy: StoragePolicyRow) {
    this.type = policy.type;
    this.settings = policy.settings ?? {};
    this.chunkSize = 0;

    this.rootPath = normalizeRoot(policy.bucket_name);
    this.rootFolderId = (this.settings.wp_root_folder_id ?? '').trim() || '0';
    this.cacheKey = `wopan:${policy.id}`;

    const cached = tokenCache.get(this.cacheKey);
    const accessToken = (this.settings.wp_access_token ?? '').trim() || cached?.accessToken || '';
    const refreshToken = (this.settings.wp_refresh_token ?? '').trim() || cached?.refreshToken || '';
    if (!accessToken && !refreshToken) {
      throw new Error(
        `联通云盘策略「${policy.name}」缺少凭据：请填 settings.wp_access_token（和 wp_refresh_token）`,
      );
    }
    this.state = { accessToken, refreshToken };
    tokenCache.set(this.cacheKey, this.state);
  }

  capabilities(): DriverCapabilities {
    return {
      proxyRequired: true,
      uploadSentinelRequired: true,
      maxSourceExpire: 0,
      thumbSupportedExts: [],
      thumbSupportAllExts: false,
      thumbMaxSize: 0,
      directUrlFilename: false,
    };
  }

  static invalidate(policyId: number): void {
    tokenCache.delete(`wopan:${policyId}`);
  }

  // -------------------------------------------------------------------------
  // 协议层
  // -------------------------------------------------------------------------

  private aesKey(channel: string): string {
    if (channel === CHANNEL_USER) return CLIENT_SECRET;
    return (this.state.accessToken || CLIENT_SECRET).slice(0, 16) || CLIENT_SECRET;
  }

  private async refresh(): Promise<void> {
    if (!this.state.refreshToken) {
      throw new Error('联通云盘 access_token 已失效，且未配置 refresh_token，请更新凭据');
    }
    const data = await this.request<{ access_token?: string; refresh_token?: string }>(
      CHANNEL_USER,
      'AppRefreshToken',
      { refreshToken: this.state.refreshToken, clientSecret: CLIENT_SECRET },
      { clientId: CLIENT_ID, secret: true },
      false,
    );
    if (!data.access_token) throw new Error('联通云盘刷新 token 失败：未返回 access_token');
    this.state.accessToken = data.access_token;
    if (data.refresh_token) this.state.refreshToken = data.refresh_token;
    tokenCache.set(this.cacheKey, this.state);
  }

  private async request<T>(
    channel: string,
    key: string,
    param: Record<string, unknown> | null,
    extra: Record<string, unknown> = {},
    retry = true,
  ): Promise<T> {
    const resTime = Date.now();
    const reqSeq = Math.floor(Math.random() * 8999) + 100000;
    const version = '';
    const keyStr = this.aesKey(channel);
    const sign = md5Hex(`${key}${resTime}${reqSeq}${channel}${version}`);

    const body: Record<string, unknown> = { ...extra };
    if (param) body.param = aesCbcEncryptBase64(JSON.stringify(param), keyStr, AES_IV);

    const headers: Record<string, string> = {
      Origin: 'https://pan.wo.cn',
      Referer: 'https://pan.wo.cn/',
      'User-Agent': BROWSER_UA,
      'Content-Type': 'application/json;charset=UTF-8',
    };
    if (this.state.accessToken) headers.Accesstoken = this.state.accessToken;

    const res = await safeFetch(`${BASE}/${channel}/dispatcher`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        header: { key, resTime, reqSeq, channel, sign, version },
        body,
      }),
    });
    const json = (await res.json().catch(() => null)) as {
      STATUS?: string;
      MSG?: string;
      RSP?: { RSP_CODE?: string; RSP_DESC?: string; DATA?: unknown };
    } | null;
    if (!json) throw new Error(`联通云盘接口 ${key} 返回非 JSON（HTTP ${res.status}）`);
    if (json.STATUS !== '200') {
      throw new Error(`联通云盘接口 ${key} 失败：STATUS=${json.STATUS} ${json.MSG ?? ''}`);
    }
    const code = json.RSP?.RSP_CODE;
    if (code !== '0000') {
      if (channel !== CHANNEL_USER && retry && code === '9999') {
        await this.refresh();
        return this.request<T>(channel, key, param, extra, false);
      }
      throw new Error(`联通云盘接口 ${key} 失败：${code} ${json.RSP?.RSP_DESC ?? ''}`);
    }

    const raw = json.RSP?.DATA;
    if (raw === undefined || raw === null) return {} as T;
    if (typeof raw === 'string') {
      const trimmed = raw.trim().replace(/^"|"$/g, '');
      try {
        return JSON.parse(aesCbcDecryptBase64(trimmed, keyStr, AES_IV)) as T;
      } catch {
        try {
          return JSON.parse(trimmed) as T;
        } catch {
          return trimmed as unknown as T;
        }
      }
    }
    return raw as T;
  }

  private home<T>(key: string, param: Record<string, unknown> | null, extra = {}): Promise<T> {
    return this.request<T>(CHANNEL_HOME, key, param, { secret: true, ...extra });
  }

  /**
   * 默认家庭 ID。官方 wopan-sdk-go 在 CreateDirectory 里即使个人空间也必传
   * familyId（取 FamilyUserCurrentEncode 的 defaultHomeId）；传空字符串服务端
   * 返回 9999 系统异常。此调用在 9999→refresh 重试链之外，失败返回 '0' 兜底。
   */
  private async familyId(): Promise<string> {
    if (this.familyIdCache) return this.familyIdCache;
    try {
      const data = await this.home<{ defaultHomeId?: number }>('FamilyUserCurrentEncode', {
        clientId: CLIENT_ID,
      });
      if (data.defaultHomeId != null && Number.isFinite(data.defaultHomeId)) {
        this.familyIdCache = String(data.defaultHomeId);
      }
    } catch {
      // 忽略：失败时沿用 '0' 兜底
    }
    if (!this.familyIdCache) this.familyIdCache = '0';
    return this.familyIdCache;
  }

  // -------------------------------------------------------------------------
  // 目录 / 文件解析
  // -------------------------------------------------------------------------

  private async listFolder(dirId: string): Promise<WoFile[]> {
    const out: WoFile[] = [];
    // 官方 SDK 分页号从 0 开始；从 1 开始会导致首页即越界返回空列表。
    for (let page = 0; page < 50; page++) {
      const data = await this.home<{ files?: WoFile[] }>('QueryAllFiles', {
        spaceType: SPACE_PERSONAL,
        parentDirectoryId: dirId,
        pageNum: page,
        pageSize: 200,
        sortRule: 1,
        clientId: CLIENT_ID,
      });
      const files = data.files ?? [];
      out.push(...files);
      if (files.length < 200) break;
    }
    return out;
  }

  private async createFolder(parentId: string, name: string): Promise<string> {
    const data = await this.home<{ id?: string }>('CreateDirectory', {
      spaceType: SPACE_PERSONAL,
      familyId: await this.familyId(),
      parentDirectoryId: parentId,
      directoryName: name,
      clientId: CLIENT_ID,
    });
    if (!data.id) throw new Error(`联通云盘创建目录失败：${name}`);
    return data.id;
  }

  /**
   * 解析（或创建）目录链，返回落盘目录 id 与扁平化文件名前缀。
   *
   * 部分联通账号可以正常读写文件，但其接口 CreateDirectory 会返回 9999
   * （系统异常，实测与 token 无关）。原实现一旦建目录失败就抛错，且误把
   * 9999 当成 token 过期去 refresh，导致上传整体失败。这里改为：目录存在
   * 就进入；不存在且能创建就创建；创建失败则把该段及后续段扁平化进文件名
   * 前缀，文件直接落到最后可用的父目录（最坏是网盘根目录），保证文件不丢。
   */
  private async resolveDir(
    segments: string[],
  ): Promise<{ dirId: string; flatPrefix: string }> {
    let current = this.rootFolderId;
    let key = '';
    let flat = '';
    let flatten = false;
    for (const seg of segments) {
      key += `/${seg}`;
      if (flatten) {
        flat += `${flat ? '_' : ''}${seg}`;
        continue;
      }
      const cached = this.dirCache.get(key);
      if (cached) {
        current = cached;
        continue;
      }
      let files: WoFile[];
      try {
        files = await this.listFolder(current);
      } catch {
        // 列目录也失败：只能扁平化落到当前父目录
        flatten = true;
        flat += `${flat ? '_' : ''}${seg}`;
        continue;
      }
      const hit = files.find((f) => f.name === seg && f.type === 0);
      if (hit) {
        current = hit.id;
        this.dirCache.set(key, current);
        continue;
      }
      if (this.mkdirDisabled) {
        flatten = true;
        flat += `${flat ? '_' : ''}${seg}`;
        continue;
      }
      try {
        current = await this.createFolder(current, seg);
        this.dirCache.set(key, current);
      } catch {
        // CreateDirectory 在该账号不可用（9999）：本次及后续都直接扁平化，
        // 避免每次上传都白跑一次建目录 + 一次徒劳的 token refresh。
        this.mkdirDisabled = true;
        flatten = true;
        flat += `${flat ? '_' : ''}${seg}`;
      }
    }
    return { dirId: current, flatPrefix: flat };
  }

  private async resolveFile(path: string): Promise<WoFile | null> {
    const segs = segmentsOf(path);
    if (!segs.length) return null;
    const name = segs.pop()!;
    const { dirId, flatPrefix } = await this.resolveDir(segs);
    const files = await this.listFolder(dirId);
    const flatName = flatPrefix ? `${flatPrefix}_${name}` : name;
    return files.find((f) => f.name === flatName && f.type !== 0) ?? null;
  }

  private async downloadUrl(fid: string): Promise<string> {
    const data = await this.home<{ list?: { fid: string; downloadUrl: string }[] }>(
      'GetDownloadUrlV2',
      { type: '1', fidList: [fid], clientId: CLIENT_ID },
    );
    const url = data.list?.find((x) => x.fid === fid)?.downloadUrl || data.list?.[0]?.downloadUrl;
    if (!url) throw new Error(`联通云盘未返回下载地址（fid=${fid}）`);
    return url;
  }

  private async zone(): Promise<string> {
    if (this.zoneUrl) return this.zoneUrl;
    try {
      const data = await this.home<{ url?: string }>('GetZoneInfo', { appId: APP_ID }, { key: true });
      this.zoneUrl = data.url || ZONE_DEFAULT;
    } catch {
      this.zoneUrl = ZONE_DEFAULT;
    }
    return this.zoneUrl;
  }

  // -------------------------------------------------------------------------
  // 上传
  // -------------------------------------------------------------------------

  private fileTypeOf(name: string): string {
    const ext = (name.split('.').pop() ?? '').toLowerCase();
    // 联通按扩展名归类，未知类型统一 5（其他）
    const map: Record<string, string> = {
      jpg: '1',
      jpeg: '1',
      png: '1',
      gif: '1',
      webp: '1',
      mp4: '2',
      mkv: '2',
      avi: '2',
      mov: '2',
      mp3: '3',
      flac: '3',
      wav: '3',
      txt: '4',
      pdf: '4',
      doc: '4',
      docx: '4',
    };
    return map[ext] ?? '5';
  }

  private async uploadStream(
    dirId: string,
    name: string,
    stream: ReadableStream,
    size: number,
  ): Promise<void> {
    const zone = await this.zone();
    const totalPart = Math.max(1, Math.ceil(size / PART_SIZE));
    const batchNo = new Date()
      .toISOString()
      .replace(/[-:TZ.]/g, '')
      .slice(0, 14);
    const uniqueId = `${Date.now()}_${randomAlnum(6)}`;

    const fileInfo = {
      spaceType: SPACE_PERSONAL,
      directoryId: dirId,
      batchNo,
      fileName: name,
      fileSize: size,
      fileType: this.fileTypeOf(name),
    };
    const fileInfoEnc = aesCbcEncryptBase64(
      JSON.stringify(fileInfo),
      (this.state.accessToken || CLIENT_SECRET).slice(0, 16),
      AES_IV,
    );

    const reader = new PartReader(stream as ReadableStream<Uint8Array>);
    for (let partIndex = 1; partIndex <= totalPart; partIndex++) {
      const expected = partIndex === totalPart ? size - (partIndex - 1) * PART_SIZE : PART_SIZE;
      const chunk = await reader.read(expected);
      if (chunk.length !== expected) {
        throw new Error(
          `联通云盘上传中断：第 ${partIndex}/${totalPart} 片收到 ${chunk.length}，应为 ${expected}`,
        );
      }
      const form = new FormData();
      form.append('uniqueId', uniqueId);
      form.append('accessToken', this.state.accessToken);
      form.append('fileName', name);
      form.append('psToken', 'undefined');
      form.append('fileSize', String(size));
      form.append('totalPart', String(totalPart));
      form.append('channel', CHANNEL_CLOUD);
      form.append('directoryId', dirId);
      form.append('fileInfo', fileInfoEnc);
      form.append('partSize', String(chunk.length));
      form.append('partIndex', String(partIndex));
      form.append(
        'file',
        new Blob([chunk.slice().buffer], { type: 'application/octet-stream' }),
        name,
      );

      const res = await fetch(`${zone}/openapi/client/upload2C`, {
        method: 'POST',
        headers: {
          Origin: 'https://pan.wo.cn',
          Referer: 'https://pan.wo.cn/',
          'User-Agent': BROWSER_UA,
        },
        body: form,
      });
      const payload = (await res.json().catch(() => ({}))) as { code?: string; msg?: string };
      if (!res.ok || payload.code !== '0000') {
        throw new Error(
          `联通云盘上传第 ${partIndex}/${totalPart} 片失败：HTTP ${res.status} ${payload.code ?? ''} ${payload.msg ?? ''}`,
        );
      }
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
    const { dirId, flatPrefix } = await this.resolveDir(segs);
    const flatName = flatPrefix ? `${flatPrefix}_${name}` : name;
    const existing = await this.resolveFile(path);
    if (existing) {
      if (!file.overwrite) throw new Error('Object existed');
      await this.home('DeleteFile', {
        spaceType: SPACE_PERSONAL,
        vipLevel: '0',
        dirList: [],
        fileList: [existing.fid || existing.id],
        clientId: CLIENT_ID,
      });
    }
    await this.uploadStream(dirId, flatName, body, contentLength || file.size);
  }

  async get(source: string, range?: string | null): Promise<ObjectContent | null> {
    const resolved = await this.resolveFile(remotePathOf(this.rootPath, source));
    if (!resolved) return null;
    const url = await this.downloadUrl(resolved.fid || resolved.id);
    const headers: Record<string, string> = { 'User-Agent': BROWSER_UA };
    if (range) headers.Range = range;
    const res = await safeFetch(url, { headers });
    if (res.status === 404 || res.status === 416) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`联通云盘下载失败：HTTP ${res.status}`);
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
      await this.home('DeleteFile', {
        spaceType: SPACE_PERSONAL,
        vipLevel: '0',
        dirList: [],
        fileList: [resolved.fid || resolved.id],
        clientId: CLIENT_ID,
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
    if (!resolved) throw new Error(`联通云盘文件不存在：${source}`);
    return this.downloadUrl(resolved.fid || resolved.id);
  }

  async list(
    prefix: string,
    options: { continuation?: string; afterKey?: string; limit?: number } = {},
  ): Promise<{
    keys: { key: string; size: number; lastModified: Date }[];
    continuation: string | null;
  }> {
    const dir = prefix ? remotePathOf(this.rootPath, prefix) : this.rootPath;
    const { dirId } = await this.resolveDir(segmentsOf(dir));
    const files = await this.listFolder(dirId);
    const limit = Math.min(1000, Math.max(1, options.limit ?? 200));
    const keys = files
      .filter((f) => f.type !== 0)
      .slice(0, limit)
      .map((f) => ({
        key: prefix ? joinPath(prefix, f.name).replace(/^\//, '') : f.name,
        size: Number(f.size ?? 0),
        lastModified: f.createTime ? new Date(f.createTime) : new Date(),
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

  /** 供后台「连接测试」使用：读一次根目录（顺带验证 token）。 */
  async probe(): Promise<void> {
    await this.listFolder(this.rootFolderId);
  }
}
