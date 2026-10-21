/**
 * 职位图标（原型 ROLE_ICON）
 *
 * 原型的 ROLE_ICON 按【职位 id】取图标；开发版职位 id 是 UUID，
 * 所以改按角色标识（roleCode）对应。列表 / 弹窗 / 详情三处共用这一份，
 * 避免同一个映射表在多个 .vue 里各抄一遍、改一处漏一处。
 */

const ROLE_ICON_BY_CODE: Record<string, string> = {
  MKT_CONSULT: '📞',
  MKT_MANAGER: '📈',
  TEACH_HEAD: '🧑‍🏫',
  TEACH_TUTOR: '👨‍🏫',
  TEACH_ASSIST: '🧑‍💼',
  TEACH_QTY: '📊',
  ACAD_MANAGER: '🎓',
  TEACH_DEAN: '📋',
  ACAD_STAFF: '🗂️',
  FIN_STAFF: '💰',
  JOB_STAFF: '💼',
  RM_PROJECT: '📁',
  RM_PRINCIPAL: '👑',
  SYS_ADMIN: '🔧',
};

/** 角色标识（roleCode）/ 是否预置 → 图标（查不到时：预置兜 🔧、自建兜 👤） */
export function roleIconOf(r: { roleCode?: string; isSys?: boolean }): string {
  return ROLE_ICON_BY_CODE[r?.roleCode || ''] || (r?.isSys ? '🔧' : '👤');
}

export default roleIconOf;
