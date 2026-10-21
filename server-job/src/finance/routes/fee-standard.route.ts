/**
 * 费用标准 · 路由
 * 接口前缀：/api/finance/standard
 *
 * 接口清单：
 *   GET    /list    费用标准列表
 *   POST   /save    保存（新增或更新）
 *   POST   /delete  逻辑删除
 *   GET    /get     ⭐ 取标准金额（供咨询/教务模块跨模块调用）
 */

import { Router } from 'express';
import { z } from 'zod';
import { ok, page } from '../utils/response';
import { wrap } from '../utils/wrap';
import { validate } from '../middleware/validate';
import { checkPermission } from '../middleware/auth';
import {
  toStandardItem,
  buildStandardQuery,
  saveStandard,
  removeStandard,
  getStandard,
} from '../services/fee-standard.service';

export const standardRouter = Router();

function operatorOf(req: any): { userId: string; userName: string } {
  return {
    userId: req.user?.userId || 'system',
    userName: req.user?.userName || '系统',
  };
}

/* ============================================================
 * 1. 费用标准列表
 *    GET /api/finance/standard/list?page=1&size=50
 * ============================================================ */

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(50),
  // ★ 2026-10-15：上限 5 → 7（押金 / 校服）
  feeType: z.coerce.number().int().min(1).max(8).optional(),
  // ★ 2026-10-20 部门拆成 1初中部 / 3高中部 / 2大学部
deptCode: z.coerce.number().int().min(1).max(3).optional(),
  onlyEnabled: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

standardRouter.get(
  '/list',
  validate(listSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as z.infer<typeof listSchema>;
    const query = buildStandardQuery(q);

    const [{ total }] = await query.clone().count({ total: '*' });
    const rows = await query
      .clone()
      .select('*')
      .orderBy([{ column: 'dept_code' }, { column: 'fee_type' }])
      .limit(q.size)
      .offset((q.page - 1) * q.size);

    res.json(page(rows.map(toStandardItem), Number(total), q));
  }),
);

/* ============================================================
 * 2. 保存费用标准
 *    POST /api/finance/standard/save
 *
 * 不传 id 时按 【费用类型 + 部门】 upsert。
 * ⚠️ 改金额只影响之后新建的费用单，历史单据金额不变。
 * ============================================================ */

const saveSchema = z.object({
  id: z.string().optional(),
  // ★ 2026-10-15：费用类型上限 5 → 7（新增「押金 6 / 校服 7」）
  feeType: z.coerce.number().int().min(1).max(8, '费用类型取值 1~8'),
  deptCode: z.coerce.number().int().min(1).max(3, '部门取值 1(初中部) 3(高中部) 2(大学部)'),
  amount: z.coerce.number().int().min(0, '标准金额必须大于等于 0（单位：分）'),
  isEnabled: z.boolean().optional(),
  remark: z.string().max(500).optional(),
});

standardRouter.post(
  '/save',
  checkPermission('finance:standard:manage'),
  validate(saveSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof saveSchema>;
    const r = await saveStandard(body, operatorOf(req));

    const msg = r.created
      ? '新增成功'
      : `已更新标准金额${r.oldAmount != null ? `（原 ${(r.oldAmount / 100).toFixed(2)} 元）` : ''}，仅对之后新建的费用单生效`;

    res.json(ok(r, msg));
  }),
);

/* ============================================================
 * 3. 逻辑删除
 *    POST /api/finance/standard/delete
 * ============================================================ */

standardRouter.post(
  '/delete',
  checkPermission('finance:standard:manage'),
  validate(z.object({ id: z.string().min(1, '必须传 id') })),
  wrap(async (req, res) => {
    const body = (req as any).validated as { id: string };
    await removeStandard(body.id, operatorOf(req));
    res.json(ok(null, '已删除'));
  }),
);

/* ============================================================
 * 4. ⭐ 取标准金额（跨模块联动接口）
 *    GET /api/finance/standard/get?feeType=1&deptCode=1
 *
 * 调用方：市场咨询(8001)、教务管理(8002)
 *   上游建费用单前先取金额，不要自己写死 ¥12800。
 *
 * ⚠️ 跨模块三铁律：
 *    ① 不直接读别人表（所以对方调我）
 *    ② 设超时
 *    ③ 失败要有兜底 —— 本接口【不挂 checkPermission】，
 *       并且配置缺失时返回业务错误码而不是 500，让对方能友好提示
 * ============================================================ */

const getSchema = z.object({
  // ★ 2026-10-15：费用类型上限 5 → 7（新增「押金 6 / 校服 7」）
  feeType: z.coerce.number().int().min(1).max(8, '费用类型取值 1~8'),
  deptCode: z.coerce.number().int().min(1).max(3, '部门取值 1(初中部) 3(高中部) 2(大学部)'),
});

standardRouter.get(
  '/get',
  // 不挂 checkPermission：跨模块机器调用
  validate(getSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as z.infer<typeof getSchema>;
    const result = await getStandard(q.feeType, q.deptCode);
    res.json(ok(result, '查询成功'));
  }),
);

export default standardRouter;
