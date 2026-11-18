/**
 * yun139 上传路径专项测试运行器（Node 端，mock 全部外部请求）。
 * 用法：node scripts/test-yun139-upload.mjs
 */
import { build } from 'esbuild';
import { rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const out = path.resolve('scripts/.yun139-upload-test.mjs');

await build({
  entryPoints: ['scripts/yun139-upload-entry.ts'],
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
