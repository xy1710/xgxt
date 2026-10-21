/**
 * 统一成绩接口（第 2 期）· 前端封装
 */

import { http } from '@/api/request';
import type { TeachingStage } from './attendance';

export type { TeachingStage };

export interface ScoreRow {
  id: string;
  stage: TeachingStage;
  stageName: string;
  examId: string;
  examName: string;
  examDate: string | null;
  classId: string | null;
  className: string | null;
  studentId: string;
  studentNo: string | null;
  studentName: string | null;
  writtenScore: number | null;
  machineScore: number | null;
  interviewScore: number | null;
  otherScore: number | null;
  writtenAvg: number | null;
  totalScore: number | null;
  examResult: number | null;
  examResultName: string;
  remark: string | null;
}

export interface ScoreEntryRow {
  studentId: string;
  studentNo: string | null;
  studentName: string | null;
  scoreId: string | null;
  writtenScore: number | null;
  machineScore: number | null;
  interviewScore: number | null;
  otherScore: number | null;
  writtenAvg: number | null;
  totalScore: number | null;
  examResult: number | null;
  remark: string | null;
}

export interface ScoreEntry {
  stage: TeachingStage;
  stageName: string;
  examId: string;
  examName: string;
  examDate: string | null;
  classId: string;
  className: string;
  fullTotal: number;
  hasWrittenAvg: boolean;
  rows: ScoreEntryRow[];
}

export interface ScoreSummaryItem {
  stage: TeachingStage;
  stageName: string;
  totalStudents: number;
  enteredCount: number;
  avgTotal: number;
  passCount: number;
  failCount: number;
  passRate: number;
}

/** 成绩公式（用于展示"本学段怎么算"） */
export interface ScoreFormulaPart {
  field: string;
  weight: number;
}
export interface ScoreFormula {
  parts: ScoreFormulaPart[];
  missingAsZero: boolean;
}
export interface ScoreScopeItem {
  writtenAvg: ScoreFormula | null;
  total: ScoreFormula;
  passByRatio: boolean;
  passRatio: number;
  /** 考试结果怎么来的：auto 后端算 / manual 老师选 / action 由「标末班」动作设置 */
  judgeMode: 'auto' | 'manual' | 'action';
}

export const EXAM_RESULT_NAME: Record<number, string> = { 1: '通过', 2: '未通过' };

/** 分数项的中文名（用于公式展示） */
export const SCORE_FIELD_NAME: Record<string, string> = {
  written: '笔试',
  machine: '机试',
  interview: '面试',
  other: '其他',
  writtenAvg: '笔试均分',
};

export function listScores(p: {
  stage?: TeachingStage;
  examId?: string;
  classId?: string;
  studentId?: string;
  keyword?: string;
  page?: number;
  size?: number;
}) {
  return http.get<{ total: number; page: number; size: number; list: ScoreRow[] }>(
    '/api/teaching/score/list',
    p,
  );
}

export function fetchScoreEntry(stage: TeachingStage, examId: string, classId: string) {
  return http.get<ScoreEntry>('/api/teaching/score/entry', { stage, examId, classId });
}

export function saveScores(body: {
  stage: TeachingStage;
  examId: string;
  rows: Array<{
    studentId: string;
    writtenScore?: number | null;
    machineScore?: number | null;
    interviewScore?: number | null;
    otherScore?: number | null;
    /** 只有 judgeMode='manual' 的学段需要传 */
    examResult?: number | null;
    remark?: string | null;
  }>;
}) {
  return http.post<{ saved: number }>('/api/teaching/score/save', body);
}

export function scoreSummary(p: { stage?: TeachingStage; examId?: string; classId?: string }) {
  return http.get<ScoreSummaryItem[]>('/api/teaching/score/summary', p);
}

export function fetchScoreFormula() {
  return http.get<Record<TeachingStage, ScoreScopeItem>>('/api/teaching/score/formula');
}

/* ============================================================
 * 编辑 / 末班（2026-10-19 新增）
 * ============================================================ */

/**
 * 单行改分
 *
 * ★ 只传要改的字段：备注列是列表内联编辑的，只传 remark 时后端不会重算分数。
 */
export interface ScoreUpdatePayload {
  stage: TeachingStage;
  /** 成绩行 id */
  id: string;
  writtenScore?: number | null;
  machineScore?: number | null;
  interviewScore?: number | null;
  otherScore?: number | null;
  /** 只有大学（judgeMode='manual'）能改 */
  examResult?: number | null;
  remark?: string | null;
}

export function updateScore(body: ScoreUpdatePayload) {
  return http.post<{ updated: number }>('/api/teaching/score/update', body);
}

/** 末班入参 */
export interface ScoreRepeatPayload {
  stage: TeachingStage;
  /** 成绩行 id */
  scoreId: string;
  /** 目标班级所属学段：初高→初高、大学→大学、实训→任意 */
  targetStage: TeachingStage;
  targetClassId: string;
  /** YYYY-MM-DD */
  repeatDate?: string;
  repeatReason: string;
  /** 学员不足说明：拼进末班原因，并同步写成绩备注 */
  shortcoming?: string;
}

export interface ScoreRepeatResult {
  repeatCount: number;
  fromClassName: string | null;
  toClassName: string;
  toStageName: string;
  notified: boolean;
}

export function repeatScore(body: ScoreRepeatPayload) {
  return http.post<ScoreRepeatResult>('/api/teaching/score/repeat', body);
}

/**
 * 末班原因的下拉选项
 *
 * ★ 选「其他」时前端要展开一个输入框手填；
 *   后端只校验非空，不校验是否属于这份列表（保留历史数据的兼容空间）。
 */
export const REPEAT_REASON_OPTIONS = [
  '综合成绩未达标',
  '学习态度不端正',
  '出勤不达标',
  '基础薄弱跟不上',
  '其他',
] as const;

/** 选了「其他」时要手填的原因值 */
export const REPEAT_REASON_OTHER = '其他';
