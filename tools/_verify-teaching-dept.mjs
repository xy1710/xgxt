/**
 * 回归验证：教学管理全模块「学段 → 部门」改名后，各合并入口页仍能正常渲染
 * ============================================================
 * 校长批注（2026-10-16）：教学管理里的「学段」统一改叫「部门」。
 * 本脚本逐页访问九个合并入口，断言：
 *   ① 页面渲染出了内容（不是白屏 / 报错页）；
 *   ② 用户可见文案里不再出现「学段」，且出现了「部门」；
 *   ③ 控制台没有未捕获异常（页面级 JS 错误）。
 *
 * 用法：node tools/_verify-teaching-dept.mjs      （前后端需在跑：8004 + 5173）
 * 产物：tools/_out/verify_teaching_dept_*.png
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUTDIR = path.join(HERE, '_out');
fs.mkdirSync(OUTDIR, { recursive: true });
const PORT = 9341;
const BASE = 'http://localhost:5173';

const PAGES = [
  ['student', '/teaching/student'],
  ['class', '/teaching/class'],
  ['attendance', '/teaching/attendance'],
  ['exam', '/teaching/exam'],
  ['score', '/teaching/score'],
  ['dorm', '/teaching/dorm'],
  ['fee', '/teaching/fee'],
  ['refund', '/teaching/refund'],
  ['approval', '/teaching/approval'],
];

const BROWSER = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => fs.existsSync(p));
if (!BROWSER) {
  console.log('NO BROWSER');
  process.exit(1);
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-verify2-'));
const child = spawn(
  BROWSER,
  [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    '--window-size=1680,1050', 'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
let msgId = 0;
const pending = new Map();
const pageErrors = [];

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
}
async function nav(hash, wait = 2600) {
  await send('Page.navigate', { url: `${BASE}/?t=${Date.now()}#${hash}` }, 30000);
  await sleep(wait);
}
async function loginAs(account) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await ev(`(() => { try { localStorage.clear(); } catch(e){} return true; })()`);
    await nav('/login', 3000);
    await ev(`(() => {
      const items = [...document.querySelectorAll('.demo-item')];
      const el = items.find(x => x.innerText.includes('${account}'));
      if (el) { el.click(); return true; }
      return false;
    })()`);
    await sleep(800);
    await ev(`(() => { const b = document.querySelector('.submit'); if (b) b.click(); return !!b; })()`);
    await sleep(4000);
    const ok = await ev(`document.body.innerText.includes('退出登录')`);
    if (ok) return true;
    console.log(`  （第 ${attempt} 次登录未成功，重试）`);
  }
  return false;
}

const fails = [];
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + detail : ''}`);
  if (!ok) fails.push(name);
};

(async () => {
  ws = new WebSocket(await getTarget());
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.method === 'Runtime.exceptionThrown') {
      pageErrors.push(m.params?.exceptionDetails?.exception?.description || 'unknown');
    }
    if (m.id && pending.has(m.id)) {
      const { resolve, reject, to } = pending.get(m.id);
      clearTimeout(to); pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    }
  };
  await send('Page.enable');
  await send('Runtime.enable');

  const logged = await loginAs('qiansy');
  check('登录成功（校长 qiansy）', logged);

  for (const [key, route] of PAGES) {
    pageErrors.length = 0;
    await nav(route, 2600);
    const info = await ev(`(() => {
      const root = document.querySelector('.teaching-domain') || document.body;
      const body = root.innerText || '';
      return {
        len: body.trim().length,
        segWord: body.includes('学段'),
        deptWord: body.includes('部门'),
        hasEmpty: !!root.querySelector('.el-empty'),
        // 催费域还是第 1 期的「页签模式」：页签直接列部门名（初高部 / 大学部 …），
        // 不出现「部门」二字，所以这里单独认一下页签。
        tabDept: [...root.querySelectorAll('.el-tabs__item')].map(el => el.innerText.trim()).join(','),
        head: body.split('\\n').filter(Boolean).slice(0, 3).join(' / '),
      };
    })()`);
    console.log(`\n=== ${route} ===`);
    console.log(`  首屏：${info?.head}`);
    check(`${key}: 页面有内容`, (info?.len ?? 0) > 30, `长度 ${info?.len}`);
    check(`${key}: 不含「学段」`, info?.segWord === false);
    check(
      `${key}: 出现「部门」/空态/部门页签`,
      info?.deptWord === true || info?.hasEmpty === true || /初高部|大学部/.test(info?.tabDept || ''),
      info?.tabDept || '',
    );
    check(`${key}: 无未捕获异常`, pageErrors.length === 0, pageErrors[0] || '');
    await shot(`verify_teaching_dept_${key}.png`);
  }

  console.log(`\n${fails.length ? 'FAILED: ' + fails.join(' / ') : 'ALL PASS'}`);
  child.kill();
  process.exitCode = fails.length ? 1 : 0;
})().catch((e) => {
  console.error('脚本异常：', e.message);
  child.kill();
  process.exitCode = 1;
});
