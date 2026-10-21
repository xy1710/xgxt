<script setup lang="ts">
/**
 * 权限配置弹窗（包装 PermTreePanel）
 *
 * ⚠️ 取值走 panelRef.getPerms()，点击「确定」才把草稿交给父组件 ——
 *    用户点「取消」时，已勾的改动不应生效。
 */
import { computed, ref } from 'vue';
import { Search } from '@element-plus/icons-vue';
import type { PermModule, RolePermMap } from 'shared-types/perm';
import PermTreePanel from './PermTreePanel.vue';

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    title?: string;
    modules: PermModule[];
    perms?: RolePermMap;
    readonly?: boolean;
    /** 职位/账号名，用于副标题 */
    subtitle?: string;
  }>(),
  { title: '配置权限', readonly: false, subtitle: '' },
);

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  (e: 'confirm', perms: RolePermMap): void;
}>();

const panelRef = ref<InstanceType<typeof PermTreePanel>>();
const keyword = ref('');

const stats = ref({ checkedActionCount: 0, coveredModuleCount: 0, totalActionCount: 0 });

/**
 * ★ 2026-10-16：已选统计挪到标题右侧括号里（原来在底部 footer）——
 *   「查看权限·咨询老师（已选 25 / 185 个权限点，覆盖 2 个模块）」。
 *   stats 由 PermTreePanel 的 @change 实时推送，勾选变化标题同步刷新。
 */
const dialogTitle = computed(() => {
  const s = stats.value;
  return `${props.title}（已选 ${s.checkedActionCount} / ${s.totalActionCount} 个权限点，覆盖 ${s.coveredModuleCount} 个模块）`;
});

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
});

function confirm() {
  const perms = panelRef.value?.getPerms() || {};
  emit('confirm', perms);
  visible.value = false;
}
</script>

<template>
  <el-dialog
    v-model="visible"
    :title="dialogTitle"
    width="920px"
    top="5vh"
    class="perm-dialog"
    destroy-on-close
  >
    <div class="dlg-head">
      <div class="sub">
        <span v-if="subtitle" class="sub-name">{{ subtitle }}</span>
        <span class="sub-tip">
          勾选即授权；<b>未勾选即无权限</b>（系统不提供「拒绝」语义）。
        </span>
      </div>
      <el-input
        v-model="keyword"
        :prefix-icon="Search"
        placeholder="搜索功能点"
        clearable
        size="small"
        class="search"
      />
    </div>

    <div class="dlg-body">
      <PermTreePanel
        ref="panelRef"
        :modules="modules"
        :perms="perms"
        :readonly="readonly"
        :keyword="keyword"
        @change="(s) => (stats = s)"
      />
    </div>

    <template #footer>
      <div class="dlg-foot">
        <el-button @click="visible = false">{{ readonly ? '关闭' : '取消' }}</el-button>
        <el-button v-if="!readonly" type="primary" @click="confirm">确定</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.dlg-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 10px;
  border-bottom: 1px solid #F4EEE9;
  margin-bottom: 10px;
}

.sub {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.sub-name {
  font-size: 13px;
  font-weight: 600;
  color: #CD3A33;
  background: #FBEFED;
  border-radius: 6px;
  padding: 2px 8px;
  white-space: nowrap;
}

.sub-tip {
  font-size: 12px;
  color: #A2938E;
}

.search {
  width: 200px;
  flex: none;
}

.dlg-body {
  max-height: 58vh;
  overflow: auto;
  padding-right: 4px;
}

.dlg-foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
}
</style>
