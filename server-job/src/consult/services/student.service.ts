/**
 * 咨询学生档案服务
 *
 * ⚠️ 职责边界：
 *    本服务只管咨询侧的学生档案与流转状态。
 *    「学籍状态变更 → 通知财务冻结」这件事不在这里做，
 *    而是在 consult-student.service 的 changeState() 里统一触发（见该文件）。
 */

import { randomUUID } from 'crypto';
import {
  GENDER_NAME,
  DEPT_NAME,
  STUDENT_STATUS_NAME,
  nameOf,
  ConsultState,
  CONSULT_STATE_NAME,
  LEAD_CHANNEL_NAME,
  BASE_FIELDS,
  EXTRA_FIELDS,
} from 'shared-types/consult';
import type {
  ConsultStudentListItem,
  ConsultStudent,
  InfoCompleteness,
} from 'shared-types/consult';
import { db } from '../utils/db';

export const STUDENT_TABLE = 't_consult_student';
export const HISTORY_TABLE = 't_consult_history';

/* ============================================================
 * 信息完整度计算
 * ============================================================ */

/** 判断某字段是否已填（字段名用中文，和前端展示对齐） */
function hasField(row: any, field: string): boolean {
  switch (field) {
    case '姓名': return !!row.student_name;
    case '性别': return row.gender !== null && row.gender !== undefined;
    case '手机号': return !!row.phone;
    case '来源': return !!row.source_channel;
    case '意向课程': return !!row.intend_course;
    case '家长联系人': return !!row.parent_contact;
    case '家长电话': return !!row.parent_phone;
    case '身份证号': return !!row.id_card;
    case '就读/毕业学校': return !!row.school;
    case '家庭住址': return !!row.address;
    case '报考院校': return !!row.target_college;
    case '出生日期': return !!row.birthday;
    case '缴费方式': return !!row.pay_mode;
    case '备注': return !!row.remark;
    default: return false;
  }
}

/** 计算信息完整度 */
export function calcCompleteness(row: any): InfoCompleteness {
  const baseCount = BASE_FIELDS.filter((f) => hasField(row, f)).length;
  const extraCount = EXTRA_FIELDS.filter((f) => hasField(row, f)).length;
  const baseTotal = BASE_FIELDS.length;
  const extraTotal = EXTRA_FIELDS.length;

  if (baseCount < baseTotal) {
    return {
      baseCount, baseTotal, extraCount, extraTotal,
      label: `基本信息待完善 ${baseCount}/${baseTotal}`,
      level: 'PENDING',
    };
  }
  if (extraCount < extraTotal) {
    return {
      baseCount, baseTotal, extraCount, extraTotal,
      label: '基本信息已录 · 档案待完善',
      level: 'PARTIAL',
    };
  }
  return {
    baseCount, baseTotal, extraCount, extraTotal,
    label: '信息完整',
    level: 'COMPLETE',
  };
}

/* ============================================================
 * 行 → 前端视图转换
 * ============================================================ */

/** 来源展示文案：「家访·青山社区」 */
export function sourceText(row: any): string {
  const ch = nameOf(LEAD_CHANNEL_NAME, row.source_channel);
  return row.source_remark ? `${ch}·${row.source_remark}` : ch;
}

/** 行 → 列表项 */
export function toListItem(row: any, feeStat?: { paid: number; pending: number }): ConsultStudentListItem {
  return {
    consultStudentId: row.id,
    studentNo: row.student_no || undefined,
    studentName: row.student_name,
    gender: row.gender,
    genderName: nameOf(GENDER_NAME, row.gender),
    phone: row.phone || undefined,
    source: sourceText(row),
    sourceChannel: row.source_channel,
    sourceChannelName: nameOf(LEAD_CHANNEL_NAME, row.source_channel),
    ownerName: row.owner_name || undefined,
    consultState: row.consult_state,
    consultStateName: nameOf(CONSULT_STATE_NAME, row.consult_state),
    studentStatus: row.student_status ?? undefined,
    studentStatusName: row.student_status ? nameOf(STUDENT_STATUS_NAME, row.student_status) : undefined,
    className: row.class_name || undefined,
    intendCourse: row.intend_course || undefined,
    paidCount: feeStat?.paid ?? 0,
    pendingCount: feeStat?.pending ?? 0,
    // ★ 2026-10-16 分期欠费：直接读学生表上同步好的 arrear_amount（由分期服务维护）
    arrearAmount: Number(row.arrear_amount || 0),
    inArrear: Number(row.arrear_amount || 0) > 0,
    infoCompleteness: calcCompleteness(row),
    createTime: row.create_time ? formatTime(row.create_time) : '',
  };
}

/** 行 → 详情 */
export function toDetail(row: any): ConsultStudent {
  return {
    id: row.id,
    consultStudentId: row.id,
    studentNo: row.student_no || undefined,
    studentName: row.student_name,
    gender: row.gender,
    genderName: nameOf(GENDER_NAME, row.gender),
    age: row.age ?? undefined,
    phone: row.phone || undefined,
    deptCode: row.dept_code ?? undefined,
    deptName: row.dept_code ? nameOf(DEPT_NAME, row.dept_code) : undefined,

    sourceChannel: row.source_channel,
    sourceChannelName: nameOf(LEAD_CHANNEL_NAME, row.source_channel),
    sourceRemark: row.source_remark || undefined,
    referrerName: row.referrer_name || undefined,
    referrerPhone: row.referrer_phone || undefined,
    ownerId: row.owner_id || undefined,
    ownerName: row.owner_name || undefined,
    ownerTitle: row.owner_title || undefined,
    creatorName: row.create_by_name || undefined,

    intendCourse: row.intend_course || undefined,
    parentContact: row.parent_contact || undefined,
    parentPhone: row.parent_phone || undefined,

    idCard: row.id_card || undefined,
    school: row.school || undefined,
    address: row.address || undefined,
    targetCollege: row.target_college || undefined,
    birthday: row.birthday || undefined,
    payMode: row.pay_mode || undefined,
    remark: row.remark || undefined,

    consultState: row.consult_state,
    consultStateName: nameOf(CONSULT_STATE_NAME, row.consult_state),
    studentStatus: row.student_status ?? undefined,
    studentStatusName: row.student_status ? nameOf(STUDENT_STATUS_NAME, row.student_status) : undefined,
    classId: row.class_id || undefined,
    className: row.class_name || undefined,
    trialStart: row.trial_start ? formatDate(row.trial_start) : undefined,
    lossReason: row.loss_reason || undefined,

    infoCompleteness: calcCompleteness(row),

    createTime: formatTime(row.create_time),
    createBy: row.create_by || '',
    updateTime: row.update_time ? formatTime(row.update_time) : undefined,
    updateBy: row.update_by || undefined,
    isDeleted: !!row.is_deleted,
  };
}

/* ============================================================
 * 格式化辅助
 * ============================================================ */

/** 只取日期部分 YYYY-MM-DD */
export function formatDate(v: any): string {
  if (!v) return '';
  if (typeof v === 'string') return v.slice(0, 10);
  const d = new Date(v);
  if (isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 格式化时间 YYYY-MM-DD HH:mm:ss */
export function formatTime(v: any): string {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d.getTime())) return String(v);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 格式化到分钟 YYYY-MM-DD HH:mm */
export function formatMinute(v: any): string {
  const s = formatTime(v);
  return s ? s.slice(0, 16) : '';
}

/** 计算两个日期相差天数（含首尾，最少 0） */
export function diffDays(start: string, end: string): number {
  const a = new Date(start + 'T00:00:00');
  const b = new Date(end + 'T00:00:00');
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return 0;
  const n = Math.round((b.getTime() - a.getTime()) / 86400000) + 1;
  return n > 0 ? n : 0;
}

/** 今天 YYYY-MM-DD */
export function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ============================================================
 * 跟进历史
 * ============================================================ */

/** 写一条跟进历史 */
export async function addHistory(
  consultStudentId: string,
  byName: string,
  text: string,
  byTitle?: string,
  action?: string,
): Promise<void> {
  await db(HISTORY_TABLE).insert({
    id: randomUUID(),
    consult_student_id: consultStudentId,
    by_name: byName,
    by_title: byTitle || null,
    action: action || null,
    text,
    create_time: new Date(),
    create_by: byName,
    is_deleted: false,
  });
}

/** 查跟进历史（按时间正序，前端做时间线） */
export async function listHistory(consultStudentId: string) {
  const rows = await db(HISTORY_TABLE)
    .where({ consult_student_id: consultStudentId, is_deleted: false })
    .orderBy('create_time', 'asc');

  return rows.map((r: any) => ({
    id: r.id,
    at: formatMinute(r.create_time),
    by: r.by_name || '',
    byTitle: r.by_title || undefined,
    text: r.text || '',
  }));
}

/* ============================================================
 * 常用查询
 * ============================================================ */

/** 按 id 取学生（未删除） */
export async function findStudent(id: string): Promise<any> {
  return db(STUDENT_TABLE).where({ id, is_deleted: false }).first();
}

/** 按姓名取学生（用于跨模块按姓名匹配） */
export async function findStudentByName(name: string): Promise<any> {
  return db(STUDENT_TABLE).where({ student_name: name, is_deleted: false }).first();
}

/** 取配置值（带默认） */
export async function getConfig(key: string, defaultValue: string): Promise<string> {
  const row = await db('t_consult_config')
    .where({ config_key: key, is_deleted: false })
    .first();
  return row ? String(row.config_value) : defaultValue;
}

/** 取配置值为数字 */
export async function getConfigNumber(key: string, defaultValue: number): Promise<number> {
  const v = await getConfig(key, String(defaultValue));
  const n = Number(v);
  return isNaN(n) ? defaultValue : n;
}

/** 取试学班级候选列表 */
export async function getClassOptions(): Promise<string[]> {
  const v = await getConfig('class_options', '试学1班,试学2班,试学3班');
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

/** 取可领用物品字典 */
export async function getConsumeItems(): Promise<Array<{ name: string; price: number }>> {
  const rows = await db('t_consult_consume_item')
    .where({ is_deleted: false, is_enabled: true })
    .orderBy('sort_no', 'asc');
  return rows.map((r: any) => ({ name: r.item_name, price: r.price }));
}

/** 按名称查物品单价（分） */
export async function getItemPrice(name: string): Promise<number | null> {
  const row = await db('t_consult_consume_item')
    .where({ item_name: name, is_deleted: false })
    .first();
  return row ? row.price : null;
}
