/**
 * 迁移执行器（幂等）
 * ============================================================
 * 用法：
 *   node scripts/_migrate-run.mjs <迁移目录> <数据库名> [--apply]
 *   node scripts/_migrate-run.mjs migrations-class-common sms_common --apply
 *
 * 说明：
 *   · 本仓库的迁移都写成「表/列不存在才动手」，可安全重复执行
 *   · 默认只列出将要执行的文件，加 --apply 才真正跑
 *   · 每个文件单独 try/catch，失败不中断后续
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import knexFactory from 'knex';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env') });
const require = createRequire(import.meta.url);

const [, , dirArg, dbArg, ...rest] = process.argv;
const APPLY = rest.includes('--apply');
if (!dirArg || !dbArg) {
  console.error('用法: node scripts/_migrate-run.mjs <迁移目录> <数据库名> [--apply]');
  process.exit(1);
}

const dir = path.resolve(ROOT, dirArg);
const onlyArg = (rest.find((a) => a.startsWith('--only=')) || '').replace('--only=', '');
const only = onlyArg ? new Set(onlyArg.split(',').map((x) => x.trim())) : null;
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.js'))
  .filter((f) => !only || [...only].some((k) => f.includes(k)))
  .sort();

const knex = knexFactory({
  client: 'mysql2',
  connection: {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: dbArg,
    charset: 'utf8mb4',
    timezone: '+08:00',
  },
  pool: { min: 0, max: 2 },
});

console.log(`${APPLY ? '【执行】' : '【预演】'} ${dirArg} → ${dbArg}，共 ${files.length} 个文件\n`);

let ok = 0;
let failed = 0;
for (const f of files) {
  const mod = require(path.join(dir, f));
  if (typeof mod.up !== 'function') {
    console.log(`  跳过（无 up） ${f}`);
    continue;
  }
  if (!APPLY) {
    console.log(`  将执行 ${f}`);
    continue;
  }
  try {
    await mod.up(knex);
    ok++;
    console.log(`  ✅ ${f}`);
  } catch (e) {
    failed++;
    console.log(`  ❌ ${f}  ${e.message}`);
  }
}

await knex.destroy();
console.log(`\n${APPLY ? `完成：成功 ${ok} / 失败 ${failed}` : '预演结束，加 --apply 执行'}`);
