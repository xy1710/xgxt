/**
 * 接口契约：催费管理
 *
 * 路径前缀：/api/class/fee
 */

import { ApiResponse, PageResponse } from '../common';
import { FeeRecord, FeeNotify } from '../class';
import { FeeType, PayStatus, ShareChannel } from '../enums';

/* ---------------- 缴费台账 ---------------- */

/** 催费列表查询参数 */
export interface FeeListQuery {
  page?: number;
  size?: number;
  classId?: string;
  feeType?: FeeType;
  payStatus?: PayStatus;
  startDate?: string;
  endDate?: string;
  isUrgent?: boolean;
  keyword?: string;
}

/** 催费列表响应 */
export type FeeListResponse = PageResponse<FeeRecord>;

/** 催费导出响应 */
export type FeeExportResponse = ApiResponse<FeeRecord[]>;

/* ---------------- 催费推送 ---------------- */

/** 催费分享入参 */
export interface FeeSharePayload {
  studentId: string;
  feeType: FeeType;
  /** 触达渠道：只允许 短信 / 微信（口径见 SHARE_CHANNEL_PUSH_OPTIONS） */
  shareChannel: ShareChannel;
  /**
   * 发送内容（★ 2026-10-20 用户要求：原「备注」改叫「发送内容」）
   *
   * 就是实际发给家长的那段话：留空则只用系统自动生成的催费文案；
   * 填了就附在自动文案后面一起发出（落库到 t_class_fee_notify.remark 列）。
   */
  sendContent?: string;
}

/** 催费分享响应（含可复制文案） */
export interface FeeShareData {
  notifyId: string;
  shareText: string;
}
export type FeeShareResponse = ApiResponse<FeeShareData>;

/* ---------------- 登记缴费（上传缴费凭证） ---------------- */

/**
 * 登记缴费入参（★ 2026-10-20 用户要求：操作列「上传缴费凭证」）
 *
 * 表单五件事：缴费方式 / 缴费金额 / 缴费时间 / 备注 / 缴费截图。
 * 截图走 base64（与咨询、财务的做法一致）：前端把本地图片读成 dataURL 传上来，
 * 后端解码写 `uploads/voucher/`，返回相对地址 `/uploads/voucher/xxx.jpg`。
 */
export interface FeePaymentPayload {
  /** 缴费台账行 ID（t_class_fee.id） */
  feeId: string;
  /** 缴费方式：1 微信支付 / 2 支付宝 / 3 现金（枚举 PayMethod） */
  payMethod: number;
  /** 实缴金额（单位：分） */
  paidAmount: number;
  /** 缴费时间 YYYY-MM-DD，默认当天，**只能选当天及以前** */
  payDate: string;
  /** 备注（转账单号 / 说明），可空 */
  remark?: string;
  /**
   * 缴费截图 data:image/png;base64,xxxx（PNG / JPG / WEBP / GIF，≤ 5MB）
   *
   * ★ 2026-10-20 用户要求：**现金**可以不传（线下交付没有转账截图）；
   *   微信支付 / 支付宝必传，否则后端报「请上传缴费截图」。
   */
  dataUrl?: string;
}

/* ---------------- 批量转交财务 ---------------- */

/**
 * 批量转交财务（★ 2026-10-20 用户要求：整页一个「批量上传到财务缴费管理」）
 *
 * 「转交」= 在财务 sms_finance.t_finance_fee 里生成对应的缴费单（带凭证/金额/日期/备注），
 * 财务在缴费管理里就能核对；成功后初高台账记下 source_system='finance' + source_id，避免重复转交。
 */
export interface FeeTransferPayload {
  /** 要转交的缴费台账行 ID（一次最多 200 条） */
  feeIds: string[];
}

/** 批量转交结果：成功/跳过/失败分开报，不因为一条失败就整体回滚 */
export interface FeeTransferResult {
  total: number;
  success: number;
  /** 跳过（已转交 / 还没登记缴费 / 不是初高单），属于正常情况 */
  skipped: Array<{ feeId: string; reason: string }>;
  /** 失败（财务侧拒绝等），需要人工看 */
  failed: Array<{ feeId: string; reason: string }>;
}

/** 登记缴费响应 */
export interface FeePaymentResult {
  feeId: string;
  /** 相对地址，直接给 <img src> 用 */
  voucherUrl: string;
  /** 登记后的缴费状态（1待缴 2已缴…）：正常会变成「已缴」 */
  payStatus: number;
  /** 是否同时写回了财务缴费单（演示数据 source_system='local' 时为 false） */
  financeSynced: boolean;
}

/* ---------------- 催费记录 ---------------- */

/** 催费记录列表查询参数 */
export interface FeeNotifyListQuery {
  page?: number;
  size?: number;
  studentId?: string;
}

/** 催费记录列表响应 */
export type FeeNotifyListResponse = PageResponse<FeeNotify>;
