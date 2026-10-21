/**
 * 账单明细 与 财务概览 · 路由
 * 接口前缀：/api/finance/bill 与 /api/finance/overview
 *
 * 接口清单：
 *   GET /api/finance/bill/list      账单明细列表（流水视角：一行一笔账单）
 *   GET /api/finance/bill/students  账单明细 · 按学员归集（原型口径：一行一个学员）
 *   GET /api/finance/bill/classes   账单明细可见班级字典（按学员归集的下拉用）
 *   GET /api/finance/bill/summary   账单汇总（缴费总额 / 退费总额）
 *   GET /api/finance/overview       财务概览（首页大屏）
 */

import { Router } from 'express';
import { z } from 'zod';
import { ok, page } from '../utils/response';
import { wrap } from '../utils/wrap';
import { validate } from '../middleware/validate';
import {
  toBillListItem,
  buildBillQuery,
  listBillStudents,
  listBillClasses,
  billSummary,
  financeOverview,
} from '../services/bill.service';

export const billRouter = Router();
export const overviewRouter = Router();

/* ============================================================
 * 1. 账单明细列表
 *    GET /api/finance/bill/list?page=1&size=20&billType=1
 * ============================================================ */

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
  studentNo: z.string().optional(),
  studentName: z.string().optional(),
  classId: z.string().optional(),
  deptCode: z.coerce.number().int().optional(),
  billType: z.coerce.number().int().min(1).max(2).optional(),
  // ★ 2026-10-15：上限 5 → 7（押金 / 校服）
  feeType: z.coerce.number().int().min(1).max(8).optional(),
  operatorName: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  keyword: z.string().optional(),
});

billRouter.get(
  '/list',
  validate(listSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as z.infer<typeof listSchema>;
    const query = buildBillQuery(q);

    const [{ total }] = await query.clone().count({ total: '*' });
    const rows = await query
      .clone()
      .select('*')
      .orderBy('bill_date', 'desc')
      .orderBy('bill_no', 'desc')
      .limit(q.size)
      .offset((q.page - 1) * q.size);

    res.json(page(rows.map(toBillListItem), Number(total), q));
  }),
);

/* ============================================================
 * 1bis. 账单明细 · 按学员归集（原型「缴费明细」口径）
 *       GET /api/finance/bill/students?page=1&size=20&deptCode=2&className=G101
 *
 * ⚠️ 与 /list 的区别（两种视角，都要保留）：
 *      /list      一行一笔账单 —— 对账、追流水用
 *      /students  一行一个学员 —— 看「这个学生一共交了哪些费、凭证在哪」用
 *
 * ⭐ 原型规则（学管财务管理原型-20260923）：
 *    列表显示学员信息 + 四类（学费/餐费/住宿费/保险费）的金额与笔数；
 *    点「详情」展开四类分组，再点某组展开该组每笔记录（日期 + 凭证号 + 查看凭证）。
 * ============================================================ */

const studentListSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
  studentNo: z.string().optional(),
  studentName: z.string().optional(),
  className: z.string().optional(),
  deptCode: z.coerce.number().int().optional(),
  keyword: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

billRouter.get(
  '/students',
  validate(studentListSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as z.infer<typeof studentListSchema>;
    const { rows, total } = await listBillStudents(q);
    res.json(page(rows, total, q));
  }),
);

/* ============================================================
 * 1ter. 账单明细 · 可见班级字典
 *       GET /api/finance/bill/classes?deptCode=2
 * ============================================================ */

billRouter.get(
  '/classes',
  validate(z.object({ deptCode: z.coerce.number().int().optional() })),
  wrap(async (req, res) => {
    const { deptCode } = (req as any).validated as { deptCode?: number };
    res.json(ok(await listBillClasses(deptCode)));
  }),
);

/* ============================================================
 * 2. 账单汇总
 *    GET /api/finance/bill/summary?startDate=2026-09-01&endDate=2026-09-30
 *
 * ⚠️ 汇总要跟列表用【同一套筛选条件】，
 *    否则会出现「列表 5 条，汇总却是 8 条的钱」这种对不上账的问题。
 * ============================================================ */

const summarySchema = listSchema.omit({ page: true, size: true });

billRouter.get(
  '/summary',
  validate(summarySchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as z.infer<typeof summarySchema>;
    const data = await billSummary(q);
    res.json(ok(data, '统计成功'));
  }),
);

/* ============================================================
 * 3. 财务概览
 *    GET /api/finance/overview
 * ============================================================ */

overviewRouter.get(
  '/overview',
  wrap(async (_req, res) => {
    const data = await financeOverview();
    res.json(ok(data, '查询成功'));
  }),
);

export default billRouter;
