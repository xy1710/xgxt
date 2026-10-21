/**
 * 回归守卫：「职位详情」弹窗底栏 —— 只许有「关闭」，「编辑权限」不许回来
 * ============================================================================
 *
 * 【口径变更史】
 *   2026-10-20 第一版（本脚本初版）：用户要求把「关闭」「编辑权限」互换位置，
 *     当时钉的是顺序「编辑权限 → 关闭」。
 *   2026-10-20 第二版（本版）：用户接着要求**把「编辑权限」删掉**。
 *     于是顺序问题不存在了，口径改成「按钮不许存在」。
 *     —— 这与第八轮「账号详情 · 去编辑按钮」是同一个演进路径：
 *     先调位置、再删掉。脚本必须跟着改口径，否则钉的是已废弃的事实。
 *
 * 【为什么删得掉】
 *   本弹窗的定位是「职位详情 = 只读查看」，改权限应由「职位权限分配」页承担
 *   （那边有 全选 / 一键清空 / 保存权限 的完整编辑 UI）。
 *   删掉按钮后，权限树的「编辑模式」失去唯一入口 → 编辑模式链路整体删除：
 *     · openPermTreeFromDetail()
 *     · saveRolePerms() / doSaveRolePerms()（含 assignApi.save 调用）
 *     · TreeMode 里的 'edit'
 *     · treeTargetId / treeUserCount 两个只为编辑模式服务的状态
 *   本脚本第二节专门守这些死代码不许回流。
 *
 *   仍然保留的：列表「24 项」→ openPermTree(row) → 只读权限树（底栏只有「关闭」）。
 *
 * 跑法：cd server-job && node scripts/_test-role-detail-footer-order.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const P = (rel) => join(REPO, rel);
const read = (p) => readFileSync(p, 'utf8');
const count = (s, sub) => s.split(sub).length - 1;

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

const ROLE = P('web-job/src/perm/views/RoleManage.vue');
const RAW = read(ROLE);
const CODE = stripComments(RAW);
const CSS = read(P('web-job/src/shared-ui/shared-ui.css'));

/* ============================================================
 * 一、详情弹窗底栏：只剩「关闭」
 * ============================================================ */
/* 锚点用 v-model 而不是标题文字：
   「职位详情」这个词在 script 注释 / toast 里也出现，按文字切会切成 script 段。 */
const iDetail = CODE.indexOf('v-model="detailOpen"');
const iNext = CODE.indexOf('v-model="usersOpen"', iDetail);
const detailBlock = iDetail > 0 && iNext > iDetail ? CODE.slice(iDetail, iNext) : '';

check('定位到「职位详情」弹窗区块', detailBlock.length > 200, `${detailBlock.length} 字符`);

const footIdx = detailBlock.indexOf('职位 ID：');
const detailFoot = footIdx > 0 ? detailBlock.slice(footIdx, footIdx + 600) : '';

check('能取到详情弹窗底栏片段', detailFoot.length > 50, `${detailFoot.length} 字符`);

check(
  '★ 底栏只有 1 个按钮',
  count(detailFoot, '<button') === 1,
  `实测 ${count(detailFoot, '<button')} 个`,
);

check(
  '★ 那个按钮是「关闭」',
  /@click="detailOpen = false">关闭<\/button>/.test(detailFoot),
);

check(
  '★ 底栏没有「编辑权限」按钮（用户 2026-10-20 要求删除）',
  !detailFoot.includes('编辑权限'),
  `编辑权限 出现 ${count(detailFoot, '编辑权限')} 次`,
);

check(
  '底栏没有残留的主按钮（btn pri）—— 只剩一个普通「关闭」',
  !/class="btn pri"/.test(detailFoot),
);

check(
  '左侧「职位 ID」说明仍在（删除按钮没把这条挤掉）',
  /* detailFoot 从「职位 ID：」本身开始切，所以这里不能再要求前面有 <div class="lft"> */
  /职位 ID：\{\{ detail\?\.id/.test(detailFoot),
  detailFoot.replace(/\s+/g, ' ').slice(0, 70),
);

/* ============================================================
 * 二、删按钮后，编辑模式链路必须一起清（死代码不许回流）
 * ============================================================ */
check(
  'openPermTreeFromDetail() 已删除（按钮没了，它失去唯一调用方）',
  !/function openPermTreeFromDetail/.test(CODE),
);

check(
  'saveRolePerms() / doSaveRolePerms() 已删除（编辑模式保存链路）',
  !/function saveRolePerms/.test(CODE) && !/function doSaveRolePerms/.test(CODE),
);

check(
  "TreeMode 只剩 'view' | 'form'（'edit' 不可达）",
  /type TreeMode = 'view' \| 'form'/.test(CODE),
);

check(
  "没有任何 treeMode === 'edit' 的判断残留",
  !/treeMode === 'edit'/.test(CODE),
);

check(
  'treeTargetId / treeUserCount 两个只为编辑模式服务的状态已删',
  !/treeTargetId/.test(CODE) && !/treeUserCount/.test(CODE),
);

check(
  'assignApi 已从 import 移除（本页再无调用）',
  !/import \{[^}]*assignApi/.test(CODE) && !/assignApi\./.test(CODE),
);

/* ============================================================
 * 三、只读查看能力仍在（别删出死路）
 * ============================================================ */
check(
  '列表「N 项」仍能打开只读权限树（openPermTree(row)）',
  /@click="openPermTree\(r\)"/.test(CODE) && /async function openPermTree\(row/.test(CODE),
);

check(
  'openTreeWith 固定为只读模式（treeMode = view）',
  /function openTreeWith\(roleName: string, perms: RolePermMap\): void \{[\s\S]{0,200}treeMode\.value = 'view'/.test(
    CODE,
  ),
);

check(
  '权限树弹窗仍挂载',
  CODE.includes('v-model="treeOpen"'),
);

check(
  '表单「＋ 配置权限」链路没被误伤（treeMode = form 仍在）',
  /function openFormTree/.test(CODE) && /treeMode\.value = 'form'/.test(CODE) && /function applyFormPerm/.test(CODE),
);

/* ============================================================
 * 四、文案不许留死指引（点了会说"去点一个不存在的按钮"）
 * ============================================================ */
check(
  '「预置职位不可删」的提示已改口径：指向「职位权限分配」页，不再说"只能编辑权限"',
  !RAW.includes('只能编辑权限或停用') && /职位权限分配/.test(RAW),
);

/* ============================================================
 * 五、别误伤：其余弹窗仍是「关闭在左、主操作在右」
 * ============================================================ */
check(
  'CSS：.dlg-f 仍是 flex-end（按钮组贴右）',
  /\.dlg-f\{[^}]*justify-content:\s*flex-end/.test(CSS),
);

const footers = [...CODE.matchAll(/<template #footer>([\s\S]*?)<\/template>/g)].map((m) => m[1]);
check('本页弹窗底栏数量合理（≥5）', footers.length >= 5, `实测 ${footers.length} 个`);

let pairs = 0;
const badPairs = [];
for (const f of footers) {
  if (!f.includes('>关闭</button>')) continue;
  const iC = f.indexOf('>关闭</button>');
  const priIdx = f.indexOf('class="btn pri"');
  if (priIdx < 0) continue;
  pairs++;
  if (iC > priIdx) badPairs.push(f.replace(/\s+/g, ' ').slice(0, 70));
}

check(
  '其余「关闭 + 主操作」成对底栏仍是关闭在前（没被上一轮的互换带偏）',
  badPairs.length === 0,
  pairs ? `扫到 ${pairs} 个，异常 ${badPairs.length} 个` : '未扫到成对底栏',
);

console.log(lines.join('\n'));
console.log(`\n===== 结果：${pass}/${pass + fail} 通过 =====`);
if (fail) {
  lines.filter((l) => l.startsWith('  ❌')).forEach((l) => console.log('  失败：' + l.trim()));
  if (badPairs.length) badPairs.forEach((b) => console.log('  异常底栏：' + b));
  process.exit(1);
}
