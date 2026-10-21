#!/usr/bin/env node
/**
 * 工作台 = 系统首页 —— 端到端验证（API 层）
 * ============================================================
 *
 * 验证 2026-10-16 用户指令「将工作台放置首页，每个角色进来第一个页面就是工作台」：
 *
 *   ① 全部演示账号登录成功，且服务端下发的 landingPath 统一为 '/'（工作台首页）
 *   ② 工作台统计接口（首页 KPI 块数据源）：
 *      · 初高班主任（sunmin）→ 200 且有数据
 *      · 大学部班主任（zhanght，门户未授权 class-jh 模块）→ 被模块权限闸拦下
 *   ③ 首页 KPI 块的显隐依据：sunmin 的 my-pages 含 /class-jh/dashboard 页面码；
 *      纯门户账号（zhoum 财务）不含 → 其首页只显示快捷入口
 *
 * 用法：
 *   node tools/verify-workbench.mjs
 *   （后端未启动会失败，请先 `npm run dev`）
 *
 * ⚠️ 本脚本只做读操作 + 「应被权限拦下」的请求，不会写库，可安全重复执行。
 */

import process from 'node:process';

// 绕开沙箱/系统代理，否则本机请求会得到误导性 502
process.env.NO_PROXY = '127.0.0.1,localhost';
process.env.no_proxy = '127.0.0.1,localhost';

const BASE = process.env.SMS_BASE || 'http://127.0.0.1:8004';
const PW = '123456';

/** 与 Login.vue demoAccounts 一致的演示账号（2026-10-16 口径） */
const ACCOUNTS = [
  'admin', 'wangjl', 'lilx', 'zhangls', 'zhoum', 'liukj', 'linx',
  'qiansy', 'congym', 'zhanght', 'sunmin', 'zhengym', 'sunjl', 'zhouj',
];

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✅ ${name}`);
  } else {
    fail += 1;
    failures.push(name);
    console.log(`  ❌ ${name}${detail ? `  → ${detail}` : ''}`);
  }
}

async function http(method, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, body: json };
}

async function main() {
  console.log('\n═══ 工作台 = 系统首页 验证 ═══\n');

  /* ---------- ① 全角色登录 → landingPath 统一 '/' ---------- */
  console.log('[1] 全角色登录，服务端落地路径统一为 /');
  const tokens = {};
  for (const acc of ACCOUNTS) {
    const r = await http('POST', '/api/portal/account/login', {
      body: { account: acc, password: PW },
    });
    const d = r.body?.data || {};
    tokens[acc] = d.token || '';
    check(
      `${acc} 登录且落地 = /`,
      !!d.token && d.landingPath === '/',
      `token=${!!d.token} landingPath=${JSON.stringify(d.landingPath)}`,
    );
  }

  /* ---------- ② 工作台统计接口（首页 KPI 块数据源） ---------- */
  console.log('\n[2] 工作台统计接口权限（/api/class-jh/dashboard/stat）');
  {
    const r = await http('GET', '/api/class-jh/dashboard/stat', { token: tokens.sunmin });
    const stat = r.body?.data || {};
    check(
      'sunmin（初高班主任）可读统计且有数据',
      r.status === 200 && r.body?.code === 200 && typeof stat.readingStudentCount === 'number',
      `status=${r.status} code=${r.body?.code}`,
    );

    const r2 = await http('GET', '/api/class-jh/dashboard/stat', { token: tokens.zhanght });
    const denied = r2.status === 403 || r2.body?.code === 40302;
    check(
      'zhanght（大学部，未授权 class-jh 模块）被拦下',
      denied,
      `status=${r2.status} code=${r2.body?.code}`,
    );
  }

  /* ---------- ③ 首页 KPI 块显隐依据（my-pages） ---------- */
  console.log('\n[3] 首页 KPI 块显隐依据（/api/job/auth/my-pages）');
  {
    const r = await http('GET', '/api/job/auth/my-pages', { token: tokens.sunmin });
    const pages = r.body?.data?.pages || [];
    check(
      'sunmin my-pages 含 /class-jh/dashboard',
      pages.some((p) => p.path === '/class-jh/dashboard'),
      `pages=${pages.length}`,
    );

    const r2 = await http('GET', '/api/job/auth/my-pages', { token: tokens.zhoum });
    const pages2 = r2.body?.data?.pages || [];
    check(
      'zhoum（财务）my-pages 不含初高工作台',
      !pages2.some((p) => p.path === '/class-jh/dashboard'),
      `pages=${pages2.length}`,
    );
  }

  /* ---------- 汇总 ---------- */
  console.log('\n═══ 汇总 ═══');
  console.log(`PASS ${pass}/${pass + fail}`);
  if (fail) {
    failures.forEach((f) => console.log(`  FAILED: ${f}`));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('脚本异常：', e?.message || e);
  process.exit(1);
});
