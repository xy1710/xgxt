/**
 * 试学闭环接口（班主任视角）
 * ============================================================
 *
 * 用户口径（2026-10-20）：
 *   交试学费 → 分配班级 → 试学中
 *     ├─ 试学有问题 → 退学（走休退学审批链：班主任发起 → 学管 → 校长）
 *     └─ 试学通过   → 班主任发起补费 → 补缴到账 → 正式在读
 *
 * ⚠️ 补费不在这里建收费单：本系统「缴费必须有凭证」，
 *   班主任只是「发起」，真正收款由咨询老师上传截图、财务核对到账。
 *   到账后咨询侧自动转正式，并把学籍同步为「正式在读」。
 *
 * 这两个接口只对【大学学段（stage=class）】的试学中学生有效，
 * 学生 ID 传的是班级侧学籍 ID（t_class_student.id）。
 */

import { http } from '@/api/request';

/** 补费预览（转正式弹窗前拉一次） */
export interface TrialPlan {
  studentId: string;
  studentNo: string;
  studentName: string;
  className: string | null;
  consultState: number;
  consultStateName: string;
  /** 全款应缴合计（分） */
  totalAmount: number;
  /** 已到账（分） */
  arrivedAmount: number;
  /** 还差（分） */
  missingAmount: number;
  /** 还差哪几项（中文） */
  missingTypeNames: string[];
  /** 在途金额（已发起、等财务确认，分） */
  inFlightAmount?: number;
  allArrived: boolean;
}

/** 补费预览 */
export function fetchTrialPlan(studentId: string) {
  return http.get<TrialPlan>('/api/class/student/trial-plan', { studentId });
}

/** 班主任发起补费（试学 → 待缴全款） */
export function trialSupplement(studentId: string) {
  return http.post<{
    studentId: string;
    consultNo: string;
    studentName?: string;
    missingAmount?: number;
    duplicate?: boolean;
    consultStateName?: string;
  }>('/api/class/student/trial-supplement', { studentId });
}

/** 试学中退学：提交退学申请（走 学管 → 校长 审批） */
export function trialQuit(payload: {
  studentId: string;
  applyReason: string;
  effectDate?: string | null;
}) {
  return http.post<{ applyId: string; applyNo: string; applyStatus: number }>('/api/class/suspend/add', {
    applyType: 2, // 2 = 退学
    studentId: payload.studentId,
    applyReason: payload.applyReason,
    effectDate: payload.effectDate || null,
  });
}
