/**
 * ★ 第 1 期「入口合并」核心配置 —— 业务域 → 各学段页面 映射表
 * ============================================================
 *
 * 【它解决什么问题】
 *   合并前：初高 / 大学 / 实训 三个学段各有一套「考试管理」，左侧菜单
 *          因此出现 3 个「考试管理」（4 组 38 项，其中 31 项是重复的）。
 *   合并后：一个「考试管理」菜单 → 进去顶部是「初高 / 大学 / 实训」学段页签，
 *          切页签 = 挂载对应学段的**原页面组件**。
 *
 * 【设计原则（第 1 期：零数据改动、零后端改动）】
 *   ① **不复制页面代码**：直接懒加载各学段**原有的 vue 组件**。
 *      所以三个学段的业务逻辑（成绩公式、审批链、出勤口径…）**一行都没改**，
 *      差异是"原样保留"的，不存在功能回退风险。
 *   ② **权限复用原页面权限码**：每个学段页签带自己的 `pageCode`（如 classjh:exam:view），
 *      菜单显隐 / 页签显隐都按原口径判 —— 用户可见范围**完全不变**。
 *   ③ **原路由全部保留**：老的 /exam、/class/exam、/class-jh/exam 都还能直连，
 *      只是左侧菜单不再重复列它们（改由 /teaching/* 统一入口）。
 *
 * 【第 2 期会做什么】
 *   把这些"原样挂载"的组件，逐个换成**真正统一的组件**（表格/弹窗共用骨架 +
 *   差异走配置）。到那时这里 `comp` 才会指向统一组件，本文件就是替换清单。
 */

import { defineAsyncComponent, type Component } from 'vue';

/** 一个学段在这个业务域里的页面 */
export interface StagePage {
  /** 页签显示名 */
  stage: string;
  /** 原路由路径（也是权限判定用的路径） */
  path: string;
  /** 原页面权限码 */
  pageCode: string;
  /** 懒加载的原页面组件 */
  comp: Component;
  /** 这个学段与其它学段的**口径差异**（给使用者提示，不是警告） */
  note?: string;
}

/** 一个业务域（= 合并后的一个菜单项） */
export interface TeachingDomainDef {
  /** 业务域 key，用于拼 /teaching/<key> 路由 */
  key: string;
  /** 菜单显示名 */
  title: string;
  /** 菜单图标（Element Plus 图标名） */
  icon: string;
  /** 一句话说明 */
  desc: string;
  /**
   * 各学段页面（按初高 → 大学 → 实训 → 就业 → 教务 的稳定顺序）
   *
   * ★★ 第 3 期 D2（2026-10-09）：**改成可选**
   *   原注释写的是「即使已 merged 也要保留 stages」——
   *   那个前提在 D2 之后已经不成立了，原因是阶段 A 把学段判权
   *   从 `hasPage(旧路由)` 改成了 `hasPerm(权限码)`，
   *   统一页不再依赖旧路由，于是**旧页面连同它的路由可以一起下线**。
   *
   *   现在的规则：
   *   · 有 `unified` 的域（八域）→ **不再需要 stages**，已清空
   *   · 没有 `unified` 的域（目前只剩催费 fee）→ **必须保留 stages**，
   *     否则那个域会变成空白页（页签模式靠 stages 出页签）
   *
   *   ⚠️ 兜底仍在：`TeachingDomain.vue` 里 stages 为空时会退回
   *      权限码判权（stageVisible），所以老配置彻底删干净也不会让用户看不到页面。
   */
  stages?: StagePage[];
  /**
   * ★ 第 2 期：这个域是否已经合并成「统一页面」
   *
   *   有值 → 页面直接渲染这个组件（**不再显示学段页签**，
   *           因为里面已经是一套代码 + 学段筛选器了）；
   *   无值 → 走第 1 期的页签模式（一个入口 + 各学段原页面）。
   *
   *   这样第 2 期可以**一个域一个域地切换**：改完哪个域就给哪个域加上 unified，
   *   没改完的域继续用页签兜着，永远不会出现"改一半用不了"。
   */
  unified?: Component;
}

/* ============================================================
 * 9 个合并业务域
 * ============================================================ */

export const TEACHING_DOMAINS: TeachingDomainDef[] = [
  /* ---------------- 1. 学生档案 / 花名册 ---------------- */
  {
    key: 'student',
    title: '学生档案',
    icon: 'User',
    desc: '学生主档与花名册：各来源（初高部 / 大学部 / 就业 / 教务）合并成一个页面，「全部」按学号去重。',
    // ★ 第 2 期：已合并成一套（四个学段 + 学号去重 + 学段筛选）
    unified: defineAsyncComponent(() => import('@/teaching/views/TeachingStudent.vue')),
  },

  /* ---------------- 2. 班级管理 ---------------- */
  {
    key: 'class',
    title: '班级管理',
    icon: 'UserFilled',
    desc: '班级主档与生命周期：建班、封班、阶段推进、师资分配。',
    /**
     * ★ 第 2 期已合并（第七个落地的业务域）
     *
     *   stages 里三个原页面**仍然保留**（权限判定与回退依据），但不再渲染。
     *
     *   【本域学段差异 —— 前端靠 /meta 下发的标志位自动显隐，不写死学段判断】
     *     · 班级编号：只有实训有（另两个学段那两张表根本没这列）
     *     · 结业日期：只有实训有
     *     · 出勤率：初高是「今日」，大学/实训是「累计」→ 列头要跟着变
     *     · 交棒岗位（项目经理/就业老师）：初高没有
     *     · 备注：大学那张表没有 remark 列
     *   ✅ 班级状态码三套完全一致（1开放/2封班/3待结业/4已结业），无需映射表
     */
    unified: defineAsyncComponent(() => import('@/teaching/views/TeachingClass.vue')),
  },

  /* ---------------- 3. 出勤管理 ---------------- */
  {
    key: 'attendance',
    title: '出勤管理',
    icon: 'Calendar',
    desc: '各部门出勤登记与统计。',
    /**
     * ★★ 第 2 期已合并（第一个落地的业务域）
     *
     *   下面 stages 里的三个页面**仍然保留**（它们是权限判定与回退的依据），
     *   但页面不再渲染它们 —— 改渲染统一页面：
     *     一个页面 + 学段筛选器 + 一套接口（/api/teaching/attendance/*）。
     *
     *   老路由 /class-jh/attendance、/class/attendance、/attendance 一个都没删，
     *   观察期内仍可直连，这就是"随时可回退"。
     */
    unified: defineAsyncComponent(() => import('@/teaching/views/TeachingAttendance.vue')),
  },

  /* ---------------- 4. 考试管理 ---------------- */
  {
    key: 'exam',
    title: '考试管理',
    icon: 'Document',
    desc: '各部门考试排期与成绩表管理。',
    /** ★ 第 2 期已合并（第二个业务域）—— stages 保留作权限判定与回退 */
    unified: defineAsyncComponent(() => import('@/teaching/views/TeachingExam.vue')),
  },

  /* ---------------- 5. 成绩管理 ---------------- */
  {
    key: 'score',
    title: '成绩管理',
    icon: 'DataLine',
    desc: '各部门成绩录入与统计。',
    /** ★ 第 2 期已合并（第三个业务域）—— 列由后端成绩公式配置驱动 */
    unified: defineAsyncComponent(() => import('@/teaching/views/TeachingScore.vue')),
  },

  /* ---------------- 6. 宿舍管理 ---------------- */
  {
    key: 'dorm',
    title: '宿舍管理',
    icon: 'House',
    desc: '各部门宿舍分派、调换与退宿。合并前这里有 4 套重复页面。',
    unified: defineAsyncComponent(() => import('@/teaching/views/TeachingDorm.vue')),
  },

  /* ---------------- 7. 催费 ---------------- */
  {
    key: 'fee',
    title: '催费',
    icon: 'Money',
    desc: '各部门费用催办与缴费台账。',
    // ★ 2026-10-19 域重组（用户要求）：原四部门页签（初高部 / 大学部 / 实训 / 教务）收成两页——
    //   「催费」= 原「初高部」缴费台账页（FeeList）改名，功能一行没动；
    //   第二页 = 教务缴费总记录（PaymentList 原样）。页签显隐沿用原权限码（见 access.ts fee 域）。
    // ★ 2026-10-20 用户要求：第二页（教务缴费总记录）整页删除。
    //   于是本域只剩一页 → 菜单名从「催费 / 缴费」改回「催费」，TeachingFeeHub 里的 el-tabs 一并去掉。
    //   ⚠️ 菜单名被 App.vue 的催费红点按**精确标题**匹配，改名必须同步那里（已改）。
    //   老页面 / 老路由（/class-jh/fee、/class/urge、/fee-call、/edu/fee）未删，可回退。
    //   ★ 2026-10-20 合并 main：main 侧对这段只做了「学段 → 部门」改名（标签 初高部 / 大学部），
    //     页签结构以本次重组为准，故不再保留 stages 四页签。
    unified: defineAsyncComponent(() => import('@/teaching/views/TeachingFeeHub.vue')),
  },

  /* ---------------- 8. 退费 ---------------- */
  {
    key: 'refund',
    title: '退费',
    icon: 'RefreshLeft',
    desc: '★ 审批链三部门统一（实训那套）：学管 → 校长 → 通知财务出款。',
    /** ★ 第 2 期已合并（第四个业务域）—— stages 保留作权限判定与回退 */
    unified: defineAsyncComponent(() => import('@/teaching/views/TeachingRefund.vue')),
  },

  /* ---------------- 9. 休学 / 退学 / 复学审批 ---------------- */
  {
    key: 'approval',
    title: '休学 / 退学审批',
    icon: 'Stamp',
    desc: '★ 审批链三部门统一（实训那套）：休学/复学 1 步，退学 2 步（学管→校长）。',
    /** ★ 第 2 期已合并（第五个业务域）—— stages 保留作权限判定与回退 */
    unified: defineAsyncComponent(() => import('@/teaching/views/TeachingLeave.vue')),
  },
];

/* ============================================================
 * 工具函数
 * ============================================================ */

/** 按 key 找业务域 */
export function findTeachingDomain(key?: string): TeachingDomainDef | undefined {
  if (!key) return undefined;
  return TEACHING_DOMAINS.find((d) => d.key === key);
}

/**
 * 原路由路径 → 合并后的菜单路径
 * （用于：菜单高亮 —— 用户直连 /exam 时，左侧要亮在「考试管理」上）
 *
 * ★ 第 3 期 D2：只还有 `stages` 的域才进这个表
 *   （八域已合并、stages 已清空 → 它们的旧路由也一并下线了，
 *     所以这条映射对它们不再需要）。
 *   保留 `?? []` 是为了「未合并的域」（如催费）仍能正常高亮。
 */
export const LEGACY_TO_TEACHING: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const d of TEACHING_DOMAINS) {
    for (const s of d.stages ?? []) map[s.path] = `/teaching/${d.key}`;
  }
  return map;
})();

/**
 * 把任意路径归到所属的「教学管理」菜单项；找不到返回空串
 *
 * ⚠️ **只做精确匹配 + 两个白名单动态路由**，不能"逐级往上剥"：
 *    剥法会把 /class/consult（大学·待接收学员）剥成 /class
 *    → 误判成「实训·班级信息管理」→ 左侧菜单亮错项。
 *    （本项目 /class 下同时住着大学部与实训两套页面，这是历史遗留的路径重叠。）
 */
export function matchTeachingPath(path: string): string {
  if (!path) return '';
  if (path.startsWith('/teaching/')) return path;
  // ① 精确命中某个学段页面
  if (LEGACY_TO_TEACHING[path]) return LEGACY_TO_TEACHING[path];
  // ② 两个非菜单的动态详情页，归到它的列表页
  //    /exam/:id/summary  → /exam
  //    /class/:id/students → /class
  if (path.startsWith('/exam/')) return LEGACY_TO_TEACHING['/exam'] || '';
  if (path.startsWith('/class/') && path.endsWith('/students')) {
    return LEGACY_TO_TEACHING['/class'] || '';
  }
  return '';
}
