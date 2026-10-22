/**
 * P3/P4 工作量扫描：老路由里哪些「裸访问」能切读、哪些不能
 * ============================================================
 *
 * 用法：node scripts/_p3-legacy-scan.mjs            （默认扫 src/routes）
 *       node scripts/_p3-legacy-scan.mjs class-jh  （扫 src/class-jh/routes）
 *
 * 对每个文件输出：
 *   · 引用了哪些表，各自是否已在 UNI_MAP（**没登记 ⇒ tbl() 会静默回退老表**）
 *   · 裸访问形态计数：db('t_x') / trx(T.const) / db.raw / whereRaw / joinRaw
 *   · 跨库引用 db('库名.t_x')
 *   · 事务（db.transaction）与 trx( 出现次数
 *   · 原生 SQL 里出现的表名（这类最容易漏，因为 tbl() 换不掉字符串里的表名）
 *
 * 判定口径：
 *   ✅ 可切 = 表已在 UNI_MAP
 *   ⛔ 不可切 = 未登记（本阶段跳过，或需先补映射）
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const GROUP = process.argv[2] || '';
const DIR = GROUP === 'class-jh' ? 'src/class-jh/routes' : 'src/routes';

/* ---------- 读 UNI_MAP（唯一真源：uniTable.ts） ---------- */
const src = readFileSync(path.join(process.cwd(), 'src/teaching/shared/uniTable.ts'), 'utf8');
const body = src
  .match(/export const UNI_MAP: Record<string, string> = \{([\s\S]*?)\n\};/)[1]
  .split('\n')
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join('\n');
const UNI = new Map([...body.matchAll(/'([^']+)'\s*:\s*'([^']+)'/g)].map((m) => [m[1], m[2]]));

/** 也读「已登记但刻意不登记」的例外名单（注释里写了「刻意不登记」的表不算漏） */
const KNOWN_SKIP = new Set(['sms_class.t_class_transfer_all']);

const files = readdirSync(DIR)
  .filter((f) => f.endsWith('.ts'))
  .sort();

const rows = [];
const allMissing = new Map();
const allRawTables = new Map();

for (const f of files) {
  const text = readFileSync(path.join(DIR, f), 'utf8');
  const t = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  /* 表名常量：const XXX = 't_xxx'  */
  const consts = new Map();
  for (const m of t.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?=\s*'([^']+)'/g)) {
    consts.set(m[1], m[2]);
  }

  const tblRefs = new Set();
  let direct = 0;
  let viaConst = 0;

  /* db('t_x') / db('库.t_x') / trx(...) / conn(...) */
  for (const m of t.matchAll(/\b(?:db|trx|conn|knex)\s*\(\s*'([^']+)'\s*\)/g)) {
    tblRefs.add(m[1]);
    direct++;
  }
  /* db(TABLE) / trx(SCORE_TABLE) */
  for (const m of t.matchAll(/\b(?:db|trx|conn|knex)\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
    const v = consts.get(m[1]);
    if (v && /(^|\.)t_|^t_[a-z]/i.test(v)) {
      tblRefs.add(v);
      viaConst++;
    }
  }

  /* 原生 SQL / raw */
  const rawCalls = (t.match(/\.raw\s*\(/g) || []).length;
  const whereRaw = (t.match(/\.(?:whereRaw|orWhereRaw|havingRaw|joinRaw)\s*\(/g) || []).length;

  /* 原生 SQL 字符串里出现的表名（tbl() 无法替换，必须人工处理） */
  const rawTables = new Set();
  for (const m of t.matchAll(/(?:from|join|into|update|delete\s+from)\s+`?(?:([a-z_]+)\.)?`?(t_[a-z0-9_]+)/gi)) {
    const full = m[1] ? `${m[1]}.${m[2]}` : m[2];
    rawTables.add(full);
    allRawTables.set(full, (allRawTables.get(full) || 0) + 1);
  }

  const tx = (t.match(/db\.transaction|\.transaction\s*\(/g) || []).length;
  const trxCalls = (t.match(/\btrx\s*\(/g) || []).length;

  const resolvable = [];
  const missing = [];
  for (const r of tblRefs) {
    const full = r.includes('.') ? r : guessDb(r);
    const hit = UNI.has(full) || UNI.has(r);
    (hit ? resolvable : missing).push(r);
    if (!hit && !KNOWN_SKIP.has(full)) allMissing.set(full, (allMissing.get(full) || 0) + 1);
  }

  rows.push({
    file: f,
    tbls: tblRefs.size,
    direct,
    viaConst,
    ok: resolvable.length,
    miss: missing,
    rawCalls,
    whereRaw,
    tx,
    trxCalls,
    rawTables: [...rawTables],
  });
}

/**
 * 裸表名（`t_job_exam`）没有库名前缀 —— 按老路由的惯例猜库：
 *   /api/job/* 走 sms_job；/api/edu/* 走 sms_edu；class-jh 走 sms_class_jh
 * 这里只是**启发式**，用于快速判断「是否登记」，不确定的会一并列出。
 */
function guessDb(t) {
  if (DIR.includes('class-jh')) return `sms_class_jh.${t}`;
  return `sms_job.${t}`;
}

console.log(`########## ${DIR} 扫描（共 ${rows.length} 个文件）##########\n`);
console.log(
  ['文件'.padEnd(26), '表', '直呼', '常量', '可切', 'raw', 'whereRaw', 'tx', 'trx'].join('  '),
);
for (const r of rows.sort((a, b) => b.direct + b.viaConst - (a.direct + a.viaConst))) {
  console.log(
    [
      r.file.padEnd(26),
      String(r.tbls).padStart(3),
      String(r.direct).padStart(3),
      String(r.viaConst).padStart(3),
      String(r.ok).padStart(3),
      String(r.rawCalls).padStart(3),
      String(r.whereRaw).padStart(8),
      String(r.tx).padStart(2),
      String(r.trxCalls).padStart(3),
    ].join('  '),
  );
}

console.log('\n########## 未登记（tbl() 会静默回退老表）##########\n');
let anyMiss = false;
for (const r of rows.filter((x) => x.miss.length)) {
  console.log(`  ${r.file}  →  ${r.miss.join(', ')}`);
  anyMiss = true;
}
if (!anyMiss) console.log('  （无）');

console.log('\n########## 原生 SQL 字符串里的表名（tbl() 换不掉，必须人工改）##########\n');
for (const r of rows.filter((x) => x.rawTables.length)) {
  console.log(`  ${r.file}  →  ${r.rawTables.join(', ')}`);
}

console.log('\n########## 全组汇总：未登记表的引用次数 ##########\n');
for (const [k, v] of [...allMissing.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(3)} 次  ${k}`);
}

console.log('\n########## 全组汇总：原生 SQL 里出现的表（按次数）##########\n');
for (const [k, v] of [...allRawTables.entries()].sort((a, b) => b[1] - a[1])) {
  const known = UNI.has(k) || UNI.has(`sms_job.${k}`) || UNI.has(`sms_class.${k}`) || UNI.has(`sms_class_jh.${k}`);
  console.log(`  ${String(v).padStart(3)} 次  ${k}${known ? '  【已登记】' : ''}`);
}
