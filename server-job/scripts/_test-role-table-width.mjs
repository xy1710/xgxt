/**
 * 回归守卫：职位管理表「列宽 / 间隙」口径
 * ============================================================================
 *
 * 背景（2026-10-20）：
 *   用户截图框出「职位管理」表里「职位名称 / 所属部门」两列右侧的大片空白，
 *   要求「间隙调整一下，让页面看起来协调一些」。
 *
 * 【根因】（与部门管理表同一类病，但成因更隐蔽）
 *   7 列都写死了 px：220/170/74/80/72/112/230，**且 table-layout 是 auto**。
 *   → auto 布局下声明的 px 只是"建议值"，浏览器按内容把多余宽度优先砸给前两列：
 *     实测 1520 视口、表宽 1264 时，前两列被撑成 290 / 224px，
 *     而内容只有 113 / 63px —— 两列富余 282px，占全表富余 423px 的 **67%**。
 *   → 数字列（关联人数/权限数/状态）原来左对齐，窄内容靠左，右侧空档更显眼。
 *
 * 【新口径】（本脚本逐条钉住）
 *   ① 表格挂 `tb-role`（只此一处），fixed 布局 + min-width:1080px；
 *   ② 7 列宽度全部百分比、合计 100%；每列＝内容宽 + 同一份呼吸空间，
 *      实测各列富余 69~75px（最大最小差 ≤ 10px）—— 不许任何一列超过 25%；
 *   ③ 3~5 列（关联人数/权限数/状态）表头与单元格**一起居中**，
 *      不能只居中 td（部门表那轮踩过「表头左、数字中」的坑）；
 *   ④ 别误伤：部门表的 tb-dept 口径不动，其余表继续 auto。
 *
 * 跑法：cd server-job && node scripts/_test-role-table-width.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const P = (rel) => join(REPO, rel);
const read = (p) => readFileSync(p, 'utf8');
const count = (s, sub) => s.split(sub).length - 1;

/** 注释里会引用旧写法（220px/290…）做说明，统计前先剥掉 */
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
const DEPT = P('web-job/src/perm/views/DeptManage.vue');
const CSS = P('web-job/src/shared-ui/shared-ui.css');

const roleSrc = stripComments(read(ROLE));
const deptSrc = stripComments(read(DEPT));
const cssSrc = read(CSS);

/* ============================================================
 * 一、表格挂 tb-role，只此一处
 * ============================================================ */
check(
  '职位管理表挂上 tb-role 类（只此一处，别的表不受影响）',
  count(roleSrc, 'class="tb tb-role"') === 1,
  `出现 ${count(roleSrc, 'class="tb tb-role"')} 次`,
);

check(
  '本页其余小表（职位下人员 / 待关职位）仍用普通 .tb（没被统一加 tb-role）',
  count(roleSrc, 'class="tb"') >= 1,
  `普通 .tb ${count(roleSrc, 'class="tb"')} 个`,
);

check(
  '职位管理页没有被误加 tb-dept（两套列宽口径互不串味）',
  count(roleSrc, 'tb-dept') === 0,
);

check(
  '部门管理表的 tb-dept 仍在（这轮不许动它）',
  count(deptSrc, 'class="tb tb-dept"') === 1,
);

/* ============================================================
 * 二、7 列百分比、合计 100
 * ============================================================ */
const thead = roleSrc.slice(roleSrc.indexOf('<thead>'), roleSrc.indexOf('</thead>'));
const widths = [...thead.matchAll(/<th[^>]*style="width:\s*([\d.]+)%"/g)].map((m) => Number(m[1]));

check(
  '表头 7 列宽度都是百分比',
  widths.length === 7,
  `解析到 ${widths.length} 列：${widths.join(' / ')}`,
);

check(
  '表头不再有写死的 px 列宽（auto 布局下 px 会被浏览器二次分配）',
  !/style="width:\s*\d+px"/.test(thead),
);

const sum = widths.reduce((a, b) => a + b, 0);
check('7 列百分比合计 100%', Math.round(sum) === 100, `合计 ${sum}%`);

check(
  '前两列合计 ≤32%（它们的富余曾是全表的 67%，不许回流）',
  widths[0] + widths[1] <= 32,
  `职位名称 ${widths[0]}% + 所属部门 ${widths[1]}% = ${widths[0] + widths[1]}%`,
);

check(
  '所属部门列 ≤14%（内容只有「财务管理部」5 字，63px）',
  widths[1] <= 14,
  `${widths[1]}%`,
);

const maxCol = Math.max(...widths);
check(
  '没有任何一列超过 25%（超了就是它独自吃掉了富余）',
  maxCol <= 25,
  `最大 ${maxCol}%，列序 ${widths.join('/')}`,
);

check(
  '操作列 ≥20%（要装 查看/查看职位下人员/停用/删除 四个链接，实测需 193px）',
  widths[6] >= 20,
  `${widths[6]}%`,
);

check(
  '创建时间列 ≥15%（19 字符「2026-10-03 18:51:11」约 104px）',
  widths[5] >= 15,
  `${widths[5]}%`,
);

/* ============================================================
 * 三、CSS 侧规则
 * ============================================================ */
check(
  'CSS：.tb.tb-role 走 table-layout:fixed',
  /\.tb\.tb-role\s*\{[^}]*table-layout:\s*fixed/.test(cssSrc),
);

check(
  'CSS：.tb.tb-role min-width:1080px（再窄改横滚，不让操作列挤成两行）',
  /\.tb\.tb-role\s*\{[^}]*min-width:\s*1080px/.test(cssSrc),
);

check(
  'CSS：fixed 没写成全局 .tb（否则所有表格列宽一起跑偏）',
  !/^\.tb\s*\{[^}]*table-layout:\s*fixed/m.test(cssSrc),
);

/* ---- ③ 表头与单元格必须成对居中 ----
   【部门表那轮的坑】只给 td 加居中 → 表头贴左、数字在中间，错开 25px。
   这里用 nth-child 定位，断言 **th 与 td 都写了**、且列号对得上。
   ⚠️ 不能直接全文件扫 `t[hd]:nth-child(N)` —— 折行那条 `td:nth-child(2)`
   也被同一个选择器前缀命中，会误判成"居中列"。只解析含 text-align:center
   的那一个规则块（选择器在工作表里跨多行，故用 [^{}]* 覆盖）。 */
const centerRule = (cssSrc.match(/\.tb\.tb-role[^{}]*\{[^}]*text-align:\s*center[^}]*\}/) || [''])[0];
const centerSelSrc = centerRule.slice(0, centerRule.indexOf('{'));
const centerSel = [...centerSelSrc.matchAll(/(t[hd]):nth-child\((\d)\)/g)].map((m) => ({
  tag: m[1],
  col: Number(m[2]),
}));

check(
  'CSS：居中列限定在第 3/4/5 列（关联人数 / 权限数 / 状态）',
  centerSel.length === 6 && centerSel.every((s) => [3, 4, 5].includes(s.col)),
  `命中 ${centerSel.map((s) => s.tag + s.col).join(' ')}`,
);

check(
  'CSS：这 3 列的表头(th)与单元格(td)都居中（不能只写 td）',
  [3, 4, 5].every(
    (c) => centerSel.some((s) => s.tag === 'th' && s.col === c) && centerSel.some((s) => s.tag === 'td' && s.col === c),
  ),
);

check(
  'CSS：居中规则里表头(th)与单元格(td)都写了（只写 td 就会表头左、内容中）',
  centerSelSrc.includes('th:nth-child') && centerSelSrc.includes('td:nth-child'),
  `选择器块：${centerSelSrc.replace(/\s+/g, ' ').trim().slice(0, 90)}`,
);

check(
  'CSS：所属部门列允许折行（fixed 下超长部门名不会撑破）',
  /\.tb\.tb-role td:nth-child\(2\)\s*\{[^}]*overflow-wrap:\s*anywhere/.test(cssSrc),
);

/* ============================================================
 * 四、结构与数据没被这轮碰掉
 * ============================================================ */
check('空状态 colspan 仍是 7（列数没变）', roleSrc.includes('colspan="7"'));

check(
  '7 个单元格内容仍在：职位名/部门/关联人数/权限数/状态/创建时间/操作',
  /r\.roleName/.test(roleSrc) &&
    /r\.deptName \|\| '—'/.test(roleSrc) &&
    /r\.userCount/.test(roleSrc) &&
    /r\.permCount/.test(roleSrc) &&
    /r\.roleStatus/.test(roleSrc) &&
    /r\.createTime/.test(roleSrc),
);

check(
  '操作列四个入口仍在（查看 / 查看职位下人员 / 停用 / 删除）',
  /@click="openDetail\(r\)">查看</.test(roleSrc) &&
    /@click="openRoleUsers\(r\)">查看职位下人员</.test(roleSrc) &&
    /@click="toggleRole\(r\)"/.test(roleSrc) &&
    /@click="r\.isSys \? toast\('系统预置职位不可删除', 'err'\) : delRole\(r\)"/.test(roleSrc),
);

check(
  '表格外面套着 .tb-wrap（min-width 才滚得起来）',
  /<div class="tb-wrap">\s*<table class="tb tb-role">/.test(roleSrc),
);

console.log(lines.join('\n'));
console.log(`\n===== 结果：${pass}/${pass + fail} 通过 =====`);
if (fail) {
  lines.filter((l) => l.startsWith('  ❌')).forEach((l) => console.log('  失败：' + l.trim()));
  process.exit(1);
}
