/**
 * 流失记录路由
 *
 * 路径前缀：/api/consult/loss
 *
 * ⚠️ 口径说明（严格对齐流程图的两个分支）：
 *
 *    流程图「是否当场报名 → 否」→ 记录未报名原因 + 后续跟进计划
 *    流程图「是否转正式 → 否」  → 记录流失原因、统计流失数量
 *
 *    所以本模块区分三种「没成交」：
 *      · NOT_ENROLLED 未报名·待跟进 —— **支持二次来访**，计入跟进待办，**不计流失**
 *      · LOST         流失          —— 明确不来，**计入流失统计**
 *      · REJECTED     未通过        —— 面试没收，**不计统计、不计流失**
 *
 *    流失率 = 流失人数 / (总人数 - 未通过人数) × 100%
 *    （未报名算在分母里 —— 人确实来过，只是还没成交）
 */

import { Router } from 'express';
import { z } from 'zod';
import { ConsultState } from 'shared-types/consult';
import type { LossRecordItem, LossStats, NotEnrolledItem } from 'shared-types/consult';
import { ok, page } from '../utils/response';
import { db } from '../utils/db';
import { wrap } from '../utils/wrap';
import { validate } from '../middleware/validate';
import { formatTime } from '../services/student.service';
// ★ 2026-10-16 数据范围：咨询师只看自己名下的流失 / 未报名记录
import { applyStudentScope } from '../services/data-scope';

export const lossRouter = Router();

/* ============================================================
 * 1. 流失记录列表
 *    GET /api/consult/loss/list
 * ============================================================ */

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
  studentName: z.string().optional(),
  ownerName: z.string().optional(),
  keyword: z.string().optional(),
});

lossRouter.get(
  '/list',
  validate(listSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as z.infer<typeof listSchema>;

    const query = db('t_consult_student')
      .where({ is_deleted: false, consult_state: ConsultState.LOST });

    // ★ 2026-10-16 数据范围：咨询师只看自己名下的流失记录
    applyStudentScope(query, req.user);

    if (q.studentName) query.andWhere('student_name', 'like', `%${q.studentName}%`);
    if (q.ownerName) query.andWhere('owner_name', 'like', `%${q.ownerName}%`);
    if (q.keyword) {
      query.andWhere((qb) => {
        qb.where('student_name', 'like', `%${q.keyword}%`)
          .orWhere('owner_name', 'like', `%${q.keyword}%`)
          .orWhere('loss_reason', 'like', `%${q.keyword}%`);
      });
    }

    const [{ total }] = await query.clone().count({ total: '*' });

    const rows: any[] = await query
      .clone()
      .select('*')
      .orderBy('update_time', 'desc')
      .limit(q.size)
      .offset((q.page - 1) * q.size);

    const list: LossRecordItem[] = rows.map((r) => ({
      consultStudentId: r.id,
      studentName: r.student_name,
      ownerName: r.owner_name || undefined,
      lossReason: r.loss_reason || '未填写',
      createTime: formatTime(r.update_time || r.create_time),
    }));

    res.json(page(list, Number(total), q));
  }),
);

/* ============================================================
 * 1.1 ⭐ 未报名·待跟进列表（流程图：「是否当场报名 → 否」）
 *     GET /api/consult/loss/not-enrolled
 *
 * ⚠️ 独立于流失列表：这批人还能二次来访，是「可挽回」名单，
 *    和「明确不来」的流失混在一起会失去行动意义。
 * ============================================================ */

lossRouter.get(
  '/not-enrolled',
  validate(listSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as z.infer<typeof listSchema>;

    const query = db('t_consult_student')
      .where({ is_deleted: false, consult_state: ConsultState.NOT_ENROLLED });

    // ★ 2026-10-16 数据范围：咨询师只看自己名下的未报名名单
    applyStudentScope(query, req.user);

    if (q.studentName) query.andWhere('student_name', 'like', `%${q.studentName}%`);
    if (q.ownerName) query.andWhere('owner_name', 'like', `%${q.ownerName}%`);
    if (q.keyword) {
      query.andWhere((qb) => {
        qb.where('student_name', 'like', `%${q.keyword}%`)
          .orWhere('owner_name', 'like', `%${q.keyword}%`)
          .orWhere('loss_reason', 'like', `%${q.keyword}%`);
      });
    }

    const [{ total }] = await query.clone().count({ total: '*' });

    const rows: any[] = await query
      .clone()
      .select('*')
      .orderBy('update_time', 'desc')
      .limit(q.size)
      .offset((q.page - 1) * q.size);

    const list: NotEnrolledItem[] = rows.map((r) => ({
      consultStudentId: r.id,
      studentName: r.student_name,
      ownerName: r.owner_name || undefined,
      reason: r.loss_reason || '未填写',
      createTime: formatTime(r.update_time || r.create_time),
    }));

    res.json(page(list, Number(total), q));
  }),
);

/* ============================================================
 * 2. 流失统计
 *    GET /api/consult/loss/stats
 * ============================================================ */

lossRouter.get(
  '/stats',
  wrap(async (req, res) => {
    // 流失人数（★ 2026-10-16 咨询师只统计自己名下的）
    const lossQuery = db('t_consult_student').where({
      is_deleted: false,
      consult_state: ConsultState.LOST,
    });
    applyStudentScope(lossQuery, req.user);
    const lossRow: any = await lossQuery.count({ c: '*' }).first();

    // 参与统计的总数（排除「未通过」）
    const totalQuery = db('t_consult_student')
      .where({ is_deleted: false })
      .whereNot('consult_state', ConsultState.REJECTED);
    applyStudentScope(totalQuery, req.user);
    const totalRow: any = await totalQuery.count({ c: '*' }).first();

    const lossCount = Number(lossRow?.c || 0);
    const totalCount = Number(totalRow?.c || 0);
    const lossRate = totalCount > 0 ? Math.round((lossCount / totalCount) * 1000) / 10 : 0;

    res.json(ok({ lossCount, totalCount, lossRate } as LossStats));
  }),
);

export default lossRouter;
