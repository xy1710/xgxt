/**
 * 统一出勤接口（第 2 期）· 前端封装
 *
 * 一套接口服务三个学段，学段由 `stage` 参数区分（jh 初高 / class 大学 / job 实训）。
 * 后端已经把所有学段的差异翻译成这里的统一结构，前端**不认识**任何学段的原始字段与状态码。
 */

import { http } from '@/api/request';

export type TeachingStage = 'jh' | 'class' | 'job';

/** 列表行 */
export interface AttendanceRow {
  id: string;
  stage: TeachingStage;
  stageName: string;
  classId: string;
  className: string;
  attendanceDate: string;
  shouldCount: number;
  actualCount: number;
  absentCount: number;
  attendanceRate: number;
  teacherName: string | null;
  headTeacherName: string | null;
  fileUrl: string | null;
  remark: string | null;
}

/** 明细行 */
export interface AttendanceDetailRow {
  studentId: string;
  studentNo: string | null;
  studentName: string | null;
  /** ★ 统一码 1出勤 2缺勤 3迟到 4早退 5请假 6事假 7病假 */
  status: number;
  statusName: string;
  reason: string | null;
  phone: string | null;
}

export interface AttendanceDetail {
  record: AttendanceRow;
  details: AttendanceDetailRow[];
}

/** 录入登记板的一行（按人） */
export interface AttendanceBoardRow {
  studentId: string;
  studentNo: string | null;
  studentName: string | null;
  /** 统一码；null = 当天还没登记 */
  status: number | null;
  reason: string | null;
  registered: boolean;
}

export interface AttendanceBoard {
  stage: TeachingStage;
  stageName: string;
  classId: string;
  className: string;
  attendanceDate: string;
  shouldCount: number;
  rows: AttendanceBoardRow[];
}

export interface ClassOption {
  stage: TeachingStage;
  stageName: string;
  id: string;
  name: string;
}

export interface AttendanceSummaryItem {
  stage: TeachingStage;
  stageName: string;
  totalRecords: number;
  avgRate: number;
  classCount: number;
  unqualifiedCount: number;
  targetRate: number;
}

export interface ListParams {
  stage?: TeachingStage;
  classId?: string;
  startDate?: string;
  endDate?: string;
  page?: number;
  size?: number;
}

export interface SaveBody {
  stage: TeachingStage;
  classId: string;
  attendanceDate: string;
  /** 大学专用：老师手填人数 */
  shouldCount?: number;
  actualCount?: number;
  /** 初高 / 实训：按人提交 */
  rows?: Array<{ studentId: string; status: number; reason?: string | null }>;
  fileUrl?: string | null;
  remark?: string | null;
}

/** 出勤状态统一码 → 中文（与后端 dto.ts 保持一致） */
export const UNIFIED_STATUS_NAME: Record<number, string> = {
  1: '出勤',
  2: '缺勤',
  3: '迟到',
  4: '早退',
  5: '请假',
  6: '事假',
  7: '病假',
};

export const STAGE_NAME: Record<TeachingStage, string> = {
  jh: '初高部',
  class: '大学部',
  job: '实训',
};

export function listAttendance(p: ListParams) {
  return http.get<{ total: number; page: number; size: number; list: AttendanceRow[] }>(
    '/api/teaching/attendance/list',
    p,
  );
}

export function getAttendanceDetail(stage: TeachingStage, id: string) {
  return http.get<AttendanceDetail>('/api/teaching/attendance/detail', { stage, id });
}

/** 录入登记板：某班某天的在班名单 + 已登记状态 */
export function fetchAttendanceBoard(stage: TeachingStage, classId: string, attendanceDate: string) {
  return http.get<AttendanceBoard>('/api/teaching/attendance/board', {
    stage,
    classId,
    attendanceDate,
  });
}

export function saveAttendance(body: SaveBody) {
  return http.post<{ id: string; shouldCount: number; actualCount: number; attendanceRate: number }>(
    '/api/teaching/attendance/save',
    body,
  );
}

export function attendanceSummary(p: Omit<ListParams, 'page' | 'size'>) {
  return http.get<AttendanceSummaryItem[]>('/api/teaching/attendance/summary', p);
}

export function fetchClassOptions() {
  return http.get<ClassOption[]>('/api/teaching/attendance/classes');
}

export function exportAttendance(p: Omit<ListParams, 'page' | 'size'>) {
  return http.get<AttendanceRow[]>('/api/teaching/attendance/export', p);
}
