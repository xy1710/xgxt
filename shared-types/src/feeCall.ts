/**
 * 催费管理 —— 前端/后端共用类型
 *
 * 归属模块：就业管理 > 实训阶段（马志斌）
 * 创建时间：2026-09-30
 *
 * ⚠️ 这个文件是「前后端唯一口径」，字段以这里为准。
 */

/** 催费单（列表项） */
export interface FeeCallListItem {
  id: string;
  feeType: number;   // FeeCallCategory: 2住宿费 4保险费 3餐费            // 2住宿费 4保险费 3餐费（FeeCallCategory，编码与 RefundType 对齐）
  feeTypeName: string;        // 枚举双返回

  studentId: string;
  studentNo: string | null;
  studentName: string | null;
  phone: string | null;
  parentPhone: string | null;

  classId: string | null;
  className: string | null;
  deptCode: number | null;
  deptName: string | null;
  headTeacherId: string | null;
  headTeacherName: string | null;

  /** 应缴金额（单位：分），可空 */
  feeAmount: number | null;
  /** 金额展示文本，如 "1,200.00"（后端算好，前端直接用） */
  feeAmountText: string | null;
  dueDate: string;            // 到期时间
  /** 是否已逾期（后端算好） */
  overdue: boolean;
  callReason: string | null;

  callStatus: number;         // 1待催缴 2催缴中 3已缴清（FeeCallStatus）
  callStatusName: string;
  handleTime: string | null;
  handleRemark: string | null;

  /* ★ 2026-10-21 登记缴费五列（与初高 t_class_fee 同口径）
     —— 催费页里就业的行也要能看到 实缴金额 / 缴费方式 / 缴费日期 / 凭证 */
  /** 缴费方式 1微信支付 2支付宝 3现金；未登记为 null */
  payMethod: number | null;
  /** 枚举双返回 */
  payMethodName: string;
  /** 实缴金额（分）；与 feeAmount（应缴）分开存，允许部分缴 */
  paidAmount: number | null;
  /** 实缴金额展示文本，如 "1,200.00" */
  paidAmountText: string | null;
  /** 缴费日期 YYYY-MM-DD */
  payDate: string | null;
  /** 缴费凭证地址（/uploads/voucher/xxx.png） */
  voucherUrl: string | null;
  /** 缴费备注（转账单号/说明） */
  payRemark: string | null;

  applicantId: string | null;
  applicantName: string | null;

  remark: string | null;
  createTime: string;

  /** ★ 当前登录人能不能处理这一单（班主任本人 / 管理员） */
  canHandle: boolean;
}

/** 查询条件 */
export interface FeeCallQuery {
  page?: number;
  size?: number;
  keyword?: string;
  feeType?: number;
  classId?: string;
  /**
   * 催费单状态：1 待催缴 / 2 催缴中 / 3 已缴清
   *
   * ★ 2026-10-20：支持多值（逗号分隔，如 `'1,2'`）——
   *   催费页的「缴费状态」统一成 待缴/已缴/已核对/逾期/冻结 后，
   *   「待缴」对应待催缴 + 催缴中两种状态。单值传法仍然有效。
   */
  callStatus?: number | string;
  /**
   * 统一缴费状态（催费页用，与初高/大学同一套：1待缴 2已缴 3已核对 4逾期 5冻结）
   *
   * 后端按展示口径翻译成「call_status + 应缴日」：
   * 待缴=未缴清且没过应缴日；逾期=未缴清且已过应缴日；已缴=已缴清；已核对/冻结=无数据。
   */
  payStatus?: number;
  /** 只看我的（班主任：只看自己班） */
  onlyMine?: boolean;
  /** 仅看逾期未缴清（催费页「仅看紧急」在就业部门的口径） */
  onlyOverdue?: boolean;
  startDate?: string;
  endDate?: string;
}

/** 新建催费单入参 */
export interface FeeCallPayload {
  feeType: number;
  studentId: string;
  feeAmount?: number | null;  // 单位：分
  dueDate: string;
  callReason?: string | null;
  remark?: string | null;
}

/** 处理催费单入参（班主任催完了） */
export interface FeeCallHandlePayload {
  id: string;
  callStatus: number;         // 2催缴中 3已缴清（班主任能改的两种）
  handleRemark?: string | null;
}

/** 详情 */
export interface FeeCallDetail extends FeeCallListItem {
  /** 该学生的历史催费记录 */
  history: Array<{
    id: string;
    feeType: number;
    feeTypeName: string;
    dueDate: string;
    callStatus: number;
    callStatusName: string;
    createTime: string;
  }>;
}

/** 顶部统计 */
export interface FeeCallSummary {
  total: number;
  /** 待处理 = 待催缴 + 催缴中 */
  pending: number;
  /** 催缴中 */
  called: number;
  /** 已缴清 */
  done: number;
  /** 已逾期（未缴清 + 到期日 < 今天） */
  overdue: number;
  /** 仅「待催缴」 */
  pendingOnly: number;
  /** 仅「催缴中」 */
  calling: number;
}

/** 可催费的学生选项 */
export interface FeeCallStudentOption {
  studentId: string;
  studentNo: string;
  studentName: string;
  className: string | null;
  deptCode: number | null;
  deptName: string | null;
  headTeacherId: string | null;
  headTeacherName: string | null;
  phone: string | null;
  parentPhone: string | null;
}
