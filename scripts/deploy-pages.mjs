#!/usr/bin/env node
/**
 * 可选：把官方前端单独部署到 Cloudflare Pages，并生成「纯 API Worker」配置。
 *
 * 上游工程默认把前端作为 Workers Static Assets 随 Worker 一起发（最省事）。
 * 如果确实想让 Workers 和 Pages 各承担一半，用本脚本：
 *
 *   1. 确保 frontend/ 里有官方前端构建产物（缺了自动拉）。
 *   2. wrangler pages deploy frontend/ → 得到 Pages 站点。
 *   3. 生成 wrangler.pages-split.toml：从 wrangler.toml 复制全部绑定，
 *      但删掉 [assets] 段 —— 没有 ASSETS 绑定时，Worker 的
 *      serveFrontend() 才会把非 /api 请求原样反代到 FRONTEND_URL。
 *
 * 之后把 FRONTEND_URL 配成 Pages 地址，再用 split 配置重新部署 Worker。
 * 浏览器仍然只访问 Worker 域名（反代发生在服务端），所以同源、Cookie、
 * CORS 都不需要额外处理。
 *
 * 用法：
 *   node scripts/deploy-pages.mjs
 *   PAGES_PROJECT=my-cloudreve node scripts/deploy-pages.mjs
 *   PAGES_URL=https://xxx.pages.dev node scripts/deploy-pages.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FRONTEND_DIR = path.join(ROOT, 'frontend');
const TOML_PATH = path.join(ROOT, 'wrangler.toml');
const SPLIT_TOML_PATH = path.join(ROOT, 'wrangler.pages-split.toml');
const WRANGLER = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const PAGES_PROJECT = process.env.PAGES_PROJECT || 'cloudreve-frontend';
const PAGES_URL = (process.env.PAGES_URL || '').replace(/\/+$/, '');

function run(cmd, args, label) {
  console.log(`  $ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', shell: false });
  const all = `${r.stdout || ''}${r.stderr || ''}`;
  if (all.trim()) console.log(all.trim().split('\n').slice(-12).map((l) => `    ${l}`).join('\n'));
  if (r.status !== 0) {
    console.error(`\n✘ ${label} 失败（exit ${r.status ?? 1}）`);
    process.exit(r.status ?? 1);
  }
  return all;
}

if (!existsSync(WRANGLER)) {
  console.error('✘ 找不到本地 wrangler，请先 npm install');
  process.exit(1);
}

// ---------------------------------------------------------------------------
console.log('▶ 1/3 检查官方前端构建产物…');
if (!existsSync(path.join(FRONTEND_DIR, 'index.html'))) {
  console.log('  frontend/index.html 不存在，调用 fetch-frontend.mjs（首次可能要几分钟）…');
  run(process.execPath, [path.join(ROOT, 'scripts', 'fetch-frontend.mjs')], '拉取前端');
}
if (!existsSync(path.join(FRONTEND_DIR, 'index.html'))) {
  console.error('✘ 前端产物仍不存在，中止。');
  process.exit(1);
}
console.log('  ✓ frontend/index.html 就绪');

// ---------------------------------------------------------------------------
console.log(`▶ 2/3 部署前端到 Cloudflare Pages（项目：${PAGES_PROJECT}）…`);
const deployOut = run(
  process.execPath,
  [WRANGLER, 'pages', 'deploy', 'frontend', '--project-name', PAGES_PROJECT, '--branch', 'main'],
  'Pages 部署',
);

const guessedUrl =
  PAGES_URL ||
  deployOut.match(/https:\/\/[a-z0-9-]+\.pages\.dev/i)?.[0] ||
  `https://${PAGES_PROJECT}.pages.dev`;

// ---------------------------------------------------------------------------
console.log('▶ 3/3 生成纯 API Worker 配置…');
const toml = readFileSync(TOML_PATH, 'utf8');
if (toml.includes('REPLACE_WITH_YOUR_KV')) {
  console.warn('  ⚠ wrangler.toml 里的 KV ID 还是占位符 —— 请先跑一次 npm run deploy，');
  console.warn('    让 deploy.mjs 创建 KV / R2 并回填真实 ID，否则 split 配置无法部署。');
}

/** 按 TOML 的 section 边界，删掉整个 [assets] 段（含 run_worker_first 等键）。 */
function stripAssetsSection(text) {
  const out = [];
  let skipping = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\[assets\]\s*$/.test(line)) {
      skipping = true;
      continue;
    }
    // 遇到下一个 section header（[xxx] 或 [[xxx]]）就停止跳过
    if (skipping && /^\[{1,2}[^\]]+\]/.test(line)) skipping = false;
    if (!skipping) out.push(line);
  }
  return out.join('\n');
}

const header = [
  '# 由 scripts/deploy-pages.mjs 自动生成，请勿手改。',
  '# 与 wrangler.toml 相同，但去掉 [assets]：Worker 只跑 API，',
  '# 非 /api 请求通过 FRONTEND_URL 反代到 Cloudflare Pages 上的官方前端。',
  '# 部署：node node_modules/wrangler/bin/wrangler.js deploy --config wrangler.pages-split.toml',
  '',
].join('\n');

let split = stripAssetsSection(toml);
if (PAGES_URL) {
  split += `\n[vars]\nFRONTEND_URL = "${PAGES_URL}"\n`;
}
writeFileSync(SPLIT_TOML_PATH, `${header}${split}\n`, 'utf8');
console.log(`  ✓ 已写入 ${path.relative(ROOT, SPLIT_TOML_PATH)}`);

console.log('\n────────────────────────────────────────────────────────────');
console.log('最后一步：用 split 配置重新部署 Worker，并把 FRONTEND_URL 传进去：');
console.log(
  `\n  node node_modules/wrangler/bin/wrangler.js deploy --config wrangler.pages-split.toml --var FRONTEND_URL:${guessedUrl}`,
);
console.log('\n也可以在面板「设置 → 变量和机密」里加 FRONTEND_URL（不是 Secret，普通变量即可），');
console.log('然后直接 deploy --config wrangler.pages-split.toml。');
console.log('\n浏览器仍然访问 Worker 域名；Pages 只是静态资源源，反代在服务端完成，');
console.log('因此同源、Cookie、CORS 都不用额外处理。');
console.log('别忘了 SITE_URL 设成 Worker 的对外地址，否则分享短链会拼错。');
console.log('────────────────────────────────────────────────────────────\n');
