/**
 * ⭐ 财务模块 HTTP 客户端（跨模块联动核心）
 *
 * ⚠️ 这个文件是「微服务联调」的关键，做三件事：
 *   1. 统一封装对财务模块 8005 的调用（地址从 config.services.finance 读）
 *   2. 强制 3 秒超时 + 失败兜底，绝不因为财务慢了把我这边拖死
 *   3. 把财务的 {code,message,data} 拆开，抛成 BizError 让上层统一处理
 *
 * ⚠️ 为什么不让前端直接调财务？
 *   ① 跨域：前端 5174，财务 8005，浏览器会拦
 *   ② 兜底：财务挂了前端应该看到「财务模块暂不可用，请稍后重试」而不是白屏
 *   ③ 鉴权：机器调用用统一的 token，不该把用户 token 透传
 *
 * 使用：
 *   const std = await financeClient.getStandard(FeeType.TUITION, DeptCode.JUNIOR_SENIOR);
 */

import { BizCode, FeeType, DeptCode } from 'shared-types/consult';
import type { FinanceStandardView, FinanceStandardBatchResult } from 'shared-types/consult';
import { config } from '../config';
import { BizError } from '../middleware/errorHandler';
import { getServiceToken } from './service-token';
// ★ 2026-10-14：跨服务调用统一走公共 axios 封装（技术选型表：跨服务调用 = axios）
import { remoteRequest, remoteGet, isRemoteTimeout } from '../../shared/http';

/** 调用财务接口的超时时间（毫秒）—— 超过就放弃，走兜底 */
const TIMEOUT_MS = 3000;

/** 财务接口返回体 */
interface FinanceResponse<T> {
  code: number;
  message: string;
  data: T;
}

/**
 * 基础请求：带超时、带鉴权、自动解包
 *
 * ★ 2026-10-14：底层 HTTP 由原生 fetch 换成公共 axios 封装（src/shared/http.ts）。
 *   ⚠️ 这里**必须显式把 RemoteError 转成本模块（consult）的 BizError** ——
 *   因为 consult 的 errorHandler 只认自己的 BizError（`instanceof`），
 *   直接抛 RemoteError 会被当成未知异常、变成 500，用户看不到中文提示。
 *   错误码与文案均与改造前逐字一致。
 */
async function request<T>(
  path: string,
  options: { method?: 'GET' | 'POST'; body?: any } = {},
): Promise<T> {
  const { method = 'GET', body } = options;

  let json: FinanceResponse<T>;
  try {
    json = await remoteRequest<FinanceResponse<T>>('finance', method, path, {
      timeout: TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        // ⚠️⚠️ 2026-10-02：不能再用固定的 'test' 了。
        //    财务模块改造后是真实验签 JWT 的，'test' 会被拒
        //    （错误：登录凭证格式不正确 → 跨模块联动全断）。
        //    改用「服务身份」JWT（见 services/service-token.ts）。
        Authorization: `Bearer ${getServiceToken()}`,
      },
      body,
      raw: true,
    });
  } catch (err: any) {
    // ---- 超时 ----
    if (isRemoteTimeout(err)) {
      throw new BizError(
        BizCode.DOWNSTREAM_TIMEOUT,
        `财务模块响应超时（超过 ${TIMEOUT_MS / 1000} 秒），请稍后重试。如持续失败请联系财务模块负责人（周铭）确认服务是否启动。`,
      );
    }
    // ---- 连不上（服务没起 / 端口不通）----
    throw new BizError(
      BizCode.DOWNSTREAM_ERROR,
      `无法连接财务模块（${config.services.finance}）。请确认财务服务已启动。`,
    );
  }

  if (!json || typeof json !== 'object') {
    throw new BizError(
      BizCode.DOWNSTREAM_ERROR,
      '财务模块返回了无法解析的内容，请联系财务模块负责人排查。',
    );
  }

  // ---- 业务码非 200：原样把财务的中文提示透出去（它写得比我自己编的好）----
  if (json.code !== BizCode.SUCCESS) {
    throw new BizError(json.code as BizCode, json.message || '财务模块处理失败');
  }

  return json.data;
}

/* ============================================================
 * 对外方法
 * ============================================================ */

export const financeClient = {
  /**
   * ⭐ 取费用标准金额（规则2）
   *
   * GET /api/finance/standard/get?feeType=1&deptCode=1
   *
   * 返回三件套：amount（多少钱）/ sourceModule（该谁发起）/ voucherReusable（凭证能否共用）
   */
  async getStandard(feeType: FeeType, deptCode: DeptCode): Promise<FinanceStandardView> {
    return request<FinanceStandardView>(
      `/api/finance/standard/get?feeType=${feeType}&deptCode=${deptCode}`,
    );
  },

  /**
   * 批量取费用标准（转正式时一次拿全款 4 笔，省 4 次往返）
   *
   * ⚠️ 财务侧只有单个 get 接口，这里并发调用后汇总。
   *    单项失败不中断整体，记进 failed 数组让前端知道哪笔没拿到。
   */
  async getStandardBatch(
    feeTypes: FeeType[],
    deptCode: DeptCode,
  ): Promise<FinanceStandardBatchResult> {
    const results = await Promise.allSettled(
      feeTypes.map((ft) => this.getStandard(ft, deptCode)),
    );

    const list: FinanceStandardView[] = [];
    const failed: Array<{ feeType: FeeType; feeTypeName: string; reason: string }> = [];

    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        list.push(r.value);
      } else {
        const ft = feeTypes[i];
        failed.push({
          feeType: ft,
          feeTypeName: FEE_TYPE_LABEL[ft] || String(ft),
          reason: r.reason?.message || '未知原因',
        });
      }
    });

    return { list, failed };
  },

  /**
   * ⭐ 建缴费单（规则3-① 的来源校验在财务侧执行）
   *
   * POST /api/finance/fee/add
   *
   * ⚠️ 关键：
   *    - 不传 amount → 财务自动按费用标准取值（规则2 的正解）
   *    - 传 sourceModule: 1 → 声明「这张单是咨询模块发起的」，对不上财务会拒绝
   *    - 传 voucherUrl → 如果违反凭证唯一性（非餐费一人一张），财务会拒绝并提示占用方
   */
  async addFee(payload: {
    studentId: string;
    studentNo?: string;
    studentName?: string;
    feeType: FeeType;
    deptCode?: DeptCode;
    classId?: string;
    className?: string;
    sourceModule?: number;
    voucherUrl?: string;
    voucherNo?: string;
    payMethod?: string;
    remark?: string;
    /** ★ 2026-10-15 自定义金额（单位：分）；不传则由财务按费用标准取值 */
    amount?: number;
    /**
     * ★ 2026-10-19 合计单的分项明细
     *
     * 用户口径：「一张凭证就是交的总金额，总金额下面列出包含什么」。
     * 传了这个，财务侧才能在总金额下面展示子项；
     * 单项单不传。
     */
    itemDetail?: Array<{
      feeType: FeeType;
      feeTypeName: string;
      amount: number;
      standardAmount: number;
      discount: number;
    }>;
  }): Promise<{ id: string; amount?: number }> {
    return request<{ id: string; amount?: number }>('/api/finance/fee/add', {
      method: 'POST',
      body: payload,
    });
  },

  /**
   * 回传凭证给财务（规则3-②）
   *
   * POST /api/finance/fee/attach-voucher
   *
   * ⚠️ 业务背景：学生「先建单 → 再交钱 → 再上传截图」，
   *    建单时没凭证，所以上传后要把凭证推给财务，财务才能在核对页看到。
   *
   * ⚠️ 上传图片是跨服务的大坑：
   *    `<img src>` 带不上 Authorization 头，所以凭证图片必须走静态托管。
   *    两个服务同机开发时，咨询侧上传时会把文件「双写」到财务的 uploads 目录，
   *    保证财务侧能通过 /uploads/voucher/xxx.jpg 直接访问到。
   */
  async attachVoucher(payload: {
    id: string;
    voucherUrl: string;
    voucherNo?: string;
  }): Promise<void> {
    await request<null>('/api/finance/fee/attach-voucher', {
      method: 'POST',
      body: payload,
    });
  },

  /**
   * ★ 2026-10-19 作废财务缴费单（咨询发起错了 / 重复发起时撤销）
   *
   * POST /api/finance/fee/cancel
   *
   * ⚠️ 财务只允许作废「未核对入账」的单；已入账会报错 —— 那种必须走退费，
   *    否则账已经出了，作废会把账单和缴费单对不上。
   */
  async cancelFee(id: string, reason?: string): Promise<null> {
    return request<null>('/api/finance/fee/cancel', {
      method: 'POST',
      body: { id, reason },
    });
  },

  /**
   * 查缴费单（用于回读财务侧的核对状态）
   *
   * GET /api/finance/fee/detail?id=xxx
   */
  async getFeeDetail(feeId: string): Promise<any> {
    return request<any>(`/api/finance/fee/detail?id=${encodeURIComponent(feeId)}`);
  },

  /**
   * 批量查缴费状态（列表页刷新用）
   *
   * GET /api/finance/fee/list?page=1&size=100&...
   */
  async listFees(params: Record<string, any> = {}): Promise<any> {
    const search = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue;
      search.append(k, String(v));
    }
    const qs = search.toString();
    return request<any>(`/api/finance/fee/list?${qs}`);
  },

  /**
   * ⭐ 学籍状态同步（规则1：休学 → 自动冻结餐费/住宿费）
   *
   * POST /api/finance/freeze/sync
   *
   * ⚠️ 幂等，可以放心重试。永远返回 HTTP 200。
   */
  async syncStudentStatus(payload: {
    studentId: string;
    studentStatus: number;
    changeTime: string;
    studentNo?: string;
    studentName?: string;
    classId?: string;
    className?: string;
    deptCode?: number;
  }): Promise<{ freezeCount: number; unfreezeCount: number; message: string }> {
    return request<{ freezeCount: number; unfreezeCount: number; message: string }>(
      '/api/finance/freeze/sync',
      { method: 'POST', body: payload },
    );
  },

  /**
   * ⭐ 上报退费单给财务（经理批准后）
   *
   * POST /api/finance/refund/apply
   *
   * ⚠️⚠️ 2026-10-15 修复：入参必须对齐财务的 applySchema
   *
   *   【原来的错】只传了 `reason`，但财务那边是：
   *     · refundItems  —— 必填（zod .min(1)），退费项目数组
   *     · refundReason —— 必填（zod .min(1)），退费原因
   *   两个都没传 → 财务直接 400「参数「refundItems」类型不正确」，
   *   **咨询发起的退费单永远进不了财务**（用户 2026-10-15 反馈的现象）。
   *
   *   【返回字段也对不上】财务返回的是 `orderNo`（TF 单号），
   *   不是 refundNo —— 原先读 refundNo 拿到 undefined，
   *   上游 finance_refund_no 永远存不进去。
   */
  async applyRefund(payload: {
    studentId: string;
    studentNo?: string;
    studentName?: string;
    classId?: string;
    className?: string;
    /** 部门编码 1 二三期 / 2 大学部 —— 财务退费列表按部门分 Tab，不传会看不到 */
    deptCode?: number;
    /** 退费项目（财务必填，至少 1 个），取值与 FeeType 一致 */
    refundItems: number[];
    /** 退费金额（单位：分） */
    refundAmount: number;
    /** 退费原因（财务必填，≤255） */
    refundReason: string;
    /** 来源类型：1 咨询 / 2 就业 */
    sourceType?: number;
    remark?: string;
  }): Promise<{ id: string; orderNo?: string }> {
    return request<{ id: string; orderNo?: string }>('/api/finance/refund/apply', {
      method: 'POST',
      body: payload,
    });
  },

  /**
   * 查退费单（回读财务侧是否已打款）
   *
   * GET /api/finance/refund/detail?id=xxx
   */
  async getRefundDetail(refundId: string): Promise<any> {
    return request<any>(`/api/finance/refund/detail?id=${encodeURIComponent(refundId)}`);
  },

  /**
   * 健康检查（启动时探测财务是否在线，不在线只警告不阻断）
   */
  async health(): Promise<boolean> {
    try {
      // 判据与改造前的 `res.ok` 一致：HTTP 2xx 即健康（axios 只在 2xx 时 resolve）
      await remoteGet('finance', '/health', { timeout: 1500, raw: true });
      return true;
    } catch {
      return false;
    }
  },
};

/** 费用类型中文名（兜底用，避免依赖 shared-types 的映射在某些路径下没加载） */
const FEE_TYPE_LABEL: Record<number, string> = {
  [FeeType.TUITION]: '学费',
  [FeeType.ACCOMMODATION]: '住宿费',
  [FeeType.MEAL]: '餐费',
  [FeeType.INSURANCE]: '保险费',
  [FeeType.TRIAL_FEE]: '试学费',
};

export default financeClient;
