/**
 * 回归守卫：项目经理 / 就业老师 的部门归属（都归「就业部」条线）
 * ============================================================================
 *
 * 背景（2026-10-20）：
 *   用户在「部门管理 → 就业部 → 查看职位」里只看到「就业老师」一个职位，
 *   同时框出「就业部 → 查看账号」里孙建龙的职位是「项目经理」，要求
 *   「项目经理和就业老师都归就业部」。
 *
 * 【改动】t_perm_role 里 R11 项目经理 的 dept_id：D_ALL（全部门）→ D_TRAIN（实训管理）。
 *   为什么落到实训管理而不是就业部直属：
 *     · 项目经理是实训条线角色，孙建龙的账号「具体部门」也正是实训管理，两者对齐；
 *     · 就业部的「查看职位」按「含下级」查，落到下级照样能看到，合计 2 个；
 *     · 挂 D_ALL 时「实训管理」职位数是 0，看起来像个空部门。
 *
 * 【本脚本钉住四件事】
 *   ① 接口：就业部（含下级）恰好两位 = 就业老师 + 项目经理；
 *   ② 接口：实训管理 / 就业管理 各自 1 位，且分别是项目经理 / 就业老师；
 *   ③ 口径：项目经理不再挂在「全部门」，且全系统职位总数仍是 14（没多没少）；
 *   ④ 源码：init SQL 种子同步改了（否则重建库又回到全部门，问题复现）。
 *
 * 跑法：cd server-job && node scripts/_test-role-dept-employment.mjs
 * 依赖：5173 + 8004 已启动。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { login, req } from './_e2e-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const P = (rel) => join(REPO, rel);
const read = (p) => readFileSync(p, 'utf8');

let pass = 0;
let fail = 0;
const lines = [];
const check = (label, cond, extra = '') => {
  if (cond) {
    pass++;
    lines.push(`  ✅ ${label}${extra ? '  —— ' + extra : ''}`);
  } else {
    fail++;
    lines.push(`  ❌ ${label}${extra ? '  —— ' + extra : ''}`);
  }
};

const B = 'http://127.0.0.1:5173';
const tok = await login('linx');
if (!tok) {
  console.error('登录失败（5173 / 8004 没起来？）');
  process.exit(1);
}
const h = { token: tok };

/** 某部门（含下级）下的职位名集合 */
async function rolesOf(deptId) {
  const r = await req(`${B}/api/perm/role/list?deptId=${deptId}&withChild=true&size=100`, h);
  const arr = r.json?.data?.list || r.json?.data?.records || r.json?.data || [];
  return (Array.isArray(arr) ? arr : []).map((x) => String(x.roleName));
}
const eqSet = (a, b) => a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');

/* ---- ① 就业部（含下级）= 就业老师 + 项目经理 ---- */
const emp = await rolesOf('D_EMP');
check(
  '就业部下（含 实训管理 / 就业管理）恰好 2 个职位：就业老师 + 项目经理',
  eqSet(emp, ['就业老师', '项目经理']),
  emp.join('、') || '空',
);

/* ---- ② 两个子部门各 1 位，且对得上 ---- */
const train = await rolesOf('D_TRAIN');
const job = await rolesOf('D_JOB');
check('实训管理 = 项目经理（原来是 0 个职位）', eqSet(train, ['项目经理']), train.join('、') || '空');
check('就业管理 = 就业老师', eqSet(job, ['就业老师']), job.join('、') || '空');

/* ---- ③ 项目经理不再挂「全部门」，总职位数不变 ---- */
const allExact = await req(`${B}/api/perm/role/list?deptId=D_ALL&withChild=false&size=100`, h);
const exactNames = (allExact.json?.data?.list || allExact.json?.data || []).map((x) => String(x.roleName));
check(
  '「全部门」直属职位里没有项目经理（只剩校长这类全校角色）',
  !exactNames.includes('项目经理'),
  `直属：${exactNames.join('、') || '空'}`,
);

const allRoles = await req(`${B}/api/perm/role/list?size=100`, h);
const total = (allRoles.json?.data?.list || allRoles.json?.data || []).length;
check('全系统职位总数仍是 14（没有多出/删掉职位）', total === 14, `实际 ${total}`);

/* ---- ④ 初始化 SQL 同步（重建库不会回退） ---- */
const sql = read(P('server-job/sql/init/sms_perm.sql'));
check(
  'init SQL 里 项目经理 的部门已改成 D_TRAIN',
  sql.includes("'项目经理','RM_PROJECT','D_TRAIN'"),
);
check(
  'init SQL 里不再有 项目经理 挂 D_ALL 的旧写法',
  !sql.includes("'项目经理','RM_PROJECT','D_ALL'"),
);

/* ---- 汇总 ---- */
console.log(lines.join('\n'));
console.log(`\n===== 结果：${pass}/${pass + fail} 通过 =====`);
if (fail) {
  lines.filter((l) => l.startsWith('  ❌')).forEach((l) => console.log('  失败：' + l.trim()));
  process.exit(1);
}
