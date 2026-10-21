/**
 * 审批链配置（★ 通用审批的核心）
 *
 * 归属模块：就业管理 > 实训阶段（马志斌）
 * 创建时间：2026-09-29
 *
 * ============================================================
 * 【这个文件是干什么的】
 * ============================================================
 *   退费、休学、退学三件事的审批流程，**全部在这里配置**。
 *   业务代码只认"配置"，不写死"第几步是谁"。
 *
 *   好处（非常重要）：
 *     斌哥说"休学退学暂定，后续可能会改" ——
 *     那就**改这个文件**，不用碰任何业务代码。
 *
 * ============================================================
 * 【三条审批链（斌哥 2026-09-29 拍板）】
 * ============================================================
 *
 *   退费：班主任发起 → 学管审批 → 校长审批 → 财务退费
 *
 *   休学：班主任发起 → 学管审批 → 通过后财务冻结费用（★ 不走校长）
 *
 *   退学：班主任发起 → 学管审批 → 校长审批 → 财务退费
 *
 *   复学：班主任发起 → 学管审批 → 通过（★ 不走校长）→ 学生回到实训中
 *         （2026-10-01 新增，与休学同为 1 步）
 *
 *   ★ 2026-10-08 斌哥拍板（一次口径统一）：
 *     「实训阶段的班主任由项目经理担任」——
 *     所以四类单据（退费/休学/退学/复学）的发起人白名单
 *     全部加上 RoleCode.PROJECT_MANAGER，与 TEACH_HEAD 并列。
 *     （宿舍调换/退宿此前已加，见文件末尾 DORM_CHANGE 节点）
 *     数据范围约束：项目经理只能对自己带的实训班发起，由 stageScope
 *     与各 route 的 project_manager_id 过滤实现，不在本文件表达。
 *
 * ============================================================
 * 【「学管」是哪个角色？】
 * ============================================================
 *   ★ 2026-09-30 更新（本条覆盖下面的旧口径）：
 *     斌哥拍板把「教质经理 + 学术经理」**合并成「学管主任」**（RoleCode.TEACH_DEAN）。
 *     角色码 QUALITY_MGR / ACADEMIC_MGR 保留但**已停用**（只为读历史数据）。
 *
 *   —— 以下是合并前的旧口径，仅作背景留存 ——
 *   斌哥拍板方案 A：
 *     学管 = 教质经理 / 学术经理 的另**一种叫法**，不新增角色。
 *     系统里就用 ROLE_QUALITY_MGR / ROLE_ACADEMIC_MGR 两个。
 *
 *   ⚠️ 学管不区分部门，谁都能批（初高中叫"教质经理+学术经理"，是同一职能的两种叫法）。
 */

import { RoleCode } from './enums';
import { ApprovalBizType, ApprovalStatus } from './enums';
// ★ 2026-10-08：角色别名感知。运行时 roles 来自权限库（RM_PROJECT），
//   配置里写的是主包 RoleCode（PROJECT_MANAGER），必须经 hasRole 桥接。
import { hasRole } from './roleAlias';

/**
 * 审批链上的一个节点
 */
export interface ApprovalNode {
  /** 步骤序号，从 1 开始 */
  step: number;
  /** 节点名称（显示给用户看，如「学管审批」） */
  name: string;
  /**
   * 有权审批这个节点的角色码列表
   * ⚠️ 是"或"的关系 —— 列表里任一角色都能批
   */
  roles: string[];
  /** 审批通过后，流程进入的状态（用来算"现在轮到谁"） */
  nextStatus: ApprovalStatus;
  /** 进了这个节点，提示文字是什么（前端直接显示） */
  hint: string;
}

/**
 * 一条完整审批链
 */
export interface ApprovalChain {
  /** 业务类型 */
  bizType: string;
  /** 业务名称 */
  bizName: string;
  /** 谁能发起 */
  initiatorRoles: string[];
  /** 审批节点（按 step 升序） */
  nodes: ApprovalNode[];
  /**
   * 通过之后要干什么（用文字描述，真正实现在业务代码里）
   * ⚠️ 这里只是写给人看的，程序不解析这个字段
   */
  afterApprove: string;
  /** 说明备注 */
  remark?: string;
}

/** 学管 = 教质经理 + 学术经理（斌哥拍板方案 A，不新增角色）*/
const XUE_GUAN_ROLES = [RoleCode.TEACH_DEAN];

/**
 * ★ 三条审批链的定义
 */
export const APPROVAL_CHAINS: Record<string, ApprovalChain> = {
  /* ============ 退费 ============ */
  [ApprovalBizType.REFUND]: {
    bizType: ApprovalBizType.REFUND,
    bizName: '退费',
    // ★ 2026-10-08 斌哥拍板：四类单据（退费/休学/退学/复学）+ 退宿调宿，
    //   发起人白名单统一加「项目经理」——实训阶段由项目经理担任班主任职责。
    initiatorRoles: [RoleCode.TEACH_HEAD, RoleCode.PROJECT_MANAGER],
    nodes: [
      {
        step: 1,
        name: '学管审批',
        roles: XUE_GUAN_ROLES,
        nextStatus: ApprovalStatus.PENDING_PRINCIPAL,
        hint: '待学管审批',
      },
      {
        step: 2,
        name: '校长审批',
        roles: [RoleCode.RM_PRINCIPAL],
        nextStatus: ApprovalStatus.APPROVED,
        hint: '待校长审批',
      },
    ],
    afterApprove: '通知财务退费（财务不审批，只执行出款）',
    remark: '每笔都走校长，不设金额阈值。班主任只能发申请，看不到审批按钮。',
  },

  /* ============ 休学 ============ */
  [ApprovalBizType.SUSPEND]: {
    bizType: ApprovalBizType.SUSPEND,
    bizName: '休学',
    // ★ 2026-10-08：加项目经理（同 REFUND 口径）
    initiatorRoles: [RoleCode.TEACH_HEAD, RoleCode.PROJECT_MANAGER],
    nodes: [
      {
        step: 1,
        name: '学管审批',
        roles: XUE_GUAN_ROLES,
        nextStatus: ApprovalStatus.APPROVED,
        hint: '待学管审批',
      },
    ],
    afterApprove: '改学生状态为「休学」+ 花名册离班 + 通知财务冻结费用',
    remark: '★ 休学不走校长（只有学管一审）。财务看审批单状态自行冻结，本模块不执行冻结动作。',
  },

  /* ============ 退学 ============ */
  [ApprovalBizType.QUIT]: {
    bizType: ApprovalBizType.QUIT,
    bizName: '退学',
    // ★ 2026-10-08：加项目经理（同 REFUND 口径）
    initiatorRoles: [RoleCode.TEACH_HEAD, RoleCode.PROJECT_MANAGER],
    nodes: [
      {
        step: 1,
        name: '学管审批',
        roles: XUE_GUAN_ROLES,
        nextStatus: ApprovalStatus.PENDING_PRINCIPAL,
        hint: '待学管审批',
      },
      {
        step: 2,
        name: '校长审批',
        roles: [RoleCode.RM_PRINCIPAL],
        nextStatus: ApprovalStatus.APPROVED,
        hint: '待校长审批',
      },
    ],
    afterApprove: '改学生状态为「退学」+ 花名册离班 + 释放床位 + 通知财务全额冻结/退费',
    remark: '★ 退学要走校长。退学所有费用全额冻结，不按天扣费。',
  },

  /* ============ 复学（2026-10-01 新增）============ */
  [ApprovalBizType.RESUME]: {
    bizType: ApprovalBizType.RESUME,
    bizName: '复学',
    // ★ 2026-10-08：加项目经理（同 REFUND 口径）
    initiatorRoles: [RoleCode.TEACH_HEAD, RoleCode.PROJECT_MANAGER],
    nodes: [
      {
        step: 1,
        name: '学管审批',
        roles: XUE_GUAN_ROLES,
        nextStatus: ApprovalStatus.APPROVED,
        hint: '待学管审批',
      },
    ],
    afterApprove:
      '改学生状态为「实训中」+ 按【复学班】重新入班 + 宿舍沿用原床位（休学期间已退宿则留空，由复学班班主任后续分配）',
    remark:
      '★ 复学与休学同为 1 步（只有学管审，不走校长）—— 斌哥 2026-10-01 拍板。' +
      '复学班级由班主任发起时手选（不一定是原班）。',
  },

  /* ============ 宿舍调换 / 退宿（2026-09-30 新增）============ */
  [ApprovalBizType.DORM_CHANGE]: {
    bizType: ApprovalBizType.DORM_CHANGE,
    bizName: '宿舍调换/退宿',
    // ★ 2026-10-08 修：加入 PROJECT_MANAGER（项目经理）
    //   斌哥反馈「项目经理不能提交退宿申请」。
    //   根因有两层：
    //     ① 名单里只有 TEACH_HEAD —— 项目经理压根不在发起人白名单
    //     ② 项目经理在权限库里的角色码是 `RM_PROJECT`，主包写的是
    //        `PROJECT_MANAGER` —— 两个码对不上，即使加进名单也匹配不到
    //   现在名单加上 PROJECT_MANAGER，且 canInitiate 走 hasRole 别名感知。
    //   业务口径（斌哥 2026-10-08 拍板）：项目经理能发起退宿/调宿，
    //   **但只限实训阶段自己带的班**（数据范围由 stageScope 控制）。
    initiatorRoles: [RoleCode.TEACH_HEAD, RoleCode.PROJECT_MANAGER],
    nodes: [
      {
        step: 1,
        name: '教务审批',
        roles: [RoleCode.ACAD_STAFF],
        nextStatus: ApprovalStatus.APPROVED,
        hint: '待教务审批',
      },
    ],
    afterApprove: '调换：旧床位释放 + 新床位占用 + 改学生宿舍；退宿：释放床位 + 清学生宿舍',
    remark:
      '★ 斌哥 2026-09-30 拍板：调换宿舍和退宿都走教务老师审批（1 步）。' +
      '教务老师 = ROLE_EDU_ADMIN，日常管宿舍的人。' +
      ' ★ 2026-10-08 补充：发起人 = 班主任（大学部）+ 项目经理（实训），' +
      '项目经理只能发起自己带的实训班学员。',
  },
};

/**
 * 取某个业务的审批链配置
 */
export function getApprovalChain(bizType: string): ApprovalChain | undefined {
  return APPROVAL_CHAINS[bizType];
}

/**
 * 取某个业务的第 N 步节点
 *
 * @param bizType 业务类型
 * @param step    步骤号（从 1 开始）
 */
export function getApprovalNode(bizType: string, step: number): ApprovalNode | undefined {
  return getApprovalChain(bizType)?.nodes.find((n) => n.step === step);
}

/**
 * 取某个业务一共有几步审批
 */
export function getApprovalStepCount(bizType: string): number {
  return getApprovalChain(bizType)?.nodes.length ?? 0;
}

/**
 * 「学管」角色集合（教质经理 / 学术经理）
 *
 * ★ 2026-09-30 斌哥拍板：学管拿到**校长的邮件授权**后，可以**代替校长审批**，
 *   这个授权过程**不体现在系统里** —— 所以这里直接放行，让学管能审任何一环节。
 *
 * ⚠️ 注意：**不做**「校长跳级」功能。流程仍然按顺序走（学管 → 校长），
 *    只是学管这个角色被放开了所有环节的审批权 —— 他拿到邮件同意后，
 *    可以把校长那一环也自己批掉，流程就走完了。
 *
 * 📌 #5 把教质/学术经理合并成「学管主任」后，这里只需改成本集合 = [RoleCode.TEACH_DEAN]。
 */
const MANAGER_ROLES: string[] = XUE_GUAN_ROLES;

/**
 * 判断某个角色能不能审批某业务的第 N 步
 *
 * ⚠️ 这个函数是「后端拦截」的依据 ——
 *    前端藏按钮只是"不碍眼"，真正拦人靠这里。
 */
export function canApprove(bizType: string, step: number, roles: string[]): boolean {
  const node = getApprovalNode(bizType, step);
  if (!node) return false;

  // ⓿ 万能测试号（SUPER_TEST）—— 权限管理模块（8006）还没接进来之前，
  //    斌哥要一个号能把「所有页面所有操作」都跑一遍，用来验证每条业务链路通不通。
  //    审批是链路最长的一环（发起→逐级审批→落地），不放开就等于没法端到端验证。
  //    ⚠️ 这颗「后门」上线前必须随 DEV_MODE 一起摘掉。
  if (roles.includes('SUPER_TEST')) return true;

  // ① 正常情况：这个环节指定的角色
  //    ★ 2026-10-08 改用 hasRole —— 别名感知。
  //      运行时 roles 来自权限库（如 RM_PROJECT），配置写的是主包 RoleCode
  //      （如 PROJECT_MANAGER），两者对不上 → 直接用 includes 会恒 false。
  if (node.roles.some((r) => hasRole(roles, r))) return true;

  // ② 学管「代替校长审批」—— ★ 只放开【本来就是校长审批的那些环节】
  //
  //    业务口径（斌哥 2026-09-30）：学管拿到校长邮件授权后，可以替校长把
  //    校长那一环批掉。**不是**"学管哪一环都能批"。
  //
  //    ⚠️ 2026-09-30 踩过的坑：这里原来写的是「只要角色里有学管就 return true」，
  //       结果**学管连宿舍调换/退宿（那是教务老师的环节）也能批了** —— 越权。
  //       所以必须加 `isPrincipalNode` 这个前置条件。
  const isPrincipalNode = node.roles.includes(RoleCode.RM_PRINCIPAL);
  if (isPrincipalNode && MANAGER_ROLES.some((r) => hasRole(roles, r))) return true;

  return false;
}

/**
 * 「全权角色」—— 拥有全部权限的角色（校长 / 系统管理员 / 万能测试号）
 *
 * ★★ 2026-10-08 斌哥拍板（口径 1a，与页面权限、操作码同一口径）：
 *   「校长拥有全部权限，可以进行任何操作，但也必须遵循权限管理的设置」。
 *
 * 【为什么要在这里也放一份】
 *   校长在「就业管理 → 班级信息管理」页点「休学/退学」按钮 → 调
 *   `POST /api/job/student-leave/create` → 这里 `canInitiate()` 判：
 *     发起人白名单 = `chain.initiatorRoles`（休学/退学/复学/退费 = [TEACH_HEAD, PROJECT_MANAGER]）
 *   —— **名单里没有校长** → 40302「只有班主任能发起休学/退学/复学申请」。
 *   而前端按钮的显示条件是 `canOperate = canAct('job:class:edit', true)`（校长有）
 *   → 表现就是「按钮看得见、一点就报红」，前后端口径割裂。
 *
 * 【为什么不能直接往每条链的 initiatorRoles 里加校长】
 *   `initiatorRoles` 是**业务发起人名单**，语义是「谁是这条单的发起方」。
 *   往里塞校长会让审批链配置失真（校长不是发起角色，他是全权角色）。
 *   全权是**跨全部单据的统一口径**，应该用独立的判据表达。
 *
 * 【「必须遵循权限管理设置」怎么办】
 *   这一层只表达「校长默认能发起」（静态基准）。
 *   「管理员在「职位权限分配」里撤掉了某动作」＝ 显式撤销，
 *   由**接口层的 overlay**（`resolveActionWithOverlay` / `getRemovedActionCodesForRoles`）
 *   再叠一层盖掉 —— 见 server-job/src/classes 各 route 的用法。
 *   两层合起来才既满足「校长全权」，又满足「遵循权限管理设置」。
 *
 * ⚠️ 别名感知：权限库里的校长码是 `RM_PRINCIPAL`，主包写 `RM_PRINCIPAL`
 *    （值一致，但 SYS_ADMIN ↔ ROLE_ADMIN 有错位），所以一律走 hasRole。
 */
const FULL_ACCESS_ROLES: string[] = [RoleCode.RM_PRINCIPAL, RoleCode.SYS_ADMIN];

/**
 * 判断某个角色能不能发起某业务
 *
 * ★ 2026-10-08：改用 hasRole —— 别名感知，见 roleAlias.ts。
 * ★ 2026-10-08 二次修：加「全权角色」口子 —— 校长/管理员对任何单据都能发起
 *   （斌哥口径 1a）。显式撤销由接口层的 overlay 负责盖掉。
 */
export function canInitiate(bizType: string, roles: string[]): boolean {
  const chain = getApprovalChain(bizType);
  if (!chain) return false;
  // ★ 万能测试号（SUPER_TEST）：与 canApprove 同口径放行，
  //   否则「能进页面、能点发起，但一提交就 403」，链路还是断的。
  if (roles.includes('SUPER_TEST')) return true;
  // ★ 全权角色（校长 / 系统管理员）：默认可发起任何单据。
  //   ⚠️ 管理员在权限树里的**显式撤销**由接口层 overlay 覆盖，见函数头注释。
  if (FULL_ACCESS_ROLES.some((r) => hasRole(roles, r))) return true;
  return chain.initiatorRoles.some((r) => hasRole(roles, r));
}

/**
 * 判断「这张单是不是我经手的」—— 提交 / 撤回 / 修改都靠它
 *
 * 【为什么要单独抽一个函数】
 *   审批单列表里每行都要算一次「这条我能不能提交 / 撤回」，
 *   而**系统自动生成的单子**（如班级结业自动产生的退宿单、退费单）
 *   的申请人写的是「业务上该负责的人」（班主任 / 项目经理），
 *   **不一定是当前点开页面的人**。
 *
 *   ⚠️ 这就是 2026-10-04 斌哥报的「系统自动生成的退宿单项目经理无法提交」：
 *      点结业的是项目经理，但单子 applicant_id 写成了大学班主任
 *      → 判`=== operator.userId` 对不上 → canSubmit 永远 false → 卡片死。
 *
 * 【口径】
 *   正常逻辑仍严格「本人发起才归我管」；
 *   只有万能测试号（SUPER_TEST）放行全部 —— 它的定位就是
 *   「权限模块未接前，把每条业务链路从发起到审批跑通一遍」。
 */
export function isMyApproval(
  approval: { applicant_id?: string | null } | null | undefined,
  operatorUserId: string,
  roles: string[],
): boolean {
  if (!approval) return false;
  if (roles.includes('SUPER_TEST')) return true;
  return approval.applicant_id === operatorUserId;
}

/**
 * 提交后的第一个状态（= 进入第 1 步、「待第 1 步审批人」）
 *
 * ⚠️ 恒为 PENDING_MANAGER —— 因为「待第 1 步」这个状态是固定的，
 *    和某个节点的 nextStatus（"批完后进入哪个状态"）不是一回事。
 *    例：休学只有 1 步且 nextStatus = APPROVED，但提交后仍应是"待学管审批"。
 */
export function getInitialPendingStatus(bizType: string): ApprovalStatus {
  const first = getApprovalNode(bizType, 1);
  if (!first) return ApprovalStatus.DRAFT;
  return ApprovalStatus.PENDING_MANAGER;
}

/**
 * 当前状态对应"轮到第几步"
 *
 * 用法：流程从 PENDING_MANAGER 走完第 1 步后，状态变成第 1 步的 nextStatus，
 *      这时要判断是不是全走完了。
 */
export function isFinished(status: number): boolean {
  return (
    status === ApprovalStatus.APPROVED ||
    status === ApprovalStatus.REJECTED ||
    status === ApprovalStatus.CANCELED
  );
}
