<script setup lang="ts">
/**
 * 考试管理 · 统一页面（第 2 期）
 * ============================================================
 * 合并前：初高 320 行 / 大学 453 行 / 实训 436 行，三套独立页面。
 * 现在：一个页面 + 学段筛选器 + 一套接口（/api/teaching/exam/*）。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useBreadcrumbStageKey } from '@/store/breadcrumb';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Delete, EditPen, Plus, Refresh, Search } from '@element-plus/icons-vue';
import {
  deleteExam,
  EXAM_CONTENT_TYPE_NAME,
  EXAM_STATUS_NAME,
  EXAM_TYPE_NAME,
  fetchExamClassOptions,
  getExamDetail,
  listExams,
  saveExam,
  type ClassOption,
  type ExamDetail,
  type ExamListParams,
  type ExamRow,
  type TeachingStage,
} from '@/teaching/api/exam';
import { stageVisible } from '@/teaching/access';
import { isReadOnlyUser } from '@/store/permission';

const STAGE_ORDER: TeachingStage[] = ['jh', 'class', 'job'];
// ★ 2026-10-22 部门口径统一：对外只有「初高中 / 大学部 / 就业部」三个部门。
//   「实训」是就业部下的一个阶段（班级 dept_code=3），不是并列部门。
const STAGE_LABEL: Record<TeachingStage, string> = { jh: '初高部', class: '大学部', job: '就业部' };

const availableStages = computed(() => STAGE_ORDER.filter((s) => stageVisible('exam', s)));

const query = reactive({

  stage: '' as '' | TeachingStage,
  classId: '',
  examType: undefined as number | undefined,
  dateRange: [] as string[],
  keyword: '',
});

/* 面包屑第 4 级：当前正在查看的学段（筛选器变化时自动同步，页面卸载自动清空） */
useBreadcrumbStageKey(() => query.stage || '');
const page = reactive({ page: 1, size: 20, total: 0 });

const loading = ref(false);
const rows = ref<ExamRow[]>([]);
const classOptions = ref<ClassOption[]>([]);

const classSelectOptions = computed(() =>
  query.stage ? classOptions.value.filter((c) => c.stage === query.stage) : classOptions.value,
);

function baseParams(): ExamListParams {
  return {
    stage: (query.stage || undefined) as TeachingStage | undefined,
    classId: query.classId || undefined,
    examType: query.examType,
    startDate: query.dateRange?.[0] || undefined,
    endDate: query.dateRange?.[1] || undefined,
    keyword: query.keyword || undefined,
  };
}

async function loadList() {
  loading.value = true;
  try {
    const r = await listExams({ ...baseParams(), page: page.page, size: page.size });
    rows.value = r.list || [];
    page.total = r.total || 0;
  } catch {
    rows.value = [];
    page.total = 0;
  } finally {
    loading.value = false;
  }
}

async function loadClasses() {
  try {
    classOptions.value = (await fetchExamClassOptions()) || [];
  } catch {
    classOptions.value = [];
  }
}

function handleSearch() {
  page.page = 1;
  void loadList();
}
function handleReset() {
  query.stage = '';
  query.classId = '';
  query.examType = undefined;
  query.dateRange = [];
  query.keyword = '';
  handleSearch();
}

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
  await loadList();
});

/* ================= 详情 ================= */
const detailVisible = ref(false);
const detailLoading = ref(false);
const detail = ref<ExamDetail | null>(null);

async function openDetail(row: ExamRow) {
  detailVisible.value = true;
  detailLoading.value = true;
  detail.value = null;
  try {
    detail.value = await getExamDetail(row.stage, row.id);
  } finally {
    detailLoading.value = false;
  }
}

/* ================= 新增 / 编辑 ================= */
const formVisible = ref(false);
const saving = ref(false);
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const form = reactive({
  id: '' as string | undefined,
  stage: '' as '' | TeachingStage,
  classId: '',
  examName: '',
  examType: 1,
  /** 考试类型=其他(5) 时的自定义名称 */
  examTypeName: '',
  examDate: today(),
  contentTypes: [1] as number[],
  fullScores: {} as Record<string, number | undefined>,
  remark: '',
});

const formStage = computed<TeachingStage | ''>(
  () => form.stage || (availableStages.value.length === 1 ? availableStages.value[0] : ''),
);
const formClassOptions = computed(() =>
  formStage.value ? classOptions.value.filter((c) => c.stage === formStage.value) : [],
);

async function openForm(row?: ExamRow) {
  if (row) {
    const d = await getExamDetail(row.stage, row.id);
    form.id = row.id;
    form.stage = row.stage;
    form.classId = row.classIds[0] || '';
    form.examName = row.examName;
    form.examType = row.examType;
    form.examTypeName = row.examTypeCustom || '';
    form.examDate = row.examDate;
    form.contentTypes = (d.contents || []).map((c) => c.type);
    form.fullScores = {};
    for (const c of d.contents || []) form.fullScores[String(c.type)] = c.fullScore ?? undefined;
    form.remark = row.remark || '';
  } else {
    form.id = undefined;
    form.stage = (query.stage || (availableStages.value.length === 1 ? availableStages.value[0] : '')) as
      | TeachingStage
      | '';
    form.classId = query.classId || '';
    form.examName = '';
    form.examType = 1;
    form.examTypeName = '';
    form.examDate = today();
    form.contentTypes = [1];
    form.fullScores = {};
    form.remark = '';
  }
  formVisible.value = true;
}

async function submitForm() {
  const stage = formStage.value as TeachingStage;
  if (!stage) return ElMessage.warning('请选择部门');
  if (!form.examName.trim()) return ElMessage.warning('请填写考试名称');
  if (!form.classId) return ElMessage.warning('请选择班级');
  if (!form.contentTypes.length) return ElMessage.warning('请至少选择一个考试内容项');
  if (form.examType === 5 && !form.examTypeName.trim()) return ElMessage.warning('类型选择「其他」时必须填写具体类型名称');

  saving.value = true;
  try {
    await saveExam({
      stage,
      id: form.id,
      examName: form.examName.trim(),
      examType: form.examType,
      examTypeName: form.examType === 5 ? form.examTypeName.trim() : null,
      examDate: form.examDate,
      classIds: [form.classId],
      contents: form.contentTypes.map((t) => ({
        type: t,
        name: EXAM_CONTENT_TYPE_NAME[t],
        fullScore: form.fullScores[String(t)] ?? null,
      })),
      remark: form.remark || null,
    });
    ElMessage.success(form.id ? '考试已更新' : '考试已创建');
    formVisible.value = false;
    await loadList();
  } finally {
    saving.value = false;
  }
}

async function handleDelete(row: ExamRow) {
  await ElMessageBox.confirm(`确定删除考试「${row.examName}」吗？`, '删除确认', { type: 'warning' });
  await deleteExam(row.stage, row.id);
  ElMessage.success('已删除');
  await loadList();
}

const canWrite = computed(() => !isReadOnlyUser.value && availableStages.value.length > 0);
</script>

<template>
  <div class="te-page">
    <div class="te-bar">
      <span class="te-bar-title">考试管理</span>
      <span class="te-bar-tag">统一入口 · 三部门合一</span>
      <el-radio-group v-model="query.stage" size="small" class="te-stage">
        <el-radio-button label="">全部</el-radio-button>
        <el-radio-button v-for="s in availableStages" :key="s" :label="s">
          {{ STAGE_LABEL[s] }}
        </el-radio-button>
      </el-radio-group>
    </div>

    <div class="te-filter">
      <el-select v-model="query.classId" placeholder="全部班级" clearable size="small" style="width: 190px">
        <el-option
          v-for="c in classSelectOptions"
          :key="c.stage + c.id"
          :label="query.stage ? c.name : `[${c.stageName}] ${c.name}`"
          :value="c.id"
        />
      </el-select>
      <el-select v-model="query.examType" placeholder="全部类型" clearable size="small" style="width: 130px">
        <el-option v-for="(n, t) in EXAM_TYPE_NAME" :key="t" :label="n" :value="Number(t)" />
      </el-select>
      <el-date-picker
        v-model="query.dateRange"
        type="daterange"
        size="small"
        value-format="YYYY-MM-DD"
        start-placeholder="开始日期"
        end-placeholder="结束日期"
        style="width: 250px"
      />
      <el-input v-model="query.keyword" placeholder="考试名称" clearable size="small" style="width: 160px" />
      <el-button size="small" type="primary" :icon="Search" @click="handleSearch">查询</el-button>
      <el-button size="small" :icon="Refresh" @click="handleReset">重置</el-button>
      <div class="te-spacer" />
      <el-button v-if="canWrite" size="small" type="primary" :icon="Plus" @click="openForm()">新建考试</el-button>
    </div>

    <el-table v-loading="loading" :data="rows" size="small" border stripe>
      <el-table-column type="index" label="序号" width="60" align="center" />
      <el-table-column prop="examDate" label="日期" width="112" align="center" sortable />
      <el-table-column prop="stageName" label="部门" width="70" align="center">
        <template #default="{ row }">
          <el-tag size="small" effect="plain" :type="row.stage === 'jh' ? 'warning' : row.stage === 'class' ? 'primary' : 'success'">
            {{ row.stageName }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="examName" label="考试名称" min-width="180" show-overflow-tooltip />
      <el-table-column prop="examTypeName" label="类型" width="100" align="center" />
      <el-table-column prop="classNames" label="班级" min-width="150" show-overflow-tooltip />
      <el-table-column prop="contentNames" label="内容项" min-width="140" show-overflow-tooltip>
        <template #default="{ row }">{{ row.contentNames || '—' }}</template>
      </el-table-column>
      <el-table-column prop="statusName" label="状态" width="90" align="center">
        <template #default="{ row }">
          <el-tag size="small" :type="row.status === 1 ? 'info' : 'success'" effect="plain">
            {{ row.statusName }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="creatorName" label="创建人" width="100" align="center">
        <template #default="{ row }">{{ row.creatorName || '—' }}</template>
      </el-table-column>
      <el-table-column label="操作" width="130" align="center" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" size="small" @click="openDetail(row)">详情</el-button>
          <el-button v-if="canWrite" link type="primary" size="small" @click="openForm(row)">编辑</el-button>
          <el-button v-if="canWrite" link type="danger" size="small" @click="handleDelete(row)">删除</el-button>
        </template>
      </el-table-column>
      <template #empty>
        <el-empty description="没有考试记录（换个部门或日期试试）" />
      </template>
    </el-table>

    <div class="te-pager">
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

    <!-- 详情 -->
    <el-dialog v-model="detailVisible" title="考试详情" width="720px">
      <div v-loading="detailLoading">
        <template v-if="detail">
          <el-descriptions :column="3" size="small" border>
            <el-descriptions-item label="部门">{{ detail.record.stageName }}</el-descriptions-item>
            <el-descriptions-item label="考试名称">{{ detail.record.examName }}</el-descriptions-item>
            <el-descriptions-item label="类型">{{ detail.record.examTypeName }}</el-descriptions-item>
            <el-descriptions-item label="日期">{{ detail.record.examDate }}</el-descriptions-item>
            <el-descriptions-item label="班级">{{ detail.record.classNames }}</el-descriptions-item>
            <el-descriptions-item label="状态">{{ detail.record.statusName }}</el-descriptions-item>
          </el-descriptions>

          <div class="te-sec">考试内容项</div>
          <el-table :data="detail.contents" size="small" border>
            <el-table-column prop="name" label="内容项" width="120" />
            <el-table-column prop="fullScore" label="满分" width="100" align="center">
              <template #default="{ row }">{{ row.fullScore ?? '——' }}</template>
            </el-table-column>
            <template #empty>
              <span class="te-muted">实训考试不含满分设置</span>
            </template>
          </el-table>

          <div class="te-sec">自定义字段</div>
          <el-table :data="detail.fields" size="small" border>
            <el-table-column prop="name" label="字段" width="160" />
            <el-table-column prop="type" label="类型" width="120" />
            <template #empty>
              <span class="te-muted">该部门没有自定义字段</span>
            </template>
          </el-table>
        </template>
      </div>
    </el-dialog>

    <!-- 新增 / 编辑 -->
    <el-dialog v-model="formVisible" :title="form.id ? '编辑考试' : '新建考试'" width="680px">
      <el-form label-width="90px" size="small">
        <el-form-item label="部门">
          <el-select v-model="form.stage" placeholder="选择部门" style="width: 140px">
            <el-option v-for="s in availableStages" :key="s" :label="STAGE_LABEL[s]" :value="s" />
          </el-select>
        </el-form-item>
        <el-form-item label="班级">
          <el-select v-model="form.classId" placeholder="选择班级" filterable style="width: 260px">
            <el-option v-for="c in formClassOptions" :key="c.id" :label="c.name" :value="c.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="考试名称">
          <el-input v-model="form.examName" maxlength="100" show-word-limit style="width: 320px" />
        </el-form-item>
        <el-form-item label="考试类型">
          <el-select v-model="form.examType" style="width: 160px">
            <el-option v-for="(n, t) in EXAM_TYPE_NAME" :key="t" :label="n" :value="Number(t)" />
          </el-select>
        </el-form-item>
        <!-- ★ 选「其他」时给出可自由填写的输入框（落 exam_type_name） -->
        <el-form-item v-if="form.examType === 5" label="类型名称">
          <el-input
            v-model="form.examTypeName"
            maxlength="50"
            show-word-limit
            placeholder="请填写具体类型，如：期末补考 / 技能比武"
            style="width: 320px"
          />
        </el-form-item>
        <el-form-item label="考试日期">
          <el-date-picker v-model="form.examDate" type="date" value-format="YYYY-MM-DD" style="width: 160px" />
        </el-form-item>
        <el-form-item label="内容项">
          <el-checkbox-group v-model="form.contentTypes">
            <el-checkbox v-for="(n, t) in EXAM_CONTENT_TYPE_NAME" :key="t" :label="Number(t)">
              {{ n }}
            </el-checkbox>
          </el-checkbox-group>
        </el-form-item>
        <el-form-item v-if="form.contentTypes.length" label="满分设置">
          <div class="te-scores">
            <div v-for="t in form.contentTypes" :key="t" class="te-score-item">
              <span>{{ EXAM_CONTENT_TYPE_NAME[t] }}</span>
              <el-input-number v-model="form.fullScores[String(t)]" :min="0" :max="1000" size="small" controls-position="right" />
            </div>
          </div>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.remark" type="textarea" :rows="2" maxlength="500" show-word-limit />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button size="small" @click="formVisible = false">取消</el-button>
        <el-button size="small" type="primary" :loading="saving" @click="submitForm">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.te-page {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.te-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border: 1px solid var(--el-border-color-lighter, #F1EAE5);
  border-radius: 8px;
  background: var(--el-fill-color-blank, #fff);
}
.te-bar-title {
  font-size: 15px;
  font-weight: 500;
  color: var(--el-text-color-primary, #443432);
}
.te-bar-tag {
  font-size: 12px;
  line-height: 18px;
  padding: 0 6px;
  border-radius: 4px;
  color: #B22A23;
  background: #F9E4E1;
}
.te-stage {
  margin-left: auto;
}
.te-filter {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.te-spacer {
  flex: 1;
}
.te-pager {
  display: flex;
  justify-content: flex-end;
}
.te-sec {
  font-size: 13px;
  font-weight: 500;
  color: var(--el-text-color-primary, #443432);
  margin: 12px 0 6px;
}
.te-muted {
  color: var(--el-text-color-secondary, #A2938E);
  font-size: 12px;
}
.te-scores {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}
.te-score-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}
</style>
