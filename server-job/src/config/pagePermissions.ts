/**
 * 页面权限清单（就业管理 > 实训阶段）
 *
 * ============================================================
 * 这是【本模块所有页面的权限定义】——权限管理的"货源清单"
 * ============================================================
 *
 * 【怎么用】
 *   1. 本清单 + 角色，决定「谁能看哪个页面」
 *   2. 权限管理模块（8006）会读这份清单，在界面上让人勾选
 *   3. 前端路由守卫：没权限的页面直接拦，菜单不显示
 *   4. 后端接口守卫：没权限的接口返回 403
 *
 * 【将来对接 8006】
 *   现在权限数据是【本地假数据】（pagePermissionSource.ts）。
 *   等 8006 就绪后，把这个清单注册给 8006，权限判定改成调 8006 的接口。
 *   本文件（清单）不用改，它描述的是"有哪些页面权限"，与数据来源无关。
 *
 * 【权限码规范】
 *   job:{模块}:{页面}      —— 页面访问权
 *   job:{模块}:{页面}:{操作} —— 按钮级操作权（本模块先用页面级）
 *
 * ⚠️ 命名要和 menu.ts 的 path 对得上，改一处要同步另一处
 */

/** 一条页面权限定义 */
export interface PagePermissionDef {
  /** 权限码，如 'job:exam:view' */
  code: string;
  /** 页面名（与菜单显示名一致） */
  name: string;
  /** 前端路由路径（与 menu.ts 的 path 一致） */
  path: string;
  /** 所属分组 */
  group: string;
  /** 说明 */
  desc: string;
}

/**
 * 本模块（就业管理-实训）的全部页面权限
 *
 * ⚠️ 新增页面时，必须在这里登记一条，否则权限管理看不到它
 */
export const PAGE_PERMISSIONS: PagePermissionDef[] = [
  {
    code: 'job:class:view',
    name: '班级信息管理',
    path: '/class',
    group: '实训管理',
    desc: '实训班级主档：建班、封班、结业、加减学生',
  },
  {
    code: 'job:classTransfer:view',
    name: '班级管理',
    path: '/class-transfer',
    group: '实训管理',
    desc: '换班交接：整个班换负责人，留存交接记录与快照',
  },
  {
    code: 'job:classStudent:view',
    name: '班级花名册',
    path: '/class/:id/students',
    group: '实训管理',
    desc: '查看某班的学生名单',
  },
  {
    code: 'job:attendance:view',
    name: '出勤管理',
    path: '/attendance',
    group: '实训管理',
    desc: '登记与查看班级出勤',
  },
  {
    code: 'job:examScore:view',
    name: '成绩管理',
    path: '/exam-score',
    group: '实训管理',
    desc: '录入卷面/机试/面试分数，标记末班',
  },
  {
    code: 'job:exam:view',
    name: '考试管理',
    path: '/exam',
    group: '实训管理',
    desc: '实训阶段考试排期与成绩表管理',
  },
  {
    code: 'job:examSummary:view',
    name: '成绩汇总',
    path: '/exam/:id/summary',
    group: '实训管理',
    desc: '查看某场考试的成绩汇总',
  },
  {
    code: 'job:feeCall:view',
    name: '催费管理',
    path: '/fee-call',
    group: '实训管理',
    desc: '实训阶段学费催缴：欠费名单、催缴记录、到账核销',
  },
  {
    code: 'job:refund:view',
    name: '退费',
    path: '/refund',
    group: '实训管理',
    desc: '实训阶段退费申请与审批',
  },
  {
    code: 'job:suspendApproval:view',
    name: '休学/退学审批',
    path: '/suspend-approval',
    group: '实训管理',
    desc: '班主任发起 → 学管审批（退学再走校长）；通过后改学生状态 + 花名册离班 + 通知财务',
  },
  {
    code: 'job:dorm:view',
    name: '宿舍管理',
    path: '/dorm',
    group: '实训管理',
    desc: '实训阶段宿舍分派与调换',
  },

  /* ============================================================
   * 就业阶段（齐晋霄）—— 2026-10-02 合并进来时登记
   *
   * ⚠️ 实训基地与就业基地不在同一地点，宿舍是【两套】：
   *    实训的走教务审批（job:dorm:view），就业的直接生效（job:empDorm:view）。
   * ============================================================ */
  {
    code: 'job:employmentLog:view',
    name: '就业日志',
    path: '/employment-log',
    group: '就业管理',
    desc: '记录每个学生的简历投递、面试邀约、面试场次与结果',
  },
  {
    code: 'job:review:view',
    name: '复盘填写',
    path: '/review-write',
    group: '就业管理',
    desc: '面试复盘：面试结论 + 复盘结论 + 录音；拿到 offer 自动发通知',
  },
  {
    code: 'job:statistics:view',
    name: '数据统计',
    path: '/statistics',
    group: '就业管理',
    desc: '就业率 / offer 数 / 人均投递 + KPI 目标达成与分布',
  },
  {
    code: 'job:empDorm:view',
    name: '就业基地宿舍',
    path: '/archive/dorm-assign',
    group: '就业管理',
    desc: '就业基地宿舍（与实训基地不在同一地点）：直接分配，不走审批',
  },
  {
    code: 'job:empArchive:view',
    name: '信息档案',
    path: '/archive/basic-info',
    group: '就业管理',
    desc: '就业阶段学生信息档案：基础信息 / 宿舍分配 / 复盘信息 / 就业日志记录',
  },

  /* ============================================================
   * 教务管理（李思雨/王咏菲）—— 2026-10-03 合并进来时登记
   *
   * ⚠️ 权限码用 edu: 前缀（与 job: 分开）。
   * ⚠️ 数据在【另一个库 sms_edu】，但对使用者无感 —— 一个系统、一套菜单。
   * ============================================================ */
  {
    code: 'edu:student:view',
    name: '学生档案',
    path: '/edu/student',
    group: '教务管理',
    desc: '教务学生档案：全校学生名单、新增/编辑、Excel 导入',
  },
  {
    code: 'edu:dorm:view',
    name: '宿舍管理（教务）',
    path: '/edu/dorm',
    group: '教务管理',
    desc: '教务宿舍总名单 / 分派宿舍 / 调换退宿申请审批 / 退宿名单',
  },
  {
    code: 'edu:fee:view',
    name: '缴费管理',
    path: '/edu/fee',
    group: '教务管理',
    desc: '教务缴费总记录 / 即将到期预警 / 凭证 OCR 识别 / 批量冻结',
  },

  /* ============================================================
   * ★ 班级管理（原 8003）2026-10-04 合并进来
   *
   * 权限码沿用班级原来的 class:* 前缀（不是 job:*）——
   *   因为班级后端代码里 requirePerm('class', 'xxx') 有 10+ 处，
   *   改码名要动班级代码；沿用原码 = 班级代码零改动。
   *
   * ⚠️ 路径加了 /class/ 前缀：实训侧已占用 /class、/dorm、/exam。
   * ============================================================ */
  {
    code: 'class:student:view',
    name: '班级信息管理（班级模块）',
    path: '/class/roster',
    group: '班级管理',
    desc: '学员花名册：按班级看学生名单、学员详情、升实训交接',
  },
  {
    code: 'class:info:view',
    name: '班级管理',
    path: '/class/info',
    group: '班级管理',
    desc: '班级建/改/删、阶段推进、交接班、班主任分配',
  },
  {
    code: 'class:consult:view',
    name: '待接收学员',
    path: '/class/consult',
    group: '班级管理',
    desc: '咨询端推来的待接收学员：接收/拒绝（★ 初高中 + 大学共用一个页面）',
  },
  {
    code: 'class:attendance:view',
    name: '出勤管理（班级模块）',
    path: '/class/attendance',
    group: '班级管理',
    desc: '学员出勤打卡与统计（班级侧）',
  },
  {
    code: 'class:grade:view',
    name: '成绩管理（班级模块）',
    path: '/class/grade',
    group: '班级管理',
    desc: '学员成绩录入与 Excel 导入（班级侧）',
  },
  {
    code: 'class:exam:view',
    name: '考试管理（班级模块）',
    path: '/class/exam',
    group: '班级管理',
    desc: '考试安排与末班判定（班级侧）',
  },
  {
    code: 'class:urge:view',
    name: '催费管理（班级模块）',
    path: '/class/urge',
    group: '班级管理',
    desc: '催费发起与催缴记录（班级侧）',
  },
  {
    code: 'class:refund:view',
    name: '退费（班级模块）',
    path: '/class/refund',
    group: '班级管理',
    desc: '退费申请与审批（班级侧）',
  },
  {
    code: 'class:suspend:view',
    name: '休学 / 退学审批（班级模块）',
    path: '/class/approval',
    group: '班级管理',
    desc: '休学/退学/复学审批与升实训交接（班级侧）',
  },
  {
    code: 'class:dorm:view',
    name: '宿舍管理（班级模块）',
    path: '/class/dorm',
    group: '班级管理',
    desc: '班级侧宿舍：床位分配、换宿/退宿申请（审批在教务）',
  },

  /* ============================================================
   * ★★ 教学管理（初高）2026-10-05 并入
   *
   *   和上面的「班级管理」（大学部 Q1~Q6）是【两个模块】：
   *     · 这一个 = 初高中部（J/G 班，预科 + 初中 1~3 期 / 高中 1~2 期）
   *     · 库 sms_class_jh，接口前缀 /api/class-jh/*，路由 /class-jh/*
   *
   *   权限码用 `classjh:` 前缀 —— 后端那 66 个接口内部的权限点仍是
   *   原包的 `class:<资源>:<动作>`（改码要动 66 处，且它是模块内部的事），
   *   两者是两层：
   *     classjh:*  = 有没有资格进这个页面（本清单 + 角色决定，前端菜单/守卫用）
   *     class:*    = 进页面之后能不能做某个动作（后端路由自己的 checkPermission）
   * ============================================================ */
  {
    code: 'classjh:dashboard:view',
    name: '工作台（初高）',
    path: '/class-jh/dashboard',
    group: '教学管理（初高）',
    desc: '在读人数、今日出勤率、临期缴费与待办',
  },
  {
    code: 'classjh:student:view',
    name: '基础数据（初高）',
    path: '/class-jh/student',
    group: '教学管理（初高）',
    desc: '学生主档与学籍状态：休学/复学/退学/末班、7 页签详情',
  },
  {
    code: 'classjh:classInfo:view',
    name: '班级管理（初高）',
    path: '/class-jh/class',
    group: '教学管理（初高）',
    desc: '班级生命周期、师资交接、学期管理',
  },
  {
    code: 'classjh:attendance:view',
    name: '出勤管理（初高）',
    path: '/class-jh/attendance',
    group: '教学管理（初高）',
    desc: '按班级+日期的考勤台账、上传出勤表、缺勤明细',
  },
  {
    code: 'classjh:exam:view',
    name: '考试管理（初高）',
    path: '/class-jh/exam',
    group: '教学管理（初高）',
    desc: '月考/质素/阶段/结业四类考试与自定义字段',
  },
  {
    code: 'classjh:score:view',
    name: '成绩管理（初高）',
    path: '/class-jh/score',
    group: '教学管理（初高）',
    desc: '成绩录入与查询（按成绩/时间/班主任筛选）',
  },
  {
    code: 'classjh:dorm:view',
    name: '宿舍管理（初高）',
    path: '/class-jh/dorm',
    group: '教学管理（初高）',
    desc: '分派宿舍、调宿申请（审批在教务）',
  },
  {
    code: 'classjh:fee:view',
    name: '催费管理（初高）',
    path: '/class-jh/fee',
    group: '教学管理（初高）',
    desc: '缴费临期/逾期名单与催费分享',
  },
  {
    code: 'classjh:refund:view',
    name: '退费（初高）',
    path: '/class-jh/refund',
    group: '教学管理（初高）',
    desc: '退学退费申请与审批（学管主任/校长审批、财务执行）',
  },
  {
    code: 'classjh:approval:view',
    name: '教职·学术审批（初高）',
    path: '/class-jh/approval',
    group: '教学管理（初高）',
    desc: '休学/复学/退学/末班/换人等流程的审批中心',
  },
  {
    code: 'classjh:setting:view',
    name: '系统设置（初高）',
    path: '/class-jh/setting',
    group: '教学管理（初高）',
    desc: '出勤达标线与统计口径、催费提醒天数、学习阶段字典',
  },
  {
    code: 'classjh:building:view',
    name: '楼栋设置（初高）',
    path: '/class-jh/building',
    group: '教学管理（初高）',
    desc: '宿舍楼栋字典，与宿舍管理的楼栋下拉实时一致（可独立授权给教务）',
  },
];

/** 按权限码查定义 */
export function findPagePermission(code: string): PagePermissionDef | undefined {
  return PAGE_PERMISSIONS.find((p) => p.code === code);
}

/** 按路径查定义（路由守卫用） */
export function findPagePermissionByPath(path: string): PagePermissionDef | undefined {
  // 先精确匹配
  const exact = PAGE_PERMISSIONS.find((p) => p.path === path);
  if (exact) return exact;
  // 再前缀匹配（处理 /class/:id/students 这类动态路由）
  return PAGE_PERMISSIONS.find((p) => {
    if (!p.path.includes('/:')) return false;
    const prefix = p.path.split('/:')[0];
    return path.startsWith(prefix + '/');
  });
}

/**
 * ★ 2026-10-06 页面权限码 → 所属门户模块（模块门槛用）
 *
 * 【为什么需要】
 *   本文件的页面清单是「角色 → 页面权限」，而「这个账号能不能进这个模块」
 *   由门户的 `sms_portal.t_sys_account.modules` 决定，两者是两层：
 *     · 模块级：门户 modules（job / edu / class / class-jh）
 *     · 页面级：本清单 + 角色
 *
 *   只判页面级会出现夹缝：**在权限库挂了系统管理员角色、门户却只授权 perm**
 *   的账号（权限管理员 linx）照样拿到全部 40 个页面码 → 菜单多出四组业务板块、
 *   接口也能调。所以消费页面权限的地方都必须再叠加这道模块门槛。
 *
 * 返回 '' = 该页面码不属于任何门户模块（不参与门槛）。
 */
export function moduleOfPageCode(pageCode?: string): string {
  if (!pageCode) return '';
  if (pageCode.startsWith('classjh:')) return 'class-jh';
  if (pageCode.startsWith('class:')) return 'class';
  if (pageCode.startsWith('job:')) return 'job';
  if (pageCode.startsWith('edu:')) return 'edu';
  return '';
}

/**
 * ★ 2026-10-19：**跨模块共用的页面码**
 *
 * 待接收学员（`class:consult:view`）改成「初高中 + 大学」共用一个页面：
 *   初高班主任的账号 modules 只有 `class-jh`，按 `class:` 前缀判模块会被直接
 *   从 my-pages 里摘掉 → 页面「没有访问权限」。
 *
 * ⚠️ 只登记**确实两段共用**的页面。别把整组 class:* 放开 —— 那等于给初高账号
 *    开了大学部班级管理的后门。
 * ⚠️ 必须与前端 `web-job/src/store/modules.ts` 的 SHARED_PAGE_MODULES 保持一致。
 */
export const SHARED_PAGE_MODULES: Record<string, string[]> = {
  'class:consult:view': ['class', 'class-jh'],
};
