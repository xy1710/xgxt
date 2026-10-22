/**
 * 出勤管理路由（就业管理 > 实训阶段）
 *
 * 接口前缀：/api/job/attendance
 * 表：t_job_attendance（出勤记录）、t_job_attendance_summary（每日汇总）
 * 字段依据：docs/班级信息+出勤-字段定稿.md 第三、四节
 *
 * ⚠️ 出勤率口径（斌哥拍板 口径A）：
 *     应到 = 该班当天「在班」的全部学生（含请假的）
 *     实到 = 出勤 + 迟到 + 早退
 *     出勤率 = 实到 ÷ 应到 × 100
 */

import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import {
  BizCode,
  RoleCode,
  ATTEND_STATUS_NAME,
  ATTEND_STATUS_PRESENT_SET,
  ATTEND_STATUS_LEAVE_SET,
  AttendStatus,
} from 'shared-types';
import { ok, page } from '../utils/response';
import { db } from '../utils/db';
import { wrap } from '../utils/wrap';
import { fmtDate, fmtDateTime } from '../utils/date';
import { validate } from '../middleware/validate';
import { checkPermission } from '../middleware/auth';
import { BizError } from '../middleware/errorHandler';
// ★ 阶段隔离（班主任只看大学 / 项目经理只看实训）
import { myTrainingClassIds, operatorOf } from '../utils/stageScope';
// ★ P3 切读层：本文件 5 张表（t_job_attendance / t_job_attendance_summary /
//   t_job_class_student / t_job_class / t_student_base）均已归一，全部走路由；
//   ⚠️ 唯一一处 join（花名册 + 学生）用 tblAs + tblRef；开关关时与原实现逐字节等价。
import { tbl, tblAs, tblInsTrx, tblRef, tblTrx } from '../teaching/shared/uniTable';

export const attendanceRouter = Router();

/** 表名常量 */
const TABLE = 't_job_attendance';
const SUMMARY_TABLE = 't_job_attendance_summary';
const CS_TABLE = 't_job_class_student';
const CLASS_TABLE = 't_job_class';
const STUDENT_TABLE = 't_student_base';

/** ★ 老表所在库 + 统一表 edu_stage 取值（本路由只服务实训） */
const DB = 'sms_job';
const STAGE = 'job' as const;

/** 花名册在班状态 */
const CS_IN = 1;

/* ============================================================
 * 数据范围（★ 2026-09-30 斌哥反馈后补上）
 *
 * 【问题】出勤的 4 个接口原来**完全不校验班级归属** ——
 *   班主任传任意 classId 就能看到别的班主任的班。
 *   和「班主任只能看自己带的班」这个统一口径不一致（别的地方都限了，就这里漏了）。
 *
 * 【口径】以**班级表**的 head_teacher_id 为准（同其它模块）。
 *   班主任 = 只能看自己带的班；校长 / 管理员 / 教务 / 教员 / 助教不受限。
 * ============================================================ */

/** 取当前登录人 */
function getOperator(req: any): { userId: string; roles: string[] } {
  const u = req.user || {};
  return { userId: u.userId || '', roles: u.roles || [] };
}

/**
 * 单个班级：不是我的班就报错
 * 用于 /board、/detail 这类"进来就指定一个班"的接口
 *
 * ★ 2026-10-08 修：原来只判班主任 → 项目经理直连这些接口能看到任何班（越权）。
 *   现在统一走 myClassIds（含项目经理的实训班范围）。
 */
async function assertMyClass(req: any, classId: string): Promise<void> {
  const ids = await myClassIds(req);
  if (ids === null) return;                 // 不限（学管/校长/管理员）
  if (!ids.includes(classId)) {
    throw new BizError(BizCode.NO_OPERATION_PERMISSION, '只能查看自己带的班级');
  }
}

/**
 * 列表：返回「我能看的班级 ID」
 * 返回 null = 不限制（校长 / 管理员等）
 */
/**
 * ★ 2026-10-04 阶段隔离：走 stageScope 统一口径
 *
 * 原来这里只判断「是不是班主任」，现在按斌哥拍板拆成两侧：
 *   · 班主任/教员/助教 → 返回**空数组**（他们看不到实训数据）
 *   · 项目经理        → 返回他负责的实训班 ID
 *   · 学管/校长/管理员 → 返回 null（不限）
 */
async function myClassIds(req: any): Promise<string[] | null> {
  return myTrainingClassIds(operatorOf(req));
}

/** 需要填原因的状态：缺勤 / 请假类 */
const NEED_REASON_SET = [AttendStatus.ABSENT, ...ATTEND_STATUS_LEAVE_SET];

/**
 * 算一天一个班的统计
 * 返回 { shouldCount, actualCount, absentCount, attendanceRate }
 */
function calcStats(rows: { attendStatus: number }[]) {
  const shouldCount = rows.length; // 口径A：应到 = 全部在班学生
  let actualCount = 0;
  for (const r of rows) {
    if (ATTEND_STATUS_PRESENT_SET.includes(r.attendStatus)) actualCount += 1;
  }
  const absentCount = shouldCount - actualCount;
  const attendanceRate =
    shouldCount > 0 ? Math.round((actualCount / shouldCount) * 10000) / 100 : 0;
  return { shouldCount, actualCount, absentCount, attendanceRate };
}

/** 重算并写入某班某天的汇总 */
async function rebuildSummary(
  trx: any,
  classId: string,
  className: string,
  attendDate: string,
  stats: { shouldCount: number; actualCount: number; absentCount: number; attendanceRate: number },
  teacherInfo: { headTeacherName?: string | null; teacherName?: string | null },
) {
  const exist = await tblTrx(trx, DB, SUMMARY_TABLE, STAGE)
    .where({ class_id: classId, attend_date: attendDate })
    .first();

  const payload = {
    class_name: className,
    should_count: stats.shouldCount,
    actual_count: stats.actualCount,
    absent_count: stats.absentCount,
    attendance_rate: stats.attendanceRate,
    head_teacher_name: teacherInfo.headTeacherName || null,
    teacher_name: teacherInfo.teacherName || null,
    update_time: new Date(),
  };

  if (exist) {
    await tblTrx(trx, DB, SUMMARY_TABLE, STAGE).where({ id: exist.id }).update({ ...payload, is_deleted: false });
  } else {
    await tblInsTrx(trx, DB, SUMMARY_TABLE, STAGE, {
      id: randomUUID(),
      create_time: new Date(),
      is_deleted: false,
      class_id: classId,
      attend_date: attendDate,
      ...payload,
    });
  }
}

/* ============================================================
 * 1. 取考勤登记板
 *    GET /api/job/attendance/board?classId=xxx&attendDate=2026-09-29
 *
 * 逻辑：按「当天在班学生」生成行；已登记过的带上原状态，
 *      没登记过的状态留空（前端默认显示出勤）。
 * ============================================================ */

attendanceRouter.get(
  '/board',
  validate(
    z.object({
      classId: z.string().min(1, '班级ID必传'),
      attendDate: z.string().min(1, '日期必传'),
    }),
  ),
  wrap(async (req, res) => {
    const q = (req as any).validated;

    // ★ 数据范围：班主任只能看自己带的班（2026-09-30 补）
    await assertMyClass(req, q.classId);

    const cls = await tbl(db, DB, CLASS_TABLE, STAGE).where({ id: q.classId, is_deleted: false }).first();
    if (!cls) throw new BizError(BizCode.CLASS_NOT_FOUND, '班级不存在');

    // 当天在班学生（花名册 status=1）
    const students = await tblAs(db, DB, CS_TABLE, STAGE, 'cs')
      .leftJoin(`${tblRef(DB, STUDENT_TABLE)} as s`, 'cs.student_id', 's.id')
      .where('cs.class_id', q.classId)
      .andWhere('cs.status', CS_IN)
      .andWhere('cs.is_deleted', false)
      .select(
        'cs.student_id',
        'cs.student_no',
        'cs.student_name',
        's.gender',
        's.phone',
      )
      .orderBy('cs.student_no', 'asc');

    // 已登记的记录
    const records = await tbl(db, DB, TABLE, STAGE)
      .where({ class_id: q.classId, attend_date: q.attendDate, is_deleted: false })
      .select('student_id', 'attend_status', 'attend_type', 'reason', 'remark');
    const recMap = new Map(records.map((r: any) => [r.student_id, r]));

    const rows = students.map((s: any) => {
      const rec: any = recMap.get(s.student_id);
      return {
        studentId: s.student_id,
        studentNo: s.student_no,
        studentName: s.student_name,
        gender: s.gender ?? null,
        phone: s.phone ?? null,
        // ⚠️ 未登记时显式返回 null，不要省略字段
        //    （省略会让前端拿不到 key，违反接口契约）
        attendStatus: rec?.attend_status ?? null,
        attendType: rec?.attend_type ?? null,
        reason: rec?.reason ?? null,
        remark: rec?.remark ?? null,
        registered: !!rec,
      };
    });

    // 统计（未登记的行按「出勤」算预览？不 —— 未登记不算，
    // 只统计已登记的，避免误导）
    const registered = rows.filter((r: any) => r.registered);
    const forStats = registered.map((r: any) => ({ attendStatus: r.attendStatus }));
    const stats =
      forStats.length > 0
        ? calcStats(forStats)
        : { shouldCount: rows.length, actualCount: 0, absentCount: rows.length, attendanceRate: 0 };

    const sumRow = await tbl(db, DB, SUMMARY_TABLE, STAGE)
      .where({ class_id: q.classId, attend_date: q.attendDate, is_deleted: false })
      .first();

    res.json(
      ok({
        classId: cls.id,
        className: cls.class_name,
        classCode: cls.class_code,
        attendDate: q.attendDate,
        headTeacherName: cls.head_teacher_name,
        teacherName: cls.teacher_name,
        shouldCount: sumRow ? sumRow.should_count : rows.length,
        actualCount: sumRow ? sumRow.actual_count : stats.actualCount,
        absentCount: sumRow ? sumRow.absent_count : stats.absentCount,
        attendanceRate: sumRow ? sumRow.attendance_rate : stats.attendanceRate,
        registered: !!sumRow,
        rows,
      }),
    );
  }),
);

/* ============================================================
 * 2. 保存考勤（批量 upsert）+ 重算汇总
 *    POST /api/job/attendance/save
 *
 * 逻辑：
 *   1. 校验每行状态合法、需要原因的状态必须填原因
 *   2. 已存在则 update，不存在则 insert
 *   3. 删除本次未提交的行（老师可能把某人从名单里去掉？不会 ——
 *      但如果学生当天转班了，旧行要清掉。这里按「提交的为准」）
 *   4. 用【当天全部在班学生】重算汇总（不是只用提交的）
 * ============================================================ */

attendanceRouter.post(
  '/save',
  validate(
    z.object({
      classId: z.string().min(1),
      attendDate: z.string().min(1),
      rows: z
        .array(
          z.object({
            studentId: z.string().min(1),
            attendStatus: z.number().int().min(1).max(7),
            // ⚠️ 必须用 nullish 而不是 optional：
            //    前端「出勤」行的请假类型会传 null（后端回显时 ?? null 带过来的），
            //    而 zod 的 .optional() 只收 undefined、不收 null，会报
            //    「参数 rows.0.attendType 类型不正确」。
            //    这里 nullish 两种都收，入库前再统一归一化。
            attendType: z.number().int().nullish(),
            reason: z.string().max(200).nullish(),
            remark: z.string().max(200).nullish(),
          }),
        )
        .min(1, '考勤数据不能为空'),
    }),
  ),
  wrap(async (req, res) => {
    const body = (req as any).validated;

    const cls = await tbl(db, DB, CLASS_TABLE, STAGE).where({ id: body.classId, is_deleted: false }).first();
    if (!cls) throw new BizError(BizCode.CLASS_NOT_FOUND, '班级不存在');

    // ---- 逐行校验 ----
    for (const r of body.rows) {
      // ① 需要原因的状态必须填原因
      if (NEED_REASON_SET.includes(r.attendStatus) && !r.reason) {
        const name = ATTEND_STATUS_NAME[r.attendStatus] || '该状态';
        throw new BizError(
          BizCode.REQUIRED_FIELD_MISSING,
          `状态为「${name}」时必须填写原因`,
        );
      }
      // ② 归一化：不是「请假类」的状态，请假类型一律清掉，
      //    防止「出勤」却带着病假类型这种脏数据进库。
      if (!ATTEND_STATUS_LEAVE_SET.includes(r.attendStatus)) {
        r.attendType = null;
      }
    }

    const now = new Date();

    await db.transaction(async (trx) => {
      // 已存在的记录（key: studentId）
      const existing = await tblTrx(trx, DB, TABLE, STAGE)
        .where({ class_id: body.classId, attend_date: body.attendDate, is_deleted: false })
        .select('id', 'student_id');
      const existMap = new Map(existing.map((r: any) => [r.student_id, r.id]));

      for (const r of body.rows) {
        const payload = {
          attend_status: r.attendStatus,
          attend_type: r.attendType || null,
          reason: r.reason || null,
          remark: r.remark || null,
          registrar_id: req.user?.userId || null,
          registrar_name: null,
          update_time: now,
          update_by: req.user?.userId || null,
        };

        const id = existMap.get(r.studentId);
        if (id) {
          await tblTrx(trx, DB, TABLE, STAGE).where({ id }).update(payload);
        } else {
          await tblInsTrx(trx, DB, TABLE, STAGE, {
            id: randomUUID(),
            create_time: now,
            create_by: req.user?.userId || null,
            is_deleted: false,
            class_id: body.classId,
            class_name: cls.class_name,
            student_id: r.studentId,
            student_no: null,
            student_name: null,
            attend_date: body.attendDate,
            ...payload,
          });
        }
      }

      // ---- 用「当天全部在班学生」重算汇总 ----
      const classStudents = await tblTrx(trx, DB, CS_TABLE, STAGE)
        .where({ class_id: body.classId, status: CS_IN, is_deleted: false })
        .select('student_id', 'student_no', 'student_name');

      // 把学号姓名补回到刚插入的记录上（上面 insert 时留空）
      for (const cs of classStudents) {
        await tblTrx(trx, DB, TABLE, STAGE)
          .where({
            class_id: body.classId,
            attend_date: body.attendDate,
            student_id: cs.student_id,
            is_deleted: false,
          })
          .update({ student_no: cs.student_no, student_name: cs.student_name });
      }

      const savedRecords = await tblTrx(trx, DB, TABLE, STAGE)
        .where({ class_id: body.classId, attend_date: body.attendDate, is_deleted: false })
        .select('student_id', 'attend_status');

      // 只统计「在班学生」的记录（转班走的就不算了）
      const inClassIds = new Set(classStudents.map((c: any) => c.student_id));
      const forStats = savedRecords
        .filter((r: any) => inClassIds.has(r.student_id))
        .map((r: any) => ({ attendStatus: r.attend_status }));

      const stats = calcStats(forStats);

      await rebuildSummary(trx, cls.id, cls.class_name, body.attendDate, stats, {
        headTeacherName: cls.head_teacher_name,
        teacherName: cls.teacher_name,
      });
    });

    // 返回保存后的汇总
    const sumRow = await tbl(db, DB, SUMMARY_TABLE, STAGE)
      .where({ class_id: body.classId, attend_date: body.attendDate, is_deleted: false })
      .first();

    res.json(
      ok({
        savedCount: body.rows.length,
        summary: sumRow
          ? {
              id: sumRow.id,
              classId: sumRow.class_id,
              className: sumRow.class_name,
              attendDate: fmtDate(sumRow.attend_date),
              shouldCount: sumRow.should_count,
              actualCount: sumRow.actual_count,
              absentCount: sumRow.absent_count,
              attendanceRate: sumRow.attendance_rate,
              headTeacherName: sumRow.head_teacher_name,
              teacherName: sumRow.teacher_name,
            }
          : null,
      }),
    );
  }),
);

/* ============================================================
 * 3. 出勤记录列表
 *    GET /api/job/attendance/page
 * ============================================================ */

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
  classId: z.string().optional(),
  studentId: z.string().optional(),
  attendStatus: z.coerce.number().int().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  studentNo: z.string().optional(),
  studentName: z.string().optional(),
});

attendanceRouter.get(
  '/page',
  validate(listSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as z.infer<typeof listSchema>;

    const query = tbl(db, DB, TABLE, STAGE).where('is_deleted', false);

    // ★ 数据范围：班主任只能看自己带的班（2026-09-30 补）
    const allowed = await myClassIds(req);
    if (allowed) query.whereIn('class_id', allowed);

    if (q.classId) query.andWhere('class_id', q.classId);
    if (q.studentId) query.andWhere('student_id', q.studentId);
    if (q.attendStatus) query.andWhere('attend_status', q.attendStatus);
    if (q.startDate) query.andWhere('attend_date', '>=', q.startDate);
    if (q.endDate) query.andWhere('attend_date', '<=', q.endDate);
    if (q.studentNo) query.andWhere('student_no', 'like', `%${q.studentNo}%`);
    if (q.studentName) query.andWhere('student_name', 'like', `%${q.studentName}%`);

    const [{ total }] = (await query.clone().count({ total: '*' })) as Array<{ total: number }>;

    const rows = await query
      .clone()
      .select('*')
      .orderBy('attend_date', 'desc')
      .orderBy('student_no', 'asc')
      .limit(q.size)
      .offset((q.page - 1) * q.size);

    const list = rows.map((r: any) => ({
      id: r.id,
      classId: r.class_id,
      className: r.class_name,
      studentId: r.student_id,
      studentNo: r.student_no,
      studentName: r.student_name,
      attendDate: fmtDate(r.attend_date),
      attendStatus: r.attend_status,
      attendStatusName: ATTEND_STATUS_NAME[r.attend_status] || '',
      attendType: r.attend_type,
      reason: r.reason,
      remark: r.remark,
      registrarId: r.registrar_id,
      registrarName: r.registrar_name,
      createTime: fmtDateTime(r.create_time),
      updateTime: fmtDateTime(r.update_time),
    }));

    res.json(page(list, Number(total), q));
  }),
);

/* ============================================================
 * 4. 班级每日出勤汇总列表
 *    GET /api/job/attendance/summary
 * ============================================================ */

attendanceRouter.get(
  '/summary',
  validate(
    z.object({
      page: z.coerce.number().int().min(1).default(1),
      size: z.coerce.number().int().min(1).max(100).default(20),
      classId: z.string().optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
    }),
  ),
  wrap(async (req, res) => {
    const q = (req as any).validated;

    const query = tbl(db, DB, SUMMARY_TABLE, STAGE).where('is_deleted', false);

    // ★ 数据范围：班主任只能看自己带的班（2026-09-30 补）
    const allowed = await myClassIds(req);
    if (allowed) query.whereIn('class_id', allowed);
    if (q.classId) query.andWhere('class_id', q.classId);
    if (q.startDate) query.andWhere('attend_date', '>=', q.startDate);
    if (q.endDate) query.andWhere('attend_date', '<=', q.endDate);

    const [{ total }] = (await query.clone().count({ total: '*' })) as Array<{ total: number }>;

    const rows = await query
      .clone()
      .select('*')
      .orderBy('attend_date', 'desc')
      .orderBy('class_name', 'asc')
      .limit(q.size)
      .offset((q.page - 1) * q.size);

    const list = rows.map((r: any) => ({
      id: r.id,
      classId: r.class_id,
      className: r.class_name,
      attendDate: fmtDate(r.attend_date),
      shouldCount: r.should_count,
      actualCount: r.actual_count,
      absentCount: r.absent_count,
      attendanceRate: r.attendance_rate,
      headTeacherName: r.head_teacher_name,
      teacherName: r.teacher_name,
      createTime: fmtDateTime(r.create_time),
      updateTime: fmtDateTime(r.update_time),
    }));

    res.json(page(list, Number(total), q));
  }),
);

/* ============================================================
 * 5. ★ 新增：某班某天的出勤明细（点击「详情」用）
 *    GET /api/job/attendance/detail?classId=xxx&attendDate=2026-09-29
 *
 * 返回：该班当天全部在班学生的逐人状态 + 统计 + 班主任/教员
 *      没登记过的学生也列出来（状态显示「未登记」），
 *      这样班主任一眼能看出「谁还没打考勤」。
 * ============================================================ */

attendanceRouter.get(
  '/detail',
  validate(
    z.object({
      classId: z.string().min(1, '班级ID必传'),
      attendDate: z.string().min(1, '日期必传'),
    }),
  ),
  wrap(async (req, res) => {
    const q = (req as any).validated;

    // ★ 数据范围：班主任只能看自己带的班（2026-09-30 补）
    await assertMyClass(req, q.classId);

    const cls = await tbl(db, DB, CLASS_TABLE, STAGE).where({ id: q.classId, is_deleted: false }).first();
    if (!cls) throw new BizError(BizCode.CLASS_NOT_FOUND, '班级不存在');

    // 当天在班学生
    const students = await tblAs(db, DB, CS_TABLE, STAGE, 'cs')
      .leftJoin(`${tblRef(DB, STUDENT_TABLE)} as s`, 'cs.student_id', 's.id')
      .where('cs.class_id', q.classId)
      .andWhere('cs.status', CS_IN)
      .andWhere('cs.is_deleted', false)
      .select('cs.student_id', 'cs.student_no', 'cs.student_name', 's.gender', 's.phone')
      .orderBy('cs.student_no', 'asc');

    // 当天已登记记录
    const records = await tbl(db, DB, TABLE, STAGE)
      .where({ class_id: q.classId, attend_date: q.attendDate, is_deleted: false })
      .select('student_id', 'attend_status', 'attend_type', 'reason', 'remark');
    const recMap = new Map(records.map((r: any) => [r.student_id, r]));

    const rows = students.map((s: any) => {
      const rec: any = recMap.get(s.student_id);
      const st = rec?.attend_status ?? null;
      return {
        studentId: s.student_id,
        studentNo: s.student_no,
        studentName: s.student_name,
        gender: s.gender ?? null,
        phone: s.phone ?? null,
        attendStatus: st,
        attendStatusName: st ? ATTEND_STATUS_NAME[st] || '' : '未登记',
        attendType: rec?.attend_type ?? null,
        reason: rec?.reason ?? null,
        remark: rec?.remark ?? null,
        registered: !!rec,
      };
    });

    // 统计：口径A（应到 = 全部在班学生）
    const registeredRows = rows.filter((r: any) => r.registered);
    const stats =
      registeredRows.length > 0
        ? calcStats(registeredRows.map((r: any) => ({ attendStatus: r.attendStatus })))
        : {
            shouldCount: rows.length,
            actualCount: 0,
            absentCount: 0,
            attendanceRate: 0,
          };

    const sumRow = await tbl(db, DB, SUMMARY_TABLE, STAGE)
      .where({ class_id: q.classId, attend_date: q.attendDate, is_deleted: false })
      .first();

    res.json(
      ok({
        classId: cls.id,
        className: cls.class_name,
        classCode: cls.class_code,
        attendDate: q.attendDate,
        headTeacherName: cls.head_teacher_name || sumRow?.head_teacher_name || null,
        teacherName: cls.teacher_name || sumRow?.teacher_name || null,
        shouldCount: sumRow ? sumRow.should_count : stats.shouldCount,
        actualCount: sumRow ? sumRow.actual_count : stats.actualCount,
        absentCount: sumRow ? sumRow.absent_count : stats.absentCount,
        attendanceRate: sumRow ? sumRow.attendance_rate : stats.attendanceRate,
        registered: !!sumRow,
        totalStudents: rows.length,
        registeredStudents: registeredRows.length,
        rows,
      }),
    );
  }),
);

export default attendanceRouter;
