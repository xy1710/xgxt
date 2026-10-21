<script setup lang="ts">
/**
 * 「教学管理」业务域宿主页（第 1 期 · 入口合并）
 * ============================================================
 *
 * 【它做什么】
 *   一个业务域（考试 / 成绩 / 出勤 / 宿舍 …）只有一个入口，页面顶部是
 *   **学段页签**（初高 / 大学 / 实训 / 就业 / 教务）；切页签 = 挂载该学段
 *   的**原页面组件**。
 *
 * 【只显示你有权限的页签】
 *   页签按 access.ts 的 stageAccessible() 过滤（原路径 + 原权限码）。
 *   一个学段都没权限 → 显示空状态，不会白屏。
 *
 * 【为什么切换要 :key】
 *   原页面里可能有大量本地状态（当前页、筛选条件…）。加 :key 强制重建组件，
 *   避免 A 学段的状态串到 B 学段上。
 */
import { computed, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { findTeachingDomain } from '@/teaching/domainConfig';
import { stageAccessible, stageVisible, type StageDomain } from '@/teaching/access';
/* 页签模式下把当前学段同步给面包屑第 4 级（unified 模式下由统一页面自己上报） */
import { setBreadcrumbStage } from '@/store/breadcrumb';

const route = useRoute();

/** 当前业务域（由路由 meta.domainKey 指定） */
const def = computed(() => findTeachingDomain(route.meta?.domainKey as string | undefined));

/**
 * 当前账号在该业务域**有权访问**的学段列表
 *
 * ★ 第 3 阶段 D2 改造（2026-10-09）
 *   原来这里读 `def.stages`（各学段的旧页面配置），判权靠 `stageAccessible(旧路由, 权限码)`。
 *   D2 要把 25 条旧路由和旧组件删掉，**删完 `stages` 就不存在了**。
 *
 *   现在改成：从 `STAGE_ACCESS`（权限码对照表）取，**不依赖旧路由**。
 *   —— 判权主走 `hasPerm(权限码)`，与后端 `requireAnyPage()` 同一套口径。
 *
 *   ⚠️ 仍然保留 `def.stages` 作为**兜底**：权限树没配全的环境
 *      （老数据）下 `hasPerm` 可能判不出可见性，此时靠旧配置保底，
 *      保证「不会有人突然看不到页面」。等观察期过了再把兜底删掉。
 */
const stages = computed<Array<{ stage: string; comp?: unknown; note?: string; path?: string; pageCode?: string }>>(() => {
  const key = route.meta?.domainKey as string | undefined;
  const d = def.value;

  // 主路径：按域 key 从权限码对照表取（不依赖旧路由）
  const fromTable = key ? DOMAIN_OF_KEY[key] : undefined;
  if (fromTable) {
    const list = STAGE_ORDER.filter((st) => stageVisible(fromTable, st));
    if (list.length) {
      return list.map((st) => ({ stage: STAGE_LABEL[st] }));
    }
  }

  // 兜底：老配置（权限树不完整时用）
  return (d?.stages || []).filter((s) => stageAccessible(s.path, s.pageCode));
});

/** domainConfig 的 key → access.ts 的业务域名 */
const DOMAIN_OF_KEY: Record<string, StageDomain> = {
  student: 'student',
  class: 'class',
  attendance: 'attendance',
  exam: 'exam',
  score: 'score',
  refund: 'refund',
  approval: 'leave',
  dorm: 'dorm',
};

/** 学段展示顺序（固定，不受权限影响，保证下拉顺序稳定） */
const STAGE_ORDER = ['jh', 'class', 'job', 'edu'] as const;

/** 学段 key → 中文名（与各统一页的 STAGE_LABEL 保持一致） */
const STAGE_LABEL: Record<string, string> = {
  jh: '初高部',
  class: '大学部',
  job: '实训',
  edu: '教务',
  就业: '就业',
};

/** 当前选中的学段 */
const active = ref('');

// 可用学段变化（权限到位 / 换账号）时，纠正选中项
watch(
  () => stages.value.map((s) => s.stage).join('|'),
  () => {
    if (!stages.value.some((s) => s.stage === active.value)) {
      active.value = stages.value[0]?.stage || '';
    }
  },
  { immediate: true },
);

const current = computed(() => stages.value.find((s) => s.stage === active.value) || null);
const currentComp = computed(() => current.value?.comp);

/* 页签模式下，当前学段变化时同步给面包屑（值本身是中文）。
 * unified 模式下 active 恒为空 → 上报空 = 面包屑第 4 级由统一页面负责。
 * 页面卸载时清空，避免学段残留到非教学页面。 */
watch(active, (v) => setBreadcrumbStage(v || ''), { immediate: true });
onUnmounted(() => setBreadcrumbStage(''));

/**
 * ★ 第 2 期：这个业务域是否已经合并成「统一页面」
 *   有值 → 直接渲染它（不再出学段页签，因为统一页面里自带学段筛选器）；
 *   无值 → 走第 1 期的页签模式。
 */
const unified = computed(() => def.value?.unified || null);
</script>

<template>
  <div class="teaching-domain">
    <div class="td-bar">
      <span class="td-bar-title">{{ def?.title || '业务域' }}</span>
      <span class="td-bar-tag">教学管理 · 合并入口</span>
      <span class="td-bar-hint">
        合并前这里有 {{ def?.stages?.length || 0 }} 套重复页面，现在收成一个入口
      </span>
    </div>

    <!-- ★ 第 2 期：已合并的业务域直接渲染统一页面 -->
    <component :is="unified" v-if="unified" />

    <template v-else>
      <el-tabs v-if="stages.length > 1" v-model="active" class="td-tabs">
        <el-tab-pane v-for="s in stages" :key="s.stage" :label="s.stage" :name="s.stage" />
      </el-tabs>

      <el-empty v-if="stages.length === 0" description="当前账号没有该业务域任何部门的访问权限" />

      <template v-else>
        <el-alert
          v-if="current?.note"
          class="td-note"
          type="info"
          :closable="false"
          show-icon
          :title="`${current.stage}口径：${current.note}`"
        />
        <div class="td-body">
          <component :is="currentComp" :key="active" />
        </div>
      </template>
    </template>
  </div>
</template>

<style scoped>
.teaching-domain {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}

.td-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  margin-bottom: 10px;
  border: 1px solid var(--el-border-color-lighter, #F1EAE5);
  border-radius: 8px;
  background: var(--el-fill-color-blank, #fff);
}
.td-bar-title {
  font-size: 15px;
  font-weight: 500;
  color: var(--el-text-color-primary, #443432);
}
.td-bar-tag {
  font-size: 12px;
  line-height: 18px;
  padding: 0 6px;
  border-radius: 4px;
  color: #B22A23;
  background: #F9E4E1;
}
.td-bar-hint {
  font-size: 12px;
  color: var(--el-text-color-secondary, #A2938E);
  margin-left: auto;
}

.td-tabs :deep(.el-tabs__header) {
  margin-bottom: 8px;
}
.td-tabs :deep(.el-tabs__content) {
  display: none;
}

.td-note {
  margin-bottom: 10px;
}

.td-body {
  flex: 1;
  min-height: 0;
}
</style>
