import {
  ApplyStatus,
  ApplyType,
  ClassStatus,
  ConsultStatus,
  DeptCode,
  DormType,
  ExamContentType,
  ExamResult,
  ExamType,
  FeeType,
  Gender,
  NotifyType,
  OuterSyncStatus,
  PayStatus,
  RefundStatus,
  StudentStatus,
  SuspendStatus,
  UpgradeStatus,
} from 'shared-types/class';

/**
 * 枚举字典（数字枚举 → 中文名称）
 *
 * ⚠️ 取值必须与《01-公共数据字典.md》完全一致。
 * ⚠️ 接口返回时必须**双返回**：`xxx` 和 `xxxName` 同时给，前端不维护映射表。
 */

export const GenderName: Record<number, string> = {
  [Gender.MALE]: '男',
  [Gender.FEMALE]: '女',
};

/** 部门（v1.3：取消初高部，只保留大学部） */
export const DeptName: Record<number, string> = {
  [DeptCode.UNIVERSITY]: '大学部',
};

/** 学生状态（v1.2 由 11 值收敛为 5 值，见 shared-types/enums.ts「变更 4」） */
export const StudentStatusName: Record<number, string> = {
  [StudentStatus.TRIAL]: '试学',
  [StudentStatus.STUDYING]: '正式在读',
  [StudentStatus.SUSPENDED]: '休学',
  [StudentStatus.QUIT]: '退学',
  [StudentStatus.TRAINING]: '实训中',
};

export const ClassStatusName: Record<number, string> = {
  [ClassStatus.OPEN]: '开放',
  [ClassStatus.CLOSED]: '封班',
  [ClassStatus.TRAINING]: '实训中',
};

export const FeeTypeName: Record<number, string> = {
  [FeeType.TUITION]: '学费',
  [FeeType.ACCOMMODATION]: '住宿费',
  [FeeType.MEAL]: '餐费',
  [FeeType.INSURANCE]: '保险费',
  [FeeType.TRIAL_FEE]: '试学费',
};

export const PayStatusName: Record<number, string> = {
  [PayStatus.UNPAID]: '待缴',
  [PayStatus.PAID]: '已缴',
  [PayStatus.VERIFIED]: '已核对',
  // 2026-10-20：库注释里 4 就是逾期，原来漏了 → 催缴行状态显示成「未知」
  [PayStatus.OVERDUE]: '逾期',
  [PayStatus.FROZEN]: '冻结',
};

export const RefundStatusName: Record<number, string> = {
  [RefundStatus.DRAFT]: '待提交',
  [RefundStatus.PENDING_MANAGER]: '待经理审批',
  [RefundStatus.PENDING_ACADEMIC]: '待教务核算',
  [RefundStatus.PENDING_FINANCE]: '待财务出款',
  [RefundStatus.PENDING_PRINCIPAL]: '待校长审批',
  [RefundStatus.REFUNDED]: '已退费',
  [RefundStatus.REJECTED]: '已驳回',
  [RefundStatus.WITHDRAWN]: '已撤回',
};

/** 退费链上每个状态对应的处理人角色 */
export const RefundStatusHandlerRole: Record<number, string> = {
  [RefundStatus.DRAFT]: '班主任',
  [RefundStatus.PENDING_MANAGER]: '学管（教质/学术经理）',
  [RefundStatus.PENDING_ACADEMIC]: '教务老师',
  [RefundStatus.PENDING_FINANCE]: '财务',
  [RefundStatus.PENDING_PRINCIPAL]: '校长',
  [RefundStatus.REFUNDED]: '—',
  [RefundStatus.REJECTED]: '班主任',
  [RefundStatus.WITHDRAWN]: '—',
};

/** 休学 / 退学状态（v1.1 由 4 值扩为 5 值） */
export const SuspendStatusName: Record<number, string> = {
  [SuspendStatus.DRAFT]: '待提交',
  [SuspendStatus.PENDING_MANAGER]: '待经理审批',
  [SuspendStatus.PENDING_PRINCIPAL]: '待校长审批',
  [SuspendStatus.APPROVED]: '已同意',
  [SuspendStatus.REJECTED]: '已驳回',
  // ★ 2026-10-09：三块合并后统一审批链（撤回改为记状态，不再软删单据）
  [SuspendStatus.WITHDRAWN]: '已撤回',
};

export const SuspendStatusHandlerRole: Record<number, string> = {
  [SuspendStatus.DRAFT]: '班主任',
  [SuspendStatus.PENDING_MANAGER]: '学管（教质/学术经理）',
  [SuspendStatus.PENDING_PRINCIPAL]: '校长',
  [SuspendStatus.APPROVED]: '—',
  [SuspendStatus.REJECTED]: '班主任',
  [SuspendStatus.WITHDRAWN]: '—',
};

/** 申请类型 */
export const ApplyTypeName: Record<number, string> = {
  [ApplyType.SUSPEND]: '休学',
  [ApplyType.QUIT]: '退学',
  [ApplyType.REFUND]: '退费',
  [ApplyType.UPGRADE]: '升学',
};

/** 升学申请状态 */
export const UpgradeStatusName: Record<number, string> = {
  [UpgradeStatus.PENDING]: '待接收',
  [UpgradeStatus.RECEIVED]: '已接收',
  [UpgradeStatus.REJECTED]: '已驳回',
};

/** 咨询推送单状态（v1.2 新增） */
export const ConsultStatusName: Record<number, string> = {
  [ConsultStatus.PENDING]: '待接收',
  [ConsultStatus.RECEIVED]: '已接收',
  [ConsultStatus.REJECTED]: '已驳回',
};

/** 外部同步状态 */
export const OuterSyncStatusName: Record<number, string> = {
  [OuterSyncStatus.PENDING]: '待同步',
  [OuterSyncStatus.SYNCED]: '已同步',
  [OuterSyncStatus.FAILED]: '同步失败',
};

export const ExamTypeName: Record<number, string> = {
  [ExamType.MONTHLY]: '月考',
  [ExamType.QUALITY]: '质素考核',
  [ExamType.STAGE]: '阶段考核',
  [ExamType.GRADUATION]: '结业考试',
  [ExamType.OTHER]: '其他',
};

export const ExamResultName: Record<number, string> = {
  [ExamResult.PASS]: '通过',
  [ExamResult.FAIL]: '未通过',
};

export const ExamContentTypeName: Record<number, string> = {
  [ExamContentType.WRITTEN]: '笔试',
  [ExamContentType.MACHINE]: '机试',
  [ExamContentType.INTERVIEW]: '面试',
  [ExamContentType.OTHER]: '其他',
};

export const ApplyStatusName: Record<number, string> = {
  [ApplyStatus.PENDING]: '待审核',
  [ApplyStatus.APPROVED]: '已同意',
  [ApplyStatus.REJECTED]: '已驳回',
};

export const DormTypeName: Record<number, string> = {
  [DormType.MALE_DORM]: '男寝',
  [DormType.FEMALE_DORM]: '女寝',
};

export const NotifyTypeName: Record<number, string> = {
  [NotifyType.APPROVED]: '审批通过',
  [NotifyType.REJECTED]: '审批驳回',
  [NotifyType.TODO]: '待办提醒',
};

/**
 * 学习阶段（v1.3：取消初高中，仅保留大学部一~六阶段；见数据字典 4.4）
 *
 * ★ 2026-10-04 补 13「实训」：升实训后学生的 stage 会被改成 13
 *   （upgrade.route.ts 的 TRAINING_STAGE），但它**不在下面 STAGES_BY_DEPT 里** ——
 *   因为 13 是系统自动流转出来的，建班时不该让人手选。
 *   这里只补「显示名」，让档案页遇到实训学生时能显示「实训」而不是空白。
 */
export const StageName: Record<number, string> = {
  201: '一阶段',
  202: '二阶段',
  203: '三阶段',
  204: '四阶段',
  205: '五阶段',
  206: '六阶段',
  13: '实训',
};

/** 某个部门下可选的学习阶段 */
export const STAGES_BY_DEPT: Record<number, number[]> = {
  [DeptCode.UNIVERSITY]: [201, 202, 203, 204, 205, 206],
};

/** 大学部最后一个阶段：只有处于该阶段才能「升实训」 */
export const UNIVERSITY_LAST_STAGE = 206;

/** 某部门阶段序列（按顺序，用于「推进阶段」取下一阶段） */
export function stagesOfDept(dept: number): number[] {
  return STAGES_BY_DEPT[dept] ?? [];
}

/** 是否为该部门的最后一个阶段（决定是否可升实训） */
export function isLastStage(stage: number | null | undefined): boolean {
  if (stage === null || stage === undefined) return false;
  const dept = deptOfStage(stage);
  if (dept === undefined) return false;
  const seq = stagesOfDept(dept);
  return seq.length > 0 && seq[seq.length - 1] === stage;
}

/** 推进一阶段：返回下一阶段值；已是最后阶段则返回 null */
export function nextStageOf(stage: number | null | undefined): number | null {
  if (stage === null || stage === undefined) return null;
  const dept = deptOfStage(stage);
  if (dept === undefined) return null;
  const seq = stagesOfDept(dept);
  const i = seq.indexOf(stage);
  if (i < 0 || i >= seq.length - 1) return null;
  return seq[i + 1];
}

/** 按阶段值反查所属部门（v1.3：只有大学部） */
export function deptOfStage(stage: number): DeptCode | undefined {
  if (stage >= 201 && stage <= 206) return DeptCode.UNIVERSITY;
  return undefined;
}

/** 取中文名，取不到时返回「未知」而不是 undefined，避免前端显示空白 */
export function nameOf(map: Record<number, string>, value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return map[value] ?? '未知';
}

export function stageNameOf(stage: number | null | undefined): string {
  return nameOf(StageName, stage);
}
