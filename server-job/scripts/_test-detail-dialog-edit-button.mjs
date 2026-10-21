/**
 * 静态回归守卫：「账号详情」弹窗底部**不该再有「去编辑」按钮**
 *
 * 背景（2026-10-19，分三轮把按钮删干净）：
 *   该弹窗是共享组件 UserDetailDialog.vue，三处入口共用同一个底部按钮：
 *     · 账号管理（UserManage）—— 第一轮：列表行操作已有独立「编辑」→ 重复入口，关掉
 *     · 职位管理（RoleManage）—— 第二轮：一并关掉
 *     · 部门管理（DeptManage）—— 第三轮（本轮）：也要删掉
 *   第一、二轮用的是 `showEdit` 开关（默认 true，前两页传 false），
 *   因为当时部门管理还要显示。本轮三处全都不要了 → 开关成了死代码，
 *   连同 prop / emit / 三处 `:show-edit="false"` 绑定一起删掉，底部只剩「关闭」。
 *
 *   所以本脚本的口径也变了：不再是「开关存在且默认 true」，
 *   而是「按钮与开关都不许回来」。谁要是把按钮加回去、或者重新引入
 *   showEdit 开关，这里立刻报红。
 *
 * 纯静态断言，不起服务、不连库；退出码 0 = 全通过。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const P = (rel) => join(REPO, rel);

const DETAIL = P('web-job/src/perm/components/UserDetailDialog.vue');
const USERM = P('web-job/src/perm/views/UserManage.vue');
const ROLEM = P('web-job/src/perm/views/RoleManage.vue');
const DEPTM = P('web-job/src/perm/views/DeptManage.vue');

const read = (p) => readFileSync(p, 'utf8');
const count = (s, sub) => s.split(sub).length - 1;

/**
 * 去掉注释后的源码 —— 本项目的注释里大量「用反引号 / 引号举例提到
 * `:show-edit="false"`、`去编辑`」，直接数会误判；
 * 统计代码层出现次数前先剥掉 HTML 注释 / 块注释 / 行注释。
 */
function stripComments(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

/** 模板里某个按钮的文字（去空白）是否还挂着「去编辑」 */
function hasEditButton(src) {
  const code = stripComments(src);
  // 模板文字节点：> 去编辑 <（允许换行与缩进）
  return />\s*去编辑\s*</.test(code);
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

/* ============================================================
 * 一、共享组件：按钮本体没了，开关也一并删除
 * ============================================================ */
const detail = read(DETAIL);

check(
  '共享组件模板里已无「去编辑」按钮文字',
  !hasEditButton(detail),
  hasEditButton(detail) ? '仍能匹到 > 去编辑 <' : '只剩注释里的说明',
);

check(
  '组件不再声明 showEdit 可选 prop（三处都不要了，留着是死代码）',
  !/showEdit\?:\s*boolean;/.test(detail),
  `showEdit? 出现 ${count(detail, 'showEdit?:')} 次`,
);

check(
  'withDefaults 里不再有 showEdit 默认值',
  !/showEdit:\s*(true|false)/.test(detail),
  `defaults 片段：${(detail.match(/withDefaults\([\s\S]{0,400}?\)/) || [''])[0].replace(/\s+/g, ' ').slice(-80)}`,
);

check(
  '组件不再声明 edit 事件（没有按钮，事件无从触发）',
  !/\(\s*e:\s*'edit'/.test(detail) && !/emit\('edit'/.test(detail),
  `声明 ${count(detail, "(e: 'edit'")} 次 / 调用 ${count(detail, "emit('edit'")} 次`,
);

check(
  '模板里不再有 v-if="showEdit" 之类的开关',
  !/v-if="showEdit"/.test(detail) && !/v-if="props\.showEdit"/.test(detail),
);

check(
  '「关闭」按钮仍在且是 primary（底部只剩它）',
  /class="btn pri" type="button" @click="visible = false"/.test(detail),
);

/* ============================================================
 * 二、三处调用页：都不许再传 show-edit、不许绑 @edit
 * ============================================================ */
const pages = [
  ['账号管理', USERM],
  ['职位管理', ROLEM],
  ['部门管理', DEPTM],
];

for (const [name, file] of pages) {
  const raw = read(file);
  const code = stripComments(raw);

  check(
    `${name}：不再传 :show-edit（按钮已不存在，传了等于挂个无效 attr）`,
    !/:show-edit=/.test(code),
    `代码里 ${count(code, ':show-edit=')} 次（含注释共 ${count(raw, ':show-edit=')} 次）`,
  );

  check(
    `${name}：不再绑 @edit（没有 edit 事件，绑了是死代码）`,
    !/@edit=/.test(code),
    `@edit= 出现 ${count(code, '@edit=')} 次`,
  );

  check(
    `${name}：仍挂载着详情弹窗（没顺手连弹窗一起删了）`,
    count(raw, '<UserDetailDialog') === 1,
    `<UserDetailDialog 出现 ${count(raw, '<UserDetailDialog')} 次`,
  );
}

/* ============================================================
 * 三、删了按钮之后，各页是否还有改账号的入口（逐个确认，别删出死路）
 * ============================================================ */
const usermCode = stripComments(read(USERM));
const rolemCode = stripComments(read(ROLEM));
const deptmCode = stripComments(read(DEPTM));

check(
  '账号管理：列表行操作仍有独立「编辑」',
  /@click="openEdit\(u\)">编辑</.test(usermCode),
);

check(
  '账号管理：editFromDetail 函数体已删（注释里留说明不算）',
  !/function editFromDetail/.test(usermCode),
);

check(
  '部门管理：部门下账号弹窗行操作仍有「详情 | 编辑」',
  /@click="openUserDetail\(u\)">详情</.test(deptmCode) &&
    /@click="openUserEdit\(u\)">编辑</.test(deptmCode),
);

check(
  '部门管理：编辑不再跳账号管理（gotoUserEdit 已删除，改成就地弹窗）',
  !/gotoUserEdit/.test(deptmCode) && !/permUserEditRoute/.test(deptmCode),
  `gotoUserEdit 出现 ${count(deptmCode, 'gotoUserEdit')} 次`,
);

check(
  '职位管理：「职位下人员」仍能打开账号详情（只是没有行级编辑，要改得去账号管理）',
  /@click="openUserDetail\(u\)">账号详情</.test(rolemCode) &&
    /@click="removeRoleFromUser\(u\)">移出该职位</.test(rolemCode),
);

check(
  '职位管理：openUserEditById / permUserEditRoute 死代码已清掉',
  !/function openUserEditById/.test(rolemCode) && !/permUserEditRoute/.test(rolemCode),
);

/* ============================================================
 * 输出
 * ============================================================ */
console.log('\n===== 「账号详情 · 去编辑」按钮已删除 · 回归 =====\n');
for (const line of results) console.log(line);
console.log(`\n===== 结果：${pass}/${pass + fail} 通过 =====`);
process.exit(fail === 0 ? 0 : 1);
