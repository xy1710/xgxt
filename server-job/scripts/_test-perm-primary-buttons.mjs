/**
 * 静态回归守卫：权限管理三个页面的「主操作按钮」必须统一成品牌红
 * ============================================================
 *
 * 背景（2026-10-19）：
 *   用户给了两张截图对照 —— 部门管理的「＋ 新建部门」是白底按钮，
 *   而职位管理的「＋ 新建职位」是品牌红按钮，要求把前者改成一样。
 *   原因：部门管理那行写的是 `class="btn"`，另外两页写的是 `class="btn pri"`。
 *
 * 为什么值得单独钉一个脚本：
 *   这不是「改错值」，而是**同一套 UI 语言在三处各抄了一遍**——
 *   只要有人新建页面时抄了白底那版，或者「顺手清理」把 pri 去掉，
 *   观感不一致又回来了，而且肉眼不一定第一时间发现（截图里才看得出来）。
 *
 * 钉住的四件事：
 *   ① 三个主按钮：部门管理 / 职位管理 / 账号管理 → 一律 `class="btn pri"` + `@click="openAdd"`；
 *   ② 三处都不能再出现「白底 + ＋新建」的主按钮写法；
 *   ③ 弹窗里的次要按钮（取消 / 关闭）**保持白底**，别被一起刷红；
 *   ④ 样式表里 `.btn.pri` 仍是品牌红 #CD3A33（有人改配色表也不能把红改没）。
 *
 * 纯静态断言，不起服务、不连库、不写文件；退出码 0 = 全通过。
 * 跑法：cd server-job && node scripts/_test-perm-primary-buttons.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const P = (rel) => join(REPO, rel);
const read = (p) => readFileSync(p, 'utf8');
const count = (s, sub) => s.split(sub).length - 1;

/** 去掉注释后再统计 —— 本次改动自带的说明注释里也写了 `class="btn pri"`，不剥会误判 */
function stripComments(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

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

/* ============================================================
 * 一、三个主按钮必须一模一样（同一段标签文本）
 * ============================================================ */
const MAIN = [
  ['部门管理', 'web-job/src/perm/views/DeptManage.vue', '＋ 新建部门'],
  ['职位管理', 'web-job/src/perm/views/RoleManage.vue', '＋ 新建职位'],
  ['账号管理', 'web-job/src/perm/views/UserManage.vue', '＋ 新建账号'],
];

for (const [name, rel, label] of MAIN) {
  const code = stripComments(read(P(rel)));
  const wanted = `<button class="btn pri" type="button" @click="openAdd">${label}</button>`;
  check(
    `${name}「${label}」是品牌红主按钮（btn pri + openAdd）`,
    count(code, wanted) === 1,
    `命中 ${count(code, wanted)} 次`,
  );
  check(
    `${name}没有残留「白底 + ${label}」的旧写法`,
    count(code, `<button class="btn" type="button" @click="openAdd">${label}</button>`) === 0,
    `旧写法 ${count(code, `<button class="btn" type="button" @click="openAdd">${label}</button>`)} 处`,
  );
}

/* ============================================================
 * 二、次要按钮别被一起刷红（取消 / 关闭 仍是白底）
 * ============================================================ */
const deptCode = stripComments(read(P('web-job/src/perm/views/DeptManage.vue')));
check(
  '部门管理弹窗的「取消 / 关闭」仍是白底次要按钮',
  count(deptCode, 'class="btn" type="button" @click="formOpen = false"') === 1 &&
    count(deptCode, 'class="btn" type="button" @click="rolesOpen = false"') === 1 &&
    count(deptCode, 'class="btn" type="button" @click="usersOpen = false"') === 1,
  `取消 ${count(deptCode, 'class="btn" type="button" @click="formOpen = false"')} / ` +
    `关闭×2 ${count(deptCode, 'class="btn" type="button" @click="rolesOpen = false"')}` +
    `+${count(deptCode, 'class="btn" type="button" @click="usersOpen = false"')}`,
);

/* ============================================================
 * 三、样式表里的品牌红没被改掉
 * ============================================================ */
const css = read(P('web-job/src/shared-ui/shared-ui.css'));
check(
  '.btn.pri 底色 = 品牌红 #CD3A33',
  /\.btn\.pri\{background:#CD3A33;border-color:#CD3A33;color:#fff/.test(css),
);
check(
  '.btn.pri:hover 悬停色 = #B22A23（不是被改成的别的红）',
  /\.btn\.pri:hover\{background:#B22A23;border-color:#B22A23;color:#fff\}/.test(css),
);

/* ============================================================
 * 输出
 * ============================================================ */
console.log('\n===== 「权限管理 · 主按钮统一品牌红」回归 =====\n');
for (const l of lines) console.log(l);
console.log(`\n===== 结果：${pass}/${pass + fail} 通过 =====`);
process.exit(fail === 0 ? 0 : 1);
