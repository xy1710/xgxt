/**
 * 左侧菜单配置 —— ★ 第 1 期「入口合并」版
 * ============================================================
 *
 * 【本次改了什么】
 *   合并前：4 个顶级分组、38 个菜单项 —— 就业管理(14) / 教务管理(3) /
 *           班级管理(10) / 教学管理（初高）(11)。
 *           其中 31 项落在 9 个**重复业务域**上（考试、成绩、出勤、宿舍、
 *           退费、催费、审批、班级、学生档案 各重复 3~4 次）。
 *
 *   合并后：**1 个顶级分组、16 个菜单项**。
 *           重复业务域各留 **1 个入口**（挂在 /teaching/<域>），进去顶部是
 *           「初高 / 大学 / 实训 / 就业 / 教务」**学段页签**，切页签即切换实现。
 *
 * 【合并不是删页面 —— 原页面一个都没动】
 *   9 个合并入口的 `stages` 指向的仍是**各学段的原路由与原页面组件**
 *   （见 `@/teaching/domainConfig.ts`）。所以：
 *     · 业务逻辑（成绩公式、审批链、出勤口径）**零改动**，不存在功能回退；
 *     · 权限沿用原 pageCode，用户可见范围**完全不变**；
 *     · 老路由仍可直连（/exam、/class/exam、/class-jh/exam …）。
 *
 * 【字段说明】
 *   path     路由地址（必填）
 *   stages   ★ 本次新增：本菜单聚合的各学段原页面。**有它时菜单显隐按
 *            「任一学段可访问」判定**（见 App.vue 的 jobGroups）。
 *   pageCode 页面权限码（单项菜单必填；聚合菜单不填，由 stages 各自判）
 *   phase    菜单右侧小标签（聚合项统一显示「合并」）
 *
 * ⚠️ 改动约定：
 *   - 新增菜单 → 改这里 + 在 router/index.ts 注册路由 + 在 pagePermissions.ts 登记权限
 *   - 顶级分组 title 不能重名（el-sub-menu 的 index 就是 title）
 */

import { TEACHING_DOMAINS } from '@/teaching/domainConfig';

export interface MenuStageRef {
  stage: string;
  path: string;
  pageCode?: string;
}

export interface MenuNode {
  path?: string;
  title: string;
  icon?: string;
  owner?: string;
  stage?: string;
  /** 业务阶段 / 分组标签（菜单里渲染成小标签） */
  phase?: string;
  desc?: string;
  /** 页面权限码，如 'job:exam:view'；有权限才显示这个菜单 */
  pageCode?: string;
  /** ★ 第 1 期：聚合菜单的各学段原页面（有它就按「任一学段可访问」显隐） */
  stages?: MenuStageRef[];
  /**
   * ★★ 2026-10-12 修「合并域菜单集体消失」：对应的 `STAGE_ACCESS` 业务域 key
   *
   * 【为什么必须有这个字段 —— 一句话：`stages` 已被第 2 期清空，菜单只能靠它判】
   *   App.vue 菜单显隐原本是二选一：
   *     if (stages?.length) → anyStageAccessible(stages)   ← 合并域走这条
   *     else                 → hasPage(path)              ← 合并域实际走了这条（错）
   *   第 2 期做「真正统一页面」时把 8 个域的 `stages` 清空、改用 `unified` 组件，
   *   但菜单判定没跟着改 → 落到 `hasPage('/teaching/exam')`
   *   → 而后端 `/api/job/auth/my-pages` 下发的 40 个页面里 `/teaching/*` **一条都没有**
   *   → 8 个合并域菜单被**静默过滤**（不报错、权限码也在，就是不显示）。
   *
   * 【为什么不能用 `path` 判权】
   *   `STAGE_ACCESS` 里 19 条旧路由已按第 3 期 D2 物理删除（path 全是 null），
   *   那里只能靠**权限码**判 —— 而权限码与后端各域 `requireAnyPage()` 同源，
   *   前后端口径天然一致。
   */
  stageDomain?: string;
  children?: MenuNode[];
}

/** 把「教学管理」业务域配置转成菜单节点（避免两处维护、改一处漏一处） */
function domainNode(key: string): MenuNode {
  const d = TEACHING_DOMAINS.find((x) => x.key === key);
  if (!d) {
    // 配置写错 key 时给一个可见的兜底，而不是静默少一个菜单
    return { title: `[缺失业务域 ${key}]`, path: '/coming' };
  }
  return {
    title: d.title,
    path: `/teaching/${d.key}`,
    icon: d.icon,
    phase: '合并',
    desc: d.desc,
    // ★★ 2026-10-12：合并域的菜单显隐改走「业务域 key」（见 MenuNode.stageDomain 注释）。
    //   ★ 注意命名对齐：TEACHING_DOMAINS 里叫 `approval`（休学/退学审批），
    //     而 STAGE_ACCESS 里叫 `leave` —— 两处命名本来就不同源，
    //     这里显式映射，不靠「名字刚好一样」蒙对。
    stageDomain: DOMAIN_TO_STAGE_DOMAIN[d.key] ?? null,
    // ★ 第 3 期 D2：已合并的八域不再有 stages（stages 改成可选），
    //   这里给空数组兜底 —— 菜单项本身只靠 title/icon/path 渲染，不依赖 stages。
    stages: (d.stages ?? []).map((s) => ({ stage: s.stage, path: s.path, pageCode: s.pageCode })),
  };
}

/**
 * TEACHING_DOMAINS.key → STAGE_ACCESS 的域 key
 *
 * 【为什么不直接用同名】实测两处命名只有 8 个域里 7 个相同：
 *   domainConfig.ts: student class attendance exam score dorm fee refund approval
 *   access.ts:        student class attendance exam score dorm fee refund leave
 *   → `approval` ↔ `leave` 命名不同源；其余同名
 *
 * ★ 2026-10-20 合并 meng 后：fee 域也改成 unified（催费 / 缴费 两页签），
 *   access.ts 里已补 fee 项，因此 fee 不再是「没有对应项」的特例。
 *
 * ★ 缺项一律映射成 null：菜单判定会退回 `hasPage(path)` 老逻辑，
 *   行为与修复前完全一致（宁可少显示，不可错误显示）。
 */
const DOMAIN_TO_STAGE_DOMAIN: Record<string, string> = {
  student: 'student',
  class: 'class',
  attendance: 'attendance',
  exam: 'exam',
  score: 'score',
  dorm: 'dorm',
  // ★ 2026-10-19：fee 域改 unified 后不再有 stages，菜单显隐改走业务域权限码
  //   （与其它八域同款；不映射会退回 hasPage('/teaching/fee')，后端页面清单里
  //   没有 /teaching/* → 菜单被静默过滤，即「催费/缴费菜单消失」的根因）
  fee: 'fee',
  refund: 'refund',
  approval: 'leave',
};

/** 唯一的顶级分组：教学管理（初高 / 大学 / 实训 / 就业 / 教务 全学段） */
export const MENU: MenuNode[] = [
  {
    title: '教学管理',
    icon: 'School',
    owner: '初高中部 / 大学部 / 实训就业',
    stage: '已完成',
    children: [
      /* ---------- 各学段独有（不参与合并） ----------
       * ★ 2026-10-16 原「工作台」菜单项已上移为系统首页
       *   （侧栏置顶项，见 config/sideMenu.ts 的 WORKBENCH_GROUP；
       *   页面本体迁到 views/Workbench.vue，/class-jh/dashboard 老路由重定向到首页）。
       *   首页工作台的初高 KPI 块仍用 classjh:dashboard:view 权限码判显隐。 */

      /* ---------- 9 个合并业务域 ---------- */
      domainNode('student'),
      domainNode('class'),

      /*
       * 2026-10-19 批注：删除左侧「班级交接」独立菜单（原 /class-transfer）。
       * 交接功能本身保留 —— 入口在「班级管理」操作列的【交接】按钮，
       * 交接记录在班级详情抽屉里；后端 /api/job/class-transfer 接口未动。
       */

      {
        title: '待接收学员',
        path: '/class/consult',
        pageCode: 'class:consult:view',
        // ★ 2026-10-19：初高也走「推送 → 班主任接收」，这一页两个学段共用
        owner: '初高中部 / 大学部',
        stage: '已完成',
        phase: '初高部 / 大学部',
        desc: '咨询端推来的待接收学员：接收 / 拒绝（初高、大学共用）。',
      },

      domainNode('attendance'),
      domainNode('exam'),
      domainNode('score'),
      domainNode('dorm'),

      domainNode('fee'),
      domainNode('refund'),
      domainNode('approval'),

      /* ---------- 就业阶段独有（不参与合并） ---------- */
      {
        title: '就业日志',
        path: '/employment-log',
        pageCode: 'job:employmentLog:view',
        owner: '就业',
        stage: '已完成',
        phase: '就业',
        desc: '记录每个学生的简历投递、面试邀约、面试场次、面试公司与结果。',
      },
      {
        title: '复盘填写',
        path: '/review-write',
        pageCode: 'job:review:view',
        owner: '就业',
        stage: '已完成',
        phase: '就业',
        desc: '面试复盘：面试结论 + 复盘结论 + 录音上传；「已发 offer」时复盘结论锁为「已签约入职」。',
      },
      {
        title: '数据统计',
        path: '/statistics',
        pageCode: 'job:statistics:view',
        owner: '就业',
        stage: '已完成',
        phase: '就业',
        desc: '就业率 / offer 数 / 人均投递 + KPI 目标达成；月度趋势与部门、班级分布。',
      },

      /* ---------- 初高独有 ---------- */
      {
        title: '系统设置',
        path: '/class-jh/setting',
        pageCode: 'classjh:setting:view',
        owner: '初高中部',
        stage: '已完成',
        phase: '初高部',
        desc: '出勤达标线与统计口径、催费提醒天数、封班可转入类型、阶段方案（方案名称+所属部门+多阶段）。',
      },
      {
        /**
         * ★ 2026-10-20 楼栋设置独立入口
         *
         * 从「系统设置」的楼栋页签抽出来单独成页，权限码 `classjh:building:view`。
         * 目的：只给教务老师楼栋字典，不连带放开系统设置 KV / 阶段字典 / 操作日志。
         */
        title: '楼栋设置',
        path: '/class-jh/building',
        pageCode: 'classjh:building:view',
        owner: '初高中部',
        stage: '已完成',
        phase: '初高',
        desc: '宿舍楼栋字典（男寝 / 女寝），与宿舍管理、分派宿舍的楼栋下拉实时一致。',
      },
    ],
  },
];

/* ============================================================
 * 工具函数
 * ============================================================ */

/** 拍平菜单树，得到全部菜单节点的数组 */
export function flattenMenu(nodes: MenuNode[] = MENU): MenuNode[] {
  const out: MenuNode[] = [];
  const walk = (list: MenuNode[]) => {
    for (const n of list) {
      out.push(n);
      if (n.children?.length) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/**
 * 按路由路径反查菜单节点
 * 注意：多个菜单共用 /coming 时，靠 query.title 区分
 */
export function findMenuNode(path: string, title?: string): MenuNode | undefined {
  const all = flattenMenu();
  if (title) {
    const byTitle = all.find((n) => n.title === title);
    if (byTitle) return byTitle;
  }
  return all.find((n) => n.path === path && !n.children);
}
