/**
 * 出勤管理路由（教学管理初高）
 *
 * 覆盖：list / detail / import（算 rate 并回流学生）/ export / unqualified
 * 表：t_class_attendance、t_class_attendance_detail。
 * 口径取「系统设置」attendanceScope：默认分母=在读+试学+预读(3/4/5)，分子=出勤+迟到(1/2)。
 */

import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { BizCode, ATTENDANCE_STATUS_NAME, STAGE_NAME } from 'shared-types/class-jh';
import { AttendanceStatus } from 'shared-types/class-jh';
import { ok, page } from '../utils/response';
import { db } from '../utils/db';
import { wrap } from '../utils/wrap';
import { nameOf } from '../utils/enumName';
import { getNumberSetting, getJsonSetting } from '../utils/setting';
import { validate } from '../middleware/validate';
import { checkPermission } from '../middleware/auth';
import { BizError } from '../middleware/errorHandler';
// ★ P4 切读层：本文件四张初高表（t_class_attendance / t_class_attendance_detail /
//   t_class_student / t_class_info）均已归一，全部走 tbl()/tblTrx()/tblInsTrx() 路由；
//   开关关时与原实现逐字节等价。
import { tbl, tblInsTrx, tblTrx } from '../../teaching/shared/uniTable';

export const attendanceRouter = Router();

const TABLE = 't_class_attendance';
const DETAIL_TABLE = 't_class_attendance_detail';
const STUDENT_TABLE = 't_class_student';
const CLASS_TABLE = 't_class_info';

/** ★ 统一表 edu_stage 取值（本路由只服务初高） */
const DB = 'sms_class_jh';
const STAGE = 'jh' as const;

/** 出勤口径 */
interface AttendanceScope {
  /** 分母包含的学生状态 */
  shouldStatuses: number[];
  /** 分子包含的考勤状态 */
  presentStatuses: number[];
}

/** 出勤台账行 → 实体（双返回） */
function toRecord(r: any) {
  return {
    attendanceId: r.id,
    classId: r.class_id,
    className: r.class_name,
    attendanceDate: r.attendance_date,
    attendanceRate: r.attendance_rate === null || r.attendance_rate === undefined ? null : Number(r.attendance_rate),
    shouldCount: r.should_count ?? 0,
    actualCount: r.actual_count ?? 0,
    monthUnqualifiedCount: r.month_unqualified_count ?? 0,
    teacherId: r.teacher_id,
    teacherName: r.teacher_name,
    headTeacherId: r.head_teacher_id,
    headTeacherName: r.head_teacher_name,
    fileUrl: r.file_url,
    remark: r.remark,
  };
}

/** 出勤明细行 → 实体（双返回） */
function toDetail(d: any) {
  return {
    detailId: d.id,
    attendanceId: d.attendance_id,
    classId: d.class_id,
    attendanceDate: d.attendance_date,
    studentId: d.student_id,
    studentNo: d.student_no,
    studentName: d.student_name,
    phone: d.phone,
    parentPhone: d.parent_phone,
    attendanceStatus: d.attendance_status,
    attendanceStatusName: nameOf(ATTENDANCE_STATUS_NAME, d.attendance_status),
    absentReason: d.absent_reason,
  };
}

/* ============================================================
 * 1. 出勤列表
 *   GET /api/class/attendance/list
 * ============================================================ */

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
  classId: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

attendanceRouter.get(
  '/list',
  checkPermission('class:attendance:view'),
  validate(listSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as z.infer<typeof listSchema>;
    const query = tbl(db, DB, TABLE, STAGE).where('is_deleted', false);
    if (q.classId) query.andWhere('class_id', q.classId);
    if (q.startDate) query.andWhere('attendance_date', '>=', q.startDate);
    if (q.endDate) query.andWhere('attendance_date', '<=', q.endDate);

    const [{ total }] = (await query.clone().count({ total: '*' })) as Array<{ total: number }>;
    const rows = await query
      .clone()
      .select('*')
      .orderBy('attendance_date', 'desc')
      .limit(q.size)
      .offset((q.page - 1) * q.size);

    res.json(page(rows.map(toRecord), Number(total), q));
  }),
);

/* ============================================================
 * 2. 出勤详情（台账 + 明细）
 *   GET /api/class/attendance/detail?attendanceId= 或 classId=&attendanceDate=
 * ============================================================ */

const detailSchema = z.object({
  attendanceId: z.string().optional(),
  classId: z.string().optional(),
  attendanceDate: z.string().optional(),
});

attendanceRouter.get(
  '/detail',
  checkPermission('class:attendance:view'),
  validate(detailSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as z.infer<typeof detailSchema>;

    const query = tbl(db, DB, TABLE, STAGE).where('is_deleted', false);
    if (q.attendanceId) query.andWhere('id', q.attendanceId);
    else if (q.classId && q.attendanceDate) {
      query.andWhere('class_id', q.classId).andWhere('attendance_date', q.attendanceDate);
    } else {
      throw new BizError(BizCode.PARAM_ERROR, '请传 attendanceId 或 classId + attendanceDate');
    }

    const record = await query.first();
    if (!record) throw new BizError(BizCode.BUSINESS_RULE_VIOLATION, '出勤台账不存在');

    const details = await tbl(db, DB, DETAIL_TABLE, STAGE).where({ attendance_id: record.id, is_deleted: false }).select('*');
    res.json(ok({ record: toRecord(record), details: details.map(toDetail) }));
  }),
);

/* ============================================================
 * 3. 出勤导入（算 should/actual/rate 并回流学生出勤率）
 *   POST /api/class/attendance/import
 * ============================================================ */

const importSchema = z.object({
  classId: z.string().min(1, '班级必填'),
  attendanceDate: z.string().min(1, '考勤日期必填'),
  fileUrl: z.string().min(1, '出勤表文件必填'),
  remark: z.string().max(500).optional(),
  details: z
    .array(
      z.object({
        studentId: z.string().min(1, '学生必填'),
        studentNo: z.string().optional(),
        studentName: z.string().optional(),
        attendanceStatus: z.coerce.number().int().min(1).max(5),
        absentReason: z.string().max(255).optional(),
      }),
    )
    .optional(),
});

attendanceRouter.post(
  '/import',
  checkPermission('class:attendance:add'),
  validate(importSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof importSchema>;

    const cls = await tbl(db, DB, CLASS_TABLE, STAGE).where({ id: body.classId, is_deleted: false }).first();
    if (!cls) throw new BizError(BizCode.CLASS_NOT_FOUND, '班级不存在');

    const scope = await getJsonSetting<AttendanceScope>('attendanceScope');
    const shouldStatuses = scope.shouldStatuses ?? [3, 4, 5];
    const presentStatuses = scope.presentStatuses ?? [1, 2];

    // 应到：班级内在读/试学/预读学生
    const students = await tbl(db, DB, STUDENT_TABLE, STAGE)
      .where({ class_id: body.classId, is_deleted: false })
      .whereIn('student_status', shouldStatuses)
      .select('*');
    const shouldCount = students.length;

    // 明细：优先用传入；否则默认全部出勤
    const detailInput = body.details && body.details.length
      ? body.details
      : students.map((s: any) => ({
          studentId: s.id,
          studentNo: s.student_no,
          studentName: s.student_name,
          attendanceStatus: AttendanceStatus.PRESENT,
          absentReason: null as string | null,
        }));

    const studentMap = new Map<string, any>(students.map((s: any) => [s.id, s]));

    // 明细学生必须属于该班「应到」集合，否则直接拒绝：
    // 避免写入 NOT NULL 的 student_no/student_name 时落 NULL（原先报 50001），也避免留下半截台账。
    const invalidDetails = detailInput.filter((d: any) => !studentMap.has(d.studentId));
    if (invalidDetails.length) {
      throw new BizError(
        BizCode.STUDENT_NOT_FOUND,
        `以下学生不在该班应到名单中：${invalidDetails.map((d: any) => d.studentId).join('、')}`,
      );
    }

    const actualCount = detailInput.filter((d: any) => presentStatuses.includes(d.attendanceStatus)).length;
    const attendanceRate = shouldCount > 0 ? Number(((actualCount / shouldCount) * 100).toFixed(2)) : 0;

    const now = new Date();

    // 台账 + 明细 + 出勤率回流 放在同一事务，任一步失败整体回滚（不留脏台账）
    const attendanceId = await db.transaction(async (trx) => {
      // 复用已存在台账（unique class+date）
      const existing = await tblTrx(trx, DB, TABLE, STAGE)
        .where({ class_id: body.classId, attendance_date: body.attendanceDate, is_deleted: false })
        .first();

      const attId = existing?.id ?? randomUUID();
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
        file_url: body.fileUrl,
        remark: body.remark ?? null,
      };

      if (existing) {
        await tblTrx(trx, DB, TABLE, STAGE).where({ id: attId }).update({ ...payload, update_time: now, update_by: req.user?.userId || 'system' });
      } else {
        await tblInsTrx(trx, DB, TABLE, STAGE, { id: attId, ...payload, is_deleted: false, create_time: now, create_by: req.user?.userId || 'system' });
      }

      /**
       * ★★ 明细「整体替换」= 按 (attendance_id, student_id) upsert
       *    （**禁止**「先整体软删、再逐条重插」）
       *
       * 【原来为什么错】
       *   旧写法是 `update({is_deleted:true}).where({attendance_id})` 后逐条 insert。
       *   在老表上一直"看起来正常"——`t_class_attendance_detail` 的
       *   attendance_id / student_id 只有普通索引。
       *   但切读后的统一表 `t_uni_attendance_detail` 有唯一键
       *     `uk_attendance_detail(attendance_id, student_id, edu_stage)`
       *   —— 软删只是把 is_deleted 置 1，**行还在、唯一键仍被占着**
       *   → 紧接着的 insert 必报 `Duplicate entry ... uk_attendance_detail`。
       *
       * 【与 P2 的关系】`teaching/attendance/repo.classJh.ts` 已在 P2 改成同款 upsert；
       *   本文件是初高**老接口**（`class-jh/routes/*`，P4 才接切读层），
       *   所以今天还没炸，但接切读的那一刻就会炸 → 提前修掉。
       */
      const prevDetails = (await tblTrx(trx, DB, DETAIL_TABLE, STAGE)
        .where({ attendance_id: attId })
        .select('id', 'student_id')) as Array<Record<string, any>>;
      const prevMap = new Map(prevDetails.map((r: any) => [String(r.student_id), String(r.id)]));
      const submittedIds = new Set(detailInput.map((d: any) => String(d.studentId)));

      // 本次未提交的旧明细 → 逻辑删除（保留审计，禁止物理删除）
      const staleIds = prevDetails.filter((r) => !submittedIds.has(String(r.student_id))).map((r) => String(r.id));
      if (staleIds.length) {
        await tblTrx(trx, DB, DETAIL_TABLE, STAGE)
          .whereIn('id', staleIds)
          .update({ is_deleted: true, update_time: now });
      }

      // 写明细：已存在（含软删）→ 原地更新并复活；不存在 → 新增
      for (const d of detailInput) {
        const stu = studentMap.get(d.studentId);
        const detailPayload = {
          attendance_id: attId,
          class_id: cls.id,
          attendance_date: body.attendanceDate,
          student_id: d.studentId,
          student_no: d.studentNo ?? stu?.student_no ?? null,
          student_name: d.studentName ?? stu?.student_name ?? null,
          phone: stu?.phone ?? null,
          parent_phone: stu?.parent_phone ?? null,
          attendance_status: d.attendanceStatus,
          absent_reason: d.absentReason ?? null,
        };
        const prevId = prevMap.get(String(d.studentId));
        if (prevId) {
          await tblTrx(trx, DB, DETAIL_TABLE, STAGE)
            .where({ id: prevId })
            .update({ ...detailPayload, is_deleted: false, update_time: now });
        } else {
          await tblInsTrx(trx, DB, DETAIL_TABLE, STAGE, {
            id: randomUUID(),
            ...detailPayload,
            is_deleted: false,
            create_time: now,
            create_by: req.user?.userId || 'system',
          });
        }
      }

      // 回流学生出勤率（该班所有应到学生统一回写当日口径后的班级出勤率）
      await tblTrx(trx, DB, STUDENT_TABLE, STAGE)
        .where({ class_id: cls.id, is_deleted: false })
        .whereIn('student_status', shouldStatuses)
        .update({ attendance_rate: attendanceRate, update_time: now });

      // 回写班级今日出勤率
      await tblTrx(trx, DB, CLASS_TABLE, STAGE).where({ id: cls.id }).update({ today_attendance_rate: attendanceRate, update_time: now });

      return attId;
    });

    res.json(ok({ attendanceId }, '导入成功'));
  }),
);

/* ============================================================
 * 4. 出勤导出
 *   GET /api/class/attendance/export
 * ============================================================ */

attendanceRouter.get(
  '/export',
  checkPermission('class:attendance:export'),
  validate(listSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as z.infer<typeof listSchema>;
    const query = tbl(db, DB, TABLE, STAGE).where('is_deleted', false);
    if (q.classId) query.andWhere('class_id', q.classId);
    if (q.startDate) query.andWhere('attendance_date', '>=', q.startDate);
    if (q.endDate) query.andWhere('attendance_date', '<=', q.endDate);

    const rows = await query.select('*').orderBy('attendance_date', 'desc');
    res.json(ok(rows.map(toRecord)));
  }),
);

/* ============================================================
 * 5. 当月未达标学生
 *   GET /api/class/attendance/unqualified?classId=&month=YYYY-MM
 * ============================================================ */

const unqualifiedSchema = z.object({
  classId: z.string().optional(),
  month: z.string().optional(),
});

attendanceRouter.get(
  '/unqualified',
  checkPermission('class:attendance:view'),
  validate(unqualifiedSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as z.infer<typeof unqualifiedSchema>;
    const targetRate = await getNumberSetting('attendanceTargetRate');
    const month = q.month || new Date().toISOString().slice(0, 7);

    // 该月所有台账（按班过滤）
    // 月末边界：取「次月 1 日」作为开区间上界，避免出现 'YYYY-MM-32' 这类非法 DATE 值
    const [yearNum, monthNum] = month.split('-').map((v) => Number(v));
    const nextMonthStart =
      monthNum === 12 ? `${yearNum + 1}-01-01` : `${yearNum}-${String(monthNum + 1).padStart(2, '0')}-01`;
    const attQuery = tbl(db, DB, TABLE, STAGE)
      .where('is_deleted', false)
      .andWhere('attendance_date', '>=', `${month}-01`)
      .andWhere('attendance_date', '<', nextMonthStart);
    if (q.classId) attQuery.andWhere('class_id', q.classId);
    const records = await attQuery.select('*');
    const attendanceIds = records.map((r: any) => r.id);
    if (!attendanceIds.length) {
      res.json(ok([]));
      return;
    }

    // 该月明细
    const details = await tbl(db, DB, DETAIL_TABLE, STAGE).whereIn('attendance_id', attendanceIds).andWhere('is_deleted', false).select('*');
    // 按学生统计：总次数 & 达标次数（出勤+迟到视为达标）
    const stat = new Map<string, { studentNo: string; studentName: string; total: number; qualified: number }>();
    for (const d of details) {
      const key = d.student_id;
      if (!stat.has(key)) {
        stat.set(key, { studentNo: d.student_no, studentName: d.student_name, total: 0, qualified: 0 });
      }
      const s = stat.get(key)!;
      s.total += 1;
      if ([AttendanceStatus.PRESENT, AttendanceStatus.LATE].includes(d.attendance_status)) s.qualified += 1;
    }

    const list: any[] = [];
    for (const [studentId, s] of stat.entries()) {
      const rate = s.total > 0 ? Number(((s.qualified / s.total) * 100).toFixed(2)) : 0;
      if (rate < targetRate) {
        list.push({
          studentId,
          studentNo: s.studentNo,
          studentName: s.studentName,
          className: undefined,
          attendanceRate: rate,
          unqualifiedCount: s.total - s.qualified,
        });
      }
    }

    // 补充班级名
    if (list.length) {
      const stuRows = await tbl(db, DB, STUDENT_TABLE, STAGE)
        .whereIn('id', list.map((x) => x.studentId))
        .select('id', 'class_name');
      const m = new Map<string, string>(stuRows.map((r: any) => [r.id, r.class_name]));
      for (const item of list) item.className = m.get(item.studentId) ?? '';
    }

    res.json(ok(list));
  }),
);

export default attendanceRouter;
