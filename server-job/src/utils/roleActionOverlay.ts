/**
 * 角色 → 操作码 叠加层（**按钮级 + 接口级**打通 legacy 四板块 ← 权限树）
 *
 * ============================================================
 * 【解决什么问题】
 *   「职位权限分配」页面（/perm/assign）维护的是 `sms_perm.t_perm_role_perm`
 *   —— 一棵**权限树**，命名体系是
 *     `module_key`（market/teach/train/job/acad/fin/approve/perm）
 *     + 中文功能点（如「学生基础数据」）
 *     + 英文动作码（如 create / uploadAttend / submitApply）
 *
 *   而 legacy 四个板块（实训 job / 教务 edu / 班级 class / 班级初高 classjh）
 *   的按钮与接口判权用的是**另一套操作码**：
 *     `class:student:add` / `class:grade:add` / `edu:student:edit` …
 *     （前端 `can('class:student:add')`，后端 `checkPermission('class:student:add')`）
 *
 *   两套命名**没有任何一列能对上**（`class` 不是树里的模块名，
 *   树里的动作叫 `create` 而操作码里叫 `add`）→ 于是「权限树改了，
 *   按钮/接口不动」，管理员在界面上取消了某动作，按钮照样在、接口照样通。
 *
 * 【本文件做什么】
 *   ① 维护一张**显式映射表** `PERM_POINT_TO_ACTION_CODES`：
 *        树上的 (module, item, action)  →  若干个 legacy 操作码
 *   ② 用**差异存储**把权限树「改动的那部分」叠加到静态兜底表上。
 *
 * ============================================================
 * 【★★ 差异存储语义（本文件最核心的一条，别改）】
 *
 *   基线（baseline）= **本功能第一次启用时**权限树里的勾选状态，
 *   快照在 `sms_perm.t_perm_role_perm_baseline`（首次使用自动灌入，幂等）。
 *
 *      新增授权 = 现在勾了 − 基线勾过        → 映射成操作码【补上】
 *      撤销授权 = 基线勾过 − 现在没勾        → 映射成操作码【移除】
 *
 *      最终操作码(role) = 静态兜底表(role) ∪ mapped(新增) − mapped(撤销)
 *
 *   为什么必须这样（血的教训，2026-10-07 实测）：
 *     直接把权限树当权威会**误伤**——树的 `teach` 模块当初是按
 *     「页面可见范围」校准的，不是按「按钮」口径：
 *       · 校长（R12）在 teach 下只勾了 view/export
 *         → 会把「新增学生 / 新建考试 / 录入成绩 / 发起退费 …」9 个按钮收走
 *       · 教员（R04）、助教（R05）同理各丢 1 个 / 4 个
 *     而按「差异存储」：**打通当天零变化**（没有差异 ⇒ 不干预），
 *     管理员之后在界面上勾/取消 → 立刻双向生效。
 *
 *   ⚠️ 这也意味着：树里**本来就勾着**、但静态表里没有的动作，
 *      不会自动授权（它不是一次「改动」）。这是刻意的 ——
 *      保证上线当天对全站 16 个账号零行为变化。
 *
 * ============================================================
 * 【降级原则】
 *   ⚠️ 与 rolePageLedger 一样：查库失败 / 基线缺失 → 当作「没有任何覆盖」，
 *      原样返回静态表。绝不能因为权限表抖一下就让全站按钮消失、接口全 403。
 * ============================================================
 */

import { db } from '../perm/utils/db';

/* ============================================================
 * 1. 映射表：(module||item) → { 树上动作码 → legacy 操作码[] }
 * ============================================================ */

/**
 * 维护提示：
 *   · key 一律 `module_key||item_name`（与 `t_perm_menu` 的列口径一致）
 *   · value 的 key 是 `t_perm_menu_action.action_code`
 *   · value 的值是该动作对应的一到多个 legacy 操作码
 *     （一个动作对应多码：如「录入成绩」在前端叫 `class:grade:add`、
 *       后端叫 `class:examScore:add`，两套码都要给到）
 *   · **只登记能明确对应的**；对应不上的动作不写 → 该动作不影响按钮
 */
export const PERM_POINT_TO_ACTION_CODES: Record<string, Record<string, string[]>> = {
  /* ---------- teach（教学部门 · 大学部）→ class:* ---------- */
  'teach||学生基础数据': {
    view: ['class:student:view'],
    create: ['class:student:add'],
    edit: ['class:student:edit'],
    export: ['class:student:export'],
  },
  'teach||班级管理': {
    view: ['class:classInfo:view'],
    add: ['class:classInfo:add'],
    edit: ['class:classInfo:edit'],
    handoverHead: ['class:handover:add'],
    handoverTutor: ['class:handover:add'],
  },
  'teach||出勤管理': {
    view: ['class:attendance:view'],
    uploadAttend: ['class:attendance:add'],
    export: ['class:attendance:export'],
  },
  'teach||考试管理': {
    view: ['class:exam:view', 'class:examScore:view'],
    createExam: ['class:exam:add'],
    entryScore: ['class:grade:add', 'class:examScore:add'],
    editScore: ['class:grade:edit'],
  },
  'teach||宿舍管理': {
    view: ['class:dorm:view', 'class:dormApply:view'],
    assignDorm: ['class:dorm:add'],
    submitDormApply: ['class:dorm:apply', 'class:dormApply:add'],
  },
  'teach||催费管理': {
    view: ['class:fee:view'],
    share: ['class:fee:add'],
  },
  'teach||退费申请': {
    view: ['class:refund:view'],
    submitApply: ['class:refund:add'],
  },
  'teach||流程管理': {
    viewFlow: ['class:flow:view'],
    startFlow: ['class:flow:add'],
    flowApprove: ['class:flow:approve'],
  },

  /* ---------- train（实训-教学）→ job:* ---------- */
  'train||实训-班级信息': {
    view: ['job:class:view'],
    edit: ['job:class:edit'],
    // ★★ 2026-10-08 补登：管理员在权限树里勾/取消「实训-班级信息 → 休学/退学/复学」时，
    //   必须同时作用于**两个**操作码，缺一不可：
    //     ① `job:class:suspend|quit|resume` —— ClassList.vue（班级信息管理页）
    //        行内「休学/退学/复学」按钮用的码；
    //     ② `job:leave:apply` —— **真正发起的接口**
    //        `POST /api/job/student-leave/create` 在 boardPermGate 里登记的码。
    //   漏 ② 的后果（本轮实测）：管理员取消校长/项目经理的「休学」勾选后，
    //   按钮确实消失了（① 被撤销），但**直接敲接口仍然成功**（② 没被撤销）
    //   —— 前后端口径割裂，管理员以为收走了权限，实际没拦住。
    suspendStudy: ['job:class:suspend', 'job:leave:apply'],
    quitStudy: ['job:class:quit', 'job:leave:apply'],
    resumeStudy: ['job:class:resume', 'job:leave:apply'],
    // ★★ 2026-10-08 补登：管理员在权限树里勾了「实训-班级信息 → 结业转就业 /
    //   撤销结业」时，对应到 class.route.ts 的 canGraduateClass / canRevokeGraduate。
    //   漏登记的后果：自建角色（如 XMJL_000）勾了「结业转就业」也转不了 ——
    //   这正是斌哥报的「项目经理勾了转就业的权限却还是没有转就业的权限」。
    graduate: ['job:class:graduate'],
    revokeGraduate: ['job:class:graduate-revoke'],
  },
  'train||实训-考试管理': {
    createExam: ['job:exam:add'],
    editExam: ['job:exam:edit'],
    delExam: ['job:exam:delete'],
  },
  'train||实训-成绩管理': {
    entryScore: ['job:exam-score:edit'],
    editScore: ['job:exam-score:edit'],
    promoteRepeat: ['job:exam-score:repeat'],
  },
  'train||实训-班级交接': {
    startHandover: ['job:class-handover:add'],
    confirmHandover: ['job:class-handover:confirm'],
  },
  /* ★ 2026-10-07 补全：train 模块其余 6 个功能点（之前只登记了 4 个） */
  'train||实训-催费管理': {
    view: ['job:feeCall:view'],
    createCall: ['job:feeCall:add'],
    handleCall: ['job:feeCall:handle'],
  },
  'train||实训-出勤管理': {
    view: ['job:attendance:view'],
    uploadAttend: ['job:attendance:add'],
    fillAbsentReason: ['job:attendance:add'],
    export: ['job:attendance:export'],
  },
  'train||实训-宿舍管理': {
    view: ['job:dorm:view'],
    assignDorm: ['job:dorm:add', 'job:dorm:edit'],
    submitDormApply: ['job:dorm:apply'],
    approveDormApply: ['job:dorm:approve'],
  },
  'train||实训-成绩汇总': {
    view: ['job:examSummary:view'],
    export: ['job:examSummary:export'],
  },
  'train||实训-退费申请': {
    view: ['job:refund:view'],
    submitApply: ['job:refund:apply'],
    agree: ['job:refund:approve'],
    reject: ['job:refund:approve'],
  },
  'train||实训-休学退学复学审批': {
    view: ['job:suspendApproval:view'],
    agree: ['job:leave:approve'],
    reject: ['job:leave:approve'],
  },

  /* ---------- job（就业管理）→ job:* ---------- */
  'job||就业信息档案': {
    view: ['job:empArchive:view'],
    edit: ['job:empArchive:edit'],
  },
  'job||就业日志': {
    view: ['job:employmentLog:view'],
    add: ['job:employmentLog:add'],
    edit: ['job:employmentLog:edit'],
  },
  'job||复盘填写': {
    view: ['job:review:view'],
    add: ['job:review:add'],
    edit: ['job:review:edit'],
  },
  'job||数据统计': {
    view: ['job:statistics:view'],
    export: ['job:statistics:export'],
  },
  'job||换班交接': {
    view: ['job:classTransfer:view'],
    startHandover: ['job:classTransfer:add'],
    confirmHandover: ['job:classTransfer:confirm'],
  },

  /* ---------- acad（教务部门）→ edu:* ---------- */
  'acad||学生档案': {
    view: ['edu:student:view'],
    edit: ['edu:student:edit'],
  },
  /* ★ 2026-10-07 补全：acad 模块其余 6 个功能点（之前只登记了 1 个） */
  'acad||临期名单': {
    view: ['edu:fee:view'],
    batchUpload: ['edu:fee:import'],
    notifyOnce: ['edu:fee:notify'],
    uploadVoucher: ['edu:fee:upload'],
  },
  'acad||宿舍总名单': {
    view: ['edu:dorm:view'],
    add: ['edu:dorm:add'],
    del: ['edu:dorm:delete'],
    edit: ['edu:dorm:edit'],
  },
  'acad||换宿/退宿审批': {
    view: ['edu:dorm:view'],
    agree: ['edu:dorm:approve'],
    reject: ['edu:dorm:approve'],
  },
  'acad||缴费总名单': {
    view: ['edu:fee:view'],
    add: ['edu:fee:add'],
    freeze: ['edu:fee:freeze'],
    import: ['edu:fee:import'],
    toggleStatus: ['edu:fee:freeze'],
  },
  'acad||退宿名单': {
    view: ['edu:dorm:view'],
    export: ['edu:dorm:export'],
  },
  'acad||餐费住宿费缴费名单': {
    view: ['edu:fee:view'],
    export: ['edu:fee:export'],
    freeze: ['edu:fee:freeze'],
    unfreeze: ['edu:fee:freeze'],
  },

  /* ---------- market（市场咨询）→ consult:* ----------
   * ⚠️ 2026-10-07 补全：权限树 market 模块共 7 个功能点，原先只登记了「学生档案」，
   *    导致咨询模块其余 6 个功能点「改了权限树但接口不动」。
   *    操作码一律用 `consult:{资源}:{动作}`，供咨询模块的 requireMarketAction 判定。
   */
  'market||预到校名单': {
    view: ['consult:preArrival:view'],
    add: ['consult:preArrival:add'],
    edit: ['consult:preArrival:edit'],
    assignConsult: ['consult:preArrival:assign'],
    markAbsent: ['consult:preArrival:absent'],
  },
  'market||咨询测试': {
    view: ['consult:test:view'],
    entryWritten: ['consult:test:written'],
    entryInterview: ['consult:test:interview'],
  },
  'market||学生档案': {
    view: ['consult:student:view'],
    add: ['consult:student:add'],
    edit: ['consult:student:edit'],
    viewFullPhone: ['consult:student:fullPhone'],
  },
  'market||缴费': {
    view: ['consult:fee:view'],
    entryTrialFee: ['consult:fee:trial'],
    entryFormalFee: ['consult:fee:formal'],
    discount: ['consult:fee:discount'],
  },
  'market||退费': {
    view: ['consult:refund:view'],
    submitApply: ['consult:refund:apply'],
    approve: ['consult:refund:approve'],
  },
  'market||跟进记录': {
    view: ['consult:follow:view'],
    add: ['consult:follow:add'],
    edit: ['consult:follow:edit'],
  },
  'market||统计分析': {
    view: ['consult:stat:view'],
    export: ['consult:stat:export'],
  },

  /* ---------- fin（财务管理）→ finance:* ---------- */
  'fin||账单明细': {
    view: ['finance:fee:view'],
    add: ['finance:fee:add'],
  },
  'fin||退费名单': {
    view: ['finance:refund:view'],
    startRefund: ['finance:refund:apply'],
    execRefund: ['finance:refund:pay'],
  },
  'fin||试学学费名单': {
    view: ['finance:trial:view'],
    verifyDone: ['finance:fee:verify'],
  },
  'fin||正式学费名单': {
    view: ['finance:formal:view'],
    verifyDone: ['finance:fee:verify'],
  },
  'fin||保险费名单': {
    view: ['finance:insurance:view'],
    verifyDone: ['finance:fee:verify'],
  },
};

/* ============================================================
 * 2. 权限管理模块（perm）—— **同名映射**，不需要单独登记
 *
 *   树上的模块名就叫 `perm`，且它的操作码格式天然就是
 *   `perm:{功能点名}:{动作码}` —— 与权限树完全同构。
 *     · perm||职位管理||add        → perm:职位管理:add
 *     · perm||权限配置||editPerm   → perm:权限配置:editPerm
 *   这里登记「每个功能点有哪些动作」，用于双向判定。
 * ============================================================ */

const PERM_MODULE_ACTIONS: Record<string, string[]> = {
  'perm||职位管理': ['view', 'add', 'edit', 'toggleStatus', 'del'],
  'perm||权限配置': ['view', 'editPerm'],
  'perm||账号管理': ['view', 'add', 'edit', 'resetPwd', 'toggleStatus'],
  'perm||规则配置': ['view', 'edit'],
  'perm||操作日志': ['view', 'export'],
};

/** 把 `perm||功能点||动作` 拼成权限管理自己的操作码 */
function permCodeOf(itemKey: string, action: string): string {
  const item = itemKey.split('||')[1];
  return `perm:${item}:${action}`;
}

/* ============================================================
 * 3. 基线表（快照）
 * ============================================================ */

const BASELINE_TABLE = 't_perm_role_perm_baseline';

let baselineEnsured: Promise<void> | null = null;

/**
 * 建基线表，并**在第一次使用时**把当前权限树全量灌进去。
 *
 * ⚠️ 幂等：表里已有数据就什么都不做。
 * ⚠️ 「基线」的语义 = 本功能启用那一刻，权限树的既有状态。
 *    想重置基线（把当前状态重新认定为基线）：
 *      DELETE FROM sms_perm.t_perm_role_perm_baseline; 然后重启后端。
 */
async function ensureBaselineTable(): Promise<void> {
  if (baselineEnsured) return baselineEnsured;

  baselineEnsured = (async () => {
    await db.raw(`
      CREATE TABLE IF NOT EXISTS ${BASELINE_TABLE} (
        id VARCHAR(191) NOT NULL PRIMARY KEY,
        role_code VARCHAR(64) NOT NULL,
        module_key VARCHAR(32) NOT NULL,
        item_name VARCHAR(64) NOT NULL,
        action_code VARCHAR(64) NOT NULL,
        create_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_role (role_code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    const [cnt] = (await db.raw(`SELECT COUNT(*) AS c FROM ${BASELINE_TABLE}`)) as any;
    if (Number(cnt?.[0]?.c || 0) > 0) return; // 已有基线 → 不覆盖

    // 首次：把当前权限树全量快照为基线
    await db.raw(`
      INSERT IGNORE INTO ${BASELINE_TABLE} (id, role_code, module_key, item_name, action_code)
      SELECT CONCAT(r.role_code, '|', rp.module_key, '|', rp.item_name, '|', rp.action_code),
             r.role_code, rp.module_key, rp.item_name, rp.action_code
      FROM t_perm_role_perm rp
      JOIN t_perm_role r ON r.id = rp.role_id
      WHERE rp.is_deleted = 0 AND r.is_deleted = 0
    `);

    // eslint-disable-next-line no-console
    console.log(`[权限] 已建立「按钮权限」基线快照（${BASELINE_TABLE}）`);
  })().catch((e) => {
    // 建表失败 → 关闭本次的 ensure，下次重试；但不影响主流程（会降级为「无覆盖」）
    baselineEnsured = null;
    throw e;
  });

  return baselineEnsured;
}

/* ============================================================
 * 4. 读取（带 15 秒内存缓存）
 * ============================================================ */

export interface RoleActionOverride {
  /** 该角色在权限树里「有记录」的功能点（module||item） */
  touchedItems: Set<string>;
  /** 现在勾选的三元组（module||item||action） */
  granted: Set<string>;
  /** 基线里勾选的三元组 */
  baselineGranted: Set<string>;
  /** ★ 预计算：「新增授权」映射出的操作码（供同步判定用，避免每请求重算） */
  addedCodes?: Set<string>;
  /** ★ 预计算：「撤销授权」映射出的操作码 */
  removedCodes?: Set<string>;
}

const CACHE_TTL_MS = 15_000;

let cache: { at: number; map: Map<string, RoleActionOverride> } | null = null;

/** 清缓存（权限管理保存角色权限后调用，让按钮/接口判定立刻生效） */
export function clearRoleActionCache(): void {
  cache = null;
}

/**
 * 读全部「角色 → 权限点」明细 + 基线，按 **role_code** 聚合。
 *
 * ⚠️ key 用 role_code：运行时 `req.user.roles` 是一串 role_code，
 *    role_id 是权限库主键，两者靠 t_perm_role 关联。
 */
export async function loadRoleActionOverrides(
  force = false,
): Promise<Map<string, RoleActionOverride>> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.map;

  const map = new Map<string, RoleActionOverride>();
  try {
    await ensureBaselineTable();

    const rows = await db('t_perm_role_perm as rp')
      .leftJoin('t_perm_role as r', 'r.id', 'rp.role_id')
      .where('rp.is_deleted', false)
      .andWhere('r.is_deleted', false)
      .select(
        'r.role_code as roleCode',
        'rp.module_key as moduleKey',
        'rp.item_name as itemName',
        'rp.action_code as actionCode',
      );

    for (const row of rows as any[]) {
      const code = String(row.roleCode || '');
      const mod = String(row.moduleKey || '');
      const item = String(row.itemName || '');
      const act = String(row.actionCode || '');
      if (!code || !mod || !item || !act) continue;

      let ov = map.get(code);
      if (!ov) {
        ov = { touchedItems: new Set(), granted: new Set(), baselineGranted: new Set() };
        map.set(code, ov);
      }
      ov.touchedItems.add(`${mod}||${item}`);
      ov.granted.add(`${mod}||${item}||${act}`);
    }

    /* ---- 基线 ---- */
    const baseRows = await db(BASELINE_TABLE).select(
      'role_code as roleCode',
      'module_key as moduleKey',
      'item_name as itemName',
      'action_code as actionCode',
    );
    for (const row of baseRows as any[]) {
      const code = String(row.roleCode || '');
      if (!code) continue;
      let ov = map.get(code);
      if (!ov) {
        ov = { touchedItems: new Set(), granted: new Set(), baselineGranted: new Set() };
        map.set(code, ov);
      }
      ov.baselineGranted.add(
        `${row.moduleKey}||${row.itemName}||${row.actionCode}`,
      );
    }

    /* ---- ★ 预计算「新增 / 撤销」的操作码（供各业务模块同步判定）---- */
    for (const ov of map.values()) {
      const d = diffOfOverride(ov);
      ov.addedCodes = new Set(d.added);
      ov.removedCodes = new Set(d.removed);
    }
  } catch {
    /**
     * ⚠️ 查库失败 → 当作「没有任何覆盖」放行（与 rolePageLedger 同一降级原则）。
     *    权限表抖一下，按钮不该跟着消失、接口不该全 403。
     */
    cache = { at: Date.now(), map: new Map() };
    return cache.map;
  }

  cache = { at: Date.now(), map };
  return map;
}

/** 取单个角色的权限点覆盖 */
export async function getRoleActionOverride(roleCode: string): Promise<RoleActionOverride | null> {
  const map = await loadRoleActionOverrides();
  return map.get(roleCode) || null;
}

/* ============================================================
 * 5. 叠加到操作码（差异存储）
 * ============================================================ */

/** 把「差异」换算成操作码：changed 里的三元组 → 它们映射出的操作码 */
function codesOfChanged(
  changed: (actSet: Set<string>) => Set<string>,
  ov: RoleActionOverride,
): string[] {
  const out: string[] = [];

  const collect = (itemKey: string, actMap: Record<string, string[]>): void => {
    changed(new Set(Object.keys(actMap).map((a) => `${itemKey}||${a}`))).forEach((k) => {
      const act = k.split('||')[2];
      const codes = actMap[act];
      if (codes) codes.forEach((c) => out.push(c));
    });
  };

  for (const [itemKey, actMap] of Object.entries(PERM_POINT_TO_ACTION_CODES)) {
    collect(itemKey, actMap);
  }
  for (const [itemKey, actions] of Object.entries(PERM_MODULE_ACTIONS)) {
    collect(itemKey, Object.fromEntries(actions.map((a) => [a, [permCodeOf(itemKey, a)]])) as any);
  }
  return out;
}

/**
 * 把「相对基线的改动」叠加到 legacy 操作码列表上。
 *
 * @param baseCodes 该角色的静态兜底操作码（ROLE_OPERATION_PERMISSIONS）
 * @param ov        该角色的权限点覆盖（null = 树里没有这个角色 → 不干预）
 */
export function overlayActionCodes(
  baseCodes: string[],
  ov: RoleActionOverride | null,
): string[] {
  if (!ov) return baseCodes;

  /** 现在勾了 − 基线勾过 = 新增 */
  const added = codesOfChanged(
    (keys) =>
      new Set(Array.from(keys).filter((k) => ov.granted.has(k) && !ov.baselineGranted.has(k))),
    ov,
  );
  /** 基线勾过 − 现在没勾 = 撤销 */
  const removed = codesOfChanged(
    (keys) =>
      new Set(Array.from(keys).filter((k) => !ov.granted.has(k) && ov.baselineGranted.has(k))),
    ov,
  );

  if (!added.length && !removed.length) return baseCodes;

  const set = new Set(baseCodes);
  removed.forEach((c) => set.delete(c));
  added.forEach((c) => set.add(c));
  return Array.from(set);
}

/* ============================================================
 * 6. 诊断用：算出某角色的「新增 / 撤销」明细（不改数据）
 * ============================================================ */

export function diffOfOverride(ov: RoleActionOverride | null): { added: string[]; removed: string[] } {
  if (!ov) return { added: [], removed: [] };
  const added = codesOfChanged(
    (keys) =>
      new Set(Array.from(keys).filter((k) => ov.granted.has(k) && !ov.baselineGranted.has(k))),
    ov,
  );
  const removed = codesOfChanged(
    (keys) =>
      new Set(Array.from(keys).filter((k) => !ov.granted.has(k) && ov.baselineGranted.has(k))),
    ov,
  );
  return { added: Array.from(new Set(added)), removed: Array.from(new Set(removed)) };
}

/* ============================================================
 * 7. ★ 同步判定接口（给各业务模块的【后端接口判权】用）
 *
 *   背景：四个 legacy 模块（class / class-jh / consult / finance）的接口
 *   判权各写各的（角色白名单 / 正则策略表 / 操作码表），都**不读权限树**。
 *   结果：管理员在「职位权限分配」里取消了某动作 → 按钮没了，
 *        但直接敲接口仍然成功（前后端不一致）。
 *
 *   本节提供 3 个函数，让这些模块用**最小改动**接入：
 *     · preloadRoleActionOverrides() —— 中间件里 await 一下，保证缓存新鲜
 *     · resolveActionWithOverlay()   —— 把「显式撤销 / 显式授权」叠加到
 *                                       模块自己的静态判权之上
 *
 *   ⚠️ 全部是「差异存储」语义：没被管理员改动过的码，行为与从前**完全一致**。
 * ============================================================ */

/** 读内存缓存里的某角色覆盖（缓存未就绪 → null = 不干预，交静态表） */
export function getOverrideSync(roleCode: string): RoleActionOverride | null {
  return cache ? cache.map.get(roleCode) || null : null;
}

/**
 * 预热内存缓存。
 *
 * 15s TTL 内是纯内存读（零查库成本），所以可以在**每个鉴权中间件**里 await；
 * 「职位权限分配」保存时会 `clearRoleActionCache()`，下一请求即重新加载 → 即时生效。
 */
export async function preloadRoleActionOverrides(): Promise<void> {
  try {
    await loadRoleActionOverrides();
  } catch {
    /* 降级：查不到就当作「无覆盖」，绝不因为权限库抖动拦掉正常业务 */
  }
}

function addedCodesOf(ov: RoleActionOverride): Set<string> {
  if (!ov.addedCodes) ov.addedCodes = new Set(diffOfOverride(ov).added);
  return ov.addedCodes;
}

function removedCodesOf(ov: RoleActionOverride): Set<string> {
  if (!ov.removedCodes) ov.removedCodes = new Set(diffOfOverride(ov).removed);
  return ov.removedCodes;
}

/**
 * ★★ 统一收口入口：把权限树的「显式改动」叠加到模块自己的静态判权上。
 *
 * 语义（逐角色判定，任一角色放行即放行 —— 与各模块原有的 `hasAnyRole` 口径一致）：
 *
 *   for each role:
 *     · 该 role 的这个码被【显式授权】  → 放行（覆盖静态表）
 *     · 该 role 的这个码被【显式撤销】  → 跳过（不再贡献放行）
 *     · 其余情况（含权限树里没这个角色） → 走模块自己的静态判权 staticAllow(role)
 *
 * @param roleCodes    用户拥有的角色码（role_code，如 TEACH_HEAD）
 * @param actionCode   本次要判的操作码（如 class:student:add）
 * @param staticAllow  模块自己的静态判权：该角色是否被允许
 */
export function resolveActionWithOverlay(
  roleCodes: string[] | undefined,
  actionCode: string,
  staticAllow: (roleCode: string) => boolean,
): boolean {
  const roles = Array.isArray(roleCodes) ? roleCodes : [];
  let allow = false;
  for (const role of roles) {
    const ov = cache ? cache.map.get(role) : null;
    if (ov) {
      if (addedCodesOf(ov).has(actionCode)) return true;
      if (removedCodesOf(ov).has(actionCode)) continue;
    }
    if (staticAllow(role)) allow = true;
  }
  return allow;
}

/* ============================================================
 * 8. ★ 前端按钮显隐用：取「被权限树显式撤销」的操作码
 *
 *   背景：job/edu 板块的按钮默认显隐由「角色」决定（各页面自己写死的
 *   角色白名单，如 `canInitiate = TEACH_HEAD`），这套默认是对的。
 *   但管理员在「职位权限分配」里取消某个动作后，对应按钮要跟着消失。
 *
 *   语义与后端总闸（boardPermGate）一致：只叠加「相对基线的撤销」，
 *   没被管理员动过的码，前端默认行为与从前**完全一致**（零回归）。
 * ============================================================ */
export function getRemovedActionCodesForRoles(roleCodes: string[] | undefined): string[] {
  const roles = Array.isArray(roleCodes) ? roleCodes : [];
  const set = new Set<string>();
  for (const role of roles) {
    const ov = cache ? cache.map.get(role) : null;
    if (!ov) continue;
    removedCodesOf(ov).forEach((c) => set.add(c));
  }
  return Array.from(set);
}
