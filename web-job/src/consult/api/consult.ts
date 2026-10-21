/**
 * 咨询模块接口调用
 *
 * ⚠️ 要点：
 *   1. 路径和后端 /api/consult/xxx 完全一致
 *   2. 返回类型从 shared-types 里引，字段写错会编译报错
 *   3. 返回类型写的是「data 里的类型」（http.xxx 已解包）
 */

import { http } from './request';
import type {
  PageData,
  ConsultStudentListItem,
  ConsultStudent,
  ConsultStudentQuery,
  ConsultStudentSavePayload,
  ConsultStudentExtraPayload,
  ConsultFeeOrder,
  ConsultFeeOrderQuery,
  ConsultFeeCreatePayload,
  ConsultFeeCreateResult,
  ConsultFeeStats,
  // ★ 2026-10-19 作废收款单返回值
  ConsultFeeCancelResult,
  ConsultRefundOrder,
  ConsultRefundQuery,
  ConsultRefundApplyPayload,
  ConsultRefundCalcPayload,
  ConsultRefundCalcResult,
  ConsultRefundStats,
  ConsultAccount,
  // ⚠️ 2026-10-03：ConsultAccountQuery / ConsultAccountSavePayload / ConsultAccountStats
  //    随账号管理页一起移除（已无调用方）。
  ConsultLoginPayload,
  ConsultLoginResult,
  ApproveCenterData,
  AssignOwnerPayload,
  InterviewResultPayload,
  AssignClassPayload,
  RecordLossPayload,
  LossRecordItem,
  LossStats,
  NotEnrolledItem,
  FinanceStandardView,
  FormalPayMode,
  FeeType,
  ConsultToFormalResult,
  ConsultSupplementPlan,
  // ★ 2026-10-16 分期付款
  ConsultInstallmentPlan,
  ConsultInstallmentCreatePayload,
  ConsultInstallmentPayPayload,
  ConsultStudentLedger,
} from 'shared-types/consult';

/* ============================================================
 * 登录 / 账号
 * ============================================================ */

/** 登录 */
export function login(payload: ConsultLoginPayload): Promise<ConsultLoginResult> {
  return http.post<ConsultLoginResult>('/api/consult/account/login', payload);
}

/** 当前登录人信息 */
export function fetchProfile(): Promise<ConsultAccount> {
  return http.get<ConsultAccount>('/api/consult/account/profile');
}

/** 岗位角色字典 */
export function fetchRoles(): Promise<Array<{ role: string; roleName: string; desc: string }>> {
  return http.get('/api/consult/account/roles');
}

/* ---- 账号管理（管理员）----
 *
 * ⚠️⚠️ 2026-10-03 用户指令：
 *   「账号管理和权限管理内的账号管理是同一个功能，权限管理内的账号管理是唯一的，
 *     账号管理删除，功能一致。」
 *   → 本模块的账号管理页（views/AccountList.vue）已删除，
 *     下面这 7 个账号维护接口（list / stats / add / update / reset-password /
 *     toggle / delete）在前端【已无调用方】，一并移除。
 *
 *   ⚠️ 后端 /api/consult/account/* 这几个接口【暂留】作为兜底通道，
 *     与门户侧的处置保持一致（门户 portal.ts 也是删前端、留后端）。
 *     后续如需彻底下线，由咨询模块负责人在自己的里程碑里处理。
 */

/* ============================================================
 * 学生管理
 * ============================================================ */

/** 学生列表 */
export function fetchStudentList(
  query: ConsultStudentQuery,
): Promise<PageData<ConsultStudentListItem>> {
  return http.get<PageData<ConsultStudentListItem>>('/api/consult/student/list', query);
}

/** 学生详情（含跟进历史 / 缴费单 / 退费单） */
export function fetchStudentDetail(id: string): Promise<ConsultStudent> {
  return http.get<ConsultStudent>('/api/consult/student/detail', { id });
}

/** 新增学生 */
export function addStudent(payload: ConsultStudentSavePayload): Promise<{ id: string }> {
  return http.post<{ id: string }>('/api/consult/student/add', payload);
}

/** 完善档案（扩展字段） */
export function updateStudentExtra(payload: ConsultStudentExtraPayload): Promise<null> {
  return http.put<null>('/api/consult/student/update-extra', payload);
}

/** 分配跟进人（经理专属） */
export function assignOwner(payload: AssignOwnerPayload): Promise<null> {
  return http.post<null>('/api/consult/student/assign', payload);
}

/** 领取（咨询师自助认领） */
export function claimStudent(consultStudentId: string): Promise<null> {
  return http.post<null>('/api/consult/student/claim', { consultStudentId });
}

/** 录入面试结果 */
export function submitInterview(payload: InterviewResultPayload): Promise<null> {
  return http.post<null>('/api/consult/student/interview', payload);
}

/** 分班（前置校验：试学费已到账） */
export function assignClass(payload: AssignClassPayload): Promise<null> {
  return http.post<null>('/api/consult/student/assign-class', payload);
}

/**
 * 入班 / 分班（咨询 → 班级管理 / 教学管理初高）
 *
 * 不带 classId：把学员推送到大学部「待接收学员」，由班主任接收并建档。
 * 带 classId（★ 2026-10-05 分班）：目标 = 大学部 / 初高，**都是分班即入班**。
 *   ★ 2026-10-20 用户口径「入班和分班合并」：大学部不再进「待接收学员」，
 *     推送后立刻由班级侧建档入班，学部（初中/高中/大学部）直接能看到学生。
 *   幂等：按 consultNo 去重，重复确认返回 duplicate=true，不会重复建档。
 */
export function enrollToClass(
  id: string,
  classId?: string,
  module?: 'class' | 'class-jh',
): Promise<{ consultNo: string; inserted: number; skipped: number; duplicate?: boolean }> {
  return http.post<{ consultNo: string; inserted: number; skipped: number; duplicate?: boolean }>(
    '/api/consult/student/enroll-to-class',
    { id, classId, module },
  );
}

/** 开放班级聚合（★ 2026-10-05 分班弹窗数据源：大学部 + 初高） */
export interface OpenClassItem {
  id?: string;
  classId?: string;
  className: string;
  stage?: number;
  stageName?: string;
  classStatusName?: string;
  headTeacherName?: string | null;
  studentCount?: number;
}
export function fetchOpenClasses(): Promise<{ univ: OpenClassItem[]; jh: OpenClassItem[] }> {
  return http.get<{ univ: OpenClassItem[]; jh: OpenClassItem[] }>(
    '/api/consult/student/open-classes',
  );
}

/**
 * ★ 2026-10-06 分班状态（批量）
 *
 * 「收款与缴费」页用它判定「分班」按钮是否可点：
 *   已分班（待接收 / 已接收 / 初高已入班）→ 不可再分派到其他班级；
 *   被班主任驳回 → 可以重新分派。
 */
export interface AssignStatusItem {
  state: 'none' | 'pending' | 'received' | 'rejected' | 'jh' | 'unknown';
  label: string;
  classId?: string | null;
  className?: string | null;
  canAssign: boolean;
}
export function fetchAssignStatus(ids: string[]): Promise<Record<string, AssignStatusItem>> {
  return http.post<Record<string, AssignStatusItem>>('/api/consult/student/assign-status', { ids });
}

/** 记录流失 */
export function recordLoss(payload: RecordLossPayload): Promise<null> {
  return http.post<null>('/api/consult/student/loss', payload);
}

/** 咨询师选项（分配用） */
export function fetchConsultants(): Promise<Array<{ id: string; name: string; title: string }>> {
  return http.get('/api/consult/student/consultants');
}

/**
 * 转正式（流程图：「是否一次性付清学费」）
 *
 * @param payMode  'FULL' 一次性缴清（把缺口全发） / 'INSTALLMENT' 分笔补缴（只发勾选的）
 * @param feeTypes 分笔补缴时勾选的费用类型；不传则退化为「缺口全发」
 */
export function toFormal(
  consultStudentId: string,
  payMode: FormalPayMode = 'FULL' as FormalPayMode,
  feeTypes?: FeeType[],
  /**
   * ★ 2026-10-19 用户口径：只要缴费就要有凭证。
   *    转正式会真的建缴费单，凭证必须随单提交。
   */
  voucherUrl?: string,
  voucherNo?: string,
): Promise<ConsultToFormalResult> {
  return http.post<ConsultToFormalResult>('/api/consult/student/to-formal', {
    consultStudentId,
    payMode,
    feeTypes,
    voucherUrl,
    voucherNo,
  });
}

/**
 * 补缴明细统计（流程图：「咨询老师统计补缴金额和类型」）
 *
 * 弹窗打开时先调它，渲染「全款 ¥XXXX / 已到账 ¥XXX / 还差 学费、住宿费 ¥XXX」
 */
export function fetchSupplementPlan(consultStudentId: string): Promise<ConsultSupplementPlan> {
  return http.get<ConsultSupplementPlan>('/api/consult/student/supplement-plan', {
    consultStudentId,
  });
}

/**
 * 面试结果录入（流程图：「是否接收该学生」）
 * accepted=false → 未通过（REJECTED），`不做统计、不计入流失`
 * accepted=true + enrolled=false → 未报名（NOT_ENROLLED），可取消
 * accepted=true + enrolled=true  → 已确认当场报名，继续走报名（缴费）流程
 */
export function submitInterviewResult(
  consultStudentId: string,
  accepted: boolean,
  reason?: string,
  enrolled?: boolean,
): Promise<null> {
  return http.post<null>('/api/consult/student/interview-result', {
    consultStudentId,
    accepted,
    enrolled,
    reason,
  });
}

/**
 * 记录「未报名·待跟进」（流程图：「是否当场报名 → 否」）
 * ⚠️ 与「流失」不同：不计入流失率，可二次来访
 */
export function notEnrolled(
  consultStudentId: string,
  reason: string,
  followUpPlan?: string,
): Promise<null> {
  return http.post<null>('/api/consult/student/not-enrolled', {
    consultStudentId,
    reason,
    followUpPlan,
  });
}

/**
 * 二次来访（流程图：「是否二上/三上 → 是 → 回访跟进」）
 * 仅「未报名·待跟进」状态可调，状态回到「待面试」
 */
export function revisit(consultStudentId: string, remark?: string): Promise<null> {
  return http.post<null>('/api/consult/student/revisit', { consultStudentId, remark });
}

/**
 * 取消「未报名」（2026-10-08 新增）
 * 仅「未报名·待跟进」状态可调，状态回到「待面试」，可重新走报名流程
 */
export function cancelNotEnrolled(consultStudentId: string, remark?: string): Promise<null> {
  return http.post<null>('/api/consult/student/cancel-not-enrolled', {
    consultStudentId,
    remark,
  });
}

/* ============================================================
 * 收款与缴费
 * ============================================================ */

/** 费用单列表（每次会自动回读财务核对状态） */
export function fetchFeeList(query: ConsultFeeOrderQuery): Promise<PageData<ConsultFeeOrder>> {
  return http.get<PageData<ConsultFeeOrder>>('/api/consult/fee/list', query);
}

/** 费用单统计 */
export function fetchFeeStats(): Promise<ConsultFeeStats> {
  return http.get<ConsultFeeStats>('/api/consult/fee/stats');
}

/** 费用单详情 */
export function fetchFeeDetail(orderId: string): Promise<ConsultFeeOrder> {
  return http.get<ConsultFeeOrder>('/api/consult/fee/detail', { orderId });
}

/**
 * 发起收费（金额不传，由财务按费用标准取值 —— 规则2）
 */
export function createFees(payload: ConsultFeeCreatePayload): Promise<ConsultFeeCreateResult> {
  return http.post<ConsultFeeCreateResult>('/api/consult/fee/create', payload);
}

/**
 * ★ 2026-10-20 补费（试学转正尾款 / 差额补收，金额自定义）
 *
 * 只对「已缴过试学费」的学生开放；金额由老师手填（单位：分）。
 * 落库类型是「补费(8)」，到账后自动把试学学员转成正式在读。
 */
export interface ConsultSupplementPayload {
  consultStudentId: string;
  /** 补费金额（单位：分） */
  amount: number;
  voucherUrl: string;
  voucherNo?: string;
  payMethod?: string;
  remark?: string;
}

export function createSupplementFee(
  payload: ConsultSupplementPayload,
): Promise<{ orderId: string; orderNo: string; amount: number }> {
  return http.post<{ orderId: string; orderNo: string; amount: number }>(
    '/api/consult/fee/supplement',
    payload,
  );
}

/** 上传图片（base64 → 返回相对 URL） */
export function uploadFile(dataUrl: string, prefix?: string): Promise<{ url: string; size: number }> {
  return http.post<{ url: string; size: number }>('/api/consult/fee/upload-file', {
    dataUrl,
    prefix,
  });
}

/** 绑定缴费凭证（会同步到财务 —— 规则3-②） */
export function uploadVoucher(
  orderId: string,
  voucherUrl: string,
  voucherNo?: string,
): Promise<null> {
  return http.post<null>('/api/consult/fee/upload-voucher', { orderId, voucherUrl, voucherNo });
}

/** 被驳回后重新提交 */
export function resubmitOrder(orderId: string): Promise<null> {
  return http.post<null>('/api/consult/fee/resubmit', { orderId });
}

/**
 * ★ 2026-10-19 作废收款单（重复发起 / 发起错了）
 *
 * ⚠️ 传整批 orderIds：学生档案按批次合并显示，只作废一张会留下半截数据。
 *    已到账的单不能作废（后端会跳过并在 message 里说明），要走退费。
 */
export function cancelFeeOrders(
  orderIds: string[],
  reason?: string,
): Promise<ConsultFeeCancelResult> {
  return http.post<ConsultFeeCancelResult>('/api/consult/fee/cancel', { orderIds, reason });
}

/** 查费用标准（规则2，用于新建学生时预览金额） */
export function fetchStandard(feeType: number, deptCode?: number): Promise<FinanceStandardView> {
  return http.get<FinanceStandardView>('/api/consult/fee/standard', { feeType, deptCode });
}

/** 批量查费用标准 */
export function fetchStandardBatch(
  feeTypes: number[],
  deptCode?: number,
): Promise<{ list: FinanceStandardView[] }> {
  return http.get('/api/consult/fee/standard-batch', {
    feeTypes: feeTypes.join(','),
    deptCode,
  });
}

/* ============================================================
 * ★ 2026-10-16 分期付款
 * ============================================================ */

/** 创建分期计划（默认立刻发起第 1 期收款） */
export function createInstallment(
  payload: ConsultInstallmentCreatePayload,
): Promise<ConsultInstallmentPlan> {
  return http.post<ConsultInstallmentPlan>('/api/consult/fee/plan/create', payload);
}

/** 缴某一期 */
export function payInstallmentStage(
  payload: ConsultInstallmentPayPayload,
): Promise<ConsultInstallmentPlan> {
  return http.post<ConsultInstallmentPlan>('/api/consult/fee/plan/pay', payload);
}

/** 分期计划列表 */
export function fetchInstallmentList(query: {
  consultStudentId?: string;
  status?: number;
  keyword?: string;
  page?: number;
  size?: number;
}): Promise<PageData<ConsultInstallmentPlan>> {
  return http.get<PageData<ConsultInstallmentPlan>>('/api/consult/fee/plan/list', query);
}

/** 分期计划详情 */
export function fetchInstallmentDetail(planId: string): Promise<ConsultInstallmentPlan> {
  return http.get<ConsultInstallmentPlan>('/api/consult/fee/plan/detail', { id: planId });
}

/** 学生缴费账本（应收 / 已收 / 优惠 / 待缴） */
export function fetchStudentLedger(
  consultStudentId: string,
): Promise<ConsultStudentLedger> {
  return http.get<ConsultStudentLedger>('/api/consult/fee/plan/ledger', { consultStudentId });
}

/* ============================================================
 * 退费管理
 * ============================================================ */

/** 退费单列表 */
export function fetchRefundList(
  query: ConsultRefundQuery,
): Promise<PageData<ConsultRefundOrder>> {
  return http.get<PageData<ConsultRefundOrder>>('/api/consult/refund/list', query);
}

/** 退费统计 */
export function fetchRefundStats(): Promise<ConsultRefundStats> {
  return http.get<ConsultRefundStats>('/api/consult/refund/stats');
}

/** 退费单详情 */
export function fetchRefundDetail(id: string): Promise<ConsultRefundOrder> {
  return http.get<ConsultRefundOrder>('/api/consult/refund/detail', { id });
}

/** 退费试算（弹窗里显示的数字用它，保证和提交后一致） */
export function calcRefund(payload: ConsultRefundCalcPayload): Promise<ConsultRefundCalcResult> {
  return http.post<ConsultRefundCalcResult>('/api/consult/refund/calc', payload);
}

/** 发起退费申请 */
export function applyRefund(payload: ConsultRefundApplyPayload): Promise<{ id: string; refundNo: string }> {
  return http.post<{ id: string; refundNo: string }>('/api/consult/refund/apply', payload);
}

/**
 * 经理审批通过
 *
 * ⚠️⚠️ 2026-10-15 修复：入参字段名原本发的是 `id`，而后端
 *   `POST /api/consult/refund/approve` 的 zod schema 要的是 **`refundId`**
 *   （`z.object({ refundId: z.string().min(1) })`）。
 *   字段名对不上 → 校验直接拒掉：
 *     400「参数「refundId」类型不正确」
 *   **经理点「审批通过」永远失败**（用户 2026-10-15 反馈的现象）。
 *
 * ⚠️ 同批修掉的还有 rejectRefund / payRefund —— 三个接口都是同一个字段名问题，
 *    改的时候一定要三个一起改（少改一个就还有一个按钮点不动）。
 */
export function approveRefund(refundId: string): Promise<null> {
  return http.post<null>('/api/consult/refund/approve', { refundId });
}

/**
 * 经理驳回
 *
 * ⚠️ 同上：字段名必须是 `refundId`（不是 id），且 `rejectReason` 必填。
 */
export function rejectRefund(refundId: string, rejectReason: string): Promise<null> {
  return http.post<null>('/api/consult/refund/reject', { refundId, rejectReason });
}

/**
 * 财务打款（演示：财务角色或手工标记）
 *
 * ⚠️ 同上：字段名必须是 `refundId`。
 *   另外后端 `/pay` 收的是 `payMethod / payRef / payTo`，
 *   原先前端发的是 `payVoucherNo` —— 名字不存在，即使字段名对了也会丢参数。
 */
export function payRefund(
  refundId: string,
  payload: { payMethod?: string; payRef?: string; payTo?: string } = {},
): Promise<null> {
  return http.post<null>('/api/consult/refund/pay', { refundId, ...payload });
}

/** 从财务同步退费状态 */
export function syncRefund(id: string): Promise<{ status: number; statusName: string }> {
  return http.post('/api/consult/refund/sync', { id });
}

/** 退费预填（算试学天数和已到账金额） */
export function fetchRefundPrefill(
  consultStudentId: string,
): Promise<ConsultRefundCalcResult & { incomeAmount: number; trialStart?: string }> {
  return http.get('/api/consult/refund/prefill', { consultStudentId });
}

/* ============================================================
 * 审批中心
 * ============================================================ */

/** 审批中心（待分配 + 待审批退费，一次返回） */
export function fetchApproveCenter(): Promise<ApproveCenterData> {
  return http.get<ApproveCenterData>('/api/consult/approve/center');
}

/* ============================================================
 * 流失记录
 * ============================================================ */

/** 流失记录列表 */
export function fetchLossList(query: {
  page?: number;
  size?: number;
  keyword?: string;
}): Promise<PageData<LossRecordItem>> {
  return http.get<PageData<LossRecordItem>>('/api/consult/loss/list', query);
}

/** 流失统计（含流失率） */
export function fetchLossStats(): Promise<LossStats> {
  return http.get<LossStats>('/api/consult/loss/stats');
}

/**
 * 未报名·待跟进列表（流程图「是否当场报名 → 否」）
 *
 * ⚠️ 与流失列表分开查：未报名不计入流失率，且这部分学生支持二次来访
 */
export function fetchNotEnrolledList(query: {
  page?: number;
  size?: number;
  studentName?: string;
  ownerName?: string;
  keyword?: string;
}): Promise<PageData<NotEnrolledItem>> {
  return http.get<PageData<NotEnrolledItem>>('/api/consult/loss/not-enrolled', query);
}
