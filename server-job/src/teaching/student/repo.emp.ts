/**
 * 学生档案仓储 · 就业部（sms_job.t_student_base，dept_code=3）
 * ============================================================
 *
 * 【★ 2026-10-19 批注新增：部门「就业部」= 独立学段 emp】
 *   与「就业」(job) 共用 t_student_base，靠 dept_code=3 隔离；
 *   其余口径（可见状态 / 数据范围 / 字段映射）与就业学段完全一致。
 *
 * 【为什么这个学段叫「就业」而不是「实训」】
 *   实训阶段的学生档案页在菜单里叫「就业管理 → 信息档案」，
 *   学生状态的可见范围也是**就业口径**（只显示走出咨询阶段的人）。
 *   学段 key 用 `job`（与门户模块名一致），显示名用「就业」。
 *
 * 【原实现保留的两处口径（不能动）】
 *   ① 只显示 4 种状态：待就业(9) / 已就业(10) / 休学(6) / 退学(7)
 *   ② 数据范围：校长 / 学管 / 管理员 → 全量；项目经理 → 自己带的实训班；
 *      班主任 → 学生主档上 head_teacher_id = 本人
 *
 * 【字段映射（与其它学段不同名的）】
 *   recruitTeacherName  → admission_teacher        （大学/初高叫 recruit_teacher_name）
 *   consultTeacherName  → consult_teacher          （大学/初高叫 consult_teacher_name）
 *   idCard              → id_card
 *   nativePlace         → native_place
 */

import { randomUUID } from 'crypto';
import { db } from '../../utils/db';
import {
  DEPT_NAME,
  GENDER_NAME,
  RoleCode,
  STUDENT_STATUS_NAME,
  StudentStatus,
  hasRole,
} from 'shared-types';
import type {
  StudentDetail,
  StudentListQuery,
  StudentRow,
  StudentSaveBody,
  StudentSaveResult,
} from '../shared/dto';
import { birthFromIdCard, calcAge, fmtDate, fmtDateTime } from '../shared/format';
import type { PhaseOption, StudentRepo } from './types';
import { tbl, readPhaseCode, phaseCodeCol, tblIns, uniDb } from '../shared/uniTable';
import { nextStudentNoForClass } from '../shared/studentNo';
// ★ 2026-10-19 就业部接入阶段方案：阶段名优先读 t_class_stage，PHASE_NAME 只兜底老数据
import { resolveStageName } from '../../class-jh/utils/stageDict';

const T = 't_student_base';
const CLASS_TABLE = 't_job_class';

/* ★ 2026-10-22 关键修正：就业部 = dept_code=3 的全部 sms_job 学生（job / emp 两种
 *   edu_stage 都算）。原来 tbl(...,'emp') 会被注入 edu_stage='emp'，
 *   实训升上来的学生（edu_stage='job'）永远查不到 —— 远端注释说「dept_code=3
 *   两种 stage_key 都在」，但过滤根本没这么走。必须用 uniDb 直查。 */
const empStudents = () => uniDb('t_uni_student').whereIn('edu_stage', ['job', 'emp']).andWhere('dept_code', 3);
const empClasses = () => uniDb('t_uni_class').whereIn('edu_stage', ['job', 'emp']).andWhere('dept_code', 3);
const STAGE = 'emp' as const;

/**
 * ★ 2026-10-21：按「阶段方案阶段」筛选
 *
 * 学生表只存阶段码（int），方案阶段在**班级**上（scheme_stage_id），
 * 只能按学生所在班级关联。
 */
function applySchemeFilter(qb: any, q: StudentListQuery): void {
  const classOf = () => empClasses();
  if (q.schemeStageId) {
    qb.whereIn('class_id', classOf().where('scheme_stage_id', q.schemeStageId).select('id'));
  }
  if (q.noScheme) {
    qb.andWhere((b: any) => {
      b.whereNull('class_id').orWhereNotIn(
        'class_id',
        classOf().whereNotNull('scheme_stage_id').whereNot('scheme_stage_id', '').select('id'),
      );
    });
  }
}

/**
 * 学生档案「实训」页签可见的状态
 *
 * ★ 2026-10-16：在原口径（待就业 / 已就业 / 休学 / 退学 —— 旧的「就业档案」只关心
 *   已经走到就业环节的人）基础上**补上「实训中」**：教学管理合并成一个入口后，
 *   这个页签就是看实训班学生的，把「实训中」滤掉的话，实训班明明有 5 个学生，
 *   页签里却是空的（班级管理花名册 5 人 / 学生档案 0 人，对不上）。
 */
const VISIBLE_STATUS: number[] = [
  StudentStatus.TRAINING,
  StudentStatus.WAIT_EMPLOY,
  StudentStatus.EMPLOYED,
  StudentStatus.SUSPENDED,
  StudentStatus.QUIT,
];

/** 实训的学习阶段（1~6 初高部 / 7~12 大学部 / 13 实训） */
const PHASE_NAME: Record<number, string> = {
  1: '预科阶段',
  2: '初中部一期',
  3: '初中部二期',
  4: '初中部三期',
  5: '高中部一期',
  6: '高中部二期',
  7: '第一阶段',
  8: '第二阶段',
  9: '第三阶段',
  10: '第四阶段',
  11: '第五阶段',
  12: '第六阶段',
  13: '实训',
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
function boolVal(v: unknown): boolean {
  return v === 1 || v === true || v === '1' || v === 'true';
}

/** 行 → 统一结构 */
function mapRow(r: Record<string, any>): StudentRow {
  const gender = Number(r.gender ?? 0);
  const status = Number(r.student_status ?? 0);
  const phase = readPhaseCode(r);
  const dormNo = str(r.dorm_no);
  return {
    stage: STAGE,
    stageName: '就业部',
    studentId: String(r.id),
    studentNo: String(r.student_no ?? ''),
    studentName: String(r.student_name ?? ''),
    gender,
    genderName: GENDER_NAME[gender] ?? '',
    // ★ 年龄优先按出生日期实时计算（每年自动更新），库里 age 仅作无出生日期时的兜底
    age: calcAge(r.birth_date) ?? numOrNull(r.age),
    deptCode: numOrNull(r.dept_code),
    deptName: DEPT_NAME[Number(r.dept_code)] ?? '',
    classId: str(r.class_id),
    className: str(r.class_name),
    phaseCode: phase,
    phaseName: phase === null ? '' : (PHASE_NAME[phase] ?? resolveStageName(phase)),
    // 由 service 层按班级统一回填（见 attachSchemeStageNames）
    schemeStageName: null,
    headTeacherId: str(r.head_teacher_id),
    headTeacherName: str(r.head_teacher_name),
    teacherId: str(r.teacher_id),
    teacherName: str(r.teacher_name),
    assistantId: str(r.assistant_id),
    assistantName: str(r.assistant_name),
    studentStatus: status,
    studentStatusName: STUDENT_STATUS_NAME[status] ?? '',
    phone: str(r.phone),
    parentName: str(r.parent_name),
    parentPhone: str(r.parent_phone),
    education: str(r.education),
    enrollDate: str(fmtDate(r.enroll_date)) || null,
    dormId: str(r.dorm_id),
    dormNo,
    // ⚠️ 就业库这张表没有 bed_no 列，床位号恒为空（不是漏映射）
    bedNo: null,
    bedLabel: dormNo,
    attendanceRate: numOrNull(r.attendance_rate),
    repeatCount: Number(r.repeat_count ?? 0),
    idCard: str(r.id_card),
    nativePlace: str(r.native_place),
    graduateSchool: str(r.graduate_school),
    homeAddress: str(r.home_address),
    recruitTeacherName: str(r.admission_teacher),
    recruitTeacherPhone: str(r.admission_teacher_phone),
    consultTeacherName: str(r.consult_teacher),
    consultTeacherPhone: str(r.consult_teacher_phone),
    remark: str(r.remark),
    createTime: fmtDateTime(r.create_time),
  };
}

/**
 * 数据范围（原实现原样搬过来）
 *
 * ⚠️ 项目经理**只按 class_id 过滤，不做 head_teacher_id 兜底** ——
 *    实训班的班主任字段与项目经理同人，用 head_teacher_id 兜底会等于「全放开」。
 */
async function applyScope(qb: any, user: any): Promise<void> {
  const roles = user?.roles || [];
  /* ★ 2026-10-21：责任人列两种写入口径（门户 UUID / 权限库 U_xxx）都要比中 */
  const uids = [
    ...new Set([user?.userId, user?.businessUserId].map((x) => String(x || '')).filter(Boolean)),
  ];
  const uid = uids[0] || '';
  const isAdmin = hasRole(roles, RoleCode.SYS_ADMIN);
  const isDean = hasRole(roles, RoleCode.TEACH_DEAN);
  const isPrincipal = hasRole(roles, RoleCode.RM_PRINCIPAL);
  if (isAdmin || isDean || isPrincipal) return;

  /* ★ 2026-10-21：就业老师按「交棒给我的就业班」隔离
   *   原来这里没有 JOB_STAFF 分支 → 不过滤 = 看到全部就业部学生（多就业老师会串数据）。
   *   口径与实训侧一致：只看 employment_teacher = 我 的班。
   */
  if (hasRole(roles, RoleCode.JOB_STAFF)) {
    const mine = (await empClasses()
      .where({ is_deleted: false })
      .whereIn('employment_teacher_id', uids)
      .select('id')) as Array<{ id: string }>;
    const ids = mine.map((c) => c.id);
    if (!ids.length) qb.whereRaw('1 = 0');
    else qb.whereIn('class_id', ids);
    return;
  }

  if (hasRole(roles, RoleCode.PROJECT_MANAGER)) {
    const mine = (await empClasses()
      .where({ project_manager_id: uid, is_deleted: false })
      .select('id')) as Array<{ id: string }>;
    const ids = mine.map((c) => c.id);
    if (!ids.length) qb.whereRaw('1 = 0');
    else qb.whereIn('class_id', ids);
    return;
  }
  if (hasRole(roles, RoleCode.TEACH_HEAD)) {
    qb.andWhere('head_teacher_id', uid);
  }
}

function buildBase(q: StudentListQuery, user: any) {
  // ★ 2026-10-21：「就业」学段已从学生档案删除，就业部成为 sms_job 的**唯一入口**。
  //   原来按 stage_key='emp' 过滤，但现存 5 个学生的 stage_key 都是 'job'
  //   （他们是实训升上来的），照旧过滤会「删掉就业学段 → 人也跟着消失」。
  //   改为按 dept_code=3（就业部）取数：job / emp 两种 stage_key 都在，
  //   部门口径也更符合「就业部」这个名字。
  const qb = empStudents()
    .where('is_deleted', false)

    .andWhere('dept_code', 3)
    .whereIn('student_status', VISIBLE_STATUS);
  if (q.classId) qb.andWhere('class_id', q.classId);
  if (q.deptCode) qb.andWhere('dept_code', q.deptCode);
  if (q.studentStatus) qb.andWhere('student_status', q.studentStatus);
  if (q.phaseCode) qb.andWhere(phaseCodeCol(), q.phaseCode);
  applySchemeFilter(qb, q);
  if (q.keyword) {
    qb.andWhere((b: any) => {
      b.where('student_no', 'like', `%${q.keyword}%`)
        .orWhere('student_name', 'like', `%${q.keyword}%`)
        .orWhere('phone', 'like', `%${q.keyword}%`);
    });
  }
  if (q.unassigned) {
    qb.andWhere((b: any) => {
      b.whereNull('dorm_id').orWhere('dorm_no', '');
    });
  }
  return qb;
}

export const repo: StudentRepo = {
  stage: STAGE,
  sections: ['resume'],
  supportUnassigned: true,

  async list(q, user) {
    const qb = buildBase(q, user);
    await applyScope(qb, user);
    const rows = (await qb.orderBy('create_time', 'desc')) as Array<Record<string, any>>;
    return rows.map(mapRow);
  },

  async detail(id, user) {
    const r = (await empStudents().where({ id, is_deleted: false }).first()) as
      | Record<string, any>
      | undefined;
    if (!r) return null;
    // 单条也要过范围（否则可以拿别人的 id 直查）
    const guard = empStudents().where({ id, is_deleted: false });
    await applyScope(guard, user);
    const allowed = await guard.first();
    if (!allowed) return null;

    const base = mapRow(r);
    return {
      base,
      profile: {
        birthDate: str(fmtDate(r.birth_date)),
        nativePlace: str(r.native_place),
        idCard: str(r.id_card),
        graduateSchool: str(r.graduate_school),
        homeAddress: str(r.home_address),
        idPhotoUrl: null,
        householdPhotoUrl: null,
      },
      market: {
        recruitTeacherName: str(r.admission_teacher),
        recruitTeacherPhone: str(r.admission_teacher_phone),
        consultTeacherName: str(r.consult_teacher),
        consultTeacherPhone: str(r.consult_teacher_phone),
      },
      dorm: base.dormId || base.dormNo
        ? {
            dormId: base.dormId,
            dormNo: base.dormNo,
            bedNo: null,
            bedLabel: base.bedLabel,
            building: null,
          }
        : null,
      quality: null,
      net: null,
      resume: {
        resumeName: str(r.resume_name),
        resumeData: str(r.resume_data),
      },
      flows: [],
      repeats: [],
      extra: null,
    };
  },

  async save(body, userId) {
    const now = new Date();
    const payload: Record<string, any> = {
      student_name: body.studentName,
      gender: body.gender,
      update_time: now,
      update_by: userId,
    };
    const set = (k: string, v: unknown) => {
      if (v !== undefined) payload[k] = v;
    };
    // ★ 出生日期：前端传了用前端的；没传则从身份证号自动提取（2026-10-15 表单改版）
    const birth = body.birthDate || birthFromIdCard(body.idCard);
    set('birth_date', birth ?? undefined);
    if (birth) payload.age = calcAge(birth);
    else if (body.age !== undefined) payload.age = body.age;
    set('native_place', body.nativePlace);
    // 就业部学生的部门兜底 3（表单没选时也不落到 null）
    set('dept_code', body.deptCode ?? 3);
    set('class_id', body.classId);
    set('class_name', body.className);
    set(phaseCodeCol(), body.phaseCode);
    set('student_status', body.studentStatus);
    set('education', body.education);
    set('graduate_school', body.graduateSchool);
    set('enroll_date', body.enrollDate);
    set('phone', body.phone);
    set('parent_name', body.parentName);
    set('parent_phone', body.parentPhone);
    set('home_address', body.homeAddress);
    set('id_card', body.idCard);
    set('admission_teacher', body.recruitTeacherName);
    set('admission_teacher_phone', body.recruitTeacherPhone);
    set('consult_teacher', body.consultTeacherName);
    set('consult_teacher_phone', body.consultTeacherPhone);
    set('dorm_id', body.dormId);
    set('dorm_no', body.dormNo);
    set('remark', body.remark);
    // 简历在 extra 里
    const extra = body.extra || {};
    if ('resumeName' in extra) payload.resume_name = extra.resumeName ?? null;
    if ('resumeData' in extra) payload.resume_data = extra.resumeData ?? null;

    if (body.id) {
      await tbl(db, 'sms_job', T, STAGE).where({ id: body.id }).update(payload);
      return { id: body.id };
    }

    // ★ 2026-10-22：学号一律按「LZ+班级编号+序号」生成，忽略前端手填值（用户口径）
    const studentNo = await nextStudentNoForClass('emp', body.classId);
    // 唯一性预检必须**不带 is_deleted 过滤**（唯一索引是物理的，逻辑删除的历史行仍占号）
    const dup = (await empStudents().where({ student_no: studentNo }).first()) as
      | Record<string, any>
      | undefined;
    if (dup) {
      throw new Error(
        boolVal(dup.is_deleted)
          ? `学号 ${studentNo} 已被「已删除」的历史学生占用，不可复用，请更换`
          : `学号 ${studentNo} 已存在，请勿重复添加`,
      );
    }

    const id = randomUUID();
    await tblIns(db, 'sms_job', T, STAGE, {
      id,
      student_no: studentNo,
      stage_key: 'emp',
      ...payload,
      student_status: body.studentStatus ?? StudentStatus.WAIT_EMPLOY,
      repeat_count: 0,
      is_deleted: false,
      create_time: now,
      create_by: userId,
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


  async phaseOptions(): Promise<PhaseOption[]> {
    return Object.entries(PHASE_NAME).map(([v, label]) => ({ value: Number(v), label }));
  },
};


/** 学号生成：见 shared/studentNo.ts（LZ + 班级编号 + 序号），旧的 J+年份 流水已停用 */
export default repo;
