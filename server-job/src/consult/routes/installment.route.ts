/**
 * ★ 2026-10-16 分期付款路由
 *
 * 路径前缀：/api/consult/fee/plan
 *
 * 职责：
 *   · 创建分期计划（一次发起收费拆成 N 期）
 *   · 缴某一期（独立向财务建一张本期金额的收款单）
 *   · 查看计划 / 期次 / 学生账本（应收 / 已收 / 优惠 / 待缴）
 */

import { Router } from 'express';
import { z } from 'zod';
import { BizCode } from 'shared-types/consult';
import { BizError } from '../middleware/errorHandler';
import { ok, page as pageResp } from '../utils/response';
import { wrap } from '../utils/wrap';
import { validate } from '../middleware/validate';
import {
  PLAN_TABLE,
  createInstallmentPlan,
  payStage,
  listPlans,
  planDetail,
  getStudentLedger,
  syncPlanProgress,
  syncAllPlans,
} from '../services/installment.service';
// ★ 2026-10-16 数据范围：咨询师只看/只操作自己名下学生的分期
import { assertStudentIdInScope, scopedStudentIds } from '../services/data-scope';
import { db } from '../utils/db';

export const installmentRouter = Router();

/* ============================================================
 * 1. 创建分期计划
 *    POST /api/consult/fee/plan/create
 * ============================================================ */

const createSchema = z.object({
  consultStudentId: z.string().min(1, '学生不能为空'),
  feeTypes: z.array(z.coerce.number().int()).min(1, '至少勾选一项费用').max(7),
  /** 实缴自定义（分），key = feeType */
  amountByType: z.record(z.coerce.string(), z.coerce.number().int()).optional(),
  payMethod: z.string().max(20).optional(),
  stages: z
    .array(
      z.object({
        stageNo: z.coerce.number().int().min(1),
        amount: z.coerce.number().int().min(1, '每期金额必须大于 0'),
        dueDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, '到期日格式应为 YYYY-MM-DD')
          .optional(),
      }),
    )
    .min(2, '分期至少需要 2 期')
    .max(12, '最多支持 12 期'),
  remark: z.string().max(200).optional(),
  startFirstStage: z.boolean().optional(),
  /**
   * ★ 2026-10-19 用户口径：「只要缴费就要有凭证」。
   *    创建分期 = 立刻收第 1 期，所以凭证必须随计划一起传。
   *    ⚠️ 这里 optional、handler 里显式校验 —— zod 缺字段的默认提示看不出人话。
   */
  voucherUrl: z.string().optional(),
  voucherNo: z.string().max(100).optional(),
});

installmentRouter.post(
  '/create',
  validate(createSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof createSchema>;
    const operator = req.user!;

    // ★ 2026-10-16 数据范围：咨询师只能给名下学生建分期
    await assertStudentIdInScope(body.consultStudentId, req.user);

    // ★ 2026-10-19 只要缴费就要有凭证（创建分期即收第 1 期）
    if (!body.voucherUrl) {
      throw new BizError(BizCode.PARAM_ERROR, '请先上传缴费凭证截图');
    }

    // zod 的 record 出来 key 是 string，转回 number key
    const amountByType: Record<number, number> | undefined = body.amountByType
      ? Object.fromEntries(
          Object.entries(body.amountByType).map(([k, v]) => [Number(k), Number(v)]),
        )
      : undefined;

    const plan = await createInstallmentPlan(
      {
        consultStudentId: body.consultStudentId,
        feeTypes: body.feeTypes as any,
        amountByType,
        payMethod: body.payMethod,
        stages: body.stages,
        remark: body.remark,
        startFirstStage: body.startFirstStage,
        voucherUrl: body.voucherUrl,
        voucherNo: body.voucherNo,
      },
      { name: operator.userName, title: operator.roleTitle },
    );

    res.json(ok(plan, `分期计划 ${plan.planNo} 已创建`));
  }),
);

/* ============================================================
 * 2. 缴某一期
 *    POST /api/consult/fee/plan/pay
 * ============================================================ */

const paySchema = z.object({
  planId: z.string().min(1, '分期计划不能为空'),
  stageNo: z.coerce.number().int().min(1),
  payMethod: z.string().max(20).optional(),
  /** 本期实收（分），不传 = 本期应收 */
  amount: z.coerce.number().int().positive().optional(),
  /**
   * ★ 2026-10-19 用户口径：「只要缴费就要有凭证」。
   *    缴每一期都必须带凭证，不再允许先建单后补传。
   */
  voucherUrl: z.string().optional(),
  voucherNo: z.string().max(100).optional(),
});

installmentRouter.post(
  '/pay',
  validate(paySchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof paySchema>;
    const operator = req.user!;

    // ★ 2026-10-16 数据范围：咨询师只能收自己名下学生的分期款
    const planRow: any = await db(PLAN_TABLE).where({ id: body.planId }).first();
    if (planRow?.consult_student_id) {
      await assertStudentIdInScope(planRow.consult_student_id, req.user);
    }

    // ★ 2026-10-19 只要缴费就要有凭证
    if (!body.voucherUrl) {
      throw new BizError(BizCode.PARAM_ERROR, '请先上传缴费凭证截图');
    }

    const plan = await payStage(body, {
      name: operator.userName,
      title: operator.roleTitle,
    });

    res.json(
      ok(plan, `第 ${body.stageNo} 期收款单已发起${body.voucherUrl ? '，凭证已同步，等待财务确认' : ''}`),
    );
  }),
);

/* ============================================================
 * 3. 计划列表
 *    GET /api/consult/fee/plan/list
 * ============================================================ */

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
  consultStudentId: z.string().optional(),
  status: z.coerce.number().int().optional(),
  keyword: z.string().optional(),
});

installmentRouter.get(
  '/list',
  validate(listSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as z.infer<typeof listSchema>;
    const { list, total } = await listPlans({
      ...q,
      scopedStudentIds: await scopedStudentIds(req.user),
    });
    res.json(pageResp(list, total, q));
  }),
);

/* ============================================================
 * 4. 计划详情
 *    GET /api/consult/fee/plan/detail?id=xxx
 * ============================================================ */

installmentRouter.get(
  '/detail',
  wrap(async (req, res) => {
    const id = String(req.query.id || '');
    if (!id) throw new Error('缺少参数 id');
    const plan = await planDetail(id);
    res.json(ok(plan));
  }),
);

/* ============================================================
 * 5. 学生缴费账本（应收 / 已收 / 优惠 / 待缴）
 *    GET /api/consult/fee/plan/ledger?consultStudentId=xxx
 * ============================================================ */

installmentRouter.get(
  '/ledger',
  wrap(async (req, res) => {
    const consultStudentId = String(req.query.consultStudentId || '');
    if (!consultStudentId) throw new Error('缺少参数 consultStudentId');
    // ★ 2026-10-16 数据范围：咨询师只能看自己名下学生的账本
    await assertStudentIdInScope(consultStudentId, req.user);
    const ledger = await getStudentLedger(consultStudentId);
    res.json(ok(ledger));
  }),
);

/* ============================================================
 * 6. 手动回算进度
 *    POST /api/consult/fee/plan/sync
 *
 * ⚠️ 正常由收款单到账同步自动带出，这里留一个手动入口：
 *    财务在后台直接改了单据状态、想立刻看到分期进度时用。
 * ============================================================ */

const syncSchema = z.object({
  planId: z.string().optional(),
});

installmentRouter.post(
  '/sync',
  validate(syncSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof syncSchema>;
    if (body.planId) {
      await syncPlanProgress(body.planId);
      res.json(ok(null, '已回算'));
    } else {
      const r = await syncAllPlans();
      res.json(ok(null, `已回算 ${r.updated} 个在途计划`));
    }
  }),
);

export default installmentRouter;
