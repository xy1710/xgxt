/**
 * 权限总览路由
 *
 * 提供方：权限管理（林晓）
 * 前缀：  /api/perm/overview
 *
 *  GET /get   首屏 KPI + 最近操作动态
 *
 * ⚠️ 口径说明（几个容易被问到的数字）：
 *    · deptTotal = 6 —— 校级直属的一级部门（市场咨询部 / 教学部 / 就业部 / 教务部 /
 *      财务管理部 / 行政），不含校级本身，也不含下设子部门；
 *    · stageTotal = 5 —— 下设子部门：教学部的 初中部 / 高中部 / 大学部，
 *      就业部的 实训管理 / 就业管理。
 *      ★ 2026-10-20 起按 dept_level 统计（原来硬编码 3 个学段 id，就业部并进来后就漏了）。
 *    · permPointTotal = 185 —— 2026-10-02「实训-教学」补到 10 个功能点后，由 157 更新；
 *      「教质/学术审批」是父功能点，下挂 休学/退学审批 + 退费审批 两个二级功能点，
 *      各 3 个动作（查看/同意/驳回），父项自身不挂动作，故合计不重复。
 *    · moduleTotal = 8 / itemTotal = 53（只算顶级功能点，二级功能点并入父项）。
 */

import { Router } from 'express';
import { ok } from '../utils/response';
import { db } from '../utils/db';
import { wrap } from '../utils/wrap';
import { RoleStatus, UserStatus } from 'shared-types/perm';
import { countDeptTotal, countStageTotal, getTreeStats, resolveLogRoleLabels } from '../services/perm.service';

export const overviewRouter = Router();

overviewRouter.get(
  '/get',
  wrap(async (_req, res) => {
    const [
      roleTotal,
      roleEnabled,
      userTotal,
      userNormal,
      deptTotal,
      stageTotal,
      stats,
      recentLogs,
    ] = await Promise.all([
      db('t_perm_role').where('is_deleted', false).count({ n: '*' }),
      db('t_perm_role').where({ is_deleted: false, role_status: RoleStatus.ENABLED }).count({ n: '*' }),
      db('t_perm_user').where('is_deleted', false).count({ n: '*' }),
      db('t_perm_user').where({ is_deleted: false, user_status: UserStatus.NORMAL }).count({ n: '*' }),
      countDeptTotal(),
      countStageTotal(),
      getTreeStats(),
      db('t_perm_log').where('is_deleted', false).orderBy('log_time', 'desc').limit(6),
    ]);

    // ★ 2026-10-20：最近日志的「所属职位」同样要中文（口径见 services/perm.service.ts
    //   resolveLogRoleLabels 的注释：token 里只有 SYS_ADMIN/SYS_STAFF，得按操作人现查）
    const recentRoleLabels = await resolveLogRoleLabels(recentLogs as any[]);

    res.json(
      ok({
        roleTotal: Number(roleTotal[0]?.n || 0),
        roleEnabled: Number(roleEnabled[0]?.n || 0),
        userTotal: Number(userTotal[0]?.n || 0),
        userNormal: Number(userNormal[0]?.n || 0),
        permPointTotal: stats.actionCount,
        moduleTotal: stats.modCount,
        itemTotal: stats.itemCount,
        deptTotal,
        stageTotal,
        recentLogs: recentLogs.map((r: any, i: number) => ({
          id: r.id,
          logTime: r.log_time,
          operatorName: r.operator_name,
          operatorRole: recentRoleLabels[i] ?? r.operator_role,
          moduleName: r.module_name,
          actionType: r.action_type,
          targetObj: r.target_obj,
          beforeValue: r.before_value,
          afterValue: r.after_value,
          ip: r.ip,
          result: r.result,
        })),
      }),
    );
  }),
);

export default overviewRouter;
