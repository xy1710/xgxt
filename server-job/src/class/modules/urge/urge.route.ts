import { Router } from 'express';
import { z } from 'zod';
import { Knex } from 'knex';
import { FeeType, PayStatus, PermAction, SourceSystem, SyncMode, SyncResult } from 'shared-types/class';
import { commonDb, db } from '../../db';
import { Errors, ok, pageData } from '../../http/response';
import { pageQuerySchema, q, validate } from '../../lib/validate';
import { baseInsert, notDeleted, paginate } from '../../lib/repo';
import { requirePerm } from '../../lib/permGuard';
import { rowsToCamel } from '../../lib/case';
import { now, today } from '../../lib/ids';
import { FeeTypeName, PayStatusName } from '../../lib/dict';
import { applySyncScope } from '../shared/syncScope';
import { resolveSyncStudentId } from '../shared/studentRef';
import { wrap } from '../../middleware/error';
import { tbl, tblTrx, tblInsTrx, uniUpdCols } from '../../../teaching/shared/uniTable';
import { boolFlag } from '../../../utils/query';
import { checkPayDate, saveVoucherImage, PAY_METHOD, PAY_METHOD_NAME } from '../../../utils/feeVoucher';

/**
 * ★ 第 10 批：催费域切读
 *
 * 【为什么 SRC 是 sms_common 而不是 sms_class】
 *   `t_class_urge_sync`（催费副本）和 `t_class_urge_log`（催费流水）
 *   本来就住在共享库 sms_common —— 它们是「教务推给我们」的只读副本，
 *   不是三学段各自的业务表。
 *   `t_class_urge_log` 例外：它住在 sms_class（我们自己产生的流水）。
 *
 * 【⚠️ 关于 edu_stage 隔离的一个行为变化，必须知情】
 *   老表模式下 `t_class_urge_sync` 是**一张表装着三个学段的行**，
 *   `/urge/list` 不加学段过滤 → 能查到全部。
 *   切读后 `tbl()` 注入 `edu_stage='class'` → 只看大学学段。
 *   这与前9 个域的行为变化完全一致（切读 = 按学段隔离），
 *   且实测「一张共享表混三个学段、谁都能看到全部」本身就是数据越权。
 */
const SRC_COMMON = 'sms_common';
const SRC_CLASS = 'sms_class';
const STAGE = 'class' as const;

const SYNC_T = 't_class_urge_sync';
const LOG_T = 't_class_urge_log';

const SYNC = () => tbl(commonDb, SRC_COMMON, SYNC_T, STAGE);
const LOG = () => tbl(db, SRC_CLASS, LOG_T, STAGE);

/**
 * 催费管理（需求二：同步教务管理的催费信息）
 *
 * 边界：
 *  - 催费记录本身**由教务管理推过来**，本模块只保存只读副本（sms_common.t_class_urge_sync）
 *  - 本模块可以执行「催收动作」，动作记录写在自己的业务库（t_class_urge_log），不回写上游
 */
export const urgeRouter = Router();

const urgeItemSchema = z.object({
  sourceId: z.string().min(1, '上游主键不能为空'),
  /**
   * 学生 ID —— ★ 2026-10-05 由【必填】改为【可选】
   *
   * ⚠️ 原因：上游（教务 sms_edu）只有**学号**，拿不到本模块的学生 ID。
   *    没传时由收方按学号回查本模块 t_class_student —— 见 shared/studentRef.ts。
   */
  studentId: z.string().optional().nullable(),
  studentNo: z.string().min(1, '学号不能为空'),
  studentName: z.string().min(1, '姓名不能为空'),
  classId: z.string().optional().nullable(),
  className: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  parentPhone: z.string().optional().nullable(),
  headTeacherId: z.string().optional().nullable(),
  headTeacherName: z.string().optional().nullable(),
  feeType: z.coerce.number().int('欠费类型不能为空'),
  amount: z.coerce.number().int('欠费金额（分）不能为空'),
  expireDate: z.string().min(1, '到期日期不能为空'),
  payStatus: z.coerce.number().int().default(PayStatus.UNPAID),
  urgeCount: z.coerce.number().int().optional().nullable(),
  lastUrgeTime: z.string().optional().nullable(),
});

const urgeSyncSchema = z.object({
  sourceSystem: z.string().default(SourceSystem.EDU),
  syncMode: z.string().default(SyncMode.INCREMENT),
  batchNo: z.string().min(1, '批次号不能为空'),
  sourceUpdateTime: z.string().optional().nullable(),
  items: z.array(urgeItemSchema).max(500, '单批最多 500 条'),
});

/**
 * @openapi
 * /api/class/urge/sync:
 *   post:
 *     tags: [催费管理]
 *     summary: 2.1 催费信息同步（教务管理 → 学管）
 *     description: 幂等键 `(sourceSystem + sourceId)`：重复推送只更新、不新增。写入共享库只读副本。
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
urgeRouter.post(
  '/sync',
  validate({ body: urgeSyncSchema }),
  wrap(async (req, res) => {
    const body = req.body as z.infer<typeof urgeSyncSchema>;
    const sourceSystem = String(body.sourceSystem || SourceSystem.EDU);
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
          const existed = (await tblTrx(trx, SRC_COMMON, SYNC_T, STAGE)
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
            phone: item.phone ?? null,
            parent_phone: item.parentPhone ?? null,
            head_teacher_id: item.headTeacherId ?? null,
            head_teacher_name: item.headTeacherName ?? null,
            fee_type: item.feeType,
            amount: item.amount,
            expire_date: item.expireDate,
            pay_status: item.payStatus,
            urge_count: item.urgeCount ?? 0,
            last_urge_time: item.lastUrgeTime ?? null,
            source_system: sourceSystem,
            source_id: item.sourceId,
            source_batch_no: body.batchNo,
            source_update_time: body.sourceUpdateTime ?? now(),
            sync_status: 2,
          };

          if (existed) {
            // ★ 铁律⑨：update 路径必须过 uniUpdCols（insert 有翻译、update 没有）
            const patch = await uniUpdCols(commonDb, SRC_COMMON, SYNC_T, {
              ...fields,
              update_time: now(),
            });
            await tblTrx(trx, SRC_COMMON, SYNC_T, STAGE)
              .where({ id: existed.id as string })
              .update(patch as never);
            result.updated += 1;
          } else {
            await tblInsTrx(trx, SRC_COMMON, SYNC_T, STAGE, {
              ...baseInsert(undefined, undefined),
              ...fields,
            });
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
        const upd = tblTrx(trx, SRC_COMMON, SYNC_T, STAGE)
          .where({ source_system: sourceSystem, is_deleted: 0 })
          .update(
            (await uniUpdCols(commonDb, SRC_COMMON, SYNC_T, { is_deleted: 1, update_time: now() })) as never,
          );
        if (incoming.length) upd.whereNotIn('source_id', incoming);
        await upd;
      }
    });

    result.finishTime = now();
    return ok(res, result, `催费同步完成：新增 ${result.inserted} 条，更新 ${result.updated} 条`);
  }),
);

/* ------------------------------ 列表 ------------------------------ */

const urgeListSchema = z.object({
  ...pageQuerySchema.shape,
  classId: z.string().optional(),
  feeType: z.coerce.number().int().optional(),
  payStatus: z.coerce.number().int().optional(),
  // ★ 2026-10-20：显式布尔解析（z.coerce.boolean 会把 "false" 当 true，
  //   前端把「仅看紧急」关掉后仍然只出逾期的）
  onlyOverdue: boolFlag.optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  keyword: z.string().optional(),
});

function daysBetween(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00`).getTime();
  const b = new Date(`${to}T00:00:00`).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

/**
 * @openapi
 * /api/class/urge/list:
 *   get:
 *     tags: [催费管理]
 *     summary: 2.2 催费列表（欠费明细）
 *     description: |
 *       逾期天数由后端按当前日期计算后返回（`overdueDays`）。
 *       金额以「分」存储，同时返回「元」字段便于直接展示。
 *     parameters:
 *       - { in: query, name: page, schema: { type: integer } }
 *       - { in: query, name: size, schema: { type: integer } }
 *       - { in: query, name: onlyOverdue, schema: { type: boolean }, description: 只看已逾期 }
 *     responses:
 *       200: { description: 分页列表 }
 */
urgeRouter.get(
  '/list',
  validate({ query: urgeListSchema }),
  wrap(async (req, res) => {
    const user = req.user!;
    const query = q<z.infer<typeof urgeListSchema>>(req);
    const t = today();

    const base = SYNC();
    notDeleted(base);
    await applySyncScope(base, user);
    if (query.classId) base.where('class_id', query.classId);
    if (query.feeType) base.where('fee_type', query.feeType);
    // ★ 2026-10-20：缴费状态按「展示口径」筛。
    //   财务侧不写 4（逾期只存在于列注释里），过了到期日的行库里还是「待缴」，
    //   所以「逾期」= 库里就是 4，或者「待缴 + 已过到期日」；「待缴」则要排掉已过期的。
    if (query.payStatus === PayStatus.OVERDUE) {
      base.where(function (this: Knex.QueryBuilder) {
        this.where('pay_status', PayStatus.OVERDUE).orWhere(function (this: Knex.QueryBuilder) {
          this.where('pay_status', PayStatus.UNPAID).andWhere('expire_date', '<', t);
        });
      });
    } else if (query.payStatus === PayStatus.UNPAID) {
      base.where('pay_status', PayStatus.UNPAID).andWhere('expire_date', '>=', t);
    } else if (query.payStatus) {
      base.where('pay_status', query.payStatus);
    }
    if (query.startDate) base.where('expire_date', '>=', query.startDate);
    if (query.endDate) base.where('expire_date', '<=', query.endDate);
    if (query.onlyOverdue) base.where('expire_date', '<', t).whereNot('pay_status', PayStatus.PAID);
    if (query.keyword) {
      const k = query.keyword;
      base.where(function (this: Knex.QueryBuilder) {
        this.where('student_no', 'like', `%${k}%`).orWhere('student_name', 'like', `%${k}%`);
      });
    }
    base.orderBy('expire_date', 'asc');

    const paged = await paginate(base, query, async (qb) => {
      const rows = (await qb) as Array<Record<string, unknown>>;
      return rows.map((r) => {
        const c = rowsToCamel<Record<string, unknown>>([r])[0];
        const expire = r.expire_date as string;
        const rawPayStatus = Number(r.pay_status ?? 0);
        const paid = rawPayStatus === PayStatus.PAID;
        const overdueDays = paid ? 0 : daysBetween(expire, t);
        // ★ 2026-10-20：逾期按到期日派生（库里可能还写着「待缴」）
        const payStatus =
          rawPayStatus === PayStatus.UNPAID && overdueDays > 0 ? PayStatus.OVERDUE : rawPayStatus;
        const amount = Number(r.amount ?? 0);
        return {
          ...c,
          feeTypeName: FeeTypeName[r.fee_type as number] ?? '未知',
          payStatus,
          payStatusName: PayStatusName[payStatus] ?? '未知',
          amountYuan: (amount / 100).toFixed(2),
          overdueDays,
          isOverdue: overdueDays > 0,
          // ★ 2026-10-21：登记缴费五列（与初高 t_class_fee 同口径），大学行也能显示实缴/方式/日期/凭证
          payMethodName: r.pay_method != null ? PAY_METHOD_NAME[Number(r.pay_method)] ?? '' : '',
        };
      });
    });

    return ok(res, pageData(paged.total, paged.page, paged.size, paged.list), '查询成功');
  }),
);

/* ------------------------------ 执行催收 ------------------------------ */

const urgeDoSchema = z.object({
  urgeId: z.string().min(1, '缺少催费记录ID'),
  channel: z.enum(['phone', 'sms', 'wechat'], {
    errorMap: () => ({ message: '催收渠道只能是 phone / sms / wechat' }),
  }),
  remark: z.string().optional().nullable(),
});

/**
 * @openapi
 * /api/class/urge/do:
 *   post:
 *     tags: [催费管理]
 *     summary: 2.3 执行一次催收（记本地催费流水）
 *     description: |
 *       催费记录属于教务管理，本模块**不回写上游**，只在自己的库记一条催收动作流水，
 *       并把副本里的催费次数 +1，便于前端立即看到效果。
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [urgeId, channel]
 *             properties:
 *               urgeId: { type: string }
 *               channel: { type: string, enum: [phone, sms, wechat] }
 *               remark: { type: string }
 *     responses:
 *       200: { description: 催收记录已保存，返回累计催费次数 }
 */
urgeRouter.post(
  '/do',
  requirePerm('urge', PermAction.ADD),
  validate({ body: urgeDoSchema }),
  wrap(async (req, res) => {
    const user = req.user!;
    const b = req.body as z.infer<typeof urgeDoSchema>;

    const rec = (await notDeleted(SYNC()).where('id', b.urgeId).first()) as
      | Record<string, unknown>
      | undefined;
    if (!rec) throw Errors.param('催费记录不存在或已失效');

    const channelName: Record<string, string> = { phone: '电话', sms: '短信', wechat: '微信' };
    const nextCount = Number(rec.urge_count ?? 0) + 1;
    const t = now();

    await db.transaction(async (trx) => {
      await tblInsTrx(trx, SRC_CLASS, LOG_T, STAGE, {
        ...baseInsert(user),
        student_id: rec.student_id as string,
        student_no: rec.student_no as string,
        student_name: rec.student_name as string,
        amount: rec.amount as number,
        channel: b.channel,
        remark: b.remark ?? null,
        operator_id: user.userId,
        operator_name: user.userName,
        urge_time: t,
      });
    });

    // 副本上的催费次数 +1（只影响本地展示，不回写教务）
    await SYNC().where({ id: b.urgeId }).update(
      (await uniUpdCols(commonDb, SRC_COMMON, SYNC_T, {
        urge_count: nextCount,
        last_urge_time: t,
        update_time: t,
      })) as never,
    );

    return ok(res, { urgeId: b.urgeId, urgeCount: nextCount }, `已记录${channelName[b.channel] ?? ''}催收`);
  }),
);

/**
 * @openapi
 * /api/class/urge/log/list:
 *   get:
 *     tags: [催费管理]
 *     summary: 2.4 催收流水（本模块执行过的催收动作）
 *     parameters:
 *       - { in: query, name: page, schema: { type: integer } }
 *       - { in: query, name: size, schema: { type: integer } }
 *       - { in: query, name: studentId, schema: { type: string } }
 *     responses:
 *       200: { description: 分页列表 }
 */
urgeRouter.get(
  '/log/list',
  validate({
    query: z.object({ ...pageQuerySchema.shape, studentId: z.string().optional() }),
  }),
  wrap(async (req, res) => {
    const query = q<{ page: number; size: number; studentId?: string }>(req);
    const base = LOG();
    notDeleted(base);
    if (query.studentId) base.where('student_id', query.studentId);
    base.orderBy('urge_time', 'desc');

    const paged = await paginate(base, query, async (qb) =>
      rowsToCamel(await qb as Array<Record<string, unknown>>),
    );
    return ok(res, pageData(paged.total, paged.page, paged.size, paged.list), '查询成功');
  }),
);

/* ------------------------------ 登记缴费（对齐初高） ------------------------------ */

/**
 * ★ 2026-10-21 用户要求：催费页里**大学**要与初高功能对齐。
 *
 * 【为什么要这个接口】
 *   初高的行早就能「上传缴费凭证（登记缴费）」，大学催缴副本原来只有 pay_status，
 *   钱怎么交的、交了多少、哪天交的、有没有凭证一概没有 → 页面上操作列只能显示「—」。
 *
 * 【写哪里】
 *   只写本模块自己的副本 `sms_common.t_class_urge_sync`（pay_method / paid_amount /
 *   pay_date / voucher_url / pay_remark + pay_status）。**不回写上游财务** ——
 *   这张表本身就是财务推来的只读副本，反写会与财务核对流程打架
 *   （初高台账能反写是因为它是「本模块建的台账 + 财务单副本」双重身份，这里不是）。
 *
 * 【状态怎么变】
 *   未结清（待缴 1 / 逾期 4）→ 已缴 2；已缴 / 已核对保持原状，只补登记信息。
 */
const urgeVoucherSchema = z.object({
  urgeId: z.string().min(1, '缺少催缴记录ID'),
  /** 缴费方式 1微信支付 2支付宝 3现金 */
  payMethod: z.coerce.number().int().min(1).max(3, '缴费方式只能是 微信支付 / 支付宝 / 现金'),
  /** 实缴金额（分）；允许与应缴不同（部分缴），必须为正 */
  paidAmount: z.coerce.number().int().positive('缴费金额必须大于 0'),
  payDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '缴费时间格式应为 YYYY-MM-DD'),
  remark: z.string().max(200, '备注最多 200 字').optional(),
  /** 缴费截图；现金可不传（见 saveVoucherImage 的调用处） */
  dataUrl: z.string().optional(),
});

urgeRouter.post(
  '/voucher',
  requirePerm('urge', PermAction.ADD),
  validate({ body: urgeVoucherSchema }),
  wrap(async (req, res) => {
    const user = req.user!;
    const b = req.body as z.infer<typeof urgeVoucherSchema>;

    const dateErr = checkPayDate(b.payDate);
    if (dateErr) throw Errors.param(dateErr);

    const rec = (await notDeleted(SYNC()).where('id', b.urgeId).first()) as
      | Record<string, unknown>
      | undefined;
    if (!rec) throw Errors.param('催费记录不存在或已失效');

    /* ---- 截图：现金不强制，微信/支付宝必须有 ---- */
    let voucherUrl: string | null = null;
    if (b.dataUrl) {
      const saved = saveVoucherImage(b.dataUrl, 'urge');
      if (!saved.ok) throw Errors.param(saved.message);
      voucherUrl = saved.voucherUrl;
    } else if (b.payMethod !== PAY_METHOD.CASH) {
      throw Errors.param('请上传缴费截图（微信支付 / 支付宝需要凭证，现金可不传）');
    }

    const rawStatus = Number(rec.pay_status ?? PayStatus.UNPAID);
    const nextStatus =
      rawStatus === PayStatus.UNPAID || rawStatus === PayStatus.OVERDUE ? PayStatus.PAID : rawStatus;

    const patch: Record<string, unknown> = {
      pay_method: b.payMethod,
      paid_amount: b.paidAmount,
      pay_date: b.payDate,
      pay_remark: b.remark ?? null,
      pay_status: nextStatus,
      update_time: now(),
    };
    // 现金且没传截图：保留原来的凭证，不要把它清空
    if (voucherUrl) patch.voucher_url = voucherUrl;

    await SYNC()
      .where({ id: b.urgeId })
      .update((await uniUpdCols(commonDb, SRC_COMMON, SYNC_T, patch)) as never);

    return ok(
      res,
      {
        urgeId: b.urgeId,
        voucherUrl: voucherUrl ?? (rec.voucher_url ?? null),
        payStatus: nextStatus,
        payMethodName: PAY_METHOD_NAME[b.payMethod] ?? '',
      },
      '缴费登记成功',
    );
  }),
);
