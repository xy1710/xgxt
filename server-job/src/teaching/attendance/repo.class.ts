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
import { getScope } from '../shared/conf';
import type {
  AttendanceBoard,
  AttendanceBoardRow,
  AttendanceDetail,
  AttendanceDetailRow,
  AttendanceListQuery,
  AttendanceRow,
  AttendanceSaveBody,
} from '../shared/dto';
import { UnifiedAttendanceStatus, UNIFIED_STATUS_NAME } from '../shared/dto';
import { tbl } from '../shared/uniTable';

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

export async function list(q: AttendanceListQuery): Promise<AttendanceRow[]> {
  const qb = tbl(db, 'sms_class', T, STAGE).where('is_deleted', 0);
  if (q.classId) qb.andWhere('class_id', q.classId);
  if (q.startDate) qb.andWhere('attendance_date', '>=', q.startDate);
  if (q.endDate) qb.andWhere('attendance_date', '<=', q.endDate);
  const rows = (await qb.orderBy('attendance_date', 'desc')) as Array<Record<string, any>>;
  return rows.map(mapRow);
}

export async function detail(id: string): Promise<AttendanceDetail | null> {
  const rec = (await tbl(db, 'sms_class', T, STAGE).where({ id, is_deleted: 0 }).first()) as Record<string, any> | undefined;
  if (!rec) return null;
  const raw = (await db(A).where({ attendance_id: id, is_deleted: 0 }).orderBy('student_no')) as Array<
    Record<string, any>
  >;
  const details: AttendanceDetailRow[] = raw.map((d) => ({
    studentId: String(d.student_id ?? ''),
    studentNo: (d.student_no as string) ?? null,
    studentName: (d.student_name as string) ?? null,
    // 大学只有"缺勤"这一种明细
    status: UnifiedAttendanceStatus.ABSENT,
    statusName: UNIFIED_STATUS_NAME[UnifiedAttendanceStatus.ABSENT],
    reason: (d.absent_reason as string) ?? null,
    phone: (d.phone as string) ?? null,
  }));
  return { record: mapRow(rec), details };
}

export async function save(body: AttendanceSaveBody, userId: string) {
  const scope = (await getScope()).class;
  const cls = (await tbl(db, 'sms_class', C, STAGE).where({ id: body.classId, is_deleted: 0 }).first()) as
    | Record<string, any>
    | undefined;
  if (!cls) throw new Error('班级不存在');

  // ★ 大学：人数由老师手工填
  const shouldCount = Number(body.shouldCount ?? 0);
  const actualCount = Number(body.actualCount ?? 0);
  if (shouldCount < 0 || actualCount < 0) throw new Error('人数不能为负');
  if (actualCount > shouldCount) throw new Error('实到人数不能大于应到人数');
  const absentCount = Math.max(0, shouldCount - actualCount);
  const attendanceRate =
    shouldCount > 0 ? Number(((actualCount / shouldCount) * 100).toFixed(2)) : 0;
  const now = new Date();

  const attendanceId = await db.transaction(async (trx) => {
    const existing = (await trx(T)
      .where({ class_id: body.classId, attendance_date: body.attendanceDate, is_deleted: 0 })
      .first()) as Record<string, any> | undefined;

    const attId = existing?.id ? String(existing.id) : randomUUID();
    const payload = {
      class_id: cls.id,
      class_name: cls.class_name,
      attendance_date: body.attendanceDate,
      should_count: shouldCount,
      present_count: actualCount,
      absent_count: absentCount,
      attendance_rate: attendanceRate,
      teacher_name: cls.teacher_name ?? null,
      head_teacher_name: cls.head_teacher_name ?? null,
    };

    if (existing) {
      await trx(T).where({ id: attId }).update({ ...payload, update_time: now, update_by: userId });
      await trx(A)
        .where({ attendance_id: attId, is_deleted: 0 })
        .update({ is_deleted: 1, update_time: now });
    } else {
      await trx(T).insert({
        id: attId,
        ...payload,
        is_deleted: 0,
        create_time: now,
        create_by: userId,
      });
    }

    // 可选：同时登记缺勤名单
    if (body.rows && body.rows.length) {
      const ids = body.rows.map((r) => r.studentId);
      const students = (await trx(S).whereIn('id', ids).where('is_deleted', 0)) as Array<
        Record<string, any>
      >;
      const stuMap = new Map(students.map((s) => [String(s.id), s]));
      for (const r of body.rows) {
        const stu = stuMap.get(r.studentId);
        await trx(A).insert({
          id: randomUUID(),
          attendance_id: attId,
          student_id: r.studentId,
          student_no: stu?.student_no ?? null,
          student_name: stu?.student_name ?? null,
          class_name: cls.class_name,
          phone: stu?.phone ?? null,
          absent_reason: r.reason ?? '',
          is_deleted: 0,
          create_time: now,
          create_by: userId,
        });
      }
    }

    await trx(C).where({ id: cls.id }).update({ attendance_rate: attendanceRate, update_time: now });
    return attId;
  });

  return { id: attendanceId, shouldCount, actualCount, attendanceRate };
}

/**
 * 录入登记板
 *
 * ⚠️ 大学**不逐人记状态**（只有"应到/实到/缺勤"三个数字），
 *    所以这里返回的是「班级学生名单 + 当天已登记的缺勤名单」，
 *    用途仅限于「要标缺勤时挑人」，不是逐人考勤。
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
    ? ((await db(A).where({ attendance_id: att.id, is_deleted: 0 })) as Array<Record<string, any>>)
    : [];
  const map = new Map(absent.map((d) => [String(d.student_id), d]));

  const rows: AttendanceBoardRow[] = students.map((s) => {
    const d = map.get(String(s.id));
    return {
      studentId: String(s.id),
      studentNo: (s.student_no as string) ?? null,
      studentName: (s.student_name as string) ?? null,
      status: d ? UnifiedAttendanceStatus.ABSENT : null,
      reason: (d?.absent_reason as string) ?? null,
      registered: !!d,
    };
  });

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
