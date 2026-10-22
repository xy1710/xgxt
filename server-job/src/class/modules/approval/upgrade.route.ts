import { Router } from 'express';
import { z } from 'zod';
import { Knex } from 'knex';
import { ApplyType, PermAction, UpgradeStatus } from 'shared-types/class';
import { db } from '../../db';
import { Errors, ok, pageData } from '../../http/response';
import { pageQuerySchema, q, validate } from '../../lib/validate';
import { baseInsert, baseUpdate, maxApplyNo, notDeleted, paginate } from '../../lib/repo';
import { requirePerm, requireApprover } from '../../lib/permGuard';
import { rowsToCamel } from '../../lib/case';
import { buildApplyNo, now, seqOfApplyNo, uuid } from '../../lib/ids';
import { DeptName, StageName, UpgradeStatusName, deptOfStage, stageNameOf } from '../../lib/dict';
import { assertClassAccess } from '../../middleware/dataScope';
import { applySyncScope } from '../shared/syncScope';
import { logApproval, sendNotify, sendNotifyByRole, STUDY_MANAGER_ROLES } from '../shared/flow';
import { wrap } from '../../middleware/error';
import { tbl, tblTrx, tblInsTrx, phaseCodeCol, readPhaseCode } from '../../../teaching/shared/uniTable';
import { TransferType } from 'shared-types';

/** 本模块只服务大学学段 */
const SRC = 'sms_class';
const STAGE = 'class' as const;

/**
 * 升学申请（需求一之 2：初高中升学的学生信息需支持同步）
 *
 * 本模块内的路径：初高部班主任发起 → 学管（本模块）接收并落库
 * 落库动作：更新学生 stage + 班级归属，成绩明细快照随档案一并保存
 * （另有教务侧推送路径：POST /api/class/student/upgrade/sync）
 */
export const upgradeRouter = Router();

const addSchema = z.object({
  studentId: z.string().min(1, '缺少学生ID'),
  toDeptCode: z.coerce.number().int('目标部门不能为空'),
  toStage: z.coerce.number().int('目标学习阶段不能为空'),
  toClassId: z.string().optional().nullable(),
  examScore: z.coerce.number().optional().nullable(),
  /** 升学时的成绩明细快照（不传则后端自动抓取最近成绩） */
  gradeSnapshot: z.string().optional().nullable(),
});

/**
 * @openapi
 * /api/class/upgrade/add:
 *   post:
 *     tags: [审批流程]
 *     summary: 5.10 发起升学申请（初高部班主任）
 *     description: |
 *       需求一之 2 的本模块路径：班主任发起 → 学管接收并落库。
 *       提交后状态为「待接收」，并通知学管。
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [studentId, toDeptCode, toStage]
 *             properties:
 *               studentId: { type: string }
 *               toDeptCode: { type: integer, example: 1 }
 *               toStage: { type: integer, example: 105 }
 *               toClassId: { type: string }
 *               examScore: { type: number }
 *     responses:
 *       200: { description: 提交成功 }
 */
upgradeRouter.post(
  '/add',
  requirePerm('upgrade', PermAction.ADD),
  validate({ body: addSchema }),
  wrap(async (req, res) => {
    const user = req.user!;
    const b = req.body as z.infer<typeof addSchema>;

    const stu = (await notDeleted(tbl(db, SRC, 't_class_student', STAGE)).where('id', b.studentId).first()) as
      | Record<string, unknown>
      | undefined;
    if (!stu) throw Errors.studentNotFound();
    assertClassAccess(user, stu.class_id as string | null, '该学生');

    const stageDept = deptOfStage(b.toStage);
    if (stageDept === undefined) {
      throw Errors.param('目标学习阶段取值不合法，请从字典 4.4 中选择');
    }
    if (stageDept !== b.toDeptCode) {
      throw Errors.param(
        `学习阶段「${StageName[b.toStage] ?? b.toStage}」属于「${DeptName[stageDept]}」，与所选部门不一致`,
      );
    }

    const pending = await notDeleted(tbl(db, SRC, 't_class_upgrade_apply', STAGE))
      .where('student_id', b.studentId)
      .where('apply_status', UpgradeStatus.PENDING)
      .first();
    if (pending) {
      throw Errors.param(`该学生已有一条待接收的升学申请（${String(pending.apply_no)}）`);
    }

    let toClassName: string | null = null;
    if (b.toClassId) {
      const cls = (await notDeleted(tbl(db, SRC, 't_class_info', STAGE)).where('id', b.toClassId).first()) as
        | Record<string, unknown>
        | undefined;
      if (!cls) throw Errors.classNotFound('目标班级不存在');
      toClassName = cls.class_name as string;
    }

    // 成绩快照：默认抓取该学生最近 5 条成绩
    let gradeSnapshot = b.gradeSnapshot ?? null;
    if (!gradeSnapshot) {
      const grades = (await notDeleted(tbl(db, SRC, 't_class_grade', STAGE))
        .where('student_id', b.studentId)
        .orderBy('create_time', 'desc')
        .limit(5)) as Array<Record<string, unknown>>;
      gradeSnapshot = JSON.stringify(
        grades.map((g) => ({
          examName: g.exam_name,
          writtenScore: g.written_score,
          machineScore: g.machine_score,
          interviewScore: g.interview_score,
          compScore: g.comp_score,
          examResult: g.exam_result,
          analysis: g.analysis,
        })),
      );
    }

    const ymd = now().slice(0, 10).replace(/-/g, '');
    const maxNo = await maxApplyNo(tbl(db, SRC, 't_class_upgrade_apply', STAGE), 't_class_upgrade_apply', 'SX', ymd);
    const applyNo = buildApplyNo('UPGRADE', seqOfApplyNo(maxNo) + 1);

    const fromStage = readPhaseCode(stu) ?? 0;
    const fromDept = (stu.dept_code as number) ?? 0;
    const id = uuid();

    await db.transaction(async (trx) => {
      await tblInsTrx(trx, SRC, 't_class_upgrade_apply', STAGE, {
        ...baseInsert(user, id),
        apply_no: applyNo,
        student_id: b.studentId,
        student_no: stu.student_no as string,
        student_name: stu.student_name as string,
        from_dept_code: fromDept,
        from_stage: fromStage,
        from_class_id: (stu.class_id as string) ?? null,
        from_class_name: (stu.class_name as string) ?? null,
        to_dept_code: b.toDeptCode,
        to_stage: b.toStage,
        to_class_id: b.toClassId ?? null,
        to_class_name: toClassName,
        exam_score: b.examScore ?? null,
        grade_snapshot: gradeSnapshot,
        apply_status: UpgradeStatus.PENDING,
        applicant_id: user.userId,
        applicant_name: user.userName,
        apply_time: now(),
      } as never);

      await logApproval(trx, {
        applyType: ApplyType.UPGRADE,
        applyNo,
        bizId: id,
        action: 'submit',
        fromStatus: 0,
        toStatus: UpgradeStatus.PENDING,
        user,
        opinion: `升学申请：${StageName[fromStage] ?? fromStage} → ${StageName[b.toStage] ?? b.toStage}`,
      });

      await sendNotifyByRole(
        trx,
        {
          notifyType: 3,
          applyType: ApplyType.UPGRADE,
          bizId: id,
          applyNo,
          title: `新的升学申请待接收：${String(stu.student_name)}`,
          content: `班主任 ${user.userName} 提交了 ${String(stu.student_name)}（${String(stu.student_no)}）的升学申请：${StageName[fromStage] ?? fromStage} → ${StageName[b.toStage] ?? b.toStage}，请接收。`,
          linkPath: `/approval/detail?id=${id}`,
        },
        STUDY_MANAGER_ROLES,
      );
    });

    return ok(res, { applyId: id, applyNo, applyStatus: UpgradeStatus.PENDING }, '升学申请已提交，等待学管接收');
  }),
);

/* ============================== 接收 / 驳回 ============================== */

const receiveSchema = z.object({
  bizId: z.string().min(1, '缺少申请单ID'),
  toClassId: z.string().optional().nullable(),
  examScore: z.coerce.number().optional().nullable(),
  opinion: z.string().optional().nullable(),
});

/**
 * @openapi
 * /api/class/upgrade/receive:
 *   post:
 *     tags: [审批流程]
 *     summary: 5.11 接收升学申请（学管）
 *     description: |
 *       接收即落库：更新学生 `stage` / 部门 / 班级归属，并写一条班级变更历史；
 *       升学时的成绩快照已随申请单一并保存（`gradeSnapshot`）。
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [bizId]
 *             properties:
 *               bizId: { type: string }
 *               toClassId: { type: string, description: 可在接收时指定目标班级 }
 *               examScore: { type: number }
 *               opinion: { type: string }
 *     responses:
 *       200: { description: 接收成功 }
 */
upgradeRouter.post(
  '/receive',
  requireApprover(),
  validate({ body: receiveSchema }),
  wrap(async (req, res) => {
    const user = req.user!;
    const b = req.body as z.infer<typeof receiveSchema>;

    const apply = (await notDeleted(tbl(db, SRC, 't_class_upgrade_apply', STAGE)).where('id', b.bizId).first()) as
      | Record<string, unknown>
      | undefined;
    if (!apply) throw Errors.applyNotFound('升学申请不存在');
    if ((apply.apply_status as number) !== UpgradeStatus.PENDING) {
      throw Errors.param('该升学申请已处理过');
    }

    const toClassId = b.toClassId ?? (apply.to_class_id as string | null) ?? null;
    let toClassName = (apply.to_class_name as string) ?? null;
    let headTeacherId: string | null = null;
    let headTeacherName: string | null = null;
    if (toClassId) {
      const cls = (await notDeleted(tbl(db, SRC, 't_class_info', STAGE)).where('id', toClassId).first()) as
        | Record<string, unknown>
        | undefined;
      if (!cls) throw Errors.classNotFound('目标班级不存在');
      toClassName = cls.class_name as string;
      headTeacherId = (cls.head_teacher_id as string) ?? null;
      headTeacherName = (cls.head_teacher_name as string) ?? null;
    }

    const t = now();
    await db.transaction(async (trx) => {
      await tblTrx(trx, SRC, 't_class_upgrade_apply', STAGE).where({ id: b.bizId }).update({
        apply_status: UpgradeStatus.RECEIVED,
        to_class_id: toClassId,
        to_class_name: toClassName,
        exam_score: b.examScore ?? apply.exam_score ?? null,
        receive_time: t,
        receiver_id: user.userId,
        receiver_name: user.userName,
        ...baseUpdate(user),
      } as never);

      const patch: Record<string, unknown> = {
        [phaseCodeCol()]: apply.to_stage as number,
        dept_code: apply.to_dept_code as number,
        ...baseUpdate(user),
      };
      if (toClassId) {
        patch.class_id = toClassId;
        patch.class_name = toClassName;
        patch.head_teacher_id = headTeacherId;
        patch.head_teacher_name = headTeacherName;
      }
      await tblTrx(trx, SRC, 't_class_student', STAGE).where({ id: apply.student_id as string }).update(patch);

      await tblInsTrx(trx, SRC, 't_class_transfer', STAGE, {
        ...baseInsert(user),
        class_id: toClassId ?? (apply.from_class_id as string) ?? '',
        class_name: toClassName ?? (apply.from_class_name as string) ?? '',
        // ★ 老表是 varchar(20) 存 'upgrade'，统一表是 int(11) 存数字码，
        //   两者语义也不同（老表这列装的是「升学」，字典 1~5 说的是「岗位交接」）。
        //   → 按开关给对应值：老表模式行为与改写前完全一致，统一表写 6=升学转班。
        //   字典新增 6 这一档是斌哥拍板的，见 shared-types/src/enums.ts 的 CLASS_UPGRADE。
        transfer_type: TransferType.CLASS_UPGRADE,
        from_user_id: null,
        from_user_name: (apply.from_class_name as string) ?? null,
        to_user_id: null,
        to_user_name: toClassName,
        transfer_time: t,
        reason: `升学：${stageNameOf(apply.from_stage as number)} → ${stageNameOf(apply.to_stage as number)}`,
      } as never);

      await logApproval(trx, {
        applyType: ApplyType.UPGRADE,
        applyNo: apply.apply_no as string,
        bizId: b.bizId,
        action: 'receive',
        fromStatus: UpgradeStatus.PENDING,
        toStatus: UpgradeStatus.RECEIVED,
        user,
        opinion: b.opinion ?? '已接收并落库',
      });

      await sendNotify(
        trx,
        {
          notifyType: 1,
          applyType: ApplyType.UPGRADE,
          bizId: b.bizId,
          applyNo: apply.apply_no as string,
          title: `升学申请已接收：${String(apply.student_name)}`,
          content: `学管 ${user.userName} 已接收 ${String(apply.student_name)}（${String(apply.student_no)}）的升学申请，学习阶段已更新为「${stageNameOf(apply.to_stage as number)}」，成绩明细已随档案保存。`,
          linkPath: `/approval/detail?id=${b.bizId}`,
        },
        { userId: apply.applicant_id as string, userName: apply.applicant_name as string },
      );
    });

    return ok(res, { bizId: b.bizId, applyStatus: UpgradeStatus.RECEIVED }, '升学申请已接收，学生档案已同步更新');
  }),
);

/**
 * @openapi
 * /api/class/upgrade/reject:
 *   post:
 *     tags: [审批流程]
 *     summary: 5.12 驳回升学申请（学管）
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [bizId, opinion]
 *             properties:
 *               bizId: { type: string }
 *               opinion: { type: string, description: 驳回原因，必填 }
 *     responses:
 *       200: { description: 驳回成功 }
 */
upgradeRouter.post(
  '/reject',
  requireApprover(),
  validate({
    body: z.object({
      bizId: z.string().min(1, '缺少申请单ID'),
      opinion: z.string().min(1, '驳回原因不能为空'),
    }),
  }),
  wrap(async (req, res) => {
    const user = req.user!;
    const b = req.body as { bizId: string; opinion: string };

    const apply = (await notDeleted(tbl(db, SRC, 't_class_upgrade_apply', STAGE)).where('id', b.bizId).first()) as
      | Record<string, unknown>
      | undefined;
    if (!apply) throw Errors.applyNotFound('升学申请不存在');
    if ((apply.apply_status as number) !== UpgradeStatus.PENDING) {
      throw Errors.param('该升学申请已处理过');
    }

    await db.transaction(async (trx) => {
      await tblTrx(trx, SRC, 't_class_upgrade_apply', STAGE).where({ id: b.bizId }).update({
        apply_status: UpgradeStatus.REJECTED,
        reject_reason: b.opinion,
        receive_time: now(),
        receiver_id: user.userId,
        receiver_name: user.userName,
        ...baseUpdate(user),
      } as never);

      await logApproval(trx, {
        applyType: ApplyType.UPGRADE,
        applyNo: apply.apply_no as string,
        bizId: b.bizId,
        action: 'reject',
        fromStatus: UpgradeStatus.PENDING,
        toStatus: UpgradeStatus.REJECTED,
        user,
        opinion: b.opinion,
      });

      await sendNotify(
        trx,
        {
          notifyType: 2,
          applyType: ApplyType.UPGRADE,
          bizId: b.bizId,
          applyNo: apply.apply_no as string,
          title: `升学申请被驳回：${String(apply.student_name)}`,
          content: `您提交的升学申请（${String(apply.apply_no)}）被学管 ${user.userName} 驳回，原因：${b.opinion}`,
          linkPath: `/approval/detail?id=${b.bizId}`,
        },
        { userId: apply.applicant_id as string, userName: apply.applicant_name as string },
      );
    });

    return ok(res, { bizId: b.bizId, applyStatus: UpgradeStatus.REJECTED }, '已驳回升学申请，已通知申请人');
  }),
);

/* ============================== 列表 / 详情 ============================== */

const listSchema = z.object({
  ...pageQuerySchema.shape,
  applyStatus: z.coerce.number().int().optional(),
  toDeptCode: z.coerce.number().int().optional(),
  toStage: z.coerce.number().int().optional(),
  fromClassId: z.string().optional(),
  keyword: z.string().optional(),
  onlyMine: z.coerce.boolean().optional(),
});

/**
 * @openapi
 * /api/class/upgrade/list:
 *   get:
 *     tags: [审批流程]
 *     summary: 5.13 升学申请列表
 *     responses:
 *       200: { description: 分页列表 }
 */
upgradeRouter.get(
  '/list',
  validate({ query: listSchema }),
  wrap(async (req, res) => {
    const user = req.user!;
    const query = q<z.infer<typeof listSchema>>(req);

    const base = tbl(db, SRC, 't_class_upgrade_apply', STAGE);
    notDeleted(base);
    // 升学的数据范围按「原班级」判定
    await applySyncScope(base, user, { classColumn: 'from_class_id' });
    if (query.applyStatus) base.where('apply_status', query.applyStatus);
    if (query.toDeptCode) base.where('to_dept_code', query.toDeptCode);
    if (query.toStage) base.where('to_stage', query.toStage);
    if (query.fromClassId) base.where('from_class_id', query.fromClassId);
    if (query.onlyMine) base.where('applicant_id', user.userId);
    if (query.keyword) {
      const k = query.keyword;
      base.where(function (this: Knex.QueryBuilder) {
        this.where('student_no', 'like', `%${k}%`)
          .orWhere('student_name', 'like', `%${k}%`)
          .orWhere('apply_no', 'like', `%${k}%`);
      });
    }
    base.orderBy('apply_time', 'desc');

    const paged = await paginate(base, query, async (qb) => {
      const rows = (await qb) as Array<Record<string, unknown>>;
      return rows.map((r) => {
        const c = rowsToCamel<Record<string, unknown>>([r])[0];
        return {
          ...c,
          who: `${String(r.student_name)} / ${String(r.student_no)}`,
          fromDeptName: DeptName[r.from_dept_code as number] ?? '—',
          toDeptName: DeptName[r.to_dept_code as number] ?? '—',
          fromStageName: stageNameOf(r.from_stage as number),
          toStageName: stageNameOf(r.to_stage as number),
          applyStatusName: UpgradeStatusName[r.apply_status as number] ?? '未知',
        };
      });
    });

    return ok(res, pageData(paged.total, paged.page, paged.size, paged.list), '查询成功');
  }),
);

/**
 * @openapi
 * /api/class/upgrade/detail:
 *   get:
 *     tags: [审批流程]
 *     summary: 5.14 升学申请详情（含成绩快照与审批日志）
 *     parameters:
 *       - { in: query, name: id, schema: { type: string }, required: true }
 *     responses:
 *       200: { description: 详情 }
 */
upgradeRouter.get(
  '/detail',
  validate({ query: z.object({ id: z.string().min(1, '缺少申请单ID') }) }),
  wrap(async (req, res) => {
    const { id } = q<{ id: string }>(req);
    const apply = (await notDeleted(tbl(db, SRC, 't_class_upgrade_apply', STAGE)).where('id', id).first()) as
      | Record<string, unknown>
      | undefined;
    if (!apply) throw Errors.applyNotFound('升学申请不存在');

    const logs = (await notDeleted(tbl(db, SRC, 't_class_approval_log', STAGE))
      .where({ biz_id: id })
      .orderBy('operate_time', 'asc')) as Array<Record<string, unknown>>;

    let gradeSnapshot: unknown = null;
    try {
      gradeSnapshot = apply.grade_snapshot ? JSON.parse(String(apply.grade_snapshot)) : null;
    } catch {
      gradeSnapshot = apply.grade_snapshot ?? null;
    }

    const c = rowsToCamel<Record<string, unknown>>([apply])[0];
    return ok(
      res,
      {
        apply: {
          ...c,
          fromDeptName: DeptName[apply.from_dept_code as number] ?? '—',
          toDeptName: DeptName[apply.to_dept_code as number] ?? '—',
          fromStageName: stageNameOf(apply.from_stage as number),
          toStageName: stageNameOf(apply.to_stage as number),
          applyStatusName: UpgradeStatusName[apply.apply_status as number] ?? '未知',
        },
        gradeSnapshot,
        logs: rowsToCamel(logs),
      },
      '查询成功',
    );
  }),
);
