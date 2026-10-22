/**
 * 学生档案仓储 · 大学（sms_class.t_class_student）
 * ============================================================
 *
 * 【与其它学段不同名的字段】
 *   nativePlace → origin        （就业/初高叫 native_place）★ 命名冲突点
 *   idCard      → id_card
 *   recruitTeacherPhone → recruit_phone（不是 recruit_teacher_phone！）
 *   consultTeacherPhone → consult_phone（不是 consult_teacher_phone！）
 *
 * 【独有的区块】综合素质 7 维（quality_*），以及证件照 / 户口本照片
 * 【独有的列】  source_system / sync_status（外部同步标记）、source_batch_no
 *
 * 【数据范围】原实现走 class 的 applyDataScope：
 *   dataScope = ALL / DEPT / CLASS（按 user.classIds）/ SELF（按招生/咨询老师）
 */

import { randomUUID } from 'crypto';
import { db } from '../../class/db';
import { applyDataScope } from '../../class/middleware/dataScope';
import { notDeleted } from '../../class/lib/repo';
import { DEPT_NAME, GENDER_NAME, STUDENT_STATUS_NAME, StudentStatus } from 'shared-types';
import { bedLabel } from 'shared-types/class';
import type {
  StudentDetail,
  StudentListQuery,
  StudentRow,
  StudentSaveBody,
  StudentSaveResult,
} from '../shared/dto';
import { birthFromIdCard, calcAge, fmtDate, fmtDateTime } from '../shared/format';
import type { PhaseOption, StudentRepo } from './types';
import { tbl, readPhaseCode, phaseCodeCol, tblIns } from '../shared/uniTable';
import { applyClassScopeKeepNull } from '../shared/dataScope';
import { nextStudentNoForClass } from '../shared/studentNo';

const T = 't_class_student';
const CLASS_TABLE = 't_class_info';
const GRADE_TABLE = 't_class_grade';
const REPEAT_TABLE = 't_class_repeat';
const STAGE = 'class' as const;

/**
 * ★ 2026-10-21：按「阶段方案阶段」筛选
 *
 * 学生表只存阶段码（int），方案阶段在**班级**上（scheme_stage_id），
 * 只能按学生所在班级关联 —— 两套编码之间没有映射关系。
 */
function applySchemeFilter(qb: any, q: StudentListQuery): void {
  const classOf = () => tbl(db, 'sms_class', CLASS_TABLE, STAGE);
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

/** 大学的学习阶段（201~206 + 13 实训） */
const PHASE_NAME: Record<number, string> = {
  201: '一阶段',
  202: '二阶段',
  203: '三阶段',
  204: '四阶段',
  205: '五阶段',
  206: '六阶段',
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

function mapRow(r: Record<string, any>): StudentRow {
  const gender = Number(r.gender ?? 0);
  const status = Number(r.student_status ?? 0);
  const phase = readPhaseCode(r);
  const dormNo = str(r.dorm_no);
  const bedNo = str(r.bed_no);
  return {
    stage: STAGE,
    stageName: '大学部',
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
    phaseName: phase === null ? '' : (PHASE_NAME[phase] ?? ''),
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
    bedNo,
    // ★ 床位展示统一走 shared-types 的 bedLabel（奇上偶下：301-1-上）
    bedLabel: bedLabel(dormNo, bedNo) || null,
    attendanceRate: numOrNull(r.attendance_rate),
    repeatCount: Number(r.repeat_count ?? 0),
    idCard: str(r.id_card),
    // ★ 大学列名是 origin
    nativePlace: str(r.origin),
    graduateSchool: str(r.graduate_school),
    homeAddress: str(r.home_address),
    recruitTeacherName: str(r.recruit_teacher_name),
    recruitTeacherPhone: str(r.recruit_phone),
    consultTeacherName: str(r.consult_teacher_name),
    consultTeacherPhone: str(r.consult_phone),
    remark: str(r.remark),
    createTime: fmtDateTime(r.create_time),
  };
}

function buildBase(q: StudentListQuery, user: any) {
  const qb = tbl(db, 'sms_class', T, STAGE);
  notDeleted(qb);
  applyDataScope(qb, user, {
    classIdColumn: 'class_id',
    ownerColumns: ['recruit_teacher_id', 'consult_teacher_id'],
  });
  if (q.classId) qb.where('class_id', q.classId);
  if (q.deptCode) qb.where('dept_code', q.deptCode);
  if (q.studentStatus) qb.where('student_status', q.studentStatus);
  // ★ 阶段码列名按开关取：老表 `stage` / 统一表 `stage_code`（硬编码 'stage' 会静默查空）。
  if (q.phaseCode) qb.andWhere(phaseCodeCol(), q.phaseCode);
  applySchemeFilter(qb, q);
  if (q.keyword) {
    const k = q.keyword;
    qb.where(function (this: any) {
      this.where('student_no', 'like', `%${k}%`)
        .orWhere('student_name', 'like', `%${k}%`)
        .orWhere('phone', 'like', `%${k}%`);
    });
  }
  if (q.unassigned) {
    qb.where(function (this: any) {
      this.whereNull('dorm_id').orWhere('dorm_no', '');
    });
  }
  return qb;
}

export const repo: StudentRepo = {
  stage: STAGE,
  sections: ['quality'],
  supportUnassigned: true,

  async list(q, user) {
    const qb = buildBase(q, user);
    /* ★ 数据范围：班主任只看自己班的学生（applyDataScope 只到「部门」粒度） */
    await applyClassScopeKeepNull(qb, 'class_id', STAGE, user);
    qb.orderBy('student_no', 'asc');
    const rows = (await qb) as Array<Record<string, any>>;
    return rows.map(mapRow);
  },

  async detail(id, user) {
    const r = (await notDeleted(tbl(db, 'sms_class', T, STAGE)).where('id', id).first()) as
      | Record<string, any>
      | undefined;
    if (!r) return null;

    const base = mapRow(r);
    const [repeats, grades] = await Promise.all([
      notDeleted(tbl(db, 'sms_class', REPEAT_TABLE, STAGE)).where('student_id', id).orderBy('repeat_time', 'desc'),
      // ★ 切读接入：成绩子表 t_class_grade → t_uni_exam_score。
      //   此处读的 written_score / machine_score / interview_score / comp_score / exam_result
      //   在统一表里**同名保留**（统一表是超集），所以只需换表、不必改列名。
      notDeleted(tbl(db, 'sms_class', GRADE_TABLE, STAGE)).where('student_id', id).orderBy('create_time', 'desc'),
    ]);

    return {
      base,
      profile: {
        birthDate: str(fmtDate(r.birth_date)),
        nativePlace: str(r.origin),
        idCard: str(r.id_card),
        graduateSchool: str(r.graduate_school),
        homeAddress: str(r.home_address),
        idPhotoUrl: str(r.id_photo_url),
        householdPhotoUrl: str(r.household_photo_url),
      },
      market: {
        recruitTeacherName: str(r.recruit_teacher_name),
        recruitTeacherPhone: str(r.recruit_phone),
        consultTeacherName: str(r.consult_teacher_name),
        consultTeacherPhone: str(r.consult_phone),
      },
      dorm:
        base.dormId || base.dormNo
          ? {
              dormId: base.dormId,
              dormNo: base.dormNo,
              bedNo: base.bedNo,
              bedLabel: base.bedLabel,
              building: str(r.dorm_building),
            }
          : null,
      quality: {
        studyStatus: str(r.quality_study),
        discipline: str(r.quality_discipline),
        ability: str(r.quality_ability),
        comprehension: str(r.quality_comprehension),
        expression: str(r.quality_expression),
        social: str(r.quality_social),
        note: str(r.quality_note),
      },
      net: null,
      resume: null,
      flows: [],
      repeats: (repeats as Array<Record<string, any>>).map((x) => ({
        id: String(x.id),
        fromClassName: x.from_class_name ?? null,
        toClassName: x.to_class_name ?? null,
        repeatReason: x.repeat_reason ?? null,
        repeatTime: fmtDate(x.repeat_time),
        repeatCount: x.repeat_count ?? 0,
      })),
      extra: {
        // 成绩（原实现把它当作详情的一个页签）
        grades: (grades as Array<Record<string, any>>).map((g) => ({
          id: String(g.id),
          examId: g.exam_id ?? null,
          writtenScore: numOrNull(g.written_score),
          machineScore: numOrNull(g.machine_score),
          interviewScore: numOrNull(g.interview_score),
          compScore: numOrNull(g.comp_score),
          examResult: numOrNull(g.exam_result),
          examResultName: Number(g.exam_result) === 1 ? '通过' : '未通过',
        })),
        syncStatus: numOrNull(r.sync_status),
        sourceSystem: str(r.source_system),
      },
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
    // ★ 大学写 origin
    set('origin', body.nativePlace);
    set('dept_code', body.deptCode);
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
    set('recruit_teacher_name', body.recruitTeacherName);
    set('recruit_phone', body.recruitTeacherPhone);
    set('consult_teacher_name', body.consultTeacherName);
    set('consult_phone', body.consultTeacherPhone);
    set('dorm_id', body.dormId);
    set('dorm_no', body.dormNo);
    set('bed_no', body.bedNo);
    set('remark', body.remark);

    if (body.id) {
      await tbl(db, 'sms_class', T, STAGE).where({ id: body.id }).update(payload);
      return { id: body.id };
    }

    // ★ 2026-10-22：学号一律按「LZ+班级编号+序号」生成，忽略前端手填值（用户口径）
    const studentNo = await nextStudentNoForClass('class', body.classId);
    const dup = (await notDeleted(tbl(db, 'sms_class', T, STAGE)).where('student_no', studentNo).first()) as
      | Record<string, any>
      | undefined;
    if (dup) throw new Error(`学号 ${studentNo} 已存在，请勿重复添加`);

    const id = randomUUID();
    await tblIns(db, 'sms_class', T, STAGE, {
      id,
      student_no: studentNo,
      ...payload,
      source_system: 'manual',
      source_id: null,
      sync_status: 2,
      student_status: body.studentStatus ?? StudentStatus.TRIAL,
      repeat_count: 0,
      is_deleted: 0,
      create_time: now,
      create_by: userId,
    });
    return { id };
  },

  async remove(id, userId) {
    await tbl(db, 'sms_class', T, STAGE)
      .where({ id })
      .update({ is_deleted: 1, update_time: new Date(), update_by: userId });
  },


  async phaseOptions(): Promise<PhaseOption[]> {
    return Object.entries(PHASE_NAME).map(([v, label]) => ({ value: Number(v), label }));
  },
};


/** 学号生成：见 shared/studentNo.ts（LZ + 班级编号 + 序号），旧的 S+年份 流水已停用 */


export default repo;
