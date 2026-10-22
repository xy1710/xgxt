/**
 * 一次性验证（P2 出勤归一）：**开关打开时，直接调用初高出勤仓储**
 *
 * 绕开 HTTP / 前端，只验证 P2 改过的那几个函数在统一表上真的能跑：
 *   save()  → 写 t_uni_attendance + t_uni_attendance_detail，且补了 edu_stage
 *   list()  → 读 t_uni_attendance（能查到刚写的台账）
 *   detail()→ 读 t_uni_attendance_detail，原码→统一状态名映射正确
 *   board() → 读 t_uni_class_student / t_uni_student 花名册
 *
 * 用法（必须先设开关，module 级常量在 import 时就求值了）：
 *   TEACHING_UNI_TABLE=1 node node_modules/tsx/dist/cli.mjs scripts/_probe-att-uni.ts
 */
import { randomUUID } from 'node:crypto';
import { conn, buildRow } from './_e2e-lib.mjs';
import * as repoJh from '../src/teaching/attendance/repo.classJh';

const UNI = conn('sms_common');
const TAG = 'P2PROBE-';
const DATE = '2026-10-16';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, extra = '') {
  if (ok) {
    pass++;
    console.log(`  ✅ ${name}${extra ? '  —— ' + extra : ''}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${extra ? '  —— ' + extra : ''}`);
  }
}

const made: { classes: string[]; students: string[]; attendance: string[] } = {
  classes: [],
  students: [],
  attendance: [],
};

(async () => {
  if (process.env.TEACHING_UNI_TABLE !== '1') {
    console.log('⚠️  必须带 TEACHING_UNI_TABLE=1 运行');
    process.exit(1);
  }
  const classId = randomUUID();
  made.classes.push(classId);
  const studentIds: string[] = [];
  try {
    /* ---------- 夹具：统一表里的班 + 3 个在读学生 ---------- */
    const cls = await buildRow(UNI, 't_uni_class', {
      id: classId,
      edu_stage: 'jh',
      class_name: `${TAG}出勤验证班`,
      class_status: 1,
      teacher_id: 'probe-t',
      teacher_name: '验证教员',
      head_teacher_id: 'probe-h',
      head_teacher_name: '验证班主任',
      is_deleted: 0,
      create_time: new Date(),
    });
    await UNI('t_uni_class').insert(cls);

    for (let i = 1; i <= 3; i++) {
      const sid = randomUUID();
      studentIds.push(sid);
      made.students.push(sid);
      const st = await buildRow(UNI, 't_uni_student', {
        id: sid,
        edu_stage: 'jh',
        class_id: classId,
        class_name: `${TAG}出勤验证班`,
        student_no: `${TAG}A-${i}`,
        student_name: `${TAG}学生${i}`,
        student_status: 3, // 在读 → 命中初高应到口径 [3,4,5]
        gender: 1,
        is_deleted: 0,
        create_time: new Date(),
      });
      await UNI('t_uni_student').insert(st);
    }
    console.log(`  已造统一表夹具：1 个班 + 3 个学生（edu_stage='jh'）`);

    /* ---------- ① save()：统一码 → 初高原码，落 t_uni_attendance_detail ---------- */
    // 统一码 3=迟到 / 7=病假 / 1=出勤  →  初高原码应为 2 / 3 / 1
    const saved = await repoJh.save(
      {
        stage: 'jh',
        classId,
        attendanceDate: DATE,
        rows: [
          { studentId: studentIds[0], status: 3, reason: '验证-迟到' },
          { studentId: studentIds[1], status: 7, reason: '验证-病假' },
          { studentId: studentIds[2], status: 1, reason: null } as never,
        ],
      } as never,
      'probe-user',
    );
    if (saved?.id) made.attendance.push(String(saved.id));
    check('save() 成功返回 id', !!saved?.id, `id=${saved?.id} 应到=${saved?.shouldCount} 实到=${saved?.actualCount}`);

    const detailRows = await UNI('t_uni_attendance_detail')
      .where({ attendance_id: saved.id, edu_stage: 'jh', is_deleted: 0 })
      .orderBy('student_no');
    const gotRaw = detailRows.map((r: any) => Number(r.attendance_status));
    check(
      '统一码→初高原码 落库正确（3/7/1 → 2/3/1）',
      JSON.stringify(gotRaw) === JSON.stringify([2, 3, 1]),
      `实得 [${gotRaw}]  行数=${detailRows.length}`,
    );
    check(
      '★ 明细行都带 edu_stage=jh（路由层注入生效）',
      detailRows.length === 3 && detailRows.every((r: any) => r.edu_stage === 'jh'),
      `edu_stage=${[...new Set(detailRows.map((r: any) => r.edu_stage))].join('/')}`,
    );

    const ledger = await UNI('t_uni_attendance').where({ id: saved.id }).first();
    check('台账落 t_uni_attendance 且带 edu_stage=jh', !!ledger && ledger.edu_stage === 'jh', `rate=${ledger?.attendance_rate}`);

    /* ---------- ② list()：能读到刚写的台账 ---------- */
    const list = await repoJh.list({ stage: 'jh', classId } as never);
    check(
      'list() 从 t_uni_attendance 读到台账',
      list.length >= 1 && list.some((r) => r.id === saved.id),
      `返回 ${list.length} 条`,
    );

    /* ---------- ③ detail()：原码 → 统一状态名 ---------- */
    const detail = await repoJh.detail(String(saved.id));
    const names = (detail?.details || []).map((d) => d.statusName);
    check(
      'detail() 原码→统一状态名（迟到/病假/出勤）',
      names.includes('迟到') && names.includes('病假') && names.includes('出勤'),
      names.join(' / '),
    );

    /* ---------- ④ board()：花名册 join ---------- */
    const board = await repoJh.board(classId, DATE);
    check(
      'board() 花名册返回 3 人且已登记',
      board.rows.length === 3 && board.rows.every((r) => r.registered),
      `应到=${board.shouldCount} 已登记=${board.rows.filter((r) => r.registered).length}`,
    );

    /* ---------- ⑤ 幂等：再 save 一次不应新增台账行 ---------- */
    const saved2 = await repoJh.save(
      {
        stage: 'jh',
        classId,
        attendanceDate: DATE,
        rows: [{ studentId: studentIds[0], status: 1, reason: null } as never],
      } as never,
      'probe-user',
    );
    const ledgerCount = await UNI('t_uni_attendance').where({ class_id: classId, edu_stage: 'jh', is_deleted: 0 }).count({ n: '*' });
    check(
      '同班同日重复 save → 复用同一台账行（不新增）',
      String(saved2.id) === String(saved.id) && Number((ledgerCount as any)[0].n) === 1,
      `台账行数=${(ledgerCount as any)[0].n}`,
    );
    const after = await UNI('t_uni_attendance_detail')
      .where({ attendance_id: saved.id, edu_stage: 'jh', is_deleted: 0 });
    check('重复 save 后旧明细被逻辑删除（只剩本次 1 条）', after.length === 1, `剩余明细=${after.length}`);
  } catch (e: any) {
    fail++;
    console.log('  ❌ 异常：' + (e?.stack || e?.message || e));
  } finally {
    /* ---------- 清理 ---------- */
    try {
      await UNI('t_uni_attendance_detail').where({ attendance_id: made.attendance[0] ?? 'x' }).del();
      await UNI('t_uni_attendance').whereIn('id', made.attendance).del();
      await UNI('t_uni_attendance').where({ class_id: made.classes[0] ?? 'x' }).del();
      await UNI('t_uni_student').whereIn('id', made.students).del();
      await UNI('t_uni_class').whereIn('id', made.classes).del();
      console.log('  🧹 已清理统一表夹具');
    } catch (e: any) {
      console.log('  ⚠️ 清理异常：' + (e?.message || e));
    }
    console.log(`\n===== 结果：${pass}/${pass + fail} 通过 =====`);
    await UNI.destroy();
    process.exit(fail ? 1 : 0);
  }
})();
