/**
 * 班级模块 → 咨询模块 的内部客户端
 * ════════════════════════════════════════════════════════════
 * 为什么需要它：
 *   「试学结束 → 班主任发起补费」「退学通过 → 回写咨询状态」这两个动作，
 *   发起方是**班主任（班级模块）**，但数据落在**咨询模块**（收款单 / 学生状态）。
 *
 *   铁律不允许直连别人的库，只能走 HTTP；而班主任的 token 在咨询侧解不出咨询岗位，
 *   所以走咨询侧专为服务间调用开的 `/api/consult/student/internal/*`
 *   （只认 x-internal-token，见 consult/routes/internal.route.ts 文件头）。
 *
 * 失败语义：与 classSync 一致 —— **不抛错**，只回 { ok, message, data }，
 *   由调用方决定是「阻断用户操作」还是「记日志继续」。本文件的调用都是
 *   用户点出来的动作，所以调用方一律要把 message 透给用户。
 * ════════════════════════════════════════════════════════════
 */

import { remoteGet, remotePost, isRemoteTimeout } from '../../shared/http';
import { config } from '../config';

const TIMEOUT_MS = 5000;

export interface ConsultOutcome<T = any> {
  ok: boolean;
  message: string;
  data?: T;
}

function consultBaseUrl(): string {
  // 合并成单进程后 CONSULT_URL 与本服务同端口；仍然按 env 优先，保留拆库部署的可能
  return String(process.env.CONSULT_URL || config.services.consult || '').replace(/\/+$/, '');
}

function fail(e: any, base: string): ConsultOutcome {
  const payload = e?.payload;
  if (payload && typeof payload === 'object' && 'code' in payload) {
    const msg = payload.message || `咨询模块返回 code=${payload.code}`;
    console.warn(`[consultClient] 业务失败：${msg}`);
    return { ok: false, message: msg, data: payload.data };
  }
  const reason = isRemoteTimeout(e)
    ? `咨询模块响应超时（超过 ${TIMEOUT_MS / 1000} 秒）`
    : `无法连接咨询模块（${base}）`;
  console.warn(`[consultClient] 调用失败：${reason}`);
  return { ok: false, message: reason };
}

function unwrap(json: any): ConsultOutcome {
  if (json?.code !== 200) {
    const msg = json?.message || `咨询模块返回 code=${json?.code}`;
    console.warn(`[consultClient] 业务失败：${msg}`);
    return { ok: false, message: msg, data: json?.data };
  }
  return { ok: true, message: json?.message || 'ok', data: json?.data };
}

async function get(path: string): Promise<ConsultOutcome> {
  const base = consultBaseUrl();
  if (!base) return { ok: false, message: '未配置咨询模块地址（CONSULT_URL）' };
  try {
    const json = await remoteGet('consult', path, {
      timeout: TIMEOUT_MS,
      headers: { 'x-internal-token': config.internalToken },
      raw: true,
    });
    return unwrap(json);
  } catch (e: any) {
    return fail(e, base);
  }
}

async function post(path: string, body: unknown): Promise<ConsultOutcome> {
  const base = consultBaseUrl();
  if (!base) return { ok: false, message: '未配置咨询模块地址（CONSULT_URL）' };
  try {
    const json = await remotePost('consult', path, body, {
      timeout: TIMEOUT_MS,
      headers: { 'x-internal-token': config.internalToken },
      raw: true,
    });
    return unwrap(json);
  } catch (e: any) {
    return fail(e, base);
  }
}

export const consultClient = {
  /**
   * 试学转正 · 补费预览
   *
   * 返回：应缴合计 / 已到账 / 还差多少 / 差哪几项（金额单位：分）
   */
  trialPlan(consultNo: string): Promise<ConsultOutcome> {
    return get(`/api/consult/student/internal/trial-plan?consultNo=${encodeURIComponent(consultNo)}`);
  },

  /**
   * ★ 2026-10-20 班主任接收建档前调：学籍该落「试学中(3)」还是「正式在读(5)」
   *
   * 判断依据在咨询库（钱交到哪一步），班级侧看不到，也不该复制一份口径。
   * 返回 data.studentStatus / data.fullSettled / data.consultState。
   */
  receivePlan(consultNo: string): Promise<ConsultOutcome> {
    return get(`/api/consult/student/internal/receive-plan?consultNo=${encodeURIComponent(consultNo)}`);
  },

  /**
   * ★ 2026-10-20 接收建档成功后调：把咨询侧状态从「待分班(4)」推进到
   *   「试学中(5)」或「正式在读(7)」。
   *
   * 幂等：状态已经不是「待分班」时返回 changed=false，不会倒退也不会重复写历史。
   */
  receiveAck(input: {
    consultNo: string;
    className?: string | null;
    operatorName?: string;
    operatorTitle?: string;
  }): Promise<ConsultOutcome> {
    return post('/api/consult/student/internal/receive-ack', {
      consultNo: input.consultNo,
      className: input.className ?? null,
      operatorName: input.operatorName || '班主任',
      operatorTitle: input.operatorTitle || '班主任',
    });
  },

  /**
   * 班主任发起补费：咨询侧状态 → 全款待缴，等财务确认到账后自动转正式
   */
  trialSupplement(input: {
    consultNo: string;
    operatorName: string;
    operatorTitle?: string;
  }): Promise<ConsultOutcome> {
    return post('/api/consult/student/internal/trial-supplement', {
      consultNo: input.consultNo,
      operatorName: input.operatorName,
      operatorTitle: input.operatorTitle || '班主任',
    });
  },

  /**
   * 退学审批通过后回写咨询状态（→ 流失）；已在退费流程中的会被跳过（skipped=true）
   */
  quit(input: {
    consultNo: string;
    reason?: string | null;
    operatorName?: string;
    operatorTitle?: string;
  }): Promise<ConsultOutcome> {
    return post('/api/consult/student/internal/quit', {
      consultNo: input.consultNo,
      reason: input.reason ?? null,
      operatorName: input.operatorName || '班级模块',
      operatorTitle: input.operatorTitle || '系统',
    });
  },
};
