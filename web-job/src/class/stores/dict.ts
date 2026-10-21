import { ref } from 'vue';
import { defineStore } from 'pinia';
import { loadDict, type DictData, type DictGroup } from '@/class/api/meta';

/**
 * 枚举字典（一次拉取，全站共用）
 *
 * 规范铁律：枚举只能来自《01-公共数据字典》，页面**不许自己写死中文**。
 * 所以所有下拉、标签、状态名都走这里。
 */
export const useDictStore = defineStore('dict', () => {
  const data = ref<DictData | null>(null);
  const loading = ref(false);
  let pending: Promise<DictData> | null = null;

  /** 幂等加载：并发调用只会打一次接口 */
  async function ensure(): Promise<DictData> {
    if (data.value) return data.value;
    if (pending) return pending;
    loading.value = true;
    pending = loadDict()
      .then((d) => {
        data.value = d;
        return d;
      })
      .finally(() => {
        loading.value = false;
        pending = null;
      });
    return pending;
  }

  /** 强制重取（后端枚举更新后用） */
  async function refresh(): Promise<void> {
    data.value = null;
    await ensure();
  }

  function groupOf(key: string): DictGroup | undefined {
    const raw = data.value as Record<string, unknown> | null;
    const g = raw?.[key];
    return g && typeof g === 'object' && !Array.isArray(g) ? (g as DictGroup) : undefined;
  }

  /** 显示名；查不到回退原值，避免页面出现空白单元格 */
  function label(key: string, value: unknown): string {
    if (value === null || value === undefined || value === '') return '—';
    const g = groupOf(key);
    return g?.[String(value)] ?? String(value);
  }

  /** 下拉选项 */
  function options(key: string): Array<{ label: string; value: number }> {
    const g = groupOf(key);
    if (!g) return [];
    return Object.keys(g)
      .filter((k) => /^\d+$/.test(k))
      .map((k) => ({ label: g[k], value: Number(k) }))
      .sort((a, b) => a.value - b.value);
  }

  /** 某部门下可选的学习阶段（升学、建班用） */
  function stagesOf(deptCode: number): Array<{ label: string; value: number }> {
    const m = data.value?.stageByDept;
    const ids = m?.[String(deptCode)];
    const g = groupOf('stage');
    if (!ids || !g) return options('stage');
    return ids
      .map((id) => ({ label: g[String(id)] ?? String(id), value: id }))
      .sort((a, b) => a.value - b.value);
  }

  /** 状态 → 处理人角色中文（审批页显示「当前待 XX 处理」） */
  function suspendHandler(status: number): string {
    return groupOf('suspendStatusHandlerRole')?.[String(status)] ?? '';
  }
  function refundHandler(status: number): string {
    return groupOf('refundStatusHandlerRole')?.[String(status)] ?? '';
  }

  /** 根据状态取 Element Plus 的 tag 类型，让状态一眼可辨 */
  function tagTypeOf(key: string, value: number | null | undefined): 'success' | 'warning' | 'danger' | 'info' | 'primary' {
    if (value === null || value === undefined) return 'info';
    const group = groupOf(key) ?? {};
    const text = group[String(value)] ?? '';
    if (/驳回|退学|未缴|欠费|流失|封班/.test(text)) return 'danger';
    if (/已同意|已通过|正式在读|已缴|已就业|开放|正常|已收到/.test(text)) return 'success';
    if (/待|试学|预在|进行中|审批中|在校/.test(text)) return 'warning';
    return 'primary';
  }

  return { data, loading, ensure, refresh, groupOf, label, options, stagesOf, suspendHandler, refundHandler, tagTypeOf };
});
