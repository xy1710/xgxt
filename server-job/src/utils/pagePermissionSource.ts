/**
 * 【临时】页面权限数据源 —— 本地假数据
 *
 * ============================================================
 * ⚠️⚠️ 这个文件是【临时的】，将来要换成调 8006！⚠️⚠️
 * ============================================================
 *
 * 【为什么有它】
 *   斌哥拍板（2026-09-29）：所有页面都要接权限管理，
 *   但权限管理模块（8006，林晓负责）还没做出来。
 *   所以先在本模块内搭好「权限守卫」的架子 + 用假数据测通，
 *   等 8006 就绪后，只需要改本文件的一个函数即可接上。
 *
 * 【将来怎么对接】
 *   把 `getRolePagePermissions()` 换成：
 *
 *     import { config } from '../config';
 *     const resp = await fetch(
 *       `${config.services.perm}/api/perm/role/page-permissions?roleCode=${role}`,
 *       { headers: { Authorization: req.headers.authorization } }
 *     );
 *     return (await resp.json()).data;
 *
 *   调用方（middleware/pagePermission.ts）不用改。
 *
 * 【假数据设计】
 *   按「角色 → 可访问页面权限码」组织。
 *   角色码来自 shared-types 的 RoleCode。
 */

import { RoleCode, expandRoleCode } from 'shared-types';
import { PAGE_PERMISSIONS } from '../config/pagePermissions';
import { applyLedgerToCodes } from './rolePageLedger';
import {
  getRoleActionOverride,
  overlayActionCodes,
  PERM_POINT_TO_ACTION_CODES,
} from './roleActionOverlay';
import { extraPageCodesFromModuleItems, isBuiltinRoleCode } from './permPointToPages';
import { getRoleModuleItems } from './roleModuleItems';

/**
 * 角色 → 页面权限码 映射（假数据）
 *
 * ⚠️ 说明：真实场景里这是管理员在 8006 的「权限配置」界面勾出来的。
 *         这里先写死几个典型角色的配置，方便测试。
 */
/**
 * 班主任 / 教员 / 助教 三家共用的页面清单
 * （斌哥 2026-09-30：这三家在实训模块权限**完全一致**）
 */
const TEACHING_STAFF_PAGES: string[] = [
  'job:class:view',
  'job:classTransfer:view',
  'job:classStudent:view',
  'job:attendance:view',
  'job:examScore:view',
  'job:examSummary:view',
  'job:refund:view',
  'job:suspendApproval:view',
  'job:dorm:view',
  'job:feeCall:view',
];

/**
 * 班主任 / 教员 / 助教 在【班级模块】的页面（2026-10-04 合并时新增）
 *
 * 给的是「带班日常要用的」：看花名册、看班级、记出勤、录成绩、催费、查宿舍。
 * 不给考试（校长专用）和审批（学管/校长专用）—— 与实训侧的口径一致。
 */
/**
 * 班主任 / 教员 / 助教 在【班级模块】的页面
 *
 * ★ 2026-10-04 斌哥拍板：「班主任、助教、教员的权限应一样，
 *   可以进行班级交接、和班级有关的全部操作」
 *   → 三家统一用这一份清单，**包括 class:info:view（班级管理 / 交接）**
 *
 * 页面级只是"能进这个页面"；进去之后能点哪些按钮由前端
 * `canManageClasses` 和后端 `permGuard.WRITE_ROLES` 一起管。
 */
const CLASS_STAFF_PAGES: string[] = [
  'class:student:view',
  'class:info:view',        // ★ 班级管理 + 班级交接（斌哥要求三家一致）
  'class:consult:view',
  'class:attendance:view',
  'class:grade:view',
  'class:urge:view',
  'class:dorm:view',
];

/* ============================================================
 * ★★ 2026-10-04 斌哥拍板：班主任按【阶段】拆成两个角色
 *
 *   班主任 TEACH_HEAD      → 只带【大学部】（class:* 页面）
 *                              看不到实训/就业的任何一个页面
 *   项目经理 RM_PROJECT    → 只带【实训】（job:* 里的实训分组）
 *                              ★ 2026-10-06 起不再给就业阶段页面
 *                             看不到大学部的任何一个页面
 *
 *   【为什么拆】升实训后带的班变了（教室 → 实训基地），
 *   一个人同时看两个阶段的名单会乱；而且项目经理不能自己建实训班
 *   （实训班只能由大学班「升实训」产生）。
 * ============================================================ */

/** 班主任（大学部）：【只给 class:*】，一条 job:* 都不给 → 彻底看不到实训 */
const HEAD_TEACHER_JOB_PAGES: string[] = [];

/**
 * 项目经理：【只给实训阶段 job:* 里带班相关的】
 *
 * ⚠️ 不给 class:* —— 他看不到大学部任何东西。
 * ⚠️ 不给 job:exam:view（考试管理是校长专用）。
 * ⚠️ 不给 job:refund:view / job:suspendApproval:view
 *    （审批流 = 班主任发起 → 学管/校长审批，项目经理不参与）。
 *
 * ★ 2026-10-06 调整：项目经理【只带实训阶段】，就业阶段的 5 个页面
 *   （信息档案 / 就业日志 / 复盘填写 / 数据统计 / 就业基地宿舍）
 *   不再给 —— 那是就业老师（JOB_STAFF）的职责范围。
 *   调整原因：两个角色此前菜单完全重叠（都是 13 / 5 页的重合集），
 *   看不出「实训 → 升就业」的分工，也不符合「项目经理管实训基地带班、
 *   就业老师管投递面试」的岗位划分。
 */
const PROJECT_MANAGER_PAGES: string[] = [
  // 实训阶段带班日常
  'job:class:view',
  'job:classStudent:view',
  /* ============================================================
   * ★ 2026-10-22：项目经理要能看到「学生档案」
   *
   *   学生档案 2026-10-21 收成三学段（初高 / 大学 / 就业部），实训学生
   *   已并入就业部（dept_code=3）——项目经理带的班就在这里。
   *   而就业部页签的权限码是 `job:empArchive:view`（原属就业老师），
   *   项目经理没有 → 学生档案整体进不去（连菜单都看不到）。
   *
   *   业务依据：「项目经理 = 实训阶段班主任」，他必须能看到自己带的学员。
   *   数据范围不会因此放宽：repo.emp 的 PROJECT_MANAGER 分支只放
   *   「project_manager_id = 自己 且未结业」的班，别人班的学员看不到。
   * ============================================================ */
  'job:empArchive:view',
  'job:classTransfer:view',   // ★ 能看班级交接记录（但不能执行交接）
  'job:attendance:view',
  'job:examScore:view',
  'job:examSummary:view',
  'job:feeCall:view',
  'job:dorm:view',
  /* ============================================================
   * ★ 2026-10-08 斌哥拍板：四类单据项目经理也能发起
   *
   * 原来这两页只给班主任，项目经理页面清单里没有 →
   *   进不去「退费管理」「休学退学」页 → 菜单里看不到，
   *   就算手动敲 URL 也被 requirePage 拦成 403。
   *
   * 斌哥口径：「实训阶段的班主任由项目经理担任」——
   *   那班主任能发起什么，项目经理就得能发起什么。
   *   （发起的**数据范围**仍受 stageScope + project_manager_id 限制，
   *     只能对自己带的实训班学员发起，见各 route 的过滤分支。）
   * ============================================================ */
  'job:refund:view',          // 退费（发起 → 学管 → 校长 → 财务执行）
  'job:suspendApproval:view', // 休学/退学审批（请假单也挂这个码）
];

/**
 * 学管主任在【班级模块】的页面
 *
 * 学管是审批人：休退学审批、退费都要他批；带班类也给（他要能看到班情况）。
 */
const CLASS_MANAGER_PAGES: string[] = [
  'class:student:view',
  'class:info:view',
  'class:consult:view',
  'class:attendance:view',
  'class:grade:view',
  'class:urge:view',
  'class:refund:view',
  'class:suspend:view',
  'class:dorm:view',
];

/** 校长在【班级模块】：全给（他是唯一全权角色） */
const CLASS_PRINCIPAL_PAGES: string[] = [
  'class:student:view',
  'class:info:view',
  'class:consult:view',
  'class:attendance:view',
  'class:grade:view',
  'class:exam:view',
  'class:urge:view',
  'class:refund:view',
  'class:suspend:view',
  'class:dorm:view',
];

/* ============================================================
 * ★★ 教学管理（初高）2026-10-05 并入
 *
 *   这是【初高中部】的教学管理（库 sms_class_jh / 前缀 /api/class-jh），
 *   与上面的 class:*（大学部）是两套模块，权限码用 classjh: 前缀区分。
 *
 *   【分配思路】按各角色在这个模块里的实际职责：
 *     · 班主任       → 整套带班业务（学生/班级/出勤/考试/成绩/宿舍/催费/退费/审批）
 *                      ⚠️ 不给「系统设置」——那是经理层定达标线的地方
 *     · 教员/助教    → 只读出勤/考试/成绩，不给审批与费用
 *     · 学管主任     → 全给（他是本模块的审批人 + 设置负责人）
 *     · 校长         → 全给
 *     · 教务老师     → 只给宿舍与审批（调宿审批在教务）
 *     · 项目经理/就业老师 → 不给（初高部与实训/就业无关）
 * ============================================================ */

/** 初高模块的全部 11 页（学管主任/校长用） */
const CLASS_JH_ALL_PAGES: string[] = [
  'classjh:dashboard:view',
  'classjh:student:view',
  'classjh:classInfo:view',
  'classjh:attendance:view',
  'classjh:exam:view',
  'classjh:score:view',
  'classjh:dorm:view',
  'classjh:fee:view',
  'classjh:refund:view',
  'classjh:approval:view',
  'classjh:setting:view',
];

/** 班主任：带班业务全给，只差「系统设置」 */
const CLASS_JH_HEAD_TEACHER_PAGES: string[] = [
  'classjh:dashboard:view',
  'classjh:student:view',
  'classjh:classInfo:view',
  'classjh:attendance:view',
  'classjh:exam:view',
  'classjh:score:view',
  'classjh:dorm:view',
  'classjh:fee:view',
  'classjh:refund:view',
  'classjh:approval:view',
];

/** 教员 / 助教：教学执行类，不含费用与审批 */
const CLASS_JH_STAFF_PAGES: string[] = [
  'classjh:dashboard:view',
  'classjh:student:view',
  'classjh:classInfo:view',
  'classjh:attendance:view',
  'classjh:exam:view',
  'classjh:score:view',
  'classjh:dorm:view',
];

/** 教务老师：本模块只负责宿舍（调宿审批）与审批中心、楼栋字典 */
const CLASS_JH_ACAD_PAGES: string[] = [
  'classjh:dashboard:view',
  'classjh:dorm:view',
  'classjh:approval:view',
  'classjh:building:view',
];

const ROLE_PAGE_PERMISSIONS: Record<string, string[]> = {
  // 系统管理员：全部页面
  [RoleCode.SYS_ADMIN]: PAGE_PERMISSIONS.map((p) => p.code),

  /* ============================================================
   * ★ 班级管理模块（原 8003）2026-10-04 合并进来
   *
   * 权限码沿用班级原来的 class:* 前缀（后端 requirePerm('class','xxx')
   * 有 10+ 处，沿用原码 = 班级代码零改动）。
   *
   * 【分配思路】按各角色在班级模块里的实际职责给：
   *   · 班主任/教员/助教 → 带班相关的（花名册、班级、出勤、成绩、催费、宿舍）
   *     考试与审批不给（那是校长/学管的事）
   *   · 学管主任 → 审批类全给（休退学审批、退费）+ 带班类
   *   · 校长 → 全给
   *   · 教务老师 → 不给（他只看教务那 3 页，斌哥 2026-10-03 拍板）
   *   · 就业老师 → 不给
   * ============================================================ */

  // ⭐ 班主任（大学部）—— ★ 2026-10-04 起只看【大学部】
  //
  //   业务背景：班主任带的是**大学阶段**的班（教室上课），
  //   升实训后那个班会交给**项目经理**接手（实训基地带训）。
  //   所以班主任【一条 job:* 页面都不给】→ 彻底看不到实训/就业的名单与页面。
  //
  //   ⚠️ 审批权不在页面权限里：能不能点"同意/驳回"由 canApprove() 按角色算
  //      （见 shared-types/src/approval.ts）。
  [RoleCode.TEACH_HEAD]: [...HEAD_TEACHER_JOB_PAGES, ...CLASS_STAFF_PAGES, ...CLASS_JH_HEAD_TEACHER_PAGES],

  // ★ 项目经理（实训/就业阶段）—— ★ 2026-10-04 新增
  //   只带实训阶段的班，【看不到大学部任何页面】。
  //   ⚠️ 不能给 class:info:view —— 那是「班级管理 / 建班」页，
  //      按斌哥要求「项目经理不能建实训班，实训班只能从大学升上来」。
  //
  // ★ 2026-10-08 别名收口：
  //   这里只保留**主包 RoleCode 的写法**（PROJECT_MANAGER）一条。
  //   权限库里存的是 `RM_PROJECT`，两者靠 `utils/roleCodeAlias.ts` 的
  //   ROLE_CODE_ALIAS 桥接 —— `getRolePagePermissions()` 会先用别名展开
  //   再查这张表（见下方实现）。
  //   ⚠️ 原先这里**同时登记了两条**（RoleCode.PROJECT_MANAGER 与
  //      字面量 'RM_PROJECT'），改一处忘另一处就会踩坑 —— 现已合并为一条。
  [RoleCode.PROJECT_MANAGER]: PROJECT_MANAGER_PAGES,

  // ★ 2026-10-08 新增：权限管理员（新建角色 PERM_ADMIN，账号 linx）
  //   只负责权限管理板块（用户/角色/授权/页面/日志），**不给任何业务页面**。
  //   它在本表里留一条空数组是【刻意的】——
  //     · perm 板块的页面可见性由 `perm/auth` 按「门户身份」判定，不走本表；
  //     · 留空可确保它不会因为别名或前缀匹配意外拿到业务页面码。
  [RoleCode.PERM_ADMIN]: [],

  // 教员 / 助教：跟班主任一样只看大学部
  //   （带班性质与班主任一致，只是分工不同 —— 页面权限不该有差别）
  [RoleCode.TEACH_TUTOR]: [...HEAD_TEACHER_JOB_PAGES, ...CLASS_STAFF_PAGES, ...CLASS_JH_STAFF_PAGES],
  [RoleCode.TEACH_ASSIST]: [...HEAD_TEACHER_JOB_PAGES, ...CLASS_STAFF_PAGES, ...CLASS_JH_STAFF_PAGES],

  // ★ 学管主任（2026-09-30 由「教质经理 + 学术经理」合并而来）
  //   职责：退费审批第 1 步 + 休退学审批 + 催费 + 宿舍；
  //   并且可以【代替校长审批】（见 approval.ts 的 MANAGER_ROLES）
  [RoleCode.TEACH_DEAN]: [
    'job:class:view',
    'job:classTransfer:view',
    'job:attendance:view',
    'job:examScore:view',
    'job:examSummary:view',
    'job:refund:view',
    'job:suspendApproval:view',
    'job:feeCall:view',
    'job:dorm:view',
    // 班级管理模块（2026-10-04 合并）—— 学管要能审批休退学/退费
    ...CLASS_MANAGER_PAGES,
    // 教学管理（初高）2026-10-05 合并 —— 学管主任是本模块的审批人与设置负责人，全给
    ...CLASS_JH_ALL_PAGES,
  ],

  // ⚠️ 教质经理 / 学术经理已【停用】（合并成上面的「学管主任」）。
  //    配置保留，只是为了让历史账号登录时不至于全白；
  //    **新账号不要再分配这两个角色**。
  [RoleCode.TEACH_QTY]: [
    'job:class:view',
    'job:classTransfer:view',
    'job:attendance:view',
    'job:examScore:view',
    'job:examSummary:view',
    'job:refund:view',
    'job:suspendApproval:view',
    'job:feeCall:view',
    'job:dorm:view',
    // 班级管理模块（2026-10-04 合并）
    ...CLASS_MANAGER_PAGES,
    // 教学管理（初高）2026-10-05 合并
    ...CLASS_JH_ALL_PAGES,
  ],
  [RoleCode.ACAD_MANAGER]: [
    'job:class:view',
    'job:classTransfer:view',
    'job:attendance:view',
    'job:examScore:view',
    'job:examSummary:view',
    'job:refund:view',
    'job:suspendApproval:view',
    'job:feeCall:view',
    'job:dorm:view',
    // 班级管理模块（2026-10-04 合并）
    ...CLASS_MANAGER_PAGES,
    // 教学管理（初高）2026-10-05 合并
    ...CLASS_JH_ALL_PAGES,
  ],

  // 校长：唯一全权角色 —— 实训 + 就业 + 教务 + 班级 全看
  // 校长：唯一全权角色 —— 实训 + 就业 + 教务 + 班级 全看
  //
  // ★ 2026-10-04 全流程回归时发现：这里原来只列了 11 个，
  //   漏了 classStudent / attendance / classTransfer / examScore / feeCall / dorm
  //   → 表现是「校长点实训侧宿舍/花名册/出勤报 40302 没有访问该页面的权限」。
  //   校长既然是"唯一全权角色"，这里就直接给全部 job: 页面（以后加页也不用再补）。
  [RoleCode.RM_PRINCIPAL]: [
    ...PAGE_PERMISSIONS.filter((p) => p.code.startsWith('job:')).map((p) => p.code),
    // 就业阶段（2026-10-02 合并进来）
    'job:employmentLog:view',
    'job:review:view',
    'job:statistics:view',
    'job:empDorm:view',
    'job:empArchive:view',
    // 教务管理（2026-10-03 合并进来）
    'edu:student:view',
    'edu:dorm:view',
    'edu:fee:view',
    // 班级管理（2026-10-04 合并进来）—— 校长全给
    ...CLASS_PRINCIPAL_PAGES,
    // 教学管理（初高）2026-10-05 合并进来 —— 校长全给
    ...CLASS_JH_ALL_PAGES,
  ],

  // ⚠️ 财务角色已【删除】（斌哥 2026-09-30）：
  //    财务只在真正出款那一刻才涉及，而本模块「审批通过就结束」，
  //    出款是财务模块（8005）自己的事 —— 所以这里不再给财务配任何页面。

  // 教务老师：★ 2026-10-03 斌哥拍板 —— 只看「教务管理」3 页
  //   ⚠️ 不再给实训侧任何页面（催费 / 宿舍 / 班级 / 花名册）。
  //   原因：教务与就业是两个体系，教务账号不该看到「就业管理」这一组菜单。
  //   → 副作用：催费管理原本由教务发起，现在教务看不到该页（斌哥已知悉）。
  //   → 实训学生的换宿 / 退宿，改由「教务管理 → 宿舍管理 → 申请审批」处理。
  //
  // ★★ 2026-10-05 用户拍板：把 `job:feeCall:view` 加回来 —— 因为出现了「权限死结」：
  //   /api/job/fee-call/create 只允许 ACAD_STAFF 发起（见 routes/feeCall.route.ts ①），
  //   而「催费管理」页只有 TEACH_DEAN / TEACH_QTY / ACAD_MANAGER / RM_PRINCIPAL 持有，
  //   ACAD_STAFF 进不去；系统管理员又是【只读总闸】不许 POST ——
  //   结果**没有任何角色能真正发起催费**，信息流转（催费 → 班级）形同虚设。
  //   加回这一条后：「就业管理 → 催费管理」会出现在教务老师的菜单里（其余就业页面仍不给他），
  //   教务点「发起催费」即可推送到班级管理（syncFeeCallToClass）。
  [RoleCode.ACAD_STAFF]: [
    'edu:student:view',
    'edu:dorm:view',
    'edu:fee:view',
    // ★ 2026-10-05：教务发起催费的入口（见上方说明）
    'job:feeCall:view',
    // ★★ 2026-10-08 修复「宿舍审批死结」：
    //   实训侧「就业管理 → 宿舍管理」（job:dorm:view）**本来就是班主任/教务共用页**——
    //   班主任只能「发起 + 撤回」，教务**只负责审批**（见 api/dorm.ts 头部说明、
    //   routes/dorm.route.ts「审批人 = 教务老师」）。
    //   但 2026-10-03 那次「教务只给教务板块 3 页」把本码一起拿掉了 →
    //   教务作为 DORM_CHANGE 的审批人**点不进页面**（实测 40302），审批链断死。
    //   加回本码：教务在实训宿舍页只看到「审批」按钮（发起按钮由后端 canCancel 控制），
    //   与「教务管理 → 宿舍管理」是两套独立宿舍（实训基地 / 教务基地），互不影响。
    'job:dorm:view',
    // ★ 2026-10-05：教学管理（初高）—— 教务在该模块负责【调宿审批】，
    //   所以给宿舍页与审批中心（其余页面属班主任/经理，不给他）
    ...CLASS_JH_ACAD_PAGES,
  ],

  // 就业老师：**只管就业阶段**，实训侧的页面一律不给
  //   ★ 2026-10-02 合并就业模块后，就业老师负责就业阶段的全部页面。
  //   ★ 2026-10-02 去掉 `job:class:view`（斌哥：就业老师那边「班级信息管理」与「信息档案」重复）
  //     —— 他不是班主任，点进去永远是空的（my-class 按 head_teacher_id 查）。
  //     去掉后「班级信息管理」不再出现在他的菜单里；他改用「信息档案」（job:empArchive:view）。
  //     ⚠️ 学员档案接口（/api/job/class-info）已改成「多码任一」，所以他仍能调详情，不受影响。
  //   ★ 2026-10-02 又去掉 `job:classTransfer:view`（斌哥截图：进去报 403）
  //     —— 「班级管理」是**换班交接**，换的是实训班的班主任/教员/助教，跟就业老师无关。
  //     留着的后果：他能看到菜单、点得进去，但页面要用的「班级下拉」接口
  //     （/api/job/class/options，当时挂在 job:class:view 下）直接 403，
  //     页面顶部红条「您没有该操作的权限」+ 中间红条「Request failed with status code 403」。
  //     → 结论：**没权限的页面不该出现在菜单里**，而不是让他进去看报错。
  [RoleCode.JOB_STAFF]: [
    'job:employmentLog:view',
    'job:review:view',
    'job:statistics:view',
    'job:empDorm:view',
    'job:empArchive:view',
  ],
};

/**
 * 查某个角色能访问哪些页面权限码
 *
 * ★ 2026-10-08 别名收口：本函数现在会**先用别名展开**再查表。
 *
 * 【为什么】
 *   调用方传进来的 `roleCode` 是**权限库的运行时真实值**（如 `RM_PROJECT`），
 *   而 ROLE_PAGE_PERMISSIONS 的 key 用的是主包 RoleCode 的写法
 *   （如 `PROJECT_MANAGER`）。两者不一致 → 直接查表会落空。
 *   展开后两张写法都能命中同一条配置，表中就**不需要再重复登记两份**。
 *
 * @example
 *   getRolePagePermissions('RM_PROJECT')
 *   //  → 展开为 ['RM_PROJECT','PROJECT_MANAGER'] → 命中 PROJECT_MANAGER 那条
 *
 * ⚠️ 将来换成调 8006
 */
export async function getRolePagePermissions(roleCode: string): Promise<string[]> {
  // TODO【将来】换成调 8006 权限管理
  // const resp = await fetch(`${config.services.perm}/api/perm/role/page-permissions?roleCode=${roleCode}`);
  // return (await resp.json()).data;

  // ★ 别名展开：把权限库码（RM_PROJECT）折算成主包码（PROJECT_MANAGER）去查表
  for (const code of expandRoleCode(roleCode)) {
    const hit = ROLE_PAGE_PERMISSIONS[code];
    if (hit) return hit;
  }
  return [];
}

/**
 * 查某个用户能访问的页面权限码（合并他所有角色）
 *
 * ★ 2026-10-07 新增一层：【角色 → 页面 台账】叠加
 *
 *   原来这里只按 ROLE_PAGE_PERMISSIONS 的硬编码表算。
 *   现在多了一层可配置的台账（权限管理 → 页面管理 → 角色模式），
 *   落在 `sms_perm.t_perm_role_page`：
 *     · 管理员去勾了某页 → 即使角色本来有权限码，也把它摘掉
 *     · 管理员加勾了某页 → 即使角色本来没权限码，也给它补上
 *     · 该角色一行都没有（从没配过）→ 什么都不做，行为与改造前**完全一致**
 *
 *   ⚠️ 这一层是**后端真闸**：requirePage / requireAnyPage / my-pages 都走这里，
 *      所以对全部账号（含没有 perm 模块的班主任、教务、财务）都生效，
 *      不依赖前端能不能拉到权限接口。
 *
 *   ⚠️ 台账查询失败时 `applyLedgerToCodes` 会原样返回，绝不把页面全禁掉
 *      （见 utils/rolePageLedger.ts 的降级说明）。
 *
 * ★★ 2026-10-08 新增一层：【权限库功能点】推导（**自建角色打通 · 方案 B**）
 *
 *   【问题】`getRolePagePermissions()` 读的是代码里写死 14 个内置角色的
 *     `ROLE_PAGE_PERMISSIONS`。管理员**新建**的角色（如 `XMJL_000`「项目经理2」）
 *     在表里查不到 → 返回空数组 → 该角色 0 页 → 所有页面「没有访问权限」。
 *     而咨询 / 财务两个板块本来就走权限库功能点换算，所以只有 legacy
 *     四板块（job/edu/class/class-jh）有这个不对称的坑。
 *
 *   【补法】把该角色的权限库功能点按 `permPointToPages.ts` 的显式映射
 *     换算成页面码，**并入**静态码之后，再交给台账层处理。
 *
 *   【★★ 关键约束：只在「静态表查不到该角色」时才启用】
 *     实测（2026-10-08）发现：若对所有角色都并入，会**误伤内置角色**——
 *       教务（ACAD_STAFF）在权限库有 teach/train 模块的功能点，
 *       于是凭空多出 `job:class:view` / `job:attendance:view`，
 *       而业务口径明确「教务不看就业管理」；
 *       班主任/学管也会多出 `class:exam:view` 等班级侧页面，
 *       但那些页面的静态口径是**刻意不给**的。
 *
 *     原因：权限库的功能点是**按模块粗粒度**投的（"这个角色在这个部门干活"），
 *     不等于该角色在 legacy 板块的**页面级**口径。内置 14 角色的页面口径
 *     是经业务确认、逐页校准过的，不能被粗粒度的功能点覆盖。
 *
 *     所以本层只服务于**静态表里压根没有的角色**（= 自建角色）：
 *       `base.length > 0` → 内置角色 → 完全不启用本层（零回归）
 *       `base.length === 0` → 自建角色 → 用功能点推导它的页面（它否则是 0 页）
 *
 *   【为什么顺序是「先并入、后过台账」】
 *     台账代表管理员**最后一次显式改动**，优先级最高：
 *       并入 → 台账 denied 仍能删掉它（管理员去勾了的页面照旧消失）
 *     若反过来（先过台账再并入），台账的 deny 会被并入冲掉 —— 那就违例了。
 *
 * @param roles 用户拥有的角色码数组
 */
export async function getUserPagePermissions(roles: string[]): Promise<string[]> {
  const set = new Set<string>();
  for (const role of roles) {
    const base = await getRolePagePermissions(role);

    /**
     * ★★ 功能点 → 页面码（自建角色打通）：**仅对「自建角色」启用**。
     *
     *    双重条件（两个都要满足才启用）：
     *      ① `!isBuiltinRoleCode(role)` —— 不是主包 RoleCode 枚举里的内置角色
     *      ② `base.length === 0` —— 静态表确实没登记过它
     *
     *    为什么需要 ①：像 `MKT_MANAGER`（市场经理）虽然已在枚举里，但
     *    `ROLE_PAGE_PERMISSIONS` 里从没给它配 legacy 页面（它本就不该看实训页），
     *    于是 `base` 也是空 —— 只靠 ② 会被误判成「自建角色」。
     *
     *    · 内置角色 → merged 恒等于 base，行为与改造前逐字一致（零回归）
     *    · 自建角色 → 用权限库功能点推导出它该有哪些页面
     */
    let merged = base;
    if (!isBuiltinRoleCode(role) && base.length === 0) {
      const items = await getRoleModuleItems(role);
      const extra = extraPageCodesFromModuleItems(items);
      if (extra.length) merged = Array.from(new Set(extra));
    }

    // ★ 角色 → 页面 台账：增/删该角色在本轮被显式调整过的页面（优先于上面两层）
    const codes = await applyLedgerToCodes(role, merged);
    codes.forEach((c) => set.add(c));
  }
  return Array.from(set);
}

/* ============================================================
 * 【按钮级】操作权限码 —— 角色 → 能点哪些操作
 * ============================================================
 *   上面 ROLE_PAGE_PERMISSIONS 配的是「能不能进这个页面」；
 *   这里配的是「进了页面之后，能不能点某个按钮」，
 *   对应后端接口上的 checkPermission('job:exam:add') 这类校验。
 *
 * ⚠️ 为什么必须有这份配置（2026-09-30 踩到）：
 *   checkPermission 本来只看 user.permissions，而这个字段要等
 *   「登录模块 8001 + 权限管理 8006」接上才会被填。在那之前它是空数组，
 *   结果是——**除"不带身份的管理员"外，所有人都点不了任何操作按钮**。
 *   校长点「新建考试」报「您没有该操作的权限」，就是这么来的。
 *
 * ⚠️ 8006 接上后，这份配置应搬过去由管理员在界面上维护，这里只留兜底。
 */
/* ------------------------------------------------------------
 * ★ 2026-10-04：班级模块的操作码补登记
 *
 * 【为什么必须有】Roster（学生名单）等页面的按钮挂的是
 *   can('class:student:edit') / can('class:suspend:add') 这类操作码，
 *   但这份配置里从来没有 class:* 的码 → can() 恒 false →
 *   新增/修改/换班/休学/退学按钮【对所有人消失】（校长也看不到）。
 *
 * 【口径】（与 class/lib/permGuard.ts 的 WRITE_ROLES 保持一致）
 *   班主任/教员/助教（三家一致，斌哥 2026-10-04）：学生增改、换班、
 *     出勤、成绩、考试、休学退学发起、宿舍申请
 *   班主任额外：退费发起（审批链发起人）
 *   学管/校长：以上全部 + 咨询审批 + 宿舍建/改
 *   教务/系统管理员：不给（教务在学生页只读、管理员全局只读）
 * ------------------------------------------------------------ */
/** 三家（班主任/教员/助教）共有的班级操作 */
const CLASS_STAFF_ACTION_CODES: string[] = [
  'class:student:add',
  'class:student:edit',
  'class:suspend:add',
  'class:attendance:add',
  'class:grade:add',
  'class:grade:edit',
  'class:grade:delete',
  'class:exam:add',
  'class:dorm:apply',
];
/** 学管/校长 = 三家全部 + 审批类 */
const CLASS_MANAGER_ACTION_CODES: string[] = [
  ...CLASS_STAFF_ACTION_CODES,
  'class:consult:approve',
  'class:dorm:add',
  'class:dorm:edit',
  'class:refund:add',
];

/**
 * 实训/就业侧（job:*）的**全部操作码** —— 从权限树映射表派生。
 *
 * 【为什么派生而不是手抄】
 *   `PERM_POINT_TO_ACTION_CODES`（utils/roleActionOverlay.ts）是
 *   「权限树功能点 → legacy 操作码」的唯一权威映射。凡是从它映射出来的
 *   job:* 码，就是管理员在界面上**有可能勾出来**的全部 job 动作。
 *   手抄清单必然随开发漂移（2026-10-07 就因为漏登记 6 个 train 功能点，
 *   导致"改了权限树但接口不动"），派生法天然免疫这个问题。
 *
 * 用途：校长（唯一全权角色）的静态兜底基准 —— 见 ROLE_OPERATION_PERMISSIONS。
 */
const ALL_JOB_ACTION_CODES: string[] = (() => {
  const set = new Set<string>();
  for (const actMap of Object.values(PERM_POINT_TO_ACTION_CODES)) {
    for (const codes of Object.values(actMap)) {
      codes.forEach((c) => {
        if (c.startsWith('job:')) set.add(c);
      });
    }
  }
  return Array.from(set).sort();
})();

const ROLE_OPERATION_PERMISSIONS: Record<string, string[]> = {
  /**
   * 校长 —— ★★ 2026-10-08 斌哥口径：「校长拥有全部权限，可以进行任何操作，
   *   但也必须遵循权限管理的设置」。
   *
   * 【为什么要把 job 全量补上】
   *   斌哥报「校长在就业模块有全部权限、但没有休学/退学权限」。实测根因：
   *     · 校长在权限树里**本来就勾着** `train||实训-班级信息`（含休学/退学/结业），
   *       属于「基线已有」，不是「新增授权」→ overlay（差异存储）**不叠加**；
   *     · 而这里的静态兜底表原来只有 `CLASS_MANAGER_ACTION_CODES`（**class:\* 码**）
   *       + 考试三个 job 码 —— **没有任何 job:class:suspend / quit / graduate**；
   *     · 结果：校长点实训侧「休学/退学」按钮 → `can('job:class:suspend')` = false
   *       → 按钮不显示 / 接口 40302。
   *
   * 【为什么是「全量静态兜底 + 权限树可撤销」而不是「改成读权限树」】
   *   校长的定位是**唯一的全权角色**（见页面权限里那句「校长既然是唯一全权角色，
   *   这里就直接给全部 job: 页面」）。所以操作码同样给全量：
   *     · 基准 = 全部 job 操作码（从权限树映射表 PERM_POINT_TO_ACTION_CODES 派生，
   *       保证「树里能勾出来的 job 码」校长一个不缺）
   *     · 管理员在「职位权限分配」里**去勾**某动作 → overlay 的 removed 把它摘掉
   *       （roleActionOverlay 的差异存储：explicit 撤销优先于静态兜底）
   *   —— 这样既满足「校长有全部权限」，又满足「必须遵循权限管理的设置」。
   *
   * ⚠️ 与页面权限同一口径：上面 RM_PRINCIPAL 的页面也是
   *    `PAGE_PERMISSIONS.filter(p => p.code.startsWith('job:'))` 全给。
   */
  [RoleCode.RM_PRINCIPAL]: [
    ...CLASS_MANAGER_ACTION_CODES,
    // 实训/就业侧全部 job 操作码（从权限树映射表派生，避免手工漏项）
    ...ALL_JOB_ACTION_CODES,
  ],

  /**
   * 学管主任 —— ★ 2026-10-06 起【只读 + 仅审批】
   *
   *   业务口径：学管主任是**审批角色**（退费/休学/退学/复学/升实训/待接收学员），
   *   除审批外一律只查看，不做任何业务写操作。
   *
   *   原来这里给的是 `CLASS_MANAGER_ACTION_CODES`（学生增改、出勤、成绩、
   *   考试、宿舍建改、退费发起…全班操作），那是把学管当"代管"的口径。
   *   现在收掉：前端 `can('class:student:add')` 这类判断会自动变 false，
   *   班级模块的「新增/修改/换班/录成绩/建宿舍/发起退费」按钮随之隐藏。
   *
   *   ⚠️ 审批按钮**不靠操作码**，靠角色（前端 `user.canApprove`、
   *      后端 `canApprove()`）—— 所以清空写操作码不会影响审批。
   *   ⚠️ 保留 `class:consult:approve` 仅作语义登记（待接收学员的接收/驳回
   *      也是学管的审批动作；该页按钮实际由角色判定 `canReceiveCard` 控制）。
   */
  [RoleCode.TEACH_DEAN]: ['class:consult:approve'],

  // 班主任：三家一致的全部班级操作 + 退费发起（审批链发起人）+ 录成绩判末班
  [RoleCode.TEACH_HEAD]: [
    ...CLASS_STAFF_ACTION_CODES,
    'class:refund:add',
    'job:exam-score:edit', 'job:exam-score:repeat',
  ],

  // 教员：与班主任一致（斌哥：三家权限一样）
  [RoleCode.TEACH_TUTOR]: [
    ...CLASS_STAFF_ACTION_CODES,
    'job:exam-score:edit', 'job:exam-score:repeat',
  ],

  // 助教：与班主任一致
  [RoleCode.TEACH_ASSIST]: [
    ...CLASS_STAFF_ACTION_CODES,
    'job:exam-score:edit',
  ],

  // 教务老师：教务学生档案的增 / 改 / 删（2026-10-03 合并教务模块后补）
  [RoleCode.ACAD_STAFF]: ['edu:student:add', 'edu:student:edit', 'edu:student:delete'],
};

/**
 * 静态兜底的操作码（**不含**权限树叠加）—— 同步版。
 *   ⚠️ 只用于「诊断 / 对比」：想知道权限树改了什么，就比对这两者。
 *      业务代码一律用下面的异步版。
 */
export function getUserOperationPermissionsBase(roles: string[]): string[] {
  const set = new Set<string>();
  for (const role of roles) {
    (ROLE_OPERATION_PERMISSIONS[role] || []).forEach((c) => set.add(c));
  }
  return Array.from(set);
}

/**
 * 查某个用户（可能身兼多角色）有哪些【操作】权限码
 *
 * ★ 2026-10-07：由同步改为异步，并叠加「权限树」这一层。
 *
 * 【为什么要叠加】
 *   上面 `ROLE_OPERATION_PERMISSIONS` 是**写死在代码里的静态表**，
 *   而管理员真正在操作的是「职位权限分配」页面（权限树 t_perm_role_perm）。
 *   两层命名体系完全不同（`teach||学生基础数据||create` ↔ `class:student:add`），
 *   所以以前「界面上取消了动作，按钮照样在」。
 *
 *   现在：静态表当**兜底默认**，权限树里管理员动过的功能点**以树为准**，
 *        换算表见 `utils/roleActionOverlay.ts`。
 *
 *   ⚠️ 该角色在树里没有记录 → 完全不干预（对存量账号零影响）。
 *   ⚠️ 查库失败 → overlay 内部降级为「无覆盖」，绝不把按钮判死。
 */
export async function getUserOperationPermissions(roles: string[]): Promise<string[]> {
  const set = new Set<string>();
  for (const role of roles) {
    const base = ROLE_OPERATION_PERMISSIONS[role] || [];
    // ★ 权限树叠加：该角色动过的功能点，以树为准（增 / 删）
    const ov = await getRoleActionOverride(role);
    overlayActionCodes(base, ov).forEach((c) => set.add(c));
  }
  return Array.from(set);
}
