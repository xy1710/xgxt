import { NextFunction, Request, Response } from 'express';
import { PermAction, RoleCode } from 'shared-types/class';
import { Errors } from '../http/response';
import {
  AuthUser,
  FULL_ACCESS_ROLES,
  WRITE_FULL_ACCESS_ROLES,
  hasAnyRole,
  isFullAccess,
} from './authUser';
// ★ 2026-10-07：接口级打通 —— 把「职位权限分配」的显式改动叠加到本模块的静态写白名单上。
//   见 src/utils/roleActionOverlay.ts 的 §7。
import {
  preloadRoleActionOverrides,
  resolveActionWithOverlay,
} from '../../utils/roleActionOverlay';

/**
 * 权限判定
 *
 * 当前实现：**内置兜底矩阵**（用户确认方案：自建 + 额外产出 8001/8006 桩服务）
 * 等 8006 权限模块就绪后，把 resolvePerms 换成调 /api/perm/user/perm 并缓存即可，
 * 调用方（requirePerm）与前端都不需要改。
 *
 * 资源命名与接口路径第二段一致：/api/class/{资源}/{动作}
 *
 * ★ 2026-10-07 接口级打通：
 *   静态矩阵（本文件的 WRITE_ROLES）仍是**基线**；
 *   管理员在「职位权限分配」里对该角色做出的**显式改动**会叠加其上
 *   （撤销 → 接口 403；新增 → 放行）。没被改动过的码，行为与从前完全一致。
 *
 *   对应关系：`requirePerm('student', PermAction.ADD)` → 操作码 `class:student:add`
 *   —— 与前端 `can('class:student:add')`、初高模块 `checkPermission('class:student:add')`
 *   完全同构（三处同一把钥匙）。
 */

/**
 * 谁能写。view 默认所有登录用户都可以，这里只列写权限
 *
 * ★ 2026-10-04 斌哥拍板：「班主任、助教、教员的权限应一样，
 *   可以进行班级交接等和班级有关的全部操作」
 *   → 引入 TEACHING_STAFF（班主任/教员/助教 三家）统一口径，
 *     class / transfer / student / attendance / grade / exam / urge 都放给他们。
 *   → 项目经理（PROJECT_MANAGER）**不在**这个名单里：
 *     他带的班是实训阶段升上来的，按需求不能建班/改班/交接。
 *
 * ★ 2026-10-06 拆出 WRITE_FULL_ACCESS_ROLES（**不含学管主任**）：
 *   学管主任是审批角色，只审不写。原先这里全是 `...FULL_ACCESS_ROLES`，
 *   而 `shared-types/class` 把 QUALITY_MGR/ACADEMIC_MGR 的值定义成 'TEACH_DEAN'，
 *   于是学管被顺带放进了每个资源的写白名单（能建班、能录成绩）。
 *   现在写白名单统一用 WRITE_FULL_ACCESS_ROLES；
 *   `approval`（审批中心）仍然用 FULL_ACCESS_ROLES —— 学管必须能批。
 */
const TEACHING_STAFF = [RoleCode.HEAD_TEACHER, RoleCode.TEACHER, RoleCode.ASSISTANT];

const WRITE_ROLES: Record<string, string[]> = {
  /** 学生：班主任/教员/助教可新建、可补充剩余信息；校长全权 */
  student: [...WRITE_FULL_ACCESS_ROLES, ...TEACHING_STAFF],
  /** 班级档案：校长 + 班主任/教员/助教（斌哥 2026-10-04：三家权限一致） */
  class: [...WRITE_FULL_ACCESS_ROLES, ...TEACHING_STAFF],
  /** 班级交接：同上（斌哥明确要求「可以进行班级交接」） */
  transfer: [...WRITE_FULL_ACCESS_ROLES, ...TEACHING_STAFF],
  /** 末班记录：教员/班主任上报，学管确认 */
  repeat: [...WRITE_FULL_ACCESS_ROLES, ...TEACHING_STAFF],
  /** 出勤：班主任 / 教员 / 助教录入 */
  attendance: [...WRITE_FULL_ACCESS_ROLES, ...TEACHING_STAFF],
  /** 考试与成绩：教员 / 班主任 / 助教录入 */
  exam: [...WRITE_FULL_ACCESS_ROLES, ...TEACHING_STAFF],
  /** 成绩：三家都可录入/修改/末班（需求 v1.5 + 2026-10-04 权限一致） */
  grade: [...WRITE_FULL_ACCESS_ROLES, ...TEACHING_STAFF],
  /** 催费：三家都能执行催收动作 */
  urge: [...WRITE_FULL_ACCESS_ROLES, ...TEACHING_STAFF],
  /** 缴费：只读副本，只有同步写入（系统内部） */
  fee: [...WRITE_FULL_ACCESS_ROLES],
  /** 宿舍：只读副本 + 申请发起 */
  dorm: [...WRITE_FULL_ACCESS_ROLES],
  dormApply: [...WRITE_FULL_ACCESS_ROLES, ...TEACHING_STAFF],
  /** 休学 / 退学：三家一致（斌哥 2026-10-04），发起后走审批链 */
  suspend: [...WRITE_FULL_ACCESS_ROLES, ...TEACHING_STAFF],
  /** 退费：班主任发起 */
  refund: [...WRITE_FULL_ACCESS_ROLES, RoleCode.HEAD_TEACHER],
  /** 升学：★ 2026-10-04 大学部班主任组（班主任/教员/助教）都能发起（交棒①） */
  upgrade: [...WRITE_FULL_ACCESS_ROLES, ...TEACHING_STAFF],
  /** 站内通知：只读（消息由系统生成） */
  notify: [...WRITE_FULL_ACCESS_ROLES],
  /**
   * 审批中心：学管 / 校长
   * ⚠️ 这里**保持 FULL_ACCESS_ROLES**（含学管主任）—— 学管的唯一写动作就是审批。
   */
  approval: [...FULL_ACCESS_ROLES],

  /**
   * 待接收学员的「接收 / 驳回」（/api/class/consult/receive|reject）
   *
   * ★ 2026-10-06 新增：这是**审批性质**的动作（咨询推送 → 班主任/学管接收），
   *   不是普通的"学生新增"。学管主任虽然不是本班班主任，但他是这条链的
   *   审批人，必须能接收/驳回。
   *
   *   之前这里挂的是 `requirePerm('student', ADD|EDIT)` —— 学管的写白名单
   *   一收窄，他连"接收学员"都点不动了（实测被 403）。
   *   所以单列一个资源：能写业务数据的三家 + 学管，都在里面。
   *   ⚠️ 具体"是不是我的班"由路由内部的 `canHandlePush()` 再判一次。
   */
  consultApprove: [...WRITE_FULL_ACCESS_ROLES, ...TEACHING_STAFF, RoleCode.QUALITY_MGR],
};

/**
 * PermAction（数字枚举）→ 操作码后缀
 *
 * ⚠️ 这里必须与前端 `can('class:xxx:add')` / 初高模块 `checkPermission('class:xxx:add')`
 *    的字符串口径严格一致，否则叠加层匹配不上（静默失效、极难排查）。
 */
const ACTION_SUFFIX: Record<number, string> = {
  [PermAction.VIEW]: 'view',
  [PermAction.ADD]: 'add',
  [PermAction.EDIT]: 'edit',
  [PermAction.DELETE]: 'delete',
  [PermAction.APPROVE]: 'approve',
  [PermAction.EXPORT]: 'export',
};

/** 由 (资源, 动作) 拼出全系统统一的操作码，如 `class:student:add` */
export function actionCodeOf(resource: string, action: PermAction): string {
  return `class:${resource}:${ACTION_SUFFIX[action] ?? String(action)}`;
}

/**
 * 静态判权（**只**看本文件的写白名单，不看权限树）
 *
 * —— 这也是「叠加层查不到数据」时的降级目标：权限库抖一下，
 *    行为退回从前，不会突然把全站写操作全 403。
 */
function staticCanRole(resource: string, role: string): boolean {
  const allowed = WRITE_ROLES[resource];
  // 未登记的资源：保守起见只放给「能写的全权角色」（校长 / 管理员 / 测试号）
  // ★ 2026-10-06：这里原来用 isFullAccess()，而它含学管主任 →
  //   凡是没在表里登记的资源，学管都能写。改用写白名单。
  if (!allowed) return WRITE_FULL_ACCESS_ROLES.includes(role);
  return allowed.includes(role);
}

function staticCan(resource: string, action: PermAction, user: AuthUser): boolean {
  if (action === PermAction.VIEW) return true; // 登录即可查看，数据再按 dataScope 过滤
  const allowed = WRITE_ROLES[resource];
  if (!allowed) return hasAnyRole(user, WRITE_FULL_ACCESS_ROLES);
  return hasAnyRole(user, allowed);
}

/**
 * 是否允许（静态白名单 ∪ 权限树的显式改动）
 *
 * ★ 2026-10-07 起为 async：先去预热叠加层缓存（15s TTL，热态零查库成本），
 *   再把「职位权限分配」里的显式撤销/授权叠加上去。
 */
export async function can(
  resource: string,
  action: PermAction,
  user: AuthUser | undefined,
): Promise<boolean> {
  if (!user) return false;
  if (action === PermAction.VIEW) return true; // 查看不受写权限控制

  const code = actionCodeOf(resource, action);
  try {
    await preloadRoleActionOverrides();
    return resolveActionWithOverlay(user.roles, code, (role) => staticCanRole(resource, role));
  } catch {
    // 降级：叠加层异常 → 退回纯静态判权（绝不误伤）
    return staticCan(resource, action, user);
  }
}

/** 权限中间件：requirePerm('student', PermAction.EDIT) */
export function requirePerm(resource: string, action: PermAction) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) return next(Errors.unauthorized());
    if (!(await can(resource, action, req.user))) {
      return next(Errors.noOperationPermission('您无权执行此操作，请联系学管或校长'));
    }
    next();
  };
}

/**
 * 审批动作的专用守卫
 * 退费 / 休学 / 退学的审批只放给学管与校长（校长仅退学与超阈值退费需要）
 *
 * ⚠️ 用 isFullAccess（**含学管主任**）—— 这是学管唯一保留的写入口。
 *    别改成 WRITE_FULL_ACCESS_ROLES，那样学管就批不了了。
 *
 * ⚠️ 本守卫不参与权限树叠加：它是「审批链的角色门槛」，
 *    与「职位权限分配」里的动作勾选是两件事（审批权由审批流定义）。
 */
export function requireApprover() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) return next(Errors.unauthorized());
    if (!isFullAccess(req.user)) {
      return next(Errors.noOperationPermission('审批操作仅学管与校长可执行'));
    }
    next();
  };
}
