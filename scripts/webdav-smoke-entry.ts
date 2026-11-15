/**
 * WebDAV 存储驱动的冒烟测试（无网络）。
 *
 * 用 mock 的全局 fetch 模拟一个 RFC 4918 服务，验证：
 *   - 流式 PUT、MKCOL 逐级建目录与缓存、路径穿越过滤、3xx/409 处理；
 *   - Basic / Bearer 认证、自定义请求头、SSRF 拒绝内网地址；
 *   - PROPFIND 探测与 multistatus XML 解析、HEAD 回退、Range GET；
 *   - DELETE 幂等、list 单层列举、工厂注册与 capabilities。
 *
 * 由 scripts/test-webdav.mjs 用 esbuild 打包后执行（npm run test:webdav）。
 */
import { WebDavDriver, parseMultistatus, probeWebDav } from '../src/storage/webdav';
import {
  SUPPORTED_POLICY_TYPES,
  getStorageDriver,
  isSelectablePolicyType,
  isRelayOnlyPolicyType,
} from '../src/storage/index';
import { PolicyType } from '../src/lib/boolset';
import type { StoragePolicyRow } from '../src/db/types';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  bodyText: string | null;
  bodyIsStream: boolean;
}

const calls: Call[] = [];
const encoder = new TextEncoder();

const DAV_XML =
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<D:multistatus xmlns:D="DAV:" xmlns:lp1="DAV:">\n' +
  '  <D:response><D:href>/dav/cloudreve/2024/</D:href>' +
  '<D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop>' +
  '<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>\n' +
  '  <D:response><D:href>https://dav.example.com/dav/cloudreve/2024/a%20b.txt</D:href>' +
  '<D:propstat><D:prop><lp1:getcontentlength>12</lp1:getcontentlength>' +
  '<lp1:getlastmodified>Wed, 15 Nov 2026 03:00:00 GMT</lp1:getlastmodified>' +
  '<D:resourcetype/></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>' +
  '<D:propstat><D:prop><D:getetag/></D:prop>' +
  '<D:status>HTTP/1.1 404 Not Found</D:status></D:propstat></D:response>\n' +
  '  <D:response><D:href>/dav/cloudreve/2024/no-length.txt</D:href>' +
  '<D:propstat><D:prop><D:getcontentlength>7</D:getcontentlength></D:prop>' +
  '<D:status>HTTP/1.1 404 Not Found</D:status></D:propstat></D:response>\n' +
  '</D:multistatus>';

const DEFAULT_STATUS: Record<string, number> = {
  PROPFIND: 207,
  MKCOL: 201,
  PUT: 201,
  HEAD: 200,
  GET: 206,
  DELETE: 204,
};
/** 每个方法可以临时改状态码，用来模拟 401/404/405/409/500 等分支。 */
const statusOverride: Record<string, number> = {};

globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
  const url = String(input);
  const method = (init.method || 'GET').toUpperCase();
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = String(v);
  const body = init.body as unknown;
  const bodyIsStream =
    !!body && typeof body === 'object' && typeof (body as { getReader?: unknown }).getReader === 'function';
  calls.push({
    url,
    method,
    headers,
    bodyText: typeof body === 'string' ? body : null,
    bodyIsStream,
  });

  const status = statusOverride[method] ?? DEFAULT_STATUS[method] ?? 200;
  const resHeaders = new Headers({ DAV: '1, 2, 3' });
  if (method === 'HEAD') resHeaders.set('content-length', '12');
  if (method === 'GET') {
    resHeaders.set('content-type', 'text/plain');
    resHeaders.set('content-range', 'bytes 0-4/12');
  }
  if (method === 'PROPFIND') resHeaders.set('content-type', 'application/xml; charset=utf-8');

  if (status === 302) {
    resHeaders.set('Location', 'https://dav.example.com/dav/');
    return new Response(null, { status, headers: resHeaders });
  }
  if (method === 'PROPFIND') {
    return new Response(status === 207 ? DAV_XML : '', { status, headers: resHeaders });
  }
  if (method === 'GET' && (status === 206 || status === 200)) {
    return new Response('hello', { status, headers: resHeaders });
  }
  return new Response(null, { status, headers: resHeaders });
}) as typeof fetch;

function makePolicy(patch: Partial<StoragePolicyRow> = {}): StoragePolicyRow {
  return {
    id: 1,
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
    name: 'WebDAV test',
    type: PolicyType.WebDav,
    server: 'https://dav.example.com/dav',
    bucket_name: 'cloudreve',
    is_private: null,
    access_key: 'alice',
    secret_key: 'secret',
    max_size: 95 * 1024 * 1024,
    dir_name_rule: null,
    file_name_rule: null,
    settings: {},
    node_id: null,
    ...patch,
  };
}

function stream(text = 'hello world!'): ReadableStream {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function reset(): void {
  calls.length = 0;
  for (const k of Object.keys(statusOverride)) delete statusOverride[k];
}

function last(method: string): Call | undefined {
  return [...calls].reverse().find((c) => c.method === method);
}

function countMethod(method: string): number {
  return calls.filter((c) => c.method === method).length;
}

let passed = 0;
function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`✗ ${msg}`);
  passed++;
  console.log(`  ✓ ${msg}`);
}

async function main(): Promise<void> {
  console.log('\n── 类型注册 ──');
  assert(SUPPORTED_POLICY_TYPES.includes(PolicyType.WebDav), 'webdav 已加入支持列表');
  assert(isSelectablePolicyType('webdav'), 'webdav 可被创建/绑定');
  assert(
    getStorageDriver({} as never, makePolicy()) instanceof WebDavDriver,
    '工厂把 webdav 路由到 WebDavDriver',
  );
  assert(
    isRelayOnlyPolicyType('webdav') &&
      isRelayOnlyPolicyType('upyun') &&
      isRelayOnlyPolicyType('cloud189') &&
      !isRelayOnlyPolicyType('s3'),
    '恒中转白名单覆盖 webdav / 网盘网桥，且不影响 s3 直传',
  );

  console.log('\n── URL 与认证 ──');
  reset();
  const d = new WebDavDriver(makePolicy({ id: 10 }));
  await d.meta('x.txt');
  assert(
    calls[0]!.url === 'https://dav.example.com/dav/cloudreve/x.txt',
    'server 自动补 https / 尾斜杠，bucket_name 作为子目录',
  );
  assert(
    calls[0]!.headers.authorization === `Basic ${btoa('alice:secret')}`,
    'Basic 认证头正确（UTF-8 → base64）',
  );
  assert(calls[0]!.headers['user-agent'] === 'Cloudreve-Worker-WebDAV/1.0', '默认 UA 已下发');

  reset();
  const bearer = new WebDavDriver(
    makePolicy({ id: 11, settings: { token: 'tok-abc' }, access_key: 'ignored' }),
  );
  await bearer.meta('x.txt');
  assert(calls[0]!.headers.authorization === 'Bearer tok-abc', 'Bearer Token 优先于 Basic');

  reset();
  const custom = new WebDavDriver(
    makePolicy({
      id: 12,
      settings: { dav_headers: { 'X-App-Token': 'abc', 'bad key': 'x', 'User-Agent': 'MyDav/2.0' } },
    }),
  );
  await custom.meta('x.txt');
  assert(calls[0]!.headers['x-app-token'] === 'abc', '自定义请求头生效');
  assert(calls[0]!.headers['user-agent'] === 'MyDav/2.0', '自定义头可覆盖默认 UA');
  assert(!('bad key' in calls[0]!.headers), '非法请求头键名被过滤');

  let ssrfRejected = false;
  try {
    new WebDavDriver(makePolicy({ id: 13, server: 'http://127.0.0.1:5006/' }));
  } catch {
    ssrfRejected = true;
  }
  assert(ssrfRejected, 'SSRF 防护拒绝内网 WebDAV 地址');

  console.log('\n── 连接测试 ──');
  reset();
  const probeOk = await d.probe();
  assert(probeOk.ok && probeOk.status === 207, 'PROPFIND Depth:0 探测成功');
  assert(probeOk.dav === '1, 2, 3', '带回服务端的 DAV 能力头');
  assert(last('PROPFIND')!.headers.depth === '0', '探测使用 Depth: 0');
  assert(
    (last('PROPFIND')!.bodyText ?? '').includes('getcontentlength'),
    'PROPFIND 请求体是标准 propfind XML',
  );

  statusOverride.PROPFIND = 401;
  const p401 = await d.probe();
  assert(!p401.ok && /认证失败/.test(p401.message), '401 翻译成认证失败提示');
  statusOverride.PROPFIND = 404;
  assert(/根路径不存在/.test((await d.probe()).message), '404 翻译成根路径提示');
  statusOverride.PROPFIND = 405;
  assert(/不是 WebDAV 端点/.test((await d.probe()).message), '405 翻译成端点错误提示');
  delete statusOverride.PROPFIND;

  const inline = await probeWebDav({
    server: 'https://dav.example.com/dav/',
    bucket_name: 'cloudreve',
    access_key: 'alice',
    secret_key: 'secret',
  });
  assert(inline.ok, 'probeWebDav 支持未落库的策略配置');
  const bad = await probeWebDav({ server: '' });
  assert(!bad.ok && /配置有误/.test(bad.message), '缺服务地址时返回可操作错误');

  console.log('\n── 上传（流式 PUT + MKCOL） ──');
  reset();
  const up = new WebDavDriver(makePolicy({ id: 20 }));
  const session = {
    id: 's1',
    policy: makePolicy({ id: 20 }),
    uid: 1,
    fileId: 1,
    entityId: 1,
    savePath: '2024/12/a b.txt',
    size: 12,
    chunkSize: 0,
    callbackSecret: 'k',
    expireAt: Date.now() + 60000,
    newFileCreated: true,
    mimeType: 'text/plain',
  };
  const cred = await up.token(session as never, {} as never);
  assert(cred.chunk_size === 0, 'token() 返回单分片全中转');
  await up.writeChunk(session as never, 0, stream(), 12);
  const mkcolCalls = calls.filter((c) => c.method === 'MKCOL');
  assert(mkcolCalls.length === 2, '两级父目录各发一次 MKCOL');
  assert(
    mkcolCalls[0]!.url.endsWith('/dav/cloudreve/2024') &&
      mkcolCalls[1]!.url.endsWith('/dav/cloudreve/2024/12'),
    'MKCOL 按层级顺序创建',
  );
  const put = last('PUT')!;
  assert(put.url.endsWith('/dav/cloudreve/2024/12/a%20b.txt'), '对象键逐段 URL 编码（空格 → %20）');
  assert(put.bodyIsStream, 'PUT 请求体是 ReadableStream（不在 Worker 内存里缓冲整文件）');
  assert(put.headers['content-type'] === 'text/plain', '透传 MIME 类型');
  assert(put.headers.overwrite === 'T', '覆盖上传带 Overwrite: T');
  assert(put.headers.authorization?.startsWith('Basic '), 'PUT 带认证头');

  reset();
  await up.writeChunk(session as never, 0, stream(), 12);
  assert(countMethod('MKCOL') === 0, '目录缓存命中后不再重复 MKCOL');
  assert(countMethod('PUT') === 1, '同目录第二次上传只发一次 PUT');

  reset();
  await up.cancelToken({ ...session, savePath: '2024/12/a b.txt' } as never);
  assert(last('DELETE')!.url.endsWith('/a%20b.txt'), '取消上传会删除占位对象');

  reset();
  await up.put(
    { savePath: '../evil.txt', fileName: 'evil.txt', size: 3, mimeType: '', overwrite: true } as never,
    stream('bad'),
    3,
  );
  assert(!last('PUT')!.url.includes('..'), '对象键里的 .. 被过滤，无法越出挂载根目录');

  reset();
  statusOverride.HEAD = 200;
  let existed = false;
  try {
    await up.put(
      { savePath: 'exists.txt', fileName: 'exists.txt', size: 3, mimeType: '', overwrite: false } as never,
      stream('bad'),
      3,
    );
  } catch (e) {
    existed = /Object existed/.test((e as Error).message);
  }
  assert(existed && countMethod('PUT') === 0, 'overwrite=false 且对象已存在时拒绝写入');
  delete statusOverride.HEAD;

  reset();
  statusOverride.PUT = 302;
  let redirectError = '';
  try {
    const d2 = new WebDavDriver(makePolicy({ id: 21 }));
    await d2.put(
      { savePath: 'r.txt', fileName: 'r', size: 1, mimeType: '', overwrite: true } as never,
      stream('x'),
      1,
    );
  } catch (e) {
    redirectError = (e as Error).message;
  }
  assert(/redirected/.test(redirectError) && /trailing slash/.test(redirectError), 'PUT 遇 3xx 给出填最终地址的提示');
  delete statusOverride.PUT;

  reset();
  statusOverride.PUT = 409;
  let conflictError = '';
  try {
    await up.put(
      { savePath: '2024/12/c.txt', fileName: 'c', size: 1, mimeType: '', overwrite: true } as never,
      stream('x'),
      1,
    );
  } catch (e) {
    conflictError = (e as Error).message;
  }
  assert(/parent directory/.test(conflictError), 'PUT 409 提示父目录可能被删');
  delete statusOverride.PUT;
  reset();
  await up.put(
    { savePath: '2024/12/c.txt', fileName: 'c', size: 1, mimeType: '', overwrite: true } as never,
    stream('x'),
    1,
  );
  assert(countMethod('MKCOL') > 0, '409 后目录缓存被清空，下次上传重新建目录');

  console.log('\n── 元信息 / 下载 / 删除 ──');
  reset();
  const m = await up.meta('a.txt');
  assert(m?.size === 12, 'HEAD 返回 content-length');
  assert(last('HEAD')!.url.endsWith('/cloudreve/a.txt'), 'HEAD 指向对象 URL');

  reset();
  statusOverride.HEAD = 405;
  const m2 = await up.meta('a.txt');
  assert(m2?.size === 12, 'HEAD 不被支持时回退 PROPFIND Depth:0');
  assert(last('PROPFIND')!.headers.depth === '0', '回退用 Depth: 0');
  delete statusOverride.HEAD;

  reset();
  const got = await up.get('a.txt', 'bytes=0-4');
  assert(!!got && got.size === 12, 'GET 从 Content-Range 还原总大小');
  assert(got!.contentRange === 'bytes 0-4/12', 'Content-Range 原样透传');
  assert(last('GET')!.headers.range === 'bytes=0-4', 'Range 头透传给 WebDAV 服务');
  assert((await new Response(got!.body).text()) === 'hello', '下载流可读取');

  reset();
  statusOverride.GET = 404;
  assert((await up.get('missing.txt')) === null, '404 返回 null');
  delete statusOverride.GET;
  statusOverride.GET = 416;
  assert((await up.get('a.txt', 'bytes=999-')) === null, '416 返回 null');
  delete statusOverride.GET;

  reset();
  const delFailed = await up.delete(['a.txt', 'b.txt']);
  assert(delFailed.length === 0 && countMethod('DELETE') === 2, 'DELETE 每个对象各一次');
  statusOverride.DELETE = 404;
  assert((await up.delete(['gone.txt'])).length === 0, 'DELETE 404 视为幂等成功');
  statusOverride.DELETE = 500;
  assert((await up.delete(['bad.txt'])).length === 1, 'DELETE 500 记录失败键');
  delete statusOverride.DELETE;

  console.log('\n── PROPFIND 列举与 XML 解析 ──');
  const entries = parseMultistatus(DAV_XML);
  assert(entries.length === 2, '解析出 2 个有效 response（全 404 propstat 的被跳过）');
  const file = entries.find((e) => e.href.includes('a%20b') || e.href.includes('a b'));
  assert(file?.size === 12, '命名空间前缀 lp1: 的 getcontentlength 能解析');
  assert(!!file?.lastModified && !Number.isNaN(file.lastModified.getTime()), 'getlastmodified 解析成 Date');
  const dir = entries.find((e) => e.href.endsWith('/2024/'));
  assert(dir?.isCollection === true, '<collection/> 识别为目录');

  reset();
  const listed = await up.list('2024/');
  assert(last('PROPFIND')!.headers.depth === '1', '列举使用 Depth: 1');
  const listedFile = listed.keys.find((k) => k.key === '2024/a b.txt');
  assert(!!listedFile, 'href（绝对 URL + %20 编码）换算成相对对象键');
  assert(listedFile?.size === 12 && listed.continuation === null, '单层列举无分页令牌');
  assert(!listed.keys.some((k) => k.key.endsWith('/')), '目录条目不进入文件列表');

  console.log('\n── capabilities ──');
  const caps = up.capabilities();
  assert(caps.proxyRequired === true && caps.maxSourceExpire === 0, '下载强制走 Worker 代理（不暴露凭据）');
  assert((await up.thumb('a.jpg', '100')) === null, '不支持缩略图');
  let sourceRejected = false;
  try {
    await up.source('a.txt', {} as never);
  } catch {
    sourceRejected = true;
  }
  assert(sourceRejected, 'source() 拒绝生成裸直链');
  await up.setCors!();
  assert(true, 'setCors() 空实现不抛错');

  console.log(`\n✅ WebDAV 驱动冒烟测试全部通过（${passed} 项断言，共记录 ${calls.length} 次出站调用）\n`);
}

main().catch((e) => {
  console.error(`\n❌ ${(e as Error).message}`);
  process.exit(1);
});
