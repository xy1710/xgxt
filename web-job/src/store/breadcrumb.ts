/**
 * 面包屑第 4 级「学段」的跨组件上报通道
 * ============================================================
 *
 * 【为什么需要它】
 *   面包屑组件挂在 App.vue 的内容区顶部（层级最高），
 *   但「当前在查看哪个学段」这个状态活在**各页面内部**：
 *     · 8 个统一页面（TeachingExam 等）→ 学段筛选器 query.stage（值为 jh/class/job）
 *     · 业务域宿主页（TeachingDomain.vue）→ 页签 active（值为中文）
 *   父组件拿不到子组件的本地状态，所以由页面**主动上报**。
 *
 * 【页面怎么接（两行）】
 *   import { useBreadcrumbStageKey } from '@/store/breadcrumb';
 *   useBreadcrumbStageKey(() => query.stage || '');
 *
 *   · source 变化（用户切了学段筛选）→ 自动同步给面包屑
 *   · 页面卸载（路由切走）→ 自动清空，不会把上一个页面的学段残留到下一个页面
 *   · 上报空字符串 = 面包屑不显示第 4 级（比如筛选器选了「全部」）
 *
 * 【为什么 key→中文 的映射放在这里，而不是用各页面自己的 STAGE_LABEL】
 *   8 个统一页面里有 3 个（Attendance/Leave/Refund）没有定义 STAGE_LABEL，
 *   其余几个的定义也略有出入。映射收拢一份，改一处全局生效。
 *
 * 【为什么不用 Pinia】
 *   只有一个字段、只被面包屑读、生命周期跟着页面走 —— 模块级 reactive 单例
 *   比 Pinia 更轻，语义上它是「页面 → 布局」的一次性上报，不是全局共享状态。
 * ============================================================
 */

import { reactive, watch, onUnmounted } from 'vue';

/** 学段 key → 中文名（与各统一页面 STAGE_LABEL 的口径保持一致） */
const STAGE_LABEL: Record<string, string> = {
  jh: '初高',
  class: '大学',
  job: '就业',
  edu: '教务',
};

/** 当前页面正在查看的学段中文名（如 '大学'）。空字符串 = 不显示第 4 级 */
export const breadcrumbStage = reactive({ stage: '' });

/** 页面用：直接上报学段中文名（TeachingDomain 的页签值本身就是中文，走这个） */
export function setBreadcrumbStage(text: string) {
  breadcrumbStage.stage = text || '';
}

/**
 * 页面接入面包屑学段显示（统一页面用这个，上报学段 key）
 *
 * @param source 返回学段 key（'jh' | 'class' | 'job' | ''）的取值函数（响应式）
 */
export function useBreadcrumbStageKey(source: () => string) {
  watch(
    source,
    (k) => {
      breadcrumbStage.stage = STAGE_LABEL[k] || '';
    },
    { immediate: true },
  );
  onUnmounted(() => {
    breadcrumbStage.stage = '';
  });
}
