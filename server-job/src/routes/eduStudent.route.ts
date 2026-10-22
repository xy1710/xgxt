/**
 * 学生管理路由（示例模块 —— 照着这个改成你自己的模块）
 *
 * ⚠️ 这是「增删改查」的完整示范，包含：
 *    - 列表查询（分页 + 筛选）
 *    - 详情查询
 *    - 新增（含参数校验）
 *    - 修改
 *    - 删除（逻辑删除）
 *
 * 各模块复制这个文件，改掉：
 *    1. 表名 t_student_base → 你自己的表
 *    2. 端口和接口前缀
 *    3. 字段名
 */

import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import {
  BizCode,
  STUDENT_STATUS_NAME,
  GENDER_NAME,
  DEPT_NAME,
  STAGE_NAME,
  Stage,
  isAutoFreezeStudentStatus,
  PayPaidStatus,
} from 'shared-types/edu';
import { ok, page } from '../utils/response';
import { db } from '../utils/db';
import { wrap } from '../utils/wrap';
// ★ P3 切读层：本文件「教务自己的」两张表在 `sms_edu`（**未归一** → 保持裸访问）；
//   跨域只读的 3 张（JOB_STUDENT / CLASS_STUDENT / FEE_CALL_TABLE）**已归一**
//   → 一律走 `tbl(db, 库, 表, 学段)`。
import { tbl, readPhaseCode } from '../teaching/shared/uniTable';
import { validate } from '../middleware/validate';
import { checkPermission } from '../middleware/auth';
import { BizError } from '../middleware/errorHandler';

export const studentRouter = Router();

/** 表名常量 —— 改这里就够（sms_edu 域，**未归一**，保持裸访问） */
const TABLE = 'sms_edu.t_student_base';

/**
 * ★ 2026-10-03：「欠费」标记要用到的两张表
 *
 * 为什么是两张：本页的学生是**两个来源合并**出来的（见下方 /list），
 *   教务自己的学生 → 欠费看教务缴费表（在 sms_edu）
 *   实训同步来的   → 欠费看就业库的催费单（在 sms_job）
 * 两边各查各的，别指望一张表能覆盖。
 *
 * ⚠️ 教务缴费表**没有 student_id**，只能按 student_no 关联
 *    （见 migrations-edu/20261002_001_add_payment_student_no.js）
 *
 * ★ P3 切读层：`EDU_PAYMENT_TABLE` 在 sms_edu（未归一）→ 裸访问；
 *   `FEE_CALL_TABLE`（sms_job.t_job_fee_call）**已归一** → 走 tbl()。
 */
const EDU_PAYMENT_TABLE = 'sms_edu.t_edu_payment';
const FEE_CALL_TABLE = 't_job_fee_call';

/**
 * 日期转 YYYY-MM-DD
 * mysql2 可能返回 Date 对象也可能返回字符串，统一处理一下，
 * 避免时区问题（不要用 toISOString，会差 8 小时）
 */
function fmtDate(v: any): string | undefined {
  if (!v) return undefined;
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return undefined;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ============================================================
 * 1. 查询学生列表
 *    GET /api/consult/student/list?page=1&size=20&className=G104
 * ============================================================ */

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
  studentNo: z.string().optional(),
  studentName: z.string().optional(),
  classId: z.string().optional(),
  className: z.string().optional(),
  deptCode: z.coerce.number().int().optional(),
  studentStatus: z.coerce.number().int().optional(),
  stage: z.coerce.number().int().optional(),
  keyword: z.string().optional(),
});

/* ============================================================
 * ★ 2026-10-03 合并：教务学生档案里也要能看到【实训学生】
 *
 * 斌哥拍板的方式：**查询时合并显示** ——
 *   实训学生的数据**只存一份**（在就业库 sms_job），教务这边"看在眼里"但改不了。
 *   这样不会出现"两份数据互相对不上"的问题。
 * ============================================================ */

/** 就业库的学生表（实训 / 就业学生在这里，走主连接 = sms_job；★ 已归一 → t_uni_student） */
const JOB_STUDENT = 't_student_base';
/** ★ 统一表 `edu_stage` 取值：实训 */
const JOB_STAGE = 'job' as const;
/**
 * 并进教务档案的实训侧学生状态
 *   实训中(8) / 待就业(9) / 已就业(10) / **休学(6)**
 *
 * ★ 2026-10-03 斌哥：休学学生也要能在教务总名单里看到
 *   （他还在校、只是暂时休学；教务是「全校记录中心」）
 *
 * ★★ 2026-10-05 斌哥：加 7（退学）——「退学后教务还显示在实训中，不符合事实」
 *   这个白名单是「实训/就业库里哪些状态的学生要合并进教务总名单」。
 *   原来**漏了 7**，于是退学的学生被 `whereIn` 直接过滤掉，
 *   教务页只剩班级库那条还停在「实训中(8)」的记录 → 显示成实训中。
 *
 *   【为什么不把 11（流失）也加进来】
 *   流失 = 咨询阶段就走了，从没进过实训/就业，跟这里无关。
 *   6/7/8/9/10 = 休学/退学/实训中/待就业/已就业，都是「进过实训就业」的事实。
 */
const JOB_STAGE_STATUS = [6, 7, 8, 9, 10];

/**
 * 大学部（班级库）的学生表 —— ★ 2026-10-04 斌哥：大学学生也要在教务档案里看到
 * 数据只存一份（在 sms_class），教务这边「看在眼里」只读，与实训学生同一套做法。
 *
 * ★ P3 切读层：老写法是「库.表」全限定字符串，`tbl()` 要把「库名 + 表名」分开传，
 *   所以拆成 CLASS_DB / CLASS_STUDENT 两个常量（与 `src/routes/dorm.route.ts` 同款）。
 */
const CLASS_STUDENT = 't_class_student';
const CLASS_DB = 'sms_class';
/** ★ 统一表 `edu_stage` 取值：大学 */
const CLASS_STAGE = 'class' as const;

/** 就业库（本路由主连接所在库） */
const JOB_DB = 'sms_job';

/**
 * 大学部班级库的 stage（201~206）→ 教务阶段体系（7~12）
 *
 * ⚠️ 两个模块阶段编号不同：班级库用 201~206 表示大学第一~第六阶段，
 *    教务/就业统一用 7~12。合并进教务列表前要映射，否则阶段名显示为空、
 *    阶段筛选筛不到。
 */
const UNIV_STAGE_MAP: Record<number, number> = {
  201: 7, 202: 8, 203: 9, 204: 10, 205: 11, 206: 12,
};
/** 大学部学生在教务体系里的阶段范围（7~12） */
const UNIV_STAGE_EDU = [7, 8, 9, 10, 11, 12];

/**
 * ★★ 跨库去重：同一个学号在多个库各存一份，只保留一条（2026-10-04斌哥拍板）
 *
 * 【为什么会有重复】
 *   本列表是**三个库合并显示**：
 *     · sms_edu.t_student_base（教务自己的）
 *     · sms_job.t_student_base（实训/就业）
 *     · sms_class.t_class_student（班级-大学部）
 *   实测 20 个学号在 job 库和 class 库**各存一份**（姓名/学号/宿舍都一样，
 *   只有 age 等少数字段不一致）→ 合并后同一个人显示两次。
 *   斌哥报的「名字和宿舍都是两个」就是这个。
 *
 * 【以谁为准 —— 斌哥定的规则】
 *   **学生处于什么阶段，就以那个阶段的库为主**：
 *     实训/就业（stage=13）> 大学部（7~12）> 教务（1~6）
 *   也就是「阶段越靠后，数据越新越准」：
 *     · 升了实训 → 以 job 库为准（实训侧字段最全，还有宿舍/催费关联）
 *     · 还在大学部 → 以 class 库为准（班级库是大学部的主场）
 *     · 都没进大学/实训 → 才用 edu 库
 *
 * 【为什么不直接删数据】
 *   三个库各有各的业务关联（缴费表催费单、审批单都指向各自的行），
 *   删一边会连带打断那边的关联。这里只改**显示口径**，数据一概不动。
 *
 * ★★ 【为什么状态不能「按 update_time 取最新的那条」—— 我踩过一次，别再踩】
 *   2026-10-05 修「退学后还显示实训中」时，我一度加了个逻辑：
 *   「同一个学号状态不一致时，谁的 update_time 新就显示谁的状态」。
 *   扫库一看就发现**这是错的**（scripts/check-status-mismatch.cjs）：
 *   全库 16 个学号状态不一致，其中 **15 个是正常业务**：
 *     job库 9待就业/10已就业 ←→ class库 8实训中
 *   意思是「学生实训结业转就业了，班级档案里的最后状态停在实训中」，
 *   本来就对。class 库那批数据的 update_time 通常比 job 库**新**
 *   （就业侧的记录一直在动，班级档案早就没人改了），
 *   一套上「按时间取新」→ **这15 个学生全部从「已就业/待就业」被显示回「实训中」**，
 *   制造出一个比原bug 大得多的错。
 *
 * 【那「退学后显示实训中」到底怎么修的】
 *   根因不在去重，而在**查询白名单**：实训学生是
 *   `whereIn('student_status', JOB_STAGE_STATUS)`查出来的，
 *   而 `JOB_STAGE_STATUS` 原来漏了 7（退学）→ 退学的 job 记录**被过滤掉**，
 *   合并池里只剩 class 库那条「实训中」→ 显示成实训中。
 *   所以：① 白名单补 7（显示层根治）② 退学/休学/复学时跨库同步 class 库（治本）。
 *   去重的「整行按来源优先级取」保持原样，**状态跟着赢家走，不另判**。
 *
 * @returns 去重后的数组；同时给每条打上 `__dupFrom` 说明它顶掉了哪些来源（排查用）
 */
function dedupeByStudentNo(rows: any[]): any[] {
  // 阶段优先级：数字越大越优先（实训 13 > 大学 7~12 > 教务 1~6）
  const PRIORITY: Record<string, number> = {
    edu: 0,
    class: 10,
    job: 20,
  };

  const byNo = new Map<string, any>();
  const noKey = (r: any): string => String(r.student_no || r.id || '').trim();

  for (const r of rows) {
    const key = noKey(r);
    // 没有学号的脏数据不参与去重，原样保留（否则会被当成同一个 key 吃掉）
    if (!key) {
      byNo.set(`__norow_${byNo.size}`, r);
      continue;
    }
    const prev = byNo.get(key);
    if (!prev) {
      byNo.set(key, r);
      continue;
    }
    // 已在列表里的那条 vs 当前这条：谁的来源优先级高留谁
    //
    // ⚠️ 这里**整行留优先级高的，状态也跟着它走**，不要另外按 update_time 取新状态。
    //   2026-10-05 斌哥报「退学后还显示实训中」时，试过「谁的 update_time 新听谁的」，
    //   实测**会制造更大的错**（见下方「为什么不能按时间取新」注释）。
    const prevP = PRIORITY[prev.__source] ?? -1;
    const curP = PRIORITY[r.__source] ?? -1;
    if (curP > prevP) {
      byNo.set(key, { ...r, __dupFrom: [prev.__source, ...(prev.__dupFrom || [])] });
    } else {
      prev.__dupFrom = [r.__source, ...(prev.__dupFrom || [])];
    }
  }

  return Array.from(byNo.values());
}

/**
 * 把列表筛选条件套到一个 query 上
 *
 * ⚠️ 教务学生 和 实训学生 两边共用同一套筛选条件，
 *    保证"筛什么，两边都跟着筛"，否则合并出来的列表会对不上。
 *
 * @param opts.skipStage 跳过「学习阶段」条件 —— 实训学生统一算「实训」阶段，
 *                       不能再按他们库里的 stage 字段筛（见下方 /list 的说明）
 */
function applyListFilters(query: any, q: any, opts: { skipStage?: boolean } = {}) {
  if (q.studentNo) query.andWhere('student_no', 'like', `%${q.studentNo}%`);
  if (q.studentName) query.andWhere('student_name', 'like', `%${q.studentName}%`);
  if (q.classId) query.andWhere('class_id', q.classId);
  if (q.className) query.andWhere('class_name', q.className);
  if (q.deptCode) query.andWhere('dept_code', q.deptCode);
  if (q.studentStatus) query.andWhere('student_status', q.studentStatus);
  if (q.stage && !opts.skipStage) query.andWhere('stage', q.stage);
  if (q.keyword) {
    query.andWhere((qb: any) => {
      qb.where('student_no', 'like', `%${q.keyword}%`)
        .orWhere('student_name', 'like', `%${q.keyword}%`)
        .orWhere('phone', 'like', `%${q.keyword}%`);
    });
  }
  return query;
}

studentRouter.get(
  '/list',
  validate(listSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as z.infer<typeof listSchema>;

    // ---- 教务自己的学生（sms_edu）----
    const eduRows: any[] = await applyListFilters(db(TABLE).where('is_deleted', false), q).select('*');

    // ---- ★ 实训 / 就业的学生（sms_job，合并显示，只读）----
    //
    // ⚠️ 学习阶段筛选的坑（2026-10-03 修）：
    //   实训学生的「学习阶段」显示成 **实训(13)**，但他们库里的 stage 字段并不是 13
    //   （历史数据是 3 之类）。如果照搬 stage 条件去查实训表：
    //     · 筛「实训」       → 查 stage=13 → 查不到（bug：明明有实训学生）
    //     · 筛「初中部二期」(3) → 实训表里 stage=3 的被带出来（bug：混进别的阶段）
    //   所以规则改成：
    //     · 筛「实训」      → 实训学生**全要**（不看他们库里的 stage）
    //     · 筛「其他阶段」  → 实训学生**一个都不出现**（他们只属于实训阶段）
    //     · 不筛阶段        → 两边都要
    let jobRows: any[] = [];
    if (!q.stage || q.stage === Stage.TRAINING) {
      jobRows = await applyListFilters(
        tbl(db, JOB_DB, JOB_STUDENT, JOB_STAGE).where('is_deleted', false).whereIn('student_status', JOB_STAGE_STATUS),
        q,
        { skipStage: true },
      ).select('*');
    }

    // ---- ★ 大学部学生（sms_class，合并显示，只读）----
    //   只在「不筛阶段 / 筛大学阶段(7~12)」时出现；筛实训(13)等其它阶段时不出现。
    //   stage 映射 201~206 → 7~12，再按 q.stage 过滤。
    let classRows: any[] = [];
    if (!q.stage || UNIV_STAGE_EDU.includes(q.stage)) {
      classRows = await applyListFilters(
        tbl(db, CLASS_DB, CLASS_STUDENT, CLASS_STAGE).where('is_deleted', false),
        q,
        { skipStage: true },
      ).select('*');
      classRows = classRows
        .map((r: any) => {
          // ★ #23 方案B：classRows 来自 t_uni_student（老表 sms_class.t_class_student）→ 阶段码走 readPhaseCode
          const phase = readPhaseCode(r);
          return { ...r, stage: UNIV_STAGE_MAP[phase] ?? phase };
        })
        .filter((r: any) => !q.stage || r.stage === q.stage);
    }

    // ---- 合并：三来源都打上来源标记 ----
    const mergedAll = [
      ...eduRows.map((r) => ({ ...r, __source: 'edu' as const })),
      ...jobRows.map((r) => ({ ...r, __source: 'job' as const, stage: Stage.TRAINING })),
      ...classRows.map((r) => ({ ...r, __source: 'class' as const })),
    ].sort(
      (a: any, b: any) =>
        new Date(b.create_time || 0).getTime() - new Date(a.create_time || 0).getTime(),
    );

    // ★★ 2026-10-04跨库去重：同一学号在 job/class 两库各存一份，
    //   合并后同一个人会显示两次（斌哥报的「名字和宿舍都是两个」）。
    //   规则：学生处于什么阶段就以那个阶段的库为主（实训 > 大学 > 教务）。
    //   ⚠️ 必须在分页**之前**去重，否则 total 也不对。
    const merged = dedupeByStudentNo(mergedAll);
    // 注：__dupFrom 只是排查用，最终出参走下面的 map（只挑业务字段）→ 不会外泄给前端。

    const total = merged.length;
    const rows = merged.slice((q.page - 1) * q.size, (q.page - 1) * q.size + q.size);

    // ---- ★ 批量取「欠费」标记（与「班级信息管理」同一口径）----
    //
    // 教务学生：教务缴费表里有「未缴」且**未冻结**的记录
    //   ⚠️ 排除冻结：休学/退学的学生缴费记录会被自动冻结，冻结的单子不参与催缴，
    //      算成"欠费"会误导（班级信息管理排的是催费单状态，同理）
    //   表只有 student_no 没有 student_id，所以按学号匹配
    // 实训学生：就业库催费单里有未缴清的（call_status != 3 = 已缴清）
    const unpaidEduNo = new Set<string>(); // 存 student_no
    const unpaidJobId = new Set<string>(); // 存 id

    const eduNos = rows
      .filter((r: any) => r.__source === 'edu' && r.student_no)
      .map((r: any) => r.student_no);
    const jobIds = rows.filter((r: any) => r.__source === 'job').map((r: any) => r.id);

    if (eduNos.length) {
      const fees = await db(EDU_PAYMENT_TABLE)
        .whereIn('student_no', eduNos)
        .andWhere('is_deleted', false)
        .andWhere('pay_status', PayPaidStatus.UNPAID)
        .andWhere('frozen', false)
        .select('student_no');
      fees.forEach((f: any) => unpaidEduNo.add(f.student_no));
    }
    if (jobIds.length) {
      const fees = await tbl(db, JOB_DB, FEE_CALL_TABLE, JOB_STAGE)
        .whereIn('student_id', jobIds)
        .andWhere('is_deleted', false)
        .andWhereNot('call_status', 3) // 3 = 已缴清
        .select('student_id');
      fees.forEach((f: any) => unpaidJobId.add(f.student_id));
    }

    // ---- 转换成前端要的格式（双返回枚举名）----
    const list = rows.map((r: any) => ({
      studentId: r.id,
      studentNo: r.student_no,
      studentName: r.student_name,
      gender: r.gender,
      genderName: GENDER_NAME[r.gender] || '',
      deptCode: r.dept_code,
      className: r.class_name,
      studentStatus: r.student_status,
      studentStatusName: STUDENT_STATUS_NAME[r.student_status] || '',
      phone: r.phone,
      headTeacherName: r.head_teacher_name,

      // ===== 学生档案页要展示的字段（取自原型）=====
      age: r.age ?? undefined,
      parentPhone: r.parent_phone || undefined,
      dormNo: r.dorm_no || undefined,
      education: r.education || undefined,
      enrollDate: fmtDate(r.enroll_date),
      attendanceRate: r.attendance_rate != null ? Number(r.attendance_rate) : undefined,
      lastClassCount: r.last_class_count ?? undefined,
      stage: r.stage ?? undefined,
      stageName: r.stage ? STAGE_NAME[r.stage] || '' : '',
      remark: r.remark || undefined,
      quality: r.quality || undefined,
      /** 欠费标记（各来源各查各的库，见上方说明；大学部暂不参与欠费计算） */
      hasUnpaid:
        r.__source === 'edu' ? unpaidEduNo.has(r.student_no) : unpaidJobId.has(r.id),

      // ★ 来源：edu = 教务自己的学生（可编辑）/ job = 实训 / class = 大学部（后两者只读）
      source: r.__source as 'edu' | 'job' | 'class',
      sourceName: r.__source === 'job' ? '实训' : r.__source === 'class' ? '大学部' : '教务',
      /** 实训 / 大学部来的学生不能在本页编辑（唯一数据源在各自模块） */
      readonly: r.__source === 'job' || r.__source === 'class',
    }));

    res.json(page(list, Number(total), q));
  }),
);

/* ============================================================
 * 1.0 班级下拉选项
 *    GET /api/edu/student/class-options?deptCode=2
 *
 * ★ 2026-10-04 斌哥：「班级选项不能实时更新，看着像写死的」
 *
 * 【真因】前端 StudentList.vue 的 CLASS_OPTIONS 是**硬编码**的
 *   初高部 ['预科1班','初一1班',…]、大学部 ['Q16'…'Q23']
 *   —— 那是原型里的 mock 数据。真实班级早就改成 Q1~Q6 了，
 *   硬编码的下拉选出来的值**在库里根本不存在**（选了等于白选）。
 *
 * 【为什么必须后端给】
 *   本页学生是**三个来源合并**的（见 /list）：
 *     教务 sms_edu.t_student_base（初高部为主）
 *     大学 sms_class.t_class_student
 *     实训 sms_job.t_student_base
 *   三个库各有一套班级名，只有后端知道全量，前端拼不出来。
 *
 * 【返回】按部门给出去重后的班级名数组，自然排序（Q2 排在 Q10 前面）
 * ============================================================ */

studentRouter.get(
  '/class-options',
  validate(z.object({ deptCode: z.coerce.number().int().min(1).max(2).optional() })),
  wrap(async (req, res) => {
    const { deptCode } = (req as any).validated as { deptCode?: number };

    const names = new Set<string>();
    const collect = (rows: any[]): void => {
      rows.forEach((r: any) => {
        if (r.class_name) names.add(r.class_name);
      });
    };

    // ---- 教务自己的学生（初高部主要来源）----
    collect(
      await db(TABLE)
        .where('is_deleted', false)
        .whereNotNull('class_name')
        .modify((qb) => {
          if (deptCode) qb.andWhere('dept_code', deptCode);
        })
        .distinct()
        .select('class_name'),
    );

    // ---- 大学部（sms_class）+ 实训（sms_job）----
    //   deptCode=1（初高部）时不查：这两个库里的班不属于初高部
    if (!deptCode || deptCode === 2) {
      collect(
        await tbl(db, CLASS_DB, CLASS_STUDENT, CLASS_STAGE).where('is_deleted', false).whereNotNull('class_name').distinct().select('class_name'),
      );
      collect(
        await tbl(db, JOB_DB, JOB_STUDENT, JOB_STAGE).where('is_deleted', false).whereNotNull('class_name').distinct().select('class_name'),
      );
    }

    // 自然排序：Q2 < Q10（纯字符串排会把 Q10 放到 Q2 前面）
    const list = [...names].sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }));

    res.json(ok(list));
  }),
);

/* ============================================================
 * 1.1 统计卡数据
 *    GET /api/edu/student/stats?deptCode=1
 *
 *    口径取自原型 renderStats()：
 *      总人数 / 在读学生(预在读+正式在读) / 试学中 / 休学+退学
 *    一次 SQL group by 搞定，不查 4 遍
 * ============================================================ */

studentRouter.get(
  '/stats',
  validate(z.object({ deptCode: z.coerce.number().int().min(1).max(2).optional() })),
  wrap(async (req, res) => {
    const { deptCode } = (req as any).validated as { deptCode?: number };

    // 教务自己的学生
    const eduRows = await db(TABLE)
      .where('is_deleted', false)
      .modify((qb) => {
        if (deptCode) qb.andWhere('dept_code', deptCode);
      })
      .select('student_status')
      .count({ c: '*' })
      .groupBy('student_status');

    // ★ 实训 / 就业的学生（合并进统计）
    const jobRows = await tbl(db, JOB_DB, JOB_STUDENT, JOB_STAGE)
      .where('is_deleted', false)
      .whereIn('student_status', JOB_STAGE_STATUS)
      .modify((qb) => {
        if (deptCode) qb.andWhere('dept_code', deptCode);
      })
      .select('student_status')
      .count({ c: '*' })
      .groupBy('student_status');

    // ★ 大学部的学生（合并进统计）
    const classRows = await tbl(db, CLASS_DB, CLASS_STUDENT, CLASS_STAGE)
      .where('is_deleted', false)
      .modify((qb) => {
        if (deptCode) qb.andWhere('dept_code', deptCode);
      })
      .select('student_status')
      .count({ c: '*' })
      .groupBy('student_status');

    let total = 0;
    let active = 0;   // 预在读(4) + 正式在读(5) + 实训中(8)
    let trial = 0;    // 试学中(3)
    let inactive = 0; // 休学(6) + 退学(7)

    for (const r of [...(eduRows as any[]), ...(jobRows as any[]), ...(classRows as any[])]) {
      const c = Number(r.c);
      total += c;
      if (r.student_status === 4 || r.student_status === 5 || r.student_status === 8) active += c;
      else if (r.student_status === 3) trial += c;
      else if (r.student_status === 6 || r.student_status === 7) inactive += c;
    }

    res.json(ok({ total, active, trial, inactive }));
  }),
);

/* ============================================================
 * 2. 查询学生详情
 *    GET /api/consult/student/detail?id=xxx
 * ============================================================ */

studentRouter.get(
  '/detail',
  validate(z.object({ id: z.string().min(1, '必须传 id') })),
  wrap(async (req, res) => {
    const { id } = (req as any).validated as { id: string };

    const row = await db(TABLE).where({ id, is_deleted: false }).first();

    if (!row) {
      throw new BizError(BizCode.STUDENT_NOT_FOUND, '学生不存在');
    }

    res.json(ok({
      id: row.id,
      studentNo: row.student_no,
      studentName: row.student_name,
      gender: row.gender,
      genderName: GENDER_NAME[row.gender] || '',
      age: row.age,
      deptCode: row.dept_code,
      deptName: DEPT_NAME[row.dept_code] || '',
      classId: row.class_id,
      className: row.class_name,
      studentStatus: row.student_status,
      studentStatusName: STUDENT_STATUS_NAME[row.student_status] || '',
      phone: row.phone,
      parentPhone: row.parent_phone,
      education: row.education,
      enrollDate: row.enroll_date,
      remark: row.remark,
      createTime: row.create_time,
    }));
  }),
);

/* ============================================================
 * 3. 新增学生
 *    POST /api/consult/student/add
 * ============================================================ */

const addSchema = z.object({
  studentNo: z.string().min(1, '学号必填'),
  studentName: z.string().min(1, '姓名必填'),
  gender: z.coerce.number().int().min(1).max(2, '性别只能是 1(男) 或 2(女)'),
  age: z.coerce.number().int().min(10).max(60).optional(),
  deptCode: z.coerce.number().int().min(1).max(2, '部门只能是 1(初高部) 或 2(大学部)'),
  classId: z.string().optional(),
  phone: z.string().max(20).optional(),
  parentPhone: z.string().max(20).optional(),
  education: z.string().max(50).optional(),
  enrollDate: z.string().optional(),
  remark: z.string().max(500).optional(),
  /** 学生状态：1 待咨询 … 5 正式在读 / 6 休学 / 7 退学（见 StudentStatus） */
  studentStatus: z.coerce.number().int().min(1).max(11).optional(),

  // ===== 学生档案页涉及的字段（原型）=====
  // ⚠️ 不写进 schema 的话，zod 会把这些字段静默丢掉，导致「改了存不进去」
  className: z.string().max(50).optional(),
  dormNo: z.string().max(20).optional(),
  quality: z.string().max(500).optional(),
  stage: z.coerce.number().int().min(1).max(13).optional(),
  attendanceRate: z.coerce.number().min(0).max(100).optional(),
  lastClassCount: z.coerce.number().int().min(0).optional(),
});

studentRouter.post(
  '/add',
  checkPermission('edu:student:add'),
  validate(addSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof addSchema>;

    // ---- 检查学号是否重复 ----
    const exists = await db(TABLE).where({ student_no: body.studentNo, is_deleted: false }).first();
    if (exists) {
      throw new BizError(BizCode.STUDENT_NO_EXISTS, `学号 ${body.studentNo} 已存在，请勿重复添加`);
    }

    // ---- 插入 ----
    const id = randomUUID();
    await db(TABLE).insert({
      id,
      student_no: body.studentNo,
      student_name: body.studentName,
      gender: body.gender,
      age: body.age ?? null,
      dept_code: body.deptCode,
      class_id: body.classId ?? null,
      phone: body.phone ?? null,
      parent_phone: body.parentPhone ?? null,
      education: body.education ?? null,
      enroll_date: body.enrollDate ?? null,
      remark: body.remark ?? null,

      // ===== 学生档案页涉及的字段（原型）=====
      class_name: body.className ?? null,
      dorm_no: body.dormNo ?? null,
      quality: body.quality ?? null,
      stage: body.stage ?? null,
      attendance_rate: body.attendanceRate ?? null,
      last_class_count: body.lastClassCount ?? 0,
      student_status: body.studentStatus ?? 1, // 不传则默认「待咨询」
      is_deleted: false,
      create_time: new Date(),
      create_by: req.user?.userId || 'system',
    });

    res.json(ok({ id }, '新增成功'));
  }),
);

/* ============================================================
 * 4. 修改学生
 *    PUT /api/consult/student/update
 * ============================================================ */

const updateSchema = addSchema.extend({
  id: z.string().min(1, '必须传 id'),
});

studentRouter.put(
  '/update',
  checkPermission('edu:student:edit'),
  validate(updateSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof updateSchema>;

    const exists = await db(TABLE).where({ id: body.id, is_deleted: false }).first();
    if (!exists) {
      throw new BizError(BizCode.STUDENT_NOT_FOUND, '学生不存在');
    }

    // 学号改了要检查是否和别人的冲突
    if (body.studentNo !== exists.student_no) {
      const dup = await db(TABLE)
        .where({ student_no: body.studentNo, is_deleted: false })
        .whereNot('id', body.id)
        .first();
      if (dup) {
        throw new BizError(BizCode.STUDENT_NO_EXISTS, `学号 ${body.studentNo} 已被占用`);
      }
    }

    // ⚠️ 注意：这里逐个字段判断是否为 undefined。
    //    前端没提交的字段【保持原值】，绝不能写 null ——
    //    否则编辑一次就会把班级、宿舍、阶段、出勤率这些数据悄悄清空。
    const patch: Record<string, any> = {
      student_no: body.studentNo,
      student_name: body.studentName,
      gender: body.gender,
      dept_code: body.deptCode,
      update_time: new Date(),
      update_by: req.user?.userId || 'system',
    };

    const nullable = [
      'age',
      'classId',
      'phone',
      'parentPhone',
      'education',
      'enrollDate',
      'remark',
      // ===== 学生档案页涉及的字段（原型）=====
      'className',
      'dormNo',
      'quality',
      'stage',
      'attendanceRate',
      'lastClassCount',
    ] as const;

    for (const key of nullable) {
      if (key in body) patch[key] = body[key] ?? null;
    }

    // 驼峰 → 下划线
    const COLUMN_MAP: Record<string, string> = {
      classId: 'class_id',
      parentPhone: 'parent_phone',
      enrollDate: 'enroll_date',
      className: 'class_name',
      dormNo: 'dorm_no',
      attendanceRate: 'attendance_rate',
      lastClassCount: 'last_class_count',
    };

    const dbPatch: Record<string, any> = { ...patch };
    for (const [camel, snake] of Object.entries(COLUMN_MAP)) {
      if (camel in dbPatch) {
        dbPatch[snake] = dbPatch[camel];
        delete dbPatch[camel];
      }
    }

    /* ===== 学生状态变更 → 同步缴费冻结状态 =====
     *
     * 规则：变成「休学 / 退学」→ TA 名下所有缴费记录自动冻结；
     *      从休学/退学改回在读 → 把当初【由系统冻结】的那批解冻。
     *
     * ⚠️ 只解冻 auto_frozen = 1 的记录：教务手动冻结的那批（比如欠费冻结）
     *    不该因为学生复学就被悄悄解冻。
     */
    let frozenCount = 0;
    let unfrozenCount = 0;
    const newStatus = body.studentStatus;
    const oldStatus = Number((exists as any).student_status);
    const changed = newStatus != null && Number(newStatus) !== oldStatus;
    const becomeCold = changed && isAutoFreezeStudentStatus(Number(newStatus));
    const recoverFromCold = changed && isAutoFreezeStudentStatus(oldStatus) && !becomeCold;

    if (changed) dbPatch.student_status = Number(newStatus);

    // 学号可能被改过，新旧学号挂着的历史缴费记录都要管到
    const stuNos = Array.from(
      new Set([String((exists as any).student_no), String(body.studentNo)].filter(Boolean)),
    );

    await db(TABLE).where({ id: body.id }).update(dbPatch);

    if (changed && stuNos.length > 0) {
      const now = new Date();
      const by = req.user?.userId || 'system';

      if (becomeCold) {
        frozenCount = await db('sms_edu.t_edu_payment')
          .whereIn('student_no', stuNos)
          .where('is_deleted', false)
          .where('frozen', false)
          .update({ frozen: 1, auto_frozen: 1, update_time: now, update_by: by });
      } else if (recoverFromCold) {
        unfrozenCount = await db('sms_edu.t_edu_payment')
          .whereIn('student_no', stuNos)
          .where('is_deleted', false)
          .where('auto_frozen', 1)
          .update({ frozen: 0, auto_frozen: 0, update_time: now, update_by: by });
      }
    }

    const extra =
      frozenCount > 0
        ? `，已同步冻结 ${frozenCount} 条缴费记录`
        : unfrozenCount > 0
          ? `，已同步解冻 ${unfrozenCount} 条缴费记录`
          : '';

    res.json(ok({ frozenCount, unfrozenCount }, `修改成功${extra}`));
  }),
);

/* ============================================================
 * 5. 删除学生（逻辑删除）
 *    DELETE /api/consult/student/delete/:id
 * ============================================================ */

studentRouter.delete(
  '/delete/:id',
  checkPermission('edu:student:delete'),
  wrap(async (req, res) => {
    const { id } = req.params;

    const exists = await db(TABLE).where({ id, is_deleted: false }).first();
    if (!exists) {
      throw new BizError(BizCode.STUDENT_NOT_FOUND, '学生不存在或已被删除');
    }

    // ⚠️ 逻辑删除！不要用 .del()
    await db(TABLE).where({ id }).update({
      is_deleted: true,
      update_time: new Date(),
      update_by: req.user?.userId || 'system',
    });

    res.json(ok(null, '删除成功'));
  }),
);

export default studentRouter;
