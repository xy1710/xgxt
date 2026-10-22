/**
 * 班级信息管理（本班学生详细名单）
 *
 * ★ 斌哥 2026-09-30 大改：
 *   实训老师**一人只带一个班**，所以不需要"先选班级再看名单"两步。
 *   原「班级信息管理」（班级列表）+「班级花名册」（学生名单）**合并成一个页面**：
 *   直接展示"我带的那个班"的学生详细信息 + 各种操作。
 *
 * 【接口清单】
 *   GET /class-info/my-class      我带的班（正常返回 0 或 1 条；教务/校长等可为空）
 *   GET /class-info/students      本班学生详细名单（分页 + 筛选）
 *   GET /class-info/summary       顶部 4 个统计卡片
 *   GET /class-info/fee-records   缴费记录（跨模块调财务 8005，未接入时优雅降级）
 *
 * ⚠️ 数据范围：班主任只能看自己带的班（口径与其它模块一致 —— 以班级表 head_teacher_id 为准）
 *
 * ⚠️ 铁律：逻辑删除、枚举双返回、日期过 fmtDate/fmtDateTime。
 */

import { Router } from 'express';
import { z } from 'zod';
import {
  BizCode,
  RoleCode,
  StudentStatus,
  ExamResult,
  STUDENT_STATUS_NAME,
  CLASS_STATUS_NAME,
  EXAM_TYPE_NAME,
  EXAM_RESULT_NAME,
  JOIN_TYPE_NAME,
  LEAVE_TYPE_NAME,
  CLASS_STUDENT_STATUS_NAME,
  INTERVIEW_CONCLUSION_NAME,
  REVIEW_CONCLUSION_NAME,
  DORM_TYPE_NAME,
  DormBedStatus,
  DormStatus,
  hasRole,
  ClassStatus,
} from 'shared-types';
import { ok, page } from '../utils/response';
import { db } from '../utils/db';
import { wrap } from '../utils/wrap';
import { fmtDate, fmtDateTime, today } from '../utils/date';
import { validate } from '../middleware/validate';
import { BizError } from '../middleware/errorHandler';
// ★ 2026-10-06：缴费记录的取数统一收口到本工具（实时财务 + 副本兜底）
import { fetchStudentFeeRecords, summarizeFees } from '../utils/financeFeeRef';
// ★ 阶段隔离（班主任只看大学 / 项目经理只看实训）
import { myTrainingClassIds } from '../utils/stageScope';
/**
 * ★ P3 切读层：本文件 11 张表全部在 sms_job、且都已在 UNI_MAP 登记 ——
 *   t_student_base / t_job_class / t_job_fee_call / t_job_class_student /
 *   t_job_exam_score / t_job_exam / t_job_dorm_bed / t_job_dorm / t_dorm /
 *   t_employment_log / t_review
 *   读走 `tbl()`；带别名的 from 侧走 `tblAs()`、被 join 侧走 `tblRef()`
 *   （见 teaching/attendance/repo.job.ts 的既有约定）；事务内读写走 `tblTrx()`。
 *   开关关时与原实现等价。
 *   ⚠️ 文中提到的 sms_common.t_class_fee_sync 由 utils/financeFeeRef.ts 内部处理，
 *      本文件没有对它的裸表访问，故不动。
 */
import { tbl, tblAs, tblRef, tblTrx, phaseCodeCol, phaseCodeSelect, readPhaseCode } from '../teaching/shared/uniTable';

export const classInfoRouter = Router();

/** 表名常量 */
const STUDENT_TABLE = 't_student_base';
const CLASS_TABLE = 't_job_class';
const FEE_CALL_TABLE = 't_job_fee_call';
/** 花名册（学生的班级流转记录：入班/离班） */
const CLASS_STUDENT_TABLE = 't_job_class_student';
/** 考试成绩（「考试信息」「末班」两个 Tab 的数据源） */
const EXAM_SCORE_TABLE = 't_job_exam_score';
/** 考试（取考试时间 / 类型） */
const EXAM_TABLE = 't_job_exam';
/** 宿舍床位（「宿舍」Tab） */
const DORM_BED_TABLE = 't_job_dorm_bed';
const DORM_TABLE = 't_job_dorm';
/**
 * 就业基地宿舍（★ 2026-10-02）
 *
 * ⚠️ 宿舍有**两套**：实训基地（`t_job_dorm` + 床位表）和就业基地（`t_dorm`，**只有房间没有床位**）。
 *    学生转就业后会被分到就业基地宿舍，详情接口必须能认出来，否则"列表有、详情空"。
 */
const EMP_DORM_TABLE = 't_dorm';
/**
 * 就业日志 / 就业复盘（「就业日志」「复盘记录」两个 Tab）
 *
 * ⚠️ 这两张表属于同库同服务的**就业模块**（齐晋霄那份），这里跨模块直查。
 *    之所以不调就业模块的接口：那边挂在 `job:employmentLog:view` / `job:review:view`
 *    权限码下，**只有就业老师有，班主任没有** —— 调了会被 40302 拦掉。
 *    表在同一个库里，直接查最省事；数据范围已由 assertSeeStudent 保证。
 */
const EMPLOYMENT_LOG_TABLE = 't_employment_log';
const REVIEW_TABLE = 't_review';

/** ★ 统一表 edu_stage 取值（本路由只服务实训 → sms_job） */
const STAGE = 'job' as const;
const DB = 'sms_job';

/** 考试信息 Tab 只展示最近几次（与参考页一致） */
const EXAM_RECENT_LIMIT = 3;

/** 宿舍性别（1男寝 2女寝）—— 注意与学生性别区分 */
const DORM_GENDER_NAME: Record<number, string> = { 1: '男生宿舍', 2: '女生宿舍' };

/** 部门名映射（数据字典固定：1初高部 2大学部） */
const DEPT_NAME: Record<number, string> = { 1: '初高部', 2: '大学部' };

/** 学生性别（1男 2女）—— 注意别用宿舍性别（那是"男生宿舍/女生宿舍"） */
const GENDER_NAME: Record<number, string> = { 1: '男', 2: '女' };

/**
 * 学习阶段名（与班级阶段共用一套）
 *
 * ★ 2026-10-04 修正：原来只有 1~4「第一~第四阶段」，
 *   但**大学部学生的 stage 实际是 201~206**（班级库那套编号），
 *   升实训后是 **13**（见 upgrade.route.ts 的 TRAINING_STAGE）——
 *   取不到名字就返回空串，前端「学习阶段」那一栏直接显示「—」，
 *   看着像没数据。这里补齐 201~206 与 13，与 class/lib/dict.ts 的 StageName 对齐。
 */
const STAGE_NAME: Record<number, string> = {
  1: '第一阶段',
  2: '第二阶段',
  3: '第三阶段',
  4: '第四阶段',
  201: '一阶段',
  202: '二阶段',
  203: '三阶段',
  204: '四阶段',
  205: '五阶段',
  206: '六阶段',
  13: '实训',
};

/** 「算在校」的学生状态（含试学中 —— 斌哥确认过试学中算在校生） */
const IN_SCHOOL_STATUS: number[] = [
  StudentStatus.TRIAL, // 试学中
  StudentStatus.PRE_STUDY, // 预在读
  StudentStatus.STUDYING, // 正式在读
  StudentStatus.TRAINING, // 实训中
];

/** 取当前登录人 */
function getOperator(req: any): { userId: string; roles: string[] } {
  const u = req.user || {};
  return { userId: u.userId || '', roles: u.roles || [] };
}

/**
 * ★ 2026-10-04 阶段隔离
 *
 * 原来只判断「是不是班主任」，现在按斌哥拍板拆成两侧：
 *   班主任/教员/助教 → 只看**大学部**（这里查的是 t_job_class = 实训班 → 查不到）
 *   项目经理        → 只看**实训/就业**
 *   学管/校长/管理员 → 全看
 *
 * ⚠️ 这个页面（班级信息管理）在 t_job_class 上 —— 也就是**实训侧**的班。
 *   所以班主任进来会看到空列表，这是符合需求的（他带的是大学班，在班级模块看）。
 */
function isOwnClassOnly(roles: string[]): boolean {
  // 项目经理 / 学管 / 校长 / 管理员 → 不受「班主任」口径限制
  // ★ 2026-10-08：改用 hasRole（别名感知）—— 项目经理在权限库里是 RM_PROJECT
  //   ⚠️ 注意：项目经理虽然不走这里，但他有自己的数据范围
  //      （只看自己带的实训班），见 pmOwnClassOnlyOf()。
  if (
    hasRole(roles, RoleCode.PROJECT_MANAGER) ||
    hasRole(roles, RoleCode.TEACH_DEAN) ||
    hasRole(roles, RoleCode.RM_PRINCIPAL) ||
    hasRole(roles, RoleCode.SYS_ADMIN)
  ) {
    return false;
  }
  // 班主任 / 教员 / 助教 → 只能看自己带的班
  return (
    hasRole(roles, RoleCode.TEACH_HEAD) ||
    hasRole(roles, RoleCode.TEACH_TUTOR) ||
    hasRole(roles, RoleCode.TEACH_ASSIST)
  );
}

/**
 * ★ 2026-10-08 新增：项目经理在本页（实训侧）的数据范围
 *
 *   本页查的是 `t_job_class`（实训班），所以：
 *     · 项目经理 → 只看自己带的（project_manager_id = 我）
 *     · 其他角色 → 不走这个函数
 *
 * 【为什么要单独抽】
 *   原来本页只处理了「班主任 head_teacher_id = 我」，
 *   项目经理被归到"不受限" → 能看到**全校所有实训班**（越权）。
 */
function pmOwnClassOnlyOf(roles: string[]): boolean {
  return (
    hasRole(roles, RoleCode.PROJECT_MANAGER) &&
    !hasRole(roles, RoleCode.SYS_ADMIN) &&
    !hasRole(roles, RoleCode.TEACH_DEAN) &&
    !hasRole(roles, RoleCode.RM_PRINCIPAL)
  );
}

/**
 * 给班级查询套上「本角色可见范围」条件
 *
 * @param b        knex builder（.modify 里用）
 * @param operator 当前登录人
 * @param ownIds   项目经理带的班 ID（null = 不限）
 *
 * ★ 2026-10-08：统一三个页面的口径，避免各写一份必然分叉。
 */
function applyClassScope(
  b: any,
  operator: { userId: string; roles: string[] },
  ownIds: string[] | null,
): void {
  if (isOwnClassOnly(operator.roles)) {
    b.andWhere('head_teacher_id', operator.userId);
  } else if (pmOwnClassOnlyOf(operator.roles)) {
    b.andWhere('project_manager_id', operator.userId);
    b.andWhereNot('class_status', ClassStatus.GRADUATED);
  } else if (ownIds) {
    if (ownIds.length === 0) b.whereRaw('1 = 0');
    else b.whereIn('id', ownIds);
  }
  // 其余（学管/校长/管理员）→ 不加条件 = 不限
}

/**
 * 取"我带的班"列表
 *
 * 正常情况一名实训老师只带 1 个班；这里仍按数组返回，
 * 前端：0 个 → 提示没带班；1 个 → 直接展示；多个 → 给下拉选择。
 */
classInfoRouter.get(
  '/my-class',
  wrap(async (req, res) => {
    const operator = getOperator(req);

    // ★ 2026-10-04 阶段隔离：班主任/教员/助教 → 看不到实训班（空列表）
    //   项目经理 → 只看自己带的实训班；学管/校长/管理员 → 全部
    const query = tbl(db, DB, CLASS_TABLE, STAGE).where('is_deleted', false);
    const myIds = await myTrainingClassIds(operator);
    if (myIds) {
      if (myIds.length === 0) {
        // 带的班为空 → 返回空列表（不是查全部）
        // ★ 统一返回数组：与下方非空分支同构（前端 fetchMyClasses 期望 MyClassItem[]）
        res.json({ code: 200, message: '查询成功', data: [] });
        return;
      }
      query.andWhere('id', 'in', myIds);
    }

    const rows = await query
      .select(
        'id', 'class_name', 'class_code', 'dept_code', phaseCodeSelect({ alias: 'stage' }), 'class_status',
        'head_teacher_id', 'project_manager_id', 'employment_teacher_id',
      )
      .orderBy('class_name', 'asc');

    res.json(
      ok(
        rows.map((r: any) => ({
          id: r.id,
          className: r.class_name,
          classCode: r.class_code,
          deptCode: r.dept_code ?? null,
          deptName: DEPT_NAME[r.dept_code] || null,
          stage: r.stage,
          stageName: STAGE_NAME[r.stage] || '',
          classStatus: r.class_status,
          classStatusName: CLASS_STATUS_NAME[r.class_status] || '',
          // ★ 2026-10-04 交棒模型：岗位责任人（前端按「责任人是不是我」判断按钮）
          projectManagerId: r.project_manager_id ?? null,
          employmentTeacherId: r.employment_teacher_id ?? null,
        })),
      ),
    );
  }),
);

/* ============================================================
 * 1. 本班学生详细名单
 *    GET /api/job/class-info/students
 * ============================================================ */

const studentListSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(200).default(20),
  /** 不传 = 用"我带的班" */
  classId: z.string().optional(),
  keyword: z.string().optional(),
  studentStatus: z.coerce.number().int().optional(),
});

classInfoRouter.get(
  '/students',
  validate(studentListSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated;
    const operator = getOperator(req);

    // ---- ① 先定"看哪个班" ----
    let classId = q.classId;
    if (!classId) {
      // 没传 → 用我带的班；班主任正常只有 1 个
      // ★ 2026-10-04 补漏洞：项目经理 / 就业老师不属于 isOwnClassOnly，
      //   原来 .modify() 一个条件都不加 → first() 取的是"全库随便第一个班"，
      //   于是马志斌（Q1 已交棒给就业）竟能看到 Q1 的 5 个待就业学生。
      //   现在项目经理走 t_job_class.project_manager_id、就业老师走
      //   employment_teacher_id，交棒后自然取不到班 → 返回空。
      // ⚠️ .modify() 回调是同步的，所以先在 await 环境里算出班级 ID 列表。
      let ownIds: string[] | null = null;
      if (!isOwnClassOnly(operator.roles)) {
        const ids = await myTrainingClassIds(operator);
        // ids === null → 学管/校长/管理员，本就不限
        ownIds = ids === null ? null : ids;
      }
      const mine = await tbl(db, DB, CLASS_TABLE, STAGE)
        .where({ is_deleted: false })
        .modify((b: any) => {
          applyClassScope(b, operator, ownIds);
        })
        .orderBy('class_name', 'asc')
        .first();
      if (!mine) {
        // 没带班 → 返回空列表（不是报错，前端会有引导提示）
        res.json(page([], 0, q));
        return;
      }
      classId = mine.id;
    } else if (isOwnClassOnly(operator.roles) || pmOwnClassOnlyOf(operator.roles)) {
      // ⚠️ 班主任/项目经理传了别人的班 ID → 拦住（不能越权看别人的班）
      // ★ 2026-10-08：补上项目经理（按 project_manager_id 校验）
      const isPM = pmOwnClassOnlyOf(operator.roles);
      const mine = isPM
        ? await tbl(db, DB, CLASS_TABLE, STAGE)
            .where({ id: classId, project_manager_id: operator.userId, is_deleted: false })
            // [已停用] ★ 2026-10-08 斌哥拍板：项目经理可见自己带的【所有】实训班（含已结业）—— 去掉未结业限制
            // .whereNot('class_status', ClassStatus.GRADUATED)
            .first()
        : await tbl(db, DB, CLASS_TABLE, STAGE)
            .where({ id: classId, head_teacher_id: operator.userId, is_deleted: false })
            .first();
      if (!mine) {
        throw new BizError(
          BizCode.NO_OPERATION_PERMISSION,
          isPM ? '只能查看自己带的实训班级' : '只能查看自己带的班级',
        );
      }
    }

    // ---- ② 学生列表（一人一班，直接查学生主档）----
    // ★ 斌哥 2026-10-01 **改口径**：已退学的学生**恢复可见** ——
    //   在原班级里能看到他，状态显示「退学」，方便班主任回顾/对账。
    //   ⚠️ 前端对退学学生**只给「详情」按钮**（只读），不能改。
    //   ⚠️ 旧口径（2026-09-30）是"退学直接不查出来"，本次已去掉那行 whereNot。
    const query = tblAs(db, DB, STUDENT_TABLE, STAGE, 's')
      .where('s.is_deleted', false)
      .andWhere('s.class_id', classId);

    if (q.keyword) {
      query.andWhere((b: any) => {
        b.where('s.student_name', 'like', `%${q.keyword}%`)
          .orWhere('s.student_no', 'like', `%${q.keyword}%`)
          .orWhere('s.phone', 'like', `%${q.keyword}%`);
      });
    }
    if (q.studentStatus) query.andWhere('s.student_status', q.studentStatus);

    const [{ total }] = await query.clone().count({ total: 's.id' });

    const rows = await query
      .clone()
      .select(
        's.id',
        's.student_no',
        's.student_name',
        's.gender',
        's.age',
        's.phone',
        's.parent_phone',
        's.dorm_no',
        's.enroll_date',
        's.education',
        's.student_status',
        's.repeat_count',
        // ★ #23 方案B：join 侧也要换列名（别名保持 stage，下游 r.stage 不变）
        phaseCodeSelect({ ref: 's', alias: 'stage' }),
        's.remark',
        's.class_id',
        's.class_name',
        's.dept_code',
      )
      .orderBy('s.student_no', 'asc')
      .limit(q.size)
      .offset((q.page - 1) * q.size);

    // ---- ③ 批量取"欠费"标记（有未缴清的催费单）----
    const ids = rows.map((r: any) => r.id);
    const unpaidSet = new Set<string>();
    if (ids.length) {
      const fees = await tbl(db, DB, FEE_CALL_TABLE, STAGE)
        .whereIn('student_id', ids)
        .andWhere('is_deleted', false)
        .andWhereNot('call_status', 3) // 3 = 已缴清
        .select('student_id');
      fees.forEach((f: any) => unpaidSet.add(f.student_id));
    }

    const list = rows.map((r: any) => ({
      studentId: r.id,
      studentNo: r.student_no,
      studentName: r.student_name,
      gender: r.gender,
      genderName: GENDER_NAME[r.gender] || '',
      className: r.class_name || null,
      deptCode: r.dept_code ?? null,
      deptName: DEPT_NAME[r.dept_code] || null,
      age: r.age ?? null,
      phone: r.phone || null,
      parentPhone: r.parent_phone || null,
      dormNo: r.dorm_no || null,
      enrollDate: fmtDate(r.enroll_date),
      education: r.education || null,
      studentStatus: r.student_status,
      studentStatusName: STUDENT_STATUS_NAME[r.student_status] || '',
      repeatCount: r.repeat_count ?? 0,
      stage: r.stage ?? null,
      stageName: STAGE_NAME[r.stage] || '',
      // ⚠️ 「综合素质」已与「备注」合并（斌哥 2026-09-30）—— 不再单独建字段
      remark: r.remark || null,
      /** 有没有未缴清的催费单（用于"欠费待催"标记） */
      hasUnpaid: unpaidSet.has(r.id),
    }));

    res.json(page(list, Number(total), q));
  }),
);

/* ============================================================
 * 2. 顶部统计卡片
 *    GET /api/job/class-info/summary
 * ============================================================ */

classInfoRouter.get(
  '/summary',
  validate(z.object({ classId: z.string().optional() })),
  wrap(async (req, res) => {
    const q = (req as any).validated;
    const operator = getOperator(req);

    let classId = q.classId;
    if (!classId) {
      const mine = await tbl(db, DB, CLASS_TABLE, STAGE)
        .where({ is_deleted: false })
        .modify((b: any) => {
          // ★ 2026-10-08：统一口径（含项目经理）
          if (isOwnClassOnly(operator.roles)) b.andWhere('head_teacher_id', operator.userId);
          else if (pmOwnClassOnlyOf(operator.roles)) {
            b.andWhere('project_manager_id', operator.userId);
            b.andWhereNot('class_status', ClassStatus.GRADUATED);
          }
        })
        .first();
      if (!mine) {
        res.json(
          ok({ totalInSchool: 0, trialCount: 0, statusChanged: 0, repeatTotal: 0, unpaidCount: 0 }),
        );
        return;
      }
      classId = mine.id;
    }

    const base = () =>
      tblAs(db, DB, STUDENT_TABLE, STAGE, 's').where('s.is_deleted', false).andWhere('s.class_id', classId);

    // ① 在读学员总数（含试学中）
    const [{ inSchool }] = await base().clone().whereIn('s.student_status', IN_SCHOOL_STATUS).count({ inSchool: 's.id' });

    // ①' 其中试学中
    const [{ trial }] = await base().clone().where('s.student_status', StudentStatus.TRIAL).count({ trial: 's.id' });

    // ② 休学人数
    //   ★ 退学**不计入"在读"**（2026-10-01 起退学学生在名单里可见，但不算在读）
    //     （否则"异动 N 人"这个数字在名单里找不到对应的人，反而让人困惑）
    const [{ changed }] = await base()
      .clone()
      .where('s.student_status', StudentStatus.SUSPENDED)
      .count({ changed: 's.id' });

    // ③ 末班记录人次（本班所有学生 repeat_count 之和）
    const [repeatRow] = await base().clone().sum({ t: 's.repeat_count' });

    // ④ 欠费待催人数（本班有未缴清催费单的学生数，去重）
    const students = await base().clone().select('s.id');
    const sids = students.map((x: any) => x.id);
    let unpaid = 0;
    if (sids.length) {
      const [row] = (await tbl(db, DB, FEE_CALL_TABLE, STAGE)
        .whereIn('student_id', sids)
        .andWhere('is_deleted', false)
        .andWhereNot('call_status', 3)
        .countDistinct({ n: 'student_id' })) as Array<Record<string, any>>;
      unpaid = Number(row?.n || 0);
    }

    res.json(
      ok({
        totalInSchool: Number(inSchool),
        trialCount: Number(trial),
        statusChanged: Number(changed),
        repeatTotal: Number(repeatRow?.t || 0),
        unpaidCount: unpaid,
      }),
    );
  }),
);

/* ============================================================
 * 3. 缴费记录（跨模块调财务 8005）
 *    GET /api/job/class-info/fee-records?studentId=xxx
 *
 * ★ 2026-10-06 修（用户需求：三处详情的缴费情况统一与财务管理对齐）：
 *   原实现调的是 `${FINANCE_URL}/api/finance/payment/list` —— 财务模块里
 *   **根本没有这条路由**（财务是 /api/finance/fee/list），也没带内部令牌，
 *   所以永远进 catch → available:false，实训老师从来就没看到过缴费记录。
 *
 *   现改为走统一取数 `utils/financeFeeRef.ts`：
 *     实时查财务 sms_finance.t_finance_fee（按学号）→ 不可用时回落
 *     班级管理的只读副本 sms_common.t_class_fee_sync。
 *   `available` 语义保留：false = 连副本也没有（前端显示提示而不是报错）。
 * ============================================================ */

classInfoRouter.get(
  '/fee-records',
  validate(z.object({ studentId: z.string().min(1, '学生ID必传') })),
  wrap(async (req, res) => {
    const { studentId } = (req as any).validated;

    const stu = await tbl(db, DB, STUDENT_TABLE, STAGE).where({ id: studentId, is_deleted: false }).first();
    if (!stu) throw new BizError(BizCode.STUDENT_NOT_FOUND, '学生不存在');

    const result = await fetchStudentFeeRecords(stu.student_no || '', { mirror: 'class' });

    res.json(
      ok({
        // 一条记录都没有才算「未接入」；有记录（哪怕是副本）都算 available
        available: result.records.length > 0,
        degraded: result.degraded,
        source: result.source,
        studentId,
        studentNo: stu.student_no,
        studentName: stu.student_name,
        summary: summarizeFees(result.records),
        records: result.records,
        message: result.records.length
          ? result.message
          : '财务管理暂无该学员的缴费记录，待财务录入后可查',
      }),
    );
  }),
);

/* ============================================================
 * 4. 修改学生信息（列表里的「修改」按钮 / 详情页里的「修改」）
 *    POST /api/job/class-info/update-student
 *
 * ★ 斌哥 2026-09-30 放宽：
 *   实训生是从大学部通过升阶考试转过来的，转过来之后
 *   **除了下面这 6 个字段，其余都能由实训老师直接改**。
 *
 * ⚠️ 以下字段**故意不给改**（都有各自的流程，改了会绕过规则）：
 *    学号 studentNo     → 入学时定，改了对不上历史数据
 *    学生状态           → 走「休学/退学审批」（列表里的休学/退学按钮）
 *    宿舍 dormNo/dormId → 走「宿舍管理」的调换/退宿审批
 *    班级 classId       → 走「班级管理」的交接/转班
 *    入学日期 enrollDate→ 学籍原始记录
 *    末班次数 repeatCount → 走「成绩管理」的判末班（手改会两边对不上）
 * ============================================================ */
const updateStudentSchema = z.object({
  studentId: z.string().min(1, '学生ID必传'),
  /** 姓名（改了会同步花名册，见下方事务） */
  studentName: z.string().max(32).optional(),
  gender: z.coerce.number().int().min(1, '性别取值 1男 2女').max(2).optional(),
  age: z.coerce.number().int().min(0).max(120).optional(),
  education: z.string().max(20).optional(),
  phone: z.string().max(20).optional(),
  parentPhone: z.string().max(20).optional(),
  /** 档案类字段（本期新增） */
  birthDate: z.string().max(20).optional(),
  nativePlace: z.string().max(64).optional(),
  graduateSchool: z.string().max(128).optional(),
  homeAddress: z.string().max(255).optional(),
  stage: z.coerce.number().int().optional(),
  remark: z.string().max(500).optional(),
  /**
   * ★ 2026-10-02（斌哥）：「修改」里可以直接换宿舍床位
   *
   * 传了 bedId 就会走完整同步：释放旧床位 → 占用新床位 →
   * 同步学生主档 dorm_id/dorm_no → 两端「已住人数」重算。
   * ⚠️ 只支持**换床位**，不支持在这里退宿（退宿要走宿舍管理的审批流程）。
   */
  bedId: z.string().optional(),
});

classInfoRouter.post(
  '/update-student',
  validate(updateStudentSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated;
    const operator = getOperator(req);

    const stu = await tbl(db, DB, STUDENT_TABLE, STAGE).where({ id: body.studentId, is_deleted: false }).first();
    if (!stu) throw new BizError(BizCode.STUDENT_NOT_FOUND, '学生不存在');

    // ★ 只读角色（教务老师）不得写 —— 本页教务只能看
    assertCanWrite(operator);

    // ★ 已转出的学生（待就业/已就业）只能看不能改
    assertStudentEditable(stu);

    // 数据范围：班主任只能改自己班的学生
    await assertSeeStudent(stu, operator);

    /* ---------- ★ 2026-10-02（斌哥）：换宿舍床位 ----------
     *
     * 原来宿舍是"不可改字段"（要走「宿舍管理」模块），现在允许在「修改」里直接换。
     * 校验口径与「分派宿舍」完全一致：床位空闲 / 宿舍正常 / 性别匹配。
     * ⚠️ 只支持**换床位**，不支持在这里退宿 —— 退宿要走宿舍管理的审批流程。
     */
    let targetBed: any = null;
    let oldDormId: string | null = null;
    if (body.bedId) {
      const bed = await tbl(db, DB, DORM_BED_TABLE, STAGE).where({ id: body.bedId, is_deleted: false }).first();
      if (!bed) throw new BizError(BizCode.DORM_BED_NOT_FOUND, '床位不存在');

      const dm = await tbl(db, DB, DORM_TABLE, STAGE).where({ id: bed.dorm_id, is_deleted: false }).first();
      if (!dm) throw new BizError(BizCode.DORM_NOT_FOUND, '宿舍不存在');
      if (dm.dorm_status === DormStatus.DISABLED) {
        throw new BizError(BizCode.DORM_DISABLED, '该宿舍已停用，不能分派');
      }

      // 性别校验：用「改完之后的性别」判断（可能同时改了性别）
      const g = body.gender !== undefined ? body.gender : stu.gender;
      if (dm.dorm_gender && g && dm.dorm_gender !== g) {
        throw new BizError(
          BizCode.DORM_GENDER_MISMATCH,
          `该生是${GENDER_NAME[g] || ''}生，不能分到「${DORM_GENDER_NAME[dm.dorm_gender] || ''}」`,
        );
      }

      if (bed.student_id === stu.id) {
        // 传的就是他自己当前那张床 → 视为没变，不做任何动作
        targetBed = null;
      } else {
        if (bed.bed_status === DormBedStatus.USED) {
          throw new BizError(
            BizCode.DORM_BED_OCCUPIED,
            `床位 ${bed.dorm_no} ${bed.bed_no} 已被占用`,
          );
        }
        targetBed = bed;
        // 记下原来那个宿舍（换完后要重算它的「已住人数」）
        if (stu.dorm_id && stu.dorm_id !== bed.dorm_id) oldDormId = stu.dorm_id;
      }
    }

    const patch: Record<string, any> = {
      update_time: new Date(),
      update_by: operator.userId,
    };
    // ⚠️ 用 !== undefined 判断，空串要能"清空"成 null
    if (body.studentName !== undefined) patch.student_name = body.studentName || null;
    if (body.gender !== undefined) patch.gender = body.gender;
    if (body.age !== undefined) patch.age = body.age;
    if (body.education !== undefined) patch.education = body.education || null;
    if (body.phone !== undefined) patch.phone = body.phone || null;
    if (body.parentPhone !== undefined) patch.parent_phone = body.parentPhone || null;
    if (body.birthDate !== undefined) patch.birth_date = body.birthDate || null;
    if (body.nativePlace !== undefined) patch.native_place = body.nativePlace || null;
    if (body.graduateSchool !== undefined) patch.graduate_school = body.graduateSchool || null;
    if (body.homeAddress !== undefined) patch.home_address = body.homeAddress || null;
    if (body.stage !== undefined) patch[phaseCodeCol()] = body.stage;
    if (body.remark !== undefined) patch.remark = body.remark || null;
    // ★ 换宿舍：学生主档的宿舍字段也跟着改（床位表在下面的事务里同步）
    if (targetBed) {
      patch.dorm_id = targetBed.dorm_id;
      patch.dorm_no = targetBed.dorm_no;
    }

    // ⚠️ 改了姓名 → 花名册里的 student_name 是**冗余字段（便于显示）**，
    //    不跟着改会出现"同一个人两个名字"。同一事务里一起更新。
    await db.transaction(async (trx: any) => {
      await tblTrx(trx, DB, STUDENT_TABLE, STAGE).where({ id: body.studentId }).update(patch);
      if (body.studentName !== undefined) {
        await tblTrx(trx, DB, CLASS_STUDENT_TABLE, STAGE)
          .where({ student_id: body.studentId, is_deleted: false })
          .update({ student_name: body.studentName || null, update_time: new Date() });
      }

      /* ★ 2026-10-02：换宿舍 —— 释放旧床 → 占用新床 → 两端「已住人数」重算 */
      if (targetBed) {
        // ① 释放该生原来占的床位
        await tblTrx(trx, DB, DORM_BED_TABLE, STAGE)
          .where({ student_id: body.studentId, is_deleted: false })
          .update({
            bed_status: DormBedStatus.FREE,
            student_id: null,
            student_no: null,
            student_name: null,
            student_gender: null,
            check_in_date: null,
            update_time: new Date(),
            update_by: operator.userId,
          });

        // ② 占用新床位
        await tblTrx(trx, DB, DORM_BED_TABLE, STAGE).where({ id: targetBed.id }).update({
          bed_status: DormBedStatus.USED,
          student_id: body.studentId,
          student_no: stu.student_no || null,
          student_name: body.studentName || stu.student_name || null,
          student_gender: body.gender ?? stu.gender ?? null,
          check_in_date: today(),
          update_time: new Date(),
          update_by: operator.userId,
        });

        // ③ 两端「已住人数」重算
        await recalcDormUsed(trx, targetBed.dorm_id);
        if (oldDormId) await recalcDormUsed(trx, oldDormId);
      }
    });

    res.json(ok(null));
  }),
);

/* ============================================================
 * 5. 学生档案详情（列表里「详情」按钮 → 6 个 Tab）
 *    GET /api/job/class-info/detail?studentId=xxx
 *
 * ★ 斌哥 2026-09-30：详情要看全一个人 ——
 *   基础信息 / 市场信息 / 末班 / 宿舍 / 考试信息 / 班级信息
 *
 * 【各 Tab 的数据来源】
 *   基础信息   t_student_base（含本期新增的 4 个档案字段）
 *   市场信息   ★ 跨模块调【咨询模块 8001】—— 未接入时优雅降级
 *   末班       t_job_exam_score 里 exam_result=2（未通过）的记录
 *   宿舍       t_job_dorm_bed + t_job_dorm
 *   考试信息   t_job_exam_score + t_job_exam（只取最近 3 次）
 *   班级信息   t_job_class（当前班）+ t_job_class_student（历史流转）
 * ============================================================ */

/**
 * 数据范围校验：班主任 / 项目经理只能看自己班的学生
 * ⚠️ 口径与其它模块一致 —— 以**班级表**的责任人字段为准
 *    （学生主档那个字段大量为空，不可靠）
 *
 * ★ 2026-10-08：补上项目经理分支（原来只判班主任 → 项目经理能看全校学生）
 */
async function assertSeeStudent(
  stu: any,
  operator: { userId: string; roles: string[] },
): Promise<void> {
  const isPM = pmOwnClassOnlyOf(operator.roles);
  if (!isOwnClassOnly(operator.roles) && !isPM) return;
  if (!stu.class_id) {
    throw new BizError(
      BizCode.NO_OPERATION_PERMISSION,
      isPM ? '只能查看自己带的实训班学生' : '只能查看自己班级的学生',
    );
  }
  const mine = isPM
    ? await tbl(db, DB, CLASS_TABLE, STAGE)
        .where({ id: stu.class_id, project_manager_id: operator.userId, is_deleted: false })
        // [已停用] ★ 2026-10-08 斌哥拍板：项目经理可见自己带的【所有】实训班（含已结业）—— 去掉未结业限制
        // .whereNot('class_status', ClassStatus.GRADUATED)
        .first()
    : await tbl(db, DB, CLASS_TABLE, STAGE)
        .where({ id: stu.class_id, head_teacher_id: operator.userId, is_deleted: false })
        .first();
  if (!mine) {
    throw new BizError(
      BizCode.NO_OPERATION_PERMISSION,
      isPM ? '只能查看自己带的实训班学生' : '只能查看自己班级的学生',
    );
  }
}

/**
 * 「只读角色」不得写 —— 本页面教务老师**只能看**（斌哥 2026-09-30）
 *
 * 【为什么教务在本页面是只读】
 *   教务老师的职责是「催费 + 宿舍调换/退宿审批」，
 *   学生名单他只是来看的（对账、核人数），不参与维护。
 *
 * ⚠️ 为什么要在后端拦：前端把按钮藏起来只是"不碍眼"。
 *    真正懂技术的人绕开页面直接调接口照样能改 ——
 *    所以**每个写接口都要自己守一道**，不能只靠前端。
 *
 * ⚠️ 注意别和「系统管理员只读」搞混：那个是 app.ts 里的全局总闸
 *    （管理员对所有业务模块都只读），这里是**本页面**的角色级只读。
 */
function assertCanWrite(operator: { roles: string[] }): void {
  // ★ 2026-10-06：学管主任（TEACH_DEAN）在本页**只读**。
  //   他是审批角色（休退学/退费的审批人），改学生档案属业务写操作，不由他办。
  //   （更外层还有 middleware/approvalOnly.ts 的只读总闸兜底。）
  if (operator.roles.includes(RoleCode.TEACH_DEAN)) {
    throw new BizError(
      BizCode.NO_OPERATION_PERMISSION,
      '学管主任在本页只能查看，不能修改学生信息',
    );
  }
  if (operator.roles.includes(RoleCode.ACAD_STAFF)) {
    throw new BizError(
      BizCode.NO_OPERATION_PERMISSION,
      '教务老师在本页只能查看，不能修改学生信息',
    );
  }
  // ★ 2026-10-02：就业老师也**只读**。
  //   他能通过「信息档案」页进到这一套接口（路由挂的是多码任一），
  //   但**学生的实训档案归实训侧管** —— 姓名/籍贯/毕业院校这些不该由他改。
  //   （他自己的「信息档案」页改学生，走的是 /api/job/student/update，不受这里影响。）
  if (operator.roles.includes(RoleCode.JOB_STAFF)) {
    throw new BizError(
      BizCode.NO_OPERATION_PERMISSION,
      '就业老师在本页只能查看，不能修改学生信息',
    );
  }
}

/**
 * ★ 学生已转出（待就业/已就业）→ 本页只能看，不能改（2026-10-01）
 *
 * 【为什么】
 *   斌哥定：班级结业后学生转到就业，**实训这边还能看到，但不能再改**。
 *   学生档案已经移交给就业那边，实训老师再改姓名/手机号会造成两边不一致。
 *
 * 【拦哪些】
 *   本页所有写学生档案的接口（修改、备注）都过这一道。
 *   休学/退学/复学走的是另一个接口（studentLeave），
 *   那边的状态白名单 `ALLOW_INITIATE_STATUS` 本来就不含待就业/已就业，天然拦住。
 */
const TRANSFERRED_STATUS: number[] = [
  StudentStatus.WAIT_EMPLOY, // 9 待就业
  StudentStatus.EMPLOYED,    // 10 已就业
];

function assertStudentEditable(stu: any): void {
  if (TRANSFERRED_STATUS.includes(stu.student_status)) {
    throw new BizError(
      BizCode.NO_OPERATION_PERMISSION,
      `该学生已是「${STUDENT_STATUS_NAME[stu.student_status] || '已转出'}」，档案已移交就业，只能查看不能修改`,
    );
  }
}

/**
 * 重算某个宿舍的「已住人数」（used_count）
 *
 * 口径：该宿舍下 `bed_status = 2(已占用)` 且未删除的床位数。
 *
 * ⚠️ **必须在事务里调用**（传 trx）—— 否则和床位改动不在同一个事务，
 *    并发时会算出错的数字。
 */
async function recalcDormUsed(trx: any, dormId: string): Promise<void> {
  const [row] = await tblTrx(trx, DB, DORM_BED_TABLE, STAGE)
    .where({ dorm_id: dormId, is_deleted: false, bed_status: DormBedStatus.USED })
    .count({ n: 'id' });
  await tblTrx(trx, DB, DORM_TABLE, STAGE)
    .where({ id: dormId })
    .update({ used_count: Number((row as any)?.n || 0) });
}

/**
 * 市场信息 —— 招生老师 / 咨询老师
 *
 * ★ 斌哥 2026-09-30 定稿：**改成读自己库**，不再实时调咨询模块 8001。
 *
 * 【为什么改】
 *   之前是「实时调 8001」拿招生/咨询老师；后经确认，这 4 个字段是学生
 *   「入学时就定、之后基本不变」的静态属性，应该**升阶时由大学部（8003）搬过来**，
 *   写进本模块的学生主档（迁移 20260930_010 已加列）。
 *   所以这里直接读 stu 的字段即可，不用再跨模块、也不用降级提示。
 *
 * 【升阶链路】咨询(8001) → 大学部(8003) → 升阶 → 实训(8004) → 升阶 → 就业
 *   本模块只负责「实训」这一环；学生的市场信息由 8003 升阶时写入。
 */
function getMarketInfo(stu: any): {
  admissionTeacher: string | null;
  admissionTeacherPhone: string | null;
  consultTeacher: string | null;
  consultTeacherPhone: string | null;
} {
  return {
    admissionTeacher: stu.admission_teacher ?? null,
    admissionTeacherPhone: stu.admission_teacher_phone ?? null,
    consultTeacher: stu.consult_teacher ?? null,
    consultTeacherPhone: stu.consult_teacher_phone ?? null,
  };
}


classInfoRouter.get(
  '/detail',
  validate(z.object({ studentId: z.string().min(1, '学生ID必传') })),
  wrap(async (req, res) => {
    const { studentId } = (req as any).validated;
    const operator = getOperator(req);

    const stu = await tbl(db, DB, STUDENT_TABLE, STAGE).where({ id: studentId, is_deleted: false }).first();
    if (!stu) throw new BizError(BizCode.STUDENT_NOT_FOUND, '学生不存在');
    await assertSeeStudent(stu, operator);

    /* ---------- ① 基础信息 ---------- */
    const basic = {
      studentId: stu.id,
      studentNo: stu.student_no || '',
      studentName: stu.student_name || '',
      gender: stu.gender ?? null,
      genderName: GENDER_NAME[stu.gender] || '',
      age: stu.age ?? null,
      className: stu.class_name || null,
      deptCode: stu.dept_code ?? null,
      deptName: DEPT_NAME[stu.dept_code] || null,
      education: stu.education || null,
      phone: stu.phone || null,
      parentPhone: stu.parent_phone || null,
      enrollDate: fmtDate(stu.enroll_date),
      birthDate: fmtDate(stu.birth_date),
      nativePlace: stu.native_place || null,
      graduateSchool: stu.graduate_school || null,
      homeAddress: stu.home_address || null,
      studentStatus: stu.student_status ?? null,
      studentStatusName: STUDENT_STATUS_NAME[stu.student_status] || '',
      stage: readPhaseCode(stu) ?? null,
      stageName: STAGE_NAME[readPhaseCode(stu)] || '',
      // 「综合素质」已与「备注」合并 —— 不再单独建字段
      remark: stu.remark || null,
      // 照片：本期只做展示位，不接上传（文件存储方案未定 —— 斌哥 2026-09-30）
      idCardPhoto: null as string | null,
      householdPhoto: null as string | null,
    };

    /* ---------- ② 市场信息（跨模块 8001） ---------- */
    const market = getMarketInfo(stu);

    /* ---------- ③ 末班记录 ---------- */
    const repeatRows = await tblAs(db, DB, EXAM_SCORE_TABLE, STAGE, 'e')
      .leftJoin(`${tblRef(DB, EXAM_TABLE)} as x`, 'e.exam_id', 'x.id')
      .where('e.is_deleted', false)
      .andWhere('e.student_id', studentId)
      .andWhere('e.exam_result', ExamResult.FAIL)
      .select(
        'e.id',
        'e.exam_id',
        'e.exam_name',
        'e.total_score',
        'e.written_avg',
        'e.interview_score',
        'e.remark',
        'e.class_name',
        'x.exam_time',
        'x.exam_type',
      )
      .orderBy('x.exam_time', 'desc');

    const repeat = {
      repeatCount: Number(stu.repeat_count || 0),
      records: repeatRows.map((r: any) => ({
        id: r.id,
        examId: r.exam_id,
        examName: r.exam_name || '',
        examType: r.exam_type ?? null,
        examTypeName: EXAM_TYPE_NAME[r.exam_type] || '',
        examTime: fmtDateTime(r.exam_time),
        totalScore: r.total_score ?? null,
        writtenAvg: r.written_avg ?? null,
        interviewScore: r.interview_score ?? null,
        className: r.class_name || null,
        remark: r.remark || null,
      })),
    };

    /* ---------- ④ 宿舍 ---------- */
    /* ★ 2026-10-02 修：宿舍有**两套**，`dorm_id` 指向哪张表，就按哪一套展示。
     *
     * 【起因】学生转到就业阶段后被分到**就业基地宿舍**（`t_dorm`）—— 它是独立一套，
     *   只有房间、**没有床位表**，分派时只改学生主档的 `dorm_id` / `dorm_no`。
     *   而老代码只查实训床位表（`t_job_dorm_bed`）→ 查不到 → 显示"该学生目前没有住宿记录"，
     *   可列表的「宿舍」列明明写着 E-101。**列表有、详情空，自相矛盾。**
     *
     * 【次序】**先看主档的 dorm_id 指向哪套**（主档才是权威口径），再取明细：
     *   ① 命中 `t_dorm`     → 就业基地宿舍（不分床位号）
     *   ② 否则查实训床位表   → 实训基地宿舍（有床位号 1上/1下）
     *   ③ 都查不到但有宿舍号 → 用学生主档兜底（宁可弱一点，也不要"列表有、详情空"）
     */
    let dorm: any = null;
    if (stu.dorm_id) {
      const empDorm = await tbl(db, DB, EMP_DORM_TABLE, STAGE)
        .where({ id: stu.dorm_id, is_deleted: false })
        .first();

      if (empDorm) {
        dorm = {
          bedId: null,
          dormId: empDorm.id,
          dormNo: empDorm.dorm_no || stu.dorm_no || '',
          // 就业基地宿舍不分床位号（就是一间房）
          bedNo: null,
          building: empDorm.building || null,
          roomNo: empDorm.floor ? `${empDorm.floor} 层` : null,
          floor: empDorm.floor ?? null,
          roomType: empDorm.room_type ?? null,
          roomTypeName: DORM_TYPE_NAME[empDorm.room_type] || '',
          dormGender: empDorm.room_type ?? null,
          dormGenderName: DORM_GENDER_NAME[empDorm.room_type] || '',
          bedCount: empDorm.bed_total ?? null,
          // 就业基地宿舍没有"已住人数"字段，留空
          usedCount: null,
          checkInDate: null,
          dormSource: 'employment',
          dormSourceName: '就业基地宿舍',
        };
      } else {
        const bed = await tblAs(db, DB, DORM_BED_TABLE, STAGE, 'b')
          .leftJoin(`${tblRef(DB, DORM_TABLE)} as d`, 'b.dorm_id', 'd.id')
          .where('b.is_deleted', false)
          .andWhere('b.student_id', studentId)
          .select(
            'b.id',
            'b.dorm_id',
            'b.dorm_no',
            'b.bed_no',
            'b.bed_status',
            'b.check_in_date',
            'd.building',
            'd.room_no',
            'd.dorm_gender',
            'd.bed_count',
            'd.used_count',
          )
          .first();

        if (bed) {
          dorm = {
            bedId: bed.id,
            dormId: bed.dorm_id,
            dormNo: bed.dorm_no || '',
            bedNo: bed.bed_no || '',
            building: bed.building || null,
            roomNo: bed.room_no || null,
            dormGender: bed.dorm_gender ?? null,
            dormGenderName: DORM_GENDER_NAME[bed.dorm_gender] || '',
            bedCount: bed.bed_count ?? null,
            usedCount: bed.used_count ?? null,
            checkInDate: fmtDate(bed.check_in_date),
            dormSource: 'training',
            dormSourceName: '实训基地宿舍',
          };
        } else if (stu.dorm_no) {
          // ③ 兜底：两张表都查不到，但学生主档上确实写着宿舍号
          dorm = {
            bedId: null,
            dormId: stu.dorm_id,
            dormNo: stu.dorm_no || '',
            bedNo: null,
            building: null,
            roomNo: null,
            dormGender: null,
            dormGenderName: '',
            bedCount: null,
            usedCount: null,
            checkInDate: null,
            dormSource: null,
            dormSourceName: '宿舍档案不完整',
          };
        }
      }
    }

    /* ---------- ⑤ 考试信息（最近 N 次） ---------- */
    const examRows = await tblAs(db, DB, EXAM_SCORE_TABLE, STAGE, 'e')
      .leftJoin(`${tblRef(DB, EXAM_TABLE)} as x`, 'e.exam_id', 'x.id')
      .where('e.is_deleted', false)
      .andWhere('e.student_id', studentId)
      .select(
        'e.id',
        'e.exam_id',
        'e.exam_name',
        'e.paper_score',
        'e.machine_score',
        'e.written_avg',
        'e.interview_score',
        'e.total_score',
        'e.exam_result',
        'e.remark',
        'e.entry_by_name',
        'e.entry_time',
        'x.exam_time',
        'x.exam_type',
      )
      .orderBy('x.exam_time', 'desc')
      .limit(EXAM_RECENT_LIMIT);

    const exams = {
      /** 只展示最近几次（页面上有说明文案） */
      limit: EXAM_RECENT_LIMIT,
      /** 笔试 / 面试权重（页面文案：综合成绩 = 笔试 × 50% + 面试 × 50%） */
      writtenWeight: 50,
      interviewWeight: 50,
      list: examRows.map((r: any) => ({
        id: r.id,
        examId: r.exam_id,
        examName: r.exam_name || '',
        examType: r.exam_type ?? null,
        examTypeName: EXAM_TYPE_NAME[r.exam_type] || '',
        examTime: fmtDateTime(r.exam_time),
        paperScore: r.paper_score ?? null,
        machineScore: r.machine_score ?? null,
        // 参考页的「笔试分数」= 我们的「笔试部分均分」（卷面×50% + 机试×50%）
        writtenAvg: r.written_avg ?? null,
        interviewScore: r.interview_score ?? null,
        totalScore: r.total_score ?? null,
        examResult: r.exam_result ?? null,
        examResultName: EXAM_RESULT_NAME[r.exam_result] || '',
        /** 参考页叫「素质分析（非必填）」—— 就是成绩表的备注 */
        qualityAnalysis: r.remark || null,
        entryByName: r.entry_by_name || null,
        entryTime: fmtDateTime(r.entry_time),
      })),
    };

    /* ---------- ⑥ 班级信息 ---------- */
    const cls = stu.class_id
      ? await tbl(db, DB, CLASS_TABLE, STAGE).where({ id: stu.class_id, is_deleted: false }).first()
      : null;

    // 当前班级人数（本模块口径：学生主档里 class_id 指向该班且未删除）
    let studentCount = 0;
    if (cls) {
      const [row] = await tbl(db, DB, STUDENT_TABLE, STAGE)
        .where({ class_id: cls.id, is_deleted: false })
        .count({ n: 'id' });
      studentCount = Number((row as any)?.n || 0);
    }

    // 历史流转（花名册里这个学生的所有进出记录）
    const historyRows = await tbl(db, DB, CLASS_STUDENT_TABLE, STAGE)
      .where({ student_id: studentId, is_deleted: false })
      .orderBy('join_date', 'asc');

    const classBlock = {
      classId: cls?.id ?? null,
      className: cls?.class_name ?? null,
      classCode: cls?.class_code ?? null,
      deptCode: cls?.dept_code ?? null,
      deptName: DEPT_NAME[cls?.dept_code] || null,
      stage: readPhaseCode(cls) ?? null,
      stageName: STAGE_NAME[readPhaseCode(cls)] || '',
      classStatus: cls?.class_status ?? null,
      classStatusName: CLASS_STATUS_NAME[cls?.class_status] || '',
      classroom: cls?.classroom || null,
      headTeacherName: cls?.head_teacher_name || null,
      teacherName: cls?.teacher_name || null,
      assistantName: cls?.assistant_name || null,
      studentCount,
      history: historyRows.map((h: any) => ({
        id: h.id,
        classId: h.class_id,
        className: h.class_name || '',
        joinDate: fmtDate(h.join_date),
        joinType: h.join_type ?? null,
        joinTypeName: JOIN_TYPE_NAME[h.join_type] || '',
        leaveDate: fmtDate(h.leave_date),
        leaveType: h.leave_type ?? null,
        leaveTypeName: LEAVE_TYPE_NAME[h.leave_type] || '',
        leaveReason: h.leave_reason || null,
        status: h.status ?? null,
        statusName: CLASS_STUDENT_STATUS_NAME[h.status] || '',
      })),
    };

    /* ---------- ⑦ 就业信息（仅「已转就业」的学生） ---------- */
    // ★ 斌哥 2026-10-02：学生转就业后，班主任在「详情」里仍要能看到
    //   他的**就业日志**和**复盘记录** —— 否则一转出去就彻底看不见了。
    //
    // 只有「待就业(9) / 已就业(10)」才查（其余状态没必要多跑两次 SQL）。
    const transferred =
      stu.student_status === StudentStatus.WAIT_EMPLOY ||
      stu.student_status === StudentStatus.EMPLOYED;

    let employment: Record<string, unknown> | null = null;
    if (transferred) {
      const logRows = await tbl(db, DB, EMPLOYMENT_LOG_TABLE, STAGE)
        .where({ student_id: studentId, is_deleted: false })
        .orderBy('log_date', 'desc');
      const reviewRows = await tbl(db, DB, REVIEW_TABLE, STAGE)
        .where({ student_id: studentId, is_deleted: false })
        .orderBy('review_time', 'desc');

      employment = {
        logs: logRows.map((r: any) => ({
          id: r.id,
          logDate: fmtDate(r.log_date),
          resumeCount: Number(r.resume_count || 0),
          interviewInvite: Number(r.interview_invite || 0),
          interviewCount: Number(r.interview_count || 0),
          interviewTime: r.interview_time || null,
          company: r.company || null,
          position: r.position || null,
          salary: r.salary === null || r.salary === undefined ? null : Number(r.salary),
          interviewSituation: r.interview_situation || null,
        })),
        reviews: reviewRows.map((r: any) => ({
          id: r.id,
          reviewTime: r.review_time || '',
          interviewTime: r.interview_time || null,
          position: r.position || null,
          salary: r.salary === null || r.salary === undefined ? null : Number(r.salary),
          interviewConclusion: r.interview_conclusion ?? null,
          interviewConclusionName: INTERVIEW_CONCLUSION_NAME[r.interview_conclusion] || '',
          reviewConclusion: r.review_conclusion ?? null,
          reviewConclusionName: REVIEW_CONCLUSION_NAME[r.review_conclusion] || '',
          detail: r.detail || null,
        })),
      };
    }

    res.json(
      ok({
        basic,
        market,
        repeat,
        dorm,
        exams,
        classInfo: classBlock,
        employment,
      }),
    );
  }),
);
