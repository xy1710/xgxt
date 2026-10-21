<script setup lang="ts">
/**
 * 页面管理（板块 → 职位 → 页面）★ 2026-10-07 改版：左栏加「职位」
 *
 * ============================================================
 * 【这一页干什么】
 *   左侧 = 板块列表，**每个板块下面挂该板块下的职位**
 *   右侧 = 全部板块的页面，按板块逐张卡片堆叠
 *
 *   两种编辑模式（点左栏什么就进什么模式）：
 *     ① 点**板块** → 「板块模式」：编辑**这个板块有哪些页面**（全局生效）
 *        打勾 = 该板块有这个页面；没打勾 = 该板块里就没有这个页面。
 *     ② 点板块下的**职位** → 「职位模式」：编辑**这个职位能看到哪些页面**
 *        打勾 = 这个职位能看到；没打勾 = 看不到。
 *        右侧仍然是**全部板块**的页面 —— 因为「这个职位到底能看哪几页」
 *        是横跨全部板块的一件事，只给一个板块是配不全的。
 *
 * 【三层叠加（改这一页之前必须懂）】
 *   ① 板块有这个页面   （页面管理 · 板块模式 → t_perm_page）
 *   ② 该职位被允许看   （页面管理 · 职位模式 → t_perm_role_page）★ 本次新增
 *   ③ 该职位有权限点   （职位权限分配 → 功能点/动作）
 *   三层都满足才可见。任一层关掉 → 不可见。
 *
 * ⚠️ 「职位模式」是**差异存储**：只落「与默认不同」的行。
 *    · 某个职位一行都没有 → 完整沿用系统既有口径（对存量账号零影响）
 *    · 因此把某页改回默认值再保存 → 那一行会消失（界面上标「已改」的会消失）
 *    · 「恢复默认」= 把该职位的显式配置全部删掉，回到系统初始口径
 *   默认值从哪来：`server-job/src/utils/rolePageDefaults.ts`
 *     · 就业/教务/班级/初高 → pagePermissionSource 的 ROLE_PAGE_PERMISSIONS
 *     · 市场咨询 / 财务管理  → perm-link 的「功能点 → menuKey」换算表
 *     · 权限管理            → 默认只给系统管理员与校长
 *
 * 【与「职位权限分配」的分工 / 版式对齐】
 *   职位权限分配：**功能点级** —— 左选职位，右侧该职位在所有板块下的
 *                  「功能点 + 动作」勾选（能不能点某个按钮）
 *   页面管理      ：**页面级**   —— 左选板块 / 职位，右侧全部板块的页面勾选
 *                  （能不能进某个页面）
 *   两页版式刻意一致（左列表 + 右板块卡片），因为是同一类配置动作。
 *
 * 【保存语义】两种模式都是**全量覆盖**，只是粒度不同：
 *   · 板块模式：逐个提交有改动的板块（后端接口粒度就是单个板块）
 *   · 职位模式：逐个提交有改动的职位（后端按职位整表替换）
 *   ⚠️ 保存成功后要 `refreshPageConfig()`：菜单与守卫读的是那份缓存，
 *      不刷新的话要等下次刷新页面菜单才会变。
 *
 * ⚠️ 「页面管理」自己也在台账里，但这两种模式都 locked=true：勾选框禁用、不可取消。
 *    否则管理员去勾之后自己就进不来了（而且没有任何界面能改回来）。
 * ⚠️ 本页的 `--warn-l` 之类原型变量在合并后没有定义（prototype.css 没带过来），
 *    所以颜色一律写实色，不要引用 var(--xxx)。
 * ============================================================
 */
import { computed, onMounted, ref } from 'vue';
import type {
  PermPageBoard,
  PermRolePagesResult,
  PermRoleSummary,
  PermRoleTreeResult,
} from 'shared-types/perm';
import { pageApi } from '@/perm/api/page';
import { refreshPageConfig } from '@/store/pageConfig';
import ProtoConfirm from '@/perm/components/ProtoConfirm.vue';
import { toast } from '@/perm/utils/toast';

/* ============================================================
 * 1. 类型：把「板块模式」与「职位模式」拍平成一个统一的 UI 模型
 *    （模板只写一份，避免两种模式各写一遍卡片）
 * ============================================================ */

interface UIPage {
  pagePath: string;
  pageTitle: string;
  pageKey: string;
  pageCode?: string;
  locked: boolean;
  remark?: string;
  /** 当前勾选态 */
  on: boolean;
  /** 服务端原始值（用来判「有没有未保存改动」） */
  original: boolean;
  /** 该页面的**默认**值（职位模式：与职位默认不同则标「已改」） */
  defaultOn: boolean;
}

interface UICard {
  moduleKey: string;
  moduleName: string;
  moduleIcon: string;
  moduleDesc: string;
  legacy: boolean;
  total: number;
  enabledCount: number;
  dirty: boolean;
  pages: UIPage[];
}

/* ============================================================
 * 2. 状态
 * ============================================================ */

type Mode = 'board' | 'role';

const loading = ref(false);
const saving = ref(false);

/** 板块级台账（页面管理 · 板块模式） */
const boards = ref<PermPageBoard[]>([]);
/** 左栏：板块 → 职位 */
const tree = ref<PermRoleTreeResult>({ boards: [], orphanRoles: [], roleTotal: 0 });

const mode = ref<Mode>('board');
/** 板块模式：当前聚焦的板块 key */
const activeKey = ref('');
/** 职位模式：当前聚焦的职位 id */
const activeRoleId = ref('');

/** 右侧板块卡片折叠态（默认全部展开 → 一屏能看到所有板块的所有页面） */
const collapsed = ref<Record<string, boolean>>({});
/** 左栏每个板块下职位列表的折叠态（默认展开，让职位一眼可见） */
const treeOpen = ref<Record<string, boolean>>({});
/**
 * 左栏「兜底职位」分组的折叠态（key = 部门名）
 *
 * 说明：不在任何板块里露面的职位，按**部门**分组展示（如「招生部」），
 * 而不是统一塞进「其他职位」——这样新加的部门/职位一眼能对上号。
 */
const orphanDeptOpen = ref<Record<string, boolean>>({});

/** 板块模式草稿：`板块key||页面path` → 是否打勾 */
const draft = ref<Record<string, boolean>>({});

/** 职位模式：已加载过的职位数据 + 每个职位一份草稿 */
const rolePagesMap = ref<Record<string, PermRolePagesResult>>({});
const roleDraft = ref<Record<string, Record<string, boolean>>>({});

const flagKey = (moduleKey: string, pagePath: string): string => `${moduleKey}||${pagePath}`;

/* ============================================================
 * 3. 加载
 * ============================================================ */

/** 用后端下发的 enabled 重置板块草稿（保存后 / 刷新后调用） */
function resetDraft(list: PermPageBoard[]): void {
  const d: Record<string, boolean> = {};
  list.forEach((b) => {
    b.pages.forEach((p) => {
      d[flagKey(b.moduleKey, p.pagePath)] = p.enabled;
    });
  });
  draft.value = d;
}

/** 把某职位的服务端数据铺成草稿 */
function seedRoleDraft(rp: PermRolePagesResult): void {
  const d: Record<string, boolean> = {};
  rp.boards.forEach((b) => {
    b.pages.forEach((p) => {
      d[flagKey(b.moduleKey, p.pagePath)] = p.enabled;
    });
  });
  roleDraft.value = { ...roleDraft.value, [rp.roleId]: d };
}

async function load(keepCurrent = true): Promise<void> {
  loading.value = true;
  try {
    const [list, roleTree] = await Promise.all([pageApi.list(), pageApi.roleTree()]);
    boards.value = list.boards;
    tree.value = roleTree;
    resetDraft(list.boards);

    if (!keepCurrent || !list.boards.some((b) => b.moduleKey === activeKey.value)) {
      activeKey.value = list.boards[0]?.moduleKey || '';
    }
    // 已加载过的职位：把服务端最新值重新灌一遍草稿（保存后要的是「以库为准」）
    if (activeRoleId.value && rolePagesMap.value[activeRoleId.value]) {
      await loadRolePages(activeRoleId.value);
    }
  } catch {
    /* 错误提示由 @/perm/api/request 统一弹出 */
  } finally {
    loading.value = false;
  }
}

/** 载入某职位的页面勾选态（职位模式右侧的数据源） */
async function loadRolePages(roleId: string, force = false): Promise<void> {
  if (!force && rolePagesMap.value[roleId]) return;
  const rp = await pageApi.rolePages(roleId);
  rolePagesMap.value = { ...rolePagesMap.value, [roleId]: rp };
  seedRoleDraft(rp);
}

onMounted(() => {
  void load(false);
});

/* ============================================================
 * 4. 统一 UI 模型
 * ============================================================ */

/** 板块模式：以「全局台账」为准 */
const boardCards = computed<UICard[]>(() =>
  boards.value.map((b) => {
    const pages: UIPage[] = b.pages.map((p) => {
      const on = !!draft.value[flagKey(b.moduleKey, p.pagePath)];
      return {
        pagePath: p.pagePath,
        pageTitle: p.pageTitle,
        pageKey: p.pageKey,
        pageCode: p.pageCode,
        locked: p.locked,
        remark: p.remark,
        on,
        original: p.enabled,
        defaultOn: p.enabled,
      };
    });
    return {
      moduleKey: b.moduleKey,
      moduleName: b.moduleName,
      moduleIcon: b.moduleIcon,
      moduleDesc: b.moduleDesc,
      legacy: b.legacy,
      total: pages.length,
      enabledCount: pages.filter((x) => x.on).length,
      dirty: pages.some((x) => x.on !== x.original),
      pages,
    };
  }),
);

/** 职位模式：以「该职位」为准 */
const activeRolePages = computed<PermRolePagesResult | null>(
  () => rolePagesMap.value[activeRoleId.value] || null,
);

const roleCards = computed<UICard[]>(() => {
  const rp = activeRolePages.value;
  if (!rp) return [];
  const d = roleDraft.value[rp.roleId] || {};
  return rp.boards.map((b) => {
    const pages: UIPage[] = b.pages.map((p) => {
      const k = flagKey(b.moduleKey, p.pagePath);
      // ⚠️ 台账里没这一行时 p.overridden=false 且 p.enabled 就是默认值，
      //    所以 defaultOn 可以用 overridden 反推出来（见契约注释）。
      const defaultOn = p.overridden ? !p.enabled : p.enabled;
      const on = k in d ? !!d[k] : p.enabled;
      return {
        pagePath: p.pagePath,
        pageTitle: p.pageTitle,
        pageKey: p.pageKey,
        pageCode: p.pageCode,
        locked: p.locked,
        remark: p.remark,
        on,
        original: p.enabled,
        defaultOn,
      };
    });
    return {
      moduleKey: b.moduleKey,
      moduleName: b.moduleName,
      moduleIcon: b.moduleIcon,
      moduleDesc: '',
      legacy: b.legacy,
      total: pages.length,
      enabledCount: pages.filter((x) => x.on).length,
      dirty: pages.some((x) => x.on !== x.original),
      pages,
    };
  });
});

/** ★ 模板只渲染这一份 */
const cards = computed<UICard[]>(() => (mode.value === 'board' ? boardCards.value : roleCards.value));

const dirtyCards = computed<UICard[]>(() => cards.value.filter((c) => c.dirty));

/** 全局统计（按草稿算，能实时反映未保存的勾选） */
const globalStat = computed(() => ({
  total: cards.value.reduce((n, c) => n + c.total, 0),
  enabled: cards.value.reduce((n, c) => n + c.enabledCount, 0),
}));

/* ============================================================
 * 5. 职位模式的「脏职位」统计
 * ============================================================ */

function roleDirty(roleId: string): boolean {
  const rp = rolePagesMap.value[roleId];
  const d = roleDraft.value[roleId];
  if (!rp || !d) return false;
  return rp.boards.some((b) =>
    b.pages.some((p) => {
      const k = flagKey(b.moduleKey, p.pagePath);
      return (k in d ? !!d[k] : p.enabled) !== p.enabled;
    }),
  );
}

const dirtyRoleIds = computed<string[]>(() => {
  const ids = new Set<string>();
  tree.value.boards.forEach((b) => b.roles.forEach((r) => ids.add(r.roleId)));
  tree.value.orphanRoles.forEach((r) => ids.add(r.roleId));
  return Array.from(ids).filter((id) => roleDirty(id));
});

/** 当前有没有待保存的东西（保存按钮的 disabled 判据） */
const hasPending = computed(() =>
  mode.value === 'board' ? dirtyCards.value.length > 0 : dirtyRoleIds.value.length > 0,
);

const pendingLabel = computed(() => {
  if (mode.value === 'board') {
    return dirtyCards.value.length ? `保存改动（${dirtyCards.value.length} 个板块）` : '保存改动';
  }
  return dirtyRoleIds.value.length ? `保存改动（${dirtyRoleIds.value.length} 个职位）` : '保存改动';
});

/* ============================================================
 * 6. 勾选
 * ============================================================ */

function togglePage(card: UICard, p: UIPage): void {
  if (p.locked) {
    toast('「页面管理」是本功能的入口，不能取消勾选');
    return;
  }
  const k = flagKey(card.moduleKey, p.pagePath);
  if (mode.value === 'board') {
    draft.value = { ...draft.value, [k]: !draft.value[k] };
    return;
  }
  const rid = activeRoleId.value;
  const cur = { ...(roleDraft.value[rid] || {}) };
  cur[k] = !p.on;
  roleDraft.value = { ...roleDraft.value, [rid]: cur };
}

/** 某板块全选 */
function selectAll(card: UICard): void {
  applyCard(card, () => true);
}

/** 某板块清空（locked 的页面依然勾上，否则等于自锁） */
function clearAll(card: UICard): void {
  applyCard(card, (p) => p.locked);
}

/** 放弃某板块未保存的改动（其它板块的草稿不动） */
function discard(card: UICard): void {
  applyCard(card, (p) => p.original);
  toast(`已放弃「${card.moduleName}」未保存的改动`);
}

function applyCard(card: UICard, pick: (p: UIPage) => boolean): void {
  if (mode.value === 'board') {
    const next = { ...draft.value };
    card.pages.forEach((p) => {
      next[flagKey(card.moduleKey, p.pagePath)] = pick(p);
    });
    draft.value = next;
    return;
  }
  const rid = activeRoleId.value;
  const cur = { ...(roleDraft.value[rid] || {}) };
  card.pages.forEach((p) => {
    cur[flagKey(card.moduleKey, p.pagePath)] = pick(p);
  });
  roleDraft.value = { ...roleDraft.value, [rid]: cur };
}

/* ============================================================
 * 7. 左栏交互
 * ============================================================ */

/** 点板块 → 板块模式；高亮 + 把右侧对应卡片滚到可视区 */
function selectBoard(moduleKey: string): void {
  mode.value = 'board';
  activeKey.value = moduleKey;
  if (collapsed.value[moduleKey]) {
    collapsed.value = { ...collapsed.value, [moduleKey]: false };
  }
  scrollToBoard(moduleKey);
}

/** 点板块下的职位 → 职位模式 */
async function selectRole(role: PermRoleSummary): Promise<void> {
  mode.value = 'role';
  activeRoleId.value = role.roleId;
  loading.value = true;
  try {
    await loadRolePages(role.roleId);
  } catch {
    /* 已提示 */
  } finally {
    loading.value = false;
  }
}

function scrollToBoard(moduleKey: string): void {
  const el = document.getElementById(`pg-board-${moduleKey}`);
  el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function toggleCollapse(moduleKey: string): void {
  collapsed.value = { ...collapsed.value, [moduleKey]: !collapsed.value[moduleKey] };
}

function toggleTree(moduleKey: string): void {
  treeOpen.value = { ...treeOpen.value, [moduleKey]: !isTreeOpen(moduleKey) };
}

/** 左栏板块下的职位默认展开（除非用户手动收过） */
function isTreeOpen(moduleKey: string): boolean {
  return treeOpen.value[moduleKey] !== false;
}

/**
 * 兜底职位按部门分组（按部门首次出现顺序；无部门名的排最后）
 *
 * 为什么不直接用 boards 里的分组：orphanRoles 是「在所有板块都看不到任何页面」的职位，
 * 后端不会把它们挂进任何 board，所以前端要自己按 deptName 归一次组。
 */
const orphanDeptGroups = computed<{ deptName: string; roles: PermRoleSummary[] }[]>(() => {
  const map = new Map<string, PermRoleSummary[]>();
  tree.value.orphanRoles.forEach((r) => {
    const d = (r.deptName || '').trim() || '未归属部门';
    const arr = map.get(d);
    if (arr) arr.push(r);
    else map.set(d, [r]);
  });
  const groups = Array.from(map.entries()).map(([deptName, roles]) => ({ deptName, roles }));
  // 「未归属部门」永远排最后，正常部门保持后端返回的相对顺序
  return groups.sort((a, b) => Number(a.deptName === '未归属部门') - Number(b.deptName === '未归属部门'));
});

function isOrphanDeptOpen(deptName: string): boolean {
  return orphanDeptOpen.value[deptName] !== false;
}

function toggleOrphanDept(deptName: string): void {
  orphanDeptOpen.value = { ...orphanDeptOpen.value, [deptName]: !isOrphanDeptOpen(deptName) };
}

function expandAll(): void {
  collapsed.value = {};
}

function collapseAll(): void {
  const next: Record<string, boolean> = {};
  boards.value.forEach((b) => {
    next[b.moduleKey] = true;
  });
  collapsed.value = next;
}

/* ============================================================
 * 8. 保存
 * ============================================================ */

const saveOpen = ref(false);
const resetOpen = ref(false);
const roleResetOpen = ref(false);

/** 确认框明细：逐卡片列出「X → Y 页」以及新增/关闭的页面名 */
const saveDetail = computed(() => {
  const changed = (c: UICard) => c.pages.filter((p) => p.on !== p.original);
  return dirtyCards.value.map((c) => {
    const seg: string[] = [`<b>${c.pages.filter((p) => p.original).length} → ${c.enabledCount}</b> 页`];
    const add = changed(c).filter((p) => p.on);
    const rm = changed(c).filter((p) => !p.on);
    if (add.length) seg.push(add.map((p) => `<span class="tag g">${p.pageTitle}</span>`).join(' '));
    if (rm.length) seg.push(rm.map((p) => `<span class="tag d">${p.pageTitle}</span>`).join(' '));
    return { k: `${c.moduleIcon} ${c.moduleName}`, v: seg.join(' · ') };
  });
});

const totalAdded = computed(() =>
  dirtyCards.value.reduce((n, c) => n + c.pages.filter((p) => p.on && !p.original).length, 0),
);
const totalRemoved = computed(() =>
  dirtyCards.value.reduce((n, c) => n + c.pages.filter((p) => !p.on && p.original).length, 0),
);

/** 把某职位的草稿整理成后端要的 items（全量：全部板块的全部页面） */
function roleItems(roleId: string): Array<{ moduleKey: string; pagePath: string; enabled: boolean }> {
  const rp = rolePagesMap.value[roleId];
  const d = roleDraft.value[roleId] || {};
  const base = new Map<string, boolean>();
  rp?.boards.forEach((b) =>
    b.pages.forEach((p) => base.set(flagKey(b.moduleKey, p.pagePath), p.enabled)),
  );

  const items: Array<{ moduleKey: string; pagePath: string; enabled: boolean }> = [];
  boards.value.forEach((b) => {
    b.pages.forEach((p) => {
      const k = flagKey(b.moduleKey, p.pagePath);
      items.push({
        moduleKey: b.moduleKey,
        pagePath: p.pagePath,
        enabled: k in d ? !!d[k] : (base.get(k) ?? false),
      });
    });
  });
  return items;
}

async function doSave(): Promise<void> {
  saving.value = true;
  try {
    let msg = '';
    if (mode.value === 'board') {
      const targets = dirtyCards.value.slice();
      if (!targets.length) {
        saveOpen.value = false;
        return;
      }
      let done = 0;
      for (const c of targets) {
        const enabledPaths = c.pages.filter((p) => p.on).map((p) => p.pagePath);
        await pageApi.save(c.moduleKey, enabledPaths);
        done += 1;
      }
      saveOpen.value = false;
      await load(true);
      msg = done === 1 ? `「${targets[0].moduleName}」已保存` : `已保存 ${done} 个板块的页面配置`;
    } else {
      const targets = dirtyRoleIds.value.slice();
      if (!targets.length) {
        saveOpen.value = false;
        return;
      }
      let done = 0;
      for (const rid of targets) {
        await pageApi.saveRole(rid, roleItems(rid));
        done += 1;
      }
      saveOpen.value = false;
      await load(true);
      msg = done === 1 ? '职位页面可见性已保存' : `已保存 ${done} 个职位的页面可见性`;
    }
    // 让左侧菜单 / 路由守卫立刻按新台账生效
    await refreshPageConfig();
    toast(msg);
  } catch {
    // 中途失败：把库里的真实状态拉回来，避免界面停留在「以为全保存了」
    await load(true);
    await refreshPageConfig();
  } finally {
    saving.value = false;
  }
}

async function doReset(): Promise<void> {
  saving.value = true;
  try {
    const res = await pageApi.reset();
    resetOpen.value = false;
    await load(true);
    await refreshPageConfig();
    toast(`已恢复全部 ${res.affected} 个页面的启用状态`);
  } catch {
    /* 已提示 */
  } finally {
    saving.value = false;
  }
}

/** 恢复当前职位的默认页面可见性（删光该职位的显式配置） */
async function doRoleReset(): Promise<void> {
  const rid = activeRoleId.value;
  if (!rid) return;
  saving.value = true;
  try {
    const res = await pageApi.resetRole(rid);
    roleResetOpen.value = false;
    // 强制重取该职位（配置已清空）
    const rp = await pageApi.rolePages(rid);
    rolePagesMap.value = { ...rolePagesMap.value, [rid]: rp };
    seedRoleDraft(rp);
    await load(true);
    await refreshPageConfig();
    toast(`已恢复默认（清除 ${res.affected} 行显式配置）`);
  } catch {
    /* 已提示 */
  } finally {
    saving.value = false;
  }
}

/* ============================================================
 * 9. 展示辅助
 * ============================================================ */

const activeRole = computed<PermRoleSummary | null>(() => {
  const id = activeRoleId.value;
  for (const b of tree.value.boards) {
    const hit = b.roles.find((r) => r.roleId === id);
    if (hit) return hit;
  }
  return tree.value.orphanRoles.find((r) => r.roleId === id) || null;
});

/** 职位模式下「已改」（与默认不同）的页面数 */
const changedVsDefault = computed(() =>
  roleCards.value.reduce(
    (n, c) => n + c.pages.filter((p) => p.on !== p.defaultOn).length,
    0,
  ),
);

const currentBoardName = computed(
  () => boards.value.find((b) => b.moduleKey === activeKey.value)?.moduleName || activeKey.value,
);
</script>

<template>
  <div>
    <!-- ==================== 主体 ==================== -->
    <div class="card">
      <div class="card-h">
        <div class="t"><span class="bar"></span>页面管理</div>
        <div class="r">
          <span class="desc">
            左侧选板块 / 职位 → 右侧勾选页面 → 保存生效（板块模式管「有没有」，职位模式管「谁能看」）
          </span>
          <button class="btn" type="button" :disabled="saving" @click="load(true)">刷新</button>
          <button
            v-if="mode === 'board'"
            class="btn wn"
            type="button"
            :disabled="saving"
            @click="resetOpen = true"
          >
            全部恢复启用
          </button>
          <button
            v-else
            class="btn wn"
            type="button"
            :disabled="saving || !activeRolePages?.configured"
            @click="roleResetOpen = true"
          >
            恢复默认
          </button>
          <button
            class="btn pri"
            type="button"
            :disabled="!hasPending || saving"
            @click="saveOpen = true"
          >
            {{ pendingLabel }}
          </button>
        </div>
      </div>

      <div class="card-b">
        <div class="split">
          <!-- ---------- 左：板块 → 职位 ---------- -->
          <div class="lft">
            <div class="desc" style="padding: 4px 6px 7px">
              板块 / 职位（{{ tree.boards.length }} 个板块 · {{ tree.roleTotal }} 个职位）
            </div>

            <div v-if="loading && !boards.length" class="empty">
              <div class="ic">⏳</div>
              加载中…
            </div>
            <div v-else-if="!tree.boards.length" class="empty">
              <div class="ic">🗂️</div>
              暂无板块
            </div>
            <template v-else>
              <div v-for="b in tree.boards" :key="b.moduleKey" class="pg-node">
                <!-- 板块行：点击 = 板块模式 -->
                <div
                  class="rl-item"
                  :class="{ on: mode === 'board' && b.moduleKey === activeKey }"
                  @click="selectBoard(b.moduleKey)"
                >
                  <!--
                    ⚠️ 没有职位可展开的板块（目前只有「工作台」：locked + 人人可见 + 无权限码）
                    不画箭头、不响应点击 —— 但保留 12px 的空 span，否则标题会左移、与其它板块错位。
                  -->
                  <span
                    class="pg-fold"
                    :style="{ cursor: b.roles.length ? 'pointer' : 'default' }"
                    @click.stop="b.roles.length && toggleTree(b.moduleKey)"
                  >
                    {{ b.roles.length ? (isTreeOpen(b.moduleKey) ? '▾' : '▸') : '' }}
                  </span>
                  <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
                    <b v-if="boardCards.find((c) => c.moduleKey === b.moduleKey)?.dirty" style="color: #A66A1F">●</b>
                    {{ b.moduleIcon }} {{ b.moduleName }}
                  </span>
                  <span class="cnt">
                    {{ boardCards.find((c) => c.moduleKey === b.moduleKey)?.enabledCount ?? 0 }}/{{ b.total }}
                  </span>
                </div>

                <!-- 职位行：点击 = 职位模式 -->
                <template v-if="isTreeOpen(b.moduleKey)">
                  <div
                    v-for="r in b.roles"
                    :key="b.moduleKey + '-' + r.roleId"
                    class="rl-item rl-sub"
                    :class="{ on: mode === 'role' && r.roleId === activeRoleId }"
                    @click="selectRole(r)"
                  >
                    <span class="rl-avatar">{{ r.roleName.slice(0, 1) }}</span>
                    <span
                      style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap"
                      :title="`${r.roleName} · ${r.deptName}`"
                    >
                      <b v-if="roleDirty(r.roleId)" style="color: #A66A1F">●</b>
                      {{ r.roleName }}
                      <span v-if="r.configured" class="tag p" style="margin-left: 3px">已配置</span>
                    </span>
                    <span class="cnt">{{ r.enabledCount }}/{{ r.total }}</span>
                  </div>
                  <!-- 「本板块暂无职位」只在**本该有职位**的板块显示；
                       单页板块（工作台）后端刻意不展开职位，这里也不该提示「暂无」 -->
                  <div v-if="!b.roles.length && b.total > 1" class="rl-none">（本板块暂无职位）</div>
                </template>
              </div>

              <!--
                兜底：在任何板块都看不到页面的职位 → 按「部门」分组显示
                （原来统一叫「其他职位」，新加部门/职位后看不出归属，改成部门名）
              -->
              <div v-if="tree.orphanRoles.length" class="pg-node" style="margin-top: 6px">
                <div class="desc" style="padding: 2px 6px 5px">暂未分配页面的职位（按部门）</div>
                <div v-for="g in orphanDeptGroups" :key="'orphan-dept-' + g.deptName" class="pg-node">
                  <div class="rl-item" @click="toggleOrphanDept(g.deptName)">
                    <span class="pg-fold">{{ isOrphanDeptOpen(g.deptName) ? '▾' : '▸' }}</span>
                    <span
                      style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap"
                      :title="g.deptName"
                    >
                      🏢 {{ g.deptName }}
                    </span>
                    <span class="cnt">{{ g.roles.length }}</span>
                  </div>
                  <template v-if="isOrphanDeptOpen(g.deptName)">
                    <div
                      v-for="r in g.roles"
                      :key="'orphan-' + r.roleId"
                      class="rl-item rl-sub"
                      :class="{ on: mode === 'role' && r.roleId === activeRoleId }"
                      @click="selectRole(r)"
                    >
                      <span class="rl-avatar">{{ r.roleName.slice(0, 1) }}</span>
                      <span
                        style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap"
                        :title="`${r.roleName} · ${r.deptName}`"
                      >
                        <b v-if="roleDirty(r.roleId)" style="color: #A66A1F">●</b>
                        {{ r.roleName }}
                        <span v-if="r.configured" class="tag p" style="margin-left: 3px">已配置</span>
                      </span>
                      <span class="cnt">{{ r.enabledCount }}/{{ r.total }}</span>
                    </div>
                  </template>
                </div>
              </div>

              <div class="desc" style="padding: 9px 6px 2px">
                共 {{ globalStat.enabled }} / {{ globalStat.total }} 个页面处于启用状态
              </div>
            </template>
          </div>

          <!-- ---------- 右：全部板块的页面 ---------- -->
          <div class="rgt">
            <!-- 总览头：随模式切换 -->
            <div class="pg-head">
              <div class="pg-ic">{{ mode === 'board' ? '🗂️' : '👤' }}</div>
              <div style="min-width: 0">
                <template v-if="mode === 'board'">
                  <div style="font-weight: 600; font-size: 14px">
                    全部板块的页面
                    <span class="tag n">{{ cards.length }} 个板块</span>
                  </div>
                  <div class="desc">
                    下面是所有板块的所有页面，可直接勾选任意板块的任意页面
                  </div>
                </template>
                <template v-else>
                  <div style="font-weight: 600; font-size: 14px">
                    {{ activeRole?.roleName || '职位' }}
                    <span v-if="activeRole" class="tag n">{{ activeRole.deptName }}</span>
                    <span v-if="activeRolePages?.configured" class="tag p">
                      已配置 {{ activeRolePages?.overrideCount }} 处
                    </span>
                    <span v-else class="tag g">沿用默认</span>
                    <span v-if="changedVsDefault" class="tag w">
                      本次已改 {{ changedVsDefault }} 页
                    </span>
                  </div>
                  <div class="desc">
                    正在编辑「该职位能看哪些页面」—— 右侧是**全部板块**的页面，可直接勾选
                  </div>
                </template>
              </div>
              <div style="margin-left: auto; text-align: right; flex: none">
                <div style="font-size: 19px; font-weight: 700; color: #CD3A33">
                  {{ globalStat.enabled }}/{{ globalStat.total }}
                </div>
                <div class="desc">已启用页面</div>
              </div>
            </div>

            <!-- 工具条 -->
            <div class="perm-tools">
              <button class="btn xs" type="button" @click="expandAll">全部展开</button>
              <button class="btn xs" type="button" @click="collapseAll">全部收起</button>
              <span v-if="mode === 'board' && dirtyCards.length" class="tag w">
                有 {{ dirtyCards.length }} 个板块有未保存改动
              </span>
              <span v-if="mode === 'role' && dirtyRoleIds.length" class="tag w">
                有 {{ dirtyRoleIds.length }} 个职位有未保存改动
              </span>
              <span v-if="mode === 'role' && activeRolePages?.configured" class="cl">
                <span class="lk wn" @click="roleResetOpen = true">清除该职位的全部配置（恢复默认）</span>
              </span>
              <span class="cl">共 {{ globalStat.total }} 个页面 · 当前启用 {{ globalStat.enabled }} 个</span>
            </div>

            <!-- 说明条 -->
            <div class="notice i" style="margin-bottom: 10px">
              ℹ
              <div v-if="mode === 'board'">
                <b>打勾 = 该板块有这个页面。</b>保存后左侧菜单立即按勾选结果变化；
                没打勾的页面即便手输 URL 也进不去，会被弹回有权限的落地页。
              </div>
              <div v-else>
                <b>打勾 = 该职位能看到这个页面。</b>
                这是「板块级」之上的第二层：板块有、职位也允许，才轮到「职位权限分配」里的功能点判定。
                <br />
                勾选状态默认来自系统既有口径；<b>只保存与默认不同的部分</b>，
                所以「恢复默认」可以把该职位一键还原。
                权限管理板块默认只对<b>系统管理员</b>与<b>校长</b>开放。
              </div>
            </div>

            <div v-if="loading && !cards.length" class="empty">
              <div class="ic">⏳</div>
              加载中…
            </div>
            <div v-else-if="!cards.length" class="empty">
              <div class="ic">🗂️</div>
              {{ mode === 'role' ? '请先在左栏点击一个职位' : '暂无板块数据' }}
            </div>

            <!-- 逐板块卡片 -->
            <template v-else>
              <div
                v-for="c in cards"
                :id="`pg-board-${c.moduleKey}`"
                :key="c.moduleKey"
                class="pg-board"
                :class="{ on: mode === 'board' && c.moduleKey === activeKey, dirty: c.dirty }"
              >
                <!-- 卡片头：板块名 + 计数 + 本板块操作 -->
                <div class="pg-bh">
                  <span class="pg-bic">{{ c.moduleIcon }}</span>
                  <b style="font-size: 12.5px">{{ c.moduleName }}</b>
                  <span class="tag n">{{ c.moduleKey }}</span>
                  <span v-if="c.legacy" class="tag p">legacy</span>
                  <span class="tag" :class="c.enabledCount === c.total ? 'g' : 'd'">
                    {{ c.enabledCount }}/{{ c.total }}
                  </span>
                  <span v-if="c.dirty" class="tag w">未保存</span>
                  <span class="pg-br">
                    <span class="lk" @click.stop="selectAll(c)">全选</span>
                    <span class="lk" @click.stop="clearAll(c)">清空</span>
                    <span v-if="c.dirty" class="lk wn" @click.stop="discard(c)">放弃改动</span>
                    <span class="lk gy" @click.stop="toggleCollapse(c.moduleKey)">
                      {{ collapsed[c.moduleKey] ? '展开' : '收起' }}
                    </span>
                  </span>
                </div>

                <!-- 职位模式：权限管理板块给一句额外说明 -->
                <div v-if="mode === 'role' && c.moduleKey === 'perm'" class="pg-note">
                  权限管理板块默认只对「系统管理员」与「校长」开放；其他职位如需授权，在此勾选即可。
                </div>

                <!-- 卡片体：该板块的页面行 -->
                <div v-show="!collapsed[c.moduleKey]" class="pg-list">
                  <label
                    v-for="p in c.pages"
                    :key="p.pagePath"
                    class="pg-item"
                    :class="{ off: !p.on, lock: p.locked }"
                  >
                    <input
                      class="ck"
                      type="checkbox"
                      :checked="p.on"
                      :disabled="p.locked"
                      @change="togglePage(c, p)"
                    />
                    <div style="flex: 1; min-width: 0">
                      <div class="pg-t">
                        {{ p.pageTitle }}
                        <span class="tag n">{{ p.pageKey }}</span>
                        <span v-if="p.locked" class="tag p">必选</span>
                        <span v-if="!p.on" class="tag d">已关闭</span>
                        <span
                          v-if="mode === 'role' && p.on !== p.defaultOn"
                          class="tag w"
                        >已改（默认{{ p.defaultOn ? '可见' : '不可见' }}）</span>
                      </div>
                      <div class="desc">
                        <span class="mono">{{ p.pagePath }}</span>
                        <template v-if="p.pageCode"> · {{ p.pageCode }}</template>
                        <template v-if="p.remark"> · {{ p.remark }}</template>
                      </div>
                    </div>
                  </label>
                </div>
              </div>
            </template>
          </div>
        </div>
      </div>
    </div>

    <!-- ==================== 保存确认 ==================== -->
    <ProtoConfirm
      v-model="saveOpen"
      :title="mode === 'board' ? '保存页面台账' : '保存职位页面可见性'"
      icon="💾"
      :msg="
        mode === 'board'
          ? `确认保存 ${dirtyCards.length} 个板块的页面配置？`
          : `确认保存 ${dirtyRoleIds.length} 个职位的页面可见性？`
      "
      :detail="saveDetail"
      :tip="
        mode === 'board'
          ? '保存后立即生效：左侧菜单马上按新的勾选结果变化，被关闭的页面直连 URL 也进不去。'
          : '保存后立即生效：该职位名下账号的左侧菜单会马上按新结果变化；只落「与默认不同」的配置。'
      "
      ok-text="确认保存"
      @ok="doSave"
    >
      <div v-if="totalRemoved" class="notice w" style="margin-top: 12px">
        ⚠
        <div>
          共 <b>{{ totalRemoved }}</b> 个页面将被关闭{{ mode === 'role' ? '（对该职位）' : '' }}，
          相应用户将看不到这些菜单。
        </div>
      </div>
      <div v-if="totalAdded" class="notice g" style="margin-top: 8px">
        ✓
        <div>共 <b>{{ totalAdded }}</b> 个页面将{{ mode === 'role' ? '对该职位' : '' }}重新启用。</div>
      </div>
    </ProtoConfirm>

    <!-- ==================== 恢复默认（职位） ==================== -->
    <ProtoConfirm
      v-model="roleResetOpen"
      title="恢复默认页面可见性"
      icon="↩"
      icon-bg="#FBF3E5"
      :msg="`确认清除「${activeRole?.roleName || ''}」的全部页面可见性配置？`"
      desc="清除后该职位回到系统既有口径（就业/教务/班级/初高按职位页面权限、咨询财务按功能点换算、权限管理只给系统管理员与校长）。"
      :detail="[
        {
          k: '影响范围',
          v: `<b>${activeRole?.roleName || ''}</b> 一个职位 · 清除 <b>${activeRolePages?.overrideCount || 0}</b> 处显式配置`,
        },
      ]"
      warn="该职位当前所有手工调整会被清空，且无法撤销。"
      ok-text="确认恢复默认"
      ok-class="wn"
      @ok="doRoleReset"
    />

    <!-- ==================== 恢复全部启用（板块） ==================== -->
    <ProtoConfirm
      v-model="resetOpen"
      title="全部恢复启用"
      icon="↩"
      icon-bg="#FBF3E5"
      msg="确认把所有板块的页面恢复为启用？"
      desc="用于演示结束后一键还原 —— 所有板块的页面都会重新出现在菜单里。"
      :detail="[
        {
          k: '影响范围',
          v: `全部 <b>${boards.length}</b> 个板块、共 <b>${globalStat.total}</b> 个页面`,
        },
      ]"
      warn="各板块当前的关闭状态会被清空，且无法撤销。"
      ok-text="确认恢复"
      ok-class="wn"
      @ok="doReset"
    />
  </div>
</template>

<style scoped>
/**
 * 本页专有样式（板块卡片 + 页面行 + 左栏职位树）。
 * 其余版式（卡片 / 左右分栏 / 左列表 / 工具条）复用全局设计系统：
 *   .card .card-h .card-b —— shared-ui.css
 *   .split / .lft / .rgt / .rl-item / .cnt / .perm-tools / .cl / .lk / .tag / .notice
 *   （与「职位权限分配」共用同一套，两页版式因此保持一致）
 */

/* 左栏在长页面里跟随滚动，方便随时跳板块 / 选职位 */
.split > .lft {
  position: sticky;
  top: 10px;
  max-height: calc(100vh - 96px);
  overflow: auto;
}

.pg-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
  padding-bottom: 11px;
  border-bottom: 1px solid #F1EAE5;
}
.pg-ic {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: #FDF4F2;
  display: grid;
  place-items: center;
  font-size: 17px;
  flex: none;
}

/* ---- 左栏：板块 → 职位 ---- */
.pg-node {
  margin-bottom: 2px;
}
.pg-fold {
  width: 12px;
  flex: none;
  font-size: 10px;
  color: #B3A69F;
  cursor: pointer;
  user-select: none;
}
/* ⚠️ .rl-item 是全局类（shared-ui.css），这里只补职位行特有的细节 */
.rl-sub {
  margin-left: 14px;
  padding-left: 8px;
  font-weight: 400;
  font-size: 12px;
}
.rl-sub > span:nth-child(2) {
  flex: 1;
  min-width: 0;
}
.rl-avatar {
  width: 18px;
  height: 18px;
  flex: none;
  border-radius: 50%;
  background: #F1EAE5;
  color: #6B5C58;
  display: grid;
  place-items: center;
  font-size: 10px;
  font-weight: 600;
}
.rl-sub.on .rl-avatar {
  background: #F9E4E1;
  color: #B22A23;
}
.rl-none {
  margin-left: 14px;
  padding: 5px 8px 7px;
  font-size: 11.5px;
  color: #B3A69F;
}

/* ---- 板块卡片（对应「职位权限分配」里每个板块的一组） ---- */
.pg-board {
  border: 1px solid #EFE7E2;
  border-radius: 9px;
  margin-bottom: 10px;
  overflow: hidden;
  scroll-margin-top: 12px;
  transition: 0.15s;
}
.pg-board.on {
  border-color: #F2C8C3;
  box-shadow: 0 0 0 3px rgba(205, 58, 51, 0.07);
}
.pg-bh {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
  padding: 8px 11px;
  background: #FAF7F4;
  border-bottom: 1px solid #F1EAE5;
}
.pg-board.dirty .pg-bh {
  background: #fffaf5;
}
.pg-bic {
  font-size: 13px;
  flex: none;
}
.pg-br {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 10px;
  flex: none;
}
.pg-note {
  padding: 7px 11px;
  font-size: 11.5px;
  color: #8A5A1E;
  background: #FBF6E9;
  border-bottom: 1px solid #F0DCA8;
}
.pg-board .pg-list {
  padding: 9px 11px;
}

.pg-list {
  display: grid;
  gap: 7px;
}
.pg-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 9px 11px;
  border: 1px solid #EFE7E2;
  border-radius: 9px;
  background: #fff;
  cursor: pointer;
  transition: 0.15s;
}
.pg-item:hover {
  border-color: #F2C8C3;
  background: #FDF4F2;
}
.pg-item.off {
  background: #FAF6F2;
}
.pg-item.off .pg-t {
  color: #B3A69F;
}
.pg-item.lock {
  cursor: default;
  background: #FDF4F2;
  border-style: dashed;
}
.pg-item.lock:hover {
  border-color: #EFE7E2;
  background: #FDF4F2;
}
.pg-item .ck {
  margin-top: 2px;
  flex: none;
  width: 14px;
  height: 14px;
  accent-color: #CD3A33;
  cursor: pointer;
}
.pg-item.lock .ck {
  cursor: default;
}
.pg-t {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 12.5px;
  font-weight: 600;
  color: #443432;
  line-height: 1.5;
}
.pg-item .desc {
  margin-top: 2px;
  word-break: break-all;
}
</style>
