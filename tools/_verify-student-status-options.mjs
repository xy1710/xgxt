/**
 * 回归验证：学生「状态」下拉选项（2026-10-20 批注）
 * ============================================================
 * 批注原文：
 *   ① 新增学生「状态选择，删除待咨询和咨询中」
 *   ② 编辑学生「状态：删除待咨询、咨询中的状态选择」
 *   ③ 「大学部的状态选择同步初中部状态选择保持一致」
 *
 * 断言：
 *   · 新增（初高部）状态下拉：没有「待咨询 / 咨询中」，有 试学中/正式在读/休学/退学/实训中/待就业
 *   · 编辑初高部学生：同上
 *   · 编辑大学部学生：选项集合与初高部**完全一致**
 *
 * 本脚本只读，不保存任何数据。
 * 用法：node tools/_verify-student-status-options.mjs   （前后端需在跑：8004 + 5173）
 * 产物：tools/_out/verify_status_options_*.png
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUTDIR = path.join(HERE, '_out');
fs.mkdirSync(OUTDIR, { recursive: true });
const PORT = 9357;
const BASE = 'http://localhost:5173';

const BROWSER = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => fs.existsSync(p));
if (!BROWSER) { console.log('NO BROWSER'); process.exit(1); }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-status-'));
const child = spawn(BROWSER, ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port='+PORT,'--user-data-dir='+profile,'--window-size=1680,1050','about:blank'], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, msgId = 0; const pending = new Map(); const pageErrors = [];
async function getTarget(){ for(let i=0;i<40;i++){ try{const r=await fetch(`http://127.0.0.1:${PORT}/json/list`);const l=await r.json();const p=l.find(t=>t.type==='page');if(p?.webSocketDebuggerUrl)return p.webSocketDebuggerUrl;}catch{} await sleep(250);} throw new Error('no target'); }
function send(m,p={}){ return new Promise((res,rej)=>{const i=++msgId;const to=setTimeout(()=>rej(new Error('timeout '+m)),30000);pending.set(i,{res,rej,to});ws.send(JSON.stringify({id:i,method:m,params:p}));}); }
async function ev(e){ const r=await send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true}); return r.result?.value; }
async function shot(n){ const r=await send('Page.captureScreenshot',{format:'png'}); fs.writeFileSync(path.join(OUTDIR,n), Buffer.from(r.data,'base64')); }
async function nav(hash,wait=2800){ await send('Page.navigate',{url:`${BASE}/?t=${Date.now()}#${hash}`},30000); await sleep(wait); }
async function loginAs(account){
  for (let a=1;a<=3;a++){
    await ev(`(()=>{try{localStorage.clear();}catch(e){}return true;})()`);
    await nav('/login',3000);
    await ev(`(()=>{const el=[...document.querySelectorAll('.demo-item')].find(x=>x.innerText.includes('${account}'));if(el)el.click();return !!el;})()`);
    await sleep(800);
    await ev(`(()=>{const b=document.querySelector('.submit');if(b)b.click();return !!b;})()`);
    await sleep(4200);
    if (await ev(`document.body.innerText.includes('退出登录')`)) return true;
    console.log(`  （第 ${a} 次登录未成功，重试）`);
  }
  return false;
}
async function clickAt(x,y){
  await send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});
  await send('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1});
}
/** 点击「可见的」元素（可选按文本过滤），取最后一个 */
async function clickVisible(sel, contains=''){
  const r = await ev(`(()=>{
    const l=[...document.querySelectorAll(${JSON.stringify(sel)})].filter(e=>{
      const b=e.getBoundingClientRect();
      return b.width>0&&b.height>0&&(!${JSON.stringify(contains)}||e.innerText.includes(${JSON.stringify(contains)}));
    });
    const el=l[l.length-1]; if(!el)return null;
    const b=el.getBoundingClientRect(); return {x:b.left+b.width/2,y:b.top+b.height/2};
  })()`);
  if (!r) return false;
  await clickAt(r.x, r.y);
  await sleep(400);
  return true;
}
/** 打开当前可见弹窗里 label=xxx 的下拉，返回选项文本数组 */
async function readOptsByLabel(label){
  const rect = await ev(`(()=>{
    const d=[...document.querySelectorAll('.el-dialog')].find(x=>x.offsetParent!==null);
    if(!d)return null;
    const item=[...d.querySelectorAll('.el-form-item')].find(it=>(it.querySelector('.el-form-item__label')?.innerText||'').trim()===${JSON.stringify(label)});
    const wrap=item?.querySelector('.el-select__wrapper');
    if(!wrap)return null;
    const r=wrap.getBoundingClientRect();
    return {x:r.left+r.width/2,y:r.top+r.height/2};
  })()`);
  if (!rect) return null;
  await clickAt(rect.x, rect.y);
  await sleep(700);
  const opts = await ev(`(()=>{
    const poppers=[...document.querySelectorAll('.el-select__popper')].filter(p=>p.getBoundingClientRect().width>0);
    const panel=poppers[poppers.length-1];
    if(!panel)return [];
    return [...panel.querySelectorAll('.el-select-dropdown__item')].map(x=>x.innerText.trim());
  })()`);
  return opts || [];
}
async function readStatusOptions(){
  const opts = await readOptsByLabel('状态');
  await shot(`verify_status_options_${Date.now()}.png`);
  await ev(`(()=>{document.body.click();return true;})()`);
  await sleep(300);
  return opts;
}
/** 在弹窗里选中某个下拉的某一项（按文本） */
async function pickOption(label, text){
  const opts = await readOptsByLabel(label);
  const hit = (opts || []).find((o) => o === text || o.includes(text));
  if (!hit) return false;
  const ok = await clickVisible('.el-select__popper .el-select-dropdown__item', hit);
  await sleep(600);
  return ok;
}
const fails=[];
const check=(n,ok,d='')=>{ console.log(`  ${ok?'PASS':'FAIL'}  ${n}${d?'  → '+d:''}`); if(!ok)fails.push(n); };

async function searchAndEdit(no){
  await ev(`(()=>{const el=[...document.querySelectorAll('.tsv-filter input')].find(x=>x.placeholder&&x.placeholder.includes('姓名'));
    if(!el)return false;const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(el,${JSON.stringify(no)});el.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
  await sleep(300);
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='查询');if(b)b.click();return !!b;})()`);
  await sleep(1700);
  const ok = await ev(`(()=>{const tr=[...document.querySelectorAll('.el-table__row')].find(x=>x.innerText.includes(${JSON.stringify(no)}));
    const b=tr&&[...tr.querySelectorAll('button')].find(x=>x.innerText.trim()==='编辑');if(!b)return false;b.click();return true;})()`);
  await sleep(1800);
  return ok;
}
async function closeDialog(){
  await ev(`(()=>{const d=[...document.querySelectorAll('.el-dialog')].find(x=>x.offsetParent!==null);
    const b=d&&[...d.querySelectorAll('.el-dialog__footer button')].find(x=>x.innerText.trim()==='取消');if(b)b.click();return !!b;})()`);
  await sleep(800);
}

(async()=>{
  ws = new WebSocket(await getTarget());
  await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej;});
  ws.onmessage=(e)=>{ let m; try{m=JSON.parse(e.data);}catch{return;}
    if(m.method==='Runtime.exceptionThrown') pageErrors.push(m.params?.exceptionDetails?.exception?.description||'unknown');
    if(m.id&&pending.has(m.id)){const {res,rej,to}=pending.get(m.id);clearTimeout(to);pending.delete(m.id);m.error?rej(new Error(m.error.message)):res(m.result);} };
  await send('Page.enable'); await send('Runtime.enable');

  check('登录成功（校长 qiansy）', await loginAs('qiansy'));
  await nav('/teaching/student', 3600);

  // ① 新增（默认初高部）
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='新增学生');if(b)b.click();return !!b;})()`);
  await sleep(1600);
  const createOpts = await readStatusOptions();
  check('新增学生：状态下拉能打开', Array.isArray(createOpts) && createOpts.length > 0, JSON.stringify(createOpts));
  check('新增学生：没有「待咨询」', !createOpts.includes('待咨询'), JSON.stringify(createOpts));
  check('新增学生：没有「咨询中」', !createOpts.includes('咨询中'));
  check('新增学生：保留 试学中/正式在读/休学/退学/实训中/待就业',
    ['试学中','正式在读','休学','退学','实训中','待就业'].every((x)=>createOpts.includes(x)), JSON.stringify(createOpts));

  // ★ 2026-10-20 批注：就业部状态要加「实训中」
  const pickedDept = await pickOption('部门', '就业部');
  check('新增学生：能把部门切到「就业部」', pickedDept === true);
  const jobOpts = await readStatusOptions();
  check('就业部状态下拉含「实训中」', (jobOpts || []).includes('实训中'), JSON.stringify(jobOpts));
  check('就业部状态不含 待咨询/咨询中/试学中/正式在读',
    !['待咨询','咨询中','试学中','正式在读'].some((x)=>jobOpts.includes(x)), JSON.stringify(jobOpts));
  await closeDialog();

  // ② 编辑初高部学生 J26007
  check('打开初高部学生 J26007 的编辑弹窗', await searchAndEdit('J26007'));
  const jhOpts = await readStatusOptions();
  check('编辑初高部：没有「待咨询/咨询中」', !jhOpts.includes('待咨询') && !jhOpts.includes('咨询中'), JSON.stringify(jhOpts));
  check('编辑初高部：选项与新增一致', JSON.stringify(jhOpts) === JSON.stringify(createOpts), JSON.stringify(jhOpts));
  await closeDialog();

  // ③ 编辑大学部学生 U26001
  check('打开大学部学生 U26001 的编辑弹窗', await searchAndEdit('U26001'));
  const uniOpts = await readStatusOptions();
  check('编辑大学部：没有「待咨询/咨询中」', !uniOpts.includes('待咨询') && !uniOpts.includes('咨询中'), JSON.stringify(uniOpts));
  check('大学部状态选项与初高部完全一致（批注③）',
    JSON.stringify(uniOpts) === JSON.stringify(jhOpts), `大学部 ${JSON.stringify(uniOpts)} / 初高部 ${JSON.stringify(jhOpts)}`);
  await closeDialog();

  check('无未捕获异常', pageErrors.length === 0, pageErrors[0] || '');

  console.log(`\n${fails.length ? 'FAILED: ' + fails.join(' / ') : 'ALL PASS'}`);
  child.kill();
  process.exitCode = fails.length ? 1 : 0;
})().catch((e)=>{ console.error('脚本异常：', e.message); child.kill(); process.exitCode = 1; });
