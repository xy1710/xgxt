/**
 * 末班记录写入 · 老表 + 统一表双写
 * ============================================================
 *
 * 【为什么双写】
 *   本系统正在做「第 4 期统一表」迁移，开关 TEACHING_UNI_TABLE 决定**读**哪边。
 *   末班是新功能，写下去的数据必须两种模式都读得到：
 *     开关关（默认）：初高/大学档案读本库的 t_class_repeat
 *     开关开       ：档案读 sms_common.t_uni_repeat
 *   → 初高/大学两条都写；实训没有老表（sms_job 里根本没有 t_class_repeat），
 *     只写统一表。
 *
 * 【末班原因怎么拼「学员不足说明」】
 *   老表没有「不足说明」这一列，也不打算为它单独加列（斌哥 2026-10-19 拍板）：
 *   原因列本身是 varchar(500) 的自由文本，把说明拼在后面即可，
 *   档案里展示为「综合成绩未达标：上课走神、作业未完成」。
 *   ⚠️ 拼接后必须截到 500 字，否则 MySQL 在严格模式下直接报
 *      `Data too long for column 'repeat_reason'`，整个末班回滚。
 */

import { randomUUID } from 'crypto';
import { commonDb } from '../../class/db';
import type { TeachingStage } from '../shared/dto';

/** repeat_reason / remark 的列宽上限 */
const MAX_REASON = 500;

export interface RepeatRecordInput {
  stage: TeachingStage;
  studentId: string;
  studentNo: string;
  studentName: string;
  fromClassId: string | null;
  fromClassName: string | null;
  /** 阶段码（初高 101~107 / 大学 201~206）；实训无阶段码传 null */
  fromStageCode: number | null;
  toClassId: string;
  toClassName: string;
  toStageCode: number | null;
  repeatReason: string;
  repeatTime: Date;
  repeatCount: number;
  /** 触发末班的那场考试（只有大学老表有这几列） */
  examName?: string | null;
  writtenScore?: number | null;
  interviewScore?: number | null;
  compScore?: number | null;
  operatorId: string;
}

/** 末班原因 + 学员不足说明 → 一个可落库的字符串 */
export function composeRepeatReason(reason: string, shortcoming?: string | null): string {
  const r = String(reason ?? '').trim();
  const s = String(shortcoming ?? '').trim();
  const text = s ? `${r}：${s}` : r;
  return text.slice(0, MAX_REASON);
}

/** 把「学员不足说明」并进成绩备注（保留原有备注，不覆盖） */
export function mergeRemark(oldRemark: string | null | undefined, shortcoming: string): string {
  const old = String(oldRemark ?? '').trim();
  const add = String(shortcoming ?? '').trim();
  if (!add) return old;
  if (!old) return add.slice(0, MAX_REASON);
  if (old.includes(add)) return old.slice(0, MAX_REASON); // 重复末班同一句话不叠两遍
  return `${old}；${add}`.slice(0, MAX_REASON);
}

/**
 * 写统一表 sms_common.t_uni_repeat
 *
 * ⚠️ `edu_stage` 是 NOT NULL 且**没有默认值**（迁移 20261010_022 故意去掉的），
 *    不传就报 `Field 'edu_stage' doesn't have a default value`。
 */
export async function insertUniRepeat(r: RepeatRecordInput): Promise<string> {
  const id = randomUUID();
  await commonDb('t_uni_repeat').insert({
    id,
    edu_stage: r.stage,
    stage_code: r.fromStageCode,
    student_id: r.studentId,
    student_no: r.studentNo,
    student_name: r.studentName,
    from_class_id: r.fromClassId,
    from_class_name: r.fromClassName,
    from_stage: r.fromStageCode,
    to_class_id: r.toClassId,
    to_class_name: r.toClassName,
    to_stage: r.toStageCode,
    repeat_reason: r.repeatReason,
    repeat_time: r.repeatTime,
    repeat_count: r.repeatCount,
    exam_name: r.examName ?? null,
    written_score: r.writtenScore ?? null,
    interview_score: r.interviewScore ?? null,
    comp_score: r.compScore ?? null,
    is_deleted: 0,
    create_by: r.operatorId,
    create_time: new Date(),
  });
  return id;
}

/** 已结业的班不能接收末班学生（各学段 class_status 口径一致：4 = 已结业） */
export const CLASS_STATUS_GRADUATED = 4;

/**
 * 末班时间：只有日期（YYYY-MM-DD）时，取当天 + 当前时分秒
 *
 * ★ 不能直接 `new Date('2026-09-29')` —— 那会得到 UTC 00:00，
 *   在 +08:00 时区落库后变成 08:00，看起来像「上午 8 点末的班」。
 */
export function repeatTimeOf(date?: string | null): Date {
  const now = new Date();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? '').trim());
  if (!m) return now;
  return new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    now.getHours(),
    now.getMinutes(),
    now.getSeconds(),
  );
}

/** 今天（YYYY-MM-DD，本地时区） */
export function todayStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
