/**
 * 统一班级信息接口（第 2 期）· 前端封装
 * ============================================================
 *
 * 一套接口服务**三个学段**，学段由 `stage` 区分（jh / class / job）。
 *
 * 【★ 三个学段字段不同，前端必须靠 meta 隐藏不适用的输入框】
 *   hasClassCode —— 只有实训有「班级编号」（另两段那两张表根本没这列）
 *   hasCloseDate —— 只有实训有「结业日期」
 *   classroomLabel —— 大学叫"教室"、实训叫"教室地点"、初高叫"教室"
 *
 * 【★ 出勤率有两种口径，不能混看】
 *   attendanceRateKind='today'（初高）→ 今日出勤率
 *   attendanceRateKind='total'（大学/实训）→ 累计出勤率
 *   列头要按 kind 动态改字，否则会误读。
 */

import { http } from '@/api/request';
import type { TeachingStage } from './attendance';

export type ClassStage = 'jh' | 'class' | 'job' | 'emp';

export type AttendanceRateKind = 'today' | 'total' | null;

export interface ClassRow {
  stage: ClassStage;
  stageName: string;
  classId: string;
  className: string;
  /** ★ 只有实训有；其它学段恒 null */
  classCode: string | null;
  deptCode: number | null;
  deptName: string;
  phaseCode: number | null;
  phaseName: string;
  /** ★ 2026-10-16：阶段方案（老班级为 null，回显退回 phaseName） */
  schemeId: string | null;
  schemeStageId: string | null;
  schemeStageName: string | null;
  headTeacherId: string | null;
  headTeacherName: string | null;
  teacherId: string | null;
  teacherName: string | null;
  assistantId: string | null;
  assistantName: string | null;
  projectManagerId: string | null;
  projectManagerName: string | null;
  employmentTeacherId: string | null;
  employmentTeacherName: string | null;
  universityNo: string | null;
  classroom: string | null;
  openDate: string | null;
  /** ★ 只有实训有 */
  closeDate: string | null;
  studentCount: number;
  classStatus: number;
  classStatusName: string;
  canChangeStatus: boolean;
  attendanceRate: number | null;
  /** ★ 这个数字是「今日」还是「累计」 */
  attendanceRateKind: AttendanceRateKind;
  remark: string | null;
  createTime: string | null;
}

export interface ClassRosterRow {
  studentId: string;
  studentNo: string | null;
  studentName: string | null;
  gender: number;
  genderName: string;
  joinType: number | null;
  joinTypeName: string;
  joinDate: string | null;
  inClassStatus: number | null;
  inClassStatusName: string;
}

export interface ClassDetail {
  base: ClassRow;
  roster: ClassRosterRow[];
  /** 当前状态下允许流转到的目标状态 */
  allowedStatus: number[];
  extra: Record<string, unknown> | null;
}

export interface ClassListParams {
  stage?: ClassStage;
  deptCode?: number;
  classStatus?: number;
  phaseCode?: number;
  keyword?: string;
  page?: number;
  size?: number;
}

export interface ClassSaveBody {
  stage: ClassStage;
  id?: string;
  className: string;
  classCode?: string | null;
  deptCode?: number | null;
  phaseCode?: number | null;
  /** ★ 2026-10-16：阶段方案（先选方案、再选阶段；不选则走老的阶段码） */
  schemeId?: string | null;
  schemeStageId?: string | null;
  schemeStageName?: string | null;
  headTeacherId?: string | null;
  headTeacherName?: string | null;
  teacherId?: string | null;
  teacherName?: string | null;
  assistantId?: string | null;
  assistantName?: string | null;
  projectManagerId?: string | null;
  projectManagerName?: string | null;
  employmentTeacherId?: string | null;
  employmentTeacherName?: string | null;
  universityNo?: string | null;
  classroom?: string | null;
  openDate?: string | null;
  closeDate?: string | null;
  classStatus?: number;
  remark?: string | null;
}

/**
 * ★ 2026-10-16 阶段方案（一个方案含多个阶段）
 *   原「阶段字典」改版后，班级/学生表单的「阶段」改成「先选方案，再选阶段」。
 */
export interface StagePlanOption {
  id: string;
  /** 方案名称，如 初高部阶段方案 */
  name: string;
  /** 所属部门 1 初高部 / 2 大学部 */
  deptCode: number;
  /** 该方案下的阶段（value = 阶段编码，label = 阶段名称） */
  phases: Array<{ value: number; label: string }>;
}

export interface ClassStageMeta {
  stage: ClassStage;
  stageName: string;
  hasClassCode: boolean;
  hasCloseDate: boolean;
  hasSealAction: boolean;
  classroomLabel: string;
  phaseOptions: Array<{ value: number; label: string }>;
  /** ★ 2026-10-16 阶段方案清单 */
  planOptions?: StagePlanOption[];
}

export interface ClassSummary {
  stage: ClassStage;
  stageName: string;
  total: number;
  openCount: number;
  closedCount: number;
  graduatingCount: number;
  graduatedCount: number;
  studentCount: number;
}

export interface ClassOption {
  stage: ClassStage;
  stageName: string;
  classId: string;
  className: string;
  classStatus: number;
  classStatusName: string;
}

/* ============================================================
 * 班级交接（2026-10-19 批注）
 *   一次交接 = 一个班 5 个岗位同时换人，提交即生效并留记录
 *   初高没有「项目经理 / 就业老师」两个岗位
 * ============================================================ */
export interface ClassHandoverRole {
  oldId: string | null;
  oldName: string | null;
  newId: string | null;
  newName: string | null;
}

export interface ClassHandoverRow {
  id: string;
  stage: ClassStage;
  stageName: string;
  classId: string;
  className: string;
  deptCode: number | null;
  headTeacher: ClassHandoverRole;
  teacher: ClassHandoverRole;
  assistant: ClassHandoverRole;
  projectManager: ClassHandoverRole;
  employmentTeacher: ClassHandoverRole;
  handoverDate: string | null;
  reason: string | null;
  operatorId: string | null;
  operatorName: string | null;
  createTime: string | null;
}

/** 只带「要换的新人」；没带的岗位视为不变 */
export interface ClassHandoverPayload {
  stage: ClassStage;
  classId: string;
  handoverDate?: string | null;
  reason?: string | null;
  headTeacherId?: string | null;
  headTeacherName?: string | null;
  teacherId?: string | null;
  teacherName?: string | null;
  assistantId?: string | null;
  assistantName?: string | null;
  projectManagerId?: string | null;
  projectManagerName?: string | null;
  employmentTeacherId?: string | null;
  employmentTeacherName?: string | null;
}

/** 某班的交接记录（详情抽屉用） */
export function listClassHandovers(stage: ClassStage, classId: string) {
  return http.get<ClassHandoverRow[]>('/api/teaching/class/handover/list', { stage, classId });
}

/** 提交交接 */
export function doClassHandover(payload: ClassHandoverPayload) {
  return http.post<ClassHandoverRow>('/api/teaching/class/handover', payload);
}

export function listClasses(params: ClassListParams) {
  return http.get<{ list: ClassRow[]; total: number; page: number; size: number }>(
    '/api/teaching/class/list',
    params,
  );
}

export function getClassDetail(stage: ClassStage, id: string) {
  return http.get<ClassDetail>('/api/teaching/class/detail', { stage, id });
}

export function getClassRoster(stage: ClassStage, id: string) {
  return http.get<ClassRosterRow[]>('/api/teaching/class/roster', { stage, id });
}

export function saveClass(body: ClassSaveBody) {
  return http.post<{ id: string }>('/api/teaching/class/save', body);
}

export function deleteClass(stage: ClassStage, id: string) {
  return http.delete<null>('/api/teaching/class/delete', { stage, id });
}

export function changeClassStatus(stage: ClassStage, id: string, classStatus: number) {
  return http.post<null>('/api/teaching/class/change-status', { stage, id, classStatus });
}

export function getClassMeta() {
  return http.get<ClassStageMeta[]>('/api/teaching/class/meta');
}

export function getClassSummary(params: ClassListParams) {
  return http.get<ClassSummary[]>('/api/teaching/class/summary', params);
}

export function getClassOptions() {
  return http.get<ClassOption[]>('/api/teaching/class/options');
}

/**
 * ★ 2026-10-16：阶段方案选项（表单「阶段方案 / 阶段」两个下拉的数据源）
 *
 * 方案统一存放在初高库、按部门区分（1 初高部 / 2 大学部）——
 * 三个学段共用这一份，前端按表单里选中的「部门」过滤；
 * 「阶段」下拉的选项 = 选中方案的 stages（阶段名称 + 学制）。
 */
export interface SchemeStageOption {
  id: string;
  stageName: string;
  studyMonths: number | null;
  sortNo: number;
}

export interface SchemeOption {
  id: string;
  schemeName: string;
  deptCode: number;
  deptName: string;
  stages: SchemeStageOption[];
}

export function getSchemeOptions() {
  return http.get<SchemeOption[]>('/api/teaching/class/scheme-options');
}

/**
 * 生成班级编号（只有实训/就业部有；其它学段返回 null）
 *
 * ★ 2026-10-22 用户口径：班级表单去掉「生成」按钮，编号改手工填写 + 必填，
 *   所以本函数**当前没有任何页面调用**（后端 /gen-code 仍在，保留给脚本/联调）。
 */
export function genClassCode(stage: ClassStage) {
  return http.get<{ classCode: string | null }>('/api/teaching/class/gen-code', { stage });
}

/* ---------------- 升实训（2026-10-20 批注：大学部 → 就业部） ---------------- */

export interface TrainingUpgradePayload {
  /** 源班级（只能是大学部班级） */
  classId: string;
  /** 新实训班的班级名称；不传 = 沿用原班名 */
  className?: string;
  /** 就业部阶段方案里的阶段编码（301/302/303…） */
  phaseCode?: number;
  projectManagerId?: string;
  projectManagerName?: string;
  employmentTeacherId?: string;
  employmentTeacherName?: string;
  remark?: string | null;
}

export interface TrainingUpgradeResult {
  targetClassId: string;
  targetClassName: string;
  classCode: string;
  moved: number;
}

/** 升实训：整班（含学生）从大学部转到就业部 */
export function upgradeClassToTraining(payload: TrainingUpgradePayload) {
  return http.post<TrainingUpgradeResult>('/api/teaching/class/training-upgrade', payload);
}

/** 班级状态（★ 三套完全一致，无需映射） */
export const CLASS_STATUS_NAME: Record<number, string> = {
  1: '开放',
  2: '封班',
  3: '待结业',
  4: '已结业',
};

/**
 * 可供选择的班级状态
 *   2026-10-19 批注：「待结业」删除（筛选下拉、编辑班级的状态下拉、统计卡片都不再出现）。
 *   CLASS_STATUS_NAME 里仍保留 3 的中文名 —— 历史数据万一是 3，标签还能正常显示。
 */
export const CLASS_STATUS_SELECTABLE = [
  { value: 1, label: '开放' },
  { value: 2, label: '封班' },
  { value: 4, label: '已结业' },
];

/**
 * 编辑班级时「班级状态」可选项：当前状态 + 允许流转到的状态（与后端同一张表）
 *   1 开放 → 1/2；2 封班 → 2/1/4；4 已结业 → 终态（只读）
 *   （3 待结业 只为兼容历史数据保留 3→4，不作为任何状态的下一跳）
 */
export function classStatusOptions(cur: number | null | undefined): Array<{ value: number; label: string }> {
  const map: Record<number, number[]> = {
    1: [1, 2],
    2: [2, 1, 4],
    3: [3, 4],
    4: [4],
  };
  const list = map[Number(cur) || 1] || [Number(cur) || 1];
  return list.map((v) => ({ value: v, label: CLASS_STATUS_NAME[v] }));
}

/** 状态 → Element Plus tag 类型 */
export const CLASS_STATUS_TAG: Record<number, string> = {
  1: 'success',
  2: 'info',
  3: 'warning',
  4: 'danger',
};

// ★ 2026-10-22 部门口径统一：对外只有「初高中 / 大学部 / 就业部」三个部门。
//   「实训」是就业部下的一个阶段（班级 dept_code=3），不是并列部门。
export const CLASS_STAGE_NAME: Record<ClassStage, string> = {
  jh: '初高部',
  class: '大学部',
  job: '就业部',
  emp: '就业部',
};

export const CLASS_STAGES: ClassStage[] = ['jh', 'class', 'job', 'emp'];

export const DEPT_OPTIONS = [
  { value: 1, label: '初高部' },
  { value: 2, label: '大学部' },
  // ★ 2026-10-19 批注：新增就业部（独立学段，班级/学生共用 sms_job）
  { value: 3, label: '就业部' },
];

/* ============================================================
 * 学生换班（末班 / 升班）· 成绩管理行操作用
 *   末班：成绩不达标 → 转到进度相同或更慢的班重修
 *   升班：成绩达标   → 跳到进度更快的班
 *   进度 = 班级阶段码 stage_code
 * ============================================================ */

export interface TransferTarget {
  id: string;
  name: string;
  stageCode: number | null;
  headTeacherName: string | null;
}

export function listTransferTargets(p: {
  stage: TeachingStage;
  fromClassId: string;
  mode: 'repeat' | 'promote';
}) {
  return http.get<TransferTarget[]>('/api/teaching/class-transfer/targets', p);
}

export function transferStudentToClass(body: {
  stage: TeachingStage;
  studentId: string;
  fromClassId: string;
  toClassId: string;
  mode: 'repeat' | 'promote';
  reason?: string | null;
  examId?: string | null;
}) {
  return http.post<{ ok: true; toClassName: string }>('/api/teaching/class-transfer/do', body);
}
