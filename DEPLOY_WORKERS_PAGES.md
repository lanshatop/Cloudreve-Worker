# 部署到 Cloudflare Workers / Pages（中文速查）

本目录是 [LegspCpd/Cloudreve-Worker](https://github.com/LegspCpd/Cloudreve-Worker) 的本地副本，
**Cloudreve v4.19.1 的 TypeScript 重写版**，不是原 Go 项目的移植。原 v3.8.3 仓库保留在
`E:\AI\projects\cloudreve-sdyto`，两者互不影响。

> **数据不兼容**：v3 的用户、文件、存储策略、数据库结构都不能平滑迁移到 v4。
> 这是「换一个能跑在边缘的实现」，不是「升级」。要保住 v3 数据，请改走容器或反代方案。

---

## 一、先准备三样东西

| 项目 | 说明 |
|---|---|
| Cloudflare 账号 | 免费档够用；R2 开通需完成结算流程绑卡（有免费额度）。**配额明细见第十节** |
| PostgreSQL 连接串 | 推荐 [Neon](https://neon.tech) 免费档，复制 `postgresql://...` 连接串。也支持 Supabase（Transaction pooler 6543）、CockroachDB、Railway、自建 PG。**不支持 MySQL / SQLite / MongoDB** |
| Node.js ≥ 20 | 本机已验证 Node 22.22.2 / npm 10.9.7 |

本项目唯一必填的环境变量就是 `DATABASE_URL`。建表在首次打开站点时自动执行，不用跑迁移命令。

---

## 二、模式 A：单 Worker（推荐，最稳）

前端作为 **Workers Static Assets** 随 Worker 一起发布。Cloudflare 现在官方建议把 Pages 项目
迁到 Workers Static Assets（[迁移说明](https://developers.cloudflare.com/workers/static-assets/migrate-from-pages)），
所以「前端静态托管」这件事本身已经由 Worker 承担，不需要再开一个 Pages 项目。

### 方式 1：Fork + Workers Builds（推荐，本机零配置）

1. Fork `LegspCpd/Cloudreve-Worker`，以后在 fork 页面点 **Sync fork** 就能拿到上游更新。
2. Cloudflare → Workers & Pages → Create → 连接你 fork 的仓库，只填两格：

   | 框 | 命令 |
   |---|---|
   | 构建命令 | `npm install` |
   | 部署命令 | `npm run deploy` |

   输出目录留空。
3. 项目设置 → 环境变量加 `DATABASE_URL`，保存后重新部署。

> ⚠️ **构建命令别填 `npm run build`** —— 那是 CI 的 dry-run 检查，放构建阶段会重复拉前端，
> 构建时间从一两分钟涨到八九分钟。

`npm run deploy` 会自动创建 KV namespace 和 R2 bucket、把真实 ID 回填 `wrangler.toml`、
把 `DATABASE_URL` 写成 Secret，然后发布。

### 方式 2：本机命令行

```bash
cd E:\AI\projects\cloudreve-worker
npm install
cp .dev.vars.example .dev.vars      # 填 DATABASE_URL
npx wrangler login
npm run deploy
```

Windows 本机跑 `deploy.mjs` 时它走 `npx.cmd` 分支，若报找不到 `pages` 之类命令，
改用 Workers Builds（Linux CI）最省事，或手工执行
`node node_modules/wrangler/bin/wrangler.js deploy`。

---

## 三、模式 B：Workers 跑 API + Pages 托管前端（真的用上两个产品）

本工程内置 `FRONTEND_URL` 反代能力：Worker 把非 `/api` 请求原样反代到 Pages 上的官方前端。
我加了一个脚本把这条路径自动化：

```bash
npm install
npm run deploy          # 第 1 步：创建 KV/R2 并回填真实 ID，同时部署完整 Worker
npm run deploy:pages    # 第 2 步：部署前端到 Pages + 生成 wrangler.pages-split.toml
```

`deploy:pages` 做三件事：确保 `frontend/` 有产物（缺了自动拉，首次可能要几分钟）、
`wrangler pages deploy frontend/`、从 `wrangler.toml` 复制配置但**删掉 `[assets]` 段**
（没有 ASSETS 绑定时，`serveFrontend()` 才会走 `FRONTEND_URL` 反代）。

然后按脚本输出的提示执行（把 URL 换成你的 Pages 地址）：

```bash
node node_modules/wrangler/bin/wrangler.js deploy \
  --config wrangler.pages-split.toml \
  --var FRONTEND_URL:https://cloudreve-frontend.pages.dev
```

可选环境变量：`PAGES_PROJECT`（Pages 项目名，默认 `cloudreve-frontend`）、
`PAGES_URL`（写死 Pages 地址，会自动写进 split 配置的 `[vars]`）。

**注意语义**：浏览器访问的仍然是 **Worker 域名**，Pages 只是静态资源源，反代发生在服务端。
所以同源、Cookie、CORS 都不用额外配置。反过来（用户直接访问 Pages 域名、由 Pages Functions
转发 `/api` 到 Worker）会引入跨域和 Cookie 问题，不建议。

---

## 四、部署后必做（漏了一定用不了）

1. **`SITE_URL`**：设成站点对外地址（模式 B 填 Worker 地址，不是 Pages 地址）。
   不设的话分享短链和下载直链会拼错。
2. **注册第一个账号** → 自动成为管理员。找回管理员权限可配 `ADMIN_EMAIL` + `ADMIN_PASSWORD`
   （两个都要，建议存 Secret，用完删掉）。
3. **添加存储策略**：管理后台 → 存储策略 → 添加。默认没有任何存储后端，不配传不了文件。
   用 R2 时类型选 **`s3`**，Endpoint 填 `https://<accountid>.r2.cloudflarestorage.com`，
   区域 `auto`，再填 AK/SK。
4. **把策略绑给用户组**：用户组 → 编辑 → 绑定策略。没绑会报 `No policy selected`。
5. 邮件 SMTP、WebDAV 账号、OIDC、用户组权限等都在管理后台配，不在环境变量里。

---

## 五、环境变量速查

| 变量 | 必填 | 说明 |
|---|---|---|
| `DATABASE_URL` | 是 | 主库 PG 连接串，唯一可写 |
| `SITE_URL` | 建议 | 对外地址，拼分享短链 / 直链 |
| `FRONTEND_URL` | 模式 B | Pages 前端地址，配了反代优先于内置静态资源 |
| `DB_PROVIDER` | 否 | `neon` / `postgres`；留空按连接串域名自动判断 |
| `JWT_SECRET` | 否 | 不设自动生成入库 |
| `CORS_ALLOW_ORIGINS` | 否 | 前后端同源不用配 |
| `R2_PUBLIC_BASE` | 否 | R2 公共域名，配了直链不带签名 |
| `KV_COUNT` | 否 | 1–5，默认 1 |

> `KV_COUNT` 有个坑：**不能填在「设置 → 变量和机密」**，那是运行时变量，构建期读不到，
> 会静默回落成 1。要配请放 Workers Builds 的环境变量，或改仓库根目录的 `KV_COUNT` 文件。
> 当前仓库里这个文件写的是 **5**，`wrangler.toml` 也已装配好 5 个角色 KV + 1 个兜底 KV，
> 即部署时会创建 **6 个 namespace**。个人站点嫌多的话，把 `KV_COUNT` 改成 `1` 再部署即可。

非 Neon 的 Postgres 建议在 Cloudflare 建 Hyperdrive 绑定，改善冷启动；不配也能跑。

---

## 六、本副本相对上游的改动

均为新增/健壮性改动，不动既有业务逻辑（以后在 fork 页面 Sync fork 时留意合并）：

| 文件 | 改动 |
|---|---|
| `DEPLOY_WORKERS_PAGES.md` | 新增：本文档 |
| `scripts/deploy-pages.mjs` | 新增：Pages 部署 + 生成纯 API Worker 配置 |
| `scripts/local-db.mjs` | 新增：本地预览用的 PGlite 数据库服务；自举前预置 `register_enabled=1` |
| `wrangler.local.toml` / `.dev.vars` | 新增：本地预览配置（KV 假 ID、本地连接串），均被 gitignore 排除 |
| `package.json` | 新增 `deploy:pages` / `dev:db` / `dev:local` / `test:netdisk` / `test:webdav`，新增依赖 `crypto-js` 与 dev 依赖 `@electric-sql/pglite-socket` / `esbuild` |
| `.gitignore` | 新增忽略 `.local-db/` |
| `scripts/fetch-frontend.mjs` | `cleanup()` 加 try/catch：删除临时目录失败不再中断构建 |
| **国内网盘原生驱动（见第十一节）** | |
| `src/storage/netdisk/common.ts` | 新增：路径换算、流式分片读取、增量 MD5/SHA-256、AES-ECB/CBC、HMAC-SHA1、BigInt RSA、Cookie 罐 |
| `src/storage/netdisk/cloud189.ts` | 新增：天翼云盘驱动（Cookie/账号登录、上传签名、10 MB 分片、批删、列举） |
| `src/storage/netdisk/yun139.ts` | 新增：移动云盘驱动（路由 host、`mcloud-sign`、R2 暂存算 SHA-256、分片直传） |
| `src/storage/netdisk/wopan.ts` | 新增：联通云盘驱动（dispatcher 信封、AES-CBC 参数、`upload2C` 分片、token 自动续期） |
| `src/storage/netdisk/aliyundrive.ts` | 新增：阿里云盘驱动（开放平台 OAuth2、`openFile/*`、预签名分片） |
| `src/storage/netdisk/index.ts` | 新增：类型→驱动工厂、预设元数据、缓存失效、连接探测 |
| `src/lib/boolset.ts` | 新增 4 个策略类型：`cloud189` / `yun139` / `wopan` / `aliyundrive`（`openlist` 已移除） |
| `src/storage/index.ts` | 注册 4 个类型到工厂与 `SUPPORTED_POLICY_TYPES`；`RELAY_ONLY_POLICY_TYPES` 覆盖四家 |
| `src/routes/admin.ts` | `KNOWN_POLICY_TYPES` 从 `SUPPORTED_POLICY_TYPES` 派生；新建策略时先做只读连通性探测（登录 + 读根目录），失败不落库；改策略清 isolate 缓存 |
| `src/db/types.ts` | `PolicySetting` 增加 `c189_*` / `y139_*` / `wp_*` / `ali_*` 凭据字段与 `netdisk_skip_probe` |
| `frontend-patches/src/api/explorer.ts`、`dashboard.ts` | 前端 `PolicyType` 枚举与 `PolicySetting` 同步扩展 |
| `frontend-patches/src/component/Admin/StoragePolicy/StoragePolicySetting.tsx` | 4 张策略卡片，按类型挂到各自的凭据向导 |
| `frontend-patches/src/component/Admin/StoragePolicy/Wizards/Netdisk/NetdiskWizard.tsx` | 重写：四家各自的凭据表单 + 抓取指引 + 根路径/上限/跳过探测 |
| `scripts/netdisk-smoke-entry.ts`、`test-netdisk.mjs` | 重写：四家原生驱动的无网络冒烟测试（mock fetch + mock R2） |
| **WebDAV 原生存储（见第十二节）** | |
| `src/storage/webdav.ts` | 新增：RFC 4918 原生客户端驱动（流式 PUT / MKCOL / PROPFIND / GET / HEAD / DELETE + 连接探测） |
| `src/lib/boolset.ts`、`src/storage/index.ts` | 新增策略类型 `webdav` 并注册到工厂与 `SUPPORTED_POLICY_TYPES` |
| `src/db/types.ts`、`frontend-patches/src/api/dashboard.ts` | `PolicySetting` 增加 `dav_headers` / `dav_skip_probe` |
| `src/routes/admin.ts` | 新建 webdav 策略前做只读 `PROPFIND` 连通性测试，失败不落库 |
| `src/services/fs.ts`、`src/services/upload.ts` | 把散落三处的「恒中转类型」判定抽成 `isRelayOnlyPolicyType()`，覆盖 WebDAV 与四家网盘驱动。**顺带修了一个隐藏 bug**：这类策略原先 `relay` 为 false，前端上传器会按 S3 直传去读 `upload_urls[0]` 直接崩，且客户端加密会把明文当密文解 |
| 前端补丁 `explorer.ts` / `StoragePolicySetting.tsx` | 增加 `webdav` 枚举与策略卡片 |
| `frontend-patches/src/component/Admin/StoragePolicy/Wizards/WebDav/WebDavWizard.tsx` | 新增：服务预设 / 地址 / 挂载子目录 / Basic 或 Bearer / 自定义头 / 单文件上限向导 |
| `scripts/webdav-smoke-entry.ts`、`test-webdav.mjs` | 新增：无网络依赖的 WebDAV 冒烟测试（`npm run test:webdav`） |

最后一处的原因：本机环境对「批量删除」有保护，`cleanup()` 抛错会让脚本在
`patchIndexHtml()` / `writeHeaders()` **之前**退出，产物里会残留 `{siteName}` 这类占位符、
且缺 `_headers`。改成非致命后，构建失败也不会再产出残缺前端。Linux CI 上不会触发，
但改了只有好处。

---

## 七、本地验证情况

| 检查 | 结果 |
|---|---|
| `npm install` | 成功，57 个包（Node 22.22.2 / npm 10.9.7） |
| `npm run typecheck` | 通过（exit 0） |
| `wrangler --version` | 4.135.0；`pages deploy`、`--config`、`--var` 均可用 |
| `node scripts/fetch-frontend.mjs` | **成功**，`frontend/` 45 MB、474 个 assets，`index.html` 占位符已补全、`_headers` 已生成 |
| `deploy-pages.mjs` 语法与配置生成 | 通过（assets 段被剔除，triggers / 6 个 KV 绑定 / R2 保留） |
| `npm run test:netdisk` | **通过，44 项断言**：四家驱动的请求形态（189 签名头与分片 PUT、联通 dispatcher 信封与 `upload2C` 表单、阿里 OAuth 与 `part_info_list`、139 路由与 SHA-256）、R2 临时对象清理、路径穿越、恒中转白名单 |
| `npm run test:webdav` | **通过，62 项断言**：流式 PUT、逐级 MKCOL 与缓存、3xx/409 分支、Basic/Bearer/自定义头、SSRF、PROPFIND 探测与 XML 解析、Range GET、DELETE 幂等、单层列举、恒中转白名单、工厂注册 |
| `wrangler deploy --dry-run`（含四家原生驱动 + WebDAV） | 通过：1865.57 KiB / gzip 446.72 KiB（crypto-js 贡献约 300 KiB 原始体积；gzip 后仍远低于免费档 3 MiB 上限） |
| 本地预览端到端 | `/` 200、`/api/v4/site/ping` → `4.19.1`、`register_enabled: true`、管理端 chunk 200 |

首次拉前端耗时约 **10 分钟**：本机的 Release 预构建包下载重试 4 次都失败（网络），
脚本自动退回「拉上游源码 → yarn install → vite build」。CI 上命中预构建包通常秒级。
如果构建机网络访问 GitHub Release 不稳定，可以配 `GH_TOKEN`，或干脆把已经生成好的
`frontend/` 一并提交进仓库（45 MB，`.gitignore` 里默认排除，需要手动加白名单）。

已知依赖告警：`npm audit` 报 1 个 moderate（生产依赖 `hono <=4.13.15`，`npm audit fix` 可修）
和 4 个 high（都在 devDependencies 的 wrangler 工具链里，不进运行时）。
上游版本锁得比较死，**建议不要擅自 `npm audit fix`**，等上游跟进更稳妥。

许可 **GPL-3.0**。上游 README 声明本项目大量使用 AI 辅助开发，自带冒烟测试
（`npm run smoke`、`npm run test:node`），上生产前建议自行评估，重要数据做好备份。

---

## 八、和原 v3 的功能对照

| 能力 | 这个 v4 Worker 版 |
|---|---|
| 文件管理 / 分享 / 直链 / 回收站 / WebDAV | 支持 |
| 多存储策略（R2/S3/OSS/COS/七牛/OneDrive/又拍云） | 支持 |
| 用户组权限、管理后台、离线下载、压缩解压、OIDC | 支持 |
| 本地磁盘存储 | 需挂「从节点」（官方 Cloudreve 从机或仓库自带的 `agent/cloudreve-node-agent.mjs`） |
| 视频转码 | 未做（边缘没有常驻转码进程） |
| v3 的 SQLite 数据库 / 旧数据 | 不兼容，无法迁移 |

---

## 九、本地预览（不连云端、不需要服务器）

这台机器没装 PostgreSQL 也没有 Docker，所以用 **PGlite**（编译成 WASM 的真 PostgreSQL 18.6）
加 `@electric-sql/pglite-socket` 在 `127.0.0.1:5432` 暴露一条标准 PG 线协议——
Worker 里的 `postgres.js` 驱动原样连上，**业务代码一行都不用改**。KV / R2 / 静态资源
由 `wrangler dev --local` 本地模拟。

### 启动

两个终端，各跑一条（顺序：先数据库，再 Worker）：

```bash
cd E:\AI\projects\cloudreve-worker
npm install
npm run dev:db       # 终端 1：PGlite → 127.0.0.1:5432
npm run dev:local    # 终端 2：Worker → http://127.0.0.1:8899
```

`.dev.vars` 已经配好（本地连接串、端口、JWT），且被 `.gitignore` 排除，不会误提交。
前端产物 `frontend/` 需要存在，没有就先跑 `node scripts/fetch-frontend.mjs`。

> 端口用的是 **8899** 而不是 wrangler 默认的 8787：本机 8787 已被别的进程占用，
> Windows 下会报 `bind(): os error 10013`。要换端口记得同时改 `dev:local` 和 `.dev.vars` 的 `SITE_URL`。

### 首次打开

访问 `http://127.0.0.1:8899`，登录页底部有「还没有账号？**立即注册**」，点进去是
`/session/signup`，**注册的第一个账号自动成为管理员**。
首次请求会触发自动建表（18 个迁移 + 播种系统数据），数据落在 `.local-db/`。
想重置直接删掉 `.local-db/` 重启即可。

> **为什么一开始看不到注册入口**：上游 `DEFAULT_SETTINGS.register_enabled = '0'`
> （fail-closed，防止线上误开注册），前端登录页据此隐藏 `/session/signup` 链接；
> 后端虽在空库时放行首个管理员自注册，界面上却没有入口，只会提示「账号不存在」。
>
> `dev:db` 启动脚本会在 Worker 自举**之前**，按 migration 0001 的 DDL 原样预建
> `settings` 表并写入 `register_enabled=1`。`ensureSettings()` 只补缺失键、不改已有行，
> 播种不会把它覆盖回 0；设置缓存也从一开始就是「已开启」，不会先缓存一份旧的关闭快照。
> **这段逻辑只存在于本地脚本**，生产部署依旧默认关闭，需要管理员到后台手动开启。
>
> - 想让本地也保持关闭：`LOCAL_OPEN_REGISTER=0 npm run dev:db`
> - 若之前已经缓存过旧值（改库后接口仍返回 false）：删掉 `.wrangler/state/` 再重启
>   Worker，或等 KV 快照 300 秒 TTL 自然过期

验证过的端点：

| 路径 | 结果 |
|---|---|
| `/` | 200，`index.html` 占位符已填充 |
| `/session/signup` | 200，注册页（SPA 回退到 `index.html`） |
| `/api/v4/site/ping` | `{"code":0,"data":"4.19.1"}` |
| `/api/v4/site/config/login` | `register_enabled: true`（注册入口开关） |
| `/api/v4/site/config/basic` | 完整站点配置（证明自动建表 + 播种成功） |
| `/api/v4/site/captcha` | 返回 SVG 验证码（证明 KV 写入正常） |
| `/assets/index-*.js` | 200，1.5 MB 主包 |
| `/manifest.json` | 200，PWA manifest |

### 边界

PGlite 是**单连接 WASM 数据库**，只适合本地看界面、试功能，不要拿它跑压测或当生产库。
本地预览也没有真实的 R2 / Neon / 自定义域名，上传大文件、离线下载、WebDAV 挂载这些
依赖外部服务的功能，仍要按前面的部署章节连真实资源才能完整验证。
Worker 业务代码、迁移 SQL、前端产物三者与线上完全一致，所以界面和 API 行为是可信的。

---

## 十、免费账户能不能跑（2026-11-15 核对官方限额）

**结论：能，0 元可跑，而且这个项目本来就是按免费档设计的。** 代码里多处注释针对
「免费档 50 subrequests」「免费档 Neon 429」做过优化，上游 `DEPLOY.md` 也写明
「免费档够用」。所有必需能力都在免费档开放：Workers、KV、R2、Static Assets、
Cron Triggers、Smart Placement（官方明确「available on all Workers plans」）。

### 实际占用 vs 免费额度

| 项目 | 本项目实际 | Workers Free 上限 |
|---|---|---|
| Worker 打包体积 | 1.49 MiB（gzip 384 KiB） | 64 MiB（未压缩） |
| 静态资源 | 575 个文件，最大 4.86 MB | 20,000 个 / 单文件 25 MiB |
| Worker 数量 | 1 | 100 |
| Cron Trigger | 1 个（每小时） | 5 个/账户 |
| KV namespace | 6 个（`KV_COUNT=5` + 兜底） | 1,000 |
| 请求数 | — | **100,000/天**（账户级，UTC 重置） |
| CPU | — | **10 ms/请求**（网络等待不计；付费默认 30 s） |
| subrequests | — | 50/请求、6 个并发出站连接 |
| 上传请求体 | 预签名 URL 直传 R2，字节不过 Worker | Free zone 100 MB |

> 上传走预签名 URL 直传（`src/services/upload.ts`），因此 100 MB 请求体上限和
> 10 ms CPU **都不会**限制大文件；文件本体占的是 R2 免费额度，不是 Neon 库容量。

### 三边配额（都不花钱，但都不是无限）

| 服务 | 免费额度 | 超额后果 |
|---|---|---|
| Cloudflare Workers / KV | 10 万请求/天；KV 读 10 万/天、**写 1,000/天**、删除/List 各 1,000/天、存储 1 GB（**账户级**） | 直接报错：1027 / 429 / KV 操作失败，**不会自动扣费** |
| Cloudflare R2 | 10 GB-month 存储、100 万 Class A、1000 万 Class B、出口流量免费 | **会真实计费**，务必设账单告警 |
| Neon Postgres | 1 GB 库、100 CU-小时/月、5 GB 出网/月、5 分钟无请求休眠 | 计算暂停到下个账期（**数据不丢**）；休眠后首个请求冷启动几百 ms |

### 真正会卡住的地方

1. **KV 写 1,000 次/天最容易撞到**：登录、验证码、上传会话、设置失效、cron 标记
   都写 KV，且额度是账户级 —— 分成 5 个 namespace 不会变多，分片的真实目的是
   避开「同一个 key 每秒只能写 1 次」。个人站够，多人或频繁上传会先在这里出问题。
2. **`run_worker_first` 把 `/assets/*` 也配成了 Worker-first**：官方明确静态资源请求
   「免费且无限」，但列入这个数组的路径会**始终调用 Worker** 并计入 10 万/天；
   一旦超额，这些请求返回 **429 而不是回退静态资源**。想省配额可以把它从数组里
   去掉（代价：不存在的 assets 路径会被 SPA 回落成 `index.html`；带 hash 的正常资源
   不受影响）。
3. **CPU 10 ms**：密码哈希是轻量 `SHA-256(password+salt)`（非 bcrypt/argon2），
   JWT 走 WebCrypto，日常接口压力不大；但大列表、打包下载、客户端加密等重 JSON
   接口仍可能触发 `Error 1102`。作者已用多层缓存把 DB 往返尽量变成「网络等待」
   （网络等待不计 CPU）。
4. **Neon 免费档并发突发会 5xx/429**：`src/db/index.ts` 注释记录了实测
   「6 路并发 × 24 请求有 14 个失败」，代码里有重试与降级，但公开服务仍会偶发慢或失败。
5. **cron 也只有 10 ms CPU**：每小时的缓存刷新 / 回收站清理可能跑不完整，
   后台任务失败不影响主功能，但回收站到期清理可能延迟。

### 建议

- **个人 / 小团队**：免费档足够。把根目录 `KV_COUNT` 从 `5` 调成 `1`（少建几个
  namespace、简化部署；写额度不变，因为是账户级），去掉 `run_worker_first` 里的
  `/assets/*`，并在 Cloudflare 账单页给 R2 加一条用量告警。
- **要对外开放给多人**：最划算的是只升 **Workers Paid $5/月** —— CPU 从 10 ms
  提到 30 s、请求不限量、KV 写从 1,000/天 变成 100 万/月。Neon 与 R2 可继续用免费档。
- **Workers Builds**（Fork + Git 自动部署）免费档给 3,000 构建分钟/月、1 个并发、
  单次 20 分钟超时；本项目首次拉前端构建约 10 分钟，仍在范围内。也可以用本机
  `npm run deploy` 完全绕开 Builds。
- **R2 开通要完成结算流程（绑卡）**：免费额度内不扣费，但 R2 没有硬封顶；
  这与 Workers / KV / Neon「超额直接停」的性质不同，别混为一谈。

---

## 十一、国内网盘接入：天翼 / 移动 / 联通 / 阿里云盘（原生驱动）

### 这一版是原生直连，不再需要网桥

上一版把四家统一转发给 OpenList / AList 实例（「网桥」）。现在四个类型各有
**自己的驱动**，直接对网盘官方的 Web/App 接口说话：

```
浏览器 ──整文件 PUT──> Cloudreve Worker ──分片直传──> 天翼 / 移动 / 联通 / 阿里云盘
                              │
                              └─ 各家的登录态、签名、加解密、哈希都在 Worker 里算
```

| 类型 | 驱动文件 | 鉴权方式 | 上传协议 | 需要 R2 |
|---|---|---|---|---|
| `cloud189` 天翼 | `src/storage/netdisk/cloud189.ts` | 浏览器 Cookie，或账号 + 密码（OAuth2 + RSA） | 10 MB 分片，AES-128-ECB 参数 + HMAC-SHA1 签名 + 预签名 PUT | 否 |
| `yun139` 移动 | `src/storage/netdisk/yun139.ts` | `authorization`（base64） | 100 MB 分片，`mcloud-sign` 签名 + 预签名 PUT | **是** |
| `wopan` 联通 | `src/storage/netdisk/wopan.ts` | `access_token` + `refresh_token` | 8 MB 分片，`upload2C` multipart 表单 | 否 |
| `aliyundrive` 阿里 | `src/storage/netdisk/aliyundrive.ts` | 官方开放平台 `refresh_token`（OAuth2） | 10 MB 分片，OSS 预签名 PUT | 否 |

四家都是**恒中转**类型（`RELAY_ONLY_POLICY_TYPES`）：浏览器把整个文件作为
index=0 PUT 给 Worker，驱动内部按各家分片大小切片上云。所以单文件大小只受
Workers 请求体限制（免费档 100 MiB），策略 `max_size` 建议 ≤ 95 MB。

### 为什么移动云盘要占 R2

139 的 `POST /file/create` **必须**带整文件 SHA-256（用于秒传判定），而
Cloudreve 交给驱动的是一条单向流，读完就没了。解法是把流先写进 R2 临时对象
（同时增量算 SHA-256），再从 R2 按分片 `range` 读回来直传，最后一次 `complete`，
**临时对象在 finally 里删除**。因此：

- `wrangler.toml` 里的 `r2_buckets` → `R2` 绑定不能删；
- R2 免费档 10 GB 足够（临时对象都是 MB 级、天级清理）；
- 没有 R2 绑定时，`yun139` 策略会在上传时报明确错误，其余三家不受影响。

### 凭据怎么拿

四家都是非官方接口（阿里云盘除外），接口和风控随时会变。

**天翼云盘（推荐 Cookie）**

1. 浏览器登录 <https://cloud.189.cn>；
2. F12 → Network → 随便点一个请求 → 复制请求头 `Cookie` 整串
   （形如 `COOKIE_LOGIN_USER=...; sessionKey=...; ...`）；
3. 填到策略的「浏览器 Cookie」。

用账号密码也能登录（`open.e.189.cn` 的 OAuth2 + RSA 加密），但触发滑块 /
设备锁时无法自动完成，会报「登录触发验证码/设备保护」——那就只能用 Cookie。

**移动云盘（authorization）**

1. 浏览器登录 <https://yun.139.com>；
2. F12 → Network → 任一 `/file/` 请求 → 复制 `Authorization: Basic xxx` 里的 `xxx`
   （base64 的 `账号:账号:token`，token 里带过期时间戳）；
3. 顺手把同一个请求里能看到的 `userDomainId`（或登录响应里的字段）填到
   「userDomainId」，驱动才能在你 token 快过期时自动续期。

**联通云盘（access_token + refresh_token）**

用沃盘 App 或 <https://pan.wo.cn> 登录后抓包：请求头 `Accesstoken` 即
`access_token`；`AppRefreshToken` 接口响应里有 `refresh_token`。
token 约 2 小时过期，**两个都要填**，驱动会在 `RSP_CODE=9999` 时自动续期。
注意联通云盘自 2026-10 起会拦截 `go-resty` 默认 UA，本驱动统一用浏览器 UA。

**阿里云盘（refresh_token）**

四家里唯一有正式开放平台的：`openapi.aliyundrive.com/adrive/v1.0`。
用任意扫码授权工具拿到 `refresh_token`（`access_token` 只有 2 小时，驱动自动续）。
如果你在阿里云开放平台注册了自己的应用，把 `client_id` / `client_secret` 一并填上；
留空则用内置公共 AppID。

### 在后台创建策略

管理后台 → 存储策略 → 新建，四张卡片：天翼云盘 / 移动云盘 / 联通云盘 / 阿里云盘。

| 向导字段 | 后端字段 | 说明 |
|---|---|---|
| 策略名称 | `name` | 随意 |
| 挂载根路径 | `bucket_name` | 默认 `/cloud189` `/cloud139` `/wopan` `/aliyun`；不存在会自动逐级创建 |
| 单文件上限 | `max_size` | 默认 95 MB（免费档请求体上限 100 MiB） |
| 跳过连接测试 | `settings.netdisk_skip_probe` | 对端限流 / 风控时勾选 |

凭据字段：

| 类型 | 字段 |
|---|---|
| 天翼 | `settings.c189_cookie`（Cookie）或 `access_key`/`secret_key`（账号密码）；`settings.c189_root_folder_id` 默认 `-11` |
| 移动 | `settings.y139_authorization`、`settings.y139_user_domain_id`、`settings.y139_root_folder_id` 默认 `/` |
| 联通 | `settings.wp_access_token`、`settings.wp_refresh_token`、`settings.wp_root_folder_id` 默认 `0` |
| 阿里 | `settings.ali_refresh_token`、`access_key`/`secret_key`（client_id/secret）、`settings.ali_drive_id`、`settings.ali_root_folder_id` 默认 `root` |

新建时会先用这份凭据做一次**只读探测**（登录 + 读根目录），失败**不落库**，
错误信息会区分「凭据过期」和「网络不可达」。改策略时不探测（面板回填的是掩码）。

### 限制（用之前一定看）

1. **单文件上限 = Workers 请求体上限**：整文件中转，不支持断点续传 / 分片续传。
   天翼与移动的「秒传」由对端判断（同内容文件已存在时上传会直接完成）。
2. **缩略图不可用**：四家驱动 `thumb()` 都返回 null，图片预览走原图。
3. **容量不联动**：Cloudreve 的用户组配额与网盘剩余空间无关，网盘满了由对端报错。
4. **token 会过期**：天翼 Cookie 一般能用很久，失效后需更新；移动 token 过期后
   需要重新抓（填了 `userDomainId` 可自动续）；联通/阿里有 refresh_token 自动续。
5. **私有接口不保证稳定**：限速、改字段、加风控都会导致失效。阿里云盘最稳
   （官方 API），其余三家请把重要数据另存备份。
6. **账号风险**：第三方客户端挂载个人网盘可能触发服务商风控，风险自负。

### 验证与排错

```bash
npm run test:netdisk     # 四家原生驱动冒烟测试（mock fetch + mock R2），44 项断言
npm run typecheck
```

冒烟测试覆盖：189 的 Cookie 透传 / 上传签名头 / 分片 PUT / commit；联通的
dispatcher 信封（`header.sign` 32 位 hex、`param` AES 密文、`Accesstoken`）与
`upload2C` 表单字段；阿里的 OAuth 刷新、`part_info_list`、Bearer、complete；
139 的路由 host、`mcloud-sign` 三段、create 里的 SHA-256 与 R2 临时对象清理；
以及 `..` 路径穿越过滤、恒中转白名单、`openlist` 已从支持列表移除。

| 现象 | 原因 / 处理 |
|---|---|
| 天翼报「登录触发验证码/设备保护」 | 账号密码登录被风控，改用 Cookie |
| 天翼报 `InvalidSessionKey` | Cookie 过期，重新复制 |
| 移动报「路由解析失败」 | authorization 过期，重新抓；或账号被风控 |
| 移动上传报「需要 R2 绑定」 | `wrangler.toml` 里 `r2_buckets` 被删了，加回来 |
| 联通报 `9999` 且刷新失败 | refresh_token 也过期了，两个 token 都要更新 |
| 阿里报 `token 刷新失败` | refresh_token 失效（换过账号或在别处重新授权），重新取 |
| 上传成功但列表看不到文件 | 挂载根路径写错了，文件在别的目录；或者对端有缓存，刷新目录 |
| 上传 413 / 中断 | 超过 Workers 请求体上限，调低 `max_size` |
| 下载 403 | 网盘直链防盗链，本站默认强制代理，不要关（`proxyRequired: true`） |

---

## 十二、WebDAV 存储（原生驱动，无需网桥）

Cloudreve 自带一个 WebDAV **服务端**（`/dav`，给客户端挂载本站空间）；
本节说的是反过来——**把远程 WebDAV 服务当存储策略**，两者互不相干。

### 为什么这个可以原生实现

WebDAV 是 RFC 4918 开放标准，只用普通 HTTP 方法，Cloudflare Workers 的
`Request` 支持除 `CONNECT` 外的所有方法（含 `PROPFIND` / `MKCOL` / `MOVE`）。
所以本站直接发协议请求即可，**不需要再部署 OpenList 或任何中间服务**：
凭据、token 刷新、私有 API 逆向这套麻烦一概没有。

```
浏览器 ──> Cloudreve Worker ──PUT/PROPFIND/GET──> 你的 WebDAV 服务
              （凭据只在 Worker 侧，不下发浏览器）
```

已在管理后台「存储策略 → 新建」加了 **WebDAV** 卡片和创建向导
（`Wizards/WebDav/WebDavWizard.tsx`），带常见服务地址预设。

### 支持的服务与凭据

| 服务 | 地址示例 | 凭据 |
|---|---|---|
| Nextcloud / ownCloud | `https://host/remote.php/dav/files/<用户名>/` | 设置 → 安全 → **创建应用密码**，别用主密码 |
| 坚果云 | `https://dav.jianguoyun.com/dav/` | 账号邮箱 + 「账户信息 → 安全选项 → 添加应用」生成的**应用密码** |
| AList / OpenList | `https://host/dav/` | WebDAV 账号密码（对端需开启 WebDAV 功能） |
| 群晖 NAS | `https://host:5006/` | 控制面板 → 文件服务 → WebDAV，启用 HTTPS 端口 |
| Seafile / 其他标准实现 | `https://host/seafdav/` 等 | 按各家文档 |

硬性要求：**公网可达 + HTTPS + 可信证书**。Workers 出站连不上自签证书；
内网 / 回环地址会被 SSRF 防护直接拒绝（要走家里 NAS 请用域名 + Tunnel）。

### 策略字段映射

| 表单字段 | 落到哪里 | 说明 |
|---|---|---|
| WebDAV 服务地址 | `policy.server` | 会补 `https://` 与结尾 `/`；**必须填最终地址**，发生 301/302 时流式 PUT 无法跟随 |
| 挂载子目录 | `policy.bucket_name` | 默认 `cloudreve`，可留空表示根目录；不存在时自动逐级 `MKCOL` |
| 用户名 / 密码 | `policy.access_key` / `secret_key` | Basic 认证，UTF-8 编码后 base64 |
| Bearer Token | `settings.token` | 填了就优先于 Basic |
| 自定义请求头 | `settings.dav_headers` | JSON 对象，如 `{"X-App-Token":"abc"}`；键名只允许字母数字连字符 |
| 单文件上限 | `policy.max_size` | 默认 95 MB |
| 跳过连接测试 | `settings.dav_skip_probe` | 对端暂时不可达、想先建好策略时勾 |

点「创建」时后端会先发一次**只读** `PROPFIND Depth:0`：401 提示凭据错误、
404 提示根路径不存在、405 提示不是 WebDAV 端点，失败不落库。
编辑已有策略时不探测（前端把密码回填成掩码，探测必然失败）。

### 协议实现

| 驱动方法 | WebDAV 请求 |
|---|---|
| `put` / `writeChunk` | `PUT`（`Overwrite: T/F`）+ 上传前逐级 `MKCOL` 建父目录 |
| `get` | `GET` + 原样透传 `Range`，206 的 `Content-Range` 回传 |
| `meta` | `HEAD`；服务不支持（405/501）时回退 `PROPFIND Depth:0` |
| `delete` | `DELETE`，404 视为幂等成功 |
| `list` | `PROPFIND Depth:1` + 轻量 multistatus XML 解析（单层、不递归） |
| `cancelToken` | `DELETE` 占位对象 |
| `source` / `thumb` | 不提供：下载强制走 Worker 代理，缩略图返回 null |

**PUT 的请求体是 `ReadableStream` 直接转发，不缓冲成 `Uint8Array`。**
免费档 Worker 只有 128 MB 内存，缓冲一个接近 100 MB 的文件会 OOM；流式转发
让大文件只占很少内存。代价是流不可重放，所以 PUT 不跟随重定向——这就是
「必须填最终地址（含尾斜杠）」的原因。其余方法走 `safeFetch`，逐跳校验
重定向目标，防止 SSRF。

### 限制（用之前一定看）

1. **单文件仍受 Workers 请求体上限约束**（免费档 100 MB）。WebDAV 没有可追加的
   分片协议，因此**不支持分片、断点续传、秒传**；`max_size` 配在套餐范围内。
   真正需要大文件请继续用 R2 / S3 策略。
2. **下载多一跳**：Basic / Bearer 凭据不能给浏览器，所以一律由 Worker 代理，
   网速与延迟取决于 Worker ↔ WebDAV 服务这一段。
3. **无缩略图、无容量联动**：图片预览走原图；Cloudreve 里的容量是用户组配额，
   不读取对端剩余空间。
4. **只支持 Basic / Bearer**，不实现 Digest（需要多轮 challenge-response）。
   坚果云、Nextcloud 一律用应用专用密码。
5. `list()` 只列举单层、不递归、无分页令牌，导入大量深层目录时不会全量扫描。
6. `MKCOL` 结果在 isolate 内缓存；若目录被外部删掉，PUT 会返回 409，
   驱动会清缓存并提示重试一次上传。

### 验证与排错

```bash
npm run test:webdav   # 无网络依赖的冒烟测试（mock WebDAV 服务），62 项断言
npm run typecheck     # 后端类型检查
```

测试覆盖：流式 PUT 与 URL 编码、逐级 MKCOL 与缓存、3xx/409 分支、
Basic/Bearer/自定义请求头、SSRF 拒绝内网地址、PROPFIND 探测与
multistatus XML（含 `lp1:` 等命名空间前缀、非 200 propstat）解析、
HEAD→PROPFIND 回退、Range GET、DELETE 幂等、单层列举、工厂注册。

| 现象 | 原因 / 处理 |
|---|---|
| 创建时报 401 | 用户名或应用密码错；坚果云/Nextcloud 必须用应用专用密码 |
| 创建时报 404 | `server` 路径本身不存在（挂载子目录会自动建，但服务根路径要先存在） |
| 创建时报 405 / 501 | 填的不是 WebDAV 端点（常见：填成网盘网页地址） |
| `Refusing to fetch a private...` | 填了内网 IP；改公网域名 + HTTPS |
| 上传报 `PUT was redirected` | 地址发生 301/302，补上结尾 `/` 或改成最终跳转后的 URL |
| 上传报 `HTTP 409` | 父目录被外部删除，重试一次（缓存已清）；持续失败请检查账号写权限 |
| 上传报 423 Locked | 对端文件被 WebDAV 客户端锁住，解锁后重试 |
| 下载慢 / 播放器卡 | 上传下载都经 Worker 代理；大文件建议改 R2 / S3 |
| 连接测试一直失败但地址没错 | 勾「跳过连接测试」先建策略，再用上传/下载实测；自签证书在 Workers 上无法使用 |

---

## 十三、通过 GitHub 部署（两种方式，选一种即可）

代码托管在 GitHub 后，有两条自动化路线：

### 方式 1：GitHub Actions（本仓库已内置，推荐）

仓库里带 [.github/workflows/deploy.yml](.github/workflows/deploy.yml)：
**push 到 main 即自动** typecheck → 冒烟测试（netdisk 44 项 / webdav 62 项）→
构建前端 → `node scripts/deploy.mjs` 部署（自动装配 KV、建 R2、写 Secret）。

一次性配置（在 GitHub 仓库页）：

1. **Settings → Secrets and variables → Actions**，添加：

   | Secret | 哪里拿 | 必填 |
   |---|---|---|
   | `CLOUDFLARE_API_TOKEN` | Cloudflare 面板 → My Profile → API Tokens → Create Token → 用 **Edit Cloudflare Workers** 模板，并追加 **Account: KV Storage Edit** 与 **R2 Edit** 权限（脚本要自动建资源） | 是 |
   | `CLOUDFLARE_ACCOUNT_ID` | Workers & Pages 概览页右侧 | 是 |
   | `DATABASE_URL` | Neon / Supabase 等的 PG 连接串；填了它部署后会自动写入 Worker 运行时 Secret | 是 |
   | `SITE_URL` | 部署后的 Worker 地址（首次部署后再回填也行） | 建议 |

2. push 到 main（或在 Actions 页手动 Run workflow）。

### 方式 2：Workers Builds（Cloudflare 面板接仓库，零配置 Secret）

1. Cloudflare 面板 → **Workers & Pages → Create → Workers → Connect to Git**，
   授权 GitHub 并选中仓库，分支 `main`。
2. 构建配置（面板会自动识别，确认一下）：
   - **Build command**：`npm run deploy`
   - **Deploy command**：留空（`npm run deploy` 内部就是 wrangler deploy）
   - **Root directory**：`/`
3. 在构建设置的**变量**里加 `DATABASE_URL`（类型 Secret）。`KV_COUNT` 也要在这里
   作为**构建变量**加（默认 1；这是构建期变量，不是运行时变量，别加错地方）。

Workers Builds 会自动注入 API token，不需要手动建 token。免费档 3000 分钟/月构建时长，
本项目单次构建约 7 分钟（大头是前端构建），每日 7 次推送也绰绰有余。

> 两种方式二选一即可，同时开也没冲突（最后部署的生效）。Actions 胜在「部署前先跑测试」，
> Workers Builds 胜在「不用管理 token」。

### 从 LegspCpd 原仓库改推自己账号

```bash
git remote set-url origin https://github.com/<你的用户名>/Cloudreve-Worker.git
git push -u origin main
```
