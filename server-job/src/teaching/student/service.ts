/**
 * 学生档案适配器（Adapter）
 * ============================================================
 *
 * 【★ 2026-10-21 用户口径：学生档案只剩三个学段】
 *   删除「就业」（job）与「教务」（edu）两个入口，保留初高 / 大学 / 就业部：
 *     · job 的数据与就业部是同一批人（sms_job 里 stage_key=job、dept_code=3），
 *       两个入口指向同一批学生，只会让人以为「就业」和「就业部」是两拨人
 *     · edu 是 sms_edu.t_student_base（教务宿舍模块的学生副本），档案里再列一遍
 *       既重复又对不上号
 *   两张表的数据一条没删 —— 教务宿舍、实训模块还在用，只是档案不再列这两个入口。
 *
 * 【合并时必须按学号去重】
 *   同一个人可能同时存在于多个库：例如「大学 → 就业部」的人，class 库和 sms_job 库各一条。
 *   去重规则：保留**阶段更靠后**的那条（emp > class > jh）。
 *
 * 【「全部」= 统一页的默认视图 = 原来「教务」页提供的「全校总台账」能力】
 *   合并前只有教务页能看全校，所以它在页面里自己拼了三个库。
 *   现在统一页的「全部」就是这个能力，而且**去重逻辑统一在适配器里**，更准。
 */

import { BizCode } from 'shared-types';
import { BizError } from '../../middleware/errorHandler';
import * as repoClassJh from './repo.classJh';
import * as repoClass from './repo.class';
import * as repoEmp from './repo.emp';
import type {
  StudentDetail,
  StudentListQuery,
  StudentRow,
  StudentSaveBody,
  StudentSaveResult,
  StudentStage,
  StudentStageMeta,
  StudentUpgradeRow,
} from '../shared/dto';
import { STUDENT_DEDUP_PRIORITY, STUDENT_STAGES, STUDENT_STAGE_NAME } from '../shared/dto';
import { assertStageCodeEx, visibleStagesEx } from '../shared/stageAccess';
import { listClassesByStage } from '../shared/classOptions';
import { loadStagePlanOptions, mergePhaseOptions } from '../shared/stagePlans';
import { loadSchemeStagesForStage } from '../shared/stageSchemes';
import { db } from '../../utils/db';
import { StudentStatus } from 'shared-types';
import type { StudentRepo, StudentStat } from './types';
import { assertStudentsInScope } from '../shared/dataScope';
import { randomUUID } from 'crypto';
import { db as classDb } from '../../class/db';
import { db as jhDb } from '../../class-jh/utils/db';
import { tbl, tblInsTrx, tblTrx, phaseCodeCol } from '../shared/uniTable';
import { resolveStageName } from '../../class-jh/utils/stageDict';
import { insertUpgrade, listByStudentNo } from './upgrade.repo';
import { ClassStatus, CLASS_STATUS_NAME, DeptCode } from 'shared-types';

/**
 * ★ 2026-10-21：学生档案只剩三个学段（就业、教务已在用户口径下删除）
 *   数据没删 —— sms_job / sms_edu 两张学生表还在，只是档案不再列这两个入口。
 */
const REPOS: Record<StudentStage, StudentRepo> = {
  jh: repoClassJh.repo,
  class: repoClass.repo,
  // ★ 就业部：按 dept_code=3 取数（含 stage_key=job 的那 5 个实训学生）
  emp: repoEmp.repo,
};

/** 各学段学生档案页的权限码（= 合并前各学段原页面的权限码，一个都没改） */
const CODES: Record<StudentStage, string | string[]> = {
  jh: 'classjh:student:view',
  class: 'class:student:view',

  emp: 'job:empArchive:view',
};

/** 各学段所属门户模块（与全站 moduleOfPageCode 口径一致） */
const MODULE: Record<StudentStage, string> = {
  jh: 'class-jh',
  class: 'class',
  emp: 'job',
};

const LABEL = '学生档案';

const nameOf = (s: StudentStage): string => STUDENT_STAGE_NAME[s];
const moduleOf = (s: StudentStage): string => MODULE[s];

export function assertStageView(user: any, stage: StudentStage): Promise<void> {
  return assertStageCodeEx(user, stage, CODES, LABEL, nameOf, moduleOf);
}

export function visibleStages(user: any): Promise<StudentStage[]> {
  return visibleStagesEx(user, STUDENT_STAGES, CODES, LABEL, nameOf, moduleOf);
}

/* ============================================================
 * 合并 + 去重（列表与统计共用同一份，保证「卡片 = 列表」）
 * ============================================================ */

async function mergedRows(
  q: StudentListQuery,
  user: any,
): Promise<{ rows: StudentRow[]; stages: StudentStage[] }> {
  const stages: StudentStage[] = q.stage ? [q.stage] : await visibleStages(user);
  if (!stages.length) throw new BizError(BizCode.NO_OPERATION_PERMISSION, '没有学生档案的访问权限');
  if (q.stage) await assertStageView(user, q.stage);

  const parts = await Promise.all(stages.map((s) => REPOS[s].list(q, user)));
  let rows = parts.flat();

  // 单学段查询不需要去重（同一张表内学号本就唯一）
  if (stages.length > 1) rows = dedupeByStudentNo(rows);

  rows.sort((a, b) => {
    const ta = a.createTime || '';
    const tb = b.createTime || '';
    if (ta !== tb) return ta < tb ? 1 : -1;
    return a.studentNo.localeCompare(b.studentNo, 'zh-Hans-CN');
  });
  await attachSchemeStageNames(rows);
  return { rows, stages };
}

/**
 * ★ 2026-10-21：把「班级绑定的阶段方案阶段名」挂到行上
 *
 * 【为什么在 service 层做】
 *   三个仓储各查一遍班级表就重复三次；这里按学段分组、每学段一次 whereIn，
 *   总共最多 3 次查询（通常只有 1 次）。
 *
 * ⚠️ 三个学段的班级表在三个库，**必须用各自的连接**：
 *   `tbl()` 在统一表开关关闭时是 `db(table)`（不带库前缀），用错连接会查错库。
 */
async function attachSchemeStageNames(rows: StudentRow[]): Promise<void> {
  const need = new Map<StudentStage, Set<string>>();
  for (const r of rows) {
    if (!r.classId) continue;
    if (!need.has(r.stage)) need.set(r.stage, new Set());
    need.get(r.stage)!.add(r.classId);
  }
  if (!need.size) return;

  const nameOf = new Map<string, string>();
  for (const [stage, ids] of need) {
    const src = CLASS_SRC[stage];
    try {
      const list = (await tbl(src.conn, src.schema, src.table, stage)
        .whereIn('id', [...ids])
        .select('id', 'scheme_stage_name')) as Array<Record<string, any>>;
      for (const c of list) {
        const nm = String(c.scheme_stage_name ?? '').trim();
        if (nm) nameOf.set(String(c.id), nm);
      }
    } catch {
      /* 方案字段没迁移 / 库没起来：阶段列退回阶段码名称，不影响列表 */
    }
  }
  for (const r of rows) r.schemeStageName = r.classId ? (nameOf.get(r.classId) ?? null) : null;
}

/** 学段 → 班级表所在库（班级绑定的阶段方案在班级表上） */
const CLASS_SRC: Record<StudentStage, { conn: any; schema: string; table: string }> = {
  jh: { conn: jhDb, schema: 'sms_class_jh', table: 't_class_info' },
  class: { conn: classDb, schema: 'sms_class', table: 't_class_info' },
  emp: { conn: db, schema: 'sms_job', table: 't_job_class' },
};

/**
 * 按学号去重：同学号保留**阶段更靠后**的那条
 *
 * ⚠️ 学号为空的记录**不参与去重**（不聚合无号的行，否则会把不同的人并成一条）
 */
function dedupeByStudentNo(rows: StudentRow[]): StudentRow[] {
  const rank = (s: StudentStage): number => {
    const i = STUDENT_DEDUP_PRIORITY.indexOf(s);
    return i < 0 ? STUDENT_DEDUP_PRIORITY.length : i;
  };
  const best = new Map<string, StudentRow>();
  const noNo: StudentRow[] = [];
  for (const r of rows) {
    const key = (r.studentNo || '').trim();
    if (!key) {
      noNo.push(r);
      continue;
    }
    const cur = best.get(key);
    if (!cur || rank(r.stage) < rank(cur.stage)) best.set(key, r);
  }
  return [...best.values(), ...noNo];
}

/* ============================================================
 * 对外能力
 * ============================================================ */

export async function listStudents(
  q: StudentListQuery,
  user: any,
): Promise<{ total: number; page: number; size: number; list: StudentRow[] }> {
  const { rows } = await mergedRows(q, user);
  const start = (q.page - 1) * q.size;
  return { total: rows.length, page: q.page, size: q.size, list: rows.slice(start, start + q.size) };
}

export async function summaryStudents(q: StudentListQuery, user: any): Promise<StudentStat> {
  const { rows } = await mergedRows({ ...q, page: 1, size: Number.MAX_SAFE_INTEGER }, user);
  const out: StudentStat = {
    total: rows.length,
    studying: 0,
    trial: 0,
    suspended: 0,
    quit: 0,
    unassigned: 0,
  };
  for (const r of rows) {
    if (r.studentStatus === StudentStatus.STUDYING) out.studying += 1;
    if (r.studentStatus === StudentStatus.TRIAL) out.trial += 1;
    if (r.studentStatus === StudentStatus.SUSPENDED) out.suspended += 1;
    if (r.studentStatus === StudentStatus.QUIT) out.quit += 1;
    if (!r.dormId || !r.dormNo) out.unassigned += 1;
  }
  return out;
}

export async function getStudentDetail(
  stage: StudentStage,
  id: string,
  user: any,
): Promise<StudentDetail> {
  await assertStageView(user, stage);
  // ★ 2026-10-22：学生档案收成三学段（jh/class/emp）后，三个都是带班概念，一律过范围
  await assertStudentsInScope(stage, [id], user, '该学生');
  const d = await REPOS[stage].detail(id, user);
  if (!d) throw new BizError(BizCode.STUDENT_NOT_FOUND, '学生不存在或没有访问权限');
  // ★ 2026-10-21：详情「阶段」也要显示方案阶段名（与列表同一口径）
  await attachSchemeStageNames([d.base]);
  // ★ 2026-10-20 升云记录：按学号挂到详情上（升云后大学那条是新 id，只有学号两边一致）
  //   放在 service 层而不是各仓储里 —— 5 个仓储都要有，写一遍比写五遍强。
  if (stage === 'jh' || stage === 'class') {
    d.upgrades = await listByStudentNo(d.base.studentNo);
  }
  return d;
}

/**
 * 详情页「扩展区块」：考试信息 / 宿舍（含调宿记录）/ 数据来源聚合
 *
 * 2026-10-15 详情分签改版：成绩来自成绩域、调宿单来自宿舍域、
 * 宿舍长来自宿舍管理 —— 各域**单独 try/catch**，某个域没权限/没数据
 * 不影响整包返回（校长全权限是主场景，但要兜住学管等受限账号）。
 */
export async function getStudentExtras(stage: StudentStage, id: string, user: any) {
  const d = await getStudentDetail(stage, id, user);
  const out: import('../shared/dto').StudentExtras = {
    scores: [] as Array<
      import('../shared/dto').ScoreRow & {
        examType?: number | null;
        examTypeName?: string | null;
      }
    >,
    dormChanges: [] as import('../shared/dto').DormChangeRow[],
    dormOwnerName: null as string | null,
    dormClassName: null as string | null,
    payments: {
      groups: [],
      totalCount: 0,
      totalAmount: 0,
      latestDate: null,
      note: null,
    },
  };

  /* 1. 考试成绩（成绩域）—— 成绩/宿舍/考试域只覆盖 jh/class 两学段（就业部没有考试成绩） */
  if (stage !== 'emp') {
    try {
      const { listScores } = await import('../score/service');
      const r = await listScores({ stage, studentId: String(id), page: 1, size: 200 }, user);
      // 考试类型/日期在考试表里，成绩表只有 exam_id —— 拉一次本学段考试清单回填
      const { listExams } = await import('../exam/service');
      const exams = await listExams({ stage, page: 1, size: 9999 }, user);
      const emap = new Map((exams.list || []).map((e: any) => [String(e.id), e]));
      out.scores = r.list.map((s) => {
        const e = emap.get(String(s.examId));
        return {
          ...s,
          examType: e?.examType ?? null,
          examTypeName: e?.examTypeName ?? '',
          examDate: s.examDate || e?.examDate || null,
        };
      });
    } catch {
      /* 没有成绩权限：考试签显示空态 */
    }

    /* 2. 调宿 / 退宿记录（宿舍域） */
    try {
      const { listDormChanges } = await import('../dorm/service');
      const changes = await listDormChanges(
        { stage, keyword: d.base.studentNo || undefined, page: 1, size: 9999 } as any,
        user,
      );
      out.dormChanges = (changes || []).filter((c) => c.studentId === String(id));
    } catch {
      /* 没有宿舍权限：调宿记录显示空态 */
    }

    /* 3. 宿舍负责人 / 班级（宿舍管理同步） */
    if (d.dorm?.dormId) {
      try {
        const { getDormDetail } = await import('../dorm/service');
        const room = await getDormDetail(stage, d.dorm.dormId, user);
        out.dormOwnerName = room?.ownerName ?? null;
        out.dormClassName = room?.className ?? null;
      } catch {
        /* 宿舍详情查不到就留空 */
      }
    }
  }

  /* 3. 缴费记录（财务账单明细，只读）—— 按学号取，跨学段都能看到 */
  try {
    const { listPaymentsByStudentNo } = await import('../../finance/services/bill.service');
    out.payments = await listPaymentsByStudentNo(d.base.studentNo);
  } catch {
    /* 财务库没起来 / 账单表没迁移：缴费签显示空态，不影响其它签 */
    out.payments.note = '财务账单暂时读不到，请稍后重试';
  }

  return out;
}

export async function saveStudent(body: StudentSaveBody, user: any): Promise<StudentSaveResult> {
  await assertStageView(user, body.stage);
  if (!body.studentName?.trim()) throw new BizError(BizCode.PARAM_ERROR, '姓名必填');
  if (!body.gender) throw new BizError(BizCode.PARAM_ERROR, '性别必填');
  // 大学 / 就业 的 dept_code 是必填列，缺了会撞数据库约束 —— 提前给出可读报错
  if (body.stage !== 'jh' && !body.deptCode) {
    throw new BizError(BizCode.PARAM_ERROR, `${STUDENT_STAGE_NAME[body.stage]}学段「部门」必填`);
  }
  try {
    return await REPOS[body.stage].save(body, user?.userId || 'system');
  } catch (e) {
    // 仓储抛的 Error 多为「学号已存在」这类业务校验 → 转成 40302/400 让前端能显示原文
    const msg = (e as Error).message || '保存失败';
    if (/学号/.test(msg)) throw new BizError(BizCode.STUDENT_NO_EXISTS, msg);
    throw new BizError(BizCode.PARAM_ERROR, msg);
  }
}

export async function removeStudent(
  stage: StudentStage,
  id: string,
  user: any,
): Promise<void> {
  await assertStageView(user, stage);
  await REPOS[stage].remove(id, user?.userId || 'system');
}

/** 元信息：每个可见学段支持的阶段码与特有区块（前端据此渲染筛选项与页签） */
export async function listStageMeta(user: any): Promise<StudentStageMeta[]> {
  const stages = await visibleStages(user);
  // ★ 2026-10-16 阶段方案：两个部门的方案都在 sms_class_jh 里，与学段无关，取一次即可
  const planOptions = await loadStagePlanOptions();
  const out: StudentStageMeta[] = [];
  for (const s of stages) {
    const repo = REPOS[s];
    out.push({
      stage: s,
      stageName: STUDENT_STAGE_NAME[s],
      // ★ 2026-10-19：本部门方案里的阶段并进筛选下拉（就业部/实训 dept_code=3 共用一套）
      phaseOptions: mergePhaseOptions(s, await repo.phaseOptions(), planOptions),
      planOptions,
      // ★ 2026-10-21：阶段筛选改读「阶段方案」（新表），实时跟随系统设置
      schemeStageOptions: await loadSchemeStagesForStage(s),
      sections: repo.sections,
      supportUnassigned: repo.supportUnassigned,
    });
  }
  return out;
}

/* ============================================================
 * 班级下拉（三学段）
 * ============================================================
 * 三个学段各有一张班级表，直接复用共享的 `listClassesByStage`。
 *
 * ★ 2026-10-21：原来这里还给「教务」单独拼过一段（从 sms_edu 学生表里
 *   去重取 class_id / class_name）—— 教务学段已从学生档案删除，这段一并去掉。
 */
export interface StudentClassOption {
  stage: StudentStage;
  stageName: string;
  id: string;
  name: string;
  /** ★ 2026-10-16 所选班级的部门 / 阶段，供学生表单「跟随班级」自动带出 */
  deptCode?: number;
  phaseCode?: number;
}

export async function listStudentClasses(user: any): Promise<StudentClassOption[]> {
  const stages = await visibleStages(user);
  const out: StudentClassOption[] = [];
  for (const s of stages) {
    for (const c of await listClassesByStage(s)) {
      out.push({
        stage: s,
        stageName: STUDENT_STAGE_NAME[s],
        id: c.id,
        name: c.name,
        deptCode: c.deptCode,
        phaseCode: c.phaseCode,
      });
    }
  }
  return out;
}

export { STUDENT_STAGES };

/* ============================================================
 * 升云（2026-10-20 批注）
 * ============================================================
 *
 * 【批注原文】
 *   「增加【升云】功能：点击升云可以批量选择人员进行升云，只适用于初高中，
 *     选择人员后再进行大学部要升入班级的选择，只能选择班级状态为开放的。」+
 *   「初高部的学生档案移动到大学部对应的班级，并增加升云的记录，
 *     在学生档案详情中显示，在基础信息页面增加升云记录，记录信息包括原班主任、
 *     原班级、操作人，同时升云只改变班级的相关内容，其余不变，尤其是学号不更改」
 *
 * 【做法 —— 档案「移动」，不是复制】
 *   ① 大学库 `sms_class.t_class_student` 插一条新档案（学号原样搬，不改）
 *   ② 初高库 `sms_class_jh.t_class_student` 原记录 `is_deleted = 1`
 *      （逻辑删除：初高页面不再出现，但历史数据/审计仍可追溯）
 *   ③ `sms_common.t_uni_student_upgrade` 记一条流水（原班级 / 原班主任 / 操作人）
 *
 * 【只搬「档案本身」，不搬业务流水】
 *   成绩 / 考勤 / 末班 / 调宿这些记录仍挂在初高库原 id 上 ——
 *   批注只要求档案与班级变更，跨学段搬流水没有业务依据（阶段也不同）。
 *
 * 【字段映射坑（两套列名不一样）】
 *   native_place → origin      id_card_no → id_card
 *   recruit_teacher_phone → recruit_phone
 *   consult_teacher_phone → consult_phone
 *   bed_no 初高是 varchar（'1号床'）→ 大学是 int（床位序号）
 *   dorm_id 在初高指向初高房间表，跨库不可用 → 只保留 dorm_no 文本，避免指向不存在的房间
 */

/** 升云可选的目标班级（大学部 + 状态 = 开放） */
export interface UpgradeTargetClass {
  id: string;
  name: string;
  deptCode: number;
  phaseCode: number | null;
  phaseName: string;
  headTeacherName: string | null;
}

export async function listUpgradeTargets(user: any): Promise<UpgradeTargetClass[]> {
  await assertStageView(user, 'class');
  const rows = (await tbl(classDb, 'sms_class', 't_class_info', 'class')
    .where({ is_deleted: 0, class_status: ClassStatus.OPEN })
    .orderBy('class_name', 'asc')) as Array<Record<string, any>>;
  return rows
    .filter((r) => Number(r.dept_code) === DeptCode.UNIVERSITY)
    .map((r) => {
      const phaseCode = r.stage === null || r.stage === undefined ? null : Number(r.stage);
      return {
        id: String(r.id),
        name: String(r.class_name ?? ''),
        deptCode: Number(r.dept_code),
        phaseCode,
        phaseName: phaseCode === null ? '' : resolveStageName(phaseCode),
        headTeacherName: r.head_teacher_name ?? null,
      };
    });
}

export interface UpgradeSkipItem {
  studentId: string;
  studentNo: string;
  studentName: string;
  reason: string;
}

export interface UpgradeResult {
  /** 成功升云的人数 */
  moved: number;
  /** 被跳过的（附原因，前端逐条提示） */
  skipped: UpgradeSkipItem[];
  /** 升入的班级名，供提示语用 */
  toClassName: string;
}

/** 初高床位号（'1号床' / '1-上'）→ 大学床位序号（1） */
function bedNoToInt(v: unknown): number | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const m = s.match(/\d+/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function upgradeToUniversity(
  body: { studentIds?: string[]; targetClassId?: string; remark?: string | null },
  user: any,
): Promise<UpgradeResult> {
  // 升云是跨学段动作：两个学段都要有访问权限（初高出人、大学进班）
  await assertStageView(user, 'jh');
  await assertStageView(user, 'class');

  const ids = [...new Set((body.studentIds || []).map((x) => String(x ?? '').trim()).filter(Boolean))];
  if (!ids.length) throw new BizError(BizCode.PARAM_ERROR, '请先勾选要升云的学生');

  const targetClassId = String(body.targetClassId ?? '').trim();
  if (!targetClassId) throw new BizError(BizCode.PARAM_ERROR, '请选择要升入的大学部班级');

  const cls = (await tbl(classDb, 'sms_class', 't_class_info', 'class')
    .where({ id: targetClassId, is_deleted: 0 })
    .first()) as Record<string, any> | undefined;
  if (!cls) throw new BizError(BizCode.PARAM_ERROR, '目标班级不存在或已删除');
  if (Number(cls.dept_code) !== DeptCode.UNIVERSITY) {
    throw new BizError(BizCode.PARAM_ERROR, '只能升入「大学部」的班级');
  }
  const clsStatus = Number(cls.class_status ?? 0);
  if (clsStatus !== ClassStatus.OPEN) {
    throw new BizError(
      BizCode.PARAM_ERROR,
      `班级「${String(cls.class_name ?? '')}」当前状态是「${CLASS_STATUS_NAME[clsStatus] || '未知'}」，只能升入「开放」状态的班级`,
    );
  }

  const operatorId = user?.userId || 'system';
  const operatorName = user?.userName || null;
  const now = new Date();
  const toClassName = String(cls.class_name ?? '');
  const toPhaseCode = cls.stage === null || cls.stage === undefined ? null : Number(cls.stage);

  const result = await classDb.transaction(async (trx) => {
    const skipped: UpgradeSkipItem[] = [];

    // ① 读初高侧学生（只取未删除的）
    const srcRows = (await tblTrx(trx, 'sms_class_jh', 't_class_student', 'jh')
      .whereIn('id', ids)
      .where('is_deleted', 0)) as Array<Record<string, any>>;
    const byId = new Map(srcRows.map((r) => [String(r.id), r]));

    // ② 大学侧同学号档案（含已逻辑删除的）——student_no 是唯一索引，插不进去
    const nos = srcRows.map((r) => String(r.student_no ?? '')).filter(Boolean);
    const existed = nos.length
      ? ((await tblTrx(trx, 'sms_class', 't_class_student', 'class').whereIn('student_no', nos)) as Array<
          Record<string, any>
        >)
      : [];
    const existedNo = new Map(existed.map((r) => [String(r.student_no), r]));

    let moved = 0;
    for (const id of ids) {
      const r = byId.get(id);
      if (!r) {
        skipped.push({ studentId: id, studentNo: '', studentName: '', reason: '学生不存在或已删除' });
        continue;
      }
      const studentNo = String(r.student_no ?? '');
      const studentName = String(r.student_name ?? '');

      // 批注口径：只有「正式在读」可以升云（前端也只列这类，这里兜底）
      if (Number(r.student_status) !== StudentStatus.STUDYING) {
        skipped.push({
          studentId: id,
          studentNo,
          studentName,
          reason: '仅「正式在读」的学生可以升云',
        });
        continue;
      }
      const dup = existedNo.get(studentNo);
      if (dup) {
        skipped.push({
          studentId: id,
          studentNo,
          studentName,
          reason: dup.is_deleted
            ? '大学部存在同号的已删除档案，学号不可复用'
            : '大学部已存在相同学号的档案',
        });
        continue;
      }

      const newId = randomUUID();
      // ③ 大学库落新档案：只换「班级相关内容」，其余字段原样搬，学号不变
      await tblInsTrx(trx, 'sms_class', 't_class_student', 'class', {
        id: newId,
        student_no: studentNo,
        student_name: studentName,
        gender: Number(r.gender ?? 1),
        age: r.age ?? null,
        birth_date: r.birth_date ?? null,
        // ★ 初高 native_place → 大学 origin
        origin: r.native_place ?? null,
        dept_code: DeptCode.UNIVERSITY,
        class_id: String(cls.id),
        class_name: toClassName,
        [phaseCodeCol()]: toPhaseCode,
        head_teacher_id: cls.head_teacher_id ?? null,
        head_teacher_name: cls.head_teacher_name ?? null,
        teacher_id: cls.teacher_id ?? null,
        teacher_name: cls.teacher_name ?? null,
        assistant_id: cls.assistant_id ?? null,
        assistant_name: cls.assistant_name ?? null,
        student_status: StudentStatus.STUDYING,
        education: r.education ?? null,
        graduate_school: r.graduate_school ?? null,
        enroll_date: r.enroll_date ?? null,
        phone: r.phone ?? null,
        parent_name: r.parent_name ?? null,
        parent_phone: r.parent_phone ?? null,
        home_address: r.home_address ?? null,
        // ★ 初高 id_card_no → 大学 id_card
        id_card: r.id_card_no ?? null,
        id_photo_url: r.id_photo_url ?? null,
        household_photo_url: r.household_photo_url ?? null,
        recruit_teacher_name: r.recruit_teacher_name ?? null,
        recruit_phone: r.recruit_teacher_phone ?? null,
        consult_teacher_name: r.consult_teacher_name ?? null,
        consult_phone: r.consult_teacher_phone ?? null,
        // 宿舍：dorm_id 是初高房间表主键，跨库指向无效 → 只保留房号 + 床位序号
        dorm_id: null,
        dorm_no: r.dorm_no ?? null,
        bed_no: bedNoToInt(r.bed_no),
        attendance_rate: r.attendance_rate ?? null,
        repeat_count: 0,
        remark: r.remark ?? null,
        source_system: 'manual',
        sync_status: 2,
        is_deleted: 0,
        create_time: now,
        create_by: operatorId,
        update_time: now,
        update_by: operatorId,
      });

      // ④ 初高原记录逻辑删除（= 档案「移动」走）
      await tblTrx(trx, 'sms_class_jh', 't_class_student', 'jh').where({ id }).update({
        is_deleted: 1,
        update_time: now,
        update_by: operatorId,
      });

      // ⑤ 升云流水（详情「基础信息」里展示）
      await insertUpgrade(
        {
          studentNo,
          studentName,
          fromStudentId: id,
          fromClassId: r.class_id ?? null,
          fromClassName: r.class_name ?? null,
          fromHeadTeacherId: r.head_teacher_id ?? null,
          fromHeadTeacherName: r.head_teacher_name ?? null,
          toStudentId: newId,
          toClassId: String(cls.id),
          toClassName,
          toHeadTeacherName: cls.head_teacher_name ?? null,
          operatorId: operatorId === 'system' ? null : operatorId,
          operatorName,
          remark: body.remark ?? null,
          upgradeTime: now,
        },
        trx,
      );

      moved += 1;
    }

    return { moved, skipped, toClassName };
  });

  return result;
}

/** 详情页用的升云记录（按学号，兼容「升云前后」两条档案） */
export async function listUpgradesOf(studentNo: string): Promise<StudentUpgradeRow[]> {
  try {
    return await listByStudentNo(studentNo);
  } catch {
    // 迁移还没跑（表不存在）时不要让详情整个 500 —— 记录区块显示空即可
    return [];
  }
}
