/**
 * 服务入口
 *
 * ⚠️ 这个文件在生成"专属包"时已经帮你改好了。
 *    正常情况下你【不需要改这里】，只写你自己的路由文件即可。
 */

import express from 'express';
import cors from 'cors';
import { config } from './config';
import { errorHandler } from './middleware/errorHandler';
import { authMiddleware } from './middleware/auth';
import { requirePage, requireAnyPage } from './middleware/pagePermission';
import { denyApprovalOnlyWrite } from './middleware/approvalOnly';
import { jobPermGate, eduPermGate } from './middleware/boardPermGate';
import { RoleCode, BizCode } from 'shared-types';
import { examRouter } from './routes/exam.route';
import { examScoreRouter } from './routes/examScore.route';
import { classRouter } from './routes/class.route';
import { classStudentRouter } from './routes/classStudent.route';
import { attendanceRouter } from './routes/attendance.route';
import { classTransferRouter } from './routes/classTransfer.route';
import { refundRouter } from './routes/refund.route';
import { studentLeaveRouter } from './routes/studentLeave.route';
import { dormRouter } from './routes/dorm.route';
import { feeCallRouter } from './routes/feeCall.route';
import { classInfoRouter } from './routes/classInfo.route';
import { authRouter } from './routes/auth.route';

// ---- 就业阶段（齐晋霄）2026-10-02 合并进来 ----
import studentRouter from './routes/student.route';
import { employmentLogRouter } from './routes/employmentLog.route';
import { reviewRouter } from './routes/review.route';
import { statisticsRouter } from './routes/statistics.route';
import { empDormRouter } from './routes/empDorm.route';
// 通知中心（读取侧；写入侧在 utils/notice.ts）
import noticeRouter from './routes/notice.route';

// ---- 教务模块（李思雨/王咏菲）2026-10-03 合并进来 ----
import eduStudentRouter from './routes/eduStudent.route';
import eduStudentImportRouter from './routes/eduStudentImport.route';
import eduDormRouter from './routes/eduDorm.route';
import eduPaymentRouter from './routes/eduPayment.route';

// ---- 大学升实训交接（班级管理 8003 → 实训 8004）2026-10-04 新增 ----
import upgradeRouter from './routes/upgrade.route';

// ---- ★ 班级管理模块（原 8003 · 学管主体）2026-10-04 并入 ----
//    代码整棵搬在 src/class/ 下，路由统一前缀 /api/class/*
import { buildRouters as buildClassRouters } from './class/modules/index';
import { authAllowSync as classAuthAllowSync, authAllowSyncPlus as classAuthAllowSyncPlus } from './class/middleware/auth';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec as classSwaggerSpec } from './class/docs/swagger';
import { dictRouter as classDictRouter } from './class/modules/meta/dict.route';
import { staffRouter as classStaffRouter } from './class/modules/meta/staff.route';
import { ok as classOk } from './class/http/response';

// ---- ★ 教学管理（初高）模块 2026-10-05 并入 ----
//    代码整棵搬在 src/class-jh/ 下，路由统一前缀 /api/class-jh/*
//    ⚠️ 与上面的班级管理（大学部，/api/class/*）【不是同一个模块】：
//       一个是大学部 Q1~Q6，一个是初高中部 J/G 班，各用各的库（sms_class / sms_class_jh）。
import { buildRouters as buildClassJhRouters } from './class-jh/routes/index';
import { authMiddleware as classJhAuth } from './class-jh/middleware/auth';

// ---- ★ 第 2 期「业务域合并」：统一教学接口 /api/teaching/* ----
//    第 1 期只合了菜单（前端），第 2 期开始真正合并代码：
//    一个业务域 = 一套页面 + 一套接口，学段由 stage 参数区分。
//    第一个域：出勤管理（详见 src/teaching/attendance/）。
import { teachingAttendanceRouter } from './teaching/attendance/route';
import { teachingExamRouter } from './teaching/exam/route';
import { teachingScoreRouter } from './teaching/score/route';
import { teachingRefundRouter } from './teaching/refund/route';
import { teachingLeaveRouter } from './teaching/leave/route';
import { teachingStudentRouter } from './teaching/student/route';
import { teachingClassRouter } from './teaching/class/route';
import { teachingTransferRouter } from './teaching/class/transfer.route';
import { teachingDormRouter } from './teaching/dorm/route';
import { teachingDormAllocateRouter } from './teaching/dorm/allocate.route';
// ★ 宿舍楼栋设置（系统设置页与宿舍管理共用的楼栋字典）
import { teachingBuildingRouter } from './teaching/dorm/building.route';
import { denyReadOnlyAdmin } from './teaching/shared/readOnlyGuard';

/* ============================================================
 * ★★ 2026-10-05 统一门户版联调合并
 *
 *   把原「统一门户版」交付包里的四个独立服务整棵搬进本服务：
 *     00-portal  (原 8000) → src/portal   · 统一登录 + 账号
 *     01-consult (原 8001) → src/consult  · 市场咨询
 *     05-finance (原 8005) → src/finance  · 财务管理
 *     06-perm    (原 8006) → src/perm     · 权限管理
 *
 *   ⚠️ 每个模块内部代码 **零改动**（只把 `shared-types` 的裸引用
 *      改成了命名空间子路径 `shared-types/<ns>`），各自的
 *      config / utils/db / middleware / services 都保留原样，
 *      所以四个库（sms_portal/consult/finance/perm）各连各的，
 *      互不干扰 —— 与原来「四个进程」时的行为完全一致。
 *
 *   ⚠️ 四个模块的 app.ts 没有搬（它们是各自进程的入口），
 *      挂载逻辑统一写在本文件下方。
 * ============================================================ */
import path from 'path';
import fs from 'fs';

// ---- 门户（统一登录）----
import portalAccountRouter from './portal/routes/account.route';
// ---- 市场咨询 ----
import { authMiddleware as consultAuth, consultPermGate } from './consult/middleware/auth';
import consultStudentRouter from './consult/routes/student.route';
/** ★ 2026-10-20 试学闭环：咨询侧服务间内部接口（只认 x-internal-token） */
import { consultInternalRouter } from './consult/routes/internal.route';
import consultFeeRouter from './consult/routes/fee.route';
/* ★ 2026-10-16 分期付款路由，挂在 /api/consult/fee/plan 下 */
import consultInstallmentRouter from './consult/routes/installment.route';
import consultRefundRouter from './consult/routes/refund.route';
import consultApproveRouter from './consult/routes/approve.route';
import consultLossRouter from './consult/routes/loss.route';
import consultAccountRouter from './consult/routes/account.route';
// ---- 财务管理 ----
import { authMiddleware as financeAuth } from './finance/middleware/auth';
import financeStudentRouter from './finance/routes/student.route';
import financeAuthRouter from './finance/routes/auth.route';
import financeFeeRouter from './finance/routes/fee.route';
import financeRefundRouter from './finance/routes/refund.route';
import financeFreezeRouter from './finance/routes/freeze.route';
import financeBillRouter, { overviewRouter as financeOverviewRouter } from './finance/routes/bill.route';
import financeStandardRouter from './finance/routes/fee-standard.route';
// ---- 权限管理 ----
import { authMiddleware as permAuth } from './perm/middleware/auth';
import permOverviewRouter from './perm/routes/overview.route';
import permAuthRouter from './perm/routes/auth.route';
import permDeptRouter from './perm/routes/dept.route';
import permRoleRouter from './perm/routes/role.route';
import permUserRouter from './perm/routes/user.route';
import permMenuRouter from './perm/routes/menu.route';
import permAssignRouter from './perm/routes/assign.route';
/* ★ 2026-10-06 新增：页面管理（板块 → 页面 台账） */
import permPageRouter from './perm/routes/page.route';
/* ★ 2026-10-07：给全部账号用的「我能看哪些页面」（宽松鉴权，见 routes/myPaths.route.ts） */
import permMyPathsRouter from './perm/routes/myPaths.route';
import permLogRouter from './perm/routes/log.route';
import permRuleRouter from './perm/routes/rule.route';
import permOptionRouter from './perm/routes/option.route';
import permExportRouter, { EXPORT_DIR as PERM_EXPORT_DIR } from './perm/routes/export.route';
import permRemoteRouter from './perm/routes/remote.route';
import { swaggerSpec as permSwaggerSpec } from './perm/swagger';

const app = express();

// ============================================================
// 基础中间件
// ============================================================

app.use(cors());
// ★ 2026-10-16：复盘「上传录音」上限提到 50MB。
//   音频以 base64 dataURL 走 JSON body 提交 → 50MB 文件 ≈ 66.7MB 请求体，
//   原来 20mb 会被 body-parser 直接拒（PayloadTooLargeError）。
app.use(express.json({ limit: '100mb' }));         // 支持 JSON 请求体
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// 请求日志（开发阶段方便看请求有没有进来）
app.use((req, _res, next) => {
  if (config.env === 'development') {
    console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.originalUrl}`);
  }
  next();
});

// ============================================================
// 健康检查（不鉴权，用于快速确认服务活着）
// ============================================================

app.get('/health', (_req, res) => {
  res.json({
    code: 200,
    message: 'ok',
    data: {
      service: 'server-job',
      port: config.port,
      time: new Date().toISOString(),
    },
  });
});

// ============================================================
// ⭐ 系统管理员「只读」总闸（斌哥 2026-09-30 拍板）
//
//   定位：**系统管理员能看所有页面，但不能做任何写操作。**
//         （校长才是"能看又能操作"的那个角色）
//
//   做法：挂在 /api/job 总前缀上，先解析身份，再拦「写」请求：
//         GET / HEAD / OPTIONS  → 放行
//         其他方法（POST/PUT/DELETE/PATCH） → 纯管理员直接 403
//
//   ⚠️ 「纯管理员」= 角色列表里**只有** ROLE_ADMIN。
//      如果一个人同时是管理员 + 别的业务角色，按业务角色走，不拦。
//   ⚠️ 这里调的 authMiddleware 与下面各子路由里的会重复执行一次 ——
//      重复解析 token 是幂等的，不影响结果，但省掉了在 9 个路由上各挂一遍的漏挂风险。
//   ⚠️ 「权限模块除外」那条：权限管理在 8006，不在本包，所以本包业务全部只读。
// ============================================================

// ---- ★ 升实训交接（大学 8003 → 实训 8004）----
// ⚠️ 必须挂在下面的全局闸【之前】：`/receive` 是服务间调用（带 x-internal-token），
//    没有用户登录态，过不了闸里的 authMiddleware。
//    路由内部自己补了：authMiddleware（/list、/pull）
//                   + 内部令牌校验（/receive）
//                   + 只读管理员校验（/pull，因为绕过了闸，得自己拦一次）
app.use('/api/job/upgrade', upgradeRouter);

// ★ 2026-10-06：`/api/job` 下再叠一道【学管主任只读 + 仅审批可写】闸
//    学管主任（TEACH_DEAN）是审批角色，审批动作（/approve /reject /receive）放行，
//    其余写请求一律 403。详见 middleware/approvalOnly.ts 的说明。
app.use('/api/job', authMiddleware, denyApprovalOnlyWrite, (req, res, next) => {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    next();
    return;
  }

  const roles = req.user?.roles || [];
  const isAdminOnly = roles.length > 0 && roles.every((r: string) => r === RoleCode.SYS_ADMIN);
  if (isAdminOnly) {
    // ⚠️ 已登录但没操作权 → 403（不是 401！401 会让前端跳登录页，用户会懵）
    res.status(403).json({
      code: BizCode.NO_OPERATION_PERMISSION,
      message: '系统管理员是只读账号，不能执行新增/修改/删除',
      data: null,
    });
    return;
  }

  next();
});

// ★ 2026-10-07：job（就业/实训）写接口总闸 —— 权限树 train/job 功能点 → 写接口。
//   挂在粗粒度闸之后：能走到这里的都已过「登录 + 只读拦截」，总闸只叠加权限树的显式改动
//   （显式撤销 → 403，未改动 → 放行）。未登记路径不干预。
app.use('/api/job', jobPermGate);

// ============================================================
// 业务路由
//
// ⚠️ 注意：每个路由都挂了 authMiddleware（统一鉴权）
//    不许在路由内部再写一套登录校验！
//
// ⭐ 2026-09-29 起：业务路由统一加 requirePage(页面权限码)
//    ——「页面权限」在【模块前缀】这一层挂，一次挂全模块都受控，
//      不用去每个接口上补，避免漏挂导致越权查数据。
//    —— 注意区分：
//        requirePage('job:xxx:view')  = 页面级访问权（本层挂）
//        checkPermission('job:xxx:do')= 按钮级操作权（在具体接口上挂）
// ============================================================

// ---- 实训阶段：考试管理 + 成绩管理（马志斌）----
app.use('/api/job/exam', authMiddleware, requirePage('job:exam:view'), examRouter);
app.use('/api/job/exam-score', authMiddleware, requirePage('job:examScore:view'), examScoreRouter);

// ---- 实训阶段：班级信息管理 + 出勤管理（马志斌）----
// ⚠️ 这里用「多码任一」而不是只挂 job:class:view，原因：
//    这个路由下的 `/options`（班级下拉）是**5 个页面共用的公共只读选项** ——
//    出勤、班级交接、考试、成绩、休退学审批都要用它。
//    如果绑死单一权限码，只要某个角色"只开了其中某个页面、却没开班级信息管理"，
//    一进那个页面就会 403（而且页面本身能打开，只是下拉加载失败，看着像 bug）。
//    ★ 2026-10-02 就业老师就是这么踩的：他有「班级管理(交接)」权限、
//      没有「班级信息管理」权限 → 进交接页，班级下拉 403。
//    其余写接口不受影响：删除/结业/撤销等都有各自的 canXxx() 角色判定兜底。
app.use(
  '/api/job/class',
  authMiddleware,
  requireAnyPage([
    'job:class:view',
    'job:classTransfer:view',
    'job:attendance:view',
    'job:exam:view',
    'job:examScore:view',
    'job:suspendApproval:view',
  ]),
  classRouter,
);
app.use('/api/job/class-student', authMiddleware, requirePage('job:classStudent:view'), classStudentRouter);
app.use('/api/job/attendance', authMiddleware, requirePage('job:attendance:view'), attendanceRouter);
app.use('/api/job/class-transfer', authMiddleware, requirePage('job:classTransfer:view'), classTransferRouter);

// ---- 实训阶段：退费（马志斌）----
// ⚠️ 页面是【班主任 / 学管 / 校长】三人共用；
//    班主任看不到审批按钮 —— 前端靠 canApprove 字段，
//    后端靠 refund.route.ts 里 doApprove 的 canApprove() 拦截。
app.use('/api/job/refund', authMiddleware, requirePage('job:refund:view'), refundRouter);

// ---- 实训阶段：休学/退学审批（马志斌）----
// ⚠️ 三人共用页面：班主任发起 / 学管审批 / 校长审批（仅退学）
//    前端靠 canApprove 藏按钮，后端靠 doApprove 的 canApprove() 拦人。
app.use(
  '/api/job/student-leave',
  authMiddleware,
  requirePage('job:suspendApproval:view'),
  studentLeaveRouter,
);

// ---- 实训阶段：宿舍管理（马志斌）----
// ⚠️ 含【宿舍主档 CRUD】+【调换/退宿申请（走审批）】
//    班主任发起 → 教务老师审批（ROLE_EDU_ADMIN，1 步）
//    前端靠 canApprove 藏按钮，后端靠 doApprove 的 canApprove() 拦人。
app.use('/api/job/dorm', authMiddleware, requirePage('job:dorm:view'), dormRouter);

// ---- 实训阶段：催费管理（马志斌）----
// ⚠️ 教务老师发起（推站内信给班主任），班主任只看自己的班。
app.use('/api/job/fee-call', authMiddleware, requirePage('job:feeCall:view'), feeCallRouter);

// ---- 实训阶段：班级信息管理（马志斌）大改 2026-09-30 ----
// ⚠️ 一人一班：页面直接展示"我带的那个班"的学生详细名单，
//    不再需要"班级列表 → 点进去看名单"两步。
//
// ★ 2026-10-02：改为「多码任一」——
//   同一套学员档案接口现在被**两个页面**共用：
//     · 班级信息管理（实训侧）→ job:class:view
//     · 信息档案（就业侧）    → job:empArchive:view
//   只挂一个码的话，另一个页面的人就调不了了。
//   ⚠️ 写操作（update-student）在路由内部另有 assertCanWrite 拦角色，
//      所以"就业老师能读不能写"是靠那里保证的，不是靠这里。
app.use(
  '/api/job/class-info',
  authMiddleware,
  requireAnyPage(['job:class:view', 'job:empArchive:view']),
  classInfoRouter,
);

// ---- 权限（页面访问权，将来对接 8006 权限管理）----
// ⚠️ 这个不能挂 requirePage —— 它就是"查自己有哪些页面权限"的接口，
//    挂了会死循环（没权限的人也得能查自己没权限）。只挂 authMiddleware。
app.use('/api/job/auth', authMiddleware, authRouter);

// ============================================================
// 就业阶段（齐晋霄）—— 2026-10-02 从她的包合并进来
// ============================================================

// ---- 学生基础数据（就业模块搜学生用；就业部分的 StudentSelect 组件依赖）----
app.use('/api/job/student', authMiddleware, studentRouter);

// ---- 就业日志（就业老师记录投递/面试情况）----
app.use(
  '/api/job/employment-log',
  authMiddleware,
  requirePage('job:employmentLog:view'),
  employmentLogRouter,
);

// ---- 就业复盘（面试/复盘结论，含录音）----
app.use('/api/job/review', authMiddleware, requirePage('job:review:view'), reviewRouter);

// ---- 就业数据统计（就业率/OFFER/KPI 目标）----
app.use('/api/job/statistics', authMiddleware, requirePage('job:statistics:view'), statisticsRouter);

// ---- 就业基地宿舍 ----
// ⚠️ 和实训基地宿舍【是两套】—— 两个基地不在同一地点（斌哥 2026-10-02）：
//    实训的走教务审批（/api/job/dorm），就业的直接生效（/api/job/emp-dorm）
app.use('/api/job/emp-dorm', authMiddleware, requirePage('job:empDorm:view'), empDormRouter);

// ---- 通知中心（站内信）----
// ⚠️ 不挂 requirePage —— 消息是所有人的基础能力，且"没权限也得能看通知"
app.use('/api/job/notice', authMiddleware, noticeRouter);

// ============================================================
// 教务模块（李思雨/王咏菲）—— 2026-10-03 从她的包合并进来
//
// ⚠️ 三个关键点：
//   1. 教务的表在【另一个库 sms_edu】，路由里用 `sms_edu.t_xxx` 全限定名访问，
//      但走的是【同一个 db 连接（连 sms_job）】——
//      这样「一个事务同时改 sms_job + sms_edu」才成立（已实测）。
//   2. 页面权限码用 edu: 前缀，与我们 job: 前缀分开，互不干扰。
//   3. /api/edu/student 挂了两个 router（普通 CRUD + Excel 导入），和教务原样一致。
// ============================================================
app.use('/api/edu', authMiddleware, eduPermGate);
app.use('/api/edu/student', authMiddleware, requirePage('edu:student:view'), eduStudentRouter);
app.use('/api/edu/student', authMiddleware, requirePage('edu:student:view'), eduStudentImportRouter);
app.use('/api/edu/dorm', authMiddleware, requirePage('edu:dorm:view'), eduDormRouter);
app.use('/api/edu/payment', authMiddleware, requirePage('edu:fee:view'), eduPaymentRouter);

// ============================================================
// ★ 班级管理模块（原 8003 · 学管主体）2026-10-04 并入
//
//   14 条路由统一前缀 /api/class/*，代码整棵在 src/class/ 下。
//   ⚠️ 认证走班级自己的 authAllowSync（不是我们的 authMiddleware）：
//      · 普通接口 → 解析 token（已兼容主系统开发 token）
//                   + 查库补 classIds（班主任只能看自己班要用）
//      · /sync 结尾 → 走 x-internal-token（模块间同步，不要登录态）
//   页面权限仍由班级自己的 requirePerm('class', 'xxx') 控制。
// ============================================================

// ---- 接口文档（照搬原 8003 的挂载方式）----
app.use('/api/class/docs', swaggerUi.serve, swaggerUi.setup(classSwaggerSpec));
app.get('/api/class/docs.json', (_req, res) => res.json(classSwaggerSpec));

// ---- 公开：枚举字典（前端渲染下拉/标签，无需登录）----
app.use('/api/class/meta', classDictRouter);

// ---- 人员选项：要登录（内部转调 8001）----
app.use('/api/class/meta', classAuthAllowSync, classStaffRouter);

// ---- 业务路由 ----
// ★ 2026-10-06：中间叠一道【学管主任只读 + 仅审批可写】闸（见 middleware/approvalOnly.ts）
for (const r of buildClassRouters()) {
  /**
   * ★ 2026-10-19：待接收学员（/api/class/consult）改成「初高中 + 大学」共用页 ——
   *   初高账号的门户 modules 只有 class-jh，默认会被模块准入挡住，
   *   这一组接口单独放行 class-jh（其它 /api/class/* 仍然只认 class）。
   */
  const authMw = r.path === '/api/class/consult' ? classAuthAllowSyncPlus(['class-jh']) : classAuthAllowSync;
  app.use(r.path, authMw, denyApprovalOnlyWrite, r.router);
}

// ---- 当前登录人（班级前端启动时拉一次，拿数据范围与可见班级）----
// ★ 2026-10-19：待接收学员是初高/大学共用页，初高账号也要能拉这个上下文
//   （否则页面一打开就弹「没有访问班级管理模块的权限」，且拿不到 classIds）
app.get('/api/class/me', classAuthAllowSyncPlus(['class-jh']), (req, res) => {
  const u = (req as any).user;
  if (!u) return classOk(res, null, '未登录');
  return classOk(
    res,
    {
      userId: u.userId,
      userName: u.userName,
      roles: u.roles,
      deptCode: u.deptCode,
      dataScope: u.dataScope,
      classIds: u.classIds,
    },
    '查询成功',
  );
});

// ============================================================
// ★★ 2026-10-05 联调合并：门户 / 市场咨询 / 财务 / 权限
//
//   挂载前缀与原来的独立服务 **逐字一致**（/api/portal、/api/consult、
//   /api/finance、/api/perm），所以：
//     · 各模块的前端代码不需要改接口地址
//     · 模块之间原有的跨模块 HTTP 调用，只要把 *_URL 指向本服务即可
//       （见 .env：六个 URL 全部指向 http://localhost:8004）
// ============================================================

/* ---- ① 统一门户：登录 + 账号维护（/api/portal/account）---- */
app.use('/api/portal/account', portalAccountRouter);

/* ---- ② 市场咨询（原 8001）---- */
/**
 * ★ 2026-10-07：中间插入 `consultPermGate` —— 让「职位权限分配」的改动
 *   真正传导到咨询模块的写接口（原先这些接口只认岗位角色，不认权限树）。
 *   ⚠️ 它只对「权限树里被管理员显式撤销过的动作」生效，其余一律放行
 *      （差异存储，与班级 / 初高 / 财务三模块同一口径）。
 */
/**
 * ★ 2026-10-20 试学闭环：服务间内部接口（/api/consult/student/internal/*）
 *
 * 为什么必须挂在登录态路由【之前】：
 *   班主任属于班级模块，他的 token 在咨询侧解不出咨询岗位，走 consultAuth 会 401。
 *   而「试学结束由班主任发起补费」「退学通过后回写咨询状态」这两个动作必须跨模块调用。
 *
 * 鉴权由 internal.route.ts 自己校验 x-internal-token（见文件头注释）。
 */
app.use('/api/consult/student/internal', consultInternalRouter);
app.use('/api/consult/student', consultAuth, consultPermGate, consultStudentRouter);
app.use('/api/consult/fee', consultAuth, consultPermGate, consultFeeRouter);
app.use('/api/consult/fee/plan', consultAuth, consultPermGate, consultInstallmentRouter);
app.use('/api/consult/refund', consultAuth, consultPermGate, consultRefundRouter);
app.use('/api/consult/approve', consultAuth, consultPermGate, consultApproveRouter);
app.use('/api/consult/loss', consultAuth, consultPermGate, consultLossRouter);
app.use('/api/consult/account', consultAuth, consultPermGate, consultAccountRouter);

/* ---- ③ 财务管理（原 8005）---- */
app.use('/api/finance/student', financeAuth, financeStudentRouter);
// ⚠️ /auth 不挂全局 authMiddleware —— 路由内部自己挂（原样保留）
app.use('/api/finance/auth', financeAuthRouter);
app.use('/api/finance/fee', financeAuth, financeFeeRouter);
app.use('/api/finance/refund', financeAuth, financeRefundRouter);
app.use('/api/finance/freeze', financeAuth, financeFreezeRouter);
app.use('/api/finance/bill', financeAuth, financeBillRouter);
app.use('/api/finance/standard', financeAuth, financeStandardRouter);
// 财务概览：路径是 /api/finance/overview（不带子资源）—— 必须放在上面几条之后
app.use('/api/finance', financeAuth, financeOverviewRouter);

/* ---- ④ 权限管理（原 8006）---- */
// 接口文档（不鉴权）
app.get('/api-docs.json', (_req, res) => {
  res.json(permSwaggerSpec);
});
app.use(
  '/api-docs',
  swaggerUi.serve,
  swaggerUi.setup(permSwaggerSpec, {
    customSiteTitle: '学管系统 · 权限管理 接口文档',
    swaggerOptions: { persistAuthorization: true, docExpansion: 'list', defaultModelsExpandDepth: 1 },
  }),
);
// 导出文件下载（静态，不鉴权）
try {
  fs.mkdirSync(PERM_EXPORT_DIR, { recursive: true });
} catch {
  /* 目录已存在或无权限时忽略，首次导出时会再建 */
}
app.use('/api/perm/export/download', express.static(path.resolve(PERM_EXPORT_DIR)));

app.use('/api/perm/auth', permAuthRouter);
app.use('/api/perm/overview', permAuth, permOverviewRouter);
app.use('/api/perm/dept', permAuth, permDeptRouter);
app.use('/api/perm/role', permAuth, permRoleRouter);
app.use('/api/perm/user', permAuth, permUserRouter);
app.use('/api/perm/menu', permAuth, permMenuRouter);
app.use('/api/perm/assign', permAuth, permAssignRouter);
/* ★ 2026-10-07 新增：给**全部账号**用的页面清单接口
 *
 * ⚠️ 必须挂在 /api/perm/page 之前 —— Express 是按顺序匹配的，
 *    放到 permAuth 那个 use 后面就会被它先接走（非 perm 账号一律 403）。
 *    用主鉴权（只验 JWT，不要求 perm 模块），因为「左侧菜单要不要渲染这个页面」
 *    是每个账号都要问的问题，见 perm/routes/myPaths.route.ts 的文件头。
 */
app.use('/api/perm/page/my-paths', authMiddleware, permMyPathsRouter);
/* ★ 2026-10-06 新增：页面管理（GET /list · GET /enabled-paths · PUT /save · POST /reset）
 * ★ 2026-10-07 扩展：角色页面台账（GET /role-tree · /role-pages · PUT /role-save · POST /role-reset） */
app.use('/api/perm/page', permAuth, permPageRouter);
app.use('/api/perm/log', permAuth, permLogRouter);
app.use('/api/perm/rule', permAuth, permRuleRouter);
app.use('/api/perm/option', permAuth, permOptionRouter);
app.use('/api/perm/export', permAuth, permExportRouter);
// ⚠️ 跨模块路由【故意不加 authMiddleware】—— 它是登录链路的一环，
//    调用者此时还没有 token（原样保留，见原 server-perm/src/app.ts 的注释）
app.use('/api/perm/remote', permRemoteRouter);

/* ---- ⑤ 静态资源：缴费凭证图片（咨询 + 财务共用同一个 uploads 目录）----
 *
 * 原交付包里咨询(8001)与财务(8005)各自挂了一个 /uploads，指向各自工程的
 * uploads 目录，靠「上传时双写」保证两边都能访问。
 * 合并成一个进程后，双写没有必要 —— 统一指向 server-job/uploads。
 * （咨询侧的写盘路径已改为 process.cwd()/uploads/voucher，见 consult 的说明）
 */
const MERGED_UPLOAD_ROOT = path.resolve(__dirname, '../uploads');
app.use(
  '/uploads',
  express.static(MERGED_UPLOAD_ROOT, {
    dotfiles: 'deny',
    index: false,
    maxAge: '7d',
    fallthrough: true,
    setHeaders(res, filePath) {
      if (!/\.(jpg|jpeg|png|gif|webp)$/i.test(filePath)) return;
      res.setHeader('Cache-Control', 'private, max-age=604800');
      res.setHeader('X-Content-Type-Options', 'nosniff');
    },
  }),
);
app.use('/uploads', (req, res) => {
  res.status(404).json({
    code: 40404,
    message: `凭证文件不存在：${req.originalUrl}`,
    data: null,
  });
});

// ============================================================
// ★ 教学管理（初高）模块（原 server-class 8003 的另一套）
//
//   2026-10-05 并入。66 个接口统一前缀 /api/class-jh/*。
//
//   ⚠️ 前缀为什么不是 /api/class：
//      系统里已经有一套【大学部】班级管理占着 /api/class（见上面那段），
//      而且两套模块的表名高度重合（t_class_info / t_class_student / …）
//      却装在不同的库（sms_class vs sms_class_jh）。
//      放同一个前缀下会互相抢路由，所以整体加 -jh 后缀区分。
//
//   鉴权走本模块自己的 authMiddleware（见 src/class-jh/middleware/auth.ts）：
//      · 验签用主工程的 JWT_SECRET（门户签发的 token 直接可用）
//      · 角色码做新→老归一化，再把门户里的权限点作为「加分项」，
//        认不到就按角色兜底（否则 64 个写操作会全 403）
// ============================================================

// 健康检查（本模块自己的，便于确认这一块活了）
// ⚠️ 必须放在下面的挂载循环【之前】：
//    handoverRouter 挂在 /api/class-jh 这一层且带鉴权，
//    放它后面的话 /api/class-jh/health 会先被鉴权拦成 401（不带 token 探不到死活）。
app.get('/api/class-jh/health', (_req, res) => {
  res.json({ code: 200, message: 'ok', data: { module: 'class-jh', time: new Date().toISOString() } });
});

// ★ 2026-10-06：同样叠一道【学管主任只读 + 仅审批可写】闸
for (const r of buildClassJhRouters()) {
  app.use(r.path, classJhAuth, denyApprovalOnlyWrite, r.router);
}

// ============================================================
// ★ 第 2 期「业务域合并」：统一教学接口 /api/teaching/attendance/*
//
//   背景：合并前「出勤管理」有三套（初高 /api/class-jh、大学 /api/class、
//         实训 /api/job），同一件事三个名字、三套表、**状态码还互相冲突**
//         （初高的「迟到」是 2，实训的「迟到」是 3）。
//   现在：一套接口，用 `stage=jh|class|job` 区分学段。
//
//   四道闸，缺一不可：
//     ① authMiddleware          —— 验签（门户 JWT）
//     ② 只读管理员拦截           —— 系统管理员 GET 放行、写请求 403
//     ③ denyApprovalOnlyWrite   —— 学管主任（审批角色）只读，仅审批可写
//     ④ requireAnyPage([三码])  —— 三个学段的出勤页面权限，**任一**即可进
//                                  （进了之后"能看哪个学段"由 service.ts 的
//                                    assertStageView 按学段再校验一次）
//
//   ⚠️ 老接口（/api/class-jh/attendance、/api/class/attendance、
//      /api/job/attendance）一个都没删，作为观察期回退通道，一个迭代后下线。
// ============================================================
// ★ 第 2 期「业务域合并」：统一教学接口 /api/teaching/<域>/*
//   四道闸：验签 → 只读管理员拦截 → 学管主任只读闸 → 三学段任一页面权限
//   （进了之后"能看哪个学段"由各域 service 的 assertStageView 按学段再校验）
app.use(
  '/api/teaching/attendance',
  authMiddleware,
  denyReadOnlyAdmin,
  denyApprovalOnlyWrite,
  requireAnyPage(['classjh:attendance:view', 'class:attendance:view', 'job:attendance:view']),
  teachingAttendanceRouter,
);

// ★ 考试管理（第二个合并的业务域）—— 结构完全同构
//   ★ 2026-10-15 补 `job:examScore:view`：
//     成绩管理页（/teaching/score）要给「考试下拉」读考试列表，调的是本域
//     `GET /api/teaching/exam/list`。但项目经理/班主任/教员/助教手里只有**成绩码**
//     `job:examScore:view`，没有**考试管理码** `job:exam:view`（那个是校长专用）——
//     于是他们一进成绩管理页就弹「您没有该操作的权限」（实测）。
//     这与 examScore.route.ts 头部记载的历史坑**完全同源**（当年靠单开 exam-options 规避，
//     第 2 期统一接口后规避失效，老 bug 复现）。
//     业务上「能看成绩 → 就必须能读到该学段的考试列表来选考试」，故把成绩码并入白名单。
//     ⚠️ 这只是放宽「进本域」；真正的数据范围仍由 service.ts 的 visibleStages/assertStageView
//        按学段再校验一次，读不到非本学段的考试。
app.use(
  '/api/teaching/exam',
  authMiddleware,
  denyReadOnlyAdmin,
  denyApprovalOnlyWrite,
  requireAnyPage([
    'classjh:exam:view',
    'class:exam:view',
    'job:exam:view',
    'job:examScore:view',
  ]),
  teachingExamRouter,
);

// ★ 成绩管理（第三个合并的业务域）
//   ⚠️ 权限码三套写法都不同：classjh:score:view / class:grade:view / job:examScore:view
app.use(
  '/api/teaching/score',
  authMiddleware,
  denyReadOnlyAdmin,
  denyApprovalOnlyWrite,
  requireAnyPage(['classjh:score:view', 'class:grade:view', 'job:examScore:view']),
  teachingScoreRouter,
);

// ★ 退费（第四个合并的业务域）
//   ★★ 审批链统一采用「实训那一套」（斌哥 2026-10-09 拍板）：
//      班主任/项目经理发起 → 学管审批 → 校长审批 → 通过后通知财务出款。
//      初高/大学原来的「待教务核算 / 待财务出款」中间节点**不再产生**。
app.use(
  '/api/teaching/refund',
  authMiddleware,
  denyReadOnlyAdmin,
  denyApprovalOnlyWrite,
  requireAnyPage(['classjh:refund:view', 'class:refund:view', 'job:refund:view']),
  teachingRefundRouter,
);

// ★ 休学 / 退学 / 复学审批（第五个合并的业务域）
//   ★ 审批链同样统一采用实训那一套（休学/复学 1 步；退学 2 步：学管 → 校长）
//   权限码：classjh:approval:view / class:suspend:view / job:suspendApproval:view
app.use(
  '/api/teaching/leave',
  authMiddleware,
  denyReadOnlyAdmin,
  denyApprovalOnlyWrite,
  requireAnyPage(['classjh:approval:view', 'class:suspend:view', 'job:suspendApproval:view']),
  teachingLeaveRouter,
);

// ★ 学生档案（第六个合并的业务域）—— 三个学段：初高 / 大学 / 就业部
//   ★ 2026-10-21 用户口径：学生档案界面删除「就业」「教务」两个入口
//     （edu:student:view 从这里摘掉 —— 教务模块自己的页面还在，只是不再进学生档案）
//   权限码：classjh:student:view / class:student:view / job:empArchive:view
app.use(
  '/api/teaching/student',
  authMiddleware,
  denyReadOnlyAdmin,
  denyApprovalOnlyWrite,
  requireAnyPage(['classjh:student:view', 'class:student:view', 'job:empArchive:view']),
  teachingStudentRouter,
);

// ★ 班级信息（第七个合并的业务域）
//   权限码：classjh:classInfo:view / class:info:view / job:class:view
//   ⚠️ 这三个权限码要**先在权限库里查准** —— 各学段原页面的码不完全一致，
//      写错会导致「菜单在但进不去」或反之。
app.use(
  '/api/teaching/class',
  authMiddleware,
  denyReadOnlyAdmin,
  denyApprovalOnlyWrite,
  requireAnyPage(['classjh:classInfo:view', 'class:info:view', 'job:class:view']),
  teachingClassRouter,
);

// ★ 学生换班（末班 / 升班）
//   ⚠️ 入口在「成绩管理」页，如果挂在 /api/teaching/class 下，
//      只有成绩权限（class:grade:view）的老师会被班级查看权限拦成 403。
//      这里单独一个前缀，两组权限码都放行。
app.use(
  '/api/teaching/class-transfer',
  authMiddleware,
  denyReadOnlyAdmin,
  denyApprovalOnlyWrite,
  requireAnyPage([
    'classjh:score:view',
    'class:grade:view',
    'job:examScore:view',
    'classjh:classInfo:view',
    'class:info:view',
    'job:class:view',
  ]),
  teachingTransferRouter,
);

  /**
   * ★ 班级宿舍分派（宿舍管理的子页面）
   *
   * 必须挂在 `/api/teaching/dorm` **之前** —— 后者会把 `/allocate/*`
   * 一并吃进 teachingDormRouter（没有匹配路由时才 next() 到后面），
   * 提前挂载可以避免依赖 fallthrough 的隐式行为。
   *
   * 权限码与宿舍域完全一致（教务老师已有 classjh:dorm:view），不新增权限点。
   */
  app.use(
  '/api/teaching/dorm/allocate',
  authMiddleware,
  denyReadOnlyAdmin,
  denyApprovalOnlyWrite,
  requireAnyPage(['classjh:dorm:view', 'class:dorm:view', 'job:dorm:view']),
  teachingDormAllocateRouter,
);

  app.use(
  '/api/teaching/dorm',
  authMiddleware,
  denyReadOnlyAdmin,
  denyApprovalOnlyWrite,
  requireAnyPage(['classjh:dorm:view', 'class:dorm:view', 'job:dorm:view']),
  teachingDormRouter,
);

  /**
   * ★ 宿舍楼栋设置 · /api/teaching/building/*
   *
   * 【为什么权限码是 4 个而不是 dorm 那 3 个】
   *   两个入口共用这一份字典：
   *     ① 教学管理 → 系统设置 → 楼栋设置页签   → classjh:setting:view
   *     ② 教学管理 → 宿舍管理 → 楼栋下拉       → classjh/class/job 的 dorm:view
   *   只挂 ① 会让「有宿舍权限、没设置权限」的用户拉不到下拉；
   *   只挂 ② 会让「有设置权限、没宿舍权限」的用户打不开设置页。
   *   → 两边都放行：看得见楼栋的人就能读，写操作另有只读管理员/学管主任两道闸。
   */
  app.use(
  '/api/teaching/building',
  authMiddleware,
  denyReadOnlyAdmin,
  denyApprovalOnlyWrite,
  requireAnyPage([
    'classjh:setting:view',
    'classjh:dorm:view',
    'class:dorm:view',
    'job:dorm:view',
  ]),
  teachingBuildingRouter,
);

// ============================================================
// 404 处理（放在所有路由之后）
// ============================================================

app.use((req, res) => {
  res.status(404).json({
    code: 40401,
    message: `接口不存在：${req.method} ${req.originalUrl}`,
    data: null,
  });
});

// ============================================================
// 统一错误处理（必须放最后！）
// ============================================================

app.use(errorHandler);

// ============================================================
// 启动
// ============================================================

app.listen(config.port, () => {
  console.log('');
  console.log('══════════════════════════════════════════');
  console.log(`  学管系统 · 就业管理 后端服务已启动`);
  console.log(`  服务标识：server-job`);
  console.log(`  端口：${config.port}`);
  console.log(`  环境：${config.env}`);
  console.log(`  数据库：${config.db.host}:${config.db.port}/${config.db.database}`);
  console.log('');
  console.log(`  健康检查：http://localhost:${config.port}/health`);
  console.log(`  接口示例：http://localhost:${config.port}/api/job/class-info/my-class`);
  console.log('══════════════════════════════════════════');
  console.log('');
});
