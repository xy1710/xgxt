/**
 * 临时脚本：把 uniTable.ts 的 UNI_MAP 全量取出，逐对做列对账。
 * 输出：老表独有列 / 统一表独有列 / 共有列。
 * 用途：P1 接入切读层 与 P5 数据搬迁 的权威依据。
 */
import { readFileSync, writeFileSync } from 'fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('dotenv').config({ path: path.join(process.cwd(), '.env') });
const knex = require('knex');

const src = readFileSync(path.join(process.cwd(), 'src/teaching/shared/uniTable.ts'), 'utf8');
const m = src.match(/export const UNI_MAP: Record<string, string> = \{([\s\S]*?)\n\};/);
if (!m) throw new Error('UNI_MAP 没找到');
const body = m[1]
  .split('\n')
  .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
  .join('\n');
const pairs = [...body.matchAll(/'([^']+)'\s*:\s*'([^']+)'/g)].map((x) => [x[1], x[2]]);

const conn = (dbName) =>
  knex({
    client: 'mysql2',
    connection: {
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT) || 3306,
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: dbName,
      charset: 'utf8mb4',
      dateStrings: true,
    },
    pool: { min: 0, max: 2 },
  });

async function colsOf(k, dbName, table) {
  // ⚠️ 必须用 raw：knex 的 .where({table_schema}) 走 information_schema 时
  //    返回的键名会被 mysql2 大写化（COLUMN_NAME），导致按 column_name 取值全 undefined。
  const [rows] = await k.raw(
    `select column_name as name, column_type as type, is_nullable as nullable,
            column_default as def, extra
       from information_schema.columns
      where table_schema = ? and table_name = ?
      order by ordinal_position`,
    [dbName, table],
  );
  return rows || [];
}

const common = conn(process.env.DB_NAME_COMMON || 'sms_common');
const cache = new Map();
async function colsCached(dbName, table) {
  const key = `${dbName}.${table}`;
  if (cache.has(key)) return cache.get(key);
  const dbName2 = dbName.startsWith('sms_') ? dbName : dbName;
  let k = dbName2 === (process.env.DB_NAME_COMMON || 'sms_common') ? common : conn(dbName2);
  const v = await colsOf(k, dbName2, table);
  cache.set(key, { cols: v, k });
  return cache.get(key);
}

const out = [];
out.push(`# 老表 → 统一表 列对账（自动生成，共 ${pairs.length} 对）\n`);

let same = 0;
const lines = [];
for (const [key, uniTable] of pairs) {
  const [dbName, table] = key.split('.');
  let o, u;
  try {
    o = (await colsCached(dbName, table)).cols;
  } catch (e) {
    lines.push(`\n## ${key} → ${uniTable}\n  ⚠️ 读老表失败: ${e.message}`);
    continue;
  }
  try {
    u = (await colsCached(process.env.DB_NAME_COMMON || 'sms_common', uniTable)).cols;
  } catch (e) {
    lines.push(`\n## ${key} → ${uniTable}\n  ⚠️ 读统一表失败: ${e.message}`);
    continue;
  }
  if (!o.length) {
    lines.push(`\n## ${key} → ${uniTable}\n  ⚠️ 老表不存在或 0 列`);
    continue;
  }
  if (!u.length) {
    lines.push(`\n## ${key} → ${uniTable}\n  ⚠️ 统一表不存在或 0 列`);
    continue;
  }
  const os = new Set(o.map((c) => c.name));
  const us = new Set(u.map((c) => c.name));
  const onlyOld = [...os].filter((c) => !us.has(c));
  const onlyUni = [...us].filter((c) => !os.has(c));
  const both = [...os].filter((c) => us.has(c));
  if (!onlyOld.length && !onlyUni.length) {
    same++;
    lines.push(`\n## ${key} → ${uniTable}  ★列完全一致（${both.length}列）`);
    continue;
  }
  lines.push(`\n## ${key} → ${uniTable}   (老${o.length}列 / 统一${u.length}列)`);
  lines.push(`  仅老表有(${onlyOld.length}): ${onlyOld.join(', ') || '—'}`);
  lines.push(`  仅统一有(${onlyUni.length}): ${onlyUni.join(', ') || '—'}`);
  lines.push(`  共有(${both.length}): ${both.join(', ') || '—'}`);
}

out.push(lines.join('\n'));
const target = path.join(process.cwd(), 'exports', '_col-diff.md');
try {
  writeFileSync(target, out.join('\n'), 'utf8');
} catch {
  writeFileSync('/tmp/_col-diff.md', out.join('\n'), 'utf8');
}
console.log(out.join('\n'));
console.log(`\n===== 共 ${pairs.length} 对；列完全一致 ${same} 对 =====`);
console.log('输出文件:', target);
await Promise.all([...new Set([...cache.values()].map((v) => v.k))].map((k) => k.destroy()));
process.exit(0);
