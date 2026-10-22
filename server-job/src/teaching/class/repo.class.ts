/**
 * 班级仓储 · 大学（sms_class.t_class_info）
 * ============================================================
 *
 * 【与实训的四处结构差异（本段特有的坑）】
 *   ① 班级编号 `class_code`：★ 2026-10-21 已补列（三部门统一必填 + 唯一），
 *      不再是「只有实训有」
 *   ② **没有 `close_date` 列** → 统一 `closeDate` 恒为 null
 *   ③ 教室列名是 **`room`**（不是 classroom）→ 写入和读取都要翻译
 *   ④ **没有 `remark` 列** → 统一 `remark` 恒为 null（不是漏映射）
 *   ⑤ 有 `project_manager_*` / `employment_teacher_*` / `university_no`
 *      （这三个和实训一样 —— 大学部也有交棒）
 *
 * 【数据范围（必须原样用 applyDataScope，不能自己另写一套）】
 *   ALL 全部 · DEPT 本部门 · CLASS 本班级（user.classIds）· SELF 本人
 *   ⚠️ SELF 且没给ownerColumns 时会**保守拒绝**（原实现行为，不要绕过）
 */

import { randomUUID } from 'crypto';
import { db } from '../../class/db';
import { applyDataScope } from '../../class/middleware/dataScope';
import { assertClassCodeAvailable } from '../shared/classCode';
import { CLASS_STATUS, CLASS_STATUS_NAME, canTransitClassStatus } from '../shared/dto';
import type {
  ClassListQuery,
  ClassRosterRow,
  ClassRow,
  ClassSaveBody,
} from '../shared/dto';
import { fmtDate, fmtDateTime } from '../shared/format';
import type { ClassRepo } from './types';
import { tbl, readPhaseCode, phaseCodeCol, tblIns } from '../shared/uniTable';
import { applyClassScope } from '../shared/dataScope';

const T = 't_class_info';
const STUDENT_T = 't_class_student';
const STAGE = 'class' as const;
const STAGE_NAME = '大学部';

/**
 * 大学部的学习阶段：201~206 = 一~六阶段，13 = 实训
 *
 * ★ 2026-10-16 按批注改版：原来这套是「大学预科 / 大学一年级 / … / 实习阶段」，
 *   和学生档案那边的口径对不上。校长截图要求班级管理的「部门 → 阶段」跟学生档案一致：
 *     部门=初高部 → 初中部1期 ~ 高中部3期
 *     部门=大学部 → 实训 / 一阶段 ~ 六阶段
 *   ⚠️ 这份表必须和 `student/repo.class.ts` 的同名表保持一致（两处都是本地常量，
 *      改一处就得同步另一处），否则同一个学生在两个页面会显示成不同阶段。
 *   ⚠️ 键写成数字字面量，`Object.entries` 会按数值升序排 → 13 排在最前（就是「实训」在最上），
 *      201~206 依次是一~六阶段，下拉顺序与截图一致，不要手动调成插入顺序。
 */
const PHASE_NAME: Record<number, string> = {
  201: '一阶段',
  202: '二阶段',
  203: '三阶段',
  204: '四阶段',
  205: '五阶段',
  206: '六阶段',
  13: '实训',
};

const DEPT_NAME: Record<number, string> = { 1: '初高部', 2: '大学部' };
const GENDER: Record<number, string> = { 0: '未知', 1: '男', 2: '女' };

function str(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  return String(v);
}
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * ★ 2026-10-21：班级编号唯一性校验 → ★ 2026-10-22 改为**三部门全局唯一**
 *
 * 学号 = LZ + 班级编号 + 序号，两个部门用同一个编号会生成同一串学号
 * （学号是跨学段唯一标识：档案「全部」按它去重、缴费记录按它归集）。
 * 具体查询见 shared/classCode.ts。
 */
async function assertClassCodeUnique(code: string, excludeId?: string): Promise<void> {
  await assertClassCodeAvailable(code, { stage: STAGE, id: excludeId });
}

function mapRow(r: Record<string, any>, studentCount: number | null): ClassRow {
  const status = Number(r.class_status ?? CLASS_STATUS.OPEN);
  const phase = readPhaseCode(r);
  return {
    stage: STAGE,
    stageName: STAGE_NAME,
    classId: String(r.id),
    className: String(r.class_name ?? ''),
    classCode: str(r.class_code),
    deptCode: numOrNull(r.dept_code),
    deptName: DEPT_NAME[Number(r.dept_code)] ?? '',
    phaseCode: phase,
    phaseName: phase === null ? '' : (PHASE_NAME[phase] ?? ''),
    // ★ 2026-10-16：阶段方案（新表单选择；老班级为 null，回显退回 phaseName）
    schemeId: str(r.scheme_id),
    schemeStageId: str(r.scheme_stage_id),
    schemeStageName: str(r.scheme_stage_name),
    headTeacherId: str(r.head_teacher_id),
    headTeacherName: str(r.head_teacher_name),
    teacherId: str(r.teacher_id),
    teacherName: str(r.teacher_name),
    assistantId: str(r.assistant_id),
    assistantName: str(r.assistant_name),
    projectManagerId: str(r.project_manager_id),
    projectManagerName: str(r.project_manager_name),
    employmentTeacherId: str(r.employment_teacher_id),
    employmentTeacherName: str(r.employment_teacher_name),
    universityNo: str(r.university_no),
    // ★ 大学列名是 room
    classroom: str(r.room),
    openDate: str(fmtDate(r.open_date)),
    // ★ 这张表没 close_date 列
    closeDate: null,
    studentCount: studentCount ?? Number(r.student_count ?? 0),
    classStatus: status,
    classStatusName: CLASS_STATUS_NAME[status] ?? '',
    canChangeStatus: status !== CLASS_STATUS.GRADUATED,
    attendanceRate: numOrNull(r.attendance_rate),
    attendanceRateKind: 'total',
    // ★ 这张表没 remark 列
    remark: null,
    createTime: fmtDateTime(r.create_time),
  };
}

function buildBase(q: ClassListQuery, user: any) {
  // ★ 数据范围由大学自己的 applyDataScope 算（本班范围时用 id 列）
  const qb = tbl(db, 'sms_class', T, STAGE).where('is_deleted', false);
  applyDataScope(qb, user, { classIdColumn: 'id' });
  if (q.deptCode) qb.andWhere('dept_code', q.deptCode);
  if (q.classStatus) qb.andWhere('class_status', q.classStatus);
  if (q.phaseCode) qb.andWhere(phaseCodeCol(), q.phaseCode);
  if (q.keyword) {
    qb.andWhere((b: any) => {
      b.where('class_name', 'like', `%${q.keyword}%`)
        .orWhere('head_teacher_name', 'like', `%${q.keyword}%`);
      // ★ 没有 class_code，不能拼进去
    });
  }
  return qb;
}

/** 实时统计班里的学生（学生表上直接挂 class_id，没有独立花名册表）
 *
 *  ⚠️ 必须 `.groupBy('class_id')`：MySQL 8 默认开 ONLY_FULL_GROUP_BY，
 *     少这个 group by 时 `select class_id, count(*)` 直接报 1140。
 *     为什么一直没暴露？—— MySQL 会把「只有 1 个值的 IN 列表」优化成等值判断，
 *     满足函数依赖检查，所以**一个学段只有 1 个班时侥幸能跑**；
 *     某学段一旦有 ≥2 个班就必然 500，整个班级管理页打不开。 */
async function countStudents(classIds: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!classIds.length) return map;
  const rows = (await tbl(db, 'sms_class', STUDENT_T, STAGE)
    .whereIn('class_id', classIds)
    .where('is_deleted', false)
    // ★ 2026-10-16 修：必须 groupBy，否则 only_full_group_by 模式下
    //   「select class_id, count(*) 无 group by」直接报 1140 错误。
    .groupBy('class_id')
    .select('class_id')
    .count({ c: '*' })
    .groupBy('class_id')) as unknown as Array<{ class_id: string; c: number | string }>;
  for (const r of rows) map.set(String(r.class_id), Number(r.c));
  return map;
}

export const repo: ClassRepo = {
  stage: STAGE,

  async phaseOptions() {
    return Object.entries(PHASE_NAME).map(([v, label]) => ({ value: Number(v), label }));
  },

  meta() {
    return {
      stage: STAGE,
      stageName: STAGE_NAME,
      hasClassCode: true,
      hasCloseDate: false,
      hasSealAction: true,
      classroomLabel: '教室',
      phaseOptions: Object.entries(PHASE_NAME).map(([v, label]) => ({
        value: Number(v),
        label,
      })),
    };
  },

  async list(q, user) {
    const qb = buildBase(q, user);
    /* ★ 数据范围：班主任只看自己带的班（老 applyDataScope 只到「部门」粒度） */
    if (!(await applyClassScope(qb, 'id', STAGE, user))) return [];
    const rows = (await qb.orderBy('create_time', 'desc')) as Array<Record<string, any>>;
    const counts = await countStudents(rows.map((r) => String(r.id)));
    return rows.map((r) => mapRow(r, counts.get(String(r.id)) ?? 0));
  },

  async detail(id, user) {
    const guard = tbl(db, 'sms_class', T, STAGE).where({ id, is_deleted: false });
    applyDataScope(guard, user, { classIdColumn: 'id' });
    const r = (await guard.first()) as Record<string, any> | undefined;
    if (!r) return null;

    const counts = await countStudents([id]);
    const base = mapRow(r, counts.get(id) ?? 0);
    const roster = await this.roster(id, user);
    return { base, roster, allowedStatus: transitionsFrom(base.classStatus), extra: null };
  },

  async save(body, userId) {
    const now = new Date();
    // ★ 2026-10-15 班级表单取消必填：班级名称留空时自动占位（表列 NOT NULL）
    const pad2 = (n: number) => String(n).padStart(2, '0');
    const className =
      String(body.className || '').trim() ||
      `未命名班级-${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
    const payload: Record<string, any> = { update_time: now, update_by: userId };
    const set = (k: string, v: unknown) => {
      if (v !== undefined) payload[k] = v;
    };
    set('class_name', String(body.className || '').trim() || undefined);
    set('dept_code', body.deptCode);
    set(phaseCodeCol(), body.phaseCode);
    // ★ 2026-10-16：阶段方案三字段（null = 清空选择；不传 = 不改）
    set('scheme_id', body.schemeId);
    set('scheme_stage_id', body.schemeStageId);
    set('scheme_stage_name', body.schemeStageName);
    set('head_teacher_id', body.headTeacherId);
    set('head_teacher_name', body.headTeacherName);
    set('teacher_id', body.teacherId);
    set('teacher_name', body.teacherName);
    set('assistant_id', body.assistantId);
    set('assistant_name', body.assistantName);
    set('project_manager_id', body.projectManagerId);
    set('project_manager_name', body.projectManagerName);
    set('employment_teacher_id', body.employmentTeacherId);
    set('employment_teacher_name', body.employmentTeacherName);
    set('university_no', body.universityNo);
    // ★ 写入列名是 room
    set('room', body.classroom);
    set('open_date', body.openDate);
    // ★ 2026-10-21：班级编号（三部门统一必填 + 同表唯一）
    set('class_code', body.classCode === undefined ? undefined : String(body.classCode ?? '').trim());
    // ★ 这张表没 close_date / remark
    if (body.classStatus !== undefined) payload.class_status = body.classStatus;

    /**
     * ★ 2026-10-22 修：只在**表单传了编号**时才校验
     *
     * 原来这里无条件要求「编辑必填」，但班级交接（service.ts handover）也走 save()，
     * 它的 saveBody 不带 classCode → 交接会被「班级编号必填」拦死。
     * 表单提交时空串被 route 转成 null（不是 undefined），所以「清空编号再保存」仍会报必填。
     */
    if (body.classCode !== undefined) {
      const code = String(body.classCode ?? '').trim();
      if (!code) throw new Error('班级编号必填');
      await assertClassCodeUnique(code, body.id);
    }

    if (body.id) {
      if (body.classStatus !== undefined) {
        const cur = (await tbl(db, 'sms_class', T, STAGE).where({ id: body.id }).first()) as
          | Record<string, any>
          | undefined;
        if (!cur) throw new Error('班级不存在');
        const from = Number(cur.class_status);
        if (from !== body.classStatus && !canTransitClassStatus(from, body.classStatus)) {
          throw new Error(
            `班级状态不可从「${CLASS_STATUS_NAME[from]}」流转为「${CLASS_STATUS_NAME[body.classStatus]}」`,
          );
        }
      }
      await tbl(db, 'sms_class', T, STAGE).where({ id: body.id }).update(payload);
      return { id: body.id };
    }

    // 同部门内名称不重复（与实训一致的口径）+ 编号唯一
    const deptCode = Number(body.deptCode ?? 2);
    // ★ 班级编号（class_code）三部门统一必填 + 跨部门唯一（shared/classCode.ts）
    const classCode = String(body.classCode ?? '').trim();
    if (!classCode) throw new Error('班级编号必填');
    await assertClassCodeAvailable(classCode);
    const dupName = (await tbl(db, 'sms_class', T, STAGE)
      .where({ class_name: className, dept_code: deptCode, is_deleted: false })
      .first()) as Record<string, any> | undefined;
    if (dupName) throw new Error(`该部门下已有班级叫「${className}」`);

    const id = randomUUID();
    await tblIns(db, 'sms_class', T, STAGE, {
      id,
      class_code: classCode,
      class_name: className, // ★ create 时名称可能被自动占位（见上）
      class_status: body.classStatus ?? CLASS_STATUS.OPEN,
      // ★ `stage`（学段内阶段码）在这张表是 NOT NULL，前端没传时必须给兜底值，
      //   否则 insert 直接报 ER_BAD_NULL_ERROR。取第一个可选阶段码更贴近业务。
      [phaseCodeCol()]: body.phaseCode ?? Number(Object.keys(PHASE_NAME)[0]),
      dept_code: body.deptCode ?? 2,
      student_count: 0,
      is_deleted: false,
      create_time: now,
      create_by: userId,
      ...payload,
    });
    return { id };
  },

  async remove(id, userId) {
    await tbl(db, 'sms_class', T, STAGE).where({ id }).update({
      is_deleted: true,
      update_time: new Date(),
      update_by: userId,
    });
  },

  async roster(id, user) {
    const guard = tbl(db, 'sms_class', T, STAGE).where({ id, is_deleted: false });
    applyDataScope(guard, user, { classIdColumn: 'id' });
    const ok = await guard.first();
    if (!ok) return [];

    const rows = (await tbl(db, 'sms_class', STUDENT_T, STAGE)
      .where({ class_id: id, is_deleted: false })
      .orderBy('student_no', 'asc')) as Array<Record<string, any>>;
    return rows.map((r): ClassRosterRow => {
      const gender = Number(r.gender ?? 0);
      return {
        studentId: String(r.id),
        studentNo: str(r.student_no),
        studentName: str(r.student_name),
        gender,
        genderName: GENDER[gender] ?? '未知',
        // ★ 大学没有独立花名册表 → 无入班方式概念
        joinType: null,
        joinTypeName: '',
        joinDate: str(fmtDate(r.enroll_date)),
        inClassStatus: null,
        inClassStatusName: '在班',
      };
    });
  },

  async changeStatus(id, to, userId) {
    const cur = (await tbl(db, 'sms_class', T, STAGE).where({ id, is_deleted: false }).first()) as
      | Record<string, any>
      | undefined;
    if (!cur) throw new Error('班级不存在');
    const from = Number(cur.class_status);
    if (from === to) return;
    if (!canTransitClassStatus(from, to)) {
      throw new Error(
        `班级状态不可从「${CLASS_STATUS_NAME[from]}」流转为「${CLASS_STATUS_NAME[to]}」`,
      );
    }
    await tbl(db, 'sms_class', T, STAGE).where({ id }).update({
      class_status: to,
      update_time: new Date(),
      update_by: userId,
    });
  },

  async summary(q, user) {
    const qb = buildBase(q, user);
    if (!(await applyClassScope(qb, 'id', STAGE, user))) {
      return { stage: STAGE, stageName: STAGE_NAME, total: 0, openCount: 0, closedCount: 0, graduatingCount: 0, graduatedCount: 0, studentCount: 0 };
    }
    const rows = (await qb.select('id', 'class_status')) as Array<Record<string, any>>;
    const counts = await countStudents(rows.map((r) => String(r.id)));
    let studentCount = 0;
    let openCount = 0;
    let closedCount = 0;
    let graduatingCount = 0;
    let graduatedCount = 0;
    for (const r of rows) {
      studentCount += counts.get(String(r.id)) ?? 0;
      const s = Number(r.class_status);
      if (s === CLASS_STATUS.OPEN) openCount++;
      else if (s === CLASS_STATUS.CLOSED) closedCount++;
      else if (s === CLASS_STATUS.GRADUATING) graduatingCount++;
      else if (s === CLASS_STATUS.GRADUATED) graduatedCount++;
    }
    return {
      stage: STAGE,
      stageName: STAGE_NAME,
      total: rows.length,
      openCount,
      closedCount,
      graduatingCount,
      graduatedCount,
      studentCount,
    };
  },
};

function transitionsFrom(from: number): number[] {
  const map: Record<number, number[]> = {
    [CLASS_STATUS.OPEN]: [CLASS_STATUS.CLOSED],
    [CLASS_STATUS.CLOSED]: [CLASS_STATUS.OPEN, CLASS_STATUS.GRADUATED],
    [CLASS_STATUS.GRADUATING]: [CLASS_STATUS.GRADUATED],
    [CLASS_STATUS.GRADUATED]: [],
  };
  return map[from] ?? [];
}

export default repo;