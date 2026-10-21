/**
 * 页面管理 · 服务层
 *
 * ============================================================
 * 【职责】
 *   `sms_perm.t_perm_page` 一张表：一行 = 一个板块里的一个页面，
 *   `enabled` 列就是这个页面「该板块有没有」的开关。
 *
 * 【为什么表要「按注册表自动补齐」】
 *   页面清单的权威源是代码（config/pageRegistry.ts），不是这张表 ——
 *   表只存「开没开」。所以：
 *     · 库里没有的行 → 自动插入，默认 enabled = 1（新页面默认可见，行为不变）
 *     · 库里多出来的行（代码里删了这个页面）→ 逻辑删除，避免台账出现幽灵页
 *     · 库里已有的行 → **只更新标题/路径/排序等展示信息，绝不动 enabled**
 *       （否则重启一次服务，管理员刚取消的勾选就被悄悄恢复了）
 *
 * 【保存语义】按板块【全量覆盖】，与职位权限分配一致：
 *   先把该板块全部置 enabled=0，再把提交的那批置 1 —— 不会留下幽灵页面。
 * ============================================================
 */

import { randomUUID } from 'crypto';
import { db } from '../utils/db';
import type { PermPageBoard, PermPageItem } from 'shared-types/perm';
import { PAGE_REGISTRY, ALL_REGISTRY_PATHS, findRegistryBoard, pageCodesOf } from '../config/pageRegistry';

export const PAGE_TABLE = 't_perm_page';

/* ============================================================
 * 1. 建表 + 与注册表对齐（幂等，只跑一次）
 * ============================================================ */

let ensured: Promise<void> | null = null;

/** 建表 + 补数据；重复调用只执行一次（并发调用共享同一个 Promise） */
export function ensurePageTable(): Promise<void> {
  if (!ensured) {
    ensured = (async () => {
      await createTable();
      await syncRegistry();
    })().catch((e) => {
      // 失败要允许下次重试，否则一次网络抖动就永久不可用
      ensured = null;
      throw e;
    });
  }
  return ensured;
}

async function createTable(): Promise<void> {
  await db.raw(`
    CREATE TABLE IF NOT EXISTS \`${PAGE_TABLE}\` (
      \`id\` varchar(36) NOT NULL COMMENT '主键UUID',
      \`create_time\` datetime NOT NULL COMMENT '创建时间',
      \`create_by\` varchar(36) DEFAULT NULL COMMENT '创建人ID',
      \`update_time\` datetime DEFAULT NULL COMMENT '修改时间',
      \`update_by\` varchar(36) DEFAULT NULL COMMENT '修改人ID',
      \`is_deleted\` tinyint(1) NOT NULL DEFAULT 0 COMMENT '逻辑删除',
      \`module_key\` varchar(32) NOT NULL COMMENT '板块key（门户模块key）',
      \`module_name\` varchar(48) NOT NULL COMMENT '板块名',
      \`module_icon\` varchar(16) DEFAULT NULL COMMENT '板块图标',
      \`module_sort\` int NOT NULL DEFAULT 0 COMMENT '板块排序',
      \`page_key\` varchar(64) NOT NULL COMMENT '页面key（新模块=menuKey；legacy=权限码中段）',
      \`page_title\` varchar(64) NOT NULL COMMENT '页面标题',
      \`page_path\` varchar(128) NOT NULL COMMENT '路由path（板块内唯一）',
      \`page_code\` varchar(64) DEFAULT NULL COMMENT 'legacy模块的页面权限码',
      \`page_sort\` int NOT NULL DEFAULT 0 COMMENT '页面排序',
      \`enabled\` tinyint(1) NOT NULL DEFAULT 1 COMMENT '1=该板块有此页面',
      \`locked\` tinyint(1) NOT NULL DEFAULT 0 COMMENT '1=不可取消（防自锁）',
      \`remark\` varchar(255) DEFAULT NULL COMMENT '说明',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uk_module_path\` (\`module_key\`,\`page_path\`),
      KEY \`idx_module\` (\`module_key\`,\`page_sort\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='权限-板块页面台账'
  `);
}

/** 把注册表里的页面补进库里；库里多出来的标记删除。**不动 enabled**。 */
async function syncRegistry(): Promise<void> {
  const rows = await db(PAGE_TABLE).select('id', 'module_key', 'page_path', 'is_deleted');
  const known = new Map<string, any>();
  rows.forEach((r: any) => known.set(`${r.module_key}||${r.page_path}`, r));

  const now = new Date();
  const registryKeys = new Set<string>();

  for (const board of PAGE_REGISTRY) {
    for (let i = 0; i < board.pages.length; i += 1) {
      const p = board.pages[i];
      const key = `${board.moduleKey}||${p.path}`;
      registryKeys.add(key);

      const show = {
        // ⚠️ module_key / page_path 也要带上：UPDATE 时是无害的同值更新，
        //    但 INSERT 时它们是 NOT NULL 且没有默认值（漏了会报
        //    "Field 'module_key' doesn't have a default value"）。
        module_key: board.moduleKey,
        page_path: p.path,
        module_name: board.moduleName,
        module_icon: board.moduleIcon,
        module_sort: board.sortNo,
        page_key: p.key,
        page_title: p.title,
        /* ⚠️ page_code 是 varchar(64) 单值列，装不下多个码。
         *   合并页（pageCodes）只落第一个码 —— 这一列在库里仅作「这是哪个学段的页」的
         *   人肉线索，真正的可见性判定走注册表（pageCodesOf），不读这一列。
         *   所以取首值不会造成任何判定偏差。 */
        page_code: pageCodesOf(p)[0] ?? null,
        page_sort: i + 1,
        locked: p.locked ? 1 : 0,
        remark: p.remark ?? null,
        update_time: now,
        update_by: 'system',
        is_deleted: 0,
      };

      const exist = known.get(key);
      if (exist) {
        // ⚠️ 刻意不带 enabled —— 库里那列是管理员的选择，不能被同步覆盖
        await db(PAGE_TABLE).where('id', exist.id).update(show);
      } else {
        await db(PAGE_TABLE).insert({
          id: randomUUID(),
          create_time: now,
          create_by: 'system',
          ...show,
          enabled: 1,
        });
      }
    }
  }

  // 代码里已删除的页面 → 逻辑删除（台账不再显示）
  const stale = rows.filter(
    (r: any) => r.is_deleted === 0 && !registryKeys.has(`${r.module_key}||${r.page_path}`),
  );
  for (const r of stale) {
    await db(PAGE_TABLE).where('id', r.id).update({
      is_deleted: 1,
      update_time: now,
      update_by: 'system',
    });
  }
}

/* ============================================================
 * 2. 查询
 * ============================================================ */

/**
 * 读台账：以【注册表】为骨架（保证代码里新加的页面一定出现），
 * 用库里的 enabled 覆盖开关键。
 */
export async function loadPageBoards(): Promise<PermPageBoard[]> {
  await ensurePageTable();

  const rows = await db(PAGE_TABLE).where('is_deleted', false);
  const flagMap = new Map<string, boolean>();
  rows.forEach((r: any) => flagMap.set(`${r.module_key}||${r.page_path}`, !!r.enabled));

  return PAGE_REGISTRY.map<PermPageBoard>((board) => {
    const pages: PermPageItem[] = board.pages.map((p, i) => ({
      pageKey: p.key,
      pageTitle: p.title,
      pagePath: p.path,
      pageCode: p.pageCode,
      /* ★ 合并页把整组码也下发，前端要展示「这一页管哪几个学段」时用得上 */
      pageCodes: p.pageCodes,
      pageSort: i + 1,
      // 库里查不到（理论上不会）→ 按「有」处理，宁可多显示也不能凭空藏页面
      enabled: flagMap.get(`${board.moduleKey}||${p.path}`) !== false,
      locked: !!p.locked,
      remark: p.remark,
    }));
    const enabledCount = pages.filter((p) => p.enabled).length;
    return {
      moduleKey: board.moduleKey,
      moduleName: board.moduleName,
      moduleIcon: board.moduleIcon,
      moduleDesc: board.moduleDesc,
      legacy: board.legacy,
      total: pages.length,
      enabledCount,
      pages,
    };
  });
}

/**
 * 页面 path 的两个集合（给前端做菜单过滤 + 路由守卫）
 *
 *   allPaths —— 台账登记过的全部页面（**只有在这个集合里的 path 才受台账管**）
 *   paths    —— 其中已启用的那部分
 *
 * ⚠️ 为什么要一起返回 allPaths：
 *   前端要区分「这个 path 台账里没有（= 不受管，放行）」与
 *   「台账里有但被关了（= 该板块没这个页面，拦掉）」。
 *   只给已启用的那份是分不出来的 —— 会把所有未登记的 path 一起拦掉。
 */
export async function loadPathFlags(): Promise<{ paths: string[]; allPaths: string[] }> {
  const boards = await loadPageBoards();
  const allPaths = boards.flatMap((b) => b.pages.map((p) => p.pagePath));
  const paths = boards.flatMap((b) =>
    b.pages.filter((p) => p.enabled).map((p) => p.pagePath),
  );
  return { paths, allPaths };
}

/* ============================================================
 * 3. 保存（按板块全量覆盖）
 * ============================================================ */

export interface SavePagesResult {
  moduleKey: string;
  enabledCount: number;
  total: number;
}

export async function saveModulePages(
  moduleKey: string,
  enabledPaths: string[],
  operator: { id?: string; name?: string } = {},
): Promise<SavePagesResult> {
  const board = findRegistryBoard(moduleKey);
  if (!board) throw new Error(`未知板块：${moduleKey}`);
  await ensurePageTable();

  const validPaths = new Set(board.pages.map((p) => p.path));
  const lockedPaths = new Set(board.pages.filter((p) => p.locked).map((p) => p.path));

  // 只接受本板块的 path，避免误传别的板块的 path 把数据搅乱
  const wanted = new Set(
    enabledPaths.filter((p) => typeof p === 'string' && validPaths.has(p)),
  );
  // locked 页面强制保留（前端已禁用勾选，这里是后端兜底）
  lockedPaths.forEach((p) => wanted.add(p));

  const now = new Date();
  const rows = await db(PAGE_TABLE).where({ module_key: moduleKey, is_deleted: false });

  for (const r of rows as any[]) {
    const on = wanted.has(r.page_path) ? 1 : 0;
    if (!!r.enabled === !!on) continue; // 没变就不写，少一次 IO
    await db(PAGE_TABLE).where('id', r.id).update({
      enabled: on,
      update_time: now,
      update_by: operator.id || 'system',
    });
  }

  return { moduleKey, enabledCount: wanted.size, total: board.pages.length };
}

/** 全部恢复为「启用」（一键还原） */
export async function resetAllPages(operator: { id?: string; name?: string } = {}): Promise<number> {
  await ensurePageTable();
  const now = new Date();
  const affected = await db(PAGE_TABLE)
    .where({ is_deleted: false })
    .whereIn(
      'page_path',
      ALL_REGISTRY_PATHS,
    )
    .update({ enabled: 1, update_time: now, update_by: operator.id || 'system' });
  return Number(affected) || 0;
}
