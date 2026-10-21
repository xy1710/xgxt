/**
 * 教学域公共格式化工具
 * ============================================================
 *
 * 【为什么单独抽出来】
 *   退费域的**三个仓储**（实训 / 初高 / 大学）都要做同样的
 *   「日期归一」与「金额（分）→ 展示文本」。
 *   各写一遍就是**新的重复** —— 与本项目「把重复合并掉」的目标正好相悖。
 *
 * 【两条约定】
 *   ① 日期一律输出 `YYYY-MM-DD`（datetime 也截断到天），空值 → `''`
 *   ② 金额在接口里**一律是「分」的整数**，展示文本才转「元」
 *      （避免浮点误差；这是财务模块的通用做法）
 */

/**
 * 分 → 展示文本，如 150000 → "1,500.00"
 *
 * ⚠️ bigint 列（t_job_refund.refund_amount）经 mysql2 回来是 **string**，
 *    所以入参类型放宽到 string。
 */
export function amountText(cent: number | string | null | undefined): string {
  const n = Number(cent || 0);
  const yuan = (n / 100).toFixed(2);
  const [intPart, decPart] = yuan.split('.');
  return `${intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decPart}`;
}

/**
 * 任意日期值 → `YYYY-MM-DD`；空值 → `''`
 *
 * ⚠️ 主库（sms_job）连接**没开 dateStrings**，datetime 会以 JS `Date` 返回；
 *    而有些库/字段又是字符串 → 两种都要能处理。
 */
export function fmtDate(v: unknown): string {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'string') return v.slice(0, 10);
  if (v instanceof Date) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(
      v.getDate(),
    ).padStart(2, '0')}`;
  }
  return String(v).slice(0, 10);
}

/** 任意日期值 → `YYYY-MM-DD HH:mm:ss`；空值 → `null` */
export function fmtDateTime(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'string') return v.replace('T', ' ').slice(0, 19);
  if (v instanceof Date) {
    const d = `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(
      v.getDate(),
    ).padStart(2, '0')}`;
    const t = `${String(v.getHours()).padStart(2, '0')}:${String(v.getMinutes()).padStart(
      2,
      '0',
    )}:${String(v.getSeconds()).padStart(2, '0')}`;
    return `${d} ${t}`;
  }
  return String(v).slice(0, 19);
}

/** 分 → 元（数值，给汇总统计用；保留 2 位小数） */
export function toYuan(cent: number | string | null | undefined): number {
  return Math.round(Number(cent || 0)) / 100;
}

/** 今天的 `YYYY-MM-DD` */
export function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

/**
 * ★ 异动日期的可选窗口：**今天 ± N 天**（业务要求：只能选「当日临近」的日期）
 *
 * 【为什么要有这个限制】
 *   异动日期写的是「学生实际休学 / 退学 / 复学的那一天」。填错年份或月份
 *   （比如 2025-10-09 写成 2026-10-09）在列表里很难一眼看出来，
 *   却会让出勤、按天退费、宿舍退宿等一串下游数据整体错位。
 *   把可选范围收窄到临近 10 天，从源头挡掉绝大多数手滑。
 *
 * 【一处定义，两处使用】
 *   · 前端：`/meta.leaveDateWindowDays` 下发 → el-date-picker 的 disabled-date
 *   · 后端：`create()` 校验（表单可以被绕过，服务端也必须拦）
 *   两边都读这里的常量，改一个数字就够。
 */
export const LEAVE_DATE_WINDOW_DAYS = 10;

/**
 * 目标日期与今天相差几天（正数 = 未来）；日期串非法时返回 `null`
 *
 * ⚠️ 用 `Date.UTC` 归一后再相减：直接用本地时间构造两个 Date 相减，
 *    在夏令时切换那天会得到 0.958 天这类小数，`Math.round` 后边界日期偶发误判。
 */
export function daysFromToday(dateStr: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr || ''));
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!y || !mo || !d) return null;
  const target = Date.UTC(y, mo - 1, d);
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target - today) / 86400000);
}

/** 是否落在「今天 ± N 天」窗口内（含边界；日期串非法 → false） */
export function isWithinLeaveDateWindow(
  dateStr: string,
  days: number = LEAVE_DATE_WINDOW_DAYS,
): boolean {
  const diff = daysFromToday(dateStr);
  return diff !== null && Math.abs(diff) <= days;
}

/**
 * 由出生日期算年龄（周岁）；算不出返回 null
 *
 * ⚠️ 学生档案里 `age` 是**冗余列**（有的历史数据 age 是空的），
 *    所以「age 为空时用 birth_date 现算」是各学段都有的兜底，抽出来共用。
 */
export function calcAge(birth: unknown): number | null {
  const s = fmtDate(birth);
  if (!s) return null;
  const b = new Date(`${s}T00:00:00`);
  if (Number.isNaN(b.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - b.getFullYear();
  const m = now.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < b.getDate())) age -= 1;
  return age >= 0 && age < 150 ? age : null;
}

/**
 * 从身份证号提取出生日期（YYYY-MM-DD）；提取不出返回 null
 *
 * 【为什么要有它】2026-10-15 学生档案改版：表单里「出生日期」输入框取消，
 * 改为录身份证号 → 系统按身份证号里的出生日期自动回填 birth_date，
 * 年龄由 birth_date 实时计算（见 calcAge），实现「每年自动更新」。
 *
 * 支持 18 位（第 7~14 位 YYYYMMDD）与 15 位（第 7~12 位 YYMMDD，补 19）。
 */
export function birthFromIdCard(idCard: unknown): string | null {
  const s = String(idCard ?? '').trim();
  if (/^\d{17}[\dXx]$/.test(s)) {
    const y = Number(s.slice(6, 10));
    const m = Number(s.slice(10, 12));
    const d = Number(s.slice(12, 14));
    return validDate(y, m, d);
  }
  if (/^\d{15}$/.test(s)) {
    const y = 1900 + Number(s.slice(6, 8));
    const m = Number(s.slice(8, 10));
    const d = Number(s.slice(10, 12));
    return validDate(y, m, d);
  }
  return null;
}

/** 年月日合法性校验（1970-01-01 ~ 当前之后一天内都放行，只挡明显非法值） */
function validDate(y: number, m: number, d: number): string | null {
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  if (y < 1900 || y > new Date().getFullYear() || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${y}-${pad(m)}-${pad(d)}`;
}

/**
 * 教室「楼栋-房间号」统一格式（2026-10-19 批注）
 * ============================================================
 * 规定格式输出，例如 A-201：楼栋段（1~3 位字母 或 2~8 个汉字的楼名）+ `-` + 1~6 位房号。
 *
 * 输入宽容、输出统一（与前端 web-job/src/teaching/classroom.ts 同一套规则）：
 *   A栋-102 / 教学楼 A-102 / a102 / A-102  →  A-102
 *   综合楼 201 / 综合楼201 / 综合楼-201    →  综合楼-201
 *
 * ⚠️ 这里只做「能认出来就归一」，认不出的**原样返回**，不在接口层硬拦：
 *    历史数据、批量导入脚本里可能还有旧写法，硬拦会把整条保存链打断；
 *    面向用户的格式提示由前端表单负责（保存时校验）。
 * ⚠️ 改规则必须同步前端那份，否则页面存的和脚本存的是两种写法。
 */
export const CLASSROOM_PATTERN = /^(?:[A-Z]{1,3}|[\u4e00-\u9fa5]{2,8})-\d{1,6}$/;

export function normalizeClassroom(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  let s = String(v).trim();
  if (!s) return '';

  // 全角字母/数字 → 半角；各种横线（— – － ― _）→ 半角 -
  s = s
    .replace(/[０-９Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[—–－―＿]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();

  if (CLASSROOM_PATTERN.test(s)) return s;

  // ① 字母楼栋（可带「栋」字、可带「教学楼」之类前缀）
  const letter = s.match(/(?:^|[^A-Za-z])([A-Za-z]{1,3})\s*栋?\s*-?\s*(\d{1,6})$/);
  if (letter) return `${letter[1].toUpperCase()}-${letter[2]}`;

  // ② 中文楼名 + 房号
  const cn = s.match(/^([\u4e00-\u9fa5]{2,8})\s*-?\s*(\d{1,6})$/);
  if (cn) return `${cn[1]}-${cn[2]}`;

  return s;
}
