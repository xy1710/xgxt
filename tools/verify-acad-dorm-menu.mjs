/**
 * 教务老师「宿舍管理」入口校验（2026-10-20 版）
 * ============================================================
 *
 * 【背景】前一版（3dfb416 + 2026-10-19 的 menu 补丁）给教务老师单开了一个
 *   独立的「教务宿舍」入口（/edu/dorm）。本版按用户要求改为：
 *   · 去掉教务自己的 /edu/dorm 入口；
 *   · 把合并后的宿舍管理页（/teaching/dorm）同步给教务老师。
 *
 * 【做法】
 *   ① 前端 menu.ts 删除「教务宿舍」(/edu/dorm) 菜单项，仅保留合并域 domainNode('dorm')；
 *   ② R08 台账：/edu/dorm 置 0（摘 edu:dorm:view），/dorm 与 /class-jh/dorm 置 1
 *      （补回 job:dorm:view / classjh:dorm:view —— 这两个码教务本就在
 *      pagePermissionSource 的 ACAD_STAFF 里持有，只是被 3dfb416 的台账摘掉了）。
 *
 * 【本脚本验证四件事】
 *   ① 静态：menu.ts 已无「教务宿舍」入口；合并域 dorm 仍在；
 *           edu:dorm:view 在 pageRegistry/app.ts 仍登记（页面本身保留给其它角色）；
 *           /api/teaching/dorm 仍只认三个学段码（不含 edu）。
 *   ② 运行时：教务老师登录后 my-pages 含 classjh:dorm:view / job:dorm:view（合并页可见），
 *           且不再含 edu:dorm:view（独立教务宿舍入口消失）。
 *   ③ 运行时：教务老师调 /api/teaching/dorm/list 真闸放行（合并宿舍可达）。
 *   ④ 反证：教务老师调 /api/edu/dorm/list 应被拒（403，教务已无教务宿舍）。
 *
 * 用法（项目根目录执行，后端需在 8004 监听）：
 *   node tools/verify-acad-dorm-menu.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const BASE = 'http://localhost:8004';
const DEMO_PWD = '123456';
const ACAD_ACCOUNT = 'zhengym'; // 教务老师（教务部，模块 edu + class-jh）

let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? '  → ' + detail : ''}`);
  if (!ok) failed += 1;
}

async function req(method, url, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  let j = null;
  const t = await r.text();
  try {
    j = JSON.parse(t);
  } catch {
    /* ignore */
  }
  return { status: r.status, body: j, raw: t };
}

/* ============================================================
 * ① 静态校验
 * ============================================================ */
console.log('=== ① 静态：四处配置是否到位 ===');

const menuSrc = read('web-job/src/config/menu.ts');
const oldEntry = menuSrc.match(
  /\{\s*title:\s*'教务宿舍'[\s\S]{0,400}?path:\s*'\/edu\/dorm'[\s\S]{0,200}?pageCode:\s*'edu:dorm:view'/,
);
check('config/menu.ts 已去掉「教务宿舍」独立入口', !oldEntry);
check('config/menu.ts 仍保留合并域 domainNode(\'dorm\')', /domainNode\('dorm'\)/.test(menuSrc));

const regSrc = read('server-job/src/perm/config/pageRegistry.ts');
const regHit = regSrc.match(/path:\s*'\/edu\/dorm'[\s\S]{0,120}?pageCode:\s*'edu:dorm:view'/);
check('pageRegistry 仍登记 edu:/edu/dorm（页面保留给其它角色）', !!regHit);

const appSrc = read('server-job/src/app.ts');
const mountHit = appSrc.match(
  /app\.use\(\s*'\/api\/edu\/dorm'[\s\S]{0,200}?requirePage\('edu:dorm:view'\)/,
);
check("app.ts 仍挂载 /api/edu/dorm 并挂 requirePage('edu:dorm:view')（页面本身保留）", !!mountHit);

// 合并宿舍页只认三个学段码（不含 edu）—— 这是教务能进合并页、不能进 edu 页的根因
const teachHit = appSrc.match(
  /app\.use\(\s*'\/api\/teaching\/dorm'[\s\S]{0,400}?requireAnyPage\(\[([^\]]+)\]\)/,
);
const teachCodes = teachHit ? teachHit[1] : '';
check(
  '/api/teaching/dorm 的权限码只认三个学段码（不含 edu:dorm:view）',
  !!teachCodes && /classjh:dorm:view/.test(teachCodes) && /job:dorm:view/.test(teachCodes) && !/edu:dorm:view/.test(teachCodes),
  teachCodes.replace(/\s+/g, ' '),
);

/* ============================================================
 * ②~④ 运行时校验
 * ============================================================ */
console.log('\n=== ② 运行时：教务老师登录后的权限码 ===');
const login = await req('POST', '/api/portal/account/login', {
  body: { account: ACAD_ACCOUNT, password: DEMO_PWD },
});
if (login.status !== 200 || !login.body?.data?.token) {
  check(`登录 ${ACAD_ACCOUNT}`, false, `HTTP ${login.status} ${login.raw.slice(0, 120)}`);
  console.log('\n后端未就绪或账号不可用，运行时校验跳过。');
  process.exit(failed ? 1 : 0);
}
const token = login.body.data.token;
check(`登录 ${ACAD_ACCOUNT}（教务老师）`, true, `modules=${JSON.stringify(login.body.data.modules)}`);

const myPages = await req('GET', '/api/job/auth/my-pages', { token });
const perms = myPages.body?.data?.permissions || [];
const stageCodes = ['classjh:dorm:view', 'class:dorm:view', 'job:dorm:view'];
const heldStage = stageCodes.filter((c) => perms.includes(c));
check('拿到 classjh:dorm:view（合并页·初高学段可见，教务已授权 class-jh 模块）', perms.includes('classjh:dorm:view'));
// 注：job:dorm:view 由教务在 pagePermissionSource 持有，但门户未给教务授权 job 模块，
// 被「模块门槛」滤掉 → 合并页只显示初高页签、看不到实训页签（门户级配置，非本任务范围）。
check('至少持有一个合并宿舍学段码（合并页对教务可见）', heldStage.length >= 1, heldStage.join(',') || '无');
check('不再持有 edu:dorm:view（独立教务宿舍入口已消失）', !perms.includes('edu:dorm:view'));

console.log('\n=== ③ 运行时：合并宿舍页真闸放行 ===');
const teach = await req('GET', '/api/teaching/dorm/list', { token });
const teachCode = teach.body?.code;
check(
  'GET /api/teaching/dorm/list 放行（200）',
  teach.status === 200 && (teachCode === 0 || teachCode === 200),
  `HTTP ${teach.status} code=${teachCode ?? '-'}`,
);

console.log('\n=== ④ 反证：独立教务宿舍页对教务应拒绝（403）===');
const edu = await req('GET', '/api/edu/dorm/list', { token });
check(
  'GET /api/edu/dorm/list 被拒（403）',
  edu.status === 403 || (edu.body?.code ?? 0) !== 0,
  `HTTP ${edu.status} code=${edu.body?.code ?? '-'}`,
);

console.log(`\n${failed === 0 ? '✅ 全部通过' : `❌ ${failed} 项未通过`}`);
process.exit(failed ? 1 : 0);
