/**
 * 审批流服务（★ 通用审批的核心实现）
 *
 * 归属模块：就业管理 > 实训阶段（马志斌）
 * 创建时间：2026-09-29
 *
 * ============================================================
 * 【这个文件解决的问题】
 * ============================================================
 *   退费、休学、退学三件事都要走审批。
 *   如果每个业务各写一套"提交/同意/驳回/撤回"，就是三份几乎一样的代码 ——
 *   以后改规则要改三处，必然漏一处。
 *
 *   所以抽到这里：**业务模块只管自己的业务字段，审批逻辑全部调这里**。
 *
 * ============================================================
 * 【怎么用（业务模块视角）】
 * ============================================================
 *   1. 建单时：调 createApproval() 建一张审批单，拿到 approvalId
 *   2. 提交时：调 submitApproval()  —— 流程 start
 *   3. 审批时：调 doApprove() / doReject()
 *   4. 撤回时：调 doCancel()
 *   5. 查详情：调 getApprovalLogs() / buildChainNodes()
 *
 * ============================================================
 * 【⚠️ 校验都在这里，业务模块不用重复写】
 * ============================================================
 *   - 状态对不对（已通过的不能再批）
 *   - 角色对不对（班主任不能审批）
 *   - 驳回有没有填原因
 *
 * ⚠️ 铁律：逻辑删除，禁物理删除。
 */

import { randomUUID } from 'crypto';
import {
  BizCode,
  ApprovalStatus,
  ApprovalAction,
  APPROVAL_ACTION_NAME,
  APPROVAL_STATUS_NAME,
  getApprovalChain,
  getApprovalNode,
  getApprovalStepCount,
  canApprove,
  isFinished,
  isMyApproval,
} from 'shared-types';
import { db } from './db';
import { BizError } from '../middleware/errorHandler';
import { sendNotice, NOTICE_TYPE } from './notice';
// ★ 切读层：审批单主表 t_job_approval + 轨迹表 t_job_approval_log 均在 sms_job
//   （学段固定 job）已归一 → 全部切读。
//   ⚠️ 轨迹表 t_job_approval_log 的映射是 P4 收尾时补进 UNI_MAP 的
//     （原「未登记 → 保持原样」的注释已作废）。
import { tbl, tblIns } from '../teaching/shared/uniTable';

const DB = 'sms_job';
const STAGE = 'job' as const;

/** 审批单主表 */
export const APPROVAL_TABLE = 't_job_approval';
/** 审批轨迹表 */
export const APPROVAL_LOG_TABLE = 't_job_approval_log';

/**
 * 操作人信息（从 req.user 提取）
 */
export interface Operator {
  userId: string;
  userName: string;
  roles: string[];
}

/**
 * 建审批单的参数
 */
export interface CreateApprovalParams {
  bizType: string;
  bizId: string;
  bizNo?: string;
  applicant: Operator;
  /** 业务冗余字段（用于列表查询，避免反复连表）*/
  studentId?: string;
  studentNo?: string;
  studentName?: string;
  classId?: string;
  className?: string;
  deptCode?: number;
}

/**
 * 建一张审批单（状态 = 待提交）
 *
 * ⚠️ 业务模块建单时调它，拿到 id 存到自己的表里。
 * ⚠️ 不在这里做"提交"，提交是单独的动作（因为要先保存业务数据）。
 */
export async function createApproval(
  params: CreateApprovalParams,
  trxOpt?: any,
): Promise<string> {
  const conn = trxOpt || db;
  const id = randomUUID();
  const now = new Date();

  await tblIns(conn, DB, APPROVAL_TABLE, STAGE, {
    id,
    create_time: now,
    create_by: params.applicant.userId,
    is_deleted: false,

    biz_type: params.bizType,
    biz_id: params.bizId,
    biz_no: params.bizNo || null,

    status: ApprovalStatus.DRAFT,
    current_step: 0,

    applicant_id: params.applicant.userId,
    applicant_name: params.applicant.userName,
    applicant_role: params.applicant.roles[0] || null,

    student_id: params.studentId || null,
    student_no: params.studentNo || null,
    student_name: params.studentName || null,
    class_id: params.classId || null,
    class_name: params.className || null,
    dept_code: params.deptCode ?? null,
  });

  return id;
}

/**
 * 提交审批（从「待提交」进入第 1 步）
 *
 * 做的事：
 *   ① 校验状态必须是「待提交」
 *   ② 校验申请人有没有发起权限
 *   ③ 状态改成"待第 1 步的人审批"，算出现在轮到谁
 *   ④ 写一条轨迹
 *   ⑤ 给第 1 步的审批人发通知
 */
export async function submitApproval(
  approvalId: string,
  operator: Operator,
  trxOpt?: any,
): Promise<void> {
  const conn = trxOpt || db;

  const appr = await tbl(conn, DB, APPROVAL_TABLE, STAGE).where({ id: approvalId, is_deleted: false }).first();
  if (!appr) throw new BizError(BizCode.APPROVAL_NOT_FOUND, '审批单不存在');

  if (appr.status !== ApprovalStatus.DRAFT) {
    throw new BizError(
      BizCode.APPROVAL_ALREADY_SUBMITTED,
      `该单已提交（当前状态：${APPROVAL_STATUS_NAME[appr.status] || appr.status}），不能重复提交`,
    );
  }

  const chain = getApprovalChain(appr.biz_type);
  if (!chain) throw new BizError(BizCode.PARAM_ERROR, `未知业务类型：${appr.biz_type}`);

  // 只有申请人本人能提交
  // ⚠️ 2026-10-04 改用 isMyApproval：原来写死 `appr.applicant_id !== operator.userId`，
  //   而**系统自动生成的单子**（班级结业 → 退宿单/ 退费单）的 applicant_id
  //   记的是「业务责任人」（大学班主任），点开页面的人（项目经理）不是他
  //   → 列表里 canSubmit 就算对了、点下去也会被这道拦成 40302。
  //   现在判定与列表口径统一（都走 isMyApproval），不会再出现
  //   「按钮亮着但点不动」这种前后端不一致。
  if (!isMyApproval(appr, operator.userId, operator.roles)) {
    throw new BizError(BizCode.NO_OPERATION_PERMISSION, '只有申请人本人能提交此单');
  }

  const firstNode = getApprovalNode(appr.biz_type, 1);
  if (!firstNode) throw new BizError(BizCode.PARAM_ERROR, '审批链配置为空');

  // ⚠️「提交后进入第 1 步」的状态恒为 PENDING_MANAGER（待第 1 步审批人）。
  //
  //    注意别和 node.nextStatus 搞混 —— 两者语义不同：
  //      · 进入第 1 步时的状态  = PENDING_MANAGER（固定，"待第 1 步的人批"）
  //      · 批完第 1 步后的状态  = firstNode.nextStatus（配置驱动，见 doApprove）
  //
  //    曾经误把这里也改成 firstNode.nextStatus，结果【休学】直接炸：
  //    休学只有 1 个节点、且它的 nextStatus = APPROVED（因为"批完即通过"），
  //    于是"一提交就变成已通过"，学管再点审批就报 40011「该单已结束」。
  //    → 所以这里必须写死 PENDING_MANAGER，不能跟着 nextStatus 走。
  const nextStatus: ApprovalStatus = ApprovalStatus.PENDING_MANAGER;
  const now = new Date();

  await tbl(conn, DB, APPROVAL_TABLE, STAGE).where({ id: approvalId }).update({
    status: nextStatus,
    current_step: 1,
    current_handler_role: firstNode.roles[0] || null,
    current_handler_hint: firstNode.hint,
    submit_time: now,
    update_time: now,
    update_by: operator.userId,
  });

  await writeLog(conn, {
    approvalId,
    bizType: appr.biz_type,
    bizId: appr.biz_id,
    step: 1,
    nodeName: '提交申请',
    operator,
    action: ApprovalAction.SUBMIT,
    comment: '提交申请',
  });

  // 通知第一步的审批人（通知失败不影响主流程）
  await notifyApprovers(conn, appr, firstNode.name, firstNode.roles[0]);
}

/**
 * 同意（当前环节通过）
 *
 * 做的事：
 *   ① 校验状态是"审批中"
 *   ② 校验当前人有权限批这一环节（★ 后端拦截的关键）
 *   ③ 写轨迹
 *   ④ 判断是不是最后一步：
 *        是 → 状态 = 已通过（业务模块自己再去做"通过后的事"）
 *        否 → 状态 = 下一步的待审状态，算出新的处理人
 *   ⑤ 通知下一步的人（或通知申请人"已通过"）
 *
 * @returns 是否全部通过（true = 流程走完，业务模块该执行"通过后的动作"了）
 */
export async function doApprove(
  approvalId: string,
  operator: Operator,
  comment?: string,
  trxOpt?: any,
): Promise<{ finished: boolean; status: ApprovalStatus }> {
  const conn = trxOpt || db;

  const appr = await tbl(conn, DB, APPROVAL_TABLE, STAGE).where({ id: approvalId, is_deleted: false }).first();
  if (!appr) throw new BizError(BizCode.APPROVAL_NOT_FOUND, '审批单不存在');

  if (isFinished(appr.status)) {
    throw new BizError(
      BizCode.APPROVAL_STATUS_NOT_ALLOW,
      `该单已结束（${APPROVAL_STATUS_NAME[appr.status]}），不能再审批`,
    );
  }
  if (appr.status === ApprovalStatus.DRAFT) {
    throw new BizError(BizCode.APPROVAL_STATUS_NOT_ALLOW, '该单还没提交，不能审批');
  }

  const step = appr.current_step;
  const node = getApprovalNode(appr.biz_type, step);
  if (!node) throw new BizError(BizCode.PARAM_ERROR, `找不到第 ${step} 步的审批配置`);

  // ★ 核心拦截：角色不对直接 403
  if (!canApprove(appr.biz_type, step, operator.roles)) {
    throw new BizError(
      BizCode.NO_OPERATION_PERMISSION,
      `您没有「${node.name}」的审批权限`,
    );
  }

  const now = new Date();
  const totalSteps = getApprovalStepCount(appr.biz_type);
  const isLast = step >= totalSteps;

  // ⚠️ 下一步状态【不能写死】——
  //    不能"非最后一步就一律 PENDING_MANAGER"。
  //    例：退学第 1 步（学管）批完应进「待校长审批」(PENDING_PRINCIPAL)，
  //        如果写死 PENDING_MANAGER，状态就会一直卡在"待学管审批"，校长永远等不到。
  //    所以：用【当前节点配置的 nextStatus】。最后一步一律 APPROVED。
  const nextStatus: ApprovalStatus = isLast
    ? ApprovalStatus.APPROVED
    : (node.nextStatus ?? ApprovalStatus.PENDING_MANAGER);
  const nextStep = isLast ? step : step + 1;
  const nextNode = isLast ? null : getApprovalNode(appr.biz_type, nextStep);

  await tbl(conn, DB, APPROVAL_TABLE, STAGE).where({ id: approvalId }).update({
    status: nextStatus,
    current_step: nextStep,
    current_handler_role: nextNode ? nextNode.roles[0] || null : null,
    current_handler_hint: nextNode ? nextNode.hint : '已通过',
    finish_time: isLast ? now : null,
    update_time: now,
    update_by: operator.userId,
  });

  await writeLog(conn, {
    approvalId,
    bizType: appr.biz_type,
    bizId: appr.biz_id,
    step,
    nodeName: node.name,
    operator,
    action: ApprovalAction.APPROVE,
    comment: comment || '同意',
  });

  // 通知：下一步的人 or 申请人
  if (nextNode) {
    await notifyApprovers(conn, appr, nextNode.name, nextNode.roles[0]);
  } else {
    await notifyApplicant(conn, appr, `您的${chainName(appr.biz_type)}申请已通过`);
  }

  return { finished: isLast, status: nextStatus };
}

/**
 * 驳回（当前环节打回）
 *
 * ⚠️ 驳回必须填原因（斌哥要求：驳回原因发到班主任）
 * ⚠️ 驳回后状态 = 已驳回，流程终止（不做"打回到某一步重走"）
 */
export async function doReject(
  approvalId: string,
  operator: Operator,
  reason: string,
  trxOpt?: any,
): Promise<void> {
  const conn = trxOpt || db;

  if (!reason || !reason.trim()) {
    throw new BizError(BizCode.APPROVAL_REJECT_NEED_REASON, '驳回时必须填写驳回原因');
  }

  const appr = await tbl(conn, DB, APPROVAL_TABLE, STAGE).where({ id: approvalId, is_deleted: false }).first();
  if (!appr) throw new BizError(BizCode.APPROVAL_NOT_FOUND, '审批单不存在');

  if (isFinished(appr.status)) {
    throw new BizError(
      BizCode.APPROVAL_STATUS_NOT_ALLOW,
      `该单已结束（${APPROVAL_STATUS_NAME[appr.status]}），不能再驳回`,
    );
  }
  if (appr.status === ApprovalStatus.DRAFT) {
    throw new BizError(BizCode.APPROVAL_STATUS_NOT_ALLOW, '该单还没提交，不能驳回');
  }

  const step = appr.current_step;
  const node = getApprovalNode(appr.biz_type, step);
  if (!node) throw new BizError(BizCode.PARAM_ERROR, `找不到第 ${step} 步的审批配置`);

  // ★ 核心拦截
  if (!canApprove(appr.biz_type, step, operator.roles)) {
    throw new BizError(
      BizCode.NO_OPERATION_PERMISSION,
      `您没有「${node.name}」的审批权限`,
    );
  }

  const now = new Date();

  await tbl(conn, DB, APPROVAL_TABLE, STAGE).where({ id: approvalId }).update({
    status: ApprovalStatus.REJECTED,
    current_handler_role: null,
    current_handler_hint: '已驳回',
    reject_reason: reason.trim(),
    finish_time: now,
    update_time: now,
    update_by: operator.userId,
  });

  await writeLog(conn, {
    approvalId,
    bizType: appr.biz_type,
    bizId: appr.biz_id,
    step,
    nodeName: node.name,
    operator,
    action: ApprovalAction.REJECT,
    comment: reason.trim(),
  });

  // ★ 斌哥要求：驳回原因要发到班主任（申请人）
  await notifyApplicant(
    conn,
    appr,
    `您的${chainName(appr.biz_type)}申请被驳回`,
    `驳回原因：${reason.trim()}`,
  );
}

/**
 * 撤回（申请人自己收回）
 *
 * ⚠️ 只有申请人本人能撤回
 * ⚠️ 已经审批结束的不能撤
 */
export async function doCancel(
  approvalId: string,
  operator: Operator,
  reason?: string,
  trxOpt?: any,
): Promise<void> {
  const conn = trxOpt || db;

  const appr = await tbl(conn, DB, APPROVAL_TABLE, STAGE).where({ id: approvalId, is_deleted: false }).first();
  if (!appr) throw new BizError(BizCode.APPROVAL_NOT_FOUND, '审批单不存在');

  // ★ 与 submitApproval 同口径：撤回也走 isMyApproval（万能测试号放行）
  if (!isMyApproval(appr, operator.userId, operator.roles)) {
    throw new BizError(BizCode.NO_OPERATION_PERMISSION, '只有申请人本人能撤回此单');
  }

  if (isFinished(appr.status)) {
    throw new BizError(
      BizCode.APPROVAL_STATUS_NOT_ALLOW,
      `该单已结束（${APPROVAL_STATUS_NAME[appr.status]}），不能撤回`,
    );
  }

  const now = new Date();

  await tbl(conn, DB, APPROVAL_TABLE, STAGE).where({ id: approvalId }).update({
    status: ApprovalStatus.CANCELED,
    current_handler_role: null,
    current_handler_hint: '已撤销',
    finish_time: now,
    update_time: now,
    update_by: operator.userId,
  });

  await writeLog(conn, {
    approvalId,
    bizType: appr.biz_type,
    bizId: appr.biz_id,
    step: appr.current_step || 0,
    nodeName: '撤回申请',
    operator,
    action: ApprovalAction.CANCEL,
    comment: reason || '申请人撤回',
  });
}

/**
 * 查审批轨迹
 */
export async function getApprovalLogs(approvalId: string): Promise<any[]> {
  return tbl(db, DB, APPROVAL_LOG_TABLE, STAGE)
    .where({ approval_id: approvalId, is_deleted: false })
    .orderBy('create_time', 'asc');
}

/**
 * 拼"流程条"数据（前端画步骤条用）
 *
 * 返回：[{ step, name, done, current }]
 */
export async function buildChainNodes(
  bizType: string,
  approval: any,
): Promise<{ step: number; name: string; done: boolean; current: boolean }[]> {
  const chain = getApprovalChain(bizType);
  if (!chain) return [];

  const currentStep = approval?.current_step || 0;
  const status = approval?.status || 0;

  return chain.nodes.map((n) => {
    const done = status === ApprovalStatus.APPROVED ? true : n.step < currentStep;
    const current = !isFinished(status) && n.step === currentStep && status !== ApprovalStatus.DRAFT;
    return { step: n.step, name: n.name, done, current };
  });
}

/**
 * 取审批单（业务模块查状态用）
 */
export async function getApproval(approvalId: string): Promise<any> {
  return tbl(db, DB, APPROVAL_TABLE, STAGE).where({ id: approvalId, is_deleted: false }).first();
}

/* ============================================================
 * 内部辅助
 * ============================================================ */

function chainName(bizType: string): string {
  return getApprovalChain(bizType)?.bizName || '申请';
}

/** 写一条轨迹 */
async function writeLog(
  conn: any,
  p: {
    approvalId: string;
    bizType: string;
    bizId: string;
    step: number;
    nodeName: string;
    operator: Operator;
    action: ApprovalAction;
    comment?: string;
  },
): Promise<void> {
  await tblIns(conn, DB, APPROVAL_LOG_TABLE, STAGE, {
    id: randomUUID(),
    create_time: new Date(),
    is_deleted: false,
    approval_id: p.approvalId,
    biz_type: p.bizType,
    biz_id: p.bizId,
    step: p.step,
    node_name: p.nodeName,
    operator_id: p.operator.userId,
    operator_name: p.operator.userName,
    operator_role: p.operator.roles[0] || null,
    action: p.action,
    action_name: APPROVAL_ACTION_NAME[p.action] || '',
    comment: p.comment || null,
  });
}

/**
 * 通知审批人
 *
 * ⚠️ 现在是"按角色发一条通知"。真实场景要知道"这个角色的具体是谁"，
 *    那要等 8006 权限模块（人员数据）。
 *    现在先发给角色，里面写清楚"待谁审批"。
 */
async function notifyApprovers(
  conn: any,
  appr: any,
  nodeName: string,
  roleCode?: string | null,
): Promise<void> {
  if (!roleCode) return;
  try {
    await sendNotice(
      {
        noticeType: NOTICE_TYPE.APPROVAL,
        title: `【待审批】${chainName(appr.biz_type)}申请`,
        content:
          `${appr.applicant_name || '申请人'} 提交了 ${appr.student_name || ''} 的` +
          `${chainName(appr.biz_type)}申请${appr.biz_no ? `（${appr.biz_no}）` : ''}，` +
          `请您审批。`,
        receiverId: roleCode,
        receiverName: nodeName,
        receiverRole: roleCode,
        bizType: appr.biz_type,
        bizId: appr.biz_id,
        classId: appr.class_id,
        className: appr.class_name,
        studentId: appr.student_id,
        studentName: appr.student_name,
      },
      conn,
    );
  } catch {
    // 通知失败不阻断主流程
  }
}

/** 通知申请人（驳回/通过时）*/
async function notifyApplicant(
  conn: any,
  appr: any,
  title: string,
  content?: string,
): Promise<void> {
  if (!appr.applicant_id) return;
  try {
    await sendNotice(
      {
        noticeType: NOTICE_TYPE.APPROVAL,
        title,
        content:
          content ||
          `${appr.student_name || ''} 的${chainName(appr.biz_type)}申请已处理` +
            `${appr.biz_no ? `（${appr.biz_no}）` : ''}。`,
        receiverId: appr.applicant_id,
        receiverName: appr.applicant_name,
        receiverRole: appr.applicant_role,
        bizType: appr.biz_type,
        bizId: appr.biz_id,
        classId: appr.class_id,
        className: appr.class_name,
        studentId: appr.student_id,
        studentName: appr.student_name,
      },
      conn,
    );
  } catch {
    // 通知失败不阻断主流程
  }
}
