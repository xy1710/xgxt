/**
 * 统一考试接口（第 2 期）· 前端封装
 * 一套接口服务三个学段，学段由 stage 区分。
 */

import { http } from '@/api/request';
import type { ClassOption, TeachingStage } from './attendance';

export type { ClassOption, TeachingStage };

export interface ExamRow {
  id: string;
  stage: TeachingStage;
  stageName: string;
  examName: string;
  examType: number;
  examTypeName: string;
  examDate: string;
  classIds: string[];
  classNames: string;
  contentTypes: number[];
  contentNames: string;
  /** 自定义类型名称（exam_type=5「其他」时） */
  examTypeCustom?: string | null;
  status: number;
  statusName: string;
  creatorName: string | null;
  remark: string | null;
}

export interface ExamContentItem {
  type: number;
  name: string;
  fullScore: number | null;
}

export interface ExamCustomField {
  name: string;
  type: string;
  sortNo: number;
}

export interface ExamDetail {
  record: ExamRow;
  contents: ExamContentItem[];
  fields: ExamCustomField[];
}

export interface ExamListParams {
  stage?: TeachingStage;
  classId?: string;
  examType?: number;
  startDate?: string;
  endDate?: string;
  keyword?: string;
  page?: number;
  size?: number;
}

export interface ExamSaveBody {
  stage: TeachingStage;
  id?: string;
  examName: string;
  examType: number;
  /** exam_type=5 时的自定义类型名称 */
  examTypeName?: string | null;
  examDate: string;
  classIds: string[];
  contents?: Array<{ type: number; name?: string; fullScore?: number | null }>;
  remark?: string | null;
}

/** 考试类型（三套枚举一致） */
export const EXAM_TYPE_NAME: Record<number, string> = {
  1: '月考',
  2: '质素考核',
  3: '阶段考核',
  4: '结业考试',
  5: '其他',
};

/** 考试内容项（三套枚举一致） */
export const EXAM_CONTENT_TYPE_NAME: Record<number, string> = {
  1: '笔试',
  2: '机试',
  3: '面试',
  4: '其他',
};

export const EXAM_STATUS_NAME: Record<number, string> = { 1: '草稿', 2: '已提交' };

export function listExams(p: ExamListParams) {
  return http.get<{ total: number; page: number; size: number; list: ExamRow[] }>(
    '/api/teaching/exam/list',
    p,
  );
}

export function getExamDetail(stage: TeachingStage, id: string) {
  return http.get<ExamDetail>('/api/teaching/exam/detail', { stage, id });
}

export function saveExam(body: ExamSaveBody) {
  return http.post<{ id: string }>('/api/teaching/exam/save', body);
}

export function deleteExam(stage: TeachingStage, id: string) {
  return http.delete<null>('/api/teaching/exam/delete', { stage, id });
}

export function fetchExamClassOptions() {
  return http.get<ClassOption[]>('/api/teaching/exam/classes');
}
