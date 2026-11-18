/**
 * yun139 上传路径专项测试（配合 scripts/test-yun139-upload.mjs 运行）。
 *
 * 覆盖 2026-11-18 重构后的四条上传分支：
 *  1. 客户端预计算哈希（浏览器 content_hash）→ R2 暂存 + create 带真实哈希
 *  2. 秒传命中（exist / rapidUpload）→ 不再 PUT / complete
 *  3. 无哈希 + ≤512KB → Worker 内 WebCrypto 现算
 *  4. 无哈希 + >512KB → 明确报错（绝不静默打爆 CPU）
 */
import { createHash } from 'node:crypto';
import type { Env } from '../src/env';
import type { StoragePolicyRow, UploadRequest, UploadSession } from '../src/db/types';
import { Yun139Driver } from '../src/storage/netdisk/yun139';
import { PolicyType } from '../src/lib/boolset';

let passed = 0;
const failures: string[] = [];

function ok(name: string, cond: unknown, detail?: unknown) {
  if (cond) {
    passed++;
    return;
  }
  failures.push(detail === undefined ? name : `${name} → ${JSON.stringify(detail)}`);
}
function eq(name: string, actual: unknown, expected: unknown) {
  ok(`${name} (got ${JSON.stringify(actual)})`, JSON.stringify(actual) === JSON.stringify(expected));
}

interface Call {
  url: string;
  method: string;
  body: unknown;
  bodyLen: number;
}
const calls: Call[] = [];
const putBytes = new Map<string, number>();
const encoder = new TextEncoder();

/** R2 mock：内存 Map 支撑 get(range)/put/delete */
class FakeR2 {
  store = new Map<string, Uint8Array>();
  ops = 0;
  async put(key: string, value: unknown) {
    this.ops++;
    const bytes =
      value instanceof Uint8Array
        ? value
        : new Uint8Array(await new Response(value as ReadableStream).arrayBuffer());
    this.store.set(key, bytes);
    return {};
  }
  async get(key: string, opts?: { range?: { offset: number; length: number } }) {
    this.ops++;
    const data = this.store.get(key);
    if (!data) return null;
    const range = opts?.range;
    const slice = range ? data.subarray(range.offset, range.offset + range.length) : data;
    return { arrayBuffer: async () => slice.slice().buffer };
  }
  async delete(key: string) {
    this.ops++;
    this.store.delete(key);
  }
}
const fakeR2 = new FakeR2();

/** create 收到的 contentHash（按请求次序记录） */
const createHashes: (string | undefined)[] = [];
/** create 收到的完整 body（按请求次序记录） */
const createBodies: Record<string, unknown>[] = [];
/** complete 收到的 body */
const completeBodies: Record<string, unknown>[] = [];
/** 本次 mock 的秒传命中模式 */
let rapidMode: 'none' | 'exist' | 'rapid' = 'none';

function resetMocks() {
  calls.length = 0;
  putBytes.clear();
  createHashes.length = 0;
  createBodies.length = 0;
  completeBodies.length = 0;
  fakeR2.store.clear();
  rapidMode = 'none';
}

globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
  const url = String(input);
  const method = (init.method || 'GET').toUpperCase();
  let body: unknown = init.body;
  let bodyLen = 0;
  if (init.body instanceof Uint8Array) bodyLen = init.body.byteLength;
  else if (typeof init.body === 'string') bodyLen = encoder.encode(init.body).length;
  calls.push({ url, method, body, bodyLen });

  if (url.includes('/user/route/qryRoutePolicy')) {
    return json({
      success: true,
      code: '0000',
      data: { routePolicyList: [{ modName: 'personal', httpsUrl: 'https://personal.example.com/hcy' }] },
    });
  }
  if (url === 'https://personal.example.com/hcy/file/list') {
    return json({ success: true, code: '0000', data: { items: [], nextPageCursor: '' } });
  }
  if (url === 'https://personal.example.com/hcy/file/create') {
    const parsed = JSON.parse(String(init.body)) as {
      type?: string;
      contentHash?: string;
      size?: number;
      partInfos?: { partNumber: number; partSize: number }[];
    };
    if (parsed.type === 'folder') return json({ success: true, code: '0000', data: { fileId: 'y-dir-1' } });
    createHashes.push(parsed.contentHash);
    createBodies.push(parsed as unknown as Record<string, unknown>);
    if (rapidMode === 'exist') return json({ success: true, code: '0000', data: { exist: true } });
    if (rapidMode === 'rapid') return json({ success: true, code: '0000', data: { rapidUpload: true } });
    return json({
      success: true,
      code: '0000',
      data: {
        fileId: 'y-file-1',
        uploadId: 'y-upload-1',
        partInfos: [{ partNumber: 1, uploadUrl: 'https://up139.example.com/p1' }],
      },
    });
  }
  if (url === 'https://personal.example.com/hcy/file/getUploadUrl') {
    return json({
      success: true,
      code: '0000',
      data: { partInfos: [{ partNumber: 1, uploadUrl: 'https://up139.example.com/p1' }] },
    });
  }
  if (url === 'https://up139.example.com/p1') {
    putBytes.set('yun139', bodyLen);
    return new Response(null, { status: 200 });
  }
  if (url === 'https://personal.example.com/hcy/file/complete') {
    completeBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return json({ success: true, code: '0000' });
  }
  return json({ success: false, code: '9999', message: `unexpected url ${url}` }, 500);
}) as typeof fetch;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// ------------------------------------------------------------------

const AUTH = Buffer.from(
  '13800000000:13800000000:tok|1|2|' + (Date.now() + 86400000),
).toString('base64');

function makeDriver(): Yun139Driver {
  return new Yun139Driver(
    { R2: fakeR2 } as unknown as Env,
    policy({
      id: 104,
      type: PolicyType.Yun139,
      bucket_name: '',
      settings: { y139_authorization: AUTH, y139_root_folder_id: '/' },
    }),
  );
}

function policy(overrides: Partial<StoragePolicyRow>): StoragePolicyRow {
  return {
    id: 1,
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
    name: 'test',
    type: 's3',
    server: null,
    bucket_name: '/cloudreve',
    is_private: false,
    max_size: 1024 * 1024 * 1024,
    dir_name_rule: null,
    file_name_rule: null,
    access_key: null,
    secret_key: null,
    settings: {},
    node_id: null,
    ...overrides,
  } as StoragePolicyRow;
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function uploadReq(over: Partial<UploadRequest> = {}): UploadRequest {
  return {
    savePath: 'uploads/x.bin',
    fileName: 'x.bin',
    size: 0,
    mimeType: 'application/octet-stream',
    overwrite: true,
    ...over,
  } as UploadRequest;
}

function sessionOf(over: Partial<UploadSession> = {}): UploadSession {
  return {
    id: 'sess-1',
    savePath: 'uploads/x.bin',
    mimeType: 'application/octet-stream',
    expireAt: Date.now() + 3600_000,
    ...over,
  } as UploadSession;
}

function sha256hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function randBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + 7) & 0xff;
  return b;
}

// =========================== 用例 ===========================

// --- 1) 中等文件（2MB）+ 客户端预计算哈希：走 R2 暂存路径 ---
{
  resetMocks();
  const size = 2 * 1024 * 1024;
  const data = randBytes(size);
  const hash = sha256hex(data);
  const driver = makeDriver();
  await driver.put(uploadReq({ size, contentHash: hash }), streamOf(data), size);

  eq('A: create 次数', createHashes.length, 1);
  eq('A: create 带客户端哈希', createHashes[0], hash);
  eq('A: create partSize=整文件', (createBodies[0].partInfos as { partSize: number }[])[0]?.partSize, size);
  eq('A: PUT 分片字节数', putBytes.get('yun139'), size);
  eq('A: complete 次数', completeBodies.length, 1);
  eq('A: complete 带哈希', completeBodies[0].contentHash, hash);
  eq('A: complete 带 fileId/uploadId', completeBodies[0].fileId, 'y-file-1');
  eq('A: R2 临时对象已清理', fakeR2.store.size, 0);
  ok('A: 未请求 getUploadUrl（create 已下发）', !calls.some((c) => c.url.endsWith('/getUploadUrl')));
}

// --- 2) 秒传命中 exist:true：不 PUT、不 complete ---
{
  resetMocks();
  rapidMode = 'exist';
  const size = 512 * 1024;
  const data = randBytes(size);
  const driver = makeDriver();
  await driver.put(uploadReq({ size, contentHash: sha256hex(data) }), streamOf(data), size);
  eq('B: 秒传不 PUT', putBytes.get('yun139'), undefined);
  eq('B: 秒传不 complete', completeBodies.length, 0);
  eq('B: R2 已清理', fakeR2.store.size, 0);
}

// --- 3) 秒传命中 rapidUpload:true（无 uploadId）：不抛错 ---
{
  resetMocks();
  rapidMode = 'rapid';
  const size = 512 * 1024;
  const data = randBytes(size);
  const driver = makeDriver();
  let threw = '';
  try {
    await driver.put(uploadReq({ size, contentHash: sha256hex(data) }), streamOf(data), size);
  } catch (e) {
    threw = (e as Error).message;
  }
  eq('C: rapidUpload 不抛错', threw, '');
  eq('C: rapidUpload 不 PUT', putBytes.get('yun139'), undefined);
}

// --- 4) >512KB 且无哈希：明确报错，不触碰 139 ---
{
  resetMocks();
  const size = 700 * 1024;
  const data = randBytes(size);
  const driver = makeDriver();
  let threw = '';
  try {
    await driver.put(uploadReq({ size }), streamOf(data), size);
  } catch (e) {
    threw = (e as Error).message;
  }
  ok('D: 大文件无哈希报错', /预计算的\s*SHA-256|超过/.test(threw), threw);
  eq('D: 未发起 create', createHashes.length, 0);
}

// --- 5) ≤512KB 且无哈希：Worker 内 WebCrypto 现算 ---
{
  resetMocks();
  const size = 100 * 1024;
  const data = randBytes(size);
  const expect = sha256hex(data);
  const driver = makeDriver();
  await driver.put(uploadReq({ size }), streamOf(data), size);
  eq('E: 现算哈希正确', createHashes[0], expect);
  eq('E: PUT 字节数', putBytes.get('yun139'), size);
  eq('E: complete 哈希一致', completeBodies[0].contentHash, expect);
}

// --- 6) 无效格式哈希：按无哈希处理 ---
{
  resetMocks();
  const size = 700 * 1024;
  const data = randBytes(size);
  const driver = makeDriver();
  let threw = '';
  try {
    await driver.put(uploadReq({ size, contentHash: 'not-a-hash' }), streamOf(data), size);
  } catch (e) {
    threw = (e as Error).message;
  }
  ok('F: 非法哈希按缺失处理并报错', /预计算的\s*SHA-256|超过/.test(threw), threw);
}

// --- 7) writeChunk 透传 session.contentHash ---
{
  resetMocks();
  const size = 1024 * 1024;
  const data = randBytes(size);
  const hash = sha256hex(data);
  const driver = makeDriver();
  await driver.writeChunk(sessionOf({ contentHash: hash, savePath: 'uploads/x.bin' }), 0, streamOf(data), size);
  eq('G: writeChunk 透传哈希到 create', createHashes[0], hash);
  eq('G: PUT 字节数', putBytes.get('yun139'), size);
}

// --- 8) create 响应未带 uploadUrl：补 getUploadUrl ---
{
  resetMocks();
  // 临时改 create 响应：不下发 uploadUrl
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    if (url === 'https://personal.example.com/hcy/file/create') {
      const parsed = JSON.parse(String(init.body)) as { type?: string };
      if (parsed.type === 'folder') return json({ success: true, code: '0000', data: { fileId: 'y-dir-1' } });
      return json({ success: true, code: '0000', data: { fileId: 'y-file-1', uploadId: 'y-upload-1', partInfos: [] } });
    }
    return (origFetch as (i: unknown, r?: RequestInit) => Promise<Response>)(input, init);
  }) as typeof fetch;
  try {
    const size = 1024 * 1024;
    const data = randBytes(size);
    const driver = makeDriver();
    await driver.put(uploadReq({ size, contentHash: sha256hex(data) }), streamOf(data), size);
    ok('H: 已补发 getUploadUrl', calls.some((c) => c.url.endsWith('/getUploadUrl')));
    eq('H: PUT 字节数', putBytes.get('yun139'), size);
    eq('H: complete 已调用', completeBodies.length, 1);
  } finally {
    globalThis.fetch = origFetch;
  }
}

// ------------------------------------------------------------------

if (failures.length) {
  console.error(`\n✗ ${failures.length} 项失败 / ${passed} 项通过`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ yun139 上传路径专项测试全部通过（${passed} 项断言）`);
