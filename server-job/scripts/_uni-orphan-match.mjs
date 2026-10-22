/**
 * T2 辅助：给「孤儿统一表」自动匹配老表源表。
 *
 * 判据：老表的列集合与统一表的列集合重合度（Jaccard 近似）。
 * 输出每张孤儿统一表 Top3 候选老表 + 列差异，供人工确认后登记 UNI_MAP。
 *
 * 用法：node scripts/_uni-orphan-match.mjs
 */
import { readFileSync } from 'fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('dotenv').config({ path: path.join(process.cwd(), '.env') });
const knex = require('knex');

const src = readFileSync(path.join(process.cwd(), 'src/teaching/shared/uniTable.ts'), 'utf8');
const mappedUni = new Set([...src.matchAll(/'(t_uni_[a-z_]+)'/g)].map((m) => m[1]));

const DBS = {
  sms_job: process.env.DB_NAME || 'sms_job',
  sms_class: process.env.DB_NAME_CLASS || 'sms_class',
  sms_class_jh: process.env.DB_NAME_CLASS_JH || 'sms_class_jh',
  sms_common: process.env.DB_NAME_COMMON || 'sms_common',
  sms_edu: process.env.DB_NAME_EDU || 'sms_edu',
};

const conn = (d) =>
  knex({
    client: 'mysql2',
    connection: {
      host: process.env.DB_HOST,
      port: +process.env.DB_PORT,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: d,
    },
    pool: { min: 0, max: 2 },
  });

/** 取某库所有表的列 */
async function colsByTable(db) {
  const k = conn(db);
  const [rows] = await k.raw(
    `select table_name t, column_name c from information_schema.columns
      where table_schema=? order by table_name, ordinal_position`,
    [db],
  );
  await k.destroy();
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r.t)) m.set(r.t, new Set());
    m.get(r.t).add(String(r.c));
  }
  return m;
}

const all = new Map(); // "db.table" -> Set(cols)
for (const [alias, db] of Object.entries(DBS)) {
  const m = await colsByTable(db);
  for (const [t, cols] of m) all.set(`${alias}.${t}`, cols);
}

// 孤儿统一表
const orphans = [...all.keys()]
  .filter((k) => k.startsWith('sms_common.t_uni_') && !mappedUni.has(k.split('.')[1]))
  .map((k) => k.split('.')[1])
  .sort();

const IGNORE = new Set(['edu_stage', 'stage_code', 'id', 'is_deleted', 'create_time', 'create_by', 'update_time', 'update_by']);
const core = (cols) => [...cols].filter((c) => !IGNORE.has(c));

console.log(`孤儿统一表 ${orphans.length} 张，逐张列出最可能的老表源表：\n`);

for (const uni of orphans) {
  const uCols = all.get(`sms_common.${uni}`);
  const uCore = new Set(core(uCols));
  const cands = [];
  for (const [full, cols] of all) {
    if (full.includes('.t_uni_')) continue;
    const cCore = core(cols);
    if (!cCore.length) continue;
    const overlap = cCore.filter((c) => uCore.has(c)).length;
    const score = overlap / Math.max(cCore.length, 1);
    if (overlap >= 2) cands.push({ full, score, overlap, total: cCore.length, cols: cCore });
  }
  cands.sort((a, b) => b.overlap - a.overlap || b.score - a.score);

  console.log(`■ ${uni}  (${uCols.size} 列, 核心 ${uCore.size})`);
  if (!cands.length) console.log('   ⚠️ 无候选（可能老表已删，或列名差别过大）');
  for (const c of cands.slice(0, 3)) {
    const onlyOld = c.cols.filter((x) => !uCore.has(x));
    console.log(
      `   ${String(c.overlap).padStart(3)}/${String(c.cols.length).padEnd(3)} 重合  ${c.full.padEnd(42)} 仅老表有: ${onlyOld.length ? onlyOld.join(',') : '（无）'}`,
    );
  }
  console.log('');
}
process.exit(0);
