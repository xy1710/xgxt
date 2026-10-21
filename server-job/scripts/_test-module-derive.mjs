/**
 * 自检：「新建账号 · 可访问模块按职位自动推导」
 * ============================================================
 *
 * 【为什么单独一个脚本】
 *   本轮把「新建账号」里的「可访问模块」勾选区删掉，改成
 *   `web-job/src/perm/utils/moduleDerive.ts` 的 `derivePortalModules()`
 *   按所选职位推导。这条规则有两个致命风险，必须机器验证：
 *
 *   ① **两套模块 key 不是一套**（最容易踩的坑）
 *      权限库 `t_perm_menu.module_key` 是 market/fin/perm/job/train/acad/teach/approve，
 *      门户模块是 consult/finance/perm/job/edu/class/class-jh ——
 *      只有 perm / job 名字刚好一样。若映射表写错（例如 market 直接当门户 key 写进去），
 *      `t_sys_account.modules` 里会存进无效 key，被 account.service 的
 *      `MODULES.filter()` 全过滤 → **账号 0 个可见模块 → 登录直接被拒**。
 *      这个 bug 只在「新建账号后去登录」时才暴露，本地开发根本发现不了。
 *
 *   ② 推导结果落空 → 同样登不进去
 *      所以规则里有两条兜底（空集 / 跨板块 → 全部模块），本脚本逐条断言。
 *
 * 【★ 怎么保证测的是「真规则」而不是「测试里抄的一份」】
 *   用 web-job 自带的 esbuild 把那个 .ts **现场转成 ESM 再 import**，
 *   规则只有一份源码，改了源码这里立刻跟着变 —— 不存在两份实现走偏的可能。
 *
 * 【★ 数据侧怎么验】
 *   拿**真实存量数据**做回归：本地库里每个账号都有「职位」和「实际模块」，
 *   规则跑出来的结果必须 ⊆ 实际模块的反向 —— 即
 *   **不允许任何一个账号「少给」模块**（少给 = 侧边栏少一个入口甚至登不进去）。
 *   多给是允许的（teach 教学部门无法从职位区分大学部/初高，故意两个都给）。
 *
 * 跑法：cd server-job && node scripts/_test-module-derive.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { conn, makeChecker } from './_e2e-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

/* ------------------------------------------------------------
 * 一、把真源码转出来（不抄规则）
 * ---------------------------------------------------------- */
const requireWeb = createRequire(path.join(REPO, 'web-job', 'package.json'));
const esbuild = requireWeb('esbuild');
const TS_PATH = path.join(REPO, 'web-job', 'src', 'perm', 'utils', 'moduleDerive.ts');

const built = await esbuild.build({
  entryPoints: [TS_PATH],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  write: false,
});
const code = built.outputFiles[0].text;
const { derivePortalModules, PORTAL_MODULE_KEYS, PERM_MODULE_TO_PORTAL } = await import(
  'data:text/javascript;base64,' + Buffer.from(code, 'utf8').toString('base64')
);

const { check, summary } = makeChecker();
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

console.log('===== 一、规则单元断言 =====');
console.log(`  来源源码：${path.relative(REPO, TS_PATH)}`);

check(
  '门户模块全集 = 7 个（与 shared-types 的 ModuleKey 对齐）',
  same(PORTAL_MODULE_KEYS, ['consult', 'finance', 'perm', 'job', 'edu', 'class', 'class-jh']),
  PORTAL_MODULE_KEYS.join(','),
);

check(
  '⚠️ 映射表里不出现门户 key 之外的脏值',
  Object.values(PERM_MODULE_TO_PORTAL)
    .flat()
    .every((k) => PORTAL_MODULE_KEYS.includes(k)),
  Object.entries(PERM_MODULE_TO_PORTAL)
    .map(([k, v]) => `${k}→${v.join('+') || '空'}`)
    .join(' / '),
);

check(
  '市场咨询（market）→ consult，不是 market',
  same(derivePortalModules(['market']), ['consult']),
  derivePortalModules(['market']).join(','),
);

check(
  '财务管理（fin）→ finance，不是 fin',
  same(derivePortalModules(['fin']), ['finance']),
  derivePortalModules(['fin']).join(','),
);

check(
  '教务部门（acad）→ edu，不是 acad',
  same(derivePortalModules(['acad']), ['edu']),
  derivePortalModules(['acad']).join(','),
);

check(
  '实训-教学（train）→ job（实训阶段的页面是 job:*）',
  same(derivePortalModules(['train']), ['job']),
  derivePortalModules(['train']).join(','),
);

check(
  '教学部门（teach）→ class + class-jh（职位无法二选一，两个都给）',
  same(derivePortalModules(['teach']), ['class', 'class-jh']),
  derivePortalModules(['teach']).join(','),
);

check(
  '审批中心（approve）不单独给模块（跨板块，没有自己的入口）',
  same(derivePortalModules(['approve']), [...PORTAL_MODULE_KEYS]),
  '落到空集 → 兜底全开',
);

check(
  '多职位并集：acad+teach+train+approve → class / class-jh / edu / job',
  same(derivePortalModules(['acad', 'teach', 'train', 'approve']), [
    'class',
    'class-jh',
    'edu',
    'job',
  ]),
  derivePortalModules(['acad', 'teach', 'train', 'approve']).join(','),
);

check(
  '兜底①：一个模块都推不出来 → 全部模块（保证一定登得进去）',
  same(derivePortalModules([]), [...PORTAL_MODULE_KEYS]),
  derivePortalModules([]).length + ' 个',
);

check(
  '兜底②：跨板块角色（命中 6 个，实测就是「校长」）→ 全开，含 perm',
  (() => {
    const got = derivePortalModules(['acad', 'approve', 'fin', 'job', 'market', 'teach', 'train']);
    return same(got, [...PORTAL_MODULE_KEYS]) && got.includes('perm');
  })(),
  derivePortalModules(['acad', 'approve', 'fin', 'job', 'market', 'teach', 'train']).join(','),
);

check(
  'unknow key 不炸、当空处理',
  same(derivePortalModules(['不存在的模块']), [...PORTAL_MODULE_KEYS]),
  '落到兜底全开',
);

/* ------------------------------------------------------------
 * 二、拿真实存量数据回归
 * ---------------------------------------------------------- */
console.log('\n===== 二、存量数据回归（推导结果不允许「少给」） =====');

const db = conn('sms_perm');
let total = 0;
let exact = 0;
const rows = [];

try {
  const [users] = await db.raw(
    `SELECT u.id, u.account, u.user_name
       FROM sms_perm.t_perm_user u
      WHERE u.is_deleted = 0
      ORDER BY u.account`,
  );
  const [links] = await db.raw(
    'SELECT user_id, role_id FROM sms_perm.t_perm_user_role WHERE is_deleted = 0',
  );
  const [roles] = await db.raw(
    'SELECT id, role_name FROM sms_perm.t_perm_role WHERE is_deleted = 0',
  );
  const [rolePerms] = await db.raw(
    'SELECT DISTINCT role_id, module_key FROM sms_perm.t_perm_role_perm WHERE is_deleted = 0',
  );
  const [accts] = await db.raw(
    'SELECT account, modules FROM sms_portal.t_sys_account WHERE is_deleted = 0',
  );

  const roleName = new Map(roles.map((r) => [r.id, r.role_name]));
  const modsOfRole = new Map();
  for (const p of rolePerms) {
    const set = modsOfRole.get(p.role_id) || new Set();
    set.add(String(p.module_key));
    modsOfRole.set(p.role_id, set);
  }
  const rolesOfUser = new Map();
  for (const l of links) {
    const arr = rolesOfUser.get(l.user_id) || [];
    arr.push(l.role_id);
    rolesOfUser.set(l.user_id, arr);
  }
  const parseModules = (raw) => {
    if (!raw) return [];
    try {
      const a = JSON.parse(String(raw));
      return Array.isArray(a) ? a.map(String) : [];
    } catch {
      return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
    }
  };
  const stored = new Map(accts.map((a) => [a.account, parseModules(a.modules)]));

  const shorten = (arr) =>
    arr
      .map((k) => k.replace('consult', '咨').replace('finance', '财').replace('perm', '权'))
      .map((k) => k.replace('job', '就').replace('edu', '教').replace('class-jh', '初高').replace('class', '班'))
      .join(' ');

  console.log('  账号           职位                  权限库模块                       推导 ──→ 门户模块            实际存的');
  let loss = 0;
  for (const u of users) {
    total += 1;
    const rids = rolesOfUser.get(u.id) || [];
    const permMods = new Set();
    rids.forEach((rid) => (modsOfRole.get(rid) || new Set()).forEach((m) => permMods.add(m)));
    const derived = derivePortalModules([...permMods], [...PORTAL_MODULE_KEYS]);
    const now = stored.get(u.account) || [];
    const isExact = same(derived, now);
    const noLoss = now.every((k) => derived.includes(k));
    if (isExact) exact += 1;
    if (!noLoss) loss += 1;
    rows.push({ account: u.account, permMods: [...permMods].sort(), derived, now, isExact, noLoss });
    console.log(
      `  ${u.account.padEnd(13)} ${rids.map((r) => roleName.get(r) || r).join(',').padEnd(20)} ` +
        `${[...permMods].sort().join(',').padEnd(30)} → ${shorten(derived).padEnd(22)} ${shorten(now) || '—'}` +
        `${isExact ? '  ✅一致' : noLoss ? '  ➕多给' : '  ❌少给'}`,
    );
  }

  check(
    `所有推导结果非空（${total} 个账号）`,
    rows.every((r) => r.derived.length > 0),
    '非空 = 新建账号一定登得进去',
  );
  check(
    '⚠️ 没有任何一个账号被「少给」模块（少给才会导致登不进去 / 少入口）',
    loss === 0,
    loss ? `${loss} 个账号少给：${rows.filter((r) => !r.noLoss).map((r) => r.account).join(',')}` : `0 个（${total} 个账号全部满足）`,
  );
  check(
    `完全一致的账号数 ≥ ${Math.floor(total * 0.5)}（其余为 teach 教学部门「两个都给」导致的多给）`,
    exact >= Math.floor(total * 0.5),
    `${exact}/${total} 完全一致`,
  );

  const multi = rows.filter((r) => !r.isExact && r.noLoss);
  check(
    '多给的账号都是「教学部门 teach」这一类（多一个 class / class-jh 入口，非漏给）',
    multi.every((r) => r.permMods.includes('teach')),
    multi.length ? `${multi.length} 个：${multi.map((r) => r.account).join(',')}` : '无',
  );
} finally {
  await db.destroy();
}

const ok = summary();
process.exit(ok ? 0 : 1);
