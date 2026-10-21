/**
 * 教室字段的统一格式（2026-10-19 批注）
 * ============================================================
 *
 * 【要求】规定格式输出，例如：A-201
 *   · 楼栋段：1~3 位字母（A / B / AB），或 2~8 个汉字的楼名（综合楼 / 实训基地）
 *   · 分隔符：半角连字符 `-`
 *   · 房间号：1~6 位数字
 *
 * 【输入宽容、输出统一】——用户确认的口径是「最终输出 A-201」，不保留「栋」字：
 *   A栋-102 / 教学楼 A-102 / a102 / A-102  →  A-102
 *   综合楼 201 / 综合楼201 / 综合楼-201    →  综合楼-201
 *
 * ⚠️ 后端 server-job/src/teaching/shared/format.ts 里的 normalizeClassroom
 *    是同一套规则（接口层兜底），改这里必须同步那边，否则「页面存的」和
 *    「脚本/接口存的」会出现两种写法。
 */

/** 合规值示例（输入框 placeholder、错误提示共用，别各写各的） */
export const CLASSROOM_EXAMPLE = 'A-201';

/** 一句人话格式说明 */
export const CLASSROOM_TIP = `教室格式为「楼栋-房间号」，例如：${CLASSROOM_EXAMPLE}`;

/** 合规值的正则：字母楼栋 或 中文楼名 + `-` + 数字房号 */
export const CLASSROOM_PATTERN = /^(?:[A-Z]{1,3}|[\u4e00-\u9fa5]{2,8})-\d{1,6}$/;

/**
 * 把各种手写习惯归一到「楼栋-房间号」。
 * 认不出来的原样返回（交给校验去拦，别在这里瞎猜成别的楼栋）。
 */
export function normalizeClassroom(raw: unknown): string {
  let v = String(raw ?? '').trim();
  if (!v) return '';

  // 全角字母/数字 → 半角；各种横线（— – － ― _）→ 半角 -
  v = v
    .replace(/[０-９Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[—–－―＿]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();

  if (CLASSROOM_PATTERN.test(v)) return v;

  // ① 字母楼栋（可带「栋」字、可带「教学楼」之类前缀）：A栋-102 / A-102 / A102 / 教学楼 A-102
  const letter = v.match(/(?:^|[^A-Za-z])([A-Za-z]{1,3})\s*栋?\s*-?\s*(\d{1,6})$/);
  if (letter) return `${letter[1].toUpperCase()}-${letter[2]}`;

  // ② 中文楼名 + 房号：综合楼 201 / 综合楼201 / 综合楼-201
  const cn = v.match(/^([\u4e00-\u9fa5]{2,8})\s*-?\s*(\d{1,6})$/);
  if (cn) return `${cn[1]}-${cn[2]}`;

  return v;
}

/** 空值算合规（教室不是必填项）；其余按「归一后是否合规」判断 */
export function isClassroomValid(raw: unknown): boolean {
  const v = String(raw ?? '').trim();
  if (!v) return true;
  return CLASSROOM_PATTERN.test(normalizeClassroom(v));
}
