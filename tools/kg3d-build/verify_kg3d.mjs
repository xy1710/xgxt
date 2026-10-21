/* 3D 知识图谱 HTML 无头浏览器验证：控制台错误 + 截图 + 交互测试 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const OUTDIR = path.join(HERE, '_out');
fs.mkdirSync(OUTDIR, { recursive: true });

const TARGET = 'file:///D:/良志学管github版/xgxt/代码知识图谱3D.html';
const PORT = 9377;

const BROWSER = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => fs.existsSync(p));
if (!BROWSER) { console.log('NO BROWSER'); process.exit(1); }
console.log('browser:', BROWSER);

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kg3d-verify-'));
const child = spawn(BROWSER, [
  '--headless=new', '--no-first-run', '--no-default-browser-check',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
  '--window-size=1680,1000', '--hide-scrollbars', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws; let msgId = 0; const pending = new Map();
const errors = [];
const logs = [];

async function getTarget() {
  for (let i = 0; i < 60; i++) {
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
    const to = setTimeout(() => reject(new Error('timeout ' + method)), 60000);
    pending.set(id, { resolve, reject, to });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __error: r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || '') };
  return r.result?.value;
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUTDIR, name), Buffer.from(r.data, 'base64'));
  console.log('  shot:', name);
}

(async () => {
  ws = new WebSocket(await getTarget());
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject, to } = pending.get(m.id);
      pending.delete(m.id); clearTimeout(to);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      return;
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      errors.push((d.exception?.description || d.text || '').split('\n').slice(0, 3).join(' | '));
    }
    if (m.method === 'Runtime.consoleAPICalled') {
      const txt = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
      logs.push(m.params.type + ': ' + txt);
      if (m.params.type === 'error') errors.push('console.error: ' + txt);
    }
  };

  await send('Runtime.enable');
  await send('Page.enable');
  console.log('navigating…');
  await send('Page.navigate', { url: TARGET });
  await sleep(9000);

  const state = await ev(`(() => {
    const loading = document.getElementById('loading');
    return {
      canvases: document.querySelectorAll('canvas').length,
      loadingClass: loading ? loading.className : 'no-loading',
      hasFG: typeof ForceGraph3D === 'function',
      hasTHREE: typeof THREE === 'object',
      dataNodes: (window.KG3D_DATA && window.KG3D_DATA.nodes.length) || 0,
      dataLinks: (window.KG3D_DATA && window.KG3D_DATA.links.length) || 0,
      legendItems: document.querySelectorAll('.lg-item[data-li]').length,
      helpRows: document.querySelectorAll('#help-labels tr').length,
      canvasSize: (() => { const c = document.querySelector('canvas'); return c ? c.width + 'x' + c.height : 'none'; })(),
    };
  })()`);
  console.log('state:', JSON.stringify(state, null, 1));

  // 非空像素检测：确认 3D 场景真的画出了东西
  const px = await ev(`(() => {
    const c = document.querySelector('canvas');
    if (!c) return 'no-canvas';
    try {
      const off = document.createElement('canvas');
      off.width = 420; off.height = 260;
      const ctx = off.getContext('2d');
      ctx.drawImage(c, 0, 0, 420, 260);
      const d = ctx.getImageData(0, 0, 420, 260).data;
      let colored = 0;
      for (let i = 0; i < d.length; i += 4) {
        // 与背景 #eef2f7 不同的像素
        if (Math.abs(d[i] - 238) > 12 || Math.abs(d[i+1] - 242) > 12 || Math.abs(d[i+2] - 247) > 12) colored++;
      }
      return 'colored-pixels: ' + colored + ' / ' + (d.length / 4);
    } catch (e) { return 'draw-error: ' + e.message; }
  })()`);
  console.log('pixels:', px);

  await shot('01-overview.png');

  // 交互 1：搜索并选中一个热点节点（payload 函数）
  await ev(`(() => {
    const s = document.getElementById('search');
    s.value = 'payload';
    s.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(700);
  const sr = await ev(`document.querySelectorAll('#search-results .rel-item').length`);
  console.log('search hits:', sr);
  await shot('02-search.png');
  const clicked = await ev(`(() => {
    const it = document.querySelector('#search-results .rel-item');
    if (it) { it.click(); return it.innerText.slice(0, 60); }
    return 'none';
  })()`);
  console.log('clicked:', clicked);
  await sleep(2200);
  const panel = await ev(`(() => {
    const p = document.getElementById('detail-panel');
    const name = document.querySelector('.dp-name');
    const secs = document.querySelectorAll('.rel-sec').length;
    const items = document.querySelectorAll('.rel-item').length;
    const code = !!document.querySelector('.dp-code pre');
    return { hidden: p.className, name: name ? name.innerText : '', secs, items, code };
  })()`);
  console.log('panel:', JSON.stringify(panel));
  await shot('03-node-detail.png');

  // 交互 2：点击一条关系条目跳转
  const jumped = await ev(`(() => {
    const it = document.querySelector('#detail-body .rel-item');
    if (it) { it.click(); return document.querySelector('.dp-name').innerText.slice(0, 60); }
    return 'none';
  })()`);
  console.log('jumped to:', jumped);
  await sleep(1500);
  await shot('04-jumped.png');

  // 交互 3：帮助模态框
  await ev(`document.getElementById('btn-help').click()`);
  await sleep(500);
  await shot('05-help.png');
  await ev(`document.getElementById('help-close').click()`);

  // 交互 4：切换配色 + 过滤
  await ev(`(() => {
    const sel = document.getElementById('colorby');
    sel.value = 'cx'; sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(800);
  await shot('06-colorby-complexity.png');

  console.log('---- console errors (' + errors.length + ') ----');
  errors.slice(0, 12).forEach((e) => console.log('  [ERR]', e.slice(0, 300)));
  console.log('---- logs (' + logs.length + ') ----');
  logs.slice(0, 10).forEach((l) => console.log('  ', l.slice(0, 200)));

  ws.close();
  child.kill();
  process.exit(errors.length ? 3 : 0);
})().catch((e) => { console.error('FATAL', e); try { child.kill(); } catch {} process.exit(1); });
