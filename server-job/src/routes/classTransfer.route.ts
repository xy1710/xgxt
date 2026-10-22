/**
 * 班级交接路由（就业管理 > 实训阶段）
 *
 * 接口前缀：/api/job/class-transfer
 * 表：t_job_class_transfer（交接记录）
 * 字段依据：docs/换班交接-字段定稿.md
 *
 * 【业务含义】（2026-09-29 斌哥拍板 方案A）
 *   一次交接 = 一个班「换负责人」：原班主任/教员/助教 → 新班主任/教员/助教。
 *   学生不动，整个班跟着新负责人走。
 *
 * ⚠️ 与「学生换班」「末班」区分：
 *   本路由是【老师层面】的班交接；
 *   学生个别转班走 classStudent 路由的 leaveType。
 *
 * 【核心规则】
 *   1. 不走审批，提交即生效（斌哥拍板）
 *   2. 提交时存「快照」：交接那一刻的人数 / 累计出勤率 / 学生名单
 *   3. 交接后要同步更新 t_job_class 的三个负责人字段
 *   4. 交接记录只增不改（留痕），可以逻辑删除
 *
 * 【员工数据来源】
 *   教师名单来自【权限管理模块 8006】（斌哥拍板：留好接口）。
 *   当前用 utils/teacherSource.ts 的本地假数据，将来换成 HTTP 调用。
 */

import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import {
  BizCode,
  CLASS_STATUS_NAME,
  CLASS_STAGE_NAME,
  TRANSFER_TYPE_NAME,
  ClassStatus,
} from 'shared-types';
import { ok, page } from '../utils/response';
import { db } from '../utils/db';
import { wrap } from '../utils/wrap';
import { today, fmtDate, fmtDateTime } from '../utils/date';
import { validate } from '../middleware/validate';
import { checkPermission } from '../middleware/auth';
import { BizError } from '../middleware/errorHandler';
import { listTeachers, findTeacherName } from '../utils/teacherSource';
// ★ P3 切读层：本文件四张表（t_job_class_transfer / t_job_class / t_job_class_student /
//   t_job_attendance_summary）都已归一，读/写走 tbl()/tblTrx()/tblInsTrx()；开关关时与原实现等价。
import { tbl, tblInsTrx, tblTrx, phaseCodeCol, readPhaseCode } from '../teaching/shared/uniTable';

export const classTransferRouter = Router();

/** 表名常量 */
const TABLE = 't_job_class_transfer';
const CLASS_TABLE = 't_job_class';
const CS_TABLE = 't_job_class_student';
const ATT_SUM_TABLE = 't_job_attendance_summary';

/** ★ 统一表 edu_stage 取值（本路由只服务实训） */
const STAGE = 'job' as const;
const DB = 'sms_job';

/** 花名册在班状态 */
const CS_IN = 1;

/* ============================================================
 * 内部工具
 * ============================================================ */

/** 把数据库行转成前端要的小驼峰 + 双返回 */
async function decorate(row: any): Promise<any> {
  if (!row) return row;

  // 解析 JSON 字符串字段（防止脏数据导致 JSON.parse 崩）
  let studentList: any[] = [];
  let detail: number[] = [];
  try {
    if (row.snapshot_student_list) studentList = JSON.parse(row.snapshot_student_list);
  } catch {
    studentList = [];
  }
  try {
    if (row.snapshot_detail) detail = JSON.parse(row.snapshot_detail);
  } catch {
    detail = [];
  }

  // ⚠️ 兜底：老数据可能只存了负责人ID、没存姓名快照。
  //    这时按 ID 反查一次（将来查 8006 员工表），保证页面能显示名字而不是空白。
  const oldHeadName =
    row.old_head_teacher_name || (await findTeacherName(row.old_head_teacher_id));
  const oldTeacherName =
    row.old_teacher_name || (await findTeacherName(row.old_teacher_id));
  const oldAssistantName =
    row.old_assistant_name || (await findTeacherName(row.old_assistant_id));
  const newHeadName =
    row.new_head_teacher_name || (await findTeacherName(row.new_head_teacher_id));
  const newTeacherName =
    row.new_teacher_name || (await findTeacherName(row.new_teacher_id));
  const newAssistantName =
    row.new_assistant_name || (await findTeacherName(row.new_assistant_id));

  return {
    id: row.id,

    classId: row.class_id,
    className: row.class_name,
    classCode: row.class_code,
    classStatus: row.class_status,
    classStatusName: CLASS_STATUS_NAME[row.class_status] || '',
    stage: readPhaseCode(row),
    stageName: CLASS_STAGE_NAME[readPhaseCode(row)] || '',

    oldHeadTeacherId: row.old_head_teacher_id,
    oldHeadTeacherName: oldHeadName,
    oldTeacherId: row.old_teacher_id,
    oldTeacherName: oldTeacherName,
    oldAssistantId: row.old_assistant_id,
    oldAssistantName: oldAssistantName,

    newHeadTeacherId: row.new_head_teacher_id,
    newHeadTeacherName: newHeadName,
    newTeacherId: row.new_teacher_id,
    newTeacherName: newTeacherName,
    newAssistantId: row.new_assistant_id,
    newAssistantName: newAssistantName,

    transferDate: fmtDate(row.transfer_date),
    transferType: row.transfer_type,
    transferTypeName: TRANSFER_TYPE_NAME[row.transfer_type] || '',
    transferReason: row.transfer_reason,
    remark: row.remark,

    snapshotStudentCount: row.snapshot_student_count,
    snapshotAttendanceRate:
      row.snapshot_attendance_rate === null || row.snapshot_attendance_rate === undefined
        ? null
        : Number(row.snapshot_attendance_rate),
    snapshotStudentList: studentList,
    snapshotDetail: detail,

    createByName: row.create_by_name,
    createTime: fmtDateTime(row.create_time),
  };
}

/** 列表项（不带学生名单明细，减小传输量） */
async function decorateListItem(row: any): Promise<any> {
  const full = await decorate(row);
  delete full.snapshotStudentList;
  delete full.snapshotDetail;
  delete full.oldTeacherId;
  delete full.oldAssistantId;
  delete full.newTeacherId;
  delete full.newAssistantId;
  delete full.oldHeadTeacherId;
  delete full.newHeadTeacherId;
  delete full.classStatus;
  delete full.stage;
  return full;
}

/**
 * 算某个班的「累计出勤率」
 * 口径：所有已登记日期的 (实到之和) ÷ (应到之和) × 100
 * 没有出勤记录时返回 null
 */
async function calcAccumulateRate(classId: string): Promise<number | null> {
  const row = await tbl(db, DB, ATT_SUM_TABLE, STAGE)
    .where({ class_id: classId, is_deleted: false })
    .sum({ should: 'should_count', actual: 'actual_count' })
    .first();

  const should = Number(row?.should || 0);
  const actual = Number(row?.actual || 0);
  if (should <= 0) return null;
  return Math.round((actual / should) * 10000) / 100;
}

/** 取班级在班学生名单（快照用） */
async function getClassStudents(classId: string) {
  const rows = await tbl(db, DB, CS_TABLE, STAGE)
    .where({ class_id: classId, status: CS_IN, is_deleted: false })
    .select('student_id', 'student_no', 'student_name')
    .orderBy('student_no', 'asc');

  return rows.map((r: any) => ({
    id: r.student_id,
    no: r.student_no || '',
    name: r.student_name || '',
  }));
}

/* ============================================================
 * 1. 交接记录列表
 *    GET /api/job/class-transfer/page
 * ============================================================ */

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(200).default(20),
  classId: z.string().optional(),
  transferType: z.coerce.number().int().optional(),
  newHeadTeacherId: z.string().optional(),
  className: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

classTransferRouter.get(
  '/page',
  validate(listSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as z.infer<typeof listSchema>;

    const query = tbl(db, DB, TABLE, STAGE).where('is_deleted', false);

    if (q.classId) query.andWhere('class_id', q.classId);
    if (q.transferType) query.andWhere('transfer_type', q.transferType);
    if (q.newHeadTeacherId) query.andWhere('new_head_teacher_id', q.newHeadTeacherId);
    if (q.className) query.andWhere('class_name', 'like', `%${q.className}%`);
    if (q.startDate) query.andWhere('transfer_date', '>=', q.startDate);
    if (q.endDate) query.andWhere('transfer_date', '<=', q.endDate);

    const [{ total }] = (await query.clone().count({ total: 'id' })) as Array<{ total: number }>;

    const rows = await query
      .clone()
      .select('*')
      .orderBy('transfer_date', 'desc')
      .orderBy('create_time', 'desc')
      .limit(q.size)
      .offset((q.page - 1) * q.size);

    const list = await Promise.all(rows.map((r: any) => decorateListItem(r)));
    res.json(page(list, Number(total), q));
  }),
);

/* ============================================================
 * 2. 交接记录详情
 *    GET /api/job/class-transfer/detail?id=xxx
 * ============================================================ */

classTransferRouter.get(
  '/detail',
  validate(z.object({ id: z.string().min(1, '交接记录ID必传') })),
  wrap(async (req, res) => {
    const q = (req as any).validated;

    const row = await tbl(db, DB, TABLE, STAGE).where({ id: q.id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.TRANSFER_NOT_FOUND, '交接记录不存在');

    res.json(ok(await decorate(row)));
  }),
);

/* ============================================================
 * 3. 交接预览（点"去交接"时先看当前状态）
 *    GET /api/job/class-transfer/preview?classId=xxx
 *
 * 返回：当前负责人（即将被替换）+ 在班人数 + 累计出勤率 + 学生名单
 * ============================================================ */

classTransferRouter.get(
  '/preview',
  validate(z.object({ classId: z.string().min(1, '班级ID必传') })),
  wrap(async (req, res) => {
    const q = (req as any).validated;

    const cls = await tbl(db, DB, CLASS_TABLE, STAGE).where({ id: q.classId, is_deleted: false }).first();
    if (!cls) throw new BizError(BizCode.CLASS_NOT_FOUND, '班级不存在');

    const students = await getClassStudents(cls.id);
    const rate = await calcAccumulateRate(cls.id);

    res.json(
      ok({
        classId: cls.id,
        className: cls.class_name,
        classCode: cls.class_code,
        classStatus: cls.class_status,
        classStatusName: CLASS_STATUS_NAME[cls.class_status] || '',
        stage: readPhaseCode(cls),
        stageName: CLASS_STAGE_NAME[readPhaseCode(cls)] || '',

        headTeacherId: cls.head_teacher_id,
        headTeacherName: cls.head_teacher_name,
        teacherId: cls.teacher_id,
        teacherName: cls.teacher_name,
        assistantId: cls.assistant_id,
        assistantName: cls.assistant_name,

        studentCount: students.length,
        attendanceRate: rate,
        students,
      }),
    );
  }),
);

/* ============================================================
 * 4. 教师选项（下拉选人）
 *    GET /api/job/class-transfer/teacher-options?role=head
 *
 * ⚠️ 数据来自权限管理 8006（斌哥拍板留好接口），当前是本地假数据
 * ============================================================ */

classTransferRouter.get(
  '/teacher-options',
  validate(z.object({ role: z.string().optional() })),
  wrap(async (req, res) => {
    const q = (req as any).validated;
    const list = await listTeachers(q.role);
    res.json(ok(list));
  }),
);

/* ============================================================
 * 5. 执行交接（核心）
 *    POST /api/job/class-transfer/do
 *
 * 流程：
 *   ① 校验班级存在
 *   ② 校验新旧负责人不能完全相同
 *   ③ 取快照：人数 / 累计出勤率 / 学生名单
 *   ④ 写交接记录
 *   ⑤ 更新 t_job_class 的三个负责人字段 ← 【真正生效的一步】
 * ============================================================ */

const doSchema = z.object({
  classId: z.string().min(1, '班级ID必传'),

  newHeadTeacherId: z.string().min(1, '新班主任必填'),
  newHeadTeacherName: z.string().max(50).optional(),
  newTeacherId: z.string().max(36).optional(),
  newTeacherName: z.string().max(50).optional(),
  newAssistantId: z.string().max(36).optional(),
  newAssistantName: z.string().max(50).optional(),

  transferDate: z.string().optional(),
  transferType: z.number().int().min(1).max(5),
  transferReason: z.string().max(200).optional(),
  remark: z.string().max(500).optional(),
  transferItems: z.array(z.number().int()).optional(),
});

classTransferRouter.post(
  '/do',
  validate(doSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof doSchema>;

    // ---- ① 班级 ----
    const cls = await tbl(db, DB, CLASS_TABLE, STAGE).where({ id: body.classId, is_deleted: false }).first();
    if (!cls) throw new BizError(BizCode.CLASS_NOT_FOUND, '班级不存在');

    // ⚠️ 已结业的班不能交接（斌哥 2026-09-30）——
    //    前端下拉已经过滤掉了，这里再拦一道，防止有人直接调接口绕过。
    if (cls.class_status === ClassStatus.GRADUATED) {
      throw new BizError(BizCode.CLASS_STATUS_NOT_ALLOW, '已结业的班级不能交接');
    }

    // ---- ② 新旧负责人不能完全相同 ----
    //     只要"班主任 + 教员"这两项都没变，就认为没交接的必要
    const sameHead = cls.head_teacher_id === body.newHeadTeacherId;
    const sameTeacher =
      (cls.teacher_id || null) === (body.newTeacherId || null);
    if (sameHead && sameTeacher) {
      throw new BizError(
        BizCode.TRANSFER_SAME_TEACHER,
        '新班主任/教员与原负责人完全相同，无需交接',
      );
    }

    // ---- ③ 快照 ----
    const students = await getClassStudents(cls.id);
    const rate = await calcAccumulateRate(cls.id);
    const transferDate = body.transferDate || today();

    // ---- ④⑤ 写记录 + 更新班级（同一事务）----
    const transferId = randomUUID();
    const now = new Date();

    // 姓名：优先用前端传的，没传就按ID去查（将来查 8006）
    const newHeadName =
      body.newHeadTeacherName || (await findTeacherName(body.newHeadTeacherId)) || null;
    const newTeacherName =
      body.newTeacherName || (await findTeacherName(body.newTeacherId)) || null;
    const newAssistantName =
      body.newAssistantName || (await findTeacherName(body.newAssistantId)) || null;

    await db.transaction(async (trx) => {
      // ④ 写交接记录
      await tblInsTrx(trx, DB, TABLE, STAGE, {
        id: transferId,
        create_time: now,
        create_by: req.user?.userId || null,
        create_by_name: req.user?.userName || null,
        is_deleted: false,

        class_id: cls.id,
        class_name: cls.class_name,
        class_code: cls.class_code,
        class_status: cls.class_status,
        [phaseCodeCol()]: readPhaseCode(cls),

        old_head_teacher_id: cls.head_teacher_id,
        old_head_teacher_name: cls.head_teacher_name,
        old_teacher_id: cls.teacher_id,
        old_teacher_name: cls.teacher_name,
        old_assistant_id: cls.assistant_id,
        old_assistant_name: cls.assistant_name,

        new_head_teacher_id: body.newHeadTeacherId,
        new_head_teacher_name: newHeadName,
        new_teacher_id: body.newTeacherId || null,
        new_teacher_name: newTeacherName,
        new_assistant_id: body.newAssistantId || null,
        new_assistant_name: newAssistantName,

        transfer_date: transferDate,
        transfer_type: body.transferType,
        transfer_reason: body.transferReason || null,
        remark: body.remark || null,

        snapshot_student_count: students.length,
        snapshot_attendance_rate: rate,
        snapshot_student_list: JSON.stringify(students),
        snapshot_detail: JSON.stringify(body.transferItems || []),
      });

      // ⑤ 更新班级负责人 ← 真正生效
      await tblTrx(trx, DB, CLASS_TABLE, STAGE)
        .where({ id: cls.id })
        .update({
          head_teacher_id: body.newHeadTeacherId,
          head_teacher_name: newHeadName,
          teacher_id: body.newTeacherId || null,
          teacher_name: newTeacherName,
          assistant_id: body.newAssistantId || null,
          assistant_name: newAssistantName,
          update_time: now,
          update_by: req.user?.userId || null,
        });
    });

    res.json(
      ok({
        transferId,
        className: cls.class_name,
        newHeadTeacherName: newHeadName,
        newTeacherName,
        newAssistantName,
        snapshotStudentCount: students.length,
      }),
    );
  }),
);

/* ============================================================
 * 6. 按班级查交接历史（班级详情里「历史交接详情」用）
 *    GET /api/job/class-transfer/history?classId=xxx
 * ============================================================ */

classTransferRouter.get(
  '/history',
  validate(z.object({ classId: z.string().min(1, '班级ID必传') })),
  wrap(async (req, res) => {
    const q = (req as any).validated;

    const rows = await tbl(db, DB, TABLE, STAGE)
      .where({ class_id: q.classId, is_deleted: false })
      .select('*')
      .orderBy('transfer_date', 'desc')
      .orderBy('create_time', 'desc');

    res.json(ok(await Promise.all(rows.map((r: any) => decorate(r)))));
  }),
);

/* ============================================================
 * 7. 删除交接记录（逻辑删除）
 *    DELETE /api/job/class-transfer/delete/:id
 *
 * ⚠️ 只是删记录留痕，【不会】把班级负责人改回去
 *    （因为交接是历史事实，撤销要走"再交接一次"）
 * ============================================================ */

classTransferRouter.delete(
  '/delete/:id',
  wrap(async (req, res) => {
    const { id } = req.params;

    const row = await tbl(db, DB, TABLE, STAGE).where({ id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.TRANSFER_NOT_FOUND, '交接记录不存在');

    await tbl(db, DB, TABLE, STAGE).where({ id }).update({
      is_deleted: true,
      update_time: new Date(),
      update_by: req.user?.userId || null,
    });

    res.json(ok(null));
  }),
);
