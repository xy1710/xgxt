/**
 * 退费路由（教学管理初高）
 *
 * 覆盖：eligible / add / update / submit / list / detail / export
 *       + 审批链 approve（2→3→(5)→4→6，超阈值走校长）/ reject（→7）+ refund_log + op_log。
 * 表：t_class_refund、t_class_refund_log。
 * 挂载：/api/class/refund。
 */

import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import {
  BizCode,
  FEE_TYPE_NAME,
  REFUND_STATUS_NAME,
} from 'shared-types/class-jh';
import { FeeType, RefundStatus, StudentStatus } from 'shared-types/class-jh';
import { ok, page } from '../utils/response';
import { db } from '../utils/db';
import { wrap } from '../utils/wrap';
import { writeOpLog } from '../utils/opLog';
import { nameOf } from '../utils/enumName';
import { getNumberSetting } from '../utils/setting';
import { validate } from '../middleware/validate';
import { checkPermission } from '../middleware/auth';
import { BizError } from '../middleware/errorHandler';
// ★ P4 切读层：本文件各表均已归一，裸 db() 全部走 tbl()/tblIns()；开关关时逐字节等价。
import { tbl, tblIns } from '../../teaching/shared/uniTable';

export const refundRouter = Router();

const TABLE = 't_class_refund';
const LOG_TABLE = 't_class_refund_log';
const STUDENT_TABLE = 't_class_student';

const DB = 'sms_class_jh';
const STAGE = 'jh' as const;

/** 各状态当前处理人（推导） */
const HANDLER_NAME: Record<number, string> = {
  [RefundStatus.DRAFT]: '班主任',
  [RefundStatus.PENDING_MANAGER]: '教质/学术经理',
  [RefundStatus.PENDING_ACADEMIC]: '教务老师',
  [RefundStatus.PENDING_FINANCE]: '财务',
  [RefundStatus.PENDING_PRINCIPAL]: '校长',
  [RefundStatus.REFUNDED]: '—',
  [RefundStatus.REJECTED]: '班主任',
};

/** 退费行 → 实体（双返回 + 处理人推导） */
function toRefund(r: any) {
  return {
    refundId: r.id,
    studentId: r.student_id,
    studentNo: r.student_no,
    studentName: r.student_name,
    classId: r.class_id,
    className: r.class_name,
    deptCode: r.dept_code,
    feeType: r.fee_type,
    feeTypeName: nameOf(FEE_TYPE_NAME, r.fee_type),
    refundAmount: r.refund_amount,
    refundReason: r.refund_reason,
    headTeacherOpinion: r.head_teacher_opinion,
    applyDate: r.apply_date,
    isFeeUsedUp: r.is_fee_used_up,
    refundStatus: r.refund_status,
    refundStatusName: nameOf(REFUND_STATUS_NAME, r.refund_status),
    currentHandlerName: r.current_handler_name ?? HANDLER_NAME[r.refund_status] ?? '',
    applyUserId: r.apply_user_id,
    applyUserName: r.apply_user_name,
    approveUserId: r.approve_user_id,
    approveUserName: r.approve_user_name,
    approveTime: r.approve_time,
    rejectReason: r.reject_reason,
    thresholdAmount: r.threshold_amount,
    payOutTime: r.pay_out_time,
    payOutVoucherNo: r.pay_out_voucher_no,
  };
}

/** 写退费审批日志 */
async function writeRefundLog(
  refundId: string,
  nodeStatus: number,
  approveResult: number,
  user?: { userId?: string; userName?: string },
  rejectReason?: string,
): Promise<void> {
  const now = new Date();
  await tblIns(db, DB, LOG_TABLE, STAGE, {
    id: randomUUID(),
    refund_id: refundId,
    node_status: nodeStatus,
    approve_user_id: user?.userId ?? null,
    approve_user_name: user?.userName ?? null,
    approve_time: now,
    approve_result: approveResult,
    reject_reason: rejectReason ?? null,
    is_deleted: false,
    create_time: now,
    create_by: user?.userId || 'system',
  });
}

/* ============================================================
 * 退费建单（供「退学审批通过」自动调用 —— F-01）
 *
 * ⚠️ 背景：设计上「退学 → 教务核算 → 财务退款」是一条链，退学审批通过后
 *    应自动生成退费单（与原型一致）。否则退学与退费是断开的，需人工再建单。
 * ============================================================ */

/** 自动建单入参 */
export interface QuitRefundInput {
  /** 退费类型 1学费 2住宿费 3餐费 4保险费 */
  feeType: number;
  /** 退费金额（分） */
  refundAmount: number;
  /** 退费原因（缺省用标准话术） */
  reason?: string;
  /** 申请日期 YYYY-MM-DD（缺省用今天） */
  applyDate?: string;
  applyUserId?: string;
  applyUserName?: string;
}

/**
 * 退学审批通过后自动生成「待提交」退费单。
 *
 * @returns 新退费单 ID；若该学生已存在未驳回的退费单（避免重复建单）或金额缺失，返回 null。
 */
export async function createQuitRefund(stu: any, input: QuitRefundInput): Promise<string | null> {
  if (!input.refundAmount || input.refundAmount <= 0) return null;

  // 幂等：同一学生已有「未驳回」的退费单则不再重复生成
  const existing = await tbl(db, DB, TABLE, STAGE)
    .where({ student_id: stu.id, is_deleted: false })
    .whereNot('refund_status', RefundStatus.REJECTED)
    .first();
  if (existing) return null;

  const threshold = await getNumberSetting('refundThresholdAmount');
  const id = randomUUID();
  const now = new Date();
  const applyDate = input.applyDate || now.toISOString().slice(0, 10);

  await tblIns(db, DB, TABLE, STAGE, {
    id,
    student_id: stu.id,
    student_no: stu.student_no,
    student_name: stu.student_name,
    class_id: stu.class_id ?? null,
    class_name: stu.class_name ?? null,
    dept_code: stu.dept_code ?? 1,
    fee_type: input.feeType,
    refund_amount: input.refundAmount,
    refund_reason: input.reason || '退学已审批，按未消耗课时核算应退费用。',
    head_teacher_opinion: null,
    apply_date: applyDate,
    is_fee_used_up: false,
    refund_status: RefundStatus.DRAFT,
    current_handler_name: HANDLER_NAME[RefundStatus.DRAFT],
    apply_user_id: input.applyUserId ?? null,
    apply_user_name: input.applyUserName ?? null,
    threshold_amount: threshold,
    is_deleted: false,
    create_time: now,
    create_by: input.applyUserId || 'system',
  });

  await writeOpLog({
    module: 'refund',
    bizType: '退费',
    bizId: id,
    studentId: stu.id,
    classId: stu.class_id,
    opUserId: input.applyUserId,
    opUserName: input.applyUserName,
    opDesc: `退学审批通过，自动生成退费单（学生 ${stu.student_name}，金额 ${(input.refundAmount / 100).toFixed(2)} 元）`,
    afterValue: { refundStatus: RefundStatus.DRAFT, refundAmount: input.refundAmount, auto: true },
  });

  return id;
}

/* ============================================================
 * 1. 可选学生（退学且费用未用完）
 *   GET /api/class/refund/eligible
 * ============================================================ */

refundRouter.get(
  '/eligible',
  checkPermission('class:refund:view'),
  validate(z.object({ keyword: z.string().optional() })),
  wrap(async (req, res) => {
    const q = (req as any).validated as { keyword?: string };
    const query = tbl(db, DB, STUDENT_TABLE, STAGE).where({ student_status: StudentStatus.QUIT, is_deleted: false });
    if (q.keyword) {
      query.andWhere((qb) => {
        qb.where('student_no', 'like', `%${q.keyword}%`).orWhere('student_name', 'like', `%${q.keyword}%`);
      });
    }
    const students = await query.select('id', 'student_no', 'student_name', 'class_name');

    // 过滤「费用已用完」（存在 is_fee_used_up=true 的退费单）
    const usedUp = await tbl(db, DB, TABLE, STAGE)
      .where({ is_deleted: false, is_fee_used_up: true })
      .select('student_id');
    const usedUpSet = new Set<string>(usedUp.map((r: any) => r.student_id));

    const list = students
      .filter((s: any) => !usedUpSet.has(s.id))
      .map((s: any) => ({
        studentId: s.id,
        studentNo: s.student_no,
        studentName: s.student_name,
        className: s.class_name,
      }));

    res.json(ok(list));
  }),
);

/* ============================================================
 * 2. 退费列表
 *   GET /api/class/refund/list
 * ============================================================ */

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
  refundStatus: z.coerce.number().int().optional(),
  classId: z.string().optional(),
  feeType: z.coerce.number().int().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  keyword: z.string().optional(),
});

refundRouter.get(
  '/list',
  checkPermission('class:refund:view'),
  validate(listSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as z.infer<typeof listSchema>;
    const query = tbl(db, DB, TABLE, STAGE).where('is_deleted', false);
    if (q.refundStatus) query.andWhere('refund_status', q.refundStatus);
    if (q.classId) query.andWhere('class_id', q.classId);
    if (q.feeType) query.andWhere('fee_type', q.feeType);
    if (q.startDate) query.andWhere('apply_date', '>=', q.startDate);
    if (q.endDate) query.andWhere('apply_date', '<=', q.endDate);
    if (q.keyword) {
      query.andWhere((qb) => {
        qb.where('student_no', 'like', `%${q.keyword}%`).orWhere('student_name', 'like', `%${q.keyword}%`);
      });
    }

    const [{ total }] = (await query.clone().count({ total: '*' })) as Array<{ total: number }>;
    const rows = await query
      .clone()
      .select('*')
      .orderBy('create_time', 'desc')
      .limit(q.size)
      .offset((q.page - 1) * q.size);

    res.json(page(rows.map(toRefund), Number(total), q));
  }),
);

/* ============================================================
 * 3. 退费详情（含审批日志）
 *   GET /api/class/refund/detail?id=xxx
 * ============================================================ */

refundRouter.get(
  '/detail',
  checkPermission('class:refund:view'),
  validate(z.object({ id: z.string().min(1, '必须传 id') })),
  wrap(async (req, res) => {
    const { id } = (req as any).validated as { id: string };
    const refund = await tbl(db, DB, TABLE, STAGE).where({ id, is_deleted: false }).first();
    if (!refund) throw new BizError(BizCode.REFUND_NOT_FOUND, '退费单不存在');

    const logs = await tbl(db, DB, LOG_TABLE, STAGE).where({ refund_id: id, is_deleted: false }).orderBy('approve_time', 'asc');
    res.json(
      ok({
        ...toRefund(refund),
        logs: logs.map((l: any) => ({
          logId: l.id,
          refundId: l.refund_id,
          nodeStatus: l.node_status,
          nodeStatusName: nameOf(REFUND_STATUS_NAME, l.node_status),
          approveUserId: l.approve_user_id,
          approveUserName: l.approve_user_name,
          approveTime: l.approve_time,
          approveResult: l.approve_result,
          rejectReason: l.reject_reason,
        })),
      }),
    );
  }),
);

/* ============================================================
 * 4. 新增退费
 *   POST /api/class/refund/add
 * ============================================================ */

const saveSchema = z.object({
  studentId: z.string().min(1, '学生必填'),
  feeType: z.coerce.number().int().min(1).max(4, '退费类型只能是 1~4'),
  refundAmount: z.coerce.number().int().positive('退费金额必须为正整数（分）'),
  refundReason: z.string().min(1, '退费原因必填'),
  applyDate: z.string().min(1, '申请日期必填'),
  headTeacherOpinion: z.string().max(500).optional(),
  isFeeUsedUp: z.coerce.boolean().optional(),
});

refundRouter.post(
  '/add',
  checkPermission('class:refund:add'),
  validate(saveSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof saveSchema>;

    const stu = await tbl(db, DB, STUDENT_TABLE, STAGE).where({ id: body.studentId, is_deleted: false }).first();
    if (!stu) throw new BizError(BizCode.STUDENT_NOT_FOUND, '学生不存在');
    if (stu.student_status !== StudentStatus.QUIT) {
      throw new BizError(BizCode.BUSINESS_RULE_VIOLATION, '仅「退学」状态的学生可申请退费');
    }
    if (body.isFeeUsedUp) {
      throw new BizError(BizCode.FEE_USED_UP, '该学生费用已用完，不可退费');
    }

    const threshold = await getNumberSetting('refundThresholdAmount');
    const id = randomUUID();
    const now = new Date();
    await tblIns(db, DB, TABLE, STAGE, {
      id,
      student_id: stu.id,
      student_no: stu.student_no,
      student_name: stu.student_name,
      class_id: stu.class_id ?? null,
      class_name: stu.class_name ?? null,
      dept_code: stu.dept_code ?? 1,
      fee_type: body.feeType,
      refund_amount: body.refundAmount,
      refund_reason: body.refundReason,
      head_teacher_opinion: body.headTeacherOpinion ?? null,
      apply_date: body.applyDate,
      is_fee_used_up: false,
      refund_status: RefundStatus.DRAFT,
      current_handler_name: HANDLER_NAME[RefundStatus.DRAFT],
      apply_user_id: req.user?.userId ?? null,
      apply_user_name: req.user?.userName ?? null,
      threshold_amount: threshold,
      is_deleted: false,
      create_time: now,
      create_by: req.user?.userId || 'system',
    });

    await writeOpLog({
      module: 'refund',
      bizType: '退费',
      bizId: id,
      studentId: stu.id,
      classId: stu.class_id,
      opUserId: req.user?.userId,
      opUserName: req.user?.userName,
      opDesc: `发起退费申请（学生 ${stu.student_name}，金额 ${(body.refundAmount / 100).toFixed(2)} 元）`,
      afterValue: { refundStatus: RefundStatus.DRAFT, refundAmount: body.refundAmount },
    });

    res.json(ok({ id }, '新增成功'));
  }),
);

/* ============================================================
 * 5. 修改退费（仅待提交 status=1）
 *   PUT /api/class/refund/update
 * ============================================================ */

refundRouter.put(
  '/update',
  checkPermission('class:refund:edit'),
  validate(saveSchema.extend({ id: z.string().min(1, '必须传 id') })),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof saveSchema> & { id: string };

    const refund = await tbl(db, DB, TABLE, STAGE).where({ id: body.id, is_deleted: false }).first();
    if (!refund) throw new BizError(BizCode.REFUND_NOT_FOUND, '退费单不存在');
    if (refund.refund_status !== RefundStatus.DRAFT) {
      throw new BizError(BizCode.ILLEGAL_STATE_TRANSITION, '仅「待提交」状态可修改');
    }
    if (body.isFeeUsedUp) {
      throw new BizError(BizCode.FEE_USED_UP, '该学生费用已用完，不可退费');
    }

    await tbl(db, DB, TABLE, STAGE).where({ id: body.id }).update({
      fee_type: body.feeType,
      refund_amount: body.refundAmount,
      refund_reason: body.refundReason,
      head_teacher_opinion: body.headTeacherOpinion ?? null,
      apply_date: body.applyDate,
      update_time: new Date(),
      update_by: req.user?.userId || 'system',
    });

    res.json(ok(null, '修改成功'));
  }),
);

/* ============================================================
 * 6. 提交退费（1→2）
 *   POST /api/class/refund/submit
 * ============================================================ */

refundRouter.post(
  '/submit',
  checkPermission('class:refund:add'),
  validate(z.object({ id: z.string().min(1, '必须传 id') })),
  wrap(async (req, res) => {
    const { id } = (req as any).validated as { id: string };
    const refund = await tbl(db, DB, TABLE, STAGE).where({ id, is_deleted: false }).first();
    if (!refund) throw new BizError(BizCode.REFUND_NOT_FOUND, '退费单不存在');
    if (refund.refund_status !== RefundStatus.DRAFT) {
      throw new BizError(BizCode.ILLEGAL_STATE_TRANSITION, '仅「待提交」状态可提交');
    }

    await tbl(db, DB, TABLE, STAGE).where({ id }).update({
      refund_status: RefundStatus.PENDING_MANAGER,
      current_handler_name: HANDLER_NAME[RefundStatus.PENDING_MANAGER],
      update_time: new Date(),
      update_by: req.user?.userId || 'system',
    });

    res.json(ok(null, '提交成功'));
  }),
);

/* ============================================================
 * 7. 退费审批（按当前状态推进）
 *   POST /api/class/refund/approve
 *   - 2→3；3→(金额>阈值?5:4)；5→4；4→6（出款）
 * ============================================================ */

refundRouter.post(
  '/approve',
  checkPermission('class:refund:approve'),
  validate(z.object({ id: z.string().min(1, '必须传 id'), remark: z.string().max(500).optional() })),
  wrap(async (req, res) => {
    const body = (req as any).validated as { id: string; remark?: string };

    const refund = await tbl(db, DB, TABLE, STAGE).where({ id: body.id, is_deleted: false }).first();
    if (!refund) throw new BizError(BizCode.REFUND_NOT_FOUND, '退费单不存在');

    const cur = refund.refund_status as RefundStatus;
    const now = new Date();
    let next: RefundStatus;
    let extra: Record<string, any> = {};

    switch (cur) {
      case RefundStatus.PENDING_MANAGER:
        next = RefundStatus.PENDING_ACADEMIC;
        break;
      case RefundStatus.PENDING_ACADEMIC:
        // 超阈值 → 待校长审批；否则 → 待财务出款
        next =
          Number(refund.refund_amount) > Number(refund.threshold_amount ?? 0)
            ? RefundStatus.PENDING_PRINCIPAL
            : RefundStatus.PENDING_FINANCE;
        break;
      case RefundStatus.PENDING_PRINCIPAL:
        next = RefundStatus.PENDING_FINANCE;
        break;
      case RefundStatus.PENDING_FINANCE:
        next = RefundStatus.REFUNDED;
        extra = {
          pay_out_time: now,
          pay_out_voucher_no: `PO${now.getTime()}`,
        };
        break;
      default:
        throw new BizError(
          BizCode.ILLEGAL_STATE_TRANSITION,
          `当前状态「${nameOf(REFUND_STATUS_NAME, cur)}」不可审批`,
        );
    }

    await tbl(db, DB, TABLE, STAGE).where({ id: body.id }).update({
      refund_status: next,
      current_handler_name: HANDLER_NAME[next],
      approve_user_id: req.user?.userId ?? null,
      approve_user_name: req.user?.userName ?? null,
      approve_time: now,
      ...extra,
      update_time: now,
      update_by: req.user?.userId || 'system',
    });

    await writeRefundLog(body.id, cur, 1, req.user);

    await writeOpLog({
      module: 'refund',
      bizType: '退费',
      bizId: body.id,
      studentId: refund.student_id,
      opUserId: req.user?.userId,
      opUserName: req.user?.userName,
      opDesc: `退费审批：${nameOf(REFUND_STATUS_NAME, cur)} → ${nameOf(REFUND_STATUS_NAME, next)}`,
      beforeValue: { refundStatus: cur },
      afterValue: { refundStatus: next },
    });

    res.json(ok({ refundStatus: next }, '审批成功'));
  }),
);

/* ============================================================
 * 8. 退费驳回（→7）
 *   POST /api/class/refund/reject
 * ============================================================ */

refundRouter.post(
  '/reject',
  checkPermission('class:refund:approve'),
  validate(z.object({ id: z.string().min(1, '必须传 id'), rejectReason: z.string().min(1, '驳回原因必填') })),
  wrap(async (req, res) => {
    const body = (req as any).validated as { id: string; rejectReason: string };

    const refund = await tbl(db, DB, TABLE, STAGE).where({ id: body.id, is_deleted: false }).first();
    if (!refund) throw new BizError(BizCode.REFUND_NOT_FOUND, '退费单不存在');
    if ([RefundStatus.REFUNDED, RefundStatus.REJECTED].includes(refund.refund_status)) {
      throw new BizError(BizCode.ILLEGAL_STATE_TRANSITION, '该退费单已终态，不可驳回');
    }

    const now = new Date();
    await tbl(db, DB, TABLE, STAGE).where({ id: body.id }).update({
      refund_status: RefundStatus.REJECTED,
      current_handler_name: HANDLER_NAME[RefundStatus.REJECTED],
      approve_user_id: req.user?.userId ?? null,
      approve_user_name: req.user?.userName ?? null,
      approve_time: now,
      reject_reason: body.rejectReason,
      update_time: now,
      update_by: req.user?.userId || 'system',
    });

    await writeRefundLog(body.id, refund.refund_status, 2, req.user, body.rejectReason);

    await writeOpLog({
      module: 'refund',
      bizType: '退费',
      bizId: body.id,
      studentId: refund.student_id,
      opUserId: req.user?.userId,
      opUserName: req.user?.userName,
      opDesc: `退费驳回：${body.rejectReason}`,
      beforeValue: { refundStatus: refund.refund_status },
      afterValue: { refundStatus: RefundStatus.REJECTED },
    });

    res.json(ok(null, '已驳回'));
  }),
);

/* ============================================================
 * 9. 退费导出
 *   GET /api/class/refund/export
 * ============================================================ */

refundRouter.get(
  '/export',
  checkPermission('class:refund:export'),
  validate(listSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as z.infer<typeof listSchema>;
    const query = tbl(db, DB, TABLE, STAGE).where('is_deleted', false);
    if (q.refundStatus) query.andWhere('refund_status', q.refundStatus);
    if (q.classId) query.andWhere('class_id', q.classId);
    if (q.feeType) query.andWhere('fee_type', q.feeType);
    if (q.startDate) query.andWhere('apply_date', '>=', q.startDate);
    if (q.endDate) query.andWhere('apply_date', '<=', q.endDate);

    const rows = await query.clone().select('*').orderBy('create_time', 'desc');
    res.json(ok(rows.map(toRefund)));
  }),
);

export default refundRouter;
