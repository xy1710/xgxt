/**
 * 回归验证：教室字段「楼栋-房间号」格式（2026-10-19 批注）
 * ============================================================
 * 要求（校长批注）：规定格式输出，例如 A-201。
 * 本脚本断言「班级管理 → 编辑班级」里的教室输入框：
 *   ① placeholder 给出了示例 A-201；
 *   ② 输入「教学楼 B-107」失焦后自动归一成「B-107」；
 *   ③ 认不出的写法（如只写 102）失焦后出现格式错误提示；
 *   ④ 改成合规值能正常保存，弹窗关闭（保存失败会留在弹窗里并报错）。
 *
 * 用法：node tools/_verify-classroom-format.mjs   （前后端需在跑：8004 + 5173）
 * 产物：tools/_out/verify_classroom_*.png
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUTDIR = path.join(HERE, '_out');
fs.mkdirSync(OUTDIR, { recursive: true });
const PORT = 9343;
const BASE = 'http://localhost:5173';
const ROW_CLASS = 'U2602';

const BROWSER = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => fs.existsSync(p));
if (!BROWSER) {
  console.log('NO BROWSER');
  process.exit(1);
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-classroom-'));
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
    if (await ev(`document.body.innerText.includes('退出登录')`)) return true;
    console.log(`  （第 ${attempt} 次登录未成功，重试）`);
  }
  return false;
}

/** 在编辑弹窗里找「教室」那项的 input（label 文案可能是 教室 / 教室地点） */
const FIND_INPUT = `(() => {
  const items = [...document.querySelectorAll('.el-dialog .el-form-item')];
  const item = items.find(it => /教室/.test(it.querySelector('.el-form-item__label')?.innerText || ''));
  return item ? item.querySelector('input') : null;
})()`;

/** 给 el-input 赋值（直接改 value 不触发 v-model，必须走原生 setter + input 事件） */
function setInputValue(text) {
  return ev(`(() => {
    const el = ${FIND_INPUT};
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(text)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('blur'));
    return true;
  })()`);
}

function readState() {
  return ev(`(() => {
    const el = ${FIND_INPUT};
    const item = el ? el.closest('.el-form-item') : null;
    return {
      value: el ? el.value : null,
      placeholder: el ? el.placeholder : null,
      error: item ? (item.querySelector('.el-form-item__error')?.innerText || '') : null,
      dialogOpen: !!document.querySelector('.el-dialog'),
    };
  })()`);
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

  check('登录成功（校长 qiansy）', await loginAs('qiansy'));
  await nav('/teaching/class', 3200);

  // 打开目标班级的编辑弹窗
  const opened = await ev(`(() => {
    const row = [...document.querySelectorAll('.el-table__row')].find(tr => tr.innerText.includes('${ROW_CLASS}'));
    if (!row) return 'no-row';
    const btn = [...row.querySelectorAll('button')].find(b => b.innerText.trim() === '编辑');
    if (!btn) return 'no-btn';
    btn.click();
    return 'ok';
  })()`);
  await sleep(1200);
  check(`打开班级 ${ROW_CLASS} 的编辑弹窗`, opened === 'ok', String(opened));

  const initial = await readState();
  check('教室输入框已渲染', initial?.value !== null, `当前值 ${initial?.value}`);
  check('placeholder 给出格式示例', /A-201/.test(initial?.placeholder || ''), initial?.placeholder || '');

  // ② 宽容输入 → 失焦归一
  await setInputValue('教学楼 B-107');
  await sleep(600);
  const normalized = await readState();
  check('「教学楼 B-107」失焦后归一为 B-107', normalized?.value === 'B-107', normalized?.value);
  check('归一后没有格式报错', !normalized?.error, normalized?.error || '');
  await shot('verify_classroom_normalized.png');

  // ③ 认不出的写法 → 报错
  await setInputValue('102');
  await sleep(700);
  const bad = await readState();
  check('「102」被判定为不合规', /格式/.test(bad?.error || ''), bad?.error || '（无错误提示）');
  await shot('verify_classroom_invalid.png');

  // ④ 改回合规值并保存
  await setInputValue('A-102');
  await sleep(600);
  const ready = await readState();
  check('改回合规值后错误消失', !ready?.error, ready?.error || '');

  const saved = await ev(`(() => {
    const footer = [...document.querySelectorAll('.el-dialog__footer button')];
    const btn = footer.find(b => b.innerText.trim() === '保存');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  await sleep(2500);
  const after = await readState();
  check('点击保存后弹窗关闭', saved === true && after?.dialogOpen === false);
  await shot('verify_classroom_saved.png');

  check('无未捕获异常', pageErrors.length === 0, pageErrors[0] || '');

  console.log(`\n${fails.length ? 'FAILED: ' + fails.join(' / ') : 'ALL PASS'}`);
  child.kill();
  process.exitCode = fails.length ? 1 : 0;
})().catch((e) => {
  console.error('脚本异常：', e.message);
  child.kill();
  process.exitCode = 1;
});
