/**
 * 学生管理路由
 *
 * 路径前缀：/api/consult/student
 *
 * ⚠️ 本文件承载原型的「学生管理」页全部动作：
 *    列表 / 详情 / 新建 / 完善档案 / 分配跟进人 / 面试结果 / 分班 / 记录流失 / 转正式
 */

import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import {
  BizCode,
  DeptCode,
  ConsultState,
  CONSULT_STATE_NAME,
  FULL_FEE_TYPES,
  FeeType,
  FEE_TYPE_NAME,
  FormalPayMode,
  SourceModule,
  ConsultFeeStatus,
  CONSULT_FEE_STATUS_NAME,
  ConsultRole,
  nameOf,
} from 'shared-types/consult';
import type { ConsultToFormalResult } from 'shared-types/consult';
import { FEE_ORDER_TABLE, parseOrderItemDetail } from '../services/fee-order.service';
import { ok, page } from '../utils/response';
import { db } from '../utils/db';
import { wrap } from '../utils/wrap';
import { validate } from '../middleware/validate';
import { requireManager } from '../middleware/auth';
import { BizError } from '../middleware/errorHandler';
import {
  STUDENT_TABLE,
  findStudent,
  toListItem,
  toDetail,
  listHistory,
  addHistory,
  getClassOptions,
  formatTime,
  today,
} from '../services/student.service';
import { changeState, syncStudentStatusOnly } from '../services/state.service';
import { terminateStudentPlans } from '../services/installment.service';
import {
  getStudentFeeStatMap,
  checkFullFeeArrived,
  createFees,
  createCombinedFees,
  getSupplementPlan,
  centToYuan,
} from '../services/fee-order.service';
import { listConsultants } from '../services/account.service';
import { financeClient } from '../services/finance.client';
// ★ 2026-10-16 数据范围：咨询师只看/只操作自己名下的学生
import {
  applyStudentScope,
  assertStudentInScope,
  guardOwnStudent,
} from '../services/data-scope';
// ★ 2026-10-05：入班 = 推送到班级管理模块（上游 → 班级 的统一出口）
import { classSync } from '../../utils/classSync';

export const studentRouter = Router();

/* ============================================================
 * 0. 辅助：把空字符串归一成 undefined
 *
 * ⚠️ 教训（骨架 bug）：前端未填的输入框会传 ''，
 *    而 `body.x ?? null` 中 ?? 只拦 null/undefined，拦不住空串，
 *    直接插 DATE 列会报 Incorrect date value: ''
 * ============================================================ */
const emptyToUndef = (v: unknown) =>
  v === '' || v === null || v === undefined ? undefined : v;
const optionalStr = (max: number) =>
  z.preprocess(emptyToUndef, z.string().max(max).optional());
const optionalDate = () =>
  z.preprocess(
    emptyToUndef,
    z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD').optional(),
  );

/* ============================================================
 * 1. 学生列表
 *    GET /api/consult/student/list
 * ============================================================ */

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
  studentName: z.string().optional(),
  phone: z.string().optional(),
  ownerName: z.string().optional(),
  className: z.string().optional(),
  sourceChannel: z.coerce.number().int().optional(),
  intendCourse: z.string().optional(),
  consultState: z.coerce.number().int().optional(),
  deptCode: z.coerce.number().int().optional(),
  keyword: z.string().optional(),
});

studentRouter.get(
  '/list',
  validate(listSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as z.infer<typeof listSchema>;

    const query = db(STUDENT_TABLE).where('is_deleted', false);

    // ★ 2026-10-16 数据范围：咨询师只看分配给自己的（＋自己录入还没分配的）
    applyStudentScope(query, req.user);

    if (q.studentName) query.andWhere('student_name', 'like', `%${q.studentName}%`);
    if (q.phone) query.andWhere('phone', 'like', `%${q.phone}%`);
    if (q.ownerName) query.andWhere('owner_name', 'like', `%${q.ownerName}%`);
    if (q.className) query.andWhere('class_name', 'like', `%${q.className}%`);
    if (q.sourceChannel) query.andWhere('source_channel', q.sourceChannel);
    if (q.intendCourse) query.andWhere('intend_course', 'like', `%${q.intendCourse}%`);
    if (q.consultState) query.andWhere('consult_state', q.consultState);
    // ★ 2026-10-15 部门筛选（前端「全部部门」下拉）：1=初高部 2=大学部
    if (q.deptCode) query.andWhere('dept_code', q.deptCode);

    // 全字段模糊搜索（对应原型的「全部字段」搜索）
    if (q.keyword) {
      query.andWhere((qb) => {
        qb.where('student_name', 'like', `%${q.keyword}%`)
          .orWhere('phone', 'like', `%${q.keyword}%`)
          .orWhere('parent_phone', 'like', `%${q.keyword}%`)
          .orWhere('owner_name', 'like', `%${q.keyword}%`)
          .orWhere('class_name', 'like', `%${q.keyword}%`)
          .orWhere('source_remark', 'like', `%${q.keyword}%`)
          .orWhere('intend_course', 'like', `%${q.keyword}%`)
          .orWhere('student_no', 'like', `%${q.keyword}%`);
      });
    }

    const [{ total }] = await query.clone().count({ total: '*' });

    const rows = await query
      .clone()
      .select('*')
      .orderBy('create_time', 'desc')
      .limit(q.size)
      .offset((q.page - 1) * q.size);

    // 批量取费用统计（避免 N+1 查询）
    const feeMap = await getStudentFeeStatMap(rows.map((r: any) => r.id));

    const list = rows.map((r: any) => toListItem(r, feeMap[r.id]));

    res.json(page(list, Number(total), q));
  }),
);

/* ============================================================
 * 2. 学生详情（含跟进历史 / 收款单 / 退费单）
 *    GET /api/consult/student/detail?id=xxx
 * ============================================================ */

studentRouter.get(
  '/detail',
  validate(z.object({ id: z.string().min(1, '必须传 id') })),
  wrap(async (req, res) => {
    const { id } = (req as any).validated as { id: string };

    const row = await findStudent(id);
    if (!row) {
      throw new BizError(BizCode.STUDENT_NOT_FOUND, '学生不存在');
    }
    // ★ 2026-10-16 数据范围：咨询师不能看别人名下的学生
    assertStudentInScope(row, req.user);

    const detail = toDetail(row);
    const history = await listHistory(id);

    // 该学生的收款单
    const feeRows: any[] = await db('t_consult_fee_order')
      .where({ consult_student_id: id, is_deleted: false })
      .orderBy('create_time', 'desc');

    /**
     * ★ 2026-10-16 用户口径：学生档案里的「缴费单」只保留【总金额】一行，
     *    总金额下面再列出它包含的费用项。
     *
     *   一次勾选多项费用发起收费时，库里是「一张单据一个费用类型」（同 batch_no），
     *   照原样平铺会出现 学费/住宿费/押金/保险费/餐费/校服 六行，同一张凭证重复六次。
     *   → 这里按 batch_no 合并成一行：金额 = 合计（总金额），凭证 = 共享凭证，
     *     included 列出包含的费用项，前端挂在总金额下面显示。
     *   （单张合并单本身就带 item_detail 的，也按 item_detail 展开成子项）
     */
    const grouped = new Map<string, any[]>();
    for (const r of feeRows) {
      const key = String(r.batch_no || r.id);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(r);
    }

    const fees: any[] = [...grouped.values()].map((rows) => {
      /**
       * 代表单据：优先「学费」，其次单号最小的那张。
       * （批次里 6 张单据的创建时间相同，直接取第一张会随机命中「保险费」这种，
       *   展示成「保险费 等 6 项」很怪 —— 学费才是这笔钱的主体。）
       */
      const sorted = [...rows].sort((a, b) =>
        String(a.order_no || '').localeCompare(String(b.order_no || '')),
      );
      const main = sorted.find((r) => Number(r.fee_type) === FeeType.TUITION) || sorted[0];
      const amount = rows.reduce((s, r) => s + Number(r.amount || 0), 0);
      // 状态取「最差的一档」（与收款与缴费列表口径一致）
      const statuses = rows.map((r) => Number(r.status));
      const status = statuses.includes(ConsultFeeStatus.REJECTED)
        ? ConsultFeeStatus.REJECTED
        : statuses.includes(ConsultFeeStatus.NO_VOUCHER)
          ? ConsultFeeStatus.NO_VOUCHER
          : statuses.includes(ConsultFeeStatus.PENDING)
            ? ConsultFeeStatus.PENDING
            : ConsultFeeStatus.ARRIVED;

      // 单张合并单：子项取 item_detail；多张单据：子项就是各张单据本身
      const detailItems =
        rows.length === 1 ? parseOrderItemDetail(main.item_detail) : [];

      const included =
        detailItems.length > 0
          ? detailItems.map((i: any) => ({
              // ★ 2026-10-19 带上类型码：前端要判断「同一费用项被重复发起」
              feeType: Number(i.feeType) || undefined,
              feeTypeName: i.feeTypeName || nameOf(FEE_TYPE_NAME, i.feeType),
              amountYuan: centToYuan(i.amount),
              status,
              statusName: nameOf(CONSULT_FEE_STATUS_NAME, status),
            }))
          : sorted.map((r) => ({
              feeType: Number(r.fee_type) || undefined,
              feeTypeName: nameOf(FEE_TYPE_NAME, r.fee_type),
              amountYuan: centToYuan(r.amount),
              status: Number(r.status),
              statusName: nameOf(CONSULT_FEE_STATUS_NAME, Number(r.status)),
              orderId: r.id,
            }));

      const firstTypeName = included[0]?.feeTypeName || nameOf(FEE_TYPE_NAME, main.fee_type);

      return {
        orderId: main.id,
        orderNo: rows.length > 1 ? `${main.order_no} 等 ${rows.length} 单` : main.order_no,
        orderIds: rows.map((r) => r.id),
        /**
         * ★ 2026-10-19 分期单标记：分期每一期都是同一个费用项，
         *    不能当成「重复收费」，也不在档案里给作废入口（撤期要回到分期计划里处理）。
         */
        planId: main.plan_id || undefined,
        stageNo: main.stage_no ?? undefined,
        feeTypeName:
          included.length > 1 ? `${firstTypeName} 等 ${included.length} 项` : firstTypeName,
        amount,
        amountYuan: centToYuan(amount),
        status,
        statusName: nameOf(CONSULT_FEE_STATUS_NAME, status),
        // 凭证：整批共用一张，取第一张有值的
        voucherUrl: rows.map((r) => r.voucher_url).find(Boolean) || undefined,
        createTime: formatTime(main.create_time),
        /** 总金额下面列出的费用项 */
        included,
      };
    });

    /**
     * ★ 2026-10-19 疑似重复收费标注（用户反馈「怎么能缴费好几次」）
     *
     * 现象：同一个费用项同时挂在两张【未终结】的单据上，学生档案里就是两组一样的金额，
     *       老师无法判断哪一张是真的。
     * 口径：只对「未到账」的单据做标注 —— 已到账之后再补收差额是合法的，不算重复。
     * 前端把 duplicated=true 的行标红，提示「疑似重复发起，请作废多余的一批」。
     */
    const openTypeCount = new Map<number, number>();
    for (const f of fees) {
      if (f.status === ConsultFeeStatus.ARRIVED) continue;
      if (f.planId) continue; // 分期各期本来就重复同一费用项，不算重复收费
      for (const it of f.included) {
        if (!it.feeType) continue;
        openTypeCount.set(it.feeType, (openTypeCount.get(it.feeType) || 0) + 1);
      }
    }
    for (const f of fees) {
      if (f.status === ConsultFeeStatus.ARRIVED) continue;
      if (f.planId) continue;
      const dupTypes = [
        ...new Set(
          f.included
            .filter((it: any) => it.feeType && (openTypeCount.get(it.feeType) || 0) > 1)
            .map((it: any) => it.feeTypeName),
        ),
      ] as string[];
      if (dupTypes.length) {
        f.duplicated = true;
        f.duplicatedTypes = dupTypes;
      }
    }

    // 退费单
    const refundRow: any = await db('t_consult_refund')      .where({ consult_student_id: id, is_deleted: false })
      .orderBy('create_time', 'desc')
      .first();

    res.json(
      ok({
        ...detail,
        history,
        fees,
        refund: refundRow
          ? {
              refundId: refundRow.id,
              refundNo: refundRow.refund_no,
              status: refundRow.status,
              refundAmount: refundRow.refund_amount,
              amountYuan: centToYuan(refundRow.refund_amount),
            }
          : null,
        /** 可分配班级候选 */
        classOptions: await getClassOptions(),
        /** 是否全款已到账（决定能否转正式完成） */
        fullFeeStatus: await checkFullFeeArrived(id, FULL_FEE_TYPES),
      }),
    );
  }),
);

/* ============================================================
 * 3. 新建学生（市场/咨询首次录入）
 *    POST /api/consult/student/add
 * ============================================================ */

const addSchema = z.object({
  studentName: z.string().min(1, '姓名必填').max(50),
  gender: z.coerce.number().int().min(1).max(2, '性别只能是 1(男) 或 2(女)'),
  phone: z.string().min(1, '手机号必填').max(20),
  sourceChannel: z.coerce.number().int().min(1).max(9, '来源渠道取值非法'),
  sourceRemark: optionalStr(100),
  // ★ 2026-10-15 来源=转介绍(3)时填写的招生老师信息
  referrerName: optionalStr(50),
  referrerPhone: optionalStr(20),
  // ★ 2026-10-15 表单已取消「意向课程」输入框，改为选填，避免旧调用方被必填校验挡住
  intendCourse: optionalStr(100),
  parentContact: optionalStr(50),
  parentPhone: optionalStr(20),
  deptCode: z.coerce.number().int().min(1).max(2).optional(),
});

studentRouter.post(
  '/add',
  validate(addSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof addSchema>;
    const operator = req.user!;

    // 手机号去重（同号可能是重复录入）
    const dup = await db(STUDENT_TABLE)
      .where({ phone: body.phone, is_deleted: false })
      .first();
    if (dup) {
      throw new BizError(
        BizCode.PARAM_ERROR,
        `手机号 ${body.phone} 已被学生「${dup.student_name}」使用，请确认是否重复录入`,
      );
    }

    const id = randomUUID();
    await db(STUDENT_TABLE).insert({
      id,
      student_name: body.studentName,
      gender: body.gender,
      phone: body.phone,
      source_channel: body.sourceChannel,
      source_remark: body.sourceRemark ?? null,
      // ★ 2026-10-15 转介绍招生老师（仅来源=转介绍时前端会传）
      referrer_name: body.sourceChannel === 3 ? body.referrerName ?? null : null,
      referrer_phone: body.sourceChannel === 3 ? body.referrerPhone ?? null : null,
      intend_course: body.intendCourse ?? null,
      parent_contact: body.parentContact ?? null,
      parent_phone: body.parentPhone ?? null,
      dept_code: body.deptCode ?? DeptCode.JUNIOR_SENIOR,
      // 新学生默认「待分配」，等经理分配跟进人
      consult_state: ConsultState.WAIT_ASSIGN,
      /**
       * ★ 2026-10-16 咨询师自己录入的先挂到自己名下
       *    —— 否则「咨询师只看分配给自己的学生」这条规则下，
       *      他刚录完的学生会立刻从列表里消失（体验上像数据丢了）。
       *      经理后续仍可以在待分配里改派给别人。
       */
      owner_name: operator.role === ConsultRole.CONSULT ? operator.userName : null,
      owner_title: operator.role === ConsultRole.CONSULT ? '咨询师' : null,
      student_status: 1,
      is_deleted: false,
      create_time: new Date(),
      create_by: operator.userName,
      create_by_name: operator.userName,
    });

    await addHistory(
      id,
      operator.userName,
      `录入基本信息（意向课程：${body.intendCourse}）`,
      operator.roleTitle,
      'CREATE',
    );

    res.json(ok({ consultStudentId: id }, '新增成功'));
  }),
);

/* ============================================================
 * 4. 完善档案信息
 *    PUT /api/consult/student/update-extra
 * ============================================================ */

const extraSchema = z.object({
  id: z.string().min(1, '必须传 id'),
  idCard: optionalStr(32),
  school: optionalStr(100),
  address: optionalStr(200),
  targetCollege: optionalStr(100),
  birthday: optionalDate(),
  payMode: optionalStr(50),
  remark: optionalStr(500),
  intendCourse: optionalStr(100),
  parentContact: optionalStr(50),
  parentPhone: optionalStr(20),
});

studentRouter.put(
  '/update-extra',
  validate(extraSchema),
  guardOwnStudent,
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof extraSchema>;
    const operator = req.user!;

    const exists = await findStudent(body.id);
    if (!exists) throw new BizError(BizCode.STUDENT_NOT_FOUND, '学生不存在');

    const patch: Record<string, any> = {
      update_time: new Date(),
      update_by: operator.userName,
    };
    if (body.idCard !== undefined) patch.id_card = body.idCard ?? null;
    if (body.school !== undefined) patch.school = body.school ?? null;
    if (body.address !== undefined) patch.address = body.address ?? null;
    if (body.targetCollege !== undefined) patch.target_college = body.targetCollege ?? null;
    if (body.birthday !== undefined) patch.birthday = body.birthday ?? null;
    if (body.payMode !== undefined) patch.pay_mode = body.payMode ?? null;
    if (body.remark !== undefined) patch.remark = body.remark ?? null;
    if (body.intendCourse !== undefined) patch.intend_course = body.intendCourse ?? null;
    if (body.parentContact !== undefined) patch.parent_contact = body.parentContact ?? null;
    if (body.parentPhone !== undefined) patch.parent_phone = body.parentPhone ?? null;

    await db(STUDENT_TABLE).where({ id: body.id }).update(patch);

    await addHistory(body.id, operator.userName, '完善档案信息', operator.roleTitle, 'UPDATE_EXTRA');

    res.json(ok(null, '档案信息已保存'));
  }),
);

/* ============================================================
 * 5. 分配咨询老师（经理专属）
 *    POST /api/consult/student/assign
 * ============================================================ */

studentRouter.post(
  '/assign',
  requireManager,
  validate(
    z.object({
      consultStudentId: z.string().min(1),
      ownerName: z.string().min(1, '请选择咨询老师').max(50),
    }),
  ),
  wrap(async (req, res) => {
    const body = (req as any).validated as { consultStudentId: string; ownerName: string };
    const operator = req.user!;

    const stu = await findStudent(body.consultStudentId);
    if (!stu) throw new BizError(BizCode.STUDENT_NOT_FOUND, '学生不存在');

    if (stu.consult_state !== ConsultState.WAIT_ASSIGN) {
      throw new BizError(
        BizCode.INVALID_STATUS,
        `只有「待分配」的学生可以分配跟进人，当前状态不是待分配`,
      );
    }

    await changeState(body.consultStudentId, ConsultState.WAIT_INTERVIEW, {
      byName: operator.userName,
      byTitle: operator.roleTitle,
      action: 'ASSIGN',
      historyText: `分配跟进人：${body.ownerName}`,
      extraFields: {
        owner_name: body.ownerName,
        owner_title: body.ownerName.includes('经理') ? '咨询经理' : '咨询师',
      },
    });

    res.json(ok(null, `已分配给 ${body.ownerName}，状态 → 待面试`));
  }),
);

/* ============================================================
 * 6. 本人接待认领
 *    POST /api/consult/student/claim
 *
 * ★ 2026-10-16：原来只有经理能「认领」（requireManager），
 *   但前端给咨询师也显示了「领取」按钮 —— 咨询师点了必 403。
 *   按新口径（咨询师负责分配给自己的学生），认领 = 自己接手，
 *   所以改成「谁都能认领，owner 记成本人」。经理保留「（本人接待）」后缀。
 * ============================================================ */

studentRouter.post(
  '/claim',
  validate(z.object({ consultStudentId: z.string().min(1) })),
  wrap(async (req, res) => {
    const { consultStudentId } = (req as any).validated as { consultStudentId: string };
    const operator = req.user!;

    const stu = await findStudent(consultStudentId);
    if (!stu) throw new BizError(BizCode.STUDENT_NOT_FOUND, '学生不存在');

    if (stu.consult_state !== ConsultState.WAIT_ASSIGN) {
      throw new BizError(
        BizCode.INVALID_STATUS,
        `只有「待分配」的学生可以认领，当前状态不是待分配`,
      );
    }

    const isMgr = operator.role !== ConsultRole.CONSULT;
    const ownerLabel = isMgr ? `${operator.userName}（本人接待）` : operator.userName;

    await changeState(consultStudentId, ConsultState.WAIT_INTERVIEW, {
      byName: operator.userName,
      byTitle: operator.roleTitle,
      action: 'CLAIM',
      historyText: isMgr ? '经理本人接待并跟进' : '咨询师本人接待认领并跟进',
      extraFields: {
        owner_name: ownerLabel,
        owner_title: isMgr ? '咨询经理' : '咨询师',
      },
    });

    res.json(ok(null, '已接待认领，状态 → 待面试'));
  }),
);

/* ============================================================
 * 7. 面试结果
 *    POST /api/consult/student/interview
 * ============================================================ */

studentRouter.post(
  '/interview',
  validate(
    z.object({
      consultStudentId: z.string().min(1),
      pass: z.coerce.boolean(),
      remark: optionalStr(200),
    }),
  ),
  guardOwnStudent,
  wrap(async (req, res) => {
    const body = (req as any).validated as {
      consultStudentId: string;
      pass: boolean;
      remark?: string;
    };
    const operator = req.user!;

    const stu = await findStudent(body.consultStudentId);
    if (!stu) throw new BizError(BizCode.STUDENT_NOT_FOUND, '学生不存在');

    if (!body.pass) {
      // ---- 不通过：不收，不做统计 ----
      await changeState(body.consultStudentId, ConsultState.REJECTED, {
        byName: operator.userName,
        byTitle: operator.roleTitle,
        action: 'INTERVIEW_FAIL',
        historyText: `面试笔试未通过（不收，不做统计）${body.remark ? `｜${body.remark}` : ''}`,
      });
      res.json(ok(null, '已记录：未通过'));
      return;
    }

    // ---- 通过：进入收费环节，状态先不动（等收费动作决定具体状态）----
    await addHistory(
      body.consultStudentId,
      operator.userName,
      '面试笔试通过，进入收费环节',
      operator.roleTitle,
      'INTERVIEW_PASS',
    );
    res.json(ok(null, '面试通过，请选择试学或一次性缴清'));
  }),
);

/* ============================================================
 * 8. 分配班级
 *    POST /api/consult/student/assign-class
 *
 * ⚠️ 前置校验：试学费必须已确认到账（原型明确要求）
 * ============================================================ */

studentRouter.post(
  '/assign-class',
  validate(
    z.object({
      consultStudentId: z.string().min(1),
      className: z.string().min(1, '请选择班级').max(50),
    }),
  ),
  guardOwnStudent,
  wrap(async (req, res) => {
    const body = (req as any).validated as { consultStudentId: string; className: string };
    const operator = req.user!;

    const stu = await findStudent(body.consultStudentId);
    if (!stu) throw new BizError(BizCode.STUDENT_NOT_FOUND, '学生不存在');

    // ---- 校验试学费是否已到账 ----
    const trialArrived: any = await db('t_consult_fee_order')
      .where({
        consult_student_id: body.consultStudentId,
        fee_type: 5,   // FeeType.TRIAL_FEE
        status: 2,     // ConsultFeeStatus.ARRIVED
        is_deleted: false,
      })
      .first();

    if (!trialArrived) {
      throw new BizError(
        BizCode.TRIAL_FEE_NOT_ARRIVED,
        '试学费未确认到账，无法进入试学阶段。请先上传缴费截图，等财务确认到账后再分班。',
      );
    }

    const isFirstClass = !stu.class_name;

    await changeState(body.consultStudentId, ConsultState.TRIAL, {
      byName: operator.userName,
      byTitle: operator.roleTitle,
      action: 'ASSIGN_CLASS',
      historyText: `分配班级：${body.className}`,
      extraFields: {
        class_name: body.className,
        // 首次分班时记试学开始日期（退费算天数用）
        trial_start: isFirstClass ? today() : stu.trial_start,
      },
    });

    res.json(ok(null, `已分班 ${body.className}，状态 → 试学中`));
  }),
);

/* ============================================================
 * 9. 记录流失
 *    POST /api/consult/student/loss
 *
 * 对应流程图「是否转正式 → 否 → 记录流失原因、统计流失数量」
 * ============================================================ */

studentRouter.post(
  '/loss',
  validate(
    z.object({
      consultStudentId: z.string().min(1),
      lossReason: z.string().min(1, '请选择流失原因').max(200),
    }),
  ),
  guardOwnStudent,
  wrap(async (req, res) => {
    const body = (req as any).validated as { consultStudentId: string; lossReason: string };
    const operator = req.user!;

    const stu = await findStudent(body.consultStudentId);
    if (!stu) throw new BizError(BizCode.STUDENT_NOT_FOUND, '学生不存在');

    await changeState(body.consultStudentId, ConsultState.LOST, {
      byName: operator.userName,
      byTitle: operator.roleTitle,
      action: 'LOSS',
      historyText: `不试学，流失原因：${body.lossReason}`,
      extraFields: { loss_reason: body.lossReason },
    });

    /* ★ 2026-10-16 分期：流失学生的尾款不再收，终止在途分期计划 */
    await terminateStudentPlans(body.consultStudentId, `学生流失：${body.lossReason}`);

    res.json(ok(null, '已记录流失并计入流失率'));
  }),
);

/* ============================================================
 * 9.1 ⭐ 记录未报名（流程图：「是否当场报名 → 否」）
 *     POST /api/consult/student/not-enrolled
 *
 * ⚠️ 与「流失」的区别（流程图里是两个分支）：
 *    · 未报名：暂时没报，**留待二次来访**，计入跟进待办，**不计入流失率**
 *    · 流失  ：明确不来了，计入流失统计
 *
 *    这里额外要求填「后续跟进计划」，对应流程图上的「+后续跟进计划」。
 * ============================================================ */

studentRouter.post(
  '/not-enrolled',
  validate(
    z.object({
      consultStudentId: z.string().min(1),
      reason: z.string().min(1, '请填写未报名原因').max(200),
      /** 后续跟进计划（流程图明确要求） */
      followUpPlan: z.string().max(300).optional(),
    }),
  ),
  guardOwnStudent,
  wrap(async (req, res) => {
    const body = (req as any).validated as {
      consultStudentId: string;
      reason: string;
      followUpPlan?: string;
    };
    const operator = req.user!;

    const stu = await findStudent(body.consultStudentId);
    if (!stu) throw new BizError(BizCode.STUDENT_NOT_FOUND, '学生不存在');

    await changeState(body.consultStudentId, ConsultState.NOT_ENROLLED, {
      byName: operator.userName,
      byTitle: operator.roleTitle,
      action: 'NOT_ENROLLED',
      historyText:
        `未当场报名，原因：${body.reason}` +
        (body.followUpPlan ? `；后续跟进计划：${body.followUpPlan}` : '') +
        '（支持二次来访重新发起流程，不计入流失率）',
      extraFields: { loss_reason: body.reason },
    });

    res.json(ok(null, '已记录「未报名·待跟进」，可择机二次来访'));
  }),
);

/* ============================================================
 * 9.2 ⭐ 二次来访（流程图：「是否二上/三上 → 是 → 回访跟进」）
 *     POST /api/consult/student/revisit
 *
 * 把「未报名」的学生重新拉回流程：状态回到「待面试」，
 * 复用同一个学生档案（不重复建档），并留痕「二次来访」。
 * ============================================================ */

studentRouter.post(
  '/revisit',
  validate(
    z.object({
      consultStudentId: z.string().min(1),
      remark: z.string().max(200).optional(),
    }),
  ),
  guardOwnStudent,
  wrap(async (req, res) => {
    const body = (req as any).validated as { consultStudentId: string; remark?: string };
    const operator = req.user!;

    const stu = await findStudent(body.consultStudentId);
    if (!stu) throw new BizError(BizCode.STUDENT_NOT_FOUND, '学生不存在');

    if (stu.consult_state !== ConsultState.NOT_ENROLLED) {
      throw new BizError(
        BizCode.INVALID_STATUS,
        `只有「未报名·待跟进」的学生才能二次来访，当前状态：${
          (CONSULT_STATE_NAME as any)[stu.consult_state] || stu.consult_state
        }`,
      );
    }

    await changeState(body.consultStudentId, ConsultState.WAIT_INTERVIEW, {
      byName: operator.userName,
      byTitle: operator.roleTitle,
      action: 'REVISIT',
      historyText: `二次来访，重新进入咨询流程${body.remark ? `：${body.remark}` : ''}`,
    });

    res.json(ok(null, '已重新进入咨询流程（状态 → 待面试）'));
  }),
);

/* ============================================================
 * 9.3 ★ 2026-10-08 取消「未报名」
 *     POST /api/consult/student/cancel-not-enrolled
 *
 * 用户口径：还未报名的（被记了「未报名·待跟进」），可以取消掉 ——
 * 取消后回到「咨询中」（报名确认态），直接重走缴费报名流程。
 *
 * ★ 2026-10-08 二次调整：不再回「待面试」——面试结果只能录一次，
 *   取消未报名是「学生又愿意报了」，不是「要重新面试」，
 *   所以落点改为 TRIAL_FEE_PENDING，前端不会再出现「面试」按钮。
 * ============================================================ */

studentRouter.post(
  '/cancel-not-enrolled',
  validate(
    z.object({
      consultStudentId: z.string().min(1),
      remark: z.string().max(200).optional(),
    }),
  ),
  guardOwnStudent,
  wrap(async (req, res) => {
    const body = (req as any).validated as { consultStudentId: string; remark?: string };
    const operator = req.user!;

    const stu = await findStudent(body.consultStudentId);
    if (!stu) throw new BizError(BizCode.STUDENT_NOT_FOUND, '学生不存在');

    if (stu.consult_state !== ConsultState.NOT_ENROLLED) {
      throw new BizError(
        BizCode.INVALID_STATUS,
        `只有「未报名·待跟进」的学生才能取消，当前状态：${
          (CONSULT_STATE_NAME as any)[stu.consult_state] || stu.consult_state
        }`,
      );
    }

    await changeState(body.consultStudentId, ConsultState.TRIAL_FEE_PENDING, {
      byName: operator.userName,
      byTitle: operator.roleTitle,
      action: 'CANCEL_NOT_ENROLLED',
      historyText: `取消「未报名」标记，恢复报名确认，可继续走缴费流程（无需重复面试）${body.remark ? `：${body.remark}` : ''}`,
    });

    res.json(ok(null, '已取消「未报名」，请到「收费与到账」继续缴费流程'));
  }),
);

/* ============================================================
 * 10. 咨询老师候选（分配弹窗用）
 *     GET /api/consult/student/consultants
 * ============================================================ */

studentRouter.get(
  '/consultants',
  wrap(async (_req, res) => {
    res.json(ok(await listConsultants()));
  }),
);

/* ============================================================
 * 11. 学籍状态手工同步（联调辅助）
 *     POST /api/consult/student/sync-status
 *
 * ⚠️ 用途：模拟教务模块把学生置为「休学」，验证财务自动冻结（规则1）
 * ============================================================ */

studentRouter.post(
  '/sync-status',
  validate(
    z.object({
      consultStudentId: z.string().min(1),
      studentStatus: z.coerce.number().int().min(1).max(11, '学籍状态取值非法'),
    }),
  ),
  wrap(async (req, res) => {
    const body = (req as any).validated as { consultStudentId: string; studentStatus: number };
    const stu = await findStudent(body.consultStudentId);
    if (!stu) throw new BizError(BizCode.STUDENT_NOT_FOUND, '学生不存在');

    const result = await syncStudentStatusOnly(
      body.consultStudentId,
      body.studentStatus,
      req.user?.userName || '联调辅助',
      `学籍状态手工同步为 ${body.studentStatus}（联调辅助）`,
    );

    res.json(
      ok(result, result.synced ? result.syncMessage || '同步成功' : `同步失败：${result.syncMessage}`),
    );
  }),
);

/* ============================================================
 * 12. ⭐ 转正式（发起全款收费 / 分笔补缴）
 *     POST /api/consult/student/to-formal
 *
 * 对应流程图「是否转正式 → 是 → 是否一次性付清学费」这个决策点：
 *   · payMode = FULL        （是）→ 一次性发起全款 4 笔
 *   · payMode = INSTALLMENT （否）→ 只发起本次勾选的类型（分笔补缴）
 *
 * ⚠️ 两种模式都切到「缴费中·待确认」，但语义不同：
 *    · FULL        —— 等全款到账才转正式
 *    · INSTALLMENT —— 只是本次这批待确认，后续还要继续补缴
 *    所以历史文案要写清楚「本次缴哪几笔、还差多少」，否则后面的人看不明白。
 * ============================================================ */

studentRouter.post(
  '/to-formal',
  validate(
    z.object({
      consultStudentId: z.string().min(1),
      payMode: z.enum(['FULL', 'INSTALLMENT']).optional().default('FULL'),
      // ★ 2026-10-15：上限 5 → 7（押金 / 校服）
      feeTypes: z.array(z.coerce.number().int().min(1).max(7)).optional(),
      /**
       * ★ 2026-10-19 用户口径：「只要缴费就要有凭证」。
       *    转正式会真的建缴费单，凭证必传；
       *    但「咨询侧无待发起款项」的 noop 分支不建单，所以这里放可选，
       *    真正建单前由 service 兜底拦截。
       */
      voucherUrl: z.string().optional(),
      voucherNo: z.string().max(100).optional(),
    }),
  ),
  guardOwnStudent,
  wrap(async (req, res) => {
    const body = (req as any).validated as {
      consultStudentId: string;
      payMode: FormalPayMode;
      feeTypes?: FeeType[];
      voucherUrl?: string;
      voucherNo?: string;
    };
    const { consultStudentId, payMode } = body;
    const operator = req.user!;

    const stu = await findStudent(consultStudentId);
    if (!stu) throw new BizError(BizCode.STUDENT_NOT_FOUND, '学生不存在');

    // ---- 1. 先算补缴缺口（流程图：「统计补缴金额和类型」）----
    const planBefore = await getSupplementPlan(consultStudentId, FULL_FEE_TYPES);

    if (planBefore.allArrived) {
      throw new BizError(BizCode.INVALID_STATUS, '该学生全款已到账，无需再次发起');
    }

    // ---- 2. 决定本次要发起哪些类型 ----
    let feeTypes: FeeType[];
    if (payMode === 'FULL') {
      // 一次性缴清：把还差的各类型一次全发
      feeTypes = planBefore.missing as FeeType[];
    } else {
      // 分笔补缴：用本次勾选的；不传则退化为「缺口全发」
      feeTypes = (body.feeTypes || []).length
        ? (body.feeTypes as FeeType[])
        : (planBefore.missing as FeeType[]);

      // ⚠️ 勾选的类型必须真的在缺口里，不然会重复建单
      const notMissing = feeTypes.filter((t) => !planBefore.missing.includes(t));
      if (notMissing.length) {
        const names = notMissing.map((t) => nameOf(FEE_TYPE_NAME, t)).join('/');
        throw new BizError(
          BizCode.PARAM_ERROR,
          `${names} 已到账或已在待确认中，无需重复发起。当前缺口：${
            planBefore.missing.map((t) => nameOf(FEE_TYPE_NAME, t)).join('/') || '无'
          }`,
        );
      }
    }

    if (!feeTypes.length) {
      throw new BizError(BizCode.PARAM_ERROR, '没有需要补缴的费用类型');
    }

    // ---- 2.5 ⭐ 按「发起方」过滤（规则3-① 的前置拦截）----
    //
    // ⚠️ 为什么要在这里拦？
    //    全款 4 类里只有「学费 / 试学费」归咨询发起，
    //    「住宿费 / 餐费 / 保险费」归教务发起（见 FULL_FEE_TYPES 注释）。
    //    如果不过滤就丢给财务，财务会逐笔拒绝，老师看到的是
    //    「4 笔里 3 笔失败」，非常困惑，而且失败原因要等往返才知道。
    //    这里提前用财务标准里的 sourceModule 判断，把不属于咨询的类型挑出来，
    //    能发的正常发，不能发的【带原因告诉老师】，不让老师以为操作失败了。
    const ownedByConsult: FeeType[] = [];
    const belongsToOthers: Array<{ feeType: FeeType; feeTypeName: string; owner: string }> = [];

    for (const t of feeTypes) {
      try {
        const std = await financeClient.getStandard(t, (stu.dept_code || 1) as DeptCode);
        if (std.sourceModule === SourceModule.CONSULT) {
          ownedByConsult.push(t);
        } else {
          belongsToOthers.push({
            feeType: t,
            feeTypeName: nameOf(FEE_TYPE_NAME, t),
            owner: std.sourceModuleName || '其他模块',
          });
        }
      } catch {
        // 财务标准取不到时交给下游兜底（createFees 里还会再校验一次）
        ownedByConsult.push(t);
      }
    }

    if (!ownedByConsult.length) {
      /*
       * ⚠️ 两种情况要分开：
       *   (a) 老师【明确勾选】了不归咨询发的类型 → 这是操作错误，要报错说清楚
       *   (b) FULL 模式自动展开缺口，结果缺口里只剩别的模块的 → 这不是错误，
       *       咨询侧的活已经干完了
       */
      if (payMode === 'INSTALLMENT' && (body.feeTypes || []).length) {
        const names = belongsToOthers
          .map((b) => `${b.feeTypeName}（应由${b.owner}发起）`)
          .join('；');
        throw new BizError(
          BizCode.SOURCE_MODULE_MISMATCH,
          `所选类型咨询模块均无权发起：${names}。` +
            `咨询侧只能发起「学费 / 试学费」，住宿费、餐费、保险费请由教务模块发起。`,
        );
      }
      const otherNames = belongsToOthers
        .map((b) => `${b.feeTypeName}（归${b.owner}）`)
        .join('；');

      await changeState(consultStudentId, ConsultState.FULL_FEE_PENDING, {
        byName: operator.userName,
        byTitle: operator.roleTitle,
        action: payMode === 'FULL' ? 'TO_FORMAL_FULL' : 'TO_FORMAL_INSTALLMENT',
        historyText:
          `转正式 · ${payMode === 'FULL' ? '一次性缴清' : '分笔补缴'}：` +
          `咨询侧无待发起款项（剩余 ${otherNames} 需其他模块发起），` +
          `全款 ¥${centToYuan(planBefore.totalAmount)}，已到账 ¥${centToYuan(planBefore.arrivedAmount)}`,
        extraFields: {
          pay_mode: payMode === 'FULL' ? '一次性缴清' : '分笔补缴',
        },
      });

      const planAfterNoop = await getSupplementPlan(consultStudentId, FULL_FEE_TYPES);
      const noopMsg =
        `咨询侧已无待发起款项。以下由其他模块发起：${otherNames}。` +
        `全款 ¥${centToYuan(planAfterNoop.totalAmount)}，已到账 ¥${centToYuan(planAfterNoop.arrivedAmount)}`;

      const noopPayload: ConsultToFormalResult = {
        created: [],
        payMode,
        planAfter: planAfterNoop,
        skipped: belongsToOthers,
        message: noopMsg,
      };
      res.json(ok(noopPayload, noopMsg));
      return;
    }

    // ---- 3. 建单（金额取财务标准，规则2；来源校验，规则3-①）----
    /**
     * ★ 2026-10-19 用户口径：「一张凭证就是交的总金额，总金额下面列小列」
     *
     * 以前这里走 createFees —— 勾 4 个类型就建 4 张单，
     * 家长只转了一笔钱，系统里却出现 4 条缴费记录、4 个凭证位置，
     * 学生档案里看着像「缴了好几次」。
     *
     * 现在：多类型一律合并成【一张合计单】，各项金额存 item_detail，
     *       财务侧也只有 1 笔待核对，金额 = 凭证上的金额。
     */
    const result =
      ownedByConsult.length > 1
        ? await createCombinedFees(
            consultStudentId,
            ownedByConsult,
            { name: operator.userName, title: operator.roleTitle },
            stu.pay_mode || undefined,
            undefined,
            body.voucherUrl,
            body.voucherNo,
          )
        : await createFees(
            consultStudentId,
            ownedByConsult,
            { name: operator.userName, title: operator.roleTitle },
            stu.pay_mode || undefined,
            undefined,
            body.voucherUrl,
            body.voucherNo,
          );

    const okList = result.created.filter((c) => c.success);
    if (!okList.length) {
      throw new BizError(
        BizCode.DOWNSTREAM_ERROR,
        `发起失败：${result.created.map((c) => `${c.feeTypeName}（${c.reason}）`).join('；')}`,
      );
    }

    // ---- 4. 切状态 ----
    const paidNames = okList.map((c) => c.feeTypeName).join('/');
    const paidAmount = okList.reduce((a, b) => a + b.amount, 0);

    // 发起后再算一次缺口，判断是「还剩缺口」还是「这次的补上了」
    const planAfter = await getSupplementPlan(consultStudentId, FULL_FEE_TYPES);

    await changeState(consultStudentId, ConsultState.FULL_FEE_PENDING, {
      byName: operator.userName,
      byTitle: operator.roleTitle,
      action: payMode === 'FULL' ? 'TO_FORMAL_FULL' : 'TO_FORMAL_INSTALLMENT',
      historyText:
        (payMode === 'FULL'
          ? `转正式 · 一次性缴清，发起全款收费（${paidNames}）共 ¥${centToYuan(paidAmount)}，等待财务确认到账`
          : `转正式 · 分笔补缴，本次发起（${paidNames}）共 ¥${centToYuan(paidAmount)}；` +
            `全款 ¥${centToYuan(planAfter.totalAmount)}，已到账 ¥${centToYuan(planAfter.arrivedAmount)}，` +
            `仍缺 ${planAfter.missing.map((t) => nameOf(FEE_TYPE_NAME, t)).join('/') || '无'}`) +
        (belongsToOthers.length
          ? `；${belongsToOthers.map((b) => `${b.feeTypeName} 归「${b.owner}」发起，本模块未发起`).join('，')}`
          : ''),
      extraFields: {
        pay_mode: payMode === 'FULL' ? '一次性缴清' : '分笔补缴',
      },
    });

    // ⚠️ 提示文案要把「哪些没发、为什么」说清楚，
    //    否则老师会以为系统漏发了（曾经就是这个体验问题）
    const otherTip = belongsToOthers.length
      ? `；${belongsToOthers
          .map((b) => `${b.feeTypeName}需由${b.owner}发起`)
          .join('、')}`
      : '';

    /**
     * ★ 2026-10-19 文案跟着「一张合计单」改
     *    合并后 okList 只有 1 条，「1 笔已发起」会让人以为只发了一类费用，
     *    所以要说清：一张单、合计多少钱、里面包含哪几项。
     */
    const merged = ownedByConsult.length > 1;
    const fullMsg = merged
      ? `已发起 1 笔合计收费 ¥${centToYuan(paidAmount)}（${ownedByConsult
          .map((t) => nameOf(FEE_TYPE_NAME, t))
          .join('/')}），请上传缴费截图${otherTip}`
      : `1 笔已发起，请上传缴费截图${otherTip}`;

    const msg =
      payMode === 'FULL'
        ? fullMsg
        : merged
          ? `已发起 1 笔合计补缴 ¥${centToYuan(paidAmount)}（${ownedByConsult
              .map((t) => nameOf(FEE_TYPE_NAME, t))
              .join('/')}），仍缺 ${
              planAfter.missing.map((t) => nameOf(FEE_TYPE_NAME, t)).join('/') || '无'
            }${otherTip}`
          : `已发起补缴 1 笔（${paidNames}），仍缺 ${
              planAfter.missing.map((t) => nameOf(FEE_TYPE_NAME, t)).join('/') || '无'
            }${otherTip}`;

    const payload: ConsultToFormalResult = {
      ...result,
      payMode,
      planAfter,
      /** 本次因来源归属未发起的类型（规则3-①），前端要显示原因 */
      skipped: belongsToOthers,
      message: msg,
    };

    res.json(ok(payload, msg));
  }),
);

/* ============================================================
 * 13. ⭐ 补缴明细统计（流程图：「咨询老师统计补缴金额和类型」）
 *     GET /api/consult/student/supplement-plan?consultStudentId=xxx
 *
 * 前端「转正式 / 补缴」弹窗打开时调，用来渲染：
 *   「全款 ¥XXXX，已到账 ¥XXX，还差 学费/住宿费 ¥XXX」
 * ============================================================ */

studentRouter.get(
  '/supplement-plan',
  validate(z.object({ consultStudentId: z.string().min(1) })),
  wrap(async (req, res) => {
    const { consultStudentId } = (req as any).validated as { consultStudentId: string };
    const plan = await getSupplementPlan(consultStudentId, FULL_FEE_TYPES);
    res.json(ok(plan));
  }),
);

/* ============================================================
 * 14. ⭐ 面试结果录入（流程图：「是否接收该学生」）
 *     POST /api/consult/student/interview-result
 *
 * 对应流程图面试后的判断点：
 *   · accepted = true  → 接收，进入「是否当场报名」
 *   · accepted = false → 不收，**不做统计、不计入流失**（REJECTED）
 *
 * ⚠️ 为什么不复用 /loss？
 *    流失是「接收了但没来」；未通过是「压根没收」。
 *    两者在流程图里是分开的，统计口径也不同，混用会让流失率虚高。
 * ============================================================ */

studentRouter.post(
  '/interview-result',
  validate(
    z.object({
      consultStudentId: z.string().min(1),
      accepted: z.coerce.boolean(),
      enrolled: z.coerce.boolean().optional(),
      reason: z.string().max(200).optional(),
    }),
  ),
  guardOwnStudent,
  wrap(async (req, res) => {
    const body = (req as any).validated as {
      consultStudentId: string;
      accepted: boolean;
      enrolled?: boolean;
      reason?: string;
    };
    const operator = req.user!;

    const stu = await findStudent(body.consultStudentId);
    if (!stu) throw new BizError(BizCode.STUDENT_NOT_FOUND, '学生不存在');

    // ★ 2026-10-08 防重护栏：面试结果只允许录入一次。
    //    只有「待面试」能录入；录过之后状态已流转，再打进来直接拒绝，
    //    从根上杜绝「重复面试」（对应流程图：面试后的判断点只走一遍）。
    if (stu.consult_state !== ConsultState.WAIT_INTERVIEW) {
      throw new BizError(
        BizCode.INVALID_STATUS,
        `该学生已录入过面试结果，无需重复面试（当前状态：${
          (CONSULT_STATE_NAME as any)[stu.consult_state] || stu.consult_state
        }）`,
      );
    }

    if (!body.accepted) {
      // 不收 → 未通过，明确不计入流失统计
      await changeState(body.consultStudentId, ConsultState.REJECTED, {
        byName: operator.userName,
        byTitle: operator.roleTitle,
        action: 'INTERVIEW_REJECT',
        historyText: `面试未通过，不予接收${body.reason ? `：${body.reason}` : ''}（不计入流失统计）`,
        extraFields: { loss_reason: body.reason || '面试未通过' },
      });
      res.json(ok(null, '已记录为「未通过」，不计入流失统计'));
      return;
    }

    // ★ 2026-10-08 口径：接收后当场确定「报名 / 未报名」，不再让学生停在待面试干等
    if (body.enrolled === false) {
      await changeState(body.consultStudentId, ConsultState.NOT_ENROLLED, {
        byName: operator.userName,
        byTitle: operator.roleTitle,
        action: 'NOT_ENROLLED',
        historyText:
          `面试通过但未当场报名${body.reason ? `：${body.reason}` : ''}` +
          '（进入「未报名·待跟进」，可取消，不计入流失率）',
        extraFields: { loss_reason: body.reason || '面试通过但未当场报名' },
      });
      res.json(ok(null, '已记录「未报名·待跟进」，可随时取消'));
      return;
    }

    // ★ 2026-10-08 面试通过 + 当场报名 → 流转到「咨询中」（缴费阶段）。
    //    状态离开「待面试」，前端「面试」按钮自然消失（杜绝重复面试）；
    //    下一步：到「收费与到账」发起试学费收费，到账后可分班进试学。
    await changeState(body.consultStudentId, ConsultState.TRIAL_FEE_PENDING, {
      byName: operator.userName,
      byTitle: operator.roleTitle,
      action: 'INTERVIEW_PASS',
      historyText:
        `面试通过，已确认当场报名，进入试学费缴费环节${body.reason ? `（${body.reason}）` : ''}` +
        '（请到「收费与到账」发起收费）',
    });
    res.json(ok(null, '已确认当场报名，请到「收费与到账」发起试学费收费'));
  }),
);

/* ============================================================
 * ★ 2026-10-05 新增：入班（咨询 → 班级管理）
 *    POST /api/consult/student/enroll-to-class
 *
 * 【业务背景】
 *   学生「分班」只是把班级名记在咨询这边（assignClass），
 *   班级管理模块（学管）那边**看不到任何东西** ——
 *   班主任的「待接收学员」页永远是空的（2026-10-05 联调发现）。
 *
 *   所以要有一个动作，把学员「推」到班级模块：班主任在
 *   「班级管理 → 待接收学员」里接收并补充信息（含宿舍床位）建档，
 *   建档后学生来源标记为「咨询同步」。
 *
 * 【为什么不直接建学生】
 *   班级归属、学号、床位要班主任来定，咨询侧只负责「交人」。
 *   真正的建档在 class 侧的 /api/class/consult/receive 里做。
 *
 * 【幂等】class 侧按 consult_no 去重，重复点「入班」不会重复推送。
 * ============================================================ */

/**
 * 入班推送单号（= class 侧的幂等键 consult_no）
 *
 * ⚠️ 优先用学号：三边（咨询/班级/教务）认人一律靠学号。
 *    学生还没学号时退回本表主键（同样稳定、唯一）。
 */
function consultNoOf(stu: Record<string, any>): string {
  const no = String(stu.student_no || '').trim();
  return no || String(stu.id);
}

studentRouter.get(
  '/open-classes',
  wrap(async (_req, res) => {
    // ★ 2026-10-05「分班」弹窗数据源：大学部 + 初高 两边「开放」班级聚合
    //   （内部接口经 classSync 带内部令牌拉取，前端不直连班级模块）
    const [univ, jh] = await Promise.all([
      classSync.classOpenOptions(),
      classSync.classJhOpenOptions(),
    ]);
    if (!univ.ok || !jh.ok) {
      const bad = !univ.ok ? '大学部' : '教学管理（初高）';
      throw new BizError(
        BizCode.DOWNSTREAM_ERROR,
        `获取${bad}开放班级失败：${(!univ.ok ? univ : jh).message}`,
      );
    }
    res.json(
      ok(
        { univ: univ.data ?? [], jh: jh.data ?? [] },
        '查询成功',
      ),
    );
  }),
);

/**
 * ★ 2026-10-06 分班状态（批量）—— 供「收款与缴费」页判定「分班」按钮可用性
 *
 * 用户口径：「咨询将学生分班之后就不能再将学生分派到其他班级，驳回之后可以」
 *   → 未分派 / 已驳回：可点「分班」
 *   → 待接收 / 已接收 / 初高已入班：不可再点
 *
 * 状态的权威源在接收方，这里实时去两边查一次（内部令牌，只读）。
 * 查不到（接收方不可用）时降级为 `unknown`，前端按「可点」显示 ——
 * 真正的拦截在后端 /enroll-to-class 里（双保险）。
 */
const assignStatusSchema = z.object({
  ids: z.array(z.string().min(1)).max(200, '一次最多查询 200 个学生'),
});

/** 分班状态机：none 未分派 / pending 待接收 / received 已接收 / rejected 已驳回 / jh 初高已入班 */
type AssignState = 'none' | 'pending' | 'received' | 'rejected' | 'jh' | 'unknown';

const ASSIGN_STATE_TEXT: Record<AssignState, string> = {
  none: '未分班',
  pending: '已推送，待班主任接收',
  received: '已接收（已入班）',
  rejected: '已被驳回，可重新分班',
  jh: '已进入初高班级',
  unknown: '分班状态未知',
};

studentRouter.post(
  '/assign-status',
  validate(assignStatusSchema),
  wrap(async (req, res) => {
    const { ids } = (req as any).validated as { ids: string[] };
    if (!ids.length) {
      res.json(ok({}, '查询成功'));
      return;
    }

    const rows = (await db(STUDENT_TABLE)
      .whereIn('id', ids)
      .select('id', 'student_no')) as Array<Record<string, any>>;

    // 学号优先作为跨模块认人键（与 /enroll-to-class 的 consultNoOf 完全一致）
    const noOf = new Map<string, string>();
    for (const r of rows) {
      const no = String(r.student_no || '').trim();
      noOf.set(String(r.id), no || String(r.id));
    }
    const nos = Array.from(new Set(Array.from(noOf.values())));

    // 两边并行查（任一失败都不影响另一端）
    const [univ, jh] = await Promise.all([
      classSync.consultStatus(nos),
      classSync.jhEnrolledStatus(nos),
    ]);
    const univMap = (univ.ok ? univ.data : {}) as Record<string, any>;
    const jhMap = (jh.ok ? jh.data : {}) as Record<string, any>;

    const out: Record<string, unknown> = {};
    for (const id of ids) {
      const no = noOf.get(id);
      if (!no) {
        out[id] = { state: 'unknown', label: ASSIGN_STATE_TEXT.unknown, canAssign: true };
        continue;
      }
      const u = univMap[no];
      const j = jhMap[no];

      let state: AssignState = 'none';
      let classId: string | null = null;
      let className: string | null = null;

      if (j) {
        state = 'jh';
        classId = (j.classId as string) ?? null;
        className = (j.className as string) ?? null;
      } else if (u) {
        const st = Number(u.applyStatus);
        state = st === 2 ? 'received' : st === 3 ? 'rejected' : 'pending';
        classId = (u.intendClassId as string) ?? null;
        className = (u.intendClassName as string) ?? null;
      } else if (!univ.ok && !jh.ok) {
        state = 'unknown';
      }

      out[id] = {
        state,
        label: ASSIGN_STATE_TEXT[state],
        classId,
        className,
        // 「已分班就不能再分派到其他班级，驳回之后可以」
        canAssign: state === 'none' || state === 'rejected' || state === 'unknown',
      };
    }

    res.json(ok(out, '查询成功'));
  }),
);

/** 后端二次拦截用的状态判定（与 /assign-status 同口径），返回阻断原因或 null */
async function assignBlockReason(stu: Record<string, any>): Promise<string | null> {
  const no = consultNoOf(stu);
  const [univ, jh] = await Promise.all([classSync.consultStatus([no]), classSync.jhEnrolledStatus([no])]);

  // ★ 2026-10-19：先看推送单（初高现在也走推送，pending/received 都在这里）
  const u = (univ.ok ? univ.data : {}) as Record<string, any>;
  const hit = u[no];
  if (hit) {
    const st = Number(hit.applyStatus);
    if (st === 2) {
      return `「${stu.student_name}」已被班主任接收并入班「${hit.intendClassName ?? ''}」，不能再分派到其他班级；如需换班请联系学管`;
    }
    if (st === 1) {
      return `「${stu.student_name}」已分班到「${hit.intendClassName ?? ''}」，正在等待班主任接收，不能重复分派；如要改派请先让该班班主任驳回`;
    }
    // st === 3（已驳回）→ 放行，允许重新分派
  }

  // 历史上「初高直建入班」的老数据没有推送单 → 仍按初高学籍表兜底拦一次
  const j = (jh.ok ? jh.data : {}) as Record<string, any>;
  if (j[no]) {
    return `「${stu.student_name}」已进入教学管理（初高）「${j[no].className ?? '对应班级'}」，不能再分派到其他班级；如需换班请先在初高侧处理`;
  }
  return null;
}

/**
 * 全款是否已缴清 —— 已抽到 `services/fee-order.service#isFullFeeSettled`
 *
 * ★ 2026-10-20：接收建档（class 侧 doReceive）也要问同一个判断，
 *   放在 service 里两边共用，避免两套口径打架。
 */

studentRouter.post(
  '/enroll-to-class',
  validate(
    z.object({
      id: z.string().min(1, '缺少学生ID'),
      /** ★ 2026-10-05 分班：目标班级 ID（收款与缴费「已缴」行点「分班」时必传） */
      classId: z.string().optional(),
      /** ★ 目标模块：'class'=大学部（走待接收，班主任同意后入班）/ 'class-jh'=初高（直接入班） */
      module: z.enum(['class', 'class-jh']).optional(),
    }),
  ),
  guardOwnStudent,
  wrap(async (req, res) => {
    const { id, classId, module } = (req as any).validated as {
      id: string;
      classId?: string;
      module?: 'class' | 'class-jh';
    };
    const operator = req.user!;

    const stu = await findStudent(id);
    if (!stu) throw new BizError(BizCode.STUDENT_NOT_FOUND, '学生不存在');

    // ---- ★ 2026-10-09 退费中的/已退费的学生不可再分班 ----
    //    用户口径：已经退费是不可以再分班的（收款单还是「已到账」，但人已经退出流程）
    //    ★ 2026-10-15 财务退款后学生流转为「流失」，流失学生同样不允许再分班
    const REFUND_BLOCK_STATES = [
      ConsultState.REFUND_MGR,
      ConsultState.REFUND_FINANCE,
      ConsultState.REFUNDED,
      ConsultState.LOST,
    ];
    if (REFUND_BLOCK_STATES.includes(stu.consult_state)) {
      throw new BizError(
        BizCode.INVALID_STATUS,
        `「${stu.student_name}」当前状态为「${
          (CONSULT_STATE_NAME as any)[stu.consult_state] || stu.consult_state
        }」，退费流程中/已退费/流失的学生不能再分班`,
      );
    }

    const consultNo = consultNoOf(stu);

    // ---- ★ 分班模式（传了 classId）：必须已缴（至少一笔收款单「已到账」） ----
    if (classId) {
      const paid = await db(FEE_ORDER_TABLE)
        .where({ consult_student_id: id, status: ConsultFeeStatus.ARRIVED, is_deleted: false })
        .first();
      if (!paid) {
        throw new BizError(
          BizCode.INVALID_STATUS,
          `「${stu.student_name}」还没有已缴的收款记录，缴费状态为「已缴（已到账）」后才能分班`,
        );
      }

      // ★ 2026-10-06 用户口径：分过班就不能再分派到其他班级（驳回之后可以）
      //   前端按钮会置灰，这里是**后端二次拦截** —— 防止直接调接口绕过。
      const blocked = await assignBlockReason(stu);
      if (blocked) throw new BizError(BizCode.INVALID_STATUS, blocked);
    }

    /* ---- 分流：初高 / 大学部 都推「待接收学员」，由对应学段的班主任接收 ----
     *
     * ★ 2026-10-20 最终口径（用户确认，两个学段统一）：
     *   「初高班主任在班级侧点了接收之后，系统会在初高学籍表建档，并回写咨询侧状态。
     *     大学侧和初高中一样，都需要老师接收之后入班」
     *
     *   → 咨询侧**只负责交人**：推送一条「待接收」单，不建档、不推进状态。
     *     建档 + 回写状态统一在 class 侧 `doReceive` 里做（见 consult.route.ts）：
     *       接收 → 建档（学籍按钱落到「试学中 / 正式在读」）→ 调咨询内部接口回写状态。
     *
     *   ⚠️ 不要在这里恢复「分班即入班」（auto-receive）：
     *      那会让班主任看不到人就被动入班，与本次口径相反。
     */
    let result;
    let msg: string;

    /**
     * 目标班属于哪个学段 / 叫什么
     *
     * ⚠️ 不能用 `stu.dept_code` 兜底 —— 那是**学生自己的部门**，
     *    咨询库里一个初高意向的学生可以被分到大学班（实测踩过：
     *    dept_code=1 的学生分到 U2601，推送单标成初高 → 接收端跑去初高库找人
     *    → 「目标班级不存在」）。
     *   所以两个学段的开放班级都查一遍，**以班级实际归属为准**。
     */
    let targetName: string | null = null;
    let targetDept: number | null = null;
    if (classId) {
      const [jhOpt, univOpt] = await Promise.all([
        classSync.classJhOpenOptions(),
        classSync.classOpenOptions(),
      ]);
      const jhHit = ((jhOpt.data as any[]) || []).find((c: any) => c.classId === classId);
      if (jhHit) {
        targetName = jhHit.className ?? null;
        targetDept = 1;
      } else {
        const univHit = ((univOpt.data as any[]) || []).find((c: any) => c.id === classId);
        if (univHit) {
          targetName = univHit.className ?? null;
          targetDept = 2;
        }
      }
    }
    const isJhTarget = targetDept === 1;

    result = await classSync.consultPush([
      {
        consultNo,
        studentName: stu.student_name,
        gender: stu.gender ?? null,
        phone: stu.phone || null,
        parentPhone: stu.parent_phone || null,
        age: stu.age ?? null,
        // 学历字段咨询侧没有，留空由班主任接收时补
        origin: stu.source_remark || null,
        graduateSchool: stu.school || null,
        homeAddress: stu.address || null,
        // ★ 目标学段：初高 1 / 大学部 2（接收端据此决定往哪个库建档）
        //   以「目标班级实际归属」为准，查不到才退回学生自己的部门
        intendDeptCode: targetDept ?? (stu.dept_code ?? null),
        intendClassId: classId ?? (stu.class_id || null),
        intendClassName: targetName ?? (stu.class_name || null),
        remark: stu.remark || null,
        pushTime: formatTime(new Date()),
        // ★ 2026-10-19：「意向阶段」已删除，不再往推送单里塞 intendStage
      },
    ]);

    // 用户点出来的动作 → 失败必须让他知道（不能像财务那样静默记日志）
    if (!result.ok) {
      throw new BizError(
        BizCode.DOWNSTREAM_ERROR,
        `推送到班级管理失败：${result.message}。请确认班级管理模块已启动（CLASS_URL），或联系学管模块负责人。`,
      );
    }

    /* ---- ★ 2026-10-20 两个学段完全统一：分班 = 推「待接收」，入班在接收端 ----
     *
     *   咨询侧到这里就结束了：**不建档、不推进咨询状态**。
     *   学生什么时候真正入班、咨询状态什么时候从「待分班」走到「试学中 / 正式在读」，
     *   统一由 class 侧班主任点「接收」时触发（见 class/modules/consult/consult.route.ts
     *   的 doReceive：建档 + 调 /internal/receive-ack 回写咨询状态）。
     *
     *   ⚠️ 不要再加「大学部分班即入班」的分支 —— 2026-10-20 用户明确要求
     *      「大学侧和初高中一样，都需要老师接收之后入班」。
     */
    const inserted = Number(result.data?.inserted ?? 0);
    const skipped = Number(result.data?.skipped ?? 0);
    const reopened = Number(result.data?.reopened ?? 0);
    const where = isJhTarget ? '教学管理（初高）' : '班级管理（大学部）';
    msg = reopened > 0
      ? `已把「${stu.student_name}」重新推送到${where}的「待接收学员」（原驳回单已重新激活），请班主任重新接收`
      : inserted > 0
        ? `已把「${stu.student_name}」推送到${where}的「待接收学员」，请班主任接收并建档`
        : `「${stu.student_name}」已在${where}的「待接收学员」里了（未重复推送）`;

    await addHistory(id, operator.userName, `分班：${msg}`, operator.roleTitle, 'ENROLL_TO_CLASS');

    /* ---- ★ 2026-10-16 分期：首付到账即可分班，但尾款没缴清的要提醒 ----
     *
     *    用户口径：分期的学生首付到账就能分班，尾款挂在待缴余额里继续收。
     *    这里在分班历史后面补一条欠费提醒，避免老师忘了还有钱没收。
     */
    const arrear = Number(stu.arrear_amount || 0);
    if (arrear > 0) {
      await addHistory(
        id,
        operator.userName,
        `该学生为分期缴费，尚有尾款 ¥${(arrear / 100).toFixed(2)} 未缴清，请跟进催收`,
        operator.roleTitle,
        'CHARGE',
      );
    }

    // ---- 分班后把目标班级记回咨询侧（学生列表/缴费单可见） ----
    if (classId) {
      await db(STUDENT_TABLE)
        .where({ id })
        .update({ class_id: classId, class_name: targetName, update_time: new Date() });
    }

    /* ---- ★ 2026-10-20 状态推进挪到「接收」时刻 ----
     *
     *   之前大学部是分班即入班，所以在这里把状态从「待分班(4)」推到
     *   「试学中(5) / 正式在读(7)」。现在两个学段都等班主任接收后才入班，
     *   人还没进班就把状态改了会出现「试学中但班级里没有这个人」，
     *   所以状态的推进统一在 class 侧接收成功后回调
     *   `/api/consult/student/internal/receive-ack` 完成。
     */

    res.json(ok({ consultNo, inserted, skipped, reopened, duplicate: false }, msg));
  }),
);

export default studentRouter;
