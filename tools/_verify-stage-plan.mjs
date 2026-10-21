/**
 * 阶段方案改版 · 界面回归（CDP 直连本机 Edge/Chrome，零依赖）
 *
 * 覆盖 2026-10-16 的三项：
 *   ① 系统设置 → 「阶段方案」页签（列 = 序号/方案名称/所属部门/操作）+ 新增方案弹窗（多阶段）
 *   ② 班级管理 → 新增班级（部门 → 阶段方案 → 阶段 联动）
 *   ③ 学生档案 → 新增学生（选班级后 部门/阶段 自动跟随）
 *
 * 用法：node tools/_verify-stage-plan.mjs     （前后端需在跑：8004 + 5173）
 * 产物：tools/_out/*.png
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

const BROWSER = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => fs.existsSync(p));
if (!BROWSER) {
  console.log('NO BROWSER');
  process.exit(1);
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-plan-'));
const child = spawn(
  BROWSER,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile,
    '--window-size=1680,1050',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
let msgId = 0;
const pending = new Map();
let failed = 0;

function check(name, ok, extra = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed += 1;
}

async function getTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* retry */
    }
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
async function nav(hash, wait = 2800) {
  await send('Page.navigate', { url: `${BASE}/?t=${Date.now()}#${hash}` }, 30000);
  await sleep(wait);
}
async function loginAs(account = 'qiansy') {
  await ev(`(() => { try { localStorage.clear(); } catch(e){} return true; })()`);
  await nav('/login', 2400);
  await ev(`(() => {
    const items = [...document.querySelectorAll('.demo-item')];
    const el = items.find(x => x.innerText.includes('${account}'));
    if (el) { el.click(); return true; }
    return false;
  })()`);
  await sleep(600);
  await ev(`(() => { const b = document.querySelector('.submit'); if (b) b.click(); return !!b; })()`);
  await sleep(3600);
  const ok = await ev(`document.body.innerText.includes('退出登录')`);
  check('登录成功（页面出现「退出登录」）', !!ok);
}

/** 点击按钮（按文本，可限定在某个弹窗/容器内） */
const clickByText = (text, scopeSel) => `(() => {
  const scope = ${scopeSel ? `document.querySelector(${JSON.stringify(scopeSel)})` : 'document'};
  if (!scope) return 'no-scope';
  const els = [...scope.querySelectorAll('button, .el-button, .el-tabs__item, .el-link')]
    .filter(b => b.innerText.trim() === ${JSON.stringify(text)} && b.offsetParent !== null && !b.disabled);
  if (els.length) { els[0].click(); return 'ok'; }
  return 'not-found';
})()`;

/**
 * 打开弹窗里某个表单项的下拉框
 * ⚠️ Element Plus 2.6 的单选下拉是点在 `.el-select__wrapper` 上才展开
 *    （点外层 .el-select 不会开），所以必须发一整套 mousedown/mouseup/click。
 */
/** 找弹窗里某个表单项（label 精确相等，避免「阶段」误配到「阶段方案」） */
const findItem = (labelText) => `(() => {
  const items = [...document.querySelectorAll('.el-dialog .el-form-item')];
  const label = (x) => (x.querySelector('.el-form-item__label')?.innerText || '').trim();
  return items.find(x => label(x) === ${JSON.stringify(labelText)}) || items.find(x => label(x).startsWith(${JSON.stringify(labelText)})) || null;
})()`;

const openSelect = (labelText) => `(() => {
  const it = ${findItem(labelText)};
  if (!it) return 'no-item';
  const w = it.querySelector('.el-select__wrapper') || it.querySelector('.el-select');
  if (!w) return 'no-wrapper';
  ['mousedown','mouseup','click'].forEach(t => w.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true })));
  return 'ok';
})()`;

/** 在读「当前可见的」下拉浮层里选一项 */
const pickVisibleOption = (match) => `(() => {
  const drops = [...document.querySelectorAll('.el-select-dropdown')].filter(d => d.offsetParent !== null);
  const d = drops[drops.length - 1];
  if (!d) return 'no-drop';
  const opts = [...d.querySelectorAll('.el-select-dropdown__item')];
  const opt = ${match ? `opts.find(x => x.innerText.includes(${JSON.stringify(match)}))` : 'opts[0]'};
  if (!opt) return 'no-opt:' + opts.map(x => x.innerText.trim()).join('|');
  ['mousedown','mouseup','click'].forEach(t => opt.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true })));
  return 'ok:' + opt.innerText.trim();
})()`;

/** 当前可见下拉浮层里的全部选项文本 */
const visibleOptions = () => `(() => {
  const drops = [...document.querySelectorAll('.el-select-dropdown')].filter(d => d.offsetParent !== null);
  const d = drops[drops.length - 1];
  if (!d) return '';
  return [...d.querySelectorAll('.el-select-dropdown__item')].map(x => x.innerText.trim()).join('|');
})()`;

/** 读弹窗里某表单项当前显示的文本 */
const readFormItem = (labelText) => `(() => {
  const it = ${findItem(labelText)};
  if (!it) return '(无此项)';
  const sel = it.querySelector('.el-select');
  const txt = (sel ? sel.innerText : '').replace(/\\s+/g, ' ').trim();
  return txt;
})()`;

const bodyText = () => `document.body.innerText`;

/* ============================================================
 * ① 系统设置 → 阶段方案
 * ============================================================ */
await wsInit();
async function wsInit() {
  const url = await getTarget();
  ws = new globalThis.WebSocket(url);
  await new Promise((res) => (ws.onopen = res));
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (!msg.id) return;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.to);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
  };
  await send('Page.enable');
  await send('Runtime.enable');
}

console.log('\n【1】系统设置 → 阶段方案');
await loginAs('qiansy');
await nav('/class-jh/setting', 3200);
check('默认页签是「系统设置」', (await ev(bodyText())).includes('保存设置'));

const tabClick = await ev(clickByText('阶段方案'));
check('找到「阶段方案」页签', tabClick === 'ok');
await sleep(1600);

const t1 = await ev(bodyText());
check('页面名称为「阶段方案」', t1.includes('阶段方案'));
check('表头含 序号/方案名称/所属部门/操作', ['序号', '方案名称', '所属部门', '操作'].every((s) => t1.includes(s)));
check('不再出现「阶段字典 / 阶段编码」', !t1.includes('阶段字典') && !t1.includes('阶段编码'));
check('列表里有「初高部阶段方案」', t1.includes('初高部阶段方案'));
check('操作列有 编辑 / 删除', t1.includes('编辑') && t1.includes('删除'));
await shot('plan-01-list.png');

const openAdd = await ev(clickByText('新增方案'));
check('找到「新增方案」按钮', openAdd === 'ok');
await sleep(900);
const dlg1 = await ev(bodyText());
check('弹窗标题为「新增方案」', dlg1.includes('新增方案'));
check('弹窗字段：方案名称 / 所属部门 / 阶段明细', ['方案名称', '所属部门', '阶段明细'].every((s) => dlg1.includes(s)));
check('有「添加阶段名称」', dlg1.includes('添加阶段名称'));
check('有示例说明文案', dlg1.includes('一个方案可包含多个阶段'));
await shot('plan-02-dialog.png');

// 填 3 个阶段
await ev(`(() => {
  const inputs = [...document.querySelectorAll('.el-dialog .el-input__inner')];
  const setVal = (el, v) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  setVal(inputs[0], '方案一');
  return inputs.length;
})()`);
await sleep(300);
for (let i = 0; i < 2; i++) {
  await ev(clickByText('添加阶段名称', '.el-dialog'));
  await sleep(250);
}
const phaseRows = await ev(`document.querySelectorAll('.el-dialog .phase-row').length`);
check('点 2 次「添加阶段名称」后有 3 行阶段明细', phaseRows === 3, `实际 ${phaseRows}`);
await ev(`(() => {
  const rows = [...document.querySelectorAll('.el-dialog .phase-row')];
  const names = ['一阶段', '二阶段', '三阶段'];
  const setVal = (el, v) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  rows.forEach((r, i) => {
    const inp = r.querySelector('.phase-name .el-input__inner');
    if (inp) setVal(inp, names[i]);
    const num = r.querySelector('.phase-month .el-input__inner');
    if (num) {
      setVal(num, '2');
      num.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  return true;
})()`);
await sleep(400);
await shot('plan-03-dialog-filled.png');
await ev(clickByText('取消', '.el-dialog'));
await sleep(600);

/* ============================================================
 * ② 班级管理 → 新增班级
 * ============================================================ */
console.log('\n【2】班级管理 → 新增班级（部门 → 阶段方案 → 阶段）');
await nav('/teaching/class', 3600);
let t2 = await ev(bodyText());
if (!t2.includes('新增班级')) {
  await nav('/class-jh/class', 3200);
  t2 = await ev(bodyText());
}
check('班级管理页打开（有「新增班级」）', t2.includes('新增班级'));
const openCls = await ev(clickByText('新增班级'));
check('点击「新增班级」', openCls === 'ok');
await sleep(1400);
const clsDlg = await ev(bodyText());
check('新增班级弹窗含「部门」', clsDlg.includes('部门'));
check('新增班级弹窗含「阶段方案」', clsDlg.includes('阶段方案'));
check('新增班级弹窗含「阶段」', clsDlg.includes('阶段'));
await shot('plan-04-class-dialog.png');

// 展开阶段方案下拉，看选项
await ev(openSelect('阶段方案'));
await sleep(1000);
const planDrop = await ev(visibleOptions());
check('阶段方案下拉有选项', !!planDrop, planDrop);
check('选项里含「初高部阶段方案」', planDrop.includes('初高部阶段方案'), planDrop);
await shot('plan-05-class-plan-dropdown.png');
// 选它 → 阶段下拉应变成该方案下的阶段
const pickedPlan = await ev(pickVisibleOption('初高部阶段方案'));
check('选中「初高部阶段方案」', String(pickedPlan).startsWith('ok:'), String(pickedPlan));
await sleep(700);
await ev(openSelect('阶段'));
await sleep(900);
const phaseDropCls = await ev(visibleOptions());
check('阶段下拉来自方案（含 初中部1期）', phaseDropCls.includes('初中部1期'), phaseDropCls);
check('阶段下拉不含大学部阶段（一阶段）', !phaseDropCls.includes('一阶段'), phaseDropCls);

await ev(clickByText('取消', '.el-dialog'));
await sleep(500);

/* ============================================================
 * ③ 学生档案 → 新增学生（阶段/部门跟随班级）
 * ============================================================ */
console.log('\n【3】学生档案 → 新增学生（阶段 / 部门跟随班级）');
await nav('/teaching/student', 3600);
const t3 = await ev(bodyText());
check('学生档案页打开（有「新增学生」）', t3.includes('新增学生'));
const openStu = await ev(clickByText('新增学生'));
check('点击「新增学生」', openStu === 'ok');
await sleep(1400);
await shot('plan-06-student-dialog.png');

const deptBefore = await ev(readFormItem('部门'));
const phaseBefore = await ev(readFormItem('阶段'));
check('选班级前「部门」未带出值', !/初高部|大学部/.test(deptBefore), `部门=${deptBefore}`);
check('选班级前「阶段」未带出值', !/阶段|期/.test(phaseBefore), `阶段=${phaseBefore}`);

// 选部门 = 初高部
await ev(openSelect('部门'));
await sleep(800);
const deptPick = await ev(pickVisibleOption('初高部'));
check('选中部门「初高部」', String(deptPick).startsWith('ok:'), String(deptPick));
await sleep(700);

// 选班级
await ev(openSelect('班级'));
await sleep(900);
const clsOpts = await ev(visibleOptions());
check('班级下拉有选项', !!clsOpts, clsOpts);
const clsPick = await ev(pickVisibleOption('G2601'));
check('选中班级 G2601', String(clsPick).startsWith('ok:'), String(clsPick));
await sleep(1100);

const deptAfter = await ev(readFormItem('部门'));
const phaseAfter = await ev(readFormItem('阶段'));
check('部门已跟随班级自动带出', deptAfter === '初高部', `部门=${deptAfter}`);
check('阶段已跟随班级自动带出（初中部1期）', phaseAfter === '初中部1期', `阶段=${phaseAfter}`);
await shot('plan-07-student-autofill.png');

/* ---------- 收尾 ---------- */
try {
  ws.close();
} catch {
  /* ignore */
}
child.kill();

console.log(`\n结果：${failed === 0 ? '全部通过 ✓' : failed + ' 项失败 ✗'}`);
process.exit(failed === 0 ? 0 : 1);
