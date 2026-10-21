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

  // ---- 400xx 业务规则（教学管理初高模块新增 ★）----
  BUSINESS_RULE_VIOLATION = 40010, // 通用业务规则不满足
  CLASS_CLOSED = 40011,            // 封班班级禁止该转入
  BED_OCCUPIED = 40012,            // 床位已占用
  FEE_USED_UP = 40013,             // 费用已用完，不可退费
  ILLEGAL_STATE_TRANSITION = 40014, // 状态流转非法
  DUPLICATE_SUBMIT = 40015,        // 重复提交
  DATA_DUPLICATE = 40016,          // 唯一字段重复（学号/班级名/房间号等）★

  // ---- 401xx 未登录 ----
  UNAUTHORIZED = 40101,
  TOKEN_EXPIRED = 40102,

  // ---- 403xx 无权限 ----
  NO_MENU_PERMISSION = 40301,
  NO_OPERATION_PERMISSION = 40302,

  // ---- 404xx 数据不存在 ----
  STUDENT_NOT_FOUND = 40401,
  CLASS_NOT_FOUND = 40402,
  DORM_NOT_FOUND = 40403,   // 宿舍不存在 ★
  EXAM_NOT_FOUND = 40404,   // 考试不存在 ★
  REFUND_NOT_FOUND = 40405, // 退费单不存在 ★
  FLOW_NOT_FOUND = 40406,   // 流程不存在 ★
  SETTING_NOT_FOUND = 40407, // 设置项不存在 ★
  FEE_NOT_FOUND = 40408,     // 缴费单不存在 ★（上传缴费凭证时校验）

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
