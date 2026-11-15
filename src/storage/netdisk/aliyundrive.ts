/**
 * 阿里云盘原生驱动（开放平台 OpenAPI v1.0）。
 *
 * 与另外三家的区别：阿里云盘有**正式开放平台**，`openapi.aliyundrive.com`
 * 的 `/adrive/v1.0` 是官方接口，签名为标准 Bearer Token，不需要破解 Web 端
 * 私有签名。代价是鉴权走 OAuth2：
 *
 *   refresh_token --(POST /oauth/access_token)--> access_token（2 小时）
 *
 * refresh_token 长期有效但会轮换，所以驱动会缓存并在每次刷新后更新内存里的
 * 副本（不写 KV，避免消耗免费档 1000 写/天）。管理员若换了 token，保存策略
 * 会清掉 isolate 缓存。
 *
 * 上传：create（带 part_info_list）→ 对每个分片 PUT 到 OSS 预签名地址 →
 * complete。分片直传，Worker 只中转字节，不需要整文件哈希（秒传的
 * pre_hash 是可选项，这里不做，避免为了 SHA-1 把整个文件读两遍）。
 *
 * 策略字段映射：
 *   settings.ali_refresh_token → refresh_token（必填）
 *   access_key                 → client_id（可选，默认内置开放平台 AppID）
 *   secret_key                 → client_secret（可选）
 *   settings.ali_drive_id      → 盘 ID（留空自动取 resource drive）
 *   settings.ali_root_folder_id→ 根目录 file_id，默认 root
 *   bucket_name                → 根路径（如 /cloudreve，不存在会自动建）
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
  PartReader,
  joinPath,
  normalizeRoot,
  remotePathOf,
  segmentsOf,
  totalFromContentRange,
} from './common';

const API_BASE = 'https://openapi.aliyundrive.com/adrive/v1.0';
const TOKEN_URL = 'https://openapi.aliyundrive.com/oauth/access_token';
/** 阿里云盘官方示例客户端（开放平台文档里的公开 AppID）。 */
const DEFAULT_CLIENT_ID = '25ab4837190e48718a28f80073574a4d';
const PART_SIZE = 10 * 1024 * 1024;

interface AliFile {
  file_id: string;
  name: string;
  type: string;
  size?: number;
  updated_at?: string;
}

interface AliToken {
  accessToken: string;
  refreshToken: string;
  expireAt: number;
}

/** isolate 级 token 缓存：refresh_token 会轮换，必须跨请求复用。 */
const tokens = new Map<string, AliToken>();

export class AliyundriveDriver implements StorageDriver {
  readonly type: string;
  readonly chunkSize: number;
  readonly settings;

  private readonly refreshToken: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly rootPath: string;
  private readonly rootFolderId: string;
  private readonly driveIdHint: string;
  private readonly cacheKey: string;
  private driveId = '';
  private readonly dirCache = new Map<string, string>();

  constructor(readonly policy: StoragePolicyRow) {
    this.type = policy.type;
    this.settings = policy.settings ?? {};
    this.chunkSize = 0;

    this.refreshToken = (this.settings.ali_refresh_token ?? '').trim();
    if (!this.refreshToken) {
      throw new Error(
        `阿里云盘策略「${policy.name}」缺少 refresh_token：请填 settings.ali_refresh_token`,
      );
    }
    this.clientId = (policy.access_key ?? '').trim() || DEFAULT_CLIENT_ID;
    this.clientSecret = (policy.secret_key ?? '').trim();
    this.driveIdHint = (this.settings.ali_drive_id ?? '').trim();
    this.rootFolderId = (this.settings.ali_root_folder_id ?? '').trim() || 'root';
    this.rootPath = normalizeRoot(policy.bucket_name);
    this.cacheKey = `ali:${policy.id}`;
    this.driveId = this.driveIdHint;
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
    tokens.delete(`ali:${policyId}`);
  }

  // -------------------------------------------------------------------------
  // 鉴权
  // -------------------------------------------------------------------------

  private async accessToken(): Promise<string> {
    const hit = tokens.get(this.cacheKey);
    if (hit && hit.expireAt > Date.now() + 60_000) return hit.accessToken;
    const body: Record<string, string> = {
      grant_type: 'refresh_token',
      refresh_token: hit?.refreshToken ?? this.refreshToken,
      client_id: this.clientId,
    };
    if (this.clientSecret) body.client_secret = this.clientSecret;

    const res = await safeFetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      message?: string;
      code?: string;
    };
    if (!res.ok || !data.access_token) {
      throw new Error(
        `阿里云盘 token 刷新失败（HTTP ${res.status}）：${data.message ?? data.code ?? '无返回'}`,
      );
    }
    const entry: AliToken = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || (body.refresh_token as string),
      expireAt: Date.now() + (data.expires_in ?? 7200) * 1000,
    };
    tokens.set(this.cacheKey, entry);
    return entry.accessToken;
  }

  private async api<T>(path: string, body: Record<string, unknown>, retry = true): Promise<T> {
    const token = await this.accessToken();
    const res = await safeFetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    if (res.status === 401 && retry) {
      tokens.delete(this.cacheKey);
      return this.api<T>(path, body, false);
    }
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`阿里云盘 API ${path} 失败（HTTP ${res.status}）：${text.slice(0, 200)}`);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`阿里云盘 API ${path} 返回非 JSON：${text.slice(0, 160)}`);
    }
  }

  private async ensureDrive(): Promise<string> {
    if (this.driveId) return this.driveId;
    const info = await this.api<{
      resource_drive_id?: string;
      default_drive_id?: string;
      backup_drive_id?: string;
    }>('/user/getDriveInfo', {});
    this.driveId = info.resource_drive_id || info.default_drive_id || info.backup_drive_id || '';
    if (!this.driveId) throw new Error('阿里云盘未返回可用的 drive_id，请在策略里手动填写');
    return this.driveId;
  }

  // -------------------------------------------------------------------------
  // 目录 / 文件解析
  // -------------------------------------------------------------------------

  private async listFolder(parentId: string): Promise<AliFile[]> {
    const driveId = await this.ensureDrive();
    const items: AliFile[] = [];
    let marker: string | undefined;
    for (let page = 0; page < 50; page++) {
      const body: Record<string, unknown> = {
        drive_id: driveId,
        parent_file_id: parentId,
        limit: 200,
        order_by: 'name',
        order_direction: 'ASC',
      };
      if (marker) body.marker = marker;
      const resp = await this.api<{ items?: AliFile[]; next_marker?: string }>(
        '/openFile/list',
        body,
      );
      items.push(...(resp.items ?? []));
      marker = resp.next_marker;
      if (!marker) break;
    }
    return items;
  }

  private async createFolder(parentId: string, name: string): Promise<string> {
    const driveId = await this.ensureDrive();
    const resp = await this.api<{ file_id?: string }>('/openFile/create', {
      drive_id: driveId,
      parent_file_id: parentId,
      name,
      type: 'folder',
      check_name_mode: 'refuse',
    });
    if (!resp.file_id) throw new Error(`阿里云盘创建目录失败：${name}`);
    return resp.file_id;
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
      const hit = items.find((f) => f.name === seg && f.type === 'folder');
      current = hit ? hit.file_id : await this.createFolder(current, seg);
      this.dirCache.set(key, current);
    }
    return current;
  }

  private async resolveFile(path: string): Promise<AliFile | null> {
    const segs = segmentsOf(path);
    if (!segs.length) return null;
    const name = segs.pop()!;
    const parentId = await this.resolveDir(segs);
    const items = await this.listFolder(parentId);
    return items.find((f) => f.name === name && f.type !== 'folder') ?? null;
  }

  private async downloadUrl(fileId: string): Promise<string> {
    const driveId = await this.ensureDrive();
    const resp = await this.api<{ url?: string; download_url?: string }>('/openFile/getDownloadUrl', {
      drive_id: driveId,
      file_id: fileId,
      expire_sec: 14400,
    });
    const url = resp.url || resp.download_url || '';
    if (!url) throw new Error(`阿里云盘未返回下载地址（fileId=${fileId}）`);
    return url;
  }

  // -------------------------------------------------------------------------
  // 上传
  // -------------------------------------------------------------------------

  private async uploadStream(
    parentId: string,
    name: string,
    stream: ReadableStream,
    size: number,
  ): Promise<void> {
    const driveId = await this.ensureDrive();
    const partCount = Math.max(1, Math.ceil(size / PART_SIZE));
    const create = await this.api<{
      file_id?: string;
      upload_id?: string;
      part_info_list?: { part_number: number; upload_url?: string }[];
    }>('/openFile/create', {
      drive_id: driveId,
      parent_file_id: parentId,
      name,
      type: 'file',
      size,
      check_name_mode: 'refuse',
      part_info_list: Array.from({ length: partCount }, (_, i) => ({ part_number: i + 1 })),
    });
    if (!create.file_id || !create.upload_id) {
      throw new Error('阿里云盘创建上传任务失败（缺 file_id / upload_id）');
    }
    const urls = new Map<number, string>();
    for (const part of create.part_info_list ?? []) {
      if (part.upload_url) urls.set(part.part_number, part.upload_url);
    }

    const reader = new PartReader(stream as ReadableStream<Uint8Array>);
    for (let partNumber = 1; partNumber <= partCount; partNumber++) {
      const expected =
        partNumber === partCount ? size - (partNumber - 1) * PART_SIZE : PART_SIZE;
      const chunk = await reader.read(PART_SIZE);
      if (chunk.length !== expected) {
        throw new Error(
          `阿里云盘上传中断：第 ${partNumber} 片收到 ${chunk.length}，应为 ${expected}`,
        );
      }
      const url = urls.get(partNumber);
      if (!url) throw new Error(`阿里云盘未下发第 ${partNumber} 片的上传地址`);
      assertSafeRemoteUrl(url);
      const put = await fetch(url, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: chunk as unknown as BodyInit,
      });
      if (!put.ok) {
        const text = await put.text().catch(() => '');
        throw new Error(`阿里云盘上传第 ${partNumber} 片失败：HTTP ${put.status} ${text.slice(0, 120)}`);
      }
      await put.body?.cancel().catch(() => {});
    }

    await this.api('/openFile/complete', {
      drive_id: driveId,
      file_id: create.file_id,
      upload_id: create.upload_id,
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
    const existing = await this.resolveFile(path);
    if (existing) {
      if (!file.overwrite) throw new Error('Object existed');
      await this.deleteFile(existing.file_id);
    }
    await this.uploadStream(parentId, name, body, contentLength || file.size);
  }

  private async deleteFile(fileId: string): Promise<void> {
    const driveId = await this.ensureDrive();
    const trash = this.settings.ali_remove_permanent !== true;
    await this.api(trash ? '/openFile/recyclebin' : '/openFile/delete', {
      drive_id: driveId,
      file_id: fileId,
    });
  }

  async get(source: string, range?: string | null): Promise<ObjectContent | null> {
    const resolved = await this.resolveFile(remotePathOf(this.rootPath, source));
    if (!resolved) return null;
    const url = await this.downloadUrl(resolved.file_id);
    const headers: Record<string, string> = {};
    if (range) headers.Range = range;
    const res = await safeFetch(url, { headers });
    if (res.status === 404 || res.status === 416) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`阿里云盘下载失败：HTTP ${res.status}`);
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
      if (resolved) await this.deleteFile(resolved.file_id);
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
    if (!resolved) throw new Error(`阿里云盘文件不存在：${source}`);
    return this.downloadUrl(resolved.file_id);
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
      .filter((f) => f.type !== 'folder')
      .slice(0, limit)
      .map((f) => ({
        key: prefix ? joinPath(prefix, f.name).replace(/^\//, '') : f.name,
        size: Number(f.size ?? 0),
        lastModified: f.updated_at ? new Date(f.updated_at) : new Date(),
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

  /** 供后台「连接测试」使用：刷新 token + 解析 drive_id + 读根目录。 */
  async probe(): Promise<void> {
    await this.ensureDrive();
    await this.listFolder(this.rootFolderId);
  }
}
