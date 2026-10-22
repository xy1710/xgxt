/**
 * 教学域配置加载器 · 状态码映射 + 口径配置
 * ============================================================
 *
 * 【它是整个合并的"翻译层"】
 *
 *   三套出勤的原始状态码**互相冲突**（实测）：
 *
 *     概念     实训 attend_status   初高 attendance_status
 *     ────────────────────────────────────────────────
 *     出勤          1                     1
 *     缺勤          2                     5      ← 差 3 位
 *     迟到          3                     2      ← 数字正好相反
 *     早退          4                  （没有）
 *     请假          5                  （没有）
 *     事假          6                     4
 *     病假          7                     3
 *
 *   7 个状态里 4 个数字冲突、2 个初高根本没有。
 *   如果直接把两张表合到一起，**初高的「迟到」会被当成「实训的缺勤」** ——
 *   页面不报错，但统计全错，而且极难事后发现。
 *
 *   所以：**进出各翻译一次**。读的时候 原始码 → 统一码；写的时候 统一码 → 原始码。
 *   老表数据一个字节都不用改。
 *
 * 【配置从哪来】
 *   ① 优先读 sms_common.t_teaching_conf（键 attendance.statusMap / attendance.scope）
 *   ② 读不到（表不存在 / 没数据 / 库挂了）→ **回落到本文件的默认值**
 *   这一层兜底很重要：配置表没建，出勤页也必须能正常打开。
 */

import { commonDb } from '../../class/db';
import type { TeachingStage } from './dto';
import { TEACHING_STAGES } from './dto';

/* ============================================================
 * 默认值（= 配置表里那两行 JSON 的内容）
 * ============================================================ */

/**
 * 状态码映射：`学段 → { 原始码: 统一码 }`
 *
 * ⚠️ 初高那行就是本次合并最关键的翻译：
 *      原 1(出勤)→1  原 2(迟到)→3  原 3(病假)→7  原 4(事假)→6  原 5(缺勤)→2
 *    大学没有明细状态码（只填人数），给空对象。
 *    实训本来就是统一码，恒等映射。
 */
export const DEFAULT_STATUS_MAP: Record<TeachingStage, Record<string, number>> = {
  jh: { 1: 1, 2: 3, 3: 7, 4: 6, 5: 2 },
  class: {},
  job: { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7 },
};

/** 出勤口径配置 */
export interface AttendanceScopeItem {
  /** 应到 = 哪些学生状态（初高用；job 用 'all' 表示全部在班） */
  shouldStatuses: number[] | 'all';
  /** 实到 = 哪些考勤状态（★ 统一码） */
  presentStatuses: number[];
  /** 未达标线（%） */
  targetRate: number;
  /** 是否由老师手工填应到/实到人数（大学 = true） */
  manualInput: boolean;
}

export const DEFAULT_SCOPE: Record<TeachingStage, AttendanceScopeItem> = {
  jh: { shouldStatuses: [3, 4, 5], presentStatuses: [1, 3], targetRate: 90, manualInput: false },
  /* ★ 2026-10-19：大学部改为逐人登记（与初高/就业一致），
     应到 = 在班名册全部；实到 = 出勤类状态（出勤/迟到/早退）。 */
  class: { shouldStatuses: 'all', presentStatuses: [1, 3, 4], targetRate: 90, manualInput: false },
  job: { shouldStatuses: 'all', presentStatuses: [1, 3, 4], targetRate: 90, manualInput: false },
};

export const CONF_KEY_STATUS_MAP = 'attendance.statusMap';
export const CONF_KEY_SCOPE = 'attendance.scope';

/* ============================================================
 * 读取（带缓存 + 兜底）
 * ============================================================ */

const T_CACHE_MS = 60_000;

let statusMapCache: { at: number; value: Record<TeachingStage, Record<string, number>> } | null =
  null;
let scopeCache: { at: number; value: Record<TeachingStage, AttendanceScopeItem> } | null = null;
let scoreCache: { at: number; value: Record<TeachingStage, ScoreScopeItem> } | null = null;

/** 读一行配置；表不存在 / 没数据 / 解析失败 → null（调用方回落默认值） */
async function readConf(key: string): Promise<Record<string, unknown> | null> {
  try {
    const row = (await commonDb('t_teaching_conf')
      .where({ conf_key: key, is_deleted: 0 })
      .first()) as { conf_value?: string } | undefined;
    if (!row?.conf_value) return null;
    const parsed = JSON.parse(row.conf_value);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    // 表没建 / 库连不上 → 静默回落默认值，绝不因为配置读不到就让页面挂掉
    return null;
  }
}

/** 状态码映射表（60 秒缓存） */
export async function getStatusMap(): Promise<Record<TeachingStage, Record<string, number>>> {
  if (statusMapCache && Date.now() - statusMapCache.at < T_CACHE_MS) return statusMapCache.value;
  const fromDb = await readConf(CONF_KEY_STATUS_MAP);
  const value: Record<TeachingStage, Record<string, number>> = {
    jh: (fromDb?.jh as Record<string, number>) ?? DEFAULT_STATUS_MAP.jh,
    class: (fromDb?.class as Record<string, number>) ?? DEFAULT_STATUS_MAP.class,
    job: (fromDb?.job as Record<string, number>) ?? DEFAULT_STATUS_MAP.job,
  };
  statusMapCache = { at: Date.now(), value };
  return value;
}

/** 口径配置（60 秒缓存） */
export async function getScope(): Promise<Record<TeachingStage, AttendanceScopeItem>> {
  if (scopeCache && Date.now() - scopeCache.at < T_CACHE_MS) return scopeCache.value;
  const fromDb = await readConf(CONF_KEY_SCOPE);
  const merge = (s: TeachingStage): AttendanceScopeItem => ({
    ...DEFAULT_SCOPE[s],
    ...((fromDb?.[s] as Partial<AttendanceScopeItem>) ?? {}),
  });
  const value: Record<TeachingStage, AttendanceScopeItem> = {
    jh: merge('jh'),
    class: merge('class'),
    job: merge('job'),
  };
  scopeCache = { at: Date.now(), value };
  return value;
}

/** 配置改了之后清缓存（管理端保存配置时调） */
export function clearConfCache(): void {
  statusMapCache = null;
  scopeCache = null;
  scoreCache = null;
  refundStatusCache = null;
  leaveBizCache = null;
  leaveStatusCache = null;
}

/* ============================================================
 * 成绩公式配置（★ 第 2 期「成绩域」的核心）
 * ============================================================
 * 三套公式**真的不一样**（实测）：
 *
 *   实训：笔试均分 = 卷面×50% + 机试×50%（缺一项 → 留空）
 *         综合成绩 = 笔试均分×50% + 面试×50%（缺面试 → 留空）
 *   大学：综合成绩 = 笔试×50% + 面试×50%（**缺项按 0 计**）
 *   初高：综合成绩 = 笔试 + 机试 + 面试 + 其他（**直接求和**），
 *         再按「总分 ≥ 满分 × 0.6」自动判定通过
 *
 * 所以这里做成**结构化配置**（不是字符串公式 —— 那是注入风险）：
 *   一个公式 = 若干「分数项 × 权重」，外加「缺项怎么办」。
 */

/** 参与计算的分数项（统一字段名） */
export type ScoreField = 'written' | 'machine' | 'interview' | 'other' | 'writtenAvg';

export interface ScoreFormulaPart {
  field: ScoreField;
  weight: number;
}

export interface ScoreFormula {
  parts: ScoreFormulaPart[];
  /**
   * 缺项处理：
   *   true  = 按 0 计（大学：没考就当 0 分，照样出综合分）
   *   false = 整项留空（实训/初高：没考完就不出综合分，避免"没考"被当成"考了 0 分"）
   */
  missingAsZero: boolean;
}

export interface ScoreScopeItem {
  /** 笔试均分公式；null = 该学段不算笔试均分 */
  writtenAvg: ScoreFormula | null;
  /** 综合成绩公式 */
  total: ScoreFormula;
  /** 是否按满分比例自动判定通过（初高 = true） */
  passByRatio: boolean;
  /** 及格线比例 */
  passRatio: number;
  /**
   * ★ 第三处差异：考试结果(exam_result) 是怎么来的
   *   'auto'   = 后端按满分比例自动判定（初高）
   *   'manual' = 老师手选（大学；该列 NOT NULL，未传时默认「通过」）
   *   'action' = 由「标末班」这类动作设置，默认 null「未判断」（实训）
   */
  judgeMode: 'auto' | 'manual' | 'action';
}

export const DEFAULT_SCORE_FORMULA: Record<TeachingStage, ScoreScopeItem> = {
  jh: {
    writtenAvg: null,
    total: {
      parts: [
        { field: 'written', weight: 1 },
        { field: 'machine', weight: 1 },
        { field: 'interview', weight: 1 },
        { field: 'other', weight: 1 },
      ],
      missingAsZero: false,
    },
    passByRatio: true,
    passRatio: 0.6,
    judgeMode: 'auto',
  },
  class: {
    writtenAvg: null,
    total: {
      parts: [
        { field: 'written', weight: 0.5 },
        { field: 'interview', weight: 0.5 },
      ],
      missingAsZero: true,
    },
    passByRatio: false,
    passRatio: 0.6,
    judgeMode: 'manual',
  },
  job: {
    writtenAvg: {
      parts: [
        { field: 'written', weight: 0.5 },
        { field: 'machine', weight: 0.5 },
      ],
      missingAsZero: false,
    },
    total: {
      parts: [
        { field: 'writtenAvg', weight: 0.5 },
        { field: 'interview', weight: 0.5 },
      ],
      missingAsZero: false,
    },
    passByRatio: false,
    passRatio: 0.6,
    judgeMode: 'action',
  },
};

export const CONF_KEY_SCORE_FORMULA = 'score.formula';

/** 成绩公式（60 秒缓存） */
export async function getScoreFormula(): Promise<Record<TeachingStage, ScoreScopeItem>> {
  if (scoreCache && Date.now() - scoreCache.at < T_CACHE_MS) return scoreCache.value;
  const fromDb = await readConf(CONF_KEY_SCORE_FORMULA);
  const merge = (s: TeachingStage): ScoreScopeItem => {
    const d = DEFAULT_SCORE_FORMULA[s];
    const o = (fromDb?.[s] as Partial<ScoreScopeItem>) ?? {};
    return {
      writtenAvg: o.writtenAvg === undefined ? d.writtenAvg : o.writtenAvg,
      total: o.total ?? d.total,
      passByRatio: o.passByRatio ?? d.passByRatio,
      passRatio: o.passRatio ?? d.passRatio,
      judgeMode: o.judgeMode ?? d.judgeMode,
    };
  };
  const value: Record<TeachingStage, ScoreScopeItem> = { jh: merge('jh'), class: merge('class'), job: merge('job') };
  scoreCache = { at: Date.now(), value };
  return value;
}

/**
 * 按公式算一个分数
 * @returns 分数（保留 2 位）；缺项且 missingAsZero=false 时返回 null
 */
export function calcByFormula(
  f: ScoreFormula,
  values: Partial<Record<ScoreField, number | null>>,
): number | null {
  let sum = 0;
  for (const p of f.parts) {
    const raw = values[p.field];
    const has = raw !== null && raw !== undefined && !Number.isNaN(Number(raw));
    if (!has) {
      if (f.missingAsZero) continue; // 按 0 计 = 跳过这一项
      return null; // 缺项 → 整项留空
    }
    sum += Number(raw) * p.weight;
  }
  return Math.round(sum * 100) / 100;
}

/**
 * 按配置算「笔试均分 / 综合成绩 / 判定结果」
 * @param fullTotal 满分（初高按比例判定通过时用；其它学段忽略）
 */
export async function calcScores(
  stage: TeachingStage,
  vals: Partial<Record<ScoreField, number | null>>,
  fullTotal = 0,
): Promise<{ writtenAvg: number | null; totalScore: number | null; examResult: number | null }> {
  const cfg = (await getScoreFormula())[stage];
  const writtenAvg = cfg.writtenAvg ? calcByFormula(cfg.writtenAvg, vals) : null;
  const totalScore = calcByFormula(cfg.total, { ...vals, writtenAvg });
  let examResult: number | null = null;
  // 只有 judgeMode='auto' 的学段由后端判定；manual/action 由调用方决定
  if (cfg.judgeMode === 'auto' && totalScore !== null && fullTotal > 0) {
    examResult = totalScore >= fullTotal * cfg.passRatio ? 1 : 2; // 1通过 2未通过
  }
  return { writtenAvg, totalScore, examResult };
}

/* ============================================================
 * 翻译：统一码 ⇄ 原始码
 * ============================================================ */

/** 原始码 → 统一码（读，用于返回给前端 / 计算口径） */
export async function toUnifiedStatus(stage: TeachingStage, raw: number | null): Promise<number | null> {
  if (raw === null || raw === undefined) return null;
  const map = await getStatusMap();
  const m = map[stage] || {};
  // 映射表里没有 → 原样返回（例如实训本就用统一码）
  return m[String(raw)] ?? raw;
}

/** 统一码 → 原始码（写，用于落回老表） */
export async function toRawStatus(stage: TeachingStage, unified: number | null): Promise<number | null> {
  if (unified === null || unified === undefined) return null;
  const map = await getStatusMap();
  const m = map[stage] || {};
  for (const [raw, uni] of Object.entries(m)) {
    if (uni === unified) return Number(raw);
  }
  return unified;
}

/* ============================================================
 * ★ 退费：统一状态映射 —— 三块合并后「审批链统一用实训那一套」
 * ============================================================
 *
 * 【统一码是什么】
 *   就是实训那套 `ApprovalStatus`，一个字没改：
 *     1 待提交 · 2 待学管审批 · 3 待校长审批 · 4 已通过 · 5 已驳回 · 6 已撤销
 *
 * 【为什么需要映射表】
 *   初高 / 大学的老表里存的是它们**自己那套 4~5 级链**的状态码：
 *     1 待提交 · 2 待经理 · 3 待教务核算 · 4 待财务出款 · 5 待校长 · 6 已退费 · 7 已驳回 · 8 已撤回
 *   （实测：初高与大学 1~7 逐值一致，大学多一个 8=已撤回；
 *     初高原先没有 8，本次已在 shared-types 补 `RefundStatus.WITHDRAWN = 8` 对齐）
 *
 *   合并后审批链砍成「学管 → 校长」两级，老码里的
 *   「待教务核算 / 待财务出款」**不再产生**，但老数据里还留着。
 *
 * 【读】老码 → 统一码：3 / 4 / 5 一律**归并**成「3 待校长审批」（都是"审批中"）
 * 【写】统一码 → 老码：3 → 5（直接落到"待校长"，**跳过 3/4 —— 这就是新链生效点**）
 *
 * ⚠️ 反向映射必须**显式配置**，不能由正向反推：
 *   3、4、5 都正向映射到 3，反推无法确定该落哪个 —— 写死才没有歧义。
 */
export interface RefundStatusMapItem {
  /** 读：老码 → 统一码 */
  read: Record<string, number>;
  /** 写：统一码 → 老码 */
  write: Record<string, number>;
}

export const DEFAULT_REFUND_STATUS_MAP: Record<TeachingStage, RefundStatusMapItem> = {
  // 初高：1~8（补齐 WITHDRAWN 后与大学逐值一致）
  jh: {
    read: { '1': 1, '2': 2, '3': 3, '4': 3, '5': 3, '6': 4, '7': 5, '8': 6 },
    write: { '1': 1, '2': 2, '3': 5, '4': 6, '5': 7, '6': 8 },
  },
  // 大学：1~8
  class: {
    read: { '1': 1, '2': 2, '3': 3, '4': 3, '5': 3, '6': 4, '7': 5, '8': 6 },
    write: { '1': 1, '2': 2, '3': 5, '4': 6, '5': 7, '6': 8 },
  },
  // 实训：本来就存统一码 → 恒等
  job: {
    read: { '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6 },
    write: { '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6 },
  },
};

export const CONF_KEY_REFUND_STATUS_MAP = 'refund.statusMap';

let refundStatusCache: { at: number; value: Record<TeachingStage, RefundStatusMapItem> } | null = null;

/** 退费状态映射（60 秒缓存） */
export async function getRefundStatusMap(): Promise<Record<TeachingStage, RefundStatusMapItem>> {
  if (refundStatusCache && Date.now() - refundStatusCache.at < 60_000) return refundStatusCache.value;
  const raw = await readConf(CONF_KEY_REFUND_STATUS_MAP);
  const value: Record<TeachingStage, RefundStatusMapItem> = {
    jh: { ...DEFAULT_REFUND_STATUS_MAP.jh },
    class: { ...DEFAULT_REFUND_STATUS_MAP.class },
    job: { ...DEFAULT_REFUND_STATUS_MAP.job },
  };
  if (raw) {
    for (const s of TEACHING_STAGES) {
      const o = (raw as Record<string, any>)[s];
      if (o && o.read && o.write) value[s] = { read: o.read, write: o.write };
    }
  }
  refundStatusCache = { at: Date.now(), value };
  return value;
}

/** 退费：老码 → 统一码（读） */
export async function toUnifiedRefundStatus(
  stage: TeachingStage,
  raw: number | null | undefined,
): Promise<number | null> {
  if (raw === null || raw === undefined) return null;
  const map = (await getRefundStatusMap())[stage];
  return map?.read?.[String(raw)] ?? raw;
}

/** 退费：统一码 → 老码（写） */
export async function toRawRefundStatus(
  stage: TeachingStage,
  unified: number | null | undefined,
): Promise<number | null> {
  if (unified === null || unified === undefined) return null;
  const map = (await getRefundStatusMap())[stage];
  return map?.write?.[String(unified)] ?? unified;
}

/* ============================================================
 * ★ 学籍异动审批（休学 / 退学 / 复学）· 类型与状态映射
 * ============================================================
 *
 * 与退费域同源：审批链**统一采用实训那一套**（见 shared-types 的 APPROVAL_CHAINS）：
 *   休学 1 步（学管）· 复学 1 步（学管）· 退学 2 步（学管 → 校长）
 *
 * 【统一业务类型】1 休学 · 2 退学 · 3 复学（= 实训的 `StudentLeaveBizType`）
 * 【统一状态】1 待提交 · 2 待学管 · 3 待校长 · 4 已通过 · 5 已驳回 · 6 已撤销
 *
 * 【三套的原始码 —— 实测】
 *   类型：初高 FlowType `1休学 2复学 3升班转班 4换人 5退学 6就业协议 7末班`
 *               → 只有 1 / 2 / 5 属本次范围（3/4/6/7 是初高独有流程，不并）
 *         大学 ApplyType `1休学 2退学 3退费 4升学`
 *               → 原本没有复学；2026-10-16 起**新增原码 5 = 复学**（统一码 3），
 *                 避开已被退费(3)/升学(4)占用的码，老数据一个字节不动
 *         实训 biz_type  `1休学 2退学 3复学`        → 就是统一码
 *
 *   状态：初高 SuspendStatus `1待提交 2待经理 3已同意 4已驳回`（原本无量级校长态）
 *         大学 SuspendStatus `1待提交 2待经理 3待校长 4已同意 5已驳回`
 *         ⚠️ **两边值不同**（初高 3=已同意，大学 3=待校长）→ 必须**各配一张表**
 *         （本次已给两边补齐 `PENDING_PRINCIPAL` / `WITHDRAWN`，见 shared-types）
 */
export interface LeaveStatusMapItem {
  /** 读：老码 → 统一码 */
  read: Record<string, number>;
  /** 写：统一码 → 老码 */
  write: Record<string, number>;
}

export const DEFAULT_LEAVE_BIZ_MAP: Record<TeachingStage, LeaveStatusMapItem> = {
  // 初高 FlowType：1休学 2复学 3升班转班 4换人 5退学 6就业协议 7末班
  jh: {
    read: { '1': 1, '5': 2, '2': 3 },
    write: { '1': 1, '2': 5, '3': 2 },
  },
  // 大学 ApplyType：1休学 2退学 3退费 4升学；★ 2026-10-16 新增 5复学（= 统一码 3）
  class: {
    read: { '1': 1, '2': 2, '5': 3 },
    write: { '1': 1, '2': 2, '3': 5 },
  },
  // 实训 biz_type = 统一码
  job: {
    read: { '1': 1, '2': 2, '3': 3 },
    write: { '1': 1, '2': 2, '3': 3 },
  },
};

export const DEFAULT_LEAVE_STATUS_MAP: Record<TeachingStage, LeaveStatusMapItem> = {
  // 初高 SuspendStatus：1待提交 2待经理 3已同意 4已驳回 5待校长(新) 6已撤回(新)
  jh: {
    read: { '1': 1, '2': 2, '3': 4, '4': 5, '5': 3, '6': 6 },
    write: { '1': 1, '2': 2, '3': 5, '4': 3, '5': 4, '6': 6 },
  },
  // 大学 SuspendStatus：1待提交 2待经理 3待校长 4已同意 5已驳回 6已撤回(新)
  class: {
    read: { '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6 },
    write: { '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6 },
  },
  // 实训 approval_status = ApprovalStatus（恒等）
  job: {
    read: { '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6 },
    write: { '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6 },
  },
};

export const CONF_KEY_LEAVE_BIZ_MAP = 'leave.bizMap';
export const CONF_KEY_LEAVE_STATUS_MAP = 'leave.statusMap';

let leaveBizCache: { at: number; value: Record<TeachingStage, LeaveStatusMapItem> } | null = null;
let leaveStatusCache: { at: number; value: Record<TeachingStage, LeaveStatusMapItem> } | null = null;

/** 审批：业务类型映射（60 秒缓存） */
export async function getLeaveBizMap(): Promise<Record<TeachingStage, LeaveStatusMapItem>> {
  if (leaveBizCache && Date.now() - leaveBizCache.at < 60_000) return leaveBizCache.value;
  const raw = await readConf(CONF_KEY_LEAVE_BIZ_MAP);
  const value: Record<TeachingStage, LeaveStatusMapItem> = {
    jh: { ...DEFAULT_LEAVE_BIZ_MAP.jh },
    class: { ...DEFAULT_LEAVE_BIZ_MAP.class },
    job: { ...DEFAULT_LEAVE_BIZ_MAP.job },
  };
  if (raw) {
    for (const s of TEACHING_STAGES) {
      const o = (raw as Record<string, any>)[s];
      if (o && o.read && o.write) value[s] = { read: o.read, write: o.write };
    }
  }
  leaveBizCache = { at: Date.now(), value };
  return value;
}

/** 审批：状态映射（60 秒缓存） */
export async function getLeaveStatusMap(): Promise<Record<TeachingStage, LeaveStatusMapItem>> {
  if (leaveStatusCache && Date.now() - leaveStatusCache.at < 60_000) return leaveStatusCache.value;
  const raw = await readConf(CONF_KEY_LEAVE_STATUS_MAP);
  const value: Record<TeachingStage, LeaveStatusMapItem> = {
    jh: { ...DEFAULT_LEAVE_STATUS_MAP.jh },
    class: { ...DEFAULT_LEAVE_STATUS_MAP.class },
    job: { ...DEFAULT_LEAVE_STATUS_MAP.job },
  };
  if (raw) {
    for (const s of TEACHING_STAGES) {
      const o = (raw as Record<string, any>)[s];
      if (o && o.read && o.write) value[s] = { read: o.read, write: o.write };
    }
  }
  leaveStatusCache = { at: Date.now(), value };
  return value;
}

/* ---- 四个翻译函数 ---- */

/** 审批：老类型码 → 统一类型码（读） */
export async function toUnifiedLeaveBiz(
  stage: TeachingStage,
  raw: number | null | undefined,
): Promise<number | null> {
  if (raw === null || raw === undefined) return null;
  const map = (await getLeaveBizMap())[stage];
  return map?.read?.[String(raw)] ?? null;
}

/** 审批：统一类型码 → 老类型码（写） */
export async function toRawLeaveBiz(
  stage: TeachingStage,
  unified: number | null | undefined,
): Promise<number | null> {
  if (unified === null || unified === undefined) return null;
  const map = (await getLeaveBizMap())[stage];
  return map?.write?.[String(unified)] ?? null;
}

/** 审批：老状态码 → 统一状态码（读） */
export async function toUnifiedLeaveStatus(
  stage: TeachingStage,
  raw: number | null | undefined,
): Promise<number | null> {
  if (raw === null || raw === undefined) return null;
  const map = (await getLeaveStatusMap())[stage];
  return map?.read?.[String(raw)] ?? raw;
}

/** 审批：统一状态码 → 老状态码（写） */
export async function toRawLeaveStatus(
  stage: TeachingStage,
  unified: number | null | undefined,
): Promise<number | null> {
  if (unified === null || unified === undefined) return null;
  const map = (await getLeaveStatusMap())[stage];
  return map?.write?.[String(unified)] ?? unified;
}

/* ============================================================
 * 审批单号生成
 * ============================================================
 *
 * 【★ 第 4 期第 2 批实测踩到 —— 这是个被老表掩盖了很久的老 bug】
 *   `t_uni_approval` 上有唯一索引 `uk_approval(apply_no, edu_stage)`，
 *   但老表三张（`t_class_flow` / `t_class_suspend_apply` / `t_job_student_leave`）
 *   实测**只有主键、一个唯一索引都没有** → 初高/实训的老表根本没 `apply_no` 这一列，
 *   不生成也不会撞车，所以这个洞一直没暴露。
 *
 *   切读后统一表把三学段合到一张表，老表「不生成也没事」的前提消失：
 *     `apply_no` 是 `NOT NULL DEFAULT ''`
 *     → 初高/实训没写这列 → 落成空串 `''`
 *     → 同一学段**第二行就撞** `Duplicate entry 'jh' for key 'uk_approval'`
 *
 *   为什么修「生成单号」而不是「删索引」：
 *     ① 业务上审批单本来就该有可查的单号（人工核对、对账都要）
 *     ② 第 4 期方案 B 的先例（`uk_exam`）是**加宽**索引而不是删保护
 *     ③ `apply_no` 在统一表里是大学/实训本来就在用的列，删了索引等于放弃单号唯一性保护
 *
 * 【格式】`XJ + yyyymmdd + 5 位随机`，与 `repo.class.ts` 原实现保持一致
 */
export function buildApplyNo(prefix = 'XJ'): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const rnd = String(Math.floor(Math.random() * 100000)).padStart(5, '0');
  return `${prefix}${y}${m}${day}${rnd}`;
}
