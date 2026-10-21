/**
 * 校验「楼栋设置」独立页面（教务老师可见，且不连带系统设置其它页签）
 * ============================================================
 *
 * 静态：
 *   ① 前端有 /class-jh/building 路由 + 菜单项（权限码 classjh:building:view）
 *   ② 后端 pagePermissions / pageRegistry 注册了该页面
 *   ③ CLASS_JH_ACAD_PAGES 含 classjh:building:view；R08 台账 KEEP 含 /class-jh/building
 *   ④ 系统设置页仍复用公共面板（没有复制两份楼栋逻辑）
 *
 * 运行时（教务老师 zhengym）：
 *   ① 持有 classjh:building:view、**不**持有 classjh:setting:view
 *   ② /api/teaching/building/list = 200（能读楼栋）
 *
 * 用法：node tools/verify-acad-building-page.mjs
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const BASE = 'http://localhost:8004';
const ACCOUNT = 'zhengym';
const PWD = '123456';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function read(rel) {
  try {
    return readFileSync(join(ROOT, rel), 'utf8');
  } catch {
    return '';
  }
}

async function req(method, url, { token, body } = {}) {
  const r = await fetch(BASE + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const raw = await r.text();
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return { status: r.status, body: json, raw };
}

console.log('▶ 静态检查');
const menu = read('web-job/src/config/menu.ts');
const router = read('web-job/src/router/index.ts');
const setting = read('web-job/src/class-jh/views/SettingList.vue');
const perms = read('server-job/src/config/pagePermissions.ts');
const registry = read('server-job/src/perm/config/pageRegistry.ts');
const source = read('server-job/src/utils/pagePermissionSource.ts');
const ledger = read('server-job/scripts/perm-role-page-acad-staff.ts');

check('菜单有「楼栋设置」且挂 classjh:building:view', /title:\s*'楼栋设置'/.test(menu) && menu.includes('classjh:building:view'));
check('路由 /class-jh/building → BuildingList.vue', router.includes("path: '/class-jh/building'") && router.includes('BuildingList.vue'));
check('pagePermissions 注册 classjh:building:view', perms.includes("code: 'classjh:building:view'"));
check('pageRegistry 注册 /class-jh/building', registry.includes("path: '/class-jh/building'") && registry.includes('classjh:building:view'));
check('CLASS_JH_ACAD_PAGES 含 classjh:building:view', /CLASS_JH_ACAD_PAGES[\s\S]{0,300}classjh:building:view/.test(source));
check('R08 台账 KEEP 含 /class-jh/building', /KEEP\s*=\s*\[[^\]]*'\/class-jh\/building'/.test(ledger));
check('系统设置页复用公共面板', setting.includes('BuildingSettingPanel') && !setting.includes('saveDormBuilding'));

console.log('\n▶ 运行时检查（教务老师 zhengym）');
const login = await req('POST', '/api/portal/account/login', { body: { account: ACCOUNT, password: PWD } });
if (login.status !== 200 || !login.body?.data?.token) {
  check('登录', false, `HTTP ${login.status} ${login.raw.slice(0, 120)}`);
} else {
  check('登录', true);
  const token = login.body.data.token;

  const myPages = await req('GET', '/api/job/auth/my-pages', { token });
  const list = myPages.body?.data?.permissions || myPages.body?.data?.perms || [];
  check('持有 classjh:building:view', list.includes('classjh:building:view'));
  check('不持有 classjh:setting:view', !list.includes('classjh:setting:view'));

  const buildings = await req('GET', '/api/teaching/building/list', { token });
  check('楼栋列表 200', buildings.status === 200, `共 ${(buildings.body?.data || []).length} 栋`);
}

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
