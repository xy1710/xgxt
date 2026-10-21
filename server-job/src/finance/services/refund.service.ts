/**
 * 退费管理 · 业务逻辑
 * 负责人：周铭（财务管理）
 *
 * ⚠️ 退费是「审批链」业务，状态流转顺序【不可变】（数据字典 4.8）：
 *
 *    1 待提交 → 2 待经理审批 → 3 待教务核算 → 4 待财务出款 → 5 待校长审批 → 6 已退费
 *                                       ↓ 任一环节被打回
 *                                      7 已驳回
 *
 *    ⚠️ 其中 5 待校长审批是「有条件」的：金额超阈值才有，
 *       所以 4 → 6 直达也是合法的（小额退费）。
 *
 *    财务的职责边界：只在「4 待财务出款」这一步动手，
 *    前面的经理审批 / 教务核算 / 校长审批都不是财务的活。
 *    但财务要能【看到】整条链走到哪了（时间轴）。
 */

import { randomUUID } from 'crypto';
import {
  BizCode,
  FEE_TYPE_NAME,
  REFUND_STATUS_NAME,
  DEPT_NAME,
  RefundStatus,
} from 'shared-types/finance';
import { db } from '../utils/db';
import { BizError } from '../middleware/errorHandler';
import { nextRefundOrderNo, nextBillNoForRefund } from '../utils/orderNo';
import { toDateStr, toTimeStr } from './fee.service';
import { REFUND_SOURCE_NAME } from 'shared-types/finance';

export const REFUND_TABLE = 't_finance_refund';
export const BILL_TABLE = 't_finance_bill';

/** 退费行 → 前端契约格式 */
export function toRefundListItem(r: any) {
  return {
    id: r.id,
    orderNo: r.order_no,
    studentId: r.student_id,
    studentNo: r.student_no,
    studentName: r.student_name,
    classId: r.class_id ?? undefined,
    className: r.class_name ?? undefined,
    deptCode: r.dept_code ?? undefined,
    deptName: r.dept_code ? DEPT_NAME[r.dept_code] : undefined,
    refundType: r.refund_type,
    refundTypeName: FEE_TYPE_NAME[r.refund_type] || '',
    refundAmount: Number(r.refund_amount),
    refundReason: r.refund_reason,
    refundStatus: r.refund_status,
    refundStatusName: REFUND_STATUS_NAME[r.refund_status] || '',
    sourceType: r.source_type,
    sourceName: REFUND_SOURCE_NAME[r.source_type] || '',
    applicantName: r.applicant_name ?? undefined,
    applyTime: toTimeStr(r.apply_time),
    pushedTime: toTimeStr(r.pushed_time),
    // ⚠️ 只有「待财务出款」才能出款 —— 这是财务模块的权限边界
    canRefund: r.refund_status === RefundStatus.PENDING_FINANCE,
    isInBill: !!r.is_in_bill,
  };
}

/** 退费行 → 详情（含审批链时间轴） */
export function toRefundDetail(r: any) {
  return {
    ...toRefundListItem(r),
    managerApproveTime: toTimeStr(r.manager_approve_time),
    managerApproveBy: r.manager_approve_by ?? undefined,
    academicCheckTime: toTimeStr(r.academic_check_time),
    academicCheckBy: r.academic_check_by ?? undefined,
    principalApproveTime: toTimeStr(r.principal_approve_time),
    principalApproveBy: r.principal_approve_by ?? undefined,
    financePayTime: toTimeStr(r.finance_pay_time),
    financePayBy: r.finance_pay_by ?? undefined,
    rejectReason: r.reject_reason ?? undefined,
    attachmentUrl: r.attachment_url ?? undefined,
    remark: r.remark ?? undefined,
    createTime: toTimeStr(r.create_time) || '',
  };
}

/** 构造列表查询条件 */
export function buildRefundQuery(q: any) {
  const query = db(REFUND_TABLE).where('is_deleted', false);

  if (q.studentNo) query.andWhere('student_no', 'like', `%${q.studentNo}%`);
  if (q.studentName) query.andWhere('student_name', 'like', `%${q.studentName}%`);
  if (q.classId) query.andWhere('class_id', q.classId);
  if (q.deptCode) query.andWhere('dept_code', q.deptCode);
  if (q.refundStatus) query.andWhere('refund_status', q.refundStatus);
  if (q.startDate) query.andWhere('apply_time', '>=', `${q.startDate} 00:00:00`);
  if (q.endDate) query.andWhere('apply_time', '<=', `${q.endDate} 23:59:59`);
  if (q.keyword) {
    query.andWhere((qb: any) => {
      qb.where('student_no', 'like', `%${q.keyword}%`)
        .orWhere('student_name', 'like', `%${q.keyword}%`)
        .orWhere('order_no', 'like', `%${q.keyword}%`);
    });
  }
  return query;
}

/**
 * 提交退费申请（上游模块审批通过后上报；财务也可代提交）
 *
 * ⭐ 2026-10-15 修正：落库状态从「1 待提交」改为「4 待财务出款」
 *
 * 【原来的错】
 *   这里硬编码 `RefundStatus.DRAFT`（待提交），但本接口的实际调用方
 *   **全都是已经走完自己审批链的上游模块**：
 *     · 咨询 → 经理审批通过后上报
 *     · 就业 / 教学·初高 / 班级 → 各自审批通过后上报（utils/financeClient）
 *   咨询侧的映射常量 `CONSULT_TO_FINANCE_REFUND_STATUS` 也白纸黑字写着
 *     「经理批准后上报 → 财务侧 4 待财务出款」。
 *   落成「待提交」的后果：列表项 `canRefund=false` → **财务看不到「出款」按钮，
 *   整条退费流程卡死在财务这一步**（用户 2026-10-15 反馈的现象）。
 *
 * 【为什么是 4 而不是别的】
 *   财务侧不需要再走一遍审批 —— 上游已经审过了，财务的职责只是「出款」。
 *   所以上报即落到「待财务出款」；财务点「退费」后由 payRefund 转「6 已退费」。
 */
export async function applyRefund(
  body: any,
  operator: { userId: string; userName: string },
): Promise<{ id: string; orderNo: string }> {
  const orderNo = await nextRefundOrderNo();
  const id = randomUUID();
  const now = new Date();

  await db(REFUND_TABLE).insert({
    id,
    create_time: now,
    create_by: operator.userId,
    is_deleted: false,
    order_no: orderNo,
    student_id: body.studentId,
    student_no: body.studentNo,
    student_name: body.studentName,
    class_id: body.classId ?? null,
    class_name: body.className ?? null,
    dept_code: body.deptCode ?? null,
    // 多选退费项目时，取第一个作为主项（数据字典里 refund_type 是单值）
    refund_type: Array.isArray(body.refundItems) && body.refundItems.length
      ? body.refundItems[0]
      : 1,
    refund_amount: body.refundAmount,
    refund_reason: body.refundReason,
    refund_status: RefundStatus.PENDING_FINANCE,
    source_type: body.sourceType ?? 1,
    apply_time: now,
    applicant_id: operator.userId,
    applicant_name: operator.userName,
    is_in_bill: false,
    attachment_url: body.attachmentUrl ?? null,
    remark: body.remark ?? null,
  });

  return { id, orderNo };
}

/**
 * 【核心】财务确认出款
 *
 * 做三件事（一个事务）：
 *   1. 校验：必须是「4 待财务出款」状态 —— 防止越权/重复出款
 *   2. 生成退费账单号，写入 t_finance_bill（bill_type = 2 退费账单）
 *   3. 回写退费单：refund_status = 6 已退费、finance_pay_time、is_in_bill = true
 *
 * ⚠️ 为什么必须先校验状态？
 *    出款是真金白银。如果允许「已退费」的单子再点一次，
 *    业务上就是重复打款 —— 这类事故在财务系统里是不可接受的。
 */
export async function payRefund(
  id: string,
  operator: { userId: string; userName: string },
  payMethod?: number,
  remark?: string,
): Promise<string> {
  return db.transaction(async (t) => {
    const row = await t(REFUND_TABLE).where({ id, is_deleted: false }).first();
    if (!row) {
      throw new BizError(BizCode.PARAM_ERROR, '退费单不存在或已被删除');
    }

    // ---- 状态校验：只允许「待财务出款」----
    if (row.refund_status === RefundStatus.REFUNDED) {
      throw new BizError(BizCode.PARAM_ERROR, '该退费单已出款，请勿重复操作');
    }
    if (row.refund_status !== RefundStatus.PENDING_FINANCE) {
      const cur = REFUND_STATUS_NAME[row.refund_status] || row.refund_status;
      throw new BizError(
        BizCode.PARAM_ERROR,
        `该退费单当前状态为「${cur}」，不能出款（只有「待财务出款」的单子才能出款）`,
      );
    }
    if (!row.refund_amount || row.refund_amount <= 0) {
      throw new BizError(BizCode.PARAM_ERROR, '退费金额异常，请先核对');
    }

    // ---- 生成账单号并记账 ----
    const billNo = await nextBillNoForRefund();
    const now = new Date();

    await t(BILL_TABLE).insert({
      id: randomUUID(),
      create_time: now,
      create_by: operator.userId,
      is_deleted: false,
      bill_no: billNo,
      bill_type: 2, // 退费账单
      source_id: row.id,
      source_no: row.order_no,
      student_id: row.student_id,
      student_no: row.student_no,
      student_name: row.student_name,
      class_id: row.class_id ?? null,
      class_name: row.class_name ?? null,
      dept_code: row.dept_code ?? null,
      head_teacher_name: null,
      fee_type: row.refund_type,
      amount: row.refund_amount,
      bill_date: toDateStr(now)!,
      operator_id: operator.userId,
      operator_name: operator.userName,
      voucher_no: null,
      pay_method: payMethod ?? null,
      remark: remark ?? `退费出款（${FEE_TYPE_NAME[row.refund_type] || ''}）`,
    });

    // ---- 回写退费单 ----
    await t(REFUND_TABLE).where({ id }).update({
      refund_status: RefundStatus.REFUNDED,
      finance_pay_time: now,
      finance_pay_by: operator.userId,
      is_in_bill: true,
      update_time: now,
      update_by: operator.userId,
      ...(remark ? { remark } : {}),
    });

    return billNo;
  });
}

/** 驳回退费单 */
export async function rejectRefund(
  id: string,
  rejectReason: string,
  operator: { userId: string; userName: string },
): Promise<void> {
  const row = await db(REFUND_TABLE).where({ id, is_deleted: false }).first();
  if (!row) {
    throw new BizError(BizCode.PARAM_ERROR, '退费单不存在或已被删除');
  }
  if (row.refund_status === RefundStatus.REFUNDED) {
    throw new BizError(BizCode.PARAM_ERROR, '该退费单已出款完成，无法驳回');
  }
  if (row.refund_status === RefundStatus.REJECTED) {
    throw new BizError(BizCode.PARAM_ERROR, '该退费单已是驳回状态');
  }
  if (!rejectReason || !rejectReason.trim()) {
    throw new BizError(BizCode.REQUIRED_FIELD_MISSING, '驳回原因必填');
  }

  await db(REFUND_TABLE).where({ id }).update({
    refund_status: RefundStatus.REJECTED,
    reject_reason: rejectReason.trim(),
    update_time: new Date(),
    update_by: operator.userId,
  });
}

/**
 * 推进审批链（供其他模块或测试用）
 *
 * ⚠️ 严格按数据字典顺序推进，不许跳步：
 *    1→2→3→4→(5)→6
 *    其中 5 是「大额才有」的校长审批，用 needPrincipal 控制
 */
export async function advanceRefund(
  id: string,
  operator: { userId: string; userName: string },
  needPrincipal = false,
): Promise<number> {
  const row = await db(REFUND_TABLE).where({ id, is_deleted: false }).first();
  if (!row) {
    throw new BizError(BizCode.PARAM_ERROR, '退费单不存在或已被删除');
  }

  const now = new Date();
  const cur = row.refund_status;

  switch (cur) {
    case RefundStatus.DRAFT:
      await db(REFUND_TABLE).where({ id }).update({
        refund_status: RefundStatus.PENDING_MANAGER,
        apply_time: row.apply_time ?? now,
        applicant_id: operator.userId,
        applicant_name: operator.userName,
        update_time: now,
        update_by: operator.userId,
      });
      return RefundStatus.PENDING_MANAGER;

    case RefundStatus.PENDING_MANAGER:
      await db(REFUND_TABLE).where({ id }).update({
        refund_status: RefundStatus.PENDING_ACADEMIC,
        manager_approve_time: now,
        manager_approve_by: operator.userId,
        update_time: now,
        update_by: operator.userId,
      });
      return RefundStatus.PENDING_ACADEMIC;

    case RefundStatus.PENDING_ACADEMIC:
      // 教务核算完 → 大额转校长审批，小额直接推财务
      await db(REFUND_TABLE).where({ id }).update({
        refund_status: needPrincipal
          ? RefundStatus.PENDING_PRINCIPAL
          : RefundStatus.PENDING_FINANCE,
        academic_check_time: now,
        academic_check_by: operator.userId,
        pushed_time: needPrincipal ? null : now,
        update_time: now,
        update_by: operator.userId,
      });
      return needPrincipal ? RefundStatus.PENDING_PRINCIPAL : RefundStatus.PENDING_FINANCE;

    case RefundStatus.PENDING_PRINCIPAL:
      await db(REFUND_TABLE).where({ id }).update({
        refund_status: RefundStatus.PENDING_FINANCE,
        principal_approve_time: now,
        principal_approve_by: operator.userId,
        pushed_time: now,
        update_time: now,
        update_by: operator.userId,
      });
      return RefundStatus.PENDING_FINANCE;

    default:
      throw new BizError(
        BizCode.PARAM_ERROR,
        `当前状态「${REFUND_STATUS_NAME[cur] || cur}」无法继续推进`,
      );
  }
}

/** 退费单号生成（供测试/其他模块引用） */
export { nextRefundOrderNo };
