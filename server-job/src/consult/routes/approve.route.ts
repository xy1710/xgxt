/**
 * 审批中心路由（咨询经理专属）
 *
 * 路径前缀：/api/consult/approve
 *
 * ⚠️ 两张表：
 *    ① 待分配学生（审批：分配咨询老师）
 *    ② 待我审批的退费申请（咨询师发起 → 经理审批 → 上报财务打款）
 */

import { Router } from 'express';
import { ConsultState, ConsultRefundStatus, ConsultRole } from 'shared-types/consult';
import type { PendingAssignItem, PendingRefundItem } from 'shared-types/consult';
import { ok } from '../utils/response';
import { db } from '../utils/db';
import { wrap } from '../utils/wrap';
import { requireManager } from '../middleware/auth';
import { sourceText, formatTime } from '../services/student.service';

export const approveRouter = Router();

/* ============================================================
 * 取审批中心数据（两张表一次返回）
 *    GET /api/consult/approve/center
 * ============================================================ */

/**
 * ★ 2026-10-16 审批中心 = 咨询经理专属
 *
 * 口径：「咨询师发起退费 → 咨询经理审批 → 财务打款」，
 *       所以咨询师不该在这里看到别人的待审批单（他只能发起，不能批）。
 */
approveRouter.get(
  '/center',
  requireManager,
  wrap(async (req, res) => {
    const user = req.user!;

    /* ---- ① 待分配学生 ---- */
    const assignRows: any[] = await db('t_consult_student')
      .where({ is_deleted: false, consult_state: ConsultState.WAIT_ASSIGN })
      .orderBy('create_time', 'asc');

    const pendingAssignList: PendingAssignItem[] = assignRows.map((r) => ({
      consultStudentId: r.id,
      studentName: r.student_name,
      phone: r.phone || undefined,
      source: sourceText(r),
      sourceChannelName: undefined,
      createTime: formatTime(r.create_time),
      creatorName: r.create_by_name || undefined,
    }));

    /* ---- ② 待审批的退费申请 ---- */
    const refundRows: any[] = await db('t_consult_refund')
      .where({ is_deleted: false, status: ConsultRefundStatus.PENDING_MANAGER })
      .orderBy('create_time', 'asc');

    const pendingRefundList: PendingRefundItem[] = refundRows.map((r) => ({
      refundId: r.id,
      refundNo: r.refund_no,
      consultStudentId: r.consult_student_id,
      studentName: r.student_name || '',
      className: r.class_name || undefined,
      applyByName: r.apply_by_name || '',
      trialDays: r.trial_days,
      deductTotal: r.deduct_total,
      refundAmount: r.refund_amount,
      status: r.status,
      statusName: '待经理审批',
      applyAt: formatTime(r.apply_at),
    }));

    res.json(ok({ pendingAssignList, pendingRefundList }));
  }),
);

/* ============================================================
 * 仅取待分配学生（分配弹窗单刷）
 *    GET /api/consult/approve/pending-assign
 * ============================================================ */

approveRouter.get(
  '/pending-assign',
  requireManager,
  wrap(async (_req, res) => {
    const rows: any[] = await db('t_consult_student')
      .where({ is_deleted: false, consult_state: ConsultState.WAIT_ASSIGN })
      .orderBy('create_time', 'asc');

    res.json(
      ok(
        rows.map((r) => ({
          consultStudentId: r.id,
          studentName: r.student_name,
          phone: r.phone || undefined,
          source: sourceText(r),
          createTime: formatTime(r.create_time),
          creatorName: r.create_by_name || undefined,
        })),
      ),
    );
  }),
);

/* ============================================================
 * 仅取待审批退费
 *    GET /api/consult/approve/pending-refund
 * ============================================================ */

approveRouter.get(
  '/pending-refund',
  requireManager,
  wrap(async (_req, res) => {
    const rows: any[] = await db('t_consult_refund')
      .where({ is_deleted: false, status: ConsultRefundStatus.PENDING_MANAGER })
      .orderBy('create_time', 'asc');

    res.json(
      ok(
        rows.map((r) => ({
          refundId: r.id,
          refundNo: r.refund_no,
          consultStudentId: r.consult_student_id,
          studentName: r.student_name || '',
          className: r.class_name || undefined,
          applyByName: r.apply_by_name || '',
          trialDays: r.trial_days,
          deductTotal: r.deduct_total,
          refundAmount: r.refund_amount,
          status: r.status,
          statusName: '待经理审批',
          applyAt: formatTime(r.apply_at),
        })),
      ),
    );
  }),
);

export default approveRouter;
