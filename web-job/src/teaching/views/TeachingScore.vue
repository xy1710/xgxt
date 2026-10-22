<script setup lang="ts">
/**
 * 成绩管理 · 统一页面（第 2 期）
 * ============================================================
 * 合并前：初高 515 行 / 大学 625 行 / 实训 777 行，三套独立页面。
 *
 * ★ 本页最特别的一点：**要填哪几列由「成绩公式配置」决定**。
 *   初高是 4 项（笔试/机试/面试/其他）直接求和；
 *   大学只用 2 项（笔试/面试）加权；
 *   实训是 3 项 + 多一列「笔试均分」。
 *   所以列不是写死的，而是从后端 `/formula` 读出来渲染的 —— 这才是"配置化"。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useBreadcrumbStageKey } from '@/store/breadcrumb';
import { ElMessage } from 'element-plus';
import { EditPen, Refresh, Search } from '@element-plus/icons-vue';
import {
  EXAM_RESULT_NAME,
  SCORE_FIELD_NAME,
  fetchScoreEntry,
  fetchScoreFormula,
  listScores,
  saveScores,
  scoreSummary,
  type ScoreEntry,
  type ScoreFormula,
  type ScoreRow,
  type ScoreScopeItem,
  type ScoreSummaryItem,
  type TeachingStage,
} from '@/teaching/api/score';
import type { ClassOption, ExamRow } from '@/teaching/api/exam';
import { listScoreClasses, listScoreExamOptions } from '@/teaching/api/score';
import { listTransferTargets, transferStudentToClass, type TransferTarget } from '@/teaching/api/class';
import { stageVisible } from '@/teaching/access';
import { isReadOnlyUser } from '@/store/permission';

const STAGE_ORDER: TeachingStage[] = ['jh', 'class', 'job'];
/** ⚠️ 三套权限码写法都不同 */
const STAGE_LABEL: Record<TeachingStage, string> = { jh: '初高', class: '大学', job: '就业' };
/** 模板里 row.stage 是 any，直接索引会报 TS7053 */
const stageLabel = (s?: string | null): string => (s && STAGE_LABEL[s as TeachingStage]) || s || '';
/** 输入项的固定展示顺序 */
const INPUT_FIELDS = ['written', 'machine', 'interview', 'other'] as const;

const availableStages = computed(() => STAGE_ORDER.filter((s) => stageVisible('score', s)));

/* ================= 公式（决定列） ================= */
const formulas = ref<Record<TeachingStage, ScoreScopeItem> | null>(null);

/** 当前学段的公式；未选学段时取第一个可见学段 */
const curFormula = computed<ScoreScopeItem | null>(() => {
  if (!formulas.value) return null;
  const s = (query.stage || availableStages.value[0]) as TeachingStage | undefined;
  return s ? formulas.value[s] : null;
});

/** 该学段要展示的输入列（由公式 parts 推导） */
const inputFields = computed<string[]>(() => {
  const f = curFormula.value;
  if (!f) return ['written', 'machine', 'interview'];
  const used = new Set<string>();
  for (const p of [...(f.writtenAvg?.parts ?? []), ...f.total.parts]) used.add(p.field);
  return INPUT_FIELDS.filter((x) => used.has(x));
});

/** 是否显示「笔试均分」列（只有实训有） */
const showWrittenAvg = computed(() => !!curFormula.value?.writtenAvg);

/** 口径说明文案 */
const formulaText = computed(() => {
  const f = curFormula.value;
  if (!f) return '';
  const fmt = (fm: ScoreFormula) =>
    fm.parts.map((p) => `${SCORE_FIELD_NAME[p.field] ?? p.field}×${p.weight}`).join(' + ');
  const parts = [];
  if (f.writtenAvg) parts.push(`笔试均分 = ${fmt(f.writtenAvg)}`);
  parts.push(`综合成绩 = ${fmt(f.total)}`);
  if (f.passByRatio) parts.push(`总分 ≥ 满分×${f.passRatio} 判定通过`);
  else parts.push(f.total.missingAsZero ? '缺项按 0 计' : '缺项留空（不判通过）');
  return parts.join('；');
});

/* ================= 查询 ================= */
const query = reactive({

  stage: '' as '' | TeachingStage,
  examId: '',
  classId: '',
  keyword: '',
});

/* 面包屑第 4 级：当前正在查看的学段（筛选器变化时自动同步，页面卸载自动清空） */
useBreadcrumbStageKey(() => query.stage || '');
const page = reactive({ page: 1, size: 20, total: 0 });
const loading = ref(false);
const rows = ref<ScoreRow[]>([]);
const summary = ref<ScoreSummaryItem[]>([]);
const examOptions = ref<ExamRow[]>([]);

const examSelectOptions = computed(() =>
  query.stage ? examOptions.value.filter((e) => e.stage === query.stage) : examOptions.value,
);
const classSelectOptions = computed(() => {
  const set = new Map<string, string>();
  for (const e of examSelectOptions.value) {
    if (e.classIds?.length) set.set(e.classIds[0], e.classNames || e.classIds[0]);
  }
  return [...set.entries()].map(([id, name]) => ({ id, name }));
});

function baseParams() {
  return {
    stage: (query.stage || undefined) as TeachingStage | undefined,
    examId: query.examId || undefined,
    classId: query.classId || undefined,
    keyword: query.keyword || undefined,
  };
}

async function loadList() {
  loading.value = true;
  try {
    const r = await listScores({ ...baseParams(), page: page.page, size: page.size });
    rows.value = r.list || [];
    page.total = r.total || 0;
  } catch {
    rows.value = [];
    page.total = 0;
  } finally {
    loading.value = false;
  }
}
async function loadSummary() {
  try {
    summary.value = (await scoreSummary(baseParams())) || [];
  } catch {
    summary.value = [];
  }
}
async function loadEntryClasses() {
  try {
    allClassOptions.value = (await listScoreClasses()) || [];
  } catch {
    allClassOptions.value = [];
  }
}

async function loadExams() {
  try {
    examOptions.value = (await listScoreExamOptions()) || [];
  } catch {
    examOptions.value = [];
  }
}
function handleSearch() {
  page.page = 1;
  void loadList();
  void loadSummary();
}
function handleReset() {
  query.stage = '';
  query.examId = '';
  query.classId = '';
  query.keyword = '';
  handleSearch();
}

watch(
  () => query.stage,
  () => {
    query.examId = '';
    query.classId = '';
    handleSearch();
  },
);

onMounted(async () => {
  try {
    formulas.value = await fetchScoreFormula();
  } catch {
    formulas.value = null;
  }
  await Promise.all([loadExams(), loadEntryClasses()]);
  await Promise.all([loadList(), loadSummary()]);
});

/* ================= 录入 ================= */
const entryVisible = ref(false);
const entryLoading = ref(false);
const entrySaving = ref(false);
const entry = ref<ScoreEntry | null>(null);
const entryForm = reactive({ stage: '' as '' | TeachingStage, examId: '', classId: '' });

const entryStage = computed<TeachingStage | ''>(
  () => entryForm.stage || (availableStages.value.length === 1 ? availableStages.value[0] : ''),
);
const entryExamOptions = computed(() => {
  if (!entryStage.value) return [];
  const ofStage = examOptions.value.filter((e) => e.stage === entryStage.value);
  if (!entryForm.classId) return ofStage;
  return ofStage.filter((e) => (e.classIds || []).includes(entryForm.classId));
});
/* ★ 2026-10-20：班级下拉改为「本部门下我能看到的班」。
   原来是从「已选考试」的 classIds 反推 —— 一个老师带多个班时，
   考试没选就根本没有班级可选，选了考试也只能录它自带的那个班。 */
const allClassOptions = ref<ClassOption[]>([]);
const entryClassOptions = computed(() =>
  entryStage.value ? allClassOptions.value.filter((c) => c.stage === entryStage.value) : [],
);
/** ★ 各输入项的本场考试满分（来自考试内容项）；缺省时回落到综合满分，再不行给 1000 */

const entryCaps = ref<Record<string, number>>({});
const capOf = (field: string): number => entryCaps.value[field] ?? (entry.value?.fullTotal || 1000);

/** 录入弹窗用自己的公式（弹窗学段可能和查询学段不同） */
const entryFormula = computed<ScoreScopeItem | null>(() => {
  if (!formulas.value || !entryStage.value) return null;
  return formulas.value[entryStage.value as TeachingStage];
});
const entryInputFields = computed<string[]>(() => {
  const f = entryFormula.value;
  if (!f) return ['written', 'machine', 'interview'];
  const used = new Set<string>();
  for (const p of [...(f.writtenAvg?.parts ?? []), ...f.total.parts]) used.add(p.field);
  return INPUT_FIELDS.filter((x) => used.has(x));
});

/** 该学段的「结果」是不是老师手选（大学 = true） */
const entryManualJudge = computed(() => entryFormula.value?.judgeMode === 'manual');

function openEntry() {
  entry.value = null;
  entryForm.stage = (query.stage || (availableStages.value.length === 1 ? availableStages.value[0] : '')) as
    | TeachingStage
    | '';
  entryForm.examId = query.examId || '';
  entryForm.classId = query.classId || '';
  entryVisible.value = true;
  void loadEntry();
}

async function loadEntry() {
  if (!entryStage.value || !entryForm.examId) {
    entry.value = null;
    return;
  }
  entryLoading.value = true;
  try {
    entry.value = await fetchScoreEntry(
      entryStage.value as TeachingStage,
      entryForm.examId,
      entryForm.classId,
    );
    if (!entryForm.classId && entry.value.classId) entryForm.classId = entry.value.classId;
    /* ★ 分项满分由后端随 entry 一起返回（不用再调考试域接口，班主任会被 403） */
    entryCaps.value = entry.value.contentFullScore || {};
  } catch {
    entry.value = null;
  } finally {
    entryLoading.value = false;
  }
}

watch(() => [entryForm.stage, entryForm.examId, entryForm.classId], () => void loadEntry());

/* ★ 部门变了：班级/考试都属于旧部门，直接清空（避免拿旧班 id 录新部门的分） */
watch(
  () => entryForm.stage,
  () => {
    entryForm.classId = '';
    entryForm.examId = '';
    entry.value = null;
  },
);

/* ★ 班级变了：当前考试若不覆盖该班，清掉考试 */
watch(
  () => entryForm.classId,
  () => {
    if (!entryForm.examId) return;
    if (!entryExamOptions.value.some((e) => e.id === entryForm.examId)) entryForm.examId = '';
  },
);

/* ★ 直接选考试时，自动带出该考试的第一个班（考试覆盖多班时可再手动换） */
watch(
  () => entryForm.examId,
  (id) => {
    if (!id || entryForm.classId) return;
    const e = examOptions.value.find((x) => x.id === id);
    const first = e?.classIds?.[0];
    if (first) entryForm.classId = first;
  },
);

/* ================= 行操作：详情 / 编辑 / 末班 / 升班 ================= */
const rowDetail = ref<ScoreRow | null>(null);
const rowDetailVisible = ref(false);
function openRowDetail(row: ScoreRow) {
  rowDetail.value = row;
  rowDetailVisible.value = true;
}

/** 编辑：直接打开录入弹窗，定位到这条记录的班级+考试 */
function openRowEdit(row: ScoreRow) {
  entryForm.stage = row.stage;
  entryForm.examId = row.examId;
  entryForm.classId = row.classId || '';
  entryVisible.value = true;
  void loadEntry();
}

const xferVisible = ref(false);
const xferSaving = ref(false);
const xferMode = ref<'repeat' | 'promote'>('repeat');
const xferRow = ref<ScoreRow | null>(null);
const xferTargets = ref<TransferTarget[]>([]);
const xferTargetId = ref('');
const xferReason = ref('');
const xferLoading = ref(false);

async function openTransfer(row: ScoreRow, mode: 'repeat' | 'promote') {
  if (!row.classId) return ElMessage.warning('该记录没有班级，无法换班');
  xferRow.value = row;
  xferMode.value = mode;
  xferTargetId.value = '';
  xferReason.value = '';
  xferTargets.value = [];
  xferVisible.value = true;
  xferLoading.value = true;
  try {
    xferTargets.value = await listTransferTargets({
      stage: row.stage,
      fromClassId: row.classId,
      mode,
    });
  } catch {
    xferTargets.value = [];
  } finally {
    xferLoading.value = false;
  }
}

async function submitTransfer() {
  const row = xferRow.value;
  if (!row?.classId) return;
  if (!xferTargetId.value) return ElMessage.warning('请选择目标班级');
  const target = xferTargets.value.find((t) => t.id === xferTargetId.value);
  const label = xferMode.value === 'repeat' ? '末班' : '升班';
  xferSaving.value = true;
  try {
    const r = await transferStudentToClass({
      stage: row.stage,
      studentId: row.studentId,
      fromClassId: row.classId,
      toClassId: xferTargetId.value,
      mode: xferMode.value,
      reason: xferReason.value.trim() || null,
      examId: row.examId,
    });
    /**
     * ★ 2026-10-22：末班/升班改成「待接收」流程 ——
     *   这里只生成一张待接收单，**学生还没转班**；
     *   要等目标班班主任在「教学管理 → 待接收学员」点「接收」后才真正入班。
     */
    ElMessage.success(
      `${row.studentName} 的${label}申请已提交，等待「${r?.toClassName || target?.name || ''}」班主任接收`,
    );
    xferVisible.value = false;
    await Promise.all([loadList(), loadSummary()]);
  } finally {
    xferSaving.value = false;
  }
}

async function submitEntry() {
  if (!entry.value) return;
  const stage = entryStage.value as TeachingStage;
  if (!stage) return ElMessage.warning('请选择部门');
  if (!entryForm.classId) return ElMessage.warning('请选择班级');
  if (!entryForm.examId) return ElMessage.warning('请选择考试');

  const rowsPayload = entry.value.rows.map((r) => ({
    studentId: r.studentId,
    writtenScore: r.writtenScore,
    machineScore: r.machineScore,
    interviewScore: r.interviewScore,
    otherScore: r.otherScore,
    // 大学是「老师手选结果」；其它学段后端算/由动作设置，传了也会被忽略
    examResult: entryManualJudge.value ? (r.examResult ?? 1) : null,
    remark: r.remark,
  }));
  if (!rowsPayload.length) return ElMessage.warning('该班没有学生');

  const bad = rowsPayload.find((r) =>
    [r.writtenScore, r.machineScore, r.interviewScore, r.otherScore].some(
      (v) => v !== null && v !== undefined && (Number(v) < 0 || Number(v) > 100),
    ),
  );
  if (bad) return ElMessage.warning('分数必须在 0 ~ 100 之间');

  entrySaving.value = true;
  try {
    const r = await saveScores({ stage, examId: entryForm.examId, rows: rowsPayload });
    ElMessage.success(`已保存 ${r.saved} 条成绩（综合成绩由后端按本部门公式计算）`);
    entryVisible.value = false;
    await Promise.all([loadList(), loadSummary()]);
  } finally {
    entrySaving.value = false;
  }
}

const canWrite = computed(() => !isReadOnlyUser.value && availableStages.value.length > 0);
</script>

<template>
  <div class="ts-page">
    <div class="ts-bar">
      <span class="ts-bar-title">成绩管理</span>
      <span class="ts-bar-tag">统一入口 · 三部门合一</span>
      <el-radio-group v-model="query.stage" size="small" class="ts-stage">
        <el-radio-button label="">全部</el-radio-button>
        <el-radio-button v-for="s in availableStages" :key="s" :label="s">
          {{ STAGE_LABEL[s] }}
        </el-radio-button>
      </el-radio-group>
    </div>

    <!-- ★ 口径提示：列与算法都来自后端配置，这里把它显示出来 -->
    <el-alert
      v-if="formulaText"
      class="ts-formula"
      type="info"
      :closable="false"
      show-icon
      :title="`本部门口径：${formulaText}`"
    />

    <div v-if="summary.length" class="ts-cards">
      <div v-for="s in summary" :key="s.stage" class="ts-card">
        <div class="ts-card-h">
          <span class="ts-card-stage">{{ stageLabel(s.stage) }}</span>
          <span class="ts-card-sub">{{ s.enteredCount }}/{{ s.totalStudents }} 已录</span>
        </div>
        <div class="ts-card-b">
          <span class="ts-card-rate">{{ s.avgTotal }}</span>
          <span class="ts-card-label">平均综合分</span>
        </div>
        <div class="ts-card-f">
          通过 {{ s.passCount }} · 未通过 {{ s.failCount }} · 通过率 <b>{{ s.passRate }}%</b>
        </div>
      </div>
    </div>

    <div class="ts-filter">
      <el-select v-model="query.examId" placeholder="全部考试" clearable filterable size="small" style="width: 220px">
        <el-option
          v-for="e in examSelectOptions"
          :key="e.id"
          :label="query.stage ? e.examName : `[${STAGE_LABEL[e.stage]}] ${e.examName}`"
          :value="e.id"
        />
      </el-select>
      <el-select v-model="query.classId" placeholder="全部班级" clearable filterable size="small" style="width: 180px">
        <el-option v-for="c in classSelectOptions" :key="c.id" :label="c.name" :value="c.id" />
      </el-select>
      <el-input v-model="query.keyword" placeholder="学生姓名" clearable size="small" style="width: 150px" />
      <el-button size="small" type="primary" :icon="Search" @click="handleSearch">查询</el-button>
      <el-button size="small" :icon="Refresh" @click="handleReset">重置</el-button>
      <div class="ts-spacer" />
      <el-button v-if="canWrite" size="small" type="primary" :icon="EditPen" @click="openEntry">录入成绩</el-button>
    </div>

    <el-table v-loading="loading" :data="rows" size="small" border stripe>
      <el-table-column type="index" label="序号" width="60" align="center" />
      <el-table-column prop="stageName" label="部门" width="70" align="center">
        <template #default="{ row }">
          <el-tag size="small" effect="plain" :type="row.stage === 'jh' ? 'warning' : row.stage === 'class' ? 'primary' : 'success'">
            {{ stageLabel(row.stage) }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="studentNo" label="学号" width="120" />
      <el-table-column prop="studentName" label="姓名" width="100" />
      <el-table-column prop="className" label="班级" min-width="130" show-overflow-tooltip>
        <template #default="{ row }">{{ row.className || '—' }}</template>
      </el-table-column>
      <el-table-column prop="examName" label="考试" min-width="150" show-overflow-tooltip />
      <el-table-column v-if="inputFields.includes('written')" prop="writtenScore" label="笔试" width="80" align="center">
        <template #default="{ row }">{{ row.writtenScore ?? '—' }}</template>
      </el-table-column>
      <el-table-column v-if="inputFields.includes('machine')" prop="machineScore" label="机试" width="80" align="center">
        <template #default="{ row }">{{ row.machineScore ?? '—' }}</template>
      </el-table-column>
      <el-table-column v-if="inputFields.includes('interview')" prop="interviewScore" label="面试" width="80" align="center">
        <template #default="{ row }">{{ row.interviewScore ?? '—' }}</template>
      </el-table-column>
      <el-table-column v-if="inputFields.includes('other')" prop="otherScore" label="其他" width="80" align="center">
        <template #default="{ row }">{{ row.otherScore ?? '—' }}</template>
      </el-table-column>
      <el-table-column v-if="showWrittenAvg" prop="writtenAvg" label="笔试均分" width="90" align="center">
        <template #default="{ row }">{{ row.writtenAvg ?? '—' }}</template>
      </el-table-column>
      <el-table-column prop="totalScore" label="综合成绩" width="100" align="center" sortable>
        <template #default="{ row }">
          <b>{{ row.totalScore ?? '—' }}</b>
        </template>
      </el-table-column>
      <!-- ★ 2026-10-22 用户要求：列表不再显示「结果」列
           （通过/未通过由老师在「录入成绩」里手选，不再在列表里占一列）。
           ⚠️ 后端仍会存 exam_result（汇总统计、末班判定都要用），只是不展示。 -->
      <el-table-column label="操作" width="200" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" size="small" @click="openRowDetail(row)">详情</el-button>
          <el-button link type="primary" size="small" @click="openRowEdit(row)">编辑</el-button>
          <el-button link type="warning" size="small" :disabled="!row.classId" @click="openTransfer(row, 'repeat')">
            末班
          </el-button>
          <el-button link type="success" size="small" :disabled="!row.classId" @click="openTransfer(row, 'promote')">
            升班
          </el-button>
        </template>
      </el-table-column>
      <template #empty>
        <el-empty description="没有成绩记录（换个部门或考试试试）" />
      </template>
    </el-table>

    <div class="ts-pager">
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

    <el-dialog v-model="entryVisible" title="录入成绩" width="820px">
      <el-form :inline="true" size="small">
        <el-form-item label="部门">
          <el-select v-model="entryForm.stage" style="width: 110px">
            <el-option v-for="s in availableStages" :key="s" :label="STAGE_LABEL[s]" :value="s" />
          </el-select>
        </el-form-item>
        <el-form-item label="班级">
          <el-select v-model="entryForm.classId" placeholder="选择班级" filterable style="width: 180px">
            <el-option v-for="c in entryClassOptions" :key="c.id" :label="c.name" :value="c.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="考试">
          <el-select
            v-model="entryForm.examId"
            :placeholder="entryForm.classId ? '选择考试' : '先选班级（或直接选考试）'"
            filterable
            style="width: 240px"
          >
            <el-option v-for="e in entryExamOptions" :key="e.id" :label="e.examName" :value="e.id" />
          </el-select>
        </el-form-item>
      </el-form>

      <div v-loading="entryLoading">
        <div v-if="entry" class="ts-entry-tip">
          {{ entry.className }} · {{ entry.examName }} · 共 {{ entry.rows.length }} 人
          <span v-if="entry.fullTotal">· 满分 {{ entry.fullTotal }}</span>
        </div>
        <el-table v-if="entry" :data="entry.rows" size="small" border stripe max-height="380">
          <el-table-column prop="studentNo" label="学号" width="110" />
          <el-table-column prop="studentName" label="姓名" width="90" />
          <el-table-column v-if="entryInputFields.includes('written')" label="笔试" width="110">
            <template #default="{ row }">
              <el-input-number v-model="row.writtenScore" :min="0" :max="capOf('written')" size="small" controls-position="right" style="width: 100px" />
            </template>
          </el-table-column>
          <el-table-column v-if="entryInputFields.includes('machine')" label="机试" width="110">
            <template #default="{ row }">
              <el-input-number v-model="row.machineScore" :min="0" :max="capOf('machine')" size="small" controls-position="right" style="width: 100px" />
            </template>
          </el-table-column>
          <el-table-column v-if="entryInputFields.includes('interview')" label="面试" width="110">
            <template #default="{ row }">
              <el-input-number v-model="row.interviewScore" :min="0" :max="capOf('interview')" size="small" controls-position="right" style="width: 100px" />
            </template>
          </el-table-column>
          <el-table-column v-if="entryInputFields.includes('other')" label="其他" width="110">
            <template #default="{ row }">
              <el-input-number v-model="row.otherScore" :min="0" :max="capOf('other')" size="small" controls-position="right" style="width: 100px" />
            </template>
          </el-table-column>
          <el-table-column v-if="entryManualJudge" label="考试结果" width="120">
            <template #default="{ row }">
              <el-select v-model="row.examResult" size="small" placeholder="选择">
                <el-option v-for="(n, k) in EXAM_RESULT_NAME" :key="k" :label="n" :value="Number(k)" />
              </el-select>
            </template>
          </el-table-column>
          <el-table-column label="已录综合" width="90" align="center">
            <template #default="{ row }">{{ row.totalScore ?? '—' }}</template>
          </el-table-column>
        </el-table>
        <el-empty v-else description="请选择部门、班级与考试" />
        <el-alert
          v-if="entry"
          class="ts-entry-note"
          type="info"
          :closable="false"
          show-icon
          title="综合成绩由后端按本部门公式计算，保存后自动回填"
        />
      </div>

      <template #footer>
        <el-button size="small" @click="entryVisible = false">取消</el-button>
        <el-button size="small" type="primary" :loading="entrySaving" @click="submitEntry">保存</el-button>
      </template>
    </el-dialog>

    <!-- ===== 成绩行详情 ===== -->
    <el-dialog v-model="rowDetailVisible" title="成绩详情" width="560px">
      <el-descriptions v-if="rowDetail" :column="2" border size="small">
        <el-descriptions-item label="部门">{{ stageLabel(rowDetail.stage) }}</el-descriptions-item>
        <el-descriptions-item label="班级">{{ rowDetail.className || '—' }}</el-descriptions-item>
        <el-descriptions-item label="学号">{{ rowDetail.studentNo || '—' }}</el-descriptions-item>
        <el-descriptions-item label="姓名">{{ rowDetail.studentName || '—' }}</el-descriptions-item>
        <el-descriptions-item label="考试" :span="2">{{ rowDetail.examName || '—' }}</el-descriptions-item>
        <el-descriptions-item label="笔试">{{ rowDetail.writtenScore ?? '—' }}</el-descriptions-item>
        <el-descriptions-item label="机试">{{ rowDetail.machineScore ?? '—' }}</el-descriptions-item>
        <el-descriptions-item label="面试">{{ rowDetail.interviewScore ?? '—' }}</el-descriptions-item>
        <el-descriptions-item label="其他">{{ rowDetail.otherScore ?? '—' }}</el-descriptions-item>
        <el-descriptions-item label="综合成绩"><b>{{ rowDetail.totalScore ?? '—' }}</b></el-descriptions-item>
        <el-descriptions-item label="结果">{{ rowDetail.examResultName || '—' }}</el-descriptions-item>
        <el-descriptions-item label="备注" :span="2">{{ rowDetail.remark || '—' }}</el-descriptions-item>
      </el-descriptions>
      <template #footer>
        <el-button size="small" @click="rowDetailVisible = false">关闭</el-button>
      </template>
    </el-dialog>

    <!-- ===== 末班 / 升班（换班） ===== -->
    <el-dialog
      v-model="xferVisible"
      :title="xferMode === 'repeat' ? '末班（转班重修）' : '升班（跳班）'"
      width="520px"
    >
      <el-alert
        v-if="xferRow"
        type="info"
        :closable="false"
        show-icon
        :title="
          (xferMode === 'repeat'
            ? '末班：成绩不达标，转到进度相同或更慢的班重修（进度 = 班级阶段码）'
            : '升班：成绩达标，跳到进度更快的班') +
          '。提交后生成待接收单，**需目标班班主任在「待接收学员」点接收后才入班**' +
          '，换班后立即生效、不需对方接收。'
        "
        style="margin-bottom: 12px"
      />
      <el-form label-width="90px" size="small">
        <el-form-item label="学生">
          <span>{{ xferRow?.studentName || '—' }}（{{ xferRow?.studentNo || '—' }}）</span>
        </el-form-item>
        <el-form-item label="原班级">
          <span>{{ xferRow?.className || '—' }}</span>
        </el-form-item>
        <el-form-item label="目标班级" required>
          <el-select
            v-model="xferTargetId"
            :loading="xferLoading"
            filterable
            :placeholder="xferTargets.length ? '选择目标班级' : '没有符合进度条件的班级'"
            style="width: 100%"
          >
            <el-option
              v-for="t in xferTargets"
              :key="t.id"
              :label="`${t.name}${t.stageCode ? ' · 阶段' + t.stageCode : ''}`"
              :value="t.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="原因">
          <el-input
            v-model="xferReason"
            type="textarea"
            :rows="2"
            maxlength="200"
            show-word-limit
            :placeholder="xferMode === 'repeat' ? '如：本次考试不及格，转班重修' : '如：成绩优秀，跳班学习'"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button size="small" @click="xferVisible = false">取消</el-button>
        <el-button size="small" type="primary" :loading="xferSaving" @click="submitTransfer">确认换班</el-button>
      </template>
    </el-dialog>

  </div>
</template>

<style scoped>
.ts-page {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ts-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border: 1px solid var(--el-border-color-lighter, #F1EAE5);
  border-radius: 8px;
  background: var(--el-fill-color-blank, #fff);
}
.ts-bar-title {
  font-size: 15px;
  font-weight: 500;
  color: var(--el-text-color-primary, #443432);
}
.ts-bar-tag {
  font-size: 12px;
  line-height: 18px;
  padding: 0 6px;
  border-radius: 4px;
  color: #B22A23;
  background: #F9E4E1;
}
.ts-stage {
  margin-left: auto;
}
.ts-formula :deep(.el-alert__title) {
  font-size: 12px;
}
.ts-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 10px;
}
.ts-card {
  border: 1px solid var(--el-border-color-lighter, #F1EAE5);
  border-radius: 8px;
  padding: 10px 14px;
  background: var(--el-fill-color-blank, #fff);
}
.ts-card-h {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.ts-card-stage {
  font-size: 14px;
  font-weight: 500;
  color: var(--el-text-color-primary, #443432);
}
.ts-card-sub {
  font-size: 12px;
  color: var(--el-text-color-secondary, #A2938E);
}
.ts-card-b {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 6px 0 4px;
}
.ts-card-rate {
  font-size: 22px;
  font-weight: 500;
  color: #0f6e56;
}
.ts-card-label {
  font-size: 12px;
  color: var(--el-text-color-secondary, #A2938E);
}
.ts-card-f {
  font-size: 12px;
  color: var(--el-text-color-secondary, #A2938E);
}
.ts-filter {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.ts-spacer {
  flex: 1;
}
.ts-pager {
  display: flex;
  justify-content: flex-end;
}
.ts-entry-tip {
  font-size: 12px;
  color: var(--el-text-color-secondary, #A2938E);
  margin: 6px 0;
}
.ts-entry-note {
  margin-top: 10px;
}
</style>
