/**
 * 校验「初高 · 学生档案」新增学生（dept_code NOT NULL 回归）
 * ============================================================
 *
 * 【背景】
 *   初高表单没有「部门」字段，前端传 `deptCode: null`。
 *   旧实现把 null 显式写进 SQL → 列上的 `DEFAULT 1` 失效 →
 *   `Column 'dept_code' cannot be null`，新增学生直接 500。
 *
 * 本脚本用校长账号（可写、有初高学生权限）真实创建一名学生再删掉：
 *   ① 创建返回 200（不再报 dept_code）
 *   ② 库里该学生的 dept_code = 1（走默认值，初高部）
 *   ③ 删除返回 200，脚本可重复执行
 *
 * 用法：node tools/verify-student-create-jh.mjs
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const BASE = 'http://localhost:8004';
const ACCOUNT = 'qiansy'; // 校长：可写 + 初高全量
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
const repo = read('server-job/src/teaching/student/repo.classJh.ts');
check('初高仓储不再把 dept_code 写 null', repo.includes("set('dept_code', body.deptCode ?? undefined)"));
check('保留 NOT NULL 说明注释', repo.includes("dept_code' cannot be null") || repo.includes('DEFAULT 1'));

console.log('\n▶ 运行时检查（校长 qiansy）');
const login = await req('POST', '/api/portal/account/login', { body: { account: ACCOUNT, password: PWD } });
if (login.status !== 200 || !login.body?.data?.token) {
  check('登录', false, `HTTP ${login.status}`);
} else {
  check('登录', true);
  const token = login.body.data.token;
  const studentNo = `TEST${Date.now()}`;

  const save = await req('POST', '/api/teaching/student/save', {
    token,
    body: { stage: 'jh', studentName: '校验测试生', gender: 1, studentNo, studentStatus: 3 },
  });
  const id = save.body?.data?.id;
  check('新增初高学生 200', save.status === 200 && save.body?.code === 200 && !!id, save.body?.message || save.raw.slice(0, 100));

  if (id) {
    // 直接用 mysql 查一下落库的 dept_code（连接信息从 server-job/.env 读）
    let dept = '';
    try {
      const env = read('server-job/.env');
      const pwd = /^DB_PASSWORD=(.*)$/m.exec(env)?.[1]?.trim() || '';
      const out = execFileSync(
        'mysql',
        ['-uroot', `-p${pwd}`, '-N', '-e', `SELECT dept_code FROM sms_class_jh.t_class_student WHERE id='${id}'`],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      );
      dept = out.trim();
    } catch {
      dept = '';
    }
    check('落库 dept_code=1（初高部）', dept === '1', `dept_code=${dept || '查询失败'}`);

    const del = await req('DELETE', `/api/teaching/student/delete?stage=jh&id=${encodeURIComponent(id)}`, { token });
    check('清理测试学生', del.status === 200 && del.body?.code === 200, del.body?.message || `HTTP ${del.status}`);
  }
}

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
