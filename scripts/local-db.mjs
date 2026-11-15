#!/usr/bin/env node
/**
 * 本地预览用的 PostgreSQL 服务。
 *
 * 本机没装 PostgreSQL / Docker，这里用 PGlite（编译成 WASM 的真 Postgres）
 * + pglite-socket 在 127.0.0.1:5432 暴露一条标准 PG 线协议，
 * 让 Worker 的 postgres.js 驱动原样连上，业务代码一行都不用改。
 *
 * 数据落在 .local-db/（可删掉重置）。启动：
 *   node scripts/local-db.mjs
 */
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, '.local-db');
const PORT = Number(process.env.LOCAL_DB_PORT || 5432);

const db = await PGlite.create(DATA_DIR);
const server = new PGLiteSocketServer({ db, port: PORT, host: '127.0.0.1' });
await server.start();

/**
 * 本地预览专属：让登录页出现「立即注册」入口。
 *
 * 上游 `DEFAULT_SETTINGS.register_enabled = '0'`（fail-closed，避免线上误开注册），
 * 前端登录页据此隐藏 `/session/signup` 链接。空库时后端虽然放行首个管理员自注册，
 * 但界面上没有入口，只会提示「账号不存在」，预览就卡住了。
 *
 * 这里在 Worker 自举**之前**按 migration 0001 的 DDL 原样预建 settings 表并写入
 * `register_enabled='1'`。`ensureSettings()` 只补缺失键、不改已有行，播种不会把它
 * 覆盖回 0；设置缓存也从一开始就是「注册已开启」，不存在陈旧快照问题。
 * 生产部署完全不运行本脚本，fail-closed 行为不变。
 *
 * 想让本地也保持关闭：`LOCAL_OPEN_REGISTER=0 npm run dev:db`。
 */
const OPEN_REGISTER = process.env.LOCAL_OPEN_REGISTER !== '0';
if (OPEN_REGISTER) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
        id         SERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        deleted_at TIMESTAMPTZ,
        name       TEXT NOT NULL,
        value      TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS setting_name ON settings (name);
    INSERT INTO settings (name, value) VALUES ('register_enabled', '1')
      ON CONFLICT (name) DO UPDATE SET value = '1', updated_at = now();
  `);
  console.log('✓ 本地预览：注册入口已开启（register_enabled=1）');
} else {
  console.log('· 本地预览：注册入口保持关闭（LOCAL_OPEN_REGISTER=0）');
}

const version = await db.query('select version()');
console.log(`✓ 本地 PG 就绪：postgresql://postgres@127.0.0.1:${PORT}/postgres`);
console.log(`  ${version.rows[0]?.version}`);
console.log(`  数据目录：${DATA_DIR}`);

const shutdown = async () => {
  await server.stop();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
