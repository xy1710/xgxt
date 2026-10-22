/**
 * 学籍异动审批适配器 · 把三套统一到「实训那一套审批链」
 * ============================================================
 *
 * 与退费域**同源**（同一套手法、同一张审批表、同一套引擎）：
 *   ① 状态码 = `ApprovalStatus`
 *   ② 审批单 = `sms_job.t_job_approval`
 *   ③ 审批引擎 = `utils/approval.ts`（submitApproval / doApprove / doReject / doCancel）
 *
 * 【本域特有的一件事：复学班】
 *   复学**必须在终审通过那一刻确定落到哪个班**，并把这个班写进学生主档。
 *   这个班由**发起人填写**（2026-10-16 起：`create` 时 `newClassId` 必填），
 *   学管终审时仍可改；写库发生在终审通过那一刻：
 *     · 顺序上是**先 doApprove（权限校验）→ 再写复学班**，越权的人碰不到数据
 *     · 写完之后**重新读一次单**再执行副作用（否则 afterApproved 读不到复学班）
 *     · 老单（建单时没有复学班）在终审仍必须补选，两者都没有就报错、不悄悄通过
 */

import {
  ApprovalBizType,
  ApprovalStatus,
  BizCode,
  STUDENT_STATUS_NAME,
  StudentStatus,
  canApprove,
  canInitiate,
  isMyApproval,
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
import type {
  LeaveDetail,
  LeaveListQuery,
  LeaveRow,
  LeaveSaveBody,
  LeaveSummary,
  TeachingStage,
} from '../shared/dto';
import {
  LEAVE_ACTIVE_STATUSES,
  LEAVE_BIZ_TYPE,
  LEAVE_BIZ_TYPE_NAME,
  LEAVE_STAGE_BIZ,
  LEAVE_STATUS,
  LEAVE_STATUS_NAME,
  TEACHING_STAGE_NAME,
  TEACHING_STAGES,
} from '../shared/dto';
import { assertStageCode, visibleStagesBy } from '../shared/stageAccess';
import {
  LEAVE_DATE_WINDOW_DAYS,
  daysFromToday,
  isWithinLeaveDateWindow,
} from '../shared/format';
import { classNameOf, listClassesOfStages } from '../shared/classOptions';
import { tbl, tblTrx } from '../shared/uniTable';
import type { LeaveAggregate, LeaveWriteInput, StudentOption } from './types';
import * as repoJh from './repo.classJh';
import * as repoClass from './repo.class';
import * as repoJob from './repo.job';
import { assertClassInScope } from '../shared/dataScope';

/* ★ 切读层：审批单 t_job_approval 在 sms_job（学段固定 job），已归一 → 全部切读。
   ⚠️ `db(常量)`/`trx(常量)` 形态是扫描器盲区（裸扫只认字符串字面量），
      与 refund/service.ts 同批修掉（2026-10-16）。 */
const APPROVAL_DB = 'sms_job';
const APPROVAL_STAGE = 'job' as const;

/** 业务类型 → 审批业务类型（三条链，来自 shared-types 的 APPROVAL_CHAINS） */
function bizToApproval(bizType: number): string {
  if (bizType === LEAVE_BIZ_TYPE.SUSPEND) return ApprovalBizType.SUSPEND;
  if (bizType === LEAVE_BIZ_TYPE.RESUME) return ApprovalBizType.RESUME;
  return ApprovalBizType.QUIT;
}

/**
 * ★ 终态学生状态：**不再办理任何学籍异动**
 *
 * 退学 / 流失 / 已就业这三种状态一旦落到学生身上，这个人就不再是「在读学员」，
 * 后面的休学/退学/复学都不该再对他开放 —— 否则会出现「先退学、再休学」这种
 * 自相矛盾的单据，且审批通过时会把已经终结的状态又改回去（把数据改坏）。
 *
 * 【口径】`退学(7)` + `流失(11)` + `已就业(10)`（用户 2026-10-16 确认）。
 *   两个口子都要堵：① 学生下拉候选名单剔除；② `create()` 再拦一次（下拉可被绕过）。
 */
const TERMINAL_STUDENT_STATUSES: number[] = [
  StudentStatus.QUIT,
  StudentStatus.LOST,
  StudentStatus.EMPLOYED,
];

/* ============================================================
 * 仓储统一接口
 * ============================================================ */

type Repo = {
  list: (q: LeaveListQuery, user?: any) => Promise<{ rows: LeaveRow[]; total: number }>;
  detail: (id: string) => Promise<LeaveRow | null>;
  studentOptions: (
    keyword: string,
    limit: number,
    /**
     * `onlySuspended` = 只放休学中的；
     * `excludeStatuses` = 剔除这些**学生状态**的行；
     * `excludeWithPending` = 剔除**已有未办结申请**的学生（与 hasPending 同口径）
     */
    opts?: { onlySuspended?: boolean; excludeStatuses?: number[]; excludeWithPending?: boolean },
    user?: any,
  ) => Promise<StudentOption[]>;
  findStudent: (id: string) => Promise<{
    no: string;
    name: string;
    gender: string | null;
    idCard: string | null;
    phone: string | null;
    parentPhone: string | null;
    classId: string | null;
    className: string | null;
    deptCode: number | null;
    studentStatus: number | null;
  } | null>;
  aggregate: () => Promise<LeaveAggregate>;
  insert: (conn: any, input: LeaveWriteInput) => Promise<string>;
  setStatus: (
    conn: any,
    id: string,
    status: number,
    patch?: Record<string, any>,
  ) => Promise<void>;
  setResumeClass: (conn: any, id: string, classId: string, className: string) => Promise<void>;
  afterApproved: (conn: any, id: string, operatorId: string) => Promise<void>;
  hasPending: (studentId: string) => Promise<boolean>;
  /** ★ 批量取学生**当前**状态（列表的「学生现状」列用） */
  studentStatuses: (ids: string[]) => Promise<Record<string, number>>;
};

const REPOS: Record<TeachingStage, Repo> = {
  jh: repoJh as unknown as Repo,
  class: repoClass as unknown as Repo,
  job: repoJob as unknown as Repo,
};

/** 各学段审批页的权限码（= 合并前各学段审批页的权限码） */
const STAGE_VIEW_CODE = {
  jh: 'classjh:approval:view',
  class: 'class:suspend:view',
  job: 'job:suspendApproval:view',
};

const LABEL = '休学/退学审批';

async function assertStageView(user: any, stage: TeachingStage): Promise<void> {
  return assertStageCode(user, stage, STAGE_VIEW_CODE, LABEL);
}

async function visibleStages(user: any): Promise<TeachingStage[]> {
  return visibleStagesBy(user, STAGE_VIEW_CODE, LABEL);
}

export function toOperator(user: any): Operator {
  if (!user) throw new BizError(BizCode.UNAUTHORIZED, '请先登录', 401);
  return { userId: user.userId, userName: user.userName, roles: user.roles || [] };
}

/* ============================================================
 * 审批单装载
 * ============================================================ */

/** 批量取审批单（三条链 btype 不同，都要捞） */
async function loadApprovals(ids: string[]): Promise<Record<string, Record<string, any>>> {
  if (!ids.length) return {};
  const rows = (await tbl(db, APPROVAL_DB, APPROVAL_TABLE, APPROVAL_STAGE)
    .whereIn('biz_type', [
      ApprovalBizType.SUSPEND,
      ApprovalBizType.QUIT,
      ApprovalBizType.RESUME,
    ])
    .whereIn('biz_id', ids)
    .where('is_deleted', false)
    .orderBy('create_time', 'asc')) as Array<Record<string, any>>;
  const map: Record<string, Record<string, any>> = {};
  for (const r of rows) map[String(r.biz_id)] = r;
  return map;
}

/* ============================================================
 * 按钮显隐
 * ============================================================ */

function withActions(
  row: LeaveRow,
  approval: Record<string, any> | undefined,
  op: Operator,
): LeaveRow {
  const roles = op.roles || [];
  // 老单没审批单时按「统一状态 + 角色」兜底（否则合并后老单谁都点不动）
  let canApproveIt = false;
  if (row.approvalStatus === LEAVE_STATUS.PENDING_MANAGER) {
    canApproveIt = canApprove(bizToApproval(row.bizType), 1, roles);
  } else if (row.approvalStatus === LEAVE_STATUS.PENDING_PRINCIPAL) {
    canApproveIt = canApprove(bizToApproval(row.bizType), 2, roles);
  }

  let canCancelIt = false;
  let canSubmitIt = false;
  if (approval) {
    const isMine = isMyApproval(approval, op.userId, roles);
    if (LEAVE_ACTIVE_STATUSES.includes(row.approvalStatus) && isMine) canCancelIt = true;
    if (approval.status === ApprovalStatus.DRAFT && isMine) canSubmitIt = true;
  } else if (row.approvalStatus === LEAVE_STATUS.DRAFT) {
    canSubmitIt = true;
  }

  return {
    ...row,
    currentHandlerHint:
      approval?.current_handler_hint ||
      (row.approvalStatus === LEAVE_STATUS.PENDING_MANAGER
        ? '待学管审批'
        : row.approvalStatus === LEAVE_STATUS.PENDING_PRINCIPAL
          ? '待校长审批'
          : null),
    canApprove: canApproveIt,
    canCancel: canCancelIt,
    canSubmit: canSubmitIt,
  };
}

/* ============================================================
 * 列表 / 详情
 * ============================================================ */

/**
 * 列表
 *
 * 【筛选条件分两类，必须区别对待】
 *   ① **能下推到 SQL 的**：学段 / 类型 / 状态 / 关键字 / 班级 / 日期区间
 *      —— 仓储直接拼进 where，分页与 total 都是数据库算的，天然正确。
 *   ② **只能算出来的**：`onlyMine`（只看待我审批）
 *      —— 它取决于「审批单当前节点 + 当前操作人的角色」，由 withActions() 判定，
 *      SQL 里表达不了。
 *
 * 【所以有两条路径】
 *   · 快路径：单学段 + 不开 onlyMine → 直接交给仓储分页（数据库分页，快且准）
 *   · 慢路径：跨学段合并 或 开了 onlyMine → **取全量池 → 补审批单 → 算出 canApprove
 *     → 过滤 → 排序 → 最后才分页**
 *
 * ★★ 顺序绝不能反（这是本页「筛选不生效」的真正原因）
 *   旧实现是「先按页切片，再对切片做 onlyMine 过滤」，后果：
 *     · size=20 时，数据库给回 20 条，其中只有 2 条待我审批 → 页面显示 2 条；
 *       真正的第 3 条其实在后面几页里，用户翻页也看不到（因为每页都只过滤本页）
 *     · total 取的是**过滤前**的总数 → 分页器显示「共 47 条」，翻到第 3 页却是空的
 *   用户视角就是「筛选不生效 / 数据丢了」。
 */
export async function list(
  q: LeaveListQuery,
  user: any,
): Promise<{ rows: LeaveRow[]; total: number }> {
  const op = toOperator(user);
  const stages: TeachingStage[] = q.stage ? [q.stage] : await visibleStages(user);
  if (!stages.length) return { rows: [], total: 0 };

  // ★ 指定了学段：先确认有权限，再确认「该学段支持这个类型」
  //   不兼容时**明确报错**，因为旧实现会走 toRawLeaveBiz → null →
  //   `where biz_type = NULL` → 恒不成立 → 静默返回空列表（用户以为「没数据」）。
  if (q.stage) {
    await assertStageView(user, q.stage);
    if (q.bizType && !LEAVE_STAGE_BIZ[q.stage].includes(q.bizType)) {
      throw new BizError(
        BizCode.PARAM_ERROR,
        `「${TEACHING_STAGE_NAME[q.stage]}」不支持「${LEAVE_BIZ_TYPE_NAME[q.bizType] || '该类型'}」`,
      );
    }
  }

  // ---------- 快路径：单学段、且不需要按「待我审批」过滤 ----------
  if (stages.length === 1 && !q.onlyMine) {
    const { rows, total } = await REPOS[stages[0]].list(q, user);
    const ap = await loadApprovals(rows.map((r) => r.id));
    const out = rows.map((r) => withActions(r, ap[r.id], op));
    await attachStudentStatus(out);
    return { rows: out, total };
  }

  /**
   * ---------- 慢路径：取全量池后在内存里过滤 / 排序 / 分页 ----------
   *
   * ⚠️ 抓取上限 `MERGE_FETCH_LIMIT`：池子是按「单学段最多 500 条」抓的。
   *    单校规模（在办单据几十条）远够用；真到了某学段未办结单据超过 500 条，
   *    这里要改成「按审批节点把 onlyMine 下推到 SQL」——已在注释里留记号，
   *    别让这个上限悄悄变成「数据看不全」。
   */
  const MERGE_FETCH_LIMIT = 500;
  const all: LeaveRow[] = [];
  for (const stage of stages) {
    // 类型与学段不兼容的学段直接不查（如「复学」不存在于大学）
    if (q.bizType && !LEAVE_STAGE_BIZ[stage].includes(q.bizType)) continue;
    try {
      await assertStageView(user, stage);
      const { rows } = await REPOS[stage].list({ ...q, page: 1, size: MERGE_FETCH_LIMIT }, user);
      all.push(...rows);
    } catch {
      /* 没权限的学段跳过（与 summary 同口径） */
    }
  }
  all.sort((a, b) => String(b.createTime || '').localeCompare(String(a.createTime || '')));

  const ap = await loadApprovals(all.map((r) => r.id));
  let pool = all.map((r) => withActions(r, ap[r.id], op));
  if (q.onlyMine) pool = pool.filter((r) => r.canApprove);

  // ★ 过滤之后才分页，且 total 就是过滤后的池子长度 —— 分页器与内容永远自洽
  const start = (q.page - 1) * q.size;
  const page = pool.slice(start, start + q.size);
  await attachStudentStatus(page); // 只给这一页补「学生现状」，不必给整池补
  return { rows: page, total: pool.length };
}

/**
 * ★ 给列表行补上「学生**当前**状态」（实时值，不是建单快照）
 *
 * 【为什么要在分页之后、由 service 统一补】
 *   · 这是**实时**值：读学生表，和异动单上的快照字段语义不同，不该混进仓储的 decorate；
 *   · 跨学段合并时 rows 来自不同库 → 必须按 stage 分组，各自用本学段的连接查；
 *   · 按页批量 whereIn（不是每行一次），避免跨学段池子几百行时打几百次查询。
 *
 * 查不到（学生被物理删掉 / id 不匹配）时留 `null`，前端显示 '—'，不能编一个状态出来。
 */
async function attachStudentStatus(rows: LeaveRow[]): Promise<void> {
  if (!rows.length) return;
  for (const stage of [...new Set(rows.map((r) => r.stage))]) {
    const ids = rows.filter((r) => r.stage === stage).map((r) => r.studentId);
    let map: Record<string, number> = {};
    try {
      map = await REPOS[stage].studentStatuses(ids);
    } catch {
      /* 学生表查不到就留空，不影响列表本身 */
    }
    for (const r of rows) {
      if (r.stage !== stage) continue;
      const st = map[r.studentId];
      r.studentStatus = st === undefined ? null : st;
      r.studentStatusName = st === undefined ? '' : STUDENT_STATUS_NAME[st] || '';
    }
  }
}

export async function detail(id: string, user: any): Promise<LeaveDetail> {
  const op = toOperator(user);
  const stages = await visibleStages(user);
  let row: LeaveRow | null = null;
  for (const s of stages) {
    row = await REPOS[s].detail(id);
    if (row) break;
  }
  if (!row) throw new BizError(BizCode.STUDENT_LEAVE_NOT_FOUND, '申请单不存在');
  await assertStageView(user, row.stage);
  await assertClassInScope(row.stage, row.classId, user, '该班级请假单');

  const ap = await loadApprovals([id]);
  const approval = ap[id];

  let logs: LeaveDetail['logs'] = [];
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
  const record = withActions(row, approval, op);
  await attachStudentStatus([record]); // 详情也显示「学生现状」，与列表同一口径
  return { record, logs };
}

const ACTION_NAME: Record<number, string> = { 1: '提交', 2: '同意', 3: '驳回', 4: '撤回' };

/* ============================================================
 * 下拉
 * ============================================================ */

/**
 * 学生下拉
 *
 * ★ 复学（`bizType = 3`）**只能挑当前处于休学的学生**：
 *   复学 = 把休学的人接回来，若下拉里混进在读/退学的人，用户很容易选错，
 *   而错误直到审批通过（改学生状态那一刻）才暴露，已经晚了。
 *   → 在下拉这一层就把名单收窄到 `student_status = 休学(6)`。
 *
 * ★★ 终态学生（退学 7 / 流失 11 / 已就业 10）**任何类型都不出现**：
 *   退回学之后又出现在「休学/退学」的候选里，用户就能给他再开一张单，
 *   审批通过时会把已经终结的学生状态改写掉（见 TERMINAL_STUDENT_STATUSES）。
 *   → 与类型无关，一律剔除；`onlySuspended` 与它叠加（复学时两者同时成立）。
 *
 * ★★ 已有**未办结**申请的学生也不出现（2026-10-16 用户要求）：
 *   以前只有 `create()` 里的 `hasPending` 拦一道 —— 用户在下拉里照样能看到这个人，
 *   费劲选完、填完原因，提交时才被拒「请勿重复提交」，白跑一趟。
 *   现在在下拉这一层就不列。
 *   ⚠️ 这里的 `excludeWithPending` 与 `create()` 的 `hasPending` **共用仓储里的同一份
 *      「未办结状态」常量**，两处口径不可能分叉（分叉 = 下拉选得到却提交失败）。
 *
 * ⚠️ 只收窄下拉是**不够的**：下拉是可以绕过的（直接调接口）。
 *   所以 `create()` 里还有同样的校验，两处口径必须一致（同一个常量）。
 */
export async function studentOptions(
  stage: TeachingStage,
  keyword: string,
  limit: number,
  user: any,
  bizType?: number,
): Promise<StudentOption[]> {
  await assertStageView(user, stage);
  const onlySuspended = bizType === LEAVE_BIZ_TYPE.RESUME;
  return REPOS[stage].studentOptions(
    keyword,
    limit,
    {
      onlySuspended,
      excludeStatuses: TERMINAL_STUDENT_STATUSES,
      excludeWithPending: true,
    },
    user,
  );
}

export async function classOptions(user: any) {
  const stages = await visibleStages(user);
  return listClassesOfStages(stages, user);
}

/* ============================================================
 * 新建
 * ============================================================ */

export async function create(body: LeaveSaveBody, user: any): Promise<{ id: string }> {
  const stage = body.stage;
  if (!TEACHING_STAGES.includes(stage)) {
    throw new BizError(BizCode.PARAM_ERROR, '学段参数非法（应为 jh / class / job）');
  }
  await assertStageView(user, stage);
  const op = toOperator(user);

  // ★ 只有班主任 / 项目经理能发起（与实训口径一致）
  if (!canInitiate(bizToApproval(body.bizType), op.roles)) {
    throw new BizError(BizCode.NO_OPERATION_PERMISSION, '只有班主任 / 项目经理能发起');
  }

  // ★ 学段是否支持该类型（2026-10-16 起三学段均支持复学，矩阵兜底仍然保留）
  if (!LEAVE_STAGE_BIZ[stage].includes(body.bizType)) {
    throw new BizError(
      BizCode.PARAM_ERROR,
      `「${TEACHING_STAGE_NAME[stage]}」不支持「${LEAVE_BIZ_TYPE_NAME[body.bizType] || '该类型'}」`,
    );
  }

  const repo = REPOS[stage];
  const stu = await repo.findStudent(body.studentId);
  if (!stu) throw new BizError(BizCode.STUDENT_NOT_FOUND, '学生不存在');

  /**
   * ★ 终态学生（退学 7 / 流失 11 / 已就业 10）不能发起任何学籍异动
   *
   * 下拉里已经剔除了，但**下拉可以被绕过**（直接 POST /create）→ 这里必须再拦一次。
   * 不拦的后果不是「多一张单子」那么轻：审批通过时 `afterApproved` 会把
   * `student_status` 从「退学」改写成「休学」/「实训中」，把已经终结的学生
   * 又改回在册状态，出勤/统计/宿舍全线跟着错。
   */
  if (stu.studentStatus != null && TERMINAL_STUDENT_STATUSES.includes(stu.studentStatus)) {
    throw new BizError(
      BizCode.PARAM_ERROR,
      `${stu.name} 当前是「${STUDENT_STATUS_NAME[stu.studentStatus] || '未知'}」，` +
        `已不能再发起学籍异动申请（退学 / 流失 / 已就业均为终态）`,
    );
  }

  /**
   * ★ 复学：只有「当前处于休学」的学生办得通
   *
   * 下拉里已经过滤了，但**下拉可以被绕过**（直接 POST /create），
   * 所以这里必须再拦一次 —— 否则能给在读生/退学生开出复学单，
   * 审批通过时会把学生状态直接改成「实训中」，把在册学生改坏。
   */
  if (body.bizType === LEAVE_BIZ_TYPE.RESUME && stu.studentStatus !== StudentStatus.SUSPENDED) {
    const cur = stu.studentStatus ?? -1;
    throw new BizError(
      BizCode.PARAM_ERROR,
      `只有「休学」中的学生才能办复学：${stu.name} 当前是「${STUDENT_STATUS_NAME[cur] || '未知'}」`,
    );
  }

  /**
   * ★ 复学必须填写「复学班级」（2026-10-16：由「审批时选」改为「发起申请时填」）
   *
   * 复学 = 回到某个班上课，这个班本来就必须有人定；原来放在学管终审时选，
   * 结果是**发起人提交时不用想清楚、学管审批时才被迫猜**。
   * 现在改成发起申请时必填，学管审批时仍可改（见 approve()）。
   * ⚠️ 同样不能只靠前端：表单可以被绕过 → 服务端必须拦。
   */
  if (body.bizType === LEAVE_BIZ_TYPE.RESUME && !body.newClassId) {
    throw new BizError(BizCode.PARAM_ERROR, '复学必须填写复学班级');
  }

  /**
   * ★ 异动日期必须落在「今天 ± 10 天」内
   *
   * 前端 picker 已经用 disabled-date 禁掉了窗口外的日期，但**表单可以被绕过**
   * （直接 POST /create）→ 服务端必须再拦一次。
   * 这个窗口不是防坏人，是防手滑：把 2026-10-09 写成 2025-10-09 这种错，
   * 列表上完全看不出来，却会让出勤 / 按天退费 / 宿舍退宿整体错位。
   * 窗口天数与前端同源：`LEAVE_DATE_WINDOW_DAYS`（由 /meta 下发）。
   */
  if (body.leaveDate && !isWithinLeaveDateWindow(body.leaveDate)) {
    const diff = daysFromToday(body.leaveDate);
    throw new BizError(
      BizCode.PARAM_ERROR,
      `异动日期只能选今天前后 ${LEAVE_DATE_WINDOW_DAYS} 天内的日期：` +
        `填的 ${body.leaveDate} 距今天 ${diff === null ? '无法识别（需 YYYY-MM-DD）' : `${Math.abs(diff)} 天`}`,
    );
  }

  if (await repo.hasPending(body.studentId)) {
    throw new BizError(BizCode.STUDENT_LEAVE_DUPLICATE, '该学生已有进行中的申请，请勿重复提交');
  }

  const input: LeaveWriteInput = {
    studentId: body.studentId,
    studentNo: stu.no,
    studentName: stu.name,
    gender: stu.gender,
    idCard: stu.idCard,
    phone: stu.phone,
    parentPhone: stu.parentPhone,
    classId: stu.classId,
    className: stu.className,
    deptName: null,
    deptCode: stu.deptCode,
    headTeacherId: op.userId,
    headTeacherName: op.userName,
    bizType: body.bizType,
    leaveDate: body.leaveDate || '',
    expectResumeDate: body.expectResumeDate || null,
    newClassId: body.newClassId || null,
    newClassName: body.newClassId ? await classNameOf(stage, body.newClassId) : null,
    leaveReason: body.leaveReason,
    attendedHours: null,
    initiatorId: op.userId,
    initiatorName: op.userName,
  };

  let newId = '';
  await db.transaction(async (trx) => {
    newId = await repo.insert(trx, input);
    const approvalId = await createApproval(
      {
        bizType: bizToApproval(body.bizType),
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
    if (body.submit) {
      await submitApproval(approvalId, op, trx);
      await repo.setStatus(trx, newId, LEAVE_STATUS.PENDING_MANAGER);
    }
  });

  return { id: newId };
}

/* ============================================================
 * 惰性补建审批单（老单）
 * ============================================================ */

async function ensureApproval(
  trx: any,
  bizId: string,
  row: LeaveRow,
  op: Operator,
): Promise<string> {
  const existed = (await tblTrx(trx, APPROVAL_DB, APPROVAL_TABLE, APPROVAL_STAGE)
    .where({ biz_id: bizId, is_deleted: false })
    .whereIn('biz_type', [ApprovalBizType.SUSPEND, ApprovalBizType.QUIT, ApprovalBizType.RESUME])
    .first()) as Record<string, any> | undefined;
  if (existed) return String(existed.id);

  const id = await createApproval(
    {
      bizType: bizToApproval(row.bizType),
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
  const step =
    row.approvalStatus === LEAVE_STATUS.PENDING_PRINCIPAL
      ? 2
      : row.approvalStatus === LEAVE_STATUS.PENDING_MANAGER
        ? 1
        : 0;
  await tblTrx(trx, APPROVAL_DB, APPROVAL_TABLE, APPROVAL_STAGE).where({ id }).update({
    status: row.approvalStatus,
    current_step: step,
    current_handler_hint:
      row.approvalStatus === LEAVE_STATUS.PENDING_MANAGER
        ? '待学管审批'
        : row.approvalStatus === LEAVE_STATUS.PENDING_PRINCIPAL
          ? '待校长审批'
          : null,
  });
  return id;
}

async function mustGet(stage: TeachingStage, id: string): Promise<LeaveRow> {
  const row = await REPOS[stage].detail(id);
  if (!row) throw new BizError(BizCode.STUDENT_LEAVE_NOT_FOUND, '申请单不存在');
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
  if (row.approvalStatus !== LEAVE_STATUS.DRAFT) {
    throw new BizError(BizCode.APPROVAL_ALREADY_SUBMITTED, '该单已提交，不能重复提交');
  }

  await db.transaction(async (trx) => {
    const approvalId = await ensureApproval(trx, id, row, op);
    await submitApproval(approvalId, op, trx);
    await REPOS[stage].setStatus(trx, id, LEAVE_STATUS.PENDING_MANAGER);
  });

  return {
    approvalStatus: LEAVE_STATUS.PENDING_MANAGER,
    approvalStatusName: LEAVE_STATUS_NAME[LEAVE_STATUS.PENDING_MANAGER],
  };
}

export async function approve(
  stage: TeachingStage,
  id: string,
  body: { comment?: string; newClassId?: string },
  user: any,
): Promise<{ finished: boolean; approvalStatus: number; approvalStatusName: string }> {
  await assertStageView(user, stage);
  const op = toOperator(user);
  const row = await mustGet(stage, id);

  // ① ★ 复学：参数完整性校验**前置**到 doApprove 之前。
  //    复学链只有 1 步（shared-types approval.ts：学管 → APPROVED），走到 approve 必然 finished。
  //    必须先拦：doApprove 写统一表（tblTrx）会**脱离本事务**（见 uniTable.ts tblTrx 的跨库注释），
  //    先批后校验会让「审批单已永久 finished、而复学班/副作用没做」成为脏状态
  //    （2026-10-16 _e2e-leave-check 开关开实锤：apR1 被拦后单子却已通过）。
  //    权限校验仍在 doApprove 里，前置的只是「参数是否存在」，越权者碰不到数据。
  /* ★ 2026-10-19 修：前置校验必须与下面第 708 行同口径 ——
     建单时已经填过复学班的（row.newClassId 有值），终审不传也应当通过
     （业务语义：沿用建单时选定的复学班）。原来只判 body.newClassId，
     导致「建单填了、终审不传」被误拦，单子卡在待审批。 */
  if (row.bizType === LEAVE_BIZ_TYPE.RESUME && !body.newClassId && !row.newClassId) {
    throw new BizError(BizCode.PARAM_ERROR, '复学审批必须选定复学班级');
  }

  let finished = false;
  let nextStatus: number = row.approvalStatus;

  await db.transaction(async (trx) => {
    const approvalId = await ensureApproval(trx, id, row, op);

    // ① 先走审批引擎（权限校验在 doApprove 里 —— 越权直接抛，下面的写入不会发生）
    const r = await doApprove(approvalId, op, body.comment, trx);
    finished = r.finished;
    nextStatus = Number(r.status);

    // ② ★ 复学：批到"通过"那一刻**才落复学班**
    //   班级优先取**本次审批传的**（学管可在审批时改），没传就用
    //   **发起申请时填的**（`row.newClassId`，2026-10-16 起建单必填）；
    //   两者都没有（老单）才报错 —— 不悄悄通过。
    if (row.bizType === LEAVE_BIZ_TYPE.RESUME && finished) {
      const newClassId = body.newClassId || row.newClassId || '';
      if (!newClassId) {
        throw new BizError(BizCode.PARAM_ERROR, '复学审批必须选定复学班级');
      }
      const clsName = await classNameOf(stage, newClassId);
      await REPOS[stage].setResumeClass(trx, id, newClassId, clsName);
    }

    await REPOS[stage].setStatus(trx, id, nextStatus);

    // ③ 全流程走完 → 副作用（改学生状态；复学要回到复学班，
    //    ⚠️ 所以上一步必须先把复学班写进去，afterApproved 才读得到）
    if (finished) {
      await REPOS[stage].afterApproved(trx, id, op.userId);
    }
  });

  return {
    finished,
    approvalStatus: nextStatus,
    approvalStatusName: LEAVE_STATUS_NAME[nextStatus] || '',
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
    await REPOS[stage].setStatus(trx, id, LEAVE_STATUS.REJECTED, { reject_reason: reason });
  });

  return {
    approvalStatus: LEAVE_STATUS.REJECTED,
    approvalStatusName: LEAVE_STATUS_NAME[LEAVE_STATUS.REJECTED],
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
    await REPOS[stage].setStatus(trx, id, LEAVE_STATUS.CANCELED);
  });

  return {
    approvalStatus: LEAVE_STATUS.CANCELED,
    approvalStatusName: LEAVE_STATUS_NAME[LEAVE_STATUS.CANCELED],
  };
}

/* ============================================================
 * 汇总
 * ============================================================ */

export async function summary(user: any): Promise<LeaveSummary[]> {
  const stages = await visibleStages(user);
  const out: LeaveSummary[] = [];
  for (const s of stages) {
    const a = await REPOS[s].aggregate();
    out.push({
      stage: s,
      stageName: TEACHING_STAGE_NAME[s],
      total: a.total,
      suspendCount: a.suspendCount,
      quitCount: a.quitCount,
      resumeCount: a.resumeCount,
      pendingCount: a.pendingCount,
      approvedCount: a.approvedCount,
    });
  }
  return out;
}

/** 供路由层用的常量（各学段支持的类型） */
export const STAGE_BIZ_SUPPORT = LEAVE_STAGE_BIZ;
