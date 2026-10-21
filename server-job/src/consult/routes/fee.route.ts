/**
 * 收款与缴费路由
 *
 * 路径前缀：/api/consult/fee
 *
 * ⚠️ 本文件的职责：
 *    咨询侧「发起收费 → 上传缴费截图 → 看财务核对结果」
 *    真实金额与核对由财务模块（8005）决定，本模块只做发起与展示。
 */

import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import path from 'path';
import fs from 'fs';
import {
  BizCode,
  FeeType,
  FEE_TYPE_NAME,
  DeptCode,
  nameOf,
  ConsultFeeStatus,
  CONSULT_FEE_STATUS_NAME,
  type ConsultFeeOrder,
} from 'shared-types/consult';
import { ok, page } from '../utils/response';
import { db } from '../utils/db';
import { wrap } from '../utils/wrap';
import { validate } from '../middleware/validate';
import { checkRole } from '../middleware/auth';
import { ConsultRole, FULL_FEE_TYPES } from 'shared-types/consult';
import { formatTime } from '../services/student.service';
import { BizError } from '../middleware/errorHandler';
import {
  FEE_ORDER_TABLE,
  buildOrderQuery,
  toOrderView,
  attachPlanInfo,
  getFeeStats,
  createFees,
  createCombinedFees,
  createSupplementFee,
  uploadVoucher,
  resubmitOrder,
  syncFromFinance,
  centToYuan,
  cancelFeeOrders,
} from '../services/fee-order.service';
import { financeClient } from '../services/finance.client';
import { config } from '../config';
// ★ 2026-10-16 数据范围：咨询师只看/只操作自己名下学生的收款单
import { scopedStudentIds, assertStudentIdInScope } from '../services/data-scope';

export const feeRouter = Router();

/* ============================================================
 * 1. 收款单列表
 *    GET /api/consult/fee/list
 *
 * ⚠️ 每次列表请求会顺带从财务同步一次状态（保证核对结果及时可见）
 * ============================================================ */

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
  studentName: z.string().optional(),
  ownerName: z.string().optional(),
  className: z.string().optional(),
  feeType: z.coerce.number().int().optional(),
  status: z.coerce.number().int().optional(),
  keyword: z.string().optional(),
  /** 是否跳过财务同步（默认同步；传 false 可跳过，加快响应） */
  sync: z.coerce.boolean().optional(),
});

/**
 * ★ 2026-10-15 一次缴清的多项费用 → 合并成一行
 *
 * 用户口径：「费用一次缴的不用列开，只是包含这个」
 *
 * 一次「发起收费」勾选 6 项，系统里就是 6 张单据，但老师眼里是「交了一笔钱」。
 * 所以列表按 (batch_no + 学生) 合成一行：金额求和、状态取最差的一档，
 * 具体包含哪些费用放进 included，点「查看」展开明细。
 *
 * @param rows         同一批次的单据行（已按 order_no 升序，顺序稳定）
 * @param consultState 学生当前咨询状态
 */
/** 解析合并缴费单的明细 JSON（脏数据返回空数组，不影响主流程） */
function parseItemDetail(raw: any): Array<{ feeType: number; feeTypeName: string; amount: number }> {
  if (!raw) return [];
  try {
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function toMergedOrderView(rows: any[], consultState?: number): ConsultFeeOrder {
  const first = rows[0];
  const main = toOrderView({ ...first, consult_state: consultState });

  /** 单笔收款：原样返回，但补齐 included / orderIds，前端不用分两套逻辑 */
  if (rows.length === 1) {
    /**
     * ★ 2026-10-15 合并缴费单：一张单 = 一笔合计，
     *   勾选了哪些费用在 item_detail 里 —— 用它生成 included（展示「包含哪些」）。
     */
    const detail = parseItemDetail(first.item_detail);
    if (detail.length > 1) {
      return {
        ...main,
        feeTypeName: '正式学费',
        itemDetail: detail,
        orderIds: [main.orderId],
        included: detail.map((d) => ({
          orderId: main.orderId,
          feeTypeName: d.feeTypeName,
          amountYuan: centToYuan(d.amount),
          statusName: main.statusName,
        })),
      };
    }

    return {
      ...main,
      itemDetail: detail.length ? detail : undefined,
      orderIds: [main.orderId],
      included: [
        {
          orderId: main.orderId,
          feeTypeName: main.feeTypeName,
          amountYuan: main.amountYuan,
          statusName: main.statusName,
        },
      ],
    };
  }

  const amount = rows.reduce((s, r) => s + Number(r.amount || 0), 0);
  const statuses: number[] = rows.map((r) => Number(r.status));
  // 状态取「最差的一档」：只要有一笔被驳回/还没传凭证，就不能显示已到账
  const status = statuses.includes(ConsultFeeStatus.REJECTED)
    ? ConsultFeeStatus.REJECTED
    : statuses.includes(ConsultFeeStatus.NO_VOUCHER)
      ? ConsultFeeStatus.NO_VOUCHER
      : statuses.includes(ConsultFeeStatus.PENDING)
        ? ConsultFeeStatus.PENDING
        : ConsultFeeStatus.ARRIVED;

  const rejectReason = rows.map((r) => r.reject_reason).find(Boolean) || undefined;

  return {
    ...main,
    merged: true,
    amount,
    amountYuan: centToYuan(amount),
    status,
    statusName: nameOf(CONSULT_FEE_STATUS_NAME, status),
    feeTypeName: `${main.feeTypeName} 等 ${rows.length} 项`,
    voucherUrl: rows.map((r) => r.voucher_url).find(Boolean) || undefined,
    voucherNo: rows.map((r) => r.voucher_no).find(Boolean) || undefined,
    rejectReason,
    lastAction:
      status === ConsultFeeStatus.ARRIVED
        ? '财务已确认到账'
        : status === ConsultFeeStatus.REJECTED
          ? `财务打回：${rejectReason || '凭证有问题'}`
          : status === ConsultFeeStatus.PENDING
            ? '凭证已上传，等待财务核对'
            : '已发起收费，等待上传缴费截图',
    orderIds: rows.map((r) => r.id),
    included: rows.map((r) => ({
      orderId: r.id,
      feeTypeName: nameOf(FEE_TYPE_NAME, r.fee_type),
      amountYuan: centToYuan(r.amount),
      statusName: nameOf(CONSULT_FEE_STATUS_NAME, Number(r.status)),
    })),
  };
}

/** 分组键：同一次发起（batch_no）+ 同一个学生 → 一行。老数据没 batch_no 时用 id 兜底 */
const GROUP_KEY = "CONCAT(IFNULL(batch_no, id), '|', consult_student_id)";

feeRouter.get(
  '/list',
  validate(listSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as z.infer<typeof listSchema>;

    // ★ 2026-10-16 数据范围：咨询师只看自己名下学生的收款单
    const scopeIds = await scopedStudentIds(req.user);

    // ---- 先从财务同步状态（失败不阻断，只是状态可能滞后）----
    if (q.sync !== false) {
      try {
        await syncFromFinance();
      } catch (err) {
        console.warn('[fee/list] 财务同步失败，使用本地状态', err);
      }
    }

    const base = buildOrderQuery(q, scopeIds);

    /* ---------- ① 分组总数（一次缴清 = 一组 = 一行）---------- */
    const totalRow = await base
      .clone()
      .countDistinct({ total: db.raw(GROUP_KEY) });
    const total = Number((totalRow[0] as any)?.total || 0);

    /* ---------- ② 本页分组 ---------- */
    const groups = (await base
      .clone()
      .select(db.raw(`${GROUP_KEY} as gkey`))
      .max({ ct: 'create_time' })
      .groupByRaw(GROUP_KEY)
      .orderBy('ct', 'desc')
      .limit(q.size)
      .offset((q.page - 1) * q.size)) as any[];

    const gkeys = groups.map((g) => String(g.gkey));

    /* ---------- ③ 取组内明细 ---------- */
    const rows: any[] = gkeys.length
      ? ((await base
          .clone()
          .select('*')
          .whereRaw(
            `${GROUP_KEY} IN (${gkeys.map(() => '?').join(',')})`,
            gkeys,
          )
          .orderBy('order_no', 'asc')) as any[])
      : [];

    // ★ 2026-10-16 补分期信息（计划号 / 总期数），一次性缴费无副作用
    await attachPlanInfo(rows);

    // ★ 2026-10-09 补学生当前咨询状态（收款单是快照，学生状态会变）
    const stuIds = Array.from(
      new Set(rows.map((r: any) => r.consult_student_id).filter(Boolean)),
    );
    const stateMap = new Map<string, number>();
    if (stuIds.length) {
      const stus: any[] = await db('t_consult_student')
        .whereIn('id', stuIds)
        .select('id', 'consult_state');
      for (const s of stus) stateMap.set(s.id, s.consult_state);
    }

    /* ---------- ④ 到账操作人 / 到账时间（财务侧确认信息）---------- */
    const feeIds = Array.from(
      new Set(rows.map((r: any) => r.finance_fee_id).filter(Boolean)),
    );
    const verifyMap = new Map<string, { by?: string; time?: any }>();
    if (feeIds.length) {
      try {
        const fins: any[] = await db('t_finance_fee')
          .withSchema('sms_finance')
          .whereIn('id', feeIds)
          .select('id', 'verified_by_name', 'verified_time');
        for (const f of fins) {
          verifyMap.set(f.id, { by: f.verified_by_name || undefined, time: f.verified_time });
        }
      } catch (err) {
        // 财务库不可达不阻断列表，只是没有操作人/时间
        console.warn('[fee/list] 读取财务确认信息失败', err);
      }
    }

    /* ---------- ⑤ 按分组顺序拼视图 ---------- */
    const byKey = new Map<string, any[]>();
    for (const r of rows) {
      const k = `${r.batch_no ?? r.id}|${r.consult_student_id}`;
      const arr = byKey.get(k);
      if (arr) arr.push(r);
      else byKey.set(k, [r]);
    }

    const views = gkeys
      .map((k) => {
        const group = byKey.get(k);
        if (!group || !group.length) return null;
        const view = toMergedOrderView(
          group,
          stateMap.get(group[0].consult_student_id),
        );
        // 合并行里任何一笔被财务确认过，就把操作人/时间带出来
        for (const r of group) {
          const v = r.finance_fee_id ? verifyMap.get(r.finance_fee_id) : undefined;
          if (v && (v.by || v.time)) {
            view.paidByName = v.by;
            view.paidTime = v.time ? formatTime(v.time) : undefined;
            break;
          }
        }
        return view;
      })
      .filter(Boolean) as ConsultFeeOrder[];

    res.json(page(views, Number(total), q));
  }),
);

/* ============================================================
 * 2. 收款统计（列表页顶部 4 张卡）
 *    GET /api/consult/fee/stats
 * ============================================================ */

feeRouter.get(
  '/stats',
  validate(listSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as z.infer<typeof listSchema>;
    res.json(ok(await getFeeStats(q, await scopedStudentIds(req.user))));
  }),
);

/* ============================================================
 * 3. 收款单详情
 *    GET /api/consult/fee/detail?id=xxx
 * ============================================================ */

feeRouter.get(
  '/detail',
  validate(z.object({ id: z.string().min(1) })),
  wrap(async (req, res) => {
    const { id } = (req as any).validated as { id: string };
    const row = await db(FEE_ORDER_TABLE).where({ id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.ORDER_NOT_FOUND, '收款单不存在');
    res.json(ok(toOrderView(row)));
  }),
);

/* ============================================================
 * 4. ⭐ 发起收费
 *    POST /api/consult/fee/create
 *
 * 请求体：
 *   { consultStudentId, feeTypes: [1] 或 [1,2,3,4], payMethod }
 *
 * ⚠️ 本接口不接收 amount —— 金额一律由财务费用标准决定（规则2）
 * ============================================================ */

const createSchema = z.object({
  consultStudentId: z.string().min(1, '必须传学生 id'),
  // ★ 2026-10-15：费用类型上限 5 → 7（新增「押金 6 / 校服 7」）
  feeTypes: z.array(z.coerce.number().int().min(1).max(8)).min(1, '至少选择一个费用类型'),
  payMethod: z.string().max(20).optional(),
  /**
   * ★ 2026-10-15 金额自定义：key = feeType（字符串），value = 金额（单位：分）
   * 传了就用传入值覆盖费用标准；不传保持原逻辑（规则2：按标准取值）。
   */
  amountByType: z
    .record(z.string(), z.coerce.number().int().min(0, '自定义金额必须大于等于 0（单位：分）'))
    .optional(),
  /**
   * ★ 2026-10-19 用户口径：「只要缴费就要有凭证」。
   *    发起收费必须带缴费凭证，建单即落库（财务侧建单即待核对），
   *    不再有「先建单、再补传凭证」的中间态。
   *
   * ⚠️ 这里用 optional，是因为 zod 对「缺字段」只会报
   *    「参数「voucherUrl」类型不正确」，看不出人话；
   *    真正的必填校验放在 handler 里，报「请先上传缴费凭证截图」。
   */
  voucherUrl: z.string().optional(),
  voucherNo: z.string().max(100).optional(),
});

feeRouter.post(
  '/create',
  validate(createSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof createSchema>;
    const operator = req.user!;

    // ★ 2026-10-16 数据范围：咨询师只能给名下学生发起收费
    await assertStudentIdInScope(body.consultStudentId, req.user);

    // ★ 2026-10-19 用户口径：只要缴费就要有凭证
    if (!body.voucherUrl) {
      throw new BizError(BizCode.PARAM_ERROR, '请先上传缴费凭证截图');
    }

    // zod 的 record 键是字符串，转成 number 键给 service 用
    const amountByType = body.amountByType
      ? Object.fromEntries(
          Object.entries(body.amountByType).map(([k, v]) => [Number(k), Number(v)]),
        )
      : undefined;

    /**
     * ★ 2026-10-15 用户口径：「缴费直接缴合计的，交一次就行」
     *    勾了多项 → 建【一张合计单】（金额 = 各项之和，明细存 item_detail）；
     *    只勾一项 → 走原来的 createFees。
     */
    const feeTypes = body.feeTypes as FeeType[];
    const result =
      feeTypes.length > 1
        ? await createCombinedFees(
            body.consultStudentId,
            feeTypes,
            { name: operator.userName, title: operator.roleTitle },
            body.payMethod,
            amountByType,
            body.voucherUrl,
            body.voucherNo,
          )
        : await createFees(
            body.consultStudentId,
            feeTypes,
            { name: operator.userName, title: operator.roleTitle },
            body.payMethod,
            amountByType,
            body.voucherUrl,
            body.voucherNo,
          );

    res.json(ok(result, result.message));
  }),
);

/* ============================================================
 * 4.5 ★ 2026-10-20 补费（试学转正尾款 / 差额补收，金额自定义）
 *     POST /api/consult/fee/supplement
 *
 * 用户口径：「交了试学费的，后边在收款与缴费管理那儿操作里面
 *            添加一个补费功能，补费金额自定义。」
 *
 * ⚠️ 与 /create 的差别：
 *    · 金额必须手填（补费没有「费用标准」）；
 *    · 门槛是「该学生已有到账的试学费」，不是随便哪个学生都能补；
 *    · 落库类型是「补费(8)」，不占学费额度、不参与全款已缴判定。
 * ============================================================ */

const supplementSchema = z.object({
  consultStudentId: z.string().min(1, '必须传学生 id'),
  /** 补费金额（单位：分），老师手填，后端不再按费用标准覆盖 */
  amount: z.coerce.number().int().positive('补费金额必须大于 0（单位：分）'),
  voucherUrl: z.string().optional(),
  voucherNo: z.string().max(100).optional(),
  payMethod: z.string().max(20).optional(),
  remark: z.string().max(200).optional(),
});

feeRouter.post(
  '/supplement',
  validate(supplementSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof supplementSchema>;
    const operator = req.user!;

    // ★ 数据范围：咨询师只能给自己名下学生发起补费（与发起收费同一条铁律）
    await assertStudentIdInScope(body.consultStudentId, req.user);

    // 凭证必填校验放在 handler：zod 报「类型不正确」看不出人话
    if (!body.voucherUrl) {
      throw new BizError(BizCode.PARAM_ERROR, '请先上传缴费凭证截图');
    }

    const result = await createSupplementFee(
      body.consultStudentId,
      body.amount,
      { name: operator.userName, title: operator.roleTitle },
      {
        voucherUrl: body.voucherUrl,
        voucherNo: body.voucherNo,
        payMethod: body.payMethod,
        remark: body.remark,
      },
    );

    res.json(ok(result, result.message));
  }),
);

/* ============================================================
 * 5. ⭐ 上传缴费截图
 *    POST /api/consult/fee/upload-voucher
 *
 * ⚠️ 业务规则（用户已确认）：
 *    凭证由咨询侧上传，财务只负责核对，不额外增加审查环节。
 *    如财务发现凭证有问题，在核对页「打回」，本模块状态变「已驳回」，
 *    咨询侧可重传后「重新提交」。
 * ============================================================ */

const voucherSchema = z.object({
  orderId: z.string().min(1, '必须传收款单 id'),
  voucherUrl: z.string().min(1, '必须传凭证图片地址'),
  voucherNo: z.string().max(100).optional(),
});

feeRouter.post(
  '/upload-voucher',
  validate(voucherSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof voucherSchema>;
    const operator = req.user!;

    // ★ 2026-10-16 数据范围：咨询师只能操作自己名下学生的收款单
    const order: any = await db(FEE_ORDER_TABLE).where({ id: body.orderId }).first();
    if (order?.consult_student_id) {
      await assertStudentIdInScope(order.consult_student_id, req.user);
    }

    await uploadVoucher(body.orderId, body.voucherUrl, body.voucherNo, {
      name: operator.userName,
      title: operator.roleTitle,
    });

    // 已到账的单只是「补图」，别提示成还要等财务核对
    const wasArrived = Number(order?.status) === 2;
    res.json(
      ok(null, wasArrived ? '凭证已补齐（该笔此前已到账）' : '缴费截图已上传，等待财务核对'),
    );
  }),
);

/* ============================================================
 * 6. 上传图片文件（拿到可存库的 URL）
 *    POST /api/consult/fee/upload-file
 *
 * ⚠️ 实现说明：
 *    演示环境用 base64 传图（前端 el-upload 设 auto-upload=false 后转 base64），
 *    后端解码写文件到 uploads/voucher/ 并返回相对 URL。
 *    这样不依赖 multer，避免多加一个依赖。
 *
 *    生产环境建议改成 multer + 对象存储。
 * ============================================================ */

const uploadFileSchema = z.object({
  /** data:image/png;base64,xxxx */
  dataUrl: z.string().min(1, '必须传图片数据'),
  /** 文件名前缀，便于识别 */
  prefix: z.string().max(50).optional(),
});

feeRouter.post(
  '/upload-file',
  validate(uploadFileSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof uploadFileSchema>;

    const m = /^data:image\/(png|jpe?g|gif|webp);base64,(.+)$/i.exec(body.dataUrl);
    if (!m) {
      throw new BizError(BizCode.FORMAT_ERROR, '只支持 PNG / JPG / GIF / WEBP 格式的图片');
    }

    const ext = m[1].toLowerCase().replace('jpeg', 'jpg');
    const buffer = Buffer.from(m[2], 'base64');

    // ⚠️ 限制 5MB，防止上传大文件把服务打挂
    if (buffer.length > 5 * 1024 * 1024) {
      throw new BizError(BizCode.PARAM_ERROR, '图片不能超过 5MB，请压缩后重试');
    }

    const fileName = `${body.prefix || 'voucher'}_${Date.now()}_${randomUUID().slice(0, 8)}.${ext}`;
    const uploadDir = path.resolve(process.cwd(), 'uploads/voucher');

    // 确保目录存在
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    fs.writeFileSync(path.join(uploadDir, fileName), buffer);

    /*
     * ⚠️ 双写财务侧 uploads 目录（跨模块图片共享）
     *
     * 问题：`<img src>` 带不上 Authorization 头，凭证图片必须走静态托管；
     *      而财务侧的 express.static 只映射自己项目下的 uploads 目录，
     *      访问不到咨询侧的文件 —— 财务在核对页就看不到截图。
     *
     * 解决：本地开发两个服务同机，上传时把文件同步写一份到财务目录，
     *      两边用同一个相对路径 /uploads/voucher/xxx.jpg，都能访问。
     *
     * ⚠️ 生产环境应改为对象存储（OSS / COS），把图片地址存成绝对 URL，
     *    两端直接访问同一个 CDN 地址，就不需要双写了。
     */
    const financeUploadDir = config.services.financeUploadDir
      ? path.resolve(__dirname, '../../', config.services.financeUploadDir)
      : '';
    if (financeUploadDir) {
      try {
        const target = path.join(financeUploadDir, 'voucher');
        if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
        fs.writeFileSync(path.join(target, fileName), buffer);
      } catch (err: any) {
        // 双写失败不阻断上传：本地已有文件，只是财务侧暂时看不到，
        // 记一条日志方便排查（财务侧核对页看不到凭证时好定位）。
        console.warn('[upload-file] 同步到财务 uploads 目录失败:', err?.message);
      }
    }

    // 返回相对 URL（前端拼上 base 或用代理访问）
    const url = `/uploads/voucher/${fileName}`;
    res.json(ok({ url, size: buffer.length }, '上传成功'));
  }),
);

/* ============================================================
 * 7. 被驳回后重新提交
 *    POST /api/consult/fee/resubmit
 * ============================================================ */

feeRouter.post(
  '/resubmit',
  validate(z.object({ orderId: z.string().min(1) })),
  wrap(async (req, res) => {
    const { orderId } = (req as any).validated as { orderId: string };
    const operator = req.user!;

    // ★ 2026-10-16 数据范围：咨询师只能操作自己名下学生的收款单
    const order: any = await db(FEE_ORDER_TABLE).where({ id: orderId }).first();
    if (order?.consult_student_id) {
      await assertStudentIdInScope(order.consult_student_id, req.user);
    }

    await resubmitOrder(orderId, { name: operator.userName, title: operator.roleTitle });
    res.json(ok(null, '已重新提交，等待财务核对'));
  }),
);

/* ============================================================
 * 7.5 ★ 2026-10-19 作废收款单（重复发起 / 发起错了）
 *     POST /api/consult/fee/cancel
 *
 * 为什么必须有这个接口：
 *   之前没有撤销通道，老师发现「多发起了一笔」只能再发一次去「覆盖」，
 *   结果同一费用项堆出好几张单，账面看起来像交了好几次钱。
 *
 * ⚠️ 整批作废：学生档案里是按批次合并显示的，只作废其中一张会留下半截数据，
 *    所以前端传的是整批 orderIds。已到账的单不能作废（要走退费）。
 * ============================================================ */

const cancelSchema = z.object({
  orderIds: z.array(z.string().min(1)).min(1, '至少传一张单据 id'),
  reason: z.string().max(200).optional(),
});

feeRouter.post(
  '/cancel',
  validate(cancelSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof cancelSchema>;
    const operator = req.user!;

    // ★ 数据范围：只能作废自己名下学生的单
    const rows: any[] = await db(FEE_ORDER_TABLE)
      .whereIn('id', body.orderIds)
      .where({ is_deleted: false });
    if (!rows.length) {
      throw new BizError(BizCode.ORDER_NOT_FOUND, '单据不存在或已作废');
    }
    for (const sid of new Set(rows.map((r) => r.consult_student_id))) {
      if (sid) await assertStudentIdInScope(String(sid), req.user);
    }

    const result = await cancelFeeOrders(
      rows.map((r) => String(r.id)),
      body.reason,
      { name: operator.userName, title: operator.roleTitle },
    );

    const msg = result.skipped.length
      ? `已作废 ${result.cancelled} 张；${result.skipped
          .map((s) => `${s.orderNo} 未作废（${s.reason}）`)
          .join('；')}`
      : `已作废 ${result.cancelled} 张单据，财务侧同步作废`;

    res.json(ok(result, msg));
  }),
);

/* ============================================================
 * 8. ⭐ 取费用标准（转发财务接口）
 *    GET /api/consult/fee/standard?feeType=1&deptCode=1
 *
 * ⚠️ 为什么不给前端直接调财务？
 *    ① 跨域（前端 5174 → 财务 8005）
 *    ② 超时兜底要统一做
 * ============================================================ */

feeRouter.get(
  '/standard',
  validate(
    z.object({
      // ★ 2026-10-15：上限 5 → 7（押金 / 校服）
      feeType: z.coerce.number().int().min(1).max(8),
      /** ★ 2026-10-20 部门拆成 1初中部 / 3高中部 / 2大学部（上限放宽到 3） */
      deptCode: z.coerce.number().int().min(1).max(3).default(1),
    }),
  ),
  wrap(async (req, res) => {
    const { feeType, deptCode } = (req as any).validated as {
      feeType: number;
      deptCode: number;
    };
    const std = await financeClient.getStandard(feeType as FeeType, deptCode as DeptCode);
    res.json(ok(std));
  }),
);

/* ============================================================
 * 9. ⭐ 批量取费用标准（转正式弹窗预览金额）
 *    GET /api/consult/fee/standard-batch?deptCode=1
 * ============================================================ */

feeRouter.get(
  '/standard-batch',
  validate(
    z.object({
      deptCode: z.coerce.number().int().min(1).max(3).default(1),
      feeTypes: z.string().optional(),
    }),
  ),
  wrap(async (req, res) => {
    const q = (req as any).validated as { deptCode: number; feeTypes?: string };
    const feeTypes = q.feeTypes
      ? (q.feeTypes.split(',').map((s) => Number(s.trim())).filter((n) => !isNaN(n)) as FeeType[])
      : FULL_FEE_TYPES;

    const result = await financeClient.getStandardBatch(feeTypes, q.deptCode as DeptCode);
    res.json(ok(result));
  }),
);

/* ============================================================
 * 10. 财务模块健康检查（前端显示「财务服务是否在线」）
 *     GET /api/consult/fee/finance-health
 * ============================================================ */

feeRouter.get(
  '/finance-health',
  wrap(async (_req, res) => {
    const online = await financeClient.health();
    res.json(
      ok(
        { online },
        online ? '财务模块在线' : '财务模块未启动或不可达（请确认 8005 端口服务已启动）',
      ),
    );
  }),
);

export default feeRouter;
