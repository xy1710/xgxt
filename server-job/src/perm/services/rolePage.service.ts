/**
 * 页面管理 · 「职位 → 页面」台账 服务层
 *
 * ============================================================
 * 【这张表是什么】
 *   `sms_perm.t_perm_role_page` 一行 = 「某个职位」在「某个板块的某个页面」上的
 *   一次**显式选择**（enabled=1 允许 / 0 禁止）。
 *
 * 【和 t_perm_page 的关系】
 *   t_perm_page      板块 → 页面 ：这个板块**有没有**这个页面（全局开关）
 *   t_perm_role_page 职位 → 页面 ：这个职位**能不能看**这个页面（职位开关）★ 本表
 *   叠加顺序：板块有 → 职位允许 → 职位有权限点 → 可见。
 *
 * 【增量覆盖，不是全量快照 —— 这是本表最关键的语义】
 *   · 某个职位**一行都没有** → 完全沿用默认（把行为交回给
 *     pagePermissionSource / perm-link 的既有口径），对存量账号零影响
 *   · 某个职位有行 → 该职位最终可见 =（默认 ∪ 打勾）− 去勾
 *   所以保存时**只落与默认不同的那些行**（差异存储）：
 *     既不会因为「某页没写」就把新加的页面藏起来，
 *     也让「恢复默认」= 把该职位的行删光，语义干净。
 *
 * 【权限码】沿用 `perm:权限配置:editPerm`（与「职位权限分配」「页面管理」同一个
 *   功能点）—— 它们都是「授权配置」这件事的不同切面，不另立功能点。
 * ============================================================
 */

import { randomUUID } from 'crypto';
import { db } from '../utils/db';
import { PAGE_REGISTRY, findRegistryBoard } from '../config/pageRegistry';
import type {
  PermRolePagesResult,
  PermRolePageSaveResult,
  PermRoleSummary,
  PermRoleTreeBoard,
  PermRoleTreeResult,
} from 'shared-types/perm';
import { deriveDefaultPathsBatch } from '../../utils/rolePageDefaults';
import { effectivePathsByRoleId } from '../../utils/rolePageEffective';
import { clearRolePageCache } from '../../utils/rolePageLedger';
import { clearRoleDefaultCache } from '../../utils/rolePageDefaults';
import { clearRoleActionCache } from '../../utils/roleActionOverlay';

export const ROLE_PAGE_TABLE = 't_perm_role_page';

/** 台账一行 */
export interface RolePageRow {
  id: string;
  roleId: string;
  moduleKey: string;
  pagePath: string;
  enabled: boolean;
}

/* ============================================================
 * 1. 建表
 * ============================================================ */

let ensured: Promise<void> | null = null;

/** 建表（幂等；并发调用共享同一个 Promise；失败允许下次重试） */
export function ensureRolePageTable(): Promise<void> {
  if (!ensured) {
    ensured = createTable().catch((e) => {
      ensured = null;
      throw e;
    });
  }
  return ensured;
}

async function createTable(): Promise<void> {
  await db.raw(`
    CREATE TABLE IF NOT EXISTS \`${ROLE_PAGE_TABLE}\` (
      \`id\` varchar(36) NOT NULL COMMENT '主键UUID',
      \`create_time\` datetime NOT NULL COMMENT '创建时间',
      \`create_by\` varchar(36) DEFAULT NULL COMMENT '创建人ID',
      \`update_time\` datetime DEFAULT NULL COMMENT '修改时间',
      \`update_by\` varchar(36) DEFAULT NULL COMMENT '修改人ID',
      \`is_deleted\` tinyint(1) NOT NULL DEFAULT 0 COMMENT '逻辑删除',
      \`role_id\` varchar(36) NOT NULL COMMENT '职位id（t_perm_role.id）',
      \`module_key\` varchar(32) NOT NULL COMMENT '板块key（门户模块key）',
      \`page_path\` varchar(128) NOT NULL COMMENT '页面路由path',
      \`enabled\` tinyint(1) NOT NULL DEFAULT 1 COMMENT '1=该职位可见该页面',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uk_role_page\` (\`role_id\`,\`module_key\`,\`page_path\`),
      KEY \`idx_role\` (\`role_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='权限-职位页面台账'
  `);
}

/* ============================================================
 * 2. 读
 * ============================================================ */

/** 读台账全部行（配置界面用） */
export async function loadRolePageRows(): Promise<RolePageRow[]> {
  await ensureRolePageTable();
  const rows = await db(ROLE_PAGE_TABLE).where('is_deleted', false);
  return (rows as any[]).map((r) => ({
    id: r.id,
    roleId: r.role_id,
    moduleKey: r.module_key,
    pagePath: r.page_path,
    enabled: !!r.enabled,
  }));
}

interface RoleLite {
  id: string;
  roleCode: string;
  roleName: string;
  roleType: string;
  deptId: string;
  deptName: string;
  enabled: boolean;
  sortNo: number;
}

/** 取全部职位（含部门名与启用态） */
async function loadRoles(): Promise<RoleLite[]> {
  const rows = await db('t_perm_role').where('is_deleted', false).orderBy('sort_no');
  const depts = await db('t_perm_dept').where('is_deleted', false).select('id', 'dept_name');
  const deptMap = new Map((depts as any[]).map((d) => [d.id, d.dept_name]));

  return (rows as any[]).map((r) => ({
    id: r.id,
    roleCode: r.role_code,
    roleName: r.role_name,
    roleType: r.role_type || '业务职位',
    deptId: r.dept_id || '',
    deptName: deptMap.get(r.dept_id) || '—',
    enabled: String(r.role_status || '').includes('启用'),
    sortNo: Number(r.sort_no || 0),
  }));
}

/** `板块key||path` 键 */
const rpKey = (moduleKey: string, pagePath: string) => `${moduleKey}||${pagePath}`;

/* ============================================================
 * 3. 左栏：板块 → 职位 树
 * ============================================================ */

/**
 * 左栏结构：每个板块下面挂「在这个板块里至少能看到 1 个页面」的职位。
 *
 * ⚠️ 一个职位可能出现在多个板块下（这很正常：班主任在班级 + 初高
 *    两个板块都有页面），所以它不是一个严格的树，而是「板块 → 相关职位」。
 */
export async function loadRoleTree(): Promise<PermRoleTreeResult> {
  const [roles, rows] = await Promise.all([loadRoles(), loadRolePageRows()]);
  const defaults = await deriveDefaultPathsBatch(roles.map((r) => r.roleCode));
  const effective = effectivePathsByRoleId(roles, rows, defaults);

  const configuredRoleIds = new Set(rows.map((r) => r.roleId));

  /** 某职位在某板块下的可见页数 */
  const countIn = (roleId: string, moduleKey: string): number => {
    const set = effective.get(roleId);
    if (!set) return 0;
    const prefix = `${moduleKey}||`;
    let n = 0;
    set.forEach((k) => {
      if (k.startsWith(prefix)) n += 1;
    });
    return n;
  };

  const boards: PermRoleTreeBoard[] = PAGE_REGISTRY.map((b) => {
    const roleList: PermRoleSummary[] = [];
    /**
     * ★ 2026-10-20：工作台**不按职位展开**（左栏直接跳过这一段）
     *
     * 【为什么】
     *   工作台是全站首页：locked（不可取消）、人人可见、也没有页面权限码。
     *   一旦按职位列出来，14 个职位全是「1/1」——14 行一模一样的数字，
     *   把下面真正要配的页面全淹掉了（用户截图框掉的就是这一段）。
     *
     * 【它本来也不可配】
     *   默认值恒为 true（见 rolePageDefaults 的 case 'workbench'）且 locked，
     *   保存时「与默认一致 → 不落行」，所以给它配什么都写不出差异行。
     *   列出来只会让管理员误以为这里能改。
     */
    if (b.moduleKey !== 'workbench') {
      for (const r of roles) {
        const n = countIn(r.id, b.moduleKey);
        if (n === 0) continue; // 这个职位在本板块一个页面都看不到 → 不挂在这里
        roleList.push({
          roleId: r.id,
          roleCode: r.roleCode,
          roleName: r.roleName,
          deptName: r.deptName,
          roleType: r.roleType,
          enabled: r.enabled,
          configured: configuredRoleIds.has(r.id),
          enabledCount: n,
          total: b.pages.length,
        });
      }
    }
    return {
      moduleKey: b.moduleKey,
      moduleName: b.moduleName,
      moduleIcon: b.moduleIcon,
      moduleDesc: b.moduleDesc,
      legacy: b.legacy,
      total: b.pages.length,
      roles: roleList,
    };
  });

  // 兜底：在所有板块都看不到任何页面的职位（正常不该出现）单独列出来，
  // 否则它在界面上无处可点，管理员就没法给它配权限。
  const shown = new Set<string>();
  boards.forEach((b) => b.roles.forEach((r) => shown.add(r.roleId)));
  const orphanRoles: PermRoleSummary[] = roles
    .filter((r) => !shown.has(r.id))
    .map((r) => ({
      roleId: r.id,
      roleCode: r.roleCode,
      roleName: r.roleName,
      deptName: r.deptName,
      roleType: r.roleType,
      enabled: r.enabled,
      configured: configuredRoleIds.has(r.id),
      enabledCount: 0,
      total: PAGE_REGISTRY.reduce((n, b) => n + b.pages.length, 0),
    }));

  return { boards, orphanRoles, roleTotal: roles.length };
}

/* ============================================================
 * 4. 右侧：某职位在全部板块下的页面勾选态
 * ============================================================ */

export async function loadRolePages(roleId: string): Promise<PermRolePagesResult> {
  const role = await db('t_perm_role').where({ id: roleId, is_deleted: false }).first();
  if (!role) throw new Error(`职位不存在：${roleId}`);

  const dept = role.dept_id
    ? await db('t_perm_dept').where({ id: role.dept_id, is_deleted: false }).first()
    : null;

  const [rows, defaults] = await Promise.all([
    loadRolePageRows(),
    deriveDefaultPathsBatch([String(role.role_code)]),
  ]);

  const myRows = new Map<string, boolean>();
  rows.forEach((r) => {
    if (r.roleId === roleId) myRows.set(rpKey(r.moduleKey, r.pagePath), r.enabled);
  });
  const def = defaults.get(String(role.role_code)) || new Set<string>();

  let enabledTotal = 0;
  let total = 0;
  let overrideCount = 0;

  const boards = PAGE_REGISTRY.map((b) => {
    let enabledCount = 0;
    const pages = b.pages.map((p, i) => {
      const k = rpKey(b.moduleKey, p.path);
      const has = myRows.has(k);
      const explicit = myRows.get(k);
      // 最终可见 = 台账有行就用台账，没行就用默认
      const on = has ? !!explicit : def.has(k);
      const overridden = has && !!explicit !== def.has(k);

      if (on) enabledCount += 1;
      if (overridden) overrideCount += 1;

      return {
        pageKey: p.key,
        pageTitle: p.title,
        pagePath: p.path,
        pageCode: p.pageCode,
        /* ★ 与板块模式口径一致：合并页把整组权限码一起下发 */
        pageCodes: p.pageCodes,
        pageSort: i + 1,
        enabled: on,
        locked: !!p.locked,
        remark: p.remark,
        overridden,
      };
    });

    total += pages.length;
    enabledTotal += enabledCount;

    return {
      moduleKey: b.moduleKey,
      moduleName: b.moduleName,
      moduleIcon: b.moduleIcon,
      legacy: b.legacy,
      total: pages.length,
      enabledCount,
      pages,
    };
  });

  return {
    roleId,
    roleCode: String(role.role_code),
    roleName: String(role.role_name),
    deptName: dept?.dept_name || '—',
    configured: myRows.size > 0,
    overrideCount,
    boards,
    total,
    enabledTotal,
  };
}

/* ============================================================
 * 5. 写
 * ============================================================ */

function invalidateCache(): void {
  clearRolePageCache();
  clearRoleDefaultCache();
  // ★ 2026-10-07：职位页面改完，按钮级的权限树叠加也要跟着失效
  clearRoleActionCache();
}

/**
 * 保存某职位在全部板块下的页面勾选。
 *
 * ⚠️ 语义 = **差异存储**：只写「与默认不同」的行。
 *    · 与默认一致的页面 → 不写行（= 交回默认，以后默认变了它跟着变）
 *    · 因此在界面上把某页从默认值改回来，再保存 → 那一行会消失
 * ⚠️ locked 的页面（「页面管理」自己）强制允许，防止把管理员锁在门外。
 */
export async function saveRolePages(
  roleId: string,
  items: Array<{ moduleKey: string; pagePath: string; enabled: boolean }>,
  operator: { id?: string; name?: string } = {},
): Promise<PermRolePageSaveResult> {
  await ensureRolePageTable();

  const role = await db('t_perm_role').where({ id: roleId, is_deleted: false }).first();
  if (!role) throw new Error(`职位不存在：${roleId}`);

  const defaults = await deriveDefaultPathsBatch([String(role.role_code)]);
  const def = defaults.get(String(role.role_code)) || new Set<string>();

  // 只接受「注册表里真实存在」的 板块+路径，防止脏数据
  const valid = new Set<string>();
  PAGE_REGISTRY.forEach((b) => b.pages.forEach((p) => valid.add(rpKey(b.moduleKey, p.path))));

  const locked = new Set<string>();
  PAGE_REGISTRY.forEach((b) =>
    b.pages.forEach((p) => {
      if (p.locked) locked.add(rpKey(b.moduleKey, p.path));
    }),
  );

  const now = new Date();
  const toWrite: Record<string, unknown>[] = [];
  let enabledTotal = 0;
  let changed = 0;

  const seen = new Set<string>();
  for (const it of items) {
    const k = rpKey(String(it.moduleKey), String(it.pagePath));
    if (!valid.has(k) || seen.has(k)) continue;
    seen.add(k);

    /**
     * ⚠️ locked 只防「取消」，不负责「强行打开」：
     *     · 默认就可见的（如「页面管理」对系统管理员）→ 强制保留，防止自锁
     *     · 默认本来就不可见的（如「页面管理」对班主任，他根本进不了权限板块）
     *       → 不因为 locked 而硬开，否则会凭空给这个职位授一条页权限，
     *         台账里也会冒出一条莫名其妙的「已改」
     */
    const on = locked.has(k) && def.has(k) ? true : !!it.enabled;
    if (on) enabledTotal += 1;
    // ★ 与默认一致 → 不落行（差异存储）
    if (on === def.has(k)) continue;
    changed += 1;
    toWrite.push({
      id: randomUUID(),
      create_time: now,
      create_by: operator.id || 'system',
      update_time: now,
      update_by: operator.id || 'system',
      is_deleted: 0,
      role_id: roleId,
      module_key: it.moduleKey,
      page_path: it.pagePath,
      enabled: on ? 1 : 0,
    });
  }

  await db.transaction(async (trx) => {
    // 全量覆盖该职位：先清空，再写差异行
    await trx(ROLE_PAGE_TABLE).where({ role_id: roleId }).del();
    if (toWrite.length) {
      const CHUNK = 200;
      for (let i = 0; i < toWrite.length; i += CHUNK) {
        await trx(ROLE_PAGE_TABLE).insert(toWrite.slice(i, i + CHUNK));
      }
    }
  });

  invalidateCache();

  return {
    roleId,
    configured: toWrite.length > 0,
    enabledTotal,
    total: valid.size,
    changed,
  };
}

/** 恢复默认：把该职位的显式配置全部删除，回到代码里的既有口径 */
export async function resetRolePages(
  roleId: string,
  operator: { id?: string; name?: string } = {},
): Promise<{ affected: number }> {
  await ensureRolePageTable();
  void operator;
  const affected = await db(ROLE_PAGE_TABLE).where({ role_id: roleId }).del();
  invalidateCache();
  return { affected: Number(affected) || 0 };
}

/** 按板块查页面（`saveRolePages` 的校验用，也供路由层复用） */
export function boardPages(moduleKey: string): Array<{ path: string; locked?: boolean }> {
  return findRegistryBoard(moduleKey)?.pages || [];
}
