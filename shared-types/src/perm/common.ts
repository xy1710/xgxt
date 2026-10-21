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

  /* 4001x 权限管理模块（林晓）业务校验错误 */
  ROLE_CODE_EXISTS = 40010,     // 职位编码已存在
  ROLE_NAME_EXISTS = 40011,     // 职位名称已存在
  ROLE_IN_USE = 40012,          // 职位有关联账号，不可删除
  PRESET_ROLE_PROTECTED = 40013, // 系统预置职位不可删除
  ROLE_DISABLED = 40014,        // 职位已停用
  DEPT_NAME_EXISTS = 40015,     // 部门名称已存在
  DEPT_IN_USE = 40016,          // 部门被职位/账号引用，不可删除
  DEPT_HAS_CHILD = 40017,       // 部门下还有子部门
  USER_PHONE_EXISTS = 40018,    // 手机号已存在
  USER_ACCOUNT_EXISTS = 40019,  // 登录账号已存在
  USER_GW_EXISTS = 40020,       // 工号已存在
  USER_HAS_BUSINESS_DATA = 40021, // 账号有业务数据，不可删除
  USER_NO_ROLE = 40022,         // 账号必须至少有一个职位
  PWD_WEAK = 40023,             // 密码强度不符合当前策略
  RULE_VALUE_INVALID = 40024,   // 规则取值不合法
  PERM_SAVE_EMPTY = 40025,      // 权限全量覆盖内容为空
  PERM_ITEM_NAME_EXISTS = 40026, // 同一板块下功能点重名
  PERM_ITEM_PROTECTED = 40027,   // 系统预置权限点不可改/删
  PERM_ITEM_ACTIONS_EMPTY = 40028, // 自建权限点至少要有一个动作

  // ---- 401xx 未登录 ----
  UNAUTHORIZED = 40101,
  TOKEN_EXPIRED = 40102,

  // ---- 403xx 无权限 ----
  NO_MENU_PERMISSION = 40301,
  NO_OPERATION_PERMISSION = 40302,

  // ---- 404xx 数据不存在 ----
  STUDENT_NOT_FOUND = 40401,
  CLASS_NOT_FOUND = 40402,

  /* 4041x 权限管理模块数据不存在 */
  ROLE_NOT_FOUND = 40410,
  USER_NOT_FOUND = 40411,
  DEPT_NOT_FOUND = 40412,
  LOG_NOT_FOUND = 40413,
  MENU_NOT_FOUND = 40414,

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
