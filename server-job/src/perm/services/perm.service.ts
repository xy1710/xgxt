/**
 * 权限管理模块 · 领域服务
 *
 * 把「查询数据库 → 组装成契约要求的形状」这类逻辑集中在这里，
 * 路由文件只负责：校验参数 → 调服务 → 包响应。
 *
 * ⚠️ 权限模型：模块 → 功能点 → 动作
 *    t_perm_menu          功能点
 *    t_perm_menu_action   动作
 *    t_perm_role_perm     职位已授权的（功能点，动作）
 */

import { randomUUID } from 'crypto';
import {
  DataScope,
  PermModule,
  PermItem,
  PermActionItem,
  PermTreeStats,
  RolePermMap,
  LogResult,
  PermLog,
  PERM_BASE_ACTION_NAME,
} from 'shared-types/perm';
import { db } from '../utils/db';
// ★ 2026-10-20：日志里的 `operator_id` 是【门户账号 id】，职位名在 sms_portal.t_sys_account.title
//   （与 sms_perm.t_perm_user 不是一张表，详见 portalTitleByAccountIds 的注释）
import { db as portalDb } from '../../portal/utils/db';

/* ============================================================
 * 一、权限树
 * ============================================================ */

/**
 * 读取完整权限树（8 模块 / 53 个顶级功能点 / 185 动作）
 * ⚠️ 带 60 秒内存缓存：权限树很少变，避免每个请求都打两次库。
 */
let treeCache: { at: number; data: PermModule[] } | null = null;
const TREE_TTL = 60 * 1000;

export function clearTreeCache(): void {
  treeCache = null;
}

export async function loadModules(force = false): Promise<PermModule[]> {
  if (!force && treeCache && Date.now() - treeCache.at < TREE_TTL) {
    return treeCache.data;
  }

  const menus = await db('t_perm_menu')
    .where('is_deleted', false)
    .orderBy([{ column: 'module_sort' }, { column: 'item_sort' }]);

  const actions = await db('t_perm_menu_action')
    .where('is_deleted', false)
    .orderBy('action_sort');

  const actByMenu = new Map<string, PermActionItem[]>();
  for (const a of actions) {
    const list = actByMenu.get(a.menu_id) || [];
    list.push({
      actionCode: a.action_code,
      actionName: a.action_name,
      baseAction: a.base_action,
      baseActionName:
        PERM_BASE_ACTION_NAME[a.base_action] || String(a.base_action),
      remark: a.remark || undefined,
    });
    actByMenu.set(a.menu_id, list);
  }

  const modMap = new Map<string, PermModule>();
  for (const m of menus) {
    let mod = modMap.get(m.module_key);
    if (!mod) {
      mod = {
        moduleKey: m.module_key,
        moduleName: m.module_name,
        moduleIcon: m.module_icon || '',
        sortNo: m.module_sort,
        items: [],
        itemCount: 0,
      };
      modMap.set(m.module_key, mod);
    }
    const item: PermItem = {
      id: m.id,
      itemName: m.item_name,
      parentItemName: m.parent_item_name || undefined,
      actions: actByMenu.get(m.id) || [],
      remark: m.remark || undefined,
      /**
       * ★ 2026-10-19：标记「用户自建」。
       * ⚠️ 老库没有 is_custom 列时这里取到 undefined → 一律按预置处理（只读），
       *    这是安全的降级方向：不会误让预置权限可删。
       */
      isCustom: !!m.is_custom,
    };
    mod.items.push(item);
    mod.itemCount = (mod.itemCount || 0) + 1;
  }

  const data = Array.from(modMap.values()).sort((a, b) => a.sortNo - b.sortNo);
  treeCache = { at: Date.now(), data };
  return data;
}

/**
 * 权限树整体统计
 *
 * ⚠️ 两个口径必须分开算，对齐原型 treeStats()：
 *    · itemCount   —— 只算【顶级功能点】（parent_item_name 为空）。
 *                     二级功能点归属其父项，不单独计数。
 *                     例：审批中心「教质/学术审批」带 2 个子项，只算 1 个功能点。
 *    · actionCount —— 按【全部】功能点求和。
 *                     父项自身不挂动作（动作都在子项上），故不会重复计。
 */
export async function getTreeStats(): Promise<PermTreeStats> {
  const mods = await loadModules();
  let itemCount = 0;
  let actionCount = 0;
  mods.forEach((m) =>
    m.items.forEach((it) => {
      if (!it.parentItemName) itemCount += 1;
      actionCount += it.actions.length;
    }),
  );
  return { modCount: mods.length, itemCount, actionCount };
}

/* ============================================================
 * 二、职位权限
 * ============================================================ */

const permKey = (moduleKey: string, itemName: string) => `${moduleKey}||${itemName}`;

/** 读某职位的权限映射 */
export async function getRolePermMap(roleId: string): Promise<RolePermMap> {
  const rows = await db('t_perm_role_perm')
    .where({ role_id: roleId, is_deleted: false })
    .orderBy('create_time');

  const map: RolePermMap = {};
  for (const r of rows) {
    const key = permKey(r.module_key, r.item_name);
    if (!map[key]) map[key] = [];
    map[key].push(r.action_code);
  }
  return map;
}

/** 某职位的已授权动作总数 */
export async function countRolePerms(roleId: string): Promise<number> {
  const rows = await db('t_perm_role_perm')
    .where({ role_id: roleId, is_deleted: false })
    .count({ n: '*' });
  return Number(rows[0]?.n || 0);
}

/**
 * 全量覆盖保存某职位的权限
 * ⚠️ 应用权限为全量覆盖（非增量合并）：先按 role_id 清空，再插入。
 */
export async function replaceRolePerms(
  roleId: string,
  perms: RolePermMap,
  operatorId: string,
): Promise<number> {
  const mods = await loadModules();
  const menuOf = new Map<string, { id: string; moduleKey: string; itemName: string; acts: Map<string, { name: string; base: number }> }>();
  mods.forEach((m) =>
    m.items.forEach((it) => {
      menuOf.set(permKey(m.moduleKey, it.itemName), {
        id: it.id,
        moduleKey: m.moduleKey,
        itemName: it.itemName,
        acts: new Map(it.actions.map((a) => [a.actionCode, { name: a.actionName, base: a.baseAction }])),
      });
    }),
  );

  const rows: Record<string, unknown>[] = [];
  Object.keys(perms || {}).forEach((key) => {
    const menu = menuOf.get(key);
    if (!menu) return; // 忽略不认识的功能点，防止脏数据入库
    const codes = Array.from(new Set(perms[key] || []));
    codes.forEach((code) => {
      const act = menu.acts.get(code);
      if (!act) return; // 忽略不认识的动作
      rows.push({
        id: randomUUID(),
        role_id: roleId,
        menu_id: menu.id,
        module_key: menu.moduleKey,
        item_name: menu.itemName,
        action_code: code,
        action_name: act.name,
        base_action: act.base,
        is_deleted: false,
        create_time: new Date(),
        create_by: operatorId,
      });
    });
  });

  await db.transaction(async (trx) => {
    await trx('t_perm_role_perm').where({ role_id: roleId }).del();
    if (rows.length) {
      // 分片插入，避免单条 SQL 过大
      const CHUNK = 200;
      for (let i = 0; i < rows.length; i += CHUNK) {
        await trx('t_perm_role_perm').insert(rows.slice(i, i + CHUNK));
      }
    }
    await trx('t_perm_role').where({ id: roleId }).update({
      perm_count: rows.length,
      update_time: new Date(),
      update_by: operatorId,
    });
  });

  return rows.length;
}

/* ============================================================
 * 三、账号权限（多职位取并集）
 * ============================================================ */

/**
 * 取某账号全部职位的权限并集
 *
 * ⚠️⚠️ 2026-10-03 修正：权限串里的【动作段改用 action_code（英文编码）】
 *
 * 改造前形如 `['market:预到校名单:查看', ...]`（动作名用中文）。
 * 问题：各模块的 checkPermission() 写的是英文动作编码，例如
 *     perm 模块 → checkPermission('perm:权限配置:editPerm')
 *   而库里 editPerm 这个动作的中文名是「编辑权限」，
 *   于是拼出来的串是 'perm:权限配置:编辑权限' ≠ 'perm:权限配置:editPerm'，
 *   永远匹配不上 → 模块负责人保存权限一律 403（实测复现）。
 *
 * 修正后形如 `['market:预到校名单:view', 'perm:权限配置:editPerm', ...]`，
 * 与各模块 checkPermission() 的书写口径完全一致，也与 JWT 里
 * permissions 字段「只放机器可判定的编码」这一约定一致。
 *
 * @returns permissions 去重后的权限点数组（动作段为 action_code）
 *          dataScope   取所有职位中最宽的一档
 */
export async function getUserEffectivePerms(userId: string): Promise<{
  roleIds: string[];
  permissions: string[];
  dataScope: DataScope;
}> {
  const links = await db('t_perm_user_role').where({ user_id: userId, is_deleted: false });
  const roleIds = links.map((l: any) => l.role_id);
  if (!roleIds.length) {
    return { roleIds: [], permissions: [], dataScope: DataScope.SELF };
  }

  const rows = await db('t_perm_role_perm')
    .whereIn('role_id', roleIds)
    .andWhere('is_deleted', false);

  const set = new Set<string>();
  let widest = DataScope.SELF;
  for (const r of rows) {
    // ⚠️ 动作段用 action_code，不用 action_name
    set.add(`${r.module_key}:${r.item_name}:${r.action_code}`);
    const scope = SCOPE_ACTION_TO_VALUE[r.action_code];
    if (scope && scope > widest) widest = scope;
  }

  return { roleIds, permissions: Array.from(set), dataScope: widest };
}

/** 行级数据范围动作 → 数据范围枚举值 */
export const SCOPE_ACTION_TO_VALUE: Record<string, DataScope> = {
  scopeSelf: DataScope.SELF,
  scopeClass: DataScope.CLASS,
  scopeDept: DataScope.DEPT,
  scopeAll: DataScope.ALL,
};

/* ============================================================
 * 三之二、门户账号 ↔ 权限库账号 的桥接（2026-10-03 新增）
 *
 * ⚠️⚠️ 为什么需要这一层：
 *    本系统里存在【两张账号表】：
 *      · t_sys_account（门户 sms_portal 库）—— 登录唯一凭据，7 个种子账号
 *      · t_perm_user  （权限 sms_perm 库）  —— 职位 / 权限 / 数据范围，15 个种子账号
 *    两张表【没有共用主键】，只能靠 `account`（登录名）对齐。
 *    实测：两张表原本只有 admin 一个账号重合 —— 所以「权限分配」保存的数据
 *    在财务 / 咨询模块里根本读不到，这正是用户说的「权限分配没生效」。
 *
 *    本模块是权限数据的【单一事实来源】，所以由本模块负责：
 *      登录名 → t_perm_user.id → 职位并集 → 有效权限点 + 数据范围
 *    并把「按模块算出来的可见页面」交给各业务模块消费。
 * ============================================================ */

/**
 * ⭐ 2026-10-16 新增：把密码同步到【门户登录表】（`sms_portal`.t_sys_account）
 *
 * 【为什么必须同步】
 *   用户报障：「在账号管理里给陈晓峰设了密码，用新密码登不进系统」。
 *   真因就是上面那两张账号表：门户登录只校验 `t_sys_account.password`
 *   （见 portal/services/account.service.ts 的 login），
 *   而「账号管理 / 重置密码 / 编辑账号」写的是 `t_perm_user.password` ——
 *   两边各写各的，改了业务表完全不影响登录，用户自然进不来。
 *
 * 【口径】本模块是账号的维护方，门户表是登录凭据的【镜像】：
 *   凡本模块改了 t_perm_user.password，就同步一份到同登录名的门户账号。
 *   （反方向——登录人自助改密——由门户那边负责同步，见
 *     portal/services/account.service.ts 的 changeOwnPassword）
 *
 * 【跨库写法】与 class / consult 模块一致：同一个连接里用全限定表名跨库读写。
 *
 * @returns true = 门户表里确实有这个登录名并已更新；
 *          false = 门户表里没有这个账号（没同步 —— 这个人也就登不进门户）
 * @remarks 门户库连不上等异常【不抛错】，只打 warn ——「改密码」不该被门户抖动连累。
 */
export async function syncPortalPassword(account: string, password: string): Promise<boolean> {
  if (!account || !password) return false;
  const portalDb = process.env.DB_NAME_PORTAL || 'sms_portal';
  try {
    const res: any = await db.raw(
      `UPDATE \`${portalDb}\`.t_sys_account
          SET password = ?, update_time = NOW()
        WHERE account = ? AND is_deleted = 0`,
      [password, account],
    );
    const affected = Number(res?.[0]?.affectedRows ?? 0);
    if (!affected) {
      // 常见坑：t_perm_user 有、t_sys_account 没有 → 这个人永远登不进门户
      console.warn(`[perm] 门户账号表里没有登录名「${account}」，密码未同步（该账号无法登录）`);
      return false;
    }
    return true;
  } catch (e: any) {
    console.warn(`[perm] 同步门户登录密码失败（account=${account}）：${e?.message || e}`);
    return false;
  }
}

/**
 * 门户账号的简要信息（登录名 → 可访问模块 / 启用状态）
 */
export interface PortalAccountBrief {
  /** 门户账号 id */
  id: string;
  /** 可访问模块 key 数组（如 ['class']） */
  modules: string[];
  /** 是否启用 */
  active: boolean;
}

/** 解析门户表里的 modules 列（库里存 JSON 字符串，兼容逗号分隔的老数据） */
function parsePortalModules(raw: any): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String);
  try {
    const arr = JSON.parse(String(raw));
    if (Array.isArray(arr)) return arr.map(String);
  } catch {
    /* 退回逗号分隔 */
  }
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 批量取门户账号信息
 *
 * ⚠️ 列表页 / 编辑表单要回显「这个账号登录后能进哪些模块」，
 *    所以按【登录名】批量查一次，避免每行一次跨库查询。
 */
export async function getPortalAccounts(accounts: string[]): Promise<Map<string, PortalAccountBrief>> {
  const out = new Map<string, PortalAccountBrief>();
  const list = Array.from(new Set((accounts || []).filter(Boolean)));
  if (!list.length) return out;
  const portalDb = process.env.DB_NAME_PORTAL || 'sms_portal';
  try {
    const res: any = await db.raw(
      `SELECT id, account, modules, active FROM \`${portalDb}\`.t_sys_account
        WHERE is_deleted = 0 AND account IN (${list.map(() => '?').join(',')})`,
      list,
    );
    const rows: any[] = Array.isArray(res?.[0]) ? res[0] : [];
    for (const r of rows) {
      if (!r?.account) continue;
      out.set(String(r.account), {
        id: String(r.id),
        modules: parsePortalModules(r.modules),
        active: !!r.active,
      });
    }
  } catch (e: any) {
    console.warn(`[perm] 读取门户账号失败：${e?.message || e}`);
  }
  return out;
}

/**
 * ⭐ 2026-10-16 新增：开通 / 更新【门户登录账号】
 *
 * 【为什么需要】
 *   门户登录要求 t_sys_account 里同时具备两样东西：**账号本身 + 至少一个可访问模块**
 *   （见 portal/services/account.service.ts 的 login：visibleModules 为空直接拒绝）。
 *   而「权限管理 → 账号管理」过去只写 t_perm_user ——
 *   结果【在账号管理里新建的账号，天生登不进系统】。
 *
 * 【口径】
 *   · 门户已有同登录名 → 只更新传进来的字段（密码 / 姓名 / 手机 / 部门 / 模块）；
 *     ⚠️ 没传 password 就【绝不动】现有密码（避免悄悄改掉一个还能用的登录密码）；
 *   · 门户没有 → 用这些字段新建一个门户账号（kind = module_owner、启用）。
 *     新建时的密码：password → passwordIfCreating → 环境变量默认值；
 *     连模块都没给就不建（建了也登不进去，白白多一条脏数据）。
 *
 * @returns existed 门户原本就有 / created 这次新建 / updated 这次改动了
 * @remarks 门户库异常只 warn 不抛错 —— 不能因为门户抖动连「建账号」都做不了。
 */
export async function upsertPortalAccount(input: {
  account: string;
  userName?: string;
  password?: string;
  /** 仅在【新建门户账号】时使用的密码（已有账号时不会拿它去覆盖） */
  passwordIfCreating?: string;
  phone?: string;
  dept?: string;
  modules?: string[];
}): Promise<{ existed: boolean; created: boolean; updated: boolean }> {
  const account = String(input.account || '').trim();
  if (!account) return { existed: false, created: false, updated: false };
  const portalDb = process.env.DB_NAME_PORTAL || 'sms_portal';
  const modules = (input.modules || []).filter(Boolean);

  try {
    const res: any = await db.raw(
      `SELECT id FROM \`${portalDb}\`.t_sys_account WHERE account = ? AND is_deleted = 0 LIMIT 1`,
      [account],
    );
    const found: any = Array.isArray(res?.[0]) ? res[0][0] : undefined;

    if (found?.id) {
      // ---- 已有门户账号：只改明确传进来的字段 ----
      const patch: Record<string, any> = {};
      if (input.password) patch.password = input.password;
      if (input.userName) patch.user_name = input.userName;
      if (input.phone) patch.phone = input.phone;
      if (input.dept) patch.dept = input.dept;
      if (modules.length) patch.modules = JSON.stringify(modules);
      if (!Object.keys(patch).length) return { existed: true, created: false, updated: false };
      patch.update_time = new Date();
      const keys = Object.keys(patch);
      // ⚠️ 列名手写不可能，但这里必须显式加反引号 ——
      //    所以拼在字符串里（不用模板串），顺手避免 `update` 之类的保留字炸掉 SQL
      const setSql = keys.map((k) => '`' + k + '` = ?').join(', ');
      await db.raw(
        `UPDATE \`${portalDb}\`.t_sys_account SET ${setSql} WHERE id = ?`,
        [...keys.map((k) => patch[k]), found.id],
      );
      return { existed: true, created: false, updated: true };
    }

    // ---- 门户里没有：必须有模块才建（否则建了也登不进去）----
    if (!modules.length) {
      console.warn(`[perm] 门户没有登录名「${account}」且未指定模块 → 未开通登录`);
      return { existed: false, created: false, updated: false };
    }
    const pwd = input.password || input.passwordIfCreating || process.env.DEFAULT_ACCOUNT_PASSWORD || '123456';
    await db.raw(
      `INSERT INTO \`${portalDb}\`.t_sys_account
         (id, create_time, create_by, create_by_name, is_deleted,
          account, password, user_name, kind, title, dept, phone, modules, active, last_login)
       VALUES (?, NOW(), 'perm-sync', '权限管理', 0, ?, ?, ?, 'module_owner', NULL, ?, ?, ?, 1, NULL)`,
      [
        randomUUID(),
        account,
        pwd,
        input.userName || account,
        input.dept || null,
        input.phone || null,
        JSON.stringify(modules),
      ],
    );
    return { existed: false, created: true, updated: false };
  } catch (e: any) {
    console.warn(`[perm] 开通/更新门户登录账号失败（account=${account}）：${e?.message || e}`);
    return { existed: false, created: false, updated: false };
  }
}

/**
 * ⭐ 2026-10-16 新增：同步门户账号的【启用状态】
 *
 * 【为什么】「账号管理 → 停用」过去只改 t_perm_user.user_status，
 *   门户登录表那边 active 仍是 1 —— 结果【被停用的人照样能登进系统】。
 *
 * @returns true = 门户账号确实被改了；false = 门户没这个登录名 / 库异常
 */
export async function setPortalAccountActive(account: string, active: boolean): Promise<boolean> {
  return updatePortalByAccount(account, { active: active ? 1 : 0 });
}

/**
 * ⭐ 2026-10-16 新增：账号被删除时【作废门户登录账号】
 *
 * 与权限库同一步调：登录名加 `#DEL#` 后缀 + 逻辑删除 + 停用。
 * 改名是为了把【唯一键腾出来】—— 否则以后用同一个登录名新建账号会撞唯一索引。
 *
 * @param renamedAccount 与权限库同规则改出来的新登录名（不传则只做作废标记）
 */
export async function retirePortalAccount(account: string, renamedAccount?: string): Promise<boolean> {
  const patch: Record<string, any> = { is_deleted: 1, active: 0 };
  if (renamedAccount) patch.account = String(renamedAccount).slice(0, 50);
  return updatePortalByAccount(account, patch);
}

/** 按登录名更新门户账号（内部工具，只改传进来的列） */
async function updatePortalByAccount(account: string, patch: Record<string, any>): Promise<boolean> {
  const acc = String(account || '').trim();
  if (!acc) return false;
  const keys = Object.keys(patch);
  if (!keys.length) return false;
  const portalDb = process.env.DB_NAME_PORTAL || 'sms_portal';
  try {
    // ⚠️ 列名必须显式加反引号 → 拼在普通字符串里（不放进模板串，免得转义炸掉）
    const setSql = keys.map((k) => '`' + k + '` = ?').join(', ');
    const res: any = await db.raw(
      `UPDATE \`${portalDb}\`.t_sys_account SET ${setSql}, update_time = NOW()
        WHERE account = ? AND is_deleted = 0`,
      [...keys.map((k) => patch[k]), acc],
    );
    const n = Number(res?.[0]?.affectedRows ?? 0);
    if (!n) console.warn(`[perm] 门户账号表里没有可更新的登录名「${acc}」（状态未同步）`);
    return n > 0;
  } catch (e: any) {
    console.warn(`[perm] 同步门户账号状态失败（account=${acc}）：${e?.message || e}`);
    return false;
  }
}

/**
 * ⭐ 2026-10-16 新增：查这个账号在【业务表】里还被谁引用
 *
 * 用途：账号删除规则 ——「有业务数据关联时不可删除 / 不可停用」。
 *
 * 【为什么跨库】业务表存的是【门户账号 id】（`sms_portal`.t_sys_account.id，UUID），
 *   权限库这边只有登录名 —— 所以先按登录名换出门户 id，再去业务表数引用。
 *
 * 【口径】只算【当前仍挂着】的引用（未删除的班级师资），**不含历史**（如交接记录的 from/to）——
 *   否则几乎谁都删不掉。以后哪个模块再把人挂到业务表上，往下面清单里加一行即可。
 *
 * @returns 中文描述数组，例如 ['大学部班级 2 个班级的师资']；无关联返回 []
 */
export async function accountBusinessRefs(account: string): Promise<string[]> {
  const refs: string[] = [];
  const acc = String(account || '').trim();
  if (!acc) return refs;
  const portalDb = process.env.DB_NAME_PORTAL || 'sms_portal';
  try {
    const r: any = await db.raw(
      `SELECT id FROM \`${portalDb}\`.t_sys_account WHERE account = ? AND is_deleted = 0 LIMIT 1`,
      [acc],
    );
    const row: any = Array.isArray(r?.[0]) ? r[0][0] : undefined;
    const uid = row?.id;
    if (!uid) return refs;

    /** 业务表里的人列清单：[库, 表, [列...], 中文说明] */
    const checks: Array<[string, string, string[], string]> = [
      [
        'sms_class',
        't_class_info',
        ['head_teacher_id', 'teacher_id', 'assistant_id', 'project_manager_id', 'employment_teacher_id'],
        '大学部班级',
      ],
      ['sms_class_jh', 't_class_info', ['head_teacher_id', 'teacher_id', 'assistant_id'], '初高班级'],
    ];

    for (const [d, t, cols, label] of checks) {
      const where = cols.map((c) => `\`${c}\` = ?`).join(' OR ');
      const res: any = await db.raw(
        `SELECT COUNT(*) AS n FROM \`${d}\`.\`${t}\` WHERE is_deleted = 0 AND (${where})`,
        cols.map(() => uid),
      );
      const n = Number((Array.isArray(res?.[0]) ? res[0][0] : undefined)?.n || 0);
      if (n > 0) refs.push(`${label} ${n} 个班级的师资`);
    }
  } catch (e: any) {
    console.warn(`[perm] 查账号业务关联失败（account=${acc}）：${e?.message || e}`);
  }
  return refs;
}

/** 账号档案（按登录名解析出来的权限全景） */
export interface AccountPermProfile {
  /** 是否在权限库中找到该账号 */
  found: boolean;
  /** 权限库里的用户 id（如 U013）；未找到时为空串 */
  permUserId: string;
  /** 登录名 */
  account: string;
  /** 姓名（权限库口径，未找到时为空串） */
  userName: string;
  /** 部门 id（如 D_FIN） */
  deptId: string;
  /** 部门中文名 */
  deptName: string;
  /** 用户状态：正常 / 已停用 / 已锁定 */
  userStatus: string;
  /** 职位编码数组（如 ['FIN_STAFF']） */
  roles: string[];
  /** 职位中文名数组（如 ['财务']） */
  roleNames: string[];
  /** 有效权限点，形如 ['fin:账单明细:查看'] */
  permissions: string[];
  /** 数据范围：1 本人 / 2 本班 / 3 本部门 / 4 全部 */
  dataScope: DataScope;
  /**
   * ⭐ 权限库里的模块 key → 该账号在该模块下有权限的功能点名
   *    例：{ fin: ['账单明细','退费名单'], market: ['学生档案'] }
   *
   * ⚠️ 这是给各业务模块算「可见页面」用的原料。
   *    权限库的模块 key（market / teach / fin / perm…）与门户的模块 key
   *    （consult / finance / perm）是【两套编码】，映射关系见 MODULE_PERM_TO_PORTAL。
   */
  moduleItems: Record<string, string[]>;
}

/** 权限库模块 key → 门户模块 key（两套编码的桥） */
export const MODULE_PERM_TO_PORTAL: Record<string, string> = {
  market: 'consult', // 市场咨询 → 门户 consult（8001）
  fin: 'finance', // 财务管理 → 门户 finance（8005）
  perm: 'perm', // 权限管理 → 门户 perm（8006）
  // 以下模块本期未接入门户，先留映射位，便于后续扩展：
  teach: 'teach',
  train: 'train',
  job: 'job',
  acad: 'acad',
  approve: 'approve',
};

/**
 * 按登录名取「权限全景档案」
 *
 * ⚠️ 查不到账号时【不抛错】，而是返回 found:false 的空档案 ——
 *    调用方（登录流程 / 鉴权中间件）需要自己决定兜底策略，
 *    这里不替它做决定（与 perm.client.ts 的降级哲学一致）。
 *
 * @param account 登录名（如 liukj / admin）
 */
export async function getAccountPermProfile(account: string): Promise<AccountPermProfile> {
  const empty: AccountPermProfile = {
    found: false,
    permUserId: '',
    account,
    userName: '',
    deptId: '',
    deptName: '',
    userStatus: '',
    roles: [],
    roleNames: [],
    permissions: [],
    dataScope: DataScope.SELF,
    moduleItems: {},
  };

  if (!account) return empty;

  const row = await db('t_perm_user').where({ account, is_deleted: false }).first();
  if (!row) return empty;

  const dept = row.dept_id
    ? await db('t_perm_dept').where({ id: row.dept_id }).first()
    : null;

  const links = await db('t_perm_user_role').where({ user_id: row.id, is_deleted: false });
  const roleIds = links.map((l: any) => l.role_id);
  const roles = roleIds.length
    ? await db('t_perm_role').whereIn('id', roleIds).andWhere('is_deleted', false)
    : [];

  // ---- 权限点 + 数据范围（多职位并集去重）----
  const { permissions, dataScope } = await getUserEffectivePerms(row.id);

  // ---- ⭐ 按模块聚合功能点（供各业务模块算可见页面）----
  const rpRows: any[] = roleIds.length
    ? await db('t_perm_role_perm').whereIn('role_id', roleIds).andWhere('is_deleted', false)
    : [];
  const moduleItems: Record<string, string[]> = {};
  for (const rp of rpRows) {
    const list = moduleItems[rp.module_key] || (moduleItems[rp.module_key] = []);
    if (!list.includes(rp.item_name)) list.push(rp.item_name);
  }

  return {
    found: true,
    permUserId: row.id,
    account: row.account,
    userName: row.user_name,
    deptId: row.dept_id || '',
    deptName: dept?.dept_name || '—',
    userStatus: row.user_status,
    roles: roles.map((r: any) => r.role_code),
    roleNames: roles.map((r: any) => r.role_name),
    permissions,
    dataScope,
    moduleItems,
  };
}

/* ============================================================
 * 四、操作日志
 * ============================================================ */

export interface AddLogInput {
  operatorId?: string;
  operatorName?: string;
  operatorRole?: string;
  moduleName: string;
  actionType: string;
  targetObj?: string;
  beforeValue?: string;
  afterValue?: string;
  ip?: string;
  result?: LogResult | string;
}

/**
 * 职位编码 / 门户级编码 / 用户 id → 中文职位名
 * ============================================================================
 *
 * 【为什么需要这一步】
 *   `req.user.roles` 里装的是【职位编码】（SYS_ADMIN / MKT_CONSULT / TEACH_HEAD），
 *   而操作日志是给人看的，应该记中文职位名（系统管理员 / 咨询老师 / 班主任）。
 *   种子数据里预置的日志用的就是中文名，写入时不转换 →
 *   日志列表里就会出现「系统管理员 · SYS_ADMIN」这种中英混杂的行。
 *
 * 【★★ 2026-10-20 第二版：光有 role_code 映射还不够】
 *   用户截图指出「操作日志 → 所属职位」整列显示 `SYS_STAFF`（英文），
 *   要求按「账号管理」那种中文胶囊显示。查库后原因有两层：
 *
 *   ① 门户登录签发的 token 里 `roles` **只有粗粒度身份**：
 *        SYS_ADMIN（管理员）/ SYS_STAFF（其余全部）—— 见 class/middleware/auth.ts 的注释。
 *      也就是说「登录者到底挂哪个职位」**根本不在 token 里**。
 *   ② `SYS_STAFF` 在 `t_perm_role` 里**没有对应行**（它不是业务职位），
 *      所以老的 `map.get(p) || p` 兜底把它原样留成了英文；
 *      `operator_role` 为空的行同理（写日志时没传）也留成空。
 *
 * 【现在的口径】逐级降级，六级兜底：
 *   ① 中文片段 → 原样保留（种子数据 / 老日志已经是中文的，不要去查库改它）；
 *   ② 业务职位编码 → 查 `t_perm_role.role_code` 换成中文名；
 *   ③ 剩下的（门户级编码 / 全空）→ 按 operator_id 查 `t_perm_user_role`；
 *   ④ 再按 operator_name 查 `t_perm_user` 的职位（门户 id 与权限库 id 不是一套，
 *      姓名才是唯一连接键；「账号管理」页显示的正是这套，两边要对得上）；
 *   ⑤ 还查不到 → 按 operator_id 查 `t_sys_account.title`（只存在于门户的账号，
 *      如张老师 / 刘会计，权限库里没有对应人）；
 *   ⑥ 最后 → 给门户级编码一个中文兜底名（系统管理员 / 普通职员 / 服务账号），
 *      绝不把 `SYS_STAFF` 这种英文丢到界面上。
 *
 * 【读写两侧共用】
 *   · 写：`addLog()` 里 `toRoleNames(raw, operatorId)` —— 新日志直接落中文；
 *   · 读：`resolveLogRoleLabels(rows)` —— **老日志（库里已是 SYS_STAFF / 空）也能正确显示**，
 *     而且一页 20 条只查 2 次库（先按编码批量查、再按账号批量查），不会 N+1。
 */

/** 门户级编码：只是「管理员 / 普通职员 / 服务账号」的粗粒度身份，不是业务职位 */
const PORTAL_LEVEL_ROLE_CODES = new Set(['SYS_ADMIN', 'SYS_STAFF', 'ROLE_SERVICE']);

/** 门户级编码的中文兜底（只有在查不到这个人真实职位时才用） */
const PORTAL_LEVEL_ROLE_LABELS: Record<string, string> = {
  SYS_ADMIN: '系统管理员',
  SYS_STAFF: '普通职员',
  ROLE_SERVICE: '服务账号',
};

/** 形如职位编码：全大写字母 / 数字 / 下划线 */
const isRoleCode = (s: string) => /^[A-Z][A-Z0-9_]*$/.test(s);

/** 「A、B」→ ['A','B'] */
const splitRoleText = (raw?: string | null) =>
  (raw || '')
    .split('、')
    .map((s) => s.trim())
    .filter(Boolean);

/** 职位编码 → 中文名（一次批量，空 map 表示一个都没命中） */
async function roleNameByCodes(codes: string[]): Promise<Map<string, string>> {
  if (!codes.length) return new Map();
  try {
    const rows = (await db('t_perm_role')
      .whereIn('role_code', [...new Set(codes)])
      .where('is_deleted', false)
      .select('role_code', 'role_name')) as { role_code: string; role_name: string }[];
    return new Map(rows.map((r) => [r.role_code, r.role_name]));
  } catch {
    // 查库失败不能把日志丢掉，交给下一级兜底
    return new Map();
  }
}

/**
 * 操作人 → 中文职位名的**首选**来源：门户账号表 `t_sys_account.title`
 *
 * 【为什么不是 t_perm_user —— 这个坑必须记住】
 *   操作日志的 `operator_id` 是【门户账号 id】（`t_sys_account.id`，UUID 形如 43575dc6-…），
 *   而「账号管理」页那套 `t_perm_user` 的主键是 `U001` / `U_chenxf` 这种短 id
 *   —— **两套账号不是同一张表**（门户账号在 sms_portal，权限账号在 sms_perm）。
 *   第一版按 t_perm_user 查，一行都查不到（林晓在 t_perm_user 里是 U021，
 *   日志里却是那个 UUID），表现为「按操作人兜底完全不生效」。
 *   门户账号自己就带 `title`（权限管理员 / 教员 / 项目经理 / 财务 …），
 *   正是界面上该显示的「所属职位」。
 */
async function portalTitleByAccountIds(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!ids.length) return out;
  try {
    const rows = (await portalDb('t_sys_account')
      .whereIn('id', [...new Set(ids)])
      .where('is_deleted', false)
      .select('id', 'title')) as { id: string; title: string | null }[];
    for (const r of rows) if (r.title) out.set(r.id, r.title);
  } catch {
    /* 查不到就走下一级 */
  }
  return out;
}

/** 二级兜底：`t_perm_user_role`（万一 operator_id 是权限库账号 U001 这种） */
async function roleNamesByUserIds(userIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!userIds.length) return out;
  try {
    const rows = (await db('t_perm_user_role as ur')
      .leftJoin('t_perm_role as r', 'ur.role_id', 'r.id')
      .whereIn('ur.user_id', [...new Set(userIds)])
      .where('ur.is_deleted', false)
      .where('r.is_deleted', false)
      .orderBy('r.sort_no', 'asc')
      .select('ur.user_id as userId', 'r.role_name as roleName')) as {
      userId: string;
      roleName: string;
    }[];
    for (const r of rows) {
      if (!r.roleName) continue;
      const arr = out.get(r.userId) || [];
      if (!arr.includes(r.roleName)) arr.push(r.roleName);
      out.set(r.userId, arr);
    }
  } catch {
    /* 同上，查不到就交给中文兜底 */
  }
  return out;
}

/**
 * 三级兜底：按**操作人姓名**匹配 `t_perm_user`，取其权限库职位
 *
 * ⚠️ 为什么还要按姓名匹配：
 *   日志的 `operator_id` 是门户账号 UUID，权限库账号主键是 U001 —— 两边 id 对不上；
 *   但两边**是同一批人**（孙敏 / 孙建龙 / 周杰 在两张表里都有），姓名是唯一可用的连接键。
 *   而「账号管理」页（用户点名要对照的那个页面）显示的正是 `t_perm_user` 这套职位，
 *   优先取它，操作日志与账号管理对同一个人才不会一个写「系统管理员」、一个写「权限管理员」。
 *   重名会取错 —— 本系统是内部系统且姓名唯一，可接受；真做大了应该加 operator_code。
 */
async function roleNamesByUserNames(names: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!names.length) return out;
  try {
    const rows = (await db('t_perm_user as u')
      .leftJoin('t_perm_user_role as ur', 'ur.user_id', 'u.id')
      .leftJoin('t_perm_role as r', 'ur.role_id', 'r.id')
      .whereIn('u.user_name', [...new Set(names)])
      .where('u.is_deleted', false)
      .where('ur.is_deleted', false)
      .where('r.is_deleted', false)
      .orderBy('r.sort_no', 'asc')
      .select('u.user_name as name', 'r.role_name as roleName')) as {
      name: string;
      roleName: string;
    }[];
    for (const r of rows) {
      if (!r.roleName) continue;
      const arr = out.get(r.name) || [];
      if (!arr.includes(r.roleName)) arr.push(r.roleName);
      out.set(r.name, arr);
    }
  } catch {
    /* 查不到就走下一级 */
  }
  return out;
}

/**
 * 统一解析入口（**写日志与读日志共用这一套口径**，避免两边各写一遍再走偏）
 *
 * 逐级降级：
 *   ① 中文片段 → 原样保留（种子数据 / 老日志已经是中文的，不去动它）；
 *   ② 业务职位编码 → `t_perm_role.role_code` 换成中文名；
 *   ③ 只剩门户级编码 / 全空 → 按 operator_id 查 `t_sys_account.title`；
 *   ④ 还查不到 → 按 operator_id 查 `t_perm_user_role`（兼容权限库账号）；
 *   ⑤ 最后给门户级编码一个中文兜底名，**绝不把 SYS_STAFF 这种英文丢到界面**。
 *
 * @returns 与入参等长；解析不出来给 `''`（界面显示「—」）
 */
async function resolveRoleLabels(
  rows: { operator_role?: string | null; operator_id?: string | null; operator_name?: string | null }[],
): Promise<string[]> {
  if (!rows.length) return [];

  // ①② 先按编码批量查一次
  const allCodes: string[] = [];
  for (const r of rows) allCodes.push(...splitRoleText(r.operator_role).filter(isRoleCode));
  const codeMap = await roleNameByCodes(allCodes);

  const labels = rows.map((r) =>
    splitRoleText(r.operator_role)
      .map((p) => (isRoleCode(p) ? codeMap.get(p) || '' : p))
      .filter(Boolean)
      .join('、'),
  );

  // ③④⑤ 仍然为空的行 → 按操作人现查（三张表各一次批量查，不 N+1）
  const need = rows.filter((_, i) => !labels[i]);
  const needIds = [...new Set(need.map((r) => r.operator_id).filter(Boolean).map(String))];
  const needNames = [...new Set(need.map((r) => r.operator_name).filter(Boolean).map(String))];
  const [byUser, byName, byAccount] = await Promise.all([
    roleNamesByUserIds(needIds),
    roleNamesByUserNames(needNames),
    portalTitleByAccountIds(needIds),
  ]);

  return rows.map((r, i) => {
    if (labels[i]) return labels[i];
    const id = r.operator_id ? String(r.operator_id) : '';
    const nm = r.operator_name ? String(r.operator_name) : '';

    // ③ 权限库职位（按 id）→ ④ 权限库职位（按姓名，与「账号管理」页口径一致）
    const permRoles = (id && byUser.get(id)) || (nm && byName.get(nm)) || [];
    if (permRoles.length) return permRoles.join('、');

    // ⑤ 门户账号自带的 title（张老师 / 刘会计 这类只存在于门户的账号）
    if (id && byAccount.get(id)) return byAccount.get(id) as string;

    // ⑥ 中文兜底，绝不把英文编码丢到界面
    return splitRoleText(r.operator_role)
      .map((p) => PORTAL_LEVEL_ROLE_LABELS[p] || '')
      .filter(Boolean)
      .join('、');
  });
}

/**
 * 写日志时用：把一段 `operatorRole`（可能是编码、可能是中文、可能空）解析成中文名
 * @param operatorId   门户账号 id —— 传了就能在只有 SYS_STAFF 时补出真实职位
 * @param operatorName 操作人姓名 —— 门户 id 与权限库 id 对不上时按姓名兜底
 */
async function toRoleNames(raw: string, operatorId?: string, operatorName?: string): Promise<string> {
  const [label] = await resolveRoleLabels([
    { operator_role: raw, operator_id: operatorId, operator_name: operatorName },
  ]);
  return label || '';
}

/**
 * 读日志时用（批量）：把一批日志行的 `operator_role` 解析成给人看的中文职位名
 * 一页 20 条只查 4 次库（编码 + 两种账号表 + 姓名），不会 N+1。
 */
export async function resolveLogRoleLabels(
  rows: { operator_role?: string | null; operator_id?: string | null; operator_name?: string | null }[],
): Promise<string[]> {
  return resolveRoleLabels(rows);
}

/**
 * 写一条操作日志
 * ⚠️ 权限变更、参数修改、账号启停必须留痕。
 *    日志写入失败不允许影响主流程，因此内部吞掉异常。
 */
export async function addLog(input: AddLogInput): Promise<void> {
  try {
    const now = new Date();
    await db('t_perm_log').insert({
      id: randomUUID(),
      log_time: now,
      operator_id: input.operatorId || 'system',
      operator_name: input.operatorName || '系统',
      operator_role: await toRoleNames(input.operatorRole || '', input.operatorId, input.operatorName),
      module_name: input.moduleName,
      action_type: input.actionType,
      target_obj: input.targetObj || '',
      before_value: input.beforeValue || '—',
      after_value: input.afterValue || '',
      ip: input.ip || '',
      result: input.result || LogResult.SUCCESS,
      is_deleted: false,
      create_time: now,
      create_by: input.operatorId || 'system',
    });
  } catch (e) {
    console.error('[addLog] 写日志失败（不影响主流程）:', (e as Error).message);
  }
}

/** 从请求里取来源 IP */
export function clientIp(req: any): string {
  return (
    (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress?.replace('::ffff:', '') ||
    ''
  );
}

/* ============================================================
 * 五、部门口径
 * ============================================================ */

/**
 * 部门层级常量（与 shared-types 的 DeptLevel 同值，这里只取用得到的两个）
 *   2 = 一级部门（校级直属：市场咨询部 / 教学部 / 就业部 …）
 *   3 = 下设子部门（教学部的 3 个学段、就业部的 实训管理 / 就业管理）
 */
const DEPT_LEVEL_DEPT = 2;
const DEPT_LEVEL_SUB = 3;

/**
 * 部门总数 = 校级直属的一级部门个数（不含校级本身，也不含下设子部门）。
 *
 * ★ 2026-10-20 口径调整：原来是「排除 D_ALL + 硬编码排除 3 个学段 id」。
 *   就业部并进来之后，下设子部门从 3 个变成 5 个（教学部 3 + 就业部 2），
 *   硬编码的 id 名单必然漏 —— 而且再挂一个子部门就要再改一次代码。
 *   改成按 dept_level 数：谁被挂到别的部门下，就自动不计入「部门总数」。
 */
export async function countDeptTotal(): Promise<number> {
  const rows = await db('t_perm_dept').where({
    is_deleted: false,
    dept_level: DEPT_LEVEL_DEPT,
  });
  return rows.length;
}

/** 下设子部门数（教学部的 初中部 / 高中部 / 大学部 + 就业部的 实训管理 / 就业管理） */
export async function countStageTotal(): Promise<number> {
  const rows = await db('t_perm_dept').where({
    is_deleted: false,
    dept_level: DEPT_LEVEL_SUB,
  });
  return rows.length;
}

/**
 * 部门下账号数：包含子部门
 * （教学部计入初中部/高中部/大学部的账号；就业部计入 实训管理 / 就业管理 的账号）
 */
export async function countUsersOfDept(deptId: string): Promise<number> {
  const all = await db('t_perm_dept').where('is_deleted', false).select('id', 'parent_id');
  const ids = collectDescendants(all, deptId);
  const rows = await db('t_perm_user')
    .where('is_deleted', false)
    .whereIn('dept_id', ids)
    .count({ n: '*' });
  return Number(rows[0]?.n || 0);
}

/** 收集某部门及其全部后代部门 id */
export function collectDescendants(
  all: { id: string; parent_id: string | null }[],
  rootId: string,
): string[] {
  const ids = [rootId];
  let changed = true;
  while (changed) {
    changed = false;
    all.forEach((d) => {
      if (d.parent_id && ids.includes(d.parent_id) && !ids.includes(d.id)) {
        ids.push(d.id);
        changed = true;
      }
    });
  }
  return ids;
}

/* ============================================================
 * 六、通用小工具
 * ============================================================ */

/** 手机号脱敏 138****4567 */
export function maskPhone(phone: string): string {
  if (!phone || phone.length < 7) return phone || '';
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

/** 取姓名首字做头像占位 */
export function avatarText(name: string): string {
  if (!name) return '?';
  return name.trim().charAt(0);
}

/** 把 role 中文名数组拼成展示串 */
export function joinRoleNames(names: string[]): string {
  return names.filter(Boolean).join('、');
}

/** 清空指定表（用于规则重置等） */
export async function delAll(table: string): Promise<void> {
  await db(table).del();
}

/** 读取某组规则为 key→value 的原始字符串映射 */
export async function getRuleRaw(group: string): Promise<Record<string, string>> {
  const rows = await db('t_perm_rule')
    .where({ rule_group: group, is_deleted: false })
    .orderBy('rule_sort');
  const out: Record<string, string> = {};
  rows.forEach((r: any) => {
    out[r.rule_key] = r.rule_value;
  });
  return out;
}

/** 职位权限数回填 */
export async function refreshRolePermCount(roleId: string): Promise<number> {
  const n = await countRolePerms(roleId);
  await db('t_perm_role').where({ id: roleId }).update({ perm_count: n });
  return n;
}

/** 该职位关联的账号数（★ 2026-10-16：只数有效账号，防止孤儿关联把人数撑大） */
export async function countRoleUsers(roleId: string): Promise<number> {
  const rows = await db('t_perm_user_role as ur')
    .join('t_perm_user as u', function (this: any) {
      this.on('u.id', 'ur.user_id').andOn('u.is_deleted', 0);
    })
    .where({ 'ur.role_id': roleId, 'ur.is_deleted': false })
    .count({ n: '*' });
  return Number(rows[0]?.n || 0);
}

export type { PermLog };
