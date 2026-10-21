/**
 * 回归守卫：部门管理表「列宽 / 间隙」口径
 * ============================================================================
 *
 * 背景（2026-10-20）：
 *   用户截图框出「部门管理」表格里「部门说明」右侧的一大片空白，要求「调整页面的间隙」。
 *
 * 【根因】表 6 列里只有「部门说明」是自适应列，其余 5 列写死 px
 *   （部门名称 230 / 上级部门 150 / 职位数 80 / 账号数 80 / 操作 250）。
 *   → 卡片宽出来多少全砸到说明列：实测卡片 1132px 时说明格 340px，
 *     而说明文字只有 81~161px —— 右边挂 180~260px 纯空白。
 *   另外数字列原来左对齐：一个 3 位数字在 80px 格里左右各留一半空档，
 *   视觉上把这个间隙又放大一倍。
 *
 * 【新口径】（本脚本逐条钉住，防止有人改回写死 px）
 *   ① 表格挂 `tb-dept` 类，仅这个表用 fixed 布局（别的表继续 auto，别误伤）；
 *   ② 6 列宽度全部百分比、合计 100% —— 富余按比例摊到每列，不再堆给说明列；
 *   ③ 数字列居中；说明列允许任意折行（fixed 布局下超长说明不会撑破）；
 *   ④ 名称列 ≥20%（要装「📂 部门名 + 含 N 个下级」标签）、
 *      操作列 ≥20%（要装下 查看职位/查看账号/编辑/删除 四个链接 + 间距）。
 *
 * 跑法：cd server-job && node scripts/_test-dept-table-width.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const P = (rel) => join(REPO, rel);
const read = (p) => readFileSync(p, 'utf8');
const count = (s, sub) => s.split(sub).length - 1;

/** 注释里会引用旧写法（230px/150px/…）做说明，统计前先剥掉 */
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

const DEPT = P('web-job/src/perm/views/DeptManage.vue');
const ROLE = P('web-job/src/perm/views/RoleManage.vue');
const CSS = P('web-job/src/shared-ui/shared-ui.css');

const deptSrc = stripComments(read(DEPT));
const cssSrc = read(CSS);

/* ---- ① 表格挂了 tb-dept 类，且只挂在这一处 ---- */
check('部门结构表挂上 tb-dept 类（只此一处，别的表不受影响）',
  count(deptSrc, 'class="tb tb-dept"') === 1,
  `出现 ${count(deptSrc, 'class="tb tb-dept"')} 次`);
check('「部门下职位 / 部门下账号」弹窗里的表没被误加 tb-dept',
  count(deptSrc, 'class="tb"') === 2,
  `其余普通表 ${count(deptSrc, 'class="tb"')} 个`);
check('职位管理页没有被误加 tb-dept（列宽口径只治部门表）',
  count(stripComments(read(ROLE)), 'tb-dept') === 0);

/* ---- ② 6 列宽度全部百分比、合计 100% ---- */
const thead = deptSrc.slice(deptSrc.indexOf('<thead>'), deptSrc.indexOf('</thead>'));
const widths = [...thead.matchAll(/<th[^>]*style="width:\s*([\d.]+)%"/g)].map((m) => Number(m[1]));
check('表头 6 列宽度都是百分比', widths.length === 6, `解析到 ${widths.length} 列：${widths.join(' / ')}`);
check('表头不再有写死的 px 列宽', !/style="width:\s*\d+px"/.test(thead));
const sum = widths.reduce((a, b) => a + b, 0);
check('6 列百分比合计 100%', Math.round(sum) === 100, `合计 ${sum}%`);
check('部门名称列 ≥20%（要装「📂 部门名 + 含 N 个下级」标签）', widths[0] >= 20, `${widths[0]}%`);
check('说明列 ≤24%（不吸收全部富余）', widths[2] <= 24, `${widths[2]}%`);
check('操作列 ≥20%（要装 查看职位/查看账号/编辑/删除 四个链接）', widths[5] >= 20, `${widths[5]}%`);

/* ---- ③ CSS 侧三条规则 ---- */
check('CSS：.tb.tb-dept 走 table-layout:fixed（列宽按声明分配，不被长说明撑开）',
  /\.tb\.tb-dept\s*\{[^}]*table-layout:\s*fixed/.test(cssSrc));
check('CSS：.tb.tb-dept .num 数字居中（左对齐会让 80px 空档再放大一倍）',
  /\.tb\.tb-dept\s+\.num\s*\{[^}]*text-align:\s*center/.test(cssSrc));
check('CSS：.tb.tb-dept .desc 允许任意折行（超长说明不会撑破 fixed 布局）',
  /\.tb\.tb-dept\s+\.desc\s*\{[^}]*overflow-wrap:\s*anywhere/.test(cssSrc));
check('CSS：fixed 规则没有写成全局 .tb（否则所有表格列宽都会跑偏）',
  !/^\.tb\s*\{[^}]*table-layout:\s*fixed/m.test(cssSrc));
check('CSS：本表 min-width:960px（六列都装得下的下限，再窄改横滚而不是挤成两行）',
  /\.tb\.tb-dept\s*\{[^}]*min-width:\s*960px/.test(cssSrc));
check('模板：表格外面套了 .tb-wrap（与职位管理 / 操作日志一致，min-width 才滚得起来）',
  /<div class="tb-wrap">\s*<table class="tb tb-dept">/.test(deptSrc));

/* ---- ③b 表头与数字必须同一条对齐规则（2026-10-20 第二版 · 用户第二次反馈）----
   【踩过的坑】第一版只给 <td> 加了居中，<th> 还是 .tb th 的左对齐
   → 表头文字贴左、数字落在列中间，两行错开 25px（1360 视口实测），
     1920 视口更夸张。用户原话「字段和下面对应的数字歪到姥姥家」。
   → 以后判「表头与内容对齐」不能只查 td 规则，必须查**表头也挂了同一个类**，
     且 CSS 选择器**没有用 td 限定**（`.tb.tb-dept td.num` 会漏掉表头）。 */
const numThs = [...thead.matchAll(/<th class="num"[^>]*>(职位数|账号数)<\/th>/g)].map((m) => m[1]);
check('表头「职位数 / 账号数」都挂 num 类（与下面数字走同一条对齐规则）',
  numThs.length === 2, `命中 ${numThs.join(' / ') || '无'}`);
check('CSS 的数字列规则没写成 td.num（写成 td 限定就会漏掉表头）',
  /\.tb\.tb-dept\s+\.num\s*\{/.test(cssSrc) && !/\.tb\.tb-dept\s+td\.num/.test(cssSrc));

/* ---- ④ 模板结构仍在：缩进变量、富余说明列仍在第 3 列 ---- */
check('说明列仍是第 3 列（.desc 单元格）', /<td class="desc">/.test(deptSrc));
check('部门名称列仍按层级缩进（--dept-indent 没被这轮改动碰掉）',
  deptSrc.includes("'--dept-indent': indentOf(d.id)"));
check('空状态 colspan 与 6 列一致', deptSrc.includes('colspan="6"'));

console.log(lines.join('\n'));
console.log(`\n===== 结果：${pass}/${pass + fail} 通过 =====`);
if (fail) {
  lines.filter((l) => l.startsWith('  ❌')).forEach((l) => console.log('  失败：' + l.trim()));
  process.exit(1);
}
