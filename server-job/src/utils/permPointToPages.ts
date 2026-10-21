/**
 * 权限库「功能点」→ legacy 页面权限码 的映射（**自建角色打通层**）
 *
 * ============================================================
 * 【解决什么问题 —— 2026-10-08 斌哥报的「自建角色无权限」】
 *
 *   现象：管理员新建角色 `XMJL_000`（项目经理2），在「职位权限分配」
 *   里勾满了「实训-教学」模块的全部功能点（40 条，落在
 *   `sms_perm.t_perm_role_perm`），但登录后**任何页面都进不去**。
 *
 *   根因（三层，逐层实测确认）：
 *     ① 页面级：legacy 四板块（job/edu/class/class-jh）的「这个角色能看哪些页」
 *        一直只读**代码里写死的** `ROLE_PAGE_PERMISSIONS[roleCode]`
 *        （见 pagePermissionSource.ts）。`XMJL_000` 是运行时新建的角色码，
 *        代码里从来没登记过 → 查到空数组 → 0 页。
 *     ② 对比：consult / finance 两个板块**本来就认权限库功能点**
 *        （走 consultMenusFromPerm / financeMenusFromPerm），
 *        所以自建角色在那两个板块反而是正常的 —— 这个不对称正是本文件要补的。
 *     ③ 操作码级其实已经打通（roleActionOverlay.ts 的 `train||*` 映射），
 *        所以现象是「按钮逻辑算得出、页面却进不去」。
 *
 * 【本文件做什么】
 *   维护一张**显式映射表**：权限库 (module_key, item_name) → legacy 页面权限码[]。
 *   `rolePageDefaults.ts` 在算「默认可见页面」时，除了读代码静态表，
 *   **再叠加**这份映射的结果 —— 于是自建角色只要勾了功能点，页面自动出现。
 *
 * 【★ 与 roleActionOverlay.ts 的区别（别搞混）】
 *   roleActionOverlay 解决的是「**按钮/接口**」：train||实训-班级信息 → job:class:edit
 *   本文件解决的是「**页面可见性**」：train||实训-班级信息 → job:class:view
 *   两者是同一件事的两个切面，**都要登记**，但落脚点不同。
 *
 * 【为什么不是「直接把权限树当权威」】
 *   ⚠️ 权限树里的勾选口径是**功能点级**，比页面级粗：
 *      勾了「实训-班级信息」= 这一页可见（含 view），但**不等于**该角色
 *      就能改班级（edit）—— 那是 roleActionOverlay 的差异存储管的。
 *   本映射只回答「**这一页要不要出现在菜单里**」，与按钮权限正交。
 *
 * 【★ 只做「加」不做「减」】
 *   本映射的产物是**并入默认集**（∪），调用方不会用它去删任何页面。
 *   想「去掉某页」仍然走「页面管理 → 角色模式」的台账（t_perm_role_page）。
 *   这样保证：① 对存量 14 个内置角色行为**零变化**（它们的功能点映射结果
 *   本就是静态表的子集）；② 自建角色立刻可用。
 * ============================================================
 */

import { RoleCode } from 'shared-types';

/**
 * `module_key||item_name` → legacy 页面权限码数组
 *
 * 维护提示：
 *   · key 一律 `module_key||item_name`（与 `t_perm_menu` 的列口径一致，
 *     也与 roleActionOverlay.ts 的 PERM_POINT_TO_ACTION_CODES 同构）
 *   · value 是该功能点对应的一到多个**页面权限码**
 *     （必须是 pageRegistry.ts 里真实存在的 pageCode，否则映射无效）
 *   · 一个功能点对应多页很常见 —— 如「acad||宿舍总名单」和
 *     「acad||换宿/退宿审批」都指向 `edu:dorm:view` 同一个页面
 *   · 只登记「有对应页面」的功能点；纯动作类功能点（如「approve||财务出款」）
 *     没有页面，**不登记**（登记了也无页可加）
 */
export const PERM_POINT_TO_PAGE_CODES: Record<string, readonly string[]> = {
  /* ============================================================
   * train（实训-教学）→ job:* 页面
   *   来源：t_perm_menu 的 10 个实训功能点
   * ============================================================ */
  'train||实训-班级信息': ['job:class:view'],
  'train||实训-出勤管理': ['job:attendance:view'],
  'train||实训-考试管理': ['job:exam:view'],
  'train||实训-成绩管理': ['job:examScore:view'],
  // ⚠️「成绩汇总」在 pageRegistry 里**没有独立菜单页**（是成绩管理列表点进去的子页），
  //    所以它不映射任何页面；勾了它对菜单无影响，跟父页面「实训-成绩管理」走。
  'train||实训-成绩汇总': [],
  'train||实训-休学退学复学审批': ['job:suspendApproval:view'],
  'train||实训-宿舍管理': ['job:dorm:view'],
  'train||实训-催费管理': ['job:feeCall:view'],
  'train||实训-退费申请': ['job:refund:view'],
  'train||实训-班级交接': ['job:classTransfer:view'],

  /* ============================================================
   * job（就业管理）→ job:* 就业阶段页面
   * ============================================================ */
  'job||就业信息档案': ['job:empArchive:view'],
  'job||就业日志': ['job:employmentLog:view'],
  'job||复盘填写': ['job:review:view'],
  'job||数据统计': ['job:statistics:view'],
  'job||换班交接': ['job:classTransfer:view'],
  // ⚠️「job||就业基地宿舍」在 t_perm_menu 里没有独立功能点
  //    （就业基地宿舍直接分配不走审批，权限跟着「就业信息档案」走）。

  /* ============================================================
   * teach（教学部门 · 大学部）→ class:* 页面
   * ============================================================ */
  'teach||学生基础数据': ['class:student:view'],
  'teach||班级管理': ['class:info:view'],
  'teach||出勤管理': ['class:attendance:view'],
  // ⚠️「teach||考试管理」管的是**考试安排 + 成绩录入**两件事，
  //    在班级板块对应两个页面（考试管理 / 成绩管理），一并给出。
  'teach||考试管理': ['class:exam:view', 'class:grade:view'],
  'teach||宿舍管理': ['class:dorm:view'],
  'teach||催费管理': ['class:urge:view'],
  'teach||退费申请': ['class:refund:view'],
  // 「流程管理」= 休学/退学/复学审批的班级侧入口
  'teach||流程管理': ['class:suspend:view'],

  /* ============================================================
   * acad（教务部门）→ edu:* 页面
   *   教务板块只有 3 页，7 个功能点归并到 3 页上
   * ============================================================ */
  'acad||学生档案': ['edu:student:view'],
  'acad||宿舍总名单': ['edu:dorm:view'],
  'acad||换宿/退宿审批': ['edu:dorm:view'],
  'acad||退宿名单': ['edu:dorm:view'],
  'acad||缴费总名单': ['edu:fee:view'],
  'acad||临期名单': ['edu:fee:view'],
  'acad||餐费住宿费缴费名单': ['edu:fee:view'],

  /* ============================================================
   * approve（审批中心）→ 各板块页面
   *   ⚠️ 这是**跨板块**的模块：勾了「休学/退学审批」的功能点，
   *      对应的是就业侧那一页（实训的休退学在 job:suspendApproval:view）。
   * ============================================================ */
  'approve||休学/退学审批': ['job:suspendApproval:view'],
  'approve||退费审批': ['job:refund:view'],
  // 「教质/学术审批」是班级初高的流程审批
  'approve||教质/学术审批': ['classjh:approval:view'],
  // ⚠️「待办事项」「教务核算」「财务出款」「校长审批」是审批环节/看板，
  //    没有独立菜单页，不映射。
};

/**
 * 由「角色的权限库功能点清单」算出它**额外的**可见页面权限码。
 *
 * @param moduleItems 该角色的功能点：`{ module_key: [item_name, ...] }`
 * @returns legacy 页面权限码数组（可能含重复，调用方自行 Set 去重）
 *
 * @example
 *   extraPagesFromModuleItems({ train: ['实训-班级信息', '实训-宿舍管理'] })
 *   // → ['job:class:view', 'job:dorm:view']
 */
export function extraPageCodesFromModuleItems(
  moduleItems: Record<string, string[]> | undefined | null,
): string[] {
  if (!moduleItems) return [];

  const out: string[] = [];
  for (const [mod, items] of Object.entries(moduleItems)) {
    for (const item of items || []) {
      const codes = PERM_POINT_TO_PAGE_CODES[`${mod}||${item}`];
      if (codes) codes.forEach((c) => out.push(c));
    }
  }
  return out;
}

/* ============================================================
 * ★★ 使用约束：**只对「自建角色」启用**
 *
 * 【为什么必须有这道闸】
 *   实测（2026-10-08）证明：把功能点换算**无条件**并入，会误伤内置角色 ——
 *     · 教务（ACAD_STAFF）在权限库有 teach/train 功能点 → 凭空多出
 *       `job:class:view` / `job:attendance:view`，而业务口径明确
 *       「教务不看就业管理」（见 pagePermissionSource.ts 的 ACAD_STAFF 注释）；
 *     · 班主任/学管 → 多出 `class:exam:view` 等**刻意不给**的班级侧页面；
 *     · 市场经理（MKT_MANAGER）→ 因为它在 approve 模块有功能点，
 *       多出 `job:suspendApproval:view` / `job:refund:view`（它压根不管这摊事）。
 *
 *   根因：权限库功能点是**模块粗粒度**授权（"这个角色在这个部门干活"），
 *   而 legacy 板块的页面口径是**逐页业务校准**过的。前者不能覆盖后者。
 *
 * 【闸门规则】
 *   角色码 ∈ 主包 `RoleCode` 枚举（= 内置角色）→ 一律不启用本映射。
 *   只有枚举里没有的（= 管理员在权限管理里**新建**的角色，如 `XMJL_000`）
 *   才启用 —— 这类角色在静态表里必然查不到，功能点就是它唯一的授权来源。
 *
 * ⚠️ 调用方（pagePermissionSource / rolePageDefaults）里还有一层
 *    `base.length === 0` 的短路，两处口径必须一致，改一处要改两处。
 * ============================================================ */

/** 主包内置角色码集合（= RoleCode 枚举的全部取值） */
const BUILTIN_ROLE_CODES: ReadonlySet<string> = new Set(Object.values(RoleCode));

/** 该角色码是不是「主包内置角色」（内置角色不走功能点推导） */
export function isBuiltinRoleCode(roleCode: string): boolean {
  return BUILTIN_ROLE_CODES.has(roleCode);
}
