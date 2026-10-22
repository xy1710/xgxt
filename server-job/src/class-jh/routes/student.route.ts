/**
 * 学生主档路由（教学管理初高）
 *
 * 覆盖：
 *   - list / detail(7 页签) / add / update / delete(逻辑删除) / export
 *   - 流程入口 suspend / resume / quit / repeat / transfer（状态机校验 + op_log）
 *
 * 表：t_class_student（班级主表 t_class_info）
 * 字段：代码小驼峰 / 数据库下划线；枚举双返回 xxx + xxxName。
 */

import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import {
  BizCode,
  GENDER_NAME,
  DEPT_NAME,
  STUDENT_STATUS_NAME,
  FLOW_TYPE_NAME,
  ATTENDANCE_STATUS_NAME,
  EXAM_TYPE_NAME,
  EXAM_RESULT_NAME,
  PAY_STATUS_NAME,
  FEE_TYPE_NAME,
  classStatusAllowsIntake,
} from 'shared-types/class-jh';
import { StudentStatus, FlowType, ClassStatus, canRepeatByStage } from 'shared-types/class-jh';
import { ok, page } from '../utils/response';
import { db } from '../utils/db';
import { wrap } from '../utils/wrap';
import { writeOpLog } from '../utils/opLog';
import { nameOf } from '../utils/enumName';
// ★ 2026-10-16 阶段名改为「优先读阶段字典表」，常量表兜底（用户自建方案的阶段编码不在常量里）
import { resolveStageName } from '../utils/stageDict';
import { validate } from '../middleware/validate';
import { checkPermission } from '../middleware/auth';
import { BizError } from '../middleware/errorHandler';
import { buildClassScope, getScopedClassIds } from '../middleware/dataScope';
import { mobile, idCard, dateOnly, dateOnlyRequired } from '../utils/zodRules';
import { classSync } from '../../utils/classSync';
// ★ 2026-10-22 学号新规：LZ + 班级编号 + 班内序号(3位, 每班从001独立)
import { nextStudentNoForClass } from '../../teaching/shared/studentNo';
// ★ 2026-10-06：缴费记录统一取数（实时财务管理 + 初高台账兜底）
import { fetchStudentFeeRecords, summarizeFees } from '../../utils/financeFeeRef';
// ★ P4 切读层：本文件六张表（t_class_student / t_class_info / t_class_dorm_resident /
//   t_class_exam_score / t_class_flow / t_class_repeat）均已归一，
//   全部走 tbl()/tblIns() 路由；开关关时与原实现逐字节等价。
import { tbl, tblIns, phaseCodeCol, readPhaseCode } from '../../teaching/shared/uniTable';

export const studentRouter = Router();

/** 表名常量 */
const TABLE = 't_class_student';
const CLASS_TABLE = 't_class_info';
const DORM_RESIDENT_TABLE = 't_class_dorm_resident';
const EXAM_SCORE_TABLE = 't_class_exam_score';
const FLOW_TABLE = 't_class_flow';
const REPEAT_TABLE = 't_class_repeat';

/** ★ 统一表 edu_stage 取值（本路由只服务初高） */
const STAGE = 'jh' as const;
const DB = 'sms_class_jh';

/* ============================================================
 * 通用助手
 * ============================================================ */

/** 由出生日期计算年龄（无则返回 null） */
function calcAge(birthDate?: string | Date | null): number | null {
  if (!birthDate) return null;
  const b = new Date(birthDate);
  if (Number.isNaN(b.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - b.getFullYear();
  const m = now.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < b.getDate())) age--;
  return age >= 0 ? age : null;
}

/**
 * 生成学号（★ 2026-10-22 用户口径）：
 *   LZ + 班级编号 + 班内序号(3位)，如 LZQ17001
 *   必须选班级、班级必须有班级编号；没有就报错（不造旧格式兜底号）
 */
async function generateStudentNo(classId?: string | null): Promise<string> {
  return nextStudentNoForClass('jh', classId);
}

/** 当前时间 → 'yyyy-MM-dd HH:mm:ss'（推送时间戳用） */
function nowStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 学生列表行 → 前端列表项（双返回枚举名） */
function toListItem(r: any) {
  return {
    studentId: r.id,
    studentNo: r.student_no,
    studentName: r.student_name,
    gender: r.gender,
    genderName: nameOf(GENDER_NAME, r.gender),
    age: r.age ?? calcAge(r.birth_date),
    deptCode: r.dept_code,
    deptName: nameOf(DEPT_NAME, r.dept_code),
    classId: r.class_id,
    className: r.class_name,
    headTeacherName: r.head_teacher_name,
    studentStatus: r.student_status,
    studentStatusName: nameOf(STUDENT_STATUS_NAME, r.student_status),
    stage: r.stage,
    stageName: resolveStageName(r.stage),
    phone: r.phone,
    parentPhone: r.parent_phone,
    dormNo: r.dorm_no,
    education: r.education,
    enrollDate: r.enroll_date,
    attendanceRate: r.attendance_rate === null || r.attendance_rate === undefined ? null : Number(r.attendance_rate),
    literacyDesc: r.literacy_desc,
    repeatCount: r.repeat_count ?? 0,
    pendingFlowType: r.pending_flow_type,
    pendingFlowTypeName: nameOf(FLOW_TYPE_NAME, r.pending_flow_type),
    remark: r.remark,
  };
}

/** 学生全量行 → 实体（双返回） */
function toStudent(row: any) {
  return {
    id: row.id,
    studentNo: row.student_no,
    studentName: row.student_name,
    gender: row.gender,
    genderName: nameOf(GENDER_NAME, row.gender),
    birthDate: row.birth_date,
    age: row.age ?? calcAge(row.birth_date),
    nativePlace: row.native_place,
    deptCode: row.dept_code,
    deptName: nameOf(DEPT_NAME, row.dept_code),
    classId: row.class_id,
    className: row.class_name,
    stage: row.stage,
    stageName: resolveStageName(row.stage),
    headTeacherId: row.head_teacher_id,
    headTeacherName: row.head_teacher_name,
    teacherId: row.teacher_id,
    teacherName: row.teacher_name,
    assistantId: row.assistant_id,
    assistantName: row.assistant_name,
    studentStatus: row.student_status,
    studentStatusName: nameOf(STUDENT_STATUS_NAME, row.student_status),
    pendingFlowType: row.pending_flow_type,
    pendingFlowTypeName: nameOf(FLOW_TYPE_NAME, row.pending_flow_type),
    education: row.education,
    graduateSchool: row.graduate_school,
    enrollDate: row.enroll_date,
    phone: row.phone,
    parentPhone: row.parent_phone,
    homeAddress: row.home_address,
    idCardNo: row.id_card_no,
    agreementStatus: row.agreement_status,
    idPhotoUrl: row.id_photo_url,
    householdPhotoUrl: row.household_photo_url,
    netAccount: row.net_account,
    netInitPassword: row.net_init_password,
    recruitTeacherName: row.recruit_teacher_name,
    recruitTeacherPhone: row.recruit_teacher_phone,
    consultTeacherName: row.consult_teacher_name,
    consultTeacherPhone: row.consult_teacher_phone,
    dormId: row.dorm_id,
    dormNo: row.dorm_no,
    bedNo: row.bed_no,
    attendanceRate: row.attendance_rate === null || row.attendance_rate === undefined ? null : Number(row.attendance_rate),
    repeatCount: row.repeat_count ?? 0,
    remark: row.remark,
    literacyDesc: row.literacy_desc,
    createTime: row.create_time,
    updateTime: row.update_time,
  };
}

/**
 * 校验目标班级是否接受该类型转入（封班 → 40011）。
 *
 * @param classId         目标班级 ID
 * @param allowClosed     是否允许转入封班班级（休学复学/末班为 true）
 */
async function loadClassOrFail(classId: string): Promise<any> {
  const cls = await tbl(db, DB, CLASS_TABLE, STAGE).where({ id: classId, is_deleted: false }).first();
  if (!cls) throw new BizError(BizCode.CLASS_NOT_FOUND, '目标班级不存在');
  return cls;
}

async function assertClassAcceptsIntake(classId: string, allowClosed: boolean): Promise<any> {
  const cls = await loadClassOrFail(classId);
  if (!allowClosed && !classStatusAllowsIntake(cls.class_status)) {
    throw new BizError(BizCode.CLASS_CLOSED, `班级「${cls.class_name}」已封班，不可转入`);
  }
  return cls;
}

/* ============================================================
 * 1. 查询学生列表
 *   GET /api/class/student/list
 * ============================================================ */

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
  keyword: z.string().optional(),
  classId: z.string().optional(),
  stage: z.coerce.number().int().optional(),
  studentStatus: z.coerce.number().int().optional(),
  deptCode: z.coerce.number().int().optional(),
});

studentRouter.get(
  '/list',
  checkPermission('class:student:view'),
  validate(listSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as z.infer<typeof listSchema>;

    const query = tbl(db, DB, TABLE, STAGE).where('is_deleted', false);
    if (q.keyword) {
      query.andWhere((qb) => {
        qb.where('student_no', 'like', `%${q.keyword}%`)
          .orWhere('student_name', 'like', `%${q.keyword}%`)
          .orWhere('phone', 'like', `%${q.keyword}%`);
      });
    }
    if (q.classId) query.andWhere('class_id', q.classId);
    if (q.stage) query.andWhere(phaseCodeCol(), q.stage);
    if (q.studentStatus) query.andWhere('student_status', q.studentStatus);
    if (q.deptCode) query.andWhere('dept_code', q.deptCode);

    // 数据范围：本班级范围时按班主任/教员/助教过滤
    const scope = buildClassScope(req);
    const classIds = await getScopedClassIds(db, CLASS_TABLE, scope, DB, STAGE);
    if (classIds) {
      if (!classIds.length) {
        res.json(page([], 0, q));
        return;
      }
      query.whereIn('class_id', classIds);
    } else if (scope.type === 3 && scope.deptCode) {
      query.andWhere('dept_code', scope.deptCode);
    }

    const [{ total }] = (await query.clone().count({ total: '*' })) as Array<{ total: number }>;
    const rows = await query
      .clone()
      .select('*')
      .orderBy('create_time', 'desc')
      .limit(q.size)
      .offset((q.page - 1) * q.size);

    res.json(page(rows.map(toListItem), Number(total), q));
  }),
);

/* ============================================================
 * 2. 查询学生详情（7 页签）
 *   GET /api/class/student/detail?id=xxx
 * ============================================================ */

studentRouter.get(
  '/detail',
  checkPermission('class:student:view'),
  validate(z.object({ id: z.string().min(1, '必须传 id') })),
  wrap(async (req, res) => {
    const { id } = (req as any).validated as { id: string };

    const row = await tbl(db, DB, TABLE, STAGE).where({ id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.STUDENT_NOT_FOUND, '学生不存在');

    const base = toStudent(row);

    // ---- 缴费情况（★ 2026-10-06：用户需求 —— 与【财务管理·缴费管理】对齐）----
    //   实时按学号查财务 sms_finance.t_finance_fee（初高学生在财务里属「二三期」部门）；
    //   财务取不到时回落本模块缴费台账 t_class_fee，并在 feeMeta 里标 degraded 供前端提示。
    //   展示文案（类型 / 状态 / 部门）统一走 utils/financeFeeRef，保证和大学部、实训一个口径。
    const feeResult = await fetchStudentFeeRecords(row.student_no || '', { mirror: 'class-jh' });
    const fee = feeResult.records;
    const feeMeta = {
      source: feeResult.source,
      mirrorFrom: feeResult.mirrorFrom ?? null,
      degraded: feeResult.degraded,
      message: feeResult.message ?? null,
      summary: summarizeFees(fee),
    };

    // ---- 宿舍信息 ----
    const resident = await tbl(db, DB, DORM_RESIDENT_TABLE, STAGE)
      .where({ student_id: id, is_active: true, is_deleted: false })
      .orderBy('check_in_date', 'desc')
      .first();
    const dorm = resident
      ? {
          buildingId: resident.building_id,
          roomId: resident.room_id,
          roomNo: resident.room_no,
          bedId: resident.bed_id,
          bedNo: resident.bed_no,
          checkInDate: resident.check_in_date,
          ownerName: resident.owner_name,
        }
      : { dormNo: row.dorm_no, bedNo: row.bed_no };

    // ---- 考试成绩 ----
    const scoreRows = await tbl(db, DB, EXAM_SCORE_TABLE, STAGE).where({ student_id: id, is_deleted: false }).orderBy('exam_date', 'desc');
    const exam = scoreRows.map((s: any) => ({
      scoreId: s.id,
      examId: s.exam_id,
      examType: s.exam_type,
      examTypeName: nameOf(EXAM_TYPE_NAME, s.exam_type),
      examDate: s.exam_date,
      scoreTotal: s.score_total,
      examResult: s.exam_result,
      examResultName: nameOf(EXAM_RESULT_NAME, s.exam_result),
      isPassed: s.is_passed,
      scoreTeacherName: s.score_teacher_name,
    }));

    // ---- 市场咨询信息 ----
    const mkt = {
      recruitTeacherName: row.recruit_teacher_name,
      recruitTeacherPhone: row.recruit_teacher_phone,
      consultTeacherName: row.consult_teacher_name,
      consultTeacherPhone: row.consult_teacher_phone,
      enrollDate: row.enroll_date,
    };

    // ---- 班级流程 / 末班记录 ----
    const flowRows = await tbl(db, DB, FLOW_TABLE, STAGE).where({ student_id: id, is_deleted: false }).orderBy('create_time', 'desc');
    const repeatRows = await tbl(db, DB, REPEAT_TABLE, STAGE).where({ student_id: id, is_deleted: false }).orderBy('repeat_time', 'desc');
    const cls = {
      flows: flowRows.map((f: any) => ({
        flowId: f.id,
        flowType: f.flow_type,
        flowTypeName: nameOf(FLOW_TYPE_NAME, f.flow_type),
        flowStatus: f.flow_status,
        applyTime: f.apply_time,
        currentNodeName: f.current_node_name,
        rejectReason: f.reject_reason,
      })),
      repeats: repeatRows.map((r: any) => ({
        repeatId: r.id,
        fromClassName: r.from_class_name,
        toClassName: r.to_class_name,
        repeatReason: r.repeat_reason,
        repeatTime: r.repeat_time,
        repeatCount: r.repeat_count,
      })),
    };

    // ---- 校园网信息 ----
    const net = {
      netAccount: row.net_account,
      netInitPassword: row.net_init_password,
    };

    res.json(ok({ ...base, base, net, fee, feeMeta, dorm, exam, mkt, cls }));
  }),
);

/* ============================================================
 * 3. 新增学生（学号可后端生成，Q8）
 *   POST /api/class/student/add
 * ============================================================ */

const addSchema = z.object({
  studentNo: z.string().max(32).optional(),
  studentName: z.string().min(1, '姓名必填'),
  gender: z.coerce.number().int().min(1).max(2, '性别只能是 1(男) 或 2(女)'),
  birthDate: dateOnly.optional(),
  nativePlace: z.string().max(100).optional(),
  deptCode: z.coerce.number().int().min(1).max(2).default(1),
  classId: z.string().optional(),
  className: z.string().optional(),
  stage: z.coerce.number().int().optional(),
  studentStatus: z.coerce.number().int().default(5),
  education: z.string().max(50).optional(),
  graduateSchool: z.string().max(100).optional(),
  enrollDate: dateOnly.optional(),
  phone: mobile.optional(),
  parentPhone: mobile.optional(),
  homeAddress: z.string().max(255).optional(),
  idCardNo: idCard.optional(),
  agreementStatus: z.coerce.number().int().optional(),
  recruitTeacherName: z.string().max(50).optional(),
  recruitTeacherPhone: mobile.optional(),
  consultTeacherName: z.string().max(50).optional(),
  consultTeacherPhone: mobile.optional(),
  remark: z.string().max(500).optional(),
  literacyDesc: z.string().max(2000).optional(),
});

studentRouter.post(
  '/add',
  checkPermission('class:student:add'),
  validate(addSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof addSchema>;

    // ★ 2026-10-22：学号一律按「LZ+班级编号+序号」生成，忽略手填值（用户口径）
    const studentNo = await generateStudentNo(body.classId ?? null);
    // ⚠️ 唯一性预检必须按「物理范围」查（不带 is_deleted 过滤）：
    //    t_class_student.uk_student_no 是物理唯一索引，被逻辑删除的历史行仍占用学号。
    //    若这里带 is_deleted=false，删除后重建同号会绕过预检、直撞索引 → 返回 50002。
    const exists = await tbl(db, DB, TABLE, STAGE).where({ student_no: studentNo }).first();
    if (exists) {
      throw new BizError(
        BizCode.STUDENT_NO_EXISTS,
        exists.is_deleted
          ? `学号 ${studentNo} 已被「已删除」的历史学生占用，不可复用，请更换`
          : `学号 ${studentNo} 已存在，请勿重复添加`,
      );
    }

    // 若指定班级，回填班级冗余字段与阶段
    let className = body.className ?? null;
    let stage = body.stage ?? null;
    if (body.classId) {
      const cls = await loadClassOrFail(body.classId);
      className = cls.class_name;
      stage = stage ?? readPhaseCode(cls);
    }

    const id = randomUUID();
    const now = new Date();
    await tblIns(db, DB, TABLE, STAGE, {
      id,
      student_no: studentNo,
      student_name: body.studentName,
      gender: body.gender,
      birth_date: body.birthDate ?? null,
      age: calcAge(body.birthDate),
      native_place: body.nativePlace ?? null,
      dept_code: body.deptCode,
      class_id: body.classId ?? null,
      class_name: className,
      [phaseCodeCol()]: stage,
      student_status: body.studentStatus,
      education: body.education ?? null,
      graduate_school: body.graduateSchool ?? null,
      enroll_date: body.enrollDate ?? null,
      phone: body.phone ?? null,
      parent_phone: body.parentPhone ?? null,
      home_address: body.homeAddress ?? null,
      id_card_no: body.idCardNo ?? null,
      agreement_status: body.agreementStatus ?? 1,
      recruit_teacher_name: body.recruitTeacherName ?? null,
      recruit_teacher_phone: body.recruitTeacherPhone ?? null,
      consult_teacher_name: body.consultTeacherName ?? null,
      consult_teacher_phone: body.consultTeacherPhone ?? null,
      repeat_count: 0,
      remark: body.remark ?? null,
      literacy_desc: body.literacyDesc ?? null,
      is_deleted: false,
      create_time: now,
      create_by: req.user?.userId || 'system',
    });

    await writeOpLog({
      module: 'student',
      bizType: '新增学生',
      bizId: id,
      studentId: id,
      opUserId: req.user?.userId,
      opUserName: req.user?.userName,
      opDesc: `新增学生 ${body.studentName}（学号 ${studentNo}）`,
      afterValue: { studentNo, studentName: body.studentName },
    });

    res.json(ok({ id }, '新增成功'));
  }),
);

/* ============================================================
 * 4. 修改学生（白名单字段：StudentSavePayload）
 *   PUT /api/class/student/update
 * ============================================================ */

const updateSchema = z.object({
  id: z.string().min(1, '必须传 id'),
  studentName: z.string().min(1, '姓名必填'),
  gender: z.coerce.number().int().min(1).max(2),
  birthDate: dateOnly.optional(),
  nativePlace: z.string().max(100).optional(),
  education: z.string().max(50).optional(),
  graduateSchool: z.string().max(100).optional(),
  enrollDate: dateOnly.optional(),
  homeAddress: z.string().max(255).optional(),
  phone: mobile.optional(),
  parentPhone: mobile.optional(),
  agreementStatus: z.coerce.number().int().optional(),
  remark: z.string().max(500).optional(),
  literacyDesc: z.string().max(2000).optional(),
  idCardNo: idCard.optional(),
});

studentRouter.put(
  '/update',
  checkPermission('class:student:edit'),
  validate(updateSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof updateSchema>;

    const exists = await tbl(db, DB, TABLE, STAGE).where({ id: body.id, is_deleted: false }).first();
    if (!exists) throw new BizError(BizCode.STUDENT_NOT_FOUND, '学生不存在');

    await tbl(db, DB, TABLE, STAGE).where({ id: body.id }).update({
      student_name: body.studentName,
      gender: body.gender,
      birth_date: body.birthDate ?? null,
      age: calcAge(body.birthDate),
      native_place: body.nativePlace ?? null,
      education: body.education ?? null,
      graduate_school: body.graduateSchool ?? null,
      enroll_date: body.enrollDate ?? null,
      home_address: body.homeAddress ?? null,
      phone: body.phone ?? null,
      parent_phone: body.parentPhone ?? null,
      agreement_status: body.agreementStatus ?? exists.agreement_status,
      remark: body.remark ?? null,
      literacy_desc: body.literacyDesc ?? null,
      id_card_no: body.idCardNo ?? null,
      update_time: new Date(),
      update_by: req.user?.userId || 'system',
    });

    res.json(ok(null, '修改成功'));
  }),
);

/* ============================================================
 * 5. 删除学生（逻辑删除）
 *   DELETE /api/class/student/delete/:id
 * ============================================================ */

studentRouter.delete(
  '/delete/:id',
  checkPermission('class:student:delete'),
  wrap(async (req, res) => {
    const { id } = req.params;
    const exists = await tbl(db, DB, TABLE, STAGE).where({ id, is_deleted: false }).first();
    if (!exists) throw new BizError(BizCode.STUDENT_NOT_FOUND, '学生不存在或已被删除');

    await tbl(db, DB, TABLE, STAGE).where({ id }).update({
      is_deleted: true,
      update_time: new Date(),
      update_by: req.user?.userId || 'system',
    });

    res.json(ok(null, '删除成功'));
  }),
);

/* ============================================================
 * 6. 导出学生（不分页，前端转 CSV）
 *   GET /api/class/student/export
 * ============================================================ */

studentRouter.get(
  '/export',
  checkPermission('class:student:export'),
  validate(listSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as z.infer<typeof listSchema>;

    const query = tbl(db, DB, TABLE, STAGE).where('is_deleted', false);
    if (q.keyword) {
      query.andWhere((qb) => {
        qb.where('student_no', 'like', `%${q.keyword}%`)
          .orWhere('student_name', 'like', `%${q.keyword}%`)
          .orWhere('phone', 'like', `%${q.keyword}%`);
      });
    }
    if (q.classId) query.andWhere('class_id', q.classId);
    if (q.stage) query.andWhere(phaseCodeCol(), q.stage);
    if (q.studentStatus) query.andWhere('student_status', q.studentStatus);
    if (q.deptCode) query.andWhere('dept_code', q.deptCode);

    const rows = await query.clone().select('*').orderBy('create_time', 'desc');
    res.json(ok(rows.map(toListItem)));
  }),
);

/* ============================================================
 * 流程入口公共：创建流程记录 + 回写 pending_flow_type
 * ============================================================ */

interface CreateFlowInput {
  flowType: FlowType;
  studentId: string;
  studentNo?: string;
  studentName?: string;
  classId?: string;
  className?: string;
  applyUserId?: string;
  applyUserName?: string;
  applyReason?: string | null;
  extra?: Record<string, any>;
}

/** 创建流程（默认 flowStatus=1 待提交） */
async function createFlow(input: CreateFlowInput): Promise<string> {
  const flowId = randomUUID();
  const now = new Date();
  await tblIns(db, DB, FLOW_TABLE, STAGE, {
    id: flowId,
    flow_type: input.flowType,
    student_id: input.studentId ?? null,
    student_no: input.studentNo ?? null,
    student_name: input.studentName ?? null,
    class_id: input.classId ?? null,
    class_name: input.className ?? null,
    apply_user_id: input.applyUserId ?? null,
    apply_user_name: input.applyUserName ?? null,
    apply_time: now,
    apply_reason: input.applyReason ?? null,
    flow_status: 1,
    current_node_name: '待提交',
    suspend_status: 1,
    is_deleted: false,
    create_time: now,
    create_by: input.applyUserId ?? 'system',
    ...(input.extra || {}),
  });
  return flowId;
}

/** 取学生或抛错 */
async function loadStudentOrFail(studentId: string): Promise<any> {
  const s = await tbl(db, DB, TABLE, STAGE).where({ id: studentId, is_deleted: false }).first();
  if (!s) throw new BizError(BizCode.STUDENT_NOT_FOUND, '学生不存在');
  return s;
}

/** 校验学生状态是否在允许集合内（否则 40014） */
function assertStatusIn(student: any, allowed: StudentStatus[], actionName: string): void {
  if (!allowed.includes(student.student_status)) {
    const cur = nameOf(STUDENT_STATUS_NAME, student.student_status);
    throw new BizError(
      BizCode.ILLEGAL_STATE_TRANSITION,
      `当前学生状态为「${cur}」，不允许${actionName}`,
    );
  }
}

/** 回写 student.pending_flow_type */
async function setPendingFlow(studentId: string, flowType: FlowType | null, userId?: string): Promise<void> {
  await tbl(db, DB, TABLE, STAGE).where({ id: studentId }).update({
    pending_flow_type: flowType,
    update_time: new Date(),
    update_by: userId || 'system',
  });
}

/* ============================================================
 * 7. 休学 suspend（状态机：仅 5 正式在读）
 *   POST /api/class/student/suspend
 * ============================================================ */

const suspendSchema = z.object({
  studentId: z.string().min(1, '学生必填'),
  suspendStartDate: dateOnlyRequired,
  expectResumeDate: dateOnly.optional(),
  suspendReason: z.string().min(1, '休学原因必填'),
  phone: mobile.optional(),
  attendedHours: z.coerce.number().int().optional(),
});

studentRouter.post(
  '/suspend',
  checkPermission('class:student:add'),
  validate(suspendSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof suspendSchema>;
    const stu = await loadStudentOrFail(body.studentId);
    assertStatusIn(stu, [StudentStatus.STUDYING], '申请休学');
    if (stu.pending_flow_type) {
      throw new BizError(BizCode.DUPLICATE_SUBMIT, '该学生已有审批中的流程，请勿重复提交');
    }

    const flowId = await createFlow({
      flowType: FlowType.SUSPEND,
      studentId: stu.id,
      studentNo: stu.student_no,
      studentName: stu.student_name,
      classId: stu.class_id,
      className: stu.class_name,
      applyUserId: req.user?.userId,
      applyUserName: req.user?.userName,
      applyReason: body.suspendReason,
      extra: {
        suspend_start_date: body.suspendStartDate,
        expect_resume_date: body.expectResumeDate ?? null,
        suspend_reason: body.suspendReason,
        phone: body.phone ?? stu.phone ?? null,
        attended_hours: body.attendedHours ?? null,
        id_card_no: stu.id_card_no ?? null,
      },
    });

    await setPendingFlow(stu.id, FlowType.SUSPEND, req.user?.userId);

    await writeOpLog({
      module: 'student',
      bizType: '休学',
      bizId: flowId,
      studentId: stu.id,
      classId: stu.class_id,
      opUserId: req.user?.userId,
      opUserName: req.user?.userName,
      opDesc: `提交休学申请（学生 ${stu.student_name}）`,
      beforeValue: { studentStatus: stu.student_status },
      afterValue: { pendingFlowType: FlowType.SUSPEND },
    });

    res.json(ok({ flowId }, '休学申请已提交'));
  }),
);

/* ============================================================
 * 8. 复学 resume（状态机：仅 6 休学，且封班可转入）
 *   POST /api/class/student/resume
 * ============================================================ */

const resumeSchema = z.object({
  studentId: z.string().min(1, '学生必填'),
  resumeClassId: z.string().min(1, '复学班级必填'),
  resumeDate: dateOnlyRequired,
  applyReason: z.string().optional(),
});

studentRouter.post(
  '/resume',
  checkPermission('class:student:add'),
  validate(resumeSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof resumeSchema>;
    const stu = await loadStudentOrFail(body.studentId);
    assertStatusIn(stu, [StudentStatus.SUSPENDED], '申请复学');
    if (stu.pending_flow_type) {
      throw new BizError(BizCode.DUPLICATE_SUBMIT, '该学生已有审批中的流程，请勿重复提交');
    }
    // 复学允许转入封班班级
    const cls = await assertClassAcceptsIntake(body.resumeClassId, true);

    const flowId = await createFlow({
      flowType: FlowType.RESUME,
      studentId: stu.id,
      studentNo: stu.student_no,
      studentName: stu.student_name,
      classId: stu.class_id,
      className: stu.class_name,
      applyUserId: req.user?.userId,
      applyUserName: req.user?.userName,
      applyReason: body.applyReason ?? null,
      extra: {
        resume_class_id: cls.id,
        resume_date: body.resumeDate,
        to_stage: readPhaseCode(cls),
      },
    });

    await setPendingFlow(stu.id, FlowType.RESUME, req.user?.userId);

    await writeOpLog({
      module: 'student',
      bizType: '复学',
      bizId: flowId,
      studentId: stu.id,
      classId: stu.class_id,
      opUserId: req.user?.userId,
      opUserName: req.user?.userName,
      opDesc: `提交复学申请（学生 ${stu.student_name} → 班级 ${cls.class_name}）`,
      beforeValue: { studentStatus: stu.student_status },
      afterValue: { pendingFlowType: FlowType.RESUME, resumeClassId: cls.id },
    });

    res.json(ok({ flowId }, '复学申请已提交'));
  }),
);

/* ============================================================
 * 9. 退学 quit（状态机：5 正式在读 / 6 休学）
 *   POST /api/class/student/quit
 * ============================================================ */

const quitSchema = z.object({
  studentId: z.string().min(1, '学生必填'),
  applyDate: dateOnly.optional(),
  suspendReason: z.string().min(1, '退学原因必填'),
  attendedHours: z.coerce.number().int().optional(),
  // ★ 退学须同时登记退费信息：审批通过后据此自动生成退费单（F-01）
  refundFeeType: z.coerce.number().int().min(1, '退费类型必填').max(4, '退费类型只能是 1~4'),
  refundAmount: z.coerce.number().int().positive('退费金额必须为正整数（单位：分）'),
});

studentRouter.post(
  '/quit',
  checkPermission('class:student:add'),
  validate(quitSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof quitSchema>;
    const stu = await loadStudentOrFail(body.studentId);
    assertStatusIn(stu, [StudentStatus.STUDYING, StudentStatus.SUSPENDED], '申请退学');
    if (stu.pending_flow_type) {
      throw new BizError(BizCode.DUPLICATE_SUBMIT, '该学生已有审批中的流程，请勿重复提交');
    }

    const flowId = await createFlow({
      flowType: FlowType.QUIT,
      studentId: stu.id,
      studentNo: stu.student_no,
      studentName: stu.student_name,
      classId: stu.class_id,
      className: stu.class_name,
      applyUserId: req.user?.userId,
      applyUserName: req.user?.userName,
      applyReason: body.suspendReason,
      extra: {
        suspend_reason: body.suspendReason,
        attended_hours: body.attendedHours ?? null,
        phone: stu.phone ?? null,
        id_card_no: stu.id_card_no ?? null,
        // ★ 退费信息随退学流程留存，审批通过后用于自动生成退费单
        refund_fee_type: body.refundFeeType,
        refund_amount: body.refundAmount,
        apply_time: body.applyDate ? new Date(body.applyDate) : new Date(),
      },
    });

    await setPendingFlow(stu.id, FlowType.QUIT, req.user?.userId);

    await writeOpLog({
      module: 'student',
      bizType: '退学',
      bizId: flowId,
      studentId: stu.id,
      classId: stu.class_id,
      opUserId: req.user?.userId,
      opUserName: req.user?.userName,
      opDesc: `提交退学申请（学生 ${stu.student_name}，拟退费 ${(body.refundAmount / 100).toFixed(2)} 元）`,
      beforeValue: { studentStatus: stu.student_status },
      afterValue: { pendingFlowType: FlowType.QUIT, refundAmount: body.refundAmount },
    });

    res.json(ok({ flowId }, '退学申请已提交'));
  }),
);

/* ============================================================
 * 10. 末班 repeat（改走审批流：申请 → 经理审批 → 通过后生效）
 *   POST /api/class/student/repeat
 *
 * ⚠️ 与休学/复学/转班保持一致：提交只创建「待提交」流程，不改学生数据；
 *    审批通过后由 flow.route 的 side effect 调 applyRepeatEffect 生效。
 * ============================================================ */

const repeatSchema = z.object({
  studentId: z.string().min(1, '学生必填'),
  toClassId: z.string().min(1, '转入班级必填'),
  repeatReason: z.string().min(1, '末班原因必填'),
  notifyUserId: z.string().optional(),
  isNotified: z.coerce.boolean().optional(),
});

/**
 * 末班业务校验（申请与生效共用）：
 *   1) 学生须「正式在读」(5)
 *   2) 阶段规则：除「1期」外均可末班（初中部1期 / 高中部1期 不可）
 *   3) 目标班级存在，且允许转入（末班允许转入封班）
 */
async function assertRepeatAllowed(studentId: string, toClassId: string): Promise<{ stu: any; toCls: any }> {
  const stu = await loadStudentOrFail(studentId);
  assertStatusIn(stu, [StudentStatus.STUDYING], '申请末班');
  if (!canRepeatByStage(readPhaseCode(stu))) {
    throw new BizError(
      BizCode.BUSINESS_RULE_VIOLATION,
      `「${resolveStageName(stu.stage) || stu.stage}」阶段学生不可末班，仅非1期阶段可办理末班`,
    );
  }
  const toCls = await assertClassAcceptsIntake(toClassId, true);
  return { stu, toCls };
}

/**
 * 末班生效：改班级/阶段 + 累计次数 + 写末班记录（**仅审批通过后调用**）。
 *
 * ⚠️ 本函数不再自行创建流程记录 —— 流程由 createRepeatFlow 创建，
 *    审批通过时由 flow.route 调用本函数施加副作用。返回末班记录 ID。
 */
export async function applyRepeatEffect(
  studentId: string,
  toClassId: string,
  reason: string,
  user?: { userId?: string; userName?: string },
  notifyUserId?: string | null,
  isNotified?: boolean,
): Promise<string> {
  const { stu, toCls } = await assertRepeatAllowed(studentId, toClassId);

  const repeatId = randomUUID();
  const now = new Date();
  const nextCount = (stu.repeat_count ?? 0) + 1;

  // 1) 末班记录
  await tblIns(db, DB, REPEAT_TABLE, STAGE, {
    id: repeatId,
    student_id: stu.id,
    student_no: stu.student_no,
    student_name: stu.student_name,
    from_class_id: stu.class_id ?? null,
    from_class_name: stu.class_name ?? null,
    from_stage: readPhaseCode(stu) ?? null,
    to_class_id: toCls.id,
    to_class_name: toCls.class_name,
    to_stage: readPhaseCode(toCls),
    repeat_reason: reason,
    repeat_time: now,
    repeat_count: nextCount,
    notify_user_id: notifyUserId ?? null,
    is_notified: isNotified ?? false,
    is_deleted: false,
    create_time: now,
    create_by: user?.userId ?? 'system',
  });

  // 2) 学生：改班级/阶段 + 累计次数 + 清 pending（审批通过，学生状态仍为 5 正式在读）
  await tbl(db, DB, TABLE, STAGE).where({ id: stu.id }).update({
    class_id: toCls.id,
    class_name: toCls.class_name,
    [phaseCodeCol()]: readPhaseCode(toCls),
    repeat_count: nextCount,
    pending_flow_type: null,
    update_time: now,
    update_by: user?.userId || 'system',
  });

  // 3) 操作日志
  await writeOpLog({
    module: 'student',
    bizType: '末班',
    bizId: repeatId,
    studentId: stu.id,
    classId: toCls.id,
    opUserId: user?.userId,
    opUserName: user?.userName,
    opDesc: `学生末班生效：${stu.class_name || ''} → ${toCls.class_name}（累计第 ${nextCount} 次）`,
    beforeValue: { classId: stu.class_id, stage: readPhaseCode(stu), repeatCount: stu.repeat_count ?? 0 },
    afterValue: { classId: toCls.id, stage: readPhaseCode(toCls), repeatCount: nextCount },
  });

  return repeatId;
}

/**
 * 末班申请：创建「待提交」流程 + 回写 pending（与休学/复学/转班一致）。
 * 返回流程 ID。
 */
export async function createRepeatFlow(
  body: z.infer<typeof repeatSchema>,
  user?: { userId?: string; userName?: string },
): Promise<string> {
  const { stu, toCls } = await assertRepeatAllowed(body.studentId, body.toClassId);
  if (stu.pending_flow_type) {
    throw new BizError(BizCode.DUPLICATE_SUBMIT, '该学生已有审批中的流程，请勿重复提交');
  }

  const flowId = await createFlow({
    flowType: FlowType.REPEAT,
    studentId: stu.id,
    studentNo: stu.student_no,
    studentName: stu.student_name,
    classId: stu.class_id,
    className: stu.class_name,
    applyUserId: user?.userId,
    applyUserName: user?.userName,
    applyReason: body.repeatReason,
    extra: {
      from_class_id: stu.class_id ?? null,
      to_class_id: toCls.id,
      from_stage: readPhaseCode(stu) ?? null,
      to_stage: readPhaseCode(toCls),
      transfer_reason: body.repeatReason,
      notify_user_id: body.notifyUserId ?? null,
      is_notified: body.isNotified ?? false,
    },
  });

  await setPendingFlow(stu.id, FlowType.REPEAT, user?.userId);

  await writeOpLog({
    module: 'student',
    bizType: '末班',
    bizId: flowId,
    studentId: stu.id,
    classId: stu.class_id,
    opUserId: user?.userId,
    opUserName: user?.userName,
    opDesc: `提交末班申请（学生 ${stu.student_name} → ${toCls.class_name}）`,
    beforeValue: { classId: stu.class_id, stage: readPhaseCode(stu), repeatCount: stu.repeat_count ?? 0 },
    afterValue: { pendingFlowType: FlowType.REPEAT, toClassId: toCls.id },
  });

  return flowId;
}

studentRouter.post(
  '/repeat',
  checkPermission('class:student:add'),
  validate(repeatSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof repeatSchema>;
    const flowId = await createRepeatFlow(body, req.user);
    res.json(ok({ flowId }, '末班申请已提交'));
  }),
);

/* ============================================================
 * 11. 转班 transfer（封班校验 40011；创建流程 type=3）
 *   POST /api/class/student/transfer
 * ============================================================ */

const transferSchema = z.object({
  studentId: z.string().min(1, '学生必填'),
  toClassId: z.string().min(1, '目标班级必填'),
  toStage: z.coerce.number().int().optional(),
  transferReason: z.string().optional(),
});

studentRouter.post(
  '/transfer',
  checkPermission('class:student:edit'),
  validate(transferSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof transferSchema>;
    const stu = await loadStudentOrFail(body.studentId);
    assertStatusIn(stu, [StudentStatus.PRE_STUDY, StudentStatus.STUDYING], '申请转班');
    if (stu.pending_flow_type) {
      throw new BizError(BizCode.DUPLICATE_SUBMIT, '该学生已有审批中的流程，请勿重复提交');
    }
    // 转班不属于休学复学/末班 → 封班班级不可转入（40011）
    const toCls = await assertClassAcceptsIntake(body.toClassId, false);

    const flowId = await createFlow({
      flowType: FlowType.TRANSFER,
      studentId: stu.id,
      studentNo: stu.student_no,
      studentName: stu.student_name,
      classId: stu.class_id,
      className: stu.class_name,
      applyUserId: req.user?.userId,
      applyUserName: req.user?.userName,
      applyReason: body.transferReason ?? null,
      extra: {
        from_class_id: stu.class_id ?? null,
        to_class_id: toCls.id,
        from_stage: readPhaseCode(stu) ?? null,
        to_stage: body.toStage ?? readPhaseCode(toCls),
        transfer_reason: body.transferReason ?? null,
      },
    });

    await setPendingFlow(stu.id, FlowType.TRANSFER, req.user?.userId);

    await writeOpLog({
      module: 'student',
      bizType: '转班',
      bizId: flowId,
      studentId: stu.id,
      classId: stu.class_id,
      opUserId: req.user?.userId,
      opUserName: req.user?.userName,
      opDesc: `提交转班申请（学生 ${stu.student_name} → 班级 ${toCls.class_name}）`,
      beforeValue: { classId: stu.class_id, stage: readPhaseCode(stu) },
      afterValue: { toClassId: toCls.id, toStage: body.toStage ?? readPhaseCode(toCls) },
    });

    res.json(ok({ flowId }, '转班申请已提交'));
  }),
);

/* ============================================================
 * ★ 2026-10-05 咨询「分班」直建（内部入口）
 *   POST /api/class-jh/student/from-consult
 *
 * 市场咨询「收款与缴费」里已缴学员点「分班」选了初高班级 →
 * 不走「待接收」，**直接**在本班建档入班（用户口径：初高不需要班主任再同意）。
 *
 * ⚠️ 内部接口（只接受 x-internal-token，见 middleware/auth.ts INTERNAL_INGRESS）：
 *    幂等键 = (source_system='consult', source_id=consultNo)，
 *    同一张咨询单重复点分班不会造出两个学生。
 * ============================================================ */

const fromConsultSchema = z.object({
  /** 咨询单号（幂等键） */
  consultNo: z.string().min(1, '缺少咨询单号'),
  studentName: z.string().min(1, '缺少学生姓名'),
  gender: z.coerce.number().int().min(1).max(2).optional(),
  phone: z.string().optional().nullable(),
  parentPhone: z.string().optional().nullable(),
  age: z.coerce.number().int().min(0).max(120).optional().nullable(),
  /** 毕业学校 */
  school: z.string().optional().nullable(),
  address: z.string().optional().nullable(),
  classId: z.string().min(1, '缺少班级ID'),
  remark: z.string().optional().nullable(),
  /**
   * ★ 2026-10-19：初高改走「待接收」后，接收弹窗补的这几项要能带过来
   *   （原来直建入班时这些全由初高自己生成/留空）。
   */
  studentNo: z.string().max(32).optional().nullable(),
  education: z.string().max(50).optional().nullable(),
  enrollDate: z.string().optional().nullable(),
  studentStatus: z.coerce.number().int().optional().nullable(),
});

/**
 * ★ 2026-10-06 新增：按咨询单号批量查「是否已在初高入班」（内部只读）
 *
 * 用途：咨询「收款与缴费」页要判断该生是否已经分过班 ——
 *      初高是**直建入班**（不落待接收单），所以只能查学生表：
 *      source_system='consult' + source_id=<咨询单号>。
 *      已入班 → 不允许再分派到别的班；被驳回（大学部侧）→ 可以重新分派。
 */
studentRouter.get(
  '/enrolled-status',
  wrap(async (req, res) => {
    const raw = String(req.query.nos || '').trim();
    const nos = raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [];
    if (!nos.length) {
      res.json(ok({}, '查询成功'));
      return;
    }
    const rows = (await tbl(db, DB, TABLE, STAGE)
      .where({ source_system: 'consult', is_deleted: false })
      .whereIn('source_id', nos)
      .select('source_id', 'id', 'student_no', 'class_id', 'class_name')) as Array<Record<string, unknown>>;
    const map: Record<string, unknown> = {};
    for (const r of rows) {
      map[String(r.source_id)] = {
        studentId: r.id,
        studentNo: r.student_no,
        classId: r.class_id,
        className: r.class_name,
      };
    }
    res.json(ok(map, '查询成功'));
  }),
);

studentRouter.post(
  '/from-consult',
  // 内部调用（SYSTEM_USER permissions=['*']）直接过；普通用户须有建案权
  checkPermission('class:student:add'),
  validate(fromConsultSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof fromConsultSchema>;

    // ---- 幂等：同一咨询单只建一次档 ----
    const dup = await tbl(db, DB, TABLE, STAGE)
      .where({ source_system: 'consult', source_id: body.consultNo })
      .first();
    if (dup) {
      res.json(ok({ id: dup.id, studentNo: dup.student_no, duplicate: true }, '该学员已分班入档，未重复创建'));
      return;
    }

    // ---- 班级必须存在且开放 ----
    const cls = await assertClassAcceptsIntake(body.classId, false);

    // ★ 2026-10-22：学号一律按「LZ+班级编号+序号」生成，忽略接收弹窗里手填的值
    //   （用户口径：即使班主任填了也以规则为准）
    const studentNo = await generateStudentNo(cls.id);
    const id = randomUUID();
    const now = new Date();
    await tblIns(db, DB, TABLE, STAGE, {
      id,
      student_no: studentNo,
      student_name: body.studentName,
      gender: body.gender ?? 1, // 咨询侧可能没填性别，先默认，班主任可改
      age: body.age ?? null,
      dept_code: 1, // 初高部（DeptCode.JUNIOR_SENIOR）
      class_id: cls.id,
      class_name: cls.class_name,
      stage: cls.stage,
      // 接收时可选「试学中 / 预在读 / 正式在读」，没选就按原来的口径「正式在读」
      student_status: body.studentStatus ?? StudentStatus.STUDYING,
      education: body.education ?? null,
      enroll_date: body.enrollDate ?? null,
      graduate_school: body.school ?? null,
      home_address: body.address ?? null,
      phone: body.phone ?? null,
      parent_phone: body.parentPhone ?? null,
      agreement_status: 1,
      repeat_count: 0,
      remark: body.remark ?? null,
      source_system: 'consult',
      source_id: body.consultNo,
      is_deleted: false,
      create_time: now,
      create_by: 'consult-sync',
    });

    await writeOpLog({
      module: 'student',
      bizType: '咨询分班入档',
      bizId: id,
      studentId: id,
      opUserId: 'consult-sync',
      opUserName: '市场咨询',
      opDesc: `咨询分班：${body.studentName}（咨询单 ${body.consultNo}）直建入班「${cls.class_name}」`,
      afterValue: { studentNo, consultNo: body.consultNo, classId: cls.id },
    });

    res.json(ok({ id, studentNo, duplicate: false }, '已入班'));
  }),
);

/* ============================================================
 * ★ 2026-10-05 升学（基础数据操作流程）
 *   POST /api/class-jh/student/promote
 *
 * 初高在读学生「升学」→ 推送到【大学部】指定开放班级的「待接收学员」，
 * 大学部班主任「同意接收」后学生信息进入对应班级（复用既有 consult/push 通道）。
 *
 * 幂等键 = 大学部侧 consult_no（这里传初高学号）→ 重复点击只产生一条待接收记录。
 * ============================================================ */

const promoteSchema = z.object({
  id: z.string().min(1, '缺少学生ID'),
  /** 升入的大学部班级（来自 /classInfo/upgrade-targets） */
  targetClassId: z.string().min(1, '请选择要升入的大学部班级'),
  remark: z.string().max(500).optional(),
});

studentRouter.post(
  '/promote',
  checkPermission('class:student:promote'),
  validate(promoteSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof promoteSchema>;
    const user = req.user!;

    const stu = await tbl(db, DB, TABLE, STAGE).where({ id: body.id, is_deleted: false }).first();
    if (!stu) throw new BizError(BizCode.STUDENT_NOT_FOUND, '学生不存在');
    if (Number(stu.student_status) !== StudentStatus.STUDYING) {
      throw new BizError(
        BizCode.BUSINESS_RULE_VIOLATION,
        '只有「正式在读」的学生才能发起升学',
      );
    }

    const out = await classSync.consultPush([
      {
        consultNo: stu.student_no, // 幂等键：初高学号
        studentName: stu.student_name,
        gender: stu.gender ?? null,
        phone: stu.phone ?? null,
        parentPhone: stu.parent_phone ?? null,
        age: stu.age ?? null,
        graduateSchool: stu.graduate_school ?? null,
        homeAddress: stu.home_address ?? null,
        intendClassId: body.targetClassId,
        remark: body.remark || `初高升学：原班级「${stu.class_name ?? '—'}」`,
        pushTime: nowStr(),
        // ---- 来源标识：大学部「待接收学员」据此显示「初高升学」 ----
        sourceSystem: 'upgrade',
        originStudentId: stu.id,
        fromClassId: stu.class_id ?? null,
        fromClassName: stu.class_name ?? null,
      },
    ]);

    if (!out.ok) {
      throw new BizError(
        BizCode.INTERNAL_ERROR,
        `推送到大学部失败：${out.message}。请稍后重试或联系管理员。`,
      );
    }

    const inserted = Number(out.data?.inserted ?? 0);
    await writeOpLog({
      module: 'student',
      bizType: '升学',
      bizId: stu.id,
      studentId: stu.id,
      opUserId: user.userId,
      opUserName: user.userName,
      opDesc: `升学：${stu.student_name} 已推送至大学部班级（待班主任接收）`,
      afterValue: { studentNo: stu.student_no, targetClassId: body.targetClassId, inserted },
    });

    res.json(
      ok(
        { inserted, skipped: Number(out.data?.skipped ?? 0) },
        inserted > 0
          ? `「${stu.student_name}」已推送至大学部「待接收学员」，待班主任接收`
          : `「${stu.student_name}」已在大学部「待接收学员」里了（未重复推送）`,
      ),
    );
  }),
);

export default studentRouter;
