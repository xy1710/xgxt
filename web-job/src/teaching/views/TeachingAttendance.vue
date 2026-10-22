<script setup lang="ts">
/**
 * 出勤管理 · 统一页面（第 2 期核心交付）
 * ============================================================
 *
 * 【它取代了什么】
 *   合并前三个学段各有一个出勤页（初高 370 行 / 大学 804 行 / 实训 710 行），
 *   页面结构约 80% 相同。现在只有这一个页面，顶部用**学段筛选器**区分。
 *
 * 【学段筛选器 ≠ 第 1 期的页签】
 *   第 1 期是「一个入口 + 三个页签，每个页签后面挂一套老页面」（三套代码并排）；
 *   第 2 期是「一个入口 + 一个页面 + 学段筛选」（**只有一套代码**）。
 *
 * 【能看到的学段 = 有权限的学段】
 *   复用第 1 期的 stageAccessible()（按各学段原页面权限码判），
 *   所以用户可见范围与合并前完全一致。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useBreadcrumbStageKey } from '@/store/breadcrumb';
import { ElMessage } from 'element-plus';
import { Download, EditPen, Refresh, Search } from '@element-plus/icons-vue';
import {
  attendanceSummary,
  exportAttendance,
  fetchAttendanceBoard,
  fetchClassOptions,
  getAttendanceDetail,
  listAttendance,
  saveAttendance,
  STAGE_NAME,
  UNIFIED_STATUS_NAME,
  type AttendanceBoard,
  type AttendanceDetail,
  type AttendanceRow,
  type AttendanceSummaryItem,
  type ClassOption,
  type TeachingStage,
} from '@/teaching/api/attendance';
import { stageVisible } from '@/teaching/access';
import { isReadOnlyUser } from '@/store/permission';

/* ============================================================
 * 学段（只显示有权限的）
 * ============================================================ */
const STAGE_ORDER: TeachingStage[] = ['jh', 'class', 'job'];

/**
 * ★ 2026-10-19 口径调整：本页把「学段」改称「部门」，
 *   且实训对外统一叫「就业」。
 *   ⚠️ 只在本页生效：后端/其它页返回的 stageName 仍是旧叫法，
 *      所以展示一律走 deptName()，不直接渲染 row.stageName。
 */
const DEPT_NAME: Record<string, string> = { jh: '初高', class: '大学', job: '就业' };
const deptName = (stage?: string | null): string =>
  stage ? (DEPT_NAME[stage] ?? STAGE_NAME[stage as TeachingStage] ?? stage) : '';

/** 各学段的原页面路径与权限码（与合并前一致） */

const availableStages = computed(() =>
  STAGE_ORDER.filter((s) => stageVisible('attendance', s)),
);

/* ============================================================
 * 查询条件
 * ============================================================ */
const query = reactive({

  stage: '' as '' | TeachingStage,
  classId: '',
  dateRange: [] as string[],
});

/* 面包屑第 4 级：当前正在查看的学段（筛选器变化时自动同步，页面卸载自动清空） */
useBreadcrumbStageKey(() => query.stage || '');
const page = reactive({ page: 1, size: 20, total: 0 });

const loading = ref(false);
const rows = ref<AttendanceRow[]>([]);
const summary = ref<AttendanceSummaryItem[]>([]);
const classOptions = ref<ClassOption[]>([]);

/** 班级下拉按当前学段过滤（不选学段 = 全部） */
const classSelectOptions = computed(() =>
  query.stage ? classOptions.value.filter((c) => c.stage === query.stage) : classOptions.value,
);

function baseParams() {
  return {
    stage: (query.stage || undefined) as TeachingStage | undefined,
    classId: query.classId || undefined,
    startDate: query.dateRange?.[0] || undefined,
    endDate: query.dateRange?.[1] || undefined,
  };
}

async function loadList() {
  loading.value = true;
  try {
    const r = await listAttendance({ ...baseParams(), page: page.page, size: page.size });
    rows.value = r.list || [];
    page.total = r.total || 0;
  } catch (e: any) {
    // 拦截器已弹提示；这里只兜底避免页面卡在 loading
    rows.value = [];
    page.total = 0;
  } finally {
    loading.value = false;
  }
}

async function loadSummary() {
  try {
    summary.value = (await attendanceSummary(baseParams())) || [];
  } catch {
    summary.value = [];
  }
}

async function loadClasses() {
  try {
    classOptions.value = (await fetchClassOptions()) || [];
  } catch {
    classOptions.value = [];
  }
}

function handleSearch() {
  page.page = 1;
  void loadList();
  void loadSummary();
}
function handleReset() {
  query.stage = '';
  query.classId = '';
  query.dateRange = [];
  handleSearch();
}

// 切学段时清掉不匹配的班级，并重新查
watch(
  () => query.stage,
  () => {
    if (query.classId && !classSelectOptions.value.some((c) => c.id === query.classId)) {
      query.classId = '';
    }
    handleSearch();
  },
);

onMounted(async () => {
  await loadClasses();
  await Promise.all([loadList(), loadSummary()]);
});

/* ============================================================
 * 详情
 * ============================================================ */
const detailVisible = ref(false);
const detailLoading = ref(false);
const detail = ref<AttendanceDetail | null>(null);

async function openDetail(row: AttendanceRow) {
  detailVisible.value = true;
  detailLoading.value = true;
  detail.value = null;
  try {
    detail.value = await getAttendanceDetail(row.stage, row.id);
  } finally {
    detailLoading.value = false;
  }
}

/* ============================================================
 * 录入
 * ============================================================ */
const entryVisible = ref(false);
const entrySaving = ref(false);
const board = ref<AttendanceBoard | null>(null);
const boardLoading = ref(false);
const entry = reactive({
  stage: '' as '' | TeachingStage,
  classId: '',
  attendanceDate: today(),
  shouldCount: 0,
  actualCount: 0,
});

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 当前录入学段（只有一个权限学段时自动选中） */
const entryStage = computed<TeachingStage | ''>(
  () => entry.stage || (availableStages.value.length === 1 ? availableStages.value[0] : ''),
);
/* ★ 2026-10-19：三个部门统一「按人勾状态」——大学部不再手工填人数 */

const entryClassOptions = computed(() =>
  entryStage.value ? classOptions.value.filter((c) => c.stage === entryStage.value) : [],
);

function openEntry(row?: AttendanceRow) {
  board.value = null;
  if (row) {
    entry.stage = row.stage;
    entry.classId = row.classId;
    entry.attendanceDate = row.attendanceDate;
    entry.shouldCount = row.shouldCount;
    entry.actualCount = row.actualCount;
  } else {
    entry.stage = (query.stage || (availableStages.value.length === 1 ? availableStages.value[0] : '')) as TeachingStage | '';
    entry.classId = query.classId || '';
    entry.attendanceDate = today();
    entry.shouldCount = 0;
    entry.actualCount = 0;
  }
  entryVisible.value = true;
  void loadBoard();
}

async function loadBoard() {
  if (!entryStage.value || !entry.classId) {
    board.value = null;
    return;
  }
  boardLoading.value = true;
  try {
    board.value = await fetchAttendanceBoard(entryStage.value as TeachingStage, entry.classId, entry.attendanceDate);
    // 未登记的一律默认「出勤」
    for (const r of board.value.rows) if (r.status === null) r.status = 1;
  } catch {
    board.value = null;
  } finally {
    boardLoading.value = false;
  }
}

watch(() => [entry.stage, entry.classId, entry.attendanceDate], () => void loadBoard());

/* ★ 切换部门后，若当前班级不属于新部门就显式清空：
   否则「值还留着、只是下拉没选项」——用户以为清空了，直接点保存会拿**上一个部门的班级 id**
   去写新部门的考勤（后端只会报「班级不存在」，或更糟写错班）。
   注意：从列表某行点「录入」时 stage/classId 是一起赋值的，此时班级合法，不能被清掉。 */
watch(
  () => entry.stage,
  () => {
    if (entry.classId && !entryClassOptions.value.some((c) => c.id === entry.classId)) {
      entry.classId = '';
      board.value = null;
    }
  },
);

/** 需要填原因的状态（与后端 dto.ts 一致） */
const NEED_REASON = [2, 5, 6, 7];

async function submitEntry() {
  const stage = entryStage.value as TeachingStage;
  if (!stage) return ElMessage.warning('请选择部门');
  if (!entry.classId) return ElMessage.warning('请选择班级');
  if (!entry.attendanceDate) return ElMessage.warning('请选择日期');

  const payload: any = { stage, classId: entry.classId, attendanceDate: entry.attendanceDate };
  /* 三个部门统一：按人提交（后端据此算应到/实到/出勤率） */
  const list = board.value?.rows || [];
  if (!list.length) return ElMessage.warning('该班当天没有在班学生');
  const missing = list.find((r) => NEED_REASON.includes(Number(r.status)) && !r.reason);
  if (missing) {
    return ElMessage.warning(
      `「${missing.studentName || missing.studentId}」状态为${UNIFIED_STATUS_NAME[Number(missing.status)]}，必须填写原因`,
    );
  }
  payload.rows = list.map((r) => ({ studentId: r.studentId, status: Number(r.status), reason: r.reason || null }));

  entrySaving.value = true;
  try {
    const r = await saveAttendance(payload);
    ElMessage.success(`已保存：应到 ${r.shouldCount} / 实到 ${r.actualCount}（出勤率 ${r.attendanceRate}%）`);
    entryVisible.value = false;
    await Promise.all([loadList(), loadSummary()]);
  } finally {
    entrySaving.value = false;
  }
}

/* ============================================================
 * 导出（前端生成 CSV）
 * ============================================================ */
async function handleExport() {
  const list = await exportAttendance(baseParams());
  if (!list.length) return ElMessage.warning('没有可导出的数据');
  const head = ['日期', '部门', '班级', '教员', '班主任', '应到', '实到', '未到', '出勤率(%)'];
  const lines = list.map((r) => [
    r.attendanceDate,
    deptName(r.stage),
    r.className,
    r.teacherName ?? '',
    r.headTeacherName ?? '',
    r.shouldCount,
    r.actualCount,
    r.absentCount,
    r.attendanceRate,
  ]);
  const csv = [head, ...lines]
    .map((cols) => cols.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))
    .join('\r\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `出勤_${today()}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  ElMessage.success(`已导出 ${list.length} 条`);
}

const canWrite = computed(() => !isReadOnlyUser.value && availableStages.value.length > 0);
</script>

<template>
  <div class="ta-page">
    <!-- ===== 顶部：部门筛选 ===== -->
    <div class="ta-bar">
      <span class="ta-bar-title">出勤管理</span>
      <span class="ta-bar-tag">统一入口 · 三部门合一</span>
      <el-radio-group v-model="query.stage" size="small" class="ta-stage">
        <el-radio-button label="">全部</el-radio-button>
        <el-radio-button
          v-for="s in availableStages"
          :key="s"
          :label="s"
        >
          {{ deptName(s) }}
        </el-radio-button>
      </el-radio-group>
    </div>

    <!-- ===== 汇总卡片 ===== -->
    <div v-if="summary.length" class="ta-cards">
      <div v-for="s in summary" :key="s.stage" class="ta-card">
        <div class="ta-card-h">
          <span class="ta-card-stage">{{ deptName(s.stage) }}</span>
          <span class="ta-card-sub">{{ s.classCount }} 个班 · {{ s.totalRecords }} 条记录</span>
        </div>
        <div class="ta-card-b">
          <span class="ta-card-rate">{{ s.avgRate }}%</span>
          <span class="ta-card-label">平均出勤率</span>
        </div>
        <div class="ta-card-f">
          未达标（&lt;{{ s.targetRate }}%）<b>{{ s.unqualifiedCount }}</b> 条
        </div>
      </div>
    </div>

    <!-- ===== 筛选区 ===== -->
    <div class="ta-filter">
      <el-select v-model="query.classId" placeholder="全部班级" clearable size="small" style="width: 200px">
        <el-option
          v-for="c in classSelectOptions"
          :key="c.stage + c.id"
          :label="c.stage === query.stage || !query.stage ? `[${deptName(c.stage)}] ${c.name}` : c.name"
          :value="c.id"
        />
      </el-select>
      <el-date-picker
        v-model="query.dateRange"
        type="daterange"
        size="small"
        value-format="YYYY-MM-DD"
        start-placeholder="开始日期"
        end-placeholder="结束日期"
        style="width: 260px"
      />
      <el-button size="small" type="primary" :icon="Search" @click="handleSearch">查询</el-button>
      <el-button size="small" :icon="Refresh" @click="handleReset">重置</el-button>
      <div class="ta-spacer" />
      <el-button size="small" :icon="Download" @click="handleExport">导出</el-button>
      <el-button v-if="canWrite" size="small" type="primary" :icon="EditPen" @click="openEntry()">
        录入出勤
      </el-button>
    </div>

    <!-- ===== 列表 ===== -->
    <el-table v-loading="loading" :data="rows" size="small" border stripe>
      <el-table-column type="index" label="序号" width="60" align="center" />
      <el-table-column prop="attendanceDate" label="日期" width="112" align="center" sortable />
      <el-table-column prop="stageName" label="部门" width="70" align="center">
        <template #default="{ row }">
          <el-tag size="small" effect="plain" :type="row.stage === 'jh' ? 'warning' : row.stage === 'class' ? 'primary' : 'success'">
            {{ deptName(row.stage) }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="className" label="班级" min-width="140" show-overflow-tooltip />
      <el-table-column prop="headTeacherName" label="班主任" width="100" align="center">
        <template #default="{ row }">{{ row.headTeacherName || '—' }}</template>
      </el-table-column>
      <el-table-column prop="teacherName" label="教员" width="100" align="center">
        <template #default="{ row }">{{ row.teacherName || '—' }}</template>
      </el-table-column>
      <el-table-column prop="shouldCount" label="应到" width="70" align="center" />
      <el-table-column prop="actualCount" label="实到" width="70" align="center" />
      <el-table-column prop="absentCount" label="未到" width="70" align="center" />
      <el-table-column label="出勤率" width="120" align="center">
        <template #default="{ row }">
          <span :class="row.attendanceRate < 90 ? 'ta-bad' : ''">{{ row.attendanceRate }}%</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="120" align="center" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" size="small" @click="openDetail(row)">详情</el-button>
          <el-button v-if="canWrite" link type="primary" size="small" @click="openEntry(row)">修改</el-button>
        </template>
      </el-table-column>
      <template #empty>
        <el-empty description="没有出勤记录（换个部门或日期试试）" />
      </template>
    </el-table>

    <div class="ta-pager">
      <el-pagination
        v-model:current-page="page.page"
        v-model:page-size="page.size"
        :total="page.total"
        :page-sizes="[20, 50, 100]"
        layout="total, sizes, prev, pager, next"
        background
        small
        @current-change="loadList"
        @size-change="handleSearch"
      />
    </div>

    <!-- ===== 详情弹窗 ===== -->
    <el-dialog
      v-model="detailVisible"
      :title="detail ? `出勤详情（本班 ${detail.details.length} 人）` : '出勤详情'"
      width="720px"
    >
      <div v-loading="detailLoading">
        <template v-if="detail">
          <el-descriptions :column="3" size="small" border>
            <el-descriptions-item label="部门">{{ deptName(detail.record.stage) }}</el-descriptions-item>
            <el-descriptions-item label="班级">{{ detail.record.className }}</el-descriptions-item>
            <el-descriptions-item label="日期">{{ detail.record.attendanceDate }}</el-descriptions-item>
            <el-descriptions-item label="应到">{{ detail.record.shouldCount }}</el-descriptions-item>
            <el-descriptions-item label="实到">{{ detail.record.actualCount }}</el-descriptions-item>
            <el-descriptions-item label="出勤率">{{ detail.record.attendanceRate }}%</el-descriptions-item>
          </el-descriptions>
          <el-table :data="detail.details" size="small" border stripe class="ta-detail-table">
            <el-table-column type="index" label="#" width="50" align="center" />
            <el-table-column prop="studentNo" label="学号" width="120" />
            <el-table-column prop="studentName" label="姓名" width="100" />
            <el-table-column prop="statusName" label="状态" width="90" align="center">
              <template #default="{ row }">
                <el-tag size="small" effect="plain" :type="row.status === 1 ? 'success' : row.status === 3 ? 'warning' : 'danger'">
                  {{ row.statusName }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="reason" label="原因" min-width="160">
              <template #default="{ row }">{{ row.reason || '—' }}</template>
            </el-table-column>
          </el-table>
          <!-- ★ 2026-10-19：大学部已改为逐人登记，原来那条「只有缺勤名单」的提示不再成立，已删除 -->
        </template>
      </div>
    </el-dialog>

    <!-- ===== 录入弹窗 ===== -->
    <el-dialog v-model="entryVisible" title="录入 / 修改出勤" width="760px">
      <el-form :inline="true" size="small" class="ta-entry-form">
        <el-form-item label="部门">
          <el-select v-model="entry.stage" placeholder="选择部门" style="width: 110px">
            <el-option v-for="s in availableStages" :key="s" :label="deptName(s)" :value="s" />
          </el-select>
        </el-form-item>
        <el-form-item label="班级">
          <el-select v-model="entry.classId" placeholder="选择班级" filterable style="width: 200px">
            <el-option v-for="c in entryClassOptions" :key="c.id" :label="c.name" :value="c.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="日期">
          <el-date-picker v-model="entry.attendanceDate" type="date" value-format="YYYY-MM-DD" style="width: 150px" />
        </el-form-item>
      </el-form>

      <!-- 三个部门统一：按人登记（⚠️ 不要用裸 <template> 包，Vue 会当原生 template 渲染，内容不可见） -->
      <div v-loading="boardLoading">
        <div v-if="board" class="ta-board-tip">
          {{ board.className }} · {{ board.attendanceDate }} · 在班 {{ board.shouldCount }} 人
        </div>
        <el-table v-if="board" :data="board.rows" size="small" border stripe max-height="360">
          <el-table-column prop="studentNo" label="学号" width="120" />
          <el-table-column prop="studentName" label="姓名" width="100" />
          <el-table-column label="状态" width="130">
            <template #default="{ row }">
              <el-select v-model="row.status" size="small">
                <el-option v-for="(name, code) in UNIFIED_STATUS_NAME" :key="code" :label="name" :value="Number(code)" />
              </el-select>
            </template>
          </el-table-column>
          <el-table-column label="原因" min-width="180">
            <template #default="{ row }">
              <el-input
                v-model="row.reason"
                size="small"
                :disabled="![2, 5, 6, 7].includes(Number(row.status))"
                placeholder="缺勤 / 请假类必须填写"
              />
            </template>
          </el-table-column>
        </el-table>
        <el-empty v-else description="请选择部门与班级" />
      </div>

      <template #footer>
        <el-button size="small" @click="entryVisible = false">取消</el-button>
        <el-button size="small" type="primary" :loading="entrySaving" @click="submitEntry">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.ta-page {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ta-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border: 1px solid var(--el-border-color-lighter, #F1EAE5);
  border-radius: 8px;
  background: var(--el-fill-color-blank, #fff);
}
.ta-bar-title {
  font-size: 15px;
  font-weight: 500;
  color: var(--el-text-color-primary, #443432);
}
.ta-bar-tag {
  font-size: 12px;
  line-height: 18px;
  padding: 0 6px;
  border-radius: 4px;
  color: #B22A23;
  background: #F9E4E1;
}
.ta-stage {
  margin-left: auto;
}

.ta-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 10px;
}
.ta-card {
  border: 1px solid var(--el-border-color-lighter, #F1EAE5);
  border-radius: 8px;
  padding: 10px 14px;
  background: var(--el-fill-color-blank, #fff);
}
.ta-card-h {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.ta-card-stage {
  font-size: 14px;
  font-weight: 500;
  color: var(--el-text-color-primary, #443432);
}
.ta-card-sub {
  font-size: 12px;
  color: var(--el-text-color-secondary, #A2938E);
}
.ta-card-b {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 6px 0 4px;
}
.ta-card-rate {
  font-size: 22px;
  font-weight: 500;
  color: #0f6e56;
}
.ta-card-label {
  font-size: 12px;
  color: var(--el-text-color-secondary, #A2938E);
}
.ta-card-f {
  font-size: 12px;
  color: var(--el-text-color-secondary, #A2938E);
}

.ta-filter {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.ta-spacer {
  flex: 1;
}

.ta-bad {
  color: #8C201B;
  font-weight: 500;
}
.ta-pager {
  display: flex;
  justify-content: flex-end;
}
.ta-detail-table {
  margin-top: 10px;
}
.ta-detail-note,
.ta-entry-form {
  margin-top: 10px;
}
.ta-board-tip {
  font-size: 12px;
  color: var(--el-text-color-secondary, #A2938E);
  margin: 6px 0;
}
</style>
