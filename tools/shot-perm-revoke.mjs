/**
 * 权限树 → 前端按钮 联动「实物取证」截图
 *
 * 目标：证明「管理员在职位权限分配里取消某动作 → 该角色账号页面上按钮真的消失」。
 *
 * 演示对象：
 *   · 角色  JOB_STAFF（就业老师，R10）
 *   · 账号  zhouj（周杰，就业老师，门户 modules=["job"]）
 *   · 页面  /employment-log（就业日志）
 *   · 按钮  「新建就业日志」→ canAct('job:employmentLog:add', true)
 *   · 权限点 job||就业日志||add（权限树勾选态）
 *
 * 流程（全真，走管理员真实保存接口 /api/perm/assign/save，即管理员在界面上的勾选动作）：
 *   ① 截图「撤销前」：zhouj 登录 → 就业日志页，按钮可见
 *   ② 管理员保存：把 R10 的「就业日志」从 [add,edit,view] 改成 [edit,view]（=取消 add）
 *   ③ 截图「撤销后」：zhouj 重新登录 → 同一页，按钮消失
 *   ④ 还原：管理员把权限点恢复原样
 *
 * 用法：node tools/shot-perm-revoke.mjs   （前后端需在跑：8004 + 5173）
 * 产物：docs/v26-*.png
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUTDIR = path.join(ROOT, 'docs');
fs.mkdirSync(OUTDIR, { recursive: true });
const PORT = 9338;
const BASE = 'http://localhost:5173';
const API = 'http://127.0.0.1:8004';
const ROLE_ID = 'R10'; // JOB_STAFF 就业老师
const ACCOUNT = 'zhouj'; // 周杰
const ITEM = 'job||就业日志';
const REMOVE_ACTION = 'add';
const BUTTON_TEXT = '新建就业日志';

const BROWSER = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => fs.existsSync(p));
if (!BROWSER) { console.log('NO BROWSER'); process.exit(1); }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-perm-'));
const child = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
  '--window-size=1680,1050', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws; let msgId = 0; const pending = new Map();

async function getTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* retry */ }
    await sleep(250);
  }
  throw new Error('no target');
}
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    const to = setTimeout(() => reject(new Error('timeout ' + method)), 30000);
    pending.set(id, { resolve, reject, to });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result?.value;
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUTDIR, name), Buffer.from(r.data, 'base64'));
  console.log('  shot: ' + name);
}
async function nav(hash, wait = 2600) {
  await send('Page.navigate', { url: `${BASE}/?t=${Date.now()}#${hash}` });
  await sleep(wait);
}
async function loginAs(account) {
  await ev(`(() => { try { localStorage.clear(); } catch(e){} return true; })()`);
  await nav('/login', 2200);
  await ev(`(() => {
    const items = [...document.querySelectorAll('.demo-item')];
    const el = items.find(x => x.innerText.includes('${account}'));
    if (el) { el.click(); return true; } return false;
  })()`);
  await sleep(500);
  await ev(`(() => { const b = document.querySelector('.submit'); if (b) b.click(); return !!b; })()`);
  await sleep(3400);
}
/** 页面上指定文字的可见按钮是否存在 */
const buttonVisible = (text) => `(() => {
  const bs = [...document.querySelectorAll('button')].filter(b =>
    b.innerText.trim() === '${text}' && b.offsetParent !== null && !b.disabled);
  return bs.length > 0;
})()`;

/* ---------- 后端 API ---------- */
async function apiLogin(account, password = '123456') {
  const r = await fetch(`${API}/api/portal/account/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account, password }),
  });
  const j = await r.json().catch(() => null);
  return j?.data?.token;
}
async function apiCall(token, method, url, body) {
  const r = await fetch(API + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

(async () => {
  ws = new WebSocket(await getTarget());
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.id && pending.has(m.id)) {
      const { resolve, reject, to } = pending.get(m.id);
      clearTimeout(to); pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    }
  };
  await send('Page.enable');
  await send('Runtime.enable');

  /* 管理员拿 token + 当前权限点（用于稍后还原） */
  const adminTok = await apiLogin('admin');
  if (!adminTok) throw new Error('admin 登录失败');
  const tree = await apiCall(adminTok, 'GET', `/api/perm/assign/tree?roleId=${ROLE_ID}`);
  const origPerms = tree.json?.data?.perms || {};
  if (!origPerms[ITEM]) throw new Error('拿不到 ' + ITEM + ' 的权限点');
  const origActions = origPerms[ITEM];
  console.log('R10 就业日志 当前动作: ' + JSON.stringify(origActions));

  /* ============ ① 撤销前 ============ */
  console.log('=== ① 撤销前：zhouj 登录 → 就业日志页 ===');
  await loginAs(ACCOUNT);
  await nav('/employment-log', 3200);
  const beforeVisible = await ev(buttonVisible(BUTTON_TEXT));
  console.log('  按钮「' + BUTTON_TEXT + '」可见 =', beforeVisible);
  await shot('v26-就业日志-撤销前按钮可见.png');

  /* ============ ② 管理员取消「新增」动作 ============ */
  console.log('=== ② 管理员取消 R10「就业日志·新增」 ===');
  const afterActions = origActions.filter((a) => a !== REMOVE_ACTION);
  const newPerms = { ...origPerms, [ITEM]: afterActions };
  const saved = await apiCall(adminTok, 'PUT', '/api/perm/assign/save', { roleId: ROLE_ID, perms: newPerms });
  console.log(`  save http=${saved.status} code=${saved.json?.code} msg=${saved.json?.message || saved.json?.msg || ''}`);
  if (saved.status !== 200 || saved.json?.code !== 200) throw new Error('save 失败');
  await sleep(800);

  /* ============ ③ 撤销后 ============ */
  console.log('=== ③ 撤销后：zhouj 重新登录 → 就业日志页 ===');
  await loginAs(ACCOUNT);
  await nav('/employment-log', 3200);
  const afterVisible = await ev(buttonVisible(BUTTON_TEXT));
  console.log('  按钮「' + BUTTON_TEXT + '」可见 =', afterVisible);
  await shot('v26-就业日志-撤销后按钮消失.png');

  /* 顺带取证：my-pages 的 removedCodes 里应含 job:employmentLog:add */
  const myTok = await apiLogin(ACCOUNT);
  const mp = await apiCall(myTok, 'GET', '/api/job/auth/my-pages');
  const removed = mp.json?.data?.removedCodes || [];
  console.log('  my-pages.removedCodes =', JSON.stringify(removed));

  /* ============ ④ 还原 ============ */
  console.log('=== ④ 还原 R10「就业日志」权限点 ===');
  const restored = await apiCall(adminTok, 'PUT', '/api/perm/assign/save', { roleId: ROLE_ID, perms: origPerms });
  console.log(`  restore http=${restored.status} code=${restored.json?.code}`);
  await sleep(800);

  const ok = beforeVisible === true && afterVisible === false;
  console.log('\n' + (ok ? '✅ 联动取证成功：撤销前可见、撤销后消失' : '❌ 联动失败：before=' + beforeVisible + ' after=' + afterVisible));

  try { await send('Browser.close'); } catch { /* ignore */ }
  child.kill();
  process.exit(ok ? 0 : 1);
})().catch(async (e) => {
  console.log('ERR: ' + (e?.stack || e));
  try { child.kill(); } catch { /* ignore */ }
  process.exit(1);
});
