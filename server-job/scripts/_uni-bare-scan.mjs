/**
 * 全仓「裸访问」盘点（P3/P4 收口判定用）
 * ============================================================
 *
 * 用法：node scripts/_uni-bare-scan.mjs
 *
 * 扫 `src/` 下**除 `src/teaching/`**（该目录早已零裸访问）以外的所有 .ts，
 * 统计每个文件里「直接操作表」的调用点，并判定该表是否已在 UNI_MAP：
 *
 *   runners  = 既可能是连接也可能是事务的通用 runner（db / trx / conn / trxOpt / client / k）
 *   形态     = runner('表'|常量)  ← 这是「裸访问」
 *
 * 输出：
 *   ① 逐文件：裸访问次数 / 已归一表数 / 未归一表数
 *   ② 仍未切读的「已归一表」清单（= P3/P4 剩下的活）
 *   ③ 未归一表清单（本阶段不该切，登记备查）
 *
 * ⚠️ 已知不漏检的能力边界（必须人工复核，脚本只做减负）：
 *   · `.join('t_x as a')` 里的表名（`join` 后紧跟 `(`，本文正则单独处理了）
 *   · 表名来自 import 的常量（如 `import { NOTICE_TABLE } from './notice'`）
 *   · 模板字符串拼出的表名
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/* ---------- UNI_MAP ---------- */
const src = readFileSync(path.join(process.cwd(), 'src/teaching/shared/uniTable.ts'), 'utf8');
const body = src
  .match(/export const UNI_MAP: Record<string, string> = \{([\s\S]*?)\n\};/)[1]
  .split('\n')
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join('\n');
const UNI = new Set([...body.matchAll(/'([^']+)'\s*:\s*'([^']+)'/g)].map((m) => m[1]));

/** 刻意不登记的（废弃表） */
const KNOWN_SKIP = new Set(['sms_class.t_class_transfer_all']);

const ROOT = path.join(process.cwd(), 'src');
const SKIP_DIRS = [path.join(ROOT, 'teaching')];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (SKIP_DIRS.some((d) => full.startsWith(d))) continue;
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const RUNNER = '(?:db|trx|conn|trxOpt|client|connOpt|k)';
const files = walk(ROOT);

const rows = [];
const stillBare = new Map(); // 已归一但还在裸访问：表 → {files:Set, count}
const unmapped = new Map(); // 未归一：表 → count
const byExtDb = new Map(); // 带库名的裸访问：库.表 → count

for (const f of files) {
  const rel = path.relative(process.cwd(), f).replace(/\\/g, '/');
  const text = readFileSync(f, 'utf8');
  // 去块注释/行注释（保留代码）
  const t = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  const consts = new Map();
  for (const m of t.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?=\s*'([^']+)'/g)) consts.set(m[1], m[2]);
  // import 进来的表名常量：无法解析库名，标记为「来自 import」
  const importedConsts = new Set();
  for (const m of t.matchAll(/import\s*\{([^}]+)\}\s*from\s*'([^']+)'/g)) {
    for (const part of m[1].split(',')) {
      const nm = part.trim().split(/\s+as\s+/).pop().trim();
      if (/TABLE|_T$|_T\b/.test(nm)) importedConsts.add(nm);
    }
  }

  let total = 0;
  const seen = new Set();

  const note = (rawTable, file) => {
    total++;
    const full = rawTable.includes('.') ? rawTable : null;
    if (full) {
      byExtDb.set(full, (byExtDb.get(full) || 0) + 1);
      if (UNI.has(full)) {
        if (!stillBare.has(full)) stillBare.set(full, { files: new Set(), count: 0 });
        const e = stillBare.get(full);
        e.files.add(rel);
        e.count++;
      } else if (!KNOWN_SKIP.has(full)) {
        unmapped.set(full, (unmapped.get(full) || 0) + 1);
      }
      seen.add(full);
      return;
    }
    // 裸表名：按所在目录猜库
    const guessed = guessDb(rel, rawTable);
    if (guessed && UNI.has(guessed)) {
      if (!stillBare.has(guessed)) stillBare.set(guessed, { files: new Set(), count: 0 });
      const e = stillBare.get(guessed);
      e.files.add(rel);
      e.count++;
      seen.add(guessed);
    } else if (guessed) {
      unmapped.set(guessed, (unmapped.get(guessed) || 0) + 1);
      seen.add(guessed);
    }
  };

  // runner('t_x') / runner('库.t_x')
  for (const m of t.matchAll(new RegExp(`\\b${RUNNER}\\s*\\(\\s*'([^']+)'\\s*\\)`, 'g'))) {
    if (/^t_[a-z0-9_]+$/.test(m[1]) || /^sms_[a-z_]+\.[a-z0-9_]+$/.test(m[1])) note(m[1], rel);
  }
  // runner(CONST)
  for (const m of t.matchAll(new RegExp(`\\b${RUNNER}\\s*\\(\\s*([A-Za-z_$][\\w$]*)\\s*\\)`, 'g'))) {
    const v = consts.get(m[1]);
    if (v && (/^t_[a-z0-9_]+$/.test(v) || /^sms_[a-z_]+\.[a-z0-9_]+$/.test(v))) note(v, rel);
    else if (importedConsts.has(m[1])) {
      total++;
      if (!unmapped.has(`<import:${rel}:${m[1]}>`)) unmapped.set(`<import:${rel}:${m[1]}>`, 0);
      unmapped.set(`<import:${rel}:${m[1]}>`, unmapped.get(`<import:${rel}:${m[1]}>`) + 1);
    }
  }
  // join / leftJoin / innerJoin 里的 't_x as a' 或 't_x'
  for (const m of t.matchAll(/\.(?:leftJoin|innerJoin|join|crossJoin)\s*\(\s*'([^']+)'/g)) {
    const parts = m[1].trim().split(/\s+/);
    const nm = parts[0];
    if (/^t_[a-z0-9_]+$/.test(nm) || /^sms_[a-z_]+\.[a-z0-9_]+$/.test(nm)) note(nm, rel);
  }

  rows.push({ rel, total, mapped: [...seen].filter((s) => UNI.has(s)).length, seen: [...seen] });
}

function guessDb(rel, table) {
  // ★ 2026-10-16（#22 改判取证）：按「模块目录 → 该模块 db() 实际连接的库」推断，
  //   不能一律猜 sms_job —— finance/perm/consult/portal 是独立子服务（app.ts:85-91「各连各的」），
  //   它们域内的同名表（如 t_student_base 影子表）不是已归一表，裸访问是正确行为。
  if (rel.includes('class-jh')) return `sms_class_jh.${table}`;
  if (rel.includes('/finance/')) return `sms_finance.${table}`;
  if (rel.includes('/perm/')) return `sms_perm.${table}`;
  if (rel.includes('/consult/')) return `sms_consult.${table}`;
  if (rel.includes('/portal/')) return `sms_portal.${table}`;
  if (rel.includes('/class/')) return `sms_class.${table}`;
  if (rel.includes('/teaching/')) return null; // 已跳过
  return `sms_job.${table}`;
}

console.log('########## 逐文件裸访问 ##########\n');
console.log('文件'.padEnd(46) + '裸访问  已归一表');
for (const r of rows.filter((x) => x.total).sort((a, b) => b.total - a.total)) {
  console.log(r.rel.padEnd(46) + String(r.total).padStart(5) + '  ' + String(r.mapped).padStart(6));
}

console.log('\n########## ★ 仍未切读的「已归一表」（P3/P4 剩下的活）##########\n');
if (!stillBare.size) console.log('  （无）—— 全仓已归一表都走了切读层');
for (const [k, v] of [...stillBare.entries()].sort((a, b) => b[1].count - a[1].count)) {
  console.log(`  ${String(v.count).padStart(3)} 次  ${k}`);
  console.log(`        出现在：${[...v.files].join(', ')}`);
}

console.log('\n########## 未归一的表（本阶段不该切，登记备查）##########\n');
for (const [k, v] of [...unmapped.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(3)} 次  ${k}`);
}

console.log('\n########## 带库名的裸访问（跨库）##########\n');
for (const [k, v] of [...byExtDb.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(3)} 次  ${k}`);
