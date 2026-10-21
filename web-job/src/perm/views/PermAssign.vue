<script setup lang="ts">
/**
 * 职位权限分配
 *
 * DOM 结构 / class / 文案严格对齐原型《学管系统-权限体系高保真原型.html》：
 *   · 页面主体        → 原型第 2570~2631 行 renderAssign()
 *   · 权限树弹窗      → 原型第 1116~1307 行 openPermTree / renderPermTree / treeSave
 *   · 复制权限        → 原型第 2632~2658 行 copyPermFrom / doCopyPerm
 *   · 重置为预置      → 原型第 2659~2671 行 resetRolePerm
 *
 * ⚠️ 样式不写在这里：原型的 <style> 已整体移植到 src/styles/prototype.css 并在
 *    main.ts 全局引入，所以这里只产出与原型【同名同层级】的 DOM。
 * ⚠️ 权限映射 RolePermMap 的 value 是【动作编码】（如 'view'），界面要显示的中文
 *    必须按 actionCode 反查 actionName —— 否则界面上会出现英文编码。
 * ⚠️ 保存语义是【全量覆盖】：提交整棵树的勾选状态，后端先清空再插入。
 *    取消勾选 = 收回权限，系统没有「拒绝」这一层语义。
 */
import { computed, onMounted, ref } from 'vue';
import type { CSSProperties } from 'vue';
import type {
  AssignRoleItem,
  PermItem,
  PermModule,
  PermRoleDetail,
  PermTreeStats,
  RolePermMap,
} from 'shared-types/perm';
import { assignApi, roleApi } from '@/perm/api/perm';
import ProtoDialog from '@/perm/components/ProtoDialog.vue';
import ProtoConfirm from '@/perm/components/ProtoConfirm.vue';
import PermItemDialog from '@/perm/components/PermItemDialog.vue';
import { toast } from '@/perm/utils/toast';

/* ============================================================
 * 0. 原型常量 / 小工具
 * ============================================================ */

/** 原型 ROLE_ICON（第 850~851 行） */
const ROLE_ICON: Record<string, string> = {
  R01: '📞',
  R02: '📈',
  R03: '🧑‍🏫',
  R04: '👨‍🏫',
  R05: '🧑‍💼',
  R06: '📊',
  R07: '🎓',
  R08: '🗂️',
  R09: '💰',
  R10: '💼',
  R11: '📁',
  R12: '👑',
  R13: '🔧',
  /* R14 已删除（2026-10-02 去掉「实训班主任」职位），断号不再复用 */
  R15: '📋',
};

function roleIcon(id: string): string {
  return ROLE_ICON[id] || '👤';
}

/** 极简 HTML 转义（职位名 / 功能点名会进 v-html 的标题与明细） */
function esc(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/** 原型 PKEY：模块key||功能点名 */
const keyOf = (moduleKey: string, itemName: string): string => `${moduleKey}||${itemName}`;

const codesOf = (it: PermItem): string[] => it.actions.map((a) => a.actionCode);

/** 去重合并多个动作编码数组 */
function union(...groups: string[][]): string[] {
  const out: string[] = [];
  groups.forEach((g) => {
    g.forEach((c) => {
      if (!out.includes(c)) out.push(c);
    });
  });
  return out;
}

/* ============================================================
 * 1. 页面数据
 * ============================================================ */

const loading = ref(false);
const saving = ref(false);

const roles = ref<AssignRoleItem[]>([]);
const currentRoleId = ref('');

const modules = ref<PermModule[]>([]);
/** 当前职位已保存的权限（key → 动作编码数组） */
const perms = ref<RolePermMap>({});
const treeStats = ref<PermTreeStats>({ modCount: 0, itemCount: 0, actionCount: 0 });

/** 职位详情（只为取「关联账号数」，与原型 roleUserCount 对应） */
const detail = ref<PermRoleDetail | null>(null);

const currentRole = computed(() => roles.value.find((r) => r.id === currentRoleId.value) || null);
const currentRoleName = computed(() => currentRole.value?.roleName || '');
const userCount = computed(() => detail.value?.userCount ?? 0);

/* ============================================================
 * 2. 树结构整理
 *
 * 接口是扁平结构：PermItem.parentItemName 指向父功能点名。
 * 原型是「模块 → 功能点 → 二级功能点 → 动作」四层 DOM，
 * 这里把扁平数据还原成「模块 → 功能点（含子项）→ 动作组」与原型一一对应。
 * ============================================================ */

interface TreeRow {
  /** 所属模块（子项 key 拼接要用） */
  mod: PermModule;
  /** 本行 key：模块key||功能点名 */
  key: string;
  item: PermItem;
  /** 二级功能点 */
  children: PermItem[];
  /** 本行（含子项）的全部动作编码，去重 */
  codes: string[];
}

interface ModuleRow {
  mod: PermModule;
  rows: TreeRow[];
}

const treeRows = computed<ModuleRow[]>(() =>
  modules.value.map((m) => {
    // 只有「顶级功能点的名字」才算父级，避免三级数据互相吞掉
    const topNames = new Set(m.items.filter((x) => !x.parentItemName).map((x) => x.itemName));
    const tops = m.items.filter((x) => !x.parentItemName || !topNames.has(x.parentItemName));
    const rows: TreeRow[] = tops.map((it) => {
      const children = m.items.filter((x) => x.parentItemName === it.itemName);
      return {
        mod: m,
        key: keyOf(m.moduleKey, it.itemName),
        item: it,
        children,
        // ⚠️ 不做并集去重：父项自身 0 个动作 + 2 个子项各 3 个 = 6 个槽位，
        //    去重会让模块总数从 16 掉到 13，与原型 treeStats() 不符。
        codes: [...codesOf(it), ...children.flatMap((c) => codesOf(c))],
      };
    });
    return { mod: m, rows };
  }),
);

const childKey = (row: TreeRow, c: PermItem): string => keyOf(row.mod.moduleKey, c.itemName);

/** 右侧概览面板：原型 renderAssign() 里模块卡片的数据（用【已保存】的权限算） */
interface SummaryRow {
  key: string;
  name: string;
  remark?: string;
  acts: { code: string; label: string }[];
}
interface SummaryMod {
  key: string;
  icon: string;
  name: string;
  tagClass: string;
  hit: number;
  total: number;
  rows: SummaryRow[];
}

/** 按动作编码反查中文名（原型直接存中文名，开发版存编码，必须反查） */
function codeLabel(row: TreeRow, code: string): string {
  const all = [...row.item.actions, ...row.children.flatMap((c) => c.actions)];
  const hit = all.find((a) => a.actionCode === code);
  return hit ? hit.actionName : code;
}

/** 某行「已保存」的动作（本人 + 子项的并集去重） */
function savedSel(row: TreeRow): string[] {
  return union(
    perms.value[row.key] || [],
    ...row.children.map((c) => perms.value[childKey(row, c)] || []),
  );
}

const summary = computed<SummaryMod[]>(() =>
  treeRows.value.map((mr) => {
    const rows: SummaryRow[] = mr.rows.map((row) => {
      const codes = savedSel(row);
      return {
        key: row.key,
        name: row.item.itemName,
        remark: row.item.remark,
        acts: codes.map((c) => ({ code: c, label: codeLabel(row, c) })),
      };
    });
    const hit = rows.filter((r) => r.acts.length > 0).length;
    const total = rows.length;
    return {
      key: mr.mod.moduleKey,
      icon: mr.mod.moduleIcon,
      name: mr.mod.moduleName,
      hit,
      total,
      tagClass: hit === 0 ? 'gy' : hit === total ? 'g' : 'w',
      rows,
    };
  }),
);

/* ============================================================
 * 3. 加载（查询走 assignApi / roleApi）
 * ============================================================ */

async function loadRoles(): Promise<void> {
  try {
    roles.value = await assignApi.roleList();
  } catch {
    /* 错误提示由 @/perm/api/request 统一弹出 */
  }
}

async function loadTree(roleId: string): Promise<void> {
  if (!roleId) return;
  loading.value = true;
  try {
    const res = await assignApi.tree(roleId);
    modules.value = res.modules;
    perms.value = { ...res.perms };
    treeStats.value = res.stats;
  } catch {
    /* 已提示 */
  } finally {
    loading.value = false;
  }
}

async function loadDetail(roleId: string): Promise<void> {
  if (!roleId) return;
  try {
    detail.value = await roleApi.detail(roleId);
  } catch {
    detail.value = null;
  }
}

async function selectRole(roleId: string): Promise<void> {
  if (roleId === currentRoleId.value) return;
  currentRoleId.value = roleId;
  await Promise.all([loadTree(roleId), loadDetail(roleId)]);
}

/** 保存 / 复制 / 重置后：职位列表 + 详细权限全部重取 */
async function refresh(): Promise<void> {
  await loadRoles();
  if (!currentRoleId.value && roles.value.length) currentRoleId.value = roles.value[0].id;
  await Promise.all([loadTree(currentRoleId.value), loadDetail(currentRoleId.value)]);
}

onMounted(async () => {
  await loadRoles();
  if (roles.value.length) {
    currentRoleId.value = roles.value[0].id;
    await Promise.all([loadTree(currentRoleId.value), loadDetail(currentRoleId.value)]);
  }
});

/* ============================================================
 * 3.5 新增 / 管理权限点（★ 2026-10-19）
 *
 * 【要解决的事】预置权限树是「系统能力清单」，新部门（招生部）＋新职位
 *   （招生老师）常常需要清单里没有的功能点。这个弹窗让管理员自己加，
 *   加的格式与预置完全一致（板块 → 功能点 → 动作），存完立刻能勾选。
 *
 * ⚠️ 保存后必须重取权限树：模块里多了一个功能点，
 *    `treeRows` / 草稿的 key 集合都变了。
 * ⚠️ 如果权限树弹窗还开着（2026-10-20 起底栏的「新增权限」已删，
 *    但页头 / 工具条两个入口在权限树开着时仍点得到），
 *    要保留用户已经勾好的草稿，只给新功能点补空数组。
 * ============================================================ */

const itemAdminOpen = ref(false);

async function onItemSaved(): Promise<void> {
  if (!currentRoleId.value) return;
  const draftBefore = treeOpen.value ? { ...draft.value } : null;
  try {
    const res = await assignApi.tree(currentRoleId.value);
    modules.value = res.modules;
    perms.value = { ...res.perms };
    treeStats.value = res.stats;
    if (treeOpen.value && draftBefore) {
      const next: Record<string, string[]> = {};
      modules.value.forEach((m) =>
        m.items.forEach((it) => {
          const k = keyOf(m.moduleKey, it.itemName);
          next[k] = k in draftBefore ? [...draftBefore[k]] : [...(perms.value[k] || [])];
        }),
      );
      setDraft(next);
    }
    await loadRoles();
  } catch {
    /* 已提示 */
  }
}

/* ============================================================
 * 4. 权限树弹窗（原型 TREE_DRAFT / renderPermTree / treeAct / treeItem / treeMod）
 * ============================================================ */

const treeOpen = ref(false);
const treeMode = ref<'edit' | 'view'>('edit');
const treeView = computed(() => treeMode.value === 'view');

/** 草稿：key → 动作编码数组（只在弹窗内改动，点保存才落库） */
const draft = ref<Record<string, string[]>>({});
/** 各模块折叠态（原型 .ch.hide） */
const collapsed = ref<Record<string, boolean>>({});

const getDraft = (key: string): string[] => draft.value[key] || [];

function setDraft(next: Record<string, string[]>): void {
  draft.value = next;
}

/**
 * 某行「草稿中」的动作（自身 + 各子项，保留各自条目）
 * ⚠️ 不去重 —— 口径与 row.codes / RoleManage 的 rowCheckedCount 保持一致。
 */
function rowSel(row: TreeRow): string[] {
  return [
    ...getDraft(row.key),
    ...row.children.flatMap((c) => getDraft(childKey(row, c))),
  ];
}

const modAll = (mr: ModuleRow): number => mr.rows.reduce((s, r) => s + r.codes.length, 0);
const modGot = (mr: ModuleRow): number => mr.rows.reduce((s, r) => s + rowSel(r).length, 0);
const modOn = (mr: ModuleRow): boolean => {
  const all = modAll(mr);
  return all > 0 && modGot(mr) === all;
};

/** 底部「已勾选 N 项动作 · 覆盖 M 个模块」 */
const treeStat = computed(() => {
  let n = 0;
  let m = 0;
  treeRows.value.forEach((mr) => {
    let c = 0;
    mr.rows.forEach((r) => (c += rowSel(r).length));
    if (c > 0) m++;
    n += c;
  });
  return { n, m };
});

const treeTitle = computed(() => {
  const name = esc(currentRoleName.value);
  return treeView.value
    ? `查看权限 · <span class="em">${name}</span> <span class="tag n">只读模式</span>`
    : `编辑权限 · <span class="em">${name}</span> <span class="tag n">改动需点击「保存」生效</span>`;
});

/** 只读模式下复选框不可点（原型用 pointerEvents:none 而不是 disabled，视觉不变） */
const roStyle = computed<CSSProperties | undefined>(() =>
  treeView.value ? { pointerEvents: 'none', cursor: 'default' } : undefined,
);

/** 原型 openPermTree() */
function openTree(mode: 'edit' | 'view'): void {
  if (!currentRoleId.value) {
    toast('请先在左侧选择一个职位', 'warn');
    return;
  }
  // 草稿只按「树上真实存在的功能点」铺满（原型 TREE_DRAFT 同样只由 PERM_TREE 生成），
  // 这样保存时是全量覆盖，树上已删除的历史权限会被自然清掉。
  const next: Record<string, string[]> = {};
  modules.value.forEach((m) =>
    m.items.forEach((it) => {
      const k = keyOf(m.moduleKey, it.itemName);
      next[k] = [...(perms.value[k] || [])];
    }),
  );
  setDraft(next);
  collapsed.value = {};
  treeMode.value = mode;
  treeOpen.value = true;
}

function toggleMod(moduleKey: string): void {
  collapsed.value = { ...collapsed.value, [moduleKey]: !collapsed.value[moduleKey] };
}

/** 原型 treeAct()：单个动作标签勾选 */
function toggleAct(key: string, code: string): void {
  if (treeView.value) return;
  const arr = [...getDraft(key)];
  const i = arr.indexOf(code);
  if (i >= 0) arr.splice(i, 1);
  else arr.push(code);
  setDraft({ ...draft.value, [key]: arr });
}

/** 原型 treeItem()：整行勾选（本行 + 全部子项一起） */
function onItemChange(row: TreeRow, e: Event): void {
  if (treeView.value) return;
  const on = (e.target as HTMLInputElement).checked;
  const next = { ...draft.value };
  next[row.key] = on ? codesOf(row.item) : [];
  row.children.forEach((c) => (next[childKey(row, c)] = on ? codesOf(c) : []));
  setDraft(next);
}

/** 子功能点整行勾选（原型 treeItem() 的 '::' 分支） */
function onChildChange(row: TreeRow, c: PermItem, e: Event): void {
  if (treeView.value) return;
  const on = (e.target as HTMLInputElement).checked;
  setDraft({ ...draft.value, [childKey(row, c)]: on ? codesOf(c) : [] });
}

/**
 * 原型 treeMod()：模块整行勾选（on=true 全勾 / false 全清）
 * ★ 2026-10-20：原来是绑在模块左侧方块上的 `@change`（要靠 `e.target.checked`），
 *   用户删掉方块改成右侧文字之后就没有 checkbox 事件了，改成直接收一个布尔值。
 */
function setModAll(mr: ModuleRow, on: boolean): void {
  if (treeView.value) return;
  const next = { ...draft.value };
  mr.rows.forEach((row) => {
    next[row.key] = on ? codesOf(row.item) : [];
    row.children.forEach((c) => (next[childKey(row, c)] = on ? codesOf(c) : []));
  });
  setDraft(next);
}

/** ◆ 模块行右侧「全选 / 取消全选」文字：按当前状态切换本模块的全部动作 */
function toggleModAll(mr: ModuleRow): void {
  setModAll(mr, !modOn(mr));
}

/**
 * 原型 treeSelectAll()：底部「全选」——把树里全部模块的动作一次勾满。
 * ★ 2026-10-20：底部那个叫「取消」的按钮（treeSelectAll(false)，取消全部勾选）
 *   已按用户要求删掉 —— 它和「一键清空」功能重复，还和右侧真正关闭弹窗的
 *   「取消」撞名，一屏两个「取消」让人分不清。清空请走「一键清空」（带二次确认）。
 */
function treeSelectAll(): void {
  if (treeView.value) return;
  const next = { ...draft.value };
  treeRows.value.forEach((mr) =>
    mr.rows.forEach((row) => {
      next[row.key] = codesOf(row.item);
      row.children.forEach((c) => (next[childKey(row, c)] = codesOf(c)));
    }),
  );
  setDraft(next);
  toast('已全选全部权限', 'warn');
}

/* ---- 一键清空（原型 treeClear：先确认，再清空草稿，仍需点保存才生效） ---- */
const clearOpen = ref(false);

function treeClearAsk(): void {
  if (treeView.value) return;
  clearOpen.value = true;
}

function doTreeClear(): void {
  clearOpen.value = false;
  const next = { ...draft.value };
  Object.keys(next).forEach((k) => (next[k] = []));
  setDraft(next);
  toast('已清空，请点击保存生效', 'warn');
}

/* ---- 保存（原型 treeSave：确认 → 落库） ---- */
const saveOpen = ref(false);

function treeSaveAsk(): void {
  saveOpen.value = true;
}

const saveDetail = computed<{ k: string; v: string }[]>(() => [
  { k: '职位', v: esc(currentRoleName.value) },
  { k: '勾选动作', v: `<b>${treeStat.value.n}</b> 项` },
  { k: '影响账号', v: `<b>${userCount.value}</b> 个账号` },
]);

async function doSaveTree(): Promise<void> {
  saveOpen.value = false;
  if (!currentRoleId.value) return;
  saving.value = true;
  try {
    const payload: RolePermMap = {};
    Object.keys(draft.value).forEach((k) => {
      const v = draft.value[k] || [];
      if (v.length) payload[k] = [...v];
    });
    const res = await assignApi.save(currentRoleId.value, payload);
    treeOpen.value = false;
    toast(`已保存 ${res.permCount} 项权限，${userCount.value} 个账号已生效`);
    await refresh();
  } catch {
    /* 已提示 */
  } finally {
    saving.value = false;
  }
}

/* ============================================================
 * 5. 从其他职位复制（原型 copyPermFrom / doCopyPerm）
 * ============================================================ */

const copyOpen = ref(false);
const copySourceId = ref('');
const copyConfirmOpen = ref(false);

const copyCandidates = computed(() => roles.value.filter((r) => r.id !== currentRoleId.value));
const copySource = computed(() => roles.value.find((r) => r.id === copySourceId.value) || null);

const copyTitle = computed(
  () => `从其他职位复制权限 <span class="tag n">目标：${esc(currentRoleName.value)}</span>`,
);

const copyDetail = computed<{ k: string; v: string }[]>(() => {
  const s = copySource.value;
  const t = currentRole.value;
  if (!s || !t) return [];
  return [
    { k: '来源职位', v: `${esc(s.roleName)} · ${s.permCount} 项` },
    { k: '目标职位', v: `${esc(t.roleName)} · 现有 ${t.permCount} 项` },
    { k: '复制后', v: `目标职位权限变为 <b>${s.permCount}</b> 项` },
    { k: '影响账号', v: `${userCount.value} 人` },
  ];
});

function openCopy(): void {
  if (!currentRoleId.value) {
    toast('请先在左侧选择一个职位', 'warn');
    return;
  }
  copySourceId.value = '';
  copyOpen.value = true;
}

function pickCopySource(id: string): void {
  copySourceId.value = id;
  copyConfirmOpen.value = true;
}

async function doCopy(): Promise<void> {
  copyConfirmOpen.value = false;
  if (!currentRoleId.value || !copySourceId.value) return;
  const targetName = currentRoleName.value;
  try {
    const res = await assignApi.copy(currentRoleId.value, copySourceId.value);
    copyOpen.value = false;
    toast(`已从「${res.sourceRoleName}」复制 ${res.permCount} 项权限到「${targetName}」`);
    await refresh();
  } catch {
    /* 已提示 */
  }
}

/* ============================================================
 * 6. 重置为预置（原型 resetRolePerm）
 * ============================================================ */

const resetOpen = ref(false);

const resetDetail = computed<{ k: string; v: string }[]>(() => [
  { k: '当前权限', v: `${currentRole.value?.permCount ?? 0} 项` },
  { k: '重置后', v: '恢复全部模块权限' },
  { k: '影响账号', v: `${userCount.value} 人` },
]);

async function doReset(): Promise<void> {
  resetOpen.value = false;
  if (!currentRoleId.value) return;
  const name = currentRoleName.value;
  try {
    await assignApi.reset(currentRoleId.value, 'full');
    toast(`已重置「${name}」的权限`, 'warn');
    await refresh();
  } catch {
    /* 已提示 */
  }
}

/* ★ 2026-10-20 按用户要求删除「查看账号」入口：
     本页是"配置职位权限"的地方，看这个职位下有哪些账号属于「部门管理 / 账号管理」的职责，
     夹在「配置权限 / 从其他职位复制」旁边容易被误点。
     入口、弹窗、状态、openRoleUsers() 一并删除（无其他调用方）。
     关联账号数仍在职位信息行「{{ currentRole.deptName }} · 关联账号 {{ userCount }} 人」展示。 */
</script>

<template>
  <div>
    <!-- ==================== 主体（原型 #page-assign） ==================== -->
    <div class="card">
      <div class="card-h">
        <div class="t"><span class="bar"></span>职位权限分配</div>
        <div class="r">
          <span class="desc">左侧选择职位 → 右侧勾选权限 → 保存生效</span>
          <button class="btn" type="button" @click="openTree('view')">全屏查看</button>
          <button class="btn" type="button" @click="resetOpen = true">重置为预置</button>
          <button class="btn wn" type="button" @click="itemAdminOpen = true">＋ 新增权限</button>
          <button class="btn pri" type="button" @click="openTree('edit')">编辑该职位权限</button>
        </div>
      </div>

      <div class="card-b">
        <div class="split">
          <!-- ---------- 左：职位列表 ---------- -->
          <div class="lft">
            <div class="desc" style="padding: 4px 6px 7px">职位列表（{{ roles.length }}）</div>
            <div v-if="loading && !roles.length" class="empty">
              <div class="ic">⏳</div>
              加载中…
            </div>
            <div v-else-if="!roles.length" class="empty">
              <div class="ic">🎭</div>
              暂无职位
            </div>
            <template v-else>
              <div
                v-for="r in roles"
                :key="r.id"
                class="rl-item"
                :class="{ on: r.id === currentRoleId }"
                @click="selectRole(r.id)"
              >
                <span>{{ roleIcon(r.id) }} {{ r.roleName }}</span><span class="cnt">{{ r.permCount }}</span>
              </div>
            </template>
          </div>

          <!-- ---------- 右：权限概览 ---------- -->
          <div class="rgt">
            <template v-if="currentRole">
              <div
                style="
                  display: flex;
                  align-items: center;
                  gap: 10px;
                  margin-bottom: 12px;
                  padding-bottom: 11px;
                  border-bottom: 1px solid var(--line2);
                "
              >
                <div
                  style="
                    width: 36px;
                    height: 36px;
                    border-radius: 10px;
                    background: var(--brand-l);
                    display: grid;
                    place-items: center;
                    font-size: 17px;
                  "
                >
                  {{ roleIcon(currentRole.id) }}
                </div>
                <div>
                  <div style="font-weight: 600; font-size: 14px">
                    {{ currentRole.roleName }}
                    <span v-if="currentRole.isSys" class="tag p">预置</span>
                    <span v-else class="tag g">自建</span>
                  </div>
                  <div class="desc">{{ currentRole.deptName }} · 关联账号 {{ userCount }} 人</div>
                </div>
                <div style="margin-left: auto; text-align: right">
                  <div style="font-size: 19px; font-weight: 700; color: var(--brand)">
                    {{ currentRole.permCount }}
                  </div>
                  <div class="desc">已授权动作</div>
                </div>
              </div>

              <div class="perm-tools">
                <button class="btn xs" type="button" @click="openTree('edit')">＋ 配置权限</button>
                <button class="btn xs" type="button" @click="openCopy">从其他职位复制</button>
                <!-- ★ 2026-10-20 按用户要求删掉这里的「查看账号」按钮；
                     同轮删掉「＋ 新增权限」：本页顶部工具条（重置为预置 / ＋ 新增权限 / 编辑该职位权限）已有入口，
                     这个位置离「配置权限」太近，容易点错成"加权限点"而不是"配权限"。 -->
                <span class="cl">共 {{ treeStats.modCount }} 个模块 / {{ treeStats.actionCount }} 个权限点</span>
              </div>

              <div v-if="loading" class="empty">
                <div class="ic">⏳</div>
                加载中…
              </div>
              <div v-else-if="!summary.length" class="empty">
                <div class="ic">🗂️</div>
                暂无权限数据
              </div>

              <template v-else>
                <div
                  v-for="m in summary"
                  :key="m.key"
                  style="border: 1px solid var(--line); border-radius: 8px; margin-bottom: 8px; overflow: hidden"
                >
                  <div style="padding: 8px 11px; background: #FAF7F4; display: flex; align-items: center; gap: 8px">
                    <span style="font-size: 13px">{{ m.icon }}</span>
                    <b style="font-size: 12.5px">{{ m.name }}</b>
                    <span class="tag" :class="m.tagClass">{{ m.hit }}/{{ m.total }}</span>
                    <span class="lk" style="margin-left: auto" @click="openTree('edit')">编辑</span>
                  </div>
                  <div style="padding: 9px 11px">
                    <div
                      v-for="row in m.rows"
                      :key="row.key"
                      style="display: flex; gap: 8px; margin-bottom: 6px; align-items: flex-start"
                    >
                      <div
                        style="min-width: 132px; font-size: 12.5px"
                        :style="{ color: row.acts.length ? 'var(--tx)' : 'var(--tx3)' }"
                      >
                        {{ row.acts.length ? '●' : '○' }} {{ row.name }}
                      </div>
                      <div style="flex: 1">
                        <template v-if="row.acts.length">
                          <span
                            v-for="a in row.acts"
                            :key="a.code"
                            class="tag b"
                            style="margin: 0 3px 3px 0"
                          >
                            {{ a.label }}
                          </span>
                        </template>
                        <span v-else class="desc">未授权</span>
                      </div>
                    </div>
                    <div v-for="row in m.rows.filter((x) => x.remark)" :key="`n-${row.key}`" class="desc">
                      ※ {{ row.remark }}
                    </div>
                  </div>
                </div>
              </template>
            </template>

            <div v-else class="empty">
              <div class="ic">👈</div>
              请在左侧选择一个职位
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ==================== 权限树弹窗（原型 openPermTree） ==================== -->
    <ProtoDialog v-model="treeOpen" :title="treeTitle" size="lg">
      <div class="notice i mb12">
        ℹ
        <div>
          <b>两种勾选方式：</b>① 点功能点左侧的<b>方框</b>可一次性勾选该功能点的全部动作；
          ② 也可<b>单独点击下方任意一个动作标签</b>（如「查看」「新建」「编辑」），自由组合勾选其中一项或几项。
          勾选后点<b>保存</b>即生效。
        </div>
      </div>

      <div>
        <div class="tree">
          <div v-for="mr in treeRows" :key="mr.mod.moduleKey" class="mod">
            <div class="n">
              <span class="cx" @click="toggleMod(mr.mod.moduleKey)">
                {{ collapsed[mr.mod.moduleKey] ? '▸' : '▾' }}
              </span>
              <span class="nm" @click="toggleMod(mr.mod.moduleKey)">
                {{ mr.mod.moduleIcon }} {{ mr.mod.moduleName }}
              </span>
              <!-- ★ 2026-10-20 按用户要求：模块标题左侧那个「整模块全选」方块已删除，
                   改成右侧的文字「全选 / 取消全选」（点一下切换本模块的全部动作）。
                   只读模式（查看权限）下不渲染 —— 点了也不能改，摆着只会误导。 -->
              <span
                v-if="!treeView"
                class="mod-all"
                :class="{ on: modOn(mr) }"
                @click="toggleModAll(mr)"
              >
                {{ modOn(mr) ? '取消全选' : '全选' }}
              </span>
              <span class="cnt">{{ modGot(mr) }}/{{ modAll(mr) }}</span>
            </div>

            <div class="ch" :class="{ hide: collapsed[mr.mod.moduleKey] }">
              <template v-for="row in mr.rows" :key="row.key">
                <div class="n" :style="row.children.length ? { fontWeight: 600 } : undefined">
                  <input
                    type="checkbox"
                    :checked="rowSel(row).length > 0"
                    :style="roStyle"
                    @change="onItemChange(row, $event)"
                  />
                  <span class="nm">{{ row.item.itemName }}</span>
                  <span v-if="row.item.isCustom" class="tag b" style="flex: none; margin-left: 4px">自建</span>
                  <span class="cnt">{{ rowSel(row).length }}/{{ row.codes.length }}</span>
                </div>

                <div v-if="row.item.actions.length" class="acts-g">
                  <span
                    v-for="a in row.item.actions"
                    :key="a.actionCode"
                    class="act"
                    :class="{ on: getDraft(row.key).includes(a.actionCode), ro: treeView }"
                    @click="toggleAct(row.key, a.actionCode)"
                  >
                    <i class="bx"></i>{{ a.actionName }}
                  </span>
                </div>

                <template v-for="c in row.children" :key="childKey(row, c)">
                  <div class="n" style="padding-left: 18px">
                    <input
                      type="checkbox"
                      :checked="getDraft(childKey(row, c)).length > 0"
                      :style="roStyle"
                      @change="onChildChange(row, c, $event)"
                    />
                    <span class="nm">{{ c.itemName }}</span>
                    <span class="cnt">{{ getDraft(childKey(row, c)).length }}/{{ c.actions.length }}</span>
                  </div>
                  <div class="acts-g">
                    <span
                      v-for="a in c.actions"
                      :key="a.actionCode"
                      class="act"
                      :class="{ on: getDraft(childKey(row, c)).includes(a.actionCode), ro: treeView }"
                      @click="toggleAct(childKey(row, c), a.actionCode)"
                    >
                      <i class="bx"></i>{{ a.actionName }}
                    </span>
                  </div>
                </template>

                <div
                  v-if="row.item.remark"
                  class="desc"
                  style="padding-left: 22px; margin-bottom: 5px"
                >
                  ※ {{ row.item.remark }}
                </div>
              </template>
            </div>
          </div>
        </div>
      </div>

      <template #footer>
        <div class="lft">
          已勾选 <b style="color: var(--brand)">{{ treeStat.n }}</b> 项动作 · 覆盖
          <b style="color: var(--brand)">{{ treeStat.m }}</b> 个模块
        </div>
        <template v-if="!treeView">
          <!-- ★ 2026-10-20 按用户要求，底栏从 6 个按钮收敛到 4 个：
               · 删掉「＋ 新增权限」—— 页头/工具条已有同一入口，弹窗里再放一个容易
                 在半勾选状态下误开另一个弹窗，改权限点的场景也不该发生在配权限时。
               · 删掉原来那个叫「取消」的（treeSelectAll(false)，取消全部勾选）——
                 它和「一键清空」功能重复，又和右侧真正关闭弹窗的「取消」撞名。
               现在：全选 / 一键清空 / 取消（关弹窗）/ 保存权限 -->
          <button class="btn" type="button" @click="treeSelectAll()">全选</button>
          <button class="btn" type="button" @click="treeClearAsk">一键清空</button>
          <button class="btn" type="button" @click="treeOpen = false">取消</button>
          <button class="btn pri" type="button" :disabled="saving" @click="treeSaveAsk">保存权限</button>
        </template>
        <button v-else class="btn" type="button" @click="treeOpen = false">关闭</button>
      </template>
    </ProtoDialog>

    <!-- ==================== 从其他职位复制（原型 copyPermFrom） ==================== -->
    <ProtoDialog v-model="copyOpen" :title="copyTitle" size="md">
      <div class="notice w mb12">⚠<div>复制将<b>覆盖</b>目标职位当前的权限配置，请谨慎操作。</div></div>
      <div style="border: 1px solid var(--line); border-radius: 9px; padding: 9px; max-height: 320px; overflow-y: auto">
        <div v-for="r in copyCandidates" :key="r.id" class="rl-item" @click="pickCopySource(r.id)">
          <span>{{ roleIcon(r.id) }} {{ r.roleName }}</span>
          <span class="cnt">{{ r.permCount }} 项权限</span>
        </div>
        <div v-if="!copyCandidates.length" class="empty">
          <div class="ic">🎭</div>
          没有可复制的其他职位
        </div>
      </div>
      <div class="notice i mt12">ℹ<div>复制后两职位权限完全一致，后续可再单独微调。</div></div>

      <template #footer>
        <button class="btn" type="button" @click="copyOpen = false">取消</button>
      </template>
    </ProtoDialog>

    <!-- ★ 2026-10-20 「查看账号」弹窗整块删除（入口已删，无其他调用方） -->

    <!-- ==================== 确认框（原型 confirmDlg） ==================== -->
    <ProtoConfirm
      v-model="copyConfirmOpen"
      title="复制权限确认"
      icon="📋"
      :msg="`确认将「${copySource?.roleName || ''}」的权限复制到「${currentRoleName}」？`"
      :detail="copyDetail"
      warn="目标职位原有权限将被完全覆盖。"
      ok-text="确认复制"
      @ok="doCopy"
    />

    <ProtoConfirm
      v-model="resetOpen"
      title="重置为预置权限"
      icon="↩"
      icon-bg="var(--warn-l)"
      :msg="`确认将「${currentRoleName}」重置为系统预置权限？`"
      desc="系统将按该职位的标准职责重新生成权限配置。"
      :detail="resetDetail"
      warn="当前自定义的权限调整将丢失，且无法撤销。"
      ok-text="确认重置"
      ok-class="wn"
      @ok="doReset"
    />

    <ProtoConfirm
      v-model="clearOpen"
      title="清空权限"
      icon="🗑"
      icon-bg="var(--dg-l)"
      msg="确认清空该职位的全部权限？"
      :desc="`当前共勾选 <b>${treeStat.n}</b> 项动作，清空后该职位将没有任何功能可用。`"
      warn="清空后职位下的账号登录将看不到任何菜单，请谨慎操作。"
      ok-text="确认清空"
      ok-class="dg"
      @ok="doTreeClear"
    />

    <ProtoConfirm
      v-model="saveOpen"
      title="保存权限配置"
      icon="💾"
      :msg="`确认保存 ${currentRoleName} 的权限配置？`"
      :detail="saveDetail"
      tip="保存后立即生效，相关账号下次刷新页面即可看到新菜单。"
      ok-text="确认保存"
      @ok="doSaveTree"
    />

    <!-- ==================== 新增/维护权限点（自建权限） ==================== -->
    <PermItemDialog v-model="itemAdminOpen" @saved="onItemSaved" />
  </div>
</template>
