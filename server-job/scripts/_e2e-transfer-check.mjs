/**
 * 自检 · 学生换班（末班 / 升班）
 * ============================================================
 * 覆盖点：
 *   ① 权限：班主任（只有成绩权限）能不能用 —— 这是拆独立前缀的原因；
 *      市场咨询这种无关角色必须被拦
 *   ② 旧路径已下线（防止前端漏改还能偷偷调通）
 *   ③ 落库：学生班籍 / repeat_count / 末班记录 / 转班记录
 *   ④ 进度规则：末班只能往「进度≤当前」，升班只能往「进度>当前」
 *
 * 运行：node scripts/_e2e-transfer-check.mjs
 * 依赖：后端 8004 + 前端 5173 + 数据库可用
 */

import { BASE, conn, killAll, login, req, startServices } from './_e2e-lib.mjs';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? '✅' : '❌'} ${name}${detail ? '  —— ' + detail : ''}`);
};

/* ★ 2026-10-21：原来硬编码 CLS-U2601/U2602，这两个班后来被软删了 →
 *   "班级不存在" 全线失败。改成自己造夹具（阶段 206 / 203，进度一快一慢）。 */
const FIX_FROM = 'TEST-XFER-FROM';
const FIX_TO = 'TEST-XFER-TO';
const FROM = FIX_FROM; // 大学部 阶段206
const TO = FIX_TO; // 大学部 阶段203（更慢）

await startServices();
const tokens = {};
for (const a of ['zhanght', 'sunjl', 'qiansy', 'lilx']) tokens[a] = await login(a);

const db = conn('sms_common');

/* 夹具：一快一慢两个大学部班（id 固定，先删后建） */
async function seedClasses() {
  await db('t_uni_class').whereIn('id', [FIX_FROM, FIX_TO]).del();
  await db('t_uni_class').insert([
    { id: FIX_FROM, edu_stage: 'class', stage_code: 206, class_code: 'XFROM', class_name: '自检换班源班206',
      dept_code: 2, class_status: 2, student_count: 0, is_deleted: 0, create_time: new Date(),
      head_teacher_id: '85a47f05-6f96-4602-944e-d5c29b0154ae', head_teacher_name: '张海涛' },
    { id: FIX_TO, edu_stage: 'class', stage_code: 203, class_code: 'XTO', class_name: '自检换班目标班203',
      dept_code: 2, class_status: 2, student_count: 0, is_deleted: 0, create_time: new Date() },
  ]);
}
await seedClasses();
const sid = 'TEST-XFER-' + Date.now();
const empClasses = [];
let empSid = null;
const cleanup = async () => {
  await db('t_uni_repeat').where({ student_id: sid }).del().catch(() => {});
  await db('t_uni_class_transfer').where({ student_id: sid }).del().catch(() => {});
  await db('t_uni_student').where({ id: sid }).del().catch(() => {});
  await db.destroy().catch(() => {});
};

try {
  /* ---------- 1. 可选目标班级（权限） ---------- */
  const targets = {};
  for (const a of ['zhanght', 'sunjl', 'qiansy', 'lilx']) {
    targets[a] = await req(`${BASE}/api/teaching/class-transfer/targets?stage=class&fromClassId=${FROM}&mode=repeat`, {
      token: tokens[a],
    });
  }
  check('★ 班主任(只有成绩权限)能取目标班级', targets.zhanght.json?.code === 200, `code=${targets.zhanght.json?.code} ${targets.zhanght.json?.message || ''}`);
  check('★ 项目经理能取目标班级', targets.sunjl.json?.code === 200, `code=${targets.sunjl.json?.code}`);
  check('★ 校长能取目标班级', targets.qiansy.json?.code === 200, `code=${targets.qiansy.json?.code}`);
  check('★ 市场咨询(无关角色)被拦', targets.lilx.json?.code === 40302, `code=${targets.lilx.json?.code}`);
  check('★ 目标班级按进度过滤（不含自己）', !(targets.qiansy.json?.data || []).some((x) => x.id === FROM));

  /* ---------- 2. 旧路径已下线 ---------- */
  const legacy = await req(`${BASE}/api/teaching/class/transfer-targets?stage=class&fromClassId=${FROM}`, { token: tokens.qiansy });
  check('★ 旧路径 /api/teaching/class/transfer-targets 已下线', legacy.json?.code !== 200, `code=${legacy.json?.code}`);

  /* ---------- 3. 班主任执行末班 ---------- */
  await db('t_uni_student').insert({
    id: sid,
    edu_stage: 'class',
    student_no: 'X' + Date.now(),
    student_name: '自检-换班生',
    gender: 1,
    class_id: FROM,
    class_name: '自检换班源班206',
    student_status: 5,
    repeat_count: 0,
    is_deleted: 0,
    create_time: new Date(),
  });

  const doRes = await req(`${BASE}/api/teaching/class-transfer/do`, {
    method: 'POST',
    token: tokens.zhanght,
    body: { stage: 'class', studentId: sid, fromClassId: FROM, toClassId: TO, mode: 'repeat', reason: '自检' },
  });
  check('★ 班主任执行末班成功（不再 403）', doRes.json?.code === 200, `code=${doRes.json?.code} ${doRes.json?.message || ''}`);

  /**
   * ★ 2026-10-22 新口径：末班/升班**不再直接生效** ——
   *   点下去只生成一张待接收单，学生班籍不变；
   *   要等目标班班主任在「教学管理 → 待接收学员」点「接收」后才真正入班。
   */
  const stu = await db('t_uni_student').where({ id: sid }).first();
  check(
    '★★ 提交末班后班籍**未变**（等班主任接收）',
    stu?.class_name === '自检换班源班206',
    `class_name=${stu?.class_name}`,
  );
  check('★ repeat_count 未变（接收后才 +1）', Number(stu?.repeat_count ?? 0) === 0, `repeat_count=${stu?.repeat_count}`);

  const push = await db('t_uni_consult_push').where({ origin_student_id: sid, is_deleted: 0 }).first();
  check(
    '★★ 已生成待接收单（目标班 + 状态=待接收）',
    !!push && push.intend_class_name === '自检换班目标班203' && Number(push.apply_status) === 1,
    `${push?.consult_no} → ${push?.intend_class_name} 状态${push?.apply_status}`,
  );
  check('★ 待接收单标记为末班重修', Number(push?.is_repeat_in) === 1, `is_repeat_in=${push?.is_repeat_in}`);

  // 目标班班主任在待接收页点接收 → 这时才入班
  // ★ 用校长接收：夹具班是登录之后才建的，不在班主任登录时算好的 classIds 里
  //   （真实场景里班主任的班在登录时就有，权限判定完全一致）
  const recvRes = await req(`${BASE}/api/class/consult/receive`, {
    method: 'POST',
    token: tokens.qiansy,
    body: { id: push.id },
  });
  check('★★ 目标班班主任接收成功', recvRes.json?.code === 200, `code=${recvRes.json?.code} ${recvRes.json?.message || ''}`);

  const stu2 = await db('t_uni_student').where({ id: sid }).first();
  check('★ 接收后班籍已改到目标班', stu2?.class_name === '自检换班目标班203', `class_name=${stu2?.class_name}`);
  check('★ 接收后 repeat_count +1', Number(stu2?.repeat_count) === 1, `repeat_count=${stu2?.repeat_count}`);

  const rep = await db('t_uni_repeat').where({ student_id: sid }).first();
  check(
    '★ 末班记录已写入（含 from→to）',
    !!rep && rep.from_class_name === '自检换班源班206' && rep.to_class_name === '自检换班目标班203',
    `${rep?.from_class_name}→${rep?.to_class_name}`,
  );

  const tr = await db('t_uni_class_transfer').where({ student_id: sid }).first();
  check('★ 转班留痕已写入', !!tr && tr.to_class_name === '自检换班目标班203', `reason=${tr?.transfer_reason}`);

  /* ---------- 4. 进度规则 ---------- */
  // 末班往更快班（U2602→U2601）必须被拒
  const badRepeat = await req(`${BASE}/api/teaching/class-transfer/do`, {
    method: 'POST',
    token: tokens.zhanght,
    body: { stage: 'class', studentId: sid, fromClassId: 'CLS-U2602', toClassId: FROM, mode: 'repeat' },
  });
  check('★ 末班不许往进度更快的班', badRepeat.json?.code === 40000 && /更快|更慢/.test(badRepeat.json?.message || ''), `${badRepeat.json?.code} ${badRepeat.json?.message || ''}`);

  // 升班往更慢班（U2601→U2602）必须被拒
  await db('t_uni_student').where({ id: sid }).update({ class_id: FROM, class_name: 'U2601' });
  const badPromote = await req(`${BASE}/api/teaching/class-transfer/do`, {
    method: 'POST',
    token: tokens.zhanght,
    body: { stage: 'class', studentId: sid, fromClassId: FROM, toClassId: TO, mode: 'promote' },
  });
  check('★ 升班不许往进度更慢的班', badPromote.json?.code === 40000, `${badPromote.json?.code} ${badPromote.json?.message || ''}`);

  /* ---------- 5. 无关角色写入被拦 ---------- */
  const lilxWrite = await req(`${BASE}/api/teaching/class-transfer/do`, {
    method: 'POST',
    token: tokens.lilx,
    body: { stage: 'class', studentId: sid, fromClassId: FROM, toClassId: TO, mode: 'repeat' },
  });
  check('★ 无关角色写入被拦', lilxWrite.json?.code === 40302, `code=${lilxWrite.json?.code}`);
  /* ---------- 6. 就业部（emp）同链路 ---------- */
  const mkEmp = async (name, code, phase) => {
    const r = await req(`${BASE}/api/teaching/class/save`, {
      method: 'POST',
      token: tokens.qiansy,
      body: { stage: 'emp', className: name, classCode: code, deptCode: 3, phaseCode: phase, openDate: '2026-10-21' },
    });
    if (r.json?.data?.id) empClasses.push(r.json.data.id);
    return r.json?.data?.id;
  };
  const em1 = await mkEmp('自检就业一阶段班', 'QE01', 301);
  const em2 = await mkEmp('自检就业二阶段班', 'QE02', 302);
  const em3 = await mkEmp('自检就业三阶段班', 'QE03', 303);
  check('就业部：建 3 个班（301/302/303）', !!(em1 && em2 && em3));

  empSid = 'TEST-EMP-' + Date.now();
  await db('t_uni_student').insert({
    id: empSid,
    edu_stage: 'emp',
    stage_key: 'emp',
    student_no: 'E' + Date.now(),
    student_name: '自检-就业换班生',
    gender: 1,
    class_id: em2,
    class_name: '自检就业二阶段班',
    student_status: 9,
    repeat_count: 0,
    is_deleted: 0,
    create_time: new Date(),
  });

  const empRep = await req(`${BASE}/api/teaching/class-transfer/targets?stage=emp&fromClassId=${em2}&mode=repeat`, { token: tokens.qiansy });
  check(
    '就业部：末班只给进度≤当前的班（301）',
    // 库里可能还有其它 301 的就业班（演示数据），只断言「含一阶段、不含三阶段」
    (empRep.json?.data || []).some((x) => x.name === '自检就业一阶段班') &&
      !(empRep.json?.data || []).some((x) => x.name === '自检就业三阶段班'),
    (empRep.json?.data || []).map((x) => x.name).join(','),
  );
  const empPro = await req(`${BASE}/api/teaching/class-transfer/targets?stage=emp&fromClassId=${em2}&mode=promote`, { token: tokens.qiansy });
  check(
    '就业部：升班只给进度更快的班（303）',
    (empPro.json?.data || []).some((x) => x.name === '自检就业三阶段班') &&
      !(empPro.json?.data || []).some((x) => x.name === '自检就业一阶段班'),
    (empPro.json?.data || []).map((x) => x.name).join(','),
  );

  const empDo1 = await req(`${BASE}/api/teaching/class-transfer/do`, {
    method: 'POST',
    token: tokens.qiansy,
    body: { stage: 'emp', studentId: empSid, fromClassId: em2, toClassId: em1, mode: 'repeat', reason: '自检' },
  });
  check('就业部：末班提交成功', empDo1.json?.code === 200, `${empDo1.json?.code} ${empDo1.json?.message || ''}`);
  const empS1 = await db('t_uni_student').where({ id: empSid }).first();
  check(
    '就业部：提交后班籍未变（等接收）',
    empS1?.class_name === '自检就业二阶段班',
    `${empS1?.class_name} / ${empS1?.repeat_count}`,
  );
  const empPush = (await db('t_uni_consult_push')
    .where({ origin_student_id: empSid, is_deleted: 0 })
    .orderBy('create_time', 'desc')
    .limit(1))[0];
  check('就业部：已生成待接收单', !!empPush && empPush.intend_class_name === '自检就业一阶段班', `${empPush?.consult_no}`);
  const empRecv = await req(`${BASE}/api/class/consult/receive`, {
    method: 'POST',
    token: tokens.qiansy,
    body: { id: empPush.id },
  });
  check('就业部：接收成功', empRecv.json?.code === 200, `${empRecv.json?.code} ${empRecv.json?.message || ''}`);
  const empS1b = await db('t_uni_student').where({ id: empSid }).first();
  check('就业部：接收后班籍改为 301 班 + repeat_count+1', empS1b?.class_name === '自检就业一阶段班' && Number(empS1b?.repeat_count) === 1, `${empS1b?.class_name} / ${empS1b?.repeat_count}`);

  const empDo2 = await req(`${BASE}/api/teaching/class-transfer/do`, {
    method: 'POST',
    token: tokens.qiansy,
    body: { stage: 'emp', studentId: empSid, fromClassId: em1, toClassId: em3, mode: 'promote', reason: '自检' },
  });
  check('就业部：升班提交成功', empDo2.json?.code === 200, `${empDo2.json?.code} ${empDo2.json?.message || ''}`);
  // ★ 取「待接收」那张（前面那次末班的单已接收；create_time 同秒排序不稳）
  const empPush2 = (await db('t_uni_consult_push')
    .where({ origin_student_id: empSid, is_deleted: 0, apply_status: 1 })
    .limit(1))[0];
  const empRecv2 = await req(`${BASE}/api/class/consult/receive`, {
    method: 'POST',
    token: tokens.qiansy,
    body: { id: empPush2.id },
  });
  check('就业部：升班接收成功', empRecv2.json?.code === 200, `${empRecv2.json?.code} ${empRecv2.json?.message || ''}`);
  const empS2 = await db('t_uni_student').where({ id: empSid }).first();
  check('就业部：接收后班籍改为 303 班', empS2?.class_name === '自检就业三阶段班', empS2?.class_name);

} finally {
  await db('t_uni_consult_push').whereIn('origin_student_id', [sid, empSid]).del().catch(() => {});
  await db('t_uni_class').whereIn('id', [FIX_FROM, FIX_TO]).del().catch(() => {});
  for (const id of empClasses) await db('t_uni_class').where({ id }).del().catch(() => {});
  if (empSid) {
    await db('t_uni_repeat').where({ student_id: empSid }).del().catch(() => {});
    await db('t_uni_class_transfer').where({ student_id: empSid }).del().catch(() => {});
    await db('t_uni_class_student').where({ student_id: empSid }).del().catch(() => {});
    await db('t_uni_student').where({ id: empSid }).del().catch(() => {});
  }
  await cleanup();
  killAll();
}

const pass = results.filter((r) => r.pass).length;
console.log(`\n===== 结果：${pass}/${results.length} 通过 =====`);
if (pass !== results.length) {
  console.log('  失败：' + results.filter((r) => !r.pass).map((r) => r.name).join(' / '));
  process.exitCode = 1;
}
