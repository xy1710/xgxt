/**
 * 板块 → 页面 台账注册表（单一事实来源）
 *
 * ============================================================
 * 【这份表是什么】
 *   全系统「每个板块里有哪些页面」的清单，供两处使用：
 *     ① `scripts/seed-perm-pages.ts`（`npm run seed:perm-pages`）—— 建表/补数据时按它灌 `sms_perm.t_perm_page`
 *     ② 运行时兜底：`services/page.service.ts` 首次访问时按它补齐新增页面
 *   页面管理页（/perm/page）的勾选结果落在库里那一列 `enabled` 上，
 *   本文件只声明「有哪些页面可选」，不决定「开没开」。
 *
 * 【数据从哪来（改的时候两边一起改）】
 *   · 新模块 consult / finance / perm
 *       → `shared-types/src/portal/portal.ts` 的 `MODULES.menus`
 *   · 教学管理（原 legacy job / edu / class / class-jh 四板块合并）
 *       → `web-job/src/config/menu.ts` 的 `MENU`（path + pageCode）
 *       → `web-job/src/teaching/domainConfig.ts`（合并业务域的标题）
 *   · 路由真实性以 `web-job/src/router/index.ts` 为准
 *
 * ⚠️⚠️ 2026-10-20 用户要求：「按左侧菜单栏改写页面管理的内容」
 *   系统这一轮把 **就业管理 / 教务管理 / 班级管理（大学部）/ 教学管理（初高）
 *   四个板块合并成了一个「教学管理」**（侧栏只剩一个分组，15 项），
 *   并把「工作台」提为置顶单层菜单项。台账原来还是「7 板块 56 页」的老口径，
 *   与菜单对不上，本次按菜单重写为 **5 板块 34 页**：
 *
 *     | 板块     | 页数 | 来源                                    |
 *     |---------|-----|----------------------------------------|
 *     | 工作台   |  1  | 侧栏置顶单层项（'/'，locked 不可取消）      |
 *     | 市场咨询 |  5  | MODULES.consult                         |
 *     | 财务管理 |  6  | MODULES.finance（顺序按菜单：冻结在退费前）  |
 *     | 权限管理 |  7  | MODULES.perm                            |
 *     | 教学管理 | 15  | MENU（五学段合并后的 15 项）               |
 *
 *   合并后旧的 4 个板块 key（job / edu / class / class-jh）在台账里**不再出现**
 *   —— `syncRegistry()` 会把库里多出来的行逻辑删除（不物理删，可回滚）。
 *
 * 【★ 合并页面的权限码为什么要用 `pageCodes` 数组】
 *   合并前的「出勤管理」有三套页面、三个权限码（初高 / 大学 / 实训各一个），
 *   合并后只剩一页 `/teaching/attendance`，但**权限判定仍按学段**走
 *   （`web-job/src/teaching/access.ts` 的 STAGE_ACCESS）。
 *   所以一页要挂多个码，`pageCode` 单值装不下 → 用 `pageCodes: string[]`。
 *   职位页面默认值推导按「任一码命中即可见」算（见 rolePageDefaults.ts）。
 *
 * ⚠️ 不收录「已注册但无菜单入口的详情页」（成绩汇总 / 班级花名册 / 复盘信息 /
 *    就业日志记录 4 个）—— 它们是列表页点进去的子页，不是板块里的独立菜单，
 *    去勾后会让父页面点不动。它们跟着各自的父页面走。
 * ============================================================
 */

export interface RegistryPage {
  /** 页面 key：新模块 = menuKey；legacy 模块 = 权限码中段（与 menu.ts 的 pageCode 对应） */
  key: string;
  /** 页面标题（侧栏显示名） */
  title: string;
  /** 路由 path（台账的自然主键，全系统唯一） */
  path: string;
  /** 单权限码（老口径，仍保留给单学段页面用） */
  pageCode?: string;
  /**
   * 多权限码（★ 2026-10-20 合并板块用）
   *
   * 一个页面跨多个学段时，每个学段有自己的权限码，全列在这里；
   * 判定口径 = **任一命中即可见**（与前端 STAGE_ACCESS 的 anyStageAccessible 一致）。
   * 与 `pageCode` 同时存在时以本字段为准。
   */
  pageCodes?: string[];
  /** 锁定：不允许取消勾选（用于防止把自己锁在门外） */
  locked?: boolean;
  /** 一句话说明（页面管理列表的副标题） */
  remark?: string;
}

export interface RegistryBoard {
  /** 板块 key（= 门户模块 key；合并后的教学管理用 'teach'） */
  moduleKey: string;
  /** 板块名（页面管理左栏显示） */
  moduleName: string;
  /** 板块图标（emoji） */
  moduleIcon: string;
  /** 板块说明 */
  moduleDesc: string;
  /** 是否 legacy 模块（页面清单原本来自 config/menu.ts） */
  legacy: boolean;
  /** 板块排序 */
  sortNo: number;
  /** 页面明细（顺序 = 侧栏顺序） */
  pages: RegistryPage[];
}

/* ============================================================
 * 0. 工作台（★ 2026-10-20 新增：侧栏置顶单层菜单项）
 * ============================================================ */
const WORKBENCH: RegistryBoard = {
  moduleKey: 'workbench',
  moduleName: '工作台',
  moduleIcon: '🏠',
  moduleDesc: '系统首页 · 每个角色进门第一页',
  legacy: false,
  sortNo: 1,
  pages: [
    {
      key: 'dashboard',
      title: '工作台',
      path: '/',
      /* ⚠️ locked：这是全站首页，也是登录后的落地页。
       *   取消勾选等于把所有人关在门外（且没有任何入口能改回来）→ 锁死。 */
      locked: true,
      remark: '待办清单、KPI、快捷入口（全角色可见，不可取消）',
    },
  ],
};

/* ============================================================
 * 1. 市场咨询（原 01-王寒逸-consult · 8001）
 * ============================================================ */
const CONSULT: RegistryBoard = {
  moduleKey: 'consult',
  moduleName: '市场咨询',
  moduleIcon: '📣',
  moduleDesc: '学生 · 缴费 · 审批 · 退费 · 流失',
  legacy: false,
  sortNo: 2,
  pages: [
    { key: 'student', title: '学生管理', path: '/consult/student', remark: '咨询学生名单、跟进记录' },
    { key: 'fee', title: '收款与缴费', path: '/consult/fee', remark: '咨询端收款（学费 / 试学费）' },
    { key: 'approve', title: '审批中心', path: '/consult/approve', remark: '待办事项、审批流转' },
    { key: 'refund', title: '退费管理', path: '/consult/refund', remark: '退费申请与查看' },
    { key: 'loss', title: '流失记录', path: '/consult/loss', remark: '流失学生登记' },
  ],
};

/* ============================================================
 * 2. 财务管理（原 05-周铭-finance · 8005）
 * ============================================================ */
const FINANCE: RegistryBoard = {
  moduleKey: 'finance',
  moduleName: '财务管理',
  moduleIcon: '💰',
  moduleDesc: '概览 · 缴费 · 冻结 · 退费 · 账单 · 标准',
  legacy: false,
  sortNo: 3,
  pages: [
    // ⚠️ path 必须是 /finance/overview（真实路由），不是 portal.ts 里那个历史笔误 /finance
    { key: 'finance', title: '财务概览', path: '/finance/overview', remark: '收支总览、KPI' },
    { key: 'fee', title: '缴费管理', path: '/finance/fee', remark: '缴费总记录、到期预警、凭证 OCR' },
    /* ★ 2026-10-20：顺序按侧栏菜单改 —— 菜单里「冻结名单」在「退费管理」之前，
     *   台账原来反了（退费在前），页面管理里看到的顺序与菜单对不上。 */
    { key: 'freeze', title: '冻结名单', path: '/finance/freeze', remark: '批量冻结 / 解冻' },
    { key: 'refund', title: '退费管理', path: '/finance/refund', remark: '退费审批与执行' },
    { key: 'bill', title: '账单明细', path: '/finance/bill', remark: '逐笔账单流水' },
    { key: 'standard', title: '费用标准', path: '/finance/standard', remark: '各类型费用标准配置' },
  ],
};

/* ============================================================
 * 3. 权限管理（原 06-林晓-perm · 8006）
 * ============================================================ */
const PERM: RegistryBoard = {
  moduleKey: 'perm',
  moduleName: '权限管理',
  moduleIcon: '🔐',
  moduleDesc: '部门 · 职位 · 账号 · 授权 · 页面 · 日志',
  legacy: false,
  sortNo: 4,
  pages: [
    { key: 'overview', title: '权限总览', path: '/perm/overview', remark: '权限体系总览、最近操作动态' },
    { key: 'dept', title: '部门管理', path: '/perm/dept', remark: '组织架构 / 部门两级树' },
    { key: 'role', title: '职位管理', path: '/perm/role', remark: '14 个内置职位 + 自建职位' },
    { key: 'user', title: '账号管理', path: '/perm/user', remark: '全系统账号维护（唯一入口）' },
    { key: 'assign', title: '职位权限分配', path: '/perm/assign', remark: '职位 → 功能点/动作授权' },
    {
      key: 'page',
      title: '页面管理',
      path: '/perm/page',
      /* ★ 本页自己也在台账里 —— 但 locked=true：
       *   它是唯一能改台账的入口，去勾后会把自己锁死（谁都进不来、也没法再改回来）。 */
      locked: true,
      remark: '板块 → 页面 台账：打勾即该板块有此页面（本页不可取消）',
    },
    { key: 'log', title: '操作日志', path: '/perm/log', remark: '权限变更与操作留痕' },
  ],
};

/* ============================================================
 * 4. 教学管理（★ 2026-10-20 由 job / edu / class / class-jh 四板块合并）
 *
 *   侧栏现在只有一个「教学管理」分组，15 项（初高 / 大学 / 实训 / 就业 / 教务）。
 *   顺序 = `web-job/src/config/menu.ts` 的 MENU 顺序 = 用户截图里的菜单顺序。
 * ============================================================ */
const TEACH: RegistryBoard = {
  moduleKey: 'teach',
  moduleName: '教学管理',
  moduleIcon: '🎓',
  moduleDesc: '初高 · 大学 · 实训 · 就业 · 教务（五学段合一，15 页）',
  legacy: true,
  sortNo: 5,
  pages: [
    {
      key: 'student',
      title: '学生档案',
      path: '/teaching/student',
      pageCodes: ['classjh:student:view', 'class:student:view', 'job:empArchive:view', 'edu:student:view'],
      remark: '学生主档与花名册：四个学段合并一页，「全部」按学号去重',
    },
    {
      key: 'class',
      title: '班级管理',
      path: '/teaching/class',
      pageCodes: ['classjh:classInfo:view', 'class:info:view', 'job:class:view'],
      remark: '班级主档与生命周期：建班、封班、阶段推进、师资分配',
    },
    {
      key: 'classTransfer',
      title: '班级交接',
      path: '/class-transfer',
      pageCode: 'job:classTransfer:view',
      remark: '换班交接：整班换负责人（班主任/教员/助教），学生不动，留快照',
    },
    {
      key: 'consult',
      title: '待接收学员',
      path: '/class/consult',
      pageCode: 'class:consult:view',
      remark: '咨询端推来的待接收学员：接收 / 拒绝',
    },
    {
      key: 'attendance',
      title: '出勤管理',
      path: '/teaching/attendance',
      pageCodes: ['classjh:attendance:view', 'class:attendance:view', 'job:attendance:view'],
      remark: '各学段出勤登记与统计（一个页面 + 学段筛选）',
    },
    {
      key: 'exam',
      title: '考试管理',
      path: '/teaching/exam',
      pageCodes: ['classjh:exam:view', 'class:exam:view', 'job:exam:view'],
      remark: '各学段考试排期与成绩表管理',
    },
    {
      key: 'score',
      title: '成绩管理',
      path: '/teaching/score',
      pageCodes: ['classjh:score:view', 'class:grade:view', 'job:examScore:view'],
      remark: '各学段成绩录入与统计（列由后端成绩公式配置驱动）',
    },
    {
      key: 'dorm',
      title: '宿舍管理',
      path: '/teaching/dorm',
      pageCodes: ['classjh:dorm:view', 'class:dorm:view', 'job:dorm:view'],
      remark: '各学段宿舍分派、调换与退宿',
    },
    {
      key: 'fee',
      title: '催费 / 缴费',
      path: '/teaching/fee',
      pageCodes: ['classjh:fee:view', 'class:urge:view', 'job:feeCall:view', 'edu:fee:view'],
      remark: '各学段费用催办与缴费台账',
    },
    {
      key: 'refund',
      title: '退费',
      path: '/teaching/refund',
      pageCodes: ['classjh:refund:view', 'class:refund:view', 'job:refund:view'],
      remark: '审批链三学段统一（实训那套）：学管 → 校长 → 通知财务出款',
    },
    {
      key: 'approval',
      title: '休学 / 退学审批',
      path: '/teaching/approval',
      pageCodes: ['classjh:approval:view', 'class:suspend:view', 'job:suspendApproval:view'],
      remark: '休学/复学 1 步，退学 2 步（学管 → 校长）',
    },
    {
      key: 'employmentLog',
      title: '就业日志',
      path: '/employment-log',
      pageCode: 'job:employmentLog:view',
      remark: '简历投递、面试邀约、场次与结果',
    },
    {
      key: 'review',
      title: '复盘填写',
      path: '/review-write',
      pageCode: 'job:review:view',
      remark: '面试复盘 + 录音；已发 offer 锁定复盘结论',
    },
    {
      key: 'statistics',
      title: '数据统计',
      path: '/statistics',
      pageCode: 'job:statistics:view',
      remark: '就业率 / offer 数 / 人均投递 + KPI 达成',
    },
    {
      key: 'setting',
      title: '系统设置',
      path: '/class-jh/setting',
      pageCode: 'classjh:setting:view',
      remark: '出勤达标线、催费提醒天数、封班可转入类型等',
    },
    {
      key: 'building',
      title: '楼栋设置',
      path: '/class-jh/building',
      pageCode: 'classjh:building:view',
      remark: '宿舍楼栋字典，与宿舍管理楼栋下拉实时一致（可独立授权给教务）',
    },
  ],
};

/* ============================================================
 * 汇总
 * ============================================================ */

/** 全部板块（顺序 = 页面管理左栏顺序 = 侧栏板块顺序） */
export const PAGE_REGISTRY: RegistryBoard[] = [
  WORKBENCH,
  CONSULT,
  FINANCE,
  PERM,
  TEACH,
];

/** 全部页面总数（当前 5 板块 34 页） */
export const PAGE_REGISTRY_TOTAL = PAGE_REGISTRY.reduce((n, b) => n + b.pages.length, 0);

/** 拍平：全部页面的 path（用于「这个 path 有没有被台账管」的判定） */
export const ALL_REGISTRY_PATHS: string[] = PAGE_REGISTRY.flatMap((b) =>
  b.pages.map((p) => p.path),
);

/** 按 moduleKey 取板块 */
export function findRegistryBoard(moduleKey: string): RegistryBoard | undefined {
  return PAGE_REGISTRY.find((b) => b.moduleKey === moduleKey);
}

/**
 * 取一个页面挂的全部权限码（单码 / 多码统一入口）
 *
 * ★ 2026-10-20 新增：合并板块一页挂多学段码，判定处不要各写一遍 `pageCode || pageCodes`。
 */
export function pageCodesOf(p: RegistryPage): string[] {
  if (p.pageCodes?.length) return p.pageCodes;
  return p.pageCode ? [p.pageCode] : [];
}
