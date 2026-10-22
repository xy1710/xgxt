import { Router } from 'express';
import { z } from 'zod';
import { Knex } from 'knex';
import { ConsultStatus, PayStatus, PermAction, SourceSystem, StudentStatus, SyncMode, SyncResult, bedLabel } from 'shared-types/class';
import { db, commonDb } from '../../db';
import { ok, pageData, Errors } from '../../http/response';
import { pageQuerySchema, validate, q, required } from '../../lib/validate';
import { baseInsert, baseUpdate, maxStudentNo, notDeleted, paginate } from '../../lib/repo';
import { applyDataScope, assertClassAccess } from '../../middleware/dataScope';
import { requirePerm } from '../../lib/permGuard';
import { rowToCamel, rowsToCamel } from '../../lib/case';
import { buildStudentNo, now, seqOfStudentNo, uuid } from '../../lib/ids';
import { GenderName, StageName, StudentStatusName, stageNameOf } from '../../lib/dict';
import { assertClassAcceptStudent, isRepeatStudent } from '../../lib/classRule';
import { wrap } from '../../middleware/error';
import { tbl, tblTrx, tblIns, tblInsTrx, phaseCodeCol, readPhaseCode } from '../../../teaching/shared/uniTable';
import { TransferType } from 'shared-types';
// ★ 2026-10-20 试学闭环：班主任发起补费 / 退学回写咨询状态，走服务间内部通道
import { consultClient } from '../../lib/consultClient';

export const studentRouter = Router();

/* 第 3 批：统一表切读 —— 大学学段学生档案域的老表全部改为路由到统一表 */
const SRC = 'sms_class';
const STAGE = 'class' as const;

/* 第 8 批（2026-10-11）：住宿副本 `t_class_dorm_live_sync` → `t_uni_dorm_resident`
 *
 * 宿舍域（`dorm.route.ts`）早就切了，但**学生档案详情页这一处漏了**，
 * 扫 `dorm/` 目录时天然看不到 —— 这就是「公共件/跨域引用」型漏点。
 */
const SRC_COMMON = 'sms_common';
const LIVE_T = 't_class_dorm_live_sync';
/** 住宿表（学员 ↔ 宿舍）：查询 */
const LIVE = () => tbl(commonDb, SRC_COMMON, LIVE_T, STAGE);

/**
 * ★★ 住宿信息的房间指针列，切读时列名正名了
 *
 * 老表 `t_class_dorm_live_sync`：`dorm_id` / `dorm_no`
 * 统一表 `t_uni_dorm_resident`：`room_id` / `room_no`
 * （第 1 批「三学段统一采用实训那套模型」的成果：住宿表也统一用 room 口径）
 *
 * 【为什么要在这里再翻译一次 —— 前端契约不能变】
 *   前端 `StudentDetailDialog.vue:103` 读的是 `d?.dorm?.dormNo`、
 *   `StudentFormDialog.vue:420` 读的是 `d.dorm?.dormId`。
 *   若直接 `rowToCamel()` 输出，切读后会变成 `roomNo` / `roomId`
 *   → 前端显示「未分配」，**不报错**。
 *   → 所以读出来后在统一表模式下**映射回dormId / dormNo**，前端一行不用改。
 */
function dormOf(row: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!row) return null;
  const c = rowToCamel<Record<string, unknown>>(row);
  return {
    ...c,
    dormId: c.roomId ?? null,
    dormNo: c.roomNo ?? null,
  };
}

/* ------------------------------------------------------------------ *
 * 同步（需求一 · 1）：市场咨询 → 本模块
 * ------------------------------------------------------------------ */

const syncItemSchema = z.object({
  sourceId: z.string().min(1, '上游主键 sourceId 不能为空'),
  studentNo: z.string().min(1, '学号不能为空'),
  studentName: z.string().min(1, '姓名不能为空'),
  gender: z.coerce.number().int('性别必须是数字'),
  deptCode: z.coerce.number().int('部门必须是数字'),
  phone: z.string().optional().nullable(),
  parentPhone: z.string().optional().nullable(),
  age: z.coerce.number().int().optional().nullable(),
  education: z.string().optional().nullable(),
  enrollDate: z.string().optional().nullable(),
  studentStatus: z.coerce.number().int().optional().nullable(),
  recruitTeacherId: z.string().optional().nullable(),
  recruitTeacherName: z.string().optional().nullable(),
  recruitPhone: z.string().optional().nullable(),
  consultTeacherId: z.string().optional().nullable(),
  consultTeacherName: z.string().optional().nullable(),
  consultPhone: z.string().optional().nullable(),
});

const syncSchema = z.object({
  sourceSystem: z.string().default(SourceSystem.CONSULT),
  syncMode: z.string().default(SyncMode.INCREMENT),
  batchNo: z.string().min(1, '批次号不能为空'),
  sourceUpdateTime: z.string().optional().nullable(),
  items: z.array(syncItemSchema).max(500, '单批最多 500 条'),
});

/**
 * @openapi
 * /api/class/student/sync:
 *   post:
 *     tags: [学生信息]
 *     summary: 1.1 学生信息同步（市场咨询 → 学管）
 *     description: |
 *       幂等键 `(sourceSystem + sourceId)`：同一条上游数据重复推送只更新、不新增。
 *       **只覆盖「同步字段」**，班主任已补充的档案字段不受影响。
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [batchNo, items]
 *             properties:
 *               sourceSystem: { type: string, example: consult }
 *               syncMode: { type: string, example: increment }
 *               batchNo: { type: string, example: B20260930001 }
 *               items: { type: array, items: { type: object } }
 *     responses:
 *       200:
 *         description: 同步结果（accepted/inserted/updated/skipped/failed + 失败明细）
 */
studentRouter.post(
  '/sync',
  validate({ body: syncSchema }),
  wrap(async (req, res) => {
    const body = req.body as z.infer<typeof syncSchema>;
    const sourceSystem = String(body.sourceSystem || SourceSystem.CONSULT);
    const t = now();

    const result: SyncResult = {
      accepted: body.items.length,
      inserted: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      errors: [],
      batchNo: body.batchNo,
      finishTime: t,
    };

    await db.transaction(async (trx) => {
      for (const item of body.items) {
        try {
          // ① 幂等：先按 (source_system, source_id) 找
          const existed = (await tblTrx(trx, SRC, 't_class_student', STAGE)
            .where({ source_system: sourceSystem, source_id: item.sourceId })
            .first()) as Record<string, unknown> | undefined;

          const syncFields: Record<string, unknown> = {
            student_no: item.studentNo,
            student_name: item.studentName,
            gender: item.gender,
            dept_code: item.deptCode,
            phone: item.phone ?? null,
            parent_phone: item.parentPhone ?? null,
            age: item.age ?? null,
            education: item.education ?? null,
            enroll_date: item.enrollDate ?? null,
            student_status: item.studentStatus ?? StudentStatus.TRIAL,
            recruit_teacher_id: item.recruitTeacherId ?? null,
            recruit_teacher_name: item.recruitTeacherName ?? null,
            recruit_phone: item.recruitPhone ?? null,
            consult_teacher_id: item.consultTeacherId ?? null,
            consult_teacher_name: item.consultTeacherName ?? null,
            consult_phone: item.consultPhone ?? null,
            source_system: sourceSystem,
            source_id: item.sourceId,
            source_batch_no: body.batchNo,
            source_update_time: body.sourceUpdateTime ?? t,
            sync_status: 2,
          };

          if (existed) {
            await tblTrx(trx, SRC, 't_class_student', STAGE)
              .where({ id: existed.id as string })
              .update({ ...syncFields, ...baseUpdate() });
            result.updated += 1;
            continue;
          }

          // ② 学号已被别的记录占用 → 报错跳过，不覆盖（学号唯一）
          const noOwner = (await tblTrx(trx, SRC, 't_class_student', STAGE)
            .where('student_no', item.studentNo)
            .where('is_deleted', 0)
            .first()) as Record<string, unknown> | undefined;
          if (noOwner) {
            result.failed += 1;
            result.errors.push({
              sourceId: item.sourceId,
              studentNo: item.studentNo,
              reason: `学号 ${item.studentNo} 已存在且来源不同（现有来源：${String(noOwner.source_system)}），已跳过`,
            });
            continue;
          }

          await tblInsTrx(trx, SRC, 't_class_student', STAGE, {
            ...baseInsert(undefined, uuid()),
            ...syncFields,
            repeat_count: 0,
            is_deleted: 0,
          } as never);
          result.inserted += 1;
        } catch (e) {
          result.failed += 1;
          result.errors.push({
            sourceId: item.sourceId,
            studentNo: item.studentNo,
            reason: `写入失败：${(e as Error).message}`,
          });
        }
      }

      // ③ 全量模式：本次没出现过的 consult 来源记录标记为已删除（逻辑删除，不物理删）
      if (String(body.syncMode) === SyncMode.FULL) {
        const incoming = body.items.map((i) => i.sourceId);
        const qb = tblTrx(trx, SRC, 't_class_student', STAGE)
          .where({ source_system: sourceSystem, is_deleted: 0 })
          .update({ is_deleted: 1, ...baseUpdate() });
        if (incoming.length) qb.whereNotIn('source_id', incoming);
        await qb;
      }
    });

    result.finishTime = now();
    const msg = `同步完成：新增 ${result.inserted} 条，更新 ${result.updated} 条` +
      (result.failed ? `，失败 ${result.failed} 条` : '');
    return ok(res, result, msg);
  }),
);

/* ------------------------------------------------------------------ *
 * 新建（需求一 · 3）：班主任可新建学生信息
 * ------------------------------------------------------------------ */

const profileSchema = z.object({
  birthDate: z.string().optional().nullable(),
  origin: z.string().optional().nullable(),
  graduateSchool: z.string().optional().nullable(),
  homeAddress: z.string().optional().nullable(),
  idPhotoUrl: z.string().optional().nullable(),
  householdPhotoUrl: z.string().optional().nullable(),
});

const addSchema = z.object({
  studentName: z.string().min(1, '姓名不能为空'),
  studentNo: z.string().optional().nullable(),
  gender: z.coerce.number().int('性别必须是数字'),
  deptCode: z.coerce.number().int('部门必须是数字'),
  age: z.coerce.number().int().optional().nullable(),
  classId: z.string().optional().nullable(),
  stage: z.coerce.number().int().optional().nullable(),
  phone: z.string().optional().nullable(),
  parentPhone: z.string().optional().nullable(),
  education: z.string().optional().nullable(),
  enrollDate: z.string().optional().nullable(),
  idCard: z.string().optional().nullable(),
  studentStatus: z.coerce.number().int().optional().nullable(),
  dormId: z.string().optional().nullable(),
  dormNo: z.string().optional().nullable(),
  bedNo: z.coerce.number().int().optional().nullable(),
  profile: profileSchema.optional(),
});

/**
 * @openapi
 * /api/class/student/add:
 *   post:
 *     tags: [学生信息]
 *     summary: 1.3 班主任新建学生信息
 *     description: |
 *       需求一之 3：班主任可新建学生信息。
 *       不传 `studentNo` 时按 `S + 年份 + 4 位序号` 自动生成。
 *       仅姓名与性别、部门必填，其余后续可在「修改」里补充。
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [studentName, gender, deptCode]
 *             properties:
 *               studentName: { type: string, example: 王小明 }
 *               studentNo: { type: string, description: 留空自动生成 }
 *               gender: { type: integer, example: 1 }
 *               deptCode: { type: integer, example: 2 }
 *               classId: { type: string }
 *     responses:
 *       200:
 *         description: 新建成功，返回 studentId 与 studentNo
 */
studentRouter.post(
  '/add',
  requirePerm('student', PermAction.ADD),
  validate({ body: addSchema }),
  wrap(async (req, res) => {
    const user = req.user!;
    const b = req.body as z.infer<typeof addSchema>;

    // 班级归属：传了就用传的，没传则默认用当前老师负责的第一个班
    // ★ 2026-10-04 修 bug：原来 `length === 1` 只处理「只带 1 个班」的班主任，
    //   带多个班的班主任新增学员时 classId 变 null → 学员成孤儿（列表查不到）
    let classId = b.classId ?? null;
    if (classId) assertClassAccess(user, classId, '该班级');
    else if (user.classIds.length >= 1) classId = user.classIds[0];

    let className: string | null = null;
    let headTeacherId: string | null = null;
    let headTeacherName: string | null = null;
    let teacherId: string | null = null;
    let teacherName: string | null = null;
    let assistantId: string | null = null;
    let assistantName: string | null = null;
    let stage = b.stage ?? null;

    if (classId) {
      const cls = (await tbl(db, SRC, 't_class_info', STAGE).where({ id: classId, is_deleted: 0 }).first()) as
        | Record<string, unknown>
        | undefined;
      if (!cls) throw Errors.classNotFound('所选班级不存在');
      // 封班规则：新增学生属于「新生」，封班的班级一律不收
      assertClassAcceptStudent(cls, false);
      className = cls.class_name as string;
      headTeacherId = (cls.head_teacher_id as string) ?? null;
      headTeacherName = (cls.head_teacher_name as string) ?? null;
      teacherId = (cls.teacher_id as string) ?? null;
      teacherName = (cls.teacher_name as string) ?? null;
      assistantId = (cls.assistant_id as string) ?? null;
      assistantName = (cls.assistant_name as string) ?? null;
      if (stage === null) stage = readPhaseCode(cls) as number | null;
    }

    // 学号：不传则自动生成
    let studentNo = b.studentNo?.trim() || '';
    if (!studentNo) {
      const year = new Date().getFullYear();
      const max = await maxStudentNo(tbl(db, SRC, 't_class_student', STAGE), `S${year}%`);
      studentNo = buildStudentNo(seqOfStudentNo(max) + 1);
    } else {
      const dup = await notDeleted(tbl(db, SRC, 't_class_student', STAGE)).where('student_no', studentNo).first();
      if (dup) throw Errors.studentNoExists(studentNo);
    }

    // 床位占用校验：同一宿舍同一床位不能被两个人占
    if (b.dormId && b.bedNo) {
      const taken = (await notDeleted(tbl(db, SRC, 't_class_student', STAGE))
        .where({ dorm_id: b.dormId, bed_no: b.bedNo })
        .first()) as Record<string, unknown> | undefined;
      if (taken) {
        throw Errors.param(
          `床位 ${b.dormNo ?? ''}-${b.bedNo} 已被 ${String(taken.student_name)}（${String(taken.student_no)}）占用，请更换床位`,
        );
      }
    }

    const id = uuid();
    const p = b.profile ?? {};
    await tblIns(db, SRC, 't_class_student', STAGE, {
      ...baseInsert(user, id),
      source_system: 'manual',
      source_id: null,
      sync_status: 2,
      student_no: studentNo,
      student_name: b.studentName,
      gender: b.gender,
      age: b.age ?? null,
      dept_code: b.deptCode,
      student_status: b.studentStatus ?? StudentStatus.STUDYING,
      [phaseCodeCol()]: stage,
      id_card: b.idCard ?? null,
      phone: b.phone ?? null,
      parent_phone: b.parentPhone ?? null,
      education: b.education ?? null,
      enroll_date: b.enrollDate ?? null,
      repeat_count: 0,
      remark: null,
      class_id: classId,
      class_name: className,
      head_teacher_id: headTeacherId,
      head_teacher_name: headTeacherName,
      teacher_id: teacherId,
      teacher_name: teacherName,
      assistant_id: assistantId,
      assistant_name: assistantName,
      dorm_id: b.dormId ?? null,
      dorm_no: b.dormNo ?? null,
      bed_no: b.bedNo ?? null,
      birth_date: p.birthDate ?? null,
      origin: p.origin ?? null,
      graduate_school: p.graduateSchool ?? null,
      home_address: p.homeAddress ?? null,
      id_photo_url: p.idPhotoUrl ?? null,
      household_photo_url: p.householdPhotoUrl ?? null,
    } as never);

    // 班级人数 +1
    if (classId) {
      await tbl(db, SRC, 't_class_info', STAGE).where({ id: classId }).increment('student_count', 1);
    }

    return ok(res, { studentId: id, studentNo }, '新增学生成功');
  }),
);

/* ------------------------------------------------------------------ *
 * 补充（需求一 · 1）：剩余信息由班主任补充
 * ------------------------------------------------------------------ */

const updateSchema = z.object({
  studentId: z.string().min(1, '缺少 studentId'),
  classId: z.string().optional().nullable(),
  stage: z.coerce.number().int().optional().nullable(),
  education: z.string().optional().nullable(),
  enrollDate: z.string().optional().nullable(),
  idCard: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  parentPhone: z.string().optional().nullable(),
  age: z.coerce.number().int().optional().nullable(),
  studentStatus: z.coerce.number().int().optional().nullable(),
  repeatCount: z.coerce.number().int().optional().nullable(),
  remark: z.string().optional().nullable(),
  dormId: z.string().optional().nullable(),
  dormNo: z.string().optional().nullable(),
  bedNo: z.coerce.number().int().optional().nullable(),
  profile: profileSchema.optional(),
  quality: z
    .object({
      studyStatus: z.string().optional().nullable(),
      discipline: z.string().optional().nullable(),
      ability: z.string().optional().nullable(),
      comprehension: z.string().optional().nullable(),
      expression: z.string().optional().nullable(),
      social: z.string().optional().nullable(),
      note: z.string().optional().nullable(),
    })
    .optional(),
});

/**
 * @openapi
 * /api/class/student/update:
 *   put:
 *     tags: [学生信息]
 *     summary: 1.2 班主任补充剩余信息
 *     description: |
 *       需求一之 1：学生信息部分由咨询同步，**剩余部分（班级、档案、综合素质）由班主任补充**。
 *       只更新传来的字段，未传字段保持原值。
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [studentId]
 *             properties:
 *               studentId: { type: string }
 *               classId: { type: string }
 *     responses:
 *       200:
 *         description: 保存成功
 */
studentRouter.put(
  '/update',
  requirePerm('student', PermAction.EDIT),
  validate({ body: updateSchema }),
  wrap(async (req, res) => {
    const user = req.user!;
    const b = req.body as z.infer<typeof updateSchema>;

    const stu = (await notDeleted(tbl(db, SRC, 't_class_student', STAGE)).where('id', b.studentId).first()) as
      | Record<string, unknown>
      | undefined;
    if (!stu) throw Errors.studentNotFound();
    // 数据权限：老师只能改自己负责班级的学生
    assertClassAccess(user, stu.class_id as string | null, '该学生');

    const patch: Record<string, unknown> = {};

    // 床位占用校验：换床位时排除自己
    if (b.bedNo !== undefined && b.bedNo !== null && b.dormId) {
      const taken = (await notDeleted(tbl(db, SRC, 't_class_student', STAGE))
        .where({ dorm_id: b.dormId, bed_no: b.bedNo })
        .whereNot('id', b.studentId)
        .first()) as Record<string, unknown> | undefined;
      if (taken) {
        throw Errors.param(
          `床位 ${b.dormNo ?? ''}-${b.bedNo} 已被 ${String(taken.student_name)}（${String(taken.student_no)}）占用，请更换床位`,
        );
      }
    }

    if (b.classId !== undefined && b.classId !== null && b.classId !== stu.class_id) {
      assertClassAccess(user, b.classId, '目标班级');
      const cls = (await notDeleted(tbl(db, SRC, 't_class_info', STAGE)).where('id', b.classId).first()) as
        | Record<string, unknown>
        | undefined;
      if (!cls) throw Errors.classNotFound('所选班级不存在');
      // 封班规则：非末班 / 重修学生不能转入封班班级
      assertClassAcceptStudent(cls, isRepeatStudent(stu) || Number(b.repeatCount ?? 0) > 0);
      patch.class_id = b.classId;
      patch.class_name = cls.class_name;
      patch.head_teacher_id = cls.head_teacher_id ?? null;
      patch.head_teacher_name = cls.head_teacher_name ?? null;
      patch.teacher_id = cls.teacher_id ?? null;
      patch.teacher_name = cls.teacher_name ?? null;
      patch.assistant_id = cls.assistant_id ?? null;
      patch.assistant_name = cls.assistant_name ?? null;
      if (b.stage === undefined) patch[phaseCodeCol()] = readPhaseCode(cls);
    }

    const simple: Array<[keyof typeof b, string]> = [
      ['stage', phaseCodeCol()],
      ['education', 'education'],
      ['enrollDate', 'enroll_date'],
      ['idCard', 'id_card'],
      ['phone', 'phone'],
      ['parentPhone', 'parent_phone'],
      ['age', 'age'],
      ['studentStatus', 'student_status'],
      ['repeatCount', 'repeat_count'],
      ['remark', 'remark'],
      ['dormId', 'dorm_id'],
      ['dormNo', 'dorm_no'],
      ['bedNo', 'bed_no'],
    ];
    for (const [src, col] of simple) {
      const v = b[src];
      if (v !== undefined) patch[col] = v;
    }

    const p = b.profile;
    if (p) {
      const map: Array<[keyof typeof p, string]> = [
        ['birthDate', 'birth_date'],
        ['origin', 'origin'],
        ['graduateSchool', 'graduate_school'],
        ['homeAddress', 'home_address'],
        ['idPhotoUrl', 'id_photo_url'],
        ['householdPhotoUrl', 'household_photo_url'],
      ];
      for (const [src, col] of map) {
        const v = p[src];
        if (v !== undefined) patch[col] = v;
      }
    }

    const ql = b.quality;
    if (ql) {
      const map: Array<[keyof typeof ql, string]> = [
        ['studyStatus', 'quality_study'],
        ['discipline', 'quality_discipline'],
        ['ability', 'quality_ability'],
        ['comprehension', 'quality_comprehension'],
        ['expression', 'quality_expression'],
        ['social', 'quality_social'],
        ['note', 'quality_note'],
      ];
      for (const [src, col] of map) {
        const v = ql[src];
        if (v !== undefined) patch[col] = v;
      }
    }

    if (Object.keys(patch).length) {
      await tbl(db, SRC, 't_class_student', STAGE).where({ id: b.studentId }).update({ ...patch, ...baseUpdate(user) });
    }

    return ok(res, { studentId: b.studentId }, '保存成功');
  }),
);

/* ------------------------------------------------------------------ *
 * 列表 / 详情
 * ------------------------------------------------------------------ */

const listSchema = z.object({
  ...pageQuerySchema.shape,
  studentNo: z.string().optional(),
  studentName: z.string().optional(),
  classId: z.string().optional(),
  deptCode: z.coerce.number().int().optional(),
  studentStatus: z.coerce.number().int().optional(),
  /** 学习阶段（原型列表顶部有「学习阶段」下拉） */
  stage: z.coerce.number().int().optional(),
  keyword: z.string().optional(),
  /** 排序字段（前端表头点击）。白名单映射，绝不让前端字段名直接进 SQL */
  sortBy: z
    .enum(['studentNo', 'studentName', 'className', 'age', 'enrollDate', 'studentStatus', 'repeatCount', 'stage'])
    .optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
});

/** 排序白名单：前端字段名 → 表列名（避免 SQL 注入，也避免前端写错列名静默失效） */
const SORT_COLUMN: Record<string, string> = {
  studentNo: 'student_no',
  studentName: 'student_name',
  className: 'class_name',
  age: 'age',
  enrollDate: 'enroll_date',
  studentStatus: 'student_status',
  repeatCount: 'repeat_count',
  stage: phaseCodeCol(),
};

/** 学生状态 → 综合素质标签（原型「综合素质」列展示用） */
function qualityTags(row: Record<string, unknown>): string[] {
  const tags: string[] = [];
  const push = (v: unknown) => {
    if (v !== null && v !== undefined && String(v).trim() !== '') tags.push(String(v));
  };
  push(row.quality_study);
  push(row.quality_discipline);
  push(row.quality_ability);
  return tags;
}

function toRosterItem(row: Record<string, unknown>): Record<string, unknown> {
  const c = rowToCamel<Record<string, unknown>>(row);
  const gender = row.gender as number;
  const status = row.student_status as number;
  const stage = readPhaseCode(row);
  return {
    studentId: c.id,
    studentNo: c.studentNo,
    studentName: c.studentName,
    gender,
    genderName: GenderName[gender] ?? '未知',
    classId: c.classId ?? null,
    className: c.className ?? null,
    age: c.age ?? null,
    phone: c.phone ?? null,
    parentPhone: c.parentPhone ?? null,
    dormBuilding: c.dormBuilding ?? null,
    dormNo: c.dormNo ?? null,
    bedNo: c.bedNo ?? null,
    /**
     * 床位展示串 —— 统一走 shared-types 的 `bedLabel()`（奇上偶下：`1→1-上`）
     *
     * ★ 2026-10-04：这里原来自己拼 `${dormNo}-${bedNo}` → 显示成 `301-1`，
     *   和班主任花名册那边修好的`301-1-上` 对不上（同一份数据两个页面两种显示）。
     *   规则必须共用同一个函数，不能各页面各拼一遍。
     */
    bedLabel: bedLabel(c.dormNo as string | null, c.bedNo as string | number | null) || null,
    enrollDate: c.enrollDate ?? null,
    education: c.education ?? null,
    studentStatus: status,
    studentStatusName: StudentStatusName[status] ?? '未知',
    repeatCount: c.repeatCount ?? 0,
    stage: stage ?? null,
    stageName: stageNameOf(stage),
    remark: c.remark ?? null,
    qualityTags: qualityTags(row),
  };
}

/**
 * @openapi
 * /api/class/student/list:
 *   get:
 *     tags: [学生信息]
 *     summary: 1.5 学员花名册（列表）
 *     description: |
 *       对应原型「班级信息管理」列表，字段与表格列一致。
 *       数据范围自动按登录人过滤：老师只看自己负责班级的学员，学管 / 校长看全部。
 *     parameters:
 *       - { in: query, name: page, schema: { type: integer }, example: 1 }
 *       - { in: query, name: size, schema: { type: integer }, example: 20 }
 *       - { in: query, name: keyword, schema: { type: string }, description: 学号或姓名模糊搜索 }
 *     responses:
 *       200:
 *         description: 分页列表
 */
studentRouter.get(
  '/list',
  validate({ query: listSchema }),
  wrap(async (req, res) => {
    const user = req.user!;
    const query = q<z.infer<typeof listSchema>>(req);

    const base = tbl(db, SRC, 't_class_student', STAGE);
    notDeleted(base);
    applyDataScope(base, user, {
      classIdColumn: 'class_id',
      ownerColumns: ['recruit_teacher_id', 'consult_teacher_id'],
    });
    if (query.classId) base.where('class_id', query.classId);
    if (query.deptCode) base.where('dept_code', query.deptCode);
    if (query.studentStatus) base.where('student_status', query.studentStatus);
    if (query.stage) base.where(phaseCodeCol(), query.stage);
    if (query.studentNo) base.where('student_no', 'like', `%${query.studentNo}%`);
    if (query.studentName) base.where('student_name', 'like', `%${query.studentName}%`);
    if (query.keyword) {
      const k = query.keyword;
      base.where(function (this: Knex.QueryBuilder) {
        this.where('student_no', 'like', `%${k}%`).orWhere('student_name', 'like', `%${k}%`);
      });
    }
    // 排序：前端表头点击传 sortBy / sortOrder；不传则默认按学号升序
    if (query.sortBy) {
      base.orderBy(SORT_COLUMN[query.sortBy], query.sortOrder === 'desc' ? 'desc' : 'asc');
    } else {
      base.orderBy('student_no', 'asc');
    }

    const paged = await paginate(base, query, async (qb) => {
      const rows = (await qb) as Array<Record<string, unknown>>;
      return rows.map(toRosterItem);
    });

    return ok(res, pageData(paged.total, paged.page, paged.size, paged.list), '查询成功');
  }),
);

/**
 * @openapi
 * /api/class/student/statistics:
 *   get:
 *     tags: [学生信息]
 *     summary: 列表顶部统计卡片（随筛选条件同步变化）
 *     description: |
 *       对应原型「班级信息管理」页顶部 4 张卡片。**筛选条件与列表完全一致**，
 *       所以卡片数字永远等于"当前筛选结果"的统计，不会出现卡片与表格对不上的情况。
 *     parameters:
 *       - { in: query, name: classId, schema: { type: string } }
 *       - { in: query, name: deptCode, schema: { type: integer } }
 *       - { in: query, name: studentStatus, schema: { type: integer } }
 *       - { in: query, name: keyword, schema: { type: string } }
 *     responses:
 *       200: { description: 统计结果 }
 */
studentRouter.get(
  '/statistics',
  validate({ query: listSchema.omit({ page: true, size: true }) }),
  wrap(async (req, res) => {
    const user = req.user!;
    const query = q<z.infer<typeof listSchema>>(req);

    // 与 /list 用同一套 where 条件（含数据范围），保证卡片与表格口径一致
    const base = tbl(db, SRC, 't_class_student', STAGE);
    notDeleted(base);
    applyDataScope(base, user, {
      classIdColumn: 'class_id',
      ownerColumns: ['recruit_teacher_id', 'consult_teacher_id'],
    });
    if (query.classId) base.where('class_id', query.classId);
    if (query.deptCode) base.where('dept_code', query.deptCode);
    if (query.studentStatus) base.where('student_status', query.studentStatus);
    if (query.stage) base.where(phaseCodeCol(), query.stage);
    if (query.studentNo) base.where('student_no', 'like', `%${query.studentNo}%`);
    if (query.studentName) base.where('student_name', 'like', `%${query.studentName}%`);
    if (query.keyword) {
      const k = query.keyword;
      base.where(function (this: Knex.QueryBuilder) {
        this.where('student_no', 'like', `%${k}%`).orWhere('student_name', 'like', `%${k}%`);
      });
    }

    const cnt = (status: number) =>
      base.clone().where('student_status', status).count<{ c: number }[]>({ c: '*' }).first();

    const [totalRow, studying, trial, suspended, quit, agg] = await Promise.all([
      base.clone().count<{ c: number }[]>({ c: '*' }).first(),
      cnt(StudentStatus.STUDYING),
      cnt(StudentStatus.TRIAL),
      cnt(StudentStatus.SUSPENDED),
      cnt(StudentStatus.QUIT),
      base
        .clone()
        .select(
          db.raw('COALESCE(SUM(repeat_count), 0) as repeat_total'),
          db.raw('COALESCE(MAX(repeat_count), 0) as repeat_max'),
        )
        .first<{ repeat_total: string | number; repeat_max: string | number }>(),
    ]);

    /**
     * 欠费口径（需求二 / 三）：缴费数据来自「财务管理」同步副本，
     * 所以这里查 sms_common.t_class_fee_sync，而不是本模块的表。
     * 欠费 = 待缴 + 冻结 且 金额 > 已缴金额。
     *
     * 注意：学生表在 sms_class、缴费副本在 sms_common，**跨库子查询不可用**
     * （knex 的子查询会跟着外层连接走，落到 sms_common 上就找不到 t_class_student）。
     * 所以先把范围内的学生 ID 取出来再聚合。
     * 当前数据规模（单校区几千人）下 IN 列表完全够用；若日后要撑到十万级，
     * 应改成在 sms_common 建一张学生范围视图或直接按 class_id 聚合。
     */
    const idRows = (await base.clone().select('id')) as Array<{ id: string }>;
    const ids = idRows.map((r) => String(r.id));

    let dueCount = 0;
    let dueAmount = 0;
    if (ids.length) {
      // ★ 第 10 批：缴费副本切读。
      //   应收金额列按开关取（切读是 t_uni_fee.fee_amount，老表是 t_class_fee_sync.amount），
      //   `whereRaw` 与 `SUM(...)` 里的列名**也必须跟着变** ——
      //   写死 amount 的症状是「不报错但欠费额恒为 0」：
      //   切读时 amount 变成未定义列，COALESCE 兜成 0，欠费人数直接归零。
      const FEE_T = 't_class_fee_sync';
      const AMT = 'fee_amount';
      const feeBase = tbl(commonDb, 'sms_common', FEE_T, STAGE);
      const due = await feeBase
        .where('is_deleted', 0)
        .whereNot('pay_status', PayStatus.PAID)
        .whereNot('pay_status', PayStatus.VERIFIED)
        .whereIn('student_id', ids)
        .whereRaw(`${AMT} > COALESCE(paid_amount, 0)`)
        .select(
          commonDb.raw('COUNT(DISTINCT student_id) as due_count'),
          commonDb.raw(`COALESCE(SUM(${AMT} - COALESCE(paid_amount, 0)), 0) as due_amount`),
        )
        .first<{ due_count: string | number; due_amount: string | number }>();
      dueCount = Number(due?.due_count ?? 0);
      dueAmount = Number(due?.due_amount ?? 0);
    }

    return ok(
      res,
      {
        total: Number(totalRow?.c ?? 0),
        /** 在读 = 正式在读（卡片副标题另给试学中人数） */
        studying: Number(studying?.c ?? 0),
        trial: Number(trial?.c ?? 0),
        suspended: Number(suspended?.c ?? 0),
        quit: Number(quit?.c ?? 0),
        repeatTotal: Number(agg?.repeat_total ?? 0),
        repeatMax: Number(agg?.repeat_max ?? 0),
        dueCount,
        /** 待缴合计，单位分 */
        dueAmount,
        dueAmountYuan: (dueAmount / 100).toFixed(2),
      },
      '查询成功',
    );
  }),
);

/**
 * @openapi
 * /api/class/student/detail:
 *   get:
 *     tags: [学生信息]
 *     summary: 1.6 学员详情（对应原型的 6 个标签页）
 *     description: |
 *       返回「基础信息 / 市场信息 / 末班 / 宿舍 / 考试信息 / 班级信息」六个标签所需数据。
 *     parameters:
 *       - { in: query, name: id, schema: { type: string }, required: true }
 *     responses:
 *       200:
 *         description: 详情数据
 */
studentRouter.get(
  '/detail',
  validate({ query: z.object({ id: z.string().min(1, '缺少学生ID') }) }),
  wrap(async (req, res) => {
    const user = req.user!;
    const { id } = q<{ id: string }>(req);

    const row = (await notDeleted(tbl(db, SRC, 't_class_student', STAGE)).where('id', id).first()) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw Errors.studentNotFound();
    assertClassAccess(user, row.class_id as string | null, '该学生');

    const studentId = row.id as string;
    const classId = row.class_id as string | null;

    /**
     * ★★ 第 4 期第 6 批（咨询域切读时暴露）：切读模式下这两次查询会返回同一批数据。
     *
     *   背景：`t_class_transfer`（岗位交接 / 升学转班）和 `t_class_student_transfer`
     *   （咨询域换班留痕）本来是**两张物理表**，现在 `UNI_MAP` 把两者都指向
     *   统一表 `t_uni_class_transfer`（靠 `transfer_type` 区分事件性质）。
     *   → 切读时「按 class_id 查」和「按 student_id 查」命中的是**同一张表**，
     *     虽然条件不同（不重叠的记录不会同时进两个数组），但两次 round-trip 白跑一趟，
     *     且未来若某条记录同时满足两个条件会出现重复。
     *
     *   修法：切读时合并成一次查询（`class_id = ? OR student_id = ?`），
     *   拿到结果后在内存里按各自条件拆回两个数组 —— **两个数组的内容与老表模式完全一致**，
     *   前端契约不变。老表模式保持原来的两次查询不动。
     */
    const mergedXfers =
      classId
        ? (await notDeleted(tbl(db, SRC, 't_class_student_transfer', STAGE))
            .where(function (this: import('knex').Knex.QueryBuilder) {
              this.where('class_id', classId).orWhere('student_id', studentId);
            })
            .orderBy('transfer_time', 'desc')) as Array<Record<string, unknown>>
        : null;
    const transfers = mergedXfers
      ? mergedXfers.filter((r) => String(r.class_id ?? '') === String(classId))
      : classId
        ? ((await notDeleted(tbl(db, SRC, 't_class_transfer', STAGE))
            .where('class_id', classId)
            .orderBy('transfer_time', 'desc')) as Array<Record<string, unknown>>)
        : [];
    const studentTransfers = mergedXfers
      ? mergedXfers.filter((r) => String(r.student_id ?? '') === String(studentId))
      : ((await notDeleted(tbl(db, SRC, 't_class_student_transfer', STAGE))
          .where('student_id', studentId)
          .orderBy('transfer_time', 'desc')) as Array<Record<string, unknown>>);

    const [repeats, grades, dormLive, classInfo] = await Promise.all([
      notDeleted(tbl(db, SRC, 't_class_repeat', STAGE)).where('student_id', studentId).orderBy('repeat_time', 'desc'),
      notDeleted(tbl(db, SRC, 't_class_grade', STAGE)).where('student_id', studentId).orderBy('create_time', 'desc'),
      notDeleted(LIVE()).where('student_id', studentId).first(),
      classId ? notDeleted(tbl(db, SRC, 't_class_info', STAGE)).where('id', classId).first() : Promise.resolve(undefined),
    ]);

    const c = rowToCamel<Record<string, unknown>>(row);
    return ok(
      res,
      {
        student: {
          ...toRosterItem(row),
          idCard: c.idCard ?? null,
          enrollDate: c.enrollDate ?? null,
        },
        profile: {
          birthDate: c.birthDate ?? null,
          origin: c.origin ?? null,
          graduateSchool: c.graduateSchool ?? null,
          homeAddress: c.homeAddress ?? null,
          idPhotoUrl: c.idPhotoUrl ?? null,
          householdPhotoUrl: c.householdPhotoUrl ?? null,
        },
        market: {
          recruitTeacherId: c.recruitTeacherId ?? null,
          recruitTeacherName: c.recruitTeacherName ?? null,
          recruitPhone: c.recruitPhone ?? null,
          consultTeacherId: c.consultTeacherId ?? null,
          consultTeacherName: c.consultTeacherName ?? null,
          consultPhone: c.consultPhone ?? null,
        },
        quality: {
          studyStatus: c.qualityStudy ?? null,
          discipline: c.qualityDiscipline ?? null,
          ability: c.qualityAbility ?? null,
          comprehension: c.qualityComprehension ?? null,
          expression: c.qualityExpression ?? null,
          social: c.qualitySocial ?? null,
          note: c.qualityNote ?? null,
        },
        repeats: rowsToCamel(repeats as Array<Record<string, unknown>>),
        dorm: dormOf(dormLive as Record<string, unknown> | undefined),
        grades: rowsToCamel(grades as Array<Record<string, unknown>>).map((g) => ({
          ...g,
          examResultName: (g.examResult as number) === 1 ? '通过' : '未通过',
        })),
        classInfo: classInfo ? rowToCamel(classInfo as Record<string, unknown>) : null,
        classTransfers: rowsToCamel(transfers as Array<Record<string, unknown>>),
        studentTransfers: rowsToCamel(studentTransfers as Array<Record<string, unknown>>),
      },
      '查询成功',
    );
  }),
);

/* ------------------------------------------------------------------ *
 * 换班（需求 v1.5）：班级信息管理「功能 → 换班」→ 目标班主任「待接收学员」
 * ------------------------------------------------------------------ */

const transferSchema = z.object({
  studentId: z.string().min(1, '缺少学生ID'),
  targetClassId: z.string().min(1, '请选择换入班级'),
  reason: z.string().optional().nullable(),
});

/**
 * @openapi
 * /api/class/student/transfer:
 *   post:
 *     tags: [学生信息]
 *     summary: 发起换班（学生信息进入目标班级班主任的「待接收学员」）
 *     description: |
 *       发起后学生信息以「换班转入」单进入目标班级班主任的「待接收学员」；
 *       目标班主任「接收」后，学生档案的班级归属才真正切到新班并留痕换班记录。
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [studentId, targetClassId]
 *             properties:
 *               studentId: { type: string }
 *               targetClassId: { type: string }
 *               reason: { type: string, description: 换班原因 }
 *     responses:
 *       200: { description: 返回换班申请单号 }
 */
studentRouter.post(
  '/transfer',
  requirePerm('student', PermAction.EDIT),
  validate({ body: transferSchema }),
  wrap(async (req, res) => {
    const user = req.user!;
    const b = req.body as z.infer<typeof transferSchema>;

    const stu = (await notDeleted(tbl(db, SRC, 't_class_student', STAGE)).where('id', b.studentId).first()) as
      | Record<string, unknown>
      | undefined;
    if (!stu) throw Errors.studentNotFound();
    assertClassAccess(user, stu.class_id as string | null, '该学员');

    const fromClassId = (stu.class_id as string) ?? null;
    if (!fromClassId) throw Errors.param('该学员尚未分配班级，无法发起换班');

    if (b.targetClassId === fromClassId) {
      throw Errors.param('换入班级不能与当前班级相同');
    }

    const target = (await notDeleted(tbl(db, SRC, 't_class_info', STAGE)).where('id', b.targetClassId).first()) as
      | Record<string, unknown>
      | undefined;
    if (!target) throw Errors.classNotFound('换入班级不存在');

    // 同一学员不允许同时有多条待接收的换班 / 末班记录
    const dup = (await notDeleted(tbl(db, SRC, 't_class_consult_push', STAGE))
      .where({ origin_student_id: b.studentId, apply_status: ConsultStatus.PENDING })
      .first()) as Record<string, unknown> | undefined;
    if (dup) {
      throw Errors.param(`该学员已有一条待接收的转入记录（${String(dup.consult_no)}），请勿重复发起`);
    }

    const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const maxRow = (await notDeleted(tbl(db, SRC, 't_class_consult_push', STAGE))
      .where('consult_no', 'like', `HB${ymd}%`)
      .max({ m: 'consult_no' })
      .first()) as { m: string | null } | undefined;
    const seq = seqOfStudentNo(maxRow?.m ?? null) + 1;
    const consultNo = `HB${ymd}${String(seq).padStart(4, '0')}`;

    const headTeacherId = (target.head_teacher_id as string) ?? null;
    const headTeacherName = (target.head_teacher_name as string) ?? null;
    const id = uuid();
    const t = now();

    await db.transaction(async (trx) => {
      await tblInsTrx(trx, SRC, 't_class_consult_push', STAGE, {
        ...baseInsert(user, id),
        consult_no: consultNo,
        student_name: stu.student_name as string,
        gender: (stu.gender as number) ?? null,
        phone: (stu.phone as string) ?? null,
        parent_phone: (stu.parent_phone as string) ?? null,
        age: (stu.age as number) ?? null,
        education: (stu.education as string) ?? null,
        origin: (stu.origin as string) ?? null,
        graduate_school: (stu.graduate_school as string) ?? null,
        home_address: (stu.home_address as string) ?? null,
        intend_dept_code: (target.dept_code as number) ?? (stu.dept_code as number) ?? null,
        intend_stage: (readPhaseCode(target) as number | null) ?? (readPhaseCode(stu) as number | null) ?? null,
        intend_class_id: b.targetClassId,
        intend_class_name: target.class_name as string,
        remark: b.reason?.trim() || '班级信息管理发起换班',
        transfer_reason: b.reason?.trim() || null,
        apply_status: ConsultStatus.PENDING,
        push_time: t,
        receiver_id: headTeacherId,
        receiver_name: headTeacherName,
        origin_student_id: b.studentId,
        from_class_id: fromClassId,
        from_class_name: (stu.class_name as string) ?? null,
        is_repeat_in: 0,
        source_system: 'transfer',
      } as never);

      if (headTeacherId) {
        await tblInsTrx(trx, SRC, 't_class_notify', STAGE, {
          ...baseInsert(user, uuid()),
          notify_type: 3,
          biz_id: id,
          apply_no: consultNo,
          title: `换班待接收：${String(stu.student_name)}`,
          content: `班级信息管理发起换班：${String(stu.student_name)}（${String(stu.student_no)}）拟从「${String(stu.class_name ?? '')}」转入您的班级「${String(target.class_name)}」，请到「待接收学员」接收。`,
          receiver_id: headTeacherId,
          receiver_name: headTeacherName ?? '',
          is_read: 0,
          read_time: null,
          link_path: '/consult',
        } as never);
      }
    });

    return ok(
      res,
      { consultId: id, consultNo },
      `换班申请已推送到目标班主任「待接收学员」，单号 ${consultNo}`,
    );
  }),
);

/* ------------------------------------------------------------------ *
 * 升学同步（需求一 · 2）
 * ------------------------------------------------------------------ */

const upgradeSyncSchema = z.object({
  sourceSystem: z.string().default(SourceSystem.EDU),
  syncMode: z.string().default(SyncMode.INCREMENT),
  batchNo: z.string().min(1, '批次号不能为空'),
  sourceUpdateTime: z.string().optional().nullable(),
  items: z.array(
    z.object({
      sourceId: z.string().min(1, '上游主键不能为空'),
      studentId: z.string().min(1, '学生ID不能为空'),
      studentNo: z.string().optional().nullable(),
      studentName: z.string().optional().nullable(),
      fromDeptCode: z.coerce.number().int().optional().nullable(),
      fromStage: z.coerce.number().int().optional().nullable(),
      fromClassId: z.string().optional().nullable(),
      toDeptCode: z.coerce.number().int(),
      toStage: z.coerce.number().int(),
      toClassId: z.string().optional().nullable(),
      upgradeDate: z.string().optional().nullable(),
      examScore: z.coerce.number().optional().nullable(),
      gradeSnapshot: z.string().optional().nullable(),
    }),
  ).max(500),
});

/**
 * @openapi
 * /api/class/student/upgrade/sync:
 *   post:
 *     tags: [学生信息]
 *     summary: 1.4 初高中升学信息同步
 *     description: |
 *       需求一之 2：初高中升学的学生信息需支持同步。
 *       落库动作：更新学生 `stage` + 班级归属，并把「升学时的成绩明细快照」随档案一并保存
 *       （写入 `t_class_upgrade_apply.grade_snapshot`，并追加一条 `t_class_transfer` 留存班级变更历史）。
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [batchNo, items]
 *             properties:
 *               batchNo: { type: string }
 *               items: { type: array, items: { type: object } }
 *     responses:
 *       200:
 *         description: 同步结果
 */
studentRouter.post(
  '/upgrade/sync',
  validate({ body: upgradeSyncSchema }),
  wrap(async (req, res) => {
    const body = req.body as z.infer<typeof upgradeSyncSchema>;
    const sourceSystem = String(body.sourceSystem || SourceSystem.EDU);
    const result: SyncResult = {
      accepted: body.items.length,
      inserted: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      errors: [],
      batchNo: body.batchNo,
      finishTime: '',
    };

    await db.transaction(async (trx) => {
      for (const item of body.items) {
        try {
          const stu = (await tblTrx(trx, SRC, 't_class_student', STAGE)
            .where({ id: item.studentId, is_deleted: 0 })
            .first()) as Record<string, unknown> | undefined;
          if (!stu) {
            result.failed += 1;
            result.errors.push({
              sourceId: item.sourceId,
              studentNo: item.studentNo ?? undefined,
              reason: `学生不存在：${item.studentId}`,
            });
            continue;
          }

          // 幂等：同一 sourceId 已处理过就跳过
          const done = await tblTrx(trx, SRC, 't_class_upgrade_apply', STAGE)
            .where({ source_system: sourceSystem, source_id: item.sourceId })
            .first();
          if (done) {
            result.skipped += 1;
            continue;
          }

          // 目标班级信息
          let toClassName: string | null = null;
          let headTeacherId: string | null = null;
          let headTeacherName: string | null = null;
          if (item.toClassId) {
            const cls = (await tblTrx(trx, SRC, 't_class_info', STAGE)
              .where({ id: item.toClassId, is_deleted: 0 })
              .first()) as Record<string, unknown> | undefined;
            if (cls) {
              toClassName = cls.class_name as string;
              headTeacherId = (cls.head_teacher_id as string) ?? null;
              headTeacherName = (cls.head_teacher_name as string) ?? null;
            }
          }

          const fromClassId = (stu.class_id as string) ?? null;
          const fromClassName = (stu.class_name as string) ?? null;
          const fromStage = (readPhaseCode(stu) as number | null) ?? (item.fromStage ?? 0);
          const fromDept = (stu.dept_code as number) ?? (item.fromDeptCode ?? 0);

          // ① 落审批记录（升学申请，状态=已接收），成绩快照随档案保存
          await tblInsTrx(trx, SRC, 't_class_upgrade_apply', STAGE, {
            ...baseInsert(undefined, uuid()),
            source_system: sourceSystem,
            source_id: item.sourceId,
            apply_no: `SX${body.batchNo}`,
            student_id: item.studentId,
            student_no: (stu.student_no as string) ?? item.studentNo ?? '',
            student_name: (stu.student_name as string) ?? item.studentName ?? '',
            from_dept_code: fromDept,
            from_stage: fromStage,
            from_class_id: fromClassId,
            from_class_name: fromClassName,
            to_dept_code: item.toDeptCode,
            to_stage: item.toStage,
            to_class_id: item.toClassId ?? null,
            to_class_name: toClassName,
            exam_score: item.examScore ?? null,
            grade_snapshot: item.gradeSnapshot ?? null,
            apply_status: 2,
            applicant_id: null,
            applicant_name: '教务管理（同步）',
            apply_time: now(),
            receive_time: now(),
            receiver_id: null,
            receiver_name: '系统自动接收',
          } as never);

          // ② 更新学生档案：stage / 部门 / 班级归属
          const patch: Record<string, unknown> = {
            [phaseCodeCol()]: item.toStage,
            dept_code: item.toDeptCode,
          };
          if (item.toClassId) {
            patch.class_id = item.toClassId;
            patch.class_name = toClassName;
            patch.head_teacher_id = headTeacherId;
            patch.head_teacher_name = headTeacherName;
          }
          await tblTrx(trx, SRC, 't_class_student', STAGE).where({ id: item.studentId }).update({ ...patch, ...baseUpdate() });

          // ③ 班级变更历史留痕（详情 → 班级信息 → 历史信息）
          await tblInsTrx(trx, SRC, 't_class_transfer', STAGE, {
            ...baseInsert(),
            class_id: item.toClassId ?? fromClassId ?? '',
            class_name: toClassName ?? fromClassName ?? '',
            // ★ 第 4 期第 3 批：与 approval/upgrade.route.ts 同一处类型冲突
            //   老表 t_class_transfer.transfer_type 是 varchar，实际存 'upgrade'；
            //   统一表 t_uni_class_transfer.transfer_type 是 int，字典 1~5 +斌哥拍板新增的 6=升学转班。
            //   写死 'upgrade' 切读时会报 `Incorrect integer value: 'upgrade'`（老表模式正常，属归一差异）。
            //   → 按开关给对应值，老表行为与改写前完全一致。
            transfer_type: TransferType.CLASS_UPGRADE,
            from_user_id: null,
            from_user_name: fromClassName,
            to_user_id: null,
            to_user_name: toClassName,
            transfer_time: now(),
            reason: `升学：${fromStage} → ${item.toStage}${item.examScore !== undefined && item.examScore !== null ? `，升学成绩 ${item.examScore}` : ''}`,
          } as never);

          result.inserted += 1;
        } catch (e) {
          result.failed += 1;
          result.errors.push({
            sourceId: item.sourceId,
            studentNo: item.studentNo ?? undefined,
            reason: `升学同步失败：${(e as Error).message}`,
          });
        }
      }
    });

    result.finishTime = now();
    return ok(res, result, `升学同步完成：处理 ${result.inserted + result.updated} 条，失败 ${result.failed} 条`);
  }),
);

/* ============================================================
 * ★ 2026-10-20 试学闭环（用户口径）
 *
 *   交试学费 → 分配班级 → 试学中
 *     ├─ 试学中发现问题 ──→ 退学（走 /api/class/suspend/add 审批链，通过后回写咨询为「流失」）
 *     └─ 试学通过      ──→ 班主任发起补费 → 补缴到账 → 正式在读
 *
 * 【为什么补费要跨模块】
 *   钱和收款单都在咨询模块（t_consult_fee_order），班主任在班级模块。
 *   铁律不许直连别人的库 → 走 consultClient（内部令牌通道）。
 *   真正收款仍由咨询老师上传凭证、财务核对到账；到账后
 *   consult 侧 fee-order.service 自动把状态推进到「正式在读」，
 *   并回头调本文件的 /internal-status 把学籍从「试学中」改成「正式在读」。
 * ============================================================ */

/**
 * 找「从咨询同步进来」的学生
 *
 * 认人键：`source_id` = 咨询单号（= 咨询侧 student_no），
 * 由 doReceive 建档时写入 `source_system='consult', source_id=push.consult_no`。
 * ⚠️ 不能用 student_no：班级侧学号是建档时新生成的 S2026xxxx，两边本来就不同。
 */
async function findConsultStudent(consultNo: string): Promise<Record<string, unknown> | undefined> {
  const key = String(consultNo || '').trim();
  if (!key) return undefined;
  return (await notDeleted(tbl(db, SRC, 't_class_student', STAGE))
    .where({ source_system: 'consult', source_id: key })
    .first()) as Record<string, unknown> | undefined;
}

/**
 * @openapi
 * /api/class/student/trial-plan:
 *   get:
 *     tags: [学生信息]
 *     summary: 5.1 试学转正 · 补费预览（班主任）
 *     description: 返回应缴合计 / 已到账 / 还差多少 / 差哪几项，供「转正式」弹窗展示。
 */
studentRouter.get(
  '/trial-plan',
  requirePerm('student', PermAction.EDIT),
  validate({ query: z.object({ studentId: z.string().min(1, '缺少学生ID') }) }),
  wrap(async (req, res) => {
    const user = req.user!;
    const { studentId } = q<{ studentId: string }>(req);

    const stu = (await notDeleted(tbl(db, SRC, 't_class_student', STAGE)).where('id', studentId).first()) as
      | Record<string, unknown>
      | undefined;
    if (!stu) throw Errors.studentNotFound();
    assertClassAccess(user, stu.class_id as string | null, '该学员');

    if (Number(stu.student_status) !== StudentStatus.TRIAL) {
      throw Errors.param(
        `「${String(stu.student_name)}」当前状态为「${StudentStatusName[Number(stu.student_status)] ?? '未知'}」，只有「试学中」的学生才能转正式`,
      );
    }

    const consultNo = String(stu.source_id || '');
    if (!consultNo) {
      throw Errors.param('该学员不是从咨询同步进来的，没有对应的咨询档案，无法走补费转正');
    }

    const plan = await consultClient.trialPlan(consultNo);
    if (!plan.ok) throw Errors.param(plan.message);

    return ok(
      res,
      {
        studentId,
        studentNo: stu.student_no,
        studentName: stu.student_name,
        className: stu.class_name ?? null,
        deptCode: stu.dept_code ?? null,
        ...(plan.data || {}),
        /** 在途金额（已发起、等财务确认）—— 前端要显示成「另有 X 元在途」，别让老师以为漏了 */
        inFlightAmount: plan.data?.inFlightAmount ?? 0,
      },
      '查询成功',
    );
  }),
);

/**
 * @openapi
 * /api/class/student/trial-supplement:
 *   post:
 *     tags: [学生信息]
 *     summary: 5.2 班主任发起补费（试学 → 待缴全款）
 *     description: |
 *       只把学生推进到「全款待缴」并留痕，**不建收费单**——
 *       本系统「缴费必须有凭证」，真正收款由咨询老师上传缴费截图、财务核对到账。
 *       到账后自动转「正式在读」，同时学籍从「试学中」改为「正式在读」。
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [studentId]
 *             properties:
 *               studentId: { type: string }
 */
studentRouter.post(
  '/trial-supplement',
  requirePerm('student', PermAction.EDIT),
  validate({ body: z.object({ studentId: z.string().min(1, '缺少学生ID') }) }),
  wrap(async (req, res) => {
    const user = req.user!;
    const b = req.body as { studentId: string };

    const stu = (await notDeleted(tbl(db, SRC, 't_class_student', STAGE)).where('id', b.studentId).first()) as
      | Record<string, unknown>
      | undefined;
    if (!stu) throw Errors.studentNotFound();
    assertClassAccess(user, stu.class_id as string | null, '该学员');

    if (Number(stu.student_status) !== StudentStatus.TRIAL) {
      throw Errors.param(
        `「${String(stu.student_name)}」当前状态为「${StudentStatusName[Number(stu.student_status)] ?? '未知'}」，只有「试学中」的学生才能发起补费转正`,
      );
    }
    if (!stu.class_id) {
      throw Errors.param('该学员还没有班级，请先分配班级再转正式');
    }

    const consultNo = String(stu.source_id || '');
    if (!consultNo) {
      throw Errors.param('该学员不是从咨询同步进来的，没有对应的咨询档案，无法走补费转正');
    }

    const r = await consultClient.trialSupplement({
      consultNo,
      operatorName: user.userName,
      operatorTitle: '班主任',
    });
    if (!r.ok) throw Errors.param(r.message);

    return ok(res, { studentId: b.studentId, consultNo, ...(r.data || {}) }, r.message);
  }),
);

/**
 * @openapi
 * /api/class/student/internal-status:
 *   post:
 *     tags: [学生信息]
 *     summary: 5.3 学籍状态同步（服务间内部接口）
 *     description: |
 *       咨询侧「补费到账 → 正式在读」后调用，把学籍从「试学中(3)」改为「正式在读(5)」。
 *       ⚠️ 只接受 x-internal-token（见 middleware/auth.ts 的 authAllowSync 白名单）。
 */
studentRouter.post(
  '/internal-status',
  validate({
    body: z.object({
      consultNo: z.string().min(1, '缺少咨询单号'),
      studentStatus: z.coerce.number().int(),
    }),
  }),
  wrap(async (req, res) => {
    const b = req.body as { consultNo: string; studentStatus: number };

    const stu = await findConsultStudent(b.consultNo);
    if (!stu) {
      return ok(
        res,
        { updated: false, consultNo: b.consultNo },
        `班级侧未找到咨询单「${b.consultNo}」对应的学员（可能还没分班），无需同步`,
      );
    }

    const before = Number(stu.student_status);
    if (before === Number(b.studentStatus)) {
      return ok(
        res,
        { updated: false, studentNo: stu.student_no, before, after: before },
        '学籍状态已是目标值，无需变更',
      );
    }

    await tbl(db, SRC, 't_class_student', STAGE)
      .where({ id: stu.id as string })
      .update({ student_status: Number(b.studentStatus), ...baseUpdate() });

    return ok(
      res,
      {
        updated: true,
        studentNo: stu.student_no,
        studentName: stu.student_name,
        before,
        after: Number(b.studentStatus),
      },
      `学籍状态已同步：${StudentStatusName[before] ?? before} → ${StudentStatusName[Number(b.studentStatus)] ?? b.studentStatus}`,
    );
  }),
);
