<script setup lang="ts">
/**
 * 权限树勾选面板（通用）
 *
 * 结构：模块 → 功能点 → 动作（三级）
 *   · 模块行：显示该模块已选 / 总数 + 全选 / 清空
 *   · 功能点行：名称 + 该功能点下的动作复选
 *
 * ⚠️ 对外不用 v-model，而是 props 传初值 + defineExpose 暴露 getPerms()。
 *    因为权限勾选是「编辑中」的状态，边勾边回写父组件会引发
 *    「父更新子 → 子重置 → 再回写父」的循环，最后把用户的勾选冲掉。
 *    需要取值时由父组件显式调用 getPerms()。
 *
 * key 规则与后端一致：`模块key||功能点名`，value 是动作编码数组。
 */
import { computed, ref, watch } from 'vue';
import { QuestionFilled } from '@element-plus/icons-vue';
import type { PermModule, RolePermMap } from 'shared-types/perm';

const props = defineProps<{
  modules: PermModule[];
  /** 初始勾选态 */
  perms?: RolePermMap;
  /** 只读（查看他人权限时用） */
  readonly?: boolean;
  /** 关键字高亮过滤（空则全显示） */
  keyword?: string;
}>();

const emit = defineEmits<{
  (e: 'change', stats: { checkedActionCount: number; coveredModuleCount: number; totalActionCount: number }): void;
}>();

const key = (moduleKey: string, itemName: string) => `${moduleKey}||${itemName}`;

/** 编辑中的草稿：key → 动作编码数组 */
const draft = ref<Record<string, string[]>>({});

function seed(p?: RolePermMap) {
  const out: Record<string, string[]> = {};
  Object.keys(p || {}).forEach((k) => {
    out[k] = [...(p as RolePermMap)[k]];
  });
  draft.value = out;
}

watch(
  () => props.perms,
  (v) => seed(v),
  { immediate: true },
);

/* ============================================================
 * 统计
 * ============================================================ */

const totalActionCount = computed(() =>
  props.modules.reduce((s, m) => s + m.items.reduce((a, it) => a + it.actions.length, 0), 0),
);

const checkedActionCount = computed(() =>
  Object.keys(draft.value).reduce((s, k) => s + (draft.value[k]?.length || 0), 0),
);

const coveredModuleCount = computed(() => {
  const mods = new Set<string>();
  Object.keys(draft.value).forEach((k) => {
    if (draft.value[k]?.length) mods.add(k.split('||')[0]);
  });
  return mods.size;
});

const stats = computed(() => ({
  checkedActionCount: checkedActionCount.value,
  coveredModuleCount: coveredModuleCount.value,
  totalActionCount: totalActionCount.value,
}));

watch(stats, (v) => emit('change', { ...v }), { deep: true });

/* ============================================================
 * 勾选逻辑
 * ============================================================ */

function getChecked(moduleKey: string, itemName: string): string[] {
  return draft.value[key(moduleKey, itemName)] || [];
}

function setChecked(moduleKey: string, itemName: string, codes: string[]) {
  draft.value = { ...draft.value, [key(moduleKey, itemName)]: codes };
}

/** 单个动作勾选变化 */
function onActionChange(moduleKey: string, itemName: string, codes: string[]) {
  setChecked(moduleKey, itemName, codes);
}

/** 某功能点是否全选 */
function itemAll(moduleKey: string, itemName: string, total: number) {
  return total > 0 && getChecked(moduleKey, itemName).length === total;
}

/** 某模块是否全选 */
function moduleAll(m: PermModule) {
  const total = m.items.reduce((a, it) => a + it.actions.length, 0);
  const checked = m.items.reduce((a, it) => a + getChecked(m.moduleKey, it.itemName).length, 0);
  return total > 0 && checked === total;
}

/** 某模块是否部分选中 */
function moduleIndeterminate(m: PermModule) {
  const checked = m.items.reduce((a, it) => a + getChecked(m.moduleKey, it.itemName).length, 0);
  return checked > 0 && !moduleAll(m);
}

/** 整模块 全选 / 清空 */
function toggleModule(m: PermModule, checked: boolean) {
  const next = { ...draft.value };
  m.items.forEach((it) => {
    next[key(m.moduleKey, it.itemName)] = checked ? it.actions.map((a) => a.actionCode) : [];
  });
  draft.value = next;
}

/** 复制当前职位的权限映射（提交用） */
function getPerms(): RolePermMap {
  const out: RolePermMap = {};
  Object.keys(draft.value).forEach((k) => {
    if (draft.value[k]?.length) out[k] = [...draft.value[k]];
  });
  return out;
}

/** 按关键字过滤要显示的功能点 */
function visibleItems(m: PermModule) {
  const kw = (props.keyword || '').trim();
  if (!kw) return m.items;
  return m.items.filter(
    (it) => it.itemName.includes(kw) || m.moduleName.includes(kw),
  );
}

function moduleVisible(m: PermModule) {
  return visibleItems(m).length > 0;
}

defineExpose({ getPerms, reset: () => seed(props.perms), stats });
</script>

<template>
  <div class="perm-panel">
    <div v-for="m in props.modules.filter(moduleVisible)" :key="m.moduleKey" class="mod">
      <div class="mod-head">
        <label class="mod-title">
          <el-checkbox
            v-if="!props.readonly"
            :model-value="moduleAll(m)"
            :indeterminate="moduleIndeterminate(m)"
            @change="(v: any) => toggleModule(m, !!v)"
          />
          <span class="mod-icon">{{ m.moduleIcon }}</span>
          <span class="mod-name">{{ m.moduleName }}</span>
          <span class="mod-sub">
            {{ m.items.reduce((a, it) => a + getChecked(m.moduleKey, it.itemName).length, 0) }}
            / {{ m.items.reduce((a, it) => a + it.actions.length, 0) }}
          </span>
        </label>
      </div>

      <div class="items">
        <div v-for="it in visibleItems(m)" :key="it.id" class="item">
          <div class="item-name">
            <span>{{ it.itemName }}</span>
            <el-tooltip v-if="it.remark" :content="it.remark" placement="top">
              <el-icon class="item-tip"><QuestionFilled /></el-icon>
            </el-tooltip>
          </div>

          <el-checkbox-group
            :model-value="getChecked(m.moduleKey, it.itemName)"
            :disabled="!!props.readonly"
            size="small"
            class="actions"
            @update:model-value="(v: any) => onActionChange(m.moduleKey, it.itemName, v as string[])"
          >
            <el-checkbox
              v-for="a in it.actions"
              :key="a.actionCode"
              :value="a.actionCode"
              :label="a.actionCode"
              class="action"
            >
              {{ a.actionName }}
            </el-checkbox>
          </el-checkbox-group>
        </div>
      </div>
    </div>

    <el-empty v-if="!props.modules.filter(moduleVisible).length" description="没有匹配的功能点" :image-size="60" />
  </div>
</template>

<script lang="ts">
export default { name: 'PermTreePanel' };
</script>

<style scoped>
.perm-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.mod {
  border: 1px solid #EFE9E4;
  border-radius: 8px;
  overflow: hidden;
}

.mod-head {
  background: #FBF7F4;
  padding: 8px 12px;
  border-bottom: 1px solid #F4EEE9;
}

.mod-title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  user-select: none;
}

.mod-icon {
  font-size: 15px;
}

.mod-name {
  font-size: 13px;
  font-weight: 600;
  color: #443432;
}

.mod-sub {
  font-size: 12px;
  color: #A2938E;
  background: #fff;
  border: 1px solid #EFE9E4;
  border-radius: 999px;
  padding: 0 7px;
}

.items {
  padding: 4px 12px 10px;
}

.item {
  padding: 8px 0;
  border-bottom: 1px dashed #F1EBE7;
  display: grid;
  grid-template-columns: 168px minmax(0, 1fr);
  gap: 10px;
  align-items: start;
}

.item:last-child {
  border-bottom: none;
}

.item-name {
  font-size: 13px;
  color: #443432;
  padding-top: 3px;
  display: flex;
  align-items: center;
  gap: 4px;
}

.item-tip {
  color: #C4B8B2;
  cursor: help;
  font-size: 13px;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 0;
}

.action {
  margin-right: 14px;
  height: 24px;
}

.action :deep(.el-checkbox__label) {
  font-size: 12px;
  padding-left: 4px;
}
</style>
