/**
 * 可选项字典路由
 *
 * 提供方：权限管理（林晓）
 * 前缀：  /api/perm/option
 *
 *  GET /get   前端所有下拉框的取值集中在这里
 *
 * ⚠️ 为什么要有这个接口？
 *    如果每个页面各写一份「职位类型 → 中文」，改一次字典要改 7 个地方，
 *    迟早出现「A 页面叫管理职位、B 页面叫管理层」的脏数据。
 *    统一在这里给出，前端只负责渲染。
 */

import { Router } from 'express';
import {
  DataScope,
  DATA_SCOPE_NAME,
  DeptLevel,
  DEPT_LEVEL_NAME,
  PermBaseAction,
  PERM_BASE_ACTION_NAME,
  RoleStatus,
  UserStatus,
  ExportScope,
} from 'shared-types/perm';
import { ok } from '../utils/response';
import { wrap } from '../utils/wrap';
/* ★ 2026-10-19：密码策略统一从 pwdPolicy 取（与校验逻辑同一份，避免文案与判定漂移） */
import { loadPwdRule } from '../services/pwdPolicy';

export const optionRouter = Router();

/* ============================================================
 * 拼接「当前生效的密码策略」提示文案
 * 例：不少于 8 位，含大写字母、数字、特殊符号，90 天有效
 * ============================================================ */

async function buildPwdTip(): Promise<string> {
  const pwd = await loadPwdRule();
  const parts: string[] = [];
  parts.push(`不少于 ${pwd.min} 位`);
  const need: string[] = [];
  if (pwd.upper) need.push('大写字母');
  if (pwd.digit) need.push('数字');
  if (pwd.symbol) need.push('特殊符号');
  if (need.length) parts.push(`含${need.join('、')}`);
  parts.push(pwd.expireDays > 0 ? `${pwd.expireDays} 天需更换` : '长期有效');
  if (pwd.forceFirst) parts.push('首次登录须修改');
  return parts.join('，');
}

optionRouter.get(
  '/get',
  wrap(async (_req, res) => {
    res.json(
      ok({
        roleTypes: ['业务职位', '管理职位', '职能职位', '系统职位'].map((v) => ({ value: v, label: v })),

        roleStatuses: [RoleStatus.ENABLED, RoleStatus.DISABLED].map((v) => ({ value: v, label: v })),

        userStatuses: [UserStatus.NORMAL, UserStatus.DISABLED, UserStatus.LOCKED].map((v) => ({
          value: v,
          label: v,
        })),

        deptLevels: [DeptLevel.SCHOOL, DeptLevel.DEPT, DeptLevel.STAGE].map((v) => ({
          value: v,
          label: DEPT_LEVEL_NAME[v],
        })),

        dataScopes: [DataScope.SELF, DataScope.CLASS, DataScope.DEPT, DataScope.ALL].map((v) => ({
          value: v,
          label: DATA_SCOPE_NAME[v],
        })),

        baseActions: [
          PermBaseAction.VIEW,
          PermBaseAction.ADD,
          PermBaseAction.EDIT,
          PermBaseAction.DELETE,
          PermBaseAction.APPROVE,
          PermBaseAction.EXPORT,
        ].map((v) => ({ value: v, label: PERM_BASE_ACTION_NAME[v] })),

        exportScopes: [
          ExportScope.CURRENT_PAGE,
          ExportScope.FILTERED,
          ExportScope.ALL,
        ].map((v) => ({ value: v, label: v })),

        /** 操作日志 — 操作类型（与 t_perm_log.action_type 取值一致） */
        logActionTypes: ['登录', '新增', '修改', '删除', '审批', '导出', '权限变更'].map((v) => ({
          value: v,
          label: v,
        })),

        /** 操作日志 — 所属模块（与 t_perm_log.module_name 取值一致） */
        logModules: [
          '市场咨询',
          '教学部门',
          '实训-教学',
          '就业管理',
          '教务部门',
          '财务管理',
          '审批中心',
          '权限管理',
        ].map((v) => ({ value: v, label: v })),

        logResults: ['成功', '失败'].map((v) => ({ value: v, label: v })),

        pwdTipText: await buildPwdTip(),
      }),
    );
  }),
);

export default optionRouter;
