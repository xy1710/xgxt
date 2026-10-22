/**
 * 临时脚本：找出「切读会炸」的列。
 * 定义：统一表有该列、老表没有该列、该列 NOT NULL 且无 DEFAULT（→ 老代码 insert 必挂 ER_NO_DEFAULT_FOR_FIELD）
 * 另附：老表独有列（→ 切读时读/写都会 Unknown column，必须靠 UNI_COL_RENAME 或剔除）
 */
import { readFileSync } from 'fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('dotenv').config({ path: path.join(process.cwd(), '.env') });
const knex = require('knex');

const src = readFileSync(path.join(process.cwd(), 'src/teaching/shared/uniTable.ts'), 'utf8');
const body = src
  .match(/export const UNI_MAP: Record<string, string> = \{([\s\S]*?)\n\};/)[1]
  .split('\n')
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join('\n');
const pairs = [...body.matchAll(/'([^']+)'\s*:\s*'([^']+)'/g)].map((x) => [x[1], x[2]]);

// 已登记的 rename / 剔除清单（从源码里取，避免手抄）
const renameBlock = src.match(/const UNI_COL_RENAME: Record<string, Record<string, string>> = \{([\s\S]*?)\n\};/)[1];
const renames = {};
for (const m of renameBlock.matchAll(/'([\w.]+)':\s*\{([\s\S]*?)\n\s*\},/g)) {
  const key = m[1];
  renames[key] = {};
  for (const c of m[2].matchAll(/(\w+):\s*'([^']+)'/g)) renames[key][c[1]] = c[2];
}

const conn = (dbName) =>
  knex({ client: 'mysql2', connection: { host: process.env.DB_HOST, port: +process.env.DB_PORT, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: dbName, dateStrings: true }, pool: { min: 0, max: 2 } });
const instances = new Map();
const K = (d) => { if (!instances.has(d)) instances.set(d, conn(d)); return instances.get(d); };

async function cols(dbName, table) {
  const [rows] = await K(dbName).raw(
    `select column_name as name, is_nullable as nullable, column_default as def, extra
       from information_schema.columns where table_schema=? and table_name=? order by ordinal_position`,
    [dbName, table],
  );
  return rows || [];
}

const COMMON = process.env.DB_NAME_COMMON || 'sms_common';
console.log('===== A. 切读会炸的列（统一表 NOT NULL 无默认 + 老表没有）=====\n');
const A = [];
const B = [];
for (const [key, uni] of pairs) {
  const [dbName, table] = key.split('.');
  const o = await cols(dbName, table);
  const u = await cols(COMMON, uni);
  if (!o.length || !u.length) continue;
  const os = new Set(o.map((c) => c.name));
  const bad = u.filter((c) => !os.has(c.name) && c.nullable === 'NO' && c.def === null && !/auto_increment/i.test(c.extra || ''));
  const onlyOld = o.filter((c) => !new Set(u.map((x) => x.name)).has(c.name));
  if (bad.length) A.push({ key, uni, bad: bad.map((c) => c.name) });
  if (onlyOld.length) B.push({ key, uni, onlyOld: onlyOld.map((c) => c.name) });
}
for (const r of A) console.log(`  ${r.key} → ${r.uni}\n      ${r.bad.join(', ')}`);
if (!A.length) console.log('  （无）');

console.log('\n===== B. 老表独有列（切读时读写都会 Unknown column）=====\n');
for (const r of B) {
  const reg = renames[r.key] || {};
  const mapped = r.onlyOld.map((c) => (reg[c] ? `${c}→${reg[c]}` : `${c}(未登记)`));
  console.log(`  ${r.key} → ${r.uni}\n      ${mapped.join(', ')}`);
}
if (!B.length) console.log('  （无）');

await Promise.all([...instances.values()].map((k) => k.destroy()));
process.exit(0);
