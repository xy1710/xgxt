/**
 * 缴费管理接口
 *
 * 对应后端 server-edu/src/routes/payment.route.ts
 * 路径前缀 /api/edu/payment（走 Vite proxy 转发到 8002）
 */

import { http } from '../request';
import type {
  PageData,
  PaymentItem,
  ExpiringItem,
  PaymentQuery,
  ExpiringQuery,
  ExpiringBatchPayload,
  BatchUploadResult,
  PaymentSavePayload,
  BatchFreezePayload,
  BatchFreezeResult,
  PaymentTotalStats,
  PaymentExpiringStats,
  NotifyResult,
  OcrResult,
  UploadCertificateResult,
} from 'shared-types/edu';

const BASE = '/api/edu/payment';

// ==================== 统计 ====================

/** 缴费总记录 Tab 的统计卡 */
export function fetchPaymentStats(): Promise<PaymentTotalStats> {
  return http.get<PaymentTotalStats>(`${BASE}/stats`);
}

/**
 * 即将到期 Tab 的统计卡
 * 传 category 时只统计该类别（跟随「学费/住宿费/…」子页签）
 */
export function fetchExpiringStats(category?: string): Promise<PaymentExpiringStats> {
  return http.get<PaymentExpiringStats>(`${BASE}/expiring-stats`, { category } as any);
}

// ==================== 缴费总记录 ====================

export function fetchPaymentList(query: PaymentQuery): Promise<PageData<PaymentItem>> {
  return http.get<PageData<PaymentItem>>(`${BASE}/list`, query as any);
}

/** 冻结 ⇄ 启动 */
export function togglePaymentFreeze(id: string): Promise<{ frozen: boolean }> {
  return http.post<{ frozen: boolean }>(`${BASE}/toggle-freeze`, { id });
}

/** 批量冻结 / 解冻（传页面上勾选的 id 列表） */
export function batchFreeze(payload: BatchFreezePayload): Promise<BatchFreezeResult> {
  return http.post<BatchFreezeResult>(`${BASE}/batch-freeze`, payload);
}

/** 新建学生缴费信息 */
export function addPayment(payload: PaymentSavePayload): Promise<null> {
  return http.post<null>(`${BASE}/add`, payload);
}

// ==================== 即将到期 ====================

export function fetchExpiringList(query: ExpiringQuery): Promise<PageData<ExpiringItem>> {
  return http.get<PageData<ExpiringItem>>(`${BASE}/expiring/list`, query as any);
}

/** 单个通知 */
export function notifyOne(id: string): Promise<NotifyResult> {
  return http.post<NotifyResult>(`${BASE}/notify`, { id });
}

/** 一键通知（传当前筛选条件） */
export function notifyAll(query: ExpiringQuery): Promise<NotifyResult> {
  return http.post<NotifyResult>(`${BASE}/notify-all`, query as any);
}

/**
 * 识别缴费截图：自动读出截图上的缴费金额和订单号
 *
 * 识别失败时后端直接抛业务错误（messages 由 request.ts 统一弹出），
 * 这里 reject，页面保持输入框为空且不允许提交。
 */
export function recognizeCertificate(file: File): Promise<OcrResult> {
  const form = new FormData();
  form.append('file', file);
  return http.post<OcrResult>(`${BASE}/ocr`, form, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 60000, // OCR 比较慢，给足时间
  });
}

/**
 * 单个上传凭证（amount / orderNo / certificateUrl 来自截图识别，只读回填）
 *
 * ⭐ 2026-10-15：新增 certificateUrl（截图地址）与返回的同步结果 ——
 *    后端落库后会把这张图回传给财务，返回体告诉页面有没有同步成功。
 */
export function uploadCertificate(payload: {
  id: string;
  certificateName?: string;
  uploadRemark?: string;
  amount?: number;
  orderNo?: string;
  certificateUrl?: string;
}): Promise<UploadCertificateResult> {
  return http.post<UploadCertificateResult>(`${BASE}/upload`, payload);
}

/** 批量上传：传 ids 则只处理勾选的行，不传则按筛选条件整批处理 */
export function batchUpload(payload: ExpiringBatchPayload): Promise<BatchUploadResult> {
  return http.post<BatchUploadResult>(`${BASE}/batch-upload`, payload as any);
}

// ==================== 导入 ====================

/** 导入模板下载地址 */
export const PAYMENT_TEMPLATE_URL = `${BASE}/import-template`;

/** 导入结果 */
export interface ImportPaymentResult {
  success: number;
  failed: number;
  failures: { row: number; reason: string }[];
}

/** 上传文件并导入 */
export function importPayments(file: File): Promise<ImportPaymentResult> {
  const form = new FormData();
  form.append('file', file);
  return http.post<ImportPaymentResult>(`${BASE}/import`, form, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 60000,
  });
}
