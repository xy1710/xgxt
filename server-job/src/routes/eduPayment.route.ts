/**
 * 缴费管理路由
 *
 * 来源：教务管理原型 payment.html
 *
 * 两个 Tab 对应的接口：
 *   1. 缴费总记录   GET  /stats          （缴费总记录 / 正常 / 已冻结 / 临期记录）
 *                   GET  /list           （类别+班级+关键字筛选，分页）
 *                   POST /toggle-freeze  （冻结 ⇄ 启动）
 *                   POST /add            （新建学生缴费信息）
 *   2. 即将到期     GET  /expiring-stats （按类别统计：临期总数 / 已缴 / 未缴 / 凭证状态）
 *                   GET  /expiring/list  （类别+班级+凭证状态+关键字筛选，分页）
 *                   POST /notify         （单个通知：凭证被打回的学生，提醒重新上传）
 *                   POST /notify-all     （一键通知当前筛选下所有被打回的）
 *                   POST /upload         （上传凭证：已缴且未传 → 已传；被打回 → 重新上传）
 *                   POST /batch-upload   （批量上传：当前筛选下所有可上传的 → 已传）
 *                   POST /ocr            （识别缴费截图，自动读出金额和订单号）
 *
 * 即将到期的操作按钮规则（见 buildExpiringActions）：
 *   1. 只有「缴费状态 = 已缴」且「凭证 = 未传」时，「上传」才可点
 *   2. 只有「凭证 = 被打回」时，「重新上传」和「通知」才可点
 *
 * 关键设计：临期列表不单独建表，是从缴费记录派生的
 *   —— 和原型一致：原型里 getExpiringList() 就是 filter(paymentList)，
 *      剩余天数不落库，每次查询时拿 expiry_date 现算。
 */

import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import * as XLSX from 'xlsx';
import {
  BizCode,
  FEE_TYPES,
  HEAD_TEACHERS,
  ALL_CLASSES,
  STUDENT_STATUS_NAME,
  ExpStatus,
  EXPIRING_DAYS,
  URGENT_DAYS,
  PAYMENT_PAGE_SIZE,
  PAY_STATUS_NORMAL,
  PAY_STATUS_FROZEN,
  PayPaidStatus,
  CertStatus,
  UPLOAD_NEED_PAID_TIP,
  UPLOAD_ALREADY_TIP,
  NOTIFY_NEED_REJECT_TIP,
  StudentStatus,
  isAutoFreezeStudentStatus,
  AUTO_FROZEN_TIP,
  OCR_NEED_IMAGE_TIP,
  OCR_FAILED_TIP,
  OCR_MAX_SIZE_MB,
  type OcrResult,
} from 'shared-types/edu';
import { ok, page } from '../utils/response';
import { db } from '../utils/db';
import { wrap } from '../utils/wrap';
import { validate } from '../middleware/validate';
import { BizError } from '../middleware/errorHandler';
import { recognizePaymentScreenshot } from '../services/ocr.service';
// ★ 2026-10-15：教务上传的缴费截图要回传给财务，否则财务核对时看不到凭证
import { pushVoucherToFinance } from '../utils/eduFinanceClient';

export const paymentRouter = Router();

const TABLE = 'sms_edu.t_edu_payment';

/** 0 值转空串 */
function str(v: any): string {
  return v == null ? '' : String(v);
}

/**
 * 日期格式化
 * ⚠️ 不能用 toISOString()——那是 UTC，会比北京时间早 8 小时，跨天就错。
 *
 * pay_date / expiry_date 在库里是 datetime（规范要求时间统一 YYYY-MM-DD HH:mm:ss），
 * 所以对外输出用 fmtDateTime 给完整格式；fmtDate 只在内部算「剩余天数」时用。
 */
function fmtDate(v: any): string | undefined {
  if (!v) return undefined;
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return undefined;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 完整时间格式 YYYY-MM-DD HH:mm:ss（接口对外统一用这个） */
function fmtDateTime(v: any): string | undefined {
  if (!v) return undefined;
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return undefined;
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    ` ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

/** 今天零点（本地时区） */
function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/** 剩余天数：负数表示已过期。原型 daysBetween(now, expDate) */
function calcDaysLeft(expDateStr?: string): number {
  if (!expDateStr) return 0;
  const target = new Date(`${expDateStr}T00:00:00`);
  if (Number.isNaN(target.getTime())) return 0;
  return Math.round((target.getTime() - startOfToday().getTime()) / 86400000);
}

/** 备注文案：原型 remark */
function buildRemark(daysLeft: number): string {
  return daysLeft <= 0 ? '已到期，请尽快处理' : `剩余${daysLeft}天`;
}

/**
 * 没有传班主任时，按班级下标落到原型那套班主任池。
 *
 * 原型写法：`TEACHERS[ALL_CLASSES.indexOf(cls)] || rand(TEACHERS)`
 *   —— 班主任池只有 8 个，而大学部班级（Q16~Q23）下标会超出 8，
 *      原型此时是随机取一个。这里改成对池长度取模，效果一样但结果可预测。
 */
function defaultTeacher(className?: string, fallback = ''): string {
  if (!className) return fallback;
  const idx = ALL_CLASSES.indexOf(className);
  if (idx < 0) return fallback;
  return HEAD_TEACHERS[idx % HEAD_TEACHERS.length] || fallback;
}

/**
 * 临期基础条件：未冻结 且 到期日落在 [今天, 今天+30天]
 * 用 MySQL 的 CURDATE()，避免 JS 与数据库时区不一致。
 */
function applyExpiringScope(query: any) {
  return query
    .where('is_deleted', false)
    .where('frozen', false)
    .whereRaw('expiry_date >= CURDATE()')
    .whereRaw('expiry_date <= DATE_ADD(CURDATE(), INTERVAL ? DAY)', [EXPIRING_DAYS]);
}

// ==================== 统计 ====================

/** 缴费总记录 Tab 的四张统计卡 */
paymentRouter.get(
  '/stats',
  wrap(async (_req, res) => {
    const rows = await db(TABLE).where('is_deleted', false).select('frozen', 'expiry_date', 'category');

    let total = 0;
    let frozen = 0;
    let expiring = 0;

    // 每个类别各多少条：子页签要显示计数，没数据的类别也要出现（值为 0）
    const byCategory: Record<string, number> = {};
    for (const c of FEE_TYPES) byCategory[c] = 0;

    for (const r of rows as any[]) {
      total += 1;
      const isFrozen = Boolean(r.frozen);
      if (isFrozen) frozen += 1;

      const cat = str(r.category);
      byCategory[cat] = (byCategory[cat] || 0) + 1;

      if (!isFrozen) {
        const daysLeft = calcDaysLeft(fmtDate(r.expiry_date));
        if (daysLeft >= 0 && daysLeft <= EXPIRING_DAYS) expiring += 1;
      }
    }

    res.json(
      ok({
        total,
        normal: total - frozen,
        frozen,
        expiring,
        byCategory,
      }),
    );
  }),
);

/**
 * 即将到期 Tab 的统计卡
 *
 * 传了 category 就只统计该类别（跟随页面上的「学费/住宿费/…」子页签）；
 * byCategory 始终返回四个类别各自的临期条数，给子页签当角标用。
 */
paymentRouter.get(
  '/expiring-stats',
  validate(z.object({ category: z.string().optional() })),
  wrap(async (req, res) => {
    const { category } = (req as any).validated as { category?: string };

    const rows = await applyExpiringScope(db(TABLE)).select(
      'category',
      'pay_status',
      'cert_status',
    );

    const byCategory: Record<string, number> = {};
    for (const c of FEE_TYPES) byCategory[c] = 0;

    let total = 0;
    let paid = 0;
    let unpaid = 0;
    let certUploaded = 0;
    let certRejected = 0;

    for (const r of rows as any[]) {
      const cat = str(r.category);
      byCategory[cat] = (byCategory[cat] || 0) + 1;

      if (category && cat !== category) continue;

      total += 1;
      if (str(r.pay_status) === PayPaidStatus.PAID) paid += 1;
      else unpaid += 1;

      const cert = str(r.cert_status) || CertStatus.NONE;
      if (cert === CertStatus.UPLOADED) certUploaded += 1;
      else if (cert === CertStatus.REJECTED) certRejected += 1;
    }

    res.json(ok({ total, paid, unpaid, certUploaded, certRejected, byCategory }));
  }),
);

// ==================== 学生休学/退学 → 系统冻结 ====================

/** 会触发系统冻结的学生状态值 */
const AUTO_FROZEN_STATUSES = [StudentStatus.SUSPENDED, StudentStatus.QUIT];

/**
 * 查一批缴费 id 里，哪些【当前】处于「学生休学/退学」的系统冻结中
 *
 * ⚠️ 实时联学生档案查，而不是只看 t_edu_payment.auto_frozen ——
 *    万一出现了学和缴费两边不同步的情况（比如直接改库），规则依然成立。
 */
async function findAutoFrozenIds(ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db(TABLE)
    .select('id')
    .whereIn(`${TABLE}.id`, ids)
    .where(`${TABLE}.is_deleted`, false)
    .whereIn(
      `${TABLE}.student_no`,
      db('sms_edu.t_student_base')
        .select('student_no')
        .whereIn('student_status', AUTO_FROZEN_STATUSES)
        .where('is_deleted', false),
    );
  return (rows as any[]).map((r) => String(r.id));
}

/** 单个 id 是否处于系统冻结（用于按钮级拦截） */
async function isAutoFrozen(id: string): Promise<boolean> {
  return (await findAutoFrozenIds([id])).length > 0;
}

/**
 * 新建 / 导入缴费时判断要不要自动冻结
 * 学号对应的学生处于休学/退学 → 这条记录一入库就是冻结状态
 */
async function shouldAutoFreeze(studentNo?: string | null): Promise<boolean> {
  if (!studentNo) return false;
  const s = await db('sms_edu.t_student_base')
    .where({ student_no: studentNo, is_deleted: false })
    .first('student_status');
  return isAutoFreezeStudentStatus(s ? Number((s as any).student_status) : undefined);
}

// ==================== 缴费总记录 ====================

const listSchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  size: z.coerce.number().int().min(1).optional(),
  category: z.string().optional(),
  className: z.string().optional(),
  frozenFilter: z.enum(['all', 'normal', 'frozen']).optional(),
  keyword: z.string().optional(),
});

paymentRouter.get(
  '/list',
  validate(listSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as {
      page?: number;
      size?: number;
      category?: string;
      className?: string;
      frozenFilter?: string;
      keyword?: string;
    };

    const size = q.size || PAYMENT_PAGE_SIZE;
    const pageNo = q.page || 1;

    // 联学生档案取「学生状态」。student_no 在档案表里是唯一键，所以是一对一，不会把行数放大
    const query = db(TABLE)
      .leftJoin(db.raw('sms_edu.t_student_base s ON s.student_no = t_edu_payment.student_no AND s.is_deleted = 0'))
      .where('t_edu_payment.is_deleted', false);
    if (q.category) query.andWhere('t_edu_payment.category', q.category);
    if (q.className) query.andWhere('t_edu_payment.class_name', q.className);
    if (q.frozenFilter === 'normal') query.andWhere('t_edu_payment.frozen', false);
    if (q.frozenFilter === 'frozen') query.andWhere('t_edu_payment.frozen', true);
    if (q.keyword) {
      // 原型关键字匹配范围：类别/班级/班主任/学号/学生姓名/缴费时间/到期时间
      const kw = `%${q.keyword}%`;
      // ⚠️ 不能用 knex 的 whereLike —— 它会生成 `COLLATE utf8_bin`，
      //    而表用的是 utf8mb4，MySQL 会报 "COLLATION 'utf8_bin' is not valid ..."
      query.andWhere((builder: any) => {
        builder
          .whereRaw('t_edu_payment.category LIKE ?', [kw])
          .orWhereRaw('t_edu_payment.class_name LIKE ?', [kw])
          .orWhereRaw('t_edu_payment.head_teacher_name LIKE ?', [kw])
          .orWhereRaw('t_edu_payment.student_no LIKE ?', [kw])
          .orWhereRaw('t_edu_payment.student_name LIKE ?', [kw])
          .orWhereRaw('DATE_FORMAT(t_edu_payment.pay_date, "%Y-%m-%d") LIKE ?', [kw])
          .orWhereRaw('DATE_FORMAT(t_edu_payment.expiry_date, "%Y-%m-%d") LIKE ?', [kw]);
      });
    }

    const countRow = await query.clone().clearSelect().clearOrder().count({ c: '*' }).first();
    const total = Number((countRow as any)?.c ?? 0);

    const rows = await query
      .clone()
      .select('t_edu_payment.*', 's.student_status as stu_status')
      .orderBy('t_edu_payment.create_time', 'desc')
      .limit(size)
      .offset((pageNo - 1) * size);

    const list = (rows as any[]).map((r) => {
      const studentNo = str(r.student_no) || undefined;
      const studentStatus = r.stu_status == null ? undefined : Number(r.stu_status);
      const statusName =
        studentStatus == null ? undefined : (STUDENT_STATUS_NAME as any)[studentStatus];
      // 学生休学/退学 → 系统冻结（兜底：即使这条记录的 frozen 字段还没被同步，页面上也必须是冻结）
      const autoFrozen = isAutoFreezeStudentStatus(studentStatus);
      const frozen = Boolean(r.frozen) || autoFrozen;
      return {
        paymentId: r.id,
        category: str(r.category),
        className: str(r.class_name) || undefined,
        headTeacherName: str(r.head_teacher_name) || undefined,
        studentNo,
        studentName: str(r.student_name),
        studentStatus,
        studentStatusName: statusName || undefined,
        // 规范：时间统一 YYYY-MM-DD HH:mm:ss
        payDate: fmtDateTime(r.pay_date),
        expiryDate: fmtDateTime(r.expiry_date),
        frozen,
        autoFrozen: autoFrozen || Boolean(r.auto_frozen),
        payStatusName: frozen ? PAY_STATUS_FROZEN : PAY_STATUS_NORMAL,
      };
    });

    res.json(page(list, total, { page: pageNo, size }));
  }),
);

/**
 * 把缴费记录关联到学生档案
 *
 * 优先用学号；没填学号就按「姓名 + 班级」回表找（同班的优先，其次取学号最小的）。
 * 找不到返回 null —— 学号允许为空，页面上学号和学生状态那两格显示空。
 */
async function resolveStudentNo(opts: {
  studentNo?: string;
  studentName?: string;
  className?: string;
}): Promise<string | null> {
  if (opts.studentNo) {
    const s = await db('sms_edu.t_student_base')
      .where({ student_no: opts.studentNo, is_deleted: false })
      .first('student_no');
    return s ? String((s as any).student_no) : null;
  }

  if (!opts.studentName) return null;

  const s = await db('sms_edu.t_student_base')
    .where({ student_name: opts.studentName, is_deleted: false })
    .orderByRaw(
      opts.className ? 'class_name <=> ? DESC, student_no ASC' : 'student_no ASC',
      opts.className ? [opts.className] : [],
    )
    .first('student_no');

  return s ? String((s as any).student_no) : null;
}

/** 冻结 ⇄ 启动 */
paymentRouter.post(
  '/toggle-freeze',
  validate(z.object({ id: z.string().min(1) })),
  wrap(async (req, res) => {
    const { id } = (req as any).validated as { id: string };
    const row = await db(TABLE).where({ id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.PARAM_ERROR, '缴费记录不存在');

    const next = !Boolean((row as any).frozen);
    // 系统冻结（学生休学/退学）不允许在这里解冻，必须先改学生状态
    if (!next && await isAutoFrozen(id)) {
      throw new BizError(BizCode.PARAM_ERROR, AUTO_FROZEN_TIP);
    }

    await db(TABLE)
      .where({ id })
      .update({ frozen: next, update_time: new Date(), update_by: (req as any).user?.userId || 'system' });

    res.json(ok({ frozen: next }, next ? '已冻结' : '已解冻'));
  }),
);

/**
 * 批量冻结 / 解冻
 *
 * 页面在表格前加了复选框，勾选多行后一次性置 frozen。
 * ⚠️ 只更新「还不是目标状态」的行 —— 已经冻结的再点批量冻结不会产生变更计数，
 *    避免提示出「已冻结 20 条」这种和体感不符的数字。
 */
paymentRouter.post(
  '/batch-freeze',
  validate(
    z.object({
      ids: z.array(z.string().min(1)).min(1, '请先勾选要操作的记录'),
      frozen: z.boolean(),
    }),
  ),
  wrap(async (req, res) => {
    const { ids, frozen } = (req as any).validated as { ids: string[]; frozen: boolean };

    // 解冻时要跳过「学生休学/退学」的系统冻结记录 —— 这批只能靠改学生状态来解冻
    let targets = ids;
    let skipped = 0;
    if (!frozen) {
      const lockedIds = await findAutoFrozenIds(ids);
      skipped = lockedIds.length;
      targets = ids.filter((i) => !lockedIds.includes(i));
      if (targets.length === 0) {
        throw new BizError(
          BizCode.PARAM_ERROR,
          skipped > 0 ? `勾选的 ${skipped} 条均为学生休学/退学的系统冻结记录，${AUTO_FROZEN_TIP}` : '请先勾选要操作的记录',
        );
      }
    }

    const now = new Date();
    const count = await db(TABLE)
      .whereIn('id', targets)
      .where('is_deleted', false)
      .where('frozen', !frozen) // 只挑状态不同的
      .update({ frozen, update_time: now, update_by: (req as any).user?.userId || 'system' });

    if (count === 0 && skipped === 0) {
      throw new BizError(
        BizCode.PARAM_ERROR,
        frozen ? '勾选的记录都已经是冻结状态' : '勾选的记录都已是正常状态',
      );
    }

    const msg =
      skipped > 0
        ? `已${frozen ? '冻结' : '解冻'} ${count} 条，${skipped} 条因学生休学/退学未解冻`
        : `已${frozen ? '冻结' : '解冻'} ${count} 条`;

    res.json(ok({ count, skipped }, msg));
  }),
);

/** 新建学生缴费信息 */
paymentRouter.post(
  '/add',
  validate(
    z.object({
      category: z.string().min(1),
      className: z.string().optional(),
      headTeacherName: z.string().optional(),
      studentNo: z.string().optional(),
      studentName: z.string().min(1, '请填写学生姓名'),
      // 同上：金额单位「分」，整数
      amount: z.coerce.number().int().min(0).optional(),
      payStatus: z.string().optional(),
      payDate: z.string().min(1, '请选择缴费时间'),
      expiryDate: z.string().min(1, '请选择到期时间'),
    }),
  ),
  wrap(async (req, res) => {
    const body = (req as any).validated as {
      category: string;
      className?: string;
      headTeacherName?: string;
      studentNo?: string;
      studentName: string;
      amount?: number;
      payStatus?: string;
      payDate: string;
      expiryDate: string;
    };

    if (!FEE_TYPES.includes(body.category as any)) {
      throw new BizError(BizCode.PARAM_ERROR, `类别只能是：${FEE_TYPES.join(' / ')}`);
    }

    const teacher = body.headTeacherName || defaultTeacher(body.className);
    const studentNo = await resolveStudentNo({
      studentNo: body.studentNo,
      studentName: body.studentName,
      className: body.className,
    });

    // 休学/退学的学生，缴费记录一入库就是冻结状态
    const autoFrozen = await shouldAutoFreeze(studentNo);

    await db(TABLE).insert({
      id: randomUUID(),
      create_time: new Date(),
      create_by: (req as any).user?.userId || 'system',
      is_deleted: false,
      category: body.category,
      class_name: body.className || null,
      head_teacher_name: teacher || null,
      student_no: studentNo,
      student_name: body.studentName,
      amount: body.amount ?? null,
      pay_status: body.payStatus || PayPaidStatus.PAID,
      cert_status: CertStatus.NONE,
      pay_date: body.payDate,
      expiry_date: body.expiryDate,
      frozen: autoFrozen,
      auto_frozen: autoFrozen ? 1 : 0,
      // 新建时若正好落在临期区间，沿用原型的默认状态判定
      // ⚠️ 系统冻结的记录不参与临期提醒 —— 学生都休学/退学了，不该再催缴
      exp_status: (() => {
        if (autoFrozen) return null;
        const d = calcDaysLeft(body.expiryDate);
        if (d < 0 || d > EXPIRING_DAYS) return null;
        return d <= URGENT_DAYS ? ExpStatus.WAIT_UPLOAD : ExpStatus.WAIT_NOTIFY;
      })(),
    });

    res.json(ok(null, autoFrozen ? `创建成功，${AUTO_FROZEN_TIP}` : '创建成功'));
  }),
);

// ==================== 即将到期 ====================

const expiringSchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  size: z.coerce.number().int().min(1).optional(),
  category: z.string().optional(),
  className: z.string().optional(),
  expStatus: z.string().optional(),
  payStatus: z.string().optional(),
  certStatus: z.string().optional(),
  keyword: z.string().optional(),
});

/** 批量上传：多了「只处理勾选行」的 ids */
const batchUploadSchema = expiringSchema.extend({
  ids: z.array(z.string().min(1)).max(500).optional(),
});

/**
 * 即将到期页操作按钮的业务规则（前后端共用一份判定）
 *
 *   1. 只有「缴费状态 = 已缴」且「凭证 = 未传」时，「上传」才可点
 *   2. 只有「凭证 = 被打回」时，「重新上传」和「通知」才可点
 *
 * 返回三个按钮的可用性 + 不可点时的原因（前端直接拿去当 tooltip）
 */
function buildExpiringActions(payStatus: string, certStatus: string) {
  const paid = payStatus === PayPaidStatus.PAID;
  const rejected = certStatus === CertStatus.REJECTED;
  const uploaded = certStatus === CertStatus.UPLOADED;

  const canUpload = paid && certStatus === CertStatus.NONE;
  const canReupload = paid && rejected;
  const canNotify = rejected;

  // 已被打回的行本身就能操作，不需要提示；其余按优先级给一条原因
  let actionTip: string | undefined;
  if (!rejected) {
    if (!paid) actionTip = UPLOAD_NEED_PAID_TIP;
    else if (uploaded) actionTip = UPLOAD_ALREADY_TIP;
  }

  return { canUpload, canReupload, canNotify, actionTip };
}

/** 单行 → 临期列表项（派生字段 + 按钮可用性），查询和批量上传共用 */
function mapExpiringRow(r: any) {
  // expDate 只用来算剩余天数（要的是「哪天」），对外输出另用 fmtDateTime 给完整时间
  const expDate = fmtDate(r.expiry_date);
  const daysLeft = calcDaysLeft(expDate);
  const expStatus = str(r.exp_status) || ExpStatus.WAIT_NOTIFY;
  const payStatus = str(r.pay_status) || PayPaidStatus.PAID;
  // 历史数据没有凭证状态列时按「未传」处理
  const certStatus = str(r.cert_status) || CertStatus.NONE;
  return {
    paymentId: r.id,
    category: str(r.category),
    className: str(r.class_name) || undefined,
    headTeacherName: str(r.head_teacher_name) || undefined,
    studentNo: str(r.student_no) || undefined,
    studentName: str(r.student_name),
    amount: r.amount == null ? undefined : Number(r.amount),
    orderNo: str(r.order_no) || undefined,
    payStatus,
    payStatusName: payStatus,
    // 规范：时间统一 YYYY-MM-DD HH:mm:ss
    payDate: fmtDateTime(r.pay_date),
    expiryDate: fmtDateTime(r.expiry_date),
    daysLeft,
    remark: buildRemark(daysLeft),
    urgent: daysLeft <= URGENT_DAYS,
    certStatus,
    certStatusName: certStatus,
    expStatus,
    expStatusName: expStatus,
    certificateName: str(r.certificate_name) || undefined,
    uploadRemark: str(r.upload_remark) || undefined,
    ...buildExpiringActions(payStatus, certStatus),
  };
}

/**
 * 共用查询：返回临期记录原文 + 派生字段
 * exportAll=true 时不做分页，供批量操作使用
 */
async function queryExpiring(opts: {
  category?: string;
  className?: string;
  expStatus?: string;
  payStatus?: string;
  certStatus?: string;
  keyword?: string;
  exportAll?: boolean;
}) {
  const query = applyExpiringScope(db(TABLE));
  if (opts.category) query.andWhere('category', opts.category);
  if (opts.className) query.andWhere('class_name', opts.className);
  if (opts.expStatus) query.andWhere('exp_status', opts.expStatus);
  if (opts.payStatus) query.andWhere('pay_status', opts.payStatus);
  if (opts.certStatus) query.andWhere('cert_status', opts.certStatus);
  if (opts.keyword) {
    // 原型关键字匹配范围：类别/班级/班主任/学生姓名/到期时间/备注
    const kw = `%${opts.keyword}%`;
    // 同上：用 whereRaw 避开 COLLATE utf8_bin 与 utf8mb4 的冲突
    query.andWhere((builder: any) => {
      builder
        .whereRaw('category LIKE ?', [kw])
        .orWhereRaw('class_name LIKE ?', [kw])
        .orWhereRaw('head_teacher_name LIKE ?', [kw])
        .orWhereRaw('student_name LIKE ?', [kw])
        .orWhereRaw('DATE_FORMAT(expiry_date, "%Y-%m-%d") LIKE ?', [kw]);
    });
  }

  const countRow = await query.clone().clearSelect().clearOrder().count({ c: '*' }).first();
  const total = Number((countRow as any)?.c ?? 0);

  const rows = await query.clone().orderBy('expiry_date', 'asc');

  const list = (rows as any[]).map(mapExpiringRow);

  return { list, total };
}

paymentRouter.get(
  '/expiring/list',
  validate(expiringSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as any;
    const size = q.size || PAYMENT_PAGE_SIZE;
    const pageNo = q.page || 1;

    const { list, total } = await queryExpiring(q);

    // 备注是派生字段，包含「剩余N天」，所以只能在内存里分页
    res.json(page(list.slice((pageNo - 1) * size, pageNo * size), total, { page: pageNo, size }));
  }),
);

/** 单个通知：只有凭证「被打回」才能通知学生重新上传 */
paymentRouter.post(
  '/notify',
  validate(z.object({ id: z.string().min(1) })),
  wrap(async (req, res) => {
    const { id } = (req as any).validated as { id: string };
    const row = await db(TABLE).where({ id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.PARAM_ERROR, '缴费记录不存在');

    const certStatus = str((row as any).cert_status) || CertStatus.NONE;
    if (certStatus !== CertStatus.REJECTED) {
      throw new BizError(BizCode.PARAM_ERROR, NOTIFY_NEED_REJECT_TIP);
    }

    await db(TABLE)
      .where({ id })
      .update({
        exp_status: ExpStatus.WAIT_UPLOAD,
        notify_time: new Date(),
        update_time: new Date(),
        update_by: (req as any).user?.userId || 'system',
      });

    res.json(ok({ count: 1 }, '已发送通知'));
  }),
);

/** 一键通知：当前筛选条件下所有凭证「被打回」的记录 */
paymentRouter.post(
  '/notify-all',
  validate(expiringSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as any;
    const { list } = await queryExpiring(q);
    const targets = list.filter((x) => x.certStatus === CertStatus.REJECTED);

    if (targets.length === 0) {
      throw new BizError(BizCode.PARAM_ERROR, NOTIFY_NEED_REJECT_TIP);
    }

    const now = new Date();
    await db(TABLE)
      .whereIn(
        'id',
        targets.map((x) => x.paymentId),
      )
      .update({
        exp_status: ExpStatus.WAIT_UPLOAD,
        notify_time: now,
        update_time: now,
        update_by: (req as any).user?.userId || 'system',
      });

    res.json(ok({ count: targets.length }, `已成功通知 ${targets.length} 名学生`));
  }),
);

/* ============================================================
 * 缴费截图识别（OCR）
 *
 * 教务点「上传 / 重新上传」→ 先选截图 → 这里识别金额和订单号 → 回填弹窗（只读）
 * → 点「确认」才带着 amount / orderNo 调 /upload 落库。
 * ============================================================ */

/**
 * 把教务上传的缴费截图写入 uploads/voucher/，返回相对地址
 *
 * ⚠️ 为什么必须有这一步（2026-10-15）：
 *   改造前这张图只在 OCR 时「路过」后端就被丢掉了 ——
 *   库里只留一个文件名占位（certificate_name），图片本身并不存在，
 *   所以**财务侧永远看不到教务上传的凭证**。
 *
 * ⚠️ 落盘目录必须与 app.ts 的静态托管根一致：
 *   app.ts 用 `path.resolve(__dirname, '../uploads')`（= server-job/uploads），
 *   而服务启动时 cwd 就是 server-job，所以 `process.cwd()/uploads` 是同一目录。
 *   写法与咨询侧 `/api/consult/fee/upload-file` 保持一致，
 *   两边的相对路径 `/uploads/voucher/xxx` 在同一个服务下都能访问。
 */
function saveEduVoucher(buffer: Buffer, originalName: string): string {
  const rawExt = (path.extname(originalName || '') || '.png').toLowerCase();
  const ext = /^\.(jpe?g|png|bmp|webp|gif)$/.test(rawExt) ? rawExt : '.png';
  const fileName = `edu_${Date.now()}_${randomUUID().slice(0, 8)}${ext}`;
  const uploadDir = path.resolve(process.cwd(), 'uploads/voucher');
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }
  fs.writeFileSync(path.join(uploadDir, fileName), buffer);
  return `/uploads/voucher/${fileName}`;
}

const uploadShot = multer({
  storage: multer.memoryStorage(),
  // ⚠️ 保险写法：万一契约包的常量没编进来（NaN）会让 multer 直接抛错把进程打挂
  limits: { fileSize: (Number(OCR_MAX_SIZE_MB) || 10) * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(null, /\.(jpe?g|png|bmp|webp|gif)$/i.test(file.originalname));
  },
});

paymentRouter.post(
  '/ocr',
  uploadShot.single('file'),
  wrap(async (req, res) => {
    const file = (req as any).file as { buffer: Buffer; originalname: string } | undefined;
    // 空文件也要挡掉：0 字节丢给 tesseract 会直接抛异常，返回 500 而不是业务错误
    if (!file || !file.buffer || file.buffer.length === 0) {
      throw new BizError(BizCode.PARAM_ERROR, OCR_NEED_IMAGE_TIP);
    }

    const result: OcrResult = await recognizePaymentScreenshot(file.buffer);

    // 一项都没认出来 → 直接报错，让页面提示换张清晰的图
    if (!result.recognized) {
      throw new BizError(BizCode.PARAM_ERROR, OCR_FAILED_TIP);
    }

    /**
     * ⭐ 2026-10-15：识别成功的同时把截图落盘，并把地址一并返回。
     *
     * 前端拿到的 certificateUrl 会随「确认」一起提交给 /upload，
     * 落库后由本模块回传给财务 —— 这样财务才看得到这张凭证。
     * （放在识别成功之后存：识别失败时前端会换图重试，存了也是垃圾文件）
     */
    const certificateUrl = saveEduVoucher(file.buffer, file.originalname);

    res.json(
      ok(
        { ...result, certificateUrl },
        result.amount != null && result.orderNo
          ? '识别成功'
          : '识别成功，但有一项未识别到，请确认截图是否清晰',
      ),
    );
  }),
);

/**
 * 单个上传凭证
 *
 * 规则：已缴 且 凭证未传 → 「上传」；凭证被打回 → 「重新上传」。
 * 除此之外（未缴 / 凭证已传）一律拒绝，避免状态被绕过。
 *
 * amount / orderNo 由截图识别带出来（弹窗里只读，不允许手改），
 * 确认后才写进库 —— 所以列表里的金额和订单号是点「确认」之后才出现的。
 */
paymentRouter.post(
  '/upload',
  validate(
    z.object({
      id: z.string().min(1),
      certificateName: z.string().optional(),
      uploadRemark: z.string().optional(),
      // 规范：金额是整数、单位「分」，所以不允许小数
      amount: z.coerce.number().int().min(0).max(99999999).optional(),
      orderNo: z.string().max(64).optional(),
      /**
       * ⭐ 2026-10-15 新增：截图相对地址（来自 /ocr 的返回）
       * 存入 certificate_url，并回传给财务 —— 财务核对时看到的就是这张图。
       */
      certificateUrl: z.string().max(255).optional(),
    }),
  ),
  wrap(async (req, res) => {
    const { id, certificateName, uploadRemark, amount, orderNo, certificateUrl } = (req as any)
      .validated as {
      id: string;
      certificateName?: string;
      uploadRemark?: string;
      amount?: number;
      orderNo?: string;
      certificateUrl?: string;
    };

    const row = await db(TABLE).where({ id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.PARAM_ERROR, '缴费记录不存在');

    const payStatus = str((row as any).pay_status) || PayPaidStatus.PAID;
    const certStatus = str((row as any).cert_status) || CertStatus.NONE;
    const { canUpload, canReupload } = buildExpiringActions(payStatus, certStatus);
    if (!canUpload && !canReupload) {
      throw new BizError(
        BizCode.PARAM_ERROR,
        payStatus !== PayPaidStatus.PAID ? UPLOAD_NEED_PAID_TIP : UPLOAD_ALREADY_TIP,
      );
    }

    const now = new Date();
    await db(TABLE).where({ id }).update({
      exp_status: ExpStatus.UPLOADED,
      cert_status: CertStatus.UPLOADED,
      upload_time: now,
      certificate_name: certificateName || null,
      upload_remark: uploadRemark || null,
      // 截图识别结果：没识别到就不覆盖已有的（避免把老数据清成空）
      ...(amount != null ? { amount } : {}),
      ...(orderNo ? { order_no: orderNo } : {}),
      // ⭐ 截图地址：本次没带就保留库里已有的（避免把上次传的图清掉）
      ...(certificateUrl ? { certificate_url: certificateUrl } : {}),
      update_time: now,
      update_by: (req as any).user?.userId || 'system',
    });

    /**
     * ⭐ 2026-10-15：把这张截图回传给财务
     *
     * 为什么放在这里：教务的职责到「上传凭证」为止，但这张凭证必须让财务看得到，
     * 否则财务在「缴费管理」核准时是瞎的（用户反馈的正是这个问题）。
     *
     * ⚠️ 非阻断：回传失败只记日志 + 在返回文案里说明，**不回滚**教务侧的上传 ——
     *    教务自己的状态流转是对的，财务那边可人工补录。
     */
    const rawRow = row as Record<string, any>;
    const sync = await pushVoucherToFinance({
      studentNo: rawRow.student_no,
      category: rawRow.category,
      // 本次传了地址用本次的；没传则回退到库里已存的
      voucherUrl: certificateUrl || rawRow.certificate_url,
      voucherNo: orderNo || rawRow.order_no,
    });
    if (!sync.ok) {
      // eslint-disable-next-line no-console
      console.warn(`[教务→财务] 缴费 ${id} 凭证回传未成功（不影响教务侧上传）：${sync.message}`);
    }

    const baseTip = canReupload ? '凭证重新上传成功' : '凭证上传成功';
    res.json(
      ok(
        { financeSynced: sync.ok, financeSyncMessage: sync.ok ? null : (sync.message ?? null) },
        sync.ok ? `${baseTip}，已同步至财务` : `${baseTip}（${sync.message}）`,
      ),
    );
  }),
);

/**
 * 批量上传凭证
 *
 * 传 ids：只处理页面上勾选的那几行（表格复选框选谁传谁）
 * 不传 ids：按当前筛选条件整批处理
 *
 * 两种情况都走同一套规则：只有「已缴 且 凭证未传/被打回」的才会被处理，
 * 未缴的、凭证已传的会被跳过（skipped），不会浑水摸鱼改掉不该改的数据。
 */
paymentRouter.post(
  '/batch-upload',
  validate(batchUploadSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as any;
    const ids = q.ids as string[] | undefined;

    let list: any[];
    if (Array.isArray(ids)) {
      // ⚠️ 空数组代表「页面上一条都没勾」，绝不能退化成整批处理——那会把全表都传了
      if (ids.length === 0) {
        throw new BizError(BizCode.PARAM_ERROR, '请先勾选需要上传凭证的记录');
      }
      // 勾选模式：忽略筛选条件，直接按 id 取，但仍要落在「临期」范围内
      const rows = await applyExpiringScope(db(TABLE)).whereIn('id', ids);
      list = (rows as any[]).map(mapExpiringRow);
    } else {
      const res2 = await queryExpiring(q);
      list = res2.list;
    }

    const targets = list.filter((x: any) => x.canUpload || x.canReupload);
    const skipped = list.length - targets.length;

    if (targets.length === 0) {
      throw new BizError(
        BizCode.PARAM_ERROR,
        Array.isArray(ids)
          ? '勾选的记录都不满足上传条件（需已缴且凭证未传/被打回）'
          : '当前没有可上传凭证的记录',
      );
    }

    const now = new Date();
    await db(TABLE)
      .whereIn(
        'id',
        targets.map((x: any) => x.paymentId),
      )
      .update({
        exp_status: ExpStatus.UPLOADED,
        cert_status: CertStatus.UPLOADED,
        upload_time: now,
        update_time: now,
        update_by: (req as any).user?.userId || 'system',
      });

    const tip = skipped > 0 ? `，跳过 ${skipped} 条不满足条件的` : '';
    res.json(
      ok(
        { count: targets.length, skipped },
        `批量上传成功：共处理 ${targets.length} 条记录${tip}`,
      ),
    );
  }),
);

// ==================== 导入 ====================

/** 导入文件的表头 → 字段 映射（支持常见别名） */
const PAYMENT_HEADERS: Record<string, string> = {
  类别: 'category',
  费用类别: 'category',
  收费类别: 'category',
  学号: 'studentNo',
  学生学号: 'studentNo',
  班级: 'className',
  班主任: 'headTeacherName',
  老师: 'headTeacherName',
  学生姓名: 'studentName',
  姓名: 'studentName',
  学生: 'studentName',
  缴费金额: 'amount',
  金额: 'amount',
  应缴金额: 'amount',
  缴费状态: 'payStatus',
  缴纳状态: 'payStatus',
  缴费时间: 'payDate',
  缴费日期: 'payDate',
  到期时间: 'expiryDate',
  到期日期: 'expiryDate',
  有效期至: 'expiryDate',
};

const uploadPayment = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(null, /\.(xlsx|xls|csv)$/i.test(file.originalname));
  },
});

/** 下载导入模板 */
paymentRouter.get(
  '/import-template',
  wrap(async (_req, res) => {
    const headers = [
      '学号',
      '类别',
      '班级',
      '班主任',
      '学生姓名',
      '缴费金额',
      '缴费状态',
      '缴费时间',
      '到期时间',
    ];
    const demo = [
      'G20251001',
      '住宿费',
      '高一1班',
      '王老师',
      '张伟',
      1200,
      '已缴',
      '2026-09-01',
      '2027-08-31',
    ];

    const aoa = [headers, demo];
    const sheet = XLSX.utils.aoa_to_sheet(aoa);
    sheet['!cols'] = headers.map(() => ({ wch: 16 }));

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, '缴费导入模板');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', 'attachment; filename*=UTF-8\'\'payment-template.xlsx');
    res.end(buf);
  }),
);

/** 上传并解析入库 */
paymentRouter.post(
  '/import',
  uploadPayment.single('file'),
  wrap(async (req, res) => {
    const file = (req as any).file as { buffer: Buffer; originalname: string } | undefined;
    if (!file) throw new BizError(BizCode.PARAM_ERROR, '请先选择要导入的文件');

    const wb = XLSX.read(file.buffer, { type: 'buffer', cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    if (!sheet) throw new BizError(BizCode.PARAM_ERROR, '文件内容为空');

    // ⚠️ 必须用 raw: true 拿到原始值（Date 对象 / Excel 序列号）。
    //    用 raw: false 的话 XLSX 会把日期格式化成 "8/1/26" 这种有歧义的字符串，
    //    遇到不同分隔符就容易解析失败（实测踩过）。
    const rows = XLSX.utils.sheet_to_json<any[]>(sheet, {
      header: 1,
      raw: true,
      defval: '',
    });
    if (rows.length < 2) throw new BizError(BizCode.PARAM_ERROR, '文件里没有数据行');

    const norm = (s: any) => String(s ?? '').replace(/[\s*＊]/g, '').toLowerCase();
    const colToKey: Record<number, string> = {};
    (rows[0] as any[]).forEach((h: any, idx: number) => {
      const key = PAYMENT_HEADERS[norm(h)];
      if (key) colToKey[idx] = key;
    });

    if (!Object.values(colToKey).includes('studentName')) {
      throw new BizError(BizCode.PARAM_ERROR, '缺少必需列「学生姓名」，请先下载模板按格式填写');
    }

    const cell = (v: any) => String(v ?? '').trim();

    const pad = (n: number) => String(n).padStart(2, '0');

    /**
     * 单元格值可能是 Date 对象 / ISO 字符串 / Excel 序列号 / "yyyy-mm-dd" / "m/d/yy"，
     * 统一转成 yyyy-MM-dd。解析不出来返回 undefined（由调用方判定为非法日期）。
     */
    function parseDateInput(v: any): string | undefined {
      if (v == null || v === '') return undefined;

      // 1) Date 对象（cellDates: true + raw: true 时）
      if (v instanceof Date) {
        if (Number.isNaN(v.getTime())) return undefined;
        return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
      }

      const s = String(v).trim();
      if (!s) return undefined;

      // 2) ISO 字符串：2026-08-01T00:00:00.000Z
      const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})[T\s]/);
      if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

      // 3) yyyy-m-d 或 yyyy/m/d
      const ymd = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
      if (ymd) return `${ymd[1]}-${pad(Number(ymd[2]))}-${pad(Number(ymd[3]))}`;

      // 4) m/d/yy 或 m/d/yyyy（XLSX 格式化过的日期，月在前）
      const mdy = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
      if (mdy) {
        const year = mdy[3].length === 2 ? 2000 + Number(mdy[3]) : Number(mdy[3]);
        return `${year}-${pad(Number(mdy[1]))}-${pad(Number(mdy[2]))}`;
      }

      // 5) Excel 日期序列号（1899-12-30 起算）
      if (/^\d{5,6}$/.test(s)) {
        const parsed = new Date(Date.UTC(1899, 11, 30) + Number(s) * 86400000);
        return `${parsed.getUTCFullYear()}-${pad(parsed.getUTCMonth() + 1)}-${pad(
          parsed.getUTCDate(),
        )}`;
      }

      return undefined;
    }

    let successCount = 0;
    let autoFrozenCount = 0;
    const failures: { row: number; reason: string }[] = [];

    await db.transaction(async (trx) => {
      for (let i = 1; i < rows.length; i += 1) {
        const line = rows[i] as any[];
        if (!line || line.every((c: any) => cell(c) === '')) continue; // 跳过空行

        const raw: Record<string, string> = {};
        for (const [idxStr, key] of Object.entries(colToKey)) {
          raw[key] = cell(line[Number(idxStr)]);
        }
        const payDate = parseDateInput(line[Number(Object.keys(colToKey).find((k) => colToKey[Number(k)] === 'payDate')!)]);
        const expiryDate = parseDateInput(
          line[Number(Object.keys(colToKey).find((k) => colToKey[Number(k)] === 'expiryDate')!)],
        );

        const rowNo = i + 1;
        const studentName = raw.studentName;

        if (!studentName) {
          failures.push({ row: rowNo, reason: '缺少学生姓名' });
          continue;
        }
        if (!payDate || !expiryDate) {
          failures.push({ row: rowNo, reason: '缺少或非法的缴费时间/到期时间' });
          continue;
        }

        const category = FEE_TYPES.includes(raw.category as any) ? raw.category : FEE_TYPES[0];
        const teacher = raw.headTeacherName || defaultTeacher(raw.className);
        const studentNo = await resolveStudentNo({
          studentNo: raw.studentNo,
          studentName,
          className: raw.className,
        });
        // 同上：休学/退学的学生导入进来就是冻结状态
        const autoFrozen = await shouldAutoFreeze(studentNo);

        await trx(TABLE).insert({
          id: randomUUID(),
          create_time: new Date(),
          create_by: (req as any).user?.userId || 'system',
          is_deleted: false,
          category,
          class_name: raw.className || null,
          head_teacher_name: teacher || null,
          student_no: studentNo,
          student_name: studentName,
          // Excel 模板里填的是「元」，落库按规范转「分」
          amount:
            Number.isFinite(Number(raw.amount)) && raw.amount !== ''
              ? Math.round(Number(raw.amount) * 100)
              : null,
          pay_status: raw.payStatus || PayPaidStatus.PAID,
          cert_status: CertStatus.NONE,
          pay_date: payDate,
          expiry_date: expiryDate,
          frozen: autoFrozen,
          auto_frozen: autoFrozen ? 1 : 0,
          // 同上：系统冻结的记录不进临期流程
          exp_status: (() => {
            if (autoFrozen) return null;
            const d = calcDaysLeft(expiryDate);
            if (d < 0 || d > EXPIRING_DAYS) return null;
            return d <= URGENT_DAYS ? ExpStatus.WAIT_UPLOAD : ExpStatus.WAIT_NOTIFY;
          })(),
        });
        successCount += 1;
        if (autoFrozen) autoFrozenCount += 1;
      }
    });

    res.json(
      ok({
        success: successCount,
        autoFrozen: autoFrozenCount,
        failed: failures.length,
        failures: failures.slice(0, 50),
      }),
    );
  }),
);

export default paymentRouter;
