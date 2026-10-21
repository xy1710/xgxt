/**
 * 【临时】教师/员工数据源 —— 本地假数据
 *
 * ============================================================
 * ⚠️⚠️ 这个文件是【临时的】，将来要删掉或改掉！⚠️⚠️
 * ============================================================
 *
 * 【为什么要这个文件】
 *   交接班级时需要选「新班主任 / 新教员 / 新助教」，需要一份员工名单。
 *   但全系统目前【还没有教师/员工表】—— 按斌哥拍板：
 *   员工数据将来来自【权限管理模块（8006，林晓负责）】。
 *
 * 【将来怎么对接】
 *   等 8006 的员工表就绪后，把本文件的 `listTeachers()` 换成：
 *
 *     import { config } from '../config';
 *     const resp = await fetch(`${config.services.perm}/api/perm/teacher/options`);
 *     return (await resp.json()).data;
 *
 *   然后删掉下面的 MOCK_TEACHERS 常量即可。
 *   调用方（classTransfer.route.ts）不用改。
 *
 * 【现在怎么办】
 *   先返回本地假数据，让整条链路能跑通、能演示、能测。
 *   假数据里的 ID 用 `T001` 这种格式，和 t_job_class 里现有的负责人ID保持一致。
 */

import type { TeacherOption } from 'shared-types';

/**
 * 假装这是 8006 权限管理返回的员工列表
 *
 * 说明：真实场景里这些数据来自「账号管理」里角色为教师的账号。
 *      这里先写死，方便本地测试。
 */
const MOCK_TEACHERS: TeacherOption[] = [
  // ---- 班主任 ----
  { id: 'T001', name: '马志斌', role: 'head', phone: '13800000001' },
  { id: 'T002', name: '王寒逸', role: 'head', phone: '13800000002' },
  { id: 'T003', name: '李思雨', role: 'head', phone: '13800000003' },
  { id: 'T005', name: '金正豪', role: 'head', phone: '13800000005' },
  { id: 'T007', name: '周铭', role: 'head', phone: '13800000007' },
  { id: 'T008', name: '林晓', role: 'head', phone: '13800000008' },

  // ---- 教员 ----
  { id: 'T004', name: '林晓', role: 'teacher', phone: '13800000004' },
  { id: 'T009', name: '王咏菲', role: 'teacher', phone: '13800000009' },
  { id: 'T010', name: '孟令磊', role: 'teacher', phone: '13800000010' },
  { id: 'T011', name: '陈宇彤', role: 'teacher', phone: '13800000011' },
  { id: 'T012', name: '齐晋霄', role: 'teacher', phone: '13800000012' },

  // ---- 助教 ----
  { id: 'T013', name: '陈文展', role: 'assistant', phone: '13800000013' },
  { id: 'T014', name: '陈静', role: 'assistant', phone: '13800000014' },
  { id: 'T015', name: '杨洋', role: 'assistant', phone: '13800000015' },
];

/**
 * 列出教师选项
 *
 * @param role 可选，按角色过滤（head班主任 / teacher教员 / assistant助教）
 *
 * ⚠️ 将来换成调 8006 的 HTTP 接口
 */
export async function listTeachers(role?: string): Promise<TeacherOption[]> {
  // TODO【将来】换成：调用 8006 权限管理的员工接口
  // const resp = await fetch(`${config.services.perm}/api/perm/teacher/options`);
  // const json = await resp.json();
  // let list = json.data as TeacherOption[];

  let list = MOCK_TEACHERS;

  if (role) {
    list = list.filter((t) => t.role === role);
  }
  return list;
}

/**
 * 按ID查教师姓名（做快照用）
 *
 * @returns 找到返回姓名，找不到返回 null
 */
export async function findTeacherName(id: string | null | undefined): Promise<string | null> {
  if (!id) return null;
  const t = MOCK_TEACHERS.find((x) => x.id === id);
  return t ? t.name : null;
}
