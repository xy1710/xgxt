import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router';
import { loadMyPermissions, permissionLoaded, hasPage, myPages } from '@/store/permission';
import {
  ensurePortalProfile,
  ensureModuleStores,
  moduleAllowed,
  moduleOfPageCode,
  pageModuleAllowed,
  menuAllowed,
  portalLandingPath,
} from '@/store/modules';
/* ★ 2026-10-06 新增：板块 → 页面 台账（权限管理 → 页面管理）
 *   守卫里因此多两步：① ensurePageConfig() 拉一次台账
 *                    ② pageEnabled(to.path) 拦掉被取消勾选的页面
 *   还有 firstEnabledPortalPath()：兜底落地页要跳过「已被关掉」的页面，
 *   否则会一直把用户送往那个已关闭的页面。 */
import { ensurePageConfig, pageEnabled, firstEnabledPortalPath } from '@/store/pageConfig';
/* ★ 第 1 期「入口合并」：初高 / 大学 / 实训 / 就业 / 教务 的重复页面，
 *   在左侧菜单里收成 9 个「业务域」入口（/teaching/<域>），
 *   进去顶部是学段页签。原路由全部保留，这里只是**新增**聚合入口。 */
import { teachingRoutes } from '@/teaching/routes';

/**
 * 路由配置 —— 统一门户版（就业/教务/班级 + 市场咨询/财务/权限）
 *
 * ★ 2026-10-05 深度单体合并：
 *   合并前是 5 个独立前端（5173 就业 / 5175 门户 / consult / finance / perm），
 *   门户用 iframe 承载其余模块。现在全部并成一个 SPA（5173），
 *   各模块页面都是【真实路由】，按模块加前缀避免重名：
 *     /consult/*  市场咨询   （原 consult 的 /student、/fee…）
 *     /finance/*  财务管理   （原 finance 的 /finance、/fee…）
 *     /perm/*     权限管理   （原 perm 的 /overview、/role…）
 *   就业/教务/班级沿用原路径（/exam、/edu/*、/class/* …），不迁移。
 *
 * 【权限守卫说明 · 两套并存】
 *   ① 就业/教务/班级：沿用 meta.pageCode + 后端 /api/job/auth/my-pages（pagePermissions.ts）
 *   ② 市场咨询/财务/权限：用门户下发的 visibleModules（模块 → 页面 menuKey）
 *   两套判定互不干扰：有 pageCode 的按①，有 module/menuKey 的按②。
 */

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'Workbench',
    // ★ 2026-10-16 用户指令：「将工作台放置首页，每个角色进来第一个页面就是工作台」
    //   首页不再是“跳到第一个有权限页面”的空壳，而是真正的工作台页：
    //   初高 KPI + 待办（有权限才显示）+ 按权限自适应的快捷入口。
    //   不挂 pageCode/module —— 能登录就能进（守卫不拦截）。
    component: () => import('@/views/Workbench.vue'),
    meta: { title: '工作台' },
  },

  /* ============ 统一登录（门户 · 全系统唯一入口） ============ */
  // ★ 2026-10-05：原 /dev-login（演示选角色）已删除，DEV_MODE 已关闭，
  //    全系统只有这一个登录入口。
  {
    path: '/login',
    name: 'Login',
    component: () => import('@/portal/views/Login.vue'),
    meta: { title: '登录', public: true },
  },

  /* ============ 占位页 / 无权限页 ============ */
  {
    path: '/coming',
    name: 'Coming',
    component: () => import('@/views/Placeholder.vue'),
    meta: { title: '功能开发中' },
  },
  {
    path: '/no-permission',
    name: 'NoPermission',
    component: () => import('@/views/NoPermission.vue'),
    meta: { title: '无访问权限' },
  },

  /* ================================================================
   * 市场咨询（原 01-王寒逸-consult · 8001）→ /consult/*
   * ================================================================ */
  {
    path: '/consult/student',
    name: 'ConsultStudent',
    component: () => import('@/consult/views/StudentList.vue'),
    meta: { title: '学生管理', module: 'consult', menuKey: 'student' },
  },
  {
    path: '/consult/fee',
    name: 'ConsultFee',
    component: () => import('@/consult/views/FeeList.vue'),
    meta: { title: '收款与缴费', module: 'consult', menuKey: 'fee' },
  },
  {
    path: '/consult/approve',
    name: 'ConsultApprove',
    component: () => import('@/consult/views/Approve.vue'),
    meta: { title: '审批中心', module: 'consult', menuKey: 'approve' },
  },
  {
    path: '/consult/refund',
    name: 'ConsultRefund',
    component: () => import('@/consult/views/RefundList.vue'),
    meta: { title: '退费管理', module: 'consult', menuKey: 'refund' },
  },
  {
    path: '/consult/loss',
    name: 'ConsultLoss',
    component: () => import('@/consult/views/LossList.vue'),
    meta: { title: '流失记录', module: 'consult', menuKey: 'loss' },
  },

  /* ================================================================
   * 财务管理（原 05-周铭-finance · 8005）→ /finance/*
   * ================================================================ */
  {
    path: '/finance/overview',
    name: 'FinanceOverview',
    component: () => import('@/finance/views/FinanceOverview.vue'),
    meta: { title: '财务概览', module: 'finance', menuKey: 'finance' },
  },
  {
    path: '/finance/fee',
    name: 'FinanceFee',
    component: () => import('@/finance/views/FeeList.vue'),
    meta: { title: '缴费管理', module: 'finance', menuKey: 'fee' },
  },
  {
    path: '/finance/refund',
    name: 'FinanceRefund',
    component: () => import('@/finance/views/RefundList.vue'),
    meta: { title: '退费管理', module: 'finance', menuKey: 'refund' },
  },
  {
    path: '/finance/freeze',
    name: 'FinanceFreeze',
    component: () => import('@/finance/views/FreezeList.vue'),
    meta: { title: '冻结名单', module: 'finance', menuKey: 'freeze' },
  },
  {
    path: '/finance/bill',
    name: 'FinanceBill',
    component: () => import('@/finance/views/BillList.vue'),
    meta: { title: '账单明细', module: 'finance', menuKey: 'bill' },
  },
  {
    path: '/finance/standard',
    name: 'FinanceStandard',
    component: () => import('@/finance/views/FeeStandard.vue'),
    meta: { title: '费用标准', module: 'finance', menuKey: 'standard' },
  },

  /* ================================================================
   * 权限管理（原 06-林晓-perm · 8006）→ /perm/*
   * ================================================================ */
  {
    path: '/perm/overview',
    name: 'PermOverview',
    component: () => import('@/perm/views/Overview.vue'),
    meta: { title: '权限总览', module: 'perm', menuKey: 'overview' },
  },
  {
    path: '/perm/dept',
    name: 'PermDept',
    component: () => import('@/perm/views/DeptManage.vue'),
    meta: { title: '部门管理', module: 'perm', menuKey: 'dept' },
  },
  {
    path: '/perm/role',
    name: 'PermRole',
    component: () => import('@/perm/views/RoleManage.vue'),
    meta: { title: '职位管理', module: 'perm', menuKey: 'role' },
  },
  {
    path: '/perm/user',
    name: 'PermUser',
    component: () => import('@/perm/views/UserManage.vue'),
    meta: { title: '账号管理', module: 'perm', menuKey: 'user' },
  },
  {
    path: '/perm/assign',
    name: 'PermAssign',
    component: () => import('@/perm/views/PermAssign.vue'),
    meta: { title: '职位权限分配', module: 'perm', menuKey: 'assign' },
  },
  /* ⚠️ 2026-10-06 用户指令：「权限管理板块里面删除规则配置页面」
   *    → 原 /perm/rule（规则配置，views/RuleConfig.vue）路由已删除。
   *      同时下线的还有：门户注册表 portals 的 rule 菜单项、PERM_MENU_KEYS 的 'rule'、
   *      前端 perm/api/perm.ts 的 ruleApi。
   *      即便有人手输 /#/perm/rule，守卫第 4 步 menuAllowed('perm','rule') 也会
   *      因为菜单里已无 rule 而把他弹回有权限的落地页。
   *    ⚠️ 后端 /api/perm/rule/* 按项目既有约定（删前端、留后端）暂留作兜底通道。
   */
  /* ★ 2026-10-06 新增：页面管理（板块 → 页面 台账）
   *   打勾 = 该板块有该页面；去勾后左侧菜单不渲染、直连 URL 也进不来 */
  {
    path: '/perm/page',
    name: 'PermPage',
    component: () => import('@/perm/views/PageManage.vue'),
    meta: { title: '页面管理', module: 'perm', menuKey: 'page' },
  },
  {
    path: '/perm/log',
    name: 'PermLog',
    component: () => import('@/perm/views/LogQuery.vue'),
    meta: { title: '操作日志', module: 'perm', menuKey: 'log' },
  },

  /* ============ 实训：考试管理 + 成绩管理 ============ */{
    path: '/exam/:id/summary',
    name: 'ExamSummary',
    component: () => import('@/views/ExamSummary.vue'),
    meta: { title: '成绩汇总', pageCode: 'job:examSummary:view' },
  },

  /* ============ 实训：班级信息管理 + 出勤管理 ============ */{
    path: '/class/:id/students',
    name: 'ClassStudentList',
    component: () => import('@/views/ClassStudentList.vue'),
    meta: { title: '班级花名册', pageCode: 'job:classStudent:view' },
  },

  /*
   * 2026-10-19 批注：删除独立「班级交接」页面（原 /class-transfer）。
   * 交接入口在「班级管理」操作列的【交接】，这里只给老书签留一个跳转，
   * 避免用户点到历史链接时白屏。
   */
  {
    path: '/class-transfer',
    redirect: '/teaching/class',
  },
  {
    path: '/transfer',
    redirect: '/teaching/class',
  },

  /* ============ 实训：未开发模块（占位页 + 权限受控） ============ */
  {
    path: '/fee-call',
    name: 'FeeCall',
    component: () => import('@/views/FeeCallList.vue'),
    meta: { title: '催费管理', pageCode: 'job:feeCall:view' },
  },/* ============ 就业阶段 ============ */
  {
    path: '/employment-log',
    name: 'EmploymentLog',
    component: () => import('@/views/EmploymentLog.vue'),
    meta: { title: '就业日志', pageCode: 'job:employmentLog:view' },
  },
  {
    path: '/review-write',
    name: 'ReviewWrite',
    component: () => import('@/views/ReviewWrite.vue'),
    meta: { title: '复盘填写', pageCode: 'job:review:view' },
  },
  {
    path: '/statistics',
    name: 'Statistics',
    component: () => import('@/views/Statistics.vue'),
    meta: { title: '数据统计', pageCode: 'job:statistics:view' },
  },
  /* ★ P7 下线（2026-10-19）：archive/BasicInfo 与 archive/DormAssign 已被
     teaching 域 TeachingStudent / TeachingDorm 完全覆盖（数据同源 t_uni_student / t_uni_dorm_*），
     页面文件与 api/empDorm.ts 已删除。复盘信息/就业记录（archive/ReviewInfo、EmploymentRecord）
     无新对应，保留——见统一表归一-剩余任务清单.md §7.1。 */
  {
    path: '/archive/review-info',
    name: 'EmpArchiveReview',
    component: () => import('@/views/archive/ReviewInfo.vue'),
    meta: { title: '复盘信息', pageCode: 'job:empArchive:view' },
  },
  {
    path: '/archive/employment-record',
    name: 'EmpArchiveEmployment',
    component: () => import('@/views/archive/EmploymentRecord.vue'),
    meta: { title: '就业日志记录', pageCode: 'job:empArchive:view' },
  },

  /* ============ 教务管理 ============ */
  {
    path: '/edu/student',
    name: 'EduStudentList',
    component: () => import('@/views/edu/StudentList.vue'),
    meta: { title: '学生档案', pageCode: 'edu:student:view' },
  },
  {
    path: '/edu/dorm',
    name: 'EduDorm',
    component: () => import('@/views/edu/DormList.vue'),
    meta: { title: '宿舍管理', pageCode: 'edu:dorm:view' },
  },
  {
    path: '/edu/fee',
    name: 'EduFee',
    component: () => import('@/views/edu/PaymentList.vue'),
    meta: { title: '缴费管理', pageCode: 'edu:fee:view' },
  },

  /* ============ 班级管理（大学部） ============ */{
    path: '/class/consult',
    name: 'ClassConsult',
    component: () => import('@/class/views/Consult.vue'),
    meta: { title: '待接收学员', pageCode: 'class:consult:view' },
  },{
    path: '/class/urge',
    name: 'ClassUrge',
    component: () => import('@/class/views/Urge.vue'),
    meta: { title: '催费管理', pageCode: 'class:urge:view' },
  },/* ============ 教学管理（初高）★ 2026-10-05 并入 ============
   *
   * 与上面的「班级管理（大学部）」是两套模块：
   *   大学部 /class/*（库 sms_class）  ← 已存在
   *   初高部 /class-jh/*（库 sms_class_jh） ← 本次并入
   *
   * ⚠️ 路由前缀必须和权限码分组一一对应：
   *    pageCode 用 classjh:*（清单见后端 config/pagePermissions.ts）
   *    接口前缀 /api/class-jh/*（本模块 api 层已改好）
   */
  /* ★ 2026-10-16 工作台迁到系统首页（/）：
   *   原 /class-jh/dashboard（初高工作台页）整体上移为首页工作台，
   *   这里留重定向 —— 老书签 / 侧栏老入口不失效。原页面权限码
   *   classjh:dashboard:view 保留在 pagePermissions/pageRegistry 里，
   *   现在用来控制「首页工作台是否显示初高 KPI 块」。 */
  { path: '/class-jh/dashboard', redirect: '/' },
  {
    path: '/class-jh/fee',
    name: 'ClassJhFee',
    component: () => import('@/class-jh/views/FeeList.vue'),
    meta: { title: '催费管理', pageCode: 'classjh:fee:view' },
  },{
    path: '/class-jh/setting',
    name: 'ClassJhSetting',
    component: () => import('@/class-jh/views/SettingList.vue'),
    meta: { title: '系统设置', pageCode: 'classjh:setting:view' },
  },
  {
    /**
     * ★ 2026-10-20 楼栋设置独立页
     *
     * 从「系统设置」里把楼栋页签抽出来，单独一个权限码 ——
     * 教务老师只拿 `classjh:building:view`，不会连带看到系统设置 KV /
     * 阶段字典 / 操作日志（那三个仍归 `classjh:setting:view`）。
     */
    path: '/class-jh/building',
    name: 'ClassJhBuilding',
    component: () => import('@/class-jh/views/BuildingList.vue'),
    meta: { title: '楼栋设置', pageCode: 'classjh:building:view' },
  },
  // 进模块根路径 → 落到系统首页工作台（★ 2026-10-16 工作台已迁到 /）
  { path: '/class-jh', redirect: '/' },

  /* ============ ★ 教学管理 · 合并入口（第 1 期）============
   *   每个业务域一个入口，页面顶部是「初高 / 大学 / 实训 / 就业 / 教务」学段页签。
   *   ⚠️ 这些路由**故意不挂 meta.pageCode / module** —— 入口本身不是"一个页面权限"，
   *      能不能进由页签层决定（teaching/access.ts 按各学段原 pageCode 判），
   *      进去后没有可用学段则显示空状态。真正的数据拦截仍在后端 requirePage。
   *   ⚠️ 原路由（/exam、/class/exam、/class-jh/exam …）一个都没删，仍可直连。 */
  ...teachingRoutes,

  /* ============ 兜底 ============ */
  {
    path: '/:pathMatch(.*)*',
    name: 'NotFound',
    component: () => import('@/views/Placeholder.vue'),
    meta: { title: '页面不存在' },
  },
];

const router = createRouter({
  history: createWebHashHistory(),
  routes,
});

/* ============================================================
 * 权限守卫（合并版）
 * ============================================================ */
router.beforeEach(async (to) => {
  // 0. 公开页（登录页）直接放行
  if (to.meta?.public) return true;

  // 1. 没 token → 去统一登录页
  const token = localStorage.getItem('sms_token');
  if (!token) {
    return { path: '/login', query: { redirect: to.fullPath } };
  }

  // 2. 拉门户身份 + 各模块 store（一次性）
  await ensurePortalProfile();
  await ensureModuleStores();

  // 2.5 就业/教务/班级的页面权限：只要已登录就拉一次
  //     （左侧菜单过滤、顶部栏「N 个页面权限」都依赖它；
  //       放在这里统一加载，避免落在模块页时永远不加载 → 顶栏恒显示 0）
  if (!permissionLoaded.value) await loadMyPermissions();

  // 2.6 ★ 2026-10-06 板块页面台账（权限管理 → 页面管理）
  //
  // 【为什么放在最前面、只写一次】
  //   台账说「这个板块有没有这个页面」。它同时影响两类页面：
  //     · 新模块（咨询/财务/权限）→ 走下面 step 4 的 module 分支
  //     · legacy（就业/教务/班级/初高）→ 走下面 step 5 的 pageCode 分支
  //   在两个分支里各写一遍容易漏一个，所以统一在这里拦一道；
  //   App.vue 的左侧菜单用同一个判据 pageEnabled() 过滤，两边口径完全一致。
  //
  // 【拉不到就不拦】store/pageConfig 里的 pageEnabled() 在台账接口失败时恒返回 true，
  //   保证「台账挂了」不会把整个系统搞成没有页面。
  await ensurePageConfig();
  if (!pageEnabled(to.path)) {
    const firstAllowed = myPages.value.find((p) => {
      if (p.path.includes('/:')) return false;
      const m = moduleOfPageCode(p.code);
      return (!m || moduleAllowed(m)) && pageEnabled(p.path);
    });
    const fallback = firstEnabledPortalPath() || (firstAllowed ? firstAllowed.path : '');
    if (fallback && fallback !== to.path) return { path: fallback };
    return { path: '/no-permission', query: { from: to.fullPath } };
  }

  // 3. 首页 → 工作台
  //    ★ 2026-10-16 起 / 本身就是工作台页（每个角色登录后第一个页面），
  //    原「跳到第一个有权限页面」的逻辑整体移除；无 pageCode 的路由
  //    在下方 step 5 里天然放行。

  // 4. 新模块页（市场咨询/财务/权限）：按门户 visibleModules 判定
  const mod = to.meta?.module as string | undefined;
  if (mod) {
    const menuKey = to.meta?.menuKey as string | undefined;
    if (!moduleAllowed(mod) || !menuAllowed(mod, menuKey)) {
      const fallback = portalLandingPath();
      if (fallback && fallback !== to.path) return { path: fallback };
      return { path: '/no-permission', query: { from: to.fullPath } };
    }
    return true;
  }

  // 5. 就业/教务/班级/初高：沿用 meta.pageCode + hasPage()
  const pageCode = to.meta?.pageCode as string | undefined;
  if (!pageCode) return true; // 无 pageCode = 占位/无权限/兜底页

  // ★ 2026-10-05 两套班级模块隔离（大学部 class / 初高 class-jh）
  //   这两套模块共用角色码，一个大学部班主任的 myPages 里同时含 class:* 与
  //   classjh:* —— 只判 hasPage 的话，直接输 URL 就能进另一套模块的页面。
  //
  // ★ 2026-10-06 扩展到全部 4 个 legacy 模块（job / edu / class / class-jh）：
  //   根因同源 —— 门户 modules 是模块级权威，但这里只校了两套班级模块，
  //   于是「门户只授权 perm、权限库里却是系统管理员角色」的账号（linx）
  //   直连 /class、/edu/student 照样能进。
  //   现在统一走 pageModuleAllowed()，一处映射、两处（App.vue 菜单 + 本守卫）共用。
  //   ★ 2026-10-19：共用页（待接收学员）允许任一相关模块放行。
  if (!pageModuleAllowed(pageCode)) {
    // 落到「当前账号有权限的任意一个页面」，避免把他甩进死循环
    const firstAllowed = myPages.value.find((p) => {
      if (p.path.includes('/:')) return false;
      const m = moduleOfPageCode(p.code);
      return !m || moduleAllowed(m);
    });
    const fallback = portalLandingPath() || (firstAllowed ? firstAllowed.path : '');
    if (fallback && fallback !== to.path) return { path: fallback };
    return { path: '/no-permission', query: { from: to.fullPath } };
  }

  if (!hasPage(to.path)) {
    return { path: '/no-permission', query: { from: to.fullPath } };
  }
  return true;
});

export default router;
