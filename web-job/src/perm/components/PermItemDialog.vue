<script setup lang="ts">
/**
 * 新增 / 管理权限点（★ 2026-10-19 新增）
 *
 * ============================================================
 * 【为什么有这个弹窗】
 *   系统的权限树是「预置能力清单」（8 个板块 / 55 个功能点），
 *   而新加的部门与职位（招生部 · 招生老师）往往需要清单里没有的功能点。
 *   过去只能改 SQL；现在管理员在这里自己加 —— 加完的权限点
 *   **格式与预置完全一致**（板块 → 功能点 → 动作），
 *   存完立刻出现在「职位权限分配」的权限树里，可以勾给任意职位。
 *
 * 【三件事】
 *   ① 左侧：全部功能点（按板块分组），可搜索；预置项能看不能改
 *   ② 右侧：新增 / 修改表单 —— 板块（可选已有或新建）、功能点、动作、备注
 *   ③ 删除：只允许删自建项；删前提示「已有几个职位勾选了它」
 *
 * 【两条硬规则（照做，别绕开）】
 *   · 预置权限点只读：业务代码里写死了 `模块:功能点:动作码` 的判权串，
 *     改预置项的名字 / 动作 = 对应按钮直接失效。
 *   · 动作编码（actionCode）是机器判权用的，只能用字母/数字/下划线；
 *     留空时后端按「动作基类」自动补（查看→view、新建→add…）。
 * ============================================================
 */
import { computed, ref, watch } from 'vue';
import type { PermItemSavePayload, PermMenuItemAdmin } from 'shared-types/perm';
import { menuApi } from '@/perm/api/perm';
import ProtoDialog from '@/perm/components/ProtoDialog.vue';
import ProtoConfirm from '@/perm/components/ProtoConfirm.vue';
import { toast } from '@/perm/utils/toast';

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    /** 打开时默认选中的板块（可选，一般传当前职位最常用的板块） */
    defaultModuleKey?: string;
  }>(),
  { defaultModuleKey: '' },
);

const emit = defineEmits<{
  'update:modelValue': [boolean];
  /** 保存 / 删除成功后通知父级刷新权限树 */
  saved: [];
}>();

const dlgOpen = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit('update:modelValue', v),
});

/* ============================================================
 * 1. 动作基类（与 shared-types 的 PermBaseAction 一一对应）
 * ============================================================ */

const BASE_ACTIONS = [
  { value: 1, code: 'view', name: '查看' },
  { value: 2, code: 'add', name: '新建' },
  { value: 3, code: 'edit', name: '编辑' },
  { value: 4, code: 'del', name: '删除' },
  { value: 5, code: 'agree', name: '审批' },
  { value: 6, code: 'export', name: '导出' },
];
const baseName = (v: number): string => BASE_ACTIONS.find((b) => b.value === v)?.name || '查看';

/* ============================================================
 * 2. 状态
 * ============================================================ */

const loading = ref(false);
const saving = ref(false);
const items = ref<PermMenuItemAdmin[]>([]);

/** 左侧筛选 */
const keyword = ref('');
const onlyCustom = ref(false);

/** 新建板块的哨兵值（与后端约定一致） */
const NEW_MODULE = '__new__';

interface ActionRow {
  actionCode: string;
  actionName: string;
  baseAction: number;
}

const blankAction = (base = 1): ActionRow => ({
  actionCode: BASE_ACTIONS.find((b) => b.value === base)?.code || '',
  actionName: BASE_ACTIONS.find((b) => b.value === base)?.name || '',
  baseAction: base,
});

const form = ref({
  id: '',
  moduleKey: '',
  moduleName: '',
  moduleIcon: '🗂️',
  itemName: '',
  parentItemName: '',
  remark: '',
  actions: [blankAction(1)] as ActionRow[],
});

const isNewModule = computed(() => form.value.moduleKey === NEW_MODULE);
const editingPreset = ref(false);
const current = computed<PermMenuItemAdmin | null>(
  () => items.value.find((x) => x.id === form.value.id) || null,
);

/* ============================================================
 * 3. 数据加载
 * ============================================================ */

/** 板块清单（从功能点里归纳，按 moduleSort 排） */
const modules = computed(() => {
  const map = new Map<string, { moduleKey: string; moduleName: string; moduleIcon: string; sort: number }>();
  items.value.forEach((it) => {
    if (!map.has(it.moduleKey)) {
      map.set(it.moduleKey, {
        moduleKey: it.moduleKey,
        moduleName: it.moduleName,
        moduleIcon: it.moduleIcon,
        sort: it.moduleSort,
      });
    }
  });
  return Array.from(map.values()).sort((a, b) => a.sort - b.sort);
});

/** 左侧列表：搜索 + 只看自建 + 按板块分组 */
const groups = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  const list = items.value.filter((it) => {
    if (onlyCustom.value && !it.isCustom) return false;
    if (!kw) return true;
    return (
      it.itemName.toLowerCase().includes(kw) ||
      it.moduleName.toLowerCase().includes(kw) ||
      it.actions.some((a) => a.actionName.toLowerCase().includes(kw))
    );
  });
  const order = modules.value.map((m) => m.moduleKey);
  const map = new Map<string, PermMenuItemAdmin[]>();
  list.forEach((it) => {
    const arr = map.get(it.moduleKey) || [];
    arr.push(it);
    map.set(it.moduleKey, arr);
  });
  return order
    .filter((k) => map.has(k))
    .map((k) => {
      const m = modules.value.find((x) => x.moduleKey === k)!;
      return { moduleKey: k, moduleName: m.moduleName, moduleIcon: m.moduleIcon, items: map.get(k) || [] };
    });
});

const customCount = computed(() => items.value.filter((x) => x.isCustom).length);

async function loadItems(): Promise<void> {
  loading.value = true;
  try {
    items.value = await menuApi.items();
  } catch {
    /* 错误提示由 @/perm/api/request 统一弹出 */
  } finally {
    loading.value = false;
  }
}

/* ============================================================
 * 4. 表单：新建 / 选中 / 编辑
 * ============================================================ */

function resetForm(moduleKey?: string): void {
  editingPreset.value = false;
  const fallback = moduleKey || props.defaultModuleKey || modules.value[0]?.moduleKey || NEW_MODULE;
  form.value = {
    id: '',
    moduleKey: modules.value.some((m) => m.moduleKey === fallback) ? fallback : NEW_MODULE,
    moduleName: '',
    moduleIcon: '🗂️',
    itemName: '',
    parentItemName: '',
    remark: '',
    actions: [blankAction(1)],
  };
}

function selectItem(it: PermMenuItemAdmin): void {
  editingPreset.value = !it.isCustom;
  form.value = {
    id: it.id,
    moduleKey: it.moduleKey,
    moduleName: '',
    moduleIcon: it.moduleIcon,
    itemName: it.itemName,
    parentItemName: it.parentItemName || '',
    remark: it.remark || '',
    actions: it.actions.map((a) => ({
      actionCode: a.actionCode,
      actionName: a.actionName,
      baseAction: Number(a.baseAction) || 1,
    })),
  };
}

/** 当前板块下可选的「上级功能点」（做二级功能点用；不含自己） */
const parentOptions = computed(() => {
  if (!form.value.moduleKey || form.value.moduleKey === NEW_MODULE) return [];
  return items.value.filter(
    (it) => it.moduleKey === form.value.moduleKey && !it.parentItemName && it.id !== form.value.id,
  );
});

/* ============================================================
 * 5. 动作行
 * ============================================================ */

function addBaseAction(base: number): void {
  if (editingPreset.value) return;
  const exists = form.value.actions.some((a) => a.actionCode === BASE_ACTIONS.find((b) => b.value === base)?.code);
  if (exists) {
    toast(`「${baseName(base)}」已经在动作列表里了`, 'warn');
    return;
  }
  form.value.actions.push(blankAction(base));
}

function addCustomAction(): void {
  if (editingPreset.value) return;
  form.value.actions.push({ actionCode: '', actionName: '', baseAction: BASE_ACTIONS[0].value });
}

function removeAction(i: number): void {
  if (editingPreset.value) return;
  form.value.actions.splice(i, 1);
}

/* ============================================================
 * 6. 保存 / 删除
 * ============================================================ */

const invalidOpen = ref(false);
const invalidList = ref<string[]>([]);

function validate(): boolean {
  const errs: string[] = [];
  if (!String(form.value.itemName || '').trim()) errs.push('请填写功能点名称');
  if (isNewModule.value) {
    if (!String(form.value.moduleName || '').trim()) errs.push('新建板块时请填写板块名称');
    const key = String(form.value.moduleKey || '');
    if (key && key !== NEW_MODULE && !/^[a-z][a-z0-9_]{1,31}$/.test(key)) {
      errs.push('板块标识只能用「小写字母开头 + 小写字母/数字/下划线」');
    }
  }
  if (!form.value.actions.length) errs.push('请至少添加一个动作');
  form.value.actions.forEach((a, i) => {
    if (!String(a.actionName || '').trim()) errs.push(`第 ${i + 1} 个动作没填名称`);
    if (a.actionCode && !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(a.actionCode)) {
      errs.push(`第 ${i + 1} 个动作编码「${a.actionCode}」不合法（字母开头，只含字母/数字/下划线）`);
    }
  });
  // 同一功能点内编码不能重复
  const codes = form.value.actions.map((a) => a.actionCode).filter(Boolean);
  if (new Set(codes).size !== codes.length) errs.push('动作编码不能重复');
  invalidList.value = errs;
  if (errs.length) {
    invalidOpen.value = true;
    return false;
  }
  return true;
}

function payload(): PermItemSavePayload {
  return {
    id: form.value.id || undefined,
    moduleKey: form.value.moduleKey,
    moduleName: isNewModule.value ? form.value.moduleName.trim() : undefined,
    moduleIcon: form.value.moduleIcon || '🗂️',
    itemName: form.value.itemName.trim(),
    parentItemName: form.value.parentItemName || null,
    remark: form.value.remark.trim() || undefined,
    actions: form.value.actions.map((a) => ({
      actionCode: a.actionCode.trim() || undefined,
      actionName: a.actionName.trim(),
      baseAction: Number(a.baseAction) || 1,
    })),
  };
}

async function save(): Promise<void> {
  if (editingPreset.value) {
    toast('系统预置权限点只读，不可修改；如需扩展请新增一条自建权限点', 'warn');
    return;
  }
  if (!validate()) return;
  saving.value = true;
  try {
    const res = form.value.id
      ? await menuApi.updateItem({ ...payload(), id: form.value.id })
      : await menuApi.addItem(payload());
    await loadItems();
    const saved = items.value.find((x) => x.id === res.id);
    if (saved) selectItem(saved);
    toast(
      res.created
        ? `已新增「${res.itemName}」（${res.actionCount} 个动作），可在权限树里勾选`
        : `已保存「${res.itemName}」的修改`,
    );
    emit('saved');
  } catch {
    /* 已提示 */
  } finally {
    saving.value = false;
  }
}

const deleteOpen = ref(false);

const deleteDetail = computed(() => {
  const it = current.value;
  if (!it) return [];
  return [
    { k: '权限点', v: `<b>${it.itemName}</b>（${it.moduleName}）` },
    { k: '动作', v: `${it.actions.length} 个` },
    {
      k: '已被勾选',
      v: it.grantedRoleCount
        ? `<b style="color:#B22A23">${it.grantedRoleCount}</b> 个职位（删除后这些授权一并收回）`
        : '暂无职位勾选',
    },
  ];
});

async function doDelete(): Promise<void> {
  const it = current.value;
  if (!it) return;
  deleteOpen.value = false;
  saving.value = true;
  try {
    const res = await menuApi.removeItem(it.id);
    await loadItems();
    resetForm(it.moduleKey);
    toast(
      res.affectedRoles
        ? `已删除「${res.itemName}」，并收回 ${res.affectedRoles} 个职位的授权`
        : `已删除「${res.itemName}」`,
    );
    emit('saved');
  } catch {
    /* 已提示 */
  } finally {
    saving.value = false;
  }
}

/* ---- 打开时拉一次最新清单 ---- */
watch(
  () => props.modelValue,
  (on) => {
    if (!on) return;
    keyword.value = '';
    onlyCustom.value = false;
    void loadItems().then(() => resetForm());
  },
  { immediate: true },
);
</script>

<template>
  <ProtoDialog
    v-model="dlgOpen"
    title='新增 / 管理权限 <span class="tag n">格式与系统预置权限一致：板块 → 功能点 → 动作</span>'
    size="xl"
  >
    <div class="notice i mb12">
      ℹ
      <div>
        在这里加的权限点会出现在「职位权限分配」的权限树里，<b>可以直接勾选给任意职位</b>（如招生老师）。
        预置权限点是系统能力清单，<b>只读</b>；要扩展请在预置项旁边新建一条，不要改预置项。
      </div>
    </div>

    <div class="pi-split">
      <!-- ---------- 左：已有权限点 ---------- -->
      <div class="pi-lft">
        <div class="pi-lh">
          <input v-model="keyword" class="inp pi-search" placeholder="搜功能点 / 动作" />
          <label class="pi-filter">
            <input v-model="onlyCustom" type="checkbox" />只看自建
          </label>
        </div>

        <div v-if="loading" class="empty" style="padding: 30px 0">
          <div class="ic">⏳</div>
          加载中…
        </div>
        <div v-else-if="!groups.length" class="empty" style="padding: 30px 0">
          <div class="ic">🔍</div>
          没有匹配的功能点
        </div>
        <div v-else class="pi-list">
          <div v-for="g in groups" :key="g.moduleKey" class="pi-grp">
            <div class="pi-gh">
              <span>{{ g.moduleIcon }} {{ g.moduleName }}</span>
              <span class="cnt">{{ g.items.length }}</span>
            </div>
            <div
              v-for="it in g.items"
              :key="it.id"
              class="pi-item"
              :class="{ on: it.id === form.id }"
              @click="selectItem(it)"
            >
              <span class="nm" :title="it.itemName">{{ it.itemName }}</span>
              <span v-if="it.isCustom" class="tag b" style="flex: none">自建</span>
              <span class="cnt" :title="`${it.grantedRoleCount} 个职位已勾选`">
                {{ it.actions.length }}
              </span>
            </div>
          </div>
        </div>

        <div class="pi-lf">
          共 {{ items.length }} 个功能点 · 自建 {{ customCount }} 个
        </div>
      </div>

      <!-- ---------- 右：表单 ---------- -->
      <div class="pi-rgt">
        <div class="pi-rh">
          <b>{{ editingPreset ? '查看预置权限点' : form.id ? '修改权限点' : '新增权限点' }}</b>
          <span v-if="editingPreset" class="tag p">预置 · 只读</span>
          <span v-else-if="form.id" class="tag g">自建 · 可改</span>
          <!-- ★ 2026-10-20 按用户要求删掉这里的「＋ 新建权限」按钮。
               新建仍然可用：本弹窗每次打开都会 resetForm() 进「新增权限点」模式，
               想再加一条，关掉弹窗从页面上的入口重新打开即可。 -->
        </div>

        <div v-if="editingPreset" class="notice w mb12">
          ⚠
          <div>
            「{{ form.itemName }}」是系统预置权限点，<b>不可修改</b>（业务代码按它的名字与动作判权）。
            如需扩展，请关闭本弹窗、从页面上的「＋ 新增权限」重新打开，新增一条自建权限点，不要改预置项。
          </div>
        </div>

        <div class="fm">
          <div class="f">
            <label>所属板块 <span class="req">*</span></label>
            <select v-model="form.moduleKey" class="inp" :disabled="editingPreset">
              <option v-for="m in modules" :key="m.moduleKey" :value="m.moduleKey">
                {{ m.moduleIcon }} {{ m.moduleName }}
              </option>
              <option :value="NEW_MODULE">＋ 新建板块…</option>
            </select>
            <span class="hint">新部门（如招生部）可以选已有板块，也可以新建一个专属板块</span>
          </div>

          <div class="f">
            <label>功能点名称 <span class="req">*</span></label>
            <input
              v-model="form.itemName"
              class="inp"
              :disabled="editingPreset"
              placeholder="如：招生报名登记"
              maxlength="64"
            />
            <span class="hint">就是权限树里那一行的名字，建议用「做什么」命名</span>
          </div>
        </div>

        <!-- 新建板块 -->
        <div v-if="isNewModule && !editingPreset" class="pi-newmod">
          <div class="fm">
            <div class="f">
              <label>板块名称 <span class="req">*</span></label>
              <input v-model="form.moduleName" class="inp" placeholder="如：招生管理" maxlength="32" />
            </div>
            <div class="f">
              <label>板块图标</label>
              <input v-model="form.moduleIcon" class="inp" placeholder="🗂️" maxlength="4" />
            </div>
          </div>
        </div>

        <div class="fm" style="margin-top: 12px">
          <div class="f">
            <label>上级功能点（可选）</label>
            <select v-model="form.parentItemName" class="inp" :disabled="editingPreset || isNewModule">
              <option value="">无（一级功能点）</option>
              <option v-for="p in parentOptions" :key="p.id" :value="p.itemName">{{ p.itemName }}</option>
            </select>
          </div>
          <div class="f">
            <label>备注</label>
            <input v-model="form.remark" class="inp" :disabled="editingPreset" placeholder="谁会用到、边界在哪" maxlength="80" />
          </div>
        </div>

        <!-- 动作 -->
        <div class="pi-sec">
          <div class="pi-sh">
            <b>动作</b>
            <span class="desc">权限只配到「动作」这一层；勾选时就是一个动作一个开关</span>
          </div>

          <div v-if="!editingPreset" class="pi-quick">
            <span class="desc">快速添加：</span>
            <button
              v-for="b in BASE_ACTIONS"
              :key="b.value"
              class="btn xs"
              type="button"
              @click="addBaseAction(b.value)"
            >
              ＋ {{ b.name }}
            </button>
            <button class="btn xs" type="button" @click="addCustomAction">＋ 自定义动作</button>
          </div>

          <table class="tb pi-tb">
            <thead>
              <tr>
                <th style="width: 34%">动作名称</th>
                <th style="width: 26%">动作编码</th>
                <th style="width: 22%">动作基类</th>
                <th style="width: 60px"></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(a, i) in form.actions" :key="i">
                <td>
                  <input v-model="a.actionName" class="inp" :disabled="editingPreset" placeholder="如：查看" maxlength="32" />
                </td>
                <td>
                  <input
                    v-model="a.actionCode"
                    class="inp"
                    :disabled="editingPreset"
                    :placeholder="baseName(a.baseAction) === '查看' ? 'view' : '留空自动生成'"
                    maxlength="64"
                  />
                </td>
                <td>
                  <select v-model.number="a.baseAction" class="inp" :disabled="editingPreset">
                    <option v-for="b in BASE_ACTIONS" :key="b.value" :value="b.value">{{ b.name }}</option>
                  </select>
                </td>
                <td style="text-align: right">
                  <span v-if="!editingPreset" class="lk wn" @click="removeAction(i)">删除</span>
                </td>
              </tr>
              <tr v-if="!form.actions.length">
                <td colspan="4">
                  <span class="desc">还没有动作 —— 点上面的「快速添加」加一个，如「查看」。</span>
                </td>
              </tr>
            </tbody>
          </table>

          <div class="desc" style="margin-top: 7px">
            ※ 动作编码是<b>机器判权</b>用的（业务代码里写 <span class="mono">模块:功能点:动作编码</span>），
            留空时按基类自动补：查看→view、新建→add、编辑→edit、删除→del、审批→agree、导出→export。
          </div>
        </div>
      </div>
    </div>

    <template #footer>
      <div class="lft">
        <span v-if="current && current.grantedRoleCount">
          该权限点已被 <b>{{ current.grantedRoleCount }}</b> 个职位勾选
        </span>
        <span v-else>保存后可在左侧权限树里勾选分配</span>
      </div>
      <button
        v-if="form.id && !editingPreset"
        class="btn dg"
        type="button"
        :disabled="saving"
        @click="deleteOpen = true"
      >
        删除该权限点
      </button>
      <button class="btn" type="button" @click="dlgOpen = false">关闭</button>
      <button
        class="btn pri"
        type="button"
        :disabled="saving || editingPreset"
        @click="save"
      >
        {{ form.id ? '保存修改' : '保存权限' }}
      </button>
    </template>
  </ProtoDialog>

  <!-- 校验未通过 -->
  <ProtoDialog v-model="invalidOpen" title="校验未通过" size="sm">
    <div class="notice d mb12">✕<div>以下内容需要修正：</div></div>
    <ul style="padding-left: 20px; font-size: 12.5px; line-height: 1.9">
      <li v-for="(e, i) in invalidList" :key="i">{{ e }}</li>
    </ul>
    <template #footer>
      <button class="btn pri" type="button" @click="invalidOpen = false">返回修改</button>
    </template>
  </ProtoDialog>

  <!-- 删除确认 -->
  <ProtoConfirm
    v-model="deleteOpen"
    title="删除权限点"
    icon="🗑"
    icon-bg="#FDF4F2"
    :msg="`确认删除「${current?.itemName || ''}」？`"
    :detail="deleteDetail"
    warn="删除后该权限点从权限树消失，已勾选它的职位会同时失去这些动作，且无法撤销。"
    ok-text="确认删除"
    ok-class="dg"
    @ok="doDelete"
  />
</template>

<style scoped>
.pi-split {
  display: flex;
  align-items: stretch;
  gap: 14px;
  min-height: 380px;
}
.pi-lft {
  width: 268px;
  flex: none;
  display: flex;
  flex-direction: column;
  border: 1px solid #EFE7E2;
  border-radius: 9px;
  background: #FBF8F5;
  min-width: 0;
  max-height: 520px;
}
.pi-lh {
  padding: 9px 9px 7px;
  border-bottom: 1px solid #F1EAE5;
  display: flex;
  flex-direction: column;
  gap: 7px;
  flex: none;
}
.pi-search {
  width: 100%;
  padding-left: 11px;
  background-image: none;
}
.pi-filter {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
  color: #7A6C67;
  cursor: pointer;
}
.pi-filter input {
  accent-color: #CD3A33;
  width: 13px;
  height: 13px;
  cursor: pointer;
}
.pi-list {
  flex: 1;
  overflow: auto;
  padding: 5px 6px;
  min-height: 0;
}
.pi-grp {
  margin-bottom: 5px;
}
.pi-gh {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 6px;
  font-size: 11px;
  font-weight: 600;
  color: #9C8D88;
  letter-spacing: 0.3px;
}
.pi-gh .cnt {
  margin-left: auto;
  font-weight: 400;
}
.pi-item {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 7px;
  border-radius: 6px;
  font-size: 12.5px;
  color: #5F5350;
  cursor: pointer;
  transition: 0.12s;
}
.pi-item:hover {
  background: #fff;
}
.pi-item.on {
  background: #FDF4F2;
  color: #B22A23;
  font-weight: 600;
}
.pi-item .nm {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pi-item .cnt {
  flex: none;
  font-size: 10.5px;
  color: #B3A69F;
  font-weight: 400;
}
.pi-lf {
  flex: none;
  padding: 7px 9px;
  border-top: 1px solid #F1EAE5;
  font-size: 11px;
  color: #B3A69F;
}
.pi-rgt {
  flex: 1;
  min-width: 0;
  border: 1px solid #EFE7E2;
  border-radius: 9px;
  padding: 13px 15px;
  overflow: auto;
  max-height: 520px;
}
.pi-rh {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 10px;
  margin-bottom: 12px;
  border-bottom: 1px solid #F1EAE5;
  font-size: 13px;
}
.pi-newmod {
  margin-top: 12px;
  padding: 11px 13px;
  border: 1px dashed #F2C8C3;
  border-radius: 8px;
  background: #FDF9F7;
}
.pi-sec {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid #F4EEE9;
}
.pi-sh {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 9px;
}
.pi-quick {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 9px;
}
.pi-tb {
  width: 100%;
}
.pi-tb th {
  font-size: 11.5px;
  font-weight: 600;
  color: #9C8D88;
  text-align: left;
  padding: 6px 6px;
  background: #FBF8F5;
  border-bottom: 1px solid #F1EAE5;
}
.pi-tb td {
  padding: 5px 6px;
  border-bottom: 1px dashed #F4EEE9;
  vertical-align: middle;
}
.pi-tb .inp {
  width: 100%;
  height: 30px;
  padding: 4px 9px;
  background-image: none;
}
</style>
