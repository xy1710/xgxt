/**
 * 静态回归守卫：「职位权限分配」页的「查看账号（N）」入口**不该再回来**
 *
 * 背景（2026-10-20）：
 *   该页工具条原来有三个按钮：＋ 配置权限 / 从其他职位复制 / 查看账号（2）。
 *   用户框出第三个要求删除。理由与本轮删「＋ 新增权限」一致：
 *   本页是「配置某个职位的权限」，而「这个职位下有哪些账号」属于
 *   部门管理 / 账号管理的职责，夹在配置按钮旁边容易被误点。
 *
 *   删入口后看账号弹窗就没有任何调用方了，所以一并清掉：
 *     · 模板里的 <ProtoDialog v-model="usersOpen"> 整块
 *     · 状态 usersOpen / usersLoading / roleUsers / usersTitle
 *     · 函数 openRoleUsers()
 *     · import 里的 userApi、类型 PermUserListItem
 *   —— 只删按钮、留着这堆东西就是死代码；但「关联账号 N 人」这行信息必须留，
 *   它是职位概览的一部分，不依赖弹窗。
 *
 *   同时守卫：部门管理页的「查看账号」**不许被误伤**（那是另一处入口，用户没要求删）。
 *
 * 纯静态断言，不起服务、不连库；退出码 0 = 全通过。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const P = (rel) => join(REPO, rel);

const ASSIGN = P('web-job/src/perm/views/PermAssign.vue');
const DEPTM = P('web-job/src/perm/views/DeptManage.vue');
const API = P('web-job/src/perm/api/perm.ts');

const read = (p) => readFileSync(p, 'utf8');
const count = (s, sub) => s.split(sub).length - 1;

/** 剥掉 HTML 注释 / 块注释 / 行注释 —— 本文件注释里大量提到「查看账号」，不剥必误判 */
function stripComments(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

let pass = 0;
let fail = 0;
const results = [];

function ok(label, extra = '') {
  pass++;
  results.push(`  ✅ ${label}${extra ? '  —— ' + extra : ''}`);
}
function bad(label, extra = '') {
  fail++;
  results.push(`  ❌ ${label}${extra ? '  —— ' + extra : ''}`);
}
function check(label, cond, extra = '') {
  if (cond) ok(label, extra);
  else bad(label, extra);
}

const raw = read(ASSIGN);
const code = stripComments(raw);

/* ============================================================
 * 一、入口按钮没了
 * ============================================================ */
check(
  '模板里已无「查看账号」按钮文字（剥注释后 0 处）',
  count(code, '查看账号') === 0,
  `实测 ${count(code, '查看账号')} 处（含注释共 ${count(raw, '查看账号')} 处）`,
);

check(
  '工具条里不再绑 @click="openRoleUsers"',
  !/openRoleUsers/.test(code),
  `代码层 ${count(code, 'openRoleUsers')} 次`,
);

check(
  '工具条的按钮只剩 2 个（＋ 配置权限 / 从其他职位复制）',
  count(code, '<button class="btn xs" type="button"') === 2,
  `实测 ${count(code, '<button class="btn xs" type="button"')} 个`,
);

check(
  '「＋ 配置权限」仍在（删按钮没删错行）',
  /@click="openTree\('edit'\)">＋ 配置权限/.test(code),
);

check(
  '「从其他职位复制」仍在（删按钮没删错行）',
  /@click="openCopy">从其他职位复制/.test(code),
);

/* ============================================================
 * 二、弹窗与死代码一并清掉
 * ============================================================ */
check(
  '看账号弹窗已删（不再有 :title="usersTitle" 的 ProtoDialog）',
  !/:title="usersTitle"/.test(code),
  `usersTitle 引用 ${count(code, 'usersTitle')} 次`,
);

check(
  '状态 usersOpen / usersLoading 已删',
  !/usersOpen/.test(code) && !/usersLoading/.test(code),
  `usersOpen ${count(code, 'usersOpen')} 次 / usersLoading ${count(code, 'usersLoading')} 次`,
);

check(
  'roleUsers 已删（弹窗内表格数据源）',
  !/roleUsers/.test(code),
  `roleUsers ${count(code, 'roleUsers')} 次`,
);

check(
  '函数 openRoleUsers() 函数体已删',
  !/function openRoleUsers/.test(code) && !/async function openRoleUsers/.test(code),
);

check(
  'import 里不再引 userApi（本页已无账号查询）',
  !/userApi/.test(code),
  `userApi ${count(code, 'userApi')} 次`,
);

check(
  'import 里不再引 PermUserListItem 类型',
  !/PermUserListItem/.test(code),
);

check(
  'ProtoDialog 仍被复制弹窗 / 权限树使用（没顺手把组件 import 删掉）',
  /import ProtoDialog from/.test(code) && count(code, '<ProtoDialog') >= 2,
  `<ProtoDialog 出现 ${count(code, '<ProtoDialog')} 次`,
);

/* ============================================================
 * 三、删了入口，信息不能缺
 * ============================================================ */
check(
  '职位信息行仍显示「关联账号 N 人」（信息不依赖弹窗）',
  /关联账号 \{\{ userCount \}\} 人/.test(code),
);

check(
  'userCount 仍被保存/重置等确认框使用（没被误删）',
  count(code, 'userCount') >= 3,
  `userCount 出现 ${count(code, 'userCount')} 次`,
);

check(
  '「影响账号」仍在保存确认 / 复制确认 / 重置确认里',
  count(code, '影响账号') >= 3,
  `实测 ${count(code, '影响账号')} 处`,
);

/* ============================================================
 * 四、别误伤：部门管理的「查看账号」是另一处入口，用户没要求删
 * ============================================================ */
const deptCode = stripComments(read(DEPTM));

check(
  '部门管理页的「查看账号」入口仍在（本次只删职位权限分配页）',
  /@click="openDeptUsers\(d\)">查看账号/.test(deptCode),
);

check(
  '部门管理的 openDeptUsers / reloadDeptUsers 仍完整',
  /function openDeptUsers/.test(deptCode) && /function reloadDeptUsers/.test(deptCode),
);

/* ============================================================
 * 五、接口层不动：userApi 仍导出（别的页面还要用）
 * ============================================================ */
const apiSrc = read(API);
check(
  'api/perm.ts 里 userApi 仍完整导出（只是本页不用了，不是把能力删了）',
  /export const userApi/.test(apiSrc),
);

/* ============================================================
 * 输出
 * ============================================================ */
console.log('\n===== 「职位权限分配 · 查看账号」入口已删除 · 回归 =====\n');
for (const line of results) console.log(line);
console.log(`\n===== 结果：${pass}/${pass + fail} 通过 =====`);
process.exit(fail === 0 ? 0 : 1);
