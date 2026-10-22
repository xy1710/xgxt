/**
 * 通知中心（站内信）路由
 *
 * 前缀：/api/job/notice      表：t_job_notice
 *
 * ============================================================
 * 【为什么新写这个文件】
 *   本模块原来只"发"通知（utils/notice.ts 的 sendNotice），
 *   没有"读"的接口 —— 也就是站内信发出去就看不见。
 *
 *   2026-10-02 合并就业模块（齐晋霄）时，斌哥拍板「通知合一」：
 *   全模块只用一套通知。而就业部分的「消息通知」页面需要能读，
 *   所以这里把读取侧补齐（列表 / 未读数 / 标记已读）。
 *
 *   ⚠️ 同步废弃了就业部分原来的 t_notification 表与接口。
 * ============================================================
 */

import { Router } from 'express';
import { z } from 'zod';
import { BizCode } from 'shared-types';
import { ok, page } from '../utils/response';
import { db } from '../utils/db';
import { wrap } from '../utils/wrap';
import { validate } from '../middleware/validate';
import { BizError } from '../middleware/errorHandler';
import { fmtDateTime } from '../utils/date';
import { NOTICE_TABLE, NOTICE_TYPE } from '../utils/notice';
// ★ P3 切读层：t_job_notice（实训通知表）已归一（sms_job.t_job_notice → t_uni_notify），
//   全部走 tbl() 路由；开关关时与原实现逐字节等价。
import { tbl } from '../teaching/shared/uniTable';

/** ★ 老表所在库 + 统一表 edu_stage 取值（本路由只服务实训） */
const DB = 'sms_job';
const STAGE = 'job' as const;

export const noticeRouter = Router();

/** 通知类型中文名 */
const NOTICE_TYPE_NAME: Record<number, string> = {
  [NOTICE_TYPE.REPEAT]: '末班通知',
  [NOTICE_TYPE.TRANSFER]: '班级交接',
  [NOTICE_TYPE.ATTENDANCE]: '考勤异常',
  [NOTICE_TYPE.SYSTEM]: '系统通知',
  [NOTICE_TYPE.APPROVAL]: '审批通知',
  [NOTICE_TYPE.OTHER]: '其他',
};

function toVo(r: any) {
  return {
    id: r.id,
    noticeType: r.notice_type,
    typeName: NOTICE_TYPE_NAME[r.notice_type] || '',
    title: r.title,
    content: r.content,
    receiverId: r.receiver_id,
    receiverName: r.receiver_name,
    receiverRole: r.receiver_role,
    senderName: r.sender_name,
    bizType: r.biz_type,
    bizId: r.biz_id,
    className: r.class_name,
    studentName: r.student_name,
    isRead: !!r.is_read,
    readTime: fmtDateTime(r.read_time),
    createTime: fmtDateTime(r.create_time),
  };
}

/**
 * 「我的通知」过滤条件
 *
 * ⚠️ 本模块发通知时，收件人可能写的是：
 *    ① 真人 ID（如 T007 周铭）—— 按 receiver_id 匹配
 *    ② 角色码（如 TEACH_HEAD）—— receiver_id / receiver_role 都可能存
 *    所以三个条件取并集，避免"发出去的收不到"。
 */
function myNoticeWhere(query: any, user: { userId: string; roles: string[] }) {
  const roles = user.roles || [];
  return query.where(function (this: any) {
    this.where('receiver_id', user.userId);
    if (roles.length) {
      this.orWhereIn('receiver_id', roles);
      this.orWhereIn('receiver_role', roles);
    }
  });
}

/* ============================================================
 * 1. 我的通知列表
 *    GET /api/job/notice/list?noticeType=5&isRead=0&title=退费
 * ============================================================ */

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
  title: z.string().optional(),
  noticeType: z.coerce.number().int().optional(),
  isRead: z.coerce.number().int().min(0).max(1).optional(),
});

noticeRouter.get(
  '/list',
  validate(listSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as z.infer<typeof listSchema>;
    const user = req.user!;

    let query = tbl(db, DB, NOTICE_TABLE, STAGE).where('is_deleted', false);
    query = myNoticeWhere(query, user);

    if (q.title) query.andWhere('title', 'like', `%${q.title}%`);
    if (q.noticeType) query.andWhere('notice_type', q.noticeType);
    if (q.isRead !== undefined) query.andWhere('is_read', !!q.isRead);

    const [{ total }] = (await query.clone().count({ total: '*' })) as Array<{ total: number }>;

    const rows = await query
      .clone()
      .select('*')
      // 未读排前面，同状态按时间倒序 —— 重要的先看
      .orderBy('is_read', 'asc')
      .orderBy('create_time', 'desc')
      .limit(q.size)
      .offset((q.page - 1) * q.size);

    res.json(page(rows.map(toVo), Number(total), q));
  }),
);

/* ============================================================
 * 2. 未读数（侧边栏角标用）
 *    GET /api/job/notice/unread-count
 * ============================================================ */

noticeRouter.get(
  '/unread-count',
  wrap(async (req, res) => {
    let query = tbl(db, DB, NOTICE_TABLE, STAGE).where({ is_deleted: false, is_read: false });
    query = myNoticeWhere(query, req.user!);
    const [{ total }] = (await query.count({ total: '*' })) as Array<{ total: number }>;
    res.json(ok({ count: Number(total) }));
  }),
);

/* ============================================================
 * 3. 详情
 *    GET /api/job/notice/detail?id=xxx
 * ============================================================ */

noticeRouter.get(
  '/detail',
  validate(z.object({ id: z.string().min(1, '必须传 id') })),
  wrap(async (req, res) => {
    const { id } = (req as any).validated as { id: string };
    const row = await tbl(db, DB, NOTICE_TABLE, STAGE).where({ id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.PARAM_ERROR, '通知不存在或已被删除');
    res.json(ok(toVo(row)));
  }),
);

/* ============================================================
 * 4. 标记已读 / 未读
 *    PUT /api/job/notice/read   { id, isRead }
 * ============================================================ */

noticeRouter.put(
  '/read',
  validate(
    z.object({
      id: z.string().min(1, '必须传 id'),
      isRead: z.coerce.number().int().min(0).max(1).default(1),
    }),
  ),
  wrap(async (req, res) => {
    const { id, isRead } = (req as any).validated as { id: string; isRead: number };

    const row = await tbl(db, DB, NOTICE_TABLE, STAGE).where({ id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.PARAM_ERROR, '通知不存在或已被删除');

    await tbl(db, DB, NOTICE_TABLE, STAGE).where({ id }).update({
      is_read: !!isRead,
      read_time: isRead ? new Date() : null,
    });

    res.json(ok(null, isRead ? '已标记为已读' : '已标记为未读'));
  }),
);

/* ============================================================
 * 5. 全部已读
 *    PUT /api/job/notice/read-all
 * ============================================================ */

noticeRouter.put(
  '/read-all',
  wrap(async (req, res) => {
    let query = tbl(db, DB, NOTICE_TABLE, STAGE).where({ is_deleted: false, is_read: false });
    query = myNoticeWhere(query, req.user!);

    const affected = await query.update({ is_read: true, read_time: new Date() });
    res.json(ok({ count: affected }, `已将 ${affected} 条通知标记为已读`));
  }),
);

/* ============================================================
 * 6. 删除（逻辑删除）
 *    DELETE /api/job/notice/delete/:id
 * ============================================================ */

noticeRouter.delete(
  '/delete/:id',
  wrap(async (req, res) => {
    const { id } = req.params;
    const row = await tbl(db, DB, NOTICE_TABLE, STAGE).where({ id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.PARAM_ERROR, '通知不存在或已被删除');

    await tbl(db, DB, NOTICE_TABLE, STAGE).where({ id }).update({ is_deleted: true });
    res.json(ok(null, '删除成功'));
  }),
);

export default noticeRouter;
