/**
 * P8 终验编排：老表 DROP 后的「全量回归」
 * ============================================================
 * 流程：临时重建教学域老表（套件夹具按老表列写 + mirrorRow 镜像，原样工作）
 *       → 依次跑 17 个 _e2e-* 套件 → 清除临时老表 → 汇总。
 *
 * 跑法：node scripts/_uni-p8-final-verify.mjs
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const run = (args) => spawnSync(process.execPath, args, { stdio: 'inherit' });

const SUITES = [
  'refund',
  'leave',
  'classjh-att-import',
  'classapproval',
  'class',
  'classstudent',
  'classconsult',
  'classinfo',
  'classdorm',
  'class-exam',
  'class-four',
  'classgrade',
  'attendance',
  'dorm',
  'exam',
  'score',
  'student',
];

console.log('════ P8 终验 · 临时重建老表 ════');
if (run([path.join(__dirname, '_uni-recreate-legacy.mjs')]).status !== 0) {
  console.error('✗ 临时老表重建失败，中止');
  process.exit(1);
}

const results = [];
for (const s of SUITES) {
  console.log(`\n════ ${s} ════`);
  const r = run([path.join(__dirname, `_e2e-${s}-check.mjs`)]);
  results.push({ suite: s, ok: r.status === 0 });
}

console.log('\n════ 清除临时老表 ════');
run([path.join(__dirname, '_uni-recreate-legacy.mjs'), '--drop']);

console.log('\n════════ 终验汇总 ════════');
let bad = 0;
for (const r of results) {
  console.log(`  ${r.ok ? '✅' : '❌'} ${r.suite}`);
  if (!r.ok) bad += 1;
}
console.log(`\n结果：${results.length - bad}/${results.length} 套件通过`);
process.exit(bad ? 1 : 0);
