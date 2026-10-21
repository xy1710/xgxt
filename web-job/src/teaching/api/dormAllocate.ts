/**
 * 班级宿舍分派接口（宿舍管理 → 班级分派）
 * ============================================================
 *
 * 数据源：教务宿舍表（sms_edu.*），与「教务宿舍管理 → 分派宿舍」同一份数据。
 * 权限：与 /api/teaching/dorm/* 一致（教务老师的 classjh:dorm:view 即可）。
 */

import { http } from '@/api/request';

export interface AllocateRoomRef {
  roomId: string;
  building: string;
  room: string;
  category: number;
  capacity: number;
}

export interface AllocateClassRow {
  className: string;
  headTeacherName: string | null;
  maleCount: number;
  femaleCount: number;
  /** 已分派 / 待分派 */
  status: string;
  maleRooms: AllocateRoomRef[];
  femaleRooms: AllocateRoomRef[];
  maleBeds: number;
  femaleBeds: number;
}

export interface AllocateBedRef {
  bedId: string;
  bedNo: string;
  bedLabel: string;
}

export interface AllocateRoomRow {
  roomId: string;
  building: string;
  room: string;
  category: number;
  capacity: number;
  occupied: number;
  remaining: number;
  full: boolean;
  assignedTo: string | null;
  /** ★ 空闲床位明细（调宿时选到具体床位） */
  freeBeds: AllocateBedRef[];
}

/** 学生搜索结果（调宿 / 退宿弹窗） */
export interface AllocateStudentRow {
  studentId: string;
  studentNo: string;
  studentName: string;
  gender: number;
  genderName: string;
  classId: string | null;
  className: string | null;
  headTeacherName: string | null;
  dormId: string | null;
  dormNo: string | null;
  building: string | null;
  room: string | null;
  bedId: string | null;
  bedNo: string | null;
  bedLabel: string | null;
}

/** 班级列表 */
export function listAllocateClasses(keyword?: string): Promise<AllocateClassRow[]> {
  return http.get<AllocateClassRow[]>('/api/teaching/dorm/allocate/classes', { keyword });
}

/** 楼栋下拉（按类别：1 男寝 / 2 女寝） */
export function listAllocateBuildings(category: number): Promise<string[]> {
  return http.get<string[]>('/api/teaching/dorm/allocate/buildings', { category });
}

/** 某楼栋下的宿舍（不传楼栋 = 该类别全部；含空闲床位明细） */
export function listAllocateRooms(category: number, building?: string): Promise<AllocateRoomRow[]> {
  return http.get<AllocateRoomRow[]>('/api/teaching/dorm/allocate/rooms', { category, building });
}

/** 学生搜索：按班级联动 + 姓名/学号前后模糊 */
export function searchAllocateStudents(params: {
  className?: string;
  keyword?: string;
  limit?: number;
}): Promise<AllocateStudentRow[]> {
  return http.get<AllocateStudentRow[]>('/api/teaching/dorm/allocate/students', params);
}

/** 保存某个班的男寝 / 女寝分派（覆盖式） */
export function saveAllocate(payload: {
  className: string;
  headTeacherName?: string | null;
  maleRoomIds: string[];
  femaleRoomIds: string[];
}): Promise<{ male: number; female: number }> {
  return http.post<{ male: number; female: number }>('/api/teaching/dorm/allocate/save', payload);
}
