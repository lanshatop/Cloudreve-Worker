/**
 * 国内网盘原生驱动的冒烟测试（无网络）。
 *
 * 用 mock 的全局 fetch 拦截所有出站请求，逐家验证「协议形态」是否正确：
 *
 *   天翼 189   Cookie 鉴权 → listFiles → createFolder → initMultiUpload(lazyCheck)
 *              → getMultiUploadUrls → PUT 预签名地址 → commitMultiUploadFile
 *   联通 WoPan dispatcher 信封（header.sign + AES-CBC param）→ QueryAllFiles
 *              → CreateDirectory → GetZoneInfo → upload2C multipart 分片
 *   阿里云盘   OAuth refresh_token → getDriveInfo → openFile/create(part_info_list)
 *              → PUT 各分片 → openFile/complete
 *   移动 139   qryRoutePolicy 取 host → file/list → file/create(SHA-256)
 *              → PUT 预签名分片 → file/complete；含 R2 暂存 mock
 *
 * 另测：四家都在 RELAY 白名单里、openlist 已从支持列表移除、
 * 路径穿越被过滤、文件字节数一致。
 *
 * 由 scripts/test-netdisk.mjs 用 esbuild 打包后执行（`npm run test:netdisk`）。
 */
import { createHash, generateKeyPairSync } from 'node:crypto';
import { Cloud189Driver } from '../src/storage/netdisk/cloud189';
import { WoPanDriver } from '../src/storage/netdisk/wopan';
import { AliyundriveDriver } from '../src/storage/netdisk/aliyundrive';
import { Yun139Driver } from '../src/storage/netdisk/yun139';
import { SUPPORTED_POLICY_TYPES, isRelayOnlyPolicyType } from '../src/storage/index';
import { PolicyType } from '../src/lib/boolset';
import type { StoragePolicyRow } from '../src/db/types';
import type { Env } from '../src/env';

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
  headers: Record<string, string>;
  body: unknown;
  form?: Record<string, string>;
  bodyLen: number;
}

const calls: Call[] = [];
const encoder = new TextEncoder();
/** 记录每个 mock 服务收到的 PUT 字节数 */
const putBytes = new Map<string, number>();

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const CONTENT = new TextEncoder().encode('hello netdisk!'); // 14 bytes
const CONTENT_MD5 = createHash('md5').update(CONTENT).digest('hex');
const CONTENT_SHA256 = createHash('sha256').update(CONTENT).digest('hex');

/** R2 mock：内存 Map 支撑 get(range)/put/delete */
class FakeR2 {
  store = new Map<string, Uint8Array>();
  async put(key: string, value: unknown) {
    const bytes =
      value instanceof Uint8Array
        ? value
        : new Uint8Array(await new Response(value as ReadableStream).arrayBuffer());
    this.store.set(key, bytes);
    return {};
  }
  async get(key: string, opts?: { range?: { offset: number; length: number } }) {
    const data = this.store.get(key);
    if (!data) return null;
    const range = opts?.range;
    const slice = range ? data.subarray(range.offset, range.offset + range.length) : data;
    return { arrayBuffer: async () => slice.slice().buffer };
  }
  async delete(key: string) {
    this.store.delete(key);
  }
}

const fakeR2 = new FakeR2();

globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
  const url = String(input);
  const method = (init.method || 'GET').toUpperCase();
  const headers: Record<string, string> = {};
  const rawHeaders = (init.headers ?? {}) as Record<string, string>;
  for (const [k, v] of Object.entries(rawHeaders)) headers[k.toLowerCase()] = String(v);

  let body: unknown = init.body;
  let form: Record<string, string> | undefined;
  let bodyLen = 0;
  if (init.body instanceof FormData) {
    form = {};
    for (const [k, v] of init.body.entries()) {
      form[k] = typeof v === 'string' ? v : `<blob ${(v as Blob).size}>`;
      if (v instanceof Blob) bodyLen += v.size;
    }
  } else if (init.body instanceof Uint8Array) {
    bodyLen = init.body.byteLength;
  } else if (typeof init.body === 'string') {
    bodyLen = encoder.encode(init.body).length;
  }
  calls.push({ url, method, headers, body, form, bodyLen });

  // ---------- 天翼云盘 ----------
  if (url.includes('/api/open/file/listFiles.action')) {
    const folderId = new URL(url).searchParams.get('folderId') ?? '';
    if (folderId === 'root1') {
      return json({
        fileListAO: { count: 1, fileList: [], folderList: [{ id: 'folder-1', name: 'uploads' }] },
      });
    }
    if (folderId === 'folder-1') {
      return json({
        fileListAO: { count: 1, fileList: [{ id: '9001', name: 'x.bin', size: 14 }], folderList: [] },
      });
    }
    return json({ fileListAO: { count: 0, fileList: [], folderList: [] } });
  }
  if (url.includes('/api/open/file/createFolder.action')) return json({ id: 'folder-1' });
  if (url.includes('/v2/getUserBriefInfo.action')) return json({ sessionKey: 'sk-1' });
  if (url.includes('/api/security/generateRsaKey.action')) {
    return json({ pubKey: RSA_TEST_KEY, pkId: 'pk-1', expire: Date.now() + 60_000 });
  }
  if (url.includes('/person/initMultiUpload')) {
    return json({ code: 'SUCCESS', data: { uploadFileId: 'uf-1', fileDataExists: '0' } });
  }
  if (url.includes('/person/getMultiUploadUrls')) {
    return json({
      code: 'SUCCESS',
      uploadUrls: { partNumber_1: { requestURL: 'https://up189.example.com/p1', requestHeader: '' } },
    });
  }
  if (url.includes('/person/commitMultiUploadFile')) return json({ code: 'SUCCESS' });
  if (url.includes('/api/portal/getFileInfo.action')) {
    return json({ fileDownloadUrl: 'https://down189.example.com/f1' });
  }
  if (url === 'https://up189.example.com/p1' || url === 'https://down189.example.com/f1') {
    putBytes.set(url, bodyLen);
    if (method === 'PUT') return new Response(null, { status: 200 });
    return new Response(CONTENT, {
      status: 200,
      headers: { 'content-length': String(CONTENT.length), 'content-type': 'application/octet-stream' },
    });
  }

  // ---------- 联通云盘 ----------
  if (url.includes('/wohome/dispatcher') || url.includes('/api-user/dispatcher')) {
    const envelope = JSON.parse(String(init.body)) as { header: { key: string } };
    switch (envelope.header.key) {
      case 'QueryAllFiles':
        return json({ STATUS: '200', RSP: { RSP_CODE: '0000', DATA: { files: [] } } });
      case 'CreateDirectory':
        return json({ STATUS: '200', RSP: { RSP_CODE: '0000', DATA: { id: 'wdir-1' } } });
      case 'GetZoneInfo':
        return json({ STATUS: '200', RSP: { RSP_CODE: '0000', DATA: { url: 'https://zone.example.com' } } });
      case 'DeleteFile':
        return json({ STATUS: '200', RSP: { RSP_CODE: '0000', DATA: {} } });
      case 'GetDownloadUrlV2':
        return json({
          STATUS: '200',
          RSP: { RSP_CODE: '0000', DATA: { list: [{ fid: 'wf-1', downloadUrl: 'https://downwo.example.com/f' }] } },
        });
      default:
        return json({ STATUS: '200', RSP: { RSP_CODE: '0000', DATA: {} } });
    }
  }
  if (url === 'https://zone.example.com/openapi/client/upload2C') {
    return json({ code: '0000', data: { fid: 'wf-1' } });
  }
  if (url === 'https://downwo.example.com/f') {
    return new Response(CONTENT, {
      status: 200,
      headers: { 'content-length': String(CONTENT.length) },
    });
  }

  // ---------- 阿里云盘 ----------
  if (url === 'https://openapi.aliyundrive.com/oauth/access_token') {
    return json({ access_token: 'ali-at', refresh_token: 'ali-rt-2', expires_in: 7200 });
  }
  if (url.endsWith('/user/getDriveInfo')) return json({ resource_drive_id: 'drive-1' });
  if (url.endsWith('/openFile/list')) {
    return json({ items: [{ file_id: 'ali-file-1', name: 'x.bin', type: 'file', size: 14 }] });
  }
  if (url.endsWith('/openFile/create')) {
    const parsed = JSON.parse(String(init.body)) as { type?: string };
    if (parsed.type === 'folder') return json({ file_id: 'ali-dir-1' });
    return json({
      file_id: 'ali-file-1',
      upload_id: 'ali-upload-1',
      part_info_list: [{ part_number: 1, upload_url: 'https://oss.example.com/p1' }],
    });
  }
  if (url === 'https://oss.example.com/p1') {
    putBytes.set('aliyun', bodyLen);
    return new Response(null, { status: 200 });
  }
  if (url.endsWith('/openFile/complete')) return json({});
  if (url.endsWith('/openFile/getDownloadUrl')) {
    return json({ url: 'https://downali.example.com/f' });
  }
  if (url === 'https://downali.example.com/f') {
    return new Response(CONTENT, {
      status: 200,
      headers: { 'content-length': String(CONTENT.length) },
    });
  }
  if (url.endsWith('/openFile/recyclebin') || url.endsWith('/openFile/delete')) return json({});

  // ---------- 移动云盘 ----------
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
    const parsed = JSON.parse(String(init.body)) as { type?: string; contentHash?: string };
    if (parsed.type === 'folder') return json({ success: true, code: '0000', data: { fileId: 'y-dir-1' } });
    (globalThis as { __y139Hash?: string }).__y139Hash = parsed.contentHash;
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
  if (url === 'https://up139.example.com/p1') {
    putBytes.set('yun139', bodyLen);
    return new Response(null, { status: 200 });
  }
  if (url === 'https://personal.example.com/hcy/file/complete') {
    return json({ success: true, code: '0000' });
  }
  if (url === 'https://personal.example.com/hcy/file/getDownloadUrl') {
    return json({ success: true, code: '0000', data: { url: 'https://down139.example.com/f' } });
  }
  if (url === 'https://down139.example.com/f') {
    return new Response(CONTENT, {
      status: 200,
      headers: { 'content-length': String(CONTENT.length) },
    });
  }
  if (url === 'https://personal.example.com/hcy/file/delete') {
    return json({ success: true, code: '0000' });
  }

  return json({ error: 'unmocked', url }, 599);
}) as typeof fetch;

/** 现场生成一把 2048 位 RSA 公钥，只为跑通天翼的上传签名分支 */
const RSA_TEST_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({
  type: 'spki',
  format: 'pem',
}) as string;

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
    max_size: 95 * 1024 * 1024,
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

const uploadReq = {
  savePath: 'uploads/x.bin',
  fileName: 'x.bin',
  size: CONTENT.length,
  mimeType: 'application/octet-stream',
  overwrite: true,
};

// =========================== 天翼云盘 ===========================
{
  calls.length = 0;
  putBytes.clear();
  const driver = new Cloud189Driver(
    policy({
      id: 101,
      type: PolicyType.Cloud189,
      bucket_name: '',
      settings: { c189_cookie: 'COOKIE_LOGIN_USER=abc; sessionKey=sk', c189_root_folder_id: 'root1' },
    }),
  );

  await driver.put(uploadReq, streamOf(CONTENT), CONTENT.length);

  const listCalls = calls.filter((c) => c.url.includes('listFiles.action'));
  ok('189: 列目录（解析根）', listCalls.length >= 1);
  ok('189: Cookie 透传', listCalls[0]?.headers.cookie?.includes('COOKIE_LOGIN_USER=abc'));
  const init = calls.find((c) => c.url.includes('/person/initMultiUpload'));
  ok('189: initMultiUpload 已调用', !!init);
  ok('189: init 带签名头', !!init?.headers.signature && !!init?.headers.encryptiontext && !!init?.headers.pkid);
  ok('189: init 参数已加密（params=）', (init?.url ?? '').includes('params='));
  const partPut = calls.find((c) => c.url === 'https://up189.example.com/p1');
  eq('189: 分片字节数', putBytes.get('https://up189.example.com/p1'), CONTENT.length);
  ok('189: 分片为 PUT', partPut?.method === 'PUT');
  ok('189: commit 已调用', calls.some((c) => c.url.includes('/person/commitMultiUploadFile')));

  // 下载：Range 透传
  calls.length = 0;
  const got = await driver.get('uploads/x.bin', 'bytes=0-3');
  const dl = calls.find((c) => c.url === 'https://down189.example.com/f1');
  eq('189: 下载带 Range', dl?.headers.range, 'bytes=0-3');
  ok('189: 下载返回 body', !!got?.body);
  await got?.body.cancel().catch(() => {});
}

// =========================== 联通云盘 ===========================
{
  calls.length = 0;
  putBytes.clear();
  const driver = new WoPanDriver(
    policy({
      id: 102,
      type: PolicyType.WoPan,
      bucket_name: '',
      settings: { wp_access_token: 'wp-at-1234567890abcdef', wp_refresh_token: 'wp-rt' },
    }),
  );

  await driver.put(uploadReq, streamOf(CONTENT), CONTENT.length);

  const dispatcher = calls.filter((c) => c.url.includes('/dispatcher'));
  ok('联通: dispatcher 已调用', dispatcher.length >= 1);
  const envelope = JSON.parse(String(dispatcher[0]?.body)) as {
    header: { key: string; sign: string; channel: string };
    body: { param: string };
  };
  eq('联通: 首个业务方法', envelope.header.key, 'QueryAllFiles');
  ok('联通: header.sign 为 32 位 hex', /^[0-9a-f]{32}$/.test(envelope.header.sign), envelope.header.sign);
  ok('联通: param 已加密（base64）', /^[A-Za-z0-9+/=]+$/.test(envelope.body.param));
  eq('联通: Accesstoken 头', dispatcher[0]?.headers.accesstoken, 'wp-at-1234567890abcdef');

  const upload = calls.find((c) => c.url.endsWith('/upload2C'));
  ok('联通: upload2C 已调用', !!upload);
  eq('联通: totalPart', upload?.form?.totalPart, '1');
  eq('联通: partIndex', upload?.form?.partIndex, '1');
  eq('联通: fileSize', upload?.form?.fileSize, String(CONTENT.length));
  ok('联通: file 字段带字节', (upload?.form?.file ?? '').includes('blob 14'));
  ok('联通: fileInfo 加密', (upload?.form?.fileInfo ?? '').length > 20);
}

// =========================== 阿里云盘 ===========================
{
  calls.length = 0;
  putBytes.clear();
  const driver = new AliyundriveDriver(
    policy({
      id: 103,
      type: PolicyType.Aliyundrive,
      bucket_name: '',
      settings: { ali_refresh_token: 'ali-rt-1' },
    }),
  );

  await driver.put(uploadReq, streamOf(CONTENT), CONTENT.length);

  const tokenCall = calls.find((c) => c.url.includes('/oauth/access_token'));
  ok('阿里: 已刷新 token', !!tokenCall);
  const tokenBody = JSON.parse(String(tokenCall?.body)) as Record<string, string>;
  eq('阿里: grant_type', tokenBody.grant_type, 'refresh_token');
  eq('阿里: 使用配置的 refresh_token', tokenBody.refresh_token, 'ali-rt-1');

  const create = calls.find((c) => c.url.endsWith('/openFile/create') && String(c.body).includes('"file"'));
  ok('阿里: create 带 part_info_list', String(create?.body).includes('part_info_list'));
  ok(
    '阿里: Bearer 鉴权',
    calls.some((c) => c.url.includes('/adrive/v1.0/') && (c.headers.authorization ?? '').startsWith('Bearer ')),
  );
  eq('阿里: 分片字节数', putBytes.get('aliyun'), CONTENT.length);
  ok('阿里: complete 已调用', calls.some((c) => c.url.endsWith('/openFile/complete')));
}

// =========================== 移动云盘 ===========================
{
  calls.length = 0;
  putBytes.clear();
  const auth = Buffer.from('13800000000:13800000000:tok|1|2|' + (Date.now() + 86400000)).toString('base64');
  const driver = new Yun139Driver({ R2: fakeR2 } as unknown as Env, policy({
    id: 104,
    type: PolicyType.Yun139,
    bucket_name: '',
    settings: { y139_authorization: auth, y139_root_folder_id: '/' },
  }));

  await driver.put(uploadReq, streamOf(CONTENT), CONTENT.length);

  const route = calls.find((c) => c.url.includes('qryRoutePolicy'));
  ok('移动: 已解析路由', !!route);
  ok('移动: Basic 鉴权', (route?.headers.authorization ?? '').startsWith('Basic '));
  const sign = route?.headers['mcloud-sign'] ?? '';
  eq('移动: mcloud-sign 三段', sign.split(',').length, 3);

  const create = calls.find(
    (c) => c.url.endsWith('/file/create') && String(c.body).includes('"file"'),
  );
  ok('移动: create 带 SHA-256', String(create?.body).includes(CONTENT_SHA256), CONTENT_SHA256);
  eq('移动: 分片字节数', putBytes.get('yun139'), CONTENT.length);
  ok('移动: complete 已调用', calls.some((c) => c.url.endsWith('/file/complete')));
  eq('移动: R2 临时对象已清理', fakeR2.store.size, 0);
}

// =========================== 通用 ===========================
{
  eq('MD5 计算正确', CONTENT_MD5.length, 32);
  ok('openlist 已移除', !(SUPPORTED_POLICY_TYPES as readonly string[]).includes('openlist'));
  for (const t of [PolicyType.Cloud189, PolicyType.Yun139, PolicyType.WoPan, PolicyType.Aliyundrive, PolicyType.WebDav]) {
    ok(`${t} 在恒中转白名单`, isRelayOnlyPolicyType(t));
  }
  ok('s3 不在恒中转白名单', !isRelayOnlyPolicyType(PolicyType.S3));

  // 路径穿越被过滤（../ 会被丢掉）
  const traversal = new Cloud189Driver(
    policy({
      id: 105,
      type: PolicyType.Cloud189,
      bucket_name: '/root/../etc',
      settings: { c189_cookie: 'a=b' },
    }),
  );
  const rootPath = (traversal as unknown as { rootPath: string }).rootPath;
  eq('路径穿越被过滤', rootPath, '/root/etc');
}

if (failures.length) {
  console.error(`\n✗ ${failures.length} 项失败 / ${passed} 项通过`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ 国内网盘原生驱动冒烟测试全部通过（${passed} 项断言）`);
