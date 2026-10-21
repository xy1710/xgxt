/**
 * 静态回归守卫：部门结构表格「一个部门只出现一处」+ 下级按层级缩进
 * ============================================================
 *
 * 背景（2026-10-19）：
 *   用户给了部门管理页截图，蓝框圈住的是「教学部」单元格里那三行内联下级
 *   （└ 初中部 / └ 高中部 / └ 大学部），绿框圈住的是下面三行独立的学段行。
 *   要求：把蓝框和绿框「整合成一个部分」，且这三个学段不能跟
 *   「市场咨询部 / 教学部」等处在同一层级。
 *
 *   原实现确实把同一批部门画了两遍：
 *     · 父级行的「部门名称」单元格里 v-for 列一遍下级名字；
 *     · 下级自己又有一行，且与父级平级、看不出从属。
 *
 * 处理方式（本脚本要钉住的）：
 *   ① 单元格里不再重复列下级 —— 内联那份列表删掉；
 *   ② 改为「部门名称」列按树深度缩进（--dept-indent），从属关系一眼可见；
 *   ③ 三个学段**仍保留自己的行** —— 它们是真部门（有职位 / 有账号），
 *      行内的「查看职位 / 查看账号 / 编辑 / 删除」入口一个都不能少。
 *
 * 为什么值得单独钉一个脚本：
 *   最容易出的错不是「改错值」，而是**为了消灭重复顺手把学段行也删了**——
 *   页面看着干净了，但那三个部门从此没有管理入口。这个脚本专门防这一手。
 *
 * 纯静态断言，不起服务、不连库、不写文件；退出码 0 = 全通过。
 * 几何效果（真的缩进了多少）由无头 Edge harness 实测，见下方 README 注释。
 * 跑法：cd server-job && node scripts/_test-dept-tree-indent.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const P = (rel) => join(REPO, rel);
const read = (p) => readFileSync(p, 'utf8');
const count = (s, sub) => s.split(sub).length - 1;

/** 去掉注释后再统计 —— 本次改动的说明注释里也引用了旧写法和 `--dept-indent` */
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
const CSS = P('web-job/src/shared-ui/shared-ui.css');
const dept = stripComments(read(DEPT));
const css = read(CSS);

/* ============================================================
 * 一、重复的那一份必须没了
 * ============================================================ */
check(
  '单元格里不再 v-for 列下级部门名（内联那份重复列表已删除）',
  count(dept, 'v-for="c in childrenOf(') === 0,
  `命中 ${count(dept, 'v-for="c in childrenOf(')} 次`,
);
check(
  '不再出现「└ {{ c.deptName }}」这种内联下级行',
  count(dept, '└ {{ c.deptName }}') === 0,
  `命中 ${count(dept, '└ {{ c.deptName }}')} 次`,
);

/* ============================================================
 * 二、改为按树深度缩进
 * ============================================================ */
check(
  '「部门名称」列挂上了 dept-name 类（缩进规则的落点）',
  count(dept, 'class="dept-name"') === 1,
  `命中 ${count(dept, 'class="dept-name"')} 次`,
);
check(
  '缩进量由行内 --dept-indent 传入（而不是按层级写死几个 class）',
  count(dept, `:style="{ '--dept-indent': indentOf(d.id) }"`) === 1,
  `命中 ${count(dept, `:style="{ '--dept-indent': indentOf(d.id) }"`)} 次`,
);
check(
  '定义了 depthOf（树深度，缺数据时兜底为 2 = 不缩进）',
  count(dept, 'const depthOf = (id: string): number =>') === 1,
);
check(
  '定义了 indentOf（第 2 层不缩进，每深一层 +20px）',
  count(dept, 'const indentOf = (id: string): string =>') === 1 &&
    count(dept, 'Math.max(0, depthOf(id) - 2) * 20') === 1,
);
check(
  '定义了 isLastSibling（同级末尾用 └，否则用 ├）',
  count(dept, 'const isLastSibling = (d: PermDeptTreeNode): boolean =>') === 1 &&
    count(dept, `isLastSibling(d) ? '└' : '├'`) === 1,
);
check(
  '子树深度确实是在 loadAll 的 walk 里记下来的',
  count(dept, 'const depth: Record<string, number> = {};') === 1 &&
    count(dept, 'depth[n.id] = d;') === 1 &&
    count(dept, 'deptDepth.value = depth;') === 1,
);
check(
  '树深度从 1 起算（校级 = 1）',
  count(dept, 'walk(t, 1);') === 1,
  `命中 ${count(dept, 'walk(t, 1);')} 次`,
);
check(
  'deptDepth 声明为 Record<string, number>',
  count(dept, 'const deptDepth = ref<Record<string, number>>({});') === 1,
);

/* ============================================================
 * 三、三个学段的行 + 它们的操作入口不能被顺手删掉
 *     （这是本次改动最大的风险：为了「去重复」把整行删了）
 * ============================================================ */
check(
  '表格行仍是「全部非校级部门」—— 学段保留自己的行',
  count(dept, 'const rows = computed(() => flatNodes.value.filter((n) => n.deptLevel !== 1));') === 1,
);
/* 整块操作区一字不差地还在 —— 比逐个计数更准：
   openDeptRoles(d) / openDeptUsers(d) 在「职位数」「账号数」单元格里也会出现，
   单独数会得到 2 次，容易被误判成「多了一处」。 */
const ACTS = `<div class="acts">
                  <span class="lk" @click="openDeptRoles(d)">查看职位</span>
                  <span class="lk" @click="openDeptUsers(d)">查看账号</span>
                  <span class="lk" @click="openEdit(d)">编辑</span>
                  <span class="lk dg" @click="delDept(d)">删除</span>
                </div>`;
check(
  '行内四个操作入口（查看职位 / 查看账号 / 编辑 / 删除）整块仍在',
  count(dept, ACTS) === 1,
  `命中 ${count(dept, ACTS)} 次`,
);
for (const [label, needle] of [
  ['查看职位', '<span class="lk" @click="openDeptRoles(d)">查看职位</span>'],
  ['查看账号', '<span class="lk" @click="openDeptUsers(d)">查看账号</span>'],
  ['编辑', '<span class="lk" @click="openEdit(d)">编辑</span>'],
  ['删除', '<span class="lk dg" @click="delDept(d)">删除</span>'],
]) {
  check(
    `「${label}」链接本身没有被改文案 / 改成按钮`,
    count(dept, needle) === 1,
    `命中 ${count(dept, needle)} 次`,
  );
}
check(
  '父级行的「含 N 个下级」标签保留（没有连它一起删掉）',
  count(dept, 'class="tag n" style="margin-left: 5px">含 {{ childrenOf(d.id).length }} 个下级</span>') === 1,
);

/* ============================================================
 * 四、样式表：缩进规则与分支符号
 * ============================================================ */
check(
  '样式表有 .tb td.dept-name 的缩进规则（基准 14px + --dept-indent）',
  /\.tb td\.dept-name\{padding-left:calc\(14px \+ var\(--dept-indent,0px\)\)\}/.test(css),
);
check(
  '--dept-indent 有 0px 兜底（没传变量时不至于把左边距算没）',
  /var\(--dept-indent,0px\)/.test(css),
);
check(
  '分支符号 .branch 有独立配色（比部门名浅，不喧宾夺主）',
  /\.tb td\.dept-name \.branch\{color:#C9BDB8/.test(css),
);

/* ============================================================
 * 输出
 * ============================================================ */
console.log('\n===== 「部门结构 · 去重复 + 树形缩进」回归 =====\n');
for (const l of lines) console.log(l);
console.log(`\n===== 结果：${pass}/${pass + fail} 通过 =====`);
process.exit(fail === 0 ? 0 : 1);
