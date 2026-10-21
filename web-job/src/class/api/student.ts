import { del, get, post, put } from './request';
import type { ClassRow, PageData, StudentDetail, StudentRow } from './types';

/** 学生信息（页面：班级信息管理） */

export interface StudentQuery {
  page?: number;
  size?: number;
  keyword?: string;
  studentNo?: string;
  studentName?: string;
  classId?: string;
  deptCode?: number;
  studentStatus?: number;
  /** 学习阶段 */
  stage?: number;
  /** 排序（白名单字段），配合 sortOrder 使用 */
  sortBy?: 'studentNo' | 'studentName' | 'className' | 'age' | 'enrollDate' | 'studentStatus' | 'repeatCount' | 'stage';
  sortOrder?: 'asc' | 'desc';
}

export function studentList(params: StudentQuery) {
  return get<PageData<StudentRow>>('/api/class/student/list', params as Record<string, unknown>);
}

export function studentDetail(id: string) {
  return get<StudentDetail>('/api/class/student/detail', { id });
}

/** 顶部统计卡片：口径与列表完全一致（同一个 where + 同一个数据范围） */
export interface StudentStatistics {
  total: number;
  studying: number;
  trial: number;
  suspended: number;
  quit: number;
  repeatTotal: number;
  repeatMax: number;
  dueCount: number;
  /** 单位分 */
  dueAmount: number;
  dueAmountYuan: string;
}

export function studentStatistics(params: Omit<StudentQuery, 'page' | 'size'> = {}) {
  return get<StudentStatistics>('/api/class/student/statistics', params as Record<string, unknown>);
}

export interface StudentAddPayload {
  studentName: string;
  studentNo?: string;
  gender: number;
  deptCode: number;
  age?: number | null;
  classId?: string | null;
  stage?: number | null;
  phone?: string | null;
  parentPhone?: string | null;
  education?: string | null;
  enrollDate?: string | null;
  idCard?: string | null;
  studentStatus?: number | null;
  dormId?: string | null;
  dormNo?: string | null;
  bedNo?: number | null;
  profile?: Record<string, unknown>;
}

export function studentAdd(payload: StudentAddPayload) {
  return post<{ studentId: string; studentNo: string }>('/api/class/student/add', payload);
}

export interface StudentUpdatePayload {
  studentId: string;
  classId?: string | null;
  stage?: number | null;
  education?: string | null;
  enrollDate?: string | null;
  idCard?: string | null;
  phone?: string | null;
  parentPhone?: string | null;
  age?: number | null;
  studentStatus?: number | null;
  repeatCount?: number | null;
  remark?: string | null;
  dormId?: string | null;
  dormNo?: string | null;
  bedNo?: number | null;
  profile?: Record<string, unknown>;
  quality?: Record<string, unknown>;
}

export function studentUpdate(payload: StudentUpdatePayload) {
  return put<{ studentId: string }>('/api/class/student/update', payload);
}

/**
 * 换班（需求 v1.5）：班级信息管理「功能 → 换班」→ 目标班主任「待接收学员」。
 * 发起后学生信息以「换班转入」单进入目标班级班主任的待接收列表；
 * 目标班主任「接收」后，学生档案班级归属才真正切到新班并留痕换班记录。
 */
export function studentTransfer(payload: { studentId: string; targetClassId: string; reason?: string | null }) {
  return post<{ consultId: string; consultNo: string }>('/api/class/student/transfer', payload);
}

/** 班级列表（新增 / 修改学生时选班级用） */
export function classOptions(params: { page?: number; size?: number; keyword?: string } = {}) {
  return get<PageData<ClassRow>>('/api/class/info/list', { page: 1, size: 200, ...params } as Record<string, unknown>);
}

/* ---------------- 班级管理（班级档案） ---------------- */

export interface ClassAddPayload {
  className: string;
  deptCode: number;
  stage?: number | null;
  headTeacherId?: string | null;
  headTeacherName?: string | null;
  teacherId?: string | null;
  teacherName?: string | null;
  assistantId?: string | null;
  assistantName?: string | null;
  // ★ 2026-10-04：项目经理 / 就业指导老师（建班 5 岗位）
  projectManagerId?: string | null;
  projectManagerName?: string | null;
  employmentTeacherId?: string | null;
  employmentTeacherName?: string | null;
  /** 统一班级号（Q+数字）；不给就按班级名自动推 */
  universityNo?: string | null;
  room?: string | null;
  openDate?: string | null;
  classStatus?: number | null;
}

export function classAdd(payload: ClassAddPayload) {
  return post<{ classId: string }>('/api/class/info/add', payload);
}

/** 班级详情：返回 { classInfo, students, transfers } 三块（不是扁平对象） */
export interface ClassDetail {
  classInfo: ClassRow;
  students: Array<{ id: string; studentNo: string; studentName: string; gender: number; studentStatus: number }>;
  transfers: Array<Record<string, unknown>>;
}

export function classDetail(id: string) {
  return get<ClassDetail>('/api/class/info/detail', { id });
}

export function classUpdate(payload: ClassAddPayload & { classId: string }) {
  return put<{ classId: string }>('/api/class/info/update', payload);
}

/** 调班记录 / 末班记录（都在班级模块下，注意路径前缀是 /api/class/info） */
export function repeatList(params: { page?: number; size?: number; studentId?: string }) {
  return get<PageData<Record<string, unknown>>>('/api/class/info/repeat/list', params as Record<string, unknown>);
}

export function repeatAdd(payload: Record<string, unknown>) {
  return post<{ repeatId: string }>('/api/class/info/repeat/add', payload);
}

export function transferAdd(payload: Record<string, unknown>) {
  return post<{ transferId: string }>('/api/class/info/transfer/add', payload);
}

/* ---------------- 出勤 / 成绩 / 考试 ---------------- */

export function attendanceList(params: {
  page?: number;
  size?: number;
  classId?: string;
  startDate?: string;
  endDate?: string;
}) {
  return get<PageData<import('./types').AttendanceRow>>('/api/class/attendance/list', params as Record<string, unknown>);
}

export function attendanceDetail(id: string) {
  return get<{ record: import('./types').AttendanceRow; absents: import('./types').AbsentRow[] }>(
    '/api/class/attendance/detail',
    { id },
  );
}

/**
 * 录入 / 覆盖考勤
 *
 * 缺勤人数与出勤率由后端算（见接口说明），前端**不要**传 absentCount / attendanceRate：
 * 传了也会被忽略，反而容易和真实值不一致。同班同天重复提交是覆盖语义。
 */
export function attendanceAdd(payload: {
  classId: string;
  attendanceDate?: string;
  shouldCount: number;
  presentCount: number;
  teacherName?: string | null;
  absents: Array<{ studentId: string; absentReason: string }>;
}) {
  return post<{ classId: string; attendanceDate: string; absentCount: number; attendanceRate: number }>(
    '/api/class/attendance/add',
    payload,
  );
}

export function absentList(params: { page?: number; size?: number; classId?: string; startDate?: string; endDate?: string }) {
  return get<PageData<import('./types').AbsentRow>>('/api/class/attendance/absent/list', params as Record<string, unknown>);
}

export function gradeList(params: {
  page?: number;
  size?: number;
  examId?: string;
  classId?: string;
  studentId?: string;
  examResult?: number;
  keyword?: string;
}) {
  return get<PageData<import('./types').GradeRow>>('/api/class/grade/list', params as Record<string, unknown>);
}

export interface GradeStatistics {
  total: number;
  passCount: number;
  failCount: number;
  passRate: number;
  avgCompScore: number;
  maxCompScore: number;
  minCompScore: number;
}

export function gradeStatistics(params: { examId?: string; classId?: string } = {}) {
  return get<GradeStatistics>('/api/class/grade/statistics', params as Record<string, unknown>);
}

export function gradeStudentList(studentId: string, limit = 10) {
  return get<Array<import('./types').GradeRow>>('/api/class/grade/student/list', { studentId, limit });
}

/**
 * 录入成绩
 *
 * **不要传 compScore**：综合成绩 = 笔试 × 50% + 面试 × 50%，由后端统一算，
 * 前端自己算一份迟早会跟后端算的对不上。
 */
export function gradeAdd(payload: {
  studentId: string;
  examId?: string | null;
  writtenScore?: number | null;
  machineScore?: number | null;
  interviewScore?: number | null;
  examResult: number;
  analysis?: string | null;
  remark?: string | null;
}) {
  return post<{ gradeId: string; compScore: number }>('/api/class/grade/add', payload);
}

export function gradeUpdate(payload: {
  gradeId: string;
  writtenScore?: number | null;
  machineScore?: number | null;
  interviewScore?: number | null;
  examResult?: number;
  analysis?: string | null;
  remark?: string | null;
}) {
  return put<{ gradeId: string; compScore: number }>('/api/class/grade/update', payload);
}

/** 删除一条成绩记录（软删，原型「操作 → 删除」） */
export function gradeDelete(gradeId: string) {
  return post<{ gradeId: string }>('/api/class/grade/delete', { gradeId });
}

/**
 * 成绩管理「末班」：把学员推送到目标班级班主任的「待接收学员」
 *
 * 点击后需选择学员去到的目标班级（targetClassId），班主任在「待接收学员」
 * 接收 / 同意后，该学员回到目标班级重修（封班班级也可接收）。返回接收单号。
 */
export function gradeRepeatHandoff(payload: { studentId: string; targetClassId?: string | null; remark?: string | null }) {
  return post<{ consultId: string; consultNo: string }>('/api/class/grade/repeat-handoff', payload);
}

/**
 * 表格批量导入成绩（需求 v1.5）：考试管理 / 成绩管理录入成绩可直接上传表格。
 * 前端把 Excel / CSV 解析成 items 数组后一次性提交；综合成绩由后端重算。
 * 返回 inserted / updated / failed 与失败明细。
 */
export function gradeImport(payload: {
  examId?: string | null;
  items: Array<{
    studentNo: string;
    studentName?: string | null;
    writtenScore?: number | null;
    machineScore?: number | null;
    interviewScore?: number | null;
    examResult?: number | null;
    analysis?: string | null;
    remark?: string | null;
  }>;
}) {
  return post<{ inserted: number; updated: number; failed: number; errors: Array<{ studentNo: string; reason: string }> }>(
    '/api/class/grade/import',
    payload,
  );
}

export function examList(params: {
  page?: number;
  size?: number;
  classId?: string;
  examType?: number;
  startDate?: string;
  endDate?: string;
  keyword?: string;
} = {}) {
  return get<PageData<import('./types').ExamRow>>('/api/class/exam/list', params as Record<string, unknown>);
}

export function examDetail(id: string) {
  return get<import('./types').ExamDetail>('/api/class/exam/detail', { id });
}

export interface ExamContentPayload {
  examContentType: number;
  fullScore: number;
  contentName?: string | null;
}

export function examAdd(payload: {
  examName: string;
  examType: number;
  examDate?: string;
  classId?: string | null;
  attendeeCount?: number | null;
  contents: ExamContentPayload[];
}) {
  return post<{ examId: string }>('/api/class/exam/add', payload);
}

export function examFieldList() {
  return get<Array<import('./types').ExamFieldRow>>('/api/class/exam/field/list');
}

/* ---------------- 催费 / 缴费 ---------------- */

export function urgeList(params: {
  page?: number;
  size?: number;
  classId?: string;
  feeType?: number;
  payStatus?: number;
  onlyOverdue?: boolean;
  startDate?: string;
  endDate?: string;
  keyword?: string;
}) {
  return get<PageData<import('./types').UrgeRow>>('/api/class/urge/list', params as Record<string, unknown>);
}

export function urgeLogList(params: { page?: number; size?: number; studentId?: string }) {
  return get<PageData<import('./types').UrgeLogRow>>('/api/class/urge/log/list', params as Record<string, unknown>);
}

export function urgeDo(payload: { urgeId: string; channel: string; remark?: string }) {
  return post<{ urgeId: string; urgeCount: number }>('/api/class/urge/do', payload);
}

/**
 * 登记缴费（上传缴费凭证）· 大学部
 *
 * ★ 2026-10-21 用户要求：催费页里大学要和初高功能对齐 ——
 *   初高的行能登记缴费（缴费方式 / 实缴金额 / 缴费日期 / 备注 / 截图），
 *   大学催缴副本原来没有这个能力（操作列只能显示「—」）。
 *
 * 落库位置：`sms_common.t_class_urge_sync`（只写本模块副本，**不回写财务** ——
 * 这张表本身就是财务推来的只读副本，反写会和财务核对流程打架）。
 * 状态：未结清（待缴 1 / 逾期 4）→ 已缴 2；已缴 / 已核对保持原状。
 */
export function submitUrgePayment(payload: {
  /** 催缴记录 id（页面行里的 feeId 带 `urge:` 前缀，调用前剥掉） */
  urgeId: string;
  /** 缴费方式 1微信支付 2支付宝 3现金 */
  payMethod: number;
  /** 实缴金额（分），允许与应缴不同 */
  paidAmount: number;
  /** 缴费日期 YYYY-MM-DD（不能晚于今天） */
  payDate: string;
  remark?: string;
  /** 缴费截图 dataURL；现金可不传 */
  dataUrl?: string;
}) {
  return post<{
    urgeId: string;
    voucherUrl: string | null;
    payStatus: number;
    payMethodName: string;
  }>('/api/class/urge/voucher', payload);
}

export function feeList(params: {
  page?: number;
  size?: number;
  studentId?: string;
  feeType?: number;
  payStatus?: number;
  keyword?: string;
}) {
  return get<PageData<import('./types').FeeRow>>('/api/class/fee/list', params as Record<string, unknown>);
}

export function feeSummary(studentId: string) {
  return get<Record<string, unknown>>('/api/class/fee/summary', { studentId });
}

/* ---------------- 宿舍 ---------------- */

export function dormRoomList(params: { page?: number; size?: number; onlyAvailable?: boolean; keyword?: string } = {}) {
  return get<PageData<import('./types').DormRoomRow>>('/api/class/dorm/room/list', params as Record<string, unknown>);
}

/** 新建宿舍分配（原型「＋ 新建宿舍分配」） */
export function dormRoomAdd(payload: {
  buildingName?: string | null;
  dormNo: string;
  bedCount: number;
  dormType?: number | null;
  leaderStudentId?: string | null;
  leaderStudentName?: string | null;
}) {
  return post<{ dormId: string; dormNo: string; bedCount: number }>('/api/class/dorm/room/add', payload);
}

/** 编辑宿舍（楼栋 / 类型 / 床位总数；宿舍号是同步主键，不在这里改） */
export function dormRoomUpdate(payload: {
  dormId: string;
  buildingName?: string | null;
  dormType?: number | null;
  bedCount?: number;
}) {
  return post<{ dormId: string }>('/api/class/dorm/room/update', payload);
}

export function dormLiveList(params: {
  page?: number;
  size?: number;
  dormId?: string;
  studentId?: string;
  classId?: string;
  keyword?: string;
} = {}) {
  return get<PageData<import('./types').DormLiveRow>>('/api/class/dorm/live/list', params as Record<string, unknown>);
}

export function dormChangeList(params: { page?: number; size?: number; studentId?: string } = {}) {
  return get<PageData<import('./types').DormChangeRow>>('/api/class/dorm/change/list', params as Record<string, unknown>);
}

export function dormApplyList(params: { page?: number; size?: number } = {}) {
  return get<PageData<import('./types').DormApplyRow>>('/api/class/dorm/apply/list', params as Record<string, unknown>);
}

export function dormApplyAdd(payload: {
  applyCategory: number;
  studentId: string;
  fromDormId?: string | null;
  toDormId?: string | null;
  toDormNo?: string | null;
  applyReason: string;
}) {
  return post<{ applyId: string; applyNo: string }>('/api/class/dorm/apply/add', payload);
}

/**
 * 宿舍申请审批结果落地
 *
 * 审批通过前必须确认「宿舍物品完好」（`hasGoodsChecked = true`），
 * 否则后端会拒绝 —— 这是原型里明确写的规则，不是可选项。
 */
export function dormApplyApprove(payload: {
  applyId: string;
  action: 'approve' | 'reject';
  opinion?: string | null;
  hasGoodsChecked?: boolean;
}) {
  return post<{ applyId: string; applyStatus: number }>('/api/class/dorm/apply/approve', payload);
}

/** 部门字典（v1.3 只有大学部）——新增学生、建班时要选 */
export const DEPT_OPTIONS = [
  { label: '大学部', value: 2 },
];

/** 删除（逻辑删除）——目前仅末班记录等子表提供，学生不允许删除 */
export function removeRecord(url: string, id: string) {
  return del<{ id: string }>(url, { id });
}
