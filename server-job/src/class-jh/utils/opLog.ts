/**
 * 操作日志写入器（教学管理初高）
 *
 * 敏感操作（休学/退学/末班/交接/调宿/退费/班级状态变更）统一调用 writeOpLog，
 * 写入 t_class_op_log。日志写入失败不影响主流程（吞掉异常并打印）。
 *
 * 用法：
 *   await writeOpLog({
 *     module: 'student',
 *     bizType: '休学',
 *     bizId: flowId,
 *     studentId,
 *     opUserId: req.user?.userId,
 *     opUserName: req.user?.userName,
 *     opDesc: '学生休学审批通过',
 *     beforeValue: { studentStatus: 5 },
 *     afterValue: { studentStatus: 6 },
 *   });
 */

import { randomUUID } from 'crypto';
import { db } from './db';
// ★ P4 切读层：`t_class_op_log`（sms_class_jh）**已归一** → 写入走 tblIns()。
//   开关关时 `tblIns()` 退化为 `db('t_class_op_log').insert(剔掉统一表专有列后的 payload)`，
//   与原实现等价（payload 里本来就没有 edu_stage 之类的列）。
import { tblIns } from '../../teaching/shared/uniTable';

/** 操作日志表名 */
const OP_LOG_TABLE = 't_class_op_log';
/** 初高库 + 学段取值 */
const DB = 'sms_class_jh';
const STAGE = 'jh' as const;

/** 写入操作日志的入参 */
export interface OpLogInput {
  /** 子模块，如 student/class/dorm/refund */
  module?: string;
  /** 业务类型：休学/退学/末班/交接/调宿/退费/班级状态 */
  bizType: string;
  /** 业务主键 */
  bizId?: string;
  /** 关联学生 ID */
  studentId?: string;
  /** 关联班级 ID */
  classId?: string;
  /** 操作人 ID */
  opUserId?: string;
  /** 操作人姓名 */
  opUserName?: string;
  /** 操作描述 */
  opDesc?: string;
  /** 操作前值（对象） */
  beforeValue?: Record<string, any> | null;
  /** 操作后值（对象） */
  afterValue?: Record<string, any> | null;
  /** 操作时间（默认当前时间） */
  opTime?: Date;
}

/**
 * 写一条操作日志。
 *
 * ⚠️ 该函数永不抛错：日志写失败只打印告警，避免因日志问题影响主业务。
 */
export async function writeOpLog(input: OpLogInput): Promise<void> {
  try {
    await tblIns(db, DB, OP_LOG_TABLE, STAGE, {
      id: randomUUID(),
      module: input.module ?? null,
      biz_type: input.bizType,
      biz_id: input.bizId ?? null,
      student_id: input.studentId ?? null,
      class_id: input.classId ?? null,
      op_user_id: input.opUserId ?? null,
      op_user_name: input.opUserName ?? null,
      op_time: input.opTime ?? new Date(),
      op_desc: input.opDesc ?? null,
      before_value: input.beforeValue ? JSON.stringify(input.beforeValue) : null,
      after_value: input.afterValue ? JSON.stringify(input.afterValue) : null,
      is_deleted: false,
      create_time: new Date(),
      create_by: input.opUserId ?? 'system',
    });
  } catch (err) {
    // 日志失败不影响主流程
    console.warn('[writeOpLog] 操作日志写入失败：', (err as any)?.message || err);
  }
}
