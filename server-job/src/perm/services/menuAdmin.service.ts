/**
 * 权限点维护 · 领域服务（★ 2026-10-19 新增）
 *
 * ============================================================
 * 【这一层解决什么问题】
 *   系统预置的权限树（8 个板块 / 55 个功能点 / 185 个动作）是「系统能力清单」，
 *   但新加的部门与职位（如 **招生部 · 招生老师**）往往需要一批预置清单里
 *   根本没有的功能点（如「招生报名登记」「意向学员跟进」）。
 *   过去只能改 SQL —— 现在由本服务提供「新增 / 修改 / 删除」三条通道。
 *
 * 【关键口径】
 *   · 自建权限点与预置权限**格式完全一致**：
 *       t_perm_menu        一行 = 一个功能点（模块 → 功能点）
 *       t_perm_menu_action 一行 = 该功能点下的一个动作
 *     因此新增后无需任何额外适配，`loadModules()` 立刻能读到它，
 *     「职位权限分配」里就能勾选给任意职位。
 *   · 预置权限点 **只读**：业务代码里写死了
 *     `checkPermission('perm:权限配置:editPerm')` 这类字符串，
 *     改了功能点名 / 删了动作 → 对应按钮直接失效。所以 go 只允许改自建项。
 *   · `is_custom` 列是运行时补的（`ensureCustomColumn`）：
 *     老库（init/sql 导入的）没有这一列，不能要求用户手工执行 ALTER。
 *
 * 【缓存】权限树有 60 秒内存缓存（见 perm.service.ts 的 loadModules），
 *   任何写操作后必须 clearTreeCache()；同时权限点也是下游
 *   「职位→页面默认值」「按钮级判权叠加」的原料，那两个 15 秒缓存也要清。
 * ============================================================
 */

import { randomUUID } from 'crypto';
import { BizCode, PermItemActionSavePayload, PermItemSavePayload } from 'shared-types/perm';
import { BizError } from '../middleware/errorHandler';
import { db } from '../utils/db';
import { clearTreeCache, loadModules, refreshRolePermCount } from './perm.service';
import { clearRoleDefaultCache } from '../../utils/rolePageDefaults';
import { clearRoleActionCache } from '../../utils/roleActionOverlay';

/** 新建板块时用的 key 前缀（与预置的 market/teach/... 区分开，一眼看得出是自建） */
const CUSTOM_MODULE_PREFIX = 'custom_';

/** 板块 key 里允许出现的字符（它会进权限串 `module:item:action`） */
const MODULE_KEY_RE = /^[a-z][a-z0-9_]{1,31}$/;
/** 动作编码里允许出现的字符（业务代码判权时直接拼字符串） */
const ACTION_CODE_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** 动作基类的默认编码 / 默认中文名（「一键套用常用动作」用） */
export const BASE_ACTION_PRESET: Record<number, { code: string; name: string }> = {
  1: { code: 'view', name: '查看' },
  2: { code: 'add', name: '新建' },
  3: { code: 'edit', name: '编辑' },
  4: { code: 'del', name: '删除' },
  5: { code: 'agree', name: '审批' },
  6: { code: 'export', name: '导出' },
};

/* ============================================================
 * 0. 建列（幂等）
 * ============================================================ */

let ensured: Promise<void> | null = null;

/** 确保 t_perm_menu 有 is_custom 列（没有就补上；并发共享同一个 Promise） */
export function ensureCustomColumn(): Promise<void> {
  if (!ensured) {
    ensured = doEnsureCustomColumn().catch((e) => {
      ensured = null;
      throw e;
    });
  }
  return ensured;
}

async function doEnsureCustomColumn(): Promise<void> {
  const res: any = await db.raw('SELECT DATABASE() AS d');
  const dbName = String((Array.isArray(res?.[0]) ? res[0][0] : undefined)?.d || '');
  if (!dbName) return;
  const cols: any = await db.raw(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 't_perm_menu' AND COLUMN_NAME = 'is_custom'`,
    [dbName],
  );
  const rows: any[] = Array.isArray(cols?.[0]) ? cols[0] : [];
  if (rows.length) return;
  await db.raw(
    "ALTER TABLE `t_perm_menu` ADD COLUMN `is_custom` tinyint(1) NOT NULL DEFAULT 0 COMMENT '1=用户自建权限点（可改可删）'",
  );
  // 预置数据的 create_by 是 system，自建的一定不是 —— 顺手把历史数据标对
  await db.raw("UPDATE `t_perm_menu` SET `is_custom` = 0 WHERE `create_by` = 'system' OR `create_by` IS NULL");
  clearTreeCache();
}

/* ============================================================
 * 1. 缓存失效
 * ============================================================ */

function invalidateAll(): void {
  clearTreeCache();
  clearRoleDefaultCache();
  clearRoleActionCache();
}

/* ============================================================
 * 2. 读：权限点维护列表
 * ============================================================ */

/**
 * 全部功能点（含自建）+ 每个功能点的动作 + 被多少职位勾选
 *
 * ⚠️ 不做分页：功能点总量是「几十~几百」级别，整份下发最简单；
 *    前端按板块分组显示 + 本地搜索即可。
 */
export async function listMenuItemsAdmin(): Promise<
  Array<{
    id: string;
    moduleKey: string;
    moduleName: string;
    moduleIcon: string;
    moduleSort: number;
    itemName: string;
    parentItemName?: string;
    itemSort: number;
    remark?: string;
    isCustom: boolean;
    actions: Array<{ actionCode: string; actionName: string; baseAction: number; remark?: string }>;
    grantedRoleCount: number;
  }>
> {
  await ensureCustomColumn();
  const mods = await loadModules();

  // 每个「板块||功能点」被多少个职位勾选（distinct role_id）
  const granted = await db('t_perm_role_perm')
    .where('is_deleted', false)
    .groupBy('module_key', 'item_name')
    .select('module_key', 'item_name')
    .countDistinct({ n: 'role_id' });
  const grantedMap = new Map<string, number>();
  (granted as any[]).forEach((g) => grantedMap.set(`${g.module_key}||${g.item_name}`, Number(g.n || 0)));

  const out: Array<{
    id: string;
    moduleKey: string;
    moduleName: string;
    moduleIcon: string;
    moduleSort: number;
    itemName: string;
    parentItemName?: string;
    itemSort: number;
    remark?: string;
    isCustom: boolean;
    actions: Array<{ actionCode: string; actionName: string; baseAction: number; remark?: string }>;
    grantedRoleCount: number;
  }> = [];

  mods.forEach((m) => {
    m.items.forEach((it, i) => {
      out.push({
        id: it.id,
        moduleKey: m.moduleKey,
        moduleName: m.moduleName,
        moduleIcon: m.moduleIcon,
        moduleSort: m.sortNo,
        itemName: it.itemName,
        parentItemName: it.parentItemName,
        // t_perm_menu 的 item_sort 没进 PermItem，这里用「模块内顺序」即可（仅列表展示用）
        itemSort: i + 1,
        remark: it.remark,
        isCustom: !!it.isCustom,
        actions: it.actions.map((a) => ({
          actionCode: a.actionCode,
          actionName: a.actionName,
          baseAction: Number(a.baseAction),
          remark: a.remark,
        })),
        grantedRoleCount: grantedMap.get(`${m.moduleKey}||${it.itemName}`) || 0,
      });
    });
  });
  return out;
}

/* ============================================================
 * 3. 写：新增 / 修改 / 删除
 * ============================================================ */

/** 取某板块的展示信息（不存在则返回 null） */
async function moduleMeta(moduleKey: string): Promise<{ moduleName: string; moduleIcon: string; moduleSort: number } | null> {
  const row = await db('t_perm_menu')
    .where({ module_key: moduleKey, is_deleted: false })
    .orderBy('module_sort')
    .first();
  if (!row) return null;
  return {
    moduleName: String(row.module_name),
    moduleIcon: String(row.module_icon || '🗂️'),
    moduleSort: Number(row.module_sort || 0),
  };
}

/** 生成一个不与现有板块冲突的 key */
async function nextModuleKey(): Promise<string> {
  const rows = await db('t_perm_menu').where('is_deleted', false).distinct('module_key');
  const used = new Set((rows as any[]).map((r) => String(r.module_key)));
  let i = 1;
  while (used.has(`${CUSTOM_MODULE_PREFIX}${i}`)) i += 1;
  return `${CUSTOM_MODULE_PREFIX}${i}`;
}

/** 校验并规整动作清单 */
function normalizeActions(actions: PermItemActionSavePayload[]): Array<{
  actionCode: string;
  actionName: string;
  baseAction: number;
  remark?: string;
}> {
  const list = (actions || []).filter((a) => String(a?.actionName || '').trim());
  if (!list.length) {
    throw new BizError(BizCode.PERM_ITEM_ACTIONS_EMPTY, '请至少添加一个动作（如「查看」「新建」）');
  }
  const used = new Set<string>();
  return list.map((a, i) => {
    const name = String(a.actionName).trim().slice(0, 32);
    const base = Number(a.baseAction) || 1;
    let code = String(a.actionCode || '').trim();
    if (!code) code = BASE_ACTION_PRESET[base]?.code || `act${i + 1}`;
    if (!ACTION_CODE_RE.test(code)) {
      throw new BizError(
        BizCode.FORMAT_ERROR,
        `动作编码「${code}」不合法：只能用字母开头的字母 / 数字 / 下划线，如 view、followUp`,
      );
    }
    // 同一功能点内编码必须唯一
    let final = code;
    let n = 2;
    while (used.has(final)) {
      final = `${code}${n}`;
      n += 1;
    }
    used.add(final);
    return { actionCode: final, actionName: name, baseAction: base, remark: a.remark };
  });
}

/** 新增自建权限点 */
export async function createMenuItem(
  input: PermItemSavePayload,
  operator: string,
): Promise<{ id: string; moduleKey: string; moduleName: string; itemName: string; actionCount: number; created: boolean }> {
  await ensureCustomColumn();

  const itemName = String(input.itemName || '').trim().slice(0, 64);
  if (!itemName) throw new BizError(BizCode.REQUIRED_FIELD_MISSING, '请填写功能点名称');

  // ---- 板块：选已有 / 新建 ----
  let moduleKey = String(input.moduleKey || '').trim();
  let meta = moduleKey && moduleKey !== '__new__' ? await moduleMeta(moduleKey) : null;
  if (meta && moduleKey === '__new__') meta = null;

  if (!meta) {
    const moduleName = String(input.moduleName || '').trim().slice(0, 32);
    if (!moduleName) {
      throw new BizError(BizCode.REQUIRED_FIELD_MISSING, '新建板块时必须填写板块名称');
    }
    if (!moduleKey || moduleKey === '__new__') moduleKey = await nextModuleKey();
    if (!MODULE_KEY_RE.test(moduleKey)) {
      throw new BizError(
        BizCode.FORMAT_ERROR,
        '板块标识不合法：只能用「小写字母开头 + 小写字母/数字/下划线」，如 custom_1',
      );
    }
    const exist = await moduleMeta(moduleKey);
    if (exist) throw new BizError(BizCode.PARAM_ERROR, `板块标识「${moduleKey}」已被占用，请换一个`);
    const maxSort = await db('t_perm_menu').where('is_deleted', false).max({ m: 'module_sort' });
    meta = {
      moduleName,
      moduleIcon: String(input.moduleIcon || '🗂️').slice(0, 16),
      moduleSort: Number(input.moduleSort) || Number((maxSort as any)?.[0]?.m || 0) + 1,
    };
  }

  // ---- 同名功能点（同板块内）不允许 ----
  const dup = await db('t_perm_menu')
    .where({ module_key: moduleKey, item_name: itemName, is_deleted: false })
    .first();
  if (dup) throw new BizError(BizCode.PERM_ITEM_NAME_EXISTS, `「${meta.moduleName}」下已有同名功能点「${itemName}」`);

  const actions = normalizeActions(input.actions);

  // ---- 排序：同板块内排到最后 ----
  const maxItemSort = await db('t_perm_menu')
    .where({ module_key: moduleKey, is_deleted: false })
    .max({ m: 'item_sort' });
  const itemSort = Number((maxItemSort as any)?.[0]?.m || 0) + 1;

  const id = `MN_c_${randomUUID().slice(0, 8)}`;
  const now = new Date();

  await db.transaction(async (trx) => {
    await trx('t_perm_menu').insert({
      id,
      create_time: now,
      create_by: operator,
      update_time: now,
      update_by: operator,
      is_deleted: 0,
      module_key: moduleKey,
      module_name: meta!.moduleName,
      module_icon: meta!.moduleIcon,
      module_sort: meta!.moduleSort,
      item_name: itemName,
      parent_item_name: String(input.parentItemName || '').trim() || null,
      item_sort: itemSort,
      remark: String(input.remark || '').trim().slice(0, 255) || null,
      is_custom: 1,
    } as any);
    await trx('t_perm_menu_action').insert(
      actions.map((a, i) => ({
        id: `MA_c_${randomUUID().slice(0, 8)}`,
        create_time: now,
        create_by: operator,
        update_time: now,
        update_by: operator,
        is_deleted: 0,
        menu_id: id,
        action_code: a.actionCode,
        action_name: a.actionName,
        base_action: a.baseAction,
        action_sort: i + 1,
        remark: a.remark ? String(a.remark).slice(0, 255) : null,
      })) as any,
    );
  });

  invalidateAll();
  return {
    id,
    moduleKey,
    moduleName: meta.moduleName,
    itemName,
    actionCount: actions.length,
    created: true,
  };
}

/** 修改自建权限点 */
export async function updateMenuItem(
  input: PermItemSavePayload,
  operator: string,
): Promise<{ id: string; moduleKey: string; moduleName: string; itemName: string; actionCount: number; created: boolean }> {
  await ensureCustomColumn();

  const id = String(input.id || '').trim();
  if (!id) throw new BizError(BizCode.REQUIRED_FIELD_MISSING, '缺少权限点 id');
  const row = await db('t_perm_menu').where({ id, is_deleted: false }).first();
  if (!row) throw new BizError(BizCode.MENU_NOT_FOUND, '权限点不存在（可能已被删除）');
  if (!row.is_custom) {
    throw new BizError(
      BizCode.PERM_ITEM_PROTECTED,
      `「${row.item_name}」是系统预置权限点，只读。要加新能力请在「新增权限」里新建一个。`,
    );
  }

  const moduleKey = String(input.moduleKey || row.module_key).trim() || String(row.module_key);
  if (moduleKey !== row.module_key) {
    throw new BizError(BizCode.PARAM_ERROR, '自建权限点不支持跨板块移动，请在目标板块下新建一条');
  }

  const itemName = String(input.itemName || '').trim().slice(0, 64);
  if (!itemName) throw new BizError(BizCode.REQUIRED_FIELD_MISSING, '请填写功能点名称');

  if (itemName !== row.item_name) {
    const dup = await db('t_perm_menu')
      .where({ module_key: moduleKey, item_name: itemName, is_deleted: false })
      .whereNot('id', id)
      .first();
    if (dup) throw new BizError(BizCode.PERM_ITEM_NAME_EXISTS, `「${row.module_name}」下已有同名功能点「${itemName}」`);
  }

  const actions = normalizeActions(input.actions);
  const now = new Date();

  // ---- 老动作 → 新动作 的差异 ----
  const oldActs: any[] = await db('t_perm_menu_action').where({ menu_id: id, is_deleted: false });
  const oldMap = new Map(oldActs.map((a) => [String(a.action_code), a]));
  const newCodes = new Set(actions.map((a) => a.actionCode));
  const removedCodes = [...oldMap.keys()].filter((c) => !newCodes.has(c));

  // 受影响职位（用于重算 perm_count）
  const grantedRoles: any[] = await db('t_perm_role_perm')
    .where({ module_key: moduleKey, item_name: row.item_name, is_deleted: false })
    .distinct('role_id');
  const roleIds = (grantedRoles as any[]).map((r) => String(r.role_id));

  await db.transaction(async (trx) => {
    await trx('t_perm_menu')
      .where({ id })
      .update({
        item_name: itemName,
        parent_item_name: String(input.parentItemName || '').trim() || null,
        remark: String(input.remark || '').trim().slice(0, 255) || null,
        update_time: now,
        update_by: operator,
      } as any);

    // 功能点改名 → 已授予的权限行跟着改（否则那些授权会变成「幽灵权限」）
    if (itemName !== row.item_name) {
      await trx('t_perm_role_perm')
        .where({ module_key: moduleKey, item_name: row.item_name })
        .update({ item_name: itemName, update_time: now, update_by: operator });
    }

    // 删掉的动作：动作行逻辑删除 + 已授予的权限行物理删除（全量覆盖语义）
    for (const code of removedCodes) {
      await trx('t_perm_menu_action').where({ id: oldMap.get(code).id }).update({ is_deleted: 1, update_time: now });
      await trx('t_perm_role_perm')
        .where({ module_key: moduleKey, item_name: itemName, action_code: code })
        .del();
    }

    // 逐个动作 upsert
    let sort = 0;
    for (const a of actions) {
      sort += 1;
      const old = oldMap.get(a.actionCode);
      if (old) {
        await trx('t_perm_menu_action')
          .where({ id: old.id })
          .update({
            action_name: a.actionName,
            base_action: a.baseAction,
            action_sort: sort,
            remark: a.remark ? String(a.remark).slice(0, 255) : null,
            update_time: now,
            update_by: operator,
          });
        // 动作名/基类也冗余在权限行里，同步一份
        await trx('t_perm_role_perm')
          .where({ module_key: moduleKey, item_name: itemName, action_code: a.actionCode })
          .update({ action_name: a.actionName, base_action: a.baseAction });
      } else {
        await trx('t_perm_menu_action').insert({
          id: `MA_c_${randomUUID().slice(0, 8)}`,
          create_time: now,
          create_by: operator,
          update_time: now,
          update_by: operator,
          is_deleted: 0,
          menu_id: id,
          action_code: a.actionCode,
          action_name: a.actionName,
          base_action: a.baseAction,
          action_sort: sort,
          remark: a.remark ? String(a.remark).slice(0, 255) : null,
        } as any);
      }
    }
  });

  // 被删掉的动作可能让某些职位的 perm_count 虚高
  for (const rid of roleIds) await refreshRolePermCount(rid);

  invalidateAll();
  return {
    id,
    moduleKey,
    moduleName: String(row.module_name),
    itemName,
    actionCount: actions.length,
    created: false,
  };
}

/** 删除自建权限点（预置项拒绝） */
export async function deleteMenuItem(id: string, operator: string): Promise<{ itemName: string; affectedRoles: number }> {
  await ensureCustomColumn();
  const row = await db('t_perm_menu').where({ id, is_deleted: false }).first();
  if (!row) throw new BizError(BizCode.MENU_NOT_FOUND, '权限点不存在（可能已被删除）');
  if (!row.is_custom) {
    throw new BizError(BizCode.PERM_ITEM_PROTECTED, `「${row.item_name}」是系统预置权限点，不可删除`);
  }

  const granted: any[] = await db('t_perm_role_perm')
    .where({ module_key: row.module_key, item_name: row.item_name, is_deleted: false })
    .distinct('role_id');
  const roleIds = (granted as any[]).map((r) => String(r.role_id));
  const now = new Date();

  await db.transaction(async (trx) => {
    await trx('t_perm_menu').where({ id }).update({ is_deleted: 1, update_time: now, update_by: operator });
    await trx('t_perm_menu_action')
      .where({ menu_id: id })
      .update({ is_deleted: 1, update_time: now, update_by: operator });
    // 已授予的权限一并收回（否则职位上会留着点不出来的权限）
    await trx('t_perm_role_perm')
      .where({ module_key: row.module_key, item_name: row.item_name })
      .del();
  });

  for (const rid of roleIds) await refreshRolePermCount(rid);
  invalidateAll();
  return { itemName: String(row.item_name), affectedRoles: roleIds.length };
}
