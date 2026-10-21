/**
 * 回归守卫：页面管理台账 = 左侧菜单栏
 * ============================================================================
 *
 * 背景（2026-10-20）：
 *   用户要求「按之前的样式，但内容按左侧菜单栏改写」——
 *   系统这轮把 就业管理 / 教务管理 / 班级管理（大学部）/ 教学管理（初高）
 *   四个板块合并成**一个「教学管理」**（侧栏只剩一个分组，15 项），
 *   并把「工作台」提为置顶单层菜单项。
 *   台账原来还是「7 板块 56 页」的老口径，跟菜单对不上。
 *
 * 【本脚本钉住的五条】
 *   ① 板块口径 = 5 个（工作台 / 市场咨询 / 财务管理 / 权限管理 / 教学管理），
 *      顺序与侧栏一致；旧的 job / edu / class / class-jh 四个 key 不再出现。
 *   ② 教学管理的 15 个页面，**顺序与 path 必须与 config/menu.ts 逐项相同**
 *      —— 这一条是核心，菜单改了台账没改就会红。
 *   ③ 合并页必须挂多个权限码（pageCodes），单码页也要能通过 pageCodesOf 取到。
 *   ④ 四个消费点都走统一取码函数，不许再出现「只认第一个码」的裸判断
 *      （2026-10-20 踩过：只认首码会让大学部班主任的默认勾选漏掉）。
 *   ⑤ 工作台是全站首页（locked），职位模式的默认值必须对它给 true，
 *      否则界面显示「工作台 0/1」，与真实权限对不上。
 *
 * 跑法：cd server-job && node scripts/_test-page-registry.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const P = (rel) => join(REPO, rel);
const read = (p) => readFileSync(p, 'utf8');

/** 注释里会引用旧口径（7 板块 56 页 / 旧板块 key）做说明，统计前先剥掉 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

const count = (s, sub) => s.split(sub).length - 1;

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

const REG = P('server-job/src/perm/config/pageRegistry.ts');
const MENU = P('web-job/src/config/menu.ts');
const PAGE_SVC = P('server-job/src/perm/services/page.service.ts');
const ROLE_SVC = P('server-job/src/perm/services/rolePage.service.ts');
const DEFAULTS = P('server-job/src/utils/rolePageDefaults.ts');
const LEDGER = P('server-job/src/utils/rolePageLedger.ts');
const TYPES = P('shared-types/src/perm/page.ts');
const PAGE_MANAGE = P('web-job/src/perm/views/PageManage.vue');

const regSrc = stripComments(read(REG));

/* ============================================================
 * ① 板块口径：5 个、顺序正确、旧 key 不再出现
 * ============================================================ */

/** PAGE_REGISTRY 汇总区之前的部分才是各板块定义 */
const bodySrc = regSrc.slice(0, regSrc.indexOf('export const PAGE_REGISTRY'));

/** 逐个板块切段：const NAME: RegistryBoard = { ... }; */
const boardMatches = [...bodySrc.matchAll(/const\s+(\w+):\s*RegistryBoard\s*=\s*\{/g)];
const boards = boardMatches.map((m, i) => {
  const start = m.index;
  const end = i + 1 < boardMatches.length ? boardMatches[i + 1].index : bodySrc.length;
  const text = bodySrc.slice(start, end);
  const moduleKey = (text.match(/moduleKey:\s*'([^']+)'/) || [])[1] || '';
  const moduleName = (text.match(/moduleName:\s*'([^']+)'/) || [])[1] || '';
  const sortNo = Number((text.match(/sortNo:\s*(\d+)/) || [])[1] || 0);
  const pagesText = text.slice(text.indexOf('pages:'));
  const pageKeys = [...pagesText.matchAll(/(?:^|[\s{,])key:\s*'([^']+)'/g)].map((x) => x[1]);
  const paths = [...pagesText.matchAll(/path:\s*'([^']+)'/g)].map((x) => x[1]);
  const multiCodes = count(pagesText, 'pageCodes:');
  const singleCodes = count(pagesText, 'pageCode:');
  return { name: m[1], moduleKey, moduleName, sortNo, pageKeys, paths, multiCodes, singleCodes };
});

const EXPECT_BOARDS = [
  ['workbench', '工作台', 1],
  ['consult', '市场咨询', 5],
  ['finance', '财务管理', 6],
  ['perm', '权限管理', 7],
  ['teach', '教学管理', 15],
];

check('板块数 = 5（原 7 板块已合并）', boards.length === 5, `实际 ${boards.length}`);
check(
  '板块 key / 名称 / 页数逐项正确且顺序 = 侧栏顺序',
  boards.length === EXPECT_BOARDS.length &&
    boards.every(
      (b, i) =>
        b.moduleKey === EXPECT_BOARDS[i][0] &&
        b.moduleName === EXPECT_BOARDS[i][1] &&
        b.pageKeys.length === EXPECT_BOARDS[i][2],
    ),
  boards.map((b) => `${b.moduleKey}:${b.pageKeys.length}`).join(' / '),
);
check(
  '旧四板块 key（job / edu / class / class-jh）不再出现在台账里',
  !boards.some((b) => ['job', 'edu', 'class', 'class-jh'].includes(b.moduleKey)),
);
check(
  'sortNo 递增（左栏顺序由它决定）',
  boards.every((b, i) => b.sortNo === i + 1),
  boards.map((b) => b.sortNo).join(','),
);

const total = boards.reduce((n, b) => n + b.pageKeys.length, 0);
check('页面总数 = 34（1+5+6+7+15）', total === 34, `实际 ${total}`);

/* ============================================================
 * ② 教学管理 15 页 = 菜单 15 项（顺序 + path 逐项比对）
 * ============================================================ */

const teach = boards.find((b) => b.moduleKey === 'teach');
check('教学管理板块存在', !!teach);

/** 从 menu.ts 的 children 数组里按出现顺序抽菜单项：
 *    domainNode('student')            → /teaching/student   （合并业务域）
 *    { title: '班级交接', path: '/x' } → /x                  （各学段独有） */
const menuSrc = stripComments(read(MENU));
const childrenStart = menuSrc.indexOf('children: [');
const childrenText = menuSrc.slice(childrenStart, menuSrc.indexOf('export ', childrenStart) > 0
  ? menuSrc.indexOf('export ', childrenStart)
  : menuSrc.length);

const menuPaths = [];
const tokenRe = /domainNode\(\s*'([^']+)'\s*\)|path:\s*'([^']+)'/g;
let mt;
while ((mt = tokenRe.exec(childrenText)) !== null) {
  if (mt[1]) menuPaths.push(`/teaching/${mt[1]}`);
  else if (mt[2]) menuPaths.push(mt[2]);
}

check('从 menu.ts 解析出 15 个菜单项', menuPaths.length === 15, `实际 ${menuPaths.length}`);
check(
  '教学管理台账的 15 个 path 与菜单逐项相同（顺序也算）',
  teach && JSON.stringify(teach.paths) === JSON.stringify(menuPaths),
  teach && teach.paths.length === menuPaths.length
    ? teach.paths
        .map((p, i) => (p === menuPaths[i] ? null : `第${i + 1}项 ${p} ≠ ${menuPaths[i]}`))
        .filter(Boolean)
        .join('；') || '全部一致'
    : `台账 ${teach?.paths.length} 项 / 菜单 ${menuPaths.length} 项`,
);

/* ============================================================
 * ③ 权限码：合并页挂多码，且统一走 pageCodesOf
 * ============================================================ */

check('教学管理里有合并页（pageCodes 数组）', (teach?.multiCodes || 0) >= 8, `多码页 ${teach?.multiCodes} 个`);
check(
  '教学管理每页都至少有一个权限码（单码 + 多码 = 15 页）',
  !!teach && teach.singleCodes + teach.multiCodes === 15,
  `单码 ${teach?.singleCodes} + 多码 ${teach?.multiCodes}`,
);
check('注册表导出统一取码函数 pageCodesOf', /export function pageCodesOf\(/.test(regSrc));
check(
  'pageCodesOf 的口径 = 有 pageCodes 用数组、否则用单码包成数组',
  /if \(p\.pageCodes\?\.length\) return p\.pageCodes;/.test(regSrc) &&
    /return p\.pageCode \? \[p\.pageCode\] : \[\];/.test(regSrc),
);

/* ============================================================
 * ④ 四个消费点都不许再裸用单码
 * ============================================================ */

const pageSvc = stripComments(read(PAGE_SVC));
const roleSvc = stripComments(read(ROLE_SVC));
const defaults = stripComments(read(DEFAULTS));
const ledger = stripComments(read(LEDGER));
const types = read(TYPES);

check('落库 page_code 走 pageCodesOf(p)[0]（varchar(64) 装不下多码，只作线索）',
  /page_code:\s*pageCodesOf\(p\)\[0\]/.test(pageSvc));
check('板块模式接口把 pageCodes 一并下发', /pageCodes:\s*p\.pageCodes/.test(pageSvc));
check('职位模式接口把 pageCodes 一并下发', /pageCodes:\s*p\.pageCodes/.test(roleSvc));
check('共享类型 PermPageItem 声明了 pageCodes', /pageCodes\?:\s*string\[\]/.test(types));

check(
  '默认值推导：任一码命中即可见（不是只认首码）',
  /visible = pageCodesOf\(p\)\.some\(\(c\) => legacySet\.has\(c\)\)/.test(defaults),
);
check(
  '默认值推导里不再有「只认 pageCode」的裸判断',
  !/legacySet\.has\(p\.pageCode\)/.test(defaults),
);
check('台账取码新增多码版本 codesOfPath', /export function codesOfPath\(pagePath: string\): string\[\]/.test(ledger));
check(
  '台账增删权限码按 path 整组处理（否则某学段的码会漏网）',
  /for \(const code of codesOfPath\(path\)\)/.test(ledger) &&
    !/const code = codeOfPath\(path\);\s*\n\s*if \(code &&/.test(ledger),
);

/* ============================================================
 * ⑤ 工作台：全局首页，locked 且职位模式默认可见
 * ============================================================ */

const wb = boards.find((b) => b.moduleKey === 'workbench');
check('工作台板块存在且只有 1 页', !!wb && wb.pageKeys.length === 1);
check('工作台页面 path = /（登录落地页）', wb?.paths[0] === '/', wb?.paths[0]);

const wbText = bodySrc.slice(
  bodySrc.indexOf('const WORKBENCH'),
  bodySrc.indexOf('const CONSULT'),
);
check('工作台页面 locked（不可取消，否则把人锁在门外）', /locked:\s*true/.test(wbText));
check(
  '职位模式默认值显式给了 workbench = true（否则界面显示「工作台 0/1」）',
  /case 'workbench':[\s\S]{0,600}?visible = true;/.test(defaults),
);

/* ============================================================
 * ⑥ 左栏：工作台不按职位展开（2026-10-20 用户截图框掉的那 14 行）
 * ============================================================ */

const roleSvcSrc = stripComments(read(ROLE_SVC));
const pageManage = stripComments(read(PAGE_MANAGE));

check(
  '职位树里工作台不枚举职位（否则 14 个职位全是 1/1，把真要配的页面淹掉）',
  /if \(b\.moduleKey !== 'workbench'\) \{/.test(roleSvcSrc),
);
check(
  '左栏展开箭头按「有没有职位」决定（空职位板块不画 ▸/▾）',
  /\{\{ b\.roles\.length \? \(isTreeOpen\(b\.moduleKey\) \? '▾' : '▸'\) : '' \}\}/.test(pageManage),
);
check(
  '「本板块暂无职位」只在多页板块提示（单页的工作台不该冒出这句）',
  /v-if="!b\.roles\.length && b\.total > 1" class="rl-none"/.test(pageManage),
);

/* ---- 汇总 ---- */
console.log(lines.join('\n'));
console.log(`\n===== 结果：${pass}/${pass + fail} 通过 =====`);
if (fail) {
  lines.filter((l) => l.startsWith('  ❌')).forEach((l) => console.log('  失败：' + l.trim()));
  process.exit(1);
}
