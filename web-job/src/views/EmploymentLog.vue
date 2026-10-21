<script setup lang="ts">
/**
 * 就业日志
 *
 * 脑图 - 页面字段：姓名 / 有效简历投递 / 面试邀约 / 面试场次 / 面试时间 / 面试公司 / 面试情况
 * 脑图 - 操作：新建 / 编辑 / 详情 / 搜索·筛选
 */

import { ref, reactive, onMounted } from 'vue';
import { canAct } from '@/store/permission';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import { Search, Refresh, Plus } from '@element-plus/icons-vue';
import {
  fetchLogList,
  fetchLogDetail,
  addLog,
  updateLog,
  deleteLog,
  // ★ 2026-10-16：走业务路由自己的 /classes（就业老师才有权限；班级管理页的接口会 403）
  fetchLogClassOptions,
} from '@/api/employmentLog';
import type { JobClassOption } from 'shared-types';

const loading = ref(false);
const tableData = ref<any[]>([]);
const total = ref(0);

/** ★ 2026-10-16：班级下拉选项 */
const classOptions = ref<JobClassOption[]>([]);

async function loadClassOptions() {
  try {
    classOptions.value = await fetchLogClassOptions();
  } catch (e) {
    // request.ts 已统一提示
  }
}

const query = reactive<any>({
  page: 1,
  size: 20,
  studentName: '',
  classId: '',
  company: '',
  startDate: '',
  endDate: '',
});

async function loadData() {
  loading.value = true;
  try {
    const data = await fetchLogList(query);
    tableData.value = data.list;
    total.value = data.total;
  } catch (e) {
    console.error(e);
  } finally {
    loading.value = false;
  }
}

/**
 * ★ 2026-10-20：筛选条件只改 query，不自动查 —— 只有点「查询」才发请求。
 *   （班级下拉已去掉 @change，其它输入框本来就只有回车触发）
 */
function handleSearch() {
  query.page = 1;
  loadData();
}

/**
 * 重置 = 清空条件 + 回到第 1 页 + 重查。
 * 之所以这里还 loadData()：条件已清空、页码已归 1，若不同步重查，
 * 表里会留着上一次的筛选结果、和分页「第 1 页」对不上。
 * （它不是"自动查"——是用户主动点按钮触发的）
 */
function handleReset() {
  query.page = 1;
  query.studentName = '';
  query.classId = '';
  query.company = '';
  query.startDate = '';
  query.endDate = '';
  loadData();
}

/* ============ 详情 ============ */

const detailVisible = ref(false);
const detailLoading = ref(false);
const detail = ref<any>({});

async function handleDetail(row: any) {
  detailVisible.value = true;
  detailLoading.value = true;
  detail.value = {};
  try {
    detail.value = await fetchLogDetail(row.id);
  } catch (e) {
    console.error(e);
  } finally {
    detailLoading.value = false;
  }
}

/* ============ 新增 / 编辑 ============ */

const dialogVisible = ref(false);
const isEdit = ref(false);
const submitting = ref(false);
const formRef = ref<FormInstance>();

const defaultForm = {
  id: '',
  studentId: '',
  studentName: '',
  logDate: '',
  resumeCount: 0,
  interviewInvite: 0,
  interviewCount: 0,
  interviewTime: '',
  company: '',
  position: '',
  salary: undefined as number | undefined,
  interviewSituation: '',
};

const form = reactive({ ...defaultForm });

const rules: FormRules = {
  // ★ 2026-10-16：姓名改为可直接手填（原来是 el-select 从学生列表里选）
  studentName: [{ required: true, message: '请输入姓名', trigger: 'blur' }],
  logDate: [{ required: true, message: '请选择日志日期', trigger: 'change' }],
};

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function handleAdd() {
  isEdit.value = false;
  Object.assign(form, defaultForm, { logDate: todayStr() });
  dialogVisible.value = true;
}

async function handleEdit(row: any) {
  isEdit.value = true;
  try {
    const data = await fetchLogDetail(row.id);
    Object.assign(form, {
      id: data.id,
      studentId: data.studentId,
      studentName: data.studentName,
      logDate: data.logDate,
      resumeCount: data.resumeCount ?? 0,
      interviewInvite: data.interviewInvite ?? 0,
      interviewCount: data.interviewCount ?? 0,
      interviewTime: data.interviewTime || '',
      company: data.company || '',
      position: data.position || '',
      salary: data.salary,
      interviewSituation: data.interviewSituation || '',
    });
    dialogVisible.value = true;
  } catch (e) {
    console.error(e);
  }
}

async function handleSubmit() {
  const valid = await formRef.value?.validate().catch(() => false);
  if (!valid) return;

  submitting.value = true;
  try {
    const payload = {
      id: form.id,
      // ★ 2026-10-16：姓名手填 → studentId 不再必传；后端会按姓名尝试匹配学生
      studentId: form.studentId || undefined,
      studentName: form.studentName.trim(),
      logDate: form.logDate,
      resumeCount: Number(form.resumeCount) || 0,
      interviewInvite: Number(form.interviewInvite) || 0,
      interviewCount: Number(form.interviewCount) || 0,
      interviewTime: form.interviewTime || undefined,
      company: form.company || undefined,
      position: form.position || undefined,
      salary: form.salary || undefined,
      interviewSituation: form.interviewSituation || undefined,
    };
    if (isEdit.value) {
      await updateLog(payload as any);
      ElMessage.success('修改成功');
    } else {
      await addLog(payload as any);
      ElMessage.success('新增成功');
    }
    dialogVisible.value = false;
    loadData();
  } catch (e) {
    // 统一处理
  } finally {
    submitting.value = false;
  }
}

async function handleDelete(row: any) {
  try {
    await ElMessageBox.confirm(
      `确定删除「${row.studentName}」${row.logDate} 的就业日志吗？`,
      '删除确认',
      { type: 'warning', confirmButtonText: '确定删除', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  try {
    await deleteLog(row.id);
    ElMessage.success('删除成功');
    loadData();
  } catch (e) {
    // 统一处理
  }
}

function money(v?: number) {
  return v ? `¥${Number(v).toLocaleString()}` : '—';
}

onMounted(() => {
  loadData();
  loadClassOptions();
});
</script>

<template>
  <div class="page-container">
    <!-- ============ 搜索/筛选 ============ -->
    <el-card shadow="never" class="search-card">
      <el-form :model="query" inline>
        <el-form-item label="姓名">
          <el-input v-model="query.studentName" placeholder="请输入姓名" clearable style="width: 150px" @keyup.enter="handleSearch" />
        </el-form-item>
        <!-- ★ 2026-10-16：班级筛选下拉
             ★ 2026-10-20：去掉 @change —— 选完班级不再自动查，
               条件全部选好后点「查询」才生效（用户要求：必须点查询按钮才查询） -->
        <el-form-item label="班级">
          <el-select v-model="query.classId" clearable filterable placeholder="全部班级" style="width: 180px">
            <el-option v-for="c in classOptions" :key="c.id" :label="c.className" :value="c.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="面试公司">
          <el-input v-model="query.company" placeholder="请输入公司名称" clearable style="width: 170px" @keyup.enter="handleSearch" />
        </el-form-item>
        <el-form-item label="日志日期">
          <el-date-picker
            v-model="query.startDate"
            type="date"
            value-format="YYYY-MM-DD"
            placeholder="开始"
            style="width: 150px"
          />
          <span class="range-split">~</span>
          <el-date-picker
            v-model="query.endDate"
            type="date"
            value-format="YYYY-MM-DD"
            placeholder="结束"
            style="width: 150px"
          />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :icon="Search" @click="handleSearch">查询</el-button>
          <el-button :icon="Refresh" @click="handleReset">重置</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <!-- ============ 列表 ============ -->
    <el-card shadow="never" class="table-card">
      <div class="toolbar">
        <el-button v-if="canAct('job:employmentLog:add', true)" type="primary" :icon="Plus" @click="handleAdd">新建就业日志</el-button>
      </div>

      <el-table v-loading="loading" :data="tableData" border stripe style="width: 100%" empty-text="暂无就业日志">
        <el-table-column type="index" label="序号" width="60" align="center" />
        <el-table-column prop="studentName" label="姓名" width="100" />
        <el-table-column prop="studentNo" label="学号" width="130" />
        <el-table-column prop="className" label="班级" width="120">
          <template #default="{ row }">{{ row.className || '—' }}</template>
        </el-table-column>
        <el-table-column prop="logDate" label="日志日期" width="120" />
        <el-table-column label="有效简历投递" width="130" align="center">
          <template #default="{ row }">
            <span class="strong">{{ row.resumeCount }}</span>
          </template>
        </el-table-column>
        <el-table-column label="面试邀约" width="100" align="center">
          <template #default="{ row }">
            <el-tag v-if="row.interviewInvite > 0" size="small" type="warning" effect="plain">{{ row.interviewInvite }}</el-tag>
            <span v-else class="muted">0</span>
          </template>
        </el-table-column>
        <el-table-column prop="interviewCount" label="面试场次" width="100" align="center" />
        <el-table-column prop="interviewTime" label="面试时间" width="150">
          <template #default="{ row }">{{ row.interviewTime || '—' }}</template>
        </el-table-column>
        <el-table-column prop="company" label="面试公司" min-width="150">
          <template #default="{ row }">{{ row.company || '—' }}</template>
        </el-table-column>
        <el-table-column prop="interviewSituation" label="面试情况" min-width="180" show-overflow-tooltip>
          <template #default="{ row }">{{ row.interviewSituation || '—' }}</template>
        </el-table-column>
        <el-table-column label="操作" width="160" fixed="right" align="center">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="handleDetail(row)">详情</el-button>
            <!-- ★ 2026-10-07 行内写按钮也走权限树：后端总闸把 update/delete 都归 employmentLog:edit -->
            <el-button v-if="canAct('job:employmentLog:edit', true)" link type="primary" size="small" @click="handleEdit(row)">编辑</el-button>
            <el-button v-if="canAct('job:employmentLog:edit', true)" link type="danger" size="small" @click="handleDelete(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-pagination
        v-model:current-page="query.page"
        v-model:page-size="query.size"
        :page-sizes="[10, 20, 50, 100]"
        :total="total"
        layout="total, sizes, prev, pager, next, jumper"
        style="margin-top: 16px; justify-content: flex-end"
        @size-change="loadData"
        @current-change="loadData"
      />
    </el-card>

    <!-- ============ 新建 / 编辑 ============ -->
    <el-dialog v-model="dialogVisible" :title="isEdit ? '编辑就业日志' : '新建就业日志'" width="620px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="120px">
        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="姓名" prop="studentName">
              <el-input v-model="form.studentName" placeholder="请输入姓名" clearable maxlength="50" />
              <div class="field-hint">
                可直接手填；若姓名与学生库里某人完全一致，会自动关联其学号与班级
              </div>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="日志日期" prop="logDate">
              <el-date-picker v-model="form.logDate" type="date" value-format="YYYY-MM-DD" placeholder="选择日期" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="有效简历投递">
              <el-input-number v-model="form.resumeCount" :min="0" :max="999" controls-position="right" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="面试邀约">
              <el-input-number v-model="form.interviewInvite" :min="0" :max="999" controls-position="right" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="面试场次">
              <el-input-number v-model="form.interviewCount" :min="0" :max="999" controls-position="right" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="薪资（元/月）">
              <el-input-number v-model="form.salary" :min="0" :max="1000000" :step="500" controls-position="right" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="面试时间">
              <el-date-picker
                v-model="form.interviewTime"
                type="datetime"
                value-format="YYYY-MM-DD HH:mm"
                placeholder="选择面试时间"
                style="width: 100%"
              />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="面试公司">
              <el-input v-model="form.company" placeholder="如 字节跳动" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="岗位">
              <el-input v-model="form.position" placeholder="如 Java 开发工程师" />
            </el-form-item>
          </el-col>
          <el-col :span="24">
            <el-form-item label="面试情况">
              <el-input v-model="form.interviewSituation" type="textarea" :rows="3" placeholder="记录面试流程、技术问题、面试官反馈等" />
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>

      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="handleSubmit">确定</el-button>
      </template>
    </el-dialog>

    <!-- ============ 详情 ============ -->
    <el-drawer v-model="detailVisible" title="就业日志详情" size="560px">
      <div v-loading="detailLoading">
        <el-descriptions :column="2" border>
          <el-descriptions-item label="姓名">{{ detail.studentName || '—' }}</el-descriptions-item>
          <el-descriptions-item label="学号">{{ detail.studentNo || '—' }}</el-descriptions-item>
          <el-descriptions-item label="班级">{{ detail.className || '—' }}</el-descriptions-item>
          <el-descriptions-item label="日志日期">{{ detail.logDate || '—' }}</el-descriptions-item>
          <el-descriptions-item label="有效简历投递">{{ detail.resumeCount ?? '—' }}</el-descriptions-item>
          <el-descriptions-item label="面试邀约">{{ detail.interviewInvite ?? '—' }}</el-descriptions-item>
          <el-descriptions-item label="面试场次">{{ detail.interviewCount ?? '—' }}</el-descriptions-item>
          <el-descriptions-item label="岗位">{{ detail.position || '—' }}</el-descriptions-item>
          <el-descriptions-item label="面试时间">{{ detail.interviewTime || '—' }}</el-descriptions-item>
          <el-descriptions-item label="薪资">{{ money(detail.salary) }}</el-descriptions-item>
          <el-descriptions-item label="面试公司" :span="2">{{ detail.company || '—' }}</el-descriptions-item>
          <el-descriptions-item label="面试情况" :span="2">
            <div class="detail-text">{{ detail.interviewSituation || '—' }}</div>
          </el-descriptions-item>
        </el-descriptions>
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
.page-container {
  padding: 16px;
}

.search-card {
  margin-bottom: 12px;
}

.search-card :deep(.el-form-item) {
  margin-bottom: 0;
}

.range-split {
  margin: 0 6px;
  color: #A2938E;
}

/* ★ 2026-10-16 姓名手填的说明文字（el-form-item__content 是 flex，需占满一行） */
.field-hint {
  width: 100%;
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.5;
  color: #A2938E;
}

.strong {
  font-weight: 600;
  color: #CD3A33;
}

.muted {
  color: #C4B8B2;
}

.detail-text {
  white-space: pre-wrap;
  line-height: 1.7;
  color: #7A6C67;
}
</style>
