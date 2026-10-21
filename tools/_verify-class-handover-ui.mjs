/**
 * 回归验证：班级管理三张批注（2026-10-19）
 * ============================================================
 * ① 操作列：有【交接】，没有【改状态】；
 * ② 编辑班级：【班级状态】挪进来了，选项里没有「待结业」；
 * ③ 阶段方案：编辑回显 + 新增默认选中（不再空着）；
 * ④ 交接弹窗：原负责人自动带出、5 个岗位、新负责人可选（初高只有 3 个）。
 *
 * 本脚本只读，不提交交接（提交链路由 tools/_verify-class-handover-flow.mjs 验证）。
 * 用法：node tools/_verify-class-handover-ui.mjs   （前后端需在跑：8004 + 5173）
 * 产物：tools/_out/verify_handover_*.png
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUTDIR = path.join(HERE, '_out');
fs.mkdirSync(OUTDIR, { recursive: true });
const PORT = 9345;
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

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-handover-'));
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

/** 弹窗里按 label 找 form-item，返回 { value, options } */
const FORM_ITEM = `(label) => {
  const dlg = document.querySelector('.el-dialog');
  if (!dlg) return null;
  const item = [...dlg.querySelectorAll('.el-form-item')]
    .find(it => (it.querySelector('.el-form-item__label')?.innerText || '').trim() === label);
  if (!item) return null;
  return {
    value: item.querySelector('.el-select__wrapper')?.innerText?.trim() || item.querySelector('input')?.value || '',
    inputValue: item.querySelector('input')?.value ?? '',
  };
}`;

function formItem(label) {
  return ev(`(${FORM_ITEM})(${JSON.stringify(label)})`);
}

/** 打开某个下拉并读取选项文本（读完按 Esc 关闭，避免挡住后续点击） */
async function selectOptions(label) {
  const opened = await ev(`(() => {
    const dlg = document.querySelector('.el-dialog');
    if (!dlg) return false;
    const item = [...dlg.querySelectorAll('.el-form-item')]
      .find(it => (it.querySelector('.el-form-item__label')?.innerText || '').trim() === ${JSON.stringify(label)});
    const wrap = item?.querySelector('.el-select__wrapper');
    if (!wrap) return false;
    wrap.click();
    return true;
  })()`);
  if (!opened) return null;
  await sleep(600);
  // ⚠️ Element Plus 把所有用过的下拉都留在 DOM 里（只是 display:none / 尺寸 0），
  //    这里只取「当前打开」那个 popper（宽高 > 0）的选项。
  const opts = await ev(`(() => {
    const poppers = [...document.querySelectorAll('.el-select__popper')]
      .filter(p => p.getBoundingClientRect().width > 0);
    const panel = poppers[poppers.length - 1];
    if (!panel) return [];
    return [...panel.querySelectorAll('.el-select-dropdown__item')].map(x => x.innerText.trim());
  })()`);
  await ev(`(() => { document.body.click(); return true; })()`);
  await sleep(300);
  return opts;
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

  // ① 操作列按钮
  const rowButtons = await ev(`(() => {
    const row = [...document.querySelectorAll('.el-table__row')].find(tr => tr.innerText.includes('U2602'));
    if (!row) return null;
    return [...row.querySelectorAll('button')].map(b => b.innerText.trim()).filter(Boolean);
  })()`);
  check('操作列有【交接】', (rowButtons || []).includes('交接'), JSON.stringify(rowButtons));
  check('操作列没有【改状态】', !(rowButtons || []).includes('改状态'));

  // ② 编辑班级：班级状态 + 阶段方案回显
  const opened = await ev(`(() => {
    const row = [...document.querySelectorAll('.el-table__row')].find(tr => tr.innerText.includes('U2602'));
    const btn = row && [...row.querySelectorAll('button')].find(b => b.innerText.trim() === '编辑');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  await sleep(1500);
  check('打开编辑弹窗', opened === true);

  const statusItem = await formItem('班级状态');
  check('编辑弹窗里有【班级状态】', !!statusItem, JSON.stringify(statusItem));
  check('班级状态回显为「开放」', statusItem?.value === '开放', statusItem?.value);

  const statusOpts = await selectOptions('班级状态');
  check('状态下拉没有「待结业」', !!statusOpts && !statusOpts.includes('待结业'), JSON.stringify(statusOpts));
  // 当前是「开放」→ 只能改成 开放/封班（结业要先封班，这条流转没放宽）
  check('开放班的状态选项为 开放/封班', JSON.stringify(statusOpts) === JSON.stringify(['开放', '封班']), JSON.stringify(statusOpts));

  const planItem = await formItem('阶段方案');
  check('编辑时阶段方案有回显（不是请选择）',
    !!planItem && planItem.value !== '请选择' && planItem.value !== '', planItem?.value);
  await shot('verify_handover_edit_status.png');

  // 关闭编辑弹窗（⚠️ 必须找「可见的那个」弹窗，页面里还留着已关闭弹窗的 DOM）
  await ev(`(() => {
    const dlg = [...document.querySelectorAll('.el-dialog')].find(d => d.offsetParent !== null);
    const btn = dlg && [...dlg.querySelectorAll('.el-dialog__footer button')].find(b => b.innerText.trim() === '取消');
    if (btn) btn.click();
    return !!btn;
  })()`);
  await sleep(900);

  // ③ 新增班级：阶段方案默认选中
  await ev(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.innerText.trim() === '新增班级');
    if (btn) btn.click();
    return !!btn;
  })()`);
  await sleep(1200);
  const planCreate = await formItem('阶段方案');
  check('新增班级时阶段方案默认选中',
    !!planCreate && planCreate.value !== '请选择' && planCreate.value !== '', planCreate?.value);
  await shot('verify_handover_create_default_plan.png');
  await ev(`(() => {
    const dlg = [...document.querySelectorAll('.el-dialog')].find(d => d.offsetParent !== null);
    const btn = dlg && [...dlg.querySelectorAll('.el-dialog__footer button')].find(b => b.innerText.trim() === '取消');
    if (btn) btn.click();
    return !!btn;
  })()`);
  await sleep(900);

  // ④ 交接弹窗结构（大学部 = 5 个岗位）
  const openedH = await ev(`(() => {
    const row = [...document.querySelectorAll('.el-table__row')].find(tr => tr.innerText.includes('U2602'));
    const btn = row && [...row.querySelectorAll('button')].find(b => b.innerText.trim() === '交接');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  await sleep(1200);
  check('打开交接弹窗', openedH === true);
  const ho = await ev(`(() => {
    const dlg = [...document.querySelectorAll('.el-dialog')].find(d => d.innerText.includes('班级交接'));
    if (!dlg) return null;
    return {
      rows: [...dlg.querySelectorAll('.el-table__row')].map(tr => tr.innerText.replace(/\\s+/g, ' ').trim()),
      selects: dlg.querySelectorAll('.el-select').length,
      hasReason: dlg.innerText.includes('交接原因'),
      hasDate: dlg.innerText.includes('交接日期'),
      className: dlg.querySelector('input')?.value || '',
    };
  })()`);
  check('交接弹窗有 5 个岗位（大学部）', (ho?.rows || []).length === 5, JSON.stringify(ho?.rows));
  check('原负责人自动带出班主任「张海涛」',
    (ho?.rows || []).some((r) => r.includes('班主任') && r.includes('张海涛')));
  check('交接弹窗有「交接日期 / 交接原因」', !!ho?.hasDate && !!ho?.hasReason);
  check('每个岗位都有「新负责人」下拉', (ho?.selects || 0) === 5, String(ho?.selects));
  await shot('verify_handover_dialog.png');

  // 初高只展示 3 个岗位（没有项目经理 / 就业老师）
  await ev(`(() => {
    const dlg = [...document.querySelectorAll('.el-dialog')].find(d => d.offsetParent !== null && d.innerText.includes('班级交接'));
    const btn = dlg && [...dlg.querySelectorAll('.el-dialog__footer button')].find(b => b.innerText.trim() === '取消');
    if (btn) btn.click();
    return !!btn;
  })()`);
  await sleep(1000);
  await ev(`(() => {
    const row = [...document.querySelectorAll('.el-table__row')].find(tr => tr.innerText.includes('G2601'));
    const btn = row && [...row.querySelectorAll('button')].find(b => b.innerText.trim() === '交接');
    if (btn) btn.click();
    return !!btn;
  })()`);
  await sleep(1200);
  const hoJh = await ev(`(() => {
    const dlg = [...document.querySelectorAll('.el-dialog')].find(d => d.innerText.includes('班级交接'));
    if (!dlg) return null;
    return [...dlg.querySelectorAll('.el-table__row')].map(tr => tr.innerText.replace(/\\s+/g, ' ').trim());
  })()`);
  check('初高交接只有 3 个岗位', (hoJh || []).length === 3, JSON.stringify(hoJh));
  check('初高交接不含项目经理/就业老师',
    !JSON.stringify(hoJh || []).includes('项目经理') && !JSON.stringify(hoJh || []).includes('就业老师'));
  await shot('verify_handover_jh.png');

  check('无未捕获异常', pageErrors.length === 0, pageErrors[0] || '');

  console.log(`\n${fails.length ? 'FAILED: ' + fails.join(' / ') : 'ALL PASS'}`);
  child.kill();
  process.exitCode = fails.length ? 1 : 0;
})().catch((e) => {
  console.error('脚本异常：', e.message);
  child.kill();
  process.exitCode = 1;
});
