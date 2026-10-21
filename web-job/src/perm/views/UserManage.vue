<script setup lang="ts">
/**
 * 账号管理（账号管理）
 *
 * 页面结构严格对齐高保真原型《学管系统-权限体系高保真原型.html》：
 *   · 第 1924~2001 行 renderUsers()          —— KPI 5 卡 + 账号列表（筛选条 + 表格 + 行内操作）
 *   · 第 2002~2077 行 openUserDetail()       —— 账号详情弹窗（基本信息 + 所属职位 + 有效权限明细）
 *   · 第 2078~2187 行 openUserForm()         —— 新建 / 编辑账号弹窗（左：基本信息 + 部门树；右：职位 + 权限预览）
 *   · 第 2188~2273 行 togRoleCk / refreshUserPermPreview / quickRoleSet /
 *                     quickRoleClear / previewUserPerm / pwdLive / genPwd / togglePw
 *   · 第 2274~2338 行 submitUserForm()       —— 表单校验（错误清单弹窗）→ 确认弹窗 → 落库
 *   · 第 2339~2397 行 openAssignRole()/submitAssignRole()  —— 分配职位弹窗
 *   · 第 2398~2460 行 resetPwd()/rpGen()/doResetPwd() —— 重置密码弹窗（密码按规则随机生成）
 *   · 第 2461~2523 行 toggleUser()/unlockUser()/delUser()  —— 停用启用 / 解锁 / 删除
 *   · 第 2524~2570 行 dlgImportUser()        —— 批量导入（原型演示）
 *   · 第 1896~1914 行 exportDlg()            —— 导出数据弹窗
 *
 * 样式不写在这里：原型的 <style> 已整体移植到 src/styles/prototype.css
 * （main.ts 全局引入），这里只产出与原型同名同层级的 DOM。
 *
 * ⚠️ 账号数据归权限管理模块所有：登录模块不建表，
 *    通过 GET /api/perm/user/auth-profile?account=xxx 取鉴权档案。
 * ⚠️ 一个账号可挂多个职位，权限取【并集去重】，数据范围取【最宽的一档】。
 *    列表里的「有效权限」就是这个并集去重后的结果（不是各职位权限数相加）。
 *
 * 与原型的三处必要取舍（详见交付说明）：
 *   ① 原型是「一次性全量渲染 + 前端过滤」，开发版是服务端分页，
 *      因此表格下方保留了一条原型风格的分页条（分页语义不能丢）。
 *   ② 原型的职位权限是内存里的 PERM 表，开发版改为按需拉取
 *      roleApi.detail(roleId).perms（带缓存）后再做并集，口径与后端一致。
 *   ③ 原型的「密码明文回显 / 短信通知 / 批量导入」是纯演示逻辑，
 *      开发版保留同样的 UI 与校验，但导入不落库、短信不真实发送。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
/* ★ 2026-10-16：模块注册表（新增/编辑账号时勾选「可访问模块」用） */
import { fetchModules } from '@/portal/api/portal';
import { PERM_ROUTE } from '@/perm/utils/links';
/* ★ 2026-10-19：「可访问模块」不再手勾 —— 由所选职位推导（规则见该文件） */
import { derivePortalModules } from '@/perm/utils/moduleDerive';
import type {
  PermDeptTreeNode,
  PermModule,
  PermRoleListItem,
  PermUserListItem,
  RolePermMap,
  UserOverview,
  UserStatus,
} from 'shared-types/perm';
import { deptApi, exportApi, menuApi, roleApi, userApi } from '@/perm/api/perm';
import { useOptionStore } from '@/perm/stores/option';
import ProtoDialog from '@/perm/components/ProtoDialog.vue';
import UserDetailDialog from '@/perm/components/UserDetailDialog.vue';
import UserEditDialog from '@/perm/components/UserEditDialog.vue';
import ProtoConfirm from '@/perm/components/ProtoConfirm.vue';
import { toast } from '@/perm/utils/toast';
import { roleIconOf } from '@/perm/utils/roleIcon';

/** 职位图标 —— 统一走 @/perm/utils/roleIcon */
const roleIcon = roleIconOf;

const router = useRouter();
const route = useRoute();

/** 可选项字典走 Pinia 缓存（职位管理 / 操作日志 / 规则配置页共用同一份） */
const optionStore = useOptionStore();

/* ============================================================
 * 零、通用小工具
 * ============================================================ */

/** 极简 HTML 转义（弹窗标题与确认框明细用 v-html 渲染，姓名/部门名是用户输入） */
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

/** 权限映射的 key 规则（与后端 perm.service.permKey 完全一致） */
const permKey = (moduleKey: string, itemName: string): string => `${moduleKey}||${itemName}`;


/** 手机号归一化（原型 normPhone 第 1052~1058 行）：全角→半角、去空格、只留数字 */
function normPhone(s: string): string {
  return String(s ?? '')
    .replace(/[\uff10-\uff19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\s\u00a0\u3000]/g, '')
    .replace(/[^\d]/g, '');
}

/** 密码强度打分（原型 pwdBar 第 1061~1068 行） */
function pwdScore(v: string): number {
  let s = 0;
  if (v.length >= 8) s++;
  if (/[A-Z]/.test(v)) s++;
  if (/[0-9]/.test(v)) s++;
  if (/[^A-Za-z0-9]/.test(v)) s++;
  return s;
}
const PWD_COLORS = ['#EFE9E4', '#B22A23', '#C9852E', '#CD3A33', '#4E9A6C'];
const PWD_TEXTS = ['', '弱', '中', '强', '很强'];

/** 取某职位已配权限动作总数（优先用列表里的 permCount，兜底用已缓存的权限映射） */
function permCountOf(roleId: string): number {
  const r = roles.value.find((x) => x.id === roleId);
  if (r) return r.permCount;
  const map = rolePerms[roleId];
  return map ? Object.values(map).reduce((a, b) => a + b.length, 0) : 0;
}

/* ============================================================
 * 一、列表（原型 renderUsers 第 1924~2001 行）
 * ============================================================ */

const loading = ref(false);
const list = ref<PermUserListItem[]>([]);
const total = ref(0);
const overview = ref<UserOverview | null>(null);

/** 全部职位（表单 / 分配职位 / 筛选用） */
const roles = ref<PermRoleListItem[]>([]);
/** 部门树根（校级下的 7 个一级部门） */
const deptRoots = ref<PermDeptTreeNode[]>([]);
/** 拍平后的全部部门节点（筛选下拉用，含「全部门」校级节点，与原型一致） */
const deptFlat = ref<PermDeptTreeNode[]>([]);
/** 部门 id → 说明（部门树里的「· 咨询老师、咨询经理」小字） */
const deptRemark = reactive<Record<string, string>>({});
/** 权限模块树（权限预览 / 权限明细渲染用） */
const modules = ref<PermModule[]>([]);

const query = reactive({
  page: 1,
  size: 10,
  keyword: '',
  deptId: '',
  roleId: '',
  /** 账号状态筛选（枚举以字符串承接，提交给接口时后端按字典校验） */
  userStatus: '',
});

/** 账号状态下拉：优先用字典接口，兜底原型写死的三档 */
const statusOptions = computed<{ value: string; label: string }[]>(() => {
  const opts = optionStore.userStatuses;
  if (opts && opts.length) return opts.map((o) => ({ value: String(o.value), label: o.label }));
  return [
    { value: '正常', label: '正常' },
    { value: '已停用', label: '已停用' },
    { value: '已锁定', label: '已锁定' },
  ];
});

const pageCount = computed(() => Math.max(1, Math.ceil(total.value / query.size)));

async function load(): Promise<void> {
  loading.value = true;
  try {
    const res = await userApi.list({ ...query });
    list.value = res.list || [];
    total.value = res.total;
  } catch {
    /* 错误已在 request 拦截器里弹过提示 */
  } finally {
    loading.value = false;
  }
}

async function loadOverview(): Promise<void> {
  try {
    overview.value = await userApi.overview();
  } catch {
    /* 已提示 */
  }
}

async function loadMeta(): Promise<void> {
  try {
    // 字典从 store 拿（命中缓存就不重复请求）；
    // 职位清单、部门树 / 部门说明、权限模块树是本页专有数据
    const [, roleRes, tree, deptPage, mods] = await Promise.all([
      optionStore.load(),
      roleApi.list({ page: 1, size: 100 }),
      deptApi.tree(),
      deptApi.list({ page: 1, size: 100 }),
      // 权限模块树只服务「权限预览 / 权限明细」，单独兜底，别让它拖垮职位与部门数据
      menuApi.tree().catch(() => [] as PermModule[]),
    ]);
    roles.value = roleRes.list || [];
    modules.value = mods || [];

    // 部门树：拍平一份便于查上下级；根节点是「全部门（校级）」，原型里对应 DEPTS 的 'all'
    const flat: PermDeptTreeNode[] = [];
    const walk = (nodes: PermDeptTreeNode[]): void => {
      nodes.forEach((n) => {
        flat.push(n);
        if (n.children?.length) walk(n.children);
      });
    };
    walk(tree as unknown as PermDeptTreeNode[]);
    deptFlat.value = flat;
    deptRoots.value = flat.filter((n) => n.deptLevel === 2);
    (deptPage.list || []).forEach((d) => {
      deptRemark[d.id] = d.remark || '';
    });
  } catch {
    /* 已提示 */
  }
}

onMounted(async () => {
  await Promise.all([loadMeta(), loadOverview(), load()]);
  /* ★ 从「部门管理」的「编辑」跳过来：/user?edit=<id> 直接把编辑表单打开，
     省掉「再搜一次这个账号」这一步。用 replace 抹掉 query，避免刷新时反复弹。 */
  const editId = String(route.query.edit || '');
  if (editId) {
    void router.replace({ path: PERM_ROUTE.user });
    try {
      const d = await userApi.detail(editId);
      // ⚠️ /user/detail 实际返回「列表项形态」（含 avatarText / deptName 等），
      //    但契约 PermUserDetailResponse 只声明了 PermUser + roleIds/roleNames，
      //    所以这里必须过一道 unknown —— 直接 as 会被 TS 判为「类型不相交」。
      await openEdit({ ...d } as unknown as PermUserListItem);
    } catch {
      /* 已提示：账号可能已被删除 */
    }
  }
});

/** 输入即筛（原型 oninput 过滤）；开发版走服务端，加 320ms 防抖避免每个字打一次接口 */
let keywordTimer = 0;
function onKeywordInput(): void {
  window.clearTimeout(keywordTimer);
  keywordTimer = window.setTimeout(searchNow, 320);
}

function searchNow(): void {
  window.clearTimeout(keywordTimer);
  query.page = 1;
  void load();
}

function resetQuery(): void {
  Object.assign(query, { page: 1, keyword: '', deptId: '', roleId: '', userStatus: '' });
  void load();
  toast('已重置筛选条件', 'warn');
}

/** KPI 第 1 张卡：清空「状态 + 部门」两个筛选（原型 USER_FILTER.st='';dept=''） */
function kpiAll(): void {
  query.userStatus = '';
  query.deptId = '';
  query.page = 1;
  void load();
}

/** KPI 第 2~4 张卡：按状态筛选 */
function kpiStatus(st: string): void {
  query.userStatus = st;
  query.page = 1;
  void load();
}

function goPage(n: number): void {
  if (n < 1 || n > pageCount.value) return;
  query.page = n;
  void load();
}

function onSizeChange(): void {
  query.page = 1;
  void load();
}

/* ============================================================
 * 二、职位权限映射（原型用内存里的 PERM，开发版按需拉取 + 缓存）
 * ============================================================ */

const rolePerms = reactive<Record<string, RolePermMap>>({});

/** 确保这些职位的权限映射已在本地（缺谁拉谁，拉过一次就缓存） */
async function ensureRolePerms(ids: string[]): Promise<void> {
  const missing = ids.filter((id) => !rolePerms[id]);
  if (!missing.length) return;
  await Promise.all(
    missing.map(async (id) => {
      try {
        const d = await roleApi.detail(id);
        rolePerms[id] = d.perms || {};
      } catch {
        rolePerms[id] = {};
      }
    }),
  );
}

/** 多职位权限并集（原型 userPermPreviewHtml 第 2227~2238 行的 merged） */
function mergedMap(ids: string[]): RolePermMap {
  const out: RolePermMap = {};
  ids.forEach((id) => {
    const m = rolePerms[id];
    if (!m) return;
    Object.keys(m).forEach((k) => {
      out[k] = Array.from(new Set([...(out[k] || []), ...(m[k] || [])]));
    });
  });
  return out;
}

function actionCount(map: RolePermMap): number {
  return Object.values(map).reduce((a, b) => a + b.length, 0);
}

interface ModuleTag {
  key: string;
  icon: string;
  name: string;
  c: number;
  total: number;
}

/** 权限预览的模块标签（原型第 2234~2237 行） */
function moduleTags(map: RolePermMap): ModuleTag[] {
  return modules.value.map((m) => ({
    key: m.moduleKey,
    icon: m.moduleIcon,
    name: m.moduleName,
    c: m.items.filter((it) => (map[permKey(m.moduleKey, it.itemName)] || []).length > 0).length,
    total: m.items.length,
  }));
}

interface CardRow {
  name: string;
  /** 已展开成中文动作名（原型的 PERM 直接存中文，开发版存编码，这里统一还原成中文） */
  actions: string[];
}

interface ModuleCard {
  key: string;
  icon: string;
  name: string;
  rows: CardRow[];
  total: number;
}

/** 权限明细卡片（原型第 2059~2070 / 2246~2252 行） */
function moduleCards(map: RolePermMap): ModuleCard[] {
  return modules.value.map((m) => {
    const rows: CardRow[] = [];
    m.items.forEach((it) => {
      const codes = map[permKey(m.moduleKey, it.itemName)] || [];
      if (!codes.length) return;
      rows.push({
        name: it.itemName,
        actions: codes.map((c) => it.actions.find((a) => a.actionCode === c)?.actionName || c),
      });
    });
    return { key: m.moduleKey, icon: m.moduleIcon, name: m.moduleName, rows, total: m.items.length };
  });
}

/* ============================================================
 * 三、通用确认框（原型 confirmDlg 第 996~1020 行）
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
  /** 中间按钮文案（原型 confirmDlg 的 midText，如「解锁并重置密码」） */
  midText: string;
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
  midText: '',
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
 * 四、账号详情 —— 复用 @/perm/components/UserDetailDialog.vue
 *
 * ★ 2026-10-19：详情弹窗底部的「去编辑」按钮已删除（共享组件里也彻底去掉了），
 *   本页改账号统一走列表行操作里的「编辑」。
 *
 * 【2026-10-07 重构】原来这里自己写了一份内联详情弹窗，而「部门管理」「职位管理」
 * 里点「账号详情」只是 router.push('/user') —— 同一件事三种做法、其中两种是坏的
 * （不弹详情，还得自己再搜一次那个账号）。现在三处统一走同一个组件。
 *
 * 组件只需传 userId，详情 / 权限模块树 / 各职位权限映射都由它自取；
 * 弹窗里的「查看权限 / 编辑权限」也不再跳「职位权限分配」，就地叠一层权限树。
 * ============================================================ */

const userDetailOpen = ref(false);
const userDetailId = ref('');
const userDetailRow = ref<PermUserListItem | null>(null);

/** 打开账号详情（列表里点姓名 / 点「查看」都走它） */
function openUserDetail(row: PermUserListItem): void {
  userDetailRow.value = row;
  userDetailId.value = row.id;
  userDetailOpen.value = true;
}

/*
 * ★ 2026-10-19：这里原先有个 `editFromDetail()`（详情底部的「去编辑」→ 打开编辑表单），
 * 随按钮一起删掉了 —— 共享组件里已无该按钮，也不再有 `edit` 事件，留着就是死代码。
 * 账号的编辑入口改由列表行操作里的「编辑」承担（见 openEdit 的调用点）。
 */

/* ============================================================
 * 五、新建 / 编辑账号（原型 openUserForm 第 2078~2187 行）
 * ============================================================ */

const formOpen = ref(false);
const formMode = ref<'add' | 'edit'>('add');
const showPwd = ref(false);

/* ============================================================
 * ★ 2026-10-16：可访问模块（门户登录后能进哪几个模块）
 *
 * 背景：门户登录要求 t_sys_account 里既有账号、又有至少一个模块，
 *      否则「在账号管理里新建的账号」永远登不进系统。
 *
 * ★ 2026-10-19 改口径：新建账号时【不再手勾】——
 *      界面上那一块勾选区已按用户要求删除，模块改由【所选职位自动推导】
 *      （derivePortalModules，规则与依据见 utils/moduleDerive.ts）。
 *      编辑账号不受影响：仍沿用列表带回的原值原样提交。
 * ============================================================ */

/** 模块候选（来自门户模块注册表，只拉一次） */
const moduleOptions = ref<{ key: string; title: string; desc: string }[]>([]);

/** 懒加载模块注册表 */
async function ensureModuleOptions(): Promise<void> {
  if (moduleOptions.value.length) return;
  try {
    moduleOptions.value = await fetchModules();
  } catch {
    /* 提示由请求拦截器统一弹出，这里不阻塞表单 */
  }
}

/** 模块 key → 中文名（确认框里展示用） */
function moduleTitleOf(key: string): string {
  return moduleOptions.value.find((m) => m.key === key)?.title || key;
}

interface UserForm {
  id: string;
  userName: string;
  account: string;
  phone: string;
  /** 0 = 未选 */
  gender: number;
  /** null = 未填 */
  age: number | null;
  deptId: string;
  /** 枚举以字符串承接，提交时再断言成 UserStatus（与职位管理页同一写法） */
  userStatus: string;
  password: string;
  needChangePwd: boolean;
  /**
   * ★ 2026-10-16：可访问模块（门户登录后能进哪几个模块）。
   * ★ 2026-10-19：新建时不再由用户手勾 —— saveUser() 提交的是 derivedModules；
   *   这个字段现在只承载【编辑】时从列表带回的原值（原样提交，不被改动）。
   */
  modules: string[];
}

const form = reactive<UserForm>({
  // ★ 2026-10-16 按用户要求：新建表单【一切留空】——
  //   性别不预选、年龄不给默认值、账号状态不预选、密码不预填、强制改密不预勾，
  //   管理员填了什么才显示什么（对应的「必填」校验也都补齐了）。
  id: '',
  userName: '',
  account: '',
  phone: '',
  /** 0 = 未选（性别必须由管理员选） */
  gender: 0,
  /** null = 未填（年龄必须由管理员填，20-65） */
  age: null,
  deptId: '',
  /** '' = 未选（下拉第一项是「请选择」） */
  userStatus: '',
  password: '',
  needChangePwd: false,
  modules: [],
});

/** 多选职位（原型 uRoles），单独用 ref 存放，替换数组才能触发权限预览重算 */
const formRoleIds = ref<string[]>([]);

/**
 * ★ 2026-10-19 修：勾选职位后要把该职位在权限库里的功能点拉回来。
 *
 * 【为什么必须补这个 watch】
 *   以前只有 `openEdit()` / `openPreview()` 会调 `ensureRolePerms()` ——
 *   **新建表单里勾职位从来没人拉**，于是：
 *     · 「权限预览（随职位勾选实时变化）」在新建时永远是空的（页面自己承诺的功能失效）；
 *     · 本次新增的「按所选职位推导可访问模块」也拿不到输入 →
 *       一路走到「推不出来就全开」的兜底 → 新建账号会白拿全部 7 个模块。
 *   补上这个 watch，两件事一起修好；`ensureRolePerms` 内部按 id 缓存，
 *   重复勾选不会重复请求。
 *
 * ⚠️ 必须写在 `formRoleIds` 声明【之后】—— `<script setup>` 是模块顶层作用域，
 *    写在声明前会 `Cannot access 'formRoleIds' before initialization`（TDZ），
 *    整个页面直接白屏（构建/类型检查都发现不了，只有跑起来才炸）。
 */
watch(formRoleIds, (ids) => {
  void ensureRolePerms(ids);
});

const formTitle = computed(() => {
  // ★ 2026-10-19：编辑账号只改基础信息，副标题不再提「分配职位与部门」
  return formMode.value === 'edit'
    ? `编辑账号 · <span class="em">${esc(form.userName)}</span> <span class="tag n">修改账号基础信息</span>`
    : `新建账号 <span class="tag n">填写账号信息并分配职位与部门</span>`;
});

const pwScore = computed(() => pwdScore(form.password));
const pwColor = computed(() => PWD_COLORS[pwScore.value]);
const pwText = computed(() => PWD_TEXTS[pwScore.value] || '太短');

const formMerged = computed<RolePermMap>(() => mergedMap(formRoleIds.value));
const formTags = computed<ModuleTag[]>(() => moduleTags(formMerged.value));
const formPermCount = computed(() => actionCount(formMerged.value));
const formModuleCount = computed(() => formTags.value.filter((t) => t.c > 0).length);

/**
 * ★ 2026-10-19：新建账号的「可访问模块」= 所选职位自动推导的结果。
 *
 * 输入取「有 ≥1 项权限的权限库模块」（与上面「M 个模块可用」同一口径），
 * 映射表与两条兜底（推导为空 / 跨板块角色 → 全部模块）见 utils/moduleDerive.ts。
 */
const derivedModules = computed<string[]>(() =>
  derivePortalModules(
    formTags.value.filter((t) => t.c > 0).map((t) => t.key),
    moduleOptions.value.map((m) => m.key),
  ),
);

/** 部门勾选态：选中项 + 其上级（回显）+ 其下级（原型 deptCk 的级联） */
const deptOn = computed<Set<string>>(() => {
  const s = new Set<string>();
  const sel = form.deptId;
  if (!sel) return s;
  s.add(sel);
  let cur: string | null = deptFlat.value.find((n) => n.id === sel)?.parentId ?? null;
  while (cur) {
    s.add(cur);
    cur = deptFlat.value.find((n) => n.id === cur)?.parentId ?? null;
  }
  deptFlat.value.filter((n) => n.parentId === sel).forEach((n) => s.add(n.id));
  return s;
});

function openAdd(): void {
  formMode.value = 'add';
  // ★ 2026-10-19：新建不再手勾模块 —— 提交时按「所选职位」推导（见 derivedModules）
  form.modules = [];
  void ensureModuleOptions();
  Object.assign(form, {
    // ★ 2026-10-16：全部留空 —— 管理员填了才会出现内容
    id: '',
    userName: '',
    account: '',
    phone: '',
    gender: 0, // 性别不预选
    age: null, // 年龄不给默认值
    deptId: '',
    userStatus: '', // 账号状态不预选（下拉显示「请选择」）
    password: '', // 密码不预填（可点「随机」按规则生成）
    needChangePwd: false, // 强制改密不预勾
  });
  formRoleIds.value = [];
  showPwd.value = false;
  formOpen.value = true;
}

/**
 * 编辑账号 —— ★ 2026-10-20 起改走共享组件 UserEditDialog（就地弹窗）
 *
 * 【为什么从「内联表单」搬出去】
 *   原先编辑复用下面那个「新建 / 编辑」合体表单（formMode = 'edit'）。
 *   而「部门管理 → 查看账号 → 编辑」当时是 router.push('/user?edit=<id>') 跳过来
 *   （用户原话：「跳转到账号管理进行修改很别扭」）。把编辑抽成一个共享弹窗后：
 *     · 部门管理可以就地编辑，不再跳页；
 *     · 两个页面用的是【同一份】字段与校验，不会各改各的。
 *
 * ⚠️ 下面那个内联表单（formOpen）现在只用于【新建账号】：
 *    `formMode` 恒为 'add'，其中 `formMode === 'edit'` 的分支不会再走到。
 *    新建账号要勾职位 / 选部门 / 推导可访问模块，那套逻辑仍留在本页。
 */
const userEditOpen = ref(false);
const userEditId = ref('');
const userEditRow = ref<PermUserListItem | null>(null);

/** 打开编辑弹窗（列表行「编辑」、以及 /user?edit=<id> 深链接都走它） */
async function openEdit(row: PermUserListItem): Promise<void> {
  userEditRow.value = row;
  userEditId.value = row.id;
  userEditOpen.value = true;
}

/** 共享弹窗保存成功 → 刷新列表与 KPI（部门树在别的页面，这里不用管） */
async function onUserEdited(): Promise<void> {
  await Promise.all([load(), loadOverview()]);
}

/** 部门选择（开发版账号只归属一个部门，所以是单选；勾选上级自动回显下级） */
function pickDept(id: string): void {
  form.deptId = form.deptId === id ? '' : id;
}

const isRoleOn = (id: string): boolean => formRoleIds.value.includes(id);

/** 职位勾选（原型 togRoleCk 第 2189~2207 行）—— 停用职位要先确认 */
function togRole(r: PermRoleListItem): void {
  if (r.roleStatus === '停用') {
    if (isRoleOn(r.id)) {
      formRoleIds.value = formRoleIds.value.filter((x) => x !== r.id);
      return;
    }
    openConfirm(
      {
        title: '职位已停用',
        icon: '⚠',
        iconBg: 'var(--warn-l)',
        msg: `职位「${r.roleName}」当前处于停用状态`,
        desc: '为该账号分配已停用职位，账号登录后不会获得该职位的权限。',
        tip: '建议先启用该职位，或改选其他职位。',
        okText: '仍然分配',
        okClass: 'wn',
      },
      () => {
        formRoleIds.value = [...formRoleIds.value, r.id];
      },
    );
    return;
  }
  formRoleIds.value = isRoleOn(r.id)
    ? formRoleIds.value.filter((x) => x !== r.id)
    : [...formRoleIds.value, r.id];
}

/** 随机强密码（原型 genPwd 第 2260~2267 行） */
/**
 * ★ 2026-10-16：新建/编辑账号的「随机」按钮
 *
 * 与「重置密码」弹窗【共用同一个生成器、同一条规则】：
 * 含大写字母 + 含数字 + 长度不低于 8 位。
 * 不再掺特殊符号 —— 密码规则里没有这一项，而且这个密码要口头/短信告知本人，好念好抄更要紧。
 */
function genPwd(): void {
  form.password = genPwdByRule();
  showPwd.value = true; // 生成后直接明文展示，方便念给本人
  toast(`已按密码规则生成：${form.password}`);
}

function togglePwd(): void {
  showPwd.value = !showPwd.value;
}

function onPhoneInput(e: Event): void {
  const el = e.target as HTMLInputElement;
  el.value = normPhone(el.value).slice(0, 11);
  form.phone = el.value;
}

/** 快捷套用（原型 quickRoleSet / quickRoleClear 第 2214~2226 行）——
 *  原型写死职位 id，开发版按【职位名】匹配（种子数据同名） */
function quickRoleSet(names: string[]): void {
  const ids = roles.value.filter((r) => names.includes(r.roleName)).map((r) => r.id);
  if (!ids.length) {
    toast(`未找到职位「${names.join('、')}」，请手动勾选`, 'warn');
    return;
  }
  formRoleIds.value = ids;
  toast(`已套用职位：${names.join('、')}`);
}

function quickRoleClear(): void {
  formRoleIds.value = [];
  toast('已清空职位选择', 'warn');
}

/* ---- 权限明细预览（原型 previewUserPerm 第 2239~2254 行） ---- */

const previewOpen = ref(false);
const previewRoleIds = ref<string[]>([]);
const previewCards = computed<ModuleCard[]>(() => moduleCards(mergedMap(previewRoleIds.value)));

async function openPreview(): Promise<void> {
  previewRoleIds.value = [...formRoleIds.value];
  previewOpen.value = true;
  await ensureRolePerms(previewRoleIds.value);
}

const previewTitle = computed(
  () => `权限明细预览 <span class="tag n">基于 ${previewRoleIds.value.length} 个职位合并</span>`,
);

/* ---- 表单校验 + 提交（原型 submitUserForm 第 2274~2338 行） ---- */

const invalidOpen = ref(false);
const invalidErrs = ref<string[]>([]);

function validateForm(): string[] {
  const errs: string[] = [];
  const v = form;
  if (!v.userName) errs.push('请输入姓名');
  else if (!/^[\u4e00-\u9fa5]{2,}$/.test(v.userName)) errs.push('姓名只能是汉字，且不少于 2 个字');
  if (v.gender !== 1 && v.gender !== 2) errs.push('请选择性别');
  // ★ 2026-10-19 按用户要求：账号年龄范围收紧为 20-65（与后端 zod 同口径）
  if (!v.age || v.age < 20 || v.age > 65) errs.push('年龄需在 20-65 之间');
  if (!/^1[3-9]\d{9}$/.test(v.phone || '')) errs.push('手机号格式不正确（11 位，1 开头，请勿输入空格/横线）');
  if (!/^[A-Za-z0-9]{4,20}$/.test(v.account || '')) errs.push('登录账号需 4-20 位字母/数字');
  else if (list.value.some((u) => u.account === v.account && u.id !== v.id)) {
    errs.push(`登录账号「${v.account}」已被占用`);
  }

  // ★ 2026-10-16：密码校验只在【新建账号】时做 —— 编辑页不对密码做任何操作
  if (formMode.value === 'add') {
    if (!v.password) errs.push('请输入密码');
    else if (v.password.length < 8) errs.push('密码至少 8 位');
    else if (!(/[A-Z]/.test(v.password) && /[0-9]/.test(v.password))) {
      errs.push('密码需同时包含大写字母与数字');
    }
  }

  if (!v.userStatus) errs.push('请选择账号状态');
  // ★ 2026-10-19：职位 / 可访问模块 / 所属部门 三块只在【新建账号】表单里出现，
  //   编辑模式下它们沿用原值提交、界面上也无法修改，所以校验只对新建账号生效。
  if (formMode.value === 'add') {
    if (!formRoleIds.value.length) errs.push('请至少为该账号分配一个职位');
    // ★ 2026-10-19：模块改为按职位推导 —— 这里只作兜底断言（正常情况下必有值：
    //   推导不出结果时会回退「全部模块」，保证账号一定登得进去）。
    if (!derivedModules.value.length) {
      errs.push('未能按所选职位推导出「可访问模块」，请检查该职位的权限配置');
    }
    if (!v.deptId) errs.push('请至少选择一个所属部门');
  }
  return errs;
}

function submitUserForm(): void {
  const errs = validateForm();
  if (errs.length) {
    invalidErrs.value = errs;
    invalidOpen.value = true;
    return;
  }

  const isEdit = formMode.value === 'edit';
  const roleNames = formRoleIds.value
    .map((id) => roles.value.find((r) => r.id === id)?.roleName || '')
    .filter(Boolean);
  // 同名账号提示（原型 dupWd）：在已加载的列表范围内做一次尽力而为的检查
  const dupName = list.value.some((u) => u.userName === form.userName && u.id !== form.id);

  openConfirm(
    {
      title: isEdit ? '保存账号修改' : '创建账号确认',
      icon: isEdit ? '💾' : '✨',
      msg: isEdit ? `确认保存对「${form.userName}」的修改？` : `确认创建账号「${form.userName}」？`,
      detail: [
        { k: '姓名 / 性别', v: `<b>${esc(form.userName)}</b> · ${form.gender === 2 ? '女' : '男'} · ${form.age} 岁` },
        { k: '登录账号', v: `<code>${esc(form.account)}</code>` },
        { k: '手机号', v: esc(form.phone) },
        { k: '账号状态', v: esc(form.userStatus || '—') },
        // ★ 2026-10-19：编辑账号只改基础信息 → 部门 / 模块 / 职位 / 密码
        //   这四行只在【新建账号】的确认框里出现。
        ...(isEdit
          ? []
          : [
              {
                k: '所属部门',
                v: esc(deptFlat.value.find((d) => d.id === form.deptId)?.deptName || '—'),
              },
              {
                k: '可访问模块',
                v: derivedModules.value.length
                  ? `${derivedModules.value
                      .map((k) => `<span class="tag b">${esc(moduleTitleOf(k))}</span>`)
                      .join(' ')} <span class="desc">· 按所选职位自动开通</span>`
                  : '<span class="desc">未推导出模块 · 请检查职位权限</span>',
              },
              {
                k: '所属职位',
                v: roleNames.length
                  ? roleNames.map((n) => `<span class="tag b">${esc(n)}</span>`).join(' ')
                  : '<span class="desc">无</span>',
              },
              {
                k: '密码策略',
                v: `${esc(form.password)} <span class="desc">${
                  form.needChangePwd ? '· 强制首次登录修改' : '· 不强制修改'
                }</span>`,
              },
            ]),
      ],
      warn: dupName ? '系统内已存在同姓名的账号，请确认不是重复创建。' : '',
      tip: isEdit
        ? '仅修改基础信息；所属职位与部门不受影响（如需调整请用列表里的「分配职位」）。'
        : `账号创建后默认状态为「${form.userStatus}」，可直接登录。`,
      okText: isEdit ? '确认保存' : '确认创建',
    },
    () => {
      void saveUser();
    },
  );
}

async function saveUser(): Promise<void> {
  const isEdit = formMode.value === 'edit';
  const payload = {
    userName: form.userName,
    account: form.account,
    phone: form.phone,
    gender: form.gender,
    age: Number(form.age), // 校验已保证 20-65，这里收口成数字
    deptId: form.deptId,
    // ★ 2026-10-19：新建 = 按职位推导；编辑 = 沿用列表带回的原值（界面不涉及模块）
    modules: isEdit ? [...form.modules] : [...derivedModules.value],
    roleIds: [...formRoleIds.value],
    userStatus: form.userStatus as UserStatus,
    // ★ 2026-10-16：编辑账号不传密码、也不传「强制首次登录修改密码」——
    //   后端这两项都是可选的，不传 = 保持库里原值不动；只有新建时才带上。
    ...(formMode.value === 'add'
      ? { password: form.password, needChangePwd: form.needChangePwd }
      : {}),
  };
  try {
    if (isEdit) {
      await userApi.update({ ...payload, id: form.id });
      toast(`已保存账号「${form.userName}」的修改`);
    } else {
      await userApi.add(payload);
      const roleNames = formRoleIds.value
        .map((id) => roles.value.find((r) => r.id === id)?.roleName || '')
        .filter(Boolean);
      toast(`已创建账号「${form.userName}」，职位：${roleNames.join('、') || '无'}`);
    }
    formOpen.value = false;
    await Promise.all([load(), loadOverview()]);
  } catch {
    /* 已提示 */
  }
}

/* ============================================================
 * 六、分配职位（原型 openAssignRole / submitAssignRole 第 2344~2396 行）
 * ============================================================ */

const assignOpen = ref(false);
const assignTarget = ref<PermUserListItem | null>(null);
const assignRoleIds = ref<string[]>([]);

const assignTitle = computed(() =>
  assignTarget.value
    ? `分配职位 · <span class="em">${esc(assignTarget.value.userName)}</span>`
    : '分配职位',
);

const assignTags = computed<ModuleTag[]>(() => moduleTags(mergedMap(assignRoleIds.value)));
const assignPermCount = computed(() => actionCount(mergedMap(assignRoleIds.value)));
const assignModuleCount = computed(() => assignTags.value.filter((t) => t.c > 0).length);

const assignIsOn = (id: string): boolean => assignRoleIds.value.includes(id);

async function openAssignRole(row: PermUserListItem): Promise<void> {
  assignTarget.value = row;
  assignRoleIds.value = [...row.roleIds];
  assignOpen.value = true;
  await ensureRolePerms(assignRoleIds.value);
}

/** 勾选（原型复用 togRoleCk：停用职位同样要先确认） */
function togAssignRole(r: PermRoleListItem): void {
  if (r.roleStatus === '停用' && !assignIsOn(r.id)) {
    openConfirm(
      {
        title: '职位已停用',
        icon: '⚠',
        iconBg: 'var(--warn-l)',
        msg: `职位「${r.roleName}」当前处于停用状态`,
        desc: '为该账号分配已停用职位，账号登录后不会获得该职位的权限。',
        tip: '建议先启用该职位，或改选其他职位。',
        okText: '仍然分配',
        okClass: 'wn',
      },
      () => {
        assignRoleIds.value = [...assignRoleIds.value, r.id];
      },
    );
    return;
  }
  assignRoleIds.value = assignIsOn(r.id)
    ? assignRoleIds.value.filter((x) => x !== r.id)
    : [...assignRoleIds.value, r.id];
}

function submitAssignRole(): void {
  const row = assignTarget.value;
  if (!row) return;
  const ids = [...assignRoleIds.value];
  const cur = row.roleIds;

  if (!ids.length) {
    openConfirm(
      {
        title: '未选择职位',
        icon: '⚠',
        iconBg: 'var(--warn-l)',
        msg: '确认清空该账号的全部职位？',
        desc: '清空后该账号将无法登录系统，操作前请确认。',
        warn: '建议至少保留一个职位。',
        okText: '确认清空',
        okClass: 'dg',
      },
      () => {
        // 后端强制「账号至少保留一个职位」，这里按同样的规则拦截，避免打一次注定失败的请求
        toast('账号至少需要保留一个职位，已取消清空', 'warn');
      },
    );
    return;
  }

  const added = ids.filter((r) => !cur.includes(r));
  const removed = cur.filter((r) => !ids.includes(r));
  openConfirm(
    {
      title: '保存职位分配',
      icon: '🔗',
      msg: `确认更新「${row.userName}」的职位？`,
      detail: [
        { k: '职位总数', v: `${cur.length} → <b style="color:var(--brand)">${ids.length}</b>` },
        {
          k: '新增职位',
          v: added.length
            ? added
                .map((r) => `<span class="tag g">${esc(roleNameById(r))}</span>`)
                .join(' ')
            : '<span class="desc">无</span>',
        },
        {
          k: '移除职位',
          v: removed.length
            ? removed
                .map((r) => `<span class="tag d">${esc(roleNameById(r))}</span>`)
                .join(' ')
            : '<span class="desc">无</span>',
        },
        { k: '合并权限', v: `${ids.reduce((a, r) => a + permCountOf(r), 0)} 项动作` },
      ],
      okText: '确认保存',
    },
    () => {
      void saveAssign(row, ids);
    },
  );
}

function roleNameById(id: string): string {
  return roles.value.find((r) => r.id === id)?.roleName || '—';
}

async function saveAssign(row: PermUserListItem, ids: string[]): Promise<void> {
  try {
    // 职位分配走账号编辑接口（职位为全量覆盖），其余字段原样带回
    await userApi.update({
      id: row.id,
      userName: row.userName,
      account: row.account,
      phone: row.phone,
      gender: row.gender,
      age: row.age,
      deptId: row.deptId,
      roleIds: ids,
      userStatus: row.userStatus,
      needChangePwd: row.needChangePwd,
    });
    assignOpen.value = false;
    toast('已更新职位分配');
    await Promise.all([load(), loadOverview()]);
  } catch {
    /* 已提示 */
  }
}

/* ============================================================
 * 七、重置密码（原型 resetPwd 第 2398~2460 行）
 * ============================================================ */

const resetOpen = ref(false);
const resetTarget = ref<PermUserListItem | null>(null);
const resetPwdValue = ref('');
const resetNeedChange = ref(true);
const resetNotify = ref(true);
const pwdRuleOpen = ref(false);

const resetTitle = computed(() =>
  resetTarget.value
    ? `重置密码 · <span class="em">${esc(resetTarget.value.userName)}</span>`
    : '重置密码',
);

/** 手机号中间打码（原型：前 3 位 + **** + 后 4 位） */
const resetPhoneMasked = computed(() => {
  const p = resetTarget.value?.phone || '';
  return p.length >= 7 ? `${p.slice(0, 3)}****${p.slice(-4)}` : p;
});

const resetPwScore = computed(() => pwdScore(resetPwdValue.value));
const resetPwColor = computed(() => PWD_COLORS[resetPwScore.value]);
const resetPwText = computed(() => PWD_TEXTS[resetPwScore.value] || '太短');

function openReset(row: PermUserListItem): void {
  resetTarget.value = row;
  // ★ 2026-10-16：打开即按规则随机生成一个新密码（可点「随机」再换）
  resetPwdValue.value = genPwdByRule();
  resetNeedChange.value = true;
  resetNotify.value = true;
  resetOpen.value = true;
}

/**
 * ⭐ 2026-10-16：按【密码规则】随机生成一个密码 —— 新建/编辑账号与重置密码弹窗共用。
 *
 * 规则 = 含大写字母 + 含数字 + 长度不低于 8 位（与界面上那句提示完全一致）。
 * 组成：2 个大写 + 3 个小写 + 3 个数字 = 8 位，再打散顺序，避免固定「大写-小写-数字」的形状。
 * ⚠️ 不掺特殊符号：这条规则本身不要求，而且管理员要口头/短信告知本人，好念好抄更要紧。
 */
function genPwdByRule(): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // 去掉 I O 这些易混字符
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const digit = '23456789'; // 去掉 0 1
  const pick = (s: string, n: number) =>
    Array.from({ length: n }, () => s[Math.floor(Math.random() * s.length)]).join('');
  return (pick(upper, 2) + pick(lower, 3) + pick(digit, 3))
    .split('')
    .sort(() => (Math.random() < 0.5 ? -1 : 1))
    .join('');
}

/** 随机按钮：按同一规则再换一个 */
function rpGen(): void {
  resetPwdValue.value = genPwdByRule();
}

function doResetPwd(): void {
  const row = resetTarget.value;
  if (!row) return;
  const p = resetPwdValue.value;
  if (p.length < 8 || !/[A-Z]/.test(p) || !/[0-9]/.test(p)) {
    pwdRuleOpen.value = true;
    return;
  }
  const notify = resetNotify.value;
  openConfirm(
    {
      title: '重置密码确认',
      icon: '🔑',
      iconBg: 'var(--warn-l)',
      msg: `确认重置「${row.userName}」的登录密码？`,
      detail: [
        { k: '账号', v: esc(row.account) },
        { k: '新密码', v: `<code>${esc(p)}</code>` },
        {
          k: '首次改密',
          v: resetNeedChange.value ? '<span class="tag w">强制修改</span>' : '<span class="tag n">不强制</span>',
        },
        { k: '短信通知', v: notify ? '<span class="tag g">已开启</span>' : '<span class="tag gy">未开启</span>' },
      ],
      warn: '重置后原密码立即失效，该账号所有在线会话将被强制下线。',
      okText: '确认重置',
      okClass: 'wn',
    },
    () => {
      void saveReset(row, p, notify);
    },
  );
}

async function saveReset(row: PermUserListItem, pwd: string, notify: boolean): Promise<void> {
  try {
    await userApi.resetPwd({
      userId: row.id,
      newPassword: pwd,
      needChangePwd: resetNeedChange.value,
    });
    resetOpen.value = false;
    toast(
      notify
        ? `已重置「${row.userName}」的密码，通知短信已发送至 ${row.phone}`
        : `已重置「${row.userName}」的密码`,
    );
    await load();
  } catch {
    /* 已提示 */
  }
}

/* ============================================================
 * 八、停用 / 启用 / 解锁 / 删除（原型第 2461~2522 行）
 * ============================================================ */

/** 该账号是否持有系统管理员职位（后端保护：不可删除、不可停用） */
function isSysAdminUser(row: PermUserListItem): boolean {
  return row.roleIds.some((id) => roles.value.find((r) => r.id === id)?.roleCode === 'SYS_ADMIN');
}

function toggleUser(row: PermUserListItem): void {
  const off = row.userStatus === '正常';
  openConfirm(
    {
      title: off ? '停用账号' : '启用账号',
      icon: off ? '⏸' : '✅',
      iconBg: off ? 'var(--warn-l)' : 'var(--ok-l)',
      msg: `确认${off ? '停用' : '启用'}账号「${row.userName}」？`,
      detail: [
        { k: '账号', v: esc(row.account) },
        { k: '职位', v: row.roleNames.length ? esc(row.roleNames.join('、')) : '<span class="desc">无</span>' },
        { k: '变更后状态', v: off ? '已停用' : '正常' },
      ],
      warn: off ? '停用后该账号立即无法登录，但数据保留；如需彻底移除请用"删除"。' : '',
      tip: off
        ? '如需临时冻结（保留登录但只读），请联系管理员配置只读职位。'
        : '启用后该账号恢复原有职位权限。',
      okText: off ? '确认停用' : '确认启用',
      okClass: off ? 'wn' : 'pri',
    },
    () => {
      void saveStatus(row, off ? '已停用' : '正常', off);
    },
  );
}

async function saveStatus(row: PermUserListItem, status: string, off: boolean): Promise<void> {
  try {
    await userApi.setStatus(row.id, status);
    toast(`账号「${row.userName}」已${off ? '停用' : '启用'}`, off ? 'warn' : 'ok');
    await Promise.all([load(), loadOverview()]);
  } catch {
    /* 已提示 */
  }
}

/** 「解锁并重置密码」的后续动作（ProtoConfirm 的 mid 事件） */
let unlockMidAction: () => void = () => undefined;

function unlockUser(row: PermUserListItem): void {
  openConfirm(
    {
      title: '解锁账号',
      icon: '🔓',
      iconBg: 'var(--ok-l)',
      msg: `确认解锁账号「${row.userName}」？`,
      detail: [
        { k: '账号', v: esc(row.account) },
        { k: '当前状态', v: '<span class="tag d">已锁定</span>' },
        { k: '变更后状态', v: '正常' },
      ],
      tip: '解锁后失败计数清零，该账号可正常登录；若为本人异常，建议同时重置密码。',
      okText: '确认解锁',
      okClass: 'ok',
      midText: '解锁并重置密码',
    },
    () => {
      void saveUnlock(row, false);
    },
  );
  // 中间按钮：解锁后再拉起重置密码弹窗
  unlockMidAction = () => {
    void saveUnlock(row, true);
  };
}

function onConfirmMid(): void {
  confirmOpen.value = false;
  unlockMidAction();
}

async function saveUnlock(row: PermUserListItem, thenReset: boolean): Promise<void> {
  try {
    await userApi.unlock(row.id);
    if (thenReset) {
      toast('已解锁，请继续重置密码');
      await Promise.all([load(), loadOverview()]);
      openReset(row);
      return;
    }
    toast(`账号「${row.userName}」已解锁`);
    await Promise.all([load(), loadOverview()]);
  } catch {
    /* 已提示 */
  }
}

function delUser(row: PermUserListItem): void {
  // 后端对系统管理员账号有硬保护（不可删除），提前拦一次少打一次必失败的请求
  if (isSysAdminUser(row)) {
    openConfirm(
      {
        title: '系统管理员账号不可删除',
        icon: '🚫',
        iconBg: 'var(--dg-l)',
        msg: `账号「${row.userName}」是系统预置管理员`,
        desc: '系统管理员账号受保护，既不可删除也不可停用，避免误操作导致无人能维护权限体系。',
        detail: [
          { k: '账号', v: `${esc(row.userName)}（${esc(row.account)}）` },
          { k: '职位', v: '<span class="tag p">🔧 系统管理员</span>' },
          { k: '建议操作', v: '如需调整其权限，请到「职位权限分配」修改职位' },
        ],
        tip: '若该人员已离职，请新建账号接替后再联系管理员处理。',
        okText: '知道了',
        okClass: 'pri',
      },
      () => undefined,
    );
    return;
  }

  openConfirm(
    {
      title: '删除账号',
      icon: '🗑',
      iconBg: 'var(--dg-l)',
      msg: `确认删除账号「${row.userName}」？`,
      detail: [
        { k: '账号', v: esc(row.account) },
        { k: '部门', v: esc(row.deptName) },
        { k: '职位', v: row.roleNames.length ? esc(row.roleNames.join('、')) : '<span class="desc">无</span>' },
      ],
      warn: '删除后账号不可恢复，如需再次使用只能重新创建；门户登录账号也会一并作废。',
      okText: '确认删除',
      okClass: 'dg',
    },
    () => {
      void saveRemove(row);
    },
  );
}

async function saveRemove(row: PermUserListItem): Promise<void> {
  try {
    await userApi.remove(row.id);
    toast(`账号「${row.userName}」已删除`, 'err');
    await Promise.all([load(), loadOverview()]);
  } catch {
    /* 已提示 */
  }
}

/* ============================================================
 * 九、批量导入（原型 dlgImportUser 第 2524~2570 行）
 *
 * ⚠️ 后端暂无账号导入接口，这里保留原型弹窗与校验流程，
 *    点「确认导入」只做提示、不落库（避免伪造成功）。
 * ============================================================ */

const importOpen = ref(false);
const importResultOpen = ref(false);
const importFailRows = [
  { name: '赵晓峰', account: 'zhaoxf', phone: '135****2201', ok: true },
  { name: '钱多多', account: 'qiandd', phone: '136****3302', ok: true },
  { name: '孙小美', account: 'sunxm', phone: '137****4403', ok: false },
];
const importDetail = [
  { k: '成功', v: '<b style="color:var(--ok)">2</b> 条' },
  { k: '失败', v: '<b style="color:var(--dg)">1</b> 条 · 手机号重复' },
];

function pickImportFile(): void {
  toast('原型演示：已模拟选中 用户导入模板.xlsx');
}

function doImport(): void {
  importOpen.value = false;
  importResultOpen.value = true;
}

function confirmImport(): void {
  toast('账号导入接口尚未提供，本次未写入数据', 'warn');
}

/* ============================================================
 * 十、导出（原型 exportDlg 第 1896~1914 行）
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
    exportScope.value === 'all' ? '全部数据' : exportScope.value === 'page' ? '当前页' : '全部筛选结果';
  try {
    const res = await exportApi.do({
      resource: 'user',
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
    <!-- ==================== KPI（原型 renderUsers 第 1933~1940 行） ==================== -->
    <div class="kpi">
      <div class="k" @click="kpiAll">
        <div class="n b">{{ overview?.userTotal ?? '—' }}</div>
        <div class="l">账号总数</div>
      </div>
      <div class="k" @click="kpiStatus('正常')">
        <div class="n g">{{ overview?.normalTotal ?? '—' }}</div>
        <div class="l">正常账号</div>
      </div>
      <div class="k" @click="kpiStatus('已停用')">
        <div class="n w">{{ overview?.disabledTotal ?? '—' }}</div>
        <div class="l">已停用</div>
      </div>
      <div class="k" @click="kpiStatus('已锁定')">
        <div class="n d">{{ overview?.lockedTotal ?? '—' }}</div>
        <div class="l">已锁定</div>
      </div>
      <div
        class="k"
        @click="toast(`共 ${overview?.needChangePwdTotal ?? 0} 个账号需首次登录修改密码`, 'warn')"
      >
        <div class="n p">{{ overview?.needChangePwdTotal ?? '—' }}</div>
        <div class="l">待改初始密码</div>
      </div>
    </div>

    <!-- ==================== 账号列表（原型第 1942~1995 行） ==================== -->
    <div class="card">
      <div class="card-h">
        <div class="t">
          <span class="bar"></span>账号列表 <span class="sub">共 {{ total }} 个</span>
        </div>
        <div class="r">
          <input
            v-model="query.keyword"
            class="inp"
            placeholder="按姓名 / 手机号 / 账号搜索"
            style="width: 220px"
            @input="onKeywordInput"
            @keyup.enter="searchNow"
          />
          <select v-model="query.deptId" class="inp" @change="searchNow">
            <option value="">全部部门</option>
            <option v-for="d in deptFlat" :key="d.id" :value="d.id">{{ d.deptName }}</option>
          </select>
          <select v-model="query.roleId" class="inp" @change="searchNow">
            <option value="">全部职位</option>
            <option v-for="r in roles" :key="r.id" :value="r.id">{{ r.roleName }}</option>
          </select>
          <select v-model="query.userStatus" class="inp" @change="searchNow">
            <option value="">全部状态</option>
            <option value="正常">正常</option>
            <option value="已停用">已停用</option>
            <option value="已锁定">已锁定</option>
          </select>
          <button class="btn" type="button" @click="resetQuery">重置</button>
          <button class="btn" type="button" @click="importOpen = true">批量导入</button>
          <button class="btn" type="button" @click="openExport">导出</button>
          <button class="btn pri" type="button" @click="openAdd">＋ 新建账号</button>
        </div>
      </div>
      <div class="card-b p0">
        <div class="tb-wrap">
          <table class="tb">
            <thead>
              <tr>
                <th style="width: 150px">姓名</th>
                <th style="width: 120px">登录账号</th>
                <th style="width: 130px">手机号</th>
                <th style="width: 120px">所属部门</th>
                <th style="width: 170px">所属职位</th>
                <th style="width: 80px">状态</th>
                <th style="width: 132px">最后登录</th>
                <th style="width: 290px">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="u in list" :key="u.id">
                <td>
                  <b class="lk" @click="openUserDetail(u)">{{ u.userName }}</b>
                </td>
                <td>
                  <code
                    style="font-size: 11.5px; background: #FBF7F4; padding: 1px 6px; border-radius: 4px"
                  >{{ u.account }}</code>
                </td>
                <td class="num">{{ u.phone }}</td>
                <td>{{ u.deptName }}</td>
                <td>
                  <template v-if="u.roleNames.length">
                    <span
                      v-for="n in u.roleNames"
                      :key="n"
                      class="tag b"
                      style="margin: 1px 2px 1px 0"
                    >{{ n }}</span>
                  </template>
                  <span v-else class="tag d">无职位</span>
                </td>
                <td>
                  <span v-if="u.userStatus === '正常'" class="tag g">正常</span>
                  <span v-else-if="u.userStatus === '已停用'" class="tag gy">已停用</span>
                  <span v-else class="tag d">已锁定</span>
                  <span v-if="u.needChangePwd" class="tag w" style="margin-top: 2px">待改密</span>
                </td>
                <td class="desc num">{{ u.lastLoginTime || '—' }}</td>
                <td>
                  <div class="acts">
                    <span class="lk" @click="openUserDetail(u)">查看</span>
                    <span class="lk" @click="openEdit(u)">编辑</span>
                    <span class="lk" @click="openAssignRole(u)">分配职位</span>
                    <span
                      class="lk wn"
                      title="本人忘记密码、登不进系统时，由管理员代其重置新密码"
                      @click="openReset(u)"
                      >重置密码</span
                    >
                    <span
                      class="lk"
                      :class="u.userStatus === '正常' ? 'wn' : 'gr'"
                      @click="toggleUser(u)"
                    >{{ u.userStatus === '正常' ? '停用' : '启用' }}</span>
                    <span v-if="u.userStatus === '已锁定'" class="lk gr" @click="unlockUser(u)">解锁</span>
                    <span class="lk dg" @click="delUser(u)">删除</span>
                  </div>
                </td>
              </tr>
              <tr v-if="!list.length">
                <td colspan="8">
                  <div class="empty">
                    <div class="ic">🔍</div>
                    {{ loading ? '加载中…' : '没有符合条件的账号' }}
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <!-- 分页条：原型是一次性全量渲染，开发版必须保留服务端分页语义 -->
      <div class="card-b" style="border-top: 1px solid var(--line2); display: flex; align-items: center; gap: 8px">
        <span class="desc">
          共 <b>{{ total }}</b> 个账号 · 第 {{ query.page }} / {{ pageCount }} 页
        </span>
        <span style="margin-left: auto"></span>
        <select v-model.number="query.size" class="inp" style="width: 104px" @change="onSizeChange">
          <option :value="10">10 条/页</option>
          <option :value="20">20 条/页</option>
          <option :value="50">50 条/页</option>
          <option :value="100">100 条/页</option>
        </select>
        <button class="btn sm" type="button" :disabled="query.page <= 1" @click="goPage(query.page - 1)">
          上一页
        </button>
        <button
          class="btn sm"
          type="button"
          :disabled="query.page >= pageCount"
          @click="goPage(query.page + 1)"
        >
          下一页
        </button>
      </div>
    </div>

    <div class="notice i">
      ℹ<div><b>删除规则：</b>账号有业务数据关联时不可删除，不可停用；系统管理员账号既不可删除也不可停用。</div>
    </div>

    <!-- ==================== 账号详情 ====================
         ⚠️ 2026-10-07 起改用 @/perm/components/UserDetailDialog.vue ——
         「账号管理 / 部门管理 / 职位管理」三处点「账号详情」看到的是同一个弹窗，
         内容也一致（基本信息 + 所属职位 + 有效权限明细），这里不再自己写一份。 -->
    <!-- ★ 2026-10-19：「去编辑」按钮已从共享组件里彻底删除，故这里不再传开关；
         本页改账号走列表行操作里的「编辑」。 -->
    <UserDetailDialog
      v-model="userDetailOpen"
      :user-id="userDetailId"
      :fallback="userDetailRow"
    />

    <!-- ==================== 编辑账号（就地弹窗，与部门管理共用一份） ==================== -->
    <!-- ★ 2026-10-20：编辑从下面那个合体表单里搬出来，抽成共享组件，
         这样「部门管理 → 编辑账号」也能就地改，不必跳回本页。 -->
    <UserEditDialog
      v-model="userEditOpen"
      :user-id="userEditId"
      :fallback="userEditRow"
      @saved="onUserEdited"
    />

    <!-- ==================== 新建账号（原型 openUserForm 第 2078~2187 行） ====================
         ⚠️ ★ 2026-10-20：本表单现在【只用于新建】—— 编辑已迁到上面的 UserEditDialog，
         `formMode` 恒为 'add'，里面 `formMode === 'edit'` 的分支不会再走到。 -->
    <ProtoDialog v-model="formOpen" :title="formTitle" size="xl">
      <!-- ★ 2026-10-19：编辑账号只保留【基本信息】→ 单列；新建账号仍是左信息 + 右职位两列 -->
      <div
        :style="{
          display: 'grid',
          gridTemplateColumns: formMode === 'edit' ? '1fr' : '1.15fr 0.85fr',
          gap: '20px',
        }"
      >
        <!-- 左：基本信息（新建时下方还有 所属部门） -->
        <div>
          <div class="sec-t"><span class="bar"></span>基本信息</div>
          <div class="fm" style="grid-template-columns: 1fr 1fr">
            <div class="f">
              <label>姓名 <span class="req">*</span></label>
              <input v-model="form.userName" class="inp" placeholder="请输入真实姓名" />
            </div>
            <div class="f">
              <label>性别 <span class="req">*</span></label>
              <div class="radios">
                <label><input v-model="form.gender" type="radio" name="uf_gen" :value="1" /> 男</label>
                <label><input v-model="form.gender" type="radio" name="uf_gen" :value="2" /> 女</label>
              </div>
            </div>
            <div class="f">
              <label>年龄 <span class="req">*</span></label>
              <input v-model.number="form.age" class="inp" type="number" min="20" max="65" placeholder="20-65" />
            </div>
            <div class="f">
              <label>手机号 <span class="req">*</span></label>
              <input
                :value="form.phone"
                class="inp"
                placeholder="11 位手机号"
                maxlength="11"
                inputmode="numeric"
                @input="onPhoneInput"
              />
            </div>
            <div class="f">
              <label>登录账号 <span class="req">*</span></label>
              <input v-model="form.account" class="inp" placeholder="字母/数字，4-20 位" />
            </div>
            <!-- ★ 2026-10-16 按用户要求：编辑账号页不再涉及密码 ——
                 密码只在【新建账号】时由管理员生成（并同步开通门户登录）；
                 忘记密码走行内「重置密码」，本人自己改走右上角「修改密码」。 -->
            <template v-if="formMode === 'add'">
            <div class="f full">
              <!-- 规则标记紧跟在「密码」右边，并用括号括起来 -->
              <label style="display: flex; align-items: center; gap: 6px">
                <span>密码</span>
                <!-- ★ 2026-10-16：密码改为必填 —— 两种模式都带红色 * -->
                <span class="req">*</span>
                <span style="font-weight: 400; font-size: 11px; color: #9C8D88"
                  >（密码需包含大写字母和数字，长度不低于 8 位）</span
                >
              </label>
              <div class="pw">
                <input
                  v-model="form.password"
                  class="inp"
                  :type="showPwd ? 'text' : 'password'"
                  placeholder="请输入密码"
                />
                <button class="btn" type="button" @click="genPwd">随机</button>
                <button class="btn" type="button" @click="togglePwd">{{ showPwd ? '隐藏' : '显示' }}</button>
              </div>
              <!-- ★ 2026-10-16：把「谁设密码、谁能改」写清楚 ——
                   管理员在新建账号时生成初始密码并告知本人，本人登录后可在右上角自行修改 -->
              <div class="desc" style="margin-top: 5px">
                创建后请把「登录账号 + 初始密码」告知本人；本人登录后可在右上角「修改密码」自行修改。
              </div>
              <div v-if="form.password" style="display: flex; gap: 3px; align-items: center; margin-top: 5px">
                <div
                  v-for="i in 4"
                  :key="i"
                  style="flex: 1; height: 4px; border-radius: 2px"
                  :style="{ background: i <= pwScore ? pwColor : '#EFE9E4' }"
                ></div>
                <span
                  style="font-size: 11px; margin-left: 5px; white-space: nowrap"
                  :style="{ color: pwColor }"
                >{{ pwText }}</span>
              </div>
            </div>
            <div class="f full">
              <label style="display: flex; align-items: center; gap: 6px; cursor: pointer">
                <input
                  v-model="form.needChangePwd"
                  type="checkbox"
                  style="accent-color: var(--brand)"
                />
                强制首次登录修改密码
              </label>
            </div>
            </template>

            <div class="f">
              <label>账号状态 <span class="req">*</span></label>
              <select v-model="form.userStatus" class="inp">
                <!-- ★ 2026-10-16：新建时不给默认值，先显示「请选择」 -->
                <option value="" disabled>请选择</option>
                <option v-for="o in statusOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
              </select>
            </div>
          </div>

          <!-- ★ 2026-10-19：所属部门 / 所属职位 / 权限预览 / 快捷套用
               只在【新建账号】时出现 —— 编辑账号只改基础信息。
               编辑时这些字段沿用列表带回的原值一起提交，不会被改动；
               需要调整职位或部门请走列表里的「分配职位」入口。 -->
          <template v-if="formMode === 'add'">
          <!-- ★ 2026-10-19：原先的「可访问模块」勾选区已按用户要求删除 ——
               模块改为【按所选职位自动推导】（见 utils/moduleDerive.ts）：
               ① 权限库模块 → 门户模块 按固定表映射（market→consult / fin→finance /
                  perm→perm / job→job / train→job / acad→edu / teach→class+class-jh /
                  approve 不单独给模块）；
               ② 推到 ≥ 6 个 → 视为跨板块角色（校长 / 系统管理员），直接全开；
               ③ 一个都推不出来 → 回退全部模块，保证建出来的账号一定登得进去。
               最终结果会在提交前的确认框里列出来，不会再手勾。 -->
          <div class="divider"></div>
          <div class="sec-t">
            <span class="bar"></span>所属部门 <span class="desc">（该账号归属与可见范围）</span>
          </div>
          <div
            style="border: 1px solid var(--line); border-radius: 9px; padding: 9px 11px; max-height: 180px; overflow-y: auto"
          >
            <div class="tree">
              <template v-for="d in deptRoots" :key="d.id">
                <div class="n">
                  <input type="checkbox" :checked="deptOn.has(d.id)" @click.prevent="pickDept(d.id)" />
                  <span class="nm" @click="pickDept(d.id)">
                    {{ d.deptName }}
                    <span v-if="deptRemark[d.id]" class="desc">· {{ deptRemark[d.id] }}</span>
                  </span>
                </div>
                <div v-if="d.children?.length" class="ch">
                  <div v-for="k in d.children" :key="k.id" class="n">
                    <input type="checkbox" :checked="deptOn.has(k.id)" @click.prevent="pickDept(k.id)" />
                    <span class="nm" @click="pickDept(k.id)">{{ k.deptName }}</span>
                  </div>
                </div>
              </template>
            </div>
          </div>
          <div class="desc mt8">
            ※ 选择"教学部"会级联勾选初中部/高中部/大学部；未勾选子部门时按上级部门归属。
          </div>
          </template>

        </div>

        <!-- 右：职位 + 权限预览 + 快捷套用（★ 2026-10-19：仅新建账号时出现） -->
        <div v-if="formMode === 'add'">
          <div class="sec-t"><span class="bar"></span>所属职位 <span class="desc">（可多选）</span></div>
          <div
            style="border: 1px solid var(--line); border-radius: 9px; padding: 9px; max-height: 262px; overflow-y: auto"
          >
            <div
              v-for="r in roles"
              :key="r.id"
              class="rl-item"
              :class="{ on: isRoleOn(r.id) }"
              :style="r.roleStatus === '停用' ? 'opacity:.5' : ''"
              @click="togRole(r)"
            >
              <input
                type="checkbox"
                :checked="isRoleOn(r.id)"
                style="accent-color: var(--brand); pointer-events: none"
              />
              <span>{{ roleIcon(r) }} {{ r.roleName }}</span>
              <span class="cnt">{{ r.roleStatus === '停用' ? '已停用' : r.permCount + ' 项权限' }}</span>
            </div>
          </div>
          <div class="desc" style="margin: 7px 0 0">
            权限取所选职位的<b>并集</b>；如需精细调整，请编辑对应职位的权限树。
          </div>

          <div class="mt12">
            <div class="sec-t">
              <span class="bar"></span>权限预览
              <span class="desc" style="font-weight: 400">（随职位勾选实时变化）</span>
              <span style="margin-left: auto">
                <span class="lk" @click="openPreview">查看明细</span>
              </span>
            </div>
            <div
              style="
                border: 1px solid var(--line);
                border-radius: 9px;
                padding: 10px 12px;
                background: #FBF8F5;
                min-height: 120px;
              "
            >
              <div v-if="!formRoleIds.length" class="empty" style="padding: 22px">
                <div class="ic">🎭</div>
                尚未选择职位，账号将无任何权限
              </div>
              <template v-else>
                <div style="font-size: 12.5px; margin-bottom: 8px">
                  合并后共 <b style="color: var(--brand)">{{ formPermCount }}</b> 项权限动作 ·
                  {{ formModuleCount }} 个模块可用
                </div>
                <div class="flex">
                  <span
                    v-for="t in formTags"
                    :key="t.key"
                    class="tag"
                    :class="t.c === 0 ? 'gy' : t.c === t.total ? 'g' : 'w'"
                  >{{ t.icon }} {{ t.name }} {{ t.c }}/{{ t.total }}</span>
                </div>
              </template>
            </div>
          </div>

          <div class="mt12">
            <div class="sec-t"><span class="bar"></span>快捷套用</div>
            <div class="flex">
              <button class="btn xs" type="button" @click="quickRoleSet(['咨询老师'])">只读咨询</button>
              <button class="btn xs" type="button" @click="quickRoleSet(['班主任'])">班主任</button>
              <button class="btn xs" type="button" @click="quickRoleSet(['教员', '助教'])">教员+助教</button>
              <button class="btn xs" type="button" @click="quickRoleSet(['财务'])">财务</button>
              <button class="btn xs" type="button" @click="quickRoleClear">清空</button>
            </div>
          </div>
        </div>
      </div>
      <template #footer>
        <div class="lft">
          {{ formMode === 'edit' ? `账号 ID：${form.id}` : '将自动生成账号 ID' }}
        </div>
        <button class="btn" type="button" @click="formOpen = false">取消</button>
        <button
          class="btn"
          type="button"
          @click="toast('已保存为草稿，可在列表中继续编辑')"
        >存草稿</button>
        <button class="btn pri" type="button" @click="submitUserForm">
          {{ formMode === 'edit' ? '保存修改' : '创建账号' }}
        </button>
      </template>
    </ProtoDialog>

    <!-- ============ 表单校验未通过（原型 submitUserForm 第 2293~2300 行） ============ -->
    <ProtoDialog v-model="invalidOpen" title="表单校验未通过" size="sm">
      <div class="notice d mb12">✕<div>请修正以下 {{ invalidErrs.length }} 处问题：</div></div>
      <ul style="padding-left: 20px; font-size: 12.5px; line-height: 1.95">
        <li v-for="e in invalidErrs" :key="e">{{ e }}</li>
      </ul>
      <div class="notice i mt12">
        ℹ<div>提示：所有带 <span style="color: var(--dg)">*</span> 的字段均为必填。</div>
      </div>
      <template #footer>
        <button class="btn pri" type="button" @click="invalidOpen = false">返回修改</button>
      </template>
    </ProtoDialog>

    <!-- ============ 权限明细预览（原型 previewUserPerm 第 2239~2254 行） ============ -->
    <ProtoDialog v-model="previewOpen" :title="previewTitle" size="lg">
      <div class="notice i mb12">ℹ<div>以下为该账号<b>实际生效</b>的权限（多职位取并集）。</div></div>
      <div v-for="m in previewCards" :key="m.key" style="margin-bottom: 12px">
        <div style="font-size: 12.5px; font-weight: 600; margin-bottom: 5px">{{ m.icon }} {{ m.name }}</div>
        <template v-if="m.rows.length">
          <div
            v-for="r in m.rows"
            :key="r.name"
            style="font-size: 12px; color: var(--tx2); margin-bottom: 3px; padding-left: 10px"
          >
            <b style="color: var(--tx)">{{ r.name }}</b>：<span
              v-for="a in r.actions"
              :key="a"
              class="tag b"
              style="margin-right: 2px"
            >{{ a }}</span>
          </div>
        </template>
        <div v-else class="desc" style="padding-left: 10px">❌ 无权限</div>
      </div>
      <template #footer>
        <button class="btn pri" type="button" @click="previewOpen = false">关闭</button>
      </template>
    </ProtoDialog>

    <!-- ==================== 分配职位（原型 openAssignRole 第 2344~2367 行） ==================== -->
    <ProtoDialog v-model="assignOpen" :title="assignTitle" size="md">
      <div class="notice i mb12">ℹ<div>可多选职位，账号权限为所选职位的<b>并集</b>。</div></div>
      <div
        style="border: 1px solid var(--line); border-radius: 9px; padding: 9px; max-height: 330px; overflow-y: auto"
      >
        <div
          v-for="r in roles"
          :key="r.id"
          class="rl-item"
          :class="{ on: assignIsOn(r.id) }"
          :style="r.roleStatus === '停用' ? 'opacity:.5' : ''"
          @click="togAssignRole(r)"
        >
          <input
            type="checkbox"
            :checked="assignIsOn(r.id)"
            style="accent-color: var(--brand); pointer-events: none"
          />
          <span>{{ roleIcon(r) }} {{ r.roleName }}</span>
          <span class="cnt">{{ r.deptName }} · {{ r.permCount }}项</span>
        </div>
      </div>
      <div class="mt12" style="border: 1px solid var(--line); border-radius: 9px; padding: 10px 12px; background: #FBF8F5">
        <div v-if="!assignRoleIds.length" class="empty" style="padding: 18px">
          <div class="ic">🎭</div>
          尚未选择职位，账号将无任何权限
        </div>
        <template v-else>
          <div style="font-size: 12.5px; margin-bottom: 8px">
            合并后共 <b style="color: var(--brand)">{{ assignPermCount }}</b> 项权限动作 ·
            {{ assignModuleCount }} 个模块可用
          </div>
          <div class="flex">
            <span
              v-for="t in assignTags"
              :key="t.key"
              class="tag"
              :class="t.c === 0 ? 'gy' : t.c === t.total ? 'g' : 'w'"
            >{{ t.icon }} {{ t.name }} {{ t.c }}/{{ t.total }}</span>
          </div>
        </template>
      </div>
      <template #footer>
        <div class="lft">
          当前职位：{{ assignTarget?.roleNames.join('、') || '无' }}
        </div>
        <button class="btn" type="button" @click="assignOpen = false">取消</button>
        <button class="btn pri" type="button" @click="submitAssignRole">保存职位分配</button>
      </template>
    </ProtoDialog>

    <!-- ==================== 重置密码（原型 resetPwd 第 2398~2426 行） ==================== -->
    <ProtoDialog v-model="resetOpen" :title="resetTitle" size="sm">
      <!-- ★ 2026-10-16：把「什么时候才用这个按钮」写在弹窗最上面 ——
           它是【本人忘记密码、登不进系统】时，由权限管理员代他重置的通道，
           本人自己能登录的话不该走这里（走右上角「修改密码」自助修改）。 -->
      <div class="notice i mb12">
        ℹ<div>
          <b>适用场景：</b>本人<b>忘记密码、登不进系统</b>时，由权限管理员在此代他重置一个新密码，
          再把新密码告知本人（本人用「账号 + 新密码」登录）。
          <span class="desc">本人自己能登录的话，请让他在右上角「修改密码」自行修改。</span>
        </div>
      </div>
      <div class="notice w mb12">
        ⚠<div>
          重置后原密码立即失效，请通过<strong>手机号 {{ resetPhoneMasked }}</strong> 告知本人。
        </div>
      </div>
      <div class="fm" style="grid-template-columns: 1fr">
        <!-- ★ 2026-10-16 按用户要求：不再让管理员从「系统默认/随机/自定义」里挑，
             直接把密码规则摆出来；下面的新密码就按这条规则【随机生成】。 -->
        <div class="f">
          <label>密码规则提示</label>
          <div style="font-size: 12.5px; color: #5F5350; line-height: 1.7; padding: 3px 0">
            需包含大写字母和数字，长度不低于 8 位
          </div>
        </div>
        <div class="f">
          <label>新密码</label>
          <div class="pw">
            <input v-model="resetPwdValue" class="inp" type="text" />
            <button class="btn" type="button" @click="rpGen">随机</button>
          </div>
          <div style="display: flex; gap: 3px; align-items: center; margin-top: 5px">
            <div
              v-for="i in 4"
              :key="i"
              style="flex: 1; height: 4px; border-radius: 2px"
              :style="{ background: i <= resetPwScore ? resetPwColor : '#EFE9E4' }"
            ></div>
            <span
              style="font-size: 11px; margin-left: 5px; white-space: nowrap"
              :style="{ color: resetPwColor }"
            >{{ resetPwText }}</span>
          </div>
        </div>
        <div class="f">
          <label style="display: flex; align-items: center; gap: 6px; cursor: pointer">
            <input v-model="resetNeedChange" type="checkbox" style="accent-color: var(--brand)" />
            强制该账号首次登录修改密码
          </label>
        </div>
        <div class="f">
          <label style="display: flex; align-items: center; gap: 6px; cursor: pointer">
            <input v-model="resetNotify" type="checkbox" style="accent-color: var(--brand)" />
            重置后短信通知本人
          </label>
        </div>
      </div>
      <div class="notice i mt12">ℹ<div>重置操作会记入操作日志，可在「操作日志」中追溯。</div></div>
      <template #footer>
        <button class="btn" type="button" @click="resetOpen = false">取消</button>
        <button class="btn pri" type="button" @click="doResetPwd">确认重置</button>
      </template>
    </ProtoDialog>

    <!-- 密码不符合规则（原型 doResetPwd 第 2441~2443 行） -->
    <ProtoDialog v-model="pwdRuleOpen" title="密码不符合规则" size="sm">
      <div class="notice d">✕<div>密码至少 8 位，且需包含大写字母与数字。</div></div>
      <template #footer>
        <button class="btn pri" type="button" @click="pwdRuleOpen = false">返回修改</button>
      </template>
    </ProtoDialog>

    <!-- ==================== 批量导入（原型 dlgImportUser 第 2524~2542 行） ==================== -->
    <ProtoDialog v-model="importOpen" title="批量导入账号" size="md">
      <div class="notice i mb12">
        ℹ<div>支持 Excel(.xlsx)/CSV。列顺序：姓名、性别、年龄、手机号、登录账号、所属部门、所属职位。</div>
      </div>
      <div
        style="border: 2px dashed var(--line); border-radius: 10px; padding: 26px; text-align: center; cursor: pointer"
        @click="pickImportFile"
      >
        <div style="font-size: 30px; opacity: 0.4">📥</div>
        <div style="margin-top: 8px; font-size: 13px">点击选择文件，或拖拽到此处</div>
        <div class="desc" style="margin-top: 4px">单次最多 1000 条 · 初始密码统一为 Ab@123456</div>
      </div>
      <div class="fm mt12" style="grid-template-columns: 1fr 1fr">
        <div class="f">
          <label>默认所属职位</label>
          <select class="inp">
            <option v-for="r in roles" :key="r.id">{{ r.roleName }}</option>
          </select>
        </div>
        <div class="f">
          <label>默认部门</label>
          <select class="inp">
            <option v-for="d in deptRoots" :key="d.id">{{ d.deptName }}</option>
          </select>
        </div>
      </div>
      <template #footer>
        <div class="lft">导入后强制首次登录修改密码</div>
        <button class="btn" type="button" @click="importOpen = false">取消</button>
        <button class="btn pri" type="button" @click="doImport">开始导入</button>
      </template>
    </ProtoDialog>

    <!-- 导入校验结果（原型 doImportUser） -->
    <ProtoConfirm
      v-model="importResultOpen"
      title="导入校验结果"
      icon="📋"
      msg="共解析 3 条，可导入 2 条"
      :detail="importDetail"
      ok-text="确认导入 2 条"
      @ok="confirmImport"
    >
      <table class="tb mt12">
        <thead>
          <tr>
            <th>姓名</th>
            <th>账号</th>
            <th>手机号</th>
            <th>校验</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in importFailRows" :key="r.account">
            <td>{{ r.name }}</td>
            <td><code style="font-size: 11.5px">{{ r.account }}</code></td>
            <td class="num">{{ r.phone }}</td>
            <td>
              <span v-if="r.ok" class="tag g">通过</span>
              <span v-else class="tag d">手机号重复</span>
            </td>
          </tr>
        </tbody>
      </table>
    </ProtoConfirm>

    <!-- ==================== 导出（原型 exportDlg 第 1896~1914 行） ==================== -->
    <ProtoDialog v-model="exportOpen" title='导出数据 <span class="tag n" style="font-weight:400">用户账号列表</span>' size="sm">
      <div class="notice i mb12">
        ℹ<div>将导出 <b>{{ total }}</b> 条数据，可在导出中心查看进度。</div>
      </div>
      <div class="sec-t"><span class="bar"></span>导出格式</div>
      <div class="ckgrid" style="grid-template-columns: 1fr 1fr">
        <div class="ck" :class="{ on: exportFormat === 'excel' }" @click="exportFormat = 'excel'">
          <input type="radio" name="expFmtU" :checked="exportFormat === 'excel'" />
          <div class="tx"><div class="n">Excel (.xlsx)</div><div class="d">推荐，保留表头与格式</div></div>
        </div>
        <div class="ck" :class="{ on: exportFormat === 'csv' }" @click="exportFormat = 'csv'">
          <input type="radio" name="expFmtU" :checked="exportFormat === 'csv'" />
          <div class="tx"><div class="n">CSV (.csv)</div><div class="d">纯文本，便于系统对接</div></div>
        </div>
      </div>
      <div class="sec-t mt16"><span class="bar"></span>导出内容</div>
      <div class="radios" style="height: auto; flex-direction: column; align-items: flex-start; gap: 8px">
        <label><input v-model="exportScope" type="radio" name="expScopeU" value="filtered" /> 当前筛选结果（{{ total }} 条）</label>
        <label><input v-model="exportScope" type="radio" name="expScopeU" value="all" /> 全部数据（含已停用/已锁定）</label>
        <label><input v-model="exportScope" type="radio" name="expScopeU" value="page" /> 仅选中项</label>
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
      :mid-text="cfg.midText"
      :ok-text="cfg.okText"
      :ok-class="cfg.okClass"
      :cancel-text="cfg.cancelText"
      @ok="onConfirmOk"
      @mid="onConfirmMid"
    />
  </div>
</template>
