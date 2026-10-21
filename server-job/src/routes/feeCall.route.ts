/**
 * 催费管理 路由（就业管理 > 实训阶段）
 *
 * 接口前缀：/api/job/fee-call
 * 表：t_job_fee_call
 * 字段依据：斌哥 2026-09-30 拍板
 *
 * ============================================================
 * 【业务规则（斌哥 2026-09-30 拍板）】
 * ============================================================
 *   1. 发起人 = 教务老师（ROLE_EDU_ADMIN）
 *   2. 类别   = 住宿费 / 保险费 / 餐费（★ 没有学费）
 *   3. 发起后【发站内信】推给该学生的班主任
 *   4. 班主任【只看自己的班】
 *   5. 班主任催完 → 标记「已催缴」→ 学生交了就标「已缴清」
 *
 * ============================================================
 * 【⚠️ 这个模块不收款】
 * ============================================================
 *   它只是"催办工单"——教务发起、班主任去催、标记结果。
 *   真正的收费/账目在财务模块（8005），本模块不碰钱。
 *
 * ⚠️ 铁律：逻辑删除，禁物理删除。
 * ⚠️ 铁律：金额一律存「分」（整数）。
 * ⚠️ 铁律：枚举双返回（feeType + feeTypeName）。
 */

import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import {
  BizCode,
  FeeCallCategory,
  FEE_CALL_CATEGORY_NAME,
  FeeCallStatus,
  FEE_CALL_STATUS_NAME,
  DEPT_NAME,
  RoleCode,
  StudentStatus,
  ClassStatus,
  hasRole,
} from 'shared-types';
import { ok, page } from '../utils/response';
import { db } from '../utils/db';
import { wrap } from '../utils/wrap';
import { today, fmtDate, fmtDateTime } from '../utils/date';
import { validate } from '../middleware/validate';
import { boolFlag } from '../utils/query';
import { BizError } from '../middleware/errorHandler';
import { sendNotice, NOTICE_TYPE } from '../utils/notice';
// ★ 阶段隔离（班主任只看大学 / 项目经理只看实训）
import { applyTrainingScope, myTrainingClassIds, operatorOf } from '../utils/stageScope';
// ★ 信息流转：催费单新增/处理 → 推送班级管理模块（只读副本）
import { syncFeeCallToClass } from '../services/urge-sync.service';
import { checkPayDate, saveVoucherImage, PAY_METHOD, PAY_METHOD_NAME } from '../utils/feeVoucher';

export const feeCallRouter = Router();

/** 表名常量 */
const TABLE = 't_job_fee_call';
const STUDENT_TABLE = 't_student_base';
const CLASS_TABLE = 't_job_class';

/** 可发起催费的学生状态（在校生都行）*/
const ALLOW_STATUS: number[] = [
  StudentStatus.TRIAL,
  StudentStatus.PRE_STUDY,
  StudentStatus.STUDYING,
  StudentStatus.TRAINING,
];

/** 合法费用类别（只有这三类）*/
const VALID_FEE_TYPES: number[] = [
  FeeCallCategory.ACCOMMODATION, // 住宿费 2
  FeeCallCategory.INSURANCE,     // 保险费 4
  FeeCallCategory.MEAL,          // 餐费 3
];

/* ============================================================
 * 内部工具
 * ============================================================ */

function getOperator(req: any) {
  const u = req.user || {};
  return {
    userId: u.userId || u.id || '',
    userName: u.userName || u.name || '',
    roles: u.roles || [],
  };
}

/** 分 → 元字符串（如 120000 → "1,200.00"）*/
function fenToYuanText(fen: number | null | undefined): string | null {
  if (fen === null || fen === undefined) return null;
  const yuan = (Number(fen) / 100).toFixed(2);
  const [int, dec] = yuan.split('.');
  const withComma = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${withComma}.${dec}`;
}

/** 是否已逾期 */
function isOverdue(dueDate: any, callStatus: number): boolean {
  if (!dueDate) return false;
  // 已缴清不算逾期
  if (callStatus === FeeCallStatus.PAID) return false;
  const due = fmtDate(dueDate);
  return !!due && due < today();
}

/** 催费单行 → 输出结构 */
function decorate(row: any, operator: { userId: string; roles: string[] }): any {
  // 班主任本人（或管理员）可以处理
  const isHeadTeacher = row.head_teacher_id === operator.userId;
  const isAdmin = operator.roles.includes(RoleCode.SYS_ADMIN);
  const notFinished = row.call_status !== FeeCallStatus.PAID;
  const canHandle = notFinished && (isHeadTeacher || isAdmin);

  return {
    id: row.id,
    feeType: row.fee_type,
    feeTypeName: FEE_CALL_CATEGORY_NAME[row.fee_type] || '',

    studentId: row.student_id,
    studentNo: row.student_no || null,
    studentName: row.student_name || null,
    phone: row.phone || null,
    parentPhone: row.parent_phone || null,

    classId: row.class_id || null,
    className: row.class_name || null,
    deptCode: row.dept_code ?? null,
    deptName: row.dept_code ? DEPT_NAME[row.dept_code] || null : null,
    headTeacherId: row.head_teacher_id || null,
    headTeacherName: row.head_teacher_name || null,

    feeAmount: row.fee_amount ?? null,
    feeAmountText: fenToYuanText(row.fee_amount),
    dueDate: fmtDate(row.due_date),
    overdue: isOverdue(row.due_date, row.call_status),
    callReason: row.call_reason || null,

    callStatus: row.call_status,
    callStatusName: FEE_CALL_STATUS_NAME[row.call_status] || '',
    handleTime: fmtDateTime(row.handle_time),
    handleRemark: row.handle_remark || null,

    /* ★ 2026-10-21：登记缴费五列（与初高 t_class_fee 同口径）——
       催费页里就业的行也要能显示 实缴金额 / 缴费方式 / 缴费日期 / 凭证 */
    payMethod: row.pay_method ?? null,
    payMethodName: row.pay_method != null ? PAY_METHOD_NAME[Number(row.pay_method)] ?? '' : '',
    paidAmount: row.paid_amount ?? null,
    paidAmountText: row.paid_amount == null ? null : fenToYuanText(row.paid_amount),
    payDate: fmtDate(row.pay_date),
    voucherUrl: row.voucher_url || null,
    payRemark: row.pay_remark || null,

    applicantId: row.applicant_id || null,
    applicantName: row.applicant_name || null,

    remark: row.remark || null,
    createTime: fmtDateTime(row.create_time),
    canHandle,
  };
}

/* ============================================================
 * 1. 列表
 *    GET /api/job/fee-call/page
 * ============================================================ */

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(200).default(20),
  keyword: z.string().optional(),
  feeType: z.coerce.number().int().optional(),
  classId: z.string().optional(),
  /**
   * 催费单状态：1 待催缴 / 2 催缴中 / 3 已缴清
   *
   * ★ 2026-10-20：支持多值（逗号分隔，如 `1,2`）。
   *   催费页的「缴费状态」已统一成初高/大学那套（待缴/已缴/已核对/逾期/冻结），
   *   其中「待缴」= 待催缴 + 催缴中 两种催费单状态，单选传不进来。
   *   单值仍然照旧可用（`3` 就是只看已缴清），不影响就业模块自己的调用。
   */
  callStatus: z.union([z.coerce.number().int(), z.string()]).optional(),
  /**
   * 统一缴费状态（催费页用，与初高/大学同一套码：1待缴 2已缴 3已核对 4逾期 5冻结）
   *
   * ★ 2026-10-20：催费页「缴费状态」三部门统一后，就业侧不能再让前端自己折算
   *   （「待缴」还要排掉已过期的、「逾期」要按应缴日派生），这里按展示口径翻译成
   *   call_status + due_date 条件：
   *     1 待缴 → call_status 1,2 且未过应缴日
   *     2 已缴 → call_status 3（已缴清）
   *     4 逾期 → call_status 1,2 且已过应缴日
   *     3 已核对 / 5 冻结 → 就业没有这些状态 → 不出数据（不是忽略条件）
   */
  payStatus: z.coerce.number().int().optional(),
  onlyMine: z.coerce.boolean().optional(),
  // ★ 2026-10-20：「仅看紧急」对就业也要生效 ——
  //   就业行的 isUrgent 就是 overdue（逾期未缴清），这里按同一口径过滤。
  onlyOverdue: boolFlag.optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

feeCallRouter.get(
  '/page',
  validate(listSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated;
    const operator = getOperator(req);

    const base = db(TABLE).where('is_deleted', false);
    await applyTrainingScope(base, req, { table: TABLE });

    if (q.keyword) {
      base.andWhere((b: any) => {
        b.where('student_name', 'like', `%${q.keyword}%`)
          .orWhere('student_no', 'like', `%${q.keyword}%`);
      });
    }
    if (q.feeType !== undefined) base.andWhere('fee_type', q.feeType);
    if (q.classId) base.andWhere('class_id', q.classId);
    // 催费单状态：单值 / 逗号多值都支持（`1,2` = 待催缴 + 催缴中）
    if (q.callStatus !== undefined && q.callStatus !== '') {
      const arr = String(q.callStatus)
        .split(',')
        .map((s: string) => Number(s.trim()))
        .filter((n: number) => Number.isInteger(n) && n > 0);
      if (arr.length === 1) base.andWhere('call_status', arr[0]);
      else if (arr.length > 1) base.whereIn('call_status', arr);
    }
    if (q.startDate) base.andWhere('due_date', '>=', q.startDate);
    if (q.endDate) base.andWhere('due_date', '<=', q.endDate);
    // 统一缴费状态 → 催费单状态 + 应缴日（口径见 payStatus 注释）
    if (q.payStatus !== undefined) {
      const t = today();
      if (q.payStatus === 1) base.whereIn('call_status', [1, 2]).andWhere('due_date', '>=', t);
      else if (q.payStatus === 2) base.where('call_status', 3);
      else if (q.payStatus === 4) base.whereIn('call_status', [1, 2]).andWhere('due_date', '<', t);
      else base.whereRaw('1 = 0'); // 已核对 / 冻结：就业无此状态
    }
    // 仅看逾期（= 仅看紧急）：已缴清的不算逾期，与 decorate 的 overdue 同口径
    if (q.onlyOverdue) {
      base.whereNot('call_status', FeeCallStatus.PAID).andWhere('due_date', '<', today());
    }

    // ★ 班主任只看自己的班（数据范围）
    //   ★ 2026-10-08 修：补上项目经理 —— 原来只判班主任，
    //     但项目经理被 applyTrainingScope 放进了"不限"分支 → 能看到全校催费单。
    //     口径：项目经理只认自己带的实训班（与其它模块统一）。
    const isAdmin = hasRole(operator.roles, RoleCode.SYS_ADMIN);
    const isPM = hasRole(operator.roles, RoleCode.PROJECT_MANAGER);
    const isHeadTeacher = hasRole(operator.roles, RoleCode.TEACH_HEAD);
    const isEduAdmin = hasRole(operator.roles, RoleCode.ACAD_STAFF);

    if (!isAdmin && isPM && !isEduAdmin) {
      const myClasses = await db(CLASS_TABLE)
        .where({ project_manager_id: operator.userId, is_deleted: false })
        // [已停用] ★ 2026-10-08 斌哥拍板：项目经理可见自己带的【所有】实训班（含已结业）—— 去掉未结业限制
        // .whereNot('class_status', ClassStatus.GRADUATED)
        .select('id');
      const ids = myClasses.map((c: any) => c.id);
      if (ids.length === 0) base.whereRaw('1 = 0');
      else base.whereIn('class_id', ids);
    } else if (isHeadTeacher && !isAdmin && !isEduAdmin) {
      base.andWhere('head_teacher_id', operator.userId);
    } else if (q.onlyMine) {
      base.andWhere('head_teacher_id', operator.userId);
    }

    const [{ c: total }] = await base.clone().count({ c: '*' });
    const rows = await base
      .clone()
      .orderBy([{ column: 'call_status', order: 'asc' }, { column: 'due_date', order: 'asc' }])
      .limit(q.size)
      .offset((q.page - 1) * q.size);

    res.json(page(rows.map((r: any) => decorate(r, operator)), Number(total), q));
  }),
);

/* ============================================================
 * 2. 详情
 *    GET /api/job/fee-call/detail
 * ============================================================ */

feeCallRouter.get(
  '/detail',
  validate(z.object({ id: z.string().min(1, '催费单ID必传') })),
  wrap(async (req, res) => {
    const { id } = (req as any).validated;
    const operator = getOperator(req);

    const row = await db(TABLE).where({ id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.FEE_CALL_NOT_FOUND, '催费单不存在');

    const history = await db(TABLE)
      .where({ student_id: row.student_id, is_deleted: false })
      .whereNot('id', id)
      .orderBy('create_time', 'desc')
      .limit(20);

    res.json(
      ok({
        ...decorate(row, operator),
        history: history.map((h: any) => ({
          id: h.id,
          feeType: h.fee_type,
          feeTypeName: FEE_CALL_CATEGORY_NAME[h.fee_type] || '',
          dueDate: fmtDate(h.due_date),
          callStatus: h.call_status,
          callStatusName: FEE_CALL_STATUS_NAME[h.call_status] || '',
          createTime: fmtDateTime(h.create_time),
        })),
      }),
    );
  }),
);

/* ============================================================
 * 3. 可选学生（教务发起时选人）
 *    GET /api/job/fee-call/student-options
 * ============================================================ */

feeCallRouter.get(
  '/student-options',
  validate(
    z.object({
      keyword: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }),
  ),
  wrap(async (req, res) => {
    const q = (req as any).validated;

    const query = db(`${STUDENT_TABLE} as s`)
      .leftJoin(`${CLASS_TABLE} as c`, 's.class_id', 'c.id')
      .where('s.is_deleted', false)
      .whereIn('s.student_status', ALLOW_STATUS);

    if (q.keyword) {
      query.andWhere((x: any) => {
        x.where('s.student_name', 'like', `%${q.keyword}%`).orWhere('s.student_no', 'like', `%${q.keyword}%`);
      });
    }

    const rows = await query
      .select(
        's.id as student_id',
        's.student_no',
        's.student_name',
        's.phone',
        's.parent_phone',
        'c.class_name',
        'c.dept_code',
        'c.head_teacher_id',
        'c.head_teacher_name',
      )
      .orderBy('s.student_no', 'asc')
      .limit(q.limit);

    res.json(
      ok(
        rows.map((r: any) => ({
          studentId: r.student_id,
          studentNo: r.student_no,
          studentName: r.student_name,
          className: r.class_name || null,
          deptCode: r.dept_code ?? null,
          deptName: r.dept_code ? DEPT_NAME[r.dept_code] || null : null,
          headTeacherId: r.head_teacher_id || null,
          headTeacherName: r.head_teacher_name || null,
          phone: r.phone || null,
          parentPhone: r.parent_phone || null,
        })),
      ),
    );
  }),
);

/* ============================================================
 * 4. 新建催费单
 *    POST /api/job/fee-call/create
 *
 * ⚠️ 只有教务老师能发起（管理员也可）。
 * ★ 发起后自动发站内信给班主任。
 * ============================================================ */

const createSchema = z.object({
  feeType: z.coerce.number().int(),
  studentId: z.string().min(1, '学生必传'),
  feeAmount: z.coerce.number().int().min(0).optional().nullable(),
  dueDate: z.string().min(1, '到期时间必填'),
  callReason: z.string().max(500).optional().nullable(),
  remark: z.string().max(500).optional().nullable(),
});

feeCallRouter.post(
  '/create',
  validate(createSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated;
    const operator = getOperator(req);

    // ① 只有教务老师/管理员能发起
    const allowed =
      operator.roles.includes(RoleCode.ACAD_STAFF) || operator.roles.includes(RoleCode.SYS_ADMIN);
    if (!allowed) {
      throw new BizError(BizCode.NO_OPERATION_PERMISSION, '只有教务老师能发起催费');
    }

    // ② 类别必须是三类之一
    if (!VALID_FEE_TYPES.includes(body.feeType)) {
      throw new BizError(BizCode.PARAM_ERROR, '费用类别只能是住宿费/保险费/餐费');
    }

    // ③ 学生校验
    const stu = await db(STUDENT_TABLE).where({ id: body.studentId, is_deleted: false }).first();
    if (!stu) throw new BizError(BizCode.STUDENT_NOT_FOUND, '学生不存在');
    if (!ALLOW_STATUS.includes(stu.student_status)) {
      throw new BizError(BizCode.STUDENT_STATUS_NOT_ALLOW, '该学生当前状态不允许发起催费');
    }

    // ④ 到期日不能早于今天
    if (body.dueDate < today()) {
      throw new BizError(BizCode.FEE_DUE_DATE_INVALID, '到期时间不能早于今天');
    }

    // ⑤ 同类费用不能有未完成的重复催费
    const dup = await db(TABLE)
      .where({ student_id: stu.id, fee_type: body.feeType, is_deleted: false })
      .whereNot('call_status', FeeCallStatus.PAID)
      .first();
    if (dup) {
      throw new BizError(
        BizCode.FEE_CALL_DUPLICATE,
        `该学生已有同类未完成的催费单`,
      );
    }

    // ⑥ 班级信息
    let cls: any = null;
    if (stu.class_id) cls = await db(CLASS_TABLE).where({ id: stu.class_id, is_deleted: false }).first();

    const id = randomUUID();
    const now = new Date();

    await db.transaction(async (trx) => {
      await trx(TABLE).insert({
        id,
        create_time: now,
        create_by: operator.userId,
        is_deleted: false,

        fee_type: body.feeType,

        student_id: stu.id,
        student_no: stu.student_no || null,
        student_name: stu.student_name || null,
        phone: stu.phone || null,
        parent_phone: stu.parent_phone || null,

        class_id: cls?.id || stu.class_id || null,
        class_name: cls?.class_name || stu.class_name || null,
        dept_code: cls?.dept_code ?? stu.dept_code ?? null,
        head_teacher_id: cls?.head_teacher_id || stu.head_teacher_id || null,
        head_teacher_name: cls?.head_teacher_name || stu.head_teacher_name || null,

        fee_amount: body.feeAmount ?? null,
        due_date: body.dueDate,
        call_reason: body.callReason || null,
        remark: body.remark || null,

        call_status: FeeCallStatus.PENDING,
        applicant_id: operator.userId,
        applicant_name: operator.userName,
      });

      // ★ 发站内信给班主任
      const receiverId = cls?.head_teacher_id || stu.head_teacher_id;
      if (receiverId) {
        await sendNotice(
          {
            noticeType: NOTICE_TYPE.SYSTEM,
            title: `【催费】${stu.student_name || ''} 的${FEE_CALL_CATEGORY_NAME[body.feeType] || ''}需催缴`,
            content:
              `${stu.student_name || ''}（${stu.student_no || ''}）的` +
              `${FEE_CALL_CATEGORY_NAME[body.feeType] || ''}需催缴，到期时间 ${body.dueDate}。` +
              (body.callReason ? `说明：${body.callReason}` : ''),
            receiverId,
            receiverName: cls?.head_teacher_name || stu.head_teacher_name || '班主任',
            receiverRole: RoleCode.TEACH_HEAD,
            senderId: operator.userId,
            senderName: operator.userName,
            bizType: 'feeCall',
            bizId: id,
            classId: cls?.id || stu.class_id,
            className: cls?.class_name || stu.class_name,
            studentId: stu.id,
            studentName: stu.student_name,
          },
          trx,
        );
      }
    });

    // ★ 2026-10-05：教务点「发起催费」→ 推给班级管理（班级「催费管理」页读只读副本）
    //    非阻断：失败只记日志，不能让催费单本身建不出来
    await syncFeeCallToClass(id);

    res.json(ok({ id }));
  }),
);

/* ============================================================
 * 5. 处理（班主任催完了 / 学生交钱了）
 *    POST /api/job/fee-call/handle
 *
 * ⚠️ 只有该学生的班主任本人（或管理员）能处理。
 * ============================================================ */

feeCallRouter.post(
  '/handle',
  validate(
    z.object({
      id: z.string().min(1, '催费单ID必传'),
      callStatus: z.coerce.number().int().min(2).max(3),
      handleRemark: z.string().max(500).optional().nullable(),
    }),
  ),
  wrap(async (req, res) => {
    const body = (req as any).validated;
    const operator = getOperator(req);

    const row = await db(TABLE).where({ id: body.id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.FEE_CALL_NOT_FOUND, '催费单不存在');

    // ★ 权限：只能处理自己班的
    const isHeadTeacher = row.head_teacher_id === operator.userId;
    const isAdmin = operator.roles.includes(RoleCode.SYS_ADMIN);
    if (!isHeadTeacher && !isAdmin) {
      throw new BizError(BizCode.NO_OPERATION_PERMISSION, '只有该学生的班主任能处理此催费单');
    }

    if (row.call_status === FeeCallStatus.PAID) {
      throw new BizError(BizCode.FEE_CALL_STATUS_NOT_ALLOW, '该催费单已完成，不能重复处理');
    }

    await db(TABLE).where({ id: body.id }).update({
      call_status: body.callStatus,
      handle_time: new Date(),
      handle_remark: body.handleRemark || null,
      update_time: new Date(),
      update_by: operator.userId,
    });

    // ★ 2026-10-05：催缴状态变了 → 把最新状态推给班级管理（只读副本）
    await syncFeeCallToClass(body.id);

    res.json(ok({ callStatus: body.callStatus }));
  }),
);

/* ============================================================
 * 5.5 登记缴费（对齐初高 · ★ 2026-10-21 用户要求）
 *    POST /api/job/fee-call/voucher
 *
 * 【在做什么】
 *   初高的催费行早就能「上传缴费凭证（登记缴费）」：缴费方式 / 实缴金额 /
 *   缴费时间 / 备注 / 截图，五样一起落库。就业的催费单原来只有一个 call_status，
 *   「钱怎么交的」完全没记录 → 催费页里就业的行操作列只能显示「—」。
 *   本接口把那五项补到 t_job_fee_call（迁移 20261021_001）。
 *
 * 【状态怎么变】
 *   登记成功 → call_status 置 3（已缴清），同时写 handle_time / handle_remark 留痕
 *   （等于「班主任催完了、钱收到了」，与 /handle 的终态一致，但不覆盖原有催缴说明）。
 *
 * ⚠️ 仍然不产生财务账目：本模块只是催办工单，不写 sms_finance。
 *    凭证只存在这张单上，供催费页「查看」和家长缴费核对用。
 * ============================================================ */

feeCallRouter.post(
  '/voucher',
  validate(
    z.object({
      id: z.string().min(1, '催费单ID必传'),
      /** 缴费方式 1微信支付 2支付宝 3现金 */
      payMethod: z.coerce.number().int().min(1).max(3, '缴费方式只能是 微信支付 / 支付宝 / 现金'),
      /** 实缴金额（分）；允许与应缴（fee_amount）不同 */
      paidAmount: z.coerce.number().int().positive('缴费金额必须大于 0'),
      payDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '缴费时间格式应为 YYYY-MM-DD'),
      remark: z.string().max(200, '备注最多 200 字').optional(),
      /** 缴费截图；现金可不传 */
      dataUrl: z.string().optional(),
    }),
  ),
  wrap(async (req, res) => {
    const body = (req as any).validated;
    const operator = getOperator(req);

    const dateErr = checkPayDate(body.payDate);
    if (dateErr) throw new BizError(BizCode.PARAM_ERROR, dateErr);

    const row = await db(TABLE).where({ id: body.id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.FEE_CALL_NOT_FOUND, '催费单不存在');

    // ★ 权限与 /handle 同款：该学生的班主任本人（或管理员）
    const isHeadTeacher = row.head_teacher_id === operator.userId;
    const isAdmin = operator.roles.includes(RoleCode.SYS_ADMIN);
    if (!isHeadTeacher && !isAdmin && !operator.roles.includes('SUPER_TEST')) {
      throw new BizError(BizCode.NO_OPERATION_PERMISSION, '只有该学生的班主任能登记此催费单的缴费');
    }

    /* ---- 截图：现金不强制，微信/支付宝必须有（与初高同规则） ---- */
    let voucherUrl: string | null = null;
    if (body.dataUrl) {
      const saved = saveVoucherImage(body.dataUrl, 'call');
      if (!saved.ok) throw new BizError(BizCode.PARAM_ERROR, saved.message);
      voucherUrl = saved.voucherUrl;
    } else if (body.payMethod !== PAY_METHOD.CASH) {
      throw new BizError(BizCode.PARAM_ERROR, '请上传缴费截图（微信支付 / 支付宝需要凭证，现金可不传）');
    }

    const patch: Record<string, any> = {
      pay_method: body.payMethod,
      paid_amount: body.paidAmount,
      pay_date: body.payDate,
      pay_remark: body.remark || null,
      call_status: FeeCallStatus.PAID,
      handle_time: new Date(),
      handle_remark: body.remark || row.handle_remark || null,
      update_time: new Date(),
      update_by: operator.userId,
    };
    // 现金且没传截图：保留原来的凭证，不要把它清空
    if (voucherUrl) patch.voucher_url = voucherUrl;

    await db(TABLE).where({ id: body.id }).update(patch);

    // 催缴状态变了 → 推给班级管理（只读副本），与 /handle 同口径
    await syncFeeCallToClass(body.id);

    res.json(
      ok(
        {
          id: body.id,
          voucherUrl: voucherUrl ?? (row.voucher_url || null),
          callStatus: FeeCallStatus.PAID,
          payMethodName: PAY_METHOD_NAME[body.payMethod] ?? '',
        },
        '缴费登记成功',
      ),
    );
  }),
);

/* ============================================================
 * 6. 作废（发起人可以作废自己的）
 *    POST /api/job/fee-call/void
 *
 * ⚠️ 实现方式 = 逻辑删除（is_deleted=true）。
 *    为什么不用状态字段：FeeCallStatus 只有 1待催缴/2催缴中/3已缴清，
 *    没有"作废"。为了一个作废去动公共枚举不划算，
 *    而且"作废"本质就是"这条单子不要了" = 逻辑删除，语义正好对上。
 * ============================================================ */

feeCallRouter.post(
  '/void',
  validate(z.object({ id: z.string().min(1, '催费单ID必传') })),
  wrap(async (req, res) => {
    const { id } = (req as any).validated;
    const operator = getOperator(req);

    const row = await db(TABLE).where({ id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.FEE_CALL_NOT_FOUND, '催费单不存在');

    const isApplicant = row.applicant_id === operator.userId;
    const isAdmin = operator.roles.includes(RoleCode.SYS_ADMIN);
    // ★ 万能测试号（SUPER_TEST）：验证「发起 → 作废」链路，业务验证用全放行
    if (!isApplicant && !isAdmin && !operator.roles.includes('SUPER_TEST')) {
      throw new BizError(BizCode.NO_OPERATION_PERMISSION, '只有发起人能作废此催费单');
    }
    if (row.call_status === FeeCallStatus.PAID) {
      throw new BizError(BizCode.FEE_CALL_STATUS_NOT_ALLOW, '已缴清的催费单不能作废');
    }

    await db(TABLE).where({ id }).update({
      is_deleted: true,
      update_time: new Date(),
      update_by: operator.userId,
    });

    res.json(ok(null));
  }),
);

/* ============================================================
 * 7. 统计
 *    GET /api/job/fee-call/summary
 * ============================================================ */

feeCallRouter.get(
  '/summary',
  wrap(async (req, res) => {
    const operator = getOperator(req);

    const base = db(TABLE).where('is_deleted', false);

    // 班主任只看自己的班
    const isHeadTeacher = operator.roles.includes(RoleCode.TEACH_HEAD);
    const isAdmin = operator.roles.includes(RoleCode.SYS_ADMIN);
    const isEduAdmin = operator.roles.includes(RoleCode.ACAD_STAFF);
    if (isHeadTeacher && !isAdmin && !isEduAdmin) {
      base.andWhere('head_teacher_id', operator.userId);
    }

    const [{ c: total }] = await base.clone().count({ c: '*' });
    const [{ c: pending }] = await base.clone().andWhere('call_status', FeeCallStatus.PENDING).count({ c: '*' });
    const [{ c: calling }] = await base.clone().andWhere('call_status', FeeCallStatus.CALLING).count({ c: '*' });
    const [{ c: done }] = await base.clone().andWhere('call_status', FeeCallStatus.PAID).count({ c: '*' });
    const [{ c: overdue }] = await base
      .clone()
      .whereNot('call_status', FeeCallStatus.PAID)
      .andWhere('due_date', '<', today())
      .count({ c: '*' });

    res.json(
      ok({
        total: Number(total),
        // 前端卡片用的名字保持通用
        pending: Number(pending) + Number(calling), // 待处理 = 待催缴+催缴中
        called: Number(calling),
        done: Number(done),
        overdue: Number(overdue),
        // 细分
        pendingOnly: Number(pending),
        calling: Number(calling),
      }),
    );
  }),
);

export default feeCallRouter;
