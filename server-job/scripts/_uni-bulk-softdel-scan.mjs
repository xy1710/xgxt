/**
 * 「批量软删 + 重插」隐患扫描（T1 辅助）
 *
 * 目标模式：一条 update({is_deleted:1,...})，其 where 条件**不含主键 id**（即批量软删），
 *           且同一文件同表附近有 insert()。
 * → 这类写法在「统一表有唯一键、老表没有」的表上会撞唯一键（软删行仍占唯一键）。
 *
 * 用法：node scripts/_uni-bulk-softdel-scan.mjs
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'node:path';

const ROOTS = [
  'src/class/modules',
  'src/routes',
  'src/class-jh/routes',
  'src/teaching',
];

function walk(d, out = []) {
  let ents = [];
  try {
    ents = readdirSync(d);
  } catch {
    return out;
  }
  for (const f of ents) {
    const p = path.join(d, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (f.endsWith('.ts') && !f.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** 从某个位置起，向前取到该语句的起始（简单启发：取所在"语句块"若干行） */
function stmtWindow(lines, idx, back = 14) {
  return lines.slice(Math.max(0, idx - back), idx + 1).join('\n');
}

const hits = [];
for (const root of ROOTS) {
  for (const file of walk(root)) {
    const txt = readFileSync(file, 'utf8');
    const lines = txt.split('\n');
    lines.forEach((ln, i) => {
      if (!/is_deleted\s*:\s*(1|true)/.test(ln)) return;
      if (/^\s*(\/\/|\*|\/\*)/.test(ln)) return; // 注释
      const w = stmtWindow(lines, i);
      // 同一语句链里有没有主键限定
      const hasIdWhere = /\.where\s*\(\s*\{\s*id\s*:/.test(w) || /whereIn\s*\(\s*'id'/.test(w);
      // 有没有别的业务键限定（说明是条件软删，不是全量）
      const hasBizWhere = /\.where\s*\(/.test(w) || /whereNotIn/.test(w) || /whereIn/.test(w);
      // 同文件是否有 insert（粗略）
      const fileHasInsert = /\.insert\s*\(|tblIns\w*\s*\(/.test(txt);
      hits.push({ file, line: i + 1, hasIdWhere, hasBizWhere, fileHasInsert, txt: ln.trim().slice(0, 100) });
    });
  }
}

const bulkNoId = hits.filter((h) => !h.hasIdWhere && h.hasBizWhere && h.fileHasInsert);
const byId = hits.filter((h) => h.hasIdWhere);

console.log('===== 「批量软删（where 不含 id）+ 同文件有 insert」= 需人工核对的点 =====\n');
if (!bulkNoId.length) console.log('  （无）');
for (const h of bulkNoId) {
  console.log(`  ${h.file}:${h.line}`);
  console.log(`      ${h.txt}`);
}
console.log(`\n  小计 ${bulkNoId.length} 处\n`);

console.log('===== 按主键软删（安全）=====\n');
for (const h of byId) console.log(`  ${h.file}:${h.line}  ${h.txt}`);
console.log(`\n  小计 ${byId.length} 处`);

console.log('\n===== 全部 is_deleted=1 命中总数 =====');
console.log(`  ${hits.length} 处（含注释已排除）`);
