/**
 * 回归验证：班级【升实训】（2026-10-20 批注）
 * ============================================================
 * 批注原文（班级管理页）：
 *   「【升实训】：部门选择为就业部，不再有班主任，教员，助教，选择项目经理，
 *     就业老师，班级名称可以进行修改，选择就业部的阶段方案」
 *   追问确认：入口在【交接】后面；整班全部转入；升实训=改变部门，班名可改可留。
 *
 * 断言：
 *   ① 大学部班级行有【升实训】，初高部/就业部行没有；
 *   ② 弹窗：原班级只读、部门=就业部（只读）、班名默认原班名可改、
 *      阶段只列就业部方案的阶段、项目经理/就业老师可选；
 *   ③ 提交后提示成功，大学部少了这个班、实训多了新班；
 *   ④ 新班详情：班主任/教员/助教为空，项目经理/就业老师有值，花名册人数正确。
 *
 * ⚠️ 会真实改数据。跑完用 数据库备份/升实训-20261020/ 恢复，或按脚本末尾提示回滚。
 * 用法：node tools/_verify-training-upgrade.mjs
 * 产物：tools/_out/verify_training_*.png
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUTDIR = path.join(HERE, '_out');
fs.mkdirSync(OUTDIR, { recursive: true });
const PORT = 9361;
const BASE = 'http://localhost:5173';
/** 要升实训的大学部班级 */
const SRC_CLASS = process.env.TRAIN_CLASS || 'U2602';
const NEW_NAME = 'U2602实训班';

const BROWSER = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => fs.existsSync(p));
if (!BROWSER) { console.log('NO BROWSER'); process.exit(1); }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-train-'));
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
async function clickVisible(sel, contains=''){
  const r = await ev(`(()=>{const l=[...document.querySelectorAll(${JSON.stringify(sel)})].filter(e=>{const b=e.getBoundingClientRect();return b.width>0&&b.height>0&&(!${JSON.stringify(contains)}||e.innerText.includes(${JSON.stringify(contains)}));});
    const el=l[l.length-1]; if(!el)return null; const b=el.getBoundingClientRect(); return {x:b.left+b.width/2,y:b.top+b.height/2};})()`);
  if (!r) return false;
  await clickAt(r.x, r.y); await sleep(400); return true;
}
/** 打开弹窗里 label 对应的下拉，返回选项文本 */
async function readSelect(label){
  const rect = await ev(`(()=>{const d=[...document.querySelectorAll('.el-dialog')].find(x=>x.offsetParent!==null&&x.innerText.includes('升实训'));
    if(!d)return null;
    const item=[...d.querySelectorAll('.el-form-item')].find(it=>(it.querySelector('.el-form-item__label')?.innerText||'').trim()===${JSON.stringify(label)});
    const wrap=item?.querySelector('.el-select__wrapper'); if(!wrap)return null;
    const b=wrap.getBoundingClientRect(); return {x:b.left+b.width/2,y:b.top+b.height/2};})()`);
  if (!rect) return null;
  await clickAt(rect.x, rect.y);
  await sleep(700);
  const opts = await ev(`(()=>{const p=[...document.querySelectorAll('.el-select__popper')].filter(x=>x.getBoundingClientRect().width>0);
    const panel=p[p.length-1]; if(!panel)return [];
    return [...panel.querySelectorAll('.el-select-dropdown__item')].map(x=>x.innerText.trim());})()`);
  return opts || [];
}
const fails=[]; const check=(n,ok,d='')=>{ console.log(`  ${ok?'PASS':'FAIL'}  ${n}${d?'  → '+d:''}`); if(!ok)fails.push(n); };

(async()=>{
  ws = new WebSocket(await getTarget());
  await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej;});
  ws.onmessage=(e)=>{ let m; try{m=JSON.parse(e.data);}catch{return;}
    if(m.method==='Runtime.exceptionThrown') pageErrors.push(m.params?.exceptionDetails?.exception?.description||'unknown');
    if(m.id&&pending.has(m.id)){const {res,rej,to}=pending.get(m.id);clearTimeout(to);pending.delete(m.id);m.error?rej(new Error(m.error.message)):res(m.result);} };
  await send('Page.enable'); await send('Runtime.enable');

  check('登录成功（校长 qiansy）', await loginAs('qiansy'));
  await nav('/teaching/class', 3800);

  // ① 按钮按学段显隐
  const btnInfo = await ev(`(()=>{
    const rows=[...document.querySelectorAll('.el-table__row')];
    const pick=(name)=>{const tr=rows.find(x=>x.innerText.includes(name)); return tr?[...tr.querySelectorAll('button')].map(b=>b.innerText.trim()):[];};
    return { uni: pick(${JSON.stringify(SRC_CLASS)}), jh: pick('G2601'), emp: pick('SX2601') };
  })()`);
  check('大学部行有【升实训】', (btnInfo?.uni||[]).includes('升实训'), JSON.stringify(btnInfo?.uni));
  check('初高部行没有【升实训】', !(btnInfo?.jh||[]).includes('升实训'), JSON.stringify(btnInfo?.jh));
  check('就业部行没有【升实训】', !(btnInfo?.emp||[]).includes('升实训'), JSON.stringify(btnInfo?.emp));
  check('操作列顺序：详情/编辑/交接/升实训/删除',
    JSON.stringify(btnInfo?.uni||[]) === JSON.stringify(['详情','编辑','交接','升实训','删除']), JSON.stringify(btnInfo?.uni));

  // ② 打开弹窗
  const opened = await ev(`(()=>{const tr=[...document.querySelectorAll('.el-table__row')].find(x=>x.innerText.includes(${JSON.stringify(SRC_CLASS)}));
    const b=tr&&[...tr.querySelectorAll('button')].find(x=>x.innerText.trim()==='升实训'); if(!b)return false; b.click(); return true;})()`);
  await sleep(1600);
  check('打开升实训弹窗', opened === true);

  const dlgInfo = await ev(`(()=>{const d=[...document.querySelectorAll('.el-dialog')].find(x=>x.offsetParent!==null&&x.innerText.includes('升实训'));
    if(!d)return null;
    const inputs=[...d.querySelectorAll('.el-form-item')].map(it=>({
      label:(it.querySelector('.el-form-item__label')?.innerText||'').trim(),
      value: it.querySelector('input')?.value ?? '',
      disabled: !!it.querySelector('input')?.disabled,
    }));
    return { title:d.querySelector('.el-dialog__title')?.innerText||'', inputs, tip:d.innerText.includes('不再有班主任') };})()`);
  check('弹窗标题是「升实训（大学部 → 就业部）」', /升实训/.test(dlgInfo?.title || ''), dlgInfo?.title);
  check('提示里写明不再有班主任/教员/助教', !!dlgInfo?.tip);
  const byLabel = (l) => (dlgInfo?.inputs || []).find((x) => x.label === l);
  check('原班级只读', byLabel('原班级')?.disabled === true && byLabel('原班级')?.value === SRC_CLASS, JSON.stringify(byLabel('原班级')));
  check('部门固定为「就业部」', byLabel('部门')?.value === '就业部', byLabel('部门')?.value);
  check('班级名称默认沿用原班名且可编辑',
    byLabel('班级名称')?.value === SRC_CLASS && byLabel('班级名称')?.disabled === false, JSON.stringify(byLabel('班级名称')));
  await shot('verify_training_dialog.png');

  // ③ 阶段下拉：只应有就业部方案的阶段
  const phaseOpts = await readSelect('阶段');
  check('阶段只列就业部方案（一/二/三阶段）',
    (phaseOpts || []).length > 0 && (phaseOpts || []).every((x) => /阶段/.test(x)) && !(phaseOpts || []).some((x) => /期|六阶段|五阶段/.test(x)),
    JSON.stringify(phaseOpts));
  await clickVisible('.el-select__popper .el-select-dropdown__item', (phaseOpts || [])[0] || '');
  await sleep(400);

  // ④ 改班级名称
  await ev(`(()=>{const d=[...document.querySelectorAll('.el-dialog')].find(x=>x.offsetParent!==null&&x.innerText.includes('升实训'));
    const item=[...d.querySelectorAll('.el-form-item')].find(it=>(it.querySelector('.el-form-item__label')?.innerText||'').trim()==='班级名称');
    const el=item?.querySelector('input'); if(!el)return false;
    const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; s.call(el,${JSON.stringify(NEW_NAME)});
    el.dispatchEvent(new Event('input',{bubbles:true})); return true;})()`);
  await sleep(400);

  // ⑤ 选项目经理 / 就业老师（都取下拉第一项）
  const pmOpts = await readSelect('项目经理');
  check('项目经理下拉有人员', (pmOpts || []).length > 0, JSON.stringify((pmOpts || []).slice(0, 3)));
  await clickVisible('.el-select__popper .el-select-dropdown__item', (pmOpts || [])[0] || '');
  await sleep(500);
  const etOpts = await readSelect('就业老师');
  check('就业老师下拉有人员', (etOpts || []).length > 0, JSON.stringify((etOpts || []).slice(0, 3)));
  await clickVisible('.el-select__popper .el-select-dropdown__item', (etOpts || [])[1] || (etOpts || [])[0] || '');
  await sleep(500);
  await shot('verify_training_filled.png');

  // ⑥ 提交
  await ev(`(()=>{const d=[...document.querySelectorAll('.el-dialog')].find(x=>x.offsetParent!==null&&x.innerText.includes('升实训'));
    const b=d&&[...d.querySelectorAll('.el-dialog__footer button')].find(x=>x.innerText.trim()==='确认升实训'); if(b)b.click(); return !!b;})()`);
  await sleep(900);
  const confirmText = await ev(`(()=>{const b=[...document.querySelectorAll('.el-message-box')].find(x=>x.offsetParent!==null);return b?b.innerText.replace(/\\s+/g,' ').trim():'';})()`);
  check('弹出升实训确认框', /升实训确认/.test(confirmText), confirmText.slice(0, 70));
  await ev(`(()=>{const b=[...document.querySelectorAll('.el-message-box')].find(x=>x.offsetParent!==null);
    const btn=b&&[...b.querySelectorAll('button')].find(x=>x.innerText.trim()==='确定'); if(btn)btn.click(); return !!btn;})()`);
  await sleep(2600);
  const toast = await ev(`(()=>{const l=[...document.querySelectorAll('.el-message')];const m=l[l.length-1];return m?m.innerText.replace(/\\s+/g,' ').trim():'';})()`);
  check('提示升实训成功', /已升实训/.test(toast), toast);
  await shot('verify_training_done.png');

  // ⑦ 列表核实：大学部少一个班，实训多一个
  await ev(`(()=>{const el=[...document.querySelectorAll('.tsv-filter input')].find(x=>x.placeholder&&x.placeholder.includes('班级名'));
    if(!el)return false;const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(el,${JSON.stringify(NEW_NAME)});el.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
  await sleep(300);
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='查询');if(b)b.click();return !!b;})()`);
  await sleep(2000);
  const newRow = await ev(`(()=>{const tr=[...document.querySelectorAll('.el-table__row')].find(x=>x.innerText.includes(${JSON.stringify(NEW_NAME)}));
    return tr?tr.innerText.replace(/\\s+/g,' ').trim():'';})()`);
  check('实训列表里出现新班级', !!newRow, newRow);
  check('新班级部门是「就业部」', newRow.includes('就业部'), newRow);
  const newRowButtons = await ev(`(()=>{const tr=[...document.querySelectorAll('.el-table__row')].find(x=>x.innerText.includes(${JSON.stringify(NEW_NAME)}));
    return tr?[...tr.querySelectorAll('button')].map(b=>b.innerText.trim()):[];})()`);
  check('新班级不再显示【升实训】', !(newRowButtons || []).includes('升实训'), JSON.stringify(newRowButtons));

  // ⑧ 新班详情：岗位与人数
  await ev(`(()=>{const tr=[...document.querySelectorAll('.el-table__row')].find(x=>x.innerText.includes(${JSON.stringify(NEW_NAME)}));
    const b=tr&&[...tr.querySelectorAll('button')].find(x=>x.innerText.trim()==='详情'); if(b)b.click(); return !!b;})()`);
  await sleep(1800);
  const detailText = await ev(`(()=>{const d=[...document.querySelectorAll('.el-drawer')].find(x=>x.offsetParent!==null);
    return d?d.innerText.replace(/\\s+/g,' ').trim():'';})()`);
  // el-descriptions(border) 里 label 与 value 是两个独立的 cell → 按「label 的下一格」取值最稳
  const descPairs = await ev(`(()=>{const d=[...document.querySelectorAll('.el-drawer')].find(x=>x.offsetParent!==null);
    if(!d)return {};
    const cells=[...d.querySelectorAll('.el-descriptions__cell')].map(c=>c.innerText.trim());
    const get=(label)=>{const i=cells.indexOf(label); return i>=0?(cells[i+1]??''):null;};
    return { head:get('班主任'), teacher:get('教员'), assistant:get('助教'), pm:get('项目经理'), et:get('就业老师') };})()`);
  check('详情里班主任为空', !descPairs?.head || descPairs.head === '—', JSON.stringify(descPairs));
  check('详情里教员/助教为空', (!descPairs?.teacher || descPairs.teacher === '—') && (!descPairs?.assistant || descPairs.assistant === '—'));
  check('详情里项目经理有值', !!descPairs?.pm && descPairs.pm !== '—', JSON.stringify(descPairs?.pm));
  check('详情里就业老师有值', !!descPairs?.et && descPairs.et !== '—', JSON.stringify(descPairs?.et));
  check('花名册人数 = 5', /花名册（5 人）/.test(detailText), (detailText.match(/花名册（\\d+ 人）/) || [])[0] || '');
  await shot('verify_training_detail.png');

  check('无未捕获异常', pageErrors.length === 0, pageErrors[0] || '');

  console.log(`\n${fails.length ? 'FAILED: ' + fails.join(' / ') : 'ALL PASS'}`);
  console.log(`\n⚠️ 真实改数据：${SRC_CLASS} 已整班升实训为「${NEW_NAME}」。`);
  console.log('   回滚：删新班/新学生/新花名册，并把原班与原学生 is_deleted 改回 0（见 数据库备份/升实训-20261020/）。');
  child.kill();
  process.exitCode = fails.length ? 1 : 0;
})().catch((e)=>{ console.error('脚本异常：', e.message); child.kill(); process.exitCode = 1; });
