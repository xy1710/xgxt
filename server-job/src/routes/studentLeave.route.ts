/**
 * 休学 / 退学审批 路由（就业管理 > 实训阶段）
 *
 * 接口前缀：/api/job/student-leave
 * 表：t_job_student_leave（休学/退学申请）+ t_job_approval（审批单，共用）
 * 字段依据：`D:\产品经理\就业模块.xmind`「休学/退学审批」+ 斌哥 2026-09-30 确认
 *
 * ============================================================
 * 【业务规则（斌哥 2026-09-29 拍板；复学 2026-10-01 新增）】
 * ============================================================
 *   休学：班主任发起 → 学管审批 → 通过（★ 不走校长）→ 财务冻结费用
 *   退学：班主任发起 → 学管审批 → 校长审批 → 通过 → 财务退费
 *   复学：班主任发起 → 学管审批 → 通过（★ 不走校长）→ 学生回到「实训中」
 *
 *   ⚠️ 休学、复学只有一审，退学两审 —— 差别在 shared-types/src/approval.ts 配置
 *
 *   ★ 页面是【班主任 / 学管 / 校长】三人共用：
 *       班主任 = 只能发申请 + 撤回
 *       学管   = 审批第 1 步
 *       校长   = 审批第 2 步（仅退学有）
 *
 *   ★ 复学的两个特点（斌哥 2026-10-01）：
 *       ① 班级由**学管在审批时选定**（不一定回原班）→ `approve` 接口必传 classId
 *          ⚠️ 班主任建单时**不选班级**，他那个班的学生休学了才能发起
 *       ② 宿舍**沿用原床位**；若休学期间已退宿，则留空由复学班班主任再分配
 *
 * ============================================================
 * 【★ 审批通过后要干的事（三种类型各不同）】
 * ============================================================
 *   ① 改学生主档状态：休学 → SUSPENDED(6)；退学 → QUIT(7)；复学 → TRAINING(8)
 *   ② 花名册：休学/退学 = 当前班改「已离班」；复学 = 【复学班】新增「在班」记录
 *   ③ 通知：休学/退学发（财务冻结/退费）；★ 复学**不发通知**
 *   ④ 宿舍：★ 退学 → **生成退宿申请、走教务审批**（2026-10-01 改，不再直接释放床位）；
 *            休学保留；复学沿用（已退宿则留空）
 *   ⑤ ★ 退学结算（2026-10-01 新增）：退学审批通过后自动生成
 *            「退宿申请」+「退学退费」合并单（学费 + 住宿费 + 餐费，三项明细分开记），
 *            金额先填 0（系统拿不到缴费数据），由班主任核对后填写再提交。
 *
 *   ⚠️ 斌哥说「冻结只改状态，财务看教务审批单状态自行处理」——
 *      所以本模块【只发通知，不执行冻结动作】，冻结在财务模块 8005。
 *
 * ⚠️ 铁律：逻辑删除，禁物理删除
 * ⚠️ 铁律：枚举双返回（bizType + bizTypeName）
 */

import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import {
  BizCode,
  RoleCode,
  ApprovalBizType,
  ApprovalStatus,
  APPROVAL_STATUS_NAME,
  StudentLeaveBizType,
  STUDENT_LEAVE_BIZ_TYPE_NAME,
  // STUDENT_LEAVE_NO_PREFIX 已随「单号」一起废弃（斌哥 2026-09-30）
  StudentStatus,
  STUDENT_STATUS_NAME,
  JoinType,
  GENDER_NAME,
  DEPT_NAME,
  AttendStatus,
  ATTEND_STATUS_PRESENT_SET,
  canApprove,
  canInitiate,
  isFinished,
  isMyApproval,
  hasRole,
  ClassStatus,
} from 'shared-types';
import { ok, page } from '../utils/response';
import { db } from '../utils/db';
import { wrap } from '../utils/wrap';
import { today, fmtDate, fmtDateTime } from '../utils/date';
import { validate } from '../middleware/validate';
import { BizError } from '../middleware/errorHandler';
import { sendNotice, NOTICE_TYPE } from '../utils/notice';
import { settleQuit } from '../utils/quitSettlement';
import {
  createApproval,
  submitApproval,
  doApprove,
  doReject,
  doCancel,
  getApprovalLogs,
  buildChainNodes,
  getApproval,
  APPROVAL_TABLE,
  type Operator,
} from '../utils/approval';
// ★ P3 切读层：本文件各表（t_job_student_leave / t_student_base / t_job_class /
//   t_job_class_student / t_job_attendance / t_job_refund / sms_class.t_class_student）
//   都已归一，全部走 tbl()/tblAs()/tblRef()/tblTrx()/tblInsTrx() 路由；
//   开关关时与原实现逐字节等价。
import { tbl, tblAs, tblInsTrx, tblRef, tblTrx } from '../teaching/shared/uniTable';

export const studentLeaveRouter = Router();

/** ★ 统一表 edu_stage 取值（本文件主库为实训库） */
const STAGE = 'job' as const;
const DB = 'sms_job';

/** 表名常量 */
const TABLE = 't_job_student_leave';
const STUDENT_TABLE = 't_student_base';
const CLASS_TABLE = 't_job_class';
const CS_TABLE = 't_job_class_student';
const ATT_TABLE = 't_job_attendance';
const REFUND_TABLE = 't_job_refund';

/**
 * ★ 班级库（大学部）的学生表 —— 跨库全限定名（2026-10-05 斌哥报「退学后还显示实训中」）
 *
 * 【为什么需要它】
 *   学生档案在三处各有一份行，而退学/休学/复学**原来只改了 sms_job 这一份**：
 *     · sms_job.t_student_base（实训/就业）← 退学只改了这里
 *     · sms_class.t_class_student（班级-大学部）← 状态还停在「实训中(8)」
 *   于是「教务学生管理」页（三库合并显示）里，同一个学号
 *   class 库那条是「实训中」、job 库那条是「退学(7)」，
 *   显示出来就是「退学后还显示在实训中」——不符合事实。
 *
 * 【同实例跨库】
 *   三个库在同一个 MySQL 实例，所以用全限定名 + 调用方传的同一个事务对象(trx)，
 *   「改我们这边 + 改班级库那边」在**同一事务**里，要么都成、要么都滚。
 *
 * ★ P3 切读层：原来是「库.表」全限定名字符串，现拆成 库名 + 表名，
 *   交给 `tblTrx()` 按开关路由（开关关时仍拼成 `sms_class.t_class_student`）。
 */
const CLASS_DB = 'sms_class';
const CLASS_DB_STUDENT = 't_class_student';

/**
 * 把学生状态**同步到班级库**（休学/退学/复学都走这里）
 *
 * ⚠️ 为什么按学号匹配而不是 id：
 *   两个库的 id 是各自生成的，**同一个人两边 id 不同**（实测），
 *   唯一能对上的就是 `student_no`（学号）。
 *
 * @param trx        调用方事务（必须传，保证跨库原子）
 * @param studentNo  学号
 * @param newStatus  新状态（StudentStatus枚举值）
 * @param operator   操作人
 * @returns 实际更新了几行（0 = 班级库里没有这个人，属正常）
 */
async function syncStatusToClassDB(
  trx: any,
  studentNo: string | null | undefined,
  newStatus: number,
  operator: Operator,
): Promise<number> {
  if (!studentNo) return 0;
  const n = await tblTrx(trx, CLASS_DB, CLASS_DB_STUDENT, 'class')
    .where({ student_no: studentNo, is_deleted: false })
    .update({
      student_status: newStatus,
      update_time: new Date(),
      update_by: operator.userId || 'system',
    });
  return n;
}

/** 花名册状态 */
const CS_IN = 1;
const CS_OUT = 2;

/** 学生状态白名单：只有这些状态能发起休学/退学 */
const ALLOW_INITIATE_STATUS: number[] = [
  StudentStatus.TRIAL,      // 试学中
  StudentStatus.PRE_STUDY,  // 预在读
  StudentStatus.STUDYING,   // 正式在读
  StudentStatus.TRAINING,   // 实训中
];

/* ============================================================
 * 内部工具
 * ============================================================ */

function getOperator(req: any): Operator {
  const u = req.user;
  if (!u) throw new BizError(BizCode.UNAUTHORIZED, '请先登录');
  return { userId: u.userId, userName: u.userName, roles: u.roles || [] };
}

/** bizType(1休学/2退学/3复学) → 审批业务类型字符串 */
function toApprovalBizType(bizType: number): string {
  switch (bizType) {
    case StudentLeaveBizType.SUSPEND:
      return ApprovalBizType.SUSPEND;
    case StudentLeaveBizType.RESUME:
      return ApprovalBizType.RESUME;
    case StudentLeaveBizType.QUIT:
    default:
      return ApprovalBizType.QUIT;
  }
}

/**
 * 算某学生的「已上课时」
 *
 * 口径：该生在 t_job_attendance 里【实际出勤】的天数
 *      （出勤 + 迟到 + 早退 算到；缺勤/请假不算）
 */
async function calcAttendedHours(studentId: string, conn: any = db): Promise<number> {
  const row = await tbl(conn, DB, ATT_TABLE, STAGE)
    .where({ student_id: studentId, is_deleted: false })
    .whereIn('attend_status', [...ATTEND_STATUS_PRESENT_SET])
    .countDistinct({ c: 'attend_date' })
    .first();
  return Number(row?.c || 0);
}

/** 数据库行 → 前端对象 */
function decorate(row: any): any {
  if (!row) return row;
  return {
    id: row.id,

    bizType: row.biz_type,
    bizTypeName: STUDENT_LEAVE_BIZ_TYPE_NAME[row.biz_type] || '',

    studentId: row.student_id,
    studentNo: row.student_no || '',
    studentName: row.student_name || '',
    gender: row.gender ?? null,
    genderName: row.gender ? GENDER_NAME[row.gender] || '' : '',
    idCard: row.id_card || null,
    phone: row.phone || null,
    parentPhone: row.parent_phone || null,
    address: row.address || null,

    classId: row.class_id || null,
    className: row.class_name || null,
    deptName: row.dept_name || (row.dept_code ? DEPT_NAME[row.dept_code] : null) || null,
    deptCode: row.dept_code ?? null,

    // ★【复学班】—— 只有复学单有值，由学管在审批时选定（斌哥 2026-10-01）
    newClassId: row.new_class_id || null,
    newClassName: row.new_class_name || null,

    headTeacherId: row.head_teacher_id || null,
    headTeacherName: row.head_teacher_name || null,

    attendedHours: row.attended_hours ?? null,
    leaveDate: fmtDate(row.leave_date),
    leaveReason: row.leave_reason || '',
    headTeacherOpinion: row.head_teacher_opinion || null,

    approvalId: row.approval_id || null,
    approvalStatus: row.approval_status,
    approvalStatusName: APPROVAL_STATUS_NAME[row.approval_status] || '',

    relatedRefundNo: row.related_refund_no || null,

    remark: row.remark || null,
    createTime: row.create_time ? fmtDateTime(row.create_time) : null,
    updateTime: row.update_time ? fmtDateTime(row.update_time) : null,
  };
}

/** 列表项 + 按钮权限 */
function decorateListItem(row: any, operator: Operator, appr: any): any {
  const base = decorate(row);
  const biz = toApprovalBizType(base.bizType);

  let canApproveIt = false;
  let canCancelIt = false;

  if (appr && !isFinished(appr.status) && appr.status !== ApprovalStatus.DRAFT) {
    canApproveIt = canApprove(biz, appr.current_step, operator.roles);
  }
  // ★ isMyApproval：万能测试号（SUPER_TEST）对「不是自己发起的单子」也放行
  const mine = isMyApproval(appr, operator.userId, operator.roles);
  if (appr && !isFinished(appr.status) && mine) {
    canCancelIt = true;
  }
  if (appr && appr.status === ApprovalStatus.DRAFT && mine) {
    canCancelIt = true;
  }

  return {
    id: base.id,
    bizType: base.bizType,
    bizTypeName: base.bizTypeName,
    studentId: base.studentId,
    studentNo: base.studentNo,
    studentName: base.studentName,
    gender: base.gender,
    genderName: base.genderName,
    className: base.className,
    deptName: base.deptName,
    headTeacherName: base.headTeacherName,
    attendedHours: base.attendedHours,
    leaveDate: base.leaveDate,
    leaveReason: base.leaveReason,
    approvalId: base.approvalId,
    approvalStatus: base.approvalStatus,
    approvalStatusName: base.approvalStatusName,
    currentHandlerHint: appr?.current_handler_hint || null,
    canApprove: canApproveIt,
    canCancel: canCancelIt,
  };
}

/**
 * ★★ 审批全部通过后的动作（休学 / 退学 / 复学 各不同）
 *
 * 必须和审批状态更新在【同一个事务】里 ——
 * 要么状态改了+学生也动了，要么都别动。
 *
 * | 类型 | 学生状态 | 花名册 | 宿舍 | 通知 |
 * |---|---|---|---|---|
 * | 休学 | → SUSPENDED(6) | 当前班**离班** | **保留**（学生还会回来） | 发（财务冻结） |
 * | 退学 | → QUIT(7) | 当前班**离班** | ★ **生成退宿申请走教务审批**（2026-10-01 改，不再直接释放床位） | 发 + 生成退学退费单 |
 * | 复学 | → TRAINING(8) | 【复学班】**入班**（join_type=休学复学） | 沿用原床位；已退宿则留空 | ★ **不发**（斌哥 2026-10-01） |
 */
async function afterApproved(
  trx: any,
  row: any,
  operator: Operator,
): Promise<void> {
  const isResume = row.biz_type === StudentLeaveBizType.RESUME;
  const isSuspend = row.biz_type === StudentLeaveBizType.SUSPEND;
  const now = new Date();

  // ---- ① 改学生主档状态 ----
  //      休学 → SUSPENDED(6) / 退学 → QUIT(7) / 复学 → TRAINING(8)
  const newStatus = isResume
    ? StudentStatus.TRAINING
    : isSuspend
      ? StudentStatus.SUSPENDED
      : StudentStatus.QUIT;

  const patch: Record<string, any> = {
    student_status: newStatus,
    update_time: now,
    update_by: operator.userId,
  };

  if (isResume) {
    // ★ 复学：回到【复学班】—— **学管审批时选定的那个班**（单据的 new_class_id）
    //   ⚠️ t_student_base 没有 dept_name 字段，只写 dept_code（从复学班带出来）
    const resumeCls = row.new_class_id
      ? await tblTrx(trx, DB, CLASS_TABLE, STAGE).where({ id: row.new_class_id }).first()
      : null;
    patch.class_id = row.new_class_id;
    patch.class_name = row.new_class_name;
    if (resumeCls?.dept_code != null) patch.dept_code = resumeCls.dept_code;
    // 宿舍：休学期间**没退宿** → 沿用原床位（这里不动）；
    //       已退宿（dorm_id 为空）→ 保持为空，由复学班班主任后续在宿舍模块分配。
  } else if (!isSuspend) {
    // ★ 退学：**不再直接清宿舍字段**（斌哥 2026-10-01 改造）
    //
    //   以前这里是 `patch.dorm_id = null; patch.dorm_no = null;` ——
    //   只清了学生主档的宿舍字段，**床位表一行没动**，导致：
    //     · 那张床在系统里永远显示"已占用"，别人分不进来
    //     · t_job_dorm.used_count 也不准（虚高）
    //   （这是个真 bug —— 床位没有真正释放。）
    //
    //   现在改成走「退宿申请 → 教务老师审批」，
    //   审批通过时 dorm.route.ts 的 afterApproved() 会**正确地释放床位**。
    //   单据在下方的「②' 退学结算」里生成。
  }

  await tblTrx(trx, DB, STUDENT_TABLE, STAGE).where({ id: row.student_id }).update(patch);

  // ★★ 2026-10-05 治本：同步到班级库（sms_class.t_class_student）
  //
  //   【为什么必须同步】
  //     同一个学号在三处各有一份行，退学/休学/复学原来**只改了 sms_job 这一份**。
  //     而「教务学生管理」页是三库合并显示，class 库那条还停在「实训中(8)」→
  //     斌哥报的「子墨退学后，教务还显示在实训中，不符合事实」。
  //
  //   【和 trx 同源，跨库原子】
  //     三个库在同一个 MySQL 实例，用全限定名 + 同一个事务对象，
  //     「改我们这边 + 改班级库那边」要么都成、要么都滚，不会出现「改了一半」。
  //
  //   【查不到怎么办】
  //     班级库里没有这个人（他可能从没进过大学部）→ 返回 0，属正常，不报错。
  await syncStatusToClassDB(trx, row.student_no, newStatus, operator);

  // ---- ② 花名册 ----
  if (isResume) {
    // ★ 复学 = 【复学班】新增一条「在班」记录 ——
    //   不能简单把老记录改回在班：复学可能换班，且老记录可能属于已结业的班。
    //   ⚠️ 唯一索引 uk_in_class 只保「在班唯一」，所以重复复学不会插重。
    //   ⚠️ 这里的班级是 **row.new_class_id**（学管审批时选定的复学班），
    //      不是 row.class_id（那是学生休学前的原班）。
    const exist = await tblTrx(trx, DB, CS_TABLE, STAGE)
      .where({
        class_id: row.new_class_id,
        student_id: row.student_id,
        status: CS_IN,
        is_deleted: false,
      })
      .first();
    if (!exist) {
      await tblInsTrx(trx, DB, CS_TABLE, STAGE, {
        id: randomUUID(),
        create_time: now,
        create_by: operator.userId,
        is_deleted: false,
        class_id: row.new_class_id,
        class_name: row.new_class_name,
        student_id: row.student_id,
        student_no: row.student_no,
        student_name: row.student_name,
        status: CS_IN,
        join_date: row.leave_date || today(),
        join_type: JoinType.RESUME, // 4 = 休学复学
      });
    }
  } else {
    // 休学 / 退学 → 当前班那条改「已离班」
    // ⚠️ 必须限定 class_id —— 一个学生可能有多条花名册记录（转班历史遗留），
    //    只应把【当前所在班】那条改成离班，不能把历史班的记录也一起改了。
    const csWhere: Record<string, any> = {
      student_id: row.student_id,
      status: CS_IN,
      is_deleted: false,
    };
    if (row.class_id) csWhere.class_id = row.class_id;

    await tblTrx(trx, DB, CS_TABLE, STAGE).where(csWhere).update({
      status: CS_OUT,
      leave_date: row.leave_date || today(),
      leave_type: isSuspend ? 3 : 4, // 3休学 4退学
      leave_reason: row.leave_reason || null,
      update_time: now,
      update_by: operator.userId,
    });
  }

  // ---- ②' 退学结算：生成退宿申请 + 退学退费合并单（斌哥 2026-10-01 新增）----
  //   ① 有宿舍的 → 生成退宿申请（走教务审批，**通过后才释放床位**）
  //   ② 生成一张「退学退费」合并单：学费 + 住宿费 + 餐费，三项明细分开记
  //      （金额先填 0 —— 系统拿不到缴费数据，由班主任核对后填）
  //   ③ 通知班主任去填金额、提交
  if (!isResume && !isSuspend) {
    await settleQuit(trx, row, operator);
  }

  // ---- ③ 通知 ----
  // ★ 复学不发通知（斌哥 2026-10-01 拍板）；休学/退学发（财务冻结/退费）
  if (isResume) return;

  try {
    await sendNotice(
      {
        noticeType: NOTICE_TYPE.APPROVAL,
        title: `【${isSuspend ? '休学' : '退学'}已通过】请处理费用`,
        content:
          `${row.student_name || ''}（${row.student_no || ''}）的` +
          `${isSuspend ? '休学' : '退学'}申请已审批通过。` +
          (isSuspend
            ? '请冻结该生相关费用。'
            : '已自动生成「退学退费」单（学费+住宿费+餐费），请班主任核对金额后提交审批。退学按全额退，不按天扣费。'),
        // ⚠️ 财务角色已移除（斌哥 2026-09-30），这条通知改发给系统管理员留痕。
        //    业务口径：本模块「审批通过就结束」，出款是财务模块 8005 自己看审批单处理。
        receiverId: RoleCode.SYS_ADMIN,
        receiverName: '系统管理员',
        receiverRole: RoleCode.SYS_ADMIN,
        bizType: toApprovalBizType(row.biz_type),
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
 * 1. 列表
 *    GET /api/job/student-leave/page
 * ============================================================ */

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(200).default(20),
  keyword: z.string().optional(),
  bizType: z.coerce.number().int().min(1).max(3).optional(),
  classId: z.string().optional(),
  deptCode: z.coerce.number().int().optional(),
  approvalStatus: z.coerce.number().int().optional(),
  onlyMine: z.coerce.boolean().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

studentLeaveRouter.get(
  '/page',
  validate(listSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as z.infer<typeof listSchema>;
    const operator = getOperator(req);

    // ⚠️ 始终 leftJoin 审批表（canApprove 需要，且避免别名不存在报错）
    const query = tblAs(db, DB, TABLE, STAGE, 'l')
      .leftJoin(`${tblRef(DB, APPROVAL_TABLE)} as a`, 'l.approval_id', 'a.id')
      .where('l.is_deleted', false);

    // ★ 数据范围：班主任只能看**自己带的班**的申请（斌哥 2026-09-30）
    //
    //   之前这里没有过滤 —— 班主任能看到全校的休学/退学单，
    //   和「我带的班」这个口径不一致（别的地方都限了，就这里漏了）。
    //
    //   口径同其它模块：以**班级表**的 head_teacher_id 为准
    //   （申请单上的 head_teacher_id 是快照，交接后就不准了）。
    // ★ 2026-10-08 修：补上项目经理（原来只判班主任 → 项目经理能看全校申请单）
    const _s1 = operator.roles;
    const _adm1 = hasRole(_s1, RoleCode.SYS_ADMIN);
    const _pm1 = hasRole(_s1, RoleCode.PROJECT_MANAGER);
    const _hd1 = hasRole(_s1, RoleCode.TEACH_HEAD);
    if (!_adm1 && _pm1) {
      const myClasses = await tbl(db, DB, CLASS_TABLE, STAGE)
        .where({ project_manager_id: operator.userId, is_deleted: false })
        // [已停用] ★ 2026-10-08 斌哥拍板：项目经理可见自己带的【所有】实训班（含已结业）—— 去掉未结业限制
        // .whereNot('class_status', ClassStatus.GRADUATED)
        .select('id');
      const ids = myClasses.map((c: any) => c.id);
      if (ids.length === 0) query.whereRaw('1 = 0');
      else query.whereIn('l.class_id', ids);
    } else if (!_adm1 && _hd1) {
      const myClasses = await tbl(db, DB, CLASS_TABLE, STAGE)
        .where({ head_teacher_id: operator.userId, is_deleted: false })
        .select('id');
      // 一个班都没有 → 传空数组，结果自然是空的（不会误放开成"看全部"）
      query.whereIn(
        'l.class_id',
        myClasses.map((c: any) => c.id),
      );
    }

    if (q.keyword) {
      query.andWhere((b: import('knex').Knex.QueryBuilder) => {
        b.where('l.student_name', 'like', `%${q.keyword}%`)
          .orWhere('l.student_no', 'like', `%${q.keyword}%`);
      });
    }
    if (q.bizType) query.andWhere('l.biz_type', q.bizType);
    if (q.classId) query.andWhere('l.class_id', q.classId);
    if (q.deptCode) query.andWhere('l.dept_code', q.deptCode);
    if (q.approvalStatus) query.andWhere('l.approval_status', q.approvalStatus);
    if (q.startDate) query.andWhere('l.leave_date', '>=', q.startDate);
    if (q.endDate) query.andWhere('l.leave_date', '<=', q.endDate);

    // ★ 只看"待我审批"：分业务类型判断（休学只 1 步、退学 2 步）
    if (q.onlyMine) {
      query.whereNotIn('a.status', [
        ApprovalStatus.DRAFT,
        ApprovalStatus.APPROVED,
        ApprovalStatus.REJECTED,
        ApprovalStatus.CANCELED,
      ]);

      // 我能批哪几步（休学和退学的链不一样，要合起来算）
      const steps: Array<{ biz: string; step: number }> = [];
      if (canApprove(ApprovalBizType.SUSPEND, 1, operator.roles)) {
        steps.push({ biz: ApprovalBizType.SUSPEND, step: 1 });
      }
      if (canApprove(ApprovalBizType.QUIT, 1, operator.roles)) {
        steps.push({ biz: ApprovalBizType.QUIT, step: 1 });
      }
      if (canApprove(ApprovalBizType.QUIT, 2, operator.roles)) {
        steps.push({ biz: ApprovalBizType.QUIT, step: 2 });
      }
      // ★ 复学（1 步，学管）—— 2026-10-01 新增
      if (canApprove(ApprovalBizType.RESUME, 1, operator.roles)) {
        steps.push({ biz: ApprovalBizType.RESUME, step: 1 });
      }
      if (!steps.length) {
        res.json(page([], 0, q));
        return;
      }

      // 审批 bizType 字符串 ↔ 单据 biz_type 数字
      const BIZ_TO_NUM: Record<string, number> = {
        [ApprovalBizType.SUSPEND]: 1,
        [ApprovalBizType.QUIT]: 2,
        [ApprovalBizType.RESUME]: 3,
      };
      query.andWhere((b: import('knex').Knex.QueryBuilder) => {
        for (const s of steps) {
          const bt = BIZ_TO_NUM[s.biz];
          b.orWhere((x) => x.where('l.biz_type', bt).andWhere('a.current_step', s.step));
        }
      });
    }

    const [{ total }] = await query.clone().count({ total: 'l.id' });

    const rows = await query
      .clone()
      .select(
        'l.*',
        'a.status as _a_status',
        'a.current_step as _a_step',
        'a.current_handler_hint as _a_hint',
        'a.applicant_id as _a_applicant',
      )
      .orderBy('l.create_time', 'desc')
      .limit(q.size)
      .offset((q.page - 1) * q.size);

    const list = rows.map((r: any) =>
      decorateListItem(r, operator, {
        status: r._a_status,
        current_step: r._a_step,
        current_handler_hint: r._a_hint,
        applicant_id: r._a_applicant,
      }),
    );

    res.json(page(list, Number(total), q));
  }),
);

/* ============================================================
 * 2. 详情（含审批轨迹 + 流程条 + 该生的退费单）
 *    GET /api/job/student-leave/detail?id=xxx
 *
 * ★ xmind 要求「查看退费表」：按学号查同一学生的申请 → 这里一并返回
 * ============================================================ */

studentLeaveRouter.get(
  '/detail',
  validate(z.object({ id: z.string().min(1, '申请单ID必传') })),
  wrap(async (req, res) => {
    const q = (req as any).validated;
    const operator = getOperator(req);

    const row = await tbl(db, DB, TABLE, STAGE).where({ id: q.id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.STUDENT_LEAVE_NOT_FOUND, '休学/退学申请不存在');

    const biz = toApprovalBizType(row.biz_type);
    const appr = row.approval_id ? await getApproval(row.approval_id) : null;
    const logs = row.approval_id ? await getApprovalLogs(row.approval_id) : [];
    const chainNodes = appr ? await buildChainNodes(biz, appr) : [];

    const base = decorate(row);

    let canApproveIt = false;
    let canCancelIt = false;
    if (appr && !isFinished(appr.status) && appr.status !== ApprovalStatus.DRAFT) {
      canApproveIt = canApprove(biz, appr.current_step, operator.roles);
    }
    if (appr && !isFinished(appr.status) && isMyApproval(appr, operator.userId, operator.roles)) {
      canCancelIt = true;
    }

    // ★ 该学生的历史退费单（xmind：查看退费表 → 按学号查同学生的申请）
    // ⚠️ 不要再 select `refund_no` —— 该字段 2026-09-30 已删（迁移 007），
    //    带上它会让整个「详情」接口报 50002「数据库字段不存在」。
    const refunds = await tbl(db, DB, REFUND_TABLE, STAGE)
      .where({ student_id: row.student_id, is_deleted: false })
      .select('id', 'refund_type_name', 'refund_amount', 'apply_date', 'approval_status')
      .orderBy('apply_date', 'desc');

    // 该生的其他休学/退学记录
    const history = await tbl(db, DB, TABLE, STAGE)
      .where({ student_id: row.student_id, is_deleted: false })
      .whereNot('id', row.id)
      .select('id', 'biz_type', 'leave_date', 'approval_status')
      .orderBy('leave_date', 'desc');

    res.json(
      ok({
        ...base,
        canApprove: canApproveIt,
        canCancel: canCancelIt,
        currentStep: appr?.current_step || 0,
        totalSteps: chainNodes.length,
        chainNodes,
        logs: logs.map((l: any) => ({
          id: l.id,
          step: l.step,
          nodeName: l.node_name,
          operatorId: l.operator_id,
          operatorName: l.operator_name,
          operatorRole: l.operator_role,
          action: l.action,
          actionName: l.action_name,
          comment: l.comment,
          createTime: l.create_time ? fmtDateTime(l.create_time) : null,
          avatarText: (l.operator_name || '?').slice(0, 1),
        })),
        refunds: refunds.map((r: any) => ({
          id: r.id,
          refundTypeName: r.refund_type_name,
          refundAmountText: (Number(r.refund_amount || 0) / 100).toFixed(2),
          applyDate: fmtDate(r.apply_date),
          approvalStatusName: APPROVAL_STATUS_NAME[r.approval_status] || '',
        })),
        history: history.map((h: any) => ({
          id: h.id,
          bizTypeName: STUDENT_LEAVE_BIZ_TYPE_NAME[h.biz_type] || '',
          leaveDate: fmtDate(h.leave_date),
          approvalStatusName: APPROVAL_STATUS_NAME[h.approval_status] || '',
        })),
      }),
    );
  }),
);

/* ============================================================
 * 3. 新建申请（班主任）
 *    POST /api/job/student-leave/create
 *
 * 流程：
 *   ① 校验学生存在 + 状态允许
 *   ② 校验没有未完成的同类申请
 *   ③ 取学生/班级快照 + 算已上课时
 *   ④ 建申请单（草稿）+ 建审批单 + 关联
 *   ⑤ 可选直接提交
 * ============================================================ */

const createSchema = z.object({
  bizType: z.number().int().min(1).max(3, '类型只能是 1休学 / 2退学 / 3复学'),
  studentId: z.string().min(1, '学生必选'),
  // ⚠️ 建单**不收** classId —— 复学班级由学管在**审批时**选定（斌哥 2026-10-01）
  leaveDate: z.string().optional(),
  leaveReason: z.string().min(1, '原因必填').max(500),
  headTeacherOpinion: z.string().max(500).optional(),
  idCard: z.string().max(32).optional(),
  address: z.string().max(200).optional(),
  remark: z.string().max(500).optional(),
  submit: z.boolean().optional(),
});

studentLeaveRouter.post(
  '/create',
  validate(createSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof createSchema>;
    const operator = getOperator(req);

    if (!canInitiate(toApprovalBizType(body.bizType), operator.roles)) {
      throw new BizError(BizCode.NO_OPERATION_PERMISSION, '只有班主任能发起休学/退学/复学申请');
    }

    const stu = await tbl(db, DB, STUDENT_TABLE, STAGE).where({ id: body.studentId, is_deleted: false }).first();
    if (!stu) throw new BizError(BizCode.STUDENT_NOT_FOUND, '学生不存在');

    const isResume = body.bizType === StudentLeaveBizType.RESUME;

    // ① 状态校验
    //    ★ 复学只针对「已休学」的学生；休学/退学只针对在校状态的学生。
    if (isResume) {
      if (stu.student_status !== StudentStatus.SUSPENDED) {
        throw new BizError(
          BizCode.STUDENT_STATUS_NOT_ALLOW,
          `只有「休学」状态的学生能发起复学申请，该生当前是「${
            STUDENT_STATUS_NAME[stu.student_status] || stu.student_status
          }」`,
        );
      }
    } else if (!ALLOW_INITIATE_STATUS.includes(stu.student_status)) {
      const blockReason: Record<number, string> = {
        [StudentStatus.SUSPENDED]: '已休学',
        [StudentStatus.QUIT]: '已退学',
        [StudentStatus.EMPLOYED]: '已就业',
        [StudentStatus.LOST]: '已流失',
      };
      const stName =
        blockReason[stu.student_status] || `当前状态(${stu.student_status})`;
      throw new BizError(
        BizCode.STUDENT_STATUS_NOT_ALLOW,
        `该学生${stName}，不能再发起休学/退学申请`,
      );
    }

    // ② 重复校验：同一学生 + 同类型 + 未结束
    const dup = await tblAs(db, DB, TABLE, STAGE, 'l')
      .join(`${tblRef(DB, APPROVAL_TABLE)} as a`, 'l.approval_id', 'a.id')
      .where('l.student_id', stu.id)
      .andWhere('l.biz_type', body.bizType)
      .andWhere('l.is_deleted', false)
      .whereNotIn('a.status', [ApprovalStatus.APPROVED, ApprovalStatus.REJECTED, ApprovalStatus.CANCELED])
      .select('l.id')
      .first();
    if (dup) {
      throw new BizError(
        BizCode.STUDENT_LEAVE_DUPLICATE,
        `该学生已有未完成的${STUDENT_LEAVE_BIZ_TYPE_NAME[body.bizType]}申请`,
      );
    }

    // 日期校验
    const leaveDate = body.leaveDate || today();
    if (stu.enroll_date && leaveDate < fmtDate(stu.enroll_date)) {
      throw new BizError(BizCode.LEAVE_DATE_INVALID, '休学/退学日期不能早于入学日期');
    }

    // ③ 数据范围：班主任只能给自己带的班的学生发起申请（与 /page 口径一致）
    //    ★ 复学也一样看**学生当前所在班** ——
    //      因为复学班级是**学管审批时**才选的，班主任发起时只负责"这学生是我班的"。
    // ★ 2026-10-08 修：补上项目经理
    const _s2 = operator.roles;
    const _adm2 = hasRole(_s2, RoleCode.SYS_ADMIN);
    const _pm2 = hasRole(_s2, RoleCode.PROJECT_MANAGER);
    const _hd2 = hasRole(_s2, RoleCode.TEACH_HEAD);
    if (!_adm2 && (_pm2 || _hd2)) {
      if (!stu.class_id) {
        throw new BizError(BizCode.NO_OPERATION_PERMISSION, '该学生没有班级，无法发起申请');
      }
      const mine = _pm2
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
          _pm2 ? '只能给自己带的实训班学生发起申请' : '只能给自己班级的学生发起申请',
        );
      }
    }

    // ★ 班级快照 = 学生**当前所在班**
    //   ⚠️ 复学单的「复学班」存在另一列 `new_class_id`（学管审批时写入），
    //      这里写入的 `class_id` 是**原班**（"他休学前在哪个班"）。
    let cls: any = null;
    if (stu.class_id) {
      cls = await tbl(db, DB, CLASS_TABLE, STAGE).where({ id: stu.class_id, is_deleted: false }).first();
    }

    const id = randomUUID();
    const now = new Date();
    const attendedHours = await calcAttendedHours(stu.id);

    await db.transaction(async (trx) => {
  
      await tblInsTrx(trx, DB, TABLE, STAGE, {
        id,
        create_time: now,
        create_by: operator.userId,
        is_deleted: false,

        biz_type: body.bizType,

        student_id: stu.id,
        student_no: stu.student_no || null,
        student_name: stu.student_name || null,
        gender: stu.gender ?? null,
        id_card: body.idCard || null,
        phone: stu.phone || null,
        parent_phone: stu.parent_phone || null,
        address: body.address || null,

        class_id: cls?.id || stu.class_id || null,
        class_name: cls?.class_name || stu.class_name || null,
        // t_job_class / t_student_base 都没有 dept_name，统一用 dept_code 映射
        dept_name: DEPT_NAME[cls?.dept_code ?? stu.dept_code] || null,
        dept_code: cls?.dept_code ?? stu.dept_code ?? null,

        head_teacher_id: cls?.head_teacher_id || stu.head_teacher_id || operator.userId,
        head_teacher_name: cls?.head_teacher_name || stu.head_teacher_name || operator.userName,

        attended_hours: attendedHours,
        leave_date: leaveDate,
        leave_reason: body.leaveReason,
        head_teacher_opinion: body.headTeacherOpinion || null,

        approval_status: ApprovalStatus.DRAFT,
        remark: body.remark || null,
      });

      const approvalId = await createApproval(
        {
          bizType: toApprovalBizType(body.bizType),
          bizId: id,
          applicant: operator,
          studentId: stu.id,
          studentNo: stu.student_no || undefined,
          studentName: stu.student_name || undefined,
          classId: cls?.id || stu.class_id || undefined,
          className: cls?.class_name || stu.class_name || undefined,
          deptCode: cls?.dept_code ?? stu.dept_code ?? undefined,
        },
        trx,
      );

      await tblTrx(trx, DB, TABLE, STAGE).where({ id }).update({ approval_id: approvalId });

      if (body.submit) {
        await submitApproval(approvalId, operator, trx);
        await tblTrx(trx, DB, TABLE, STAGE).where({ id }).update({
          approval_status: ApprovalStatus.PENDING_MANAGER,
          update_time: now,
        });
      }
    });

    res.json(ok({ id }));
  }),
);

/* ============================================================
 * 4. 提交
 *    POST /api/job/student-leave/submit
 * ============================================================ */

studentLeaveRouter.post(
  '/submit',
  validate(z.object({ id: z.string().min(1, '申请单ID必传') })),
  wrap(async (req, res) => {
    const body = (req as any).validated;
    const operator = getOperator(req);

    const row = await tbl(db, DB, TABLE, STAGE).where({ id: body.id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.STUDENT_LEAVE_NOT_FOUND, '申请单不存在');
    if (!row.approval_id) throw new BizError(BizCode.APPROVAL_NOT_FOUND, '该单没有关联审批单');

    await db.transaction(async (trx) => {
      await submitApproval(row.approval_id, operator, trx);
      await tblTrx(trx, DB, TABLE, STAGE).where({ id: row.id }).update({
        approval_status: ApprovalStatus.PENDING_MANAGER,
        update_time: new Date(),
        update_by: operator.userId,
      });
    });

    res.json(ok(null));
  }),
);

/* ============================================================
 * 5. 同意（学管 / 校长）
 *    POST /api/job/student-leave/approve
 *
 * ★★ 这是和退费最大的不同 ——
 *    全部通过时，要执行 afterApproved()（改学生状态 + 离班 + 通知财务）
 * ============================================================ */

studentLeaveRouter.post(
  '/approve',
  validate(
    z.object({
      id: z.string().min(1, '申请单ID必传'),
      comment: z.string().max(500).optional(),
      // ★ 复学专用：**学管审批时选定复学班级**（斌哥 2026-10-01 修正流程）
      classId: z.string().max(36).optional(),
    }),
  ),
  wrap(async (req, res) => {
    const body = (req as any).validated;
    const operator = getOperator(req);

    const row = await tbl(db, DB, TABLE, STAGE).where({ id: body.id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.STUDENT_LEAVE_NOT_FOUND, '申请单不存在');
    if (!row.approval_id) throw new BizError(BizCode.APPROVAL_NOT_FOUND, '该单没有关联审批单');

    const isResume = row.biz_type === StudentLeaveBizType.RESUME;

    let finished = false;
    let nextStatus = ApprovalStatus.PENDING_MANAGER;

    await db.transaction(async (trx) => {
      // ① 先走审批引擎
      //    ★ 权限校验在 doApprove 里 —— 越权会直接抛 40302，
      //      下面的"写复学班"根本不会执行（事务回滚）。
      const result = await doApprove(row.approval_id, operator, body.comment, trx);
      finished = result.finished;
      nextStatus = result.status;

      const patch: Record<string, any> = {
        approval_status: nextStatus,
        update_time: new Date(),
        update_by: operator.userId,
      };

      // ② ★ 复学：**批到"通过"那一刻**才落「复学班」
      //    复学班级是学管在审批这一步选定的，所以必须选；没选就拦。
      //    排在 doApprove 之后 = 权限优先（越权的人不会先改动单据）。
      if (isResume && finished) {
        if (!body.classId) {
          throw new BizError(BizCode.PARAM_ERROR, '复学审批必须选定复学班级');
        }
        const resumeCls = await tblTrx(trx, DB, CLASS_TABLE, STAGE)
          .where({ id: body.classId, is_deleted: false })
          .first();
        if (!resumeCls) throw new BizError(BizCode.CLASS_NOT_FOUND, '复学班级不存在');
        patch.new_class_id = resumeCls.id;
        patch.new_class_name = resumeCls.class_name;
      }

      await tblTrx(trx, DB, TABLE, STAGE).where({ id: row.id }).update(patch);

      // ③ 全流程走完 → 执行"通过后的动作"
      //    ⚠️ 必须**重新读一次**单据 —— 刚刚才写入 new_class_id，
      //       用旧 row 的话 afterApproved 拿不到复学班。
      if (finished) {
        const fresh = await tblTrx(trx, DB, TABLE, STAGE).where({ id: row.id }).first();
        await afterApproved(trx, fresh, operator);
      }
    });

    res.json(
      ok({
        finished,
        approvalStatus: nextStatus,
        approvalStatusName: APPROVAL_STATUS_NAME[nextStatus] || '',
      }),
    );
  }),
);

/* ============================================================
 * 6. 驳回
 *    POST /api/job/student-leave/reject
 * ============================================================ */

studentLeaveRouter.post(
  '/reject',
  validate(
    z.object({
      id: z.string().min(1, '申请单ID必传'),
      reason: z.string().min(1, '驳回原因必填').max(500),
    }),
  ),
  wrap(async (req, res) => {
    const body = (req as any).validated;
    const operator = getOperator(req);

    const row = await tbl(db, DB, TABLE, STAGE).where({ id: body.id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.STUDENT_LEAVE_NOT_FOUND, '申请单不存在');
    if (!row.approval_id) throw new BizError(BizCode.APPROVAL_NOT_FOUND, '该单没有关联审批单');

    await db.transaction(async (trx) => {
      await doReject(row.approval_id, operator, body.reason, trx);
      await tblTrx(trx, DB, TABLE, STAGE).where({ id: row.id }).update({
        approval_status: ApprovalStatus.REJECTED,
        update_time: new Date(),
        update_by: operator.userId,
      });
    });

    res.json(ok(null));
  }),
);

/* ============================================================
 * 7. 撤回
 *    POST /api/job/student-leave/cancel
 * ============================================================ */

studentLeaveRouter.post(
  '/cancel',
  validate(
    z.object({
      id: z.string().min(1, '申请单ID必传'),
      reason: z.string().max(500).optional(),
    }),
  ),
  wrap(async (req, res) => {
    const body = (req as any).validated;
    const operator = getOperator(req);

    const row = await tbl(db, DB, TABLE, STAGE).where({ id: body.id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.STUDENT_LEAVE_NOT_FOUND, '申请单不存在');
    if (!row.approval_id) throw new BizError(BizCode.APPROVAL_NOT_FOUND, '该单没有关联审批单');

    await db.transaction(async (trx) => {
      await doCancel(row.approval_id, operator, body.reason, trx);
      await tblTrx(trx, DB, TABLE, STAGE).where({ id: row.id }).update({
        approval_status: ApprovalStatus.CANCELED,
        update_time: new Date(),
        update_by: operator.userId,
      });
    });

    res.json(ok(null));
  }),
);

/* ============================================================
 * 8. 可选学生
 *    GET /api/job/student-leave/student-options?keyword=xxx&bizType=1
 *
 * ⚠️ 按业务类型过滤：
 *      bizType=1休学 / 2退学 → 只列「在校」的学生（已休学/已退学的排除）
 *      bizType=3复学         → 只列「已休学」的学生（只有他们能复学）
 * ============================================================ */

studentLeaveRouter.get(
  '/student-options',
  validate(
    z.object({
      keyword: z.string().optional(),
      /** 1休学 2退学 3复学（不传=按休学/退学口径） */
      bizType: z.coerce.number().int().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }),
  ),
  wrap(async (req, res) => {
    const q = (req as any).validated;
    const operator = getOperator(req);

    const isResume = q.bizType === StudentLeaveBizType.RESUME;

    const query = tblAs(db, DB, STUDENT_TABLE, STAGE, 's')
      .leftJoin(`${tblRef(DB, CLASS_TABLE)} as c`, 's.class_id', 'c.id')
      .where('s.is_deleted', false)
      .whereIn(
        's.student_status',
        isResume ? [StudentStatus.SUSPENDED] : ALLOW_INITIATE_STATUS,
      );

    // ★ 数据范围：班主任只能看到**自己带的班**的学生
    //   （与 /page、出勤等模块口径一致 —— 都看班级表的 head_teacher_id）
    // ★ 2026-10-08 修：补上项目经理
    const _s3 = operator.roles;
    const _adm3 = hasRole(_s3, RoleCode.SYS_ADMIN);
    const _pm3 = hasRole(_s3, RoleCode.PROJECT_MANAGER);
    const _hd3 = hasRole(_s3, RoleCode.TEACH_HEAD);
    if (!_adm3 && _pm3) {
      const myClasses = await tbl(db, DB, CLASS_TABLE, STAGE)
        .where({ project_manager_id: operator.userId, is_deleted: false })
        // [已停用] ★ 2026-10-08 斌哥拍板：项目经理可见自己带的【所有】实训班（含已结业）—— 去掉未结业限制
        // .whereNot('class_status', ClassStatus.GRADUATED)
        .select('id');
      const ids = myClasses.map((c: any) => c.id);
      if (ids.length === 0) query.whereRaw('1 = 0');
      else query.whereIn('s.class_id', ids);
    } else if (!_adm3 && _hd3) {
      const myClasses = await tbl(db, DB, CLASS_TABLE, STAGE)
        .where({ head_teacher_id: operator.userId, is_deleted: false })
        .select('id');
      query.whereIn(
        's.class_id',
        myClasses.map((c: any) => c.id),
      );
    }

    if (q.keyword) {
      query.andWhere((b: import('knex').Knex.QueryBuilder) => {
        b.where('s.student_name', 'like', `%${q.keyword}%`).orWhere(
          's.student_no',
          'like',
          `%${q.keyword}%`,
        );
      });
    }

    const rows = await query
      .select(
        's.id as student_id',
        's.student_no',
        's.student_name',
        's.gender',
        's.phone',
        's.parent_phone',
        's.dorm_no',
        'c.class_name',
        'c.dept_code',
        // ⚠️ t_job_class 表【没有 dept_name 字段】（只有 dept_code），
        //    部门名称统一用 DEPT_NAME[dept_code] 映射（见下），不要在这里 select 它，
        //    否则会报 50002「数据库字段不存在」。
        'c.head_teacher_id',
        'c.head_teacher_name',
      )
      .orderBy('s.student_no', 'asc')
      .limit(q.limit);

    // 已上课时逐个人算（学生数量不会太多，可接受）
    const list = [];
    for (const r of rows) {
      list.push({
        studentId: r.student_id,
        studentNo: r.student_no,
        studentName: r.student_name,
        gender: r.gender ?? null,
        genderName: r.gender ? GENDER_NAME[r.gender] || '' : '',
        className: r.class_name || null,
        deptCode: r.dept_code ?? null,
        deptName: DEPT_NAME[r.dept_code] || null,
        headTeacherId: r.head_teacher_id || null,
        headTeacherName: r.head_teacher_name || null,
        attendedHours: await calcAttendedHours(r.student_id),
        phone: r.phone || null,
        parentPhone: r.parent_phone || null,
        dormNo: r.dorm_no || null,
      });
    }

    res.json(ok(list));
  }),
);

/* ============================================================
 * 9. 统计
 *    GET /api/job/student-leave/summary
 * ============================================================ */

studentLeaveRouter.get(
  '/summary',
  wrap(async (req, res) => {
    const operator = getOperator(req);

    const totalRow = await tbl(db, DB, TABLE, STAGE).where('is_deleted', false).count({ c: 'id' }).first();
    const suspendRow = await tbl(db, DB, TABLE, STAGE)
      .where({ is_deleted: false, biz_type: StudentLeaveBizType.SUSPEND })
      .count({ c: 'id' })
      .first();
    const quitRow = await tbl(db, DB, TABLE, STAGE)
      .where({ is_deleted: false, biz_type: StudentLeaveBizType.QUIT })
      .count({ c: 'id' })
      .first();
    const resumeRow = await tbl(db, DB, TABLE, STAGE)
      .where({ is_deleted: false, biz_type: StudentLeaveBizType.RESUME })
      .count({ c: 'id' })
      .first();
    const pendingMgr = await tbl(db, DB, TABLE, STAGE)
      .where({ is_deleted: false, approval_status: ApprovalStatus.PENDING_MANAGER })
      .count({ c: 'id' })
      .first();
    const pendingPrincipal = await tbl(db, DB, TABLE, STAGE)
      .where({ is_deleted: false, approval_status: ApprovalStatus.PENDING_PRINCIPAL })
      .count({ c: 'id' })
      .first();
    const approved = await tbl(db, DB, TABLE, STAGE)
      .where({ is_deleted: false, approval_status: ApprovalStatus.APPROVED })
      .count({ c: 'id' })
      .first();

    // 待我审批
    let myCount = 0;
    const steps: Array<{ bt: number; step: number }> = [];
    if (canApprove(ApprovalBizType.SUSPEND, 1, operator.roles)) steps.push({ bt: 1, step: 1 });
    if (canApprove(ApprovalBizType.QUIT, 1, operator.roles)) steps.push({ bt: 2, step: 1 });
    if (canApprove(ApprovalBizType.QUIT, 2, operator.roles)) steps.push({ bt: 2, step: 2 });
    if (canApprove(ApprovalBizType.RESUME, 1, operator.roles)) steps.push({ bt: 3, step: 1 });

    if (steps.length) {
      const r = await tblAs(db, DB, TABLE, STAGE, 'l')
        .join(`${tblRef(DB, APPROVAL_TABLE)} as a`, 'l.approval_id', 'a.id')
        .where('l.is_deleted', false)
        .whereNotIn('a.status', [
          ApprovalStatus.DRAFT,
          ApprovalStatus.APPROVED,
          ApprovalStatus.REJECTED,
          ApprovalStatus.CANCELED,
        ])
        .andWhere((b: import('knex').Knex.QueryBuilder) => {
          for (const s of steps) {
            b.orWhere((x) => x.where('l.biz_type', s.bt).andWhere('a.current_step', s.step));
          }
        })
        .count({ c: 'l.id' })
        .first();
      myCount = Number(r?.c || 0);
    }

    res.json(
      ok({
        total: Number(totalRow?.c || 0),
        suspendCount: Number(suspendRow?.c || 0),
        quitCount: Number(quitRow?.c || 0),
        resumeCount: Number(resumeRow?.c || 0),
        pendingMgr: Number(pendingMgr?.c || 0),
        pendingPrincipal: Number(pendingPrincipal?.c || 0),
        approved: Number(approved?.c || 0),
        myPending: myCount,
      }),
    );
  }),
);
