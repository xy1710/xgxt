/**
 * 通用响应与分页类型
 *
 * ⚠️ 必须与《02-接口契约规范.md》完全一致
 */

/** 统一响应格式 */
export interface ApiResponse<T = any> {
  /** 业务状态码，200 表示成功 */
  code: number;
  /** 中文提示信息，可直接展示给用户 */
  message: string;
  /** 业务数据，没有数据时为 null，但字段必须存在 */
  data: T;
}

/** 分页响应数据 */
export interface PageData<T> {
  total: number;
  page: number;
  size: number;
  list: T[];
}

/** 分页响应（完整） */
export type PageResponse<T> = ApiResponse<PageData<T>>;

/** 分页请求参数 */
export interface PageQuery {
  /** 页码，从 1 开始 */
  page: number;
  /** 每页条数 */
  size: number;
}

/** 业务状态码 */
export enum BizCode {
  SUCCESS = 200,

  // ---- 400xx 参数错误 ----
  PARAM_ERROR = 40000,
  STUDENT_NO_EXISTS = 40001,
  REQUIRED_FIELD_MISSING = 40002,
  FORMAT_ERROR = 40003,
  /** 班级编号已存在 */
  CLASS_CODE_EXISTS = 40004,
  /** 班级名称在当前部门内重复 */
  CLASS_NAME_EXISTS = 40005,
  /** 班级状态不允许该操作（如已结业的班不能加学生） */
  CLASS_STATUS_NOT_ALLOW = 40006,
  /** 学生已在该班（在班状态） */
  STUDENT_ALREADY_IN_CLASS = 40007,
  /** 学生不在该班 */
  STUDENT_NOT_IN_CLASS = 40008,

  // ---- 401xx 未登录 ----
  UNAUTHORIZED = 40101,
  TOKEN_EXPIRED = 40102,

  // ---- 403xx 无权限 ----
  NO_MENU_PERMISSION = 40301,
  NO_OPERATION_PERMISSION = 40302,

  // ---- 404xx 数据不存在 ----
  STUDENT_NOT_FOUND = 40401,
  CLASS_NOT_FOUND = 40402,
  EXAM_NOT_FOUND = 40403,
  SCORE_NOT_FOUND = 40404,
  /** 出勤记录不存在 */
  ATTENDANCE_NOT_FOUND = 40405,
  /** 交接记录不存在 */
  TRANSFER_NOT_FOUND = 40406,
  /** 退费单不存在 */
  REFUND_NOT_FOUND = 40407,
  /** 审批单不存在 */
  APPROVAL_NOT_FOUND = 40408,

  // ---- 400xx 班级交接 ----
  /** 新负责人与原负责人完全相同，无需交接 */
  TRANSFER_SAME_TEACHER = 40009,
  /** 交接日期不能早于开班日期 */
  TRANSFER_DATE_INVALID = 40010,

  // ---- 400xx 审批流 ----
  /** 当前状态不允许这个操作（如已通过的单子不能再提交） */
  APPROVAL_STATUS_NOT_ALLOW = 40011,
  /** 你没有权限审批这一环节 */
  APPROVAL_NO_PERMISSION = 40012,
  /** 驳回必须填原因 */
  APPROVAL_REJECT_NEED_REASON = 40013,
  /** 已提交的单子不能修改，请先撤回 */
  APPROVAL_ALREADY_SUBMITTED = 40014,

  // ---- 400xx 退费 ----
  /** 退费金额必须大于 0 */
  REFUND_AMOUNT_INVALID = 40015,
  /** 该学生已有未完成的退费申请 */
  REFUND_DUPLICATE = 40016,

  // ---- 400xx 休学/退学 ----
  /** 休学/退学单不存在 */
  STUDENT_LEAVE_NOT_FOUND = 40409,
  /** 该学生已有未完成的休学/退学申请 */
  STUDENT_LEAVE_DUPLICATE = 40017,
  /** 学生当前状态不允许发起休学/退学（如已退学）*/
  STUDENT_STATUS_NOT_ALLOW = 40018,
  /** 休学/退学日期不能早于入学日期 */
  LEAVE_DATE_INVALID = 40019,

  // ---- 400xx 宿舍管理 ----
  /** 宿舍不存在 */
  DORM_NOT_FOUND = 40410,
  /** 床位不存在 */
  DORM_BED_NOT_FOUND = 40411,
  /** 宿舍调换/退宿单不存在 */
  DORM_CHANGE_NOT_FOUND = 40412,
  /** 宿舍编号重复 */
  DORM_NO_DUPLICATE = 40020,
  /** 床位已被占用 */
  DORM_BED_OCCUPIED = 40021,
  /** 该学生当前没有宿舍（不能调换/退宿） */
  STUDENT_NO_DORM = 40022,
  /** 该学生已有未完成的宿舍申请 */
  DORM_CHANGE_DUPLICATE = 40023,
  /** 目标床位与当前床位相同 */
  DORM_SAME_BED = 40024,
  /** 宿舍已停用，不能选 */
  DORM_DISABLED = 40025,
  /** 该学生已有宿舍（不能重复分派） */
  STUDENT_HAS_DORM = 40029,
  /** 性别与宿舍类型不匹配（男寝/女寝） */
  DORM_GENDER_MISMATCH = 40030,

  // ---- 400xx 催费管理 ----
  /** 催费单不存在 */
  FEE_CALL_NOT_FOUND = 40413,
  /** 该学生已有同类未完成的催费单 */
  FEE_CALL_DUPLICATE = 40026,
  /** 催费单状态不允许此操作 */
  FEE_CALL_STATUS_NOT_ALLOW = 40027,
  /** 到期时间不能早于今天 */
  FEE_DUE_DATE_INVALID = 40028,

  // ---- 400xx 考试管理 ----
  /**
   * 同一班级同一天已有同名考试。
   *
   * ★ 2026-10-16（任务 #20）新增：`t_uni_exam.uk_exam` 唯一索引**已废弃**
   *   （它违反「唯一索引不能凭空加」铁律⑧，且会让「开关关/开关开」行为不一致），
   *   改由应用层「先查后写」查重，命中时抛本码。
   *   详见 `src/teaching/exam/uniExamUnique.ts`。
   */
  EXAM_DUPLICATE = 40031,

  // ---- 500xx 系统错误 ----
  INTERNAL_ERROR = 50001,
  DB_ERROR = 50002,
}

/** 全局实体基础字段（所有表都有） */
export interface BaseEntity {
  id: string;
  /** YYYY-MM-DD HH:mm:ss */
  createTime: string;
  createBy: string;
  updateTime?: string;
  updateBy?: string;
  isDeleted: boolean;
}

/** 通用查询参数（列表接口都用这套） */
export interface CommonQuery extends PageQuery {
  /** YYYY-MM-DD */
  startDate?: string;
  /** YYYY-MM-DD */
  endDate?: string;
  keyword?: string;
  classId?: string;
  deptCode?: number;
}
