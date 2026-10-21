/**
 * 回归验证：「学段 → 部门」批注（2026-10-16）
 * ============================================================
 * 用 headless 浏览器真实打开 教学管理 · 学生档案（校长 qiansy），断言：
 *   ① 说明条、筛选标签都是「部门」，不再出现「学段」；
 *   ② 列表里学生显示的是部门名（大学部），不是「大学」；
 *   ③ 「部门」下拉展开后是 初高部 / 大学部；
 *   ④ 选「大学部」/「初高部」各查一次，条数不同（筛选生效）。
 *
 * 用法：node tools/_verify-student-dept.mjs        （前后端需在跑：8004 + 5173）
 * 产物：tools/_out/verify_student_dept_*.png
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUTDIR = path.join(HERE, '_out');
fs.mkdirSync(OUTDIR, { recursive: true });
const PORT = 9339;
const BASE = 'http://localhost:5173';

const BROWSER = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => fs.existsSync(p));
if (!BROWSER) {
  console.log('NO BROWSER');
  process.exit(1);
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-verify-'));
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
  await send('Page.navigate', { url: `${BASE}/?t=${Date.now()}#${hash}` }, 30000);
  await sleep(wait);
}
async function loginAs(account) {
  await ev(`(() => { try { localStorage.clear(); } catch(e){} return true; })()`);
  await nav('/login', 2200);
  await ev(`(() => {
    const items = [...document.querySelectorAll('.demo-item')];
    const el = items.find(x => x.innerText.includes('${account}'));
    if (el) { el.click(); return true; }
    return false;
  })()`);
  await sleep(500);
  await ev(`(() => { const b = document.querySelector('.submit'); if (b) b.click(); return !!b; })()`);
  await sleep(3400);
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
    if (m.id && pending.has(m.id)) {
      const { resolve, reject, to } = pending.get(m.id);
      clearTimeout(to); pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    }
  };
  await send('Page.enable');
  await send('Runtime.enable');

  await loginAs('qiansy');
  await nav('/teaching/student', 3000);

  const text = () => `document.body.innerText`;

  /* ① 文案：不再出现「学段」 */
  const body = await ev(text());
  check('页面不含「学段」字样', !body.includes('学段'));
  check('筛选标签是「部门」', body.includes('部门'));
  check('说明条已改为部门口径', body.includes('初高部 / 大学部'));

  /* ② 列表里的部门名 */
  const firstRow = await ev(
    `(() => { const r = document.querySelector('.el-table__row'); return r ? r.innerText.replace(/\\n/g,' | ') : ''; })()`,
  );
  check('列表首行显示部门名（初高部 / 大学部）', /初高部|大学部/.test(firstRow), firstRow);
  await shot('verify_student_dept_list.png');

  /* ③ 部门下拉选项 */
  await ev(`(() => {
    const items = [...document.querySelectorAll('.el-form-item')];
    const it = items.find(x => x.innerText.trim().startsWith('部门'));
    const inp = it && it.querySelector('.el-select');
    if (inp) { inp.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; }
    return false;
  })()`);
  await sleep(700);
  const opts = await ev(
    `[...document.querySelectorAll('.el-select-dropdown__item')].map(e => e.innerText.trim()).join(',')`,
  );
  check('部门下拉含 初高部 / 大学部', /初高部/.test(opts) && /大学部/.test(opts), opts);
  await shot('verify_student_dept_options.png');

  /* ④ 选「大学部」/「初高部」各查一次
   *
   * ⚠️ 2026-10-16 改成【与数据量无关】的断言：
   *   原来写死「大学部 = 1 条 / 初高部 = 0 条」，那是早期「演示库里只有 1 条学生」的
   *   快照。后来演示库用 seed:all 重建（32 名学生、两个部门都有），这两条断言必然红，
   *   但那不是功能坏了。现在只验「筛选确实生效」：两边都能查出数、且条数不同。 */
  const pick = (label) => `(() => {
    const el = [...document.querySelectorAll('.el-select-dropdown__item')].find(e => e.innerText.trim() === '${label}');
    if (!el) return 'not-found';
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return 'ok';
  })()`;
  const search = `(() => {
    const bs = [...document.querySelectorAll('button')].filter(b => b.innerText.trim() === '查询' && b.offsetParent !== null);
    if (bs.length) { bs[0].click(); return 'clicked'; }
    return 'not-found';
  })()`;
  const totalText = `document.body.innerText.match(/共\\s*(\\d+)\\s*条/)?.[1] ?? '?'`;
  const totalOf = async () => {
    const t = await ev(totalText);
    return t === '?' ? -1 : Number(t);
  };

  check('选中 大学部', (await ev(pick('大学部'))) === 'ok');
  await sleep(300);
  await ev(search);
  await sleep(1600);
  const uniTotal = await totalOf();
  console.log('    大学部筛选结果条数：' + uniTotal);

  /* 重开下拉选「初高部」 */
  await ev(`(() => {
    const items = [...document.querySelectorAll('.el-form-item')];
    const it = items.find(x => x.innerText.trim().startsWith('部门'));
    const inp = it && it.querySelector('.el-select');
    if (inp) { inp.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; }
    return false;
  })()`);
  await sleep(700);
  check('选中 初高部', (await ev(pick('初高部'))) === 'ok');
  await sleep(300);
  await ev(search);
  await sleep(1600);
  const jhTotal = await totalOf();
  console.log('    初高部筛选结果条数：' + jhTotal);

  check('部门筛选能查出数据（两个部门合计 > 0）', uniTotal + jhTotal > 0, `大学部 ${uniTotal} / 初高部 ${jhTotal}`);
  check('两个部门的筛选结果不同（筛选确实生效）', uniTotal !== jhTotal, `大学部 ${uniTotal} / 初高部 ${jhTotal}`);
  await shot('verify_student_dept_filter_jh.png');

  console.log(`\n${fails.length ? 'FAILED: ' + fails.join(' / ') : 'ALL PASS'}`);
  child.kill();
  process.exitCode = fails.length ? 1 : 0;
})().catch((e) => {
  console.error('脚本异常：', e.message);
  child.kill();
  process.exitCode = 1;
});
