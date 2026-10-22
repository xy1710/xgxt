/**
 * 通知服务（站内信）
 *
 * 归属模块：就业管理 > 实训阶段
 *
 * 【职责】
 *   别的业务（末班、交接…）需要发通知时，调这里的函数，不用自己写 INSERT。
 *
 * 【设计说明】
 *   - 站内信 = 通知落在数据库，收件人登录后能看到（含未读红点）
 *   - 不依赖外部服务（短信/微信都没接）
 *   - 支持传 trx（事务），保证"业务操作 + 发通知"要么都成功、要么都回滚
 *
 * 【用法】
 *   // 单独发（自动开事务）
 *   await sendNotice({ noticeType: 1, title: '...', receiverId: 'T002', ... });
 *
 *   // 在事务里发（推荐，与业务同生共死）
 *   await db.transaction(async (trx) => {
 *     await doSomething(trx);
 *     await sendNotice({ ... }, trx);
 *   });
 */

import { randomUUID } from 'crypto';
import type { Knex } from 'knex';
import { db } from '../utils/db';
// ★ 切读层：通知表 t_job_notice 在 sms_job（学段固定 job）已归一 → 切读；开关关时与原实现等价
import { tblIns, tblInsTrx } from '../teaching/shared/uniTable';

const DB = 'sms_job';
const STAGE = 'job' as const;

/** 通知表名 */
export const NOTICE_TABLE = 't_job_notice';

/** 通知类型（与 enums.ts 的 NoticeType 对齐） */
export const NOTICE_TYPE = {
  /** 末班通知 */
  REPEAT: 1,
  /** 班级交接 */
  TRANSFER: 2,
  /** 考勤异常 */
  ATTENDANCE: 3,
  /** 系统通知 */
  SYSTEM: 4,
  /** 审批通知（退费/休学/退学 的提交、通过、驳回、撤回） */
  APPROVAL: 5,
  /** 其他 */
  OTHER: 9,
} as const;

/** 发通知的入参 */
export interface SendNoticeParams {
  /** 通知类型 */
  noticeType: number;
  /** 标题 */
  title: string;
  /** 正文（可选） */
  content?: string;

  /** 收件人 */
  receiverId: string;
  receiverName?: string | null;
  receiverRole?: string | null;

  /** 发件人（可选，系统发的可以不填） */
  senderId?: string | null;
  senderName?: string | null;

  /** 关联业务 */
  bizType?: string | null;
  bizId?: string | null;
  classId?: string | null;
  className?: string | null;
  studentId?: string | null;
  studentName?: string | null;
}

/**
 * 发一条通知
 *
 * @param params 通知内容
 * @param trxOpt 可选的事务对象。传了就参与该事务（推荐）
 * @returns 通知ID
 */
export async function sendNotice(
  params: SendNoticeParams,
  trxOpt?: Knex.Transaction,
): Promise<string> {
  const id = randomUUID();
  const now = new Date();

  const row = {
    id,
    create_time: now,
    create_by: params.senderId || null,
    is_deleted: false,

    notice_type: params.noticeType,
    title: params.title,
    content: params.content || null,

    receiver_id: params.receiverId,
    receiver_name: params.receiverName || null,
    receiver_role: params.receiverRole || null,

    sender_id: params.senderId || null,
    sender_name: params.senderName || null,

    biz_type: params.bizType || null,
    biz_id: params.bizId || null,
    class_id: params.classId || null,
    class_name: params.className || null,
    student_id: params.studentId || null,
    student_name: params.studentName || null,

    is_read: false,
    read_time: null,
  };

  if (trxOpt) {
    await tblInsTrx(trxOpt, DB, NOTICE_TABLE, STAGE, row);
  } else {
    await tblIns(db, DB, NOTICE_TABLE, STAGE, row);
  }

  return id;
}

/**
 * 批量发通知（同一内容给多人）
 *
 * @returns 发出的通知条数
 */
export async function sendNoticeBatch(
  base: Omit<SendNoticeParams, 'receiverId' | 'receiverName' | 'receiverRole'>,
  receivers: Array<{ id: string; name?: string | null; role?: string | null }>,
  trxOpt?: Knex.Transaction,
): Promise<number> {
  if (!receivers.length) return 0;

  const now = new Date();
  const rows = receivers.map((r) => ({
    id: randomUUID(),
    create_time: now,
    create_by: base.senderId || null,
    is_deleted: false,

    notice_type: base.noticeType,
    title: base.title,
    content: base.content || null,

    receiver_id: r.id,
    receiver_name: r.name || null,
    receiver_role: r.role || null,

    sender_id: base.senderId || null,
    sender_name: base.senderName || null,

    biz_type: base.bizType || null,
    biz_id: base.bizId || null,
    class_id: base.classId || null,
    class_name: base.className || null,
    student_id: base.studentId || null,
    student_name: base.studentName || null,

    is_read: false,
    read_time: null,
  }));

  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    if (trxOpt) {
      await tblInsTrx(trxOpt, DB, NOTICE_TABLE, STAGE, chunk);
    } else {
      await tblIns(db, DB, NOTICE_TABLE, STAGE, chunk);
    }
  }

  return rows.length;
}
