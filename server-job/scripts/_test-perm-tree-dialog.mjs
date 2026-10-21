/**
 * 静态回归守卫：职位权限分配 · 「编辑权限」权限树弹窗的交互结构
 * ============================================================
 *
 * 背景（2026-10-20）：
 *   用户给了两张截图对照，一次提了三件事 ——
 *     ① 删掉模块标题左侧那个「整模块全选」方块（图一左边框住的），
 *        改成在右侧放「全选」文字（图一右边框住的位置）；
 *     ② 删掉弹窗底部的「＋ 新增权限」；
 *     ③ 底部有两个「取消」（一个取消勾选、一个关弹窗），只保留一个。
 *
 * 为什么值得钉一个脚本：
 *   这三处都是「少了一个方块 / 少了一个按钮」型改动 —— 视觉上没报错、
 *   功能上也还在，除非逐个按钮数，否则很难发现被后人加回来。
 *   特别是「取消」，两处文字一模一样，靠肉眼数根本数不准；
 *   而「模块全选」的能力如果连文字一起误删，权限就再也没法一键配满。
 *
 * 钉住的六组事实：
 *   一、模块行左侧方块彻底删除（含它的 onModChange 事件函数）
 *   二、右侧「全选 / 取消全选」文字存在、按状态切换、只读模式不渲染
 *   三、底栏只剩 4 个按钮且顺序固定（全选 / 一键清空 / 取消 / 保存权限）
 *   四、「取消」全弹窗只有 1 个（不再有取消勾选那个）
 *   五、「＋ 新增权限」在权限树底栏不再出现（页面另外两处入口保留）
 *   六、样式类 .mod-all 有定义（删样式会让文字挤成一团）
 *
 * 纯静态断言，不起服务、不连库、不写文件；退出码 0 = 全通过。
 * 跑法：cd server-job && node scripts/_test-perm-tree-dialog.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const P = (rel) => join(REPO, rel);
const read = (p) => readFileSync(p, 'utf8');
const count = (s, sub) => s.split(sub).length - 1;

/** 去掉注释后再断言 —— 本次改动自带的说明注释里写了 `setModAll` / 「取消」等字样，不剥会误判 */
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

const RAW_ASSIGN = read(P('web-job/src/perm/views/PermAssign.vue'));
const ASSIGN = stripComments(RAW_ASSIGN);
/* ★ 2026-10-20：权限树在本项目里是【两份独立实现】——
   职位权限分配页一套（PermAssign）、职位管理页一套（RoleManage）。
   上轮只改前者，用户从「职位管理 → 编辑权限」进来仍看到两个「取消」。
   所以这里两份都要读、都要守。 */
const RAW_ROLE = read(P('web-job/src/perm/views/RoleManage.vue'));
const ROLE = stripComments(RAW_ROLE);
const CSS = read(P('web-job/src/shared-ui/shared-ui.css'));

/* 权限树弹窗的整段模板：从 v-model="treeOpen" 到它自己的 </ProtoDialog>
   （该弹窗内部不嵌套别的 ProtoDialog，所以取第一个闭合标签即可） */
const treeStart = ASSIGN.indexOf('v-model="treeOpen"');
const treeEnd = ASSIGN.indexOf('</ProtoDialog>', treeStart);
const TREE = treeStart >= 0 && treeEnd > treeStart ? ASSIGN.slice(treeStart, treeEnd) : '';

/* 底栏片段：左下的「已勾选 N 项」到「保存权限」之间 */
const footStart = TREE.indexOf('已勾选');
const footEnd = TREE.indexOf('保存权限');
const FOOT = footStart >= 0 && footEnd > footStart ? TREE.slice(footStart, footEnd) : '';

/* ============================================================
 * 一、模块行左侧的方块必须彻底删除
 * ============================================================ */
check('能取到权限树弹窗模板片段', TREE.length > 500, `${TREE.length} 字符`);
check(
  '★ 模块行左侧的「整模块全选」方块已删除',
  !TREE.includes(':checked="modOn(mr)"'),
);
check(
  '配套的 onModChange（靠 checkbox 事件取 checked）已无残留',
  !ASSIGN.includes('onModChange'),
);
check(
  '只读模式的 roStyle 仍用于行级 / 子项方块（没被误删成孤儿）',
  count(TREE, ':style="roStyle"') === 2,
  `实测 ${count(TREE, ':style="roStyle"')} 处`,
);

/* ============================================================
 * 二、右侧「全选 / 取消全选」文字
 * ============================================================ */
check('模块行右侧挂了 .mod-all 文字元素', TREE.includes('class="mod-all"'));
check(
  '★ 文字按状态切换：未全选 =「全选」，已全选 =「取消全选」',
  TREE.includes("modOn(mr) ? '取消全选' : '全选'"),
);
check('点文字调 toggleModAll(mr)', TREE.includes('@click="toggleModAll(mr)"'));
check(
  '已全选时挂 .on 类（样式上转灰，提示再点即取消）',
  TREE.includes(':class="{ on: modOn(mr) }"'),
);
check(
  '只读模式（查看权限）不渲染这个文字 —— 点了也改不了，摆着会误导',
  /v-if="!treeView"\s*\n?\s*class="mod-all"/.test(TREE) ||
    /v-if="!treeView"[\s\S]{0,80}mod-all/.test(TREE),
);
check(
  'toggleModAll 的实现 = 按当前状态取反',
  /function toggleModAll\(mr: ModuleRow\): void \{\s*setModAll\(mr, !modOn\(mr\)\);/.test(ASSIGN),
);
check(
  'setModAll 收布尔值而非 Event（方块删了就没有 e.target.checked 了）',
  /function setModAll\(mr: ModuleRow, on: boolean\): void \{/.test(ASSIGN),
);
check(
  'setModAll 内部仍对「本行 + 全部子项」一起赋值（不丢子功能点）',
  ASSIGN.includes('next[row.key] = on ? codesOf(row.item) : [];') &&
    ASSIGN.includes('row.children.forEach((c) => (next[childKey(row, c)] = on ? codesOf(c) : []));'),
);

/* ============================================================
 * 三、底栏只有 4 个按钮，顺序固定
 * ============================================================ */
check('能取到弹窗底栏片段', FOOT.length > 100, `${FOOT.length} 字符`);
check(
  '★ 底栏按钮顺序 = 全选 → 一键清空 → 取消 → 保存权限',
  (() => {
    const i1 = FOOT.indexOf('treeSelectAll()');
    const i2 = FOOT.indexOf('treeClearAsk');
    const i3 = FOOT.indexOf('treeOpen = false');
    const i4 = FOOT.indexOf('treeSaveAsk');
    return i1 >= 0 && i1 < i2 && i2 < i3 && i3 < i4;
  })(),
);
check(
  '★ 底栏按钮总数 = 4（全选 / 一键清空 / 取消 / 保存权限）',
  count(FOOT, '<button') === 4,
  `实测 ${count(FOOT, '<button')} 个`,
);

/* ============================================================
 * 四、「取消」只保留一个
 * ============================================================ */
check(
  '★ 底栏「取消」按钮只有 1 个（原来一屏两个，分不清哪个是关弹窗）',
  count(FOOT, '>取消</button>') === 1,
  `实测 ${count(FOOT, '>取消</button>')} 个`,
);
check(
  '保留的那个「取消」是关闭弹窗（treeOpen = false），不是取消勾选',
  /@click="treeOpen = false">取消<\/button>/.test(FOOT),
);
check(
  '取消勾选那个入口（treeSelectAll(false)）已删除',
  !ASSIGN.includes('treeSelectAll(false)'),
);
check(
  'treeSelectAll 收敛成无参（只剩「全选」一种用法，不留死分支）',
  /function treeSelectAll\(\): void \{/.test(ASSIGN),
);
check(
  '清空能力没丢：一键清空仍在（带二次确认，比裸取消勾选安全）',
  FOOT.includes('treeClearAsk') && ASSIGN.includes('function treeClearAsk(): void'),
);

/* ============================================================
 * 五、「＋ 新增权限」从权限树底栏移除，但页面另外两处保留
 * ============================================================ */
check('★ 底栏不再有「＋ 新增权限」', !FOOT.includes('＋ 新增权限'));
check(
  '页面只剩 1 处「＋ 新增权限」入口（页头；工具条那处已按 2026-10-20 要求删除）',
  count(ASSIGN, 'itemAdminOpen = true') === 1,
  `实测 ${count(ASSIGN, 'itemAdminOpen = true')} 处`,
);
check(
  '权限点管理弹窗仍挂载（入口少了不等于功能删了）',
  ASSIGN.includes('<PermItemDialog v-model="itemAdminOpen"'),
);

/* ============================================================
 * 六、样式类
 * ============================================================ */
check(
  '样式表里有 .tree .n .mod-all 规则',
  /\.tree \.n \.mod-all\{/.test(CSS),
);
check(
  '.mod-all 悬停有反馈（否则看不出是可点的文字）',
  /\.tree \.n \.mod-all:hover\{/.test(CSS),
);
check(
  '.mod-all.on 用灰色（已全选 → 提示再点即取消）',
  /\.tree \.n \.mod-all\.on\{/.test(CSS),
);

/* ============================================================
 * 七、职位管理页那份权限树：与上一节同口径（用户 2026-10-20 反馈漏改）
 * ============================================================ */
const roleTreeStart = ROLE.indexOf('v-model="treeOpen"');
const roleTreeEnd = ROLE.indexOf('</ProtoDialog>', roleTreeStart);
const ROLE_TREE = roleTreeStart >= 0 && roleTreeEnd > roleTreeStart ? ROLE.slice(roleTreeStart, roleTreeEnd) : '';

check('职位管理页也能取到自己的权限树弹窗', ROLE_TREE.length > 500, `${ROLE_TREE.length} 字符`);

check(
  '★ RoleManage 只剩一个「关弹窗」按钮（treeOpen = false）',
  count(ROLE_TREE, '@click="treeOpen = false"') === 1,
  `treeOpen=false 按钮 ${count(ROLE_TREE, '@click="treeOpen = false"')} 个`,
);

/* 文案口径随编辑模式一起变了（2026-10-20 第三轮）：
   编辑模式删除后只剩两种 —— 表单模式「放弃」、只读模式「关闭」。 */
check(
  'RoleManage 关闭按钮文案只剩「放弃（表单模式）／关闭」',
  /\{\{\s*treeMode === 'form' \? '放弃' : '关闭'\s*\}\}/.test(ROLE_TREE) &&
    !ROLE_TREE.includes("'取消'"),
  `三元 = ${/\{\{\s*treeMode[^}]*\}\}/.exec(ROLE_TREE)?.[0].replace(/\s+/g, ' ') || '缺'}`,
);

/* ⚠️ 这条不能数字面「>取消</button>」：本页关闭按钮的文案是三元插值
   （form='放弃' / edit='取消' / view='关闭'），字面量根本数不到 —— 上一版就栽在这。 */
check(
  'RoleManage 底栏没有任何「取消全部勾选」类按钮（只剩关弹窗那个）',
  !/treeSelectAll\((true|false)\)/.test(ROLE_TREE),
  `带参调用 ${count(ROLE_TREE, 'treeSelectAll(true)') + count(ROLE_TREE, 'treeSelectAll(false)')} 处（应为 0）`,
);

check(
  'RoleManage 那个按钮确实是「关弹窗」（treeOpen = false），不是勾选操作',
  /@click="treeOpen = false"/.test(ROLE_TREE) &&
    count(ROLE_TREE, '@click="treeOpen = false"') === 1,
);

check(
  'RoleManage 取消勾选入口（treeSelectAll(false)）已删除',
  !ROLE.includes('treeSelectAll(false)'),
);

check(
  'RoleManage treeSelectAll 也收敛成无参',
  /function treeSelectAll\(\): void \{/.test(ROLE),
  /function treeSelectAll\(([^)]*)\)/.exec(ROLE)?.[1] === undefined
    ? ''
    : `签名参数 =「${/function treeSelectAll\(([^)]*)\)/.exec(ROLE)[1]}」`,
);

check(
  'RoleManage 底栏仍保留：全选 / 一键清空（表单模式「＋ 配置权限」要用）',
  ROLE_TREE.includes('treeSelectAll()') && ROLE_TREE.includes('treeClear'),
);

/* ★ 2026-10-20 第三轮：详情弹窗「编辑权限」删掉后，本页权限树的编辑模式不可达，
   底栏那个「保存权限」按钮随之删除。这里钉住"它不该回来"，
   但「职位权限分配」页（PermAssign）的保存按钮必须还在 —— 那是权限编辑的主路径。 */
check(
  'RoleManage 底栏不再有「保存权限」按钮（编辑模式已删）',
  !ROLE_TREE.includes('>保存权限</button>'),
);

check(
  'PermAssign 的「保存权限」仍在（权限编辑主路径没被连带删掉）',
  FOOT.includes('treeSaveAsk') && ASSIGN.includes('>保存权限</button>'),
);

check(
  'RoleManage 清空能力没丢（treeClear 仍在，带二次确认）',
  /function treeClear\(\): void \{/.test(ROLE),
);

check(
  'RoleManage 底栏左侧统计仍在（删按钮没把这条挤掉）',
  /已勾选[\s\S]{0,80}treeActionCount/.test(ROLE_TREE),
);

check(
  '两份实现都不再有「取消全部勾选」的 toast 文案（死了的提示也一起清）',
  !RAW_ASSIGN.includes('已取消全部勾选') && !RAW_ROLE.includes('已取消全部勾选'),
);

/* ============================================================
 * 输出
 * ============================================================ */
console.log('\n===== 「编辑权限」权限树弹窗结构回归 =====\n');
for (const l of lines) console.log(l);
console.log(`\n===== 结果：${pass}/${pass + fail} 通过 =====`);
process.exit(fail === 0 ? 0 : 1);
