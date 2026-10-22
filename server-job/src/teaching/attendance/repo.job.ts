/**
 * 出勤仓储 · 实训（sms_job）
 * ============================================================
 *
 * 表：t_job_attendance（明细即主表，一人一天一行）
 *     + t_job_attendance_summary（班级每日汇总，按班按日一行）
 *
 * ⚠️ 实训与另两个学段**结构方向相反**：
 *     初高/大学 = 先有一行台账，再挂明细；
 *     实训      = 每人一行明细，汇总另算。
 *   本仓储负责把这个方向"掰"成统一形状。
 *
 * ⚠️ 实训的 attend_status 用的就是 1~7 那套（与统一码同构），
 *   但仍然走 conf 的映射表 —— 保证以后任何学段改口径都只改配置。
 */

import { randomUUID } from 'crypto';
import { db } from '../../utils/db';
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
import { tbl, tblAs, tblInsTrx, tblRef, tblTrx } from '../shared/uniTable';
import { applyClassScope } from '../shared/dataScope';

const TABLE = 't_job_attendance';
const SUMMARY = 't_job_attendance_summary';
const CS_TABLE = 't_job_class_student';
const CLASS_TABLE = 't_job_class';
const STUDENT_TABLE = 't_student_base';
const STAGE = 'job' as const;
/** 花名册里 status=1 表示在班 */
const CS_IN = 1;

/**
 * ⚠️ 主库连接**没有**开 `dateStrings`，日期会以 JS Date 返回，
 *    直接 JSON 序列化会变成带时区的 ISO 串（前端展示差 8 小时）。
 *    统一在这里切成 'YYYY-MM-DD'。
 */
function fmtDate(v: unknown): string {
  if (!v) return '';
  if (typeof v === 'string') return v.slice(0, 10);
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(v).slice(0, 10);
}

function mapRow(r: Record<string, any>): AttendanceRow {
  const should = Number(r.should_count ?? 0);
  const actual = Number(r.actual_count ?? 0);
  return {
    id: String(r.id),
    stage: STAGE,
    stageName: '就业部',
    classId: String(r.class_id ?? ''),
    className: String(r.class_name ?? ''),
    attendanceDate: fmtDate(r.attend_date),
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

/**
 * 当天在班学生（花名册 status=1）
 *
 * ⚠️ 唯一一处 **join** —— 两张表（花名册 + 学生）都在 sms_job，
 *    归一后两张都落 sms_common，所以 qualify 走 `tblAs` + `tblRef`：
 *      · `tblAs`  → from 侧：开关开时自动换成 uniDb + `cs.edu_stage` 条件
 *        （别名限定不能省：两张表都有 edu_stage，不带前缀会 ambiguous）
 *      · `tblRef` → 被 join 侧：只换表名，连接由 from 侧那条链决定
 */
async function roster(classId: string, runner: any = db) {
  return (await tblAs(runner, 'sms_job', CS_TABLE, STAGE, 'cs')
    .leftJoin(`${tblRef('sms_job', STUDENT_TABLE)} as s`, 'cs.student_id', 's.id')
    .where('cs.class_id', classId)
    .andWhere('cs.status', CS_IN)
    .andWhere('cs.is_deleted', 0)
    .select('cs.student_id', 'cs.student_no', 'cs.student_name', 's.phone')
    .orderBy('cs.student_no', 'asc')) as Array<Record<string, any>>;
}

export async function list(q: AttendanceListQuery, user?: any): Promise<AttendanceRow[]> {
  const qb = tbl(db, 'sms_job', SUMMARY, STAGE).where('is_deleted', 0);
  if (q.classId) qb.andWhere('class_id', q.classId);
  if (q.startDate) qb.andWhere('attend_date', '>=', q.startDate);
  if (q.endDate) qb.andWhere('attend_date', '<=', q.endDate);
  /* 角色数据范围：项目经理只看自己未结业的实训班；就业老师只看自己接手的班 */
  if (user && !(await applyClassScope(qb, 'class_id', STAGE, user))) return [];
  const rows = (await qb.orderBy('attend_date', 'desc')) as Array<Record<string, any>>;
  return rows.map(mapRow);
}

export async function detail(id: string): Promise<AttendanceDetail | null> {
  const rec = (await tbl(db, 'sms_job', SUMMARY, STAGE).where({ id, is_deleted: 0 }).first()) as
    | Record<string, any>
    | undefined;
  if (!rec) return null;
  const raw = (await tbl(db, 'sms_job', TABLE, STAGE)
    .where({ class_id: rec.class_id, attend_date: fmtDate(rec.attend_date), is_deleted: 0 })
    .orderBy('student_no')) as Array<Record<string, any>>;
  const map = new Map(raw.map((d) => [String(d.student_id), d]));

  /* ★ 2026-10-19：详情要能看到「该班全部学生」。
     实训的明细表按「逐人登记」写，但补录/中途入班时仍可能缺行 ——
     按在班名册铺一遍，缺记录的按「出勤」显示；名册外的历史明细追加在末尾。 */
  const students = await roster(rec.class_id);
  const details: AttendanceDetailRow[] = [];
  const seen = new Set<string>();
  for (const s of students) {
    const sid = String(s.student_id);
    seen.add(sid);
    const d = map.get(sid);
    const status = d
      ? ((await toUnifiedStatus(STAGE, Number(d.attend_status))) ?? 0)
      : UnifiedAttendanceStatus.PRESENT;
    details.push({
      studentId: sid,
      studentNo: ((d?.student_no ?? s.student_no) as string) ?? null,
      studentName: ((d?.student_name ?? s.student_name) as string) ?? null,
      status,
      statusName: UNIFIED_STATUS_NAME[status] ?? '未知',
      reason: (d?.reason as string) ?? null,
      phone: (s.phone as string) ?? null,
    });
  }
  for (const d of raw) {
    const sid = String(d.student_id ?? '');
    if (seen.has(sid)) continue;
    const status = (await toUnifiedStatus(STAGE, Number(d.attend_status))) ?? 0;
    details.push({
      studentId: sid,
      studentNo: (d.student_no as string) ?? null,
      studentName: (d.student_name as string) ?? null,
      status,
      statusName: UNIFIED_STATUS_NAME[status] ?? '未知',
      reason: (d.reason as string) ?? null,
      phone: null,
    });
  }
  return { record: mapRow(rec), details };
}

export async function save(body: AttendanceSaveBody, userId: string) {
  const scope = (await getScope()).job;
  const cls = (await tbl(db, 'sms_job', CLASS_TABLE, STAGE).where({ id: body.classId, is_deleted: 0 }).first()) as
    | Record<string, any>
    | undefined;
  if (!cls) throw new Error('班级不存在');

  const rows = body.rows ?? [];
  if (!rows.length) throw new Error('考勤数据不能为空');
  for (const r of rows) {
    if (NEED_REASON_STATUSES.includes(r.status) && !r.reason) {
      throw new Error(`状态为「${UNIFIED_STATUS_NAME[r.status] || '未知'}」时必须填写原因`);
    }
  }

  const now = new Date();
  const date = body.attendanceDate;

  const summaryId = await db.transaction(async (trx) => {
    // ① 现存记录（用于 upsert 与"按提交的为准"清理）
    const existing = (await tblTrx(trx, 'sms_job', TABLE, STAGE)
      .where({ class_id: body.classId, attend_date: date, is_deleted: 0 })
      .select('id', 'student_id')) as Array<Record<string, any>>;
    const existMap = new Map(existing.map((r) => [String(r.student_id), String(r.id)]));
    const submitted = new Set(rows.map((r) => r.studentId));

    // 提交里没有、但库里有的 → 逻辑删除（学生当天转班等情况）
    const stale = existing.filter((r) => !submitted.has(String(r.student_id)));
    if (stale.length) {
      await tblTrx(trx, 'sms_job', TABLE, STAGE)
        .whereIn(
          'id',
          stale.map((r) => String(r.id)),
        )
        .update({ is_deleted: 1, update_time: now, update_by: userId });
    }

    // ② 逐行 upsert（统一码 → 原始码）
    const nameMap = new Map((await roster(body.classId, trx)).map((s) => [String(s.student_id), s]));
    for (const r of rows) {
      const stu = nameMap.get(r.studentId);
      const payload = {
        class_id: body.classId,
        class_name: cls.class_name,
        student_id: r.studentId,
        student_no: stu?.student_no ?? null,
        student_name: stu?.student_name ?? null,
        attend_date: date,
        attend_status: await toRawStatus(STAGE, r.status),
        reason: r.reason ?? null,
        remark: body.remark ?? null,
        registrar_id: userId,
        update_time: now,
        update_by: userId,
      };
      const id = existMap.get(r.studentId);
      if (id) {
        await tblTrx(trx, 'sms_job', TABLE, STAGE).where({ id }).update(payload);
      } else {
        await tblInsTrx(trx, 'sms_job', TABLE, STAGE, {
          id: randomUUID(),
          ...payload,
          is_deleted: 0,
          create_time: now,
          create_by: userId,
        });
      }
    }

    // ③ 用【当天全部在班学生】重算汇总（口径A：应到 = 全部在班学生）
    const all = (await roster(body.classId, trx)).length || rows.length;
    const saved = (await tblTrx(trx, 'sms_job', TABLE, STAGE)
      .where({ class_id: body.classId, attend_date: date, is_deleted: 0 })
      .select('attend_status')) as Array<Record<string, any>>;
    const actualCount = saved.filter((r) =>
      scope.presentStatuses.includes(Number(r.attend_status)),
    ).length;
    const absentCount = all - actualCount;
    const rate = all > 0 ? Math.round((actualCount / all) * 10000) / 100 : 0;

    const sumExisting = (await tblTrx(trx, 'sms_job', SUMMARY, STAGE)
      .where({ class_id: body.classId, attend_date: date })
      .first()) as Record<string, any> | undefined;
    const sumPayload = {
      class_name: cls.class_name,
      should_count: all,
      actual_count: actualCount,
      absent_count: absentCount,
      attendance_rate: rate,
      head_teacher_name: cls.head_teacher_name ?? null,
      teacher_name: cls.teacher_name ?? null,
      is_deleted: 0,
      update_time: now,
      update_by: userId,
    };
    if (sumExisting) {
      await tblTrx(trx, 'sms_job', SUMMARY, STAGE).where({ id: sumExisting.id }).update(sumPayload);
      return String(sumExisting.id);
    }
    const newId = randomUUID();
    await tblInsTrx(trx, 'sms_job', SUMMARY, STAGE, {
      id: newId,
      class_id: body.classId,
      attend_date: date,
      create_time: now,
      create_by: userId,
      ...sumPayload,
    });
    return newId;
  });

  const sum = (await tbl(db, 'sms_job', SUMMARY, STAGE).where({ id: summaryId }).first()) as Record<string, any>;
  return {
    id: summaryId,
    shouldCount: Number(sum?.should_count ?? 0),
    actualCount: Number(sum?.actual_count ?? 0),
    attendanceRate: Number(sum?.attendance_rate ?? 0),
  };
}

/** 录入登记板：某班某天的在班名单 + 已登记状态 */
export async function board(classId: string, date: string): Promise<AttendanceBoard> {
  const cls = (await tbl(db, 'sms_job', CLASS_TABLE, STAGE).where({ id: classId, is_deleted: 0 }).first()) as
    | Record<string, any>
    | undefined;
  if (!cls) throw new Error('班级不存在');

  const students = await roster(classId);
  const records = (await tbl(db, 'sms_job', TABLE, STAGE)
    .where({ class_id: classId, attend_date: date, is_deleted: 0 })
    .select('student_id', 'attend_status', 'reason')) as Array<Record<string, any>>;
  const map = new Map(records.map((r) => [String(r.student_id), r]));

  const rows: AttendanceBoardRow[] = [];
  for (const s of students) {
    const r = map.get(String(s.student_id));
    rows.push({
      studentId: String(s.student_id),
      studentNo: (s.student_no as string) ?? null,
      studentName: (s.student_name as string) ?? null,
      status: r ? await toUnifiedStatus(STAGE, Number(r.attend_status)) : null,
      reason: (r?.reason as string) ?? null,
      registered: !!r,
    });
  }

  return {
    stage: STAGE,
    stageName: '就业部',
    classId,
    className: String(cls.class_name ?? ''),
    attendanceDate: date,
    shouldCount: students.length,
    rows,
  };
}
