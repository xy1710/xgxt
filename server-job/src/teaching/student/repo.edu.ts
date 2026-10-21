/**
 * 学生档案仓储 · 教务（sms_edu.t_student_base）
 * ============================================================
 *
 * 【与其它学段最大的一处不同：连接方式】
 *   教务的表在**另一个库 sms_edu**。原实现（routes/eduStudent.route.ts）的做法是
 *   用**主连接（sms_job）+ 全限定表名 `sms_edu.t_xxx`** ——
 *   这样「一个事务同时改 sms_job + sms_edu」才成立。
 *   这里原样保留（不再单独开一个 edu 连接）。
 *
 * 【★ 行为变更（已记入交付说明）】
 *   原「教务」页是**三源合并的只读汇总**（edu 自己的学生 + 实训 + 大学的影子表，
 *   跨库按学号去重），因为在合并前它是**唯一能看到全校的地方**。
 *   合并后统一页的「全部」选项已经提供这个能力，而且由适配器统一去重、更准确。
 *   所以本仓储**只读教务自己的学生**，不再自己拼三源 ——
 *   「看全校」= 选「全部」。
 *
 * 【独有的副作用】改学生状态 → 联动冻结/解冻该生名下缴费记录
 *   （休学/退学 → 冻结；从休学/退学改回在读 → 只解冻**系统自动冻结的**那批）
 */

import { randomUUID } from 'crypto';
import { db } from '../../utils/db';
import { DEPT_NAME, GENDER_NAME, STUDENT_STATUS_NAME, StudentStatus } from 'shared-types';
import { isAutoFreezeStudentStatus, Stage, STAGE_NAME } from 'shared-types/edu';
import type {
  StudentDetail,
  StudentListQuery,
  StudentRow,
  StudentSaveBody,
  StudentSaveResult,
} from '../shared/dto';
import { calcAge, fmtDate, fmtDateTime } from '../shared/format';
import type { PhaseOption, StudentRepo } from './types';

/** ⚠️ 全限定表名（跨库访问的唯一合法姿势，见文件头注释） */
const T = 'sms_edu.t_student_base';
const PAYMENT_TABLE = 'sms_edu.t_edu_payment';
const STAGE = 'edu' as const;

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
  const phase = numOrNull(r.stage);
  const dormNo = str(r.dorm_no);
  return {
    stage: STAGE,
    stageName: '教务',
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
    phaseName: phase === null ? '' : (STAGE_NAME[phase] ?? ''),
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
    // 教务表没有 bed_no 列
    bedNo: null,
    bedLabel: dormNo,
    attendanceRate: numOrNull(r.attendance_rate),
    repeatCount: Number(r.repeat_count ?? 0),
    idCard: null, // 教务表没有身份证列
    nativePlace: null, // 教务表没有籍贯列
    graduateSchool: null,
    homeAddress: null,
    recruitTeacherName: null,
    recruitTeacherPhone: null,
    consultTeacherName: null,
    consultTeacherPhone: null,
    remark: str(r.remark),
    createTime: fmtDateTime(r.create_time),
  };
}

function buildBase(q: StudentListQuery) {
  const qb = db(T).where('is_deleted', false);
  if (q.classId) qb.andWhere('class_id', q.classId);
  if (q.deptCode) qb.andWhere('dept_code', q.deptCode);
  if (q.studentStatus) qb.andWhere('student_status', q.studentStatus);
  if (q.phaseCode) qb.andWhere('stage', q.phaseCode);
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
  sections: [],
  supportUnassigned: true,

  async list(q) {
    const rows = (await buildBase(q).orderBy('create_time', 'desc')) as Array<Record<string, any>>;
    return rows.map(mapRow);
  },

  async detail(id): Promise<StudentDetail | null> {
    const r = (await db(T).where({ id, is_deleted: false }).first()) as
      | Record<string, any>
      | undefined;
    if (!r) return null;
    const base = mapRow(r);
    return {
      base,
      profile: {
        birthDate: null,
        nativePlace: null,
        idCard: null,
        graduateSchool: null,
        homeAddress: null,
        idPhotoUrl: null,
        householdPhotoUrl: null,
      },
      market: {
        recruitTeacherName: null,
        recruitTeacherPhone: null,
        consultTeacherName: null,
        consultTeacherPhone: null,
      },
      dorm:
        base.dormId || base.dormNo
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
      resume: null,
      flows: [],
      repeats: [],
      extra: {
        quality: str(r.quality),
        lastClassCount: numOrNull(r.last_class_count),
      },
    };
  },

  async save(body, userId): Promise<StudentSaveResult> {
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
    set('age', body.age);
    set('dept_code', body.deptCode);
    set('class_id', body.classId);
    set('class_name', body.className);
    set('stage', body.phaseCode);
    set('education', body.education);
    set('enroll_date', body.enrollDate);
    set('phone', body.phone);
    set('parent_name', body.parentName);
    set('parent_phone', body.parentPhone);
    set('dorm_id', body.dormId);
    set('dorm_no', body.dormNo);
    set('remark', body.remark);
    const extra = body.extra || {};
    if ('quality' in extra) payload.quality = extra.quality ?? null;

    /* ---------- 修改 ---------- */
    if (body.id) {
      const exists = (await db(T).where({ id: body.id, is_deleted: false }).first()) as
        | Record<string, any>
        | undefined;
      if (!exists) throw new Error('学生不存在或已被删除');

      const oldStatus = Number(exists.student_status);
      const newStatus = body.studentStatus;
      const changed = newStatus != null && Number(newStatus) !== oldStatus;
      const becomeCold = changed && isAutoFreezeStudentStatus(Number(newStatus));
      const recoverFromCold =
        changed && isAutoFreezeStudentStatus(oldStatus) && !becomeCold;

      if (changed) payload.student_status = Number(newStatus);

      // 学号可能被改过，新旧学号挂着的历史缴费记录都要管到
      const nos = Array.from(
        new Set([String(exists.student_no || ''), String(body.studentNo || '')].filter(Boolean)),
      );

      await db(T).where({ id: body.id }).update(payload);

      let frozenCount = 0;
      let unfrozenCount = 0;
      // body.syncFreeze === false 时跳过（极少用，留个口子）
      if (changed && nos.length && body.syncFreeze !== false) {
        if (becomeCold) {
          frozenCount = await db(PAYMENT_TABLE)
            .whereIn('student_no', nos)
            .where('is_deleted', false)
            .where('frozen', false)
            .update({ frozen: 1, auto_frozen: 1, update_time: now, update_by: userId });
        } else if (recoverFromCold) {
          unfrozenCount = await db(PAYMENT_TABLE)
            .whereIn('student_no', nos)
            .where('is_deleted', false)
            .where('auto_frozen', 1)
            .update({ frozen: 0, auto_frozen: 0, update_time: now, update_by: userId });
        }
      }
      return { id: body.id, frozenCount, unfrozenCount };
    }

    /* ---------- 新增 ---------- */
    const studentNo = String(body.studentNo || '').trim() || (await generateStudentNo());
    // 唯一性预检不带 is_deleted（唯一索引是物理的，逻辑删除的历史行仍占号）
    const dup = (await db(T).where({ student_no: studentNo }).first()) as
      | Record<string, any>
      | undefined;
    if (dup) {
      throw new Error(
        dup.is_deleted
          ? `学号 ${studentNo} 已被「已删除」的历史学生占用，不可复用，请更换`
          : `学号 ${studentNo} 已存在，请勿重复添加`
      );
    }

    const id = randomUUID();
    await db(T).insert({
      id,
      student_no: studentNo,
      ...payload,
      student_status: body.studentStatus ?? StudentStatus.PRE_STUDY,
      repeat_count: 0,
      is_deleted: false,
      create_time: now,
      create_by: userId,
    });
    return { id, frozenCount: 0, unfrozenCount: 0 };
  },

  async remove(id, userId) {
    await db(T)
      .where({ id })
      .update({ is_deleted: true, update_time: new Date(), update_by: userId });
  },


  async phaseOptions(): Promise<PhaseOption[]> {
    return Object.entries(STAGE_NAME).map(([v, label]) => ({ value: Number(v), label }));
  },
};

/** 学号生成：E + 年份 + 4 位流水（教务口径） */
async function generateStudentNo(): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `E${year}`;
  const rows = (await db(T).where('student_no', 'like', `${prefix}%`).select('student_no')) as Array<{
    student_no: string;
  }>;
  const max = rows.reduce((m, r) => {
    const n = Number(String(r.student_no).slice(prefix.length));
    return Number.isFinite(n) && n > m ? n : m;
  }, 0);
  return `${prefix}${String(max + 1).padStart(4, '0')}`;
}

/** 供外部引用（保持与原始 edu 模块一致的口径常量） */
export const EDU_STAGE_RANGE_UNIV: number[] = [Stage.UNIV_1, Stage.UNIV_6];

export default repo;
