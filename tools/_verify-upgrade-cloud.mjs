/**
 * 回归验证：学生档案【升云】（2026-10-20 批注）
 * ============================================================
 * 批注原文：
 *   「增加【升云】功能：点击升云可以批量选择人员进行升云，只适用于初高中，
 *     选择人员后再进行大学部要升入班级的选择，只能选择班级状态为开放的。」
 *   「初高部的学生档案移动到大学部对应的班级，并增加升云的记录，
 *     在学生档案详情中显示，在基础信息页面增加升云记录，记录信息包括原班主任、
 *     原班级、操作人，同时升云只改变班级的相关内容，其余不变，尤其是学号不更改」
 *
 * 断言：
 *   ① 工具栏有【升云】按钮，点开弹窗；
 *   ② 弹窗只列「初高部 · 正式在读」学生；目标班级只列「大学部 · 开放」班；
 *   ③ 勾选 1 人 + 选班 → 提交 → 提示成功；
 *   ④ 升云后该生仍在（学号不变），部门变成「大学部」、班级是所选班；
 *   ⑤ 详情「基础信息」有「升云记录」，含原班级 / 原班主任 / 操作人。
 *
 * ⚠️ 本脚本会真实改数据（把 1 名初高学生升到大学部）。跑完如需还原，看脚本末尾打印的提示。
 * 用法：node tools/_verify-upgrade-cloud.mjs   （前后端需在跑：8004 + 5173）
 * 产物：tools/_out/verify_upgrade_*.png
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUTDIR = path.join(HERE, '_out');
fs.mkdirSync(OUTDIR, { recursive: true });
const PORT = 9347;
const BASE = 'http://localhost:5173';
/** 本次用来验证的学生（初高部 · 正式在读） */
const TEST_NO = process.env.UPG_NO || 'J26006';

const BROWSER = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => fs.existsSync(p));
if (!BROWSER) {
  console.log('NO BROWSER');
  process.exit(1);
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-upgrade-'));
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
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'eval error');
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

/** 按坐标真点 —— Element Plus 的下拉是 teleport 出来的，程序化 click 会命中错误的 popper */
async function clickAt(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}
/** 找到「可见的」元素中心坐标并点击 */
async function clickVisible(selector, containsText = '') {
  const rect = await ev(`(() => {
    const list = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .filter(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && (!${JSON.stringify(containsText)} || el.innerText.includes(${JSON.stringify(containsText)}));
      });
    const el = list[list.length - 1];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!rect) return false;
  await clickAt(rect.x, rect.y);
  await sleep(400);
  return true;
}
/** 在输入框里写值（走原生 setter + input 事件，Vue 才认） */
async function fillInput(selector, value) {
  return ev(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .filter(x => x.getBoundingClientRect().width > 0).pop();
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
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
  await nav('/teaching/student', 3600);

  // ① 工具栏按钮
  const hasBtn = await ev(`(() => [...document.querySelectorAll('button')].some(b => b.innerText.trim() === '升云'))()`);
  check('工具栏有【升云】按钮', hasBtn);

  await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.innerText.trim() === '升云');
    if (b) b.click();
    return !!b;
  })()`);
  await sleep(1800);

  const dlg = await ev(`(() => {
    const d = [...document.querySelectorAll('.el-dialog')].find(x => x.offsetParent !== null && x.innerText.includes('升云'));
    if (!d) return null;
    const rows = [...d.querySelectorAll('.el-table__row')].map(tr => tr.innerText.replace(/\\s+/g, ' ').trim());
    return {
      title: d.querySelector('.el-dialog__title')?.innerText || '',
      rows,
      tip: d.innerText.includes('只能选「开放」状态的班级') || d.innerText.includes('只能选'),
      hasSide: d.innerText.includes('目标班级'),
    };
  })()`);
  check('打开升云弹窗', !!dlg, dlg?.title);
  check('弹窗说明含「只能选开放班级」', !!dlg?.tip);
  check('弹窗右侧有「目标班级」选择区', !!dlg?.hasSide);
  check('只列初高部学生（学号 J 开头）',
    (dlg?.rows || []).length > 0 && (dlg?.rows || []).every((r) => /^J\d+/.test(r)),
    `共 ${(dlg?.rows || []).length} 行`);
  check(`待升云学生里有 ${TEST_NO}`, (dlg?.rows || []).some((r) => r.includes(TEST_NO)));
  check('没有列退学/休学学生（只列正式在读）',
    !(dlg?.rows || []).some((r) => r.includes('退学') || r.includes('休学')),
    JSON.stringify((dlg?.rows || []).filter((r) => r.includes('退学') || r.includes('休学'))));
  check('每页最多 15 人（批注：每页15个，剩下翻页）', (dlg?.rows || []).length <= 15, `${(dlg?.rows || []).length} 行`);
  const pager = await ev(`(() => {
    const d = [...document.querySelectorAll('.el-dialog')].find(x => x.offsetParent !== null && x.innerText.includes('升云'));
    return d ? (d.querySelector('.upg-foot .el-pagination')?.innerText || '').replace(/\\s+/g, ' ').trim() : '';
  })()`);
  check('表格下方有翻页组件（共 11 条）', /11/.test(pager), pager);
  await shot('verify_upgrade_dialog.png');

  // ① 左下角「全选本页」
  const allChecked = await ev(`(() => {
    const d = [...document.querySelectorAll('.el-dialog')].find(x => x.offsetParent !== null && x.innerText.includes('升云'));
    const cb = d && [...d.querySelectorAll('.upg-foot .el-checkbox')][0];
    if (!cb) return false;
    cb.click();
    return true;
  })()`);
  await sleep(700);
  const pickedAll = await ev(`(() => {
    const d = [...document.querySelectorAll('.el-dialog')].find(x => x.offsetParent !== null && x.innerText.includes('升云'));
    return d ? (d.innerText.match(/已选\\s*(\\d+)\\s*人/) || [])[1] || '' : '';
  })()`);
  check('有「全选本页」且点击后本页全选', allChecked === true && Number(pickedAll) === (dlg?.rows || []).length, `已选 ${pickedAll}`);
  // 再点一次取消
  await ev(`(() => {
    const d = [...document.querySelectorAll('.el-dialog')].find(x => x.offsetParent !== null && x.innerText.includes('升云'));
    const cb = d && [...d.querySelectorAll('.upg-foot .el-checkbox')][0];
    if (cb) cb.click();
    return !!cb;
  })()`);
  await sleep(600);
  const pickedNone = await ev(`(() => {
    const d = [...document.querySelectorAll('.el-dialog')].find(x => x.offsetParent !== null && x.innerText.includes('升云'));
    return d ? (d.innerText.match(/已选\\s*(\\d+)\\s*人/) || [])[1] || '' : '';
  })()`);
  check('再点「全选本页」可取消', pickedNone === '0', `已选 ${pickedNone}`);

  // ② 班级筛选（批注：加班级的筛选）
  const hasClassFilter = await ev(`(() => {
    const d = [...document.querySelectorAll('.el-dialog')].find(x => x.offsetParent !== null && x.innerText.includes('升云'));
    return !!(d && d.querySelector('.upg-bar .el-select__wrapper'));
  })()`);
  check('搜索框右侧有「班级」筛选', hasClassFilter === true);
  const openedClass = await clickVisible('.upg-bar .el-select__wrapper');
  await sleep(700);
  const classOpts = await ev(`(() => {
    const poppers = [...document.querySelectorAll('.el-select__popper')].filter(p => p.getBoundingClientRect().width > 0);
    const panel = poppers[poppers.length - 1];
    if (!panel) return [];
    return [...panel.querySelectorAll('.el-select-dropdown__item')].map(x => x.innerText.trim());
  })()`);
  // ⚠️ 初高部班级名不一定是 G 开头（演示库里还有 J2602），不能按前缀断言；
  //    正确性由下面「按班级筛选后只剩该班学生」保证
  check('班级筛选有初高部班级可选', (classOpts || []).length > 0, JSON.stringify(classOpts));
  await clickVisible('.el-select__popper .el-select-dropdown__item', (classOpts || [])[0] || '');
  await sleep(1600);
  const filteredRows = await ev(`(() => {
    const d = [...document.querySelectorAll('.el-dialog')].find(x => x.offsetParent !== null && x.innerText.includes('升云'));
    return d ? [...d.querySelectorAll('.el-table__row')].map(tr => tr.innerText.replace(/\\s+/g, ' ').trim()) : [];
  })()`);
  check('按班级筛选后只剩该班学生',
    (filteredRows || []).length > 0 && (filteredRows || []).every((r) => r.includes((classOpts || [])[0] || '@@')),
    `${JSON.stringify(classOpts?.[0])} → ${(filteredRows || []).length} 行`);
  await shot('verify_upgrade_class_filter.png');

  // 关掉重开（重置筛选）
  await ev(`(() => {
    const d = [...document.querySelectorAll('.el-dialog')].find(x => x.offsetParent !== null && x.innerText.includes('升云'));
    const b = d && d.querySelector('.el-dialog__headerbtn');
    if (b) b.click();
    return !!b;
  })()`);
  await sleep(800);
  await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.innerText.trim() === '升云');
    if (b) b.click();
    return !!b;
  })()`);
  await sleep(1800);

  // ② 目标班级下拉：只应有大学部开放班
  const opened = await clickVisible('.upg-side .el-select__wrapper');
  await sleep(700);
  const opts = await ev(`(() => {
    const poppers = [...document.querySelectorAll('.el-select__popper')].filter(p => p.getBoundingClientRect().width > 0);
    const panel = poppers[poppers.length - 1];
    if (!panel) return [];
    return [...panel.querySelectorAll('.el-select-dropdown__item')].map(x => x.innerText.trim());
  })()`);
  check('目标班级下拉有开放班级', (opts || []).length > 0, JSON.stringify(opts));
  check('目标班级都是大学部班级（U 开头）', (opts || []).every((o) => o.startsWith('U')), JSON.stringify(opts));
  await shot('verify_upgrade_targets.png');

  // 选第一个班
  const targetName = (opts || [])[0]?.split(' · ')[0] || '';
  await clickVisible('.el-select__popper .el-select-dropdown__item', targetName);
  await sleep(600);

  // ③ 勾选测试学生
  const picked = await ev(`(() => {
    const d = [...document.querySelectorAll('.el-dialog')].find(x => x.offsetParent !== null && x.innerText.includes('升云'));
    if (!d) return false;
    const tr = [...d.querySelectorAll('.el-table__row')].find(x => x.innerText.includes(${JSON.stringify(TEST_NO)}));
    const cb = tr?.querySelector('.el-checkbox');
    if (!cb) return false;
    cb.click();
    return true;
  })()`);
  await sleep(700);
  check(`勾选 ${TEST_NO}`, picked === true);
  const selectedTip = await ev(`(() => {
    const d = [...document.querySelectorAll('.el-dialog')].find(x => x.offsetParent !== null && x.innerText.includes('升云'));
    return d ? (d.innerText.match(/已选\\s*(\\d+)\\s*人/) || [])[1] || '' : '';
  })()`);
  check('右侧「已选 1 人」', selectedTip === '1', selectedTip);
  await shot('verify_upgrade_picked.png');

  // ④ 提交
  await ev(`(() => {
    const d = [...document.querySelectorAll('.el-dialog')].find(x => x.offsetParent !== null && x.innerText.includes('升云'));
    const b = d && [...d.querySelectorAll('.el-dialog__footer button')].find(x => x.innerText.trim() === '确定升云');
    if (b) b.click();
    return !!b;
  })()`);
  await sleep(900);
  const confirmText = await ev(`(() => {
    const box = [...document.querySelectorAll('.el-message-box')].find(x => x.offsetParent !== null);
    return box ? box.innerText.replace(/\\s+/g, ' ').trim() : '';
  })()`);
  check('弹出升云确认框', confirmText.includes('升云'), confirmText.slice(0, 80));
  await ev(`(() => {
    const box = [...document.querySelectorAll('.el-message-box')].find(x => x.offsetParent !== null);
    const b = box && [...box.querySelectorAll('button')].find(x => x.innerText.trim() === '确定');
    if (b) b.click();
    return !!b;
  })()`);
  await sleep(1100);
  // ⚠️ el-message 是 position:fixed，offsetParent 恒为 null —— 不能拿它判可见性
  const toast = await ev(`(() => {
    const list = [...document.querySelectorAll('.el-message')];
    const m = list[list.length - 1];
    return m ? m.innerText.replace(/\\s+/g, ' ').trim() : '';
  })()`);
  check('提示升云成功', /已升云/.test(toast), toast);
  await shot('verify_upgrade_done.png');
  await sleep(1500);
  // 若弹窗还开着（有 skipped 会弹结果框），先关掉
  await ev(`(() => {
    const box = [...document.querySelectorAll('.el-message-box')].find(x => x.offsetParent !== null);
    const b = box && [...box.querySelectorAll('button')].find(x => /确定|知道了/.test(x.innerText));
    if (b) b.click();
    return true;
  })()`);
  await sleep(800);

  // ⑤ 列表核实：学号还在，部门变大学部
  await fillInput('.tsv-filter input[placeholder="姓名 / 学号 / 手机"]', TEST_NO);
  await sleep(300);
  await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.innerText.trim() === '查询');
    if (b) b.click();
    return !!b;
  })()`);
  await sleep(2000);
  const rowInfo = await ev(`(() => {
    const tr = [...document.querySelectorAll('.el-table__row')].find(x => x.innerText.includes(${JSON.stringify(TEST_NO)}));
    return tr ? tr.innerText.replace(/\\s+/g, ' ').trim() : '';
  })()`);
  check(`升云后仍能查到学号 ${TEST_NO}（学号不变）`, !!rowInfo, rowInfo);
  check('该生已归到「大学部」', rowInfo.includes('大学部'), rowInfo);
  await shot('verify_upgrade_list.png');

  // ⑥ 详情：基础信息里的升云记录
  await ev(`(() => {
    const tr = [...document.querySelectorAll('.el-table__row')].find(x => x.innerText.includes(${JSON.stringify(TEST_NO)}));
    const b = tr && [...tr.querySelectorAll('button')].find(x => x.innerText.trim() === '详情');
    if (b) b.click();
    return !!b;
  })()`);
  await sleep(2000);
  const detailText = await ev(`(() => {
    const d = [...document.querySelectorAll('.el-dialog')].find(x => x.offsetParent !== null);
    return d ? d.innerText.replace(/\\s+/g, ' ').trim() : '';
  })()`);
  check('详情中显示「升云记录」', detailText.includes('升云记录'), '');
  check('记录含「原班级」', /原班级：\\s*\\S/.test(detailText) || detailText.includes('原班级：'));
  check('记录含「原班主任」', detailText.includes('原班主任：'));
  check('记录含「操作人」', detailText.includes('操作人：'));
  await shot('verify_upgrade_detail.png');

  check('无未捕获异常', pageErrors.length === 0, pageErrors[0] || '');

  console.log(`\n${fails.length ? 'FAILED: ' + fails.join(' / ') : 'ALL PASS'}`);
  console.log(`\n⚠️ 本脚本真实修改了数据：${TEST_NO} 已从初高部升云到「${targetName}」。`);
  console.log('   如需还原：见 数据库备份/升云功能-20261020/ 里的两张学生表备份。');
  child.kill();
  process.exitCode = fails.length ? 1 : 0;
})().catch((e) => {
  console.error('脚本异常：', e.message);
  child.kill();
  process.exitCode = 1;
});
