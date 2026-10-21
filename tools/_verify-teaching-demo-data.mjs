/**
 * 回归验证：教学管理各页面的演示数据是否都出得来（2026-10-16 演示数据补齐）
 * ============================================================
 * 用 headless 浏览器以校长身份逐页打开「教学管理」的合并入口，断言：
 *   · 页面有内容、没有未捕获异常；
 *   · 列表里至少有 1 行数据（学生 / 班级 / 出勤 / 考试 / 成绩 / 宿舍 / 催费 / 退费 / 休学审批）；
 *   · 顺手截图，人工核对用。
 *
 * 用法：node tools\_verify-teaching-demo-data.mjs     （前后端需在跑：8004 + 5173）
 * 产物：tools/_out/demo_<域>.png
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUTDIR = path.join(HERE, '_out');
fs.mkdirSync(OUTDIR, { recursive: true });
const PORT = 9353;
const BASE = 'http://localhost:5173';

const PAGES = [
  ['student', '/teaching/student', '学生档案'],
  ['class', '/teaching/class', '班级管理'],
  ['attendance', '/teaching/attendance', '出勤管理'],
  ['exam', '/teaching/exam', '考试管理'],
  ['score', '/teaching/score', '成绩管理'],
  ['dorm', '/teaching/dorm', '宿舍管理'],
  ['fee', '/teaching/fee', '催费'],
  ['refund', '/teaching/refund', '退费'],
  ['approval', '/teaching/approval', '休学 / 退学审批'],
];

const BROWSER = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => fs.existsSync(p));
if (!BROWSER) { console.log('NO BROWSER'); process.exit(1); }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-demo-'));
const child = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
  '--window-size=1680,1050', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws; let msgId = 0; const pending = new Map();
const pageErrors = [];

async function getTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const page = (await r.json()).find((t) => t.type === 'page');
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
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUTDIR, name), Buffer.from(r.data, 'base64'));
}
async function nav(hash, wait = 2800) {
  await send('Page.navigate', { url: `${BASE}/?t=${Date.now()}#${hash}` }, 30000);
  await sleep(wait);
}
async function loginAs(account) {
  await ev(`(() => { try { localStorage.clear(); } catch(e){} return true; })()`);
  await nav('/login', 2200);
  await ev(`(() => { const el=[...document.querySelectorAll('.demo-item')].find(x=>x.innerText.includes('${account}')); if(el) el.click(); return !!el; })()`);
  await sleep(500);
  await ev(`(() => { const b=document.querySelector('.submit'); if(b) b.click(); return !!b; })()`);
  await sleep(3400);
}

const fails = [];
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + detail : ''}`);
  if (!ok) fails.push(name);
};

/** 页面里可见的数据行数（Element Plus 表格 + 卡片式列表都用 .el-table__row） */
const ROWS = `(() => {
  const t = [...document.querySelectorAll('.el-table__row')].filter(r => r.offsetParent !== null);
  return t.length;
})()`;

/** 等列表出数（首屏接口慢时会数到 0，最多等 8 秒再判失败） */
async function waitRows(timeout = 8000) {
  const t0 = Date.now();
  let n = 0;
  while (Date.now() - t0 < timeout) {
    n = (await ev(ROWS)) || 0;
    if (n > 0) return n;
    await sleep(500);
  }
  return n;
}

(async () => {
  ws = new WebSocket(await getTarget());
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params?.exceptionDetails?.exception?.description || 'unknown');
    if (m.id && pending.has(m.id)) {
      const { resolve, reject, to } = pending.get(m.id);
      clearTimeout(to); pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    }
  };
  await send('Page.enable'); await send('Runtime.enable');
  await loginAs('qiansy');

  for (const [key, route, title] of PAGES) {
    pageErrors.length = 0;
    await nav(route, 3000);
    const rows = await waitRows();
    const txt = await ev(`(document.querySelector('.teaching-domain')||document.body).innerText.slice(0,120).replace(/\\n/g,' / ')`);
    console.log(`\n=== ${title} (${route}) ===`);
    console.log(`  ${txt}`);
    check(`${title}：列表有数据（${rows} 行）`, rows > 0, `行数 ${rows}`);
    check(`${title}：无未捕获异常`, pageErrors.length === 0, pageErrors[0] || '');
    await shot(`demo_${key}.png`);
  }

  console.log(`\n${fails.length ? 'FAILED: ' + fails.join(' / ') : 'ALL PASS'}`);
  child.kill();
  process.exitCode = fails.length ? 1 : 0;
})().catch((e) => { console.error('脚本异常：', e.message); child.kill(); process.exitCode = 1; });
