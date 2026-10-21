import { Router } from 'express';
import { z } from 'zod';
import { Knex } from 'knex';
import { ApplyType, PermAction, StudentStatus, SuspendStatus } from 'shared-types/class';
import { db } from '../../db';
import { Errors, ok, pageData } from '../../http/response';
import { pageQuerySchema, q, validate } from '../../lib/validate';
import { baseInsert, baseUpdate, maxApplyNo, notDeleted, paginate } from '../../lib/repo';
import { requirePerm } from '../../lib/permGuard';
import { rowsToCamel } from '../../lib/case';
import { buildApplyNo, now, seqOfApplyNo, uuid } from '../../lib/ids';
import { ApplyTypeName, SuspendStatusHandlerRole, SuspendStatusName } from '../../lib/dict';
import { hasAnyRole, isFullAccess, isPrincipal, isStudyManager } from '../../lib/authUser';
import { assertClassAccess } from '../../middleware/dataScope';
import { logApproval, PRINCIPAL_ROLES, sendNotify, sendNotifyByRole, STUDY_MANAGER_ROLES } from '../shared/flow';
import { RoleCode } from 'shared-types/class';
import { wrap } from '../../middleware/error';
import { applySyncScope } from '../shared/syncScope';
import { tbl, tblTrx, tblInsTrx } from '../../../teaching/shared/uniTable';
// ★ 2026-10-20 试学闭环：退学通过后回写咨询侧状态（→ 流失）
import { consultClient } from '../../lib/consultClient';

/** 本模块只服务大学学段 */
const SRC = 'sms_class';
const STAGE = 'class' as const;

/**
 * 休学 / 退学审批
 *
 * 流程（依据需求，用户已确认）：
 *   休学：班主任申请 → 学管审批 → 通过后通知班主任；驳回同样通知班主任
 *        状态：待提交(1) → 待经理审批(2) → 已同意(4) / 已驳回(5)
 *   退学：班主任申请 → 学管初步审批 → 校长审批 → 通过后通知班主任与学管；驳回同样通知
 *        状态：待提交(1) → 待经理审批(2) → 待校长审批(3) → 已同意(4) / 已驳回(5)
 *
 * 权限：
 *   发起  = 班主任（且只能为自己负责班级的学生发起）
 *   初审  = 学管（教质经理 / 学术经理）
 *   终审  = 校长（仅退学）
 */
export const suspendRouter = Router();

/** 状态 → 当前处理人角色中文（列表「当前处理人」列） */
function handlerNameOf(status: number): string {
  return SuspendStatusHandlerRole[status] ?? '—';
}

/** 该状态由谁处理（用于判定当前登录人能否审批） */
function canApproveAt(user: NonNullable<import('express').Request['user']>, status: number, applyType: number): boolean {
  if (isFullAccess(user) && !isPrincipal(user) && !isStudyManager(user)) return true; // 管理员兜底
  if (status === SuspendStatus.PENDING_MANAGER) return isStudyManager(user) || hasAnyRole(user, [RoleCode.ADMIN]);
  if (status === SuspendStatus.PENDING_PRINCIPAL) return isPrincipal(user) || hasAnyRole(user, [RoleCode.ADMIN]);
  void applyType;
  return false;
}

/* ============================== 发起申请 ============================== */

const addSchema = z.object({
  applyType: z.coerce.number().int('申请类型不能为空'),
  studentId: z.string().min(1, '缺少学生ID'),
  applyReason: z.string().min(1, '申请原因不能为空'),
  effectDate: z.string().optional().nullable(),
  expectResumeDate: z.string().optional().nullable(),
  occurredAmount: z.coerce.number().int().optional().nullable(),
  refundableAmount: z.coerce.number().int().optional().nullable(),
});

/**
 * @openapi
 * /api/class/suspend/add:
 *   post:
 *     tags: [审批流程]
 *     summary: 5.1 提交休学 / 退学申请（班主任）
 *     description: |
 *       - `applyType = 1` 休学：提交后进入「待经理审批」，学管审批一次即终审
 *       - `applyType = 2` 退学：提交后进入「待经理审批」，学管通过后还要校长审批
 *       提交即通知学管（站内待办）。
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [applyType, studentId, applyReason]
 *             properties:
 *               applyType: { type: integer, enum: [1, 2] }
 *               studentId: { type: string }
 *               applyReason: { type: string }
 *               effectDate: { type: string, description: 休学开始日期 / 退学申请日期 }
 *               expectResumeDate: { type: string, description: 休学专用 }
 *     responses:
 *       200: { description: 提交成功，返回申请单号 }
 */
suspendRouter.post(
  '/add',
  requirePerm('suspend', PermAction.ADD),
  validate({ body: addSchema }),
  wrap(async (req, res) => {
    const user = req.user!;
    const b = req.body as z.infer<typeof addSchema>;

    if (b.applyType !== ApplyType.SUSPEND && b.applyType !== ApplyType.QUIT) {
      throw Errors.param('申请类型只能是 1（休学）或 2（退学）');
    }

    const stu = (await notDeleted(tbl(db, SRC, 't_class_student', STAGE)).where('id', b.studentId).first()) as
      | Record<string, unknown>
      | undefined;
    if (!stu) throw Errors.studentNotFound();
    assertClassAccess(user, stu.class_id as string | null, '该学生');

    // 同一学生不允许有未走完的同类型申请
    const pending = await notDeleted(tbl(db, SRC, 't_class_suspend_apply', STAGE))
      .where('student_id', b.studentId)
      .where('apply_type', b.applyType)
      .whereIn('apply_status', [SuspendStatus.DRAFT, SuspendStatus.PENDING_MANAGER, SuspendStatus.PENDING_PRINCIPAL])
      .first();
    if (pending) {
      throw Errors.param(`该学生已有一条进行中的${ApplyTypeName[b.applyType]}申请（${String(pending.apply_no)}），请勿重复提交`);
    }

    const prefixKey = b.applyType === ApplyType.SUSPEND ? 'SUSPEND' : 'QUIT';
    const prefix = b.applyType === ApplyType.SUSPEND ? 'XG' : 'TG';
    const ymd = now().slice(0, 10).replace(/-/g, '');
    const maxNo = await maxApplyNo(tbl(db, SRC, 't_class_suspend_apply', STAGE), 't_class_suspend_apply', prefix, ymd);
    const applyNo = buildApplyNo(prefixKey, seqOfApplyNo(maxNo) + 1);

    const id = uuid();
    const t = now();

    await db.transaction(async (trx) => {
      await tblInsTrx(trx, SRC, 't_class_suspend_apply', STAGE, {
        ...baseInsert(user, id),
        apply_no: applyNo,
        apply_type: b.applyType,
        student_id: b.studentId,
        student_no: stu.student_no as string,
        student_name: stu.student_name as string,
        class_id: (stu.class_id as string) ?? null,
        class_name: (stu.class_name as string) ?? null,
        dept_code: (stu.dept_code as number) ?? null,
        id_card: (stu.id_card as string) ?? null,
        parent_phone: (stu.parent_phone as string) ?? null,
        apply_reason: b.applyReason,
        effect_date: b.effectDate ?? null,
        expect_resume_date: b.expectResumeDate ?? null,
        occurred_amount: b.occurredAmount ?? null,
        refundable_amount: b.refundableAmount ?? null,
        apply_status: SuspendStatus.PENDING_MANAGER,
        applicant_id: user.userId,
        applicant_name: user.userName,
        apply_time: t,
      } as never);

      await logApproval(trx, {
        applyType: b.applyType as ApplyType,
        applyNo,
        bizId: id,
        action: 'submit',
        fromStatus: SuspendStatus.DRAFT,
        toStatus: SuspendStatus.PENDING_MANAGER,
        user,
        opinion: b.applyReason,
      });

      // 通知学管有人提交了申请
      await sendNotifyByRole(
        trx,
        {
          notifyType: 3,
          applyType: b.applyType as ApplyType,
          bizId: id,
          applyNo,
          title: `新的${ApplyTypeName[b.applyType]}申请待审批：${String(stu.student_name)}`,
          content: `班主任 ${user.userName} 提交了 ${String(stu.student_name)}（${String(stu.student_no)}）的${ApplyTypeName[b.applyType]}申请，请及时审批。原因：${b.applyReason}`,
          linkPath: `/approval/detail?id=${id}`,
        },
        STUDY_MANAGER_ROLES,
      );
    });

    return ok(
      res,
      { applyId: id, applyNo, applyStatus: SuspendStatus.PENDING_MANAGER },
      `${ApplyTypeName[b.applyType]}申请已提交，等待学管审批`,
    );
  }),
);

/* ============================== 审批 ============================== */

const approveSchema = z.object({
  bizId: z.string().min(1, '缺少申请单ID'),
  action: z.enum(['approve', 'reject'], { errorMap: () => ({ message: '审批动作只能是 approve / reject' }) }),
  opinion: z.string().optional().nullable(),
});

/**
 * @openapi
 * /api/class/suspend/approve:
 *   post:
 *     tags: [审批流程]
 *     summary: 5.2 审批休学 / 退学申请
 *     description: |
 *       状态机（按当前状态判定该谁审，角色不符直接 403）：
 *       - 待经理审批：仅学管可审。休学 → 通过即「已同意」；退学 → 通过转「待校长审批」
 *       - 待校长审批：仅校长可审（仅退学）
 *       - 驳回：必须填 `opinion`（驳回原因），单子回到班主任并通知
 *       通过后的连带动作：学生状态改为「休学」/「退学」。
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [bizId, action]
 *             properties:
 *               bizId: { type: string }
 *               action: { type: string, enum: [approve, reject] }
 *               opinion: { type: string, description: 驳回时必填 }
 *     responses:
 *       200: { description: 审批结果与最新状态 }
 */
suspendRouter.post(
  '/approve',
  validate({ body: approveSchema }),
  wrap(async (req, res) => {
    const user = req.user!;
    const b = req.body as z.infer<typeof approveSchema>;

    const apply = (await notDeleted(tbl(db, SRC, 't_class_suspend_apply', STAGE)).where('id', b.bizId).first()) as
      | Record<string, unknown>
      | undefined;
    if (!apply) throw Errors.applyNotFound('申请单不存在');

    const status = apply.apply_status as number;
    const applyType = apply.apply_type as number;
    const applyNo = apply.apply_no as string;
    const studentName = apply.student_name as string;

    if (status !== SuspendStatus.PENDING_MANAGER && status !== SuspendStatus.PENDING_PRINCIPAL) {
      throw Errors.param('该申请单当前状态不可审批（可能已审批完成或已驳回）');
    }
    if (!canApproveAt(user, status, applyType)) {
      const need = status === SuspendStatus.PENDING_MANAGER ? '学管' : '校长';
      throw Errors.noOperationPermission(`当前节点应由${need}审批，您无权操作`);
    }
    if (b.action === 'reject' && (!b.opinion || !b.opinion.trim())) {
      throw Errors.required('驳回原因');
    }

    const t = now();
    let toStatus: number;

    if (b.action === 'reject') {
      toStatus = SuspendStatus.REJECTED;
    } else if (status === SuspendStatus.PENDING_MANAGER && applyType === ApplyType.QUIT) {
      toStatus = SuspendStatus.PENDING_PRINCIPAL; // 退学：学管初审通过 → 转校长
    } else {
      toStatus = SuspendStatus.APPROVED;
    }

    await db.transaction(async (trx) => {
      const patch: Record<string, unknown> = { apply_status: toStatus, ...baseUpdate(user) };

      if (status === SuspendStatus.PENDING_MANAGER) {
        patch.manager_approver_id = user.userId;
        patch.manager_approver_name = user.userName;
        patch.manager_approve_time = t;
        patch.manager_opinion = b.opinion ?? (b.action === 'approve' ? '同意' : null);
      } else {
        patch.principal_approver_id = user.userId;
        patch.principal_approver_name = user.userName;
        patch.principal_approve_time = t;
        patch.principal_opinion = b.opinion ?? (b.action === 'approve' ? '同意' : null);
      }
      if (b.action === 'reject') patch.reject_reason = b.opinion;

      await tblTrx(trx, SRC, 't_class_suspend_apply', STAGE).where({ id: b.bizId }).update(patch);

      await logApproval(trx, {
        applyType: applyType as ApplyType,
        applyNo,
        bizId: b.bizId,
        action: b.action === 'approve' ? 'approve' : 'reject',
        fromStatus: status,
        toStatus,
        user,
        opinion: b.opinion ?? undefined,
      });

      const typeName = ApplyTypeName[applyType];

      if (toStatus === SuspendStatus.PENDING_PRINCIPAL) {
        // 退学：学管初审通过 → 通知校长，并告知班主任进度
        await sendNotifyByRole(
          trx,
          {
            notifyType: 3,
            applyType: applyType as ApplyType,
            bizId: b.bizId,
            applyNo,
            title: `退学申请待您审批：${studentName}`,
            content: `学管 ${user.userName} 已初审通过 ${studentName} 的退学申请（${applyNo}），请校长审批。`,
            linkPath: `/approval/detail?id=${b.bizId}`,
          },
          PRINCIPAL_ROLES,
        );
        await sendNotify(
          trx,
          {
            notifyType: 3,
            applyType: applyType as ApplyType,
            bizId: b.bizId,
            applyNo,
            title: `退学申请已通过学管初审：${studentName}`,
            content: `您提交的退学申请（${applyNo}）已由学管 ${user.userName} 初审通过，正在等待校长审批。`,
            linkPath: `/approval/detail?id=${b.bizId}`,
          },
          { userId: apply.applicant_id as string, userName: apply.applicant_name as string },
        );
      } else if (toStatus === SuspendStatus.APPROVED) {
        // 终审通过：改学生状态
        const newStudentStatus = applyType === ApplyType.SUSPEND ? StudentStatus.SUSPENDED : StudentStatus.QUIT;
        await tblTrx(trx, SRC, 't_class_student', STAGE)
          .where({ id: apply.student_id as string })
          .update({ student_status: newStudentStatus, ...baseUpdate(user) });

        // 通知班主任（必须）
        await sendNotify(
          trx,
          {
            notifyType: 1,
            applyType: applyType as ApplyType,
            bizId: b.bizId,
            applyNo,
            title: `${typeName}申请已通过：${studentName}`,
            content: `您提交的${typeName}申请（${applyNo}）已审批通过，学生状态已更新为「${typeName}」。`,
            linkPath: `/approval/detail?id=${b.bizId}`,
          },
          { userId: apply.applicant_id as string, userName: apply.applicant_name as string },
        );
        // 退学：还要通知学管（需求明确「通知班主任和学管」）
        if (applyType === ApplyType.QUIT) {
          await sendNotifyByRole(
            trx,
            {
              notifyType: 1,
              applyType: applyType as ApplyType,
              bizId: b.bizId,
              applyNo,
              title: `退学申请已通过：${studentName}`,
              content: `校长已审批通过 ${studentName}（${applyNo}）的退学申请，流程已结束。`,
              linkPath: `/approval/detail?id=${b.bizId}`,
            },
            STUDY_MANAGER_ROLES,
          );
        }
      } else {
        // 驳回：通知班主任；退学驳回时同时通知学管
        const rejectRoleName = status === SuspendStatus.PENDING_MANAGER ? '学管' : '校长';
        await sendNotify(
          trx,
          {
            notifyType: 2,
            applyType: applyType as ApplyType,
            bizId: b.bizId,
            applyNo,
            title: `${typeName}申请被驳回：${studentName}`,
            content: `您提交的${typeName}申请（${applyNo}）被${rejectRoleName} ${user.userName} 驳回，原因：${b.opinion ?? '未填写'}`,
            linkPath: `/approval/detail?id=${b.bizId}`,
          },
          { userId: apply.applicant_id as string, userName: apply.applicant_name as string },
        );
        if (applyType === ApplyType.QUIT) {
          await sendNotifyByRole(
            trx,
            {
              notifyType: 2,
              applyType: applyType as ApplyType,
              bizId: b.bizId,
              applyNo,
              title: `退学申请被驳回：${studentName}`,
              content: `校长 ${user.userName} 驳回了 ${studentName}（${applyNo}）的退学申请，原因：${b.opinion ?? '未填写'}`,
              linkPath: `/approval/detail?id=${b.bizId}`,
            },
            STUDY_MANAGER_ROLES,
          );
        }
      }
    });

    /* ★ 2026-10-20 试学闭环：退学审批通过 → 回写咨询侧状态（→ 流失）
     *
     * 用户口径：「试学中有问题就退学」。退学审批在本模块走完，但学生在咨询侧
     * 还挂着「试学中」—— 咨询老师会一直以为人还在。这里同步过去。
     *
     * ⚠️ 放在事务外：跨模块 HTTP 不能进事务（对方不回滚，本地回滚就分叉了）。
     * ⚠️ 失败只记日志：审批结果已经生效，不能因为咨询模块抖一下把审批结果撤掉。
     * ⚠️ 只处理「从咨询同步进来」的学生（source_system='consult'）。
     */
    if (toStatus === SuspendStatus.APPROVED && applyType === ApplyType.QUIT) {
      try {
        const stu = (await notDeleted(tbl(db, SRC, 't_class_student', STAGE))
          .where({ id: apply.student_id as string })
          .first()) as Record<string, unknown> | undefined;
        const consultNo = String(stu?.source_id || '');
        if (stu && String(stu.source_system || '') === 'consult' && consultNo) {
          const r = await consultClient.quit({
            consultNo,
            reason: (apply.apply_reason as string) || '试学未通过，退学',
            operatorName: user.userName,
            operatorTitle: '学管',
          });
          if (!r.ok) {
            console.warn(`[suspend/approve] 回写咨询状态失败（${consultNo}）：${r.message}`);
          }
        }
      } catch (e: any) {
        console.warn('[suspend/approve] 回写咨询状态异常', e?.message);
      }
    }

    const statusName = SuspendStatusName[toStatus] ?? '';
    const okMsg = toStatus === SuspendStatus.PENDING_PRINCIPAL
      ? '初审已通过，已转交校长审批'
      : toStatus === SuspendStatus.APPROVED
        ? '审批通过，学生状态已同步更新'
        : '已驳回，已通知申请人';

    return ok(res, { bizId: b.bizId, applyStatus: toStatus, applyStatusName: statusName }, okMsg);
  }),
);

/* ============================== 撤回 ============================== */

/**
 * @openapi
 * /api/class/suspend/withdraw:
 *   post:
 *     tags: [审批流程]
 *     summary: 5.3 撤回申请（班主任撤回自己提交的、尚未审批完成的单子）
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [bizId]
 *             properties:
 *               bizId: { type: string }
 *     responses:
 *       200: { description: 撤回成功 }
 */
suspendRouter.post(
  '/withdraw',
  validate({ body: z.object({ bizId: z.string().min(1, '缺少申请单ID') }) }),
  wrap(async (req, res) => {
    const user = req.user!;
    const { bizId } = req.body as { bizId: string };

    const apply = (await notDeleted(tbl(db, SRC, 't_class_suspend_apply', STAGE)).where('id', bizId).first()) as
      | Record<string, unknown>
      | undefined;
    if (!apply) throw Errors.applyNotFound();
    if (apply.applicant_id !== user.userId && !isFullAccess(user)) {
      throw Errors.noOperationPermission('只能撤回自己提交的申请');
    }
    const status = apply.apply_status as number;
    if (status !== SuspendStatus.PENDING_MANAGER && status !== SuspendStatus.PENDING_PRINCIPAL) {
      throw Errors.param('当前状态不可撤回');
    }

    await db.transaction(async (trx) => {
      await tblTrx(trx, SRC, 't_class_suspend_apply', STAGE).where({ id: bizId }).update({
        is_deleted: 1,
        ...baseUpdate(user),
      } as never);
      await logApproval(trx, {
        applyType: apply.apply_type as ApplyType,
        applyNo: apply.apply_no as string,
        bizId,
        action: 'reject',
        fromStatus: status,
        toStatus: status,
        user,
        opinion: '申请人撤回',
      });
    });

    return ok(res, { bizId }, '已撤回申请');
  }),
);

/* ============================== 列表 / 详情 ============================== */

const listSchema = z.object({
  ...pageQuerySchema.shape,
  applyType: z.coerce.number().int().optional(),
  applyStatus: z.coerce.number().int().optional(),
  classId: z.string().optional(),
  studentNo: z.string().optional(),
  studentName: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  keyword: z.string().optional(),
  /** 只看我提交的 */
  onlyMine: z.coerce.boolean().optional(),
  /** 只看待我审批的 */
  onlyTodo: z.coerce.boolean().optional(),
});

/**
 * @openapi
 * /api/class/suspend/list:
 *   get:
 *     tags: [审批流程]
 *     summary: 5.4 休学 / 退学申请列表
 *     description: |
 *       数据范围：老师只看自己负责班级的申请；学管 / 校长看全部。
 *       `onlyMine=true` 看我提交的；`onlyTodo=true` 看当前节点该我审的。
 *     responses:
 *       200: { description: 分页列表 }
 */
suspendRouter.get(
  '/list',
  validate({ query: listSchema }),
  wrap(async (req, res) => {
    const user = req.user!;
    const query = q<z.infer<typeof listSchema>>(req);

    const base = tbl(db, SRC, 't_class_suspend_apply', STAGE);
    notDeleted(base);
    await applySyncScope(base, user);
    if (query.applyType) base.where('apply_type', query.applyType);
    if (query.applyStatus) base.where('apply_status', query.applyStatus);
    if (query.classId) base.where('class_id', query.classId);
    if (query.studentNo) base.where('student_no', 'like', `%${query.studentNo}%`);
    if (query.studentName) base.where('student_name', 'like', `%${query.studentName}%`);
    if (query.startDate) base.where('apply_time', '>=', `${query.startDate} 00:00:00`);
    if (query.endDate) base.where('apply_time', '<=', `${query.endDate} 23:59:59`);
    if (query.keyword) {
      const k = query.keyword;
      base.where(function (this: Knex.QueryBuilder) {
        this.where('student_no', 'like', `%${k}%`)
          .orWhere('student_name', 'like', `%${k}%`)
          .orWhere('apply_no', 'like', `%${k}%`);
      });
    }
    if (query.onlyMine) base.where('applicant_id', user.userId);
    if (query.onlyTodo) {
      const statuses: number[] = [];
      if (isStudyManager(user) || hasAnyRole(user, [RoleCode.ADMIN])) statuses.push(SuspendStatus.PENDING_MANAGER);
      if (isPrincipal(user) || hasAnyRole(user, [RoleCode.ADMIN])) statuses.push(SuspendStatus.PENDING_PRINCIPAL);
      if (!statuses.length) base.whereRaw('1 = 0');
      else base.whereIn('apply_status', statuses);
    }
    base.orderBy('apply_time', 'desc');

    const paged = await paginate(base, query, async (qb) => {
      const rows = (await qb) as Array<Record<string, unknown>>;
      return rows.map((r) => {
        const c = rowsToCamel<Record<string, unknown>>([r])[0];
        const st = r.apply_status as number;
        return {
          ...c,
          applyTypeName: ApplyTypeName[r.apply_type as number] ?? '未知',
          applyStatusName: SuspendStatusName[st] ?? '未知',
          currentHandlerName: handlerNameOf(st),
          occurredAmountYuan: r.occurred_amount === null ? null : (Number(r.occurred_amount) / 100).toFixed(2),
          refundableAmountYuan: r.refundable_amount === null ? null : (Number(r.refundable_amount) / 100).toFixed(2),
        };
      });
    });

    return ok(res, pageData(paged.total, paged.page, paged.size, paged.list), '查询成功');
  }),
);

/**
 * @openapi
 * /api/class/suspend/detail:
 *   get:
 *     tags: [审批流程]
 *     summary: 5.5 申请详情（含审批日志与下一处理人）
 *     parameters:
 *       - { in: query, name: id, schema: { type: string }, required: true }
 *     responses:
 *       200: { description: 详情 }
 */
suspendRouter.get(
  '/detail',
  validate({ query: z.object({ id: z.string().min(1, '缺少申请单ID') }) }),
  wrap(async (req, res) => {
    const user = req.user!;
    const { id } = q<{ id: string }>(req);

    const apply = (await notDeleted(tbl(db, SRC, 't_class_suspend_apply', STAGE)).where('id', id).first()) as
      | Record<string, unknown>
      | undefined;
    if (!apply) throw Errors.applyNotFound();
    assertClassAccess(user, apply.class_id as string | null, '该申请');

    const logs = (await notDeleted(tbl(db, SRC, 't_class_approval_log', STAGE))
      .where({ biz_id: id })
      .orderBy('operate_time', 'asc')) as Array<Record<string, unknown>>;

    const c = rowsToCamel<Record<string, unknown>>([apply])[0];
    const st = apply.apply_status as number;
    return ok(
      res,
      {
        apply: {
          ...c,
          applyTypeName: ApplyTypeName[apply.apply_type as number] ?? '未知',
          applyStatusName: SuspendStatusName[st] ?? '未知',
          occurredAmountYuan: apply.occurred_amount === null ? null : (Number(apply.occurred_amount) / 100).toFixed(2),
          refundableAmountYuan: apply.refundable_amount === null ? null : (Number(apply.refundable_amount) / 100).toFixed(2),
        },
        logs: rowsToCamel(logs),
        nextHandlerRole: handlerNameOf(st),
        nextHandlerName: handlerNameOf(st),
        canApprove: canApproveAt(user, st, apply.apply_type as number),
      },
      '查询成功',
    );
  }),
);
