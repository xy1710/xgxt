/**
 * ⭐ 教务模块 → 财务模块 · 缴费凭证回传
 *
 * ============================================================
 * 【为什么有它】2026-10-15 用户反馈
 * ============================================================
 *   「教务上传了缴费截图，财务看不到」
 *
 *   实测根因：教务的 `POST /api/edu/payment/upload` 只把 `certificate_name`
 *   （文件名，如「凭证-U26001.png」）写进自己的表 ——
 *   **图片没落盘、也从没告诉过财务**，所以财务侧 `t_finance_fee.voucher_url`
 *   永远是空的，财务在「缴费管理」核对时自然看不到凭证。
 *
 *   本文件补上「回传」这一环：
 *     教务上传截图 → 找到财务对应的缴费单 → 调财务 attach-voucher 把凭证挂上去。
 *
 * ============================================================
 * 【怎么找到财务那张单】两边从没互存 ID，唯一可靠的关联键是
 *   **学号 + 费用类型**：
 *     · 教务 `t_edu_payment`：`student_no` + `category`（中文，如「学费」）
 *     · 财务 `t_finance_fee`：`student_no` + `fee_type`（数字，1 学费…）
 *   中文→数字的换算走 `shared-types/edu` 的 `CATEGORY_TO_FEE_TYPE`（唯一口径）。
 *
 * ============================================================
 * 【失败策略】**绝不阻断主流程**
 *   教务的「上传凭证」是本模块自己的状态流转；财务侧没挂上只是财务看不到图，
 *   不该让教务的上传整体失败。所以本文件**不抛错**，统一返回 {ok, message}，
 *   由调用方决定怎么提示。
 * ============================================================
 */

import { db } from './db';
import { getServiceToken } from '../consult/services/service-token';
import { isRemoteTimeout, remotePost } from '../shared/http';
import { CATEGORY_TO_FEE_TYPE, PayStatus } from 'shared-types/edu';

/** 财务缴费单表（跨库全限定名） */
const FINANCE_FEE_TABLE = 'sms_finance.t_finance_fee';

/** 调财务接口的超时（毫秒）—— 同其他跨模块客户端，3 秒放弃 */
const TIMEOUT_MS = 3000;

/** 财务接口返回体 */
interface FinanceResponse<T> {
  code: number;
  message: string;
  data: T;
}

export interface PushVoucherResult {
  /** 是否成功挂到财务的缴费单上 */
  ok: boolean;
  /** 挂上的财务缴费单 ID（成功时有值，便于写进日志/排查） */
  financeFeeId?: string;
  /** 失败原因（已转成人话，可直接展示或记日志） */
  message?: string;
}

/**
 * 按【学号 + 费用类型】找财务对应的缴费单
 *
 * 优先级：
 *   1. 冻结(5)的单不选 —— 财务的缴费管理本来就不显示冻结单，挂上去也看不到
 *   2. 没凭证的优先（避免覆盖财务已有的凭证）
 *   3. 同条件下取最新建的
 *
 * ⚠️ 找不到不抛错，返回 null（调用方据此提示「财务没有对应缴费单」）。
 */
async function findFinanceFeeId(studentNo: string, feeType: number): Promise<string | null> {
  try {
    const row = (await db(FINANCE_FEE_TABLE)
      .where({ student_no: studentNo, fee_type: feeType, is_deleted: false })
      .whereNot('pay_status', PayStatus.FROZEN)
      .orderByRaw("CASE WHEN voucher_url IS NULL OR voucher_url = '' THEN 0 ELSE 1 END ASC")
      .orderBy('create_time', 'desc')
      .first('id')) as { id?: string } | undefined;
    return row?.id ? String(row.id) : null;
  } catch {
    // 财务库不可达（未建库 / 无权限）→ 当作没找到，不影响教务侧上传
    return null;
  }
}

/**
 * 把教务上传的缴费截图回传给财务
 *
 * @param studentNo  学号（跨模块认人只认学号）
 * @param category   教务的中文费用类别，如「学费」
 * @param voucherUrl 截图相对地址，如 /uploads/voucher/edu_xxx.png
 * @param voucherNo  截图识别出的支付订单号（可选）
 */
export async function pushVoucherToFinance(params: {
  studentNo?: string | null;
  category?: string | null;
  voucherUrl?: string | null;
  voucherNo?: string | null;
}): Promise<PushVoucherResult> {
  const studentNo = String(params.studentNo || '').trim();
  const voucherUrl = String(params.voucherUrl || '').trim();
  const category = String(params.category || '').trim();

  // ---- 前置条件：缺任何一项都没法挂，直接给明确原因（不抛错）----
  if (!voucherUrl) {
    return { ok: false, message: '本次没有截图地址（老数据或未识别到图片），未回传财务' };
  }
  if (!studentNo) {
    return { ok: false, message: '该缴费记录没有学号，无法定位财务的缴费单，未回传财务' };
  }
  const feeType = CATEGORY_TO_FEE_TYPE[category];
  if (!feeType) {
    return {
      ok: false,
      message: `费用类别「${category}」没有对应的财务费用类型，未回传财务`,
    };
  }

  // ---- 1. 找财务那张单 ----
  const financeFeeId = await findFinanceFeeId(studentNo, feeType);
  if (!financeFeeId) {
    return {
      ok: false,
      message: `财务侧没有找到「${studentNo}」的${category}缴费单，凭证未能同步（可让财务补建后再传）`,
    };
  }

  // ---- 2. 调财务回传凭证 ----
  try {
    const payload = await remotePost<FinanceResponse<null>>(
      'finance',
      '/api/finance/fee/attach-voucher',
      {
        id: financeFeeId,
        voucherUrl,
        ...(params.voucherNo ? { voucherNo: params.voucherNo } : {}),
      },
      {
        timeout: TIMEOUT_MS,
        headers: {
          'Content-Type': 'application/json',
          // 服务身份 JWT：财务侧对 kind==='service' 放行，不再卡 modules
          // ⚠️ 必须传 'edu' —— 否则自报家门会显示成别的模块，排查时对不上
          Authorization: `Bearer ${getServiceToken('edu')}`,
        },
        raw: true,
      },
    );

    if (!payload || typeof payload !== 'object') {
      return { ok: false, financeFeeId, message: '财务模块返回了非 JSON 内容' };
    }
    // ⚠️ 财务侧成功码历史上出现过 0，这里 0/200 双兼容
    if (payload.code !== 0 && payload.code !== 200) {
      return {
        ok: false,
        financeFeeId,
        message: `财务模块拒绝了本次凭证同步：${payload.message || '未知错误'}`,
      };
    }
    return { ok: true, financeFeeId };
  } catch (err: any) {
    if (isRemoteTimeout(err)) {
      return {
        ok: false,
        financeFeeId,
        message: `财务模块响应超时（超过 ${TIMEOUT_MS / 1000} 秒）`,
      };
    }
    const p = err?.payload;
    if (p && typeof p === 'object' && 'message' in p) {
      return {
        ok: false,
        financeFeeId,
        message: `财务模块拒绝了本次凭证同步：${(p as any).message}`,
      };
    }
    return {
      ok: false,
      financeFeeId,
      message: `无法连接财务模块：${err?.message || '网络错误'}`,
    };
  }
}
