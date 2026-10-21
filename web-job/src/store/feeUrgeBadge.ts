import { defineStore } from 'pinia';
import { PayStatus } from 'shared-types/class-jh';
import { http } from '@/api/request';

/**
 * 催费/缴费 菜单红点（2026-10-19 用户要求：有催费信息时菜单项右上角亮红点）
 * ============================================================
 * 【口径】待催办事项数 = 三部门之和：
 *   · 初高：缴费台账「待缴」（PayStatus.UNPAID，含到期阈值内的紧急件——待缴即该催）；
 *   · 大学：催缴记录「逾期未缴」（onlyOverdue）；
 *   · 就业：催费单「待催缴」（callStatus=1；「催缴中」视为已在处理，不亮点）。
 *
 * 【形态】一次性拉三个接口的 size=1 只为读 total，轻量；
 *   60 秒节流；进入催费/缴费页时强刷（处理完回来红点会随之消失）；
 *   未登录/无权限拉取失败时静默保持现状。
 */
export const useFeeUrgeBadge = defineStore('feeUrgeBadge', {
  state: () => ({
    jhPending: 0,
    classOverdue: 0,
    employPending: 0,
    lastFetched: 0,
  }),
  getters: {
    count: (s) => s.jhPending + s.classOverdue + s.employPending,
    tooltip: (s) =>
      `待催办：初高待缴 ${s.jhPending} · 大学逾期 ${s.classOverdue} · 就业待催缴 ${s.employPending}（点击进入处理）`,
  },
  actions: {
    async refresh(force = false) {
      if (!force && Date.now() - this.lastFetched < 60_000) return; // 60 秒节流
      try {
        const [jh, cls, emp] = await Promise.all([
          http.get<any>('/api/class-jh/fee/list', { page: 1, size: 1, payStatus: PayStatus.UNPAID }),
          http.get<any>('/api/class/urge/list', { page: 1, size: 1, onlyOverdue: true }),
          http.get<any>('/api/job/fee-call/page', { page: 1, size: 1, callStatus: 1 }),
        ]);
        this.jhPending = Number(jh?.total || 0);
        this.classOverdue = Number(cls?.total || 0);
        this.employPending = Number(emp?.total || 0);
        this.lastFetched = Date.now();
      } catch {
        /* 静默：未登录/无权限时保持现状 */
      }
    },
  },
});
