/**
 * 全量自检 + 自动收尾
 * ============================================================
 * 用法：
 *   node scripts/_e2e-all.mjs                  # 跑全部套件，结束后清理夹具残留
 *   node scripts/_e2e-all.mjs --only=class,score
 *   node scripts/_e2e-all.mjs --keep-legacy    # 不自动 drop 临时老表
 *
 * 【为什么需要它】
 *   单个套件只清自己登记过的夹具，而且有些负面用例（"应该被拦"）会真的
 *   建出记录却没人登记 → 每跑一轮就往库里撒一点 E2E-* / 自检* 垃圾，
 *   最后污染「目标班级」这类下拉。
 *   → 统一用这个入口跑，结束自动调 `_demo-clean-e2e.mjs --apply` 收尾，
 *     库里始终保持干净（删前自动备份到 数据库备份/）。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = path.join(ROOT, 'scripts');

const ALL = [
  'attendance',
  'class',
  'class-exam',
  'class-four',
  'classapproval',
  'classconsult',
  'classdorm',
  'classgrade',
  'classinfo',
  'classjh-att-import',
  'classstudent',
  'dorm',
  'exam',
  'leave',
  'refund',
  'score',
  'student',
  'transfer',
];

const onlyArg = (process.argv.find((a) => a.startsWith('--only=')) || '').replace('--only=', '');
const only = onlyArg ? new Set(onlyArg.split(',').map((x) => x.trim())) : null;
const keepLegacy = process.argv.includes('--keep-legacy');
const suites = ALL.filter((s) => !only || only.has(s));

const run = (file, args = [], label = '') => {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, file), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (label) {
    const res = (out.match(/结果：\d+\/\d+ 通过/) || [])[0] || (r.status === 0 ? '完成' : '失败');
    console.log(`  ${label.padEnd(18)} ${res}`);
  }
  return { ok: r.status === 0, out };
};

if (!suites.length) {
  console.error('没有匹配的套件');
  process.exit(1);
}

/* ★ 先做「迁移守卫审计」：确认没有「老表已删→迁移跳过→统一表却缺列」的隐患
   （2026-10-21 的 class_no / pay_remark 就是这么漏的，运行期才炸） */
console.log(`== 0/3 迁移守卫审计 ==`);
{
  const audit = spawnSync(process.execPath, [path.join(SCRIPTS, '_audit-migration-guards.mjs')], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const out = `${audit.stdout || ''}${audit.stderr || ''}`.trim().split('\n');
  console.log(out.slice(0, 6).map((l) => '  ' + l).join('\n'));
  if (audit.status !== 0) {
    console.log('\n✗ 存在「跳过但统一表缺列」的迁移，先补统一表迁移再继续');
    process.exit(1);
  }
}

console.log(`\n== 1/3 准备临时老表（用例夹具要用）==`);
run('_uni-recreate-legacy.mjs');

console.log(`\n== 2/3 跑 ${suites.length} 个套件 ==`);
const failed = [];
for (const s of suites) {
  const file = `_e2e-${s}-check.mjs`;
  if (!fs.existsSync(path.join(SCRIPTS, file))) {
    console.log(`  ${s.padEnd(18)} (无此套件，跳过)`);
    continue;
  }
  const { ok } = run(file, [], s);
  if (!ok) failed.push(s);
}

if (!keepLegacy) {
  console.log(`\n== 3/3 收尾 ==`);
  run('_uni-recreate-legacy.mjs', ['--drop']);
} else {
  console.log('\n（--keep-legacy：保留临时老表）');
}

// 无论成败都清一次夹具残留（先备份再删）
const clean = spawnSync(process.execPath, [path.join(SCRIPTS, '_demo-clean-e2e.mjs'), '--apply'], {
  cwd: ROOT,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
const tail = `${clean.stdout || ''}`.trim().split('\n');
console.log(tail.slice(-3).join('\n'));

console.log(`\n===== 全部完成：${suites.length - failed.length}/${suites.length} 个套件通过 =====`);
if (failed.length) {
  console.log(`  失败：${failed.join(' / ')}`);
  process.exitCode = 1;
}
