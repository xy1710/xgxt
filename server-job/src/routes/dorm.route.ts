/**
 * 宿舍管理 路由（就业管理 > 实训阶段）
 *
 * 接口前缀：/api/job/dorm
 * 表：t_job_dorm（宿舍主档）+ t_job_dorm_bed（床位）+ t_job_dorm_change（调换/退宿申请）
 * 字段依据：斌哥 2026-09-30 拍板
 *
 * ============================================================
 * 【业务规则（斌哥 2026-09-30 拍板）】
 * ============================================================
 *   1. 宿舍主档【本模块自建】（不存在教务，独立跑通）
 *   2. 调换宿舍、退宿【都走审批】，审批人 = 教务老师（ROLE_EDU_ADMIN，1 步）
 *   3. 发起人 = 班主任
 *
 *   调换宿舍：班主任发起（选学生 + 新床位）→ 教务审批 → 通过
 *   退宿：    班主任发起（选学生）           → 教务审批 → 通过
 *
 * ============================================================
 * 【★ 审批通过后做什么（同一事务）】
 * ============================================================
 *   调换：
 *     ① 旧床位释放（bed_status=1 空闲，清 student_*）
 *     ② 新床位占用（bed_status=2 已占用，写 student_*）
 *     ③ 学生主档 dorm_id / dorm_no 改成新宿舍
 *     ④ 两端宿舍 used_count 重算
 *   退宿：
 *     ① 当前床位释放
 *     ② 学生主档 dorm_id / dorm_no 置空
 *     ③ 宿舍 used_count 重算
 *
 * ============================================================
 * 【★ 权限控制（双层）】
 * ============================================================
 *   前端：canApprove / canCancel 由后端算，控制按钮显隐
 *   后端：/approve 里 canApprove() 拦人（返回 40302）
 *   教务老师只能批自己的那条链；班主任看不到审批按钮。
 *
 * ⚠️ 铁律：逻辑删除，禁物理删除。
 * ⚠️ 铁律：枚举双返回（dormGender + dormGenderName）。
 */

import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import {
  BizCode,
  ApprovalBizType,
  ApprovalStatus,
  APPROVAL_STATUS_NAME,
  getApprovalChain,
  DormChangeBizType,
  DORM_CHANGE_BIZ_TYPE_NAME,
  // DORM_CHANGE_NO_PREFIX 已随「单号」一起废弃（斌哥 2026-09-30）
  DormStatus,
  DORM_STATUS_NAME,
  DormBedStatus,
  DORM_BED_STATUS_NAME,
  DormType,
  DORM_GENDER_NAME,
  GENDER_NAME,
  DEPT_NAME,
  StudentStatus,
  STUDENT_STATUS_NAME,
  canApprove,
  canInitiate,
  isFinished,
  RoleCode,
  isMyApproval,
  hasRole,
  ClassStatus,
} from 'shared-types';
// ★ 床位「上/下铺」文字规则与大学部/教务共用同一份（避免三个模块各写一份必然分叉）
import { bedNoText, bedLabel } from 'shared-types/class';
import { ok, page } from '../utils/response';
import { db } from '../utils/db';
import { wrap } from '../utils/wrap';
import { today, fmtDate, fmtDateTime } from '../utils/date';
import { validate } from '../middleware/validate';
import { BizError } from '../middleware/errorHandler';
import { sendNotice, NOTICE_TYPE } from '../utils/notice';
import {
  createApproval,
  submitApproval,
  doApprove,
  doReject,
  doCancel,
  getApprovalLogs,
  buildChainNodes,
  getApproval,
  type Operator,
} from '../utils/approval';
// ★ 2026-10-03：申请单同步到「教务管理 → 宿舍管理 → 申请审批」
import { syncApplyToEdu, cancelEduApply } from '../utils/dormBridge';
// ★ P3 切读层：本文件 6 张老表全部已归一，读写走 tbl()/tblTrx()/tblInsTrx()；
//   两张表以上 join 的查询用 tblAs()（from 侧）+ tblRef()（被 join 侧）。
//   开关关（默认）时行为与改造前等价。
import { tbl, tblTrx, tblInsTrx, tblAs, tblRef } from '../teaching/shared/uniTable';

export const dormRouter = Router();

/** 表名常量 */
const DORM_TABLE = 't_job_dorm';
const BED_TABLE = 't_job_dorm_bed';
const CHANGE_TABLE = 't_job_dorm_change';
const STUDENT_TABLE = 't_student_base';
const CLASS_TABLE = 't_job_class';

/** ★ 统一表 edu_stage 取值 / 老表所在库（本路由只服务实训） */
const STAGE = 'job' as const;
const DB = 'sms_job';

/**
 * ★ 班级库（大学部）的学生表 —— 跨库全限定名（2026-10-05 斌哥报「已退宿却还占着床」）
 *
 * 【为什么需要它】
 *   同一个学号在三处各有一份行。**换宿/退宿原来只改了 sms_job 这一份**：
 *     · sms_job.t_student_base.dorm_id / dorm_no   ← 退宿时清空了 ✅
 *     · sms_job.t_job_dorm_bed                ← 床位释放了 ✅
 *     · sms_class.t_class_student 的 dorm_building/dorm_no/bed_no ← **还挂着床** ❌
 *   而「宿舍总名单」里大学部那一路**正是从 class 库的学生字段动态聚合出来的**
 *   → 已退宿的学生仍然显示占着床。
 *
 * 【与退学状态那次是同一个病根】
 *   退学（studentLeave.route.ts 的 syncStatusToClassDB）只同步了 `student_status`，
 *   没同步宿舍字段；退宿（这里）连状态带床位一起漏了。
 *   **三处数据要一起动，漏一处就会从另一条路冒出来。**
 *
 * 【同实例跨库】
 *   三个库在同一个 MySQL 实例 → 用全限定名 + 调用方传的同一个 trx，
 *   「改我们这边 + 改班级库那边」在同一事务里，要么都成、要么都滚。
 *
 * ★ P3 切读层：老写法是「库.表」字符串 `sms_class.t_class_student`，
 *   `tblTrx()` 要把「库名 + 表名」分开传，所以拆成下面两个常量。
 */
const CLASS_DB = 'sms_class';
const CLASS_DB_STUDENT = 't_class_student';
/** 班级库（大学部）的学段 = 大学 */
const CLASS_DB_STAGE = 'class' as const;

/**
 * 把宿舍信息**同步到班级库**（换宿改地址 / 退宿清空都走这里）
 *
 * ⚠️ 为什么按学号匹配而不是 id：两个库的 id 各自生成，**同一个人两边 id 不同**（实测），
 *    唯一能对上的就是 `student_no`（学号）。
 *
 * ⚠️ class 库是「宿舍字段直接存在学生行上」的（没有房间表/床位表），
 *    所以换宿/退宿要改的就是它那三个字段：dorm_building / dorm_no / bed_no，
 *    顺带把 dorm_id 也置空（它指向的 D1 之类是大学部自己的宿舍主档）。
 *
 * @param patch  要改的字段；退宿传 { dorm_id:null, dorm_building:null, dorm_no:null, bed_no:null }
 * @returns 实际更新了几行（0 = 班级库里没有这个人，属正常）
 */
async function syncDormToClassDB(
  trx: any,
  studentNo: string | null | undefined,
  patch: Record<string, any>,
  operator: Operator,
): Promise<number> {
  if (!studentNo) return 0;
  const n = await tblTrx(trx, CLASS_DB, CLASS_DB_STUDENT, CLASS_DB_STAGE)
    .where({ student_no: studentNo, is_deleted: false })
    .update({
      ...patch,
      update_time: new Date(),
      update_by: operator.userId || 'system',
    });
  return n;
}

/** 可发起调换/退宿的学生状态（在校生都行）*/
const ALLOW_INITIATE_STATUS: number[] = [
  StudentStatus.TRIAL,      // 试学中
  StudentStatus.PRE_STUDY,  // 预在读
  StudentStatus.STUDYING,   // 正式在读
  StudentStatus.TRAINING,   // 实训中
];

/* ============================================================
 * 内部工具
 * ============================================================ */

/**
 * ★ 第 i 个床位（从 1 开始）→ 床位号文本
 *
 * 宿舍是**上下铺**，床位号要能看出上/下（斌哥 2026-10-01）：
 *   1 → 1-上   2 → 1-下   3 → 2-上   4 → 2-下
 * 规则：**奇数 = 上铺，偶数 = 下铺**；同一编号共用一个床架。
 *
 * ★ 2026-10-04：实现挪到 `shared-types/class` 的 `bedNoText()` 了。
 *   原因是同一套「奇上偶下」的规则现在有**三个模块**要用
 *   （大学部花名册 / 教务宿舍 / 实训宿舍），各写一份必然分叉
 *   ——之前就分叉过一次（大学部显示 `301-1-上`、这里显示裸数字 1）。
 *   这里只留一个薄壳，建床位时顺手调用。
 */
function bedNoOf(i: number): string {
  return bedNoText(i);
}

function getOperator(req: any): Operator {
  const u = req.user || {};
  return {
    userId: u.userId || u.id || '',
    userName: u.userName || u.name || '',
    roles: u.roles || [],
  };
}

/** 重算某宿舍的已住人数 */
async function recalcUsedCount(trx: any, dormId: string): Promise<void> {
  const row = await tblTrx(trx, DB, BED_TABLE, STAGE)
    .where({ dorm_id: dormId, bed_status: DormBedStatus.USED, is_deleted: false })
    .count({ c: '*' })
    .first();
  await tblTrx(trx, DB, DORM_TABLE, STAGE).where({ id: dormId }).update({ used_count: Number(row?.c) || 0 });
}

/** 宿舍行 → 输出结构（含双返回 + 空余床位数）*/
function decorateDorm(row: any): any {
  if (!row) return row;
  const bedCount = row.bed_count ?? 0;
  const usedCount = row.used_count ?? 0;
  return {
    id: row.id,
    dormNo: row.dorm_no,
    building: row.building,
    roomNo: row.room_no,
    bedCount,
    usedCount,
    freeCount: Math.max(bedCount - usedCount, 0),
    dormGender: row.dorm_gender,
    dormGenderName: DORM_GENDER_NAME[row.dorm_gender] || '',
    deptCode: row.dept_code ?? null,
    deptName: row.dept_code ? DEPT_NAME[row.dept_code] || null : null,
    dormStatus: row.dorm_status,
    dormStatusName: DORM_STATUS_NAME[row.dorm_status] || '',
    facility: row.facility || null,
    remark: row.remark || null,
    createTime: fmtDateTime(row.create_time),
    updateTime: row.update_time,
  };
}

/** 床位行 → 输出结构 */
function decorateBed(row: any): any {
  return {
    id: row.id,
    dormId: row.dorm_id,
    dormNo: row.dorm_no,
    bedNo: row.bed_no,
    /**
     * ★ 床位的「上/下铺」文字（`1上` / `1下`）—— 跟大学部教务宿舍同一套说法
     *
     * 【为什么不直接改 bedNo】
     *   `t_job_dorm_bed.bed_no` 是 **integer**（1/2/3/4），存的是序号，
     *   排序、比对、生成床架都靠它。改成字符串会连带一堆计算逻辑坏掉。
     *   所以库里继续存数字，出参再翻译成文字 —— 前端爱显示哪个用哪个。
     *
     * 【规则必须共用】
     *   奇数 = 上铺，偶数 = 下铺；与迁移 `20261001_012` 的数据转换、
     *   以及 shared-types/class 的 `bedNoText()` 保持一致。
     *   三处各写一份必然分叉，所以这里一律调共享函数。
     */
    bedNoText: bedNoText(row.bed_no),
    /** 完整标签：`301-1上`，前端表格一个字段直接显示 */
    bedLabel: bedLabel(row.dorm_no, row.bed_no),
    bedStatus: row.bed_status,
    bedStatusName: DORM_BED_STATUS_NAME[row.bed_status] || '',
    studentId: row.student_id || null,
    studentNo: row.student_no || null,
    studentName: row.student_name || null,
    studentGender: row.student_gender ?? null,
    checkInDate: fmtDate(row.check_in_date),
    remark: row.remark || null,
  };
}

/**
 * 申请单行 → 输出结构
 * @param row         业务行
 * @param appr        审批单（可选）
 * @param operator    当前登录人（算 canApprove / canCancel）
 */
/**
 * 宿舍「待审批中」该显示什么文案
 *
 * ⚠️ 通用枚举 APPROVAL_STATUS_NAME[PENDING_MANAGER] = 「待学管审批」，
 *    但宿舍的审批人**只有教务老师**，跟学管（教质/学术经理）没关系，
 *    直接显示会误导人。
 *    所以「待审批中」统一用审批链配置里的 hint（=「待教务审批」），
 *    其余状态（已通过 / 已驳回 / 已撤销 / 待提交）照旧。
 *
 * ★ 想改文案 → 改 shared-types/src/approval.ts 里 DORM_CHANGE 的 hint，别硬编码在这里。
 */
const DORM_PENDING_HINT =
  getApprovalChain(ApprovalBizType.DORM_CHANGE)?.nodes[0]?.hint || '待审批中';

function dormStatusName(status: number, hint?: string | null): string {
  if (status === ApprovalStatus.PENDING_MANAGER) return hint || DORM_PENDING_HINT;
  return APPROVAL_STATUS_NAME[status] || '';
}

function decorateChange(row: any, appr: any, operator: Operator): any {
  const step = appr?.current_step || 1;
  const roles = operator.roles || [];
  const bizType = row.biz_type === DormChangeBizType.CHANGE ? ApprovalBizType.DORM_CHANGE : ApprovalBizType.DORM_CHANGE;

  const finished = isFinished(appr?.status ?? 0);
  const canApproveIt =
    !!appr &&
    appr.status !== ApprovalStatus.DRAFT &&
    !finished &&
    canApprove(bizType, step, roles);

  // ★ isMyApproval：本人发起才归我管；万能测试号（SUPER_TEST）全放行
  const mine = isMyApproval(appr, operator.userId, operator.roles);
  const canCancelIt = !!appr && !finished && appr.status !== ApprovalStatus.DRAFT && mine;

  // ★ 提交：状态是「待提交（草稿）」+ 本人发起（2026-10-01 新增）
  //   班级结业时自动生成的退宿申请会落在这个状态 —— 必须有入口让班主任提交，
  //   否则单子永远躺在草稿里，教务老师也看不到。
  const canSubmitIt = !!appr && appr.status === ApprovalStatus.DRAFT && mine;

  return {
    id: row.id,
    bizType: row.biz_type,
    bizTypeName: DORM_CHANGE_BIZ_TYPE_NAME[row.biz_type] || '',

    studentId: row.student_id,
    studentNo: row.student_no || null,
    studentName: row.student_name || null,
    gender: row.gender ?? null,
    genderName: row.gender ? GENDER_NAME[row.gender] || '' : '',

    className: row.class_name || null,
    deptCode: row.dept_code ?? null,
    deptName: row.dept_code ? DEPT_NAME[row.dept_code] || null : null,
    headTeacherId: row.head_teacher_id || null,
    headTeacherName: row.head_teacher_name || null,

    oldDormNo: row.old_dorm_no || null,
    oldBedNo: row.old_bed_no ?? null,
    newDormNo: row.new_dorm_no || null,
    newBedNo: row.new_bed_no ?? null,

    changeDate: fmtDate(row.change_date),
    changeReason: row.change_reason,
    headTeacherOpinion: row.head_teacher_opinion || null,

    approvalId: row.approval_id || null,
    approvalStatus: row.approval_status,
    approvalStatusName: dormStatusName(row.approval_status, appr?.current_handler_hint),
    currentStep: appr?.current_step ?? null,
    currentHandlerHint: appr?.current_handler_hint || null,

    canApprove: canApproveIt,
    canCancel: canCancelIt,
    canSubmit: canSubmitIt,

    remark: row.remark || null,
    createTime: fmtDateTime(row.create_time),
  };
}

/**
 * ★★ 审批全部通过后的动作（调换 / 退宿 各不同）
 *
 * ⚠️ 必须和审批状态更新在【同一个事务】里 ——
 *    要么床位改了 + 学生也动了，要么都别动。
 */
export async function afterApproved(trx: any, row: any, operator: Operator): Promise<void> {
  const isChange = row.biz_type === DormChangeBizType.CHANGE;
  const now = new Date();

  // ---- ① 释放【原】床位 ----
  if (row.old_bed_id) {
    await tblTrx(trx, DB, BED_TABLE, STAGE).where({ id: row.old_bed_id, is_deleted: false }).update({
      bed_status: DormBedStatus.FREE,
      student_id: null,
      student_no: null,
      student_name: null,
      student_gender: null,
      check_in_date: null,
      update_time: now,
      update_by: operator.userId,
    });
  }

  if (isChange) {
    // ---- ② 占用【新】床位 ----
    if (!row.new_bed_id) {
      throw new BizError(BizCode.PARAM_ERROR, '调换宿舍缺少新床位信息');
    }
    const target = await tblTrx(trx, DB, BED_TABLE, STAGE).where({ id: row.new_bed_id, is_deleted: false }).first();
    if (!target) throw new BizError(BizCode.DORM_BED_NOT_FOUND, '目标床位不存在');
    if (target.bed_status === DormBedStatus.USED) {
      throw new BizError(BizCode.DORM_BED_OCCUPIED, `床位 ${target.dorm_no}-${target.bed_no} 已被占用`);
    }
    await tblTrx(trx, DB, BED_TABLE, STAGE).where({ id: row.new_bed_id }).update({
      bed_status: DormBedStatus.USED,
      student_id: row.student_id,
      student_no: row.student_no,
      student_name: row.student_name,
      student_gender: row.gender,
      check_in_date: today(),
      update_time: now,
      update_by: operator.userId,
    });

    // ---- ③ 学生主档 → 新宿舍 ----
    await tblTrx(trx, DB, STUDENT_TABLE, STAGE).where({ id: row.student_id }).update({
      dorm_id: row.new_dorm_id,
      dorm_no: row.new_dorm_no,
      update_time: now,
      update_by: operator.userId,
    });

    // ★★ 2026-10-05 同步班级库：换宿只改实训库的话，大学部那一路
    //   （宿舍总名单就是从 class 库学生字段聚合出来的）仍显示旧宿舍 → 同一人两处不一致。
    //   ⚠️ 跨库地址字段在 class 库里是「写在学生行上」的，床位序号沿用新建单时的值；
    //   这里只搬「楼栋+房号」，床位由班级侧后续分配，避免猜错占位。
    const newRoom = isChange
      ? await tblTrx(trx, DB, DORM_TABLE, STAGE).where({ id: row.new_dorm_id }).first()
      : null;
    if (newRoom) {
      await syncDormToClassDB(
        trx,
        row.student_no,
        {
          dorm_id: null, // class 库的 dorm_id 指向大学部自己的宿舍主档，换宿时先置空
          dorm_building: newRoom.building ?? null,
          dorm_no: newRoom.room_no ?? newRoom.dorm_no ?? null,
        },
        operator,
      );
    }
  } else {
    // ---- 退宿：③ 学生主档清空宿舍 ----
    await tblTrx(trx, DB, STUDENT_TABLE, STAGE).where({ id: row.student_id }).update({
      dorm_id: null,
      dorm_no: null,
      update_time: now,
      update_by: operator.userId,
    });

    // ★★ 2026-10-05 同步班级库清空（斌哥报「已退宿，教务还记录着床铺」）
    //   不清的话：宿舍总名单里大学部那一路仍显示他占着 3号楼/301/床2
    //   —— 那是**从 class 库学生字段动态聚合出来的**，不是床位表，绕不过去。
    //   与退学的 syncStatusToClassDB 同一个跨库事务口径。
    await syncDormToClassDB(
      trx,
      row.student_no,
      { dorm_id: null, dorm_building: null, dorm_no: null, bed_no: null },
      operator,
    );
  }

  // ---- ④ 重算两端宿舍 used_count ----
  if (row.old_dorm_id) await recalcUsedCount(trx, row.old_dorm_id);
  if (isChange && row.new_dorm_id) await recalcUsedCount(trx, row.new_dorm_id);

  // ---- ⑤ 通知班主任（结果反馈）----
  try {
    const action = isChange ? '调换宿舍' : '退宿';
    await sendNotice(
      {
        noticeType: NOTICE_TYPE.APPROVAL,
        title: `【${action}已通过】${row.student_name || ''}`,
        content:
          `${row.student_name || ''}（${row.student_no || ''}）的${action}申请已审批通过。` +
          (isChange
            ? `宿舍已由 ${row.old_dorm_no || '—'} 调整为 ${row.new_dorm_no || '—'}。`
            : `已办理退宿（原宿舍 ${row.old_dorm_no || '—'}）。`),
        receiverId: row.head_teacher_id || RoleCode.TEACH_HEAD,
        receiverName: row.head_teacher_name || '班主任',
        receiverRole: RoleCode.TEACH_HEAD,
        bizType: ApprovalBizType.DORM_CHANGE,
        bizId: row.id,
        classId: row.class_id,
        className: row.class_name,
        studentId: row.student_id,
        studentName: row.student_name,
      },
      trx,
    );
  } catch {
    // 通知失败不阻断主流程
  }
}

/* ============================================================
 * 1. 宿舍列表
 *    GET /api/job/dorm/page
 * ============================================================ */

const dormListSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(200).default(20),
  keyword: z.string().optional(),
  building: z.string().optional(),
  dormGender: z.coerce.number().int().optional(),
  dormStatus: z.coerce.number().int().optional(),
  deptCode: z.coerce.number().int().optional(),
  onlyFree: z.coerce.boolean().optional(),
});

/* ============================================================
 * ★ 入住明细（按学生看）
 *    GET /api/job/dorm/student-bed/page
 *
 * 斌哥 2026-09-30：宿舍主档加一个「按学生」视角 ——
 *   房间视角回答"这间房还有几张空床"，学生视角回答"张三住哪"。
 *
 * 数据来源：床位表里已经冗余了学生信息（student_id/no/name/gender/check_in_date），
 *   班级名要连学生主档 → 班级表。
 * ============================================================ */
const studentBedSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(200).default(20),
  keyword: z.string().optional(),
  classId: z.string().optional(),
  dormId: z.string().optional(),
});

dormRouter.get(
  '/student-bed/page',
  validate(studentBedSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated;
    const operator = getOperator(req);

    const base = tblAs(db, DB, BED_TABLE, STAGE, 'b')
      .where('b.is_deleted', false)
      .whereNotNull('b.student_id')
      .leftJoin(`${tblRef(DB, STUDENT_TABLE)} as s`, 'b.student_id', 's.id')
      .leftJoin(`${tblRef(DB, CLASS_TABLE)} as c`, 's.class_id', 'c.id')
      // 楼栋在宿舍主档上（床位表只有宿舍号）
      .leftJoin(`${tblRef(DB, DORM_TABLE)} as d`, 'b.dorm_id', 'd.id');

    if (q.dormId) base.andWhere('b.dorm_id', q.dormId);
    if (q.classId) base.andWhere('s.class_id', q.classId);
    if (q.keyword) {
      base.andWhere((k: any) => {
        k.where('b.student_name', 'like', `%${q.keyword}%`)
          .orWhere('b.student_no', 'like', `%${q.keyword}%`)
          .orWhere('b.dorm_no', 'like', `%${q.keyword}%`);
      });
    }

    // ★ 数据范围（2026-10-08 修）
    //   原来是「班主任只看自己带的班」，**漏了项目经理** ——
    //   于是项目经理登录后能看到全校所有床位（越权）。
    //   现在按角色只走一条分支：
    //     · 项目经理 → 只看自己带的实训班（t_job_class.project_manager_id）
    //     · 班主任   → 只看自己带的大学部班（t_class_info.head_teacher_id）
    //     · 其他（学管/校长/管理员/教务）→ 不限
    const _r = operator.roles;
    const _isAdmin = hasRole(_r, RoleCode.SYS_ADMIN);
    const _isPM = hasRole(_r, RoleCode.PROJECT_MANAGER);
    const _isHead = hasRole(_r, RoleCode.TEACH_HEAD);
    if (!_isAdmin && _isPM) {
      // 项目经理：只认自己带的实训班（c 就是 t_job_class 的别名）
      //   ⚠️ 未结业的班才算「当前归我带」，口径与 stageScope.myTrainingClassIds 一致
      base.andWhere('c.project_manager_id', operator.userId);
      base.andWhereNot('c.class_status', ClassStatus.GRADUATED);
    } else if (!_isAdmin && _isHead && !_isPM) {
      base.andWhere('c.head_teacher_id', operator.userId);
    }

    const [{ total }] = await base.clone().count({ total: '*' });

    const rows = await base
      .clone()
      .select(
        'b.id',
        'b.dorm_id',
        'b.dorm_no',
        'b.bed_no',
        'b.student_id',
        'b.student_no',
        'b.student_name',
        'b.student_gender',
        'b.check_in_date',
        'c.class_name',
        'c.dept_code',
        'd.building',
      )
      .orderBy('b.dorm_no', 'asc')
      .orderBy('b.bed_no', 'asc')
      .limit(q.size)
      .offset((q.page - 1) * q.size);

    res.json(
      page(
        rows.map((r: any) => ({
          id: r.id,
          dormId: r.dorm_id,
          dormNo: r.dorm_no,
          bedNo: r.bed_no,
          // ★ 上/下铺文字（`1-上`）—— 前端入住明细表直接显示
          bedNoText: bedNoText(r.bed_no),
          studentId: r.student_id,
          studentNo: r.student_no,
          studentName: r.student_name,
          gender: r.student_gender,
          // ⚠️ 这里要的是「学生性别」（男/女），不是「宿舍性别」（男生宿舍/女生宿舍）——
          //    用 DORM_GENDER_NAME 会显示成"女生宿舍"，列宽不够还被截断。
          genderName:
            r.student_gender === 1 ? '男' : r.student_gender === 2 ? '女' : '',
          checkInDate: fmtDate(r.check_in_date),
          className: r.class_name || null,
          deptCode: r.dept_code ?? null,
          deptName: DEPT_NAME[r.dept_code] || null,
          /** 楼栋（宿舍主档上的） */
          building: r.building || null,
        })),
        Number(total),
        q,
      ),
    );
  }),
);

dormRouter.get(
  '/page',
  validate(dormListSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated;
    const base = tbl(db, DB, DORM_TABLE, STAGE).where('is_deleted', false);

    if (q.keyword) {
      base.andWhere((b: any) => {
        b.where('dorm_no', 'like', `%${q.keyword}%`)
          .orWhere('building', 'like', `%${q.keyword}%`)
          .orWhere('room_no', 'like', `%${q.keyword}%`);
      });
    }
    if (q.building) base.andWhere('building', q.building);
    if (q.dormGender !== undefined) base.andWhere('dorm_gender', q.dormGender);
    if (q.dormStatus !== undefined) base.andWhere('dorm_status', q.dormStatus);
    if (q.deptCode !== undefined) base.andWhere('dept_code', q.deptCode);
    if (q.onlyFree) base.andWhereRaw('used_count < bed_count');

    const [{ c: total }] = (await base.clone().count({ c: '*' })) as Array<{ c: number }>;
    const rows = await base
      .clone()
      .orderBy([{ column: 'building', order: 'asc' }, { column: 'room_no', order: 'asc' }])
      .limit(q.size)
      .offset((q.page - 1) * q.size);

    res.json(page(rows.map(decorateDorm), Number(total), q));
  }),
);

/* ============================================================
 * 2. 宿舍详情（含所有床位）
 *    GET /api/job/dorm/detail
 * ============================================================ */

dormRouter.get(
  '/detail',
  validate(z.object({ id: z.string().min(1, '宿舍ID必传') })),
  wrap(async (req, res) => {
    const { id } = (req as any).validated;
    const row = await tbl(db, DB, DORM_TABLE, STAGE).where({ id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.DORM_NOT_FOUND, '宿舍不存在');

    const beds = await tbl(db, DB, BED_TABLE, STAGE)
      .where({ dorm_id: id, is_deleted: false })
      .orderBy('bed_no', 'asc');

    res.json(ok({ ...decorateDorm(row), beds: beds.map(decorateBed) }));
  }),
);

/* ============================================================
 * 3. 新建宿舍
 *    POST /api/job/dorm/create
 * ============================================================ */

const dormSaveSchema = z.object({
  dormNo: z.string().min(1, '宿舍编号必填').max(20),
  building: z.string().min(1, '楼栋必填').max(50),
  roomNo: z.string().min(1, '房间号必填').max(20),
  bedCount: z.coerce.number().int().min(1).max(20),
  dormGender: z.coerce.number().int().min(0).max(2).default(0),
  deptCode: z.coerce.number().int().optional().nullable(),
  dormStatus: z.coerce.number().int().min(1).max(2).default(1),
  facility: z.string().max(200).optional().nullable(),
  remark: z.string().max(500).optional().nullable(),
});

dormRouter.post(
  '/create',
  validate(dormSaveSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated;
    const operator = getOperator(req);

    // 编号唯一
    const dup = await tbl(db, DB, DORM_TABLE, STAGE).where({ dorm_no: body.dormNo, is_deleted: false }).first();
    if (dup) throw new BizError(BizCode.DORM_NO_DUPLICATE, `宿舍编号 ${body.dormNo} 已存在`);

    const id = randomUUID();
    const now = new Date();

    await db.transaction(async (trx) => {
      await tblInsTrx(trx, DB, DORM_TABLE, STAGE, {
        id,
        create_time: now,
        create_by: operator.userId,
        is_deleted: false,
        dorm_no: body.dormNo,
        building: body.building,
        room_no: body.roomNo,
        bed_count: body.bedCount,
        used_count: 0,
        dorm_gender: body.dormGender,
        dept_code: body.deptCode ?? null,
        dorm_status: body.dormStatus,
        facility: body.facility || null,
        remark: body.remark || null,
      });

      // 按容量自动造床位
      const beds = [];
      for (let i = 1; i <= body.bedCount; i++) {
        beds.push({
          id: randomUUID(),
          create_time: now,
          create_by: operator.userId,
          is_deleted: false,
          dorm_id: id,
          dorm_no: body.dormNo,
          bed_no: bedNoOf(i), // ★ 1上 / 1下 / 2上 / 2下 …
          bed_status: DormBedStatus.FREE,
          remark: null,
        });
      }
      await tblInsTrx(trx, DB, BED_TABLE, STAGE, beds);
    });

    res.json(ok({ id, dormNo: body.dormNo }));
  }),
);

/* ============================================================
 * 4. 编辑宿舍
 *    POST /api/job/dorm/update
 *
 * ⚠️ 床位容量只能【增大】—— 缩小会丢床位，且可能让已住学生无处可去。
 * ============================================================ */

dormRouter.post(
  '/update',
  validate(dormSaveSchema.extend({ id: z.string().min(1, '宿舍ID必传') })),
  wrap(async (req, res) => {
    const body = (req as any).validated;
    const operator = getOperator(req);

    const row = await tbl(db, DB, DORM_TABLE, STAGE).where({ id: body.id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.DORM_NOT_FOUND, '宿舍不存在');

    const dup = await tbl(db, DB, DORM_TABLE, STAGE)
      .where({ dorm_no: body.dormNo, is_deleted: false })
      .whereNot('id', body.id)
      .first();
    if (dup) throw new BizError(BizCode.DORM_NO_DUPLICATE, `宿舍编号 ${body.dormNo} 已存在`);

    if (body.bedCount < row.bed_count) {
      throw new BizError(BizCode.PARAM_ERROR, `床位容量只能增大（当前 ${row.bed_count}），不能缩小`);
    }

    const now = new Date();
    await db.transaction(async (trx) => {
      await tblTrx(trx, DB, DORM_TABLE, STAGE).where({ id: body.id }).update({
        dorm_no: body.dormNo,
        building: body.building,
        room_no: body.roomNo,
        bed_count: body.bedCount,
        dorm_gender: body.dormGender,
        dept_code: body.deptCode ?? null,
        dorm_status: body.dormStatus,
        facility: body.facility || null,
        remark: body.remark || null,
        update_time: now,
        update_by: operator.userId,
      });

      // 容量增大 → 补床位
      if (body.bedCount > row.bed_count) {
        const beds = [];
        for (let i = row.bed_count + 1; i <= body.bedCount; i++) {
          beds.push({
            id: randomUUID(),
            create_time: now,
            create_by: operator.userId,
            is_deleted: false,
            dorm_id: body.id,
            dorm_no: body.dormNo,
            bed_no: bedNoOf(i), // ★ 1上 / 1下 / 2上 / 2下 …
            bed_status: DormBedStatus.FREE,
            remark: null,
          });
        }
        if (beds.length) await tblInsTrx(trx, DB, BED_TABLE, STAGE, beds);
      }

      // 编号变了要同步床位上的宿舍编号快照
      await tblTrx(trx, DB, BED_TABLE, STAGE).where({ dorm_id: body.id }).update({ dorm_no: body.dormNo });
    });

    res.json(ok(null));
  }),
);

/* ============================================================
 * 5. 删除宿舍（逻辑删除，有学生住就不能删）
 *    POST /api/job/dorm/delete
 * ============================================================ */

dormRouter.post(
  '/delete',
  validate(z.object({ id: z.string().min(1, '宿舍ID必传') })),
  wrap(async (req, res) => {
    const { id } = (req as any).validated;
    const operator = getOperator(req);

    const row = await tbl(db, DB, DORM_TABLE, STAGE).where({ id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.DORM_NOT_FOUND, '宿舍不存在');
    if (row.used_count > 0) {
      throw new BizError(BizCode.PARAM_ERROR, `该宿舍还住着 ${row.used_count} 人，不能删除`);
    }

    const now = new Date();
    await db.transaction(async (trx) => {
      await tblTrx(trx, DB, DORM_TABLE, STAGE).where({ id }).update({ is_deleted: true, update_time: now, update_by: operator.userId });
      await tblTrx(trx, DB, BED_TABLE, STAGE).where({ dorm_id: id }).update({ is_deleted: true, update_time: now, update_by: operator.userId });
    });

    res.json(ok(null));
  }),
);

/* ============================================================
 * 6. 楼栋列表（下拉用）
 *    GET /api/job/dorm/buildings
 * ============================================================ */

dormRouter.get(
  '/buildings',
  wrap(async (_req, res) => {
    const rows = await tbl(db, DB, DORM_TABLE, STAGE)
      .where('is_deleted', false)
      .distinct('building')
      .orderBy('building', 'asc');
    res.json(ok(rows.map((r: any) => r.building)));
  }),
);

/* ============================================================
 * 7. 可选床位（调换宿舍时选新床位）
 *    GET /api/job/dorm/bed-options
 *
 * 只返回【空闲】床位；可排除某个学生自己的当前床位。
 * ============================================================ */

dormRouter.get(
  '/bed-options',
  validate(
    z.object({
      keyword: z.string().optional(),
      dormGender: z.coerce.number().int().optional(),
      /** ★ 2026-10-03：传了学生 ID，就**按这个学生的性别**过滤（男生只能选男寝） */
      studentId: z.string().optional(),
      excludeStudentId: z.string().optional(),
      excludeBedId: z.string().optional(),
      // ★ 2026-10-02：按宿舍筛床位（「修改学生」里换宿舍时，先选宿舍再选床）
      dormId: z.string().optional(),
    }),
  ),
  wrap(async (req, res) => {
    const q = (req as any).validated;
    const base = tblAs(db, DB, BED_TABLE, STAGE, 'b')
      .join(`${tblRef(DB, DORM_TABLE)} as d`, 'b.dorm_id', 'd.id')
      .where('b.is_deleted', false)
      .andWhere('d.is_deleted', false)
      .andWhere('b.bed_status', DormBedStatus.FREE)
      .andWhere('d.dorm_status', DormStatus.NORMAL);

    if (q.keyword) {
      base.andWhere((x: any) => {
        x.where('b.dorm_no', 'like', `%${q.keyword}%`).orWhere('d.building', 'like', `%${q.keyword}%`);
      });
    }

    // ★ 2026-10-03 斌哥：换宿舍时按学生性别过滤 —— 男生只能选男寝、女生只能选女寝
    //   · 传了 studentId → 以【该学生的性别】为准（不信前端传的 dormGender）
    //   · dorm_gender = 0 表示「不限」，两边都能选
    let gender: number | undefined = q.dormGender;
    if (q.studentId) {
      const stu = await tbl(db, DB, STUDENT_TABLE, STAGE).where({ id: q.studentId, is_deleted: false }).first();
      if (stu?.gender) gender = stu.gender;
    }
    if (gender !== undefined) {
      base.andWhere((x: any) => x.where('d.dorm_gender', gender).orWhere('d.dorm_gender', 0));
    }

    if (q.excludeBedId) base.andWhereNot('b.id', q.excludeBedId);
    // ★ 2026-10-02：只看某个宿舍下的床位
    if (q.dormId) base.andWhere('b.dorm_id', q.dormId);

    const rows = await base
      .select(
        'b.id as bed_id',
        'b.dorm_id',
        'b.dorm_no',
        'b.bed_no',
        'd.building',
        'd.room_no',
        'd.dorm_gender',
      )
      .orderBy([{ column: 'd.building', order: 'asc' }, { column: 'b.dorm_no', order: 'asc' }, { column: 'b.bed_no', order: 'asc' }])
      .limit(200);

    res.json(
      ok(
        rows.map((r: any) => ({
          bedId: r.bed_id,
          dormId: r.dorm_id,
          dormNo: r.dorm_no,
          building: r.building,
          roomNo: r.room_no,
          bedNo: r.bed_no,
          // ★ 上/下铺文字（`1-上`）—— 前端下拉直接显示，别自己拼
          bedNoText: bedNoText(r.bed_no),
          dormGender: r.dorm_gender,
          dormGenderName: DORM_GENDER_NAME[r.dorm_gender] || '',
        })),
      ),
    );
  }),
);

/* ============================================================
 * 8. 可发起调换/退宿的学生（班主任选人下拉）
 *    GET /api/job/dorm/student-options
 *
 * ⚠️ 只列【当前有宿舍】的学生 —— 没宿舍谈不上调换/退宿。
 * ============================================================ */

dormRouter.get(
  '/student-options',
  validate(
    z.object({
      keyword: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      /** ★ 2026-10-03：1=调换 2=退宿。退宿时**休学学生也要列出来**（他还占着床位没退） */
      bizType: z.coerce.number().int().optional(),
    }),
  ),
  wrap(async (req, res) => {
    const q = (req as any).validated;
    const operator = getOperator(req);

    // ★ 2026-10-03 斌哥：休学学生若没退宿，填**退宿**申请时要能选到他
    const allowStatus =
      q.bizType === DormChangeBizType.CHECKOUT
        ? [...ALLOW_INITIATE_STATUS, StudentStatus.SUSPENDED]
        : ALLOW_INITIATE_STATUS;

    const query = tblAs(db, DB, STUDENT_TABLE, STAGE, 's')
      .leftJoin(`${tblRef(DB, CLASS_TABLE)} as c`, 's.class_id', 'c.id')
      .leftJoin(`${tblRef(DB, BED_TABLE)} as b`, function (this: any) {
        this.on('b.student_id', '=', 's.id')
          .andOn('b.bed_status', '=', db.raw('?', [DormBedStatus.USED]))
          .andOn('b.is_deleted', '=', db.raw('?', [false]));
      })
      .where('s.is_deleted', false)
      .whereIn('s.student_status', allowStatus)
      .whereNotNull('s.dorm_id');

    // ★ 数据范围（2026-10-08 修：补上项目经理）
    //   项目经理 → 只看自己带的实训班（未结业）
    //   班主任   → 只看自己带的班
    //
    // ⚠️【口径必须和建单一致】建单时写 head_teacher 的取值是
    //    `cls?.head_teacher_id || stu.head_teacher_id`（班级表优先，学生主档兜底）。
    //    但学生主档 t_student_base.head_teacher_id 大量为 null（历史数据没回填），
    //    权威来源是班级表 t_job_class.head_teacher_id。
    //    所以这里也必须【班级优先 + 兜底】，否则会出现：
    //      班主任能发起 → 但列表里查不到自己刚发起的人（口径割裂）。
    const _r2 = operator.roles;
    const _adm2 = hasRole(_r2, RoleCode.SYS_ADMIN);
    const _pm2 = hasRole(_r2, RoleCode.PROJECT_MANAGER);
    const _head2 = hasRole(_r2, RoleCode.TEACH_HEAD);
    if (!_adm2 && _pm2) {
      query.andWhere('c.project_manager_id', operator.userId);
      query.andWhereNot('c.class_status', ClassStatus.GRADUATED);
    } else if (!_adm2 && _head2 && !_pm2) {
      query.andWhere(function (this: any) {
        this.where('c.head_teacher_id', operator.userId)
          .orWhere(function (this: any) {
            this.whereNull('c.head_teacher_id').andWhere('s.head_teacher_id', operator.userId);
          });
      });
    }

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
        's.gender',
        's.student_status',
        's.dorm_id',
        's.dorm_no',
        'b.id as bed_id',
        'b.bed_no',
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
          gender: r.gender ?? null,
          genderName: r.gender ? GENDER_NAME[r.gender] || '' : '',
          // ★ 2026-10-03：带上学生状态（退宿时会包含「休学」的学生，前端要能标出来）
          studentStatus: r.student_status ?? null,
          studentStatusName: r.student_status ? STUDENT_STATUS_NAME[r.student_status] || '' : '',
          className: r.class_name || null,
          deptCode: r.dept_code ?? null,
          deptName: r.dept_code ? DEPT_NAME[r.dept_code] || null : null,
          headTeacherId: r.head_teacher_id || null,
          headTeacherName: r.head_teacher_name || null,
          dormId: r.dorm_id || null,
          dormNo: r.dorm_no || null,
          bedId: r.bed_id || null,
          bedNo: r.bed_no ?? null,
        })),
      ),
    );
  }),
);

/* ============================================================
 * 9. 调换/退宿 申请单 列表
 *    GET /api/job/dorm/change/page
 * ============================================================ */

const changeListSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(200).default(20),
  keyword: z.string().optional(),
  bizType: z.coerce.number().int().min(1).max(2).optional(),
  classId: z.string().optional(),
  approvalStatus: z.coerce.number().int().optional(),
  onlyMine: z.coerce.boolean().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

dormRouter.get(
  '/change/page',
  validate(changeListSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated;
    const operator = getOperator(req);

    const base = tblAs(db, DB, CHANGE_TABLE, STAGE, 'l')
      .join(`${tblRef(DB, 't_job_approval')} as a`, 'l.approval_id', 'a.id')
      .where('l.is_deleted', false)
      .andWhere('a.is_deleted', false);

    if (q.keyword) {
      base.andWhere((b: any) => {
        b.where('l.student_name', 'like', `%${q.keyword}%`)
          .orWhere('l.student_no', 'like', `%${q.keyword}%`);
      });
    }
    if (q.bizType !== undefined) base.andWhere('l.biz_type', q.bizType);
    if (q.classId) base.andWhere('l.class_id', q.classId);
    if (q.approvalStatus !== undefined) base.andWhere('l.approval_status', q.approvalStatus);
    if (q.startDate) base.andWhere('l.change_date', '>=', q.startDate);
    if (q.endDate) base.andWhere('l.change_date', '<=', q.endDate);

    // 只看跟我有关的
    if (q.onlyMine) {
      const isMgr = canApprove(ApprovalBizType.DORM_CHANGE, 1, operator.roles);
      if (isMgr) {
        // 教务：待我批的（第 1 步 + 审批中）
        base.andWhere('a.status', ApprovalStatus.PENDING_MANAGER).andWhere('a.current_step', 1);
      } else {
        // 班主任：我发起的
        base.andWhere('a.applicant_id', operator.userId);
      }
    }

    const [{ c: total }] = await base.clone().count({ c: '*' });
    const rows = await base
      .clone()
      .select('l.*', 'a.status as a_status', 'a.current_step', 'a.current_handler_hint', 'a.applicant_id')
      .orderBy('l.create_time', 'desc')
      .limit(q.size)
      .offset((q.page - 1) * q.size);

    const list = rows.map((r: any) =>
      decorateChange(r, { status: r.a_status, current_step: r.current_step, current_handler_hint: r.current_handler_hint, applicant_id: r.applicant_id }, operator),
    );

    res.json(page(list, Number(total), q));
  }),
);

/* ============================================================
 * 10. 调换/退宿 详情
 *     GET /api/job/dorm/change/detail
 * ============================================================ */

dormRouter.get(
  '/change/detail',
  validate(z.object({ id: z.string().min(1, '申请单ID必传') })),
  wrap(async (req, res) => {
    const { id } = (req as any).validated;
    const operator = getOperator(req);

    const row = await tbl(db, DB, CHANGE_TABLE, STAGE).where({ id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.DORM_CHANGE_NOT_FOUND, '宿舍调换/退宿申请单不存在');

    const appr = row.approval_id ? await getApproval(row.approval_id) : null;
    const base = decorateChange(row, appr, operator);

    const logs = row.approval_id ? await getApprovalLogs(row.approval_id) : [];
    const chainNodesRaw = row.approval_id
      ? await buildChainNodes(ApprovalBizType.DORM_CHANGE, appr)
      : [];
    const chainNodes = chainNodesRaw.map((n: any) => ({
      step: n.step,
      name: n.name,
      hint: n.name,
      roles: [] as string[],
      status: n.done ? 'done' : n.current ? 'current' : 'todo',
    }));

    // 该学生的历史宿舍变动
    const history = await tbl(db, DB, CHANGE_TABLE, STAGE)
      .where({ student_id: row.student_id, is_deleted: false })
      .whereNot('id', id)
      .orderBy('create_time', 'desc')
      .limit(20);

    res.json(
      ok({
        ...base,
        logs: logs.map((l: any) => ({
          id: l.id,
          step: l.step,
          nodeName: l.node_name,
          operatorName: l.operator_name,
          operatorRole: l.operator_role || null,
          action: l.action,
          actionName: l.action_name || '',
          comment: l.comment || null,
          createTime: fmtDateTime(l.create_time),
        })),
        chainNodes,
        history: history.map((h: any) => ({
          id: h.id,
          bizType: h.biz_type,
          bizTypeName: DORM_CHANGE_BIZ_TYPE_NAME[h.biz_type] || '',
          oldDormNo: h.old_dorm_no || null,
          newDormNo: h.new_dorm_no || null,
          approvalStatus: h.approval_status,
          approvalStatusName: dormStatusName(h.approval_status),
          changeDate: fmtDate(h.change_date),
        })),
      }),
    );
  }),
);

/* ============================================================
 * 11. 新建调换/退宿申请单
 *     POST /api/job/dorm/change/create
 *
 * ⚠️ 只有班主任能发起。
 * ============================================================ */

const changeCreateSchema = z.object({
  bizType: z.coerce.number().int().min(1).max(2),
  studentId: z.string().min(1, '学生必传'),
  changeDate: z.string().optional(),
  changeReason: z.string().min(1, '原因必填').max(500),
  headTeacherOpinion: z.string().max(500).optional().nullable(),
  /** 调换时必传：新床位 */
  newBedId: z.string().optional().nullable(),
  remark: z.string().max(500).optional().nullable(),
  /**
   * ★ 2026-10-03 斌哥：「保存并提交审批」要一步到位
   *   true = 创建后**同一事务里直接提交**（并同步进教务），不用再点第二次
   */
  submit: z.boolean().optional(),
});

dormRouter.post(
  '/change/create',
  validate(changeCreateSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated;
    const operator = getOperator(req);

    // ① 只能班主任发起
    if (!canInitiate(ApprovalBizType.DORM_CHANGE, operator.roles)) {
      throw new BizError(BizCode.NO_OPERATION_PERMISSION, '只有班主任能发起宿舍调换/退宿申请');
    }

    // ② 学生必须存在且在可发起状态
    const stu = await tbl(db, DB, STUDENT_TABLE, STAGE).where({ id: body.studentId, is_deleted: false }).first();
    if (!stu) throw new BizError(BizCode.STUDENT_NOT_FOUND, '学生不存在');
    // ★ 2026-10-03：退宿允许【休学】学生（他可能还占着床位没退），调换仍不允许
    const allowInitiate =
      body.bizType === DormChangeBizType.CHECKOUT
        ? [...ALLOW_INITIATE_STATUS, StudentStatus.SUSPENDED]
        : ALLOW_INITIATE_STATUS;
    if (!allowInitiate.includes(stu.student_status)) {
      throw new BizError(BizCode.STUDENT_STATUS_NOT_ALLOW, '该学生当前状态不允许发起宿舍申请');
    }

    // ③ 学生必须有宿舍（没宿舍没法调换/退宿）
    if (!stu.dorm_id) {
      throw new BizError(BizCode.STUDENT_NO_DORM, '该学生当前没有宿舍，不能调换/退宿');
    }

    // ④ 不能有未完成的同类型申请
    const dup = await tblAs(db, DB, CHANGE_TABLE, STAGE, 'l')
      .join(`${tblRef(DB, 't_job_approval')} as a`, 'l.approval_id', 'a.id')
      .where('l.student_id', stu.id)
      .andWhere('l.is_deleted', false)
      .whereNotIn('a.status', [ApprovalStatus.APPROVED, ApprovalStatus.REJECTED, ApprovalStatus.CANCELED])
      .select('l.id')
      .first();
    if (dup) {
      throw new BizError(
        BizCode.DORM_CHANGE_DUPLICATE,
        `该学生已有未完成的宿舍申请`,
      );
    }

    // ⑤ 找学生当前床位
    const oldBed = await tbl(db, DB, BED_TABLE, STAGE)
      .where({ student_id: stu.id, bed_status: DormBedStatus.USED, is_deleted: false })
      .first();

    const isChange = body.bizType === DormChangeBizType.CHANGE;
    let newBed: any = null;

    if (isChange) {
      if (!body.newBedId) throw new BizError(BizCode.PARAM_ERROR, '调换宿舍必须选择新床位');
      newBed = await tbl(db, DB, BED_TABLE, STAGE).where({ id: body.newBedId, is_deleted: false }).first();
      if (!newBed) throw new BizError(BizCode.DORM_BED_NOT_FOUND, '目标床位不存在');
      if (newBed.bed_status === DormBedStatus.USED) {
        throw new BizError(BizCode.DORM_BED_OCCUPIED, `床位 ${newBed.dorm_no}-${newBed.bed_no} 已被占用`);
      }
      if (oldBed && oldBed.id === newBed.id) {
        throw new BizError(BizCode.DORM_SAME_BED, '新床位与当前床位相同，无需调换');
      }
      const targetDorm = await tbl(db, DB, DORM_TABLE, STAGE).where({ id: newBed.dorm_id, is_deleted: false }).first();
      if (!targetDorm || targetDorm.dorm_status === DormStatus.DISABLED) {
        throw new BizError(BizCode.DORM_DISABLED, '目标宿舍已停用，不能选');
      }
      // ★ 2026-10-03 斌哥：性别必须匹配 —— 男生不能换进女寝（dorm_gender=0 不限除外）
      const targetGender = Number(targetDorm.dorm_gender) || 0;
      if (targetGender !== 0 && stu.gender && targetGender !== Number(stu.gender)) {
        throw new BizError(
          BizCode.DORM_GENDER_MISMATCH,
          '目标宿舍的性别与学生的性别不符，不能选择',
        );
      }
    }

    // ⑥ 班级信息
    let cls: any = null;
    if (stu.class_id) cls = await tbl(db, DB, CLASS_TABLE, STAGE).where({ id: stu.class_id, is_deleted: false }).first();

    const changeDate = body.changeDate || today();
    const id = randomUUID();
    const now = new Date();

    await db.transaction(async (trx) => {
      // 建审批单
      const approvalId = await createApproval(
        {
          bizType: ApprovalBizType.DORM_CHANGE,
          bizId: id,
          applicant: operator,
          studentId: stu.id,
          studentNo: stu.student_no,
          studentName: stu.student_name,
          classId: cls?.id || stu.class_id || undefined,
          className: cls?.class_name || stu.class_name || undefined,
          deptCode: cls?.dept_code ?? stu.dept_code ?? undefined,
        },
        trx,
      );

      await tblInsTrx(trx, DB, CHANGE_TABLE, STAGE, {
        id,
        create_time: now,
        create_by: operator.userId,
        is_deleted: false,

        biz_type: body.bizType,

        student_id: stu.id,
        student_no: stu.student_no || null,
        student_name: stu.student_name || null,
        gender: stu.gender ?? null,
        phone: stu.phone || null,

        class_id: cls?.id || stu.class_id || null,
        class_name: cls?.class_name || stu.class_name || null,
        dept_code: cls?.dept_code ?? stu.dept_code ?? null,
        head_teacher_id: cls?.head_teacher_id || stu.head_teacher_id || operator.userId,
        head_teacher_name: cls?.head_teacher_name || stu.head_teacher_name || operator.userName,

        old_dorm_id: stu.dorm_id || null,
        old_dorm_no: stu.dorm_no || oldBed?.dorm_no || null,
        old_bed_id: oldBed?.id || null,
        old_bed_no: oldBed?.bed_no ?? null,

        new_dorm_id: newBed?.dorm_id || null,
        new_dorm_no: newBed?.dorm_no || null,
        new_bed_id: newBed?.id || null,
        new_bed_no: newBed?.bed_no ?? null,

        change_date: changeDate,
        change_reason: body.changeReason,
        head_teacher_opinion: body.headTeacherOpinion || null,

        approval_id: approvalId,
        approval_status: ApprovalStatus.DRAFT,

        remark: body.remark || null,
      });

      // ★ 2026-10-03 斌哥：点「保存并提交审批」= 创建 + 提交一步到位。
      //   以前前端传了 submit，但后端 schema 没这个字段，被静默丢掉 → 还得再点一次「提交审批」。
      if (body.submit) {
        await submitApproval(approvalId, operator, trx);
        await tblTrx(trx, DB, CHANGE_TABLE, STAGE).where({ id }).update({
          approval_status: ApprovalStatus.PENDING_MANAGER,
          update_time: new Date(),
          update_by: operator.userId,
        });

        // 同一事务里同步进教务申请表（之后由教务在「教务管理 → 宿舍管理 → 申请审批」审批）
        const created = await tblTrx(trx, DB, CHANGE_TABLE, STAGE).where({ id }).first();
        await syncApplyToEdu(trx, created, operator);
      }
    });

    res.json(
      ok({
        id,
        approvalStatus: body.submit ? ApprovalStatus.PENDING_MANAGER : ApprovalStatus.DRAFT,
      }),
    );
  }),
);

/* ============================================================
 * 12. 提交申请单
 *     POST /api/job/dorm/change/submit
 * ============================================================ */

dormRouter.post(
  '/change/submit',
  validate(z.object({ id: z.string().min(1, '申请单ID必传') })),
  wrap(async (req, res) => {
    const { id } = (req as any).validated;
    const operator = getOperator(req);

    const row = await tbl(db, DB, CHANGE_TABLE, STAGE).where({ id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.DORM_CHANGE_NOT_FOUND, '申请单不存在');

    await db.transaction(async (trx) => {
      await submitApproval(row.approval_id, operator, trx);
      await tblTrx(trx, DB, CHANGE_TABLE, STAGE).where({ id }).update({
        approval_status: ApprovalStatus.PENDING_MANAGER,
        update_time: new Date(),
        update_by: operator.userId,
      });

      // ★ 2026-10-03：同一事务里同步一条到教务申请表
      //   （之后由教务在「教务管理 → 宿舍管理 → 申请审批」里审批）
      await syncApplyToEdu(trx, row, operator);
    });

    res.json(ok({ approvalStatus: ApprovalStatus.PENDING_MANAGER }));
  }),
);

/* ============================================================
 * 13. 同意（教务老师）
 *     POST /api/job/dorm/change/approve
 *
 * ★★ 全部通过时执行 afterApproved()（改床位 + 改学生宿舍）
 * ============================================================ */

dormRouter.post(
  '/change/approve',
  validate(
    z.object({
      id: z.string().min(1, '申请单ID必传'),
      comment: z.string().max(500).optional(),
    }),
  ),
  wrap(async (req, res) => {
    const body = (req as any).validated;
    const operator = getOperator(req);

    const row = await tbl(db, DB, CHANGE_TABLE, STAGE).where({ id: body.id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.DORM_CHANGE_NOT_FOUND, '申请单不存在');

    let finished = false;
    let nextStatus = 0;

    await db.transaction(async (trx) => {
      const result = await doApprove(row.approval_id, operator, body.comment, trx);
      finished = result.finished;
      nextStatus = result.status;

      await tblTrx(trx, DB, CHANGE_TABLE, STAGE).where({ id: row.id }).update({
        approval_status: nextStatus,
        update_time: new Date(),
        update_by: operator.userId,
      });

      if (finished) {
        await afterApproved(trx, row, operator);
      }
    });

    res.json(
      ok({
        finished,
        approvalStatus: nextStatus,
        approvalStatusName: dormStatusName(nextStatus),
      }),
    );
  }),
);

/* ============================================================
 * 14. 驳回（教务老师）
 *     POST /api/job/dorm/change/reject
 * ============================================================ */

dormRouter.post(
  '/change/reject',
  validate(
    z.object({
      id: z.string().min(1, '申请单ID必传'),
      reason: z.string().min(1, '驳回原因必填').max(500),
    }),
  ),
  wrap(async (req, res) => {
    const body = (req as any).validated;
    const operator = getOperator(req);

    const row = await tbl(db, DB, CHANGE_TABLE, STAGE).where({ id: body.id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.DORM_CHANGE_NOT_FOUND, '申请单不存在');

    await db.transaction(async (trx) => {
      await doReject(row.approval_id, operator, body.reason, trx);
      await tblTrx(trx, DB, CHANGE_TABLE, STAGE).where({ id: row.id }).update({
        approval_status: ApprovalStatus.REJECTED,
        update_time: new Date(),
        update_by: operator.userId,
      });
    });

    res.json(ok({ approvalStatus: ApprovalStatus.REJECTED }));
  }),
);

/* ============================================================
 * 15. 撤回（仅申请人本人）
 *     POST /api/job/dorm/change/cancel
 * ============================================================ */

dormRouter.post(
  '/change/cancel',
  validate(z.object({ id: z.string().min(1, '申请单ID必传') })),
  wrap(async (req, res) => {
    const { id } = (req as any).validated;
    const operator = getOperator(req);

    const row = await tbl(db, DB, CHANGE_TABLE, STAGE).where({ id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.DORM_CHANGE_NOT_FOUND, '申请单不存在');

    await db.transaction(async (trx) => {
      await doCancel(row.approval_id, operator, undefined, trx);
      await tblTrx(trx, DB, CHANGE_TABLE, STAGE).where({ id: row.id }).update({
        approval_status: ApprovalStatus.CANCELED,
        update_time: new Date(),
        update_by: operator.userId,
      });

      // ★ 2026-10-03：撤回时，把教务那边还没审批的那条也撤掉
      //   （已通过 / 已驳回的不动 —— 那已经不是"能撤"的状态了）
      await cancelEduApply(trx, row);
    });

    res.json(ok({ approvalStatus: ApprovalStatus.CANCELED }));
  }),
);

/* ============================================================
 * 16. 统计
 *     GET /api/job/dorm/change/summary
 * ============================================================ */

dormRouter.get(
  '/change/summary',
  wrap(async (req, res) => {
    const operator = getOperator(req);

    const base = tblAs(db, DB, CHANGE_TABLE, STAGE, 'l')
      .join(`${tblRef(DB, 't_job_approval')} as a`, 'l.approval_id', 'a.id')
      .where('l.is_deleted', false)
      .andWhere('a.is_deleted', false);

    const [{ c: totalChange }] = await base.clone().andWhere('l.biz_type', DormChangeBizType.CHANGE).count({ c: '*' });
    const [{ c: totalCheckout }] = await base.clone().andWhere('l.biz_type', DormChangeBizType.CHECKOUT).count({ c: '*' });
    const [{ c: approved }] = await base.clone().andWhere('l.approval_status', ApprovalStatus.APPROVED).count({ c: '*' });
    const [{ c: pending }] = await base
      .clone()
      .whereNotIn('l.approval_status', [ApprovalStatus.APPROVED, ApprovalStatus.REJECTED, ApprovalStatus.CANCELED])
      .count({ c: '*' });

    // 待我审批
    let todoMine = 0;
    if (canApprove(ApprovalBizType.DORM_CHANGE, 1, operator.roles)) {
      const [r] = await base
        .clone()
        .andWhere('a.status', ApprovalStatus.PENDING_MANAGER)
        .andWhere('a.current_step', 1)
        .count({ c: '*' });
      todoMine = Number(r.c);
    }

    res.json(
      ok({
        totalChange: Number(totalChange),
        totalCheckout: Number(totalCheckout),
        pending: Number(pending),
        approved: Number(approved),
        todoMine,
      }),
    );
  }),
);

/* ============================================================
 * 14. ★ 分派宿舍（2026-10-01 新增 · 斌哥）
 *     · GET  /api/job/dorm/assign/page  —— 待分派的学生（没宿舍的在校生）
 *     · POST /api/job/dorm/assign       —— 分派床位（**直接生效，不走审批**）
 *
 * 【为什么要有这个】
 *   学生**休学期间若办理了退宿**，复学后宿舍是空的 ——
 *   由**复学班的班主任**在这里把他分到某个床位。
 *   （斌哥 2026-10-01：学管定完复学班后，复学班班主任负责分床位）
 *
 * 【口径】
 *   · 只列 `dorm_id IS NULL`（没宿舍）且 `student_status = 实训中(8)` 的学生
 *   · 班主任只看自己带的班（同其它模块）
 *   · 选床位直接生效，**不走审批**（斌哥 2026-10-01）
 * ============================================================ */

const assignListSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(200).default(20),
  keyword: z.string().optional(),
  classId: z.string().optional(),
});

dormRouter.get(
  '/assign/page',
  validate(assignListSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated;
    const operator = getOperator(req);

    const query = tblAs(db, DB, STUDENT_TABLE, STAGE, 's')
      .leftJoin(`${tblRef(DB, CLASS_TABLE)} as c`, 's.class_id', 'c.id')
      .where('s.is_deleted', false)
      .whereNull('s.dorm_id') // ★ 没有宿舍
      .andWhere('s.student_status', StudentStatus.TRAINING); // ★ 实训中

    // ★ 数据范围（2026-10-08 修：补上项目经理）
    //   项目经理 → 只看自己带的实训班；班主任 → 只看自己带的班
    const _r3 = operator.roles;
    const _adm3 = hasRole(_r3, RoleCode.SYS_ADMIN);
    const _pm3 = hasRole(_r3, RoleCode.PROJECT_MANAGER);
    const _head3 = hasRole(_r3, RoleCode.TEACH_HEAD);
    if (!_adm3 && _pm3) {
      const myClasses = await tbl(db, DB, CLASS_TABLE, STAGE)
        .where({ project_manager_id: operator.userId, is_deleted: false })
        // [已停用] ★ 2026-10-08 斌哥拍板：项目经理可见自己带的【所有】实训班（含已结业）—— 去掉未结业限制
        // .whereNot('class_status', ClassStatus.GRADUATED)
        .select('id');
      const ids = myClasses.map((x: any) => x.id);
      if (ids.length === 0) query.whereRaw('1 = 0');
      else query.whereIn('s.class_id', ids);
    } else if (!_adm3 && _head3 && !_pm3) {
      const myClasses = await tbl(db, DB, CLASS_TABLE, STAGE)
        .where({ head_teacher_id: operator.userId, is_deleted: false })
        .select('id');
      query.whereIn(
        's.class_id',
        myClasses.map((x: any) => x.id),
      );
    }

    if (q.keyword) {
      query.andWhere((b: any) => {
        b.where('s.student_name', 'like', `%${q.keyword}%`).orWhere(
          's.student_no',
          'like',
          `%${q.keyword}%`,
        );
      });
    }
    if (q.classId) query.andWhere('s.class_id', q.classId);

    const [{ total }] = await query.clone().count({ total: 's.id' });

    const rows = await query
      .clone()
      .select(
        's.id as student_id',
        's.student_no',
        's.student_name',
        's.gender',
        's.phone',
        's.class_id',
        's.class_name',
        's.dept_code',
        's.student_status',
      )
      .orderBy('s.student_no', 'asc')
      .limit(q.size)
      .offset((q.page - 1) * q.size);

    const list = rows.map((r: any) => ({
      studentId: r.student_id,
      studentNo: r.student_no,
      studentName: r.student_name,
      gender: r.gender ?? null,
      genderName: GENDER_NAME[r.gender] || '',
      phone: r.phone || null,
      classId: r.class_id || null,
      className: r.class_name || null,
      deptCode: r.dept_code ?? null,
      deptName: DEPT_NAME[r.dept_code] || null,
      studentStatus: r.student_status,
      studentStatusName: STUDENT_STATUS_NAME[r.student_status] || '',
    }));

    res.json(page(list, Number(total), q));
  }),
);

/** 分派宿舍（★ 直接生效，不走审批） */
dormRouter.post(
  '/assign',
  validate(
    z.object({
      studentId: z.string().min(1, '学生必选'),
      bedId: z.string().min(1, '床位必选'),
    }),
  ),
  wrap(async (req, res) => {
    const body = (req as any).validated;
    const operator = getOperator(req);

    const stu = await tbl(db, DB, STUDENT_TABLE, STAGE).where({ id: body.studentId, is_deleted: false }).first();
    if (!stu) throw new BizError(BizCode.STUDENT_NOT_FOUND, '学生不存在');
    if (stu.dorm_id) {
      throw new BizError(BizCode.STUDENT_HAS_DORM, '该学生已有宿舍，不能重复分派');
    }

    // ★ 数据范围（2026-10-08 修：补上项目经理）
    //   项目经理 → 只能给自己带的实训班学生分派；班主任 → 只能给自己班的学生分派
    const _r4 = operator.roles;
    const _adm4 = hasRole(_r4, RoleCode.SYS_ADMIN);
    const _pm4 = hasRole(_r4, RoleCode.PROJECT_MANAGER);
    const _head4 = hasRole(_r4, RoleCode.TEACH_HEAD);
    if (!_adm4 && (_pm4 || _head4)) {
      if (!stu.class_id) {
        throw new BizError(BizCode.NO_OPERATION_PERMISSION, '该学生没有班级，无法分派宿舍');
      }
      const mine = _pm4
        ? await tbl(db, DB, CLASS_TABLE, STAGE)
            .where({ id: stu.class_id, project_manager_id: operator.userId, is_deleted: false })
            // [已停用] ★ 2026-10-08 斌哥拍板：项目经理可见自己带的【所有】实训班（含已结业）—— 去掉未结业限制
            // .whereNot('class_status', ClassStatus.GRADUATED)
            .first()
        : await tbl(db, DB, CLASS_TABLE, STAGE)
            .where({ id: stu.class_id, head_teacher_id: operator.userId, is_deleted: false })
            .first();
      if (!mine) {
        throw new BizError(
          BizCode.NO_OPERATION_PERMISSION,
          _pm4 ? '只能给自己带的实训班学生分派宿舍' : '只能给自己班级的学生分派宿舍',
        );
      }
    }

    // 床位校验
    const bed = await tbl(db, DB, BED_TABLE, STAGE).where({ id: body.bedId, is_deleted: false }).first();
    if (!bed) throw new BizError(BizCode.DORM_BED_NOT_FOUND, '床位不存在');
    if (bed.bed_status === DormBedStatus.USED) {
      throw new BizError(BizCode.DORM_BED_OCCUPIED, `床位 ${bed.dorm_no} ${bed.bed_no} 已被占用`);
    }

    const dorm = await tbl(db, DB, DORM_TABLE, STAGE).where({ id: bed.dorm_id, is_deleted: false }).first();
    if (!dorm) throw new BizError(BizCode.DORM_NOT_FOUND, '宿舍不存在');
    if (dorm.dorm_status === DormStatus.DISABLED) {
      throw new BizError(BizCode.DORM_DISABLED, '该宿舍已停用，不能分派');
    }

    // ★ 性别校验：男生只能分到男寝，女生只能分到女寝
    if (dorm.dorm_gender && stu.gender && dorm.dorm_gender !== stu.gender) {
      throw new BizError(
        BizCode.DORM_GENDER_MISMATCH,
        `该生是${GENDER_NAME[stu.gender] || ''}生，不能分到「${
          DORM_GENDER_NAME[dorm.dorm_gender] || ''
        }」`,
      );
    }

    const now = new Date();
    await db.transaction(async (trx) => {
      // ① 占用床位
      await tblTrx(trx, DB, BED_TABLE, STAGE).where({ id: bed.id }).update({
        bed_status: DormBedStatus.USED,
        student_id: stu.id,
        student_no: stu.student_no || null,
        student_name: stu.student_name || null,
        student_gender: stu.gender ?? null,
        check_in_date: today(),
        update_time: now,
        update_by: operator.userId,
      });
      // ② 学生主档写入宿舍
      await tblTrx(trx, DB, STUDENT_TABLE, STAGE).where({ id: stu.id }).update({
        dorm_id: bed.dorm_id,
        dorm_no: bed.dorm_no,
        update_time: now,
        update_by: operator.userId,
      });
      // ③ 重算该宿舍「已住人数」
      await recalcUsedCount(trx, bed.dorm_id);
    });

    //★ 返回上/下铺文字，前端提示语直接用（别自己拼 `dormNo-bedNo`）
    res.json(
      ok({
        dormNo: bed.dorm_no,
        bedNo: bed.bed_no,
        bedNoText: bedNoText(bed.bed_no),
        bedLabel: bedLabel(bed.dorm_no, bed.bed_no),
      }),
    );
  }),
);

export default dormRouter;
