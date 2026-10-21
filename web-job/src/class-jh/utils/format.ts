/**
 * 通用格式化工具（金额 / 日期 / 状态标签颜色 / 空值兜底）
 *
 * ⚠️ 金额统一规则：后端给「分」（整数），展示 ÷100 保留 2 位并加 ¥；提交前 ×100 取整。
 * ⚠️ 枚举展示一律用后端双返回的 xxxName，本文件只负责「标签颜色」和「空值兜底」，不写 1→'男' 映射。
 */

/** ElTag 支持的 type 取值 */
export type TagType = 'success' | 'warning' | 'info' | 'danger' | 'primary';

/** 空值兜底：null/undefined/空串 → '—' */
export function dash(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  return String(value);
}

/** 分 → 元（数字，保留 2 位） */
export function fenToYuan(fen: number | null | undefined): number {
  if (fen === null || fen === undefined || Number.isNaN(Number(fen))) return 0;
  return Math.round(Number(fen)) / 100;
}

/** 分 → 元字符串（¥1,280.00）；空值 → '—' */
export function formatAmount(fen: number | null | undefined): string {
  if (fen === null || fen === undefined) return '—';
  const yuan = fenToYuan(fen);
  return `¥${yuan.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** 元 → 分（整数，用于提交）。允许输入 ¥ 与千分位。 */
export function yuanToFen(yuan: number | string | null | undefined): number {
  if (yuan === null || yuan === undefined || yuan === '') return 0;
  const n = Number(String(yuan).replace(/[¥,\s]/g, ''));
  if (Number.isNaN(n)) return 0;
  return Math.round(n * 100);
}

/** 日期时间：后端已返回 'YYYY-MM-DD HH:mm:ss'，此处仅兜底空值 */
export function formatDateTime(value: string | null | undefined): string {
  return dash(value);
}

/** 日期：后端已返回 'YYYY-MM-DD'，此处仅兜底空值 */
export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  // 兼容 ISO 串：只取日期部分
  return String(value).slice(0, 10);
}

/** 百分比展示：83.33 → '83.33%' */
export function formatRate(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${Number(value).toFixed(2)}%`;
}

/** 学生状态标签色（在读=success、试学=primary、休学=warning、退学/流失=danger） */
export function studentStatusTagType(status: number): TagType {
  if (status === 5) return 'success'; // 正式在读
  if (status === 3) return 'primary'; // 试学中
  if (status === 4) return 'primary'; // 预在读
  if (status === 6) return 'warning'; // 休学
  if (status === 7 || status === 11) return 'danger'; // 退学 / 流失
  return 'info';
}

/** 班级状态标签色 */
export function classStatusTagType(status: number): TagType {
  if (status === 1) return 'success'; // 开放
  if (status === 2) return 'warning'; // 封班
  if (status === 3) return 'primary'; // 待结业
  return 'info'; // 已结业
}

/** 缴费状态标签色 */
export function payStatusTagType(status: number): TagType {
  if (status === 1) return 'warning'; // 待缴
  if (status === 2) return 'primary'; // 已缴
  if (status === 3) return 'success'; // 已核对
  // 2026-10-20 补：逾期原来是灰的（落到冻结的 info），看着像「状态没了」
  if (status === 4) return 'danger'; // 逾期
  return 'info'; // 冻结(5)
}

/** 退费状态标签色 */
export function refundStatusTagType(status: number): TagType {
  if (status === 6) return 'success'; // 已退费
  if (status === 7) return 'danger'; // 已驳回
  if (status === 1) return 'info'; // 待提交
  return 'warning'; // 审批中（2/3/4/5）
}

/** 流程状态标签色 */
export function flowStatusTagType(status: number): TagType {
  if (status === 3) return 'success'; // 已同意
  if (status === 4) return 'danger'; // 已驳回
  if (status === 1) return 'info'; // 待提交
  return 'warning'; // 待审批（2）
}

/** 出勤状态标签色 */
export function attendanceStatusTagType(status: number): TagType {
  if (status === 1) return 'success'; // 出勤
  if (status === 2) return 'warning'; // 迟到
  if (status === 5) return 'danger'; // 缺勤
  return 'info'; // 病假/事假
}

/** 通用申请状态标签色（调宿/退宿） */
export function applyStatusTagType(status: number): TagType {
  if (status === 2) return 'success'; // 已同意
  if (status === 3) return 'danger'; // 已驳回
  return 'warning'; // 待审核
}

/** 床位/房间状态标签色 */
export function bedStatusTagType(status: string | null | undefined): TagType {
  if (status === '空闲') return 'success';
  if (status === '已占用') return 'warning';
  if (status === '维修') return 'info';
  return 'info';
}
