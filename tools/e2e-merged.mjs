/**
 * 合并前端 E2E（CDP，零依赖 —— 只用本机已装的 Edge/Chrome）
 *  场景A admin（系统管理员）→ 三个门户模块 + 就业/教务/班级/初高 全部可见，页面权限 > 0
 *  场景B zhangls（市场咨询·模块负责人）→ 只有「市场咨询」组，看不到财务/权限/就业/教务/班级，
 *          且越权访问 /finance/* 会被拦回自己模块
 *  场景C zhengym（教务老师）→ ★ 2026-10-05 新增：能登录，只看到「教务管理」+「就业管理」
 *          （催费入口），且 /fee-call、/edu/dorm、/edu/student 都能打开
 *  场景D sunmin（初高班主任）→ ★ 2026-10-05 新增：只挂 class-jh → 只看得到
 *          「教学管理（初高）」组，看不到大学部「班级管理」，能打开初高页面
 *  场景E zhanght（大学部班主任）→ ★ 两套班级模块【隔离】：角色虽给了初高页面码，
 *          但模块没授权 → 菜单里没有「教学管理（初高）」，直连 /class-jh/* 会被守卫拦走
 *  外加：登录页渲染、22 条路由扫页、控制台错误/异常
 * 用法（在任意目录均可）：node tools/e2e-merged.mjs
 * 前提：前后端已起来（一键启动.bat），5173/8004 监听中
 * 产物：全部落在脚本同级的 tools/_out/ 下（report + png），不污染项目根目录
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 产物固定落在脚本同级的 _out/，这样在哪儿执行都不会把文件丢到项目根目录
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUTDIR = path.join(HERE, '_out');
fs.mkdirSync(OUTDIR, { recursive: true });

const OUT = path.join(OUTDIR, 'e2e-report.txt');
fs.writeFileSync(OUT, '');
const log = (s) => {
  const line = typeof s === 'string' ? s : JSON.stringify(s);
  fs.appendFileSync(OUT, line + '\r\n');
  console.log(line);
};
process.on('uncaughtException', (e) => log('UNCAUGHT: ' + (e?.stack || e)));
process.on('unhandledRejection', (e) => log('UNHANDLED: ' + (e?.stack || e)));

const PORT = 9334;
const BASE = 'http://localhost:5173';

const CAND = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];
const BROWSER = CAND.find((p) => fs.existsSync(p));
if (!BROWSER) { log('NO BROWSER FOUND'); process.exit(1); }
log('browser: ' + BROWSER);

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-e2e-'));
const child = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
  '--window-size=1680,1050', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = list.find((t) => t.type === 'page');
      if (p?.webSocketDebuggerUrl) return p.webSocketDebuggerUrl;
    } catch { /* retry */ }
    await sleep(300);
  }
  throw new Error('no page target');
}

let ws; let msgId = 0; const pending = new Map();
let consoleErrors = []; let exceptions = [];

function send(method, params = {}, t = 25000) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => { pending.delete(id); reject(new Error('timeout ' + method)); }, t);
    pending.set(id, { resolve, reject, to });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function ev(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return { error: r.exceptionDetails.text };
  return { value: r.result?.value };
}
async function shot(name) {
  try {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    if (r?.data) { fs.writeFileSync(path.join(OUTDIR, name), Buffer.from(r.data, 'base64')); log('screenshot: ' + name); }
  } catch (e) { log('shot fail ' + name + ': ' + e.message); }
}
async function nav(hash, wait = 2300) {
  await send('Page.navigate', { url: `${BASE}/?t=${Date.now()}#${hash}` }, 30000);
  await sleep(wait);
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' :: ' + detail : ''}`);
}

async function loginAs(account) {
  // ⚠️ 先清 localStorage：E2E 复用同一个浏览器页，Pinia 是内存态，
  //    只改 localStorage 不重载的话，上一个账号的页面权限会残留。
  //    （真实用户是「退出登录 → 重新登录」，portalLogout() 会重置这些状态，已单独验证）
  await ev(`(() => { try { localStorage.clear(); } catch(e){} return true; })()`);
  await nav('/login');
  const clicked = await ev(`(() => {
    const items = [...document.querySelectorAll('.demo-item')];
    const el = items.find(x => x.innerText.includes('${account}'));
    if (el) el.click();
    return !!el;
  })()`);
  await sleep(400);
  await ev(`(() => { const b = document.querySelector('.submit'); if (b) b.click(); return !!b; })()`);
  await sleep(3200);
  return clicked.value;
}

const menuProbe = `(() => ({
  hash: location.hash,
  groups: [...document.querySelectorAll('.side-menu .el-sub-menu__title .menu-title')].map(e=>e.innerText),
  permTag: (document.querySelector('.perm-tag')||{}).innerText || '',
  topUser: (document.querySelector('.header-user span')||{}).innerText || '',
}))()`;

(async () => {
  ws = new WebSocket(await getTarget());
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.id && pending.has(m.id)) {
      const { resolve, reject, to } = pending.get(m.id);
      clearTimeout(to); pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      return;
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErrors.push((m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 240));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      exceptions.push((m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '').slice(0, 240));
    }
  };
  await send('Page.enable');
  await send('Runtime.enable');

  // ---------- 场景 A：admin ----------
  log('\n=== 场景A：admin（系统管理员）===');
  await nav('/login');
  let p = await ev(`(() => ({ hasLogin: !!document.querySelector('.login-card'), demo: document.querySelectorAll('.demo-item').length, brand:(document.querySelector('.brand-pane h1')||{}).innerText||'' }))()`);
  // ⚠️ 演示账号个数会随联调增减（2026-10-05 加了 就业/教务/班级 5 个角色 → 7+5=12），
  //    所以这里只断言「至少有原来那 7 个」，别把具体数字写死。
  check('登录页正常渲染', !!p.value?.hasLogin && Number(p.value.demo) >= 7, JSON.stringify(p.value));
  await shot('_e2e_01_login.png');

  consoleErrors = []; exceptions = [];
  await loginAs('admin');
  p = await ev(menuProbe);
  const gA = p.value?.groups || [];
  log('  ' + JSON.stringify(p.value));
  await shot('_e2e_02_admin_dashboard.png');
  check('admin 登录后落地到首页工作台', p.value?.hash === '#/', p.value?.hash);
  check('admin 看到 市场咨询/财务管理/权限管理', ['市场咨询', '财务管理', '权限管理'].every((x) => gA.includes(x)), JSON.stringify(gA));
  check('admin 看到 就业管理/教务管理/班级管理', ['就业管理', '教务管理', '班级管理'].every((x) => gA.includes(x)), JSON.stringify(gA));
  check('admin 看到 教学管理（初高）', gA.includes('教学管理（初高）'), JSON.stringify(gA));
  check('admin 顶栏页面权限数 > 0', parseInt((p.value?.permTag || '0'), 10) > 0, p.value?.permTag);
  check('admin 顶栏显示姓名', p.value?.topUser === '系统管理员', p.value?.topUser);

  // admin 路由扫页
  const routes = [
    '/consult/student', '/consult/fee', '/consult/approve', '/consult/refund', '/consult/loss',
    '/finance/overview', '/finance/fee', '/finance/refund', '/finance/freeze', '/finance/bill', '/finance/standard',
    '/perm/overview', '/perm/dept', '/perm/role', '/perm/user', '/perm/assign', '/perm/rule', '/perm/log',
    '/exam', '/class/roster', '/edu/student', '/class-jh/dashboard',
  ];
  log('\n  --- admin 路由扫页 ---');
  let empties = [];
  for (const r of routes) {
    await nav(r);
    const res = await ev(`(() => {
      const main=document.querySelector('.main'); const txt=main?main.innerText:'';
      const body=document.body.innerText||'';
      return { hash: location.hash, chars: txt.length, rows: main?main.querySelectorAll('.el-table__row, tr').length:0,
               noPerm: body.includes('无访问权限'), head: txt.replace(/\\s+/g,' ').slice(0,70) };
    })()`);
    const v = res.value || {};
    if (v.chars < 60 || v.noPerm) empties.push(r + JSON.stringify(v));
    log(`    ${r} chars=${v.chars} rows=${v.rows} noPerm=${v.noPerm}`);
  }
  check('admin 全部 22 个路由都能渲染内容', empties.length === 0, empties.join(' | '));

  // ---------- 场景 B：zhangls（市场咨询）----------
  log('\n=== 场景B：zhangls（市场咨询 · 模块负责人）===');
  await loginAs('zhangls');
  p = await ev(menuProbe);
  const gB = p.value?.groups || [];
  log('  ' + JSON.stringify(p.value));
  await shot('_e2e_03_consult_dashboard.png');
  check('zhangls 只看到「市场咨询」组', gB.length === 1 && gB[0] === '市场咨询', JSON.stringify(gB));
  check('zhangls 顶栏显示姓名', p.value?.topUser === '张老师', p.value?.topUser);

  // zhangls 访问财务模块页 → 应被守卫拦到有权限的页（不是白屏/无权限）
  await nav('/finance/overview');
  const guard = await ev(`(() => ({ hash: location.hash, hasLogin: !!document.querySelector('.login-card') }))()`);
  log('  访问 /finance/overview 后落点: ' + JSON.stringify(guard.value));
  check('zhangls 越权访问财务页被拦回自己模块', guard.value?.hash && !guard.value.hash.includes('finance'), guard.value?.hash);

  // ---------- 场景 C：zhengym（教务老师）----------
  //   ★ 2026-10-05 方案A：教务/班级账号纳入门户注册表后应能登录，
  //     并且要能看到「教务管理」+「催费管理」（催费入口是本次新增的，见 pagePermissionSource.ts）。
  log('\n=== 场景C：zhengym（教务老师）===');
  consoleErrors = []; exceptions = [];
  await loginAs('zhengym');
  p = await ev(menuProbe);
  const gC = p.value?.groups || [];
  log('  ' + JSON.stringify(p.value));
  await shot('_e2e_04_edu_dashboard.png');
  check('zhengym 登录后落地到首页工作台', p.value?.hash === '#/', p.value?.hash);
  check('zhengym 看到「教务管理」组', gC.includes('教务管理'), JSON.stringify(gC));
  check('zhengym 看到「就业管理」组（催费入口所在）', gC.includes('就业管理'), JSON.stringify(gC));
  check(
    'zhengym 看不到无关模块（咨询/财务/权限/班级）',
    !['市场咨询', '财务管理', '权限管理', '班级管理'].some((x) => gC.includes(x)),
    JSON.stringify(gC),
  );
  check('zhengym 顶栏显示姓名', p.value?.topUser === '郑一鸣', p.value?.topUser);

  for (const r of ['/fee-call', '/edu/dorm', '/edu/student']) {
    await nav(r);
    const res = await ev(`(() => {
      const main=document.querySelector('.main'); const txt=main?main.innerText:'';
      return { hash: location.hash, chars: txt.length, noPerm: (document.body.innerText||'').includes('无访问权限'),
               head: txt.replace(/\\s+/g,' ').slice(0,60) };
    })()`);
    const v = res.value || {};
    log(`    ${r} → ${v.hash} chars=${v.chars} noPerm=${v.noPerm} | ${v.head}`);
    check(`zhengym 能打开 ${r}`, v.chars >= 60 && !v.noPerm && String(v.hash).includes(r), JSON.stringify(v));
  }
  await shot('_e2e_05_edu_feecall.png');

  // ---------- 场景 D：sunmin（初高班主任）----------
  //   ★ 2026-10-05：教学管理（初高）并入后新增。sunmin 只挂 class-jh 模块，
  //     应只看得到「教学管理（初高）」组，且能打开初高页面。
  log('\n=== 场景D：sunmin（初高班主任 · 只挂 class-jh）===');
  consoleErrors = []; exceptions = [];
  await loginAs('sunmin');
  p = await ev(menuProbe);
  const gD = p.value?.groups || [];
  log('  ' + JSON.stringify(p.value));
  await shot('_e2e_06_jh_dashboard.png');
  check('sunmin 登录后落地到首页工作台', p.value?.hash === '#/', p.value?.hash);
  check('sunmin 看到「教学管理（初高）」组', gD.includes('教学管理（初高）'), JSON.stringify(gD));
  check('sunmin 看不到大学部「班级管理」组', !gD.includes('班级管理'), JSON.stringify(gD));
  check(
    'sunmin 看不到无关模块（咨询/财务/权限/就业/教务）',
    !['市场咨询', '财务管理', '权限管理', '就业管理', '教务管理'].some((x) => gD.includes(x)),
    JSON.stringify(gD),
  );
  check('sunmin 顶栏显示姓名', p.value?.topUser === '孙敏', p.value?.topUser);

  for (const r of ['/class-jh/student', '/class-jh/class']) {
    await nav(r);
    const res = await ev(`(() => {
      const main=document.querySelector('.main'); const txt=main?main.innerText:'';
      return { hash: location.hash, chars: txt.length, noPerm: (document.body.innerText||'').includes('无访问权限'),
               head: txt.replace(/\\s+/g,' ').slice(0,60) };
    })()`);
    const v = res.value || {};
    log(`    ${r} → ${v.hash} chars=${v.chars} noPerm=${v.noPerm} | ${v.head}`);
    check(`sunmin 能打开 ${r}`, v.chars >= 60 && !v.noPerm && String(v.hash).includes(r), JSON.stringify(v));
  }
  // ★ 2026-10-16 工作台迁到系统首页：旧工作台路由重定向到首页工作台（'/'）
  await nav('/class-jh/dashboard');
  const wb = await ev(`(() => {
    const main=document.querySelector('.main'); const txt=main?main.innerText:'';
    return { hash: location.hash, chars: txt.length,
             hasTitle: txt.includes('工作台'), hasEntry: txt.includes('快捷入口') };
  })()`);
  log(`    /class-jh/dashboard（重定向） → ${JSON.stringify(wb.value)}`);
  check('sunmin 直连旧工作台路由落到首页工作台',
    wb.value?.hash === '#/' && Number(wb.value?.chars) >= 60 && !!wb.value?.hasTitle,
    JSON.stringify(wb.value));
  await shot('_e2e_07_jh_student.png');

  // ---------- 场景 E：zhanght（大学部班主任）↔ 两套班级模块隔离 ----------
  //   ★ 关键回归：大学部班主任的角色（TEACH_HEAD）同时拥有 class:* 与 classjh:* 页面码，
  //     但账号只授权了 class 模块 —— 菜单不该出现「教学管理（初高）」，
  //     直连初高页面也应被守卫拦回自己模块。
  log('\n=== 场景E：zhanght（大学部班主任 · 只挂 class）===');
  await loginAs('zhanght');
  p = await ev(menuProbe);
  const gE = p.value?.groups || [];
  log('  ' + JSON.stringify(p.value));
  await shot('_e2e_08_class_dashboard.png');
  check('zhanght 看到大学部「班级管理」组', gE.includes('班级管理'), JSON.stringify(gE));
  check('zhanght 看不到「教学管理（初高）」（角色有页面码但模块未授权）', !gE.includes('教学管理（初高）'), JSON.stringify(gE));

  await nav('/class-jh/student');
  const iso = await ev(`(() => ({ hash: location.hash }))()`);
  log('  zhanght 直连 /class-jh/student 后落点: ' + JSON.stringify(iso.value));
  check('zhanght 直连初高页被拦（落点不在初高模块）', !String(iso.value?.hash || '').includes('/class-jh'), iso.value?.hash);

  log('\n=== 控制台错误 / 异常 ===');
  log('consoleErrors(' + consoleErrors.length + '): ' + JSON.stringify(consoleErrors.slice(0, 10)));
  log('exceptions(' + exceptions.length + '): ' + JSON.stringify(exceptions.slice(0, 10)));
  check('无控制台错误', consoleErrors.length === 0, JSON.stringify(consoleErrors.slice(0, 3)));
  check('无未捕获异常', exceptions.length === 0, JSON.stringify(exceptions.slice(0, 3)));

  const failed = results.filter((r) => !r.ok);
  log('\n=== 汇总 ===');
  log(`PASS ${results.length - failed.length}/${results.length}`);
  failed.forEach((f) => log('  FAILED: ' + f.name + ' :: ' + f.detail));

  try { await send('Browser.close'); } catch { /* ignore */ }
  child.kill();
  process.exit(failed.length ? 1 : 0);
})();
