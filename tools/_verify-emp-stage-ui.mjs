/**
 * 回归验证：就业部阶段方案 + 删除班级交接页 + 花名册改名（2026-10-19）
 * ============================================================
 * ① 班级管理操作列：按钮叫【详情】，不再有【花名册】；抽屉标题以「· 详情」结尾，
 *    抽屉里仍然有「花名册（N 人）」这一块名单；
 * ② 左侧菜单没有【班级交接】；直连老地址 /class-transfer 会跳到 /teaching/class；
 * ③ 系统设置 → 阶段方案：有「就业部阶段方案」，新增方案的部门下拉含「就业部」；
 * ④ 新增班级选「就业部」→ 阶段方案默认就业部那套 → 阶段下拉是 一/二/三阶段。
 *
 * 用法：node tools/_verify-emp-stage-ui.mjs   （前后端需在跑：8004 + 5173）
 * 产物：tools/_out/verify_empstage_*.png
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUTDIR = path.join(HERE, '_out');
fs.mkdirSync(OUTDIR, { recursive: true });
const PORT = 9346;
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

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-empstage-'));
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

/**
 * ★ Element Plus 的下拉 / 弹窗都是 teleport 到 body 的：
 *   程序化 el.click() 会命中错误的 popper，必须按坐标真点（见 tools/_verify-class-handover-ui.mjs 注释）
 */
async function clickAt(rect) {
  if (!rect) return false;
  const x = rect.x + rect.w / 2;
  const y = rect.y + rect.h / 2;
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  return true;
}

/** 打开弹窗里某个 label 的下拉（真点 wrapper），返回选项文本 */
async function openSelectInDialog(label) {
  const rect = await ev(`(() => {
    const dlg = [...document.querySelectorAll('.el-dialog')].find(d => d.offsetParent !== null);
    if (!dlg) return null;
    const item = [...dlg.querySelectorAll('.el-form-item')]
      .find(it => (it.querySelector('.el-form-item__label')?.innerText || '').trim() === ${JSON.stringify(label)});
    const wrap = item?.querySelector('.el-select__wrapper');
    if (!wrap) return null;
    const r = wrap.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  })()`);
  if (!rect) return null;
  await clickAt(rect);
  await sleep(600);
  return readOpenOptions();
}

/** 读当前打开的那个下拉的选项（只认宽高 > 0 的 popper） */
async function readOpenOptions() {
  return ev(`(() => {
    const poppers = [...document.querySelectorAll('.el-select__popper')]
      .filter(p => p.getBoundingClientRect().width > 0);
    const panel = poppers[poppers.length - 1];
    if (!panel) return [];
    return [...panel.querySelectorAll('.el-select-dropdown__item')]
      .filter(x => x.getBoundingClientRect().height > 0)
      .map(x => x.innerText.trim());
  })()`);
}

/** 在下拉里按文本选项（真点坐标） */
async function pickOpenOption(text) {
  const rect = await ev(`(() => {
    const poppers = [...document.querySelectorAll('.el-select__popper')]
      .filter(p => p.getBoundingClientRect().width > 0);
    const panel = poppers[poppers.length - 1];
    if (!panel) return null;
    const item = [...panel.querySelectorAll('.el-select-dropdown__item')]
      .find(x => x.innerText.trim() === ${JSON.stringify(text)});
    if (!item) return null;
    const r = item.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  })()`);
  if (!rect) return false;
  await clickAt(rect);
  await sleep(500);
  return true;
}

/** 读弹窗里某个 label 的当前值 */
function formItem(label) {
  return ev(`(() => {
    const dlg = [...document.querySelectorAll('.el-dialog')].find(d => d.offsetParent !== null);
    if (!dlg) return null;
    const item = [...dlg.querySelectorAll('.el-form-item')]
      .find(it => (it.querySelector('.el-form-item__label')?.innerText || '').trim() === ${JSON.stringify(label)});
    if (!item) return null;
    return {
      value: (item.querySelector('.el-select__selected-item')?.innerText
        || item.querySelector('.el-select__placeholder')?.innerText
        || item.querySelector('input')?.value || '').trim(),
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

  /* ---------------- ② 菜单里没有班级交接 ---------------- */
  const menuText = await ev(`(() => {
    const menu = document.querySelector('.el-menu') || document.body;
    return menu.innerText;
  })()`);
  check('左侧菜单没有【班级交接】', !String(menuText).includes('班级交接'), String(menuText).slice(0, 200).replace(/\n/g, ' | '));

  await nav('/class-transfer', 2600);
  const hashAfter = await ev(`location.hash`);
  check('老地址 /class-transfer 跳到班级管理', String(hashAfter).includes('/teaching/class'), hashAfter);

  /* ---------------- ① 班级管理：详情 ---------------- */
  await nav('/teaching/class', 3200);
  const rowButtons = await ev(`(() => {
    const row = document.querySelector('.el-table__row');
    if (!row) return null;
    return [...row.querySelectorAll('button')].map(b => b.innerText.trim()).filter(Boolean);
  })()`);
  check('操作列按钮叫【详情】', (rowButtons || []).includes('详情'), JSON.stringify(rowButtons));
  check('操作列不再有【花名册】', !(rowButtons || []).includes('花名册'));

  await ev(`(() => {
    const row = document.querySelector('.el-table__row');
    const btn = row && [...row.querySelectorAll('button')].find(b => b.innerText.trim() === '详情');
    if (btn) btn.click();
    return !!btn;
  })()`);
  await sleep(1400);
  const drawer = await ev(`(() => {
    const d = [...document.querySelectorAll('.el-drawer')].find(x => x.offsetParent !== null || x.getBoundingClientRect().width > 0);
    if (!d) return null;
    return {
      title: (d.querySelector('.el-drawer__title')?.innerText || '').trim(),
      body: d.innerText,
    };
  })()`);
  check('抽屉标题以「· 详情」结尾', /·\s*详情/.test(drawer?.title || ''), drawer?.title);
  check('抽屉里仍有「花名册（N 人）」名单块', /花名册（\d+\s*人）/.test(drawer?.body || ''), (drawer?.body || '').slice(0, 120).replace(/\n/g, ' | '));
  await shot('verify_empstage_detail_drawer.png');
  await ev(`(() => { document.body.click(); return true; })()`);
  await sleep(600);

  /* ---------------- ③ 系统设置 → 阶段方案 ---------------- */
  await nav('/class-jh/setting', 3200);
  const tabRect = await ev(`(() => {
    const tab = [...document.querySelectorAll('.el-tabs__item')].find(t => t.innerText.trim() === '阶段方案');
    if (!tab) return null;
    const r = tab.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  })()`);
  await clickAt(tabRect);
  await sleep(1200);
  const planPageText = await ev(`document.body.innerText`);
  check('阶段方案列表有【就业部阶段方案】', String(planPageText).includes('就业部阶段方案'));
  check('列表里能看到「就业部」部门名', String(planPageText).includes('就业部'));
  await shot('verify_empstage_setting_tab.png');

  // 新增方案弹窗：部门下拉要能选到就业部
  await ev(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.innerText.trim() === '新增方案');
    if (btn) btn.click();
    return !!btn;
  })()`);
  await sleep(1200);
  const deptOpts = await openSelectInDialog('所属部门');
  check('新增方案的部门下拉含【就业部】', (deptOpts || []).includes('就业部'), JSON.stringify(deptOpts));
  await shot('verify_empstage_plan_dialog.png');
  await ev(`(() => {
    const dlg = [...document.querySelectorAll('.el-dialog')].find(d => d.offsetParent !== null);
    const btn = dlg && [...dlg.querySelectorAll('.el-dialog__footer button')].find(b => b.innerText.trim() === '取消');
    if (btn) btn.click();
    return !!btn;
  })()`);
  await sleep(800);

  /* ---------------- ④ 新增班级：就业部 → 方案 → 阶段 ---------------- */
  await nav('/teaching/class', 3200);
  await ev(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.innerText.trim() === '新增班级');
    if (btn) btn.click();
    return !!btn;
  })()`);
  await sleep(1300);

  const deptOpts2 = await openSelectInDialog('部门');
  check('新增班级的部门下拉含【就业部】', (deptOpts2 || []).includes('就业部'), JSON.stringify(deptOpts2));
  const picked = await pickOpenOption('就业部');
  check('已选中「就业部」', picked === true);
  await sleep(900);

  const planItem = await formItem('阶段方案');
  check('选就业部后阶段方案自动选中「就业部阶段方案」',
    (planItem?.value || '').includes('就业部阶段方案'), planItem?.value);

  const phaseOpts = await openSelectInDialog('阶段');
  check('阶段下拉 = 一阶段/二阶段/三阶段',
    JSON.stringify(phaseOpts) === JSON.stringify(['一阶段', '二阶段', '三阶段']), JSON.stringify(phaseOpts));
  await shot('verify_empstage_class_form.png');
  await ev(`(() => {
    const dlg = [...document.querySelectorAll('.el-dialog')].find(d => d.offsetParent !== null);
    const btn = dlg && [...dlg.querySelectorAll('.el-dialog__footer button')].find(b => b.innerText.trim() === '取消');
    if (btn) btn.click();
    return !!btn;
  })()`);
  await sleep(800);

  /* ---------------- ⑤ 学生档案：就业部同样走方案 ---------------- */
  await nav('/teaching/student', 3200);
  await ev(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.innerText.trim() === '新增学生');
    if (btn) btn.click();
    return !!btn;
  })()`);
  await sleep(1300);
  const stuDeptOpts = await openSelectInDialog('部门');
  check('新增学生的部门下拉含【就业部】', (stuDeptOpts || []).includes('就业部'), JSON.stringify(stuDeptOpts));
  await pickOpenOption('就业部');
  await sleep(900);
  const stuPhaseOpts = await openSelectInDialog('阶段');
  check('学生阶段下拉 = 一阶段/二阶段/三阶段',
    JSON.stringify(stuPhaseOpts) === JSON.stringify(['一阶段', '二阶段', '三阶段']), JSON.stringify(stuPhaseOpts));
  await shot('verify_empstage_student_form.png');

  check('无未捕获异常', pageErrors.length === 0, pageErrors[0] || '');

  console.log(`\n${fails.length ? 'FAILED: ' + fails.join(' / ') : 'ALL PASS'}`);
  child.kill();
  process.exitCode = fails.length ? 1 : 0;
})().catch((e) => {
  console.error('脚本异常：', e.message);
  child.kill();
  process.exitCode = 1;
});
