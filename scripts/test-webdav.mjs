/**
 * 用 esbuild 把 webdav-smoke-entry.ts 打包成可在 Node 直接执行的 ESM，
 * 然后运行它。测试内部会 mock 掉全局 fetch，不需要真实 WebDAV 服务。
 *
 * 用法：npm run test:webdav
 */
import { build } from 'esbuild';
import { rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const out = path.resolve('scripts/.webdav-smoke.mjs');

await build({
  entryPoints: ['scripts/webdav-smoke-entry.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: out,
  logLevel: 'warning',
});

try {
  await import(pathToFileURL(out).href);
} finally {
  rmSync(out, { force: true });
}
