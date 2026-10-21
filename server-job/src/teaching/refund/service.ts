/**
 * 退费适配器 · 把三套退费统一到「实训那一套审批链」
 * ============================================================
 *
 * ★★ 本域的核心决策（斌哥 2026-10-09 拍板）：
 *    **审批链统一采用实训那一套** ——
 *      班主任 / 项目经理发起 → 学管审批 → 校长审批 → 通过后通知财务出款。
 *
 *    实现上「三件套全部复用实训的」：
 *      ① 状态码 = `ApprovalStatus`（1 待提交 / 2 待学管 / 3 待校长 / 4 已通过 / 5 已驳回 / 6 已撤销）
 *      ② 审批单 = **同一张表** `sms_job.t_job_approval`（跨库写入）
 *      ③ 审批引擎 = **同一套代码** `utils/approval.ts`
 *         （submitApproval / doApprove / doReject / doCancel，一行业务逻辑都不重写）
 *
 *    → 好处：审批中心、审批日志、通知、角色判定**天然统一**；
 *      初高 / 大学原来那套自建状态机被**整体替换**，不是"照着抄一遍"。
 *
 * 【跨库怎么做到】
 *   三个库（sms_job / sms_class / sms_class_jh）在**同一个 MySQL 实例**上，
 *   所以用 job 的连接开一个事务，事务里用**全限定表名**写另外两个库的表 ——
 *   这就是「业务单 + 审批单」强一致的做法（同事务，要么都成要么都回滚）。
 *   项目里已有跨库先例：`services/dorm-sync.service.ts` 用 `sms_edu.t_xxx`。
 *
 * 【老单怎么办】
 *   合并上线前创建的单子**没有审批单**。写操作前会做**惰性补建**
 *   （`ensureApproval`）：按当前统一状态推算该停在第几步，补一条审批单，
 *   申请人取业务单上记录的原发起人。补建后老单即可在新界面继续走完流程。
 */

import {
  ApprovalBizType,
  ApprovalStatus,
  BizCode,
  canApprove,
  canInitiate,
  hasRole,
  isFinished,
  isMyApproval,
  RoleCode,
} from 'shared-types';
import { db } from '../../utils/db';
import { BizError } from '../../middleware/errorHandler';
import {
  APPROVAL_TABLE,
  createApproval,
  doApprove,
  doCancel,
  doReject,
  getApprovalLogs,
  submitApproval,
  type Operator,
} from '../../utils/approval';
import { applyRefundToFinance } from '../../utils/financeClient';
// ★ 第 11 批：实训侧退费业务表切读（`t_job_refund` → `t_uni_refund`）
import { tbl, uniUpdCols } from '../shared/uniTable';
import type {
  RefundDetail,
  RefundListQuery,
  RefundRow,
  RefundSaveBody,
  RefundSummary,
  TeachingStage,
} from '../shared/dto';
import {
  REFUND_ACTIVE_STATUSES,
  REFUND_ITEM_MAX_AMOUNT,
  REFUND_STATUS,
  REFUND_STATUS_NAME,
  TEACHING_STAGE_NAME,
  TEACHING_STAGES,
} from '../shared/dto';
import { assertStageCode, visibleStagesBy } from '../shared/stageAccess';
import { listClassesOfStages } from '../shared/classOptions';
import { amountText } from '../shared/format';
import type { RefundAggregate, RefundWriteInput, StudentOption } from './types';
import * as repoJh from './repo.classJh';
import * as repoClass from './repo.class';
import * as repoJob from './repo.job';

const BIZ = ApprovalBizType.REFUND;

/** 各学段退费页的权限码（= 合并前各学段退费页的权限码，一个都没改） */
const STAGE_VIEW_CODE = {
  jh: 'classjh:refund:view',
  class: 'class:refund:view',
  job: 'job:refund:view',
};

const LABEL = '退费';

/** 学段访问校验（统一走共享模块，口径与其它域一致） */
async function assertStageView(user: any, stage: TeachingStage): Promise<void> {
  return assertStageCode(user, stage, STAGE_VIEW_CODE, LABEL);
}

/** 当前账号可见的学段 */
async function visibleStages(user: any): Promise<TeachingStage[]> {
  return visibleStagesBy(user, STAGE_VIEW_CODE, LABEL);
}

/* ============================================================
 * 仓储统一接口（三个仓储导出同名同签名函数，按 stage 分派）
 * ============================================================ */

type Repo = {
  list: (q: RefundListQuery) => Promise<{ rows: RefundRow[]; total: number }>;
  detail: (id: string) => Promise<RefundRow | null>;
  studentOptions: (keyword: string, limit: number) => Promise<StudentOption[]>;
  aggregate: () => Promise<RefundAggregate>;
  insert: (
    conn: any,
    input: RefundWriteInput,
    items?: Array<{ feeType: number; amount: number }>,
  ) => Promise<string>;
  setStatus: (
    conn: any,
    id: string,
    unifiedStatus: number,
    patch?: Record<string, any>,
  ) => Promise<void>;
  setFinance: (conn: any, id: string, remark: string | null, time: string | null) => Promise<void>;
  /** 该学生是否有进行中的退费单（防重复提交） */
  hasPending: (studentId: string) => Promise<boolean>;
  /** 按 id 取学生（建单时做快照） */
  findStudent: (id: string) => Promise<{
    no: string;
    name: string;
    classId: string | null;
    className: string | null;
    deptCode: number | null;
  } | null>;
};

const REPOS: Record<TeachingStage, Repo> = {
  jh: repoJh as unknown as Repo,
  class: repoClass as unknown as Repo,
  job: repoJob as unknown as Repo,
};

/** 从 req.user 取操作人 */
export function toOperator(user: any): Operator {
  if (!user) throw new BizError(BizCode.UNAUTHORIZED, '请先登录', 401);
  return { userId: user.userId, userName: user.userName, roles: user.roles || [] };
}

/* ============================================================
 * 审批单装载（三学段统一从 t_job_approval 取）
 * ============================================================ */

/**
 * 批量取审批单：按 `biz_type=REFUND + biz_id IN (ids)`
 *
 * ⚠️ 业务单 id 是 UUID（全局唯一），所以三学段的单混在同一个 biz_type 下不会撞。
 *    这也是**不需要给初高/大学表加 `approval_id` 列**的原因 —— 少一次表结构变更。
 */
async function loadApprovals(ids: string[]): Promise<Record<string, Record<string, any>>> {
  if (!ids.length) return {};
  const rows = (await db(APPROVAL_TABLE)
    .where({ biz_type: BIZ, is_deleted: false })
    .whereIn('biz_id', ids)
    .orderBy('create_time', 'asc')) as Array<Record<string, any>>;
  const map: Record<string, Record<string, any>> = {};
  for (const r of rows) map[String(r.biz_id)] = r; // 后写的覆盖 → 取最新
  return map;
}

/* ============================================================
 * 按钮显隐（与后端写操作同一口径）
 * ============================================================ */

function withActions(row: RefundRow, approval: Record<string, any> | undefined, op: Operator): RefundRow {
  const roles = op.roles || [];

  // ★ 老单没有审批单时，仍按「统一状态 + 角色」给出审批按钮 ——
  //   否则合并上线后，进行中的老单在页面上变成"谁都点不了"，直接卡死。
  let canApproveIt = false;
  if (row.approvalStatus === REFUND_STATUS.PENDING_MANAGER) {
    canApproveIt = canApprove(BIZ, 1, roles);
  } else if (row.approvalStatus === REFUND_STATUS.PENDING_PRINCIPAL) {
    canApproveIt = canApprove(BIZ, 2, roles);
  } else {
    canApproveIt = false;
  }

  let canCancelIt = false;
  let canSubmitIt = false;
  if (approval) {
    const isMine = isMyApproval(approval, op.userId, roles);
    if (REFUND_ACTIVE_STATUSES.includes(row.approvalStatus) && isMine) canCancelIt = true;
    if (approval.status === ApprovalStatus.DRAFT && isMine) canSubmitIt = true;
  } else if (row.approvalStatus === REFUND_STATUS.DRAFT) {
    // 老单（无审批单）的草稿态：允许提交，落库时惰性补建审批单
    canSubmitIt = true;
  }

  return {
    ...row,
    currentHandlerHint:
      approval?.current_handler_hint ||
      (row.approvalStatus === REFUND_STATUS.PENDING_MANAGER
        ? '待学管审批'
        : row.approvalStatus === REFUND_STATUS.PENDING_PRINCIPAL
          ? '待校长审批'
          : null),
    canApprove: canApproveIt,
    canCancel: canCancelIt,
    canSubmit: canSubmitIt,
  };
}

/* ============================================================
 * 列表
 * ============================================================ */

export async function list(
  q: RefundListQuery,
  user: any,
): Promise<{ rows: RefundRow[]; total: number }> {
  const op = toOperator(user);
  const stages: TeachingStage[] = q.stage ? [q.stage] : await visibleStages(user);
  if (!stages.length) return { rows: [], total: 0 };

  // 单学段：直接分页
  if (stages.length === 1) {
    const stage = stages[0];
    await assertStageView(user, stage);
    const { rows, total } = await REPOS[stage].list(q);
    const ap = await loadApprovals(rows.map((r) => r.id));
    let out = rows.map((r) => withActions(r, ap[r.id], op));
    // ★「只看待我审批」：审批人由**审批单 + 角色**决定（审批单在另一个库），
    //    SQL 里没法过滤 → 在内存里筛。代价：total 只对"本页"准确（已足够用）。
    if (q.onlyMine) out = out.filter((r) => r.canApprove);
    return { rows: out, total: q.onlyMine ? out.length : total };
  }

  // 多学段（"全学段"视图）：各取前 N 条合并展示，避免一次拉全量
  const per = Math.max(q.size, 20);
  const all: RefundRow[] = [];
  let total = 0;
  for (const stage of stages) {
    try {
      await assertStageView(user, stage);
      const { rows, total: t } = await REPOS[stage].list({ ...q, page: 1, size: per });
      total += t;
      all.push(...rows);
    } catch {
      /* 没权限的学段跳过 */
    }
  }
  all.sort((a, b) => String(b.createTime || '').localeCompare(String(a.createTime || '')));
  const start = (q.page - 1) * q.size;
  const slice = all.slice(start, start + q.size);
  const ap = await loadApprovals(slice.map((r) => r.id));
  let out = slice.map((r) => withActions(r, ap[r.id], op));
  if (q.onlyMine) out = out.filter((r) => r.canApprove);
  return { rows: out, total };
}

/* ============================================================
 * 详情（含审批轨迹）
 * ============================================================ */

export async function detail(id: string, user: any): Promise<RefundDetail> {
  const op = toOperator(user);
  // 不知道学段 → 逐个试（最多 3 次，代价可接受）
  const stages = await visibleStages(user);
  let row: RefundRow | null = null;
  for (const s of stages) {
    row = await REPOS[s].detail(id);
    if (row) break;
  }
  if (!row) throw new BizError(BizCode.REFUND_NOT_FOUND, '退费单不存在');
  await assertStageView(user, row.stage);

  const ap = await loadApprovals([id]);
  const approval = ap[id];

  let logs: RefundDetail['logs'] = [];
  if (approval) {
    const raw = await getApprovalLogs(String(approval.id));
    logs = raw.map((l: Record<string, any>) => ({
      step: Number(l.step || 0),
      nodeName: String(l.node_name || ''),
      operatorName: String(l.operator_name || ''),
      actionName: ACTION_NAME[Number(l.action)] || '',
      comment: l.comment || null,
      time: l.create_time ? String(l.create_time).replace('T', ' ').slice(0, 19) : null,
    }));
  }

  return { record: withActions(row, approval, op), logs };
}

const ACTION_NAME: Record<number, string> = {
  1: '提交',
  2: '同意',
  3: '驳回',
  4: '撤回',
};

/* ============================================================
 * 学生下拉 / 班级下拉
 * ============================================================ */

export async function studentOptions(
  stage: TeachingStage,
  keyword: string,
  limit: number,
  user: any,
): Promise<StudentOption[]> {
  await assertStageView(user, stage);
  return REPOS[stage].studentOptions(keyword, limit);
}

export async function classOptions(user: any) {
  const stages = await visibleStages(user);
  return listClassesOfStages(stages);
}

/* ============================================================
 * 新建
 * ============================================================ */

export async function create(body: RefundSaveBody, user: any): Promise<{ id: string }> {
  const stage = body.stage;
  if (!TEACHING_STAGES.includes(stage)) {
    throw new BizError(BizCode.PARAM_ERROR, '学段参数非法（应为 jh / class / job）');
  }
  await assertStageView(user, stage);
  const op = toOperator(user);

  // ★ 与实训口径一致：只有「班主任 / 项目经理」能发起（校长/管理员走全权角色口子）
  if (!canInitiate(BIZ, op.roles)) {
    throw new BizError(BizCode.NO_OPERATION_PERMISSION, '只有班主任 / 项目经理能发起退费申请');
  }

  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) throw new BizError(BizCode.PARAM_ERROR, '请至少填一项退费费用');
  const sum = items.reduce((a, x) => a + Number(x.amount || 0), 0);
  if (sum <= 0) throw new BizError(BizCode.REFUND_AMOUNT_INVALID, '退费金额必须大于 0');
  if (sum !== Number(body.refundAmount)) {
    throw new BizError(
      BizCode.PARAM_ERROR,
      `退费总额（${amountText(body.refundAmount)} 元）与各项目之和（${amountText(sum)} 元）不一致，请核对`,
    );
  }

  // ★ 单项费用上限 10 万元（分）：前端费用项输入框已限 max，这里兜底（接口可被绕过）
  for (const it of items) {
    if (Number(it.amount) > REFUND_ITEM_MAX_AMOUNT) {
      throw new BizError(
        BizCode.PARAM_ERROR,
        `单项费用最高 10 万元（当前 ${amountText(Number(it.amount))} 元），请拆分为多项或核对金额`,
      );
    }
  }

  const repo = REPOS[stage];
  // 防重复：同一学生不允许有两条进行中的退费单（大学原有规则，统一到三学段）
  if (await repo.hasPending(body.studentId)) {
    throw new BizError(BizCode.REFUND_DUPLICATE, '该学生已有一条进行中的退费申请，请勿重复提交');
  }

  // 学生 / 班级快照
  const stu = await findStudent(stage, body.studentId);
  if (!stu) throw new BizError(BizCode.STUDENT_NOT_FOUND, '学生不存在');

  const input: RefundWriteInput = {
    studentId: body.studentId,
    studentNo: stu.no,
    studentName: stu.name,
    classId: stu.classId,
    className: stu.className,
    deptName: null,
    deptCode: stu.deptCode,
    headTeacherId: hasRole(op.roles, RoleCode.PROJECT_MANAGER) ? op.userId : null,
    headTeacherName: hasRole(op.roles, RoleCode.PROJECT_MANAGER) ? op.userName : null,
    feeType: items[0].feeType,
    refundAmount: body.refundAmount,
    applyDate: body.applyDate || '',
    refundReason: body.refundReason,
    remark: body.remark ?? null,
    initiatorId: op.userId,
    initiatorName: op.userName,
  };

  let newId = '';
  await db.transaction(async (trx) => {
    // ① 业务单（写各自库，全限定名）
    newId = await repo.insert(trx, input, items);
    // ② 审批单（统一落 sms_job.t_job_approval）
    const approvalId = await createApproval(
      {
        bizType: BIZ,
        bizId: newId,
        applicant: op,
        studentId: input.studentId,
        studentNo: input.studentNo,
        studentName: input.studentName,
        classId: input.classId || undefined,
        className: input.className || undefined,
        deptCode: input.deptCode ?? undefined,
      },
      trx,
    );
    // ③ 直接提交（可选）
    if (body.submit) {
      await submitApproval(approvalId, op, trx);
      await repo.setStatus(trx, newId, REFUND_STATUS.PENDING_MANAGER);
    }
  });

  return { id: newId };
}

/* ============================================================
 * 惰性补建审批单（给"合并前创建的老单"用）
 * ============================================================ */

async function ensureApproval(
  trx: any,
  bizId: string,
  row: RefundRow,
  op: Operator,
): Promise<string> {
  const existed = (await trx(APPROVAL_TABLE)
    .where({ biz_type: BIZ, biz_id: bizId, is_deleted: false })
    .first()) as Record<string, any> | undefined;
  if (existed) return String(existed.id);

  const id = await createApproval(
    {
      bizType: BIZ,
      bizId,
      applicant: op,
      studentId: row.studentId,
      studentNo: row.studentNo,
      studentName: row.studentName,
      classId: row.classId || undefined,
      className: row.className || undefined,
    },
    trx,
  );

  // 按当前统一状态推算「应该停在第几步」
  const step =
    row.approvalStatus === REFUND_STATUS.PENDING_PRINCIPAL
      ? 2
      : row.approvalStatus === REFUND_STATUS.PENDING_MANAGER
        ? 1
        : 0;
  await trx(APPROVAL_TABLE).where({ id }).update({
    status: row.approvalStatus,
    current_step: step,
    current_handler_hint:
      row.approvalStatus === REFUND_STATUS.PENDING_MANAGER
        ? '待学管审批'
        : row.approvalStatus === REFUND_STATUS.PENDING_PRINCIPAL
          ? '待校长审批'
          : null,
  });
  return id;
}

/** 取一条业务单（写操作共用），带"不存在"报错 */
async function mustGet(stage: TeachingStage, id: string): Promise<RefundRow> {
  const row = await REPOS[stage].detail(id);
  if (!row) throw new BizError(BizCode.REFUND_NOT_FOUND, '退费单不存在');
  return row;
}

/* ============================================================
 * 提交 / 审批 / 驳回 / 撤回
 * ============================================================ */

export async function submit(
  stage: TeachingStage,
  id: string,
  user: any,
): Promise<{ approvalStatus: number; approvalStatusName: string }> {
  await assertStageView(user, stage);
  const op = toOperator(user);
  const row = await mustGet(stage, id);
  if (row.approvalStatus !== REFUND_STATUS.DRAFT) {
    throw new BizError(BizCode.APPROVAL_ALREADY_SUBMITTED, '该单已提交，不能重复提交');
  }

  await db.transaction(async (trx) => {
    const approvalId = await ensureApproval(trx, id, row, op);
    await submitApproval(approvalId, op, trx);
    await REPOS[stage].setStatus(trx, id, REFUND_STATUS.PENDING_MANAGER);
  });

  return {
    approvalStatus: REFUND_STATUS.PENDING_MANAGER,
    approvalStatusName: REFUND_STATUS_NAME[REFUND_STATUS.PENDING_MANAGER],
  };
}

export async function approve(
  stage: TeachingStage,
  id: string,
  comment: string | undefined,
  user: any,
): Promise<{ finished: boolean; approvalStatus: number; approvalStatusName: string; pushed: boolean }> {
  await assertStageView(user, stage);
  const op = toOperator(user);
  const row = await mustGet(stage, id);

  let finished = false;
  let nextStatus: number = row.approvalStatus;

  await db.transaction(async (trx) => {
    const approvalId = await ensureApproval(trx, id, row, op);
    const r = await doApprove(approvalId, op, comment, trx);
    finished = r.finished;
    nextStatus = Number(r.status);
    await REPOS[stage].setStatus(trx, id, nextStatus);
  });

  // ★ 审批链走完 → 通知财务建退费单（**事务外**：财务是外部模块，
  //   超时会把本地审批一起回滚，得不偿失；失败不回滚，人工补录）
  let pushed = false;
  if (finished) {
    pushed = await pushRefundToFinance(stage, row, op);
  }

  return {
    finished,
    approvalStatus: nextStatus,
    approvalStatusName: REFUND_STATUS_NAME[nextStatus] || '',
    pushed,
  };
}

export async function reject(
  stage: TeachingStage,
  id: string,
  reason: string,
  user: any,
): Promise<{ approvalStatus: number; approvalStatusName: string }> {
  await assertStageView(user, stage);
  const op = toOperator(user);
  const row = await mustGet(stage, id);

  await db.transaction(async (trx) => {
    const approvalId = await ensureApproval(trx, id, row, op);
    await doReject(approvalId, op, reason, trx);
    await REPOS[stage].setStatus(trx, id, REFUND_STATUS.REJECTED, { reject_reason: reason });
  });

  return {
    approvalStatus: REFUND_STATUS.REJECTED,
    approvalStatusName: REFUND_STATUS_NAME[REFUND_STATUS.REJECTED],
  };
}

export async function cancel(
  stage: TeachingStage,
  id: string,
  reason: string | undefined,
  user: any,
): Promise<{ approvalStatus: number; approvalStatusName: string }> {
  await assertStageView(user, stage);
  const op = toOperator(user);
  const row = await mustGet(stage, id);

  await db.transaction(async (trx) => {
    const approvalId = await ensureApproval(trx, id, row, op);
    await doCancel(approvalId, op, reason, trx);
    await REPOS[stage].setStatus(trx, id, REFUND_STATUS.CANCELED);
  });

  return {
    approvalStatus: REFUND_STATUS.CANCELED,
    approvalStatusName: REFUND_STATUS_NAME[REFUND_STATUS.CANCELED],
  };
}

/* ============================================================
 * 财务确认出款
 * ============================================================ */

export async function financeConfirm(
  stage: TeachingStage,
  id: string,
  body: { financeRemark?: string; refundTime?: string },
  user: any,
): Promise<null> {
  await assertStageView(user, stage);
  const row = await mustGet(stage, id);
  if (row.approvalStatus !== REFUND_STATUS.APPROVED) {
    throw new BizError(
      BizCode.APPROVAL_STATUS_NOT_ALLOW,
      `该单还没审批通过（当前：${row.approvalStatusName}），不能确认出款`,
    );
  }
  await REPOS[stage].setFinance(db, id, body.financeRemark ?? null, body.refundTime ?? null);
  return null;
}

/* ============================================================
 * 推送财务（统一实现；实训原逻辑搬过来，三学段共用）
 * ============================================================ */

async function pushRefundToFinance(
  stage: TeachingStage,
  row: RefundRow,
  op: Operator,
): Promise<boolean> {
  // 财务只认 1~5 的费用类型；「退学退费(6)」要展开成它包含的实际项
  const feeTypes = row.items
    .map((i) => i.feeType)
    .filter((t) => t >= 1 && t <= 5);
  const refundItems = feeTypes.length ? feeTypes : [1];

  const rawReason = String(row.refundReason || '').trim();
  const refundReason = (!rawReason || /^\d+$/.test(rawReason)
    ? `${TEACHING_STAGE_NAME[stage]}${row.feeTypeName || '退费'}申请`
    : rawReason
  ).slice(0, 255);

  try {
    const res = await applyRefundToFinance({
      studentId: row.studentId,
      studentNo: row.studentNo,
      studentName: row.studentName,
      classId: row.classId || undefined,
      className: row.className || undefined,
      refundItems,
      refundAmount: row.refundAmount,
      refundReason,
      sourceType: 2, // 2 = 就业（非咨询）
      remark: `${TEACHING_STAGE_NAME[stage]}退费单 ${row.id}（${row.feeTypeName}）`,
    });
    // eslint-disable-next-line no-console
    console.log(`[退费推送财务] 成功：${stage} 单 ${row.id} → 财务单 ${res.orderNo}`);

    // 实训表有专门的溯源列；初高/大学的这两列不存在 → 跳过
    if (stage === 'job') {
      // ★ 第 11 批：改走统一表路由层。
      //   sms_job.t_job_refund（28 列）→ t_uni_refund（50 列），实测缺列 0。
      //   update 路径必须过 uniUpdCols（铁律⑨）。
      await tbl(db, 'sms_job', 't_job_refund', stage)
        .where({ id: row.id })
        .update(
          (await uniUpdCols(db, 'sms_job', 't_job_refund', {
            update_time: new Date(),
            update_by: op.userId,
          })) as never,
        )
        .catch(() => undefined);
    }
    return true;
  } catch (err: any) {
    // eslint-disable-next-line no-console
    console.error(`[退费推送财务] 失败：${stage} 单`, row.id, err?.message);
    return false;
  }
}

/* ============================================================
 * 汇总
 * ============================================================ */

export async function summary(user: any): Promise<RefundSummary[]> {
  const stages = await visibleStages(user);
  const out: RefundSummary[] = [];
  for (const s of stages) {
    const a = await REPOS[s].aggregate();
    out.push({
      stage: s,
      stageName: TEACHING_STAGE_NAME[s],
      total: a.total,
      pendingCount: a.pendingCount,
      approvedCount: a.approvedCount,
      rejectedCount: a.rejectedCount,
      approvedAmount: a.approvedAmount,
    });
  }
  return out;
}

/* ============================================================
 * 学生查询（各库不同表 → 由仓储各自实现）
 * ============================================================ */

async function findStudent(stage: TeachingStage, studentId: string) {
  return REPOS[stage].findStudent(studentId);
}
