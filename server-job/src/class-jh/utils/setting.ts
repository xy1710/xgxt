/**
 * 系统设置读取助手（教学管理初高）
 *
 * 阈值一律不写死，从 t_class_setting 读取；缺失时用默认值兜底。
 *
 * 预置键：attendanceTargetRate(90)、attendanceScope(JSON)、feeRemindDays(7)、
 *        feeUrgeWindowDays(20)、refundThresholdAmount(500000)、
 *        closedClassIntakeTypes([1,2])、allowStudentAdd(false)。
 *
 * ★ 两个「天数」别混（2026-10-20 用户要求新增窗口）：
 *   · feeUrgeWindowDays = 催费列表**窗口**：到期日距今 ≤ N 天的缴费单才进催费列表（含已逾期）
 *   · feeRemindDays     = 催费**标红**：未结清且剩余 ≤ N 天打「紧急」标记
 *   窗口是门槛（进不进列表），标红是视觉提示，两者语义不同，不能合成一个数。
 */

import { db } from './db';
// ★ P4 切读层：`t_class_setting`（sms_class_jh）**已归一** → 读走 tbl()。
//   开关关时 `tbl()` 退化为 `db('t_class_setting')`，SQL 一字不差。
import { tbl } from '../../teaching/shared/uniTable';

/** 设置表 */
const SETTING_TABLE = 't_class_setting';
/** 初高库 + 学段取值 */
const DB = 'sms_class_jh';
const STAGE = 'jh' as const;

/** 默认值（与种子/ARCH 一致） */
export const SETTING_DEFAULTS: Record<string, string> = {
  attendanceTargetRate: '90',
  attendanceScope: JSON.stringify({ shouldStatuses: [3, 4, 5], presentStatuses: [1, 2] }),
  feeRemindDays: '7',
  feeUrgeWindowDays: '20',
  refundThresholdAmount: '500000',
  closedClassIntakeTypes: JSON.stringify([1, 2]),
  allowStudentAdd: 'false',
};

/** 读取全部设置（KV 映射） */
export async function getAllSettings(): Promise<Record<string, string>> {
  const rows = await tbl(db, DB, SETTING_TABLE, STAGE).where('is_deleted', false).select('setting_key', 'setting_value');
  const map: Record<string, string> = { ...SETTING_DEFAULTS };
  for (const r of rows) {
    if (r.setting_value !== null && r.setting_value !== undefined) {
      map[r.setting_key] = String(r.setting_value);
    }
  }
  return map;
}

/** 读取单个设置字符串值 */
export async function getSetting(key: string): Promise<string> {
  const row = await tbl(db, DB, SETTING_TABLE, STAGE).where({ setting_key: key, is_deleted: false }).first();
  if (row && row.setting_value !== null && row.setting_value !== undefined) {
    return String(row.setting_value);
  }
  return SETTING_DEFAULTS[key] ?? '';
}

/** 读取单个设置数字值 */
export async function getNumberSetting(key: string): Promise<number> {
  const raw = await getSetting(key);
  const n = Number(raw);
  return Number.isNaN(n) ? Number(SETTING_DEFAULTS[key] ?? 0) : n;
}

/** 读取单个设置 JSON 值 */
export async function getJsonSetting<T>(key: string): Promise<T> {
  const raw = await getSetting(key);
  try {
    return JSON.parse(raw) as T;
  } catch {
    return JSON.parse(SETTING_DEFAULTS[key] ?? '{}') as T;
  }
}
