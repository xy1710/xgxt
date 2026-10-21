/**
 * 财务模块公共工具
 * 负责人：周铭（财务管理）
 *
 * ⚠️ 为什么单独一个文件？
 *    金额显示、枚举着色这类逻辑，如果每个页面各写一遍，
 *    改一次要改五个地方，早晚会不一致。
 *    统一放这里，页面 import 就行。
 */

/* ============================================================
 * 金额处理 —— 全项目最要紧的一块
 *
 * ⚠️ 后端所有金额都是「分」（整数）。
 *    0.1 + 0.2 = 0.30000000000000004 这种浮点事故，
 *    在财务系统里等于事故，所以只在【显示的最后一步】才换成元。
 * ============================================================ */

/** 分 → 「¥1,280.00」 */
export function formatAmount(fen: number | null | undefined): string {
  const n = Number(fen);
  if (fen === null || fen === undefined || Number.isNaN(n)) return '¥0.00';
  return `¥${(n / 100).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** 分 → 「1,280.00」（不带 ¥，用于表格里图标在表头的情况） */
export function formatAmountPlain(fen: number | null | undefined): string {
  const n = Number(fen);
  if (fen === null || fen === undefined || Number.isNaN(n)) return '0.00';
  return (n / 100).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** 元 → 分（表单输入「1280」→ 后端要的 128000） */
export function toFen(yuan: number | string | null | undefined): number {
  const n = Number(yuan);
  if (Number.isNaN(n)) return 0;
  // ⚠️ 先四舍五入再取整：避免 12.34 * 100 = 1233.9999 这种精度坑
  return Math.round(n * 100);
}

/** 分 → 元（表单回填用） */
export function toYuan(fen: number | null | undefined): number {
  const n = Number(fen);
  if (fen === null || fen === undefined || Number.isNaN(n)) return 0;
  return n / 100;
}

/* ============================================================
 * 枚举着色
 *
 * ⚠️ 约定：色系表达「业务含义」，不是随手挑好看的
 *    success 绿 = 完成/正常    warning 橙 = 待处理/需注意
 *    danger  红 = 异常/被驳回  info   灰 = 未开始/已结束
 * ============================================================ */

type TagType = 'success' | 'warning' | 'info' | 'danger' | 'primary';

/** 缴费状态：1待缴 2待核对 3已缴 5冻结（4 逾期已于 2026-10-15 移除） */
export function payStatusTagType(status: number): TagType {
  switch (status) {
    case 3: return 'success';  // 已缴（财务核对通过、已入账）
    case 2: return 'warning';  // 待核对（凭证已交，等财务核）—— 财务的待办，用醒目色
    case 1: return 'info';     // 待缴
    case 5: return 'warning';  // 冻结
    default: return 'info';
  }
}

/**
 * 退费状态（审批链）：1待提交 2待经理审批 3待教务核算
 *                  4待财务出款 5待校长审批 6已退费 7已驳回
 */
export function refundStatusTagType(status: number): TagType {
  switch (status) {
    case 6: return 'success';  // 已退费
    case 7: return 'danger';   // 已驳回
    case 4: return 'warning';  // 待财务出款 —— 财务要重点盯的
    case 1: return 'info';     // 待提交
    default: return 'primary'; // 各种审批中
  }
}

/** 账单类型：1缴费账单 2退费账单 */
export function billTypeTagType(type: number): TagType {
  return type === 1 ? 'success' : 'warning';
}

/** 冻结来源：1自动冻结 2手动冻结 */
export function freezeSourceTagType(source: number): TagType {
  return source === 1 ? 'primary' : 'warning';
}

/* ============================================================
 * 日期工具
 * ============================================================ */

/** 取今天的 YYYY-MM-DD */
export function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 剩余天数 → 展示文案（0 天要显眼，告诉财务「已经到期了」） */
export function restDaysText(days: number | null | undefined): string {
  const n = Number(days) || 0;
  if (n <= 0) return '已到期';
  if (n <= 7) return `${n} 天（即将到期）`;
  return `${n} 天`;
}

/** 剩余天数 → 标签颜色 */
export function restDaysTagType(days: number | null | undefined): TagType {
  const n = Number(days) || 0;
  if (n <= 0) return 'danger';
  if (n <= 7) return 'warning';
  return 'success';
}

/** 空值占位：表格里 null 显示「—」比空白好读 */
export function dash(v: any): string {
  if (v === null || v === undefined || v === '') return '—';
  return String(v);
}
