/**
 * ⭐ 跨模块同步客户端 —— 「上游 → 班级管理」统一出口
 *
 * ============================================================
 * 【为什么有它】
 * ============================================================
 *   班级管理模块（学管）把「缴费 / 催费 / 宿舍 / 咨询推送」的数据
 *   存成【只读副本】（sms_common.t_class_*_sync），并已经实现了 4 个接收口：
 *       POST /api/class/consult/push   咨询推送学员（待接收）
 *       POST /api/class/fee/sync       缴费信息
 *       POST /api/class/urge/sync      催费信息
 *       POST /api/class/dorm/sync      宿舍房间 + 住宿学员
 *
 *   ⚠️ 但 2026-10-05 联调时发现：**消费端齐全，生产端一个都没写** ——
 *      咨询录入学生、财务确认缴费、教务催费/分派宿舍，班级那边都看不到。
 *      本文件就是补上「生产端」。
 *
 * 【铁律】不许直接读别人的数据库表（接口契约规范 6.3）：
 *   一律走 HTTP 接口，带 `x-internal-token`（见 config.internalToken）。
 *
 * 【两种调用姿势】
 *   · 用户点击触发的（咨询「入班」）→ 用 `*Strict` 语义：
 *     失败要**告诉用户**，所以把 outcome 交给调用方决定要不要抛错。
 *   · 业务顺带触发的（财务保存、教务催费）→ 用非阻断语义：
 *     同步失败**不能**把主流程带崩（用户的钱已经收好了），只记日志。
 *   本文件统一返回 SyncOutcome，两种姿势都由调用方决定 —— 不在这里偷偷吞错。
 */

import { config } from '../config';
/**
 * ★ 2026-10-14：底层 HTTP 从原生 fetch 换成公共 axios 封装（src/shared/http.ts）。
 *   《技术选型表》约定「跨服务调用 = axios」，此文件原是实现者之一。
 */
import { remoteGet, remotePost, isRemoteTimeout } from '../shared/http';

/** 调用班级模块的超时（毫秒）。它是本进程内的服务，5 秒足够 */
const TIMEOUT_MS = 5000;

/** 同步结果（与 class 侧 SyncResult 对齐的宽松结构） */
export interface SyncOutcome {
  /** HTTP + 业务码都成功 */
  ok: boolean;
  /** 给用户看的中文提示 */
  message: string;
  /** class 侧原始 data（含 inserted / updated / skipped / failed / errors） */
  data?: any;
}

/** 上游系统标识（与 shared-types/class 的 SourceSystem 取值一致） */
export type UpstreamSystem = 'consult' | 'edu' | 'finance';

/**
 * 生成批次号
 *
 * ⚠️ 必须唯一：class 侧把它写进 `source_batch_no` 用于追溯，
 *    同一个批次号重复推不会被当成新数据（幂等键是 sourceSystem+sourceId，不是批次号）。
 *    加毫秒 + 随机后缀，避免同一秒内多次调用撞号。
 */
function makeBatchNo(prefix: string): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}` +
    String(d.getMilliseconds()).padStart(3, '0');
  const rnd = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${prefix}${stamp}${rnd}`;
}

/** 班级模块基地址（.env 的 CLASS_URL 优先；合并后就是本服务的 8004） */
function classBaseUrl(): string {
  return String(process.env.CLASS_URL || config.services.class || '').replace(/\/+$/, '');
}

/**
 * 基础 POST：带内部令牌 + 超时，**永远不抛错**，只回 SyncOutcome
 *
 * ★ 2026-10-14 改造：底层由原生 fetch 换成公共 axios 封装，语义逐条保持——
 *   · 仍然「不抛错、只回 SyncOutcome」（调用方决定阻断与否，见文件头说明）
 *   · 仍然透出对方的中文提示与 data（业务失败时取 `err.payload` 里的原始响应体）
 *   · 超时提示文案不变（axios 的超时应判 ECONNABORTED，用 isRemoteTimeout 统一判）
 *   用 `raw: true` 拿完整 {code,message,data}，这样成功时还能用对方的 message 做提示。
 */
async function post(path: string, body: unknown): Promise<SyncOutcome> {
  const base = classBaseUrl();
  if (!base) {
    return { ok: false, message: '未配置班级模块地址（CLASS_URL）' };
  }

  let json: any;
  try {
    json = await remotePost('class', path, body, {
      timeout: TIMEOUT_MS,
      headers: { 'x-internal-token': config.internalToken },
      raw: true,
    });
  } catch (e: any) {
    // ① 对方返回了业务错误（code ≠ 200）→ 原样透出它的 message / data
    const payload = e?.payload;
    if (payload && typeof payload === 'object' && 'code' in payload) {
      const msg = payload.message || `班级模块返回 code=${payload.code}`;
      // eslint-disable-next-line no-console
      console.warn(`[classSync] ${path} 业务失败：${msg}`);
      return { ok: false, message: msg, data: payload.data };
    }
    // ② 超时 / 连不上 / 响应体解析不了
    const reason = isRemoteTimeout(e)
      ? `班级模块响应超时（超过 ${TIMEOUT_MS / 1000} 秒）`
      : `无法连接班级模块（${base}）`;
    // eslint-disable-next-line no-console
    console.warn(`[classSync] ${path} 调用失败：${reason}`);
    return { ok: false, message: reason };
  }

  // ⚠️ 兜底再核对一次 code：响应拦截器只对「带 code 字段」的响应体做判断，
  //    这段保证「对方返回的不是本系统统一结构」时的行为与改造前完全一致。
  if (json?.code !== 200) {
    const msg = json?.message || `班级模块返回 code=${json?.code}`;
    // eslint-disable-next-line no-console
    console.warn(`[classSync] ${path} 业务失败：${msg}`);
    return { ok: false, message: msg, data: json?.data };
  }
  return { ok: true, message: json?.message || '同步成功', data: json?.data };
}

/** 基础 GET：带内部令牌 + 超时，永远不抛错，只回 SyncOutcome（读类接口用） */
async function get(path: string): Promise<SyncOutcome> {
  const base = classBaseUrl();
  if (!base) {
    return { ok: false, message: '未配置班级模块地址（CLASS_URL）' };
  }

  let json: any;
  try {
    json = await remoteGet('class', path, {
      timeout: TIMEOUT_MS,
      headers: { 'x-internal-token': config.internalToken },
      raw: true,
    });
  } catch (e: any) {
    const payload = e?.payload;
    if (payload && typeof payload === 'object' && 'code' in payload) {
      const msg = payload.message || `班级模块返回 code=${payload.code}`;
      // eslint-disable-next-line no-console
      console.warn(`[classSync] GET ${path} 业务失败：${msg}`);
      return { ok: false, message: msg, data: payload.data };
    }
    const reason = isRemoteTimeout(e)
      ? `班级模块响应超时（超过 ${TIMEOUT_MS / 1000} 秒）`
      : `无法连接班级模块（${base}）`;
    // eslint-disable-next-line no-console
    console.warn(`[classSync] GET ${path} 调用失败：${reason}`);
    return { ok: false, message: reason };
  }

  if (json?.code !== 200) {
    const msg = json?.message || `班级模块返回 code=${json?.code}`;
    // eslint-disable-next-line no-console
    console.warn(`[classSync] GET ${path} 业务失败：${msg}`);
    return { ok: false, message: msg, data: json?.data };
  }
  return { ok: true, message: json?.message || 'ok', data: json?.data };
}

/* ============================================================
 * 对外方法（与 class 侧 4 个接收口一一对应）
 * ============================================================ */

export const classSync = {
  /**
   * 咨询推送学员 → 班级「待接收学员」
   *
   * ⚠️ 幂等键 = consultNo（class 侧按 consult_no 去重）：
   *    重复推同一个人不会产生两条，而是返回 skipped=1。
   */
  consultPush(items: Array<Record<string, unknown>>): Promise<SyncOutcome> {
    return post('/api/class/consult/push', { items });
  },

  /**
   * ★ 2026-10-20 分班即入班：推送单建好后立刻由班级侧「接收 + 建档」
   *
   * 用户口径：「缴费结束之后，直接给他分配班级……入班和分班合并」。
   * 原来大学部是「推送 → 待接收学员 → 班主任点接收」，现在分班当场入班。
   * 幂等：已接收的单子再调一次只返回 already=true，不会重复建档。
   */
  consultAutoReceive(consultNo: string, studentStatus?: number | null): Promise<SyncOutcome> {
    return post('/api/class/consult/auto-receive', {
      consultNo,
      studentStatus: studentStatus ?? null,
    });
  },

  /**
   * ★ 2026-10-20 试学闭环：补费到账转正后，把班级学籍从「试学中」改成「正式在读」
   *
   * 用户口径：交了试学费先试学，试学过了由班主任发起补费，补齐后转正式。
   * 钱和状态在咨询侧，学籍在班级侧，两边必须一起走 —— 否则班主任花名册里
   * 学生永远挂着「试学中」，班主任会以为还没转正。
   *
   * ⚠️ 认人键是 consultNo（= 咨询侧学号），班级建档时写进 source_id。
   * ⚠️ 失败不抛错：到账本身已经成功，学籍同步失败只记日志，
   *    下次状态变更会再同步一次（幂等）。
   */
  studentStatusSync(consultNo: string, studentStatus: number): Promise<SyncOutcome> {
    return post('/api/class/student/internal-status', { consultNo, studentStatus });
  },

  /** 缴费信息 → 班级只读副本（sms_common.t_class_fee_sync） */
  feeSync(items: Array<Record<string, unknown>>): Promise<SyncOutcome> {
    return post('/api/class/fee/sync', {
      sourceSystem: 'finance' satisfies UpstreamSystem,
      syncMode: 'increment',
      batchNo: makeBatchNo('FIN'),
      items,
    });
  },

  /** 催费信息 → 班级只读副本（sms_common.t_class_urge_sync） */
  urgeSync(items: Array<Record<string, unknown>>): Promise<SyncOutcome> {
    return post('/api/class/urge/sync', {
      sourceSystem: 'edu' satisfies UpstreamSystem,
      syncMode: 'increment',
      batchNo: makeBatchNo('EDUURGE'),
      items,
    });
  },

  /**
   * 宿舍房间 + 住宿学员 → 班级只读副本（sms_common.t_class_dorm_*_sync）
   *
   * @param items            本次「该班分到的房间 + 房内住宿学员」
   * @param removedSourceIds 本次被取消分派的房间（教务房间主键），
   *                         班级侧据此把对应房间副本 + 住宿副本标记删除。
   *                         ⚠️ 传空数组是安全的：班级侧不会因此清空任何房间。
   */
  dormSync(items: Array<Record<string, unknown>>, removedSourceIds: string[] = []): Promise<SyncOutcome> {
    return post('/api/class/dorm/sync', {
      sourceSystem: 'edu' satisfies UpstreamSystem,
      syncMode: 'increment',
      batchNo: makeBatchNo('EDUDORM'),
      items,
      removedSourceIds,
    });
  },

  /* ============================================================
   * ★ 2026-10-05 分班 / 升学（咨询 → 班级；初高 → 大学部）
   * ============================================================ */

  /**
   * 大学部「开放班级」列表（class_status=1）
   *
   * 用途：① 咨询「分班」选择目标班级；② 初高「升学」选择升入的大学部班级。
   * 内部入口，class 侧用 x-internal-token 放行（见 authAllowSync）。
   */
  classOpenOptions(): Promise<SyncOutcome> {
    return get('/api/class/info/open-options');
  },

  /** 初高「开放班级」列表（sms_class_jh.t_class_info，class_status=1） */
  classJhOpenOptions(): Promise<SyncOutcome> {
    return get('/api/class-jh/classInfo/open-options');
  },

  /**
   * 咨询「分班」→ 教学管理（初高）：**直接**在初高对应班级建档入班
   * （用户口径：初高侧不需要班主任再同意，分班即入班）
   *
   * ⚠️ 幂等键 = consultNo（初高侧按 source_system='consult' + source_id 去重）
   */
  consultCreateJh(item: Record<string, unknown>): Promise<SyncOutcome> {
    return post('/api/class-jh/student/from-consult', item);
  },

  /* ============================================================
   * ★ 2026-10-06 「已分班不可再分派、驳回后可再分派」的状态查询
   *
   *   咨询「收款与缴费」页要按「这个学生分班到哪一步了」决定按钮可用性：
   *     未分派 / 已驳回 → 【分班】可点
   *     待接收 / 已接收 / 初高已入班 → 不可再点（否则会被改派到别的班）
   *
   *   状态的唯一权威源在接收方（班级 / 初高），所以由咨询侧**来查**，
   *   而不是在咨询库自己存一份可能失真的副本。
   *   两个查询都走内部令牌，失败时返回 ok:false（调用方降级为「不限按钮」，
   *   但后端 /enroll-to-class 仍会二次拦截 —— 不会真的重复分派）。
   * ============================================================ */

  /** 大学部侧：按咨询单号批量查推送状态（1 待接收 / 2 已接收 / 3 已驳回） */
  consultStatus(consultNos: string[]): Promise<SyncOutcome> {
    if (!consultNos.length) return Promise.resolve({ ok: true, message: '无查询项', data: {} });
    return get(`/api/class/consult/internal-status?nos=${encodeURIComponent(consultNos.join(','))}`);
  },

  /** 初高侧：按咨询单号批量查是否已直建入班 */
  jhEnrolledStatus(consultNos: string[]): Promise<SyncOutcome> {
    if (!consultNos.length) return Promise.resolve({ ok: true, message: '无查询项', data: {} });
    return get(`/api/class-jh/student/enrolled-status?nos=${encodeURIComponent(consultNos.join(','))}`);
  },
};

export default classSync;
