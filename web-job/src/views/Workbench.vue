<script setup lang="ts">
/**
 * 工作台（系统首页 · 全角色统一落地页）
 *
 * ★ 2026-10-16 用户指令：「将工作台放置首页，每个角色进来第一个页面就是工作台」
 *
 *  - 登录后、路由 /、侧栏第一项都指向这里（见 router/index.ts、App.vue、
 *    server-job account.service.ts 的 landingPathOf）
 *  - 内容按权限自适应，角色能看到什么完全由既有权限口径决定：
 *      · 初高 KPI + 待办：有 classjh:dashboard:view 页面权限才显示
 *        （统计接口本身还挂着后端权限闸，这里只是不碍眼）
 *      · 快捷入口：与左侧菜单同一套过滤口径（config/sideMenu.ts），
 *        角色有什么模块/页面就显示什么
 *
 *  原 class-jh/views/Dashboard.vue 的 KPI + 待办整体迁移到这里（原路由
 *  /class-jh/dashboard 重定向到首页，老书签不失效）。
 */

import { computed, ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { Refresh } from '@element-plus/icons-vue';
import type { DashboardStat } from 'shared-types/class-jh';
import { ROLE_CODE_NAME } from 'shared-types';
import { fetchDashboardStat } from '@/class-jh/api/stats';
import { formatRate } from '@/class-jh/utils/format';
import { useAuthStore as usePortalStore } from '@/portal/stores/auth';
import { myRoles, hasPage } from '@/store/permission';
import { pageEnabled } from '@/store/pageConfig';
import { useSideMenu } from '@/config/sideMenu';

const router = useRouter();
const portal = usePortalStore();

/* ==================== 身份欢迎语 ==================== */

const userNameText = computed(() => portal.account?.userName || '未登录');

/** 头衔：门户账号 title / kind，老口径角色码兜底（与 App.vue 顶栏同一口径） */
const roleText = computed(() => {
  const a = portal.account;
  if (a) {
    if (a.title) return a.title;
    if (a.kind === 'sys_admin') return '系统管理员';
    return '模块负责人';
  }
  return myRoles.value.map((r) => ROLE_CODE_NAME[r] || r).join('、') || '未登录';
});

const todayText = computed(() => {
  const d = new Date();
  const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 星期${week}`;
});

/* ==================== 初高 KPI + 待办（有权限才显示） ==================== */

/**
 * 显示条件 = 「有工作台页面权限」且「页面台账没有把它关掉」。
 * ⚠️ 统计接口后端还挂着 checkPermission('class:student:view')，双保险。
 */
const showClassJhStat = computed(
  () => hasPage('/class-jh/dashboard') && pageEnabled('/class-jh/dashboard'),
);

const statLoading = ref(false);
const stat = ref<DashboardStat | null>(null);

async function loadStat() {
  if (!showClassJhStat.value) return;
  statLoading.value = true;
  try {
    stat.value = await fetchDashboardStat();
  } catch {
    /* 错误已统一处理；KPI 卡显示 0 / — */
  } finally {
    statLoading.value = false;
  }
}

function goTodo(path?: string) {
  if (!path) {
    ElMessage.info('该待办暂未配置跳转');
    return;
  }
  router.push(path);
}

/* ==================== 快捷入口（与侧栏同一套口径） ==================== */

interface WorkbenchEntry {
  title: string;
  path: string;
  group: string;
  phase?: string;
}

const { visibleMenu } = useSideMenu();

const entries = computed<WorkbenchEntry[]>(() => {
  const out: WorkbenchEntry[] = [];
  for (const g of visibleMenu.value) {
    // 工作台自己（'/'）不进快捷入口 —— 用户已经站在它上面
    if (!g.children?.length) continue;
    for (const c of g.children) {
      if (!c.path || c.path === '/') continue;
      out.push({ title: c.title, path: c.path, group: g.title, phase: c.phase });
    }
  }
  return out;
});

onMounted(loadStat);
</script>

<template>
  <div class="page-container">
    <!-- ============ 欢迎栏 ============ -->
    <div class="toolbar">
      <div class="welcome">
        <span class="page-title">工作台</span>
        <span class="welcome-text">
          欢迎回来，{{ userNameText }}（{{ roleText }}） · {{ todayText }}
        </span>
      </div>
      <el-button v-if="showClassJhStat" :icon="Refresh" @click="loadStat">刷新</el-button>
    </div>

    <!-- ============ 初高 KPI + 待办（有权限才显示） ============ -->
    <div v-if="showClassJhStat" v-loading="statLoading">
      <div class="kpi-row">
        <el-card shadow="hover" class="kpi-card">
          <div class="kpi-label">在读学生数</div>
          <div class="kpi-value">{{ stat?.readingStudentCount ?? 0 }}</div>
          <div class="kpi-sub">试学 / 预在读 / 正式在读</div>
        </el-card>

        <el-card shadow="hover" class="kpi-card">
          <div class="kpi-label">今日出勤率</div>
          <div class="kpi-value">
            {{ stat ? formatRate(stat.todayAttendanceRate) : '—' }}
          </div>
          <div class="kpi-sub">
            目标 {{ stat ? formatRate(stat.attendanceTargetRate) : '—' }}
          </div>
        </el-card>

        <el-card shadow="hover" class="kpi-card">
          <div class="kpi-label">紧急催费</div>
          <div class="kpi-value danger">{{ stat?.urgentFeeCount ?? 0 }}</div>
          <div class="kpi-sub">临近应缴日期</div>
        </el-card>

        <el-card shadow="hover" class="kpi-card">
          <div class="kpi-label">待办总数</div>
          <div class="kpi-value warning">{{ stat?.pendingTodoCount ?? 0 }}</div>
          <div class="kpi-sub">待审批流程 / 退费 / 调宿</div>
        </el-card>
      </div>

      <el-card shadow="never" class="todo-card">
        <template #header>
          <span>待办清单</span>
        </template>
        <div v-if="stat?.todos?.length" class="todo-list">
          <div v-for="todo in stat.todos" :key="todo.type" class="todo-item" @click="goTodo(todo.path)">
            <span class="todo-title">{{ todo.title }}</span>
            <el-tag :type="todo.count > 0 ? 'danger' : 'info'" size="small">{{ todo.count }}</el-tag>
          </div>
        </div>
        <el-empty v-else description="暂无待办" :image-size="80" />
      </el-card>
    </div>

    <!-- ============ 快捷入口 ============ -->
    <el-card shadow="never" class="entry-card">
      <template #header>
        <span>快捷入口</span>
      </template>
      <div v-if="entries.length" class="entry-grid">
        <div
          v-for="e in entries"
          :key="e.group + e.path"
          class="entry-item"
          @click="router.push(e.path)"
        >
          <div class="entry-title">{{ e.title }}</div>
          <div class="entry-group">{{ e.phase || e.group }}</div>
        </div>
      </div>
      <el-empty
        v-else
        description="该账号暂无可用页面，请联系系统管理员分配模块权限"
        :image-size="80"
      />
    </el-card>
  </div>
</template>

<style scoped>
.page-container {
  padding: 16px;
}
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}
.welcome {
  display: flex;
  align-items: baseline;
  gap: 14px;
  flex-wrap: wrap;
}
.page-title {
  font-size: 18px;
  font-weight: 600;
  color: #443432;
}
.welcome-text {
  font-size: 13px;
  color: #A2938E;
}
.kpi-row {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}
.kpi-card {
  flex: 1;
  min-width: 180px;
  text-align: center;
}
.kpi-label {
  color: #A2938E;
  font-size: 14px;
  margin-bottom: 10px;
}
.kpi-value {
  font-size: 30px;
  font-weight: 600;
  color: #CD3A33;
}
.kpi-value.danger {
  color: #CD3A33;
}
.kpi-value.warning {
  color: #C9852E;
}
.kpi-sub {
  margin-top: 8px;
  color: #C4B8B2;
  font-size: 12px;
}
.todo-card {
  min-height: 160px;
  margin-bottom: 16px;
}
.todo-list {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
.todo-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 18px;
  border: 1px solid #E2D7D1;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s;
}
.todo-item:hover {
  border-color: #CD3A33;
  background: #FDF4F2;
}
.todo-title {
  font-size: 14px;
  color: #443432;
}
.entry-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 12px;
}
.entry-item {
  padding: 14px 16px;
  border: 1px solid #E2D7D1;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s;
}
.entry-item:hover {
  border-color: #CD3A33;
  background: #FDF4F2;
}
.entry-title {
  font-size: 14px;
  font-weight: 600;
  color: #443432;
}
.entry-group {
  margin-top: 6px;
  font-size: 12px;
  color: #C4B8B2;
}
</style>
