/**
 * 数据库覆盖审计（第 1、3 问）
 * ============================================================
 * 三方对齐：
 *   A. init SQL（一键启动会给新环境建的表）
 *   B. 本地实际库
 *   C. 代码里真正读写的表（tbl()/db()/UNI_MAP/CREATE TABLE）
 *
 * 输出：
 *   · 每个库：init SQL 有、实际库没有  → 新环境没问题，本机少了（少见）
 *   · 每个库：实际库有、init SQL 没有  → ★ 新环境会缺表（一键启动建不全）
 *   · 代码引用但两边都没有            → ★★ 运行期必炸
 *
 * 用法：node scripts/_audit-schema-coverage.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env') });

const conn = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

/* ---------- A. 解析 init SQL ---------- */
const INIT_DIR = path.join(ROOT, 'sql', 'init');
const initTables = new Map(); // schema → Set(table)
const addT = (schema, t) => {
  if (!initTables.has(schema)) initTables.set(schema, new Set());
  initTables.get(schema).add(t);
};
for (const f of fs.readdirSync(INIT_DIR).filter((x) => x.endsWith('.sql'))) {
  const src = fs.readFileSync(path.join(INIT_DIR, f), 'utf8');
  for (const m of src.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?`?(\w+)`?\./gi)) {
    addT(m[1].toLowerCase(), m[2]);
  }
  for (const m of src.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?`?(t_[a-z_0-9]+|knex_\w+)`?/gi)) {
    // 未带库名前缀的，按文件名映射
    const file = f.replace('.sql', '');
    const schema = { 'uni-tables': 'sms_common', 'legacy-teaching': 'sms_job' }[file] || file;
    addT(schema, m[1]);
  }
}
// legacy-teaching.sql 里 CREATE DATABASE 段落归属：解析每个 USE/DROP DATABASE 后的表
{
  const src = fs.readFileSync(path.join(INIT_DIR, 'legacy-teaching.sql'), 'utf8');
  let cur = null;
  for (const line of src.split('\n')) {
    const use = line.match(/^\s*USE\s+`?(\w+)`?/i) || line.match(/^\s*CREATE DATABASE[^(]*`?(\w+)`?/i);
    if (use) cur = use[1].toLowerCase();
    const t = line.match(/CREATE TABLE (?:IF NOT EXISTS )?`?(t_[a-z_0-9]+|knex_\w+)`?/i);
    if (t && cur) addT(cur, t[1]);
  }
}

/* ---------- B. 实际库 ---------- */
const SCHEMAS = ['sms_common', 'sms_job', 'sms_edu', 'sms_class', 'sms_class_jh', 'sms_consult', 'sms_finance', 'sms_perm', 'sms_portal'];
const actual = new Map();
for (const s of SCHEMAS) {
  const [rows] = await conn.query(
    'select table_name from information_schema.tables where table_schema=? and table_type="BASE TABLE"',
    [s],
  );
  actual.set(s, new Set(rows.map((r) => r.TABLE_NAME)));
}

/* ---------- C. 代码引用的表 ---------- */
const codeRefs = new Map(); // table → Set(file)
const walk = (d, out = []) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|mjs|js)$/.test(e.name)) out.push(p);
  }
  return out;
};
const SRC = path.join(ROOT, 'src');
for (const f of walk(SRC)) {
  const src = fs.readFileSync(f, 'utf8');
  const rel = path.relative(ROOT, f);
  // t_uni_* 直接引用
  for (const m of src.matchAll(/['"`](t_uni_[a-z_0-9]+)['"`]/g)) {
    if (!codeRefs.has(m[1])) codeRefs.set(m[1], new Set());
    codeRefs.get(m[1]).add(rel);
  }
  // tbl(db, 'sms_x', 't_yyy', ...) / db('t_yyy')
  for (const m of src.matchAll(/(?:tbl\w*\(\s*\w+\s*,\s*|db\(\s*)['"](sms_[a-z]+)['"]?\s*,?\s*['"`]?(t_[a-z_0-9]+)['"`]?/g)) {
    // 记录「库.表」组合
    const key = `${m[1]}::${m[2]}`;
    if (!codeRefs.has(key)) codeRefs.set(key, new Set());
    codeRefs.get(key).add(rel);
  }
}
// 迁移里的 CREATE TABLE（新环境靠它们建的表）
const migTables = new Map(); // schema → Set
for (const dir of fs.readdirSync(ROOT).filter((d) => d.startsWith('migrations'))) {
  const full = path.join(ROOT, dir);
  if (!fs.statSync(full).isDirectory()) continue;
  const schema = DB_OF_DIR(dir);
  for (const f of fs.readdirSync(full).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(full, f), 'utf8');
    for (const m of src.matchAll(/(?:createTable|createTableIfNotExists)\(\s*'?(t_[a-z_0-9]+)'?/g)) {
      if (!migTables.has(schema)) migTables.set(schema, new Set());
      migTables.get(schema).add(m[1]);
    }
  }
}
function DB_OF_DIR(dir) {
  return {
    migrations: 'sms_job',
    'migrations-edu': 'sms_edu',
    'migrations-class': 'sms_class',
    'migrations-class-common': 'sms_common',
    'migrations-class-jh': 'sms_class_jh',
  }[dir] || null;
}

/* ---------- 输出 ---------- */
console.log('='.repeat(70));
console.log('A) init SQL 覆盖的表 vs 实际库');
console.log('='.repeat(70));
for (const s of SCHEMAS) {
  const sqlT = initTables.get(s) || new Set();
  const dbT = actual.get(s) || new Set();
  const onlySql = [...sqlT].filter((t) => !dbT.has(t));
  const onlyDb = [...dbT].filter((t) => !sqlT.has(t) && t !== 'knex_migrations' && t !== 'knex_migrations_lock');
  if (onlySql.length || onlyDb.length) {
    console.log(`\n【${s}】init=${sqlT.size} 实际=${dbT.size}`);
    if (onlySql.length) console.log('  init 有、本机没有:', onlySql.join(', '));
    if (onlyDb.length) console.log('  ★ 本机有、init 没有（新环境会缺）:', onlyDb.join(', '));
  }
}

console.log('\n' + '='.repeat(70));
console.log('B) 代码引用的表：本机缺 / 新环境缺');
console.log('='.repeat(70));
let missingDb = 0;
let missingFresh = 0;
const tUni = [...codeRefs.keys()].filter((k) => !k.includes('::'));
const byPair = [...codeRefs.keys()].filter((k) => k.includes('::'));
for (const t of tUni) {
  const existsSomewhere = SCHEMAS.some((s) => (actual.get(s) || new Set()).has(t));
  if (!existsSomewhere) {
    console.log(`  ★★ 代码引用 ${t} —— 任何库都没有！文件: ${[...codeRefs.get(t)].slice(0, 2).join(', ')}`);
    missingDb++;
  }
}
for (const k of byPair) {
  const [db, t] = k.split('::');
  const inDb = (actual.get(db) || new Set()).has(t);
  if (!inDb) {
    const inSql = (initTables.get(db) || new Set()).has(t);
    const inMig = (migTables.get(db) || new Set()).has(t);
    if (!inSql && !inMig) {
      console.log(`  ★ ${db}.${t} 本机没有，init SQL / 迁移也不会建 —— ${[...codeRefs.get(k)].slice(0, 2).join(', ')}`);
      missingFresh++;
    }
  }
}
console.log(`\n小计：运行期缺表 ${missingDb}，新环境缺表（且无建表来源）${missingFresh}`);

console.log('\n' + '='.repeat(70));
console.log('C) t_uni_* 表：迁移会建但 init SQL 没有（新环境靠 migrate 补，核对列即可）');
console.log('='.repeat(70));
const uniInDb = [...(actual.get('sms_common') || new Set())].filter((t) => t.startsWith('t_uni_'));
const uniInSql = initTables.get('sms_common') || new Set();
const uniOnlyDb = uniInDb.filter((t) => !uniInSql.has(t));
const uniOnlySql = [...uniInSql].filter((t) => !uniInDb.includes(t));
console.log(`  本机 t_uni_* 共 ${uniInDb.length} 张；init SQL 有 ${uniInSql.size} 张`);
if (uniOnlySql.length) console.log('  init 有、本机没有:', uniOnlySql.join(', '));
if (uniOnlyDb.length) console.log('  ★ 本机有、init 没有（migrate 能否建出来需逐表核对）:', uniOnlyDb.join(', '));

await conn.end();
