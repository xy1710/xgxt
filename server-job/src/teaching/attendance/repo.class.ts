/**
 * 出勤仓储 · 大学部（sms_class）
 * ============================================================
 *
 * 表：t_class_attendance（台账，按班按日）+ t_class_attendance_absent（**只存缺勤的人**）
 *
 * ⚠️ 大学是个"异类"，两点必须说清楚：
 *   ① **不记状态码**：它只有「应到 / 实到 / 缺勤」三个数字，没有迟到/早退/请假。
 *      所以明细里所有缺勤的人统一按统一码 **2(缺勤)** 返回。
 *   ② **人数是老师手工填的**：不按学生名单算（配置 manualInput = true）。
 *      所以 save 必须传 shouldCount / actualCount，后端不算。
 */

import { randomUUID } from 'crypto';
import { db } from '../../class/db';
import { getScope, toRawStatus, toUnifiedStatus } from '../shared/conf';
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
const A = 't_class_attendance_absent';
const C = 't_class_info';
const S = 't_class_student';
const STAGE = 'class' as const;

function mapRow(r: Record<string, any>): AttendanceRow {
  const should = Number(r.should_count ?? 0);
  const actual = Number(r.present_count ?? 0);
  return {
    id: String(r.id),
    stage: STAGE,
    stageName: '大学部',
    classId: String(r.class_id ?? ''),
    className: String(r.class_name ?? ''),
    attendanceDate: String(r.attendance_date ?? '').slice(0, 10),
    shouldCount: should,
    actualCount: actual,
    absentCount: Number(r.absent_count ?? Math.max(0, should - actual)),
    attendanceRate: Number(r.attendance_rate ?? 0),
    teacherName: (r.teacher_name as string) ?? null,
    headTeacherName: (r.head_teacher_name as string) ?? null,
    fileUrl: null,
    remark: null,
  };
}

export async function list(q: AttendanceListQuery, user?: any): Promise<AttendanceRow[]> {
  const qb = tbl(db, 'sms_class', T, STAGE).where('is_deleted', 0);
  if (q.classId) qb.andWhere('class_id', q.classId);
  if (q.startDate) qb.andWhere('attendance_date', '>=', q.startDate);
  if (q.endDate) qb.andWhere('attendance_date', '<=', q.endDate);
  if (user && !(await applyClassScope(qb, 'class_id', STAGE, user))) return [];
  const rows = (await qb.orderBy('attendance_date', 'desc')) as Array<Record<string, any>>;
  return rows.map(mapRow);
}

export async function detail(id: string): Promise<AttendanceDetail | null> {
  const rec = (await tbl(db, 'sms_class', T, STAGE).where({ id, is_deleted: 0 }).first()) as Record<string, any> | undefined;
  if (!rec) return null;
  const raw = (await tbl(db, 'sms_class', A, STAGE).where({ attendance_id: id, is_deleted: 0 }).orderBy('student_no')) as Array<
    Record<string, any>
  >;
  const map = new Map(raw.map((d) => [String(d.student_id), d]));

  /* ★ 2026-10-19：详情要能看到「该班全部学生」。
     大学明细表只记「缺勤名单」，直接返回就只有缺勤的人；
     这里按在班名册铺一遍，未列入缺勤名单的按「出勤」显示。
     名册之外的记录（转班/退班学生的历史明细）追加在末尾，避免老数据「消失」。 */
  const roster = (await tbl(db, 'sms_class', S, STAGE)
    .where({ class_id: rec.class_id, is_deleted: 0 })
    .orderBy('student_no')) as Array<Record<string, any>>;

  const details: AttendanceDetailRow[] = [];
  const seen = new Set<string>();
  for (const s of roster) {
    const sid = String(s.id);
    seen.add(sid);
    const d = map.get(sid);
    /* 逐人登记后明细带真实状态；历史数据（只有缺勤名单）没有值时按「缺勤」兜底 */
    const status = d
      ? ((await toUnifiedStatus(STAGE, Number(d.attendance_status))) ?? UnifiedAttendanceStatus.ABSENT)
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
    const status =
      (await toUnifiedStatus(STAGE, Number(d.attendance_status))) ?? UnifiedAttendanceStatus.ABSENT;
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
  return { record: mapRow(rec), details };
}

export async function save(body: AttendanceSaveBody, userId: string) {
  const scope = (await getScope()).class;
  const cls = (await tbl(db, 'sms_class', C, STAGE).where({ id: body.classId, is_deleted: 0 }).first()) as
    | Record<string, any>
    | undefined;
  if (!cls) throw new Error('班级不存在');

  /* ★ 2026-10-19：大学部改为「逐人登记」，与初高 / 就业口径一致。
     原来这里是「老师手工填应到 / 实到人数」，明细只存缺勤名单；
     现在按在班名册逐人写状态（出勤/迟到/缺勤/请假…），应到=名册人数、实到=出勤类状态数。 */
  const students = (await tbl(db, 'sms_class', S, STAGE)
    .where({ class_id: body.classId, is_deleted: 0 })
    .orderBy('student_no')) as Array<Record<string, any>>;
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
    throw new Error(`以下学生不在该班名单中：${invalid.map((r) => r.studentId).join('、')}`);
  }
  for (const r of input) {
    if (NEED_REASON_STATUSES.includes(r.status) && !r.reason) {
      throw new Error(`状态为「${UNIFIED_STATUS_NAME[r.status] || '未知'}」时必须填写原因`);
    }
  }

  const actualCount = input.filter((r) => scope.presentStatuses.includes(r.status)).length;
  const absentCount = Math.max(0, shouldCount - actualCount);
  const attendanceRate = shouldCount > 0 ? Number(((actualCount / shouldCount) * 100).toFixed(2)) : 0;
  const now = new Date();

  const attendanceId = await db.transaction(async (trx) => {
    const existing = (await tblTrx(trx, 'sms_class', T, STAGE)
      .where({ class_id: body.classId, attendance_date: body.attendanceDate, is_deleted: 0 })
      .first()) as Record<string, any> | undefined;

    const attId = existing?.id ? String(existing.id) : randomUUID();
    const payload = {
      class_id: cls.id,
      class_name: cls.class_name,
      attendance_date: body.attendanceDate,
      should_count: shouldCount,
      /* 老表列名是 present_count；统一表两列都有（present_count / actual_count），
         两个都写：本域读 present_count，跨域报表读 actual_count，避免一边为空 */
      present_count: actualCount,
      actual_count: actualCount,
      absent_count: absentCount,
      attendance_rate: attendanceRate,
      teacher_id: cls.teacher_id ?? null,
      teacher_name: cls.teacher_name ?? null,
      head_teacher_id: cls.head_teacher_id ?? null,
      head_teacher_name: cls.head_teacher_name ?? null,
    };

    if (existing) {
      await tblTrx(trx, 'sms_class', T, STAGE)
        .where({ id: attId })
        .update({ ...payload, update_time: now, update_by: userId });
    } else {
      await tblInsTrx(trx, 'sms_class', T, STAGE, {
        id: attId,
        ...payload,
        is_deleted: 0,
        create_time: now,
        create_by: userId,
      });
    }

    /* 明细「整体替换」= 按学生 upsert（与初高/实训同款）
       —— 统一表 uk_attendance_detail(attendance_id,student_id,edu_stage) 不允许
          先软删再插入（软删行仍占唯一键）。 */
    const prevDetails = (await tblTrx(trx, 'sms_class', A, STAGE)
      .where({ attendance_id: attId })
      .select('id', 'student_id')) as Array<Record<string, any>>;
    const prevMap = new Map(prevDetails.map((d) => [String(d.student_id), String(d.id)]));
    const submittedIds = new Set(input.map((r) => String(r.studentId)));

    const staleDetails = prevDetails.filter((d) => !submittedIds.has(String(d.student_id)));
    if (staleDetails.length) {
      await tblTrx(trx, 'sms_class', A, STAGE)
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
        /* 统一码 → 原码（大学没有历史状态码映射表，恒等）；
           ⚠️ 老表 t_class_attendance_absent 没有 attendance_status 列，
              仅统一表有 —— P8 之后老表已 DROP，这个写入只走统一表。 */
        attendance_status: await toRawStatus(STAGE, r.status),
        // 统一表 absent_reason 是 NOT NULL DEFAULT ''，不能显式传 null
        absent_reason: r.reason ?? '',
      };
      const prevId = prevMap.get(String(r.studentId));
      if (prevId) {
        await tblTrx(trx, 'sms_class', A, STAGE)
          .where({ id: prevId })
          .update({ ...detailPayload, is_deleted: 0, update_time: now, update_by: userId });
      } else {
        await tblInsTrx(trx, 'sms_class', A, STAGE, {
          id: randomUUID(),
          ...detailPayload,
          is_deleted: 0,
          create_time: now,
          create_by: userId,
        });
      }
    }

    await tblTrx(trx, 'sms_class', C, STAGE)
      .where({ id: cls.id })
      .update({ attendance_rate: attendanceRate, update_time: now });
    return attId;
  });

  return { id: attendanceId, shouldCount, actualCount, attendanceRate };
}

/**
 * 录入登记板
 *
 * ★ 2026-10-19：大学部已改为「逐人登记」，这里返回**全班学生名单 + 当天已登记状态**，
 *    与初高 / 就业完全同构（原来只有手工人数，这个函数只用来挑缺勤的人）。
 */
export async function board(classId: string, date: string): Promise<AttendanceBoard> {
  const cls = (await tbl(db, 'sms_class', C, STAGE).where({ id: classId, is_deleted: 0 }).first()) as
    | Record<string, any>
    | undefined;
  if (!cls) throw new Error('班级不存在');

  const students = (await tbl(db, 'sms_class', S, STAGE)
    .where({ class_id: classId, is_deleted: 0 })
    .orderBy('student_no')) as Array<Record<string, any>>;

  const att = (await tbl(db, 'sms_class', T, STAGE)
    .where({ class_id: classId, attendance_date: date, is_deleted: 0 })
    .first()) as Record<string, any> | undefined;
  const absent = att
    ? ((await tbl(db, 'sms_class', A, STAGE).where({ attendance_id: att.id, is_deleted: 0 })) as Array<
        Record<string, any>
      >)
    : [];
  const map = new Map(absent.map((d) => [String(d.student_id), d]));

  const rows: AttendanceBoardRow[] = [];
  for (const s of students) {
    const d = map.get(String(s.id));
    rows.push({
      studentId: String(s.id),
      studentNo: (s.student_no as string) ?? null,
      studentName: (s.student_name as string) ?? null,
      /* 逐人登记后按真实状态回显；未登记的保持 null（前端默认按「出勤」） */
      status: d
        ? ((await toUnifiedStatus(STAGE, Number(d.attendance_status))) ?? UnifiedAttendanceStatus.ABSENT)
        : null,
      reason: (d?.absent_reason as string) ?? null,
      registered: !!d,
    });
  }

  return {
    stage: STAGE,
    stageName: '大学部',
    classId,
    className: String(cls.class_name ?? ''),
    attendanceDate: date,
    shouldCount: students.length,
    rows,
  };
}
