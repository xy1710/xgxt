/**
 * 2026-10-16 需求验证 · 阶段方案（阶段字典升级）
 * ============================================================
 *
 * 验证两件事（API + 界面双通道）：
 *   ① 系统设置 · 阶段方案页：新增方案（多阶段）/ 编辑 / 删除
 *   ② 班级管理 · 新增&编辑班级：阶段方案选择 + 阶段选择（选项 = 方案里的阶段）
 *
 * 用法：node tools/verify-stage-scheme.mjs     （前端 5173 / 后端 8004 需在跑）
 * 产物：tools/_out/scheme-*.png（界面截图，人工核对用）
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
const API = 'http://127.0.0.1:8004';
const ACCOUNT = 'qiansy';

const BROWSER = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => fs.existsSync(p));
if (!BROWSER) {
  console.log('NO BROWSER');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let failed = 0;
function check(name, ok, extra = '') {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}${extra ? ' —— ' + extra : ''}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${extra ? ' —— ' + extra : ''}`);
  }
}

/* ---------- 后端接口小工具 ---------- */
async function apiLogin(account, password = '123456') {
  const r = await fetch(`${API}/api/portal/account/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
  return r.json().catch(() => null);
}

/* ---------- CDP 浏览器小工具 ---------- */
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-scheme-'));
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
  if (r.exceptionDetails) return `EXCEPTION: ${r.exceptionDetails.text}`;
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

/** 可见页签面板（避免读到隐藏页签里的表格） */
const VISIBLE_PANE = `[...document.querySelectorAll('.el-tab-pane')].find(p => p.offsetParent !== null && p.querySelector('.el-table'))`;

/** 点击按钮（可按行文本限定范围） */
const clickBtn = (text, rowText) => `(() => {
  let scope = document;
  if ('${rowText || ''}') {
    const row = [...document.querySelectorAll('.el-table__row')].find(r => r.innerText.includes('${rowText}'));
    if (!row) return 'row-not-found';
    scope = row;
  }
  const bs = [...(scope.querySelectorAll ? scope.querySelectorAll('button') : [])]
    .filter(b => b.innerText.trim() === '${text}' && b.offsetParent !== null && !b.disabled);
  if (bs.length) { bs[0].click(); return 'clicked'; }
  return 'not-found';
})()`;

const clickTab = (text) => `(() => {
  const t = [...document.querySelectorAll('.el-tabs__item')].find(e => e.innerText.trim() === '${text}');
  if (t) { t.click(); return 'ok'; }
  return 'not-found';
})()`;

/** 给输入框赋值（触发 Vue 的 input/change，el-input 与 el-input-number 都吃这两个事件） */
const setInput = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return 'input-not-found';
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, ${JSON.stringify(String(value))});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.blur();
  return 'ok';
})()`;

/** 点开某个表单项里的下拉（按 label 文本找 el-select） */
const openSelectByLabel = (label) => `(() => {
  const scope = document.querySelector('.el-dialog') || document;
  const item = [...scope.querySelectorAll('.el-form-item')].find(fi => {
    const l = fi.querySelector('.el-form-item__label');
    return l && l.innerText.trim().replace(/[:：]/g, '') === '${label}';
  });
  if (!item) return 'label-not-found';
  const w = item.querySelector('.el-select__wrapper') || item.querySelector('.el-select') || item.querySelector('.el-input');
  if (!w) return 'select-not-found';
  w.click();
  return 'ok';
})()`;

/** 点下拉里的某个选项（取可见 popper 里的项） */
const clickOption = (text) => `(() => {
  const items = [...document.querySelectorAll('.el-select-dropdown__item')]
    .filter(i => i.offsetParent !== null && i.innerText.trim().includes('${text}'));
  if (!items.length) return 'option-not-found';
  items[0].click();
  return 'ok';
})()`;

/** 读包含某段文本的表格行里的所有单元格文字 */
const readRowCells = (rowText) => `(() => {
  const row = [...document.querySelectorAll('.el-table__row')].find(r => r.innerText.includes('${rowText}'));
  if (!row) return [];
  return [...row.querySelectorAll('td')].map(td => td.innerText.trim());
})()`;

/** 读可见页签里表格的某一列文字 */
const readTableCol = (colIdx) => `(() => {
  const pane = ${VISIBLE_PANE};
  if (!pane) return [];
  return [...pane.querySelectorAll('.el-table__row')].map(r => {
    const tds = r.querySelectorAll('td');
    return tds[${colIdx}] ? tds[${colIdx}].innerText.trim() : '';
  });
})()`;

const readTableHeaders = () => `(() => {
  const pane = ${VISIBLE_PANE};
  if (!pane) return [];
  return [...pane.querySelectorAll('.el-table__header th')].map(t => t.innerText.trim()).filter(Boolean);
})()`;

/**
 * 读某个表单项当前值
 *   el-select（2.7 新版）：选中文字在 .el-select__selected-item 里，input.value 恒为空
 *   el-input：直接用 input.value
 */
const readFieldValue = (label) => `(() => {
  const scope = document.querySelector('.el-dialog') || document;
  const item = [...scope.querySelectorAll('.el-form-item')].find(fi => {
    const l = fi.querySelector('.el-form-item__label');
    return l && l.innerText.trim().replace(/[:：]/g, '') === '${label}';
  });
  if (!item) return 'label-not-found';
  if (item.querySelector('.el-select')) {
    // ⚠️ 第一个 .el-select__selected-item 是藏起来的 input 壳，选中文字在第二个
    const it = [...item.querySelectorAll('.el-select__selected-item')]
      .find(x => !x.classList.contains('el-select__input-wrapper'));
    return it ? it.innerText.trim() : '';
  }
  const inp = item.querySelector('input');
  return inp ? inp.value : 'no-input';
})()`;

/** 读下拉弹出层里的所有选项文字 */
const readOpenOptions = () => `(() => {
  return [...document.querySelectorAll('.el-select-dropdown__item')]
    .filter(i => i.offsetParent !== null)
    .map(i => i.innerText.trim());
})()`;

/** 点方案弹窗里第 n 行阶段的「删除」（n 从 1 开始） */
const clickDialogStageDelete = (n) => `(() => {
  const dlg = document.querySelector('.el-dialog');
  if (!dlg) return 'dialog-not-found';
  const btns = [...dlg.querySelectorAll('.scheme-stage-row button')].filter(b => b.innerText.trim() === '删除');
  if (btns[${n - 1}]) { btns[${n - 1}].click(); return 'ok'; }
  return 'not-found';
})()`;

/* ============================================================
 * 主流程
 * ============================================================ */
async function main() {
  console.log('\n=== 0. 登录并准备浏览器 ===');
  const token = await apiLogin(ACCOUNT);
  check('接口登录 qiansy', !!token);

  ws = new WebSocket(await getTarget());
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      clearTimeout(p.to);
      if (m.error) p.reject(new Error(m.error.message));
      else p.resolve(m.result);
    }
  };
  await send('Page.enable');
  await send('Runtime.enable');

  await nav('/login', 2200);
  await ev(`localStorage.setItem('sms_token', ${JSON.stringify(token)})`);

  /* ---------------- 1. 系统设置 · 阶段方案 ---------------- */
  console.log('\n=== 1. 系统设置 · 阶段方案页 ===');
  await nav('/class-jh/setting', 3200);
  await ev(clickTab('阶段方案'));
  await sleep(900);
  await shot('scheme-01-阶段方案列表.png');

  const tabExists = await ev(
    `[...document.querySelectorAll('.el-tabs__item')].some(e => e.innerText.trim() === '阶段方案')`,
  );
  check('页签名称已改为「阶段方案」', tabExists === true);

  const headers = await ev(readTableHeaders());
  check(
    '表格字段 = 序号/方案名称/所属部门/操作',
    JSON.stringify(headers) === JSON.stringify(['序号', '方案名称', '所属部门', '操作']),
    `实际：${JSON.stringify(headers)}`,
  );

  const rows0 = await ev(readTableCol(1));
  check(
    '表格列出方案（含默认方案）',
    Array.isArray(rows0) && rows0.length >= 2,
    `当前 ${rows0?.length ?? 0} 个：${(rows0 || []).join('、')}`,
  );

  // 新增方案：方案一（一/二/三阶段 · 学制2月）
  await ev(clickBtn('新增方案'));
  await sleep(700);
  await ev(setInput('.el-dialog input[placeholder="如 方案一"]', '方案一'));
  await ev(setInput('.el-dialog .scheme-stage-row:nth-child(1) input[placeholder="阶段名称，如 一阶段"]', '一阶段'));
  await ev(setInput('.el-dialog .scheme-stage-row:nth-child(1) .el-input-number input', '2'));

  for (const [name, months] of [['二阶段', '2'], ['三阶段', '2']]) {
    await ev(clickBtn('添加阶段名称'));
    await sleep(350);
    const idx = await ev(`document.querySelectorAll('.el-dialog .scheme-stage-row').length`);
    await ev(setInput(`.el-dialog .scheme-stage-row:nth-child(${idx}) input[placeholder="阶段名称，如 一阶段"]`, name));
    await ev(setInput(`.el-dialog .scheme-stage-row:nth-child(${idx}) .el-input-number input`, months));
  }
  await sleep(400);
  await shot('scheme-02-新增方案弹窗.png');

  await ev(clickBtn('确定'));
  await sleep(1300);
  await shot('scheme-03-新增后列表.png');
  const rows1 = await ev(readTableCol(1));
  check('新增「方案一」（3 个阶段）成功', Array.isArray(rows1) && rows1.includes('方案一'), `当前：${(rows1 || []).join('、')}`);

  // 编辑：回填校验 + 删掉一个阶段后保存
  await ev(clickBtn('编辑', '方案一'));
  await sleep(900);
  const editName = await ev(readFieldValue('方案名称'));
  const editRowCount = await ev(`document.querySelectorAll('.el-dialog .scheme-stage-row').length`);
  check(
    '编辑弹窗回填方案名称与阶段明细',
    editName === '方案一' && editRowCount === 3,
    `名称=${editName}，阶段行数=${editRowCount}`,
  );
  await shot('scheme-04-编辑方案弹窗.png');
  await ev(clickDialogStageDelete(3));
  await sleep(300);
  await ev(clickBtn('确定'));
  await sleep(1300);
  const rows2 = await ev(readTableCol(1));
  check('编辑保存（阶段明细覆盖）成功', Array.isArray(rows2) && rows2.includes('方案一'));

  // 删除：方案一 → 确认
  await ev(clickBtn('删除', '方案一'));
  await sleep(800);
  await shot('scheme-05-删除确认.png');
  const confirmClicked = await ev(`(() => {
    const box = [...document.querySelectorAll('.el-message-box')].find(b => b.offsetParent !== null);
    if (!box) return 'box-not-found';
    const b = [...box.querySelectorAll('button')].find(x => x.innerText.trim() === '确定删除');
    if (b) { b.click(); return 'ok'; }
    return 'btn-not-found';
  })()`);
  check('删除确认框可交互', confirmClicked === 'ok', confirmClicked);
  await sleep(1400);
  const rows3 = await ev(readTableCol(1));
  check('删除方案成功', Array.isArray(rows3) && !rows3.includes('方案一'), `当前：${(rows3 || []).join('、')}`);
  await shot('scheme-06-删除后列表.png');

  /* ---------------- 2. 班级管理 · 新增/编辑班级 ---------------- */
  console.log('\n=== 2. 班级管理 · 新增班级（阶段方案 + 阶段） ===');
  await nav('/teaching/class', 3400);
  await shot('scheme-07-班级列表.png');

  await ev(clickBtn('新增班级'));
  await sleep(1000);
  await shot('scheme-08-新增班级弹窗.png');

  const hasSchemeField = await ev(
    `[...document.querySelectorAll('.el-dialog .el-form-item__label')].some(l => l.innerText.trim() === '阶段方案')`,
  );
  check('新增班级表单出现「阶段方案」', hasSchemeField === true);
  const hasStageField = await ev(
    `[...document.querySelectorAll('.el-dialog .el-form-item__label')].some(l => l.innerText.trim() === '阶段')`,
  );
  check('新增班级表单出现「阶段」', hasStageField === true);

  await ev(openSelectByLabel('阶段方案'));
  await sleep(700);
  const schemeOpts = await ev(readOpenOptions());
  await shot('scheme-09-阶段方案下拉.png');
  check('方案下拉有数据（按部门过滤）', Array.isArray(schemeOpts) && schemeOpts.length > 0, `选项：${(schemeOpts || []).join('、')}`);

  await ev(clickOption('初高部阶段方案'));
  await sleep(600);
  await ev(openSelectByLabel('阶段'));
  await sleep(700);
  const stageOpts = await ev(readOpenOptions());
  await shot('scheme-10-阶段下拉.png');
  check(
    '「阶段」下拉 = 方案里的阶段（带学制）',
    Array.isArray(stageOpts) && stageOpts.length > 0 && stageOpts.filter((s) => s.includes('学制')).length > 0,
    `选项：${(stageOpts || []).join('、')}`,
  );

  const pickR = await ev(clickOption('初中部1期'));
  check('可选中方案里的阶段', pickR === 'ok', pickR);
  await sleep(400);
  await shot('scheme-11-表单已选方案与阶段.png');
  const pickedScheme = await ev(readFieldValue('阶段方案'));
  const pickedStage = await ev(readFieldValue('阶段'));
  check(
    '表单回显：方案 + 阶段',
    !!pickedScheme && pickedStage.includes('初中部1期'),
    `方案=${pickedScheme}，阶段=${pickedStage}`,
  );

  // 编辑已有班级：方案/阶段应回填（CLS-JH-G2601 先通过接口挂上方案）
  await ev(clickBtn('取消'));
  await sleep(400);
  await apiCall(token, 'POST', '/api/teaching/class/save', {
    stage: 'jh',
    id: 'CLS-JH-G2601',
    className: 'G2601',
    schemeId: 'seed-scheme-1',
    schemeStageId: 'seed-scheme-1-s2',
    schemeStageName: '初中部1期',
  });
  await nav('/teaching/class', 3400);
  const gRow = await ev(readRowCells('G2601'));
  check('班级列表「阶段」列显示方案阶段名', Array.isArray(gRow) && gRow.includes('初中部1期'), `G2601 行：${(gRow || []).join(' | ')}`);
  await shot('scheme-12-班级列表阶段列.png');
  await ev(clickBtn('编辑', 'G2601'));
  await sleep(1000);
  await shot('scheme-13-编辑班级回填.png');
  const editScheme = await ev(readFieldValue('阶段方案'));
  const editStage = await ev(readFieldValue('阶段'));
  check('编辑班级时方案/阶段正确回填', editScheme === '初高部阶段方案' && editStage === '初中部1期', `方案=${editScheme}，阶段=${editStage}`);
  await ev(clickBtn('取消'));
  await sleep(400);
  // 还原
  await apiCall(token, 'POST', '/api/teaching/class/save', {
    stage: 'jh',
    id: 'CLS-JH-G2601',
    className: 'G2601',
    schemeId: null,
    schemeStageId: null,
    schemeStageName: null,
  });
  await sleep(400);

  /* ---------------- 3. 接口层断言（方案被班级引用后不可删） ---------------- */
  console.log('\n=== 3. 删除保护 ===');
  const addR = await apiCall(token, 'POST', '/api/class-jh/stage-scheme/add', {
    schemeName: '临时方案-验证',
    deptCode: 2,
    stages: [{ stageName: '甲阶段', studyMonths: 1 }],
  });
  const tmpId = addR?.data?.id;
  check('接口新增临时方案', !!tmpId);

  const saveR = await apiCall(token, 'POST', '/api/teaching/class/save', {
    stage: 'class',
    id: 'CLS-U2601',
    className: 'U2601',
    schemeId: tmpId,
    schemeStageId: 'tmp-stage-x',
    schemeStageName: '甲阶段',
    phaseCode: 201,
  });
  check('接口把临时方案挂到大学班级', saveR?.code === 200, saveR?.message || '');

  const delR = await apiCall(token, 'DELETE', `/api/class-jh/stage-scheme/delete/${tmpId}`);
  check('被班级引用的方案禁止删除', delR?.code === 40010, delR?.message || '');

  await apiCall(token, 'POST', '/api/teaching/class/save', {
    stage: 'class',
    id: 'CLS-U2601',
    className: 'U2601',
    schemeId: null,
    schemeStageId: null,
    schemeStageName: null,
  });
  const delR2 = await apiCall(token, 'DELETE', `/api/class-jh/stage-scheme/delete/${tmpId}`);
  check('解绑后可正常删除（验证数据已清理）', delR2?.code === 200, delR2?.message || '');

  console.log('\n============================================');
  console.log(`结果：通过 ${passed} 项 / 失败 ${failed} 项`);
  console.log(`截图目录：${OUTDIR}`);
  console.log('============================================\n');
}

main()
  .catch((e) => {
    console.error('验证脚本异常：', e);
    failed += 1;
  })
  .finally(async () => {
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    child.kill();
    await sleep(300);
    process.exit(failed ? 1 : 0);
  });
