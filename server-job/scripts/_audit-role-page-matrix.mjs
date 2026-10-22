/**
 * 角色 × 页面 × 数据 全量矩阵（第 2 问）
 * ============================================================
 * 对 16 个演示账号，逐个登录后调「各模块的列表接口」，记录
 *   code（200/403/4xx/5xx）与数据行数，输出矩阵 + 异常清单。
 *
 * 判读基准：
 *   · 50001/50002/500 → ★ 运行期 bug（缺表/缺列/异常）
 *   · 403             → 无该页权限（是否合理看角色，报告里按岗位标注）
 *   · 200 / 0 行      → 对照校长（qiansy）的行数：校长>0 而该角色应看到 → 存疑
 *
 * 输出：数据库导出/审计-角色页面数据矩阵.md
 * 用法：node scripts/_audit-role-page-matrix.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE, killAll, login, req, startServices } from './_e2e-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '..', '数据库导出', '审计-角色页面数据矩阵.md');

const ACCOUNTS = [
  'admin', 'qiansy', 'congym', 'zhengym', 'wangjl', 'lilx', 'zhangls', 'sunjl',
  'zhanght', 'sunmin', 'chenxf', 'zhaomx', 'zhouj', 'liukj', 'zhoum', 'linx',
];

/* 端点清单：[模块, 名称, 路径] */
const STAGES4 = ['jh', 'class', 'job', 'emp'];
const E = [];
for (const [dom, label] of [
  ['student', '学生档案'], ['class', '班级管理'], ['attendance', '考勤'], ['exam', '考试'],
  ['score', '成绩'], ['dorm', '宿舍'], ['refund', '退费'], ['leave', '休学退学'],
]) {
  // ★ 2026-10-22 口径：学生档案三学段（jh/class/emp）；其余域 jh/class/job（emp 未开放）
  const stages = dom === 'student' ? ['jh', 'class', 'emp'] : STAGES4;
  for (const st of stages) E.push([`教学·${label}`, st, `/api/teaching/${dom}/list?stage=${st}&page=1&size=50`]);
}
const JOB = [
  // 花名册接口 classId 必传（按班查花名册），用现存的实训班探测
  ['/api/job/class-student/page?page=1&size=50&classId=CLS-JOB-SX2601', '实训花名册(SX2601)'],
  ['/api/job/employment-log/list?page=1&size=50', '就业日志'],
  ['/api/job/review/list?page=1&size=50', '复盘填写'],
  ['/api/job/fee-call/page?page=1&size=50', '催费通知'],
  ['/api/job/emp-dorm/list?page=1&size=50', '就业宿舍'],
];
for (const [p, label] of JOB) E.push(['就业模块', label, p]);
const CJH = [
  ['student', '学生'], ['classInfo', '班级'], ['attendance', '考勤'], ['exam', '考试'],
  ['examScore', '成绩'], ['dorm', '宿舍'], ['fee', '缴费'], ['refund', '退费'],
];
for (const [m, label] of CJH) E.push(['初高模块', label, `/api/class-jh/${m}/list?page=1&size=50`]);
E.push(['市场咨询', '咨询学员', '/api/consult/student/list?page=1&size=50']);
E.push(['财务模块', '费用账单', '/api/finance/fee/list?page=1&size=50']);
E.push(['财务模块', ' bill账单', '/api/finance/bill/list?page=1&size=50']);
E.push(['财务模块', '退费', '/api/finance/refund/list?page=1&size=50']);

await startServices();

const tokens = new Map();
for (const a of ACCOUNTS) {
  try {
    tokens.set(a, await login(a));
  } catch (e) {
    console.error(`✗ ${a} 登录失败：${e.message}`);
  }
}

const rowsOf = (j) => {
  if (!j?.data) return -1;
  if (Array.isArray(j.data)) return j.data.length;
  if (Array.isArray(j.data.list)) return j.data.list.length;
  if (typeof j.data.total === 'number') return j.data.total;
  return -1;
};

const matrix = new Map();
const issues = [];
const qiansyRef = new Map();

for (const [module, label, p] of E) {
  const key = `${module}｜${label}`;
  matrix.set(key, new Map());
  for (const a of ACCOUNTS) {
    const t = tokens.get(a);
    if (!t) {
      matrix.get(key).set(a, '未登录');
      continue;
    }
    const r = await req(`${BASE}${p}`, { token: t });
    const code = r.json?.code;
    let cell = String(code);
    if (code === 200) {
      const n = rowsOf(r.json);
      cell = String(n);
      if (a === 'qiansy') qiansyRef.set(key, n);
      if (String(r.status).startsWith('5')) cell = `HTTP${r.status}`;
    } else if (code === 50001 || code === 50002 || (r.status && String(r.status).startsWith('5'))) {
      cell = `★${code}`;
      issues.push(`★ 运行期错误 [${a}] ${key} → code=${code} ${r.json?.message || ''}`);
    }
    matrix.get(key).set(a, cell);
  }
}

/* ---------- 生成报告 ---------- */
const shortName = {
  admin: '管理员', qiansy: '校长', congym: '学管主任', zhengym: '教务', wangjl: '咨询经理',
  lilx: '咨询师①', zhangls: '咨询师②', sunjl: '项目经理', zhanght: '班主任①', sunmin: '班主任②',
  chenxf: '教员', zhaomx: '助教', zhouj: '就业老师', liukj: '会计', zhoum: '财务负责', linx: '权限管理',
};

const lines = [];
lines.push('# 角色 × 页面 × 数据 矩阵（2026-10-22 审计）');
lines.push('');
lines.push('> 数字 = 列表行数；403 = 无该页权限；★5xxxx = 运行期错误；`-` = 接口未返回行数（如 overview 类）');
lines.push('');
lines.push('| 模块 | 页面（学段） | ' + ACCOUNTS.map((a) => shortName[a] || a).join(' | ') + ' |');
lines.push('|---|---|' + ACCOUNTS.map(() => '---').join('|') + '|');
for (const [key, m] of matrix) {
  const [module, label] = key.split('｜');
  const cells = ACCOUNTS.map((a) => {
    const v = m.get(a) ?? '-';
    const ref = qiansyRef.get(key) ?? 0;
    // 校长有数据、该角色 0 行 → 标记待核（可能合理：范围过滤/没数据）
    if (v === '0' && ref > 0) return `0?`;
    return v;
  });
  lines.push(`| ${module} | ${label} | ${cells.join(' | ')} |`);
}
lines.push('');
lines.push('## 异常清单（★ = 需要修的）');
lines.push('');
lines.push(issues.length ? issues.map((x) => `- ${x}`).join('\n') : '- 无运行期错误');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, lines.join('\n'));
console.log(`矩阵已写入 ${OUT}`);
console.log(`端点 ${E.length} 个 × 账号 ${ACCOUNTS.length} 个 = ${E.length * ACCOUNTS.length} 次探测`);
console.log(`运行期错误 ${issues.length} 处`);

await killAll();
