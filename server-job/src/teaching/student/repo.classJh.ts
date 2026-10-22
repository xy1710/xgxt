/**
 * 学生档案仓储 · 初高（sms_class_jh.t_class_student）
 * ============================================================
 *
 * 【与其它学段不同名的字段】
 *   idCard   → id_card_no   （就业/大学叫 id_card）★ 命名冲突点
 *   nativePlace → native_place
 *
 * 【独有的区块】校园网账号密码（net_account / net_init_password）
 * 【独有的列】  pending_flow_type（进行中的流程）/ agreement_status / literacy_desc
 *
 * 【数据范围】原实现走 class-jh 的 dataScope：
 *   buildClassScope(req) + getScopedClassIds(db, 班级表, scope)
 *   —— 本班级范围时按班级的 班主任/教员/助教 三字段匹配。
 */

import { randomUUID } from 'crypto';
import { db } from '../../class-jh/utils/db';
import { buildClassScope, getScopedClassIds } from '../../class-jh/middleware/dataScope';
import { DEPT_NAME, GENDER_NAME, STUDENT_STATUS_NAME, StudentStatus } from 'shared-types';
import { STAGE_NAME, FLOW_TYPE_NAME } from 'shared-types/class-jh';
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
// ★ 2026-10-21 学号新规：LZ + J/T(初/高) + 班号(3位) + 班内序号(3位, 每班从001独立)
import { nextStudentNoForClass } from '../shared/studentNo';

const T = 't_class_student';
const CLASS_TABLE = 't_class_info';
const FLOW_TABLE = 't_class_flow';
const REPEAT_TABLE = 't_class_repeat';
const STAGE = 'jh' as const;
/** 初高库（本仓储全部表都在这里） */
const DB = 'sms_class_jh';

/**
 * ★ 2026-10-21：按「阶段方案阶段」筛选
 *
 * 学生表只存阶段码（int），方案阶段在**班级**上（scheme_stage_id），
 * 所以只能按学生所在班级关联 —— 不能拿学生自己的 stage 去比，两套编码没有映射关系。
 */
function applySchemeFilter(qb: any, q: StudentListQuery): void {
  const classOf = () => tbl(db, 'sms_class_jh', CLASS_TABLE, STAGE);
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

function str(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  return String(v);
}
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 初高的「末班状态」——用于标记该学段是否已进过末班 */

function mapRow(r: Record<string, any>): StudentRow {
  const gender = Number(r.gender ?? 0);
  const status = Number(r.student_status ?? 0);
  const phase = readPhaseCode(r);
  return {
    stage: STAGE,
    stageName: '初高部',
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
    dormNo: str(r.dorm_no),
    bedNo: str(r.bed_no),
    bedLabel: bedText(str(r.dorm_no), str(r.bed_no)),
    attendanceRate: numOrNull(r.attendance_rate),
    repeatCount: Number(r.repeat_count ?? 0),
    // ★ 初高列名是 id_card_no
    idCard: str(r.id_card_no),
    nativePlace: str(r.native_place),
    graduateSchool: str(r.graduate_school),
    homeAddress: str(r.home_address),
    recruitTeacherName: str(r.recruit_teacher_name),
    recruitTeacherPhone: str(r.recruit_teacher_phone),
    consultTeacherName: str(r.consult_teacher_name),
    consultTeacherPhone: str(r.consult_teacher_phone),
    remark: str(r.remark),
    createTime: fmtDateTime(r.create_time),
  };
}

/** 房间号-床位（初高自己的拼法：`301-3`，不带上/下） */
function bedText(room: string | null, bed: string | null): string | null {
  if (!room) return bed;
  if (!bed) return room;
  return `${room}-${bed}`;
}

async function applyScope(qb: any, user: any): Promise<void> {
  const scope = buildClassScope({ user } as any);
  const classIds = await getScopedClassIds(db, CLASS_TABLE, scope, DB, STAGE);
  if (classIds) {
    if (!classIds.length) qb.whereRaw('1 = 0');
    else qb.whereIn('class_id', classIds);
  } else if (scope.type === 3 && scope.deptCode) {
    qb.andWhere('dept_code', scope.deptCode);
  }
}

function buildBase(q: StudentListQuery) {
  const qb = tbl(db, 'sms_class_jh', T, STAGE).where('is_deleted', false);
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
  sections: ['net', 'flows', 'repeats'],
  supportUnassigned: true,

  async list(q, user) {
    const qb = buildBase(q);
    await applyScope(qb, user);
    await applyClassScopeKeepNull(qb, 'class_id', STAGE, user);
    const rows = (await qb.orderBy('create_time', 'desc')) as Array<Record<string, any>>;
    return rows.map(mapRow);
  },

  async detail(id, user) {
    const r = (await tbl(db, 'sms_class_jh', T, STAGE).where({ id, is_deleted: false }).first()) as
      | Record<string, any>
      | undefined;
    if (!r) return null;
    const guard = tbl(db, 'sms_class_jh', T, STAGE).where({ id, is_deleted: false });
    await applyScope(guard, user);
    if (!(await guard.first())) return null;

    const base = mapRow(r);
    // ★ 切读接入：审批流水 t_class_flow → t_uni_approval。
    //   下面读的 flow_type / flow_status / apply_time / current_node_name / reject_reason
    //   在统一表里同名保留（超集），只需换表。
    const flows = (await tbl(db, 'sms_class_jh', FLOW_TABLE, STAGE)
      .where({ student_id: id, is_deleted: false })
      .orderBy('create_time', 'desc')) as Array<Record<string, any>>;
    const repeats = (await tbl(db, 'sms_class_jh', REPEAT_TABLE, STAGE)
      .where({ student_id: id, is_deleted: false })
      .orderBy('repeat_time', 'desc')) as Array<Record<string, any>>;

    return {
      base,
      profile: {
        birthDate: str(fmtDate(r.birth_date)),
        nativePlace: str(r.native_place),
        idCard: str(r.id_card_no),
        graduateSchool: str(r.graduate_school),
        homeAddress: str(r.home_address),
        idPhotoUrl: str(r.id_photo_url),
        householdPhotoUrl: str(r.household_photo_url),
      },
      market: {
        recruitTeacherName: str(r.recruit_teacher_name),
        recruitTeacherPhone: str(r.recruit_teacher_phone),
        consultTeacherName: str(r.consult_teacher_name),
        consultTeacherPhone: str(r.consult_teacher_phone),
      },
      dorm:
        base.dormId || base.dormNo
          ? {
              dormId: base.dormId,
              dormNo: base.dormNo,
              bedNo: base.bedNo,
              bedLabel: base.bedLabel,
              building: null,
            }
          : null,
      quality: null,
      net: {
        netAccount: str(r.net_account),
        netInitPassword: str(r.net_init_password),
      },
      resume: null,
      flows: flows.map((f) => ({
        id: String(f.id),
        flowType: f.flow_type,
        flowTypeName: FLOW_TYPE_NAME[Number(f.flow_type)] ?? '',
        flowStatus: f.flow_status,
        applyTime: fmtDate(f.apply_time),
        currentNodeName: f.current_node_name ?? null,
        rejectReason: f.reject_reason ?? null,
      })),
      repeats: repeats.map((x) => ({
        id: String(x.id),
        fromClassName: x.from_class_name ?? null,
        toClassName: x.to_class_name ?? null,
        repeatReason: x.repeat_reason ?? null,
        repeatTime: fmtDate(x.repeat_time),
        repeatCount: x.repeat_count ?? 0,
      })),
      extra: {
        pendingFlowType: numOrNull(r.pending_flow_type),
        pendingFlowTypeName: FLOW_TYPE_NAME[Number(r.pending_flow_type)] ?? '',
        agreementStatus: numOrNull(r.agreement_status),
        literacyDesc: str(r.literacy_desc),
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
    set('native_place', body.nativePlace);
    /**
     * ★ 2026-10-20 修复：初高新增学生报 `Column 'dept_code' cannot be null`
     *
     * 初高表单没有「部门」字段（只有初高部/大学部两个值，学生档案里用不到），
     * 前端会传 `deptCode: null`。旧写法 `set('dept_code', body.deptCode)`
     * 会把 null **显式写进 SQL** —— 显式 NULL 会让列上的 `DEFAULT 1` 失效，
     * 直接撞 NOT NULL 约束。
     * → 这里把 null 归成 undefined（= 不写这一列），新增时走数据库默认值 1（初高部）；
     *   编辑时也不会把已有部门的记录清空。
     */
    set('dept_code', body.deptCode ?? undefined);
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
    // ★ 初高写 id_card_no
    set('id_card_no', body.idCard);
    set('recruit_teacher_name', body.recruitTeacherName);
    set('recruit_teacher_phone', body.recruitTeacherPhone);
    set('consult_teacher_name', body.consultTeacherName);
    set('consult_teacher_phone', body.consultTeacherPhone);
    set('dorm_id', body.dormId);
    set('dorm_no', body.dormNo);
    set('bed_no', body.bedNo);
    // ★ 校园网账号（可手填；留空时保存后由系统自动生成，见 ensureNetAccount）
    set('net_account', body.netAccount);
    set('net_init_password', body.netInitPassword);
    set('remark', body.remark);

    if (body.id) {
      await tbl(db, 'sms_class_jh', T, STAGE).where({ id: body.id }).update(payload);
      await ensureNetAccount(String(body.id));
      return { id: body.id };
    }

    // ★ 2026-10-22：学号一律按「LZ+班级编号+序号」生成，忽略前端手填值（用户口径）
    const studentNo = await generateStudentNo(body);
    const dup = (await tbl(db, 'sms_class_jh', T, STAGE).where({ student_no: studentNo }).first()) as
      | Record<string, any>
      | undefined;
    if (dup) {
      throw new Error(
        dup.is_deleted
          ? `学号 ${studentNo} 已被「已删除」的历史学生占用，不可复用，请更换`
          : `学号 ${studentNo} 已存在，请勿重复添加`,
      );
    }

    const id = randomUUID();
    await tblIns(db, 'sms_class_jh', T, STAGE, {
      id,
      student_no: studentNo,
      ...payload,
      student_status: body.studentStatus ?? StudentStatus.TRIAL,
      repeat_count: 0,
      is_deleted: false,
      create_time: now,
      create_by: userId,
    });
    await ensureNetAccount(id);
    return { id };
  },

  async remove(id, userId) {
    await tbl(db, 'sms_class_jh', T, STAGE).where({ id }).update({
      is_deleted: true,
      update_time: new Date(),
      update_by: userId,
    });
  },


  async phaseOptions(): Promise<PhaseOption[]> {
    return Object.entries(STAGE_NAME).map(([v, label]) => ({ value: Number(v), label }));
  },
};


/**
 * 校园网账号自动生成（2026-10-15 详情分签改版）：
 * 账号 = 学号；密码 = 8 位随机字母数字。只在「账号为空」时生成，
 * 已有账号（含用户手填）一律不动。
 */
async function ensureNetAccount(studentId: string): Promise<void> {
  const row = (await tbl(db, 'sms_class_jh', T, STAGE).where({ id: studentId }).first()) as
    | Record<string, any>
    | undefined;
  if (!row || str(row.net_account)) return;
  const account = str(row.student_no) || `NET${Date.now()}`;
  const password = Math.random().toString(36).slice(2, 10).toUpperCase();
  await tbl(db, 'sms_class_jh', T, STAGE).where({ id: studentId }).update({
    net_account: account,
    net_init_password: password,
    update_time: new Date(),
  });
}

/**
 * 学号生成（★ 2026-10-22 用户口径，替换掉 10-21 的「LZ+学段字母+班号」版本）：
 *   学号 = LZ + 班级编号 + 班内序号(3位)，如 LZQ17001
 *   必须选班级、班级必须有编号；没编号直接报错（不造旧格式兜底号）
 */
async function generateStudentNo(body: StudentSaveBody): Promise<string> {
  return nextStudentNoForClass('jh', body.classId);
}

export default repo;
