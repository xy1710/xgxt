/**
 * 催费管理路由（教学管理初高）
 *
 * 覆盖：list（含 remainDays/isUrgent，按配置阈值）/ export / voucher（上传缴费凭证）/
 *      share（写 notify + 文案）/ notify/list。
 * 表：t_class_fee、t_class_fee_notify。
 * 挂载：/api/class/fee。
 *
 * ★ 2026-10-20：催费推送 / 催费记录在页面上已下线（操作列改成「上传缴费凭证」），
 *   但 share / notify/list 的接口与数据保留，便于后续接真实短信发送时复用。
 */

import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  BizCode,
  FEE_TYPE_NAME,
  PAY_METHOD_NAME,
  PAY_STATUS_NAME,
  SHARE_CHANNEL_NAME,
  SHARE_CHANNEL_PUSH_CODES,
} from 'shared-types/class-jh';
import { FeeType, PayMethod, PayStatus, ShareChannel } from 'shared-types/class-jh';
import { ok, page } from '../utils/response';
import { db } from '../utils/db';
import { wrap } from '../utils/wrap';
import { nameOf } from '../utils/enumName';
import { getNumberSetting } from '../utils/setting';
import { writeOpLog } from '../utils/opLog';
import { boolFlag } from '../../utils/query';
import { validate } from '../middleware/validate';
import { checkPermission } from '../middleware/auth';
import { BizError } from '../middleware/errorHandler';
// ★ 2026-10-20 批量转交财务：直接复用财务自己的建单服务（凭证唯一性等规则不重复实现）
import { addFee as financeAddFee } from '../../finance/services/fee.service';

export const feeRouter = Router();

const FEE_TABLE = 't_class_fee';
const NOTIFY_TABLE = 't_class_fee_notify';
const STUDENT_TABLE = 't_class_student';

/** 剩余天数（到期日 - 今天）；无到期日返回 null */
function calcRemainDays(expireDate: any): number | null {
  if (!expireDate) return null;
  const d = new Date(expireDate);
  if (Number.isNaN(d.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  d.setHours(0, 0, 0, 0);
  return Math.round((d.getTime() - today.getTime()) / (24 * 3600 * 1000));
}

/**
 * 未结清状态（待缴 / 逾期 / 冻结）
 *
 * ★ 2026-10-20 补 OVERDUE：原来只算「待缴 + 冻结」，
 *   而演示库里的逾期行 pay_status 写的是 4（逾期）→ 这类行既没状态名、也没「紧急」标记，
 *   用户看到的正是「有些人没有缴费状态」+「逾期的不是紧急」。逾期当然是没交钱，
 *   必须算未结清，才会在 remainDays 为负时自动打上「紧急」。
 */
const UNPAID_STATUSES = [PayStatus.UNPAID, PayStatus.OVERDUE, PayStatus.FROZEN];

/**
 * 计算「对外展示用的缴费状态」
 *
 * ★ 2026-10-20 第二个坑：用户看到「剩余 -12 天了还显示待缴，为什么不显示逾期？」
 *   原因：财务侧根本不写 4（财务枚举只有 1待缴/2待核对/3已缴/5冻结，4 只存在于列注释里），
 *   所以过了到期日的行，库里 pay_status 还是 **1 待缴** —— 4 靠数据是等不来的。
 *   → 逾期只能**按日期派生**：还是待缴、且到期日已过 → 展示为「逾期」。
 *
 * 派生只针对「待缴(1)」：
 *   · 已缴(2) / 已核对(3)：钱已经收了，过期也不叫逾期，状态不变；
 *   · 冻结(5)：冻结期间本来就不该催，保持冻结，别被改成逾期。
 */
function effectivePayStatus(rawPayStatus: number, remainDays: number | null): number {
  if (rawPayStatus === PayStatus.UNPAID && remainDays !== null && remainDays < 0) {
    return PayStatus.OVERDUE;
  }
  return rawPayStatus;
}

/**
 * 缴费台账行 → 实体（含派生 remainDays/isUrgent）
 *
 * ★ 2026-10-20 用户要求：列表补「学生手机号 / 家长手机号」。
 *   t_class_fee 是**缴费流水表，不存联系方式**（已核 information_schema：
 *   21 列里没有任何 phone 列），联系方式只在学生表 t_class_student 上，
 *   → 由调用方按 studentId 批量补齐（见 fetchStudentContacts），
 *   这里只负责把补好的值透传出去，缺学生档时给 null（前端显示 —）。
 *
 * ★ 2026-10-20：payStatus 输出的是**派生后的状态**（逾期按到期日算），
 *   rawPayStatus 保留库里的原值，方便排查「为什么这条是逾期」。
 */
function toFee(r: any, remindDays: number) {
  const remainDays = calcRemainDays(r.expire_date);
  const payStatus = effectivePayStatus(r.pay_status, remainDays);
  const isUrgent =
    UNPAID_STATUSES.includes(payStatus) && remainDays !== null && remainDays <= remindDays;
  return {
    feeId: r.id,
    studentId: r.student_id,
    studentNo: r.student_no,
    studentName: r.student_name,
    classId: r.class_id,
    className: r.class_name,
    deptCode: r.dept_code,
    phone: r.phone ?? null,
    parentPhone: r.parent_phone ?? null,
    feeType: r.fee_type,
    feeTypeName: nameOf(FEE_TYPE_NAME, r.fee_type),
    feeAmount: r.fee_amount,
    payStatus,
    payStatusName: nameOf(PAY_STATUS_NAME, payStatus),
    /** 库里的原值（1 待缴 / 2 已缴 / 3 已核对 / 4 逾期 / 5 冻结） */
    rawPayStatus: r.pay_status,
    payDate: r.pay_date,
    expireDate: r.expire_date,
    remainDays,
    isUrgent,
    voucherUrl: r.voucher_url,
    /* ★ 2026-10-20 登记缴费写入的三项（未登记为 null，前端显示 —） */
    payMethod: r.pay_method ?? null,
    payMethodName: r.pay_method ? nameOf(PAY_METHOD_NAME, r.pay_method) : null,
    paidAmount: r.paid_amount ?? null,
    payRemark: r.pay_remark ?? null,
    /**
     * 是否已转交财务（批量转交的判据）
     * source_system='finance' + source_id 有值 = 这张单已经有对应的财务缴费单
     */
    transferred: r.source_system === 'finance' && !!r.source_id,
  };
}

/**
 * 催费列表窗口判断（★ 2026-10-20 用户要求：到期日到 20 天才进催费列表）
 *
 * 【数据从哪来】催费列表的内容来自财务管理 · 缴费管理：财务的缴费单
 *   (`sms_finance.t_finance_fee`) 在新增/回传凭证/核对/打回时，由
 *   `finance/services/class-sync.ts` 的 `syncFeeToJh()` 幂等同步成本表的副本
 *   （`sms_class_jh.t_class_fee`，含 `expire_date` 到期日期）。
 *
 * 【窗口口径】到期日距今 ≤ feeUrgeWindowDays 天（默认 20）才进列表；
 *   已逾期（remainDays 为负）**照常进**，越逾期越该催。
 *
 * 【为什么放在读侧，而不是同步侧】
 *   同步只在财务单发生写操作时触发一次，「某笔单哪天进入 20 天窗口」没有任何事件，
 *   本仓库也没有定时任务 —— 只有读侧过滤才能做到「今天进窗口，今天的列表立刻就有」。
 *
 * 【到期日为空的单不进列表】上游咨询建单没传 expireDate（落 NULL），
 *   没有到期日就无法判断「还差几天」，按用户口径不作为催费对象。
 *   这类单仍留在 t_class_fee 里（财务追溯、学生详情缴费情况要用），
 *   只是不出现在催费列表 / 导出结果里。
 */
function withinUrgeWindow(row: { remainDays: number | null }, windowDays: number): boolean {
  return row.remainDays !== null && row.remainDays <= windowDays;
}

/**
 * 批量取学生的**档案信息**：`studentId → { 学号/姓名/班级/部门/电话 }`
 *
 * ⚠️ 两条纪律：
 *   ① 一次 IN 查询就够（不要左连 —— `t_class_fee` 与 `t_class_student` 同名列
 *      一大把：student_no / student_name / class_id / class_name / dept_code /
 *      is_deleted…，左连后不加表前缀会直接 ambiguous column）；
 *   ② 按 500 分片：导出场景可能一次上千个 studentId，一条超长 IN 会撞
 *      max_allowed_packet 报错。去重 + 剔空值同样不能省。
 *
 * ★ 2026-10-20 扩展：原来只取 phone / parent_phone（列表补联系方式），
 *   现在**顺带把学号、姓名、班级、部门一起取回来**，用于覆盖单据上的快照列。
 *   用户口径「学生档案有的字段按学生档案的数据走」—— 学生换班后，
 *   缴费单上显示的班级必须是档案里的新班级，而不是开单那天的老班级。
 *   `t_class_fee` 自己那份 class_name 仍留在库里做财务追溯，只是不再拿来显示。
 *
 * ⚠️ 加 `is_deleted = 0`：档案里已删除的学生不再算作有效档案
 *   （「学生档案没有的，其他模块也不能有」）。这类单据的姓名/班级
 *   会保留开单快照，不会突然变成空白。
 */
async function fetchStudentContacts(studentIds: Array<string | null | undefined>) {
  const map: Record<
    string,
    {
      studentNo: string | null;
      studentName: string | null;
      classId: string | null;
      className: string | null;
      deptCode: number | null;
      phone: string | null;
      parentPhone: string | null;
    }
  > = {};
  const ids = [...new Set(studentIds.filter((x): x is string => !!x))];
  for (let i = 0; i < ids.length; i += 500) {
    const rows = await db(STUDENT_TABLE)
      .where('is_deleted', false)
      .whereIn('id', ids.slice(i, i + 500))
      .select('id', 'phone', 'parent_phone', 'student_no', 'student_name', 'class_id', 'class_name', 'dept_code');
    for (const r of rows as any[]) {
      map[r.id] = {
        studentNo: r.student_no || null,
        studentName: r.student_name || null,
        classId: r.class_id || null,
        className: r.class_name || null,
        deptCode: r.dept_code == null ? null : Number(r.dept_code),
        phone: r.phone || null,
        parentPhone: r.parent_phone || null,
      };
    }
  }
  return map;
}

/**
 * ★ 2026-10-20：把档案值合并进列表行（档案有值才覆盖，档案空则保留开单快照）
 *
 * 「按档案走」不等于「档案空就清空」：实训/历史数据里学生档案可能缺列，
 * 这时把单据上原有的信息保留下来，比显示成「—」有用。
 */
function mergeArchive<T extends Record<string, any>>(
  list: T[],
  archive: Awaited<ReturnType<typeof fetchStudentContacts>>,
): T[] {
  return list.map((x) => {
    const s = archive[x.studentId];
    if (!s) return x;
    return {
      ...x,
      studentNo: s.studentNo || x.studentNo,
      studentName: s.studentName || x.studentName,
      classId: s.classId ?? x.classId,
      className: s.className ?? x.className,
      deptCode: s.deptCode ?? x.deptCode,
      // 联系方式本来就只有档案有，档案没有就是 null（前端显示「—」）
      phone: s.phone,
      parentPhone: s.parentPhone,
    };
  });
}

/**
 * ★ 2026-10-20：取「档案当前在该班」的学生 id
 *
 * 用途：班级筛选要「单据快照 + 档案现状」两边命中。
 * 列表显示的班级已经改成档案最新值，如果筛选还只看单据上的 class_id，
 * 学生换班后会出现「列表显示 B 班、按 B 班筛却一条都出不来」。
 */
async function studentIdsInClass(classId: string): Promise<string[]> {
  const rows = (await db(STUDENT_TABLE)
    .where({ is_deleted: false, class_id: classId })
    .select('id')) as any[];
  return [...new Set(rows.map((r) => String(r.id || '')).filter(Boolean))];
}

/** ★ 2026-10-20：按档案的姓名/学号搜人（改名后按新名字也能搜到老单据） */
async function studentIdsByKeyword(keyword: string): Promise<string[]> {
  const rows = (await db(STUDENT_TABLE)
    .where('is_deleted', false)
    .andWhere((b) => {
      b.where('student_name', 'like', `%${keyword}%`).orWhere('student_no', 'like', `%${keyword}%`);
    })
    .select('id')) as any[];
  return [...new Set(rows.map((r) => String(r.id || '')).filter(Boolean))];
}

/* ============================================================
 * 1. 催费列表
 *   GET /api/class/fee/list
 * ============================================================ */

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
  classId: z.string().optional(),
  feeType: z.coerce.number().int().optional(),
  payStatus: z.coerce.number().int().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  // ★ 2026-10-20：改用显式布尔解析（z.coerce.boolean 会把 "false" 当 true，
  //   前端把「仅看紧急」关掉后仍然只出紧急的）
  isUrgent: boolFlag.optional(),
  keyword: z.string().optional(),
});

feeRouter.get(
  '/list',
  checkPermission('class:fee:view'),
  validate(listSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as z.infer<typeof listSchema>;
    const remindDays = await getNumberSetting('feeRemindDays');
    // ★ 催费列表窗口天数（默认 20）：到期日距今 ≤ N 天才进列表
    const windowDays = await getNumberSetting('feeUrgeWindowDays');

    const query = db(FEE_TABLE).where('is_deleted', false);
    // ★ 2026-10-20：班级筛选同时认「单据快照」和「档案现状」（学生换班后仍能筛到）
    if (q.classId) {
      const inClass = await studentIdsInClass(q.classId);
      query.andWhere((qb) => {
        qb.where('class_id', q.classId);
        if (inClass.length) qb.orWhereIn('student_id', inClass);
      });
    }
    if (q.feeType) query.andWhere('fee_type', q.feeType);
    // ⚠️ 缴费状态**不能按库里的 pay_status 在 SQL 里筛**：
    //    逾期是按到期日派生的（见 effectivePayStatus），库里可能还写着「待缴」。
    //    若在这里 where pay_status=4 → 一条都查不到；where pay_status=1 → 又会把
    //    显示成「逾期」的行带出来。所以统一等映射完按「展示状态」筛。
    if (q.startDate) query.andWhere('expire_date', '>=', q.startDate);
    if (q.endDate) query.andWhere('expire_date', '<=', q.endDate);
    if (q.keyword) {
      const hit = await studentIdsByKeyword(q.keyword);
      query.andWhere((qb) => {
        qb.where('student_no', 'like', `%${q.keyword}%`).orWhere('student_name', 'like', `%${q.keyword}%`);
        if (hit.length) qb.orWhereIn('student_id', hit);
      });
    }

    // isUrgent 为派生值，先取全量（当前筛选）再内存过滤分页
    const allRows = await query.clone().select('*').orderBy('expire_date', 'asc');
    // ★ 窗口过滤：只留到期日在 N 天内（含逾期）的单；到期日为空的单不进列表
    let list = allRows
      .map((r: any) => toFee(r, remindDays))
      .filter((x: any) => withinUrgeWindow(x, windowDays));
    // ★ 缴费状态按派生后的状态筛（逾期 = 待缴 + 已过到期日，见 effectivePayStatus）
    if (q.payStatus) list = list.filter((x) => x.payStatus === q.payStatus);
    if (q.isUrgent !== undefined) list = list.filter((x) => x.isUrgent === q.isUrgent);

    const total = list.length;
    const paged = list.slice((q.page - 1) * q.size, q.page * q.size);

    // ★ 催费次数（2026-10-19 用户要求）：按学生聚合催费记录条数（notify 按学生维度催缴，
    //    只查本页行，一次 groupBy，代价可忽略）
    const stuIds = [...new Set(paged.map((x: any) => x.studentId))].filter(Boolean);
    let urgeCountMap: Record<string, number> = {};
    if (stuIds.length) {
      const counts = await db(NOTIFY_TABLE)
        .where('is_deleted', false)
        .whereIn('student_id', stuIds)
        .groupBy('student_id')
        .select('student_id', db.raw('count(*) as urge_count'));
      urgeCountMap = Object.fromEntries(counts.map((c: any) => [c.student_id, Number(c.urge_count)]));
    }
    const withCount = paged.map((x: any) => ({ ...x, urgeCount: urgeCountMap[x.studentId] || 0 }));

    // ★ 档案信息（2026-10-20）：缴费表不自带手机号，且姓名/班级是开单快照 ——
    //   按本页学生批量取档案，一次性把联系方式和学生属性都对齐到档案最新值
    const contacts = await fetchStudentContacts(withCount.map((x: any) => x.studentId));
    const withContact = mergeArchive(withCount, contacts);

    // 顺带把窗口天数带回前端：列表为什么比台账少，界面上要说得清楚
    res.json({ ...page(withContact, total, q), urgeWindowDays: windowDays });
  }),
);

/* ============================================================
 * 2. 催费导出
 *   GET /api/class/fee/export
 * ============================================================ */

feeRouter.get(
  '/export',
  checkPermission('class:fee:export'),
  validate(listSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as z.infer<typeof listSchema>;
    const remindDays = await getNumberSetting('feeRemindDays');
    // ★ 导出与列表同一窗口口径（少了一行会被当成 bug）
    const windowDays = await getNumberSetting('feeUrgeWindowDays');

    const query = db(FEE_TABLE).where('is_deleted', false);
    // ★ 2026-10-20：筛选口径与列表完全一致（班级/关键字都认档案现状）
    if (q.classId) {
      const inClass = await studentIdsInClass(q.classId);
      query.andWhere((qb) => {
        qb.where('class_id', q.classId);
        if (inClass.length) qb.orWhereIn('student_id', inClass);
      });
    }
    if (q.feeType) query.andWhere('fee_type', q.feeType);
    // ⚠️ 缴费状态与列表同口径：导出也按派生后的状态筛（SQL 层不筛 pay_status，原因见 /list）
    // ★ 2026-10-20：导出补应缴日期筛选 —— 列表筛完导出却是全量，用户会以为筛选没生效
    if (q.startDate) query.andWhere('expire_date', '>=', q.startDate);
    if (q.endDate) query.andWhere('expire_date', '<=', q.endDate);
    if (q.keyword) {
      const hit = await studentIdsByKeyword(q.keyword);
      query.andWhere((qb) => {
        qb.where('student_no', 'like', `%${q.keyword}%`).orWhere('student_name', 'like', `%${q.keyword}%`);
        if (hit.length) qb.orWhereIn('student_id', hit);
      });
    }

    const rows = await query.clone().select('*').orderBy('expire_date', 'asc');
    // ★ 窗口过滤与列表同口径；到期日为空的单同样不进
    let list = rows
      .map((r: any) => toFee(r, remindDays))
      .filter((x: any) => withinUrgeWindow(x, windowDays));
    // ★ 导出与列表同一缴费状态口径（逾期按到期日派生）
    if (q.payStatus) list = list.filter((x) => x.payStatus === q.payStatus);
    if (q.isUrgent !== undefined) list = list.filter((x) => x.isUrgent === q.isUrgent);

    // ★ 档案信息（2026-10-20）：导出与列表同口径，按 500 分片批量取档案
    const contacts = await fetchStudentContacts(list.map((x: any) => x.studentId));
    const withContact = mergeArchive(list, contacts);

    res.json(ok(withContact));
  }),
);

/* ============================================================
 * 2.5 登记缴费（上传缴费凭证）
 *   POST /api/class-jh/fee/voucher
 *
 * ★ 2026-10-20 用户要求：操作列恢复，里面放「上传缴费凭证」，
 *   表单五项：缴费方式（微信支付/支付宝/现金）、缴费金额、缴费时间（默认当天、不能选未来）、
 *   备注、缴费截图（从本地选图片）。
 *
 * 【怎么存】沿用咨询/财务已有的做法：前端把图片读成 base64 传过来，
 *   后端解码落盘到 `uploads/voucher/`，返回相对地址 `/uploads/voucher/xxx.jpg`。
 *   `<img src>` 带不上 Authorization 头，所以凭证必须走静态托管（app.ts 已挂 /uploads）。
 *
 * 【写两处，别只写副本】
 *   · `t_class_fee`（初高台账，页面读的是它）：凭证 / 方式 / 实缴金额 / 缴费日期 / 备注
 *   · `sms_finance.t_finance_fee`（财务权威源）：只反写 voucher_url / pay_date / remark
 *   只写副本的话，财务下次把这张单再推一遍会把 voucher_url 覆盖回去，用户登记的凭证就"消失"了。
 *   财务那张单能不能找到，靠 `source_system='finance'` + `source_id` 判断；
 *   演示数据是 `source_system='local'`（没有财务单），就只写副本，不算失败。
 *   ⚠️ 财务侧 pay_status 不在这里流转（那是财务核对流程的事，财务侧还有"凭证唯一性""已核对不许改"等规则），
 *     本接口只负责把凭证和信息登记进去。
 *
 * 【状态怎么变】
 *   登记了「金额 + 时间 + 截图」就等于报缴了 → 未结清（待缴 1 / 逾期 4）推进成「已缴(2)」，
 *   已核对的单不动（3 已核对 / 2 已缴保持原状，只更新凭证与实缴信息）。
 *   这样列表里的「逾期 / 紧急」会随登记消失，符合"这笔钱已经收到了"的业务事实。
 * ============================================================ */

const paymentSchema = z.object({
  feeId: z.string().min(1, '缴费单必填'),
  /** 缴费方式 1微信支付 2支付宝 3现金 */
  payMethod: z.coerce.number().int().min(1).max(3, '缴费方式只能是 微信支付 / 支付宝 / 现金'),
  /** 实缴金额（分）。允许与应缴金额不同（部分缴），但必须为正数 */
  paidAmount: z.coerce.number().int().positive('缴费金额必须大于 0'),
  /** 缴费时间 YYYY-MM-DD（默认当天；不能晚于今天，由后端再兜一次） */
  payDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '缴费时间格式应为 YYYY-MM-DD'),
  /** 备注（转账单号 / 说明） */
  remark: z.string().max(200, '备注最多 200 字').optional(),
  /**
   * 缴费截图，形如 data:image/png;base64,xxxx
   *
   * ★ 2026-10-20 用户要求：**现金**可以不传截图（微信/支付宝必须传，钱是从账上走的）。
   *   所以这里不设 min(1)，"必填与否"在下面按 payMethod 判（schema 层写死会一刀切）。
   */
  dataUrl: z.string().optional(),
});

/** 凭证图片体积上限（5MB，与咨询/财务一致） */
const VOUCHER_MAX_BYTES = 5 * 1024 * 1024;

/** YYYY-MM-DD（本地时区），用于"不能选未来"的判断 */
function todayStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

feeRouter.post(
  '/voucher',
  checkPermission('class:fee:add'),
  validate(paymentSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof paymentSchema>;
    const operator = req.user;

    /* ---- 1. 缴费时间不能是未来（前端已禁选，这里再兜一层：接口可能被直接调） ---- */
    if (body.payDate > todayStr()) {
      throw new BizError(BizCode.PARAM_ERROR, '缴费时间不能晚于今天');
    }

    /* ---- 2. 准备落盘 ---- */
    const row = await db(FEE_TABLE).where({ id: body.feeId, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.FEE_NOT_FOUND, '缴费单不存在或已被删除');

    /* ---- 3. 截图：现金不强制，微信/支付宝必须有 ---- */
    let voucherUrl: string | null = null;
    let fileName = '';
    if (body.dataUrl) {
      const matched = /^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/i.exec(body.dataUrl);
      if (!matched) {
        throw new BizError(BizCode.FORMAT_ERROR, '缴费截图只支持 PNG / JPG / WEBP / GIF 图片');
      }
      const ext = matched[1].toLowerCase().replace('jpeg', 'jpg');
      const buffer = Buffer.from(matched[2], 'base64');
      if (!buffer.length) throw new BizError(BizCode.PARAM_ERROR, '图片内容为空，请重新选择');
      if (buffer.length > VOUCHER_MAX_BYTES) {
        throw new BizError(BizCode.PARAM_ERROR, '图片不能超过 5MB，请压缩后重试');
      }
      fileName = `jh_fee_${Date.now()}_${randomUUID().slice(0, 8)}.${ext}`;
      const uploadDir = path.resolve(process.cwd(), 'uploads/voucher');
      fs.mkdirSync(uploadDir, { recursive: true });
      fs.writeFileSync(path.join(uploadDir, fileName), buffer);
      voucherUrl = `/uploads/voucher/${fileName}`;
    } else if (body.payMethod !== PayMethod.CASH) {
      // 现金是线下交付、没有转账凭证可拍，所以只有现金允许不传
      throw new BizError(BizCode.PARAM_ERROR, '请上传缴费截图（微信支付 / 支付宝需要凭证，现金可不传）');
    }

    /* ---- 3. 写初高台账（含状态推进） ---- */
    const before = {
      payStatus: row.pay_status,
      payDate: row.pay_date ?? null,
      voucherUrl: row.voucher_url ?? null,
      payMethod: row.pay_method ?? null,
      paidAmount: row.paid_amount ?? null,
    };
    // 未结清（待缴/逾期）→ 已缴；已缴/已核对保持（只补凭证与实缴信息）
    const rawStatus = Number(row.pay_status ?? 1);
    const nextStatus = rawStatus === PayStatus.UNPAID || rawStatus === PayStatus.OVERDUE
      ? PayStatus.PAID
      : rawStatus;

    const updateFields: Record<string, any> = {
      pay_method: body.payMethod,
      paid_amount: body.paidAmount,
      pay_date: body.payDate,
      pay_remark: body.remark ?? null,
      pay_status: nextStatus,
      update_time: new Date(),
      update_by: operator?.userId ?? null,
    };
    // 现金且没传截图：保留原来的凭证，不要把它清空
    if (voucherUrl) updateFields.voucher_url = voucherUrl;
    await db(FEE_TABLE).where({ id: row.id }).update(updateFields);

    /* ---- 4. 财务侧反写（best-effort）：只写凭证/日期/备注，状态交给财务核对流程 ---- */
    let financeSynced = false;
    if (row.source_system === 'finance' && row.source_id) {
      try {
        const finFields: Record<string, any> = {
          pay_date: body.payDate,
          remark: body.remark ?? null,
        };
        if (voucherUrl) finFields.voucher_url = voucherUrl;
        const affected = await db('sms_finance.t_finance_fee')
          .where({ id: String(row.source_id), is_deleted: false })
          .update(finFields);
        financeSynced = Number(affected) > 0;
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[fee-payment] 反写财务缴费单失败（不影响本次登记）：', (e as Error).message);
      }
    }

    /* ---- 5. 留痕 ---- */
    await writeOpLog({
      module: 'fee',
      bizType: '登记缴费',
      bizId: row.id,
      studentId: row.student_id,
      classId: row.class_id,
      opUserId: operator?.userId,
      opUserName: operator?.userName,
      opDesc: `登记缴费：${nameOf(PAY_METHOD_NAME, body.payMethod)} ${(body.paidAmount / 100).toFixed(2)} 元${fileName ? `（${fileName}）` : '（现金·无截图）'}`,
      beforeValue: before,
      afterValue: {
        payStatus: nextStatus,
        payDate: body.payDate,
        voucherUrl,
        payMethod: body.payMethod,
        paidAmount: body.paidAmount,
      },
    });

    res.json(
      ok(
        { feeId: row.id, voucherUrl: voucherUrl ?? row.voucher_url ?? null, payStatus: nextStatus, financeSynced },
        '缴费登记成功',
      ),
    );
  }),
);

/* ============================================================
 * 2.6 批量转交财务（★ 2026-10-20 用户要求：整页一个「批量上传到财务缴费管理」）
 *   GET  /api/class-jh/fee/transfer/candidates   候选列表（已登记缴费的初高单）
 *   POST /api/class-jh/fee/transfer              把选中的单据转交财务
 *
 * 【“转交”到底做了什么】
 *   在财务 `sms_finance.t_finance_fee` 里**生成对应的缴费单**（带凭证 / 实缴金额 / 缴费日期 / 备注），
 *   财务在「缴费管理」里就能看到并核对 —— 这也是"把凭证信息转交给财务"的落地方式。
 *   走的是财务自己的 `addFee()`，凭证唯一性、状态与凭证一致性等规则都照财务的口径执行，
 *   不在本模块重新实现一遍（重复写规则 = 迟早对不上）。
 *
 * 【转交成功后】
 *   回写 `t_class_fee.source_system='finance' + source_id=财务单id`：
 *   · 这张单从此有财务对应单，`transferred=true`；
 *   · 再转交会被"已转交过财务"跳过，不会重复建单；
 *   · 以后财务改这张单，syncFeeToJh 按 (source_system, source_id) 合并回同一行，不会多出一条。
 *
 * 【一条失败不影响其他】逐条 try/catch，最后返回 成功 / 跳过 / 失败 三份明细。
 * ============================================================ */

feeRouter.get(
  '/transfer/candidates',
  checkPermission('class:fee:view'),
  wrap(async (_req, res) => {
    const remindDays = await getNumberSetting('feeRemindDays');
    // 候选 = 已登记缴费（有方式或实缴金额）的初高单；已转交的也返回，前端用 transferred 区分
    const rows = await db(FEE_TABLE)
      .where('is_deleted', false)
      .andWhere((qb) => {
        qb.whereNotNull('pay_method').orWhereNotNull('paid_amount');
      })
      .orderBy('pay_date', 'desc')
      .orderBy('expire_date', 'desc')
      .limit(500)
      .select('*');
    res.json(ok(rows.map((r: any) => toFee(r, remindDays))));
  }),
);

const transferSchema = z.object({
  feeIds: z
    .array(z.string().min(1))
    .min(1, '请先勾选要转交的记录')
    .max(200, '一次最多转交 200 条'),
});

feeRouter.post(
  '/transfer',
  checkPermission('class:fee:add'),
  validate(transferSchema),
  wrap(async (req, res) => {
    const { feeIds } = (req as any).validated as z.infer<typeof transferSchema>;
    const operator = { userId: req.user?.userId ?? '', userName: req.user?.userName ?? '' };
    const uniq = [...new Set(feeIds)];

    const rows = await db(FEE_TABLE).whereIn('id', uniq).where('is_deleted', false).select('*');
    const byId = new Map(rows.map((r: any) => [r.id, r]));

    const skipped: Array<{ feeId: string; reason: string }> = [];
    const failed: Array<{ feeId: string; reason: string }> = [];
    let success = 0;

    for (const id of uniq) {
      const row: any = byId.get(id);
      if (!row) {
        skipped.push({ feeId: id, reason: '缴费单不存在' });
        continue;
      }
      if (Number(row.dept_code ?? 1) !== 1) {
        skipped.push({ feeId: id, reason: '只有初高的缴费单能转交财务' });
        continue;
      }
      if (row.pay_method == null && row.paid_amount == null) {
        skipped.push({ feeId: id, reason: '还没登记缴费，没有凭证可转交' });
        continue;
      }
      if (row.source_system === 'finance' && row.source_id) {
        skipped.push({ feeId: id, reason: '已转交过财务' });
        continue;
      }

      try {
        /* 缴费方式在财务表里没有列（t_finance_fee 无 pay_method），
           所以把「方式·备注」一起写进财务的 remark，财务核对时看得到怎么收的钱 */
        const remarkParts = [
          row.pay_method ? nameOf(PAY_METHOD_NAME, row.pay_method) : '',
          row.pay_remark || '',
        ].filter(Boolean);
        const remark = `${remarkParts.join('·')}${row.voucher_url ? '' : '（现金收取，无凭证）'}`;

        const financeFeeId = await financeAddFee(
          {
            studentId: row.student_id,
            studentNo: row.student_no,
            studentName: row.student_name,
            classId: row.class_id ?? undefined,
            className: row.class_name ?? undefined,
            deptCode: 1,
            feeType: Number(row.fee_type),
            // 转交的是「实收金额」：没填实缴时退回应缴
            amount: Number(row.paid_amount ?? row.fee_amount ?? 0),
            payStatus: PayStatus.PAID, // 已收款，等财务核对
            payDate: row.pay_date ? String(row.pay_date).slice(0, 10) : undefined,
            expireDate: row.expire_date ? String(row.expire_date).slice(0, 10) : undefined,
            period: row.period ?? undefined,
            voucherUrl: row.voucher_url || undefined,
            remark: remark || undefined,
          },
          operator,
        );

        await db(FEE_TABLE).where({ id }).update({
          source_system: 'finance',
          source_id: financeFeeId,
          update_time: new Date(),
          update_by: operator.userId || null,
        });
        success += 1;
      } catch (e) {
        failed.push({ feeId: id, reason: (e as Error)?.message || '转交失败' });
      }
    }

    await writeOpLog({
      module: 'fee',
      bizType: '转交财务',
      opUserId: operator.userId || undefined,
      opUserName: operator.userName || undefined,
      opDesc: `批量转交财务：提交 ${uniq.length} 条，成功 ${success}，跳过 ${skipped.length}，失败 ${failed.length}`,
      afterValue: { success, skipped: skipped.length, failed: failed.length },
    });

    res.json(
      ok(
        { total: uniq.length, success, skipped, failed },
        `转交完成：成功 ${success} 条${skipped.length ? `，跳过 ${skipped.length} 条` : ''}${failed.length ? `，失败 ${failed.length} 条` : ''}`,
      ),
    );
  }),
);

/* ============================================================
 * 3. 催费推送（按 短信 / 微信 触达，生成发送内容）
 *   POST /api/class/fee/share
 * ============================================================ */

const shareSchema = z.object({
  studentId: z.string().min(1, '学生必填'),
  feeType: z.coerce.number().int().min(1).max(5, '缴费类型不正确'),
  // ★ 2026-10-20 用户要求：触达渠道只留 短信 / 微信（站内消息下线），
  //   与前端下拉共用 SHARE_CHANNEL_PUSH_CODES 一份口径，避免「界面不给选、接口照样收」
  shareChannel: z.coerce
    .number()
    .int()
    .refine((v) => SHARE_CHANNEL_PUSH_CODES.includes(v), '触达渠道仅支持短信或微信'),
  // ★ 2026-10-20：「备注」改叫「发送内容」，就是实际发给家长的那段话
  sendContent: z.string().max(500).optional(),
});

feeRouter.post(
  '/share',
  checkPermission('class:fee:add'),
  validate(shareSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof shareSchema>;

    const stu = await db(STUDENT_TABLE).where({ id: body.studentId, is_deleted: false }).first();
    if (!stu) throw new BizError(BizCode.STUDENT_NOT_FOUND, '学生不存在');

    // 取最近一笔该类型缴费快照
    const fee = await db(FEE_TABLE)
      .where({ student_id: stu.id, fee_type: body.feeType, is_deleted: false })
      .orderBy('expire_date', 'desc')
      .first();

    const feeAmount = fee?.fee_amount ?? null;
    const expireDate = fee?.expire_date ?? null;
    const amountYuan = feeAmount === null ? '—' : (feeAmount / 100).toFixed(2);

    // 生成发送内容：系统自动文案 + 用户填的「发送内容」（有则附在后面，不再带「备注：」前缀）
    const sendContent = (body.sendContent ?? '').trim();
    const shareText =
      `【缴费提醒】${stu.student_name} 同学（学号 ${stu.student_no}）：` +
      `您的「${nameOf(FEE_TYPE_NAME, body.feeType)}」${feeAmount === null ? '' : `应缴 ${amountYuan} 元`}` +
      `${expireDate ? `，到期日 ${String(expireDate).slice(0, 10)}` : ''}，请尽快完成缴费。` +
      `${sendContent ? `\n${sendContent}` : ''}`;

    const notifyId = randomUUID();
    const now = new Date();
    await db(NOTIFY_TABLE).insert({
      id: notifyId,
      student_id: stu.id,
      student_no: stu.student_no,
      student_name: stu.student_name,
      class_id: stu.class_id ?? null,
      class_name: stu.class_name ?? null,
      fee_type: body.feeType,
      fee_amount: feeAmount,
      expire_date: expireDate,
      share_channel: body.shareChannel,
      notify_user_id: req.user?.userId ?? null,
      notify_user_name: req.user?.userName ?? null,
      notify_time: now,
      // 表列名沿用 remark（不动库结构），存的就是「发送内容」
      remark: sendContent || null,
      is_deleted: false,
      create_time: now,
      create_by: req.user?.userId || 'system',
    });

    res.json(ok({ notifyId, shareText, shareChannelName: nameOf(SHARE_CHANNEL_NAME, body.shareChannel) }, '推送成功'));
  }),
);

/* ============================================================
 * 4. 催费记录列表
 *   GET /api/class/fee/notify/list
 * ============================================================ */

const notifyListSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
  studentId: z.string().optional(),
});

feeRouter.get(
  '/notify/list',
  checkPermission('class:fee:view'),
  validate(notifyListSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as z.infer<typeof notifyListSchema>;
    const query = db(NOTIFY_TABLE).where('is_deleted', false);
    if (q.studentId) query.andWhere('student_id', q.studentId);

    const [{ total }] = await query.clone().count({ total: '*' });
    const rows = await query
      .clone()
      .select('*')
      .orderBy('notify_time', 'desc')
      .limit(q.size)
      .offset((q.page - 1) * q.size);

    const list = rows.map((n: any) => ({
      notifyId: n.id,
      studentId: n.student_id,
      studentNo: n.student_no,
      studentName: n.student_name,
      classId: n.class_id,
      className: n.class_name,
      feeType: n.fee_type,
      feeTypeName: nameOf(FEE_TYPE_NAME, n.fee_type),
      feeAmount: n.fee_amount,
      expireDate: n.expire_date,
      shareChannel: n.share_channel,
      shareChannelName: nameOf(SHARE_CHANNEL_NAME, n.share_channel),
      notifyUserId: n.notify_user_id,
      notifyUserName: n.notify_user_name,
      notifyTime: n.notify_time,
      remark: n.remark,
    }));

    // ★ 2026-10-20：催费记录上的姓名/班级是**推送当时的快照**，
    //   这里按档案最新值覆盖，和列表、导出口径一致（学生换班后不会显示老班级）
    const archive = await fetchStudentContacts(list.map((x: any) => x.studentId));

    res.json(page(mergeArchive(list, archive), Number(total), q));
  }),
);

export default feeRouter;
