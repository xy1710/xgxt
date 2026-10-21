<script setup lang="ts">
/**
 * 部门管理
 *
 * 页面结构严格对齐高保真原型《学管系统-权限体系高保真原型.html》：
 *   · 第 2682~2721 行 renderOrg()    —— KPI 4 卡 + 「部门结构」表格
 *   · 第 2722~2734 行 deptRoles()    —— 查看职位弹窗
 *   · 第 2735~2748 行 deptUsers()    —— 查看账号弹窗
 *   · 第 2749~2769 行 dlgDeptForm()  —— 新建 / 编辑部门弹窗
 *   · 第 2770~2785 行 submitDept()   —— 校验 + 确认后落库
 *   · 第 2786~2804 行 delDept()      —— 删除前拦截 + 删除确认
 *
 * 样式不写在这里：原型的 <style> 已整体移植到 src/styles/prototype.css
 * （main.ts 全局引入），这里只产出与原型同名同层级的 DOM。
 *
 * ⚠️ 保留的两条业务规则（原型弹窗只有一个「上级部门」下拉，规则体现在下拉里）：
 *    ① 「＋ 新建部门」默认上级 = 校级（顶级）→ 建出来的是与市场咨询部 / 教务部同级的一级部门；
 *       想建下级就在下拉里改选目标部门（等价于原型的「新建子部门」）。
 *    ② 层级上限 3（校级1 / 部门2 / 学段3）：下拉里 level=3 的部门置灰不可选，
 *       避免建出「无层级名」的第 4 层。
 *
 * ⚠️ 删除规则（后端已强制，前端提前拦一次，少一次无谓请求）：
 *    · 有子部门 / 被职位引用 / 被账号引用 → 不可删（弹「不可删除」并给出关联明细）
 *    · 校级部门不在表格里（原型 renderOrg 用 filter(d=>d.id!=='all') 排除了根节点），天然不可删
 */
import { computed, onMounted, reactive, ref } from 'vue';
import type {
  DeptOverview,
  PermDept,
  PermDeptTreeNode,
  PermModule,
  PermRoleListItem,
  PermUserListItem,
  RolePermMap,
} from 'shared-types/perm';
import { deptApi, roleApi, userApi, assignApi } from '@/perm/api/perm';
import ProtoDialog from '@/perm/components/ProtoDialog.vue';
import ProtoConfirm from '@/perm/components/ProtoConfirm.vue';
import PermTreeDialog from '@/perm/components/PermTreeDialog.vue';
import UserDetailDialog from '@/perm/components/UserDetailDialog.vue';
import UserEditDialog from '@/perm/components/UserEditDialog.vue';
import { roleIconOf } from '@/perm/utils/roleIcon';
import { toast } from '@/perm/utils/toast';

/** 部门层级上限（shared-types 的 DeptLevel：1 校级 / 2 部门 / 3 学段） */
const MAX_DEPT_LEVEL = 3;

/** 极简 HTML 转义（确认框明细与弹窗标题用 v-html 渲染，部门名是用户输入） */
function esc(s: string): string {
  return String(s ?? '').replace(/[&<>"]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;',
  );
}

/* ============================================================
 * 一、数据加载
 * ============================================================ */

const loading = ref(false);
const overview = ref<DeptOverview | null>(null);
/** 拍平后的全部部门节点（含校级根节点） */
const flatNodes = ref<PermDeptTreeNode[]>([]);
/**
 * ★ 2026-10-19 按用户要求新增：每个部门在部门树里的深度。
 *   校级=1；市场咨询部 / 教学部等=2；初中部 / 高中部 / 大学部=3。
 *   用途：表格「部门名称」列按层级缩进，让下级部门一眼看出从属关系。
 */
const deptDepth = ref<Record<string, number>>({});
/** 部门列表（带 remark / deptShort，树上没有） */
const deptList = ref<PermDept[]>([]);

/** 校级根部门（原型里的 'all'，level 1） */
const rootId = computed(() => flatNodes.value.find((n) => n.deptLevel === 1)?.id ?? '');

/** 表格行：原型 `DEPTS.filter(d=>d.id!=='all')` —— 排除校级根节点 */
const rows = computed(() => flatNodes.value.filter((n) => n.deptLevel !== 1));

/** 弹窗「上级部门」下拉的候选：原型 `DEPTS.filter(x=>x.id!=='all')` */
const parentOptions = computed(() => flatNodes.value.filter((n) => n.deptLevel !== 1));

const nameOf = (id: string): string =>
  flatNodes.value.find((n) => n.id === id)?.deptName || '—';

const childrenOf = (id: string): PermDeptTreeNode[] =>
  flatNodes.value.filter((n) => n.parentId === id);

/**
 * ★ 2026-10-19 部门结构树形缩进（按用户要求：下级部门不再在单元格里重复列一遍）。
 *   depthOf  —— 树深度；数据还没到手时按「直接挂在校级下」= 2 处理（即不缩进）
 *   indentOf —— 「部门名称」列的缩进量；第 2 层（校级直属）为 0，每深一层 +20px
 *   isLastSibling —— 同级里是不是最后一个，决定前面画「└」还是「├」
 */
const depthOf = (id: string): number => deptDepth.value[id] || 2;
const indentOf = (id: string): string => `${Math.max(0, depthOf(id) - 2) * 20}px`;
const isLastSibling = (d: PermDeptTreeNode): boolean => {
  const sibs = flatNodes.value.filter((n) => (n.parentId || '') === (d.parentId || ''));
  return sibs.length > 0 && sibs[sibs.length - 1].id === d.id;
};

const deptOf = (id: string): PermDept | undefined => deptList.value.find((d) => d.id === id);

/** 部门说明列（原型表格里的 `d.desc`） */
const remarkOf = (id: string): string => deptOf(id)?.remark || '—';

/** 上级是校级 → 原型显示「校部」标签而不是部门名 */
const isSchoolParent = (id: string): boolean => !id || id === rootId.value;

async function loadAll(): Promise<void> {
  loading.value = true;
  try {
    const [ov, t, page] = await Promise.all([
      deptApi.overview(),
      deptApi.tree(),
      deptApi.list({ page: 1, size: 100 }),
    ]);
    overview.value = ov;
    deptList.value = page.list || [];

    // 拍平一份，便于查上级名字 / 算下级部门；顺手把「树深度」也记下来给表格缩进用
    const flat: PermDeptTreeNode[] = [];
    const depth: Record<string, number> = {};
    const walk = (nodes: PermDeptTreeNode[], d: number): void => {
      nodes.forEach((n) => {
        flat.push(n);
        depth[n.id] = d;
        if (n.children?.length) walk(n.children, d + 1);
      });
    };
    walk(t, 1);
    flatNodes.value = flat;
    deptDepth.value = depth;
  } catch {
    /* 错误已在 request 拦截器里弹过提示 */
  } finally {
    loading.value = false;
  }
}

onMounted(loadAll);

/* ============================================================
 * 二、新建 / 编辑部门（原型 dlgDeptForm + submitDept）
 * ============================================================ */

interface DeptForm {
  id: string;
  deptName: string;
  /** 弹窗里不展示（原型无此字段），但保存时带上，避免把已有简称覆盖成空 */
  deptShort: string;
  parentId: string;
  remark: string;
}

const formOpen = ref(false);
const formTitle = ref('新建部门');
const form = reactive<DeptForm>({
  id: '',
  deptName: '',
  deptShort: '',
  parentId: '',
  remark: '',
});

/** 校验未通过的小弹窗（原型 submitDept 里的 notice d） */
const invalidOpen = ref(false);

function openAdd(): void {
  if (!rootId.value) {
    toast('部门数据还没加载好，请稍后再试', 'warn');
    return;
  }
  Object.assign(form, {
    id: '',
    deptName: '',
    deptShort: '',
    // 规则①：默认挂在校级（顶级）下 → 与市场咨询部 / 教务部同级
    parentId: rootId.value,
    remark: '',
  });
  formTitle.value = '新建部门';
  formOpen.value = true;
}

async function openEdit(node: PermDeptTreeNode): Promise<void> {
  const d = deptOf(node.id);
  // 列表里的字段够用；再取一次详情是为了拿到最权威的 remark / deptShort（改错了很难查）
  let detail: PermDept | null = null;
  try {
    detail = await deptApi.detail(node.id);
  } catch {
    /* 已提示，退回用列表 / 树节点上的字段 */
  }
  Object.assign(form, {
    id: node.id,
    deptName: detail?.deptName ?? d?.deptName ?? node.deptName,
    deptShort: detail?.deptShort ?? d?.deptShort ?? node.deptShort ?? '',
    parentId: detail?.parentId ?? d?.parentId ?? node.parentId ?? rootId.value,
    remark: detail?.remark ?? d?.remark ?? '',
  });
  formTitle.value = `编辑部门 · <span class="em">${esc(form.deptName)}</span>`;
  formOpen.value = true;
}

function submitDept(): void {
  const name = form.deptName.trim();
  if (!name) {
    invalidOpen.value = true;
    return;
  }
  const isEdit = !!form.id;
  openConfirm(
    {
      title: isEdit ? '保存部门修改' : '创建部门',
      icon: isEdit ? '💾' : '🏢',
      msg: isEdit ? `确认保存对「${name}」的修改？` : `确认创建部门「${name}」？`,
      detail: [
        { k: '部门名称', v: `<b>${esc(name)}</b>` },
        { k: '上级部门', v: isSchoolParent(form.parentId) ? '校部' : esc(nameOf(form.parentId)) },
        { k: '部门说明', v: esc(form.remark.trim()) || '—' },
      ],
      tip: '创建后可在新建职位/账号时选择该部门。',
      okText: isEdit ? '确认保存' : '确认创建',
    },
    () => {
      void saveDept();
    },
  );
}

async function saveDept(): Promise<void> {
  const name = form.deptName.trim();
  const short = form.deptShort || name.slice(0, 4);
  try {
    if (form.id) {
      await deptApi.update({
        id: form.id,
        deptName: name,
        deptShort: short,
        parentId: form.parentId,
        remark: form.remark.trim(),
      });
      toast('已保存部门');
    } else {
      await deptApi.add({
        deptName: name,
        deptShort: short,
        parentId: form.parentId,
        remark: form.remark.trim(),
      });
      toast(`已创建部门「${name}」`);
    }
    formOpen.value = false;
    await loadAll();
  } catch {
    /* 已提示 */
  }
}

/* ============================================================
 * 三、删除（原型 delDept）
 * ============================================================ */

async function delDept(node: PermDeptTreeNode): Promise<void> {
  const childCount = childrenOf(node.id).length;
  const roleCount = node.roleCount || 0;
  const userCount = node.userCount || 0;

  if (childCount || roleCount || userCount) {
    const detail: { k: string; v: string }[] = [];
    if (childCount) detail.push({ k: '下级部门', v: `<b>${childCount}</b> 个` });
    detail.push(
      { k: '关联职位', v: `<b>${roleCount}</b> 个` },
      { k: '关联账号', v: `<b>${userCount}</b> 个` },
    );
    openConfirm(
      {
        title: '不可删除',
        icon: '🚫',
        iconBg: 'var(--dg-l)',
        msg: `部门「${node.deptName}」仍有关联数据`,
        detail,
        desc: '请先将相关职位与账号转移至其他部门，再执行删除。',
        okText: '查看关联职位',
        okClass: 'wn',
      },
      () => {
        void openDeptRoles(node);
      },
    );
    return;
  }

  openConfirm(
    {
      title: '删除部门',
      icon: '🗑',
      iconBg: 'var(--dg-l)',
      msg: `确认删除部门「${node.deptName}」？`,
      warn: '删除后不可恢复，相关职位与账号的部门归属将同步失效。',
      okText: '确认删除',
      okClass: 'dg',
    },
    () => {
      void doRemove(node);
    },
  );
}

async function doRemove(node: PermDeptTreeNode): Promise<void> {
  try {
    await deptApi.remove(node.id);
    toast('部门已删除', 'err');
    await loadAll();
  } catch {
    /* 已提示 */
  }
}

/* ============================================================
 * 四、确认框（原型 confirmDlg）—— 三种确认共用同一个组件
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
 * 五、查看职位 / 查看账号（原型 deptRoles / deptUsers）
 * ============================================================ */

const rolesOpen = ref(false);
const rolesLoading = ref(false);
const rolesDeptName = ref('');
const rolesSub = ref('');
const deptRolesList = ref<PermRoleListItem[]>([]);

const rolesTitle = computed(
  () =>
    `部门下职位 · <span class="em">${esc(rolesDeptName.value)}</span>` +
    ` <span class="tag n" style="font-weight:400">${esc(rolesSub.value)}</span>`,
);

async function openDeptRoles(node: PermDeptTreeNode): Promise<void> {
  rolesDeptName.value = node.deptName;
  rolesSub.value = `${node.roleCount || 0} 个职位`;
  deptRolesList.value = [];
  rolesOpen.value = true;
  rolesLoading.value = true;
  try {
    // ★ 2026-10-16：「账号数」改为【本部门（含子部门）内】挂该职位的人数 ——
    //   职位接口的 userCount 是全系统口径（别的部门的咨询老师也算进来），
    //   会出现「弹窗里咨询老师 4 人、本部门账号只有 3 个」的对不上。
    //   这里直接拉本部门账号（与「查看账号」弹窗同源、同口径），按职位分组计数。
    const [page, upage] = await Promise.all([
      roleApi.list({ deptId: node.id, page: 1, size: 100 }),
      userApi.list({ deptId: node.id, page: 1, size: 100 }),
    ]);
    const cnt = new Map<string, number>();
    (upage.list || []).forEach((u: PermUserListItem) => {
      (u.roleIds || []).forEach((rid) => cnt.set(rid, (cnt.get(rid) || 0) + 1));
    });
    deptRolesList.value = (page.list || []).map((r) => ({
      ...r,
      userCount: cnt.get(r.id) || 0,
    }));
    rolesSub.value = `${deptRolesList.value.length} 个职位`;
  } catch {
    /* 已提示 */
  } finally {
    rolesLoading.value = false;
  }
}

const usersOpen = ref(false);
const usersLoading = ref(false);
const usersDeptName = ref('');
const usersSub = ref('');
const deptUsersList = ref<PermUserListItem[]>([]);
/** 当前弹窗对应的部门 id —— 保存账号后原样再拉一次用（★ 2026-10-20） */
const usersDeptId = ref('');

const usersTitle = computed(
  () =>
    `部门下账号 · <span class="em">${esc(usersDeptName.value)}</span>` +
    ` <span class="tag n" style="font-weight:400">${esc(usersSub.value)}</span>`,
);

async function openDeptUsers(node: PermDeptTreeNode): Promise<void> {
  usersDeptId.value = node.id;
  usersDeptName.value = node.deptName;
  usersSub.value = `${node.userCount || 0} 个账号`;
  deptUsersList.value = [];
  usersOpen.value = true;
  await reloadDeptUsers();
}

/** 重拉当前部门下的账号（打开弹窗 / 就地编辑保存后都走它） */
async function reloadDeptUsers(): Promise<void> {
  if (!usersDeptId.value) return;
  usersLoading.value = true;
  try {
    const page = await userApi.list({ deptId: usersDeptId.value, page: 1, size: 100 });
    deptUsersList.value = page.list || [];
    usersSub.value = `${deptUsersList.value.length} 个账号`;
  } catch {
    /* 已提示 */
  } finally {
    usersLoading.value = false;
  }
}

/** 账号状态标签：正常 → .tag g，其余 → .tag gy（原型 deptUsers） */
const isNormal = (st: string): boolean => st === '正常';

/* ============================================================
 * 六、账号详情弹窗
 *
 * 【用户反馈】「点击账号详情后有问题，应该弹出相应的页面，页面包含所有应该查看的内容」
 * 原先点「详情」只是 router.push('/user') 跳回账号管理列表页 —— 既不弹详情，
 * 还得自己再搜一次这个账号。现在就地弹完整详情（基本信息 + 所属职位 + 有效权限明细）。
 * ============================================================ */

const userDetailOpen = ref(false);
const userDetailId = ref('');
const userDetailRow = ref<PermUserListItem | null>(null);

function openUserDetail(u: PermUserListItem): void {
  userDetailRow.value = u;
  userDetailId.value = u.id;
  userDetailOpen.value = true;
}

/* ============================================================
 * 七、职位权限弹窗（「看权限 / 编辑权限」）
 *
 * 【用户反馈】「部门管理页面里面看权限和编辑权限的操作都有问题，点击后应该弹出相应的页面」
 * 原先两处都只是 router.push('/assign') —— 跳过去还不知道该选哪个职位，等于把活儿丢给用户。
 * 现在直接就地叠一层权限树：查看态只读、编辑态可勾选并保存。
 * ============================================================ */

const permOpen = ref(false);
const permLoading = ref(false);
const permReadonly = ref(true);
const permRole = ref<PermRoleListItem | null>(null);
const permModules = ref<PermModule[]>([]);
const permPerms = ref<RolePermMap>({});

/**
 * ⚠️ PermTreeDialog 内部是 el-dialog，`title` 按【纯文本】渲染（不走 v-html），
 *    所以这里不能塞 <span> 之类的标记，否则界面上会原样显示尖括号。
 */
const permTitle = computed(() => {
  const r = permRole.value;
  if (!r) return '配置权限';
  if (permLoading.value) return `加载权限中… · ${r.roleName}`;
  return `${permReadonly.value ? '查看权限' : '编辑权限'} · ${r.roleName}`;
});

async function openRolePerm(r: PermRoleListItem, readonly: boolean): Promise<void> {
  permRole.value = r;
  permReadonly.value = readonly;
  permPerms.value = {};
  permOpen.value = true;
  permLoading.value = true;
  try {
    const d = await assignApi.tree(r.id);
    permModules.value = d.modules || [];
    permPerms.value = d.perms || {};
  } catch {
    /* 已提示 */
  } finally {
    permLoading.value = false;
  }
}

async function onRolePermConfirm(perms: RolePermMap): Promise<void> {
  const r = permRole.value;
  if (!r) return;
  try {
    const res = await assignApi.save(r.id, perms);
    toast(`「${r.roleName}」权限已保存，共 ${res.permCount} 项`);
    // 让弹窗里的「权限数」立刻跟上（deptRolesList 是 roleApi.list 的快照）
    const hit = deptRolesList.value.find((x) => x.id === r.id);
    if (hit) hit.permCount = res.permCount;
  } catch {
    /* 已提示 */
  }
}

/**
 * 账号编辑：就地弹窗，不再跳「账号管理」
 *
 * ★ 2026-10-20 按用户要求改动。原先是 router.push('/user?edit=<id>')，
 *   跳到账号管理页再打开编辑表单 —— 用户原话「跳转到账号管理进行修改很别扭」。
 *   现在改用共享组件 UserEditDialog：字段、校验、保存接口与账号管理完全一致
 *   （同一份 基本信息 表单 + PUT /api/perm/user/update），就地改、就地存。
 *
 * ⚠️ 保存后要做两件事：① 刷新「部门下账号」这张表（姓名可能改了）；
 *   ② 刷新部门树 / KPI（账号状态、归属计数可能变）。
 */
const userEditOpen = ref(false);
const userEditId = ref('');
const userEditRow = ref<PermUserListItem | null>(null);

function openUserEdit(u: PermUserListItem): void {
  userEditRow.value = u;
  userEditId.value = u.id;
  userEditOpen.value = true;
}

async function onUserEdited(): Promise<void> {
  // 账号弹窗还开着 → 就地刷新它，别让用户看到旧姓名
  if (usersOpen.value) await reloadDeptUsers();
  await loadAll();
}

/** 「为该部门新建职位 / 新建账号」按钮已随 2026-10-16 界面清理移除（gotoPage 一并删除） */
</script>

<template>
  <div>
    <!-- ==================== KPI（原型 renderOrg 第 2687~2692 行） ==================== -->
    <div class="kpi">
      <!-- ★ 2026-10-20：实训教学部 + 就业管理部 合并为「就业部」，其下挂 实训管理 / 就业管理。
           原来第 1 张卡的口径是「部门总数 = 全部 - 校级 - 3 个学段」，第 2 张卡写死「学段（教学部）」；
           现在下设子部门变成 5 个（教学部 3 + 就业部 2），沿用旧文案会自相矛盾，故两处一起改口径。 -->
      <div class="k" @click="toast('部门总数只统计校级直属的一级部门：教学部的 3 个学段、就业部的 2 个下设部门不重复计入')">
        <div class="n b">{{ overview?.deptTotal ?? '—' }}</div>
        <div class="l">部门总数</div>
      </div>
      <div class="k" @click="toast('下设子部门：教学部的 初中部 / 高中部 / 大学部 + 就业部的 实训管理 / 就业管理')">
        <div class="n g">{{ overview?.stageTotal ?? '—' }}</div>
        <div class="l">下设子部门</div>
      </div>
      <div class="k" @click="toast('全部门职位均在此列表')">
        <div class="n p">{{ overview?.roleTotal ?? '—' }}</div>
        <div class="l">归属职位数</div>
      </div>
      <div class="k" @click="toast(`共 ${overview?.userTotal ?? 0} 个账号已归属部门`)">
        <div class="n w">{{ overview?.userTotal ?? '—' }}</div>
        <div class="l">归属账号数</div>
      </div>
    </div>

    <!-- ==================== 部门结构（原型第 2693~2720 行） ==================== -->
    <div class="card">
      <div class="card-h">
        <div class="t">
          <span class="bar"></span>部门结构 <span class="sub">用于职位归属与账号划分</span>
        </div>
        <div class="r">
          <!-- ★ 2026-10-19 按用户要求：主操作按钮统一成品牌红（与「新建职位」「新建账号」一致）——
               原来是普通白底按钮 class="btn"，与职位管理 / 账号管理的主按钮观感不一致。 -->
          <button class="btn pri" type="button" @click="openAdd">＋ 新建部门</button>
        </div>
      </div>
      <div class="card-b p0">
        <!-- ★ 2026-10-20 按用户反馈（截图框出「部门说明」右侧的大片空白）改列宽口径：
               原来只有「部门说明」是自适应列，其余 5 列写死 px（230/150/80/80/250），
               → 卡片宽出来多少全部砸到说明列上：卡片 1132px 时说明格 340px，
                 而实测文字只有 81~161px，右边挂着 180~260px 纯空白。
               现在 6 列全给百分比（合计 100%）+ table-layout:fixed，
               富余空间按比例摊到每一列，不再集中成「说明列右侧一个大洞」。
               百分比取值：名称 24 / 上级 12 / 说明 21 / 职位 10 / 账号 10 / 操作 23
               —— 名称要装得下「📂 部门名 + 含 N 个下级」标签，操作要装得下 4 个链接。
               另外外面套了 .tb-wrap（与职位管理 / 操作日志两张表一致）+
           CSS 里给本表 min-width:960px：视口窄到装不下 960 时改为横向滚动，
           而不是把「查看职位 / 查看账号 / 编辑 / 删除」挤断成两行。 -->
        <div class="tb-wrap">
        <table class="tb tb-dept">
          <thead>
            <tr>
              <th style="width: 24%">部门名称</th>
              <th style="width: 12%">上级部门</th>
              <th style="width: 21%">部门说明</th>
              <!-- ★ 2026-10-20 用户第二次反馈（截图框住「职位数 / 账号数」两列表头）：
                   「字段和下面对应的数字歪到姥姥家」—— 上一轮只给 <td> 加了居中，
                   表头还是左对齐 → 表头文字贴左、数字落在列中间，两行错开半个列宽。
                   现在表头也挂 num 类，表头与单元格走**同一条**对齐规则，
                   不会再出现「改了行没改头」的半套。 -->
              <th class="num" style="width: 10%">职位数</th>
              <th class="num" style="width: 10%">账号数</th>
              <th style="width: 23%">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="d in rows" :key="d.id">
              <!-- ★ 2026-10-19 按用户要求：原来这里在「含 N 个下级」下面还把下级部门名
                   一个个列了一遍（└ 初中部 / └ 高中部 / └ 大学部），可下面又有它们自己的
                   表格行 —— 同一批部门出现两遍，而且三个学段的行跟「市场咨询部 / 教学部」
                   平级，看不出谁从属于谁。现在改成：单元格里不再重复列下级，改为在
                   「部门名称」列按层级缩进（父级部门照旧带「含 N 个下级」标签）。
                   ⚠️ 三个学段仍保留自己的行 —— 它们是真部门（有职位 / 有账号），
                      行内的「查看职位 / 查看账号 / 编辑 / 删除」入口不能丢。 -->
              <td class="dept-name" :style="{ '--dept-indent': indentOf(d.id) }">
                <span v-if="depthOf(d.id) > 1" class="branch">{{ isLastSibling(d) ? '└' : '├' }}</span>
                <b>{{ childrenOf(d.id).length ? '📂' : '📁' }} {{ d.deptName }}</b>
                <span v-if="childrenOf(d.id).length" class="tag n" style="margin-left: 5px">含 {{ childrenOf(d.id).length }} 个下级</span>
              </td>
              <td>
                <span v-if="isSchoolParent(d.parentId || '')" class="tag n">校部</span>
                <template v-else>{{ nameOf(d.parentId || '') }}</template>
              </td>
              <td class="desc">{{ remarkOf(d.id) }}</td>
              <td class="num">
                <span class="lk" @click="openDeptRoles(d)">{{ d.roleCount || 0 }}</span>
              </td>
              <td class="num">
                <span class="lk" @click="openDeptUsers(d)">{{ d.userCount || 0 }}</span>
              </td>
              <td>
                <div class="acts">
                  <span class="lk" @click="openDeptRoles(d)">查看职位</span>
                  <span class="lk" @click="openDeptUsers(d)">查看账号</span>
                  <span class="lk" @click="openEdit(d)">编辑</span>
                  <span class="lk dg" @click="delDept(d)">删除</span>
                </div>
              </td>
            </tr>
            <tr v-if="!rows.length">
              <td colspan="6">
                <div class="empty">
                  <div class="ic">🏢</div>
                  {{ loading ? '加载中…' : '暂无部门数据' }}
                </div>
              </td>
            </tr>
          </tbody>
        </table>
        </div>
      </div>
    </div>

    <!-- ==================== 新建 / 编辑部门（原型 dlgDeptForm） ==================== -->
    <ProtoDialog v-model="formOpen" :title="formTitle" size="sm">
      <div class="fm" style="grid-template-columns: 1fr">
        <div class="f">
          <label>部门名称 <span class="req">*</span></label>
          <input v-model="form.deptName" class="inp" placeholder="如：就业部" />
        </div>
        <div class="f">
          <label>上级部门 <span class="req">*</span></label>
          <select v-model="form.parentId" class="inp">
            <option
              v-for="x in parentOptions"
              :key="x.id"
              :value="x.id"
              :disabled="x.deptLevel >= MAX_DEPT_LEVEL"
            >
              {{ x.deptName }}
            </option>
            <option :value="rootId">校级（顶级）</option>
          </select>
        </div>
        <div class="f">
          <label>部门说明</label>
          <textarea
            v-model="form.remark"
            class="inp"
            placeholder="简述部门职责与典型职位"
          ></textarea>
        </div>
      </div>
      <div class="notice i mt12">ℹ<div>部门用于职位归属与账号划分，删除前请确保无职位/账号关联。</div></div>
      <template #footer>
        <button class="btn" type="button" @click="formOpen = false">取消</button>
        <button class="btn pri" type="button" @click="submitDept">
          {{ form.id ? '保存' : '创建部门' }}
        </button>
      </template>
    </ProtoDialog>

    <!-- 校验未通过（原型 submitDept 里的 notice d 小弹窗） -->
    <ProtoDialog v-model="invalidOpen" title="校验未通过" size="sm">
      <div class="notice d">✕<div>请填写部门名称</div></div>
      <template #footer>
        <button class="btn pri" type="button" @click="invalidOpen = false">返回</button>
      </template>
    </ProtoDialog>

    <!-- ==================== 确认框（原型 confirmDlg） ==================== -->
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

    <!-- ==================== 部门下职位（原型 deptRoles） ==================== -->
    <ProtoDialog v-model="rolesOpen" :title="rolesTitle" size="md">
      <table v-if="deptRolesList.length" class="tb">
        <thead>
          <tr>
            <th>职位名称</th>
            <th>账号数</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in deptRolesList" :key="r.id">
            <td><b>👤 {{ r.roleName }}</b></td>
            <td class="num">{{ r.userCount }}</td>
            <td>
              <span class="lk" @click="openRolePerm(r, true)">看权限</span>
              <span class="sep">|</span>
              <span class="lk" @click="openRolePerm(r, false)">编辑权限</span>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">
        <div class="ic">🎭</div>
        {{ rolesLoading ? '加载中…' : '该部门下暂无职位' }}
      </div>
      <template #footer>
        <button class="btn" type="button" @click="rolesOpen = false">关闭</button>
      </template>
    </ProtoDialog>

    <!-- ==================== 部门下账号（原型 deptUsers） ==================== -->
    <ProtoDialog v-model="usersOpen" :title="usersTitle" size="lg">
      <table v-if="deptUsersList.length" class="tb">
        <thead>
          <tr>
            <th>姓名</th>
            <th>账号</th>
            <th>具体部门</th>
            <th>职位</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="u in deptUsersList" :key="u.id">
            <td><b>{{ u.userName }}</b></td>
            <td><code style="font-size: 11.5px">{{ u.account }}</code></td>
            <td>{{ u.deptName }}</td>
            <td>
              <span
                v-for="n in u.roleNames"
                :key="n"
                class="tag b"
                style="margin-right: 4px"
              >{{ n }}</span>
            </td>
            <td>
              <span v-if="isNormal(u.userStatus)" class="tag g">正常</span>
              <span v-else class="tag gy">{{ u.userStatus }}</span>
            </td>
            <td>
              <span class="lk" @click="openUserDetail(u)">详情</span>
              <span class="sep">|</span>
              <!-- ★ 2026-10-20：就地弹「编辑账号」，不再跳账号管理页 -->
              <span class="lk" @click="openUserEdit(u)">编辑</span>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">
        <div class="ic">👤</div>
        {{ usersLoading ? '加载中…' : '该部门下暂无账号' }}
      </div>
      <template #footer>
        <button class="btn" type="button" @click="usersOpen = false">关闭</button>
      </template>
    </ProtoDialog>

    <!-- ==================== 职位权限（看权限 / 编辑权限，就地弹窗） ==================== -->
    <PermTreeDialog
      v-model="permOpen"
      :title="permTitle"
      :modules="permModules"
      :perms="permPerms"
      :readonly="permReadonly"
      :subtitle="permRole ? roleIconOf(permRole) + ' ' + permRole.roleName : ''"
      @confirm="onRolePermConfirm"
    />

    <!-- ==================== 账号详情（就地弹窗，不跳账号管理） ==================== -->
    <!-- ★ 2026-10-19：底部「去编辑」按钮已删除（组件里已无此按钮，故也无 @edit 绑定）；
         本页改账号走「部门下账号」弹窗行操作里的「编辑」→ 就地弹 UserEditDialog。 -->
    <UserDetailDialog
      v-model="userDetailOpen"
      :user-id="userDetailId"
      :fallback="userDetailRow"
    />

    <!-- ==================== 编辑账号（就地弹窗，与账号管理同一份表单） ==================== -->
    <UserEditDialog
      v-model="userEditOpen"
      :user-id="userEditId"
      :fallback="userEditRow"
      @saved="onUserEdited"
    />
  </div>
</template>
