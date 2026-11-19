/**
 * EdgeOne Pages（Makers）构建脚本。
 *
 * 产物两块：
 *   1. `dist/` —— 前端静态托管目录（edgeone.json 的 outputDirectory），
 *      fetch-frontend 拉取/构建的前端产物原样拷入。
 *   2. `cloud-functions/[[default]].js` —— catch-all Node 云函数，处理
 *      全部后端路径（/api/*、/dav、/s/:id 分享页、/f/:id 直链、manifest）。
 *
 * ⚠️ 函数内要做 SPA 壳兜底（api/makers.ts 的 isHtmlNav 分支）：前端路由
 *   （/home 等）在静态层不存在，会落到 catch-all 函数，没有壳兜底就是
 *   404 JSON，前端路由全打不开。缺失的 /assets/*.js 则必须 404 —— 回壳
 *   会造成「HTML 当 JS」的白屏（CF 的 not_found_handling 踩过同样的坑）。
 *
 * 其他平台行为：
 *   - `cloudflare:sockets` 被 alias 到 src/edgeone/socket-shim.ts
 *     （node:net 实现），CF 的 wrangler 构建不受影响；
 *   - 每小时 cron 由 edgeone.json 的 schedules 触发
 *     POST /api/v4/site/cron/tick（端点自带 10 分钟节流）；
 *   - 国际站（pages.edgeone.ai）与中国站（edgeone.cloud.tencent.com）的
 *     edgeone.json 完全通用，两个控制台各建一个项目绑同一仓库即可。
 */
import esbuild from 'esbuild';
import { cpSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 文本输入换行归一：--check 逐字节比对产物。Windows 本地 core.autocrlf=true
// 会把源码 checkout 成 CRLF，而 Linux CI 是 LF —— .sql/.html 以 text loader
// 内嵌成字符串后，CRLF 会变成产物里的 `\r` 转义，两边产物永远不等。
// 统一在读取时归一为 LF，保证 Windows 本地与 CI 打出的包字节恒等。
const normalizeEolPlugin = {
  name: 'normalize-eol',
  setup(build) {
    build.onLoad({ filter: /\.(sql|html)$/ }, async (args) => {
      const { promises: fsp } = await import('node:fs');
      const text = await fsp.readFile(args.path, 'utf8');
      return { contents: text.replace(/\r\n?/g, '\n'), loader: 'text' };
    });
  },
};

// ---- 1. 前端产物 ------------------------------------------------------------
// 复用 CF 部署同款的 fetch-frontend.mjs：优先下载 Release 预构建包，
// 失败回落源码构建。产物目录 frontend/ 与 wrangler [assets] 共用一份。
console.log('▶ [1/3] 准备前端产物（frontend/）…');
{
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'fetch-frontend.mjs')], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    console.error('✘ 前端产物准备失败');
    process.exit(r.status ?? 1);
  }
}

// ---- 2. dist/（outputDirectory）--------------------------------------------
console.log('▶ [2/3] 组装 dist/（outputDirectory）…');
{
  const src = path.join(ROOT, 'frontend');
  const out = path.join(ROOT, 'dist');
  if (!existsSync(path.join(src, 'index.html'))) {
    console.error(`✘ ${src}/index.html 不存在，前端产物不完整`);
    process.exit(1);
  }
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(src, out, { recursive: true });
  console.log(`  已拷贝 ${src} → ${out}`);
}

// ---- 3. Node 云函数（catch-all bundle）--------------------------------------
// ⚠️ 产物必须提交进仓库：EdgeOne 的函数路由在构建前从仓库读取，构建期
// 新建的 cloud-functions/ 不一定被注册（本项目实测：函数没入库时 /api/*
// 全被 SPA fallback 回成 index.html，前端报 themes undefined）。
// `--check` 模式供 CI 用：重新打包后与已提交产物逐字节比对，防止改了
// src/ 忘了重新生成产物。
const CHECK = process.argv.includes('--check');
const ARTIFACT = path.join(ROOT, 'cloud-functions', '[[default]].js');
const OUTFILE = CHECK
  ? path.join(ROOT, 'node_modules', '.cache', 'edgeone-artifact-check.mjs')
  : ARTIFACT;

console.log(CHECK ? '▶ [3/3] 校验云函数产物是否最新…' : '▶ [3/3] 打包 Node 云函数…');
console.log(`  [diag] esbuild ${esbuild.version}`);

// 依赖漂移自检：bundle 把 node_modules 里的依赖代码一起打包，所以
// node_modules 与 package-lock.json 只要有一个包版本不同（npm install 会
// 顺手升级，npm ci 不会），产物就会整段位移，--check 报出的差异位置与真正
// 改动毫无关系。这里先把漂移指出来，省得又去怀疑 esbuild/换行/路径。
{
  const { readFileSync, existsSync: exists } = await import('node:fs');
  const lockPath = path.join(ROOT, 'package-lock.json');
  if (exists(lockPath)) {
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    const drift = [];
    for (const [key, meta] of Object.entries(lock.packages || {})) {
      const m = /^node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(key);
      if (!m || !meta.version) continue;
      const pj = path.join(ROOT, key, 'package.json');
      if (!exists(pj)) continue;
      const installed = JSON.parse(readFileSync(pj, 'utf8')).version;
      if (installed !== meta.version) drift.push(`${m[1]} ${installed} ≠ lock ${meta.version}`);
    }
    if (drift.length) {
      console.log(`  [warn] node_modules 与 lockfile 不一致（${drift.length} 个包）：`);
      for (const d of drift.slice(0, 5)) console.log(`         ${d}`);
      console.log('         产物必然与 CI 对不上，先跑 npm ci');
    }
  }
}

if (CHECK) mkdirSync(path.dirname(OUTFILE), { recursive: true });

// 未提交改动提示：--check 比的是「已提交产物 vs 当前工作区源码」。本地常驻
// 的 PGlite 补丁（src/db/repo.ts、src/db/audit.ts 等）本来就不入库，会让这个
// 比对必然失败，且差异位置与真实改动无关。先说清楚，别白追一轮。
if (CHECK) {
  try {
    const { execFileSync } = await import('node:child_process');
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
    if (dirty) {
      const files = dirty.split('\n').map((l) => l.slice(2).trim());
      console.log(`  [warn] 工作区有 ${files.length} 个未提交改动：${files.slice(0, 4).join(', ')}${files.length > 4 ? ' …' : ''}`);
      console.log('         本地补丁/未提交改动会被打进产物，与已提交版本必然不一致');
      console.log('         要重建可信产物：git stash → 构建 → git stash pop');
    }
  } catch {
    /* 非 git 环境忽略 */
  }
}
await esbuild.build({
  entryPoints: [path.join(ROOT, 'api', 'makers.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  // 注意：不用 minify: true。--check 是逐字节比对，而产物是「源码 + 依赖
  // 代码」的拼接，字节位置对输入极其敏感：依赖版本漂移或标识符混淆的命名
  // 重排，都会让整包偏移上千字节，报出的差异位置离真正改动十万八千里。
  // 空白/语法压缩是确定性的，标识符保留原名，体积大一些，但 diff 可读、
  // 排查成本低得多。
  minifyWhitespace: true,
  minifySyntax: true,
  outfile: OUTFILE,
  // SPA 壳内联：dist/index.html 以文本形式打进 bundle（构建顺序保证
  // 这一步跑在「组装 dist/」之后）。
  loader: { '.html': 'text', '.sql': 'text' },
  // cloudflare:sockets 换成 node:net shim（src/edgeone/socket-shim.ts）；
  // CF 的 wrangler 构建走平台原生实现，不受本 alias 影响。
  alias: {
    'cloudflare:sockets': path.join(ROOT, 'src', 'edgeone', 'socket-shim.ts'),
  },
  plugins: [normalizeEolPlugin],
  logLevel: 'silent',
});

// 换行归一：--check 是逐字节比对。Windows 上 core.autocrlf=true 会把源码
// checkout 成 CRLF，esbuild 会把这些 \r 原样带进内联文本与模板字符串，
// 导致 Windows 本地产物与 Linux CI 产物字节不同、比对永远失败。
// 统一归一成 LF 后，两边产物一致（JS 对换行不敏感，运行时无影响）。
{
  const { readFileSync, writeFileSync } = await import('node:fs');
  const buf = readFileSync(OUTFILE, 'utf8');
  if (buf.includes('\r')) writeFileSync(OUTFILE, buf.replace(/\r\n?/g, '\n'), 'utf8');
}

if (CHECK) {
  const { readFileSync, writeFileSync, rmSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const expected = readFileSync(OUTFILE);
  // 诊断：不一致时保留 CI 侧重算的 bundle 并打印两侧哈希/长度，供本地
  // 逐字节 diff（配合 ci.yml 的 upload-artifact 步骤取回文件）。
  const dump = path.join(ROOT, 'node_modules', '.cache', 'edgeone-artifact-mismatch.js');
  rmSync(dump, { force: true });
  writeFileSync(dump, expected);
  console.log(
    `  [diag] rebuilt: sha256=${createHash('sha256').update(expected).digest('hex')} size=${expected.length}`,
  );
  rmSync(OUTFILE, { force: true });
  if (!existsSync(ARTIFACT)) {
    console.error('✘ cloud-functions/[[default]].js 未提交');
    process.exit(1);
  }
  const actual = readFileSync(ARTIFACT);
  console.log(
    `  [diag] committed: sha256=${createHash('sha256').update(actual).digest('hex')} size=${actual.length}`,
  );
  if (!expected.equals(actual)) {
    // 找出首个差异字节，帮助快速定位差异来源（换行？资源名？代码段？）
    let diffAt = -1;
    const n = Math.min(expected.length, actual.length);
    for (let i = 0; i < n; i++) {
      if (expected[i] !== actual[i]) { diffAt = i; break; }
    }
    console.log(
      `  [diag] first-diff byte: ${diffAt}` +
        (diffAt >= 0
          ? ` | rebuilt: ${expected.slice(diffAt, diffAt + 80).toString('utf8').replace(/\n/g, '\\n')}`
          : '') +
        (diffAt >= 0
          ? ` | committed: ${actual.slice(diffAt, diffAt + 80).toString('utf8').replace(/\n/g, '\\n')}`
          : ''),
    );
    console.error(
      '✘ 云函数产物已过期：改了 api/ 或 src/ 之后要跑\n' +
        '    node scripts/build-edgeone.mjs\n' +
        '  并把 cloud-functions/[[default]].js 一起提交。',
    );
    process.exit(1);
  }
  console.log('  ✓ 云函数产物与源码一致');
} else {
  console.log('  ✓ cloud-functions/[[default]].js');
}

console.log('✔ EdgeOne 构建完成');
