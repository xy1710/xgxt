/**
 * 缴费管理 · 路由
 * 接口前缀：/api/finance/fee
 *
 * 接口清单（与 shared-types/src/api/finance.api.ts 契约一一对应）：
 *   GET    /list          缴费列表（分页 + 筛选）
 *   GET    /detail        缴费详情
 *   POST   /add           新增缴费单
 *   POST   /verify        财务核对通过（生成账单）
 *   POST   /reject        财务打回
 *   POST   /batch-verify  批量核对
 */

import { Router } from 'express';
import { z } from 'zod';
import { BizCode } from 'shared-types/finance';
import { ok, page } from '../utils/response';
import { db } from '../utils/db';
import { wrap } from '../utils/wrap';
import { validate } from '../middleware/validate';
import { checkPermission } from '../middleware/auth';
import { BizError } from '../middleware/errorHandler';
import {
  FEE_TABLE,
  toFeeListItem,
  toFeeDetail,
  buildFeeQuery,
  verifyFee,
  rejectFee,
  batchVerifyFee,
  addFee,
  findVoucherSharers,
  attachVoucher,
  listFeeClasses,
  statsFee,
  voucherGroupMap,
  voucherGroupOf,
  cancelFee,
} from '../services/fee.service';
// ★ 2026-10-05：缴费单新增/变更后推送到班级管理（只读副本），失败不影响主流程
// ★ 2026-10-06：收方扩到「大学部 + 初高」，故改调 syncFeeToAll / syncFeesToAll
import { syncFeeToAll, syncFeesToAll } from '../services/class-sync';
// ★ 2026-10-20：财务缴费单的学生姓名/班级以学生档案为准（能对上就对，对不上保持原样）
import { lookupArchive, applyArchiveToFeeRows } from '../services/student-archive';

export const feeRouter = Router();

/** 取当前操作人（开发期是假用户，接登录后自动变成真人） */
function operatorOf(req: any): { userId: string; userName: string } {
  return {
    userId: req.user?.userId || 'system',
    userName: req.user?.userName || '系统',
  };
}

/* ============================================================
 * 1. 缴费列表
 *    GET /api/finance/fee/list?page=1&size=20&payStatus=2
 * ============================================================ */

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
  studentNo: z.string().optional(),
  studentName: z.string().optional(),
  classId: z.string().optional(),
  /** 班级名（精确），班级下拉选出来的值直接用它筛，兼容只写班级名没写 class_id 的老数据 */
  className: z.string().optional(),
  deptCode: z.coerce.number().int().optional(),
  feeType: z.coerce.number().int().optional(),
  /** 来源模块筛选，取值来自 SourceModule */
  sourceModule: z.coerce.number().int().min(1).max(3).optional(),
  payStatus: z.coerce.number().int().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  keyword: z.string().optional(),
});

feeRouter.get(
  '/list',
  validate(listSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as z.infer<typeof listSchema>;
    const query = buildFeeQuery(q);

    const [{ total }] = await query.clone().count({ total: '*' });

    /**
     * ⭐ 排序（2026-10-15 用户指令）：「待核对 → 已缴 → 已打回」
     *
     * 为什么：
     *   缴费管理是财务的【核对工作台】，财务进来第一眼要看到的是
     *   「还有哪些单等着我核对」，而不是最新的单。
     *
     * 怎么排（三级）：
     *   ① 待核对（未核对 + 未打回）→ 0，排最前
     *   ② 已缴（已核对）           → 1
     *   ③ 已打回（等上游重传凭证）  → 2，排最后
     *   同组内仍按 create_time desc（新单在前）。
     *
     * ⚠️ 判断用的是 is_verified / is_rejected 而不是 pay_status：
     *    打回单的 pay_status 仍是 PAID(2)，用 pay_status 会把打回单
     *    误当成待核对排到最前面，反而干扰财务。
     *
     * ⚠️ 冻结单据已由 buildFeeQuery 硬性排除，不会进入本列表。
     */
    const rows = await query
      .clone()
      .select('*')
      .orderByRaw('CASE WHEN is_rejected = 1 THEN 2 WHEN is_verified = 1 THEN 1 ELSE 0 END ASC')
      .orderBy('create_time', 'desc')
      .limit(q.size)
      .offset((q.page - 1) * q.size);

    /**
     * ★ 2026-10-20 合并 main 时两段逻辑合到一处（先档案对齐 → 再按凭证聚合）：
     *
     * ① 学生姓名 / 班级 / 部门以学生档案最新值为准（meng 侧）：
     *    财务的单有两个来源：报名前的咨询收费单（此时学生还没进学籍档案）、
     *    报名后的补单（档案里已有）。所以口径是「能对上就对齐，对不上保持原样」——
     *    对不上的不删不改（那是「尚未建档」的真实状态，不是脏数据）。
     *
     * ② 把「这张凭证覆盖了几笔、合计多少」带给前端（main 侧）：
     *    用户反馈「缴费凭证和实缴金额对不上」的根因：一次缴清多项费用时，
     *    一张转账截图挂在多张单据上，本单 amount 只是其中一项（学费 28000），
     *    凭证截图却是合计（32400）。列表里不标出来，财务只会以为数据错了。
     *    这里只做一次聚合（本页凭证去重后 IN 查询），不产生 N+1。
     *
     * ⚠️ 顺序不能反：档案对齐只改姓名/班级/部门，不动 voucher_url，
     *    所以先对齐再聚合，与「先聚合再对齐」结果一致；但先对齐能保证
     *    聚合用的就是最终返回给前端的那批行，避免以后加字段时踩坑。
     */
    const { rows: rowsWithArchive } = applyArchiveToFeeRows(
      rows,
      await lookupArchive(
        rows.map((r: any) => r.student_id),
        rows.map((r: any) => r.student_no),
      ),
    );

    const groupMap = await voucherGroupMap(rowsWithArchive.map((r: any) => r.voucher_url));

    const list = rowsWithArchive.map((r: any) => {
      const item = toFeeListItem(r);
      const g = r.voucher_url ? groupMap.get(String(r.voucher_url)) : undefined;
      return {
        ...item,
        voucherGroupCount: g?.count ?? 1,
        voucherGroupAmount: g?.amount ?? item.amount,
      };
    });
    res.json(page(list, Number(total), q));
  }),
);

/* ============================================================
 * 1.1 班级字典 —— 「所有拥有的班级」
 *     GET /api/finance/fee/classes?deptCode=2
 *
 * ⚠️ 前端班级下拉原来只能从「当前页数据」去重，翻页就变、没缴费的班看不到。
 *    这个接口从「缴费单 + 学生表」合并出全量班级，一次性给前端做下拉。
 * ============================================================ */

feeRouter.get(
  '/classes',
  validate(
    z.object({
      deptCode: z.coerce.number().int().optional(),
    }),
  ),
  wrap(async (req, res) => {
    const { deptCode } = (req as any).validated as { deptCode?: number };
    res.json(ok(await listFeeClasses(deptCode)));
  }),
);

/* ============================================================
 * 1.2 缴费状态统计（全量口径，工具栏内联统计用）
 *     GET /api/finance/fee/stats?payStatus=2&deptCode=1
 * ============================================================ */

feeRouter.get(
  '/stats',
  validate(listSchema.omit({ page: true, size: true })),
  wrap(async (req, res) => {
    const q = (req as any).validated as any;
    res.json(ok(await statsFee(q)));
  }),
);

/* ============================================================
 * 2. 缴费详情
 *    GET /api/finance/fee/detail?id=xxx
 * ============================================================ */

feeRouter.get(
  '/detail',
  validate(z.object({ id: z.string().min(1, '必须传 id') })),
  wrap(async (req, res) => {
    const { id } = (req as any).validated as { id: string };
    const row = await db(FEE_TABLE).where({ id, is_deleted: false }).first();
    if (!row) {
      throw new BizError(BizCode.FEE_NOT_FOUND, '缴费单不存在');
    }
    // ★ 2026-10-20：详情与列表同口径（档案能对上就用档案最新值）
    applyArchiveToFeeRows(
      [row],
      await lookupArchive([row.student_id], [row.student_no]),
    );
    // 餐费场景：把「同一张凭证还被谁共用」一并返回，方便财务判断
    const shared = await findVoucherSharers(row.voucher_url, id);
    // ★ 2026-10-19 这张凭证一共覆盖几笔、合计多少（详情弹窗要讲清「本单 ≠ 凭证总额」）
    const group = await voucherGroupOf(row.voucher_url);
    res.json(ok({ ...toFeeDetail(row), sharedVoucherBy: shared, voucherGroupCount: group.count, voucherGroupAmount: group.amount }));
  }),
);

/* ============================================================
 * 3. 新增缴费单
 *    POST /api/finance/fee/add
 * ============================================================ */

const addSchema = z.object({
  studentId: z.string().min(1, '学生ID必填'),
  studentNo: z.string().min(1, '学号必填'),
  studentName: z.string().min(1, '姓名必填'),
  classId: z.string().optional(),
  className: z.string().optional(),
  deptCode: z.coerce.number().int().optional(),
  headTeacherId: z.string().optional(),
  headTeacherName: z.string().optional(),
  // ★ 2026-10-15：上限 5 → 7（押金 6 / 校服 7）
  feeType: z.coerce.number().int().min(1).max(8, '缴费类型只能是 1~8'),
  /**
   * 金额（单位：分），正整数。
   * ⚠️ 不传时后端会自动从「费用标准」取该 类型+部门 的标准金额（规则2）。
   */
  amount: z.coerce.number().int().positive('金额必须大于 0（单位：分）').optional(),
  /**
   * 来源模块（规则3）。不传时按费用类型自动推断：
   *   学费/试学费 → 咨询；餐费/住宿费/保险费 → 教务
   * 传了但和费用类型不匹配会被拒绝。
   */
  sourceModule: z.coerce.number().int().min(1).max(3, '来源模块 1咨询 2教务 3财务自建').optional(),
  payStatus: z.coerce.number().int().min(1).max(5).optional(),
  payDate: z.string().optional(),
  expireDate: z.string().optional(),
  period: z.string().max(32).optional(),
  /**
   * 凭证截图相对路径。
   * ⚠️ 非餐费类型下同一张凭证只能用于一条单据（规则3），重复会被拒绝；
   *    餐费允许多人共用同一张凭证。
   */
  voucherUrl: z.string().max(255).optional(),
  voucherNo: z.string().max(64).optional(),
  remark: z.string().max(500).optional(),
});

feeRouter.post(
  '/add',
  checkPermission('finance:fee:add'),
  validate(addSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof addSchema>;
    const id = await addFee(body, operatorOf(req));

    // ★ 2026-10-05：新增/编辑收费单 → 推给班级管理（班级「缴费管理」页读只读副本）
    //    非阻断：失败只记日志，不能把收款单本身弄丢
    await syncFeeToAll(id);

    res.json(ok({ id }, '新增成功'));
  }),
);

/* ============================================================
 * 7. 上游模块回传凭证（规则3-②）
 *    POST /api/finance/fee/attach-voucher
 *
 * ⚠️ 供咨询 / 教务模块调用：
 *    上游建立缴费单时学生还没交钱，拿到截图后再回传到财务侧。
 *    财务侧收到后在「缴费核对」页就能看到凭证并核对。
 * ============================================================ */

const attachVoucherSchema = z.object({
  id: z.string().min(1, '必须传缴费单 id'),
  voucherUrl: z.string().min(1, '凭证图片地址必填').max(255),
  voucherNo: z.string().max(64).optional(),
});

feeRouter.post(
  '/attach-voucher',
  validate(attachVoucherSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof attachVoucherSchema>;
    await attachVoucher(body.id, body.voucherUrl, body.voucherNo, operatorOf(req));

    // ★ 2026-10-05：回传凭证 = 改动了这张单 → 重新推一次（班级侧看到最新凭证/状态）
    await syncFeeToAll(body.id);

    res.json(ok(null, '凭证已接收，等待财务核对'));
  }),
);

/* ============================================================
 * 8. 财务核对通过
 *    POST /api/finance/fee/verify
 *
 * ⚠️ 这是财务模块最重要的一个接口：
 *    核对 → 生成缴费账单号 → 计入账单明细
 * ============================================================ */

const verifySchema = z.object({
  id: z.string().min(1, '必须传 id'),
  remark: z.string().max(500).optional(),
});

feeRouter.post(
  '/verify',
  checkPermission('finance:fee:verify'),
  validate(verifySchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof verifySchema>;
    const billNo = await verifyFee(body.id, operatorOf(req), body.remark);

    // ★ 2026-10-05：核对通过 = 缴费状态变了 → 推最新状态给班级管理
    await syncFeeToAll(body.id);

    res.json(ok({ billNo }, `核对成功，已生成账单 ${billNo}`));
  }),
);

/* ============================================================
 * 8.5 ★ 2026-10-19 作废缴费单（上游发起错了 / 重复发起）
 *     POST /api/finance/fee/cancel
 *
 * ⚠️ 只允许作废「未核对入账」的单，已入账的必须走退费。
 *    咨询侧发现重复发起时，会先调这里再软删自己的收款单。
 * ============================================================ */

const cancelSchema = z.object({
  id: z.string().min(1, '必须传缴费单 id'),
  reason: z.string().max(200).optional(),
});

feeRouter.post(
  '/cancel',
  validate(cancelSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof cancelSchema>;
    await cancelFee(body.id, body.reason || '上游重复发起', operatorOf(req));
    res.json(ok(null, '缴费单已作废'));
  }),
);

/* ============================================================
 * 5. 财务打回
 *    POST /api/finance/fee/reject
 * ============================================================ */

const rejectSchema = z.object({
  id: z.string().min(1, '必须传 id'),
  // ⚠️ 打回原因必填：班主任得知道哪里错了才能改
  rejectReason: z.string().min(1, '打回原因必填').max(255),
});

feeRouter.post(
  '/reject',
  checkPermission('finance:fee:verify'),
  validate(rejectSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof rejectSchema>;
    await rejectFee(body.id, body.rejectReason, operatorOf(req));

    // ★ 2026-10-05：打回也改变了这张单 → 推最新状态给班级
    await syncFeeToAll(body.id);

    res.json(ok(null, '已打回，等待班主任重新上传凭证'));
  }),
);

/* ============================================================
 * 6. 批量核对
 *    POST /api/finance/fee/batch-verify
 * ============================================================ */

const batchVerifySchema = z.object({
  ids: z.array(z.string().min(1)).min(1, '请至少选择一条'),
});

feeRouter.post(
  '/batch-verify',
  checkPermission('finance:fee:verify'),
  validate(batchVerifySchema),
  wrap(async (req, res) => {
    const { ids } = (req as any).validated as z.infer<typeof batchVerifySchema>;
    const result = await batchVerifyFee(ids, operatorOf(req));

    const msg = result.failed.length
      ? `核对完成：成功 ${result.successCount} 条，失败 ${result.failed.length} 条`
      : `核对完成：成功 ${result.successCount} 条`;

    // ★ 2026-10-05：批量核对后，把成功的这些单推最新状态给班级管理
    await syncFeesToAll(ids);

    res.json(ok({ successCount: result.successCount, billNos: result.billNos }, msg));
  }),
);

export default feeRouter;
