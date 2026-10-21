/**
 * 诊断工具：核对「按钮权限打通」有没有引入意外变化
 *
 *   npm run check:action-overlay
 *
 * 【怎么读结果】
 *   每个角色一行：
 *     base = 静态兜底表里的操作码数量
 *     now  = 叠加「权限树相对基线的改动」之后的数量
 *     相对基线: +N -M   ← 管理员在「职位权限分配」里做出的净改动
 *   想确认「打通当天零变化」→ 14 个角色应全部 `+0 -0`。
 *   若出现了非预期的 `+ / -`，说明有人改过权限树（或基线被重置了）。
 *
 * 【基线在哪】
 *   `sms_perm.t_perm_role_perm_baseline`（首次使用自动建表 + 自动灌）。
 *   想「把当前权限树重新认定为基线」：
 *     DELETE FROM sms_perm.t_perm_role_perm_baseline;  然后重启后端。
 */
import {
  getUserOperationPermissions,
  getUserOperationPermissionsBase,
} from '../src/utils/pagePermissionSource';
import { getRoleActionOverride, diffOfOverride } from '../src/utils/roleActionOverlay';

const ROLES = [
  'MKT_CONSULT', 'MKT_MANAGER', 'TEACH_HEAD', 'TEACH_TUTOR', 'TEACH_ASSIST',
  'TEACH_QTY', 'ACAD_MANAGER', 'ACAD_STAFF', 'FIN_STAFF', 'JOB_STAFF',
  'RM_PROJECT', 'RM_PRINCIPAL', 'SYS_ADMIN', 'TEACH_DEAN',
];

(async () => {
  let changed = 0;
  for (const r of ROLES) {
    const base = getUserOperationPermissionsBase([r]).sort();
    const now = (await getUserOperationPermissions([r])).sort();
    const ov = await getRoleActionOverride(r);
    const d = diffOfOverride(ov);
    const added = now.filter((c) => !base.includes(c));
    const removed = base.filter((c) => !now.includes(c));
    const flag = added.length || removed.length ? '★' : ' ';
    if (added.length || removed.length) changed += 1;
    console.log(
      `${flag} ${r.padEnd(14)} base=${String(base.length).padStart(2)} now=${String(now.length).padStart(2)}` +
        `  相对基线: +${d.added.length} -${d.removed.length}` +
        `  (树内记录 ${ov ? ov.granted.size : 0} 条 / 基线 ${ov ? ov.baselineGranted.size : 0} 条)`,
    );
    if (added.length) console.log(`     + 实际新增: ${added.join(', ')}`);
    if (removed.length) console.log(`     - 实际移除: ${removed.join(', ')}`);
  }
  console.log(`\n共 ${ROLES.length} 个角色，其中 ${changed} 个角色的操作码发生变化`);
  process.exit(0);
})();
