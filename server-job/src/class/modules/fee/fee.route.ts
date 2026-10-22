import { Router } from 'express';
import { z } from 'zod';
import { Knex } from 'knex';
import { FeeType, PayStatus, PermAction, SourceSystem, SyncMode, SyncResult } from 'shared-types/class';
import { commonDb } from '../../db';
import { ok, pageData } from '../../http/response';
import { pageQuerySchema, q, validate } from '../../lib/validate';
import { baseInsert, notDeleted, paginate } from '../../lib/repo';
import { rowsToCamel } from '../../lib/case';
import { now } from '../../lib/ids';
import { FeeTypeName, PayStatusName } from '../../lib/dict';
import { applySyncScope } from '../shared/syncScope';
import { resolveSyncStudentId } from '../shared/studentRef';
import { wrap } from '../../middleware/error';
// ★ 2026-10-06：缴费「类型 / 状态 / 部门」展示文案统一收口到主工程（初高、实训共用一套）
import { FEE_TYPE_TEXT, FEE_STATUS_TEXT, DEPT_TEXT } from '../../../utils/financeFeeRef';
import { tbl, tblTrx, tblInsTrx, uniUpdCols } from '../../../teaching/shared/uniTable';

/**
 * ★ 第 10 批：费用域切读
 *
 * 【为什么 SRC 是 sms_common】
 *   `t_class_fee_sync` 是财务推给我们的**只读副本**，本来就在共享库。
 *
 * 【★★ 金额列名按开关取 —— 这是本域最容易踩的坑】
 *   老表 `t_class_fee_sync.amount`（应收金额）
 *   统一表 `t_uni_fee.fee_amount`（同一笔钱，老表名字短）
 *
 *   写入侧已由 `UNI_COL_RENAME['sms_common.t_class_fee_sync'].amount = 'fee_amount'`
 *   自动翻译（insert / update 两条路径都过）。
 *
 *   ★ 但**读路径不会自动改名**（路由层不做业务列名改写，否则每张表都要维护别名）。
 *   → 下面所有 `r.amount` 必须换成 `r[amountCol()]`，
 *     否则症状是「不报错但整列读不到」：
 *     `/fee/list` 的金额恒为 0.00、`/fee/summary` 的 totalUnpaid 恒为 0。
 */
const SRC_COMMON = 'sms_common';
const STAGE = 'class' as const;

const FEE_T = 't_class_fee_sync';

const FEE = () => tbl(commonDb, SRC_COMMON, FEE_T, STAGE);

/** 应收金额列名：切读写统一表的新列，老表写老列 */
const amountCol = () => 'fee_amount';

/**
 * 缴费信息（需求三：同步财务管理的缴费信息）
 *
 * 边界：缴费数据由**财务管理（8005）**推过来，本模块只保存只读副本，
 *      供学管 / 班主任查看，并作为「退费申请」的可选项目来源。
 *      ⚠️ 本模块不产生缴费数据，也不回写财务。
 */
export const feeRouter = Router();

const feeItemSchema = z.object({
  sourceId: z.string().min(1, '上游主键不能为空'),
  /**
   * 学生 ID —— ★ 2026-10-05 由【必填】改为【可选】
   *
   * ⚠️ 原因：上游（财务 sms_finance）只有**学号**，拿不到本模块的学生 ID
   *    （各库学生表主键是不同的 uuid，只有 student_no 三边都对得上）。
   *    没传时由收方按学号回查本模块 t_class_student —— 见 shared/studentRef.ts。
   */
  studentId: z.string().optional().nullable(),
  studentNo: z.string().min(1, '学号不能为空'),
  studentName: z.string().min(1, '姓名不能为空'),
  classId: z.string().optional().nullable(),
  className: z.string().optional().nullable(),
  feeType: z.coerce.number().int('缴费类型不能为空'),
  amount: z.coerce.number().int('应收金额（分）不能为空'),
  paidAmount: z.coerce.number().int().optional().nullable(),
  payStatus: z.coerce.number().int().default(PayStatus.UNPAID),
  payDate: z.string().optional().nullable(),
  expireDate: z.string().optional().nullable(),
  voucherUrl: z.string().optional().nullable(),
  payMethod: z.string().optional().nullable(),
  /** ★ 2026-10-06 新增：费用周期 + 部门（1 二三期/初高部 2 大学部），三处详情展示口径统一用 */
  period: z.string().optional().nullable(),
  deptCode: z.coerce.number().int().optional().nullable(),
});

const feeSyncSchema = z.object({
  sourceSystem: z.string().default(SourceSystem.FINANCE),
  syncMode: z.string().default(SyncMode.INCREMENT),
  batchNo: z.string().min(1, '批次号不能为空'),
  sourceUpdateTime: z.string().optional().nullable(),
  items: z.array(feeItemSchema).max(500, '单批最多 500 条'),
});

/**
 * @openapi
 * /api/class/fee/sync:
 *   post:
 *     tags: [缴费信息]
 *     summary: 3.1 缴费信息同步（财务管理 → 学管）
 *     description: 幂等键 `(sourceSystem + sourceId)`；写入共享库只读副本 `sms_common.t_class_fee_sync`。
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [batchNo, items]
 *             properties:
 *               batchNo: { type: string }
 *               items: { type: array, items: { type: object } }
 *     responses:
 *       200: { description: 同步结果 }
 */
feeRouter.post(
  '/sync',
  validate({ body: feeSyncSchema }),
  wrap(async (req, res) => {
    const body = req.body as z.infer<typeof feeSyncSchema>;
    const sourceSystem = String(body.sourceSystem || SourceSystem.FINANCE);
    const result: SyncResult = {
      accepted: body.items.length,
      inserted: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      errors: [],
      batchNo: body.batchNo,
      finishTime: '',
    };

    await commonDb.transaction(async (trx) => {
      for (const item of body.items) {
        try {
          const existed = (await tblTrx(trx, SRC_COMMON, FEE_T, STAGE)
            .where({ source_system: sourceSystem, source_id: item.sourceId })
            .first()) as Record<string, unknown> | undefined;

          // ★ 2026-10-05：上游只带学号时，在这里回查本模块的学生 ID
          const studentId = await resolveSyncStudentId(item);

          const fields: Record<string, unknown> = {
            student_id: studentId,
            student_no: item.studentNo,
            student_name: item.studentName,
            class_id: item.classId ?? null,
            class_name: item.className ?? null,
            fee_type: item.feeType,
            amount: item.amount,
            paid_amount: item.paidAmount ?? null,
            pay_status: item.payStatus,
            pay_date: item.payDate ?? null,
            expire_date: item.expireDate ?? null,
            voucher_url: item.voucherUrl ?? null,
            pay_method: item.payMethod ?? null,
            source_system: sourceSystem,
            source_id: item.sourceId,
            source_batch_no: body.batchNo,
            source_update_time: body.sourceUpdateTime ?? now(),
            sync_status: 2,
          };

          if (existed) {
            // ★ 铁律⑨：update 路径必须过 uniUpdCols，
            //   否则 amount 不会被翻成 fee_amount → Unknown column，
            //   且症状是「首次成功、二次必炸」，错误藏在 errors[].reason 里
            const patch = await uniUpdCols(commonDb, SRC_COMMON, FEE_T, {
              ...fields,
              update_time: now(),
            });
            await tblTrx(trx, SRC_COMMON, FEE_T, STAGE)
              .where({ id: existed.id as string })
              .update(patch as never);
            result.updated += 1;
          } else {
            await tblInsTrx(trx, SRC_COMMON, FEE_T, STAGE, { ...baseInsert(), ...fields });
            result.inserted += 1;
          }
        } catch (e) {
          result.failed += 1;
          result.errors.push({
            sourceId: item.sourceId,
            studentNo: item.studentNo,
            reason: `写入失败：${(e as Error).message}`,
          });
        }
      }

      if (String(body.syncMode) === SyncMode.FULL) {
        const incoming = body.items.map((i) => i.sourceId);
        const upd = tblTrx(trx, SRC_COMMON, FEE_T, STAGE)
          .where({ source_system: sourceSystem, is_deleted: 0 })
          .update(
            (await uniUpdCols(commonDb, SRC_COMMON, FEE_T, { is_deleted: 1, update_time: now() })) as never,
          );
        if (incoming.length) upd.whereNotIn('source_id', incoming);
        await upd;
      }
    });

    result.finishTime = now();
    return ok(res, result, `缴费同步完成：新增 ${result.inserted} 条，更新 ${result.updated} 条`);
  }),
);

/* ------------------------------ 列表 ------------------------------ */

const feeListSchema = z.object({
  ...pageQuerySchema.shape,
  classId: z.string().optional(),
  studentId: z.string().optional(),
  studentNo: z.string().optional(),
  studentName: z.string().optional(),
  feeType: z.coerce.number().int().optional(),
  payStatus: z.coerce.number().int().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  keyword: z.string().optional(),
});

/**
 * @openapi
 * /api/class/fee/list:
 *   get:
 *     tags: [缴费信息]
 *     summary: 3.2 缴费信息列表
 *     description: 金额以「分」存储，同时返回 `amountYuan` / `paidAmountYuan` 便于直接展示。
 *     parameters:
 *       - { in: query, name: page, schema: { type: integer } }
 *       - { in: query, name: size, schema: { type: integer } }
 *       - { in: query, name: feeType, schema: { type: integer } }
 *       - { in: query, name: payStatus, schema: { type: integer } }
 *     responses:
 *       200: { description: 分页列表 }
 */
feeRouter.get(
  '/list',
  validate({ query: feeListSchema }),
  wrap(async (req, res) => {
    const user = req.user!;
    const query = q<z.infer<typeof feeListSchema>>(req);

    const base = FEE();
    notDeleted(base);
    await applySyncScope(base, user);
    if (query.classId) base.where('class_id', query.classId);
    if (query.studentId) base.where('student_id', query.studentId);
    if (query.studentNo) base.where('student_no', 'like', `%${query.studentNo}%`);
    if (query.studentName) base.where('student_name', 'like', `%${query.studentName}%`);
    if (query.feeType) base.where('fee_type', query.feeType);
    if (query.payStatus) base.where('pay_status', query.payStatus);
    if (query.startDate) base.where('pay_date', '>=', query.startDate);
    if (query.endDate) base.where('pay_date', '<=', query.endDate);
    if (query.keyword) {
      const k = query.keyword;
      base.where(function (this: Knex.QueryBuilder) {
        this.where('student_no', 'like', `%${k}%`).orWhere('student_name', 'like', `%${k}%`);
      });
    }
    base.orderBy('pay_date', 'desc').orderBy('student_no', 'asc');

    const paged = await paginate(base, query, async (qb) => {
      const rows = (await qb) as Array<Record<string, unknown>>;
      return rows.map((r) => {
        const c = rowsToCamel<Record<string, unknown>>([r])[0];
        // ★ 金额列按开关取：切读是 fee_amount，老表是 amount
        const amount = Number(r[amountCol()] ?? 0);
        const paid = r.paid_amount === null || r.paid_amount === undefined ? null : Number(r.paid_amount);
        const deptCode = r.dept_code == null ? null : Number(r.dept_code);
        return {
          ...c,
          // ★ 输出统一用 amount 这个名字，老表模式下c.amount 本来就在，
          //   切读时rowsToCamel 得到的是 feeAmount → 补一个 amount 出去
          amount,
          amountYuan: (amount / 100).toFixed(2),
          paidAmount: paid,
          paidAmountYuan: paid === null ? null : (paid / 100).toFixed(2),
          unpaidAmount: amount - (paid ?? 0),
          unpaidAmountYuan: ((amount - (paid ?? 0)) / 100).toFixed(2),
          // ★ 2026-10-06：类型 / 状态 / 部门文案统一口径（与初高、实训详情同一套字）
          feeTypeName: FEE_TYPE_TEXT[r.fee_type as number] ?? FeeTypeName[r.fee_type as number] ?? '未知',
          payStatusName:
            FEE_STATUS_TEXT[r.pay_status as number] ?? PayStatusName[r.pay_status as number] ?? '未知',
          deptCode,
          deptName: deptCode == null ? '—' : DEPT_TEXT[deptCode] ?? '—',
        };
      });
    });

    return ok(res, pageData(paged.total, paged.page, paged.size, paged.list), '查询成功');
  }),
);

/**
 * @openapi
 * /api/class/fee/summary:
 *   get:
 *     tags: [缴费信息]
 *     summary: 3.3 某学员的缴费汇总（应收 / 已收 / 欠费）
 *     description: 退费申请页需要按学员汇总各费用项，避免前端累加出错。
 *     parameters:
 *       - { in: query, name: studentId, schema: { type: string }, required: true }
 *     responses:
 *       200: { description: 汇总数据 }
 */
feeRouter.get(
  '/summary',
  validate({ query: z.object({ studentId: z.string().min(1, '缺少学生ID') }) }),
  wrap(async (req, res) => {
    const { studentId } = q<{ studentId: string }>(req);
    const rows = (await notDeleted(FEE())
      .where('student_id', studentId)) as Array<Record<string, unknown>>;

    const byType: Record<string, { feeType: number; feeTypeName: string; amount: number; paid: number }> = {};
    let totalAmount = 0;
    let totalPaid = 0;

    for (const r of rows) {
      const ft = r.fee_type as number;
      // ★ 金额列按开关取：切读是 fee_amount，老表是 amount
      const amount = Number(r[amountCol()] ?? 0);
      const paid = Number(r.paid_amount ?? 0);
      totalAmount += amount;
      totalPaid += paid;
      const key = String(ft);
      if (!byType[key]) {
        byType[key] = { feeType: ft, feeTypeName: FeeTypeName[ft] ?? '未知', amount: 0, paid: 0 };
      }
      byType[key].amount += amount;
      byType[key].paid += paid;
    }

    return ok(
      res,
      {
        totalAmount,
        totalPaid,
        totalUnpaid: totalAmount - totalPaid,
        totalAmountYuan: (totalAmount / 100).toFixed(2),
        totalPaidYuan: (totalPaid / 100).toFixed(2),
        totalUnpaidYuan: ((totalAmount - totalPaid) / 100).toFixed(2),
        items: Object.values(byType).map((x) => ({
          ...x,
          amountYuan: (x.amount / 100).toFixed(2),
          paidYuan: (x.paid / 100).toFixed(2),
          unpaidYuan: ((x.amount - x.paid) / 100).toFixed(2),
        })),
      },
      '查询成功',
    );
  }),
);
