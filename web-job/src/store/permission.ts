/**
 * 当前用户页面权限（就业管理 > 实训阶段）
 *
 * 【用途】
 *   1. 左侧菜单过滤：没权限的菜单项不显示
 *   2. 路由守卫：直接输 URL 也进不去
 *   3. 页面内：可以用 hasPage() 控制按钮显隐
 *
 * 【数据来源】
 *   后端 /api/job/auth/my-pages
 *   后端再往上追，是权限管理模块（8006）—— 现在 8006 未就绪，用本地假数据。
 *
 * 【⚠️ 重要认知：前端过滤菜单 ≠ 权限控制】
 *   前端隐藏菜单只是「不碍眼」，真正的拦截在后端接口。
 *   就算前端把菜单藏了，用户直接调接口照样能拿到数据 ——
 *   所以后端每个接口都必须挂权限校验（本模块已做）。
 */

import { ref, computed } from 'vue';
import { RoleCode, normalizeRoles } from 'shared-types';
import { http, setReadOnlyState } from '@/api/request';

/** 页面权限定义（与后端 PAGE_PERMISSIONS 结构一致） */
export interface PagePermission {
  code: string;
  name: string;
  path: string;
  group: string;
  desc: string;
}

interface MyPagesData {
  roles: string[];
  permissions: string[];
  removedCodes?: string[];
  pages: PagePermission[];
  allPages: PagePermission[];
}

/** 当前用户可访问的页面 */
export const myPages = ref<PagePermission[]>([]);
/** 当前用户的权限码 */
export const myPermissions = ref<string[]>([]);
/** 当前用户角色 */
export const myRoles = ref<string[]>([]);
/** 当前用户 ID（★ 2026-10-04 交棒模型：按「岗位责任人是不是我」判断按钮显隐） */
export const myUserId = ref('');
/** ★ 2026-10-07 被「职位权限分配」显式撤销的操作码（前端按钮据此叠加隐藏） */
export const myRemovedCodes = ref<string[]>([]);

/**
 * 当前用户是不是「只读管理员」（斌哥 2026-09-30 拍板）
 *
 *   系统管理员**能看所有页面，但不能做任何写操作**（校长才是"能看又能操作"的那个）。
 *   页面里用它隐藏操作按钮（新增/编辑/删除/审批…）。
 *
 * ⚠️ 判定条件：角色列表里**只有** ROLE_ADMIN。
 *    如果一个人同时是管理员 + 别的业务角色，按业务角色走，不算只读。
 */
export const isReadOnlyAdmin = computed(() => {
  const r = myRoles.value;
  return r.length > 0 && r.every((x) => x === RoleCode.SYS_ADMIN);
});

/**
 * 学管主任（★ 2026-10-06 新增）—— 「只读 + 仅审批可写」
 *
 *   业务口径：学管主任是**审批角色**（退费/休学/退学/复学/升实训/待接收学员），
 *   除了「同意 / 驳回 / 接收」，其他一切（建班、交接、录出勤、录成绩、
 *   建宿舍、发起退费…）都只能查看。
 *
 *   ⚠️ `TEACH_QTY`（教质经理）是同一职能的历史角色码，同样按只读处理。
 *   ⚠️ 与 `isReadOnlyAdmin` 的区别：
 *      · 管理员 —— **连审批都不能**（纯只读）
 *      · 学管主任 —— 能审批（审批按钮要保留）
 *      所以「审批按钮」不能只用本判定，要用 `isReadOnlyUser` +
 *      `v-readonly-hide.approver` 这类"豁免"写法，见 main.ts 的指令。
 */
export const APPROVAL_ONLY_ROLES: string[] = [RoleCode.TEACH_DEAN, 'TEACH_QTY'];
export const isApprovalOnly = computed(() => {
  const r = myRoles.value;
  return r.length > 0 && r.some((x) => APPROVAL_ONLY_ROLES.includes(x));
});

/**
 * 前端统一的「只读用户」判定 —— 写操作按钮据此隐藏
 *
 *   = 系统管理员（纯只读） 或 学管主任（只读 + 仅审批）
 *
 *   ⚠️ 只读只是**体验层**：真正的拦截在后端
 *      （app.ts 的两个总闸 / middleware/approvalOnly.ts）。
 */
export const isReadOnlyUser = computed(() => isReadOnlyAdmin.value || isApprovalOnly.value);

/** 只读的原因文案（写请求被前端拦下时提示用） */
export const readOnlyReason = computed(() => {
  if (isReadOnlyAdmin.value) return '系统管理员是只读账号，不能执行新增 / 修改 / 删除';
  if (isApprovalOnly.value) return '学管主任为审批角色：只能查看数据、执行审批，不能新增 / 修改 / 删除';
  return '';
});

/**
 * 当前用户是不是「万能测试号」（SUPER_TEST）
 *
 * 【它是什么】
 *   权限管理模块（8006）还没接进来的时候，斌哥要一个号能看能改**所有页面**，
 *   专门用来验证「每个模块的业务到底通不通」，权限对不对以后再说。
 *
 * 【为什么不用系统管理员】
 *   系统管理员被 app.ts 的全局只读闸判成「只读」，写请求一律 40302 ——
 *   能进所有页面，但一个按钮都点不了，正好不是斌哥要的东西。
 *   所以后端专门造了这个不存在的角色码 SUPER_TEST。
 *
 * 【怎么用】
 *   页面里凡是 `myRoles.includes(某个角色)` 这种硬编码判断，都 OR 上 `isSuperTest`：
 *     const canInitiate = computed(() =>
 *       isSuperTest.value || myRoles.value.includes(RoleCode.TEACH_HEAD));
 *   不然万能号会漏掉那些「没挂操作码、只在页面里写死角色」的老按钮。
 */
export const SUPER_TEST_ROLE = 'SUPER_TEST';
export const isSuperTest = computed(() => myRoles.value.includes(SUPER_TEST_ROLE));

/* ============================================================
 * ★ 2026-10-08 斌哥拍板：「实训阶段的班主任由项目经理担任」
 *
 * 【为什么要有这几个语义化出口】
 *   原先 4 个页面的「发起」按钮都硬编码成：
 *     myRoles.includes(RoleCode.TEACH_HEAD)
 *   而项目经理在权限库里的角色码是 `RM_PROJECT`，主包写的是
 *   `PROJECT_MANAGER` —— 两边对不上 → 项目经理永远看不到发起按钮。
 *
 *   ⚠️ 关键：myRoles 已经在 loadMyPermissions() 里过了 normalizeRoles()，
 *      也就是 `RM_PROJECT` **已被翻译成** `PROJECT_MANAGER`，
 *      所以这里直接判主包 RoleCode 是对的，不需要再认别名。
 *
 * 【口径】班主任能发起的单据，项目经理也能发起（四类单据 + 退宿调宿）；
 *   真正的数据范围（只能对自己带的实训班）由后端 stageScope 拦截，
 *   前端只负责"按钮不碍眼"。
 * ============================================================ */
/** 班主任视角 */
export const isHeadTeacher = computed(() => myRoles.value.includes(RoleCode.TEACH_HEAD));
/** 项目经理视角（实训阶段带班负责人） */
export const isProjectManager = computed(() =>
  myRoles.value.includes(RoleCode.PROJECT_MANAGER),
);
/** 「带班发起人」= 班主任 或 项目经理 —— 各页面「发起」按钮统一用它 */
export const isClassInitiator = computed(() => isHeadTeacher.value || isProjectManager.value);
/** 是否已加载完权限（路由守卫要等这个） */
export const permissionLoaded = ref(false);

/** 拉取当前用户权限 */
export async function loadMyPermissions(): Promise<void> {
  try {
    const data = await http.get<MyPagesData>('/api/job/auth/my-pages');
    myPages.value = data.pages || [];
    myPermissions.value = data.permissions || [];
    // ★ 2026-10-08：把后端下发的角色码「归一化」成主包 RoleCode 的写法。
    //   原因：后端 roles 来自权限库（如项目经理是 `RM_PROJECT`），
    //   而全前端页面写的判断是 `myRoles.value.includes(RoleCode.PROJECT_MANAGER)`
    //   —— 两个码对不上 → 判断恒 false → 按钮永远不显示。
    //   在这个【唯一入口】归一化后，所有页面无需改动即可生效。
    //   （映射表见 shared-types/src/roleAlias.ts）
    myRoles.value = normalizeRoles(data.roles || []);
    myUserId.value = (data as any).userId || '';
    myRemovedCodes.value = data.removedCodes || [];
    // ⭐ 同步给请求层 —— request.ts 不能反向 import 本文件（会循环依赖），
    //    所以由这边主动把结果推过去，写操作会被它提前拦掉。
    // ★ 2026-10-06：只读范围从「管理员」扩到「管理员 + 学管主任」，
    //    并告知请求层「学管的审批动作要放行」。
    setReadOnlyState(isReadOnlyUser.value, readOnlyReason.value, isApprovalOnly.value);
  } catch (e) {
    // 拉不到权限时：为了不让页面全白，给一个"什么都不能看"的空列表
    // （后端接口有独立校验，前端这里空着是安全的）
    myPages.value = [];
    myPermissions.value = [];
    myRoles.value = [];
    myUserId.value = '';
    myRemovedCodes.value = [];
    setReadOnlyState(false);
    // eslint-disable-next-line no-console
    console.warn('[权限] 加载失败，已降级为空权限', e);
  } finally {
    permissionLoaded.value = true;
  }
}

/**
 * 能不能访问某个页面（按路由路径判断）
 *
 * 用法：hasPage('/teaching/class') → true/false
 *      hasPage('/class-jh/xxx/students') → 走前缀匹配
 *
 * ★ 第 3 期提醒：合并域的旧路由（`/class` `/exam` `/dorm` 等）已陆续下线，
 *   **判学段可见性请用 `hasPerm(权限码)`**，或 `teaching/access.ts` 的
 *   `stageVisible(domain, stage)` —— 别再用旧路由判权，否则路由删掉后
 *   学段会集体「消失」。
 */
export function hasPage(path: string): boolean {
  // 精确匹配
  if (myPages.value.some((p) => p.path === path)) return true;
  // 前缀匹配（动态路由，如 /class/:id/students 对应 /class/abc/students）
  return myPages.value.some((p) => {
    if (!p.path.includes('/:')) return false;
    const prefix = p.path.split('/:')[0];
    return path.startsWith(prefix + '/');
  });
}

/** 有没有某个权限码 */
export function hasPerm(code: string): boolean {
  return myPermissions.value.includes('*') || myPermissions.value.includes(code);
}

/**
 * ★ 2026-10-07 按钮级判权：角色默认 + 权限树叠加（job/edu 板块用）
 *
 *   job/edu 板块的按钮默认显隐由「角色白名单」决定（各页面自己写死的
 *   canInitiate / canOperate），这套默认是准的。这里在它之上再叠加一层：
 *   —— 管理员在「职位权限分配」里**取消**某个动作后，对应按钮要消失。
 *
 *   @param code        操作码（如 job:refund:apply）
 *   @param roleDefault 角色层面的默认可见性（调用方把原来的角色判断传进来）
 *
 *   语义：万能测试号放行；角色默认不可见 → 隐藏；否则若该码被权限树显式
 *   撤销 → 隐藏；其余 → 显示。
 */
export function canAct(code: string, roleDefault: boolean): boolean {
  if (isSuperTest.value) return true;
  if (!roleDefault) return false;
  return !myRemovedCodes.value.includes(code);
}

/** 重置（登出时用） */
export function resetPermissions(): void {
  myPages.value = [];
  myPermissions.value = [];
  myRoles.value = [];
  myUserId.value = '';
  myRemovedCodes.value = [];
  permissionLoaded.value = false;
}
