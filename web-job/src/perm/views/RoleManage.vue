<script setup lang="ts">
/**
 * 职位管理
 *
 * 页面结构严格对齐高保真原型《学管系统-权限体系高保真原型.html》：
 *   · 第 1491~1551 行 renderRoleList()      —— 筛选条 + 职位表格 + 行内操作
 *   · 第 1554~1598 行 openRoleDetail()      —— 职位详情弹窗（基本信息 + 权限覆盖 + 职位下账号）
 *   · 第 1599~1612 行 openRoleUsers()       —— 职位下人员弹窗
 *   · 第 1613~1625 行 removeRoleFromUser()  —— 移出职位确认
 *   · 第 1626~1640 行 toggleRole()          —— 停用 / 启用确认
 *   · 第 1641~1671 行 delRole()             —— 删除确认（预置不可删 / 有关联账号不可删）
 *   · 第 1675~1740 行 openRoleForm()        —— 新建 / 编辑职位弹窗（含模板 + 权限预览）
 *   · 第 1740~1783 行 permPreviewHtml / openFormPermTree / applyFormPerm
 *   · 第 1784~1807 行 ROLE_TPL / applyRoleTpl  —— 权限模板
 *   · 第 1808~1857 行 submitRoleForm()      —— 校验 + 确认后落库
 *   · 第 1858~1914 行 dlgImportRole / dlgImportPreview / doImport / exportDlg / selOne
 *   · 第 1148~1317 行 renderPermTree / treeAct / treeItem / treeMod / treeTog /
 *                     treeSelectAll / treeClear / updatePermStat —— 权限树
 *
 * ⚠️ 样式不写在这里：原型的 <style> 已逐字节移植到 src/styles/prototype.css
 *    （main.ts 全局引入），这里只产出与原型【同名同层级】的 DOM。
 *
 * ⚠️ 与原型的三处「数据模型对齐」（不是视觉差异）：
 *    ① 权限草稿的 key 沿用后端约定 `模块key||功能点名`，value 是【动作编码】
 *       （如 'view'），显示中文一律取 action.actionName —— 原型里 value 是中文动作名，
 *       开发版必须先映射，否则存进库里的就是「查看」这种中文，后端认不出来。
 *    ② 原型 openPermTree 的「二级功能点」子项在开发版数据里是【扁平的】：
 *       /api/perm/menu/tree 的 approve 模块只有「教质/学术审批」这一个功能点
 *       （自带 view/agree/reject 三个动作），并没有「休学/退学审批」「退费审批」两个子项，
 *       所以按原型「功能点 → 动作」的单层结构渲染即可。
 *    ③ 原型表单里的「关联部门（该职位可见的数据部门）」在开发版没有落库字段
 *       （PermRoleSavePayload 无此字段），开发版把「数据范围」建模成了权限点
 *       （perm 模块的「数据权限（行级）」功能点：本人/本班级/本部门/全部数据），
 *       所以这一段不渲染，改由权限树勾选。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { PERM_ROUTE } from '@/perm/utils/links';
import type {
  PermDeptTreeNode,
  PermItem,
  PermModule,
  PermRoleDetail,
  PermRoleListItem,
  PermUserListItem,
  RoleOverview,
  RolePermMap,
  RoleStatus,
  RoleType,
} from 'shared-types/perm';
import { deptApi, exportApi, roleApi, userApi } from '@/perm/api/perm';
import { useOptionStore } from '@/perm/stores/option';
import { usePermStore } from '@/perm/stores/perm';
import ProtoDialog from '@/perm/components/ProtoDialog.vue';
import ProtoConfirm from '@/perm/components/ProtoConfirm.vue';
import UserDetailDialog from '@/perm/components/UserDetailDialog.vue';
import { toast } from '@/perm/utils/toast';
import { roleIconOf } from '@/perm/utils/roleIcon';

const router = useRouter();
const optionStore = useOptionStore();
const permStore = usePermStore();

/** 极简 HTML 转义（弹窗标题 / 确认框 desc·detail 走 v-html，职位名是用户输入） */
function esc(s: string): string {
  return String(s ?? '').replace(/[&<>"]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;',
  );
}

/** 权限草稿 key：与后端约定一致 —— `模块key||功能点名` */
const permKey = (moduleKey: string, itemName: string): string => `${moduleKey}||${itemName}`;

/** 只保留非空项（提交 / 落库用） */
function cleanPerms(p: RolePermMap): RolePermMap {
  const out: RolePermMap = {};
  Object.keys(p).forEach((k) => {
    if (p[k]?.length) out[k] = [...p[k]];
  });
  return out;
}

/** 深拷贝（草稿隔离，取消不留痕） */
function clonePerms(p: RolePermMap): RolePermMap {
  const out: RolePermMap = {};
  Object.keys(p).forEach((k) => {
    out[k] = [...(p[k] || [])];
  });
  return out;
}

/** 已勾选动作总数 */
function countActions(p: RolePermMap): number {
  return Object.keys(p).reduce((s, k) => s + (p[k]?.length || 0), 0);
}

/** 覆盖模块数 */
function countModules(p: RolePermMap): number {
  const mods = new Set<string>();
  Object.keys(p).forEach((k) => {
    if (p[k]?.length) mods.add(k.split('||')[0]);
  });
  return mods.size;
}

/** 职位图标 —— 统一走 @/perm/utils/roleIcon（列表 / 弹窗 / 详情三处共用一份映射表） */
const roleIcon = roleIconOf;

/* ★ 2026-10-20：职位类型（业务/管理/职能/系统职位）已按用户要求从界面上整列移除 ——
 *   列表列、筛选下拉、详情弹窗、新建/编辑表单、批量导入、导出表都不再展示或让人填。
 *   ⚠️ 字段本身（t_perm_role.role_type）与接口里的一律保留：
 *      数据仍按原值存着，编辑职位时原样带回、保存时原样提交，不会被重置成「业务职位」。
 *      原先用于给类型标签配色的 typeTag() 因此一并删除（没有落点了）。 */

/* ============================================================
 * 一、列表（原型 ROLE_FILTER + renderRoleList）
 * ============================================================ */

const loading = ref(false);
const list = ref<PermRoleListItem[]>([]);
const total = ref(0);
/** KPI 数据：本页不展示 KPI，仅用于「预置职位共 N 个」这句文案 */
const overview = ref<RoleOverview | null>(null);

const query = reactive({
  page: 1,
  size: 10,
  keyword: '',
  roleStatus: '',
  deptId: '',
});

const pageCount = computed(() => Math.max(1, Math.ceil(total.value / query.size)));

async function load(): Promise<void> {
  loading.value = true;
  try {
    const res = await roleApi.list({ ...query });
    list.value = res.list || [];
    total.value = res.total || 0;
  } catch {
    /* 错误已在 request 拦截器里弹过提示 */
  } finally {
    loading.value = false;
  }
}

async function loadOverview(): Promise<void> {
  try {
    overview.value = await roleApi.overview();
  } catch {
    /* 已提示 */
  }
}

/* ============================================================
 * 二、字典与权限树（Pinia 缓存，整会话各只请求一次）
 * ============================================================ */

const modules = ref<PermModule[]>([]);
/** 部门下拉（由部门树拍平；原型 DEPTS 的等价物） */
const flatDepts = ref<{ id: string; deptName: string; isRoot: boolean }[]>([]);

/** 原型表单里「所属部门」默认选中市场咨询部；开发版取第一个非校级部门 */
const defaultDeptId = computed(
  () => flatDepts.value.find((d) => !d.isRoot)?.id || flatDepts.value[0]?.id || '',
);

const deptNameOf = (id: string): string => flatDepts.value.find((d) => d.id === id)?.deptName || '—';

const roleStatuses = computed<{ value: string; label: string }[]>(() =>
  optionStore.roleStatuses.length
    ? optionStore.roleStatuses.map((o) => ({ value: String(o.value), label: o.label }))
    : ['启用', '停用'].map((v) => ({ value: v, label: v })),
);

async function loadMeta(): Promise<void> {
  try {
    // ⚠️ 部门下拉【必须】拍平部门树 deptApi.tree()，不能用权限树：
    //    权限树节点是 { moduleKey, moduleName, items }，没有 id / deptName。
    const [tree, , deptTree] = await Promise.all([
      permStore.loadTree(),
      optionStore.load(),
      deptApi.tree(),
    ]);
    modules.value = tree;

    const flat: { id: string; deptName: string; isRoot: boolean }[] = [];
    const walk = (nodes: PermDeptTreeNode[], depth: number): void => {
      nodes.forEach((n) => {
        flat.push({ id: n.id, deptName: n.deptName, isRoot: depth === 0 });
        if (n.children?.length) walk(n.children, depth + 1);
      });
    };
    walk(deptTree, 0);
    flatDepts.value = flat;
  } catch {
    /* 已提示 */
  }
}

onMounted(() => {
  void Promise.all([loadMeta(), loadOverview(), load()]);
});

/* ============================================================
 * 三、筛选（原型：改筛选条件即时重渲染列表）
 * ============================================================ */

let keywordTimer = 0;

function reloadFromFirstPage(): void {
  query.page = 1;
  void load();
}

/** 原型是 oninput 即时过滤；开发版打的是接口，做个 300ms 防抖，用户无感 */
function onKeywordInput(): void {
  window.clearTimeout(keywordTimer);
  keywordTimer = window.setTimeout(reloadFromFirstPage, 300);
}

function resetFilter(): void {
  Object.assign(query, { page: 1, keyword: '', roleStatus: '', deptId: '' });
  void load();
  toast('已重置筛选条件', 'warn');
}

function goPage(p: number): void {
  const next = Math.min(Math.max(1, p), pageCount.value);
  if (next === query.page) return;
  query.page = next;
  void load();
}

/* ============================================================
 * 四、确认框（原型 confirmDlg）—— 本页所有确认共用
 * ============================================================ */

interface ConfirmCfg {
  title: string;
  icon: string;
  iconBg: string;
  msg: string;
  desc: string;
  detail: { k: string; v: string }[];
  warn: string;
  tip: string;
  okText: string;
  okClass: string;
  cancelText: string;
}

const CONFIRM_DEFAULT: ConfirmCfg = {
  title: '确认操作',
  icon: '',
  iconBg: 'var(--brand-l)',
  msg: '',
  desc: '',
  detail: [],
  warn: '',
  tip: '',
  okText: '确定',
  okClass: 'pri',
  cancelText: '取消',
};

const confirmOpen = ref(false);
const cfg = reactive<ConfirmCfg>({ ...CONFIRM_DEFAULT, detail: [] });
let confirmAction: () => void = () => undefined;

function openConfirm(c: Partial<ConfirmCfg>, onOk: () => void): void {
  Object.assign(cfg, CONFIRM_DEFAULT, { detail: [] }, c);
  confirmAction = onOk;
  confirmOpen.value = true;
}

function onConfirmOk(): void {
  confirmOpen.value = false;
  confirmAction();
}

/* ============================================================
 * 五、职位详情（原型 openRoleDetail）
 * ============================================================ */

const detailOpen = ref(false);
const detail = ref<PermRoleDetail | null>(null);
const detailUsers = ref<PermUserListItem[]>([]);
const detailLoading = ref(false);

const detailTitle = computed(
  () => `职位详情 · <span class="em">${esc(detail.value?.roleName || '')}</span>`,
);

/** 权限覆盖情况：某模块下「已授权功能点」的文案 */
function coverText(m: PermModule): string {
  const perms = detail.value?.perms || {};
  const has = m.items.filter((it) => (perms[permKey(m.moduleKey, it.itemName)] || []).length > 0);
  return has.length ? `✅ ${has.map((x) => x.itemName).join('、')}` : '❌ 无权限';
}

async function openDetail(row: PermRoleListItem): Promise<void> {
  detail.value = null;
  detailUsers.value = [];
  detailOpen.value = true;
  detailLoading.value = true;
  try {
    const [d, users] = await Promise.all([
      roleApi.detail(row.id),
      userApi.list({ roleId: row.id, page: 1, size: 100 }),
    ]);
    detail.value = d;
    detailUsers.value = users.list || [];
  } catch {
    /* 已提示 */
  } finally {
    detailLoading.value = false;
  }
}

/* ============================================================
 * 六、权限树（原型 openPermTree / renderPermTree / treeXxx / updatePermStat）
 *    两种模式（★ 2026-10-20：原为三种，edit 随「职位详情 → 编辑权限」按钮一起删除）：
 *      view —— 只读查看（列表「权限数」）。编辑权限改去「职位权限分配」页
 *      form —— 职位表单草稿（表单「＋ 配置权限」）→ 应用到表单
 * ============================================================ */

type TreeMode = 'view' | 'form';

const treeOpen = ref(false);
const treeMode = ref<TreeMode>('view');
const treeTitle = ref('');
const treeDraft = ref<RolePermMap>({});
const treeRoleName = ref('');
/** 模块折叠（原型 treeTog） */
const collapsed = reactive<Record<string, boolean>>({});

const readonlyTree = computed(() => treeMode.value === 'view');

const checkedOf = (moduleKey: string, itemName: string): string[] =>
  treeDraft.value[permKey(moduleKey, itemName)] || [];

const setChecked = (moduleKey: string, itemName: string, codes: string[]): void => {
  treeDraft.value = { ...treeDraft.value, [permKey(moduleKey, itemName)]: codes };
};

/* ---- 树行结构：功能点 + 二级功能点（原型 it.sub） ----
   ⚠️ 接口给回来的 items 是【扁平】的，二级功能点靠 parentItemName 关联父项。
      例：审批中心的「教质/学术审批」是父功能点，自身不挂动作，
          动作都在「休学/退学审批」「退费审批」两个二级功能点上。 */
interface TreeRow {
  mod: PermModule;
  item: PermItem;
  children: PermItem[];
}

const treeRows = computed<{ mod: PermModule; rows: TreeRow[] }[]>(() =>
  modules.value.map((m) => {
    // 只有「顶级功能点的名字」才算父级，避免层级数据互相吞掉
    const topNames = new Set(m.items.filter((x) => !x.parentItemName).map((x) => x.itemName));
    const tops = m.items.filter((x) => !x.parentItemName || !topNames.has(x.parentItemName));
    return {
      mod: m,
      rows: tops.map((it) => ({
        mod: m,
        item: it,
        children: m.items.filter((x) => x.parentItemName === it.itemName),
      })),
    };
  }),
);

const modRows = (m: PermModule): TreeRow[] =>
  treeRows.value.find((x) => x.mod.moduleKey === m.moduleKey)?.rows || [];

/** 行的动作总数（自身 + 子项；父项自身不挂动作，故不会重复计） */
const rowTotal = (row: TreeRow): number =>
  row.item.actions.length + row.children.reduce((s, c) => s + c.actions.length, 0);

/**
 * 行已勾选动作数
 * ⚠️ 按【自身 + 各子项】求和，不做并集去重 —— 父项「教质/学术审批」的 2 个子项
 *    动作名相同（查看/同意/驳回），去重会让父项显示 3/6、模块总数从 16 掉到 13。
 *    与原型 allActsOf() / treeStats() 的口径保持一致。
 */
const rowCheckedCount = (row: TreeRow): number =>
  checkedOf(row.mod.moduleKey, row.item.itemName).length +
  row.children.reduce((s, c) => s + checkedOf(row.mod.moduleKey, c.itemName).length, 0);

const modTotal = (m: PermModule): number => modRows(m).reduce((s, r) => s + rowTotal(r), 0);

const modChecked = (m: PermModule): number =>
  modRows(m).reduce((s, r) => s + rowCheckedCount(r), 0);

const modOn = (m: PermModule): boolean => modTotal(m) > 0 && modChecked(m) === modTotal(m);

const treeActionCount = computed(() => countActions(treeDraft.value));
const treeModuleCount = computed(() => {
  const mods = new Set<string>();
  Object.keys(treeDraft.value).forEach((k) => {
    if (treeDraft.value[k]?.length) mods.add(k.split('||')[0]);
  });
  return mods.size;
});

function collapseAll(): void {
  Object.keys(collapsed).forEach((k) => {
    collapsed[k] = false;
  });
}

function openTreeWith(roleName: string, perms: RolePermMap): void {
  treeRoleName.value = roleName;
  treeMode.value = 'view';
  treeDraft.value = clonePerms(perms);
  collapseAll();

  /* ★ 2026-10-20 只剩「查看权限」一种口径：原来按 mode 分两套标题，
     编辑模式随详情弹窗那个按钮一起删掉了。 */
  treeTitle.value = `查看权限 · <span class="em">${esc(roleName)}</span> <span class="tag n" style="font-weight:400">只读模式</span>`;
  treeOpen.value = true;
}

/** 列表「权限数」→ 查看权限（只读；编辑权限请去「职位权限分配」页） */
async function openPermTree(row: PermRoleListItem): Promise<void> {
  try {
    const d = await roleApi.detail(row.id);
    openTreeWith(row.roleName, d.perms || {});
  } catch {
    /* 已提示 */
  }
}

/* ★ 2026-10-20 删除 openPermTreeFromDetail()：它只服务「职位详情」底栏那个
   「编辑权限」按钮，按钮已按用户要求删除 → 函数失去唯一调用方，属死代码。
   权限编辑入口现在只剩「职位权限分配」页（那边是完整的编辑 UI）。 */

/** 表单「＋ 配置权限」（原型 openFormPermTree） */
function openFormTree(): void {
  treeMode.value = 'form';
  treeRoleName.value = form.roleName;
  treeDraft.value = clonePerms(draftPerms.value);
  collapseAll();
  treeTitle.value =
    '配置权限（职位表单草稿） <span class="tag n" style="font-weight:400">保存后回到职位表单</span>';
  treeOpen.value = true;
}

function toggleModCollapse(moduleKey: string): void {
  collapsed[moduleKey] = !collapsed[moduleKey];
}

/* ---- 勾选（原型 treeAct / treeItem / treeMod / treeSelectAll） ---- */

function toggleAct(moduleKey: string, itemName: string, code: string): void {
  if (readonlyTree.value) return;
  const cur = [...checkedOf(moduleKey, itemName)];
  const i = cur.indexOf(code);
  if (i >= 0) cur.splice(i, 1);
  else cur.push(code);
  setChecked(moduleKey, itemName, cur);
}

function onItemToggle(moduleKey: string, it: PermItem, e: Event): void {
  if (readonlyTree.value) return;
  const on = (e.target as HTMLInputElement).checked;
  const next = { ...treeDraft.value };
  next[permKey(moduleKey, it.itemName)] = on ? it.actions.map((a) => a.actionCode) : [];
  /* ⚠️ 父功能点勾选要【联动全部二级功能点】（原型 treeItem 对 it.sub 的处理） */
  const mod = modules.value.find((x) => x.moduleKey === moduleKey);
  (mod?.items || [])
    .filter((x) => x.parentItemName === it.itemName)
    .forEach((c) => {
      next[permKey(moduleKey, c.itemName)] = on ? c.actions.map((a) => a.actionCode) : [];
    });
  treeDraft.value = next;
}

function onModToggle(m: PermModule, e: Event): void {
  if (readonlyTree.value) return;
  const on = (e.target as HTMLInputElement).checked;
  const next = { ...treeDraft.value };
  m.items.forEach((it) => {
    next[permKey(m.moduleKey, it.itemName)] = on ? it.actions.map((a) => a.actionCode) : [];
  });
  treeDraft.value = next;
}

/**
 * 全选全部权限（原型 treeSelectAll）。
 * ★ 2026-10-20：原签名 `treeSelectAll(on: boolean)`，`false` 分支是"取消全部勾选"，
 *   对应按钮已按用户要求删除（与「一键清空」重复、又与关弹窗的「取消」撞名）。
 *   这里收敛成无参 —— 不留一个永远走不到的分支。
 *   要清空请用 treeClear()（带二次确认）。
 */
function treeSelectAll(): void {
  if (readonlyTree.value) return;
  const next: RolePermMap = {};
  modules.value.forEach((m) => {
    m.items.forEach((it) => {
      next[permKey(m.moduleKey, it.itemName)] = it.actions.map((a) => a.actionCode);
    });
  });
  treeDraft.value = next;
  toast('已全选全部权限', 'warn');
}

function treeClear(): void {
  if (readonlyTree.value) return;
  openConfirm(
    {
      title: '清空权限',
      icon: '🗑',
      iconBg: 'var(--dg-l)',
      msg: '确认清空该职位的全部权限？',
      desc: `当前共勾选 <b>${treeActionCount.value}</b> 项动作，清空后该职位将没有任何功能可用。`,
      warn: '清空后职位下的账号登录将看不到任何菜单，请谨慎操作。',
      okText: '确认清空',
      okClass: 'dg',
    },
    () => {
      treeDraft.value = {};
      toast('已清空，请点击保存生效', 'warn');
    },
  );
}

/** 表单模式：应用到表单（原型 applyFormPerm） */
function applyFormPerm(): void {
  draftPerms.value = cleanPerms(treeDraft.value);
  treeOpen.value = false;
  toast(`已应用 ${countActions(draftPerms.value)} 项权限到表单`);
}

/* ★ 2026-10-20 删除 saveRolePerms() / doSaveRolePerms()：
   这两个只服务权限树的「编辑模式」，而编辑模式的唯一入口是
   「职位详情 → 编辑权限」按钮（已按用户要求删除）。
   按钮没了 → 编辑模式不可达 → 保存链路成死代码，一并清掉。
   连带的 assignApi 已从 import 移除（本页再无调用）。
   权限编辑走「职位权限分配」页（assignApi.save 在那里仍是主路径）。 */

/* ============================================================
 * 七、停用 / 启用（原型 toggleRole）
 * ============================================================ */

function toggleRole(row: PermRoleListItem): void {
  const toOn = row.roleStatus !== '启用';
  const n = row.userCount || 0;
  openConfirm(
    {
      title: toOn ? '启用职位' : '停用职位',
      icon: toOn ? '✅' : '⏸',
      iconBg: toOn ? 'var(--ok-l)' : 'var(--warn-l)',
      msg: `确认${toOn ? '启用' : '停用'}职位「${row.roleName}」？`,
      detail: [
        { k: '关联账号', v: `<b>${n}</b> 个` },
        { k: '当前状态', v: row.roleStatus },
        { k: '变更后', v: toOn ? '启用' : '停用' },
      ],
      warn:
        !toOn && n > 0
          ? `停用后，该职位下的 ${n} 个账号将无法登录系统（账号状态不变，但职位失效）。`
          : '',
      tip: toOn
        ? '启用后该职位权限立即恢复生效。'
        : '若只是临时冻结，建议改用"停用账号"而非停用职位。',
      okText: toOn ? '确认启用' : '确认停用',
      okClass: toOn ? 'pri' : 'wn',
    },
    () => {
      void doToggleRole(row, toOn);
    },
  );
}

async function doToggleRole(row: PermRoleListItem, toOn: boolean): Promise<void> {
  // ⚠️ 这里不能写成 `RoleStatus`：RoleStatus 是【字符串枚举】（名义类型），
  //    三元表达式推出来的是字面量联合类型 "启用" | "停用"，赋值给枚举会报 TS2322。
  //    roleApi.setStatus 的入参本来就是 string，直接按 string 传即可。
  const target: string = toOn ? '启用' : '停用';
  try {
    await roleApi.setStatus(row.id, target);
    toast(`职位「${row.roleName}」已${toOn ? '启用' : '停用'}`, toOn ? 'ok' : 'warn');
    await Promise.all([load(), loadOverview()]);
  } catch {
    /* 已提示 */
  }
}

/* ============================================================
 * 八、删除（原型 delRole）
 * ============================================================ */

function delRole(row: PermRoleListItem): void {
  const n = row.userCount || 0;

  if (row.isSys) {
    openConfirm(
      {
        title: '无法删除',
        icon: '🚫',
        iconBg: 'var(--dg-l)',
        msg: '系统预置职位不可删除',
        desc: `「${esc(row.roleName)}」是系统预置的 <b>${overview.value?.presetTotal ?? 0}</b> 个基础职位之一，只能停用，或到「职位权限分配」页调整它的权限。`,
        tip: '如确认不再需要，可改为"停用"，效果等同但可随时恢复。',
        okText: '改为停用该职位',
        okClass: 'wn',
      },
      () => {
        toggleRole(row);
      },
    );
    return;
  }

  if (n > 0) {
    openConfirm(
      {
        title: '有关联账号，不可删除',
        icon: '🚫',
        iconBg: 'var(--dg-l)',
        msg: `该职位下有 ${n} 个账号，不可删除`,
        desc: '存在账号关联时删除会造成这些账号失去权限依据。请先将其移至其他职位。',
        detail: [
          { k: '职位', v: esc(row.roleName) },
          { k: '关联账号', v: `<b>${n}</b> 个` },
        ],
        okText: '查看关联账号',
        okClass: 'wn',
      },
      () => {
        void openRoleUsers(row);
      },
    );
    return;
  }

  openConfirm(
    {
      title: '删除职位',
      icon: '🗑',
      iconBg: 'var(--dg-l)',
      msg: `确认删除职位「${row.roleName}」？`,
      detail: [
        { k: '所属部门', v: esc(row.deptName || '—') },
        { k: '已配权限', v: `${row.permCount} 项` },
        { k: '关联账号', v: '0 个' },
      ],
      warn: '删除后该职位的权限配置将永久丢失，无法恢复。',
      okText: '确认删除',
      okClass: 'dg',
    },
    () => {
      void doRemove(row);
    },
  );
}

async function doRemove(row: PermRoleListItem): Promise<void> {
  try {
    await roleApi.remove(row.id);
    toast(`职位「${row.roleName}」已删除`, 'err');
    await Promise.all([load(), loadOverview()]);
  } catch {
    /* 已提示 */
  }
}

/* ============================================================
 * 九、职位下人员（原型 openRoleUsers / removeRoleFromUser）
 * ============================================================ */

const usersOpen = ref(false);
const roleUsers = ref<PermUserListItem[]>([]);
const usersRole = ref<PermRoleListItem | null>(null);

const usersTitle = computed(
  () => `职位下人员 · <span class="em">${esc(usersRole.value?.roleName || '')}</span>`,
);

async function openRoleUsers(row: PermRoleListItem): Promise<void> {
  usersRole.value = row;
  roleUsers.value = [];
  usersOpen.value = true;
  try {
    const res = await userApi.list({ roleId: row.id, page: 1, size: 100 });
    roleUsers.value = res.list || [];
  } catch {
    /* 已提示 */
  }
}

function removeRoleFromUser(u: PermUserListItem): void {
  const row = usersRole.value;
  if (!row) return;
  const ids = u.roleIds || [];
  const outIdx = ids.indexOf(row.id);
  const remain = (u.roleNames || []).filter((_, i) => i !== outIdx);
  const remainIds = ids.filter((id) => id !== row.id);

  /* ⚠️ 这是该账号【唯一】的职位 —— 移不掉。
   *
   * 【用户反馈】「移除职位后这个职位还在页面里」
   * 根因：后端硬性要求「账号至少保留一个职位」（BizCode.USER_NO_ROLE），
   * 而这里原来照样弹出「确认移出」——弹窗还写着「移出后账号将无法登录系统！」，
   * 用户点了确认 → doRemoveRoleFromUser 静默 return（只飘一条 3 秒的 toast）
   * → 账号仍旧留在列表里，看起来就像「移出没生效」。
   *
   * 改法：唯一职位时【不给可执行按钮】，直接解释清楚 + 指个去处，
   * 与 delRole() 里「系统预置职位不可删除 → 改为停用」是同一套写法。 */
  if (!remainIds.length) {
    openConfirm(
      {
        title: '无法移出（这是唯一职位）',
        icon: '🚫',
        iconBg: 'var(--dg-l)',
        msg: `「${esc(u.userName)}」只有「${esc(row.roleName)}」这一个职位，无法直接移出`,
        desc: '系统强制<b>每个账号至少保留一个职位</b>——否则该账号会失去全部权限依据、无法登录。',
        detail: [
          { k: '账号', v: `${esc(u.userName)} (${esc(u.account)})` },
          { k: '当前职位', v: esc((u.roleNames || []).join('、') || '—') },
          { k: '正确的做法', v: '先去「账号管理」给该账号分配另一个职位，再回来移出本职位' },
        ],
        tip: '如果这个账号本身已不再需要，请到「账号管理」里直接停用或删除它。',
        okText: '去账号管理分配职位',
        okClass: 'wn',
      },
      () => {
        usersOpen.value = false;
        void router.push(PERM_ROUTE.user);
      },
    );
    return;
  }

  openConfirm(
    {
      title: '移出职位',
      icon: '⚠',
      iconBg: 'var(--warn-l)',
      msg: `确认将「${u.userName}」移出职位「${row.roleName}」？`,
      detail: [
        { k: '账号', v: `${esc(u.userName)} (${esc(u.account)})` },
        { k: '当前职位', v: esc((u.roleNames || []).join('、') || '—') },
        { k: '移出后剩余', v: esc(remain.join('、')) },
      ],
      okText: '确认移出',
      okClass: 'dg',
    },
    () => {
      void doRemoveRoleFromUser(u, row);
    },
  );
}

async function doRemoveRoleFromUser(u: PermUserListItem, row: PermRoleListItem): Promise<void> {
  const remainIds = (u.roleIds || []).filter((id) => id !== row.id);
  /* 兜底：上层已拦住「唯一职位」，这里再守一次，防绕过 */
  if (!remainIds.length) {
    toast('账号至少需要保留一个职位，请先在「账号管理」中为其分配其他职位', 'warn');
    return;
  }
  try {
    // ⚠️ 后端「编辑账号」是全量覆盖，这里先取详情再回写，避免把其它字段冲成空
    const d = await userApi.detail(u.id);
    await userApi.update({
      id: d.id,
      userName: d.userName,
      account: d.account,
      phone: d.phone,
      gender: d.gender,
      age: d.age,
      deptId: d.deptId,
      userStatus: d.userStatus,
      roleIds: remainIds,
      needChangePwd: d.needChangePwd,
    });
    toast(`已将 ${u.userName} 移出 ${row.roleName}`, 'warn');
    await openRoleUsers(row);
    await Promise.all([load(), loadOverview()]);
  } catch {
    /* 已提示 */
  }
}

/* ============================================================
 * 九之二、账号详情（就地弹窗）
 *
 * 【用户反馈】「点击账号详情后有问题，应该弹出相应的页面」
 * 原先「账号详情」只是 router.push('/user') 跳回账号管理列表页，不弹详情。
 * 现在就地弹与「账号管理」完全一致的详情（同一份 UserDetailDialog）。
 * ============================================================ */

const userDetailOpen = ref(false);
const userDetailId = ref('');
const userDetailRow = ref<PermUserListItem | null>(null);

function openUserDetail(u: PermUserListItem): void {
  userDetailRow.value = u;
  userDetailId.value = u.id;
  userDetailOpen.value = true;
}

/**
 * ★ 2026-10-19 按用户要求：详情弹窗里的「去编辑」按钮已删除（共享组件里也彻底去掉了），
 *   随之 `openUserEditById()` 成了死代码，一并删除（`permUserEditRoute` 导入也清掉）。
 * ⚠️ 副作用要说清楚：本页「职位下人员」的行操作只有「移出该职位」「账号详情」，
 *   去掉这个按钮后，在职位管理这一页已经**没有任何编辑账号的入口** ——
 *   要改账号请走左侧「账号管理」→ 该行「编辑」。
 */

/* ============================================================
 * 十、新建 / 编辑职位（原型 openRoleForm + submitRoleForm）
 * ============================================================ */

interface RoleForm {
  id: string;
  roleName: string;
  deptId: string;
  /**
   * ★ 2026-10-20：界面上已没有「职位类型」这个字段，但模型里**必须留着**——
   *   编辑职位时从详情带回原值、保存时原样提交，否则后端会把类型重置成默认的「业务职位」
   *   （存量里「管理职位 / 职能职位」的 5 个职位会被悄悄改掉）。新建时填默认值即可。
   */
  roleType: string;
  roleStatus: string;
  /** 弹窗里不展示（原型无此字段），但保存时要带上，避免把排序号覆盖掉 */
  sortNo: number;
  remark: string;
  isSys: boolean;
}

const formOpen = ref(false);
const formTitle = ref('新建职位');
const submitting = ref(false);
const form = reactive<RoleForm>({
  id: '',
  roleName: '',
  deptId: '',
  roleType: '业务职位',
  roleStatus: '启用',
  sortNo: 99,
  remark: '',
  isSys: false,
});

/**
 * ★ 2026-10-08：可选的「等价内置职位」下拉项 —— 已随 2026-10-16 界面清理一并移除，
 *   该列（列表/表单/确认弹窗）不再展示；后端 equiv_role_code 逻辑保持不变。
 */

/** 职位表单里的权限草稿（原型 FORM_PERM） */
const draftPerms = ref<RolePermMap>({});
const draftActionCount = computed(() => countActions(draftPerms.value));
const draftModuleCount = computed(() => countModules(draftPerms.value));

/** 表单里「权限预览」某模块是否已授权（原型 permPreviewHtml） */
function draftModuleOn(m: PermModule): boolean {
  return m.items.some((it) => (draftPerms.value[permKey(m.moduleKey, it.itemName)] || []).length > 0);
}

/* 校验未通过小弹窗（原型 submitRoleForm 第 1816~1822 行） */
const invalidOpen = ref(false);
const invalidList = ref<string[]>([]);

function openAdd(): void {
  Object.assign(form, {
    id: '',
    roleName: '',
    deptId: defaultDeptId.value,
    roleType: '业务职位',
    roleStatus: '启用',
    sortNo: 99,
    remark: '',
    isSys: false,
  });
  draftPerms.value = {};
  formTitle.value = '新建职位';
  formOpen.value = true;
}

async function openEdit(row: PermRoleListItem): Promise<void> {
  try {
    const d = await roleApi.detail(row.id);
    Object.assign(form, {
      id: d.id,
      roleName: d.roleName,
      deptId: d.deptId || defaultDeptId.value,
      roleType: d.roleType,
      roleStatus: d.roleStatus,
      sortNo: d.sortNo ?? 99,
      remark: d.remark || '',
      isSys: d.isSys,
    });
    draftPerms.value = clonePerms(d.perms || {});
    formTitle.value = `编辑职位 · <span class="em">${esc(d.roleName)}</span>`;
    formOpen.value = true;
  } catch {
    /* 已提示 */
  }
}

/* ---- 权限模板（原型 ROLE_TPL / applyRoleTpl，第 1784~1807 行） ---- */

interface TplCfg {
  /** 模块 key → 'all' 或 功能点名数组 */
  [moduleKey: string]: 'all' | string[];
}

const ROLE_TPL: Record<string, TplCfg | 'all' | null> = {
  consult: {
    market: 'all',
    acad: ['学生档案'],
    fin: ['试学学费名单', '正式学费名单'],
    approve: ['待办事项'],
  },
  teacher: {
    teach: 'all',
    /* ⚠️ 2026-10-02：实训补到 10 个功能点后，「教员」模板不再整模块全给 ——
       「实训-考试管理」按《三方操作清单》1.3 只给校长 + 系统管理员 */
    train: [
      '实训-班级信息', '实训-出勤管理', '实训-成绩管理', '实训-成绩汇总',
      '实训-休学退学复学审批', '实训-宿舍管理', '实训-催费管理', '实训-退费申请',
      '实训-班级交接',
    ],
    acad: ['学生档案'],
    job: ['查看'],
  },
  acad: { acad: 'all', train: 'all', approve: 'all' },
  fin: { fin: 'all', acad: 'all', approve: ['待办事项', '财务出款', '教务核算', '校长审批'] },
  all: 'all',
  none: null,
};

const TPL_NAME: Record<string, string> = {
  consult: '咨询老师',
  teacher: '教员',
  acad: '教务',
  fin: '财务',
  all: '全部权限',
};

function applyRoleTpl(tpl: string): void {
  const cfg = ROLE_TPL[tpl];
  const next: RolePermMap = {};

  modules.value.forEach((m) => {
    m.items.forEach((it) => {
      next[permKey(m.moduleKey, it.itemName)] = [];
    });
  });

  if (cfg === 'all') {
    modules.value.forEach((m) => {
      m.items.forEach((it) => {
        next[permKey(m.moduleKey, it.itemName)] = it.actions.map((a) => a.actionCode);
      });
    });
  } else if (cfg) {
    Object.keys(cfg).forEach((mk) => {
      const m = modules.value.find((x) => x.moduleKey === mk);
      if (!m) return;
      const rule = cfg[mk];
      m.items.forEach((it) => {
        if (rule === 'all') next[permKey(mk, it.itemName)] = it.actions.map((a) => a.actionCode);
        else if (rule.includes(it.itemName)) {
          next[permKey(mk, it.itemName)] = it.actions.map((a) => a.actionCode);
        }
      });
    });
  }

  draftPerms.value = cleanPerms(next);
  toast(
    tpl === 'none' ? '已清空权限草稿' : `已套用「${TPL_NAME[tpl] || tpl}」模板`,
    tpl === 'none' ? 'warn' : 'ok',
  );
}

/** 提交（原型 submitRoleForm：校验 → 确认 → 落库） */
function submitForm(): void {
  const name = form.roleName.trim();
  const err: string[] = [];

  if (!name) err.push('职位名称必填');
  if (!form.deptId) err.push('所属部门必填');

  if (err.length) {
    invalidList.value = err;
    invalidOpen.value = true;
    return;
  }

  const isEdit = !!form.id;
  openConfirm(
    {
      title: isEdit ? '保存职位修改' : '创建职位确认',
      icon: isEdit ? '💾' : '✨',
      msg: isEdit ? `确认保存对「${name}」的修改？` : `确认创建职位「${name}」？`,
      detail: [
        { k: '职位名称', v: `<b>${esc(name)}</b>` },
        { k: '所属部门', v: esc(deptNameOf(form.deptId)) },
        { k: '已配权限', v: `<b>${draftActionCount.value}</b> 项动作` },
      ],
      tip: isEdit
        ? `修改后立即对 ${detail.value?.userCount ?? 0} 个账号生效。`
        : '创建后可在「账号管理」中为该职位分配账号。',
      okText: isEdit ? '确认保存' : '确认创建',
    },
    () => {
      void saveForm(isEdit, name);
    },
  );
}

async function saveForm(isEdit: boolean, name: string): Promise<void> {
  submitting.value = true;
  try {
    const payload = {
      roleName: name,
      deptId: form.deptId,
      roleType: form.roleType as RoleType,
      roleStatus: form.roleStatus as RoleStatus,
      sortNo: form.sortNo,
      remark: form.remark.trim(),
      perms: cleanPerms(draftPerms.value),
    };
    if (isEdit) {
      await roleApi.update({ ...payload, id: form.id });
      toast(`已保存职位「${name}」`);
    } else {
      await roleApi.add(payload);
      toast(`已创建职位「${name}」，共 ${draftActionCount.value} 项权限`);
    }
    formOpen.value = false;
    await Promise.all([load(), loadOverview()]);
  } catch {
    /* 已提示 */
  } finally {
    submitting.value = false;
  }
}

/* ============================================================
 * 十一、批量导入（原型 dlgImportRole / dlgImportPreview / doImport）
 * ============================================================ */

interface ImportRow {
  roleName: string;
  deptName: string;
  remark: string;
  ok: boolean;
  reason: string;
}

/* ★ 2026-10-20：模板去掉「类型」列（职位类型已不在界面出现）。
 *   导入时后端 roleType 不传 → 按默认「业务职位」落库（与新建职位同一套兜底）。 */
const IMPORT_HEADER = '职位名称,所属部门,职位说明';
const IMPORT_TEMPLATE = [
  IMPORT_HEADER,
  '实训助教,实训管理,导入创建',
  '财务主管,财务管理部,导入创建',
].join('\n');

const importOpen = ref(false);
const previewOpen = ref(false);
const importing = ref(false);
const importText = ref('');
const pickedName = ref('');
const importRows = ref<ImportRow[]>([]);
const fileRef = ref<HTMLInputElement>();

const importTotal = computed(() => importRows.value.length);
const importValid = computed(() => importRows.value.filter((r) => r.ok));
const importFail = computed(() => importRows.value.filter((r) => !r.ok));

const previewTitle = computed(
  () =>
    `导入数据校验结果 <span class="tag n" style="font-weight:400">共 ${importTotal.value} 条 · 可导入 ${importValid.value.length} 条</span>`,
);

function pickFile(): void {
  fileRef.value?.click();
}

function readFile(f: File): void {
  const reader = new FileReader();
  reader.onload = () => {
    importText.value = String(reader.result || '');
    pickedName.value = f.name;
    toast(`已读取文件：${f.name}`);
  };
  reader.readAsText(f, 'utf-8');
}

function onFileChange(e: Event): void {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  if (f) readFile(f);
  input.value = ''; // 允许重复选择同一个文件
}

function onDrop(e: DragEvent): void {
  const f = e.dataTransfer?.files?.[0];
  if (f) readFile(f);
}

function downloadText(fileName: string, text: string): void {
  const blob = new Blob([`\ufeff${text}`], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(a.href);
}

function downloadTpl(): void {
  downloadText('职位导入模板.csv', IMPORT_TEMPLATE);
  toast('已下载《职位导入模板.csv》');
}

/** 原型 dlgImportPreview：先校验再导入 */
function toImportPreview(): void {
  const lines = importText.value
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) {
    toast('请先选择文件', 'warn');
    return;
  }
  if (lines[0].includes('职位名称') || lines[0].toLowerCase().includes('rolename')) lines.shift();

  const seen = new Set<string>();
  const rows: ImportRow[] = lines.map((line) => {
    const [roleName, deptName, remark] = line
      .split(',')
      .map((s) => (s || '').trim());
    const r: ImportRow = {
      roleName: roleName || '',
      deptName: deptName || '',
      remark: remark || '',
      ok: true,
      reason: '',
    };
    if (!r.roleName) {
      r.ok = false;
      r.reason = '职位名称必填';
    } else if (seen.has(r.roleName)) {
      r.ok = false;
      r.reason = '文件内职位名称重复';
    }
    seen.add(r.roleName);
    return r;
  });

  if (!rows.length) {
    toast('文件里没有可导入的数据行', 'warn');
    return;
  }
  importRows.value = rows;
  importOpen.value = false;
  previewOpen.value = true;
}

function downloadFailList(): void {
  const text = [
    `${IMPORT_HEADER},失败原因`,
    ...importFail.value.map(
      (r) => `${r.roleName},${r.deptName},${r.remark},${r.reason}`,
    ),
  ].join('\n');
  downloadText('职位导入失败清单.csv', text);
  toast('已下载校验失败清单，请修正后重试', 'warn');
}

async function doImport(): Promise<void> {
  const rows = importValid.value;
  if (!rows.length) {
    toast('没有校验通过的数据', 'warn');
    return;
  }
  importing.value = true;
  try {
    const res = await roleApi.importList(
      rows.map((r) => ({
        roleName: r.roleName,
        deptName: r.deptName,
        remark: r.remark,
      })),
    );
    previewOpen.value = false;
    if (res.fail > 0) {
      toast(
        `导入完成：成功 ${res.success} 条，失败 ${res.fail} 条 · ${res.errors?.[0]?.reason || ''}`,
        'warn',
      );
    } else {
      toast(`已成功导入 ${res.success} 个职位`);
    }
    await Promise.all([load(), loadOverview()]);
  } catch {
    /* 已提示 */
  } finally {
    importing.value = false;
  }
}

/* ============================================================
 * 十二、导出（原型 exportDlg，第 1896~1914 行）
 * ============================================================ */

const exportOpen = ref(false);
const exportFormat = ref<'excel' | 'csv'>('excel');
const exportScope = ref<'filtered' | 'all' | 'page'>('filtered');

function openExport(): void {
  exportFormat.value = 'excel';
  exportScope.value = 'filtered';
  exportOpen.value = true;
}

async function doExport(): Promise<void> {
  const scope =
    exportScope.value === 'all'
      ? '全部数据'
      : exportScope.value === 'page'
        ? '当前页'
        : '全部筛选结果';
  try {
    const res = await exportApi.do({
      resource: 'role',
      scope,
      format: exportFormat.value,
      query: { ...query },
    });
    exportOpen.value = false;
    toast(`导出任务已创建，共 ${res.total} 条数据，完成后自动下载`);
  } catch {
    /* 已提示 */
  }
}
</script>

<template>
  <div>
    <!-- ==================== 职位列表（原型 renderRoleList 第 1496~1550 行） ==================== -->
    <div class="card">
      <div class="card-h">
        <div class="t"><span class="bar"></span>职位列表 <span class="sub">共 {{ total }} 个</span></div>
        <div class="r">
          <input
            v-model="query.keyword"
            class="inp"
            placeholder="搜索职位名称"
            style="width: 200px"
            @input="onKeywordInput"
            @keyup.enter="reloadFromFirstPage"
          />
          <select v-model="query.roleStatus" class="inp" @change="reloadFromFirstPage">
            <option value="">全部状态</option>
            <option v-for="s in roleStatuses" :key="s.value" :value="s.value">{{ s.label }}</option>
          </select>
          <select v-model="query.deptId" class="inp" @change="reloadFromFirstPage">
            <option value="">全部部门</option>
            <option v-for="d in flatDepts" :key="d.id" :value="d.id">{{ d.deptName }}</option>
          </select>
          <button class="btn" type="button" @click="resetFilter">重置</button>
          <button class="btn" type="button" @click="importOpen = true">批量导入</button>
          <button class="btn" type="button" @click="openExport">导出</button>
          <button class="btn pri" type="button" @click="openAdd">＋ 新建职位</button>
        </div>
      </div>

      <div class="card-b p0">
        <div class="tb-wrap">
          <table class="tb tb-role">
            <thead>
              <tr>
                <!-- ★ 2026-10-20 列宽改百分比（合计 100）+ .tb-role 固定布局。
                     原来写死 220/170/74/80/72/112/230px，但 table-layout 是 auto：
                     声明的 px 只是建议值，浏览器按内容把多余宽度全砸给前两列
                     （实测 1520 视口、表宽 1264 时「职位名称」220→290、「所属部门」170→224，
                     两列富余 282px 占全表富余 423px 的 67%），看着就是大片空洞。
                     新比例＝各列「内容宽 + 同样的呼吸空间」反算（每列富余 69~75px 均摊），
                     不再让某一列独自吃掉富余（操作列实测只需 193px，给 23% 即够）。 -->
                <th style="width: 17%">职位名称</th>
                <th style="width: 13%">所属部门</th>
                <th style="width: 10%">关联人数</th>
                <th style="width: 10%">权限数</th>
                <th style="width: 11%">状态</th>
                <th style="width: 16%">创建时间</th>
                <th style="width: 23%">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in list" :key="r.id">
                <td>
                  <span class="lk" style="font-weight: 600" @click="openDetail(r)">
                    {{ roleIcon(r) }} {{ r.roleName }}
                  </span>
                  <span v-if="r.isSys" class="tag n" style="margin-left: 4px">预置</span>
                </td>
                <td>{{ r.deptName || '—' }}</td>
                <td class="num">{{ r.userCount }} 人</td>
                <td class="num">
                  <span class="lk" @click="openPermTree(r)">{{ r.permCount }} 项</span>
                </td>
                <td>
                  <span v-if="r.roleStatus === '启用'" class="tag g">启用</span>
                  <span v-else class="tag gy">停用</span>
                </td>
                <td class="desc num">{{ r.createTime }}</td>
                <td>
                  <div class="acts">
                    <span class="lk" @click="openDetail(r)">查看</span>
                    <span class="lk" @click="openRoleUsers(r)">查看职位下人员</span>
                    <span
                      class="lk"
                      :class="r.roleStatus === '启用' ? 'wn' : 'gr'"
                      @click="toggleRole(r)"
                    >{{ r.roleStatus === '启用' ? '停用' : '启用' }}</span>
                    <span
                      class="lk"
                      :class="r.isSys ? 'dis' : 'dg'"
                      @click="r.isSys ? toast('系统预置职位不可删除', 'err') : delRole(r)"
                    >删除</span>
                  </div>
                </td>
              </tr>
              <tr v-if="!list.length">
                <td colspan="7">
                  <div class="empty">
                    <div class="ic">🔍</div>
                    {{ loading ? '加载中…' : '没有符合条件的职位，试试调整筛选条件' }}
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- 分页（原型为客户端全量渲染、无分页器；开发版接口分页，这里保持原型的按钮风格） -->
      <div
        class="card-b"
        style="display: flex; align-items: center; gap: 8px; justify-content: flex-end; padding: 10px 16px; border-top: 1px solid var(--line2)"
      >
        <span class="desc">共 {{ total }} 条 · 第 {{ query.page }} / {{ pageCount }} 页</span>
        <button class="btn xs" type="button" :disabled="query.page <= 1" @click="goPage(1)">首页</button>
        <button class="btn xs" type="button" :disabled="query.page <= 1" @click="goPage(query.page - 1)">上一页</button>
        <button class="btn xs" type="button" :disabled="query.page >= pageCount" @click="goPage(query.page + 1)">下一页</button>
        <button class="btn xs" type="button" :disabled="query.page >= pageCount" @click="goPage(pageCount)">末页</button>
      </div>
    </div>

    <!-- ==================== 职位详情（原型 openRoleDetail 第 1554~1598 行） ==================== -->
    <ProtoDialog v-model="detailOpen" :title="detailTitle" size="lg">
      <div class="fm" style="grid-template-columns: repeat(3, 1fr)">
        <div class="f"><label>职位名称</label><div style="font-weight: 600">{{ detail?.roleName || '—' }}</div></div>
        <div class="f"><label>所属部门</label><div>{{ detail?.deptName || '—' }}</div></div>
        <div class="f">
          <label>状态</label>
          <div>
            <span v-if="detail?.roleStatus === '启用'" class="tag g">启用</span>
            <span v-else class="tag gy">停用</span>
          </div>
        </div>
        <div class="f full"><label>职位说明</label><div class="desc">{{ detail?.remark || '—' }}</div></div>
        <div class="f"><label>关联账号</label><div><b>{{ detail?.userCount ?? 0 }}</b> 人</div></div>
        <div class="f"><label>已配权限</label><div><b>{{ detail?.permCount ?? 0 }}</b> 项动作</div></div>
        <div class="f"><label>更新时间</label><div class="desc num">{{ detail?.updateTime || '—' }}</div></div>
      </div>

      <div class="divider"></div>
      <div class="sec-t"><span class="bar"></span>权限覆盖情况</div>
      <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 8px">
        <div
          v-for="m in modules"
          :key="m.moduleKey"
          style="border: 1px solid var(--line); border-radius: 8px; padding: 9px 11px"
        >
          <div style="font-size: 12.5px; font-weight: 600; margin-bottom: 3px">{{ m.moduleIcon }} {{ m.moduleName }}</div>
          <div class="desc">{{ coverText(m) }}</div>
        </div>
      </div>

      <div class="divider"></div>
      <div class="sec-t"><span class="bar"></span>职位下账号 <span class="desc">（{{ detailUsers.length }} 人）</span></div>
      <div v-if="detailUsers.length" class="tb-wrap">
        <table class="tb">
          <thead>
            <tr><th>姓名</th><th>部门</th><th>状态</th><th>最后登录</th></tr>
          </thead>
          <tbody>
            <tr v-for="u in detailUsers" :key="u.id">
              <td><b>{{ u.userName }}</b></td>
              <td>{{ u.deptName }}</td>
              <td>
                <span v-if="u.userStatus === '正常'" class="tag g">正常</span>
                <span v-else class="tag" :class="u.userStatus === '已停用' ? 'gy' : 'd'">{{ u.userStatus }}</span>
              </td>
              <td class="desc num">{{ u.lastLoginTime || '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else class="empty">
        <div class="ic">👤</div>
        {{ detailLoading ? '加载中…' : '该职位下暂无账号' }}
      </div>

      <template #footer>
        <div class="lft">职位 ID：{{ detail?.id || '—' }}</div>
        <!-- ★ 2026-10-20 按用户要求删掉这里的「编辑权限」按钮。
             职责归位：本弹窗是「职位详情」（只读查看），
             改权限请回「职位权限分配」页（那边有 全选 / 一键清空 / 保存权限 的完整编辑 UI），
             不在详情里再开一个编辑入口 —— 与「详情＝只读」的语义一致。 -->
        <button class="btn" type="button" @click="detailOpen = false">关闭</button>
      </template>
    </ProtoDialog>

    <!-- ==================== 职位下人员（原型 openRoleUsers 第 1599~1612 行） ==================== -->
    <ProtoDialog v-model="usersOpen" :title="usersTitle" size="md">
      <div class="notice i mb12">ℹ<div>共 <b>{{ roleUsers.length }}</b> 个账号；可在此直接为账号追加/移除本职位。</div></div>
      <table v-if="roleUsers.length" class="tb">
        <thead>
          <tr><th>姓名</th><th>部门</th><th>状态</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="u in roleUsers" :key="u.id">
            <td><b>{{ u.userName }}</b></td>
            <td>{{ u.deptName }}</td>
            <td>
              <span v-if="u.userStatus === '正常'" class="tag g">正常</span>
              <span v-else class="tag gy">{{ u.userStatus }}</span>
            </td>
            <td>
              <span class="lk dg" @click="removeRoleFromUser(u)">移出该职位</span>
              <span class="sep">|</span>
              <span class="lk" @click="openUserDetail(u)">账号详情</span>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty"><div class="ic">👤</div>该职位下暂无账号</div>
      <template #footer>
        <button class="btn" type="button" @click="usersOpen = false">关闭</button>
      </template>
    </ProtoDialog>

    <!-- ==================== 权限树（原型 openPermTree / openFormPermTree） ==================== -->
    <ProtoDialog v-model="treeOpen" :title="treeTitle" size="lg">
      <div v-if="treeMode === 'form'" class="notice w mb12">
        ⚠<div>此处改动仅作用于当前职位表单草稿，点击「应用到表单」后才会写入。</div>
      </div>
      <div v-else class="notice i mb12">
        ℹ<div>
          <b>两种勾选方式：</b>① 点功能点左侧的<b>方框</b>可一次性勾选该功能点的全部动作；② 也可<b>单独点击下方任意一个动作标签</b>（如「查看」「新建」「编辑」），自由组合勾选其中一项或几项。勾选后点<b>保存</b>即生效。
        </div>
      </div>

      <div class="tree">
        <div v-for="m in modules" :key="m.moduleKey" class="mod">
          <div class="n">
            <span class="cx" @click="toggleModCollapse(m.moduleKey)">{{ collapsed[m.moduleKey] ? '▸' : '▾' }}</span>
            <input
              type="checkbox"
              :checked="modOn(m)"
              :disabled="readonlyTree"
              @change="onModToggle(m, $event)"
            />
            <span class="nm" @click="toggleModCollapse(m.moduleKey)">{{ m.moduleIcon }} {{ m.moduleName }}</span>
            <span class="cnt">{{ modChecked(m) }}/{{ modTotal(m) }}</span>
          </div>
          <div class="ch" :class="{ hide: collapsed[m.moduleKey] }">
            <template v-for="row in modRows(m)" :key="row.item.id">
              <!-- 功能点（有二级项时是父项，勾选态取自身与子项并集） -->
              <div class="n">
                <input
                  type="checkbox"
                  :checked="rowCheckedCount(row) > 0"
                  :disabled="readonlyTree"
                  @change="onItemToggle(m.moduleKey, row.item, $event)"
                />
                <span class="nm" :style="row.children.length ? 'font-weight:600' : ''">{{ row.item.itemName }}</span>
                <span class="cnt">{{ rowCheckedCount(row) }}/{{ rowTotal(row) }}</span>
              </div>
              <div v-if="row.item.actions.length" class="acts-g">
                <span
                  v-for="a in row.item.actions"
                  :key="a.actionCode"
                  class="act"
                  :class="{ on: checkedOf(m.moduleKey, row.item.itemName).includes(a.actionCode), ro: readonlyTree }"
                  @click="toggleAct(m.moduleKey, row.item.itemName, a.actionCode)"
                >
                  <i class="bx"></i>{{ a.actionName }}
                </span>
              </div>
              <!-- 二级功能点 -->
              <template v-for="c in row.children" :key="c.id">
                <div class="n" style="padding-left: 18px">
                  <input
                    type="checkbox"
                    :checked="checkedOf(m.moduleKey, c.itemName).length > 0"
                    :disabled="readonlyTree"
                    @change="onItemToggle(m.moduleKey, c, $event)"
                  />
                  <span class="nm">{{ c.itemName }}</span>
                  <span class="cnt">{{ checkedOf(m.moduleKey, c.itemName).length }}/{{ c.actions.length }}</span>
                </div>
                <div class="acts-g">
                  <span
                    v-for="a in c.actions"
                    :key="a.actionCode"
                    class="act"
                    :class="{ on: checkedOf(m.moduleKey, c.itemName).includes(a.actionCode), ro: readonlyTree }"
                    @click="toggleAct(m.moduleKey, c.itemName, a.actionCode)"
                  >
                    <i class="bx"></i>{{ a.actionName }}
                  </span>
                </div>
                <div v-if="c.remark" class="desc" style="padding-left: 22px; margin-bottom: 5px">
                  ※ {{ c.remark }}
                </div>
              </template>
              <div v-if="row.item.remark" class="desc" style="padding-left: 22px; margin-bottom: 5px">
                ※ {{ row.item.remark }}
              </div>
            </template>
          </div>
        </div>
      </div>

      <template #footer>
        <div class="lft">
          已勾选 <b style="color: var(--brand)">{{ treeActionCount }}</b> 项动作 · 覆盖
          <b style="color: var(--brand)">{{ treeModuleCount }}</b> 个模块
        </div>
        <template v-if="!readonlyTree">
          <button class="btn" type="button" @click="treeSelectAll()">全选</button>
          <!-- ★ 2026-10-20 按用户要求删掉这里原来的「取消」（= treeSelectAll(false) 取消全部勾选）：
               它与右侧关闭弹窗的「取消」在 edit 模式下撞名，一屏两个「取消」分不清；
               功能上又与「一键清空」重复（后者还带二次确认）。清空请走「一键清空」。
               现在：全选 / 一键清空 / 取消（关弹窗）/ 保存权限。
               ⚠️ 权限树在本项目里有【两份独立实现】：本页一套、PermAssign.vue 一套，
                  改一处必须同步另一处（上轮只改了 PermAssign 导致本页漏改）。 -->
          <button class="btn" type="button" @click="treeClear">一键清空</button>
        </template>
        <!-- 编辑模式已删（2026-10-20），文案只剩两种：表单模式「放弃」、只读模式「关闭」 -->
        <button class="btn" type="button" @click="treeOpen = false">
          {{ treeMode === 'form' ? '放弃' : '关闭' }}
        </button>
        <button v-if="treeMode === 'form'" class="btn pri" type="button" @click="applyFormPerm">应用到表单</button>
      </template>
    </ProtoDialog>

    <!-- ==================== 新建 / 编辑职位（原型 openRoleForm 第 1675~1740 行） ==================== -->
    <ProtoDialog v-model="formOpen" :title="formTitle" size="lg">
      <div class="sec-t"><span class="bar"></span>基本信息</div>
      <div class="fm">
        <div class="f">
          <label>职位名称 <span class="req">*</span></label>
          <input v-model="form.roleName" class="inp" placeholder="如：学管主任" />
        </div>
        <div class="f">
          <label>所属部门 <span class="req">*</span></label>
          <select v-model="form.deptId" class="inp">
            <option v-for="d in flatDepts" :key="d.id" :value="d.id">{{ d.deptName }}</option>
          </select>
        </div>
        <div class="f">
          <label>状态</label>
          <select v-model="form.roleStatus" class="inp">
            <option value="启用">启用</option>
            <option value="停用">停用</option>
          </select>
        </div>
        <div class="f full">
          <label>职位说明</label>
          <textarea v-model="form.remark" class="inp" placeholder="简述该职位的职责边界，便于后续维护"></textarea>
        </div>
      </div>

      <div class="divider"></div>
      <div class="sec-t">
        <span class="bar"></span>可操作权限
        <span class="desc" style="font-weight: 400">点击下方"配置权限"逐项勾选，或先套用模板</span>
      </div>
      <div class="flex mb12">
        <button class="btn sm" type="button" @click="applyRoleTpl('consult')">📞 套用·咨询老师模板</button>
        <button class="btn sm" type="button" @click="applyRoleTpl('teacher')">👨‍🏫 套用·教员模板</button>
        <button class="btn sm" type="button" @click="applyRoleTpl('acad')">🗂️ 套用·教务模板</button>
        <button class="btn sm" type="button" @click="applyRoleTpl('fin')">💰 套用·财务模板</button>
        <button class="btn sm" type="button" @click="applyRoleTpl('all')">🔓 全部权限</button>
        <button class="btn sm" type="button" @click="applyRoleTpl('none')">🔒 清空</button>
      </div>
      <div style="border: 1px solid var(--line); border-radius: 9px; padding: 11px 13px; background: #FBF8F5">
        <div class="flex" style="justify-content: space-between; margin-bottom: 8px">
          <div style="font-size: 12.5px">
            当前勾选：<b style="color: var(--brand)">{{ draftActionCount }}</b> 项动作 ·
            {{ draftModuleCount }} 个模块
          </div>
          <button class="btn sm pri" type="button" @click="openFormTree">＋ 配置权限</button>
        </div>
        <div class="flex">
          <span
            v-for="m in modules"
            :key="m.moduleKey"
            class="tag"
            :class="draftModuleOn(m) ? 'g' : 'gy'"
          >{{ m.moduleIcon }} {{ m.moduleName }} {{ draftModuleOn(m) ? '✓' : '—' }}</span>
        </div>
      </div>

      <template #footer>
        <div class="lft">{{ form.id ? '职位 ID：' + form.id : '新建职位将自动生成 ID' }}</div>
        <button class="btn" type="button" @click="formOpen = false">取消</button>
        <button class="btn" type="button" @click="toast('职位草稿已暂存到本地，可稍后继续编辑')">暂存草稿</button>
        <button class="btn pri" type="button" :disabled="submitting" @click="submitForm">
          {{ form.id ? '保存修改' : '创建职位' }}
        </button>
      </template>
    </ProtoDialog>

    <!-- 校验未通过（原型 submitRoleForm 第 1816~1822 行） -->
    <ProtoDialog v-model="invalidOpen" title="校验未通过" size="sm">
      <div class="notice d mb12">✕<div>以下内容需要修正：</div></div>
      <ul style="padding-left: 20px; font-size: 12.5px; line-height: 1.9">
        <li v-for="(e, i) in invalidList" :key="i">{{ e }}</li>
      </ul>
      <template #footer>
        <button class="btn pri" type="button" @click="invalidOpen = false">返回修改</button>
      </template>
    </ProtoDialog>

    <!-- ==================== 批量导入（原型 dlgImportRole 第 1858~1872 行） ==================== -->
    <ProtoDialog v-model="importOpen" title="批量导入职位" size="md">
      <div class="notice i mb12">ℹ<div>支持 Excel(.xlsx) / CSV，列顺序：职位名称、类型、所属部门、职位说明。</div></div>
      <div
        style="border: 2px dashed var(--line); border-radius: 10px; padding: 26px; text-align: center; cursor: pointer"
        @click="pickFile"
        @dragover.prevent
        @drop.prevent="onDrop"
      >
        <div style="font-size: 30px; opacity: 0.4">📥</div>
        <div style="margin-top: 8px; font-size: 13px">{{ pickedName || '点击选择文件，或将文件拖到此处' }}</div>
        <div class="desc" style="margin-top: 4px">单次最多 500 条 · 仅支持 10MB 以内</div>
      </div>
      <input ref="fileRef" type="file" accept=".csv,.txt" style="display: none" @change="onFileChange" />
      <div class="flex mt12">
        <button class="btn sm" type="button" @click="downloadTpl">下载导入模板</button>
        <button class="btn sm" type="button" @click="toImportPreview">开始校验并导入</button>
      </div>
      <template #footer>
        <button class="btn" type="button" @click="importOpen = false">取消</button>
        <button class="btn pri" type="button" @click="toImportPreview">开始校验并导入</button>
      </template>
    </ProtoDialog>

    <!-- ============ 导入数据校验结果（原型 dlgImportPreview 第 1873~1888 行） ============ -->
    <ProtoDialog v-model="previewOpen" :title="previewTitle" size="md">
      <div v-if="importFail.length" class="notice w mb12">
        ⚠<div>有 <b>{{ importFail.length }}</b> 条数据校验失败，可修正后重新导入，或直接跳过。</div>
      </div>
      <table class="tb">
        <thead>
          <tr><th>职位名称</th><th>部门</th><th>校验</th></tr>
        </thead>
        <tbody>
          <tr v-for="(r, i) in importRows" :key="i" :style="r.ok ? '' : 'background:var(--dg-l)'">
            <td>{{ r.roleName || '—' }}</td>
            <td>{{ r.deptName || '—' }}</td>
            <td>
              <span v-if="r.ok" class="tag g">通过</span>
              <span v-else class="tag d">{{ r.reason }}</span>
            </td>
          </tr>
        </tbody>
      </table>
      <template #footer>
        <div class="lft">将新增 {{ importValid.length }} 个职位</div>
        <button class="btn" type="button" @click="previewOpen = false">取消</button>
        <button v-if="importFail.length" class="btn" type="button" @click="downloadFailList">下载失败清单</button>
        <button class="btn pri" type="button" :disabled="importing || !importValid.length" @click="doImport">
          确认导入 {{ importValid.length }} 条
        </button>
      </template>
    </ProtoDialog>

    <!-- ==================== 导出（原型 exportDlg 第 1896~1913 行） ==================== -->
    <ProtoDialog
      v-model="exportOpen"
      title='导出数据 <span class="tag n" style="font-weight:400">职位列表</span>'
      size="sm"
    >
      <div class="notice i mb12">ℹ<div>将导出 <b>{{ total }}</b> 条数据，可在导出中心查看进度。</div></div>
      <div class="sec-t"><span class="bar"></span>导出格式</div>
      <div class="ckgrid" style="grid-template-columns: 1fr 1fr">
        <div class="ck" :class="{ on: exportFormat === 'excel' }" @click="exportFormat = 'excel'">
          <input type="radio" name="expFmt" :checked="exportFormat === 'excel'" />
          <div class="tx"><div class="n">Excel (.xlsx)</div><div class="d">推荐，保留表头与格式</div></div>
        </div>
        <div class="ck" :class="{ on: exportFormat === 'csv' }" @click="exportFormat = 'csv'">
          <input type="radio" name="expFmt" :checked="exportFormat === 'csv'" />
          <div class="tx"><div class="n">CSV (.csv)</div><div class="d">纯文本，便于系统对接</div></div>
        </div>
      </div>
      <div class="sec-t mt16"><span class="bar"></span>导出内容</div>
      <div class="radios" style="height: auto; flex-direction: column; align-items: flex-start; gap: 8px">
        <label><input v-model="exportScope" type="radio" name="expScope" value="filtered" /> 当前筛选结果（{{ total }} 条）</label>
        <label><input v-model="exportScope" type="radio" name="expScope" value="all" /> 全部数据（含未启用）</label>
        <label><input v-model="exportScope" type="radio" name="expScope" value="page" /> 仅选中项</label>
      </div>
      <template #footer>
        <div class="lft">预计文件大小 &lt; 1MB</div>
        <button class="btn" type="button" @click="exportOpen = false">取消</button>
        <button class="btn pri" type="button" @click="doExport">开始导出</button>
      </template>
    </ProtoDialog>

    <!-- ==================== 通用确认框（原型 confirmDlg） ==================== -->
    <ProtoConfirm
      v-model="confirmOpen"
      :title="cfg.title"
      :icon="cfg.icon"
      :icon-bg="cfg.iconBg"
      :msg="cfg.msg"
      :desc="cfg.desc"
      :detail="cfg.detail"
      :warn="cfg.warn"
      :tip="cfg.tip"
      :ok-text="cfg.okText"
      :ok-class="cfg.okClass"
      :cancel-text="cfg.cancelText"
      @ok="onConfirmOk"
    />

    <!-- ==================== 账号详情（就地弹窗，与账号管理同一份组件） ==================== -->
    <!-- ★ 2026-10-19：「去编辑」按钮已从共享组件里彻底删除，故这里不再传开关。
         本页「职位下人员」没有行级编辑，要改该账号请走「账号管理」列表里的「编辑」。 -->
    <UserDetailDialog
      v-model="userDetailOpen"
      :user-id="userDetailId"
      :fallback="userDetailRow"
    />
  </div>
</template>
