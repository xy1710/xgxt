/**
 * 班级仓储 · 实训/就业（sms_job.t_job_class）
 * ============================================================
 *
 * 【为什么这个学段字段最全 —— 它是另外两段的「超集」】
 *   `t_job_class` 29 列，两个 `t_class_info` 只有 21 / 25 列。
 *   差异见每处 ★ 注释。
 *
 * 【本段独有、原样保留的两条业务规则】
 *   ① 班级编号 `class_code` **必填 + 全局唯一**（另两个学段那两张表根本没这列）
 *      同部门内班级名也不可重名
 *   ② 「开放」状态已废弃（2026-10-02斌哥确认：能进实训/就业阶段的班只会是封班），
 *      所以**新建班默认 class_status=2（封班）**，不传就是 2。
 *      「解封」接口原实现保留但无入口 —— 统一流转表里 封班→开放 天然合法，
 *      这里不额外拦（要拦也是页面不显示按钮的事）。
 *
 * 【★ 数据范围（不能动，越权=数据泄露）】
 *   校长 / 学管 / 管理员 → 全量
 *   项目经理           → **只限 project_manager_id = 本人** 的班
 *   班主任             → head_teacher_id = 本人
 *   ⚠️ 项目经理**不做 head_teacher_id 兜底** —— 实训班的班主任字段与项目经理同人，
 *      兜底等于「全放开」。
 */

import { randomUUID } from 'crypto';
import { db } from '../../utils/db';
import { RoleCode, hasRole } from 'shared-types';
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
// ★ 2026-10-19 实训与就业部共用「就业部」阶段方案（dept_code=3）：
//   阶段名优先读 t_class_stage，PHASE_NAME 只兜底老数据
import { resolveStageName } from '../../class-jh/utils/stageDict';
import type { ClassRepo } from './types';
import { tbl, readPhaseCode, phaseCodeCol, tblIns } from '../shared/uniTable';

const T = 't_job_class';
const ROSTER_T = 't_job_class_student';
const STUDENT_T = 't_student_base';
const STAGE = 'job' as const;
const STAGE_NAME = '实训';

/** 实训阶段：1 一阶段 2 二阶段 3 三阶段 */
const PHASE_NAME: Record<number, string> = {
  1: '一阶段',
  2: '二阶段',
  3: '三阶段',
};

/** 入班方式（花名册 t_job_class_student.join_type） */
const JOIN_TYPE_NAME: Record<number, string> = {
  1: '新生入班',
  2: '换班转入',
  3: '末班转入',
  4: '休学复学',
};

function str(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  return String(v);
}
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const DEPT_NAME: Record<number, string> = { 1: '初高部', 2: '大学部', 3: '就业部' };

/** 行 → 统一结构 */
function mapRow(r: Record<string, any>, studentCount: number | null): ClassRow {
  const status = Number(r.class_status ?? CLASS_STATUS.CLOSED);
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
    phaseName: phase === null ? '' : (PHASE_NAME[phase] ?? resolveStageName(phase)),
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
    classroom: str(r.classroom),
    openDate: str(fmtDate(r.open_date)),
    closeDate: str(fmtDate(r.close_date)),
    // ★ 优先用实时统计的人数，表里的冗余值只当兜底
    studentCount: studentCount ?? Number(r.student_count ?? 0),
    classStatus: status,
    classStatusName: CLASS_STATUS_NAME[status] ?? '',
    canChangeStatus: status !== CLASS_STATUS.GRADUATED,
    attendanceRate: numOrNull(r.attendance_rate),
    // 实训这张表是累计出勤率（初高才是 today_*）
    attendanceRateKind: 'total',
    remark: str(r.remark),
    createTime: fmtDateTime(r.create_time),
  };
}

/** 数据范围（口径原样搬，见文件头说明） */
async function applyScope(qb: any, user: any): Promise<void> {
  const roles = user?.roles || [];
  const uid = user?.userId || '';
  if (
    hasRole(roles, RoleCode.SYS_ADMIN) ||
    hasRole(roles, RoleCode.TEACH_DEAN) ||
    hasRole(roles, RoleCode.RM_PRINCIPAL)
  ) {
    return;
  }
  if (hasRole(roles, RoleCode.PROJECT_MANAGER)) {
    const mine = (await tbl(db, 'sms_job', T, STAGE)
      .where({ project_manager_id: uid, is_deleted: false })
      .select('id')) as Array<{ id: string }>;
    const ids = mine.map((c) => c.id);
    if (!ids.length) qb.whereRaw('1 = 0');
    else qb.whereIn('id', ids);
    return;
  }
  if (hasRole(roles, RoleCode.TEACH_HEAD)) {
    qb.andWhere('head_teacher_id', uid);
  }
}

function buildBase(q: ClassListQuery) {
  // ★ 2026-10-19：实训与就业部共用这张表、dept 都是就业部(3)，
  //   靠 stage_key 区分（实训='job'，就业部='emp'）
  const qb = tbl(db, 'sms_job', T, STAGE)
    .where('is_deleted', false)
    .andWhere('stage_key', 'job');
  if (q.deptCode) qb.andWhere('dept_code', q.deptCode);
  if (q.classStatus) qb.andWhere('class_status', q.classStatus);
  if (q.phaseCode) qb.andWhere(phaseCodeCol(), q.phaseCode);
  if (q.keyword) {
    qb.andWhere((b: any) => {
      b.where('class_name', 'like', `%${q.keyword}%`)
        .orWhere('class_code', 'like', `%${q.keyword}%`)
        .orWhere('head_teacher_name', 'like', `%${q.keyword}%`);
    });
  }
  return qb;
}

/** 批量统计各班「在班」人数（花名册 status=1） */
async function countStudents(classIds: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!classIds.length) return map;
  const rows = (await tbl(db, 'sms_job', ROSTER_T, STAGE)
    .whereIn('class_id', classIds)
    .where({ is_deleted: false, status: 1 })
    // ★ 2026-10-16 修：必须 groupBy，否则 only_full_group_by 模式下
    //   「select class_id, count(*) 无 group by」直接报 1140 错误。
    .groupBy('class_id')
    .select('class_id')
    .count({ c: '*' })
    // ⚠️ 同上：ONLY_FULL_GROUP_BY 下必须 group by（现在只有 1 个实训班没暴露，别等 2 个班）
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
      hasCloseDate: true,
      hasSealAction: true,
      classroomLabel: '教室地点',
      phaseOptions: Object.entries(PHASE_NAME).map(([v, label]) => ({
        value: Number(v),
        label,
      })),
    };
  },

  async list(q, user) {
    const qb = buildBase(q);
    await applyScope(qb, user);
    const rows = (await qb.orderBy('create_time', 'desc')) as Array<Record<string, any>>;
    const counts = await countStudents(rows.map((r) => String(r.id)));
    return rows.map((r) => mapRow(r, counts.get(String(r.id)) ?? 0));
  },

  async detail(id, user) {
    const guard = tbl(db, 'sms_job', T, STAGE).where({ id, is_deleted: false });
    await applyScope(guard, user);
    const r = (await guard.first()) as Record<string, any> | undefined;
    if (!r) return null;

    const counts = await countStudents([id]);
    const base = mapRow(r, counts.get(id) ?? 0);
    const roster = await this.roster(id, user);
    const allowed = canTransitClassStatus(base.classStatus, base.classStatus)
      ? transitionsFrom(base.classStatus)
      : [];
    return { base, roster, allowedStatus: allowed, extra: null };
  },

  async save(body, userId) {
    const now = new Date();
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
    set('classroom', body.classroom);
    set('open_date', body.openDate);
    set('close_date', body.closeDate);
    set('remark', body.remark);
    if (body.classStatus !== undefined) payload.class_status = body.classStatus;

    if (body.id) {
      // 修改时也走状态机
      if (body.classStatus !== undefined) {
        const cur = (await tbl(db, 'sms_job', T, STAGE).where({ id: body.id }).first()) as
          | Record<string, any>
          | undefined;
        if (!cur) throw new Error('班级不存在');
        const from = Number(cur.class_status);
        if (from !== body.classStatus && !canTransitClassStatus(from, body.classStatus)) {
          throw new Error(
            `班级状态不可从「${CLASS_STATUS_NAME[from]}」流转为「${CLASS_STATUS_NAME[body.classStatus]}」`,
          );
        }
        // ★ 2026-10-19：改状态挪进「编辑班级」后，保存这条路径也要补上原来
        //   changeStatus 做的事 —— 结业写结业日期 + 记住上一个状态。
        if (from !== body.classStatus && body.classStatus === CLASS_STATUS.GRADUATED) {
          if (!payload.close_date) payload.close_date = now;
          payload.prev_class_status = from;
        }
      }
      await tbl(db, 'sms_job', T, STAGE).where({ id: body.id }).update(payload);
      return { id: body.id };
    }

    // 新增：编号必填 + 唯一；同部门内名称不重复（原实现口径）
    const classCode = String(body.classCode || '').trim();
    if (!classCode) throw new Error('班级编号必填');
    if (!String(body.openDate || '').trim()) throw new Error('开班日期必填');
    // ★ 2026-10-15 放宽：班主任允许不选（head_teacher_id 已迁改为可空）。
    //   班级名称留空时自动占位（class_name 列 NOT NULL + 部门内不重复）
    const pad2 = (n: number) => String(n).padStart(2, '0');
    const className =
      String(body.className || '').trim() ||
      `未命名班级-${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
    const deptCode = Number(body.deptCode ?? 3);
    const dupCode = (await tbl(db, 'sms_job', T, STAGE).where({ class_code: classCode, is_deleted: false }).first()) as
      | Record<string, any>
      | undefined;
    if (dupCode) throw new Error(`班级编号「${classCode}」已存在`);
    const dupName = (await tbl(db, 'sms_job', T, STAGE)
      .where({ class_name: className, dept_code: deptCode, is_deleted: false })
      .first()) as Record<string, any> | undefined;
    if (dupName) throw new Error(`该部门下已有班级叫「${className}」`);

    const id = randomUUID();
    await tblIns(db, 'sms_job', T, STAGE, {
      id,
      class_code: classCode,
      stage_key: 'job',
      class_name: className, // ★ create 时名称可能被自动占位（见上）
      // ★ 新建默认封班（"开放"已废弃）
      class_status: body.classStatus ?? CLASS_STATUS.CLOSED,
      // ★ `stage`（阶段码）/ `dept_code` 在这张表都是 NOT NULL，前端没传时给兜底值
      [phaseCodeCol()]: body.phaseCode ?? 1,
      dept_code: deptCode,
      student_count: 0,
      is_deleted: false,
      create_time: now,
      create_by: userId,
      ...payload,
    });
    return { id };
  },

  async remove(id, userId) {
    await tbl(db, 'sms_job', T, STAGE).where({ id }).update({
      is_deleted: true,
      update_time: new Date(),
      update_by: userId,
    });
  },

  async roster(id, user) {
    const guard = tbl(db, 'sms_job', T, STAGE).where({ id, is_deleted: false });
    await applyScope(guard, user);
    const ok = await guard.first();
    if (!ok) return [];

    const rows = (await tbl(db, 'sms_job', ROSTER_T, STAGE)
      .where({ class_id: id, is_deleted: false })
      .orderBy('create_time', 'asc')) as Array<Record<string, any>>;

    // 补性别：花名册表只有快照姓名/学号，性别要回学生主档取
    const ids = rows.map((r) => String(r.student_id)).filter(Boolean);
    const genderMap = new Map<string, number>();
    if (ids.length) {
      const stus = (await tbl(db, 'sms_job', STUDENT_T, STAGE)
        .whereIn('id', ids)
        .select('id', 'gender')) as Array<Record<string, any>>;
      for (const s of stus) genderMap.set(String(s.id), Number(s.gender ?? 0));
    }

    const GENDER: Record<number, string> = { 0: '未知', 1: '男', 2: '女' };
    return rows.map((r): ClassRosterRow => {
      const st = Number(r.status ?? 1);
      const joinType = numOrNull(r.join_type);
      const gender = genderMap.get(String(r.student_id)) ?? 0;
      return {
        studentId: String(r.student_id),
        studentNo: str(r.student_no),
        studentName: str(r.student_name),
        gender,
        genderName: GENDER[gender] ?? '未知',
        joinType,
        joinTypeName: joinType === null ? '' : (JOIN_TYPE_NAME[joinType] ?? ''),
        joinDate: str(fmtDate(r.join_date)),
        inClassStatus: st,
        inClassStatusName: st === 1 ? '在班' : '已离班',
      };
    });
  },

  async changeStatus(id, to, userId) {
    const cur = (await tbl(db, 'sms_job', T, STAGE).where({ id, is_deleted: false }).first()) as
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
    const patch: Record<string, any> = {
      class_status: to,
      update_time: new Date(),
      update_by: userId,
    };
    // 结业要写结业日期（原实现口径）
    if (to === CLASS_STATUS.GRADUATED) {
      patch.close_date = new Date();
      patch.prev_class_status = from;
    }
    await tbl(db, 'sms_job', T, STAGE).where({ id }).update(patch);
  },

  async summary(q, user) {
    const qb = buildBase(q);
    await applyScope(qb, user);
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

/** 允许流转到的目标状态 */
function transitionsFrom(from: number): number[] {
  const map: Record<number, number[]> = {
    [CLASS_STATUS.OPEN]: [CLASS_STATUS.CLOSED],
    [CLASS_STATUS.CLOSED]: [CLASS_STATUS.OPEN, CLASS_STATUS.GRADUATED],
    [CLASS_STATUS.GRADUATING]: [CLASS_STATUS.GRADUATED],
    [CLASS_STATUS.GRADUATED]: [],
  };
  return map[from] ?? [];
}

/** 班级编号生成：SX + 年份 + 4 位流水 */
export async function genClassCode(): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `SX${year}`;
  const rows = (await tbl(db, 'sms_job', T, STAGE).where('class_code', 'like', `${prefix}%`).select('class_code')) as Array<{
    class_code: string;
  }>;
  const max = rows.reduce((m, r) => {
    const n = Number(String(r.class_code).slice(prefix.length));
    return Number.isFinite(n) && n > m ? n : m;
  }, 0);
  return `${prefix}${String(max + 1).padStart(4, '0')}`;
}

export default repo;