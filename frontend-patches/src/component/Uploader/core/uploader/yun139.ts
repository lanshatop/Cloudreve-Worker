import Chunk, { ChunkInfo } from "./chunk";
import { s3LikeUploadChunk, s3LikeUploadCallback } from "../api";
import { Status } from "./base";
import { PolicyType } from "../../../../api/explorer.ts";

/**
 * 移动云盘（139）直传上传器。
 *
 * 服务端在创建会话阶段就已经调过 139 的 `/file/create`：用浏览器预计算的
 * 整文件 SHA-256 建好上传任务，并把每片的预签名地址放在 `session.upload_urls`。
 * 这里只负责把分片直接 PUT 到 139 的 EOS 桶，字节完全不经过 Worker ——
 * 从而绕开 Workers 免费档 10 ms CPU 上限（大文件哈希算不动是之前 503 的根因）。
 *
 * 收尾（`/file/complete`）需要 mcloud-sign，只能由 Worker 代签，所以最后
 * 打一次 GET `/api/v4/callback/yun139/{sessionID}/{secret}` 让服务端收尾。
 */
export default class Yun139 extends Chunk {
  protected async uploadChunk(chunkInfo: ChunkInfo) {
    // 秒传命中：139 已按 contentHash 落好文件，一个字节都不用传。
    // 后端此时返回 chunk_size=0 / skip_upload=true，Chunk 基类会把整个
    // 文件当成单块（getChunks 的 0 语义），这里直接把进度置满即可。
    if (this.task.session?.skip_upload) {
      this.logger.info("139 rapid upload hit, skipping chunk upload.");
      this.updateChunkProgress(chunkInfo.chunk.size, chunkInfo.index);
      return;
    }

    const url = this.task.session?.upload_urls?.[chunkInfo.index];
    if (!url) {
      throw new Error(`Missing 139 upload url for chunk ${chunkInfo.index}`);
    }

    const etag = await s3LikeUploadChunk(
      url,
      chunkInfo,
      (p) => {
        this.updateChunkProgress(p.loaded, chunkInfo.index);
      },
      this.cancelToken.token,
    );

    this.task.chunkProgress[chunkInfo.index].etag = etag;
  }

  protected async afterUpload(): Promise<any> {
    this.logger.info("Finishing 139 direct upload...");
    this.transit(Status.finishing);
    return s3LikeUploadCallback(
      this.task.session!.session_id,
      this.task.session!.callback_secret,
      PolicyType.yun139,
    );
  }
}
