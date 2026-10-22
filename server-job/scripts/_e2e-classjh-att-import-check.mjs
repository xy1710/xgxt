/**
 * T1（任务 #18）冒烟验证：初高出勤老接口 `/api/class-jh/attendance/import`
 *
 * 【为什么单独写这个】
 *   `class-jh/routes/attendance.route.ts` 本轮把「明细先整体软删、再逐条重插」
 *   改成了「按 (attendance_id, student_id) upsert」，
 *   但这个文件**没有任何现成自检套件覆盖**（scripts/ 下无 class-jh 套件）。
 *   改一处无测试的写入路径必须补验证，否则等于盲改。
 *
 * 【验什么】
 *   ① 首次 /import 正常落 3 条明细
 *   ② ★ 再次 /import（同明细）必须成功 —— 老写法在切读统一表后会撞
 *      uk_attendance_detail；改 upsert 后不会再重建行
 *   ③ 明细行 id **保持不变**（upsert 语义：原地更新而非重建）
 *   ④ 少提交一个学生 → 该学生明细被**逻辑删除**（is_deleted=1），列表只剩 2 条
 *
 * 跑法：cd server-job && node scripts/_e2e-classjh-att-import-check.mjs
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import {
  startServices,
  login,
  req,
  conn,
  buildRow,
  freePorts,
  killAll,
  BASE,
  mirrorRow,
  USE_UNI,
} from './_e2e-lib.mjs';

const require = createRequire(import.meta.url);
require('dotenv').config({ path: path.join(process.cwd(), '.env') });

// ★ 夹具前缀每轮随机：t_class_info.class_name 有 uk_class_name，软删行仍占键
const TAG = '【冒烟】' + Math.random().toString(36).slice(2, 6) + ' ';
const DATE = '1998-03-03';
const API = `${BASE}/api/class-jh/attendance`;

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) {
    pass += 1;
    console.log(`  ✅ ${name}${extra ? '  —— ' + extra : ''}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${name}${extra ? '  —— ' + extra : ''}`);
  }
};

const made = { classes: [], students: [], attendance: [] };

async function main() {
  console.log('启动服务…');
  await startServices();

  const token = await login('sunmin');
  if (!token) throw new Error('登录失败（账号 sunmin）');

  const jh = conn('sms_class_jh');
  const uniDb = conn('sms_common'); // ★ #24：统一表镜像/断言分流用
  /** ★ #24 开关开适配：夹具镜像行登记（finally 统一清理） */
  const madeUni = [];

  try {
    /* ---------- 夹具：1 个初高班 + 3 个学生 ---------- */
    const classId = randomUUID();
    const clsRow = await buildRow(jh, 't_class_info', {
      id: classId,
      class_name: `${TAG}班`,
      class_status: 1,
      dept_code: 1,
      student_count: 3,
      stage: 1,
    });
    await jh('t_class_info').insert(clsRow);
    made.classes.push(classId);
    if (USE_UNI) {
      await mirrorRow(uniDb, 'sms_class_jh', 't_class_info', clsRow, 'jh', (_d, t, id) =>
        madeUni.push([t, id]),
      );
    }

    const stuIds = [];
    for (let i = 0; i < 3; i += 1) {
      const sid = randomUUID();
      stuIds.push(sid);
      const stuRow = await buildRow(jh, 't_class_student', {
        id: sid,
        student_no: `${TAG}${i + 1}`,
        student_name: `${TAG}学生${i + 1}`,
        class_id: classId,
        student_status: 3,
        dept_code: 1,
      });
      await jh('t_class_student').insert(stuRow);
      made.students.push(sid);
      if (USE_UNI) {
        await mirrorRow(uniDb, 'sms_class_jh', 't_class_student', stuRow, 'jh', (_d, t, id) =>
          madeUni.push([t, id]),
        );
      }
    }

    const mkDetails = (n) =>
      stuIds.slice(0, n).map((sid, i) => ({
        studentId: sid,
        attendanceStatus: [1, 2, 3][i] ?? 1,
        // ⚠️ 不能传 null：schema 是 z.string().max(255).optional()，显式 null 会被拒
        ...(i === 2 ? { absentReason: '冒烟验证' } : {}),
      }));

    /* ---------- ① 首次保存 ---------- */
    const r1 = await req(`${API}/import`, {
      method: 'POST',
      token,
      body: { classId, attendanceDate: DATE, fileUrl: 'https://example.com/a.xlsx', details: mkDetails(3) },
    });
    check('① 首次 /import 成功', r1.json?.code === 200, `code=${r1.json?.code} ${r1.json?.message || ''}`);
    const attId = r1.json?.data?.attendanceId ?? r1.json?.data?.id ?? '';

    const d1 = await req(`${API}/detail?attendanceId=${attId}`, { token });
    const list1 = d1.json?.data?.details || [];
    check('① 明细落 3 条', list1.length === 3, `实际 ${list1.length}`);
    const ids1 = list1.map((x) => x.detailId).sort();

    /* ---------- ②③ 再次保存（同明细）---------- */
    const r2 = await req(`${API}/import`, {
      method: 'POST',
      token,
      body: { classId, attendanceDate: DATE, fileUrl: 'https://example.com/a.xlsx', details: mkDetails(3) },
    });
    check(
      '★② 二次 /import 成功（upsert 后不再「软删+重插」）',
      r2.json?.code === 200,
      `code=${r2.json?.code} ${r2.json?.message || ''}`,
    );

    const d2 = await req(`${API}/detail?attendanceId=${attId}`, { token });
    const list2 = d2.json?.data?.details || [];
    check('② 二次后明细仍为 3 条', list2.length === 3, `实际 ${list2.length}`);
    const ids2 = list2.map((x) => x.detailId).sort();
    check(
      '★③ 明细行 id 保持稳定（原地更新，未重建）',
      JSON.stringify(ids1) === JSON.stringify(ids2),
      `before=${ids1.join(',')} after=${ids2.join(',')}`,
    );

    /* ---------- ④ 少提交一个学生 → 逻辑删除 ---------- */
    const r3 = await req(`${API}/import`, {
      method: 'POST',
      token,
      body: { classId, attendanceDate: DATE, fileUrl: 'https://example.com/a.xlsx', details: mkDetails(2) },
    });
    check('④ 提交 2 条成功', r3.json?.code === 200, `code=${r3.json?.code}`);

    const d3 = await req(`${API}/detail?attendanceId=${attId}`, { token });
    const list3 = d3.json?.data?.details || [];
    check('④ 未提交的旧明细被逻辑删除（只剩 2 条）', list3.length === 2, `实际 ${list3.length}`);

    // ★ #24 开关开分流：产品写 t_uni_attendance_detail，断言读同侧
    const detailT = USE_UNI ? uniDb('t_uni_attendance_detail') : jh('t_class_attendance_detail');
    const raw = await detailT.where({ attendance_id: attId });
    check(
      '④ 库里是「逻辑删除」而非物理删除（3 行都在，1 行 is_deleted=1）',
      raw.length === 3 && raw.filter((x) => Number(x.is_deleted) === 1).length === 1,
      `总 ${raw.length} 行, 软删 ${raw.filter((x) => Number(x.is_deleted) === 1).length} 行`,
    );
    made.attendance.push(attId);
  } finally {
    /* ---------- 清理 ---------- */
    const jh2 = conn('sms_class_jh');
    if (made.attendance.length) {
      await jh2('t_class_attendance_detail').whereIn('attendance_id', made.attendance).del().catch(() => {});
      await jh2('t_class_attendance').whereIn('id', made.attendance).del().catch(() => {});
      // ★ #24：开关开时产品写的是统一表考勤（主表+明细），一并清理
      if (USE_UNI) {
        await uniDb('t_uni_attendance_detail').whereIn('attendance_id', made.attendance).del().catch(() => {});
        await uniDb('t_uni_attendance').whereIn('id', made.attendance).del().catch(() => {});
      }
    }
    if (made.students.length) await jh2('t_class_student').whereIn('id', made.students).del().catch(() => {});
    if (made.classes.length) await jh2('t_class_info').whereIn('id', made.classes).del().catch(() => {});
    // ★ #24：镜像行清理（mirrorRow 登记的统一表行）
    for (const [t, id] of madeUni) {
      await uniDb(t).where({ id }).del().catch(() => {});
    }
    console.log(`  🧹 已清理夹具：班 ${made.classes.length} / 学生 ${made.students.length} / 考勤 ${made.attendance.length}`);
    await jh2.destroy();
    await jh.destroy().catch(() => {});
    freePorts();
    killAll();
  }

  console.log(`\n===== 结果：${pass}/${pass + fail} 通过 =====`);
  if (fail) console.log(`  失败：${fail} 项`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('❌ 异常：' + (e?.stack || e));
  freePorts();
  killAll();
  process.exit(1);
});
