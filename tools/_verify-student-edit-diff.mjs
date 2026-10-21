/**
 * 回归验证：编辑学生保存前的「确认修改内容」（2026-10-20 批注）
 * ============================================================
 * 批注原文：「若更改编辑学生，点击保存，则会出现我修改的内容有什么，是否更改」
 *
 * 断言：
 *   ① 什么都不改点保存 → 提示「未检测到修改内容」，不弹确认框；
 *   ② 改备注后保存 → 弹「确认修改内容」，逐条列出「原值 → 新值」；
 *   ③ 点「返回修改」→ 不保存（弹窗还在，备注仍是新值）；
 *   ④ 再点保存 → 点「确定保存」→ 提示已保存，重新打开编辑看到新值；
 *   ⑤ 最后把备注改回原样（脚本自己还原数据）。
 *
 * 用法：node tools/_verify-student-edit-diff.mjs   （前后端需在跑：8004 + 5173）
 * 产物：tools/_out/verify_edit_diff_*.png
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUTDIR = path.join(HERE, '_out');
fs.mkdirSync(OUTDIR, { recursive: true });
const PORT = 9355;
const BASE = 'http://localhost:5173';
const TEST_NO = process.env.EDIT_NO || 'J26001';
const NEW_REMARK = '演示学生-变更测试';

const BROWSER = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => fs.existsSync(p));
if (!BROWSER) { console.log('NO BROWSER'); process.exit(1); }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-diff-'));
const child = spawn(BROWSER, ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port='+PORT,'--user-data-dir='+profile,'--window-size=1680,1050','about:blank'], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, msgId = 0; const pending = new Map(); const pageErrors = [];
async function getTarget() { for (let i=0;i<40;i++){ try{const r=await fetch(`http://127.0.0.1:${PORT}/json/list`);const l=await r.json();const p=l.find(t=>t.type==='page');if(p?.webSocketDebuggerUrl)return p.webSocketDebuggerUrl;}catch{} await sleep(250);} throw new Error('no target'); }
function send(m,p={}){ return new Promise((res,rej)=>{const i=++msgId;const to=setTimeout(()=>rej(new Error('timeout '+m)),30000);pending.set(i,{res,rej,to});ws.send(JSON.stringify({id:i,method:m,params:p}));}); }
async function ev(e){ const r = await send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true}); return r.result?.value; }
async function shot(n){ const r = await send('Page.captureScreenshot',{format:'png'}); fs.writeFileSync(path.join(OUTDIR,n), Buffer.from(r.data,'base64')); }
async function nav(hash, wait=2800){ await send('Page.navigate',{url:`${BASE}/?t=${Date.now()}#${hash}`},30000); await sleep(wait); }
async function loginAs(account){
  for (let attempt=1; attempt<=3; attempt++){
    await ev(`(()=>{try{localStorage.clear();}catch(e){}return true;})()`);
    await nav('/login', 3000);
    await ev(`(()=>{const el=[...document.querySelectorAll('.demo-item')].find(x=>x.innerText.includes('${account}'));if(el)el.click();return !!el;})()`);
    await sleep(800);
    await ev(`(()=>{const b=document.querySelector('.submit');if(b)b.click();return !!b;})()`);
    await sleep(4200);
    if (await ev(`document.body.innerText.includes('退出登录')`)) return true;
    console.log(`  （第 ${attempt} 次登录未成功，重试）`);
  }
  return false;
}
const fails = [];
const check = (n, ok, d='') => { console.log(`  ${ok?'PASS':'FAIL'}  ${n}${d?'  → '+d:''}`); if(!ok) fails.push(n); };

/** 搜索学生并点【编辑】 */
async function openEditOf(no) {
  await ev(`(()=>{const el=[...document.querySelectorAll('.tsv-filter input')].find(x=>x.placeholder&&x.placeholder.includes('姓名'));
    if(!el)return false;const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(el,${JSON.stringify(no)});el.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
  await sleep(300);
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='查询');if(b)b.click();return !!b;})()`);
  await sleep(1800);
  const clicked = await ev(`(()=>{const tr=[...document.querySelectorAll('.el-table__row')].find(x=>x.innerText.includes(${JSON.stringify(no)}));
    const b=tr&&[...tr.querySelectorAll('button')].find(x=>x.innerText.trim()==='编辑');if(!b)return false;b.click();return true;})()`);
  await sleep(1800);
  return clicked;
}
/** 读编辑弹窗里备注输入框的值 */
function readRemark() {
  return ev(`(()=>{const d=[...document.querySelectorAll('.el-dialog')].find(x=>x.offsetParent!==null&&x.innerText.includes('编辑学生'));if(!d)return null;const ta=d.querySelector('textarea');return ta?ta.value:null;})()`);
}
/** 写备注 */
function writeRemark(val) {
  return ev(`(()=>{const d=[...document.querySelectorAll('.el-dialog')].find(x=>x.offsetParent!==null&&x.innerText.includes('编辑学生'));if(!d)return false;
    const ta=d.querySelector('textarea');if(!ta)return false;
    const s=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;s.call(ta,${JSON.stringify(val)});
    ta.dispatchEvent(new Event('input',{bubbles:true}));return ta.value;})()`);
}
async function clickFooter(text) {
  return ev(`(()=>{const d=[...document.querySelectorAll('.el-dialog')].find(x=>x.offsetParent!==null&&(x.innerText.includes('编辑学生')||x.innerText.includes('新增学生')));
    const b=d&&[...d.querySelectorAll('.el-dialog__footer button')].find(x=>x.innerText.trim()===${JSON.stringify(text)});if(!b)return false;b.click();return true;})()`);
}
async function boxText() {
  return ev(`(()=>{const b=[...document.querySelectorAll('.el-message-box')].find(x=>x.offsetParent!==null);return b?b.innerText.replace(/\\s+/g,' ').trim():'';})()`);
}
async function clickBoxBtn(text) {
  return ev(`(()=>{const b=[...document.querySelectorAll('.el-message-box')].find(x=>x.offsetParent!==null);
    const btn=b&&[...b.querySelectorAll('button')].find(x=>x.innerText.trim()===${JSON.stringify(text)});if(!btn)return false;btn.click();return true;})()`);
}
async function lastToast() {
  // ⚠️ el-message 是 fixed，offsetParent 恒 null，直接取最后一个
  return ev(`(()=>{const l=[...document.querySelectorAll('.el-message')];const m=l[l.length-1];return m?m.innerText.replace(/\\s+/g,' ').trim():'';})()`);
}
async function dialogOpen() {
  return ev(`(()=>!![...document.querySelectorAll('.el-dialog')].find(x=>x.offsetParent!==null&&x.innerText.includes('编辑学生')))()`);
}

(async () => {
  ws = new WebSocket(await getTarget());
  await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej;});
  ws.onmessage = (e)=>{ let m; try{m=JSON.parse(e.data);}catch{return;}
    if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params?.exceptionDetails?.exception?.description || 'unknown');
    if (m.id && pending.has(m.id)) { const {res,rej,to}=pending.get(m.id); clearTimeout(to); pending.delete(m.id); m.error?rej(new Error(m.error.message)):res(m.result); } };
  await send('Page.enable'); await send('Runtime.enable');

  check('登录成功（校长 qiansy）', await loginAs('qiansy'));
  await nav('/teaching/student', 3600);

  // ① 不改任何内容点保存
  check(`打开 ${TEST_NO} 的编辑弹窗`, await openEditOf(TEST_NO));
  const origin = await readRemark();
  check('读到原备注', typeof origin === 'string', JSON.stringify(origin));
  await clickFooter('保存');
  await sleep(1200);
  check('无改动时提示「未检测到修改内容」', /未检测到修改内容/.test(await lastToast()), await lastToast());
  check('无改动时不弹确认框', (await boxText()) === '');
  check('无改动时直接关闭编辑弹窗', (await dialogOpen()) === false);

  // ② 改备注后保存 → 出现「我修改的内容」
  check('再次打开编辑弹窗', await openEditOf(TEST_NO));
  await writeRemark(NEW_REMARK);
  await sleep(400);
  await clickFooter('保存');
  await sleep(1300);
  const confirmText = await boxText();
  check('弹出「确认修改内容」', confirmText.includes('确认修改内容'), confirmText.slice(0, 60));
  check('清单里列出「备注」这一项', confirmText.includes('备注'));
  check('清单里能看到原值', !!origin && confirmText.includes(origin), `原值：${origin}`);
  check('清单里能看到新值', confirmText.includes(NEW_REMARK), `新值：${NEW_REMARK}`);
  await shot('verify_edit_diff_confirm.png');

  // ③ 返回修改 → 不保存
  await clickBoxBtn('返回修改');
  await sleep(800);
  check('点「返回修改」后编辑弹窗还在', await dialogOpen() === true);
  check('点「返回修改」后备注仍是新值（未提交）', (await readRemark()) === NEW_REMARK);

  // ④ 再保存 → 确定保存
  await clickFooter('保存');
  await sleep(1200);
  await clickBoxBtn('确定保存');
  await sleep(2200);
  check('确定保存后提示已保存', /已保存/.test(await lastToast()), await lastToast());
  check('保存后编辑弹窗关闭', (await dialogOpen()) === false);
  await shot('verify_edit_diff_saved.png');

  // ⑤ 重新打开确认落库 + 还原数据
  await openEditOf(TEST_NO);
  check('重新打开看到新备注已落库', (await readRemark()) === NEW_REMARK, await readRemark());
  await writeRemark(origin || '');
  await sleep(400);
  await clickFooter('保存');
  await sleep(1200);
  const restoreBox = await boxText();
  check('还原时同样弹确认框', restoreBox.includes('确认修改内容'), restoreBox.slice(0, 40));
  await clickBoxBtn('确定保存');
  await sleep(2000);
  await openEditOf(TEST_NO);
  check('备注已还原为原值', (await readRemark()) === (origin || ''), await readRemark());

  check('无未捕获异常', pageErrors.length === 0, pageErrors[0] || '');

  console.log(`\n${fails.length ? 'FAILED: ' + fails.join(' / ') : 'ALL PASS'}`);
  child.kill();
  process.exitCode = fails.length ? 1 : 0;
})().catch((e)=>{ console.error('脚本异常：', e.message); child.kill(); process.exitCode = 1; });
