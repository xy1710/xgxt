<script setup lang="ts">
/**
 * 系统设置页
 *
 * 四个页签：系统设置（KV）/ 楼栋设置 / 阶段方案 / 操作日志。
 *
 * ★ 楼栋设置（2026-10-16 新增）：宿舍楼栋字典，和「教学管理 → 宿舍管理」
 *   的楼栋下拉是同一份数据（sms_common.t_dorm_building）。
 *   这里加一栋 → 宿舍管理的楼栋下拉立刻多一项，不需要改任何代码。
 *
 * ★ 2026-10-20 楼栋设置抽成公共面板 `BuildingSettingPanel.vue`：
 *   独立的「教学管理 → 楼栋设置」页（/class-jh/building，单独授权给教务老师）
 *   与本页页签渲染**同一个组件**，不再复制两份逻辑。
 *
 * ★ 阶段方案（2026-10-16 由「阶段字典」升级）：
 *   一个方案 = 方案名称 + 所属部门 + N 个阶段（阶段名称 + 学制月数）；
 *   例：方案一 → 一阶段 学制2月 / 二阶段 学制2月 / 三阶段 学制2月。
 *   班级新增/编辑里的「阶段方案 / 阶段」两个下拉即取这里的数据。
 */

import { ref, reactive, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Plus, Delete, Edit, Search, Refresh, SetUp } from '@element-plus/icons-vue';
import { DEPT_NAME } from 'shared-types/class-jh';
import type { ClassSetting, StageScheme, OpLog, OpLogListQuery, StageSchemeSavePayload } from 'shared-types/class-jh';
import {
  fetchSettingDetail,
  updateSetting,
  fetchStageSchemeList,
  addStageScheme,
  updateStageScheme,
  deleteStageScheme,
  fetchOpLogList,
} from '@/class-jh/api/setting';
import { dash, formatDateTime } from '@/class-jh/utils/format';
/** ★ 2026-10-20：楼栋设置抽成公共面板，系统设置页与独立「楼栋设置」页共用 */
import BuildingSettingPanel from '@/class-jh/components/setting/BuildingSettingPanel.vue';

const activeTab = ref('setting');

/* ================= 系统设置 ================= */
const settingLoading = ref(false);
const settingList = ref<ClassSetting[]>([]);
const settingSaving = ref(false);
/** 表单值（字符串归一化，保存时再转换类型） */
const settingValues = reactive<Record<string, string>>({});

/** 数字型设置键 */
const NUMBER_KEYS = ['attendanceTargetRate', 'feeRemindDays', 'feeUrgeWindowDays', 'refundThresholdAmount', 'closedClassIntakeTypes'];
/** 布尔型设置键 */
const BOOLEAN_KEYS = ['allowStudentAdd'];

async function loadSettings() {
  settingLoading.value = true;
  try {
    const list = await fetchSettingDetail();
    settingList.value = list;
    list.forEach((s) => {
      settingValues[s.settingKey] = s.settingValue ?? '';
    });
  } catch {
    /* 错误已统一处理 */
  } finally {
    settingLoading.value = false;
  }
}

function isNumberKey(key: string): boolean {
  return NUMBER_KEYS.includes(key);
}
function isBooleanKey(key: string): boolean {
  return BOOLEAN_KEYS.includes(key);
}

async function saveSettings() {
  settingSaving.value = true;
  try {
    const payload: Record<string, string | number | boolean> = {};
    settingList.value.forEach((s) => {
      const raw = settingValues[s.settingKey] ?? '';
      if (isBooleanKey(s.settingKey)) {
        payload[s.settingKey] = raw === 'true' || raw === '1';
      } else if (isNumberKey(s.settingKey)) {
        payload[s.settingKey] = Number(raw) || 0;
      } else {
        payload[s.settingKey] = String(raw);
      }
    });
    await updateSetting(payload);
    ElMessage.success('保存成功');
    loadSettings();
  } catch {
    /* 错误已统一处理 */
  } finally {
    settingSaving.value = false;
  }
}

/* ================= 阶段方案 ================= */
const schemeLoading = ref(false);
const schemeData = ref<StageScheme[]>([]);

async function loadSchemes() {
  schemeLoading.value = true;
  try {
    schemeData.value = await fetchStageSchemeList();
  } catch {
    /* 错误已统一处理 */
  } finally {
    schemeLoading.value = false;
  }
}

/** 弹窗里的一行阶段明细（学制未填时为 undefined，提交前校验） */
interface SchemeStageRow {
  stageName: string;
  studyMonths: number | undefined;
}

const schemeVisible = ref(false);
const schemeSubmitting = ref(false);
const schemeForm = reactive<{
  id: string | undefined;
  schemeName: string;
  deptCode: number;
  stages: SchemeStageRow[];
}>({
  id: undefined,
  schemeName: '',
  deptCode: 1,
  stages: [],
});

/** 打开弹窗：传 row = 编辑（回填方案与阶段明细），不传 = 新增 */
function openSchemeDialog(row?: StageScheme) {
  if (row) {
    schemeForm.id = row.id;
    schemeForm.schemeName = row.schemeName;
    schemeForm.deptCode = row.deptCode;
    schemeForm.stages = row.stages.length
      ? row.stages.map((s) => ({ stageName: s.stageName, studyMonths: s.studyMonths ?? undefined }))
      : [{ stageName: '', studyMonths: undefined }];
  } else {
    schemeForm.id = undefined;
    schemeForm.schemeName = '';
    schemeForm.deptCode = 1;
    schemeForm.stages = [{ stageName: '', studyMonths: undefined }];
  }
  schemeVisible.value = true;
}

/** 「添加阶段名称」：一个方案可以挂多个阶段 */
function addSchemeStage() {
  schemeForm.stages.push({ stageName: '', studyMonths: undefined });
}

function removeSchemeStage(index: number) {
  if (schemeForm.stages.length <= 1) return;
  schemeForm.stages.splice(index, 1);
}

async function submitScheme() {
  const schemeName = schemeForm.schemeName.trim();
  if (!schemeName) {
    ElMessage.warning('请填写方案名称');
    return;
  }
  if (!schemeForm.deptCode) {
    ElMessage.warning('请选择所属部门');
    return;
  }
  if (!schemeForm.stages.length) {
    ElMessage.warning('请至少添加一个阶段');
    return;
  }
  for (let i = 0; i < schemeForm.stages.length; i++) {
    const s = schemeForm.stages[i];
    if (!s.stageName?.trim()) {
      ElMessage.warning(`请填写第 ${i + 1} 个阶段的阶段名称`);
      return;
    }
    if (!s.studyMonths || s.studyMonths <= 0) {
      ElMessage.warning(`请填写第 ${i + 1} 个阶段的学制（月）`);
      return;
    }
  }

  const payload: StageSchemeSavePayload = {
    schemeName,
    deptCode: schemeForm.deptCode,
    stages: schemeForm.stages.map((s) => ({ stageName: s.stageName.trim(), studyMonths: Number(s.studyMonths) })),
  };

  schemeSubmitting.value = true;
  try {
    if (schemeForm.id) {
      await updateStageScheme(schemeForm.id, payload);
      ElMessage.success('保存成功');
    } else {
      await addStageScheme(payload);
      ElMessage.success('新增成功');
    }
    schemeVisible.value = false;
    loadSchemes();
  } catch {
    /* 错误已统一处理 */
  } finally {
    schemeSubmitting.value = false;
  }
}

async function handleDeleteScheme(row: StageScheme) {
  try {
    await ElMessageBox.confirm(
      `确定删除方案「${row.schemeName}」吗？（方案下已有班级 / 学生正在使用的阶段不可删）`,
      '删除确认',
      {
        type: 'warning',
        confirmButtonText: '确定删除',
        cancelButtonText: '取消',
      },
    );
  } catch {
    return;
  }
  try {
    await deleteStageScheme(row.id);
    ElMessage.success('删除成功');
    loadSchemes();
  } catch {
    /* 错误已统一处理 */
  }
}

/* ================= 操作日志 ================= */
const opLogLoading = ref(false);
const opLogData = ref<OpLog[]>([]);
const opLogTotal = ref(0);
const opLogQuery = reactive<OpLogListQuery & { page: number; size: number }>({
  page: 1,
  size: 20,
  bizType: undefined,
  startDate: undefined,
  endDate: undefined,
});

async function loadOpLog() {
  opLogLoading.value = true;
  try {
    const data = await fetchOpLogList(opLogQuery);
    opLogData.value = data.list;
    opLogTotal.value = data.total;
  } catch {
    /* 错误已统一处理 */
  } finally {
    opLogLoading.value = false;
  }
}

function resetOpLogQuery() {
  opLogQuery.page = 1;
  opLogQuery.size = 20;
  opLogQuery.bizType = undefined;
  opLogQuery.startDate = undefined;
  opLogQuery.endDate = undefined;
  loadOpLog();
}

onMounted(() => {
  loadSettings();
  loadSchemes();
  loadOpLog();
});
</script>

<template>
  <div class="page-container">
    <el-tabs v-model="activeTab" type="border-card">
      <!-- 系统设置 -->
      <el-tab-pane label="系统设置" name="setting">
        <div v-loading="settingLoading" class="setting-wrap">
          <el-form label-width="180px" class="setting-form">
            <el-form-item v-for="s in settingList" :key="s.settingKey" :label="s.settingName || s.settingKey">
              <el-switch
                v-if="isBooleanKey(s.settingKey)"
                :model-value="settingValues[s.settingKey] === 'true' || settingValues[s.settingKey] === '1'"
                @update:model-value="(v: string | number | boolean) => (settingValues[s.settingKey] = String(v))"
              />
              <el-input-number
                v-else-if="isNumberKey(s.settingKey)"
                :model-value="Number(settingValues[s.settingKey]) || 0"
                :min="0"
                style="width: 220px"
                @update:model-value="(v: number | undefined) => (settingValues[s.settingKey] = String(v ?? 0))"
              />
              <el-input v-else v-model="settingValues[s.settingKey]" style="width: 320px" />
              <el-text v-if="s.remark" type="info" size="small" class="ml12">{{ s.remark }}</el-text>
            </el-form-item>
          </el-form>
          <el-button v-readonly-hide type="primary" :icon="SetUp" :loading="settingSaving" @click="saveSettings">保存设置</el-button>
        </div>
      </el-tab-pane>

      <!-- 楼栋设置（公共面板：与独立「楼栋设置」页完全相同） -->
      <el-tab-pane label="楼栋设置" name="building">
        <BuildingSettingPanel />
      </el-tab-pane>

      <!-- 阶段方案（★ 2026-10-16 由「阶段字典」升级：一个方案可含多个阶段） -->
      <el-tab-pane label="阶段方案" name="stageScheme">
        <div class="toolbar">
          <el-button v-readonly-hide type="primary" :icon="Plus" @click="openSchemeDialog()">新增方案</el-button>
        </div>
        <el-table v-loading="schemeLoading" :data="schemeData" border stripe empty-text="暂无方案">
          <el-table-column type="index" label="序号" width="60" align="center" />
          <el-table-column prop="schemeName" label="方案名称" min-width="180" />
          <el-table-column label="所属部门" width="140">
            <template #default="{ row }">{{ DEPT_NAME[row.deptCode] || dash(row.deptCode) }}</template>
          </el-table-column>
          <el-table-column label="操作" width="150" align="center" fixed="right">
            <template #default="{ row }">
              <el-button v-readonly-hide link type="primary" size="small" :icon="Edit" @click="openSchemeDialog(row)">编辑</el-button>
              <el-button v-readonly-hide link type="danger" size="small" :icon="Delete" @click="handleDeleteScheme(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <!-- 操作日志 -->
      <el-tab-pane label="操作日志" name="opLog">
        <el-form :model="opLogQuery" inline class="mb12">
          <el-form-item label="业务类型">
            <el-input v-model="opLogQuery.bizType" placeholder="如 休学/退费" clearable style="width: 150px" @keyup.enter="loadOpLog" />
          </el-form-item>
          <el-form-item label="操作时间">
            <el-date-picker v-model="opLogQuery.startDate" type="date" value-format="YYYY-MM-DD" placeholder="开始" style="width: 140px" />
            <span class="sep">~</span>
            <el-date-picker v-model="opLogQuery.endDate" type="date" value-format="YYYY-MM-DD" placeholder="结束" style="width: 140px" />
          </el-form-item>
          <el-form-item>
            <el-button type="primary" :icon="Search" @click="loadOpLog">查询</el-button>
            <el-button :icon="Refresh" @click="resetOpLogQuery">重置</el-button>
          </el-form-item>
        </el-form>

        <el-table v-loading="opLogLoading" :data="opLogData" border stripe size="small" empty-text="暂无日志">
          <el-table-column type="index" label="序号" width="60" align="center" />
          <el-table-column label="操作时间" width="170">
            <template #default="{ row }">{{ formatDateTime(row.opTime) }}</template>
          </el-table-column>
          <el-table-column prop="module" label="模块" width="100">
            <template #default="{ row }">{{ dash(row.module) }}</template>
          </el-table-column>
          <el-table-column prop="bizType" label="业务类型" width="110" />
          <el-table-column label="操作人" width="110">
            <template #default="{ row }">{{ dash(row.opUserName) }}</template>
          </el-table-column>
          <el-table-column prop="opDesc" label="操作描述" min-width="240" show-overflow-tooltip />
        </el-table>

        <el-pagination
          v-model:current-page="opLogQuery.page"
          v-model:page-size="opLogQuery.size"
          :page-sizes="[10, 20, 50, 100]"
          :total="opLogTotal"
          layout="total, sizes, prev, pager, next"
          style="margin-top: 16px; justify-content: flex-end"
          @size-change="loadOpLog"
          @current-change="loadOpLog"
        />
      </el-tab-pane>
    </el-tabs>

    <!-- 新增 / 编辑方案（★ 一个方案可挂多个阶段） -->
    <el-dialog v-model="schemeVisible" :title="schemeForm.id ? '编辑方案' : '新增方案'" width="640px">
      <el-form :model="schemeForm" label-width="90px">
        <el-form-item label="方案名称" required>
          <el-input v-model="schemeForm.schemeName" maxlength="50" placeholder="如 方案一" />
        </el-form-item>
        <el-form-item label="所属部门" required>
          <el-select v-model="schemeForm.deptCode" style="width: 100%">
            <el-option v-for="(name, value) in DEPT_NAME" :key="value" :label="name" :value="Number(value)" />
          </el-select>
        </el-form-item>
        <el-form-item label="阶段明细" required>
          <div class="scheme-stages">
            <div v-for="(s, i) in schemeForm.stages" :key="i" class="scheme-stage-row">
              <span class="scheme-stage-row__no">{{ i + 1 }}</span>
              <el-input v-model="s.stageName" maxlength="50" placeholder="阶段名称，如 一阶段" class="scheme-stage-row__name" />
              <el-input-number
                v-model="s.studyMonths"
                :min="1"
                :max="120"
                controls-position="right"
                class="scheme-stage-row__months"
              />
              <span class="scheme-stage-row__unit">月</span>
              <el-button
                link
                type="danger"
                :icon="Delete"
                :disabled="schemeForm.stages.length <= 1"
                @click="removeSchemeStage(i)"
              >
                删除
              </el-button>
            </div>
            <el-button link type="primary" :icon="Plus" @click="addSchemeStage">添加阶段名称</el-button>
            <div class="scheme-stages__tip">
              一个方案可包含多个阶段，例：方案一 → 一阶段 · 学制2月 / 二阶段 · 学制2月 / 三阶段 · 学制2月
            </div>
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="schemeVisible = false">取消</el-button>
        <el-button v-readonly-hide type="primary" :loading="schemeSubmitting" @click="submitScheme">确定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.page-container {
  padding: 16px;
}
.setting-wrap {
  padding: 8px 0;
}
.setting-form {
  max-width: 720px;
}
.ml12 {
  margin-left: 12px;
}
.mb12 {
  margin-bottom: 12px;
}
.sep {
  margin: 0 6px;
}
.toolbar {
  margin-bottom: 12px;
}
/* 楼栋列表里「未配置 / 0」的弱化显示 */
.muted {
  color: #c0c4cc;
}
.ok {
  color: #303133;
}

/* 新增/编辑方案弹窗里的「阶段明细」 */
.scheme-stages {
  width: 100%;
}
.scheme-stage-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.scheme-stage-row__no {
  width: 20px;
  height: 20px;
  line-height: 20px;
  text-align: center;
  border-radius: 50%;
  background: #ecf5ff;
  color: #409eff;
  font-size: 12px;
  flex: none;
}
.scheme-stage-row__name {
  width: 220px;
}
.scheme-stage-row__months {
  width: 130px;
}
.scheme-stage-row__unit {
  color: #909399;
}
.scheme-stages__tip {
  margin-top: 6px;
  font-size: 12px;
  color: #909399;
  line-height: 1.6;
}
</style>
