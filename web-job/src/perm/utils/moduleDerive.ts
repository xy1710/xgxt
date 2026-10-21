/**
 * 「所选职位 → 门户可访问模块」推导（★ 2026-10-19 新增）
 *
 * ============================================================
 * 【为什么需要这个文件】
 *   「新建账号」过去要管理员手勾「可访问模块」（门户登录后能进哪几个模块），
 *   按用户要求把那一块勾选区删掉，改成**按所选职位自动推导**。
 *
 *   所以这里要回答一个问题：给定「这个职位在权限库里有哪些模块的功能点」，
 *   它应该拿到哪几个【门户模块】。
 *
 * ============================================================
 * 【⚠️ 最容易踩的坑：这是两套完全不同的模块 key，不能直接当同一套用】
 *
 *   实测（2026-10-19，本地库快照统计）：
 *
 *   ① 权限库 `sms_perm.t_perm_menu.module_key` —— 8 个，是**功能点分组**：
 *        market(市场咨询) / fin(财务管理) / perm(权限管理) / job(就业管理)
 *        / train(实训-教学) / acad(教务部门) / teach(教学部门) / approve(审批中心)
 *
 *   ② 门户模块 `shared-types/portal` 的 `ModuleKey` —— 7 个，是**登录后的入口**：
 *        consult(市场咨询) / finance(财务管理) / perm(权限管理) / job(就业管理)
 *        / edu(教务管理) / class(班级管理·大学部) / class-jh(教学管理·初高)
 *
 *   两套里**只有 `perm` 和 `job` 名字刚好一样**，其余全是「看着像、其实不等」：
 *   market≠consult、fin≠finance、acad≠edu、teach/train 都要拆到 class / class-jh。
 *   直接拿权限库的 key 当门户 key 写进 `t_sys_account.modules`，会被
 *   `account.service.ts` 的 `MODULES.filter(...)` 全部过滤掉 → 该账号 0 个可见模块
 *   → **登录直接被拒**。所以必须走下面这张显式映射表。
 *
 * ============================================================
 * 【映射表怎么来的 —— 不是拍脑袋，是拿存量数据对出来的】
 *
 *   依据 ①：`server-job/src/utils/permPointToPages.ts`（权限点→页面权限码的权威映射）
 *      · `train||实训-*`  → `job:*` 页面    ⇒ train 属于【就业】板块
 *      · `teach||教学-*`  → `class:*` 页面  ⇒ teach 属于【班级·大学部】板块
 *      · `acad||*`        → `edu:*` 页面    ⇒ acad 属于【教务】板块
 *      · `approve||*`     → 跨板块（job 的休退学/退费 + classjh 的教质审批），
 *        没有自己的门户模块 ⇒ approve 不单独给模块
 *
 *   依据 ②：本地库里 15 个账号「职位 → 实际 modules」的实测对照，结论一致。
 *
 *   ⚠️ 已知的口径损失：`teach`（教学部门）在存量数据里有的账号落 `class`、
 *      有的落 `class-jh`（如「班主任@大学部」→ class、「班主任@教学部」→ class-jh），
 *      而且**职位本身没有区分依据**（两个班主任是同一个职位）。所以这里采取
 *      「两个都给」：宁可多给一个模块入口（页面仍受职位页面权限逐页约束），
 *      也不要出现「建出来的账号少一个入口甚至登不进去」。
 *
 * ============================================================
 * 【两条兜底（保证「一定登得进去」是硬底线）】
 *   · 推导结果为空（例如某职位只勾了审批类功能点）→ 回退【全部模块】；
 *   · 推导结果 ≥ 6 个（跨板块角色，实测就是「校长」「系统管理员」）→ 直接【全部模块】，
 *     免得出现「能进 6 个板块的人偏偏进不去第 7 个」这种怪事。
 *
 * ============================================================
 */

/**
 * 门户模块 key 全集 —— 与 `shared-types/src/portal/portal.ts` 的 `MODULE_NAME` 保持一致。
 *
 * ⚠️ 这里只是**兜底用**的常量（正常情况下会用接口拉回来的模块列表当全集，
 *    见 `derivePortalModules` 的 `allKeys` 参数）。portal 侧新增模块时记得同步这里。
 */
export const PORTAL_MODULE_KEYS: readonly string[] = [
  'consult',
  'finance',
  'perm',
  'job',
  'edu',
  'class',
  'class-jh',
];

/**
 * 权限库模块 key → 门户模块 key（可一对多）
 *
 * ⚠️ 改动前务必对照 `server-job/src/utils/permPointToPages.ts` 与
 *    `server-job/src/perm/config/pageRegistry.ts` 的 pageCode 前缀。
 */
export const PERM_MODULE_TO_PORTAL: Record<string, readonly string[]> = {
  /** 市场咨询 → 市场咨询 */
  market: ['consult'],
  /** 财务管理 → 财务管理 */
  fin: ['finance'],
  /** 权限管理 → 权限管理 */
  perm: ['perm'],
  /** 就业管理 → 就业管理 */
  job: ['job'],
  /** 实训-教学 → 就业管理（实训是就业板块的前一个阶段，页面是 job:*） */
  train: ['job'],
  /** 教务部门 → 教务管理 */
  acad: ['edu'],
  /** 教学部门 → 班级管理（大学部）+ 教学管理（初高）——职位本身无法二选一，两个都给 */
  teach: ['class', 'class-jh'],
  /** 审批中心 → 跨板块（job / class-jh 的审批页），没有自己的门户模块 */
  approve: [],
};

/** 推到这么多模块就算「跨板块角色」→ 直接全开（实测命中「校长」「系统管理员」） */
const CROSS_BOARD_MIN = 6;

/**
 * 由「所选职位覆盖到的权限库模块」推导门户可访问模块。
 *
 * @param permModules 职位并集里**有 ≥1 项权限**的权限库模块 key
 *                    （与「权限预览」里「M 个模块可用」同一口径）
 * @param allKeys     门户模块全集（一般传接口拉回的模块列表；不传则用内置常量）
 * @returns 排好序的门户模块 key 数组，**一定非空**
 *
 * @example
 *   derivePortalModules(['market', 'approve'])                     // → ['consult']
 *   derivePortalModules(['teach'])                                 // → ['class', 'class-jh']
 *   derivePortalModules(['acad', 'teach', 'train', 'approve'])     // → ['class', 'class-jh', 'edu', 'job']
 *   derivePortalModules([])                                        // → 全部模块（兜底）
 */
export function derivePortalModules(permModules: string[], allKeys?: string[]): string[] {
  const all = (allKeys && allKeys.length ? allKeys : PORTAL_MODULE_KEYS).slice().sort();
  const hit = new Set<string>();

  for (const raw of permModules || []) {
    const key = String(raw ?? '').trim();
    if (!key) continue;
    for (const portal of PERM_MODULE_TO_PORTAL[key] || []) {
      if (all.includes(portal)) hit.add(portal);
    }
  }

  // 兜底 ①：一个都推不出来 → 全开（不然建出来的账号登不进去）
  if (!hit.size) return all;
  // 兜底 ②：跨板块角色 → 全开
  if (hit.size >= CROSS_BOARD_MIN) return all;
  return [...hit].sort();
}
