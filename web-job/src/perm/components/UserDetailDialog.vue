<script setup lang="ts">
/**
 * 账号详情弹窗（可复用）
 *
 * 【为什么抽成组件】
 *   「账号详情」有三处入口，原先只有账号管理里是对的，另外两处都只是 router.push
 *   跳回列表页、不打开详情：
 *     · 账号管理  · 列表 → 查看 / 点姓名
 *     · 部门管理  · 部门下账号弹窗 → 详情 / 编辑
 *     · 职位管理  · 查看职位下人员弹窗 → 账号详情
 *   抽出来之后三处共用同一个弹窗，内容一致（基本信息 + 所属职位 + 有效权限明细），
 *   以后再改「详情里该显示什么」只改这一处。
 *
 * 【自取数据】调用方只要给 userId（可选再给一行列表数据做首屏秒开）：
 *   detail + 权限模块树 + 各职位权限映射 全在本组件内拉取。
 *
 * ⚠️ 「查看权限 / 编辑权限」不再跳「职位权限分配」页（跳过去还不知道要点哪个职位），
 *    直接在本弹窗之上叠一层权限树弹窗（PermTreeDialog），就地看 / 就地改。
 *
 * ★ 2026-10-19 起：底部「去编辑」按钮已**彻底删除**（用户最终要求：不要这个按钮）。
 *   删之前它是可关的，三处入口按三轮要求逐个关掉 ——
 *     · 账号管理：列表行操作里本来就有独立的「编辑」，底部再来一个是重复入口；
 *     · 职位管理：「职位下人员」弹窗也一并去掉；
 *     · 部门管理：最后一处，用户第三轮要求删除。
 *   三处都关了之后开关本身成了死代码，遂连同 prop / emit 一起删掉，
 *   底部只剩「关闭」。
 *
 *   ⚠️ 想改账号，走各页列表行操作的「编辑」：
 *     · 账号管理、部门管理（部门下账号弹窗）都有行级「编辑」；
 *     · 职位管理的「职位下人员」弹窗没有行级编辑，要改得回「账号管理」。
 */
import { computed, ref, watch } from 'vue';
import type { PermModule, PermRoleListItem, PermUserListItem, RolePermMap } from 'shared-types/perm';
import ProtoDialog from './ProtoDialog.vue';
import PermTreeDialog from './PermTreeDialog.vue';
import { roleApi, userApi, assignApi, menuApi } from '@/perm/api/perm';
import { roleIconOf } from '@/perm/utils/roleIcon';
import { toast } from '@/perm/utils/toast';

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    /** 要展示的账号 id（'' 时不请求） */
    userId: string;
    /** 列表行数据：先渲染、再补最新（可选） */
    fallback?: PermUserListItem | null;
  }>(),
  { fallback: null },
);

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
}>();

/* ============================================================
 * 模块级缓存：职位清单 / 权限模块树 ── 同一会话内只拉一次
 * ============================================================ */

let rolesCache: PermRoleListItem[] | null = null;
let modulesCache: PermModule[] | null = null;

async function loadRoles(): Promise<PermRoleListItem[]> {
  if (rolesCache) return rolesCache;
  try {
    const page = await roleApi.list({ page: 1, size: 100 });
    rolesCache = page.list || [];
  } catch {
    rolesCache = [];
  }
  return rolesCache;
}

async function loadModules(): Promise<PermModule[]> {
  if (modulesCache) return modulesCache;
  try {
    modulesCache = await menuApi.tree();
  } catch {
    modulesCache = [];
  }
  return modulesCache;
}

/* ============================================================
 * 小工具
 * ============================================================ */

/** 极简 HTML 转义（标题走 v-html，姓名是用户输入） */
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

/** 权限映射 key（与后端 perm.service.permKey 完全一致） */
const permKey = (moduleKey: string, itemName: string): string => `${moduleKey}||${itemName}`;

const roleIcon = roleIconOf;

/* ============================================================
 * 主状态
 * ============================================================ */

const visible = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit('update:modelValue', v),
});

const detail = ref<PermUserListItem | null>(null);
const detailLoading = ref(false);
const permLoading = ref(false);
const allRoles = ref<PermRoleListItem[]>([]);
const modules = ref<PermModule[]>([]);

/** 职位 id → 该职位权限映射（按需拉、拉过就缓存） */
const rolePerms = ref<Record<string, RolePermMap>>({});

const detailTitle = computed(() => {
  const d = detail.value;
  if (!d) return '账号详情';
  return `账号详情 · <span class="em">${esc(d.userName)}</span> <span class="tag n">${esc(String(d.userStatus))}</span>`;
});

/** 所属职位：元数据优先取职位清单（含权限数 / 状态） */
interface DetailRole {
  id: string;
  roleName: string;
  permCount: number;
  roleStatus: string;
  icon: string;
}

const detailRoles = computed<DetailRole[]>(() => {
  const d = detail.value;
  if (!d) return [];
  return (d.roleIds || []).map((id, i) => {
    const r = allRoles.value.find((x) => x.id === id);
    if (r) {
      return {
        id,
        roleName: r.roleName,
        permCount: r.permCount,
        roleStatus: r.roleStatus,
        icon: roleIcon(r),
      };
    }
    return {
      id,
      roleName: (d.roleNames || [])[i] || '—',
      permCount: 0,
      roleStatus: '启用',
      icon: '👤',
    };
  });
});

/** 多职位权限并集 */
function mergedMap(ids: string[]): RolePermMap {
  const out: RolePermMap = {};
  (ids || []).forEach((id) => {
    const m = rolePerms.value[id];
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

interface CardRow {
  name: string;
  actions: string[];
}
interface ModuleCard {
  key: string;
  icon: string;
  name: string;
  rows: CardRow[];
  total: number;
}

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

/** 详情卡片上的「有效权限动作」总数（并集去重后的动作数） */
const effectivePermCount = computed(() => actionCount(mergedMap(detail.value?.roleIds || [])));

const detailCards = computed<ModuleCard[]>(() =>
  detail.value ? moduleCards(mergedMap(detail.value.roleIds)) : [],
);

/** 确保这些职位的权限映射已在本地 */
async function ensureRolePerms(ids: string[]): Promise<void> {
  const missing = (ids || []).filter((id) => !rolePerms.value[id]);
  if (!missing.length) return;
  await Promise.all(
    missing.map(async (id) => {
      try {
        const d = await roleApi.detail(id);
        rolePerms.value[id] = d.perms || {};
      } catch {
        rolePerms.value[id] = {};
      }
    }),
  );
}

/** 拉详情（userId 变化 / 弹窗打开时） */
async function loadDetail(id: string): Promise<void> {
  if (!id) return;
  detailLoading.value = true;
  permLoading.value = true;
  try {
    let cur: PermUserListItem | null = props.fallback && props.fallback.id === id ? props.fallback : null;
    detail.value = cur;

    const [d, rs, ms] = await Promise.all([userApi.detail(id), loadRoles(), loadModules()]);
    allRoles.value = rs;
    modules.value = ms;
    // ⚠️ /user/detail 实际返回「列表项形态」（带 avatarText / effectivePermCount 等），
    //    但契约只声明了 PermUser + roleIds/roleNames —— 与列表行合并，两边都不丢。
    cur = { ...(cur || {}), ...d } as PermUserListItem;
    detail.value = cur;

    await ensureRolePerms(cur.roleIds || []);
  } catch {
    /* 已提示，沿用 fallback */
  } finally {
    detailLoading.value = false;
    permLoading.value = false;
  }
}

watch(
  () => [props.modelValue, props.userId] as const,
  ([on, id]) => {
    if (!on) return;
    detail.value = props.fallback && props.fallback.id === id ? props.fallback : null;
    void loadDetail(String(id || ''));
  },
  { immediate: true },
);

/* ============================================================
 * 「查看权限 / 编辑权限」→ 就地叠一层权限树弹窗（不跳页）
 * ============================================================ */

const treeOpen = ref(false);
const treeReadonly = ref(true);
const treeRole = ref<DetailRole | null>(null);
const treePerms = ref<RolePermMap>({});
const treeLoading = ref(false);

/** ⚠️ PermTreeDialog 内部是 el-dialog，`title` 按纯文本渲染（不走 v-html），别塞 HTML */
const treeTitle = computed(() => {
  const r = treeRole.value;
  if (!r) return '配置权限';
  return `${treeReadonly.value ? '查看权限' : '编辑权限'} · ${r.roleName}`;
});

async function openRolePerm(r: DetailRole, readonly: boolean): Promise<void> {
  treeRole.value = r;
  treeReadonly.value = readonly;
  treePerms.value = {};
  treeOpen.value = true;
  treeLoading.value = true;
  try {
    const d = await assignApi.tree(r.id);
    treePerms.value = d.perms || {};
    if (!modules.value.length) modules.value = d.modules || [];
  } catch {
    /* 已提示 */
  } finally {
    treeLoading.value = false;
  }
}

async function onTreeConfirm(perms: RolePermMap): Promise<void> {
  const r = treeRole.value;
  if (!r) return;
  try {
    const res = await assignApi.save(r.id, perms);
    toast(`「${r.roleName}」权限已保存，共 ${res.permCount} 项`, 'ok');    rolePerms.value[r.id] = { ...perms }; // 让上层「有效权限明细」立刻跟着变
    await loadDetail(props.userId);
  } catch {
    /* 已提示 */
  }
}
</script>

<template>
  <ProtoDialog v-model="visible" :title="detailTitle" size="lg">
    <template v-if="detail">
      <!-- 头部 -->
      <div class="flex" style="gap: 13px; align-items: flex-start; margin-bottom: 14px">
        <div
          style="
            width: 54px;
            height: 54px;
            border-radius: 13px;
            background: linear-gradient(135deg, #E6A99C, #CD3A33);
            color: #fff;
            display: grid;
            place-items: center;
            font-size: 22px;
            font-weight: 600;
            flex: 0 0 auto;
          "
        >
          {{ detail.avatarText || (detail.userName || '').slice(0, 1) }}
        </div>
        <div style="flex: 1">
          <div style="font-size: 16px; font-weight: 600">
            {{ detail.userName }}
            <span v-if="detail.userStatus === '正常'" class="tag g">正常</span>
            <span v-else-if="detail.userStatus === '已停用'" class="tag gy">已停用</span>
            <span v-else class="tag d">{{ detail.userStatus }}</span>
            <span v-if="detail.needChangePwd" class="tag w">需首次改密</span>
          </div>
          <div class="desc" style="margin-top: 3px">
            {{ detail.deptName }} · {{ (detail.roleNames || []).join('、') || '无职位' }}
          </div>
        </div>
        <div style="text-align: right; flex: 0 0 auto">
          <div style="font-size: 20px; font-weight: 700; color: var(--brand)">
            {{ effectivePermCount }}
          </div>
          <div class="desc">有效权限动作</div>
        </div>
      </div>

      <!-- 基本信息 -->
      <div class="sec-t"><span class="bar"></span>基本信息</div>
      <div class="fm" style="grid-template-columns: repeat(3, 1fr)">
        <div class="f"><label>姓名</label><div>{{ detail.userName }}</div></div>
        <div class="f"><label>性别</label><div>{{ detail.genderName || '—' }}</div></div>
        <div class="f"><label>年龄</label><div class="num">{{ detail.age || '—' }}</div></div>
        <div class="f">
          <label>登录账号</label>
          <div>
            <code style="background: #FBF7F4; padding: 2px 7px; border-radius: 4px">{{ detail.account }}</code>
          </div>
        </div>
        <div class="f"><label>手机号</label><div class="num">{{ detail.phone }}</div></div>
        <div class="f"><label>所属部门</label><div>{{ detail.deptName }}</div></div>
        <div class="f"><label>账号状态</label><div>{{ detail.userStatus }}</div></div>
        <div class="f"><label>创建人</label><div>{{ detail.createBy || '—' }}</div></div>
        <div class="f"><label>创建时间</label><div class="desc num">{{ detail.createTime }}</div></div>
        <div class="f"><label>最后登录</label><div class="desc num">{{ detail.lastLoginTime || '—' }}</div></div>
        <div class="f">
          <label>需首次改密</label>
          <div>{{ detail.needChangePwd ? '是' : '否' }}</div>
        </div>
      </div>

      <!-- 所属职位 -->
      <div class="divider"></div>
      <div class="sec-t">
        <span class="bar"></span>所属职位 <span class="desc">（可多职位，权限取并集；可就地查看 / 编辑该职位权限）</span>
      </div>
      <table v-if="detailRoles.length" class="tb">
        <thead>
          <tr>
            <th>职位</th>
            <th>权限数</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in detailRoles" :key="r.id">
            <td><b>{{ r.icon }} {{ r.roleName }}</b></td>
            <td class="num">{{ r.permCount }} 项</td>
            <td>
              <span v-if="r.roleStatus === '启用'" class="tag g">启用</span>
              <span v-else class="tag gy">停用</span>
            </td>
            <td>
              <span class="lk" @click="openRolePerm(r, true)">查看权限</span>
              <span class="sep">|</span>
              <span class="lk" @click="openRolePerm(r, false)">编辑权限</span>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-else class="notice d">✕<div>该账号未分配任何职位，无法登录系统。</div></div>

      <!-- 有效权限明细 -->
      <div class="divider"></div>
      <div class="sec-t"><span class="bar"></span>有效权限明细（合并结果）</div>
      <div v-if="permLoading || detailLoading" class="empty"><div class="ic">⏳</div>正在计算权限并集…</div>
      <div
        v-else
        style="display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 8px"
      >
        <div
          v-for="m in detailCards"
          :key="m.key"
          style="border: 1px solid var(--line); border-radius: 8px; padding: 9px 11px"
        >
          <div style="font-size: 12.5px; font-weight: 600; margin-bottom: 4px">
            {{ m.icon }} {{ m.name }} <span class="desc">{{ m.rows.length }}/{{ m.total }}</span>
          </div>
          <template v-if="m.rows.length">
            <div
              v-for="r in m.rows"
              :key="r.name"
              style="font-size: 11.5px; color: var(--tx2); margin-bottom: 3px"
            >
              <b style="color: var(--tx)">{{ r.name }}</b>：<span
                v-for="a in r.actions"
                :key="a"
                class="tag b"
                style="margin-right: 2px"
              >{{ a }}</span>
            </div>
          </template>
          <div v-else class="desc">❌ 无权限</div>
        </div>
      </div>
    </template>

    <div v-else class="empty"><div class="ic">⏳</div>加载中…</div>

    <template #footer>
      <div class="lft">账号 ID：{{ detail?.id || '—' }}</div>
      <!-- ★ 2026-10-19：底部「去编辑」按钮已彻底删除（三处入口全部要求去掉），
           只剩「关闭」。改账号请走列表行操作里的「编辑」。 -->
      <button class="btn pri" type="button" @click="visible = false">关闭</button>
    </template>
  </ProtoDialog>

  <!-- ★ 叠在详情之上：查看 / 编辑某个职位的权限，不跳页 -->
  <PermTreeDialog
    v-model="treeOpen"
    :title="treeTitle"
    :modules="modules"
    :perms="treePerms"
    :readonly="treeReadonly"
    :subtitle="treeRole ? treeRole.icon + ' ' + treeRole.roleName : ''"
    @confirm="onTreeConfirm"
  />
</template>
