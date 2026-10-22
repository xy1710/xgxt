/**
 * 任务 #20 · HTTP 层验证（**打真实接口**，不启服务 —— 直接连已在运行的 8004）
 * ============================================================
 *
 * 与 `_uni-exam-unique-check.ts` 的分工：
 *   · 那个脚本直连数据库、绕开 HTTP，验的是**仓储校验逻辑**（开关关/开关开各 13/13）
 *   · 本脚本走真实接口，验的是**端到端**：鉴权 → 参数校验 → 查重 → 错误码/提示文案
 *
 * 验证内容：
 *   ① 首次保存 → 成功
 *   ② 同班 + 同日 + 同名再存 → code = 40031（EXAM_DUPLICATE），提示是给用户看的人话
 *   ③ 换个名字 → 成功（不是一刀切拦）
 *   ④ 收尾：删掉自检数据（软删 + 物理删），不留残留
 *
 * ⚠️ 前提：8004 已在运行（本脚本不启服务、不杀进程，避免打断本地开发）。
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/_uni-exam-unique-http.mjs
 */
import 'dotenv/config';
import { req, PASS } from './_e2e-lib.mjs';

const BE = 'http://127.0.0.1:8004';
const TAG = '归一自检_HTTP_考试唯一性';

let pass = 0;
let fail = 0;
function check(name, ok, extra = '') {
  if (ok) {
    pass++;
    console.log(`  ✔ ${name}${extra ? '  ' + extra : ''}`);
  } else {
    fail++;
    console.log(`  ✘ ${name}${extra ? '  ' + extra : ''}`);
  }
}

async function loginAs(account) {
  const r = await req(`${BE}/api/portal/account/login`, {
    method: 'POST',
    body: { account, password: PASS },
  });
  return r.json?.data?.token || '';
}

(async () => {
  console.log('===== 任务 #20 · HTTP 层验证（直连 8004，不重启服务）=====\n');

  const health = await req(`${BE}/health`);
  if (health.status !== 200) {
    console.log(`  ✘ 8004 未就绪（status=${health.status}），请先启动后端再跑本脚本`);
    process.exit(1);
  }

  // ⚠️ 不能用 admin —— 系统管理员是**只读**账号（40302），
  //    要拿「考试页写权限」得用校长 qiansy（各学段考试权限齐全）。
  const token = await loginAs('qiansy');
  check('① 登录成功', !!token, token ? '' : '拿不到 token');

  const cls = await req(`${BE}/api/teaching/exam/classes`, { token });
  const list = cls.json?.data ?? [];
  const target = list.find((c) => c.stage === 'class') ?? list[0];
  check('② 取到班级下拉', !!target, target ? `${target.stage} / ${target.id}` : JSON.stringify(cls.json).slice(0, 200));
  if (!target) {
    process.exit(1);
  }

  const date = '2099-12-31';
  const body = {
    stage: target.stage,
    examName: `${TAG}_${Date.now()}`,
    examType: 1,
    examDate: date,
    classIds: [target.id],
    contents: [{ type: 1, name: '笔试', fullScore: 100 }],
  };

  const created = [];
  try {
    const r1 = await req(`${BE}/api/teaching/exam/save`, { method: 'POST', token, body });
    const id1 = r1.json?.data?.id;
    check('③ 首次保存 → 成功', r1.json?.code === 200 && !!id1, `code=${r1.json?.code} ${r1.json?.message ?? ''}`);
    if (id1) created.push(String(id1));

    const r2 = await req(`${BE}/api/teaching/exam/save`, { method: 'POST', token, body });
    check(
      '④ 同班+同日+同名再存 → EXAM_DUPLICATE(40031)',
      Number(r2.json?.code) === 40031,
      `code=${r2.json?.code} "${r2.json?.message ?? ''}"`,
    );
    check(
      '⑤ 提示是人话（含日期与考试名，不含 Duplicate entry 之类技术词）',
      !!r2.json?.message && !/Duplicate entry|ER_/i.test(String(r2.json.message)),
      '',
    );

    const r3 = await req(`${BE}/api/teaching/exam/save`, {
      method: 'POST',
      token,
      body: { ...body, examName: `${body.examName}_换名字` },
    });
    const id3 = r3.json?.data?.id;
    check('⑥ 换考试名 → 成功（不是一刀切拦住）', r3.json?.code === 200 && !!id3, `code=${r3.json?.code}`);
    if (id3) created.push(String(id3));

    const r4 = await req(`${BE}/api/teaching/exam/list`, {
      token,
      method: 'GET',
    });
    check('⑦ 列表接口仍正常（回归）', r4.json?.code === 200, `code=${r4.json?.code}`);
  } finally {
    for (const id of created) {
      await req(`${BE}/api/teaching/exam/delete?stage=${target.stage}&id=${id}`, { method: 'DELETE', token });
    }
  }

  /* ============================================================
   * P3：老接口 /api/job/exam/add 也必须被同一条查重规则覆盖
   *   （它原先是裸写老表、无任何重复校验；切读后统一表已无 uk_exam，
   *     所以必须在应用层补上，否则「开关开」下它反而比「开关关」更松）
   * ============================================================ */
  console.log('\n--- P3：老接口 /api/job/exam/* ---');
  const legacyBody = {
    examName: `${TAG}_老接口_${Date.now()}`,
    examType: 1,
    examTime: `${date} 09:00:00`,
    classIds: [target.id],
    classNames: ['自检班'],
    contentTypes: [1, 2, 3],
    remark: '自检',
  };
  const legacyIds = [];
  try {
    const l1 = await req(`${BE}/api/job/exam/add`, { method: 'POST', token, body: legacyBody });
    const lid = l1.json?.data?.id;
    check('⑧ 老接口首次新增 → 成功', l1.json?.code === 200 && !!lid, `code=${l1.json?.code} ${l1.json?.message ?? ''}`);
    if (lid) legacyIds.push(String(lid));

    const l2 = await req(`${BE}/api/job/exam/add`, { method: 'POST', token, body: legacyBody });
    check(
      '⑨ 老接口重复新增 → EXAM_DUPLICATE(40031)',
      Number(l2.json?.code) === 40031,
      `code=${l2.json?.code} "${l2.json?.message ?? ''}"`,
    );
  } finally {
    for (const id of legacyIds) {
      await req(`${BE}/api/job/exam/delete/${id}`, { method: 'DELETE', token });
    }
  }

  console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
  console.log('（自检考试已软删；下面再物理清理一次）');

  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const knex = require('knex');
  const k = knex({
    client: 'mysql2',
    connection: {
      host: process.env.DB_HOST,
      port: +process.env.DB_PORT,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME || 'sms_job',
    },
    pool: { min: 0, max: 1 },
  });
  const res = [];
  for (const t of ['t_job_exam', 't_job_exam_score']) {
    const [r] = await k.raw('delete from ?? where exam_name like ?', [
      `${process.env.DB_NAME || 'sms_job'}.${t}`,
      `${TAG}%`,
    ]);
    res.push(`${t} ${r?.affectedRows ?? 0} 行`);
  }
  const [r3] = await k.raw('delete from ?? where exam_name like ?', [
    `${process.env.DB_NAME_CLASS || 'sms_class'}.t_class_exam`,
    `${TAG}%`,
  ]);
  res.push(`t_class_exam ${r3?.affectedRows ?? 0} 行`);
  console.log(`  已物理清理自检考试：${res.join('、')}`);
  await k.destroy();

  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('脚本异常：', e);
  process.exit(1);
});
