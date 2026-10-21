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
  REPEAT_REASON_OPTIONS,
  REPEAT_REASON_OTHER,
  SCORE_FIELD_NAME,
  fetchScoreEntry,
  fetchScoreFormula,
  listScores,
  repeatScore,
  saveScores,
  scoreSummary,
  updateScore,
  type ScoreEntry,
  type ScoreFormula,
  type ScoreRow,
  type ScoreScopeItem,
  type ScoreSummaryItem,
  type TeachingStage,
} from '@/teaching/api/score';
import { listExams, type ExamRow } from '@/teaching/api/exam';
import { getClassOptions, type ClassOption } from '@/teaching/api/class';
import { stageVisible } from '@/teaching/access';
import { isReadOnlyUser } from '@/store/permission';

const STAGE_ORDER: TeachingStage[] = ['jh', 'class', 'job'];
/** ⚠️ 三套权限码写法都不同 */
const STAGE_LABEL: Record<TeachingStage, string> = { jh: '初高部', class: '大学部', job: '实训' };
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
const classOptions = ref<ClassOption[]>([]);

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
async function loadExams() {
  try {
    const r = await listExams({ size: 200 });
    examOptions.value = r.list || [];
  } catch {
    examOptions.value = [];
  }
}
/**
 * 末班弹窗的「交接到的班级」数据源
 *
 * ★ 用 /class/options（已结业的班后端已过滤），三学段一次取回；
 *   选哪个学段由前端按规则过滤 —— 初高只能初高、大学只能大学、实训全部。
 */
async function loadClassOptions() {
  try {
    classOptions.value = (await getClassOptions()) || [];
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
  query.examId = '';
  query.classId = '';
  query.keyword = '';
  handleSearch();
}

/**
 * 三个下拉「选完即查」，不用再点查询
 *
 * ★ 为什么用 setTimeout(0) 而不是直接调：
 *   切学段时 examId/classId 会被重置成 ''，两个 watcher 会同一拍各触发一次 →
 *   连发两个完全相同的请求。用 0 延迟把同一拍的多次触发压成一次。
 * ★ 学生姓名不走这里 —— 输入过程每敲一个字就查一次会把库打满，
 *   仍然必须回车或点「查询」。
 */
let autoTimer: number | null = null;
function autoSearch() {
  if (autoTimer !== null) window.clearTimeout(autoTimer);
  autoTimer = window.setTimeout(() => {
    autoTimer = null;
    page.page = 1;
    void loadList();
    void loadSummary();
  }, 0);
}

watch(
  () => query.stage,
  () => {
    query.examId = '';
    query.classId = '';
    autoSearch();
  },
);
watch([() => query.examId, () => query.classId], () => autoSearch());

onMounted(async () => {
  try {
    formulas.value = await fetchScoreFormula();
  } catch {
    formulas.value = null;
  }
  await Promise.all([loadExams(), loadClassOptions()]);
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
const entryExamOptions = computed(() =>
  entryStage.value ? examOptions.value.filter((e) => e.stage === entryStage.value) : [],
);
const entryClassOptions = computed(() => {
  const e = entryExamOptions.value.find((x) => x.id === entryForm.examId);
  if (!e) return [];
  return (e.classIds || []).map((id, i) => ({
    id,
    name: (e.classNames || '').split('、')[i] || id,
  }));
});
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
  } catch {
    entry.value = null;
  } finally {
    entryLoading.value = false;
  }
}

watch(() => [entryForm.stage, entryForm.examId, entryForm.classId], () => void loadEntry());

async function submitEntry() {
  if (!entry.value) return;
  const stage = entryStage.value as TeachingStage;
  if (!stage || !entryForm.examId) return ElMessage.warning('请选择部门与考试');

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

/* ================= 列表内联改备注 ================= */
/** 正在编辑备注的成绩行 id；null = 没在编辑 */
const remarkEditingId = ref<string | null>(null);
const remarkDraft = ref('');
const remarkSaving = ref(false);

function startRemarkEdit(row: ScoreRow) {
  if (!canWrite.value) return;
  remarkEditingId.value = row.id;
  remarkDraft.value = row.remark ?? '';
}

/**
 * 失焦 / 回车即保存
 *
 * ★ 只传 remark —— 后端据此只更新备注列，不会顺手重算综合成绩。
 */
async function commitRemark(row: ScoreRow) {
  if (remarkEditingId.value !== row.id) return;
  const next = remarkDraft.value.trim();
  remarkEditingId.value = null;
  if (next === (row.remark ?? '').trim()) return;
  remarkSaving.value = true;
  try {
    await updateScore({ stage: row.stage, id: row.id, remark: next || null });
    row.remark = next || null;
    ElMessage.success('备注已保存');
  } catch {
    /* 错误提示由 http 拦截器统一弹 */
  } finally {
    remarkSaving.value = false;
  }
}

/* ================= 编辑（改分数 / 结果 / 备注） ================= */
const editVisible = ref(false);
const editSaving = ref(false);
const editRow = ref<ScoreRow | null>(null);
const editForm = reactive({
  writtenScore: null as number | null,
  machineScore: null as number | null,
  interviewScore: null as number | null,
  otherScore: null as number | null,
  examResult: null as number | null,
  remark: '',
});

/** 某学段要填哪几项分数（由该学段的公式决定，和列表列头同一口径） */
function inputFieldsOf(stage: TeachingStage): string[] {
  const f = formulas.value?.[stage];
  if (!f) return ['written', 'machine', 'interview'];
  const used = new Set<string>();
  for (const p of [...(f.writtenAvg?.parts ?? []), ...f.total.parts]) used.add(p.field);
  return INPUT_FIELDS.filter((x) => used.has(x));
}
/** 该学段的「结果」默认怎么来：auto 按分数重判 / manual 老师手选 / action 由末班置值 */
function judgeModeOf(stage: TeachingStage): 'auto' | 'manual' | 'action' {
  return formulas.value?.[stage]?.judgeMode ?? 'auto';
}

const editFields = computed(() =>
  editRow.value ? inputFieldsOf(editRow.value.stage) : ['written', 'machine', 'interview'],
);
/**
 * 老师这次有没有动过「结果」下拉
 *
 * ★ 只在下拉真的改过时才把 examResult 发给后端。
 *   否则初高每次改分数都会把「上次的结果」当成手选值写回去，
 *   按满分比例自动重判就永久失效了。
 */
const editResultTouched = ref(false);

/** 结果下拉旁的说明（按学段口径，避免老师不知道「不选会怎样」） */
const judgeHint = computed(() => {
  const st = editRow.value?.stage;
  if (!st) return '';
  const mode = judgeModeOf(st);
  if (mode === 'auto') return '不选则按分数自动判定';
  if (mode === 'manual') return '老师手选';
  return '默认未判断';
});

function openEdit(row: ScoreRow) {
  editRow.value = row;
  editForm.writtenScore = row.writtenScore;
  editForm.machineScore = row.machineScore;
  editForm.interviewScore = row.interviewScore;
  editForm.otherScore = row.otherScore;
  editForm.examResult = row.examResult;
  editForm.remark = row.remark ?? '';
  editResultTouched.value = false;
  editVisible.value = true;
}

async function submitEdit() {
  const row = editRow.value;
  if (!row) return;
  const nums = [editForm.writtenScore, editForm.machineScore, editForm.interviewScore, editForm.otherScore];
  if (nums.some((v) => v !== null && v !== undefined && (Number(v) < 0 || Number(v) > 100))) {
    return ElMessage.warning('分数必须在 0 ~ 100 之间');
  }
  editSaving.value = true;
  try {
    await updateScore({
      stage: row.stage,
      id: row.id,
      writtenScore: editForm.writtenScore,
      machineScore: editForm.machineScore,
      interviewScore: editForm.interviewScore,
      otherScore: editForm.otherScore,
      // ★ 三个学段都能手改结果；只有真的改过才发（没改就让后端按原口径判定）
      ...(editResultTouched.value ? { examResult: editForm.examResult } : {}),
      remark: editForm.remark.trim() || null,
    });
    ElMessage.success('已保存');
    editVisible.value = false;
    await Promise.all([loadList(), loadSummary()]);
  } finally {
    editSaving.value = false;
  }
}

/* ================= 末班 ================= */
const repeatVisible = ref(false);
const repeatSaving = ref(false);
const repeatRow = ref<ScoreRow | null>(null);
const repeatForm = reactive({
  targetStage: '' as '' | TeachingStage,
  targetClassId: '',
  repeatDate: '',
  reason: '',
  otherReason: '',
  shortcoming: '',
});

/** 今天（本地时区，不能用 toISOString —— 那是 UTC，凌晨会差一天） */
function todayStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 末班可选的目标班级（按学段规则过滤）
 *
 * 初高 → 只能初高班；大学 → 只能大学班；实训 → 三学段任意班。
 * 同时排除「该生当前所在班」，否则后端会以「无需末班」拒掉。
 *
 * ⚠️ 就业部（emp）已并入班级学段枚举，但就业部不办末班 —— 这里显式排除掉，
 *    顺便把类型收窄回 TeachingStage（下游 STAGE_LABEL 只认三个学段）。
 */
type RepeatClassOption = Omit<ClassOption, 'stage'> & { stage: TeachingStage };

const repeatClassOptions = computed<RepeatClassOption[]>(() => {
  const row = repeatRow.value;
  if (!row) return [];
  const allow: TeachingStage[] = row.stage === 'jh' ? ['jh'] : row.stage === 'class' ? ['class'] : ['jh', 'class', 'job'];
  return classOptions.value.filter(
    (c): c is RepeatClassOption => c.stage !== 'emp' && allow.includes(c.stage) && c.classId !== row.classId,
  );
});

/** 按学段分组的选项（实训能看到三个学段，分组才不会混在一起） */
const repeatClassGroups = computed(() => {
  const map = new Map<TeachingStage, RepeatClassOption[]>();
  for (const c of repeatClassOptions.value) {
    const list = map.get(c.stage) || [];
    list.push(c);
    map.set(c.stage, list);
  }
  return [...map.entries()].map(([stage, list]) => ({ stage, label: STAGE_LABEL[stage], list }));
});

/** 选「其他」时必须手填原因 */
const needCustomReason = computed(() => repeatForm.reason === REPEAT_REASON_OTHER);

function openRepeat(row: ScoreRow) {
  if (row.examResult !== 2) {
    return ElMessage.warning('只有结果为「未通过」的学生才能末班');
  }
  repeatRow.value = row;
  repeatForm.targetStage = '';
  repeatForm.targetClassId = '';
  repeatForm.repeatDate = todayStr();
  repeatForm.reason = REPEAT_REASON_OPTIONS[0];
  repeatForm.otherReason = '';
  repeatForm.shortcoming = '';
  repeatVisible.value = true;
}

/** 选班级时顺带把学段带出来（后端要按学段去对应的库查班级） */
function onRepeatClassChange(classId: string) {
  const hit = repeatClassOptions.value.find((c) => c.classId === classId);
  repeatForm.targetStage = hit ? hit.stage : '';
}

async function submitRepeat() {
  const row = repeatRow.value;
  if (!row) return;
  if (!repeatForm.targetClassId || !repeatForm.targetStage) return ElMessage.warning('请选择交接到的班级');
  if (!repeatForm.repeatDate) return ElMessage.warning('请选择末班日期');
  const reason = needCustomReason.value ? repeatForm.otherReason.trim() : repeatForm.reason;
  if (!reason) return ElMessage.warning('请填写末班原因');

  repeatSaving.value = true;
  try {
    const r = await repeatScore({
      stage: row.stage,
      scoreId: row.id,
      targetStage: repeatForm.targetStage,
      targetClassId: repeatForm.targetClassId,
      repeatDate: repeatForm.repeatDate,
      repeatReason: reason,
      shortcoming: repeatForm.shortcoming.trim() || undefined,
    });
    ElMessage.success(
      `已末班：${r.fromClassName || '无班级'} → ${r.toClassName}（累计第 ${r.repeatCount} 次）`,
    );
    repeatVisible.value = false;
    await Promise.all([loadList(), loadSummary()]);
  } finally {
    repeatSaving.value = false;
  }
}
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
          <span class="ts-card-stage">{{ s.stageName }}</span>
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
      <!-- ★ 2026-10-19：两个下拉都补了显式的「全部」项，并且选完即查（不用再点查询） -->
      <el-select
        v-model="query.examId"
        placeholder="全部考试"
        clearable
        filterable
        size="small"
        style="width: 220px"
      >
        <el-option label="全部考试" value="" />
        <el-option
          v-for="e in examSelectOptions"
          :key="e.id"
          :label="query.stage ? e.examName : `[${e.stageName}] ${e.examName}`"
          :value="e.id"
        />
      </el-select>
      <el-select
        v-model="query.classId"
        placeholder="全部班级"
        clearable
        filterable
        size="small"
        style="width: 180px"
      >
        <el-option label="全部班级" value="" />
        <el-option v-for="c in classSelectOptions" :key="c.id" :label="c.name" :value="c.id" />
      </el-select>
      <!-- ★ 姓名不自动查：输入过程中每敲一个字就查会打满库，仍走回车 / 查询按钮 -->
      <el-input
        v-model="query.keyword"
        placeholder="学生姓名（回车查询）"
        clearable
        size="small"
        style="width: 170px"
        @keyup.enter="handleSearch"
      />
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
            {{ row.stageName }}
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
      <el-table-column prop="examResultName" label="结果" width="90" align="center">
        <template #default="{ row }">
          <el-tag v-if="row.examResult" size="small" :type="row.examResult === 1 ? 'success' : 'danger'" effect="plain">
            {{ row.examResultName }}
          </el-tag>
          <span v-else>—</span>
        </template>
      </el-table-column>
      <!-- ★ 2026-10-19 新增：备注列（班主任记录学生不足 / 问题所在，点一下就地改） -->
      <el-table-column label="备注" min-width="180">
        <template #default="{ row }">
          <el-input
            v-if="remarkEditingId === row.id"
            v-model="remarkDraft"
            size="small"
            maxlength="200"
            autofocus
            placeholder="记录学生不足 / 问题所在"
            @blur="commitRemark(row)"
            @keyup.enter="commitRemark(row)"
          />
          <span
            v-else
            class="ts-remark"
            :class="{ 'is-empty': !row.remark, 'is-readonly': !canWrite }"
            :title="row.remark || ''"
            @click="startRemarkEdit(row)"
          >
            {{ row.remark || (canWrite ? '点击填写' : '—') }}
          </span>
        </template>
      </el-table-column>
      <!-- ★ 2026-10-19 新增：功能列（编辑 / 末班） -->
      <el-table-column label="功能" width="130" fixed="right" align="center">
        <template #default="{ row }">
          <el-button link type="primary" size="small" :disabled="!canWrite" @click="openEdit(row)">编辑</el-button>
          <el-tooltip :disabled="row.examResult === 2" content="只有结果为「未通过」才能末班" placement="top">
            <span class="ts-tip-wrap">
              <el-button
                link
                type="danger"
                size="small"
                :disabled="!canWrite || row.examResult !== 2"
                @click="openRepeat(row)"
              >
                末班
              </el-button>
            </span>
          </el-tooltip>
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
        <el-form-item label="考试">
          <el-select v-model="entryForm.examId" placeholder="选择考试" filterable style="width: 240px">
            <el-option v-for="e in entryExamOptions" :key="e.id" :label="e.examName" :value="e.id" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="entryClassOptions.length > 1" label="班级">
          <el-select v-model="entryForm.classId" placeholder="选择班级" style="width: 180px">
            <el-option v-for="c in entryClassOptions" :key="c.id" :label="c.name" :value="c.id" />
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
              <el-input-number v-model="row.writtenScore" :min="0" :max="100" size="small" controls-position="right" style="width: 100px" />
            </template>
          </el-table-column>
          <el-table-column v-if="entryInputFields.includes('machine')" label="机试" width="110">
            <template #default="{ row }">
              <el-input-number v-model="row.machineScore" :min="0" :max="100" size="small" controls-position="right" style="width: 100px" />
            </template>
          </el-table-column>
          <el-table-column v-if="entryInputFields.includes('interview')" label="面试" width="110">
            <template #default="{ row }">
              <el-input-number v-model="row.interviewScore" :min="0" :max="100" size="small" controls-position="right" style="width: 100px" />
            </template>
          </el-table-column>
          <el-table-column v-if="entryInputFields.includes('other')" label="其他" width="110">
            <template #default="{ row }">
              <el-input-number v-model="row.otherScore" :min="0" :max="100" size="small" controls-position="right" style="width: 100px" />
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
        <el-empty v-else description="请选择部门与考试" />
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

    <!-- ★ 2026-10-19 新增：编辑（改分数 / 结果 / 备注） -->
    <el-dialog v-model="editVisible" title="编辑成绩" width="560px">
      <div v-if="editRow" class="ts-dialog-head">
        {{ editRow.studentNo }} · {{ editRow.studentName }} ·
        {{ editRow.className || '—' }} · {{ editRow.examName }}
      </div>
      <el-form label-width="90px" size="small">
        <el-form-item v-if="editFields.includes('written')" label="笔试">
          <el-input-number v-model="editForm.writtenScore" :min="0" :max="100" controls-position="right" style="width: 150px" />
        </el-form-item>
        <el-form-item v-if="editFields.includes('machine')" label="机试">
          <el-input-number v-model="editForm.machineScore" :min="0" :max="100" controls-position="right" style="width: 150px" />
        </el-form-item>
        <el-form-item v-if="editFields.includes('interview')" label="面试">
          <el-input-number v-model="editForm.interviewScore" :min="0" :max="100" controls-position="right" style="width: 150px" />
        </el-form-item>
        <el-form-item v-if="editFields.includes('other')" label="其他">
          <el-input-number v-model="editForm.otherScore" :min="0" :max="100" controls-position="right" style="width: 150px" />
        </el-form-item>
        <el-form-item label="结果">
          <div class="ts-field-col">
            <el-select
              v-model="editForm.examResult"
              placeholder="未判断"
              style="width: 150px"
              @change="editResultTouched = true"
            >
              <el-option v-for="(n, k) in EXAM_RESULT_NAME" :key="k" :label="n" :value="Number(k)" />
            </el-select>
            <span class="ts-field-hint">{{ judgeHint }}</span>
          </div>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="editForm.remark" type="textarea" :rows="3" maxlength="200" show-word-limit placeholder="记录学生不足 / 问题所在" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button size="small" @click="editVisible = false">取消</el-button>
        <el-button size="small" type="primary" :loading="editSaving" @click="submitEdit">保存</el-button>
      </template>
    </el-dialog>

    <!-- ★ 2026-10-19 新增：末班（转班重修） -->
    <el-dialog v-model="repeatVisible" title="末班（转班重修）" width="620px">
      <div v-if="repeatRow" class="ts-dialog-head">
        {{ repeatRow.studentNo }} · {{ repeatRow.studentName }} · {{ repeatRow.examName }} ·
        当前班级：{{ repeatRow.className || '—' }}
      </div>
      <el-form label-width="110px" size="small">
        <el-form-item label="交接到的班级" required>
          <el-select
            v-model="repeatForm.targetClassId"
            filterable
            placeholder="选择目标班级"
            style="width: 100%"
            @change="onRepeatClassChange"
          >
            <el-option-group v-for="g in repeatClassGroups" :key="g.stage" :label="g.label">
              <el-option v-for="c in g.list" :key="c.classId" :label="c.className" :value="c.classId" />
            </el-option-group>
          </el-select>
        </el-form-item>
        <el-form-item label="末班日期" required>
          <el-date-picker
            v-model="repeatForm.repeatDate"
            type="date"
            value-format="YYYY-MM-DD"
            :clearable="false"
            style="width: 180px"
          />
        </el-form-item>
        <el-form-item label="末班原因" required>
          <el-select v-model="repeatForm.reason" style="width: 240px">
            <el-option v-for="o in REPEAT_REASON_OPTIONS" :key="o" :label="o" :value="o" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="needCustomReason" label="原因说明" required>
          <el-input v-model="repeatForm.otherReason" maxlength="60" placeholder="请填写末班原因" />
        </el-form-item>
        <el-form-item label="学员不足说明">
          <el-input
            v-model="repeatForm.shortcoming"
            type="textarea"
            :rows="3"
            maxlength="200"
            show-word-limit
            placeholder="将同步写入成绩备注与学员档案"
          />
        </el-form-item>
      </el-form>
      <el-alert
        type="warning"
        :closable="false"
        show-icon
        title="末班后该生会立即转入目标班级，并在学生档案中留一条末班记录，累计末班次数 +1"
      />
      <template #footer>
        <el-button size="small" @click="repeatVisible = false">取消</el-button>
        <el-button size="small" type="danger" :loading="repeatSaving" @click="submitRepeat">确认末班</el-button>
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

/* ---- 2026-10-19 新增：备注列 / 功能列 / 弹窗标题行 ---- */
.ts-remark {
  display: inline-block;
  width: 100%;
  min-height: 20px;
  line-height: 20px;
  padding: 0 4px;
  border-radius: 4px;
  cursor: text;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--el-text-color-primary, #443432);
}
.ts-remark:hover {
  background: #fdf1ee;
}
.ts-remark.is-empty {
  color: var(--el-text-color-placeholder, #a2938e);
}
.ts-remark.is-readonly,
.ts-remark.is-readonly:hover {
  cursor: default;
  background: transparent;
}
.ts-tip-wrap {
  margin-left: 12px;
}
.ts-tip-wrap .el-button {
  margin-left: 0;
}
.ts-dialog-head {
  font-size: 12px;
  color: var(--el-text-color-secondary, #a2938e);
  margin-bottom: 12px;
}
.ts-field-col {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
}
.ts-field-hint {
  font-size: 12px;
  line-height: 16px;
  color: var(--el-text-color-secondary, #a2938e);
}
</style>
