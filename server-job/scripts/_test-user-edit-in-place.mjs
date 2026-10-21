/**
 * 静态回归守卫：账号「就地编辑」
 *
 * 背景（2026-10-20，用户要求）：
 *   「部门管理 → 查看账号 → 编辑」原先 router.push('/user?edit=<id>')
 *   跳到账号管理页再打开表单。用户原话：「跳转到账号管理进行修改很别扭」。
 *   改法：把编辑抽成共享组件 UserEditDialog.vue，两个页面共用同一份表单，
 *   就地弹、就地存，保存后各自刷新自己的列表。
 *
 * 这个脚本钉住四件事：
 *   ① 共享组件存在，字段 / 校验 / 保存接口与账号管理同口径；
 *   ② 保存时【不传 modules】—— 后端「modules 不传 = 不动门户模块配置」，
 *      编辑基础信息不该顺手改写门户可访问模块（这条最容易被人「补全」掉）；
 *   ③ 部门管理不再有任何跳转（useRouter / permUserEditRoute / gotoUserEdit 全清）；
 *   ④ 账号管理的新建账号表单没被误伤（新建仍在本页、仍有密码与职位区）。
 *
 * 纯静态断言，不起服务、不连库；退出码 0 = 全通过。
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const P = (rel) => join(REPO, rel);

const EDIT = P('web-job/src/perm/components/UserEditDialog.vue');
const USERM = P('web-job/src/perm/views/UserManage.vue');
const DEPTM = P('web-job/src/perm/views/DeptManage.vue');

const read = (p) => readFileSync(p, 'utf8');
const count = (s, sub) => s.split(sub).length - 1;

/** 剥掉注释再统计代码层出现次数（本项目注释里大量举例提到组件名/字段名） */
function stripComments(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

let pass = 0;
let fail = 0;
const results = [];
const ok = (l, e = '') => (pass++, results.push(`  ✅ ${l}${e ? '  —— ' + e : ''}`));
const bad = (l, e = '') => (fail++, results.push(`  ❌ ${l}${e ? '  —— ' + e : ''}`));
const check = (l, c, e = '') => (c ? ok(l, e) : bad(l, e));

/* ============================================================
 * 一、共享组件：存在性 + 契约
 * ============================================================ */
check('共享组件 UserEditDialog.vue 存在', existsSync(EDIT), EDIT);

const edit = read(EDIT);
const editCode = stripComments(edit);

check(
  '组件声明 modelValue / userId / fallback 三个 prop',
  /modelValue:\s*boolean;/.test(editCode) &&
    /userId:\s*string;/.test(editCode) &&
    /fallback\?:/.test(editCode),
);

check(
  '组件对外只发 saved 事件（调用方据此刷新列表）',
  /\(e:\s*'saved'\)/.test(editCode),
);

/* ---- 字段：图二的「基本信息」六项 ---- */
for (const label of ['姓名', '性别', '年龄', '手机号', '登录账号', '账号状态']) {
  check(`表单含「${label}」字段`, new RegExp(`<label>${label}`).test(editCode));
}

check(
  '六个字段都标了必填红星',
  count(editCode, '<span class="req">*</span>') >= 6,
  `req 标记 ${count(editCode, '<span class="req">*</span>')} 处`,
);

check(
  '底部三个按钮：取消 / 存草稿 / 保存修改',
  count(editCode, '>取消<') >= 1 &&
    count(editCode, '存草稿') >= 1 &&
    count(editCode, '保存修改') >= 1,
);

/* ---- 校验：与账号管理同口径 ---- */
check('校验：姓名只允许汉字且≥2', /\^\[\\u4e00-\\u9fa5\]\{2,\}\$/.test(editCode));
check('校验：年龄 20-65', /form\.age\s*<\s*20\s*\|\|\s*form\.age\s*>\s*65/.test(editCode));
check('校验：手机号 11 位 1 开头', /\^1\[3-9\]\\d\{9\}\$/.test(editCode));
check('校验：登录账号 4-20 位字母数字', /\^\[A-Za-z0-9\]\{4,20\}\$/.test(editCode));

/* ---- 保存：走同一个 update 接口，且刻意不传 modules ---- */
check('保存调用 userApi.update', /await userApi\.update\(/.test(editCode));
check(
  '保存时把 deptId / roleIds 原样带回（否则会被清空）',
  /deptId:\s*form\.deptId/.test(editCode) && /roleIds:\s*\[\.\.\.form\.roleIds\]/.test(editCode),
);
check(
  '★ 保存时不传 modules —— 编辑基础信息不该改门户可访问模块',
  !/^\s*modules:/m.test(editCode),
  `代码里 modules: 赋值 ${(editCode.match(/^\s*modules:/gm) || []).length} 处`,
);
check(
  '保存前有二次确认（与账号管理同一个问法）',
  /确认保存对/.test(editCode) && /确认保存/.test(editCode),
);

/* ============================================================
 * 二、部门管理：彻底不跳转
 * ============================================================ */
const deptm = read(DEPTM);
const deptmCode = stripComments(deptm);

check('部门管理引用了共享组件', /import UserEditDialog from/.test(deptmCode));
check(
  '部门管理挂载了编辑弹窗（带 @saved）',
  /<UserEditDialog/.test(deptmCode) && /@saved="onUserEdited"/.test(deptmCode),
);
check(
  '行内「编辑」打开就地弹窗（openUserEdit）',
  /@click="openUserEdit\(u\)">编辑</.test(deptmCode),
);

check(
  '★ 部门管理不再 import useRouter（本轮把跳转彻底摘掉）',
  !/from 'vue-router'/.test(deptmCode),
);
check('部门管理不再用 permUserEditRoute', !/permUserEditRoute/.test(deptmCode));
check('部门管理不再有 gotoUserEdit', !/gotoUserEdit/.test(deptmCode));
check(
  '部门管理没有任何 router.push 跳转',
  !/router\.push/.test(deptmCode),
  `router.push ${count(deptmCode, 'router.push')} 次`,
);

check(
  '保存后刷新「部门下账号」表 + 部门树/KPI',
  /reloadDeptUsers\(\)/.test(deptmCode) && /await loadAll\(\)/.test(deptmCode),
);
check(
  '刷新用的是当前部门的 id（不写死某个部门）',
  /usersDeptId\.value\s*=\s*node\.id/.test(deptmCode) &&
    /deptId:\s*usersDeptId\.value/.test(deptmCode),
);

/* ============================================================
 * 三、账号管理：编辑走共享组件，新建仍在本页
 * ============================================================ */
const userm = read(USERM);
const usermCode = stripComments(userm);

check('账号管理引用了共享组件', /import UserEditDialog from/.test(usermCode));
check(
  '账号管理挂载了编辑弹窗（带 @saved）',
  /<UserEditDialog/.test(usermCode) && /@saved="onUserEdited"/.test(usermCode),
);
check(
  '账号管理的 openEdit 改成开弹窗（不再往内联表单里塞 formMode = edit）',
  /function openEdit\(row: PermUserListItem\)/.test(usermCode) &&
    !/formMode\.value\s*=\s*'edit'/.test(usermCode),
  `formMode='edit' 赋值 ${count(usermCode, "formMode.value = 'edit'")} 次`,
);

check(
  '★ 新建账号表单没被误伤：formOpen 仍在、仍有密码与职位区',
  /v-model="formOpen"/.test(usermCode) &&
    // 密码框是动态 type（显示/隐藏切换）：:type="showPwd ? 'text' : 'password'"
    /v-model="form\.password"/.test(usermCode) &&
    /showPwd/.test(usermCode) &&
    /所属部门/.test(usermCode) &&
    /所属职位/.test(usermCode),
);
check(
  '新建入口仍调 openAdd（formMode 只剩 add）',
  /function openAdd\(\)/.test(usermCode) && /formMode\.value\s*=\s*'add'/.test(usermCode),
);
check(
  '账号管理保存后刷新列表与 KPI',
  /function onUserEdited/.test(usermCode) && /loadOverview\(\)/.test(usermCode),
);
check(
  '深链接 /user?edit=<id> 仍能打开编辑（改调同一个 openEdit）',
  /route\.query\.edit/.test(usermCode) && /openEdit\(\{ \.\.\.d \}/.test(usermCode),
);

/* ============================================================
 * 输出
 * ============================================================ */
console.log('\n===== 账号「就地编辑」回归 =====\n');
for (const line of results) console.log(line);
console.log(`\n===== 结果：${pass}/${pass + fail} 通过 =====`);
process.exit(fail === 0 ? 0 : 1);
