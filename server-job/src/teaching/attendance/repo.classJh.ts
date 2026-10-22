/**
 * 出勤仓储 · 初高（sms_class_jh）
 * ============================================================
 *
 * 表：t_class_attendance（台账，按班按日）+ t_class_attendance_detail（明细，按人）
 *
 * ⚠️ 本文件的唯一职责边界：
 *      「查自己的表 / 写自己的表」+「把原始状态码翻译成统一码」。
 *      **不做任何跨学段判断、不做口径决策** —— 那是 service.ts 的事。
 *      这样每个仓储都能单独测，出问题也只需要看这一个文件。
 */

import { randomUUID } from 'crypto';
import { db } from '../../class-jh/utils/db';
import { toUnifiedStatus, toRawStatus, getScope } from '../shared/conf';
import type {
  AttendanceBoard,
  AttendanceBoardRow,
  AttendanceDetail,
  AttendanceDetailRow,
  AttendanceListQuery,
  AttendanceRow,
  AttendanceSaveBody,
} from '../shared/dto';
import { NEED_REASON_STATUSES, UnifiedAttendanceStatus, UNIFIED_STATUS_NAME } from '../shared/dto';
import { tbl, tblInsTrx, tblTrx } from '../shared/uniTable';
import { applyClassScope } from '../shared/dataScope';

const T = 't_class_attendance';
const D = 't_class_attendance_detail';
const S = 't_class_student';
const C = 't_class_info';
const STAGE = 'jh' as const;

/** 台账行 → 统一 DTO */
async function mapRow(r: Record<string, any>): Promise<AttendanceRow> {
  const should = Number(r.should_count ?? 0);
  const actual = Number(r.actual_count ?? 0);
  return {
    id: String(r.id),
    stage: STAGE,
    stageName: '初高部',
    classId: String(r.class_id ?? ''),
    className: String(r.class_name ?? ''),
    attendanceDate: String(r.attendance_date ?? '').slice(0, 10),
    shouldCount: should,
    actualCount: actual,
    absentCount: Math.max(0, should - actual),
    attendanceRate: Number(r.attendance_rate ?? 0),
    teacherName: (r.teacher_name as string) ?? null,
    headTeacherName: (r.head_teacher_name as string) ?? null,
    fileUrl: (r.file_url as string) ?? null,
    remark: (r.remark as string) ?? null,
  };
}

export async function list(q: AttendanceListQuery, user?: any): Promise<AttendanceRow[]> {
  const qb = tbl(db, 'sms_class_jh', T, STAGE).where('is_deleted', 0);
  if (q.classId) qb.andWhere('class_id', q.classId);
  if (q.startDate) qb.andWhere('attendance_date', '>=', q.startDate);
  if (q.endDate) qb.andWhere('attendance_date', '<=', q.endDate);
  if (user && !(await applyClassScope(qb, 'class_id', STAGE, user))) return [];
  const rows = (await qb.orderBy('attendance_date', 'desc')) as Array<Record<string, any>>;
  return Promise.all(rows.map(mapRow));
}

export async function detail(id: string): Promise<AttendanceDetail | null> {
  const rec = (await tbl(db, 'sms_class_jh', T, STAGE).where({ id, is_deleted: 0 }).first()) as Record<string, any> | undefined;
  if (!rec) return null;
  const raw = (await tbl(db, 'sms_class_jh', D, STAGE).where({ attendance_id: id, is_deleted: 0 }).orderBy('student_no')) as Array<
    Record<string, any>
  >;
  const map = new Map(raw.map((d) => [String(d.student_id), d]));

  /* ★ 2026-10-19：详情要能看到「该班全部学生」——
     按在班名册铺一遍，缺明细的按「出勤」显示；名册外的历史明细追加在末尾。 */
  const scope = (await getScope()).jh;
  const shouldStatuses = Array.isArray(scope.shouldStatuses) ? scope.shouldStatuses : [3, 4, 5];
  const roster = (await tbl(db, 'sms_class_jh', S, STAGE)
    .where({ class_id: rec.class_id, is_deleted: 0 })
    .whereIn('student_status', shouldStatuses)
    .orderBy('student_no')) as Array<Record<string, any>>;

  const details: AttendanceDetailRow[] = [];
  const seen = new Set<string>();
  for (const s of roster) {
    const sid = String(s.id);
    seen.add(sid);
    const d = map.get(sid);
    const status = d
      ? ((await toUnifiedStatus(STAGE, Number(d.attendance_status))) ?? 0)
      : UnifiedAttendanceStatus.PRESENT;
    details.push({
      studentId: sid,
      studentNo: ((d?.student_no ?? s.student_no) as string) ?? null,
      studentName: ((d?.student_name ?? s.student_name) as string) ?? null,
      status,
      statusName: UNIFIED_STATUS_NAME[status] ?? '未知',
      reason: (d?.absent_reason as string) ?? null,
      phone: ((d?.phone ?? s.phone) as string) ?? null,
    });
  }
  for (const d of raw) {
    const sid = String(d.student_id ?? '');
    if (seen.has(sid)) continue;
    const status = (await toUnifiedStatus(STAGE, Number(d.attendance_status))) ?? 0;
    details.push({
      studentId: sid,
      studentNo: (d.student_no as string) ?? null,
      studentName: (d.student_name as string) ?? null,
      status,
      statusName: UNIFIED_STATUS_NAME[status] ?? '未知',
      reason: (d.absent_reason as string) ?? null,
      phone: (d.phone as string) ?? null,
    });
  }
  return { record: await mapRow(rec), details };
}

export async function save(body: AttendanceSaveBody, userId: string) {
  const scope = (await getScope()).jh;
  const cls = (await tbl(db, 'sms_class_jh', C, STAGE).where({ id: body.classId, is_deleted: 0 }).first()) as
    | Record<string, any>
    | undefined;
  if (!cls) throw new Error('班级不存在');

  // 应到 = 在读 + 试学 + 预读（学生状态由配置决定）
  const shouldStatuses = Array.isArray(scope.shouldStatuses) ? scope.shouldStatuses : [3, 4, 5];
  const students = (await tbl(db, 'sms_class_jh', S, STAGE)
    .where({ class_id: body.classId, is_deleted: 0 })
    .whereIn('student_status', shouldStatuses)) as Array<Record<string, any>>;
  const stuMap = new Map(students.map((s) => [String(s.id), s]));
  const shouldCount = students.length;

  // 明细：优先用传入；否则默认全部出勤
  const input: Array<{ studentId: string; status: number; reason?: string | null }> =
    body.rows && body.rows.length
      ? body.rows
      : students.map((s) => ({
          studentId: String(s.id),
          status: UnifiedAttendanceStatus.PRESENT as number,
        }));

  const invalid = input.filter((r) => !stuMap.has(r.studentId));
  if (invalid.length) {
    throw new Error(`以下学生不在该班应到名单中：${invalid.map((r) => r.studentId).join('、')}`);
  }
  for (const r of input) {
    if (NEED_REASON_STATUSES.includes(r.status) && !r.reason) {
      throw new Error(`状态为「${UNIFIED_STATUS_NAME[r.status] || '未知'}」时必须填写原因`);
    }
  }

  const actualCount = input.filter((r) => scope.presentStatuses.includes(r.status)).length;
  const attendanceRate = shouldCount > 0 ? Number(((actualCount / shouldCount) * 100).toFixed(2)) : 0;
  const now = new Date();

  const attendanceId = await db.transaction(async (trx) => {
    const existing = (await tblTrx(trx, 'sms_class_jh', T, STAGE)
      .where({ class_id: body.classId, attendance_date: body.attendanceDate, is_deleted: 0 })
      .first()) as Record<string, any> | undefined;

    const attId = existing?.id ? String(existing.id) : randomUUID();
    const payload = {
      class_id: cls.id,
      class_name: cls.class_name,
      attendance_date: body.attendanceDate,
      attendance_rate: attendanceRate,
      should_count: shouldCount,
      actual_count: actualCount,
      teacher_id: cls.teacher_id ?? null,
      teacher_name: cls.teacher_name ?? null,
      head_teacher_id: cls.head_teacher_id ?? null,
      head_teacher_name: cls.head_teacher_name ?? null,
      file_url: body.fileUrl ?? null,
      remark: body.remark ?? null,
    };

    if (existing) {
      await tblTrx(trx, 'sms_class_jh', T, STAGE)
        .where({ id: attId })
        .update({ ...payload, update_time: now, update_by: userId });
    } else {
      await tblInsTrx(trx, 'sms_class_jh', T, STAGE, {
        id: attId,
        ...payload,
        is_deleted: 0,
        create_time: now,
        create_by: userId,
      });
    }

    /**
     * ★★ 明细「整体替换」= **按学生 upsert**（P2 修正）
     *
     * 【为什么不能「先整体软删、再插入」】
     *   统一表 `t_uni_attendance_detail` 上有唯一键
     *     `uk_attendance_detail (attendance_id, student_id, edu_stage)`
     *   —— 这是**刻意的业务约束**：一次考勤里一个学生只应有一条明细。
     *   而软删只是把 `is_deleted` 置 1，**行还在、唯一键仍被占住**
     *   → 紧接着的 insert 必报
     *     `Duplicate entry '...' for key 't_uni_attendance_detail.uk_attendance_detail'`
     *   （第 4 期已记录过同款坑：软删 + 唯一索引 = 删了再也建不回来）
     *
     * 【为什么老表模式一直"看起来正常"】
     *   老表 `t_class_attendance_detail` 的 `attendance_id` / `student_id` 都是
     *   **普通索引**，没有唯一约束 → 软删 + 重插能过，只是悄悄堆历史行。
     *   → 属于「老表宽松掩盖了代码缺陷」，切读统一表才炸出来。
     *
     * 【改法】按（本次考勤 + 学生）做 upsert：
     *   已存在 → 原地 update（顺带把软删的复活 `is_deleted: 0`）
     *   不存在 → insert
     *   本次未提交的旧明细 → 逻辑删除（保留审计，不物理删）
     *   ⚠️ 全仓没有任何地方读 `is_deleted = 1` 的出勤明细（已 grep 确认），
     *     所以不再"每条保存追加一行历史"不存在信息丢失。
     */
    const prevDetails = (await tblTrx(trx, 'sms_class_jh', D, STAGE)
      .where({ attendance_id: attId })
      .select('id', 'student_id')) as Array<Record<string, any>>;
    const prevMap = new Map(prevDetails.map((d) => [String(d.student_id), String(d.id)]));
    const submittedIds = new Set(input.map((r) => String(r.studentId)));

    const staleDetails = prevDetails.filter((d) => !submittedIds.has(String(d.student_id)));
    if (staleDetails.length) {
      await tblTrx(trx, 'sms_class_jh', D, STAGE)
        .whereIn(
          'id',
          staleDetails.map((d) => String(d.id)),
        )
        .update({ is_deleted: 1, update_time: now, update_by: userId });
    }

    for (const r of input) {
      const stu = stuMap.get(r.studentId)!;
      const detailPayload = {
        attendance_id: attId,
        class_id: cls.id,
        attendance_date: body.attendanceDate,
        student_id: r.studentId,
        student_no: stu.student_no ?? null,
        student_name: stu.student_name ?? null,
        phone: stu.phone ?? null,
        parent_phone: stu.parent_phone ?? null,
        // ★ 统一码 → 初高原码，落回老表
        attendance_status: await toRawStatus(STAGE, r.status),
        // ⚠️ 用 '' 而不是 null：统一表 `t_uni_attendance_detail.absent_reason`
        //    是 `NOT NULL DEFAULT ''`，显式传 null 会 `Column 'absent_reason' cannot be null`。
        //    （大学仓储本来就是 `?? ''`，这里与它对齐；老表侧 '' 与 NULL 语义无差别）
        absent_reason: r.reason ?? '',
      };
      const prevId = prevMap.get(String(r.studentId));
      if (prevId) {
        await tblTrx(trx, 'sms_class_jh', D, STAGE)
          .where({ id: prevId })
          .update({ ...detailPayload, is_deleted: 0, update_time: now, update_by: userId });
      } else {
        await tblInsTrx(trx, 'sms_class_jh', D, STAGE, {
          id: randomUUID(),
          ...detailPayload,
          is_deleted: 0,
          create_time: now,
          create_by: userId,
        });
      }
    }

    await tblTrx(trx, 'sms_class_jh', S, STAGE)
      .where({ class_id: cls.id, is_deleted: 0 })
      .whereIn('student_status', shouldStatuses)
      .update({ attendance_rate: attendanceRate, update_time: now });
    await tblTrx(trx, 'sms_class_jh', C, STAGE)
      .where({ id: cls.id })
      .update({ today_attendance_rate: attendanceRate, update_time: now });

    return attId;
  });

  return { id: attendanceId, shouldCount, actualCount, attendanceRate };
}

/** 录入登记板：某班某天的在班名单 + 已登记状态 */
export async function board(classId: string, date: string): Promise<AttendanceBoard> {
  const scope = (await getScope()).jh;
  const shouldStatuses = Array.isArray(scope.shouldStatuses) ? scope.shouldStatuses : [3, 4, 5];
  const cls = (await tbl(db, 'sms_class_jh', C, STAGE).where({ id: classId, is_deleted: 0 }).first()) as
    | Record<string, any>
    | undefined;
  if (!cls) throw new Error('班级不存在');

  const students = (await tbl(db, 'sms_class_jh', S, STAGE)
    .where({ class_id: classId, is_deleted: 0 })
    .whereIn('student_status', shouldStatuses)
    .orderBy('student_no')) as Array<Record<string, any>>;

  const att = (await tbl(db, 'sms_class_jh', T, STAGE)
    .where({ class_id: classId, attendance_date: date, is_deleted: 0 })
    .first()) as Record<string, any> | undefined;
  const details = att
    ? ((await tbl(db, 'sms_class_jh', D, STAGE).where({ attendance_id: att.id, is_deleted: 0 })) as Array<
        Record<string, any>
      >)
    : [];
  const map = new Map(details.map((d) => [String(d.student_id), d]));

  const rows: AttendanceBoardRow[] = [];
  for (const s of students) {
    const d = map.get(String(s.id));
    rows.push({
      studentId: String(s.id),
      studentNo: (s.student_no as string) ?? null,
      studentName: (s.student_name as string) ?? null,
      status: d ? await toUnifiedStatus(STAGE, Number(d.attendance_status)) : null,
      reason: (d?.absent_reason as string) ?? null,
      registered: !!d,
    });
  }
  return {
    stage: STAGE,
    stageName: '初高部',
    classId,
    className: String(cls.class_name ?? ''),
    attendanceDate: date,
    shouldCount: students.length,
    rows,
  };
}
