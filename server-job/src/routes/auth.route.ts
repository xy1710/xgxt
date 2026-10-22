/**
 * 权限相关路由（就业管理 > 实训阶段）
 *
 * 接口前缀：/api/job/auth
 *
 * 【职责】
 *   1. 告诉前端「当前用户能看哪些页面」→ 前端过滤菜单、拦路由
 *   2. 提供页面权限清单 → 权限管理模块（8006）配置界面用
 *
 * 【与 8006 的关系】
 *   本模块是权限的【消费方】。
 *   权威权限配置存在 8006（权限管理模块，林晓负责）。
 *   现在 8006 未就绪，用本地假数据（utils/pagePermissionSource.ts）。
 *   将来只改数据源，本路由与前端不用动。
 */

import { Router } from 'express';
import { wrap } from '../utils/wrap';
import { ok } from '../utils/response';
import { db } from '../utils/db';
import { getMyPages } from '../middleware/pagePermission';
import { PAGE_PERMISSIONS } from '../config/pagePermissions';
// ★ P3 切读层：本文件跨库读「大学班 t_class_info」与「实训班 t_job_class」，
//   两表均已归一 → t_uni_class；开关关时跨库表仍带库名前缀，与原实现逐字节等价。
import { tbl } from '../teaching/shared/uniTable';

export const authRouter = Router();

/**
 * 取「当前用户能访问的页面」
 * GET /api/job/auth/my-pages
 *
 * 前端在 App 启动时调一次，然后：
 *   - 过滤左侧菜单
 *   - 路由守卫拦截
 */
authRouter.get('/my-pages', wrap(getMyPages));

/**
 * 页面权限清单（全部）
 * GET /api/job/auth/page-permissions
 *
 * 用途：给权限管理（8006）的配置界面读，知道本模块有哪些页面权限可配。
 *      普通用户也可以读（只是清单，不含敏感信息）。
 */
authRouter.get(
  '/page-permissions',
  wrap(async (_req, res) => {
    res.json({
      code: 200,
      message: '操作成功',
      data: PAGE_PERMISSIONS,
    });
  }),
);

/**
 * 演示身份清单
 * GET /api/job/auth/demo-identities
 *
 * ★ 2026-09-30 新增
 *
 * 【为什么需要】
 *   「选择角色」进的是**角色级假身份**（userId = `U_ROLE_HEAD_TEACHER`），
 *   而班级表里的班主任是**真人 ID**（如 `T007` 周铭）。
 *   凡是"按本人过滤"的逻辑（我带的班 / 我发起的催费），两头对不上就查成空 ——
 *   演示时打开页面一看一个学生都没有，一脸懵。
 *
 *   所以这里把「数据里实际存在的班主任 / 教员 / 助教」列出来，
 *   前端选角色时可以再选一次「以谁的身份进入」
 *   （token 写成 `test-ROLE_HEAD_TEACHER@T007`）。
 *
 * ⚠️ 数据源是班级表（`t_job_class`）—— 因为目前"谁是班主任"只有这里记着。
 *    等权限管理（8006，林晓）有了用户体系，这里应当改成从 8006 取。
 */
authRouter.get(
  '/demo-identities',
  wrap(async (_req, res) => {
    /** 从班级表里把某一类负责人去重捞出来
     *  ★ 2026-10-04：大学班在 sms_class.t_class_info、实训班在 t_job_class，
     *    两个库都要捞，否则「多造角色」后登录页下拉只有实训库那一半 */
    const pick = async (idCol: string, nameCol: string) => {
      const map = new Map<string, string>();
      // ★ 2026-10-04：大学班在 sms_class.t_class_info、实训班在 sms_job.t_job_class，
      //   两个库都要捞，否则「多造角色」后登录页下拉只有实训库那一半。
      //   ⚠️ 当前连接是 sms_job，故 t_class_info 必须带库名前缀（由 tbl() 保证）。
      for (const src of [
        { dbName: 'sms_class', table: 't_class_info', stage: 'class' as const },
        { dbName: 'sms_job', table: 't_job_class', stage: 'job' as const },
      ]) {
        const rows = await tbl(db, src.dbName, src.table, src.stage)
          .where('is_deleted', false)
          .whereNotNull(idCol)
          .distinct()
          .select(idCol, nameCol);
        rows.forEach((r: any) => {
          const id = r[idCol];
          if (id && !map.has(id)) map.set(id, r[nameCol] || id);
        });
      }
      return Array.from(map, ([id, name]) => ({ id, name }));
    };

    res.json(
      ok({
        headTeachers: await pick('head_teacher_id', 'head_teacher_name'),
        teachers: await pick('teacher_id', 'teacher_name'),
        assistants: await pick('assistant_id', 'assistant_name'),
        // ★ 2026-10-04 斌哥拍板：班主任按阶段拆出「项目经理」，登录页要能选它
        //   数据源：大学班 + 实训班的 project_manager_*（两库都捞）
        projectManagers: await pickProjectManagers(),
        // ★ 就业指导老师（转就业后接管班级），登录页也要能选真人
        employmentTeachers: await pick('employment_teacher_id', 'employment_teacher_name'),
      }),
    );
  }),
);

/**
 * 取「项目经理」候选人（= 能带实训班的人）
 *
 * 只取实训班的 `project_manager_*`（升实训时必填真人，见交棒模型）。
 * ★ 2026-10-04：不再「没填就退回班主任」—— 避免项目经理下拉里混进假数据。
 */
async function pickProjectManagers(): Promise<Array<{ id: string; name: string }>> {
  const map = new Map<string, string>();
  // ★ 大学班（sms_class.t_class_info）+ 实训班（sms_job.t_job_class）两库都捞项目经理
  for (const src of [
    { dbName: 'sms_class', table: 't_class_info', stage: 'class' as const },
    { dbName: 'sms_job', table: 't_job_class', stage: 'job' as const },
  ]) {
    const pm = await tbl(db, src.dbName, src.table, src.stage)
      .where('is_deleted', false)
      .whereNotNull('project_manager_id')
      .distinct()
      .select('project_manager_id', 'project_manager_name');
    (pm as Array<Record<string, unknown>>).forEach((r) => {
      const id = r.project_manager_id as string;
      if (id && !map.has(id)) map.set(id, (r.project_manager_name as string) || id);
    });
  }
  return Array.from(map, ([id, name]) => ({ id, name }));
}
