/**
 * 班级管理路由（就业管理 > 实训阶段）
 *
 * 接口前缀：/api/job/class
 * 表：t_job_class（班级主档）
 * 字段依据：docs/班级信息+出勤-字段定稿.md 第一节
 *
 * ⚠️ 核心规则：
 *   1. 班级编号 class_code 全局唯一（重复报 40004）
 *   2. 同部门内班级名称不可重名（重复报 40005）
 *   3. 班级人数 student_count 由花名册实时统计，不手填
 *   4. 封班的班只接受休学/末次班学生转入（在花名册接口里校验）
 *   5. 已结业的班不允许再加学生
 */

import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { BizCode, CLASS_STATUS_NAME, CLASS_STAGE_NAME, RoleCode, hasRole } from 'shared-types';
import { ok, page } from '../utils/response';
import { db } from '../utils/db';
import { wrap } from '../utils/wrap';
import { today, fmtDate } from '../utils/date';
import { validate } from '../middleware/validate';
import { checkPermission, SUPER_TEST_ROLE } from '../middleware/auth';
import { BizError } from '../middleware/errorHandler';
import type { Operator } from '../utils/approval';
import { graduateClass, previewGraduate, revokeGraduate } from '../utils/graduate';
import { resolveActionWithOverlay } from '../utils/roleActionOverlay';
// ★ P3 切读层：本文件 4 张表（t_job_class / t_job_class_student / t_student_base /
//   t_job_attendance_summary）均已在 UNI_MAP 登记，全部走 tbl()/tblIns() 路由；
//   开关关时与原实现等价。
import { tbl, tblIns, phaseCodeCol, phaseCodeSelect, readPhaseCode } from '../teaching/shared/uniTable';

export const classRouter = Router();

/** 表名常量 */
const TABLE = 't_job_class';
const CS_TABLE = 't_job_class_student';       // 花名册
const STUDENT_TABLE = 't_student_base';       // 学生主档
const SUMMARY_TABLE = 't_job_attendance_summary'; // 出勤汇总（取今日出勤率）

/** ★ 统一表 edu_stage 取值（本路由只服务实训 → sms_job） */
const STAGE = 'job' as const;
const DB = 'sms_job';

/** 部门名映射（数据字典固定：1初高部 2大学部） */
const DEPT_NAME: Record<number, string> = { 1: '初高部', 2: '大学部' };

/** 班级状态常量 */
const STATUS_OPEN = 1;
const STATUS_SEALED = 2;
const STATUS_PENDING_GRADUATE = 3;
const STATUS_GRADUATED = 4;

/**
 * 谁能删除班级？
 *
 * ⚠️ 斌哥 2026-09-30 拍板：**班主任没有删除班级的权限** ——
 *    删除是管理动作，班主任只负责带班，不该能删。
 *
 * 【为什么用「角色白名单」而不是权限码 checkPermission()】
 *   权限管理模块（8006）还没接上，`user.permissions` 在开发环境下只有
 *   管理员拿到 `['*']`，其他角色一律是空数组 —— 用权限码的话，
 *   会变成「除了管理员谁都不能删」，连校长都删不了，表达不了真实意图。
 *   等 8006 接上后，可以改成 checkPermission('job:class:delete')。
 */
const CLASS_DELETE_ROLES: string[] = [
  RoleCode.RM_PRINCIPAL,
  RoleCode.ACAD_STAFF,
  // ★ 2026-10-06 移除 TEACH_DEAN（学管主任）：
  //   学管是审批角色，只审不写 —— 删班属业务写操作，不再给他。
  //   （更外层还有 middleware/approvalOnly.ts 的「只读 + 仅审批可写」总闸兜底。）
];

// ⚠️ 故意**不含** RoleCode.SYS_ADMIN：
//    系统管理员是【只读】账号（斌哥 2026-09-30），app.ts 的总闸会拦掉他的写请求。
//    所以这里也不能放行 —— 否则前端会显示删除按钮，点下去才报 403，体验很糟。

/** 该角色组合能不能删班级 */
function canDeleteClass(roles: string[]): boolean {
  // ★ 万能测试号（SUPER_TEST）：权限模块未接前要能验证全流程，先放行
  if (roles.includes(SUPER_TEST_ROLE)) return true;
  return roles.some((r) => CLASS_DELETE_ROLES.includes(r));
}

/**
 * 谁能「结业」？
 *
 * 斌哥 2026-10-01：结业 = 一个按钮，点下去**班级结业 + 全班转就业**（不走审批）。
 * 因为它一次性改一批学生的状态、还会生成退宿申请和住宿费退费单，影响面大。
 * ⚠️ 不含教务老师（教务在班级信息页是只读），不含系统管理员（只读账号）。
 *
 * ★ 2026-10-04 更新（交棒模型）：发起人见下方 CLASS_GRADUATE_ROLES。
 */
/**
 * 「结业转就业」发起人（★ 2026-10-04 斌哥拍板：交棒②由原负责人发起）
 *
 *   - 项目经理（**仅限自己带的班**，数据范围另校验）—— 实训阶段的责任人
 *   - 校长（管理动作，不受交棒影响）
 * ⚠️ 班主任不再能结业 —— 升实训时已交棒，实训班不归他管了。
 * ⚠️ ★ 2026-10-06 移除学管主任 —— 他是审批角色，结业是业务写操作，
 *    学管只看不办（总闸 middleware/approvalOnly.ts 也会拦）。
 */
const CLASS_GRADUATE_ROLES: string[] = [
  RoleCode.RM_PRINCIPAL,
  RoleCode.PROJECT_MANAGER,
];

/**
 * 谁能「结业转就业」？
 *
 * ★★ 2026-10-08 修复两处 bug（斌哥报「项目经理勾了转就业权限却还是转不了」）：
 *
 *   ① **裸 `includes` → 改用 `hasRole`（别名感知）**
 *      原来写的是 `CLASS_GRADUATE_ROLES.includes(r)` —— 直接拿**原始角色码**
 *      去比。项目经理在权限库里的角色码是 `RM_PROJECT`，而白名单里写的是
 *      主包码 `PROJECT_MANAGER`，两者对不上 → **项目经理永远转不了就业**。
 *      （同文件 `assertMyClassIfTeacher` 早在 2026-10-08 就改成 hasRole 了，
 *       这里是同一次改造的漏网之处。）
 *
 *   ② **叠加权限树（overlay）**
 *      管理员在「职位权限分配」里勾了「实训-班级信息 → 结业转就业」，
 *      应当对该角色生效 —— 这条对**自建角色**尤其关键：
 *      像 `XMJL_000`（项目经理2）不在任何代码白名单里，权限树是它唯一的授权来源。
 *      映射表见 `utils/roleActionOverlay.ts` 的 `train||实训-班级信息`。
 *
 *   ⚠️ overlay 是**差异存储**：没被管理员改动过的角色，行为与从前完全一致。
 */
function canGraduateClass(roles: string[]): boolean {
  // ★ 万能测试号（SUPER_TEST）：业务验证用，全部放行
  if (roles.includes(SUPER_TEST_ROLE)) return true;
  return resolveActionWithOverlay(roles, 'job:class:graduate', (r) =>
    CLASS_GRADUATE_ROLES.some((allowed) => hasRole([r], allowed)),
  );
}

/**
 * 谁能「撤销结业」？
 *
 * 斌哥 2026-10-01 拍板：**只给校长**。
 * 这是个"批量回滚 + 改一批学生状态"的危险动作，口子开小一点。
 *
 * ★ 2026-10-08：同 canGraduateClass —— 改用 hasRole（别名感知）
 *   并叠加权限树（`job:class:graduate-revoke`）。
 */
function canRevokeGraduate(roles: string[]): boolean {
  // ★ 万能测试号（SUPER_TEST）：业务验证用，全部放行
  if (roles.includes(SUPER_TEST_ROLE)) return true;
  return resolveActionWithOverlay(roles, 'job:class:graduate-revoke', (r) =>
    hasRole([r], RoleCode.RM_PRINCIPAL),
  );
}

/** 从 req 提取操作人 */
function getOperator(req: any): Operator {
  const u = req.user || {};
  return {
    userId: u.userId || u.id || '',
    userName: u.userName || u.name || '',
    roles: u.roles || [],
  };
}

/** 班主任只能操作自己带的班（口径：班级表 head_teacher_id） */
/**
 * 「只限自己带的班」校验（★ 2026-10-04 交棒模型）
 *
 *   项目经理（且不含校长/学管）→ 必须是该班 project_manager
 *   班主任（legacy）           → 必须是该班 head_teacher
 *   校长 / 学管                → 不限
 */
function assertMyClassIfTeacher(roles: string[], userId: string, cls: any): void {
  const isFullAccess =
    hasRole(roles, RoleCode.RM_PRINCIPAL) || hasRole(roles, RoleCode.TEACH_DEAN);
  if (isFullAccess) return;

  // ★ 2026-10-08：改用 hasRole（别名感知）—— 项目经理在权限库里是 RM_PROJECT
  if (hasRole(roles, RoleCode.PROJECT_MANAGER)) {
    if (cls.project_manager_id !== userId) {
      throw new BizError(BizCode.NO_OPERATION_PERMISSION, '只能操作自己带的实训班级');
    }
    return;
  }
  if (hasRole(roles, RoleCode.TEACH_HEAD) && cls.head_teacher_id !== userId) {
    throw new BizError(BizCode.NO_OPERATION_PERMISSION, '只能操作自己带的班级');
  }
}

/** 给班级行补上「双返回」名称字段（输出用小驼峰，符合接口契约） */
function decorate(row: any): any {
  if (!row) return row;
  return {
    ...row,
    className: row.class_name,
    classCode: row.class_code,
    deptCode: row.dept_code,
    // ★ #23 方案B：阶段码一律走 readPhaseCode（统一表权威列是 stage_code）
    stage: readPhaseCode(row),
    headTeacherId: row.head_teacher_id,
    headTeacherName: row.head_teacher_name,
    teacherId: row.teacher_id,
    teacherName: row.teacher_name,
    assistantId: row.assistant_id,
    assistantName: row.assistant_name,
    // ★ 2026-10-04 交棒模型：5 个岗位都要返回
    //   之前漏了 projectManager / employmentTeacher，导致项目经理登录后
    //   在班级列表上看不到「这个班是我负责的」，像是没数据。
    projectManagerId: row.project_manager_id,
    projectManagerName: row.project_manager_name,
    employmentTeacherId: row.employment_teacher_id,
    employmentTeacherName: row.employment_teacher_name,
    universityNo: row.university_no,
    classroom: row.classroom,
    openDate: fmtDate(row.open_date),
    closeDate: fmtDate(row.close_date),
    studentCount: row.student_count,
    classStatus: row.class_status,
    attendanceRate: row.attendance_rate,
    remark: row.remark,
    createTime: row.create_time,
    updateTime: row.update_time,
    deptName: DEPT_NAME[row.dept_code] || '',
    stageName: CLASS_STAGE_NAME[readPhaseCode(row)] || '',
    classStatusName: CLASS_STATUS_NAME[row.class_status] || '',
  };
}

/**
 * 生成班级编号：SX + 年 + 3位序号，如 SX2026001
 * 规则：找当年最大序号 +1
 */
async function genClassCode(): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `SX${year}`;
  const rows = await tbl(db, DB, TABLE, STAGE)
    .where('class_code', 'like', `${prefix}%`)
    .orderBy('class_code', 'desc')
    .limit(1)
    .select('class_code');
  let seq = 1;
  if (rows.length) {
    const last = String(rows[0].class_code).replace(prefix, '');
    const n = parseInt(last, 10);
    if (!Number.isNaN(n)) seq = n + 1;
  }
  return `${prefix}${String(seq).padStart(3, '0')}`;
}

/* ============================================================
 * 1. 查询班级列表
 *    GET /api/job/class/page
 * ============================================================ */

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
  className: z.string().optional(),
  classCode: z.string().optional(),
  classStatus: z.coerce.number().int().optional(),
  deptCode: z.coerce.number().int().optional(),
  stage: z.coerce.number().int().optional(),
  headTeacherId: z.string().optional(),
});

classRouter.get(
  '/page',
  validate(listSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as z.infer<typeof listSchema>;

    const query = tbl(db, DB, TABLE, STAGE).where('is_deleted', false);
    if (q.className) query.andWhere('class_name', 'like', `%${q.className}%`);
    if (q.classCode) query.andWhere('class_code', 'like', `%${q.classCode}%`);
    if (q.classStatus) query.andWhere('class_status', q.classStatus);
    if (q.deptCode) query.andWhere('dept_code', q.deptCode);
    if (q.stage) query.andWhere(phaseCodeCol(), q.stage);
    if (q.headTeacherId) query.andWhere('head_teacher_id', q.headTeacherId);

    // ★ tbl() 的聚合返回值需显式断言（与 exam.route.ts / repo.job.ts 同款写法）
    const [{ total }] = (await query.clone().count({ total: '*' })) as Array<Record<string, any>>;

    const rows = await query
      .clone()
      .select('*')
      .orderBy('class_status', 'asc')
      .orderBy('open_date', 'desc')
      .limit(q.size)
      .offset((q.page - 1) * q.size);

    // 批量取今日出勤率（避免 N+1 查询）
    const ids = rows.map((r: any) => r.id);
    let rateMap: Record<string, number> = {};
    if (ids.length) {
      const sums = await tbl(db, DB, SUMMARY_TABLE, STAGE)
        .whereIn('class_id', ids)
        .andWhere('attend_date', today())
        .andWhere('is_deleted', false)
        .select('class_id', 'attendance_rate');
      rateMap = sums.reduce((acc: any, s: any) => {
        acc[s.class_id] = s.attendance_rate;
        return acc;
      }, {});
    }

    // ⭐ 能不能删班级（班主任没有这个权限，见文件头 CLASS_DELETE_ROLES 注释）
    //    由后端算好给前端，前端只管按它显隐按钮 —— 与宿舍/退费的 canApprove 同一套做法
    const canDelete = canDeleteClass(req.user?.roles || []);

    const list = rows.map((r: any) => {
      const d = decorate(r);
      return {
        id: d.id,
        className: d.className,
        classCode: d.classCode,
        deptCode: d.deptCode,
        deptName: d.deptName,
        stage: d.stage,
        stageName: d.stageName,
        headTeacherName: d.headTeacherName,
        teacherName: d.teacherName,
        // ★ 2026-10-04 交棒模型：项目经理 / 就业指导老师要在列表上显示
        //   （项目经理靠这个确认「哪些班是我带的」）
        projectManagerId: d.projectManagerId,
        projectManagerName: d.projectManagerName,
        employmentTeacherId: d.employmentTeacherId,
        employmentTeacherName: d.employmentTeacherName,
        universityNo: d.universityNo,
        classroom: d.classroom,
        openDate: d.openDate,
        studentCount: d.studentCount,
        classStatus: d.classStatus,
        classStatusName: d.classStatusName,
        todayAttendanceRate: rateMap[d.id] ?? null,
        remark: d.remark,
        canDelete,
      };
    });

    res.json(page(list, Number(total), q));
  }),
);

/* ============================================================
 * 2. 班级详情
 *    GET /api/job/class/detail?id=xxx
 * ============================================================ */

classRouter.get(
  '/detail',
  validate(z.object({ id: z.string().min(1) })),
  wrap(async (req, res) => {
    const { id } = (req as any).validated;
    const row = await tbl(db, DB, TABLE, STAGE).where({ id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.CLASS_NOT_FOUND, '班级不存在');

    const d = decorate(row);
    // 顺带带出今日出勤率
    const sum = await tbl(db, DB, SUMMARY_TABLE, STAGE)
      .where({ class_id: id, attend_date: today(), is_deleted: false })
      .first();
    res.json(ok({ ...d, todayAttendanceRate: sum?.attendance_rate ?? null }));
  }),
);

/* ============================================================
 * 3. 班级下拉选项（给考试选班等场景用）
 *    GET /api/job/class/options
 *    默认只返回「开放」的班（结业/封班的班不该出现在考试选班里）
 * ============================================================ */

classRouter.get(
  '/options',
  validate(
    z.object({
      deptCode: z.coerce.number().int().optional(),
      /** 是否含非开放状态的班（补考、查历史时可能要） */
      includeAll: z.coerce.boolean().optional(),
    }),
  ),
  wrap(async (req, res) => {
    const q = (req as any).validated;
    const query = tbl(db, DB, TABLE, STAGE).where('is_deleted', false);
    // ★ 2026-10-02（斌哥）：实训/就业阶段的班级**只有「封班」和「已结业」两种状态**，不再有"开放"。
    //   ⚠️ 这里原来按"开放(class_status=1)"过滤 —— 现在所有班都是封班，
    //      不改的话这个下拉会**一个班都出不来**。改成"排除已结业"。
    if (!q.includeAll) query.whereNot('class_status', STATUS_GRADUATED);
    if (q.deptCode) query.andWhere('dept_code', q.deptCode);

    const rows = await query
      .select(
        'id',
        'class_name',
        'class_code',
        'dept_code',
        // ★ #23 方案B：显式列清单里必须换列名（别名保持 stage，下游 r.stage 不变）
        phaseCodeSelect({ alias: 'stage' }),
        'class_status',
        'student_count',
        // ★ 2026-10-04：交接班下拉要显示「现在谁在管这个班」→ 必须带上 5 个岗位
        'head_teacher_id',
        'head_teacher_name',
        'teacher_id',
        'teacher_name',
        'assistant_id',
        'assistant_name',
        'project_manager_id',
        'project_manager_name',
        'employment_teacher_id',
        'employment_teacher_name',
        'university_no',
      )
      .orderBy('class_name', 'asc');

    res.json(
      ok(
        rows.map((r: any) => ({
          id: r.id,
          className: r.class_name,
          classCode: r.class_code,
          deptCode: r.dept_code,
          stage: r.stage,
          stageName: CLASS_STAGE_NAME[r.stage] || '',
          classStatus: r.class_status,
          classStatusName: CLASS_STATUS_NAME[r.class_status] || '',
          studentCount: r.student_count,
          headTeacherId: r.head_teacher_id,
          headTeacherName: r.head_teacher_name,
          teacherId: r.teacher_id,
          teacherName: r.teacher_name,
          assistantId: r.assistant_id,
          assistantName: r.assistant_name,
          projectManagerId: r.project_manager_id,
          projectManagerName: r.project_manager_name,
          employmentTeacherId: r.employment_teacher_id,
          employmentTeacherName: r.employment_teacher_name,
          universityNo: r.university_no,
        })),
      ),
    );
  }),
);

/* ============================================================
 * 4. 生成班级编号（新建班级时点「自动生成」）
 *    GET /api/job/class/gen-code
 * ============================================================ */

classRouter.get(
  '/gen-code',
  wrap(async (_req, res) => {
    res.json(ok({ classCode: await genClassCode() }));
  }),
);

/* ============================================================
 * 5. 新建班级
 *    POST /api/job/class/add
 * ============================================================ */

const saveSchema = z.object({
  className: z.string().min(1, '班级名称必填').max(50),
  classCode: z.string().min(1, '班级编号必填').max(32),
  deptCode: z.number().int().min(1).max(2),
  stage: z.number().int().min(1).max(3),
  headTeacherId: z.string().min(1, '班主任必填'),
  /** 姓名快照：前端选人后一并传入，用于列表显示（防改名后看不懂） */
  headTeacherName: z.string().max(50).optional(),
  teacherId: z.string().optional(),
  teacherName: z.string().max(50).optional(),
  assistantId: z.string().optional(),
  assistantName: z.string().max(50).optional(),
  classroom: z.string().max(50).optional(),
  openDate: z.string().min(1, '开班日期必填'),
  // ★ 2026-10-02：实训班的常态就是「封班」，新建时不传就默认 2(封班)。
  //   "开放"这个状态业务上已废弃（能进入实训/就业阶段的班级只会是封班）。
  classStatus: z.number().int().min(1).max(4).optional(),
  remark: z.string().max(500).optional(),
});

/** 校验：编号唯一 + 同部门内名称不重复 */
async function checkUnique(
  classCode: string,
  className: string,
  deptCode: number,
  excludeId?: string,
) {
  const codeQ = tbl(db, DB, TABLE, STAGE).where({ class_code: classCode, is_deleted: false });
  if (excludeId) codeQ.andWhereNot('id', excludeId);
  if (await codeQ.first()) {
    throw new BizError(BizCode.CLASS_CODE_EXISTS, `班级编号「${classCode}」已存在`);
  }

  const nameQ = tbl(db, DB, TABLE, STAGE).where({
    class_name: className,
    dept_code: deptCode,
    is_deleted: false,
  });
  if (excludeId) nameQ.andWhereNot('id', excludeId);
  if (await nameQ.first()) {
    throw new BizError(BizCode.CLASS_NAME_EXISTS, `该部门下已有班级叫「${className}」`);
  }
}

classRouter.post(
  '/add',
  validate(saveSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof saveSchema>;
    await checkUnique(body.classCode, body.className, body.deptCode);

    const id = randomUUID();
    const now = new Date();

    await tblIns(db, DB, TABLE, STAGE, {
      id,
      create_time: now,
      create_by: req.user?.userId || null,
      is_deleted: false,

      class_name: body.className,
      class_code: body.classCode,
      dept_code: body.deptCode,
      [phaseCodeCol()]: body.stage,
      head_teacher_id: body.headTeacherId,
      head_teacher_name: body.headTeacherName || null,
      teacher_id: body.teacherId || null,
      teacher_name: body.teacherName || null,
      assistant_id: body.assistantId || null,
      assistant_name: body.assistantName || null,
      classroom: body.classroom || null,
      open_date: body.openDate,
      // ★ 2026-10-02：不传就是「封班」（实训班常态），不再有"开放"
      class_status: body.classStatus ?? STATUS_SEALED,
      student_count: 0,
      remark: body.remark || null,
    });

    res.json(ok({ id }));
  }),
);

/* ============================================================
 * 6. 编辑班级
 *    PUT /api/job/class/update
 * ============================================================ */

classRouter.put(
  '/update',
  validate(saveSchema.extend({ id: z.string().min(1) })),
  wrap(async (req, res) => {
    const body = (req as any).validated;
    const row = await tbl(db, DB, TABLE, STAGE).where({ id: body.id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.CLASS_NOT_FOUND, '班级不存在');

    await checkUnique(body.classCode, body.className, body.deptCode, body.id);

    await tbl(db, DB, TABLE, STAGE).where({ id: body.id }).update({
      update_time: new Date(),
      update_by: req.user?.userId || null,

      class_name: body.className,
      class_code: body.classCode,
      dept_code: body.deptCode,
      [phaseCodeCol()]: body.stage,
      head_teacher_id: body.headTeacherId,
      head_teacher_name: body.headTeacherName ?? row.head_teacher_name,
      teacher_id: body.teacherId || null,
      teacher_name: body.teacherName ?? row.teacher_name,
      assistant_id: body.assistantId || null,
      assistant_name: body.assistantName ?? row.assistant_name,
      classroom: body.classroom || null,
      open_date: body.openDate,
      // ★ 2026-10-02：不传就保持原状态（schema 已改成可选）
      class_status: body.classStatus ?? row.class_status,
      remark: body.remark || null,
    });

    res.json(ok(null));
  }),
);

/* ============================================================
 * 7. 删除班级（逻辑删）
 *    DELETE /api/job/class/delete/:id
 *
 * ⚠️ 有在班学生的班级不允许删除
 * ============================================================ */

classRouter.delete(
  '/delete/:id',
  wrap(async (req, res) => {
    const { id } = req.params;

    // ⚠️ 双层拦截的第二层：前端不显示删除按钮，但挡不住有人直接调接口，
    //    所以后端必须再拦一次。班主任删 → 40302。
    if (!canDeleteClass(req.user?.roles || [])) {
      throw new BizError(BizCode.NO_OPERATION_PERMISSION, '班主任无权删除班级');
    }

    const row = await tbl(db, DB, TABLE, STAGE).where({ id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.CLASS_NOT_FOUND, '班级不存在');

    const [{ cnt }] = (await tbl(db, DB, CS_TABLE, STAGE)
      .where({ class_id: id, status: 1, is_deleted: false })
      .count({ cnt: '*' })) as Array<Record<string, any>>;
    if (Number(cnt) > 0) {
      throw new BizError(
        BizCode.CLASS_STATUS_NOT_ALLOW,
        `班级还有 ${cnt} 名在班学生，请先移出学生再删除`,
      );
    }

    await tbl(db, DB, TABLE, STAGE).where({ id }).update({
      is_deleted: true,
      update_time: new Date(),
      update_by: req.user?.userId || null,
    });
    res.json(ok(null));
  }),
);

/* ============================================================
 * 8. 封班 / 解封
 *    POST /api/job/class/seal/:id
 *    POST /api/job/class/unseal/:id
 *
 * 封班规则：只接受休学学生和末次班学生转入（校验在花名册接口）
 * ============================================================ */

classRouter.post(
  '/seal/:id',
  wrap(async (req, res) => {
    const { id } = req.params;
    const row = await tbl(db, DB, TABLE, STAGE).where({ id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.CLASS_NOT_FOUND, '班级不存在');
    if (row.class_status === STATUS_GRADUATED) {
      throw new BizError(BizCode.CLASS_STATUS_NOT_ALLOW, '已结业的班级不能封班');
    }
    await tbl(db, DB, TABLE, STAGE).where({ id }).update({
      class_status: STATUS_SEALED,
      update_time: new Date(),
      update_by: req.user?.userId || null,
    });
    res.json(ok(null));
  }),
);

classRouter.post(
  '/unseal/:id',
  // ⚠️ 2026-10-02（斌哥）：**"开放"状态已废弃** —— 能进入实训/就业阶段的班级只会是「封班」。
  //   这个接口保留仅为兼容（前端没有入口、也没有调用），业务上不应该再用。
  //   如果确认永远不需要，可以整个删掉。
  wrap(async (req, res) => {
    const { id } = req.params;
    const row = await tbl(db, DB, TABLE, STAGE).where({ id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.CLASS_NOT_FOUND, '班级不存在');
    if (row.class_status !== STATUS_SEALED) {
      throw new BizError(BizCode.CLASS_STATUS_NOT_ALLOW, '只有封班状态才能解封');
    }
    await tbl(db, DB, TABLE, STAGE).where({ id }).update({
      class_status: STATUS_OPEN,
      update_time: new Date(),
      update_by: req.user?.userId || null,
    });
    res.json(ok(null));
  }),
);

/* ============================================================
 * 9. 结业（= 班级结业 + 全班转就业）
 *    GET  /api/job/class/graduate/preview/:id   预览：会转出多少人
 *    POST /api/job/class/graduate/:id           执行结业（必传 closeDate）
 *    POST /api/job/class/revoke-graduate/:id    撤销结业（仅校长）
 *
 * ★★ 斌哥 2026-10-01 拍板：
 *   「结业」和「转就业」是**一个动作**，点一下全部完成，不走审批。
 *
 *   为什么"转就业"在这里做、不用接口调别人？
 *     → 就业和实训**在同一个服务(8004)、同一个库(sms_job)**，
 *       学生主档就在自己库里，改个状态（8 实训中 → 9 待就业）就完事，
 *       根本不需要像"大学部 8003 → 实训 8004"那样跨库搬数据。
 *
 *   谁会被转走 / 谁会被跳过 / 连带生成什么单子，
 *   全部逻辑见 `utils/graduate.ts` 的文件头注释。
 * ============================================================ */

classRouter.get(
  '/graduate/preview/:id',
  wrap(async (req, res) => {
    const { id } = req.params;
    const operator = getOperator(req);
    const roles = operator.roles || [];

    if (!canGraduateClass(roles)) {
      throw new BizError(BizCode.NO_OPERATION_PERMISSION, '您没有结业的权限');
    }
    const row = await tbl(db, DB, TABLE, STAGE).where({ id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.CLASS_NOT_FOUND, '班级不存在');
    assertMyClassIfTeacher(roles, operator.userId, row);

    const data = await previewGraduate(id);
    res.json(ok(data));
  }),
);

classRouter.post(
  '/graduate/:id',
  validate(z.object({ closeDate: z.string().min(1, '结业日期必填') })),
  wrap(async (req, res) => {
    const { id } = req.params;
    const { closeDate } = (req as any).validated;
    const operator = getOperator(req);
    const roles = operator.roles || [];

    if (!canGraduateClass(roles)) {
      throw new BizError(BizCode.NO_OPERATION_PERMISSION, '您没有结业的权限');
    }
    const row = await tbl(db, DB, TABLE, STAGE).where({ id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.CLASS_NOT_FOUND, '班级不存在');
    assertMyClassIfTeacher(roles, operator.userId, row);

    const data = await graduateClass(id, closeDate, operator);
    res.json(ok(data));
  }),
);

/* ============================================================
 * 10. 撤销结业（仅校长）
 *
 * ⚠️ 只回滚「学生」这一侧：
 *      班级状态 → 结业前状态
 *      花名册   → 回「在班」
 *      学生主档 → 待就业(9) 回「实训中(8)」
 *      退宿申请 → 把「还没审批通过」的自动作废（否则教务一通过就把人床位退了）
 *    ⚠️ 退费单【不动】（斌哥拍板）—— 由班主任自己判断是否提交/作废
 * ============================================================ */

classRouter.post(
  '/revoke-graduate/:id',
  wrap(async (req, res) => {
    const { id } = req.params;
    const operator = getOperator(req);

    if (!canRevokeGraduate(operator.roles || [])) {
      throw new BizError(BizCode.NO_OPERATION_PERMISSION, '只有校长可以撤销结业');
    }
    const row = await tbl(db, DB, TABLE, STAGE).where({ id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.CLASS_NOT_FOUND, '班级不存在');

    const data = await revokeGraduate(id, operator);
    res.json(ok(data));
  }),
);
