/**
 * 班级仓储 · 初高（sms_class_jh.t_class_info）
 * ============================================================
 *
 * 【与实训的四处结构差异（本段特有的坑）】
 *   ① **没有 `class_code` 列** → 统一 `classCode` 恒为 null
 *   ② **没有 `close_date` 列** → 统一 `closeDate` 恒为 null
 *   ③ 教室列名是 `classroom`（与实训同名，但长度 100 vs 50）
 *   ④ **没有 `project_manager_*` / `employment_teacher_*` / `university_no`**
 *      （初高没交棒 —— 这是**业务事实**，不是漏映射）
 *   ⑤ 有 `remark` 列（大学没有）
 *   ⑥ ★★ 出勤率列名是 **`today_attendance_rate`（今日出勤率）**，
 *      而实训/大学是 `attendance_rate`（累计）。
 *      → 统一成 `attendanceRate` + `attendanceRateKind='today'`，
 *        **前端必须靠 kind 区分**，否则「今日 92%」会被当成累计率。
 *
 * 【数据范围（必须原样用初高的 buildClassScope + getScopedClassIds）】
 *   本班级范围 = head_teacher_id / teacher_id / assistant_id **命中任一** 即算我的班。
 *   ⚠️ 初高班主任字段是 NOT NULL，与大学（可空）不同 —— 建班时必填班主任。
 */

import { randomUUID } from 'crypto';
import { db } from '../../class-jh/utils/db';
import {
  CLASS_STATUS,
  CLASS_STATUS_NAME,
  canTransitClassStatus,
} from '../shared/dto';
import type {
  ClassListQuery,
  ClassRosterRow,
  ClassRow,
  ClassSaveBody,
} from '../shared/dto';
import { fmtDate, fmtDateTime } from '../shared/format';
import type { ClassRepo } from './types';
import { tbl, readPhaseCode, phaseCodeCol, tblIns } from '../shared/uniTable';

const T = 't_class_info';
const STUDENT_T = 't_class_student';
const STAGE = 'jh' as const;
const STAGE_NAME = '初高部';

/** 初高阶段 101~107 / 201~204（与 shared-types/class-jh 的 STAGE_NAME 一致） */
const PHASE_NAME: Record<number, string> = {
  101: '预科',
  102: '初中部1期',
  103: '初中部2期',
  104: '初中部3期',
  105: '高中部1期',
  106: '高中部2期',
  107: '高中部3期',
  201: '一阶段',
  202: '二阶段',
  203: '三阶段',
  204: '四阶段',
};

const DEPT_NAME: Record<number, string> = { 1: '初高部', 2: '大学部' };
const GENDER: Record<number, string> = { 0: '未知', 1: '男', 2: '女' };

/**
 * 「在读」学生状态（**统一码**）：试学中 3 / 预在读 4 / 正式在读 5
 *
 * ⚠️ 2026-10-16 修正：原来是 `[1, 2, 3, 6]`，那是老初高库的旧编码 ——
 *   统一码里 1=待咨询、2=咨询中、6=休学，套在现在的数据上结果是
 *   「班里 12 个正式在读的学生一个都不算，休学的反而算在读」，班级人数永远显示 0。
 *   口径与 `teaching/shared/conf.ts` 的 `DEFAULT_SCOPE.jh.shouldStatuses = [3,4,5]`
 *   （初高出勤「应到」）保持一致。
 */
const IN_SCHOOL_STATUS: number[] = [3, 4, 5];

function str(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  return String(v);
}
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function mapRow(r: Record<string, any>, studentCount: number | null): ClassRow {
  const status = Number(r.class_status ?? CLASS_STATUS.OPEN);
  const phase = readPhaseCode(r);
  return {
    stage: STAGE,
    stageName: STAGE_NAME,
    classId: String(r.id),
    className: String(r.class_name ?? ''),
    classCode: null,
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
    // ★ 初高没交棒字段
    projectManagerId: null,
    projectManagerName: null,
    employmentTeacherId: null,
    employmentTeacherName: null,
    universityNo: null,
    classroom: str(r.classroom),
    openDate: str(fmtDate(r.open_date)),
    closeDate: null,
    studentCount: studentCount ?? Number(r.student_count ?? 0),
    classStatus: status,
    classStatusName: CLASS_STATUS_NAME[status] ?? '',
    canChangeStatus: status !== CLASS_STATUS.GRADUATED,
    attendanceRate: numOrNull(r.today_attendance_rate),
    // ★★ 初高是「今日」出勤率，不是累计
    attendanceRateKind: 'today',
    remark: str(r.remark),
    createTime: fmtDateTime(r.create_time),
  };
}

/**
 * 数据范围（初高口径）
 *
 * 原实现用 buildClassScope(req) + getScopedClassIds(db, 表名, scope)：
 *   本班级 → 班主任/教员/助教**任一**命中
 *   本部门 → dept_code
 *   全部/本人 → 不限班级
 * 这里是仓储（拿到的不是 req 而是 user），所以按 dataScope 直接复刻同样语义。
 */
function applyScope(qb: any, user: any): void {
  const scope = Number(user?.dataScope ?? 4);
  // DataScope: 1 本人 / 2 本班级 / 3 本部门 / 4 全部
  if (scope === 3 && user?.deptCode) qb.andWhere('dept_code', user.deptCode);
  // 本班级（2）走下面的白名单子查询；本人（1）与全部（4）不限班级
}

async function scopedClassIds(user: any): Promise<string[] | null> {
  const scope = Number(user?.dataScope ?? 4);
  if (scope !== 2) return null;
  const uid = user?.userId || '';
  if (!uid) return [];
  const rows = (await tbl(db, 'sms_class_jh', T, STAGE)
    .where('is_deleted', false)
    .andWhere((b: any) => {
      b.where('head_teacher_id', uid)
        .orWhere('teacher_id', uid)
        .orWhere('assistant_id', uid);
    })
    .select('id')) as Array<{ id: string }>;
  return rows.map((r) => String(r.id));
}

function buildBase(q: ClassListQuery, user: any) {
  const qb = tbl(db, 'sms_class_jh', T, STAGE).where('is_deleted', false);
  applyScope(qb, user);
  if (q.deptCode) qb.andWhere('dept_code', q.deptCode);
  if (q.classStatus) qb.andWhere('class_status', q.classStatus);
  if (q.phaseCode) qb.andWhere(phaseCodeCol(), q.phaseCode);
  if (q.keyword) {
    qb.andWhere((b: any) => {
      b.where('class_name', 'like', `%${q.keyword}%`)
        .orWhere('head_teacher_name', 'like', `%${q.keyword}%`);
    });
  }
  return qb;
}

async function countStudents(classIds: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!classIds.length) return map;
  const rows = (await tbl(db, 'sms_class_jh', STUDENT_T, STAGE)
    .whereIn('class_id', classIds)
    .where('is_deleted', false)
    .whereIn('student_status', IN_SCHOOL_STATUS)
    // ★ 2026-10-16 修：必须 groupBy，否则 only_full_group_by 模式下
    //   「select class_id, count(*) 无 group by」直接报 1140 错误。
    .groupBy('class_id')
    .select('class_id')
    .count({ c: '*' })
    // ⚠️ 必须 group by：MySQL 8 的 ONLY_FULL_GROUP_BY 下少它会报 1140；
    //    一个学段只有 1 个班时 MySQL 会把单值 IN 优化成等值判断而侥幸通过，
    //    ≥2 个班就 500（班级管理整页打不开）
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
      hasClassCode: false,
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
    // ★ 本班级范围要叠白名单（applyScope 只处理了部门级）
    const ids = await scopedClassIds(user);
    if (ids) {
      if (!ids.length) return [];
      qb.whereIn('id', ids);
    }
    const rows = (await qb.orderBy('create_time', 'desc')) as Array<Record<string, any>>;
    const counts = await countStudents(rows.map((r) => String(r.id)));
    return rows.map((r) => mapRow(r, counts.get(String(r.id)) ?? 0));
  },

  async detail(id, user) {
    const r = (await tbl(db, 'sms_class_jh', T, STAGE).where({ id, is_deleted: false }).first()) as
      | Record<string, any>
      | undefined;
    if (!r) return null;
    // 单条也要过范围（否则能拿别人的 id 直查）
    const ids = await scopedClassIds(user);
    if (ids && !ids.includes(id)) return null;

    const counts = await countStudents([id]);
    const base = mapRow(r, counts.get(id) ?? 0);
    const roster = await this.roster(id, user);
    return { base, roster, allowedStatus: transitionsFrom(base.classStatus), extra: null };
  },

  async save(body, userId) {
    const now = new Date();
    // ★ 2026-10-15 班级表单取消必填：班级名称留空时自动占位（表列 NOT NULL + 部门内不重复）
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
    set('classroom', body.classroom);
    set('open_date', body.openDate);
    set('remark', body.remark);
    if (body.classStatus !== undefined) payload.class_status = body.classStatus;
    // ★ 这张表没 class_code / close_date / 交棒字段

    if (body.id) {
      if (body.classStatus !== undefined) {
        const cur = (await tbl(db, 'sms_class_jh', T, STAGE).where({ id: body.id }).first()) as
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
      await tbl(db, 'sms_class_jh', T, STAGE).where({ id: body.id }).update(payload);
      return { id: body.id };
    }

    // ★ 2026-10-15 放宽：班主任/教员允许不选（列已迁改为可空），不再前置拦截。
    //   同部门内名称不重复（用占位名也能过 —— 带秒级时间戳）
    const deptCode = Number(body.deptCode ?? 1);
    const dupName = (await tbl(db, 'sms_class_jh', T, STAGE)
      .where({ class_name: className, dept_code: deptCode, is_deleted: false })
      .first()) as Record<string, any> | undefined;
    if (dupName) throw new Error(`该部门下已有班级叫「${className}」`);

    const id = randomUUID();
    await tblIns(db, 'sms_class_jh', T, STAGE, {
      id,
      class_name: className, // ★ create 时名称可能被自动占位（见上）
      class_status: body.classStatus ?? CLASS_STATUS.OPEN,
      // ★ `stage`（学段内阶段码）在这张表是 NOT NULL，前端没传时给兜底值
      [phaseCodeCol()]: body.phaseCode ?? Number(Object.keys(PHASE_NAME)[0]),
      dept_code: body.deptCode ?? 1,
      student_count: 0,
      is_deleted: false,
      create_time: now,
      create_by: userId,
      ...payload,
    });
    return { id };
  },

  async remove(id, userId) {
    await tbl(db, 'sms_class_jh', T, STAGE).where({ id }).update({
      is_deleted: true,
      update_time: new Date(),
      update_by: userId,
    });
  },

  async roster(id, user) {
    const r = (await tbl(db, 'sms_class_jh', T, STAGE).where({ id, is_deleted: false }).first()) as
      | Record<string, any>
      | undefined;
    if (!r) return [];
    const ids = await scopedClassIds(user);
    if (ids && !ids.includes(id)) return [];

    const rows = (await tbl(db, 'sms_class_jh', STUDENT_T, STAGE)
      .where({ class_id: id, is_deleted: false })
      .orderBy('student_no', 'asc')) as Array<Record<string, any>>;
    return rows.map((x): ClassRosterRow => {
      const gender = Number(x.gender ?? 0);
      return {
        studentId: String(x.id),
        studentNo: str(x.student_no),
        studentName: str(x.student_name),
        gender,
        genderName: GENDER[gender] ?? '未知',
        joinType: null,
        joinTypeName: '',
        joinDate: str(fmtDate(x.enroll_date)),
        inClassStatus: null,
        inClassStatusName: '在班',
      };
    });
  },

  async changeStatus(id, to, userId) {
    const cur = (await tbl(db, 'sms_class_jh', T, STAGE).where({ id, is_deleted: false }).first()) as
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
    await tbl(db, 'sms_class_jh', T, STAGE).where({ id }).update({
      class_status: to,
      update_time: new Date(),
      update_by: userId,
    });
  },

  async summary(q, user) {
    const qb = buildBase(q, user);
    const ids = await scopedClassIds(user);
    if (ids) {
      if (!ids.length) {
        return {
          stage: STAGE,
          stageName: STAGE_NAME,
          total: 0,
          openCount: 0,
          closedCount: 0,
          graduatingCount: 0,
          graduatedCount: 0,
          studentCount: 0,
        };
      }
      qb.whereIn('id', ids);
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