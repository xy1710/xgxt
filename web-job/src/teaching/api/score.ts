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
  /** 各分数项的本场满分（written/machine/interview/other） */
  contentFullScore?: Record<string, number>;
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

/**
 * ★ 2026-10-19：成绩页的考试下拉（只读）
 *
 * 为什么不再调 `/api/teaching/exam/list`：
 *   大学部班主任只有成绩码 `class:grade:view`，没有考试码 `class:exam:view`，
 *   调考试域接口会被 403 →「点成绩管理就弹无权限」。
 *   这个接口用成绩域的权限码判权，只返回考试列表。
 */
export function listScoreExamOptions(p: { stage?: TeachingStage; keyword?: string } = {}) {
  return http.get<import('./exam').ExamRow[]>('/api/teaching/score/exam-options', p);
}

/**
 * 成绩录入用的「班级下拉」
 *
 * 为什么不用 `/api/teaching/exam/classes`：那个接口按考试域权限码判权，
 * 班主任只有 class:grade:view、没有 class:exam:view → 拿到 0 个班。
 */
export function listScoreClasses() {
  return http.get<import('./attendance').ClassOption[]>('/api/teaching/score/classes');
}

