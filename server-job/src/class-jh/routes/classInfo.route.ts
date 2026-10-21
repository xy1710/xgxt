/**
 * 班级管理路由（教学管理初高）
 *
 * 覆盖：班级主档 list/detail/add/update/delete/options + 班级状态机校验（40014）。
 * 表：t_class_info（班级主表，避免 t_class_class）。
 * 封班约束（40011）由 student.route / handover 在转入前调用。
 */

import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { BizCode, CLASS_STATUS_NAME } from 'shared-types/class-jh';
import { ClassStatus } from 'shared-types/class-jh';
import { ok, page } from '../utils/response';
import { db } from '../utils/db';
import { wrap } from '../utils/wrap';
import { writeOpLog } from '../utils/opLog';
import { nameOf } from '../utils/enumName';
// ★ 2026-10-16 阶段名改为「优先读阶段字典表」，常量表兜底（用户自建方案的阶段编码不在常量里）
import { resolveStageName } from '../utils/stageDict';
import { validate } from '../middleware/validate';
import { checkPermission } from '../middleware/auth';
import { BizError } from '../middleware/errorHandler';
import classSync from '../../utils/classSync';

export const classInfoRouter = Router();

const TABLE = 't_class_info';
const STUDENT_TABLE = 't_class_student';
const HANDOVER_TABLE = 't_class_handover';
const TERM_TABLE = 't_class_term';

/** 班级状态机允许的流转表（key=当前，val=可转目标） */
const CLASS_STATUS_TRANSITIONS: Record<number, number[]> = {
  [ClassStatus.OPEN]: [ClassStatus.OPEN, ClassStatus.CLOSED, ClassStatus.GRADUATING],
  [ClassStatus.CLOSED]: [ClassStatus.CLOSED, ClassStatus.OPEN, ClassStatus.GRADUATING],
  [ClassStatus.GRADUATING]: [ClassStatus.GRADUATING, ClassStatus.GRADUATED],
  [ClassStatus.GRADUATED]: [ClassStatus.GRADUATED],
};

/** 校验班级状态流转是否合法（非法 → 40014） */
function assertClassStatusTransition(from: number, to: number): void {
  const allowed = CLASS_STATUS_TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    throw new BizError(
      BizCode.ILLEGAL_STATE_TRANSITION,
      `班级状态不可从「${nameOf(CLASS_STATUS_NAME, from)}」流转为「${nameOf(CLASS_STATUS_NAME, to)}」`,
    );
  }
}

/** 班级行 → 实体（双返回） */
function toClassInfo(r: any) {
  return {
    classId: r.id,
    className: r.class_name,
    stage: r.stage,
    stageName: resolveStageName(r.stage),
    headTeacherId: r.head_teacher_id,
    headTeacherName: r.head_teacher_name,
    teacherId: r.teacher_id,
    teacherName: r.teacher_name,
    assistantId: r.assistant_id,
    assistantName: r.assistant_name,
    classroom: r.classroom,
    openDate: r.open_date,
    deptCode: r.dept_code,
    classStatus: r.class_status,
    classStatusName: nameOf(CLASS_STATUS_NAME, r.class_status),
    studentCount: r.student_count ?? 0,
    todayAttendanceRate:
      r.today_attendance_rate === null || r.today_attendance_rate === undefined
        ? null
        : Number(r.today_attendance_rate),
    remark: r.remark,
    createTime: r.create_time,
  };
}

/* ============================================================
 * 0. 开放班级 / 升学目标班级（★ 2026-10-05 分班 · 升学）
 * ============================================================ */

/**
 * GET /api/class-jh/classInfo/open-options
 *
 * ⚠️ 内部接口（只接受 x-internal-token）：给咨询「分班」提供初高开放班级清单。
 *    见 middleware/auth.ts 的 INTERNAL_INGRESS 白名单。
 */
classInfoRouter.get(
  '/open-options',
  wrap(async (_req, res) => {
    const rows = await db(TABLE)
      .where('is_deleted', false)
      .andWhere('class_status', ClassStatus.OPEN)
      .orderBy('class_name', 'asc');
    res.json(ok(rows.map(toClassInfo)));
  }),
);

/**
 * GET /api/class-jh/classInfo/upgrade-targets
 *
 * 供初高「升学」弹窗选择要升入的**大学部**班级。
 * ⚠️ 本模块不直连大学部数据库，走内部接口拉取（classSync.classOpenOptions → /api/class/info/open-options）。
 */
classInfoRouter.get(
  '/upgrade-targets',
  checkPermission('class:classInfo:view'),
  wrap(async (_req, res) => {
    const out = await classSync.classOpenOptions();
    if (!out.ok) {
      throw new BizError(BizCode.INTERNAL_ERROR, `获取大学部开放班级失败：${out.message}`);
    }
    const list = Array.isArray(out.data) ? out.data : [];
    res.json(ok(list));
  }),
);

/* ============================================================
 * 1. 班级列表
 *   GET /api/class/classInfo/list
 * ============================================================ */

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
  className: z.string().optional(),
  stage: z.coerce.number().int().optional(),
  classStatus: z.coerce.number().int().optional(),
  headTeacherId: z.string().optional(),
  teacherId: z.string().optional(),
  keyword: z.string().optional(),
});

classInfoRouter.get(
  '/list',
  checkPermission('class:classInfo:view'),
  validate(listSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as z.infer<typeof listSchema>;

    const query = db(TABLE).where('is_deleted', false);
    if (q.className) query.andWhere('class_name', 'like', `%${q.className}%`);
    if (q.stage) query.andWhere('stage', q.stage);
    if (q.classStatus) query.andWhere('class_status', q.classStatus);
    if (q.headTeacherId) query.andWhere('head_teacher_id', q.headTeacherId);
    if (q.teacherId) query.andWhere('teacher_id', q.teacherId);
    if (q.keyword) {
      query.andWhere((qb) => {
        qb.where('class_name', 'like', `%${q.keyword}%`)
          .orWhere('head_teacher_name', 'like', `%${q.keyword}%`)
          .orWhere('teacher_name', 'like', `%${q.keyword}%`);
      });
    }

    const [{ total }] = await query.clone().count({ total: '*' });
    const rows = await query
      .clone()
      .select('*')
      .orderBy('create_time', 'desc')
      .limit(q.size)
      .offset((q.page - 1) * q.size);

    res.json(page(rows.map(toClassInfo), Number(total), q));
  }),
);

/* ============================================================
 * 2. 班级详情（含交接历史 + 学期 + 学生）
 *   GET /api/class/classInfo/detail?id=xxx
 * ============================================================ */

classInfoRouter.get(
  '/detail',
  checkPermission('class:classInfo:view'),
  validate(z.object({ id: z.string().min(1, '必须传 id') })),
  wrap(async (req, res) => {
    const { id } = (req as any).validated as { id: string };
    const row = await db(TABLE).where({ id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.CLASS_NOT_FOUND, '班级不存在');

    const handovers = await db(HANDOVER_TABLE).where({ class_id: id, is_deleted: false }).orderBy('handover_time', 'desc');
    const terms = await db(TERM_TABLE).where({ class_id: id, is_deleted: false }).orderBy('start_date', 'asc');
    const students = await db(STUDENT_TABLE)
      .where({ class_id: id, is_deleted: false })
      .select('id', 'student_no', 'student_name', 'student_status');

    res.json(
      ok({
        ...toClassInfo(row),
        handovers: handovers.map((h: any) => ({
          handoverId: h.id,
          classId: h.class_id,
          className: h.class_name,
          handoverRole: h.handover_role,
          fromUserName: h.from_user_name,
          toUserName: h.to_user_name,
          handoverContent: h.handover_content,
          handoverTime: h.handover_time,
        })),
        terms: terms.map((t: any) => ({
          termId: t.id,
          classId: t.class_id,
          className: t.class_name,
          termName: t.term_name,
          startDate: t.start_date,
          endDate: t.end_date,
        })),
        students: students.map((s: any) => ({
          studentId: s.id,
          studentNo: s.student_no,
          studentName: s.student_name,
        })),
      }),
    );
  }),
);

/* ============================================================
 * 3. 新增班级
 *   POST /api/class/classInfo/add
 * ============================================================ */

const addSchema = z.object({
  className: z.string().min(1, '班级名称必填'),
  stage: z.coerce.number().int().min(101, '学习阶段不正确'),
  headTeacherId: z.string().min(1, '班主任必填'),
  // ⚠️ t_class_info.head_teacher_name 是 NOT NULL 列。班主任姓名是班级的必填业务属性，
  //    所以这里必须必填校验（缺失返回 40002），不能用空串兜底 —— 空串会造成"静默写入空姓名"。
  headTeacherName: z.string().min(1, '班主任姓名必填'),
  teacherId: z.string().min(1, '教员必填'),
  teacherName: z.string().min(1, '教员姓名必填'),
  assistantId: z.string().optional(),
  assistantName: z.string().optional(),
  classroom: z.string().max(100).optional(),
  openDate: z.string().optional(),
  deptCode: z.coerce.number().int().min(1).max(2).default(1),
  classStatus: z.coerce.number().int().min(1).max(4).default(1),
  remark: z.string().max(500).optional(),
});

classInfoRouter.post(
  '/add',
  checkPermission('class:classInfo:add'),
  validate(addSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof addSchema>;

    // ⚠️ 唯一性预检按「物理范围」查（含已逻辑删除的行）：uk_class_name 是物理唯一索引，
    //    若带 is_deleted=false，删除后重建同名班级会绕过预检、直撞索引 → 返回 50002。
    const dup = await db(TABLE).where({ class_name: body.className }).first();
    if (dup) {
      throw new BizError(
        BizCode.BUSINESS_RULE_VIOLATION,
        dup.is_deleted
          ? `班级名称「${body.className}」已被「已删除」的历史班级占用，不可复用`
          : `班级名称「${body.className}」已存在`,
      );
    }

    const id = randomUUID();
    const now = new Date();
    await db(TABLE).insert({
      id,
      class_name: body.className,
      stage: body.stage,
      head_teacher_id: body.headTeacherId,
      // 姓名列为 NOT NULL，可选姓名统一兜底空串（契约仍保持 optional）
      head_teacher_name: body.headTeacherName,
      teacher_id: body.teacherId,
      teacher_name: body.teacherName,
      assistant_id: body.assistantId ?? null,
      assistant_name: body.assistantName ?? null,
      classroom: body.classroom ?? null,
      open_date: body.openDate ?? null,
      dept_code: body.deptCode,
      class_status: body.classStatus,
      student_count: 0,
      remark: body.remark ?? null,
      is_deleted: false,
      create_time: now,
      create_by: req.user?.userId || 'system',
    });

    await writeOpLog({
      module: 'class',
      bizType: '班级状态',
      bizId: id,
      classId: id,
      opUserId: req.user?.userId,
      opUserName: req.user?.userName,
      opDesc: `新增班级 ${body.className}`,
      afterValue: { classStatus: body.classStatus },
    });

    res.json(ok({ id }, '新增成功'));
  }),
);

/* ============================================================
 * 4. 修改班级（含状态机流转 + op_log）
 *   PUT /api/class/classInfo/update
 * ============================================================ */

const updateSchema = z.object({
  id: z.string().min(1, '必须传 id'),
  className: z.string().min(1, '班级名称必填'),
  stage: z.coerce.number().int().min(101),
  headTeacherId: z.string().min(1),
  headTeacherName: z.string().optional(),
  teacherId: z.string().min(1),
  teacherName: z.string().optional(),
  assistantId: z.string().optional(),
  assistantName: z.string().optional(),
  classroom: z.string().max(100).optional(),
  openDate: z.string().optional(),
  deptCode: z.coerce.number().int().min(1).max(2).optional(),
  classStatus: z.coerce.number().int().min(1).max(4),
  remark: z.string().max(500).optional(),
});

classInfoRouter.put(
  '/update',
  checkPermission('class:classInfo:edit'),
  validate(updateSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof updateSchema>;

    const exists = await db(TABLE).where({ id: body.id, is_deleted: false }).first();
    if (!exists) throw new BizError(BizCode.CLASS_NOT_FOUND, '班级不存在');

    // 班级名唯一
    if (body.className !== exists.class_name) {
      const dup = await db(TABLE)
        .where({ class_name: body.className, is_deleted: false })
        .whereNot('id', body.id)
        .first();
      if (dup) throw new BizError(BizCode.BUSINESS_RULE_VIOLATION, `班级名称「${body.className}」已被占用`);
    }

    // 状态机校验
    assertClassStatusTransition(exists.class_status, body.classStatus);

    await db(TABLE).where({ id: body.id }).update({
      class_name: body.className,
      stage: body.stage,
      head_teacher_id: body.headTeacherId,
      head_teacher_name: body.headTeacherName ?? exists.head_teacher_name,
      teacher_id: body.teacherId,
      teacher_name: body.teacherName ?? exists.teacher_name,
      assistant_id: body.assistantId ?? null,
      assistant_name: body.assistantName ?? null,
      classroom: body.classroom ?? null,
      open_date: body.openDate ?? null,
      dept_code: body.deptCode ?? exists.dept_code,
      class_status: body.classStatus,
      remark: body.remark ?? null,
      update_time: new Date(),
      update_by: req.user?.userId || 'system',
    });

    // 班级名变更 → 同步学生冗余字段
    if (body.className !== exists.class_name) {
      await db(STUDENT_TABLE)
        .where({ class_id: body.id, is_deleted: false })
        .update({ class_name: body.className, stage: body.stage, update_time: new Date() });
    }

    // 状态变更才写日志
    if (body.classStatus !== exists.class_status) {
      await writeOpLog({
        module: 'class',
        bizType: '班级状态',
        bizId: body.id,
        classId: body.id,
        opUserId: req.user?.userId,
        opUserName: req.user?.userName,
        opDesc: `班级 ${body.className} 状态变更：${nameOf(CLASS_STATUS_NAME, exists.class_status)} → ${nameOf(CLASS_STATUS_NAME, body.classStatus)}`,
        beforeValue: { classStatus: exists.class_status },
        afterValue: { classStatus: body.classStatus },
      });
    }

    res.json(ok(null, '修改成功'));
  }),
);

/* ============================================================
 * 5. 删除班级（逻辑删除）
 *   DELETE /api/class/classInfo/delete/:id
 * ============================================================ */

classInfoRouter.delete(
  '/delete/:id',
  checkPermission('class:classInfo:delete'),
  wrap(async (req, res) => {
    const { id } = req.params;
    const exists = await db(TABLE).where({ id, is_deleted: false }).first();
    if (!exists) throw new BizError(BizCode.CLASS_NOT_FOUND, '班级不存在或已被删除');

    await db(TABLE).where({ id }).update({
      is_deleted: true,
      update_time: new Date(),
      update_by: req.user?.userId || 'system',
    });

    res.json(ok(null, '删除成功'));
  }),
);

/* ============================================================
 * 6. 班级下拉选项（转班/复学/末班用）
 *   GET /api/class/classInfo/options?stage=&excludeGraduated=true
 * ============================================================ */

classInfoRouter.get(
  '/options',
  checkPermission('class:classInfo:view'),
  validate(
    z.object({
      stage: z.coerce.number().int().optional(),
      excludeGraduated: z.coerce.boolean().default(true),
    }),
  ),
  wrap(async (req, res) => {
    const q = (req as any).validated as { stage?: number; excludeGraduated: boolean };

    const query = db(TABLE).where('is_deleted', false);
    if (q.stage) query.andWhere('stage', q.stage);
    if (q.excludeGraduated) query.whereNot('class_status', ClassStatus.GRADUATED);

    const rows = await query.select('*').orderBy('class_name', 'asc');
    res.json(ok(rows.map(toClassInfo)));
  }),
);

export default classInfoRouter;
