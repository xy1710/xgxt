<template>
  <div class="page-container">
    <!-- ============ 顶部统计 ============ -->
    <div class="stat-row">
      <div class="stat-card total">
        <div class="stat-num">{{ summary.total }}</div>
        <div class="stat-label">催费单总数</div>
      </div>
      <div class="stat-card pending">
        <div class="stat-num">{{ summary.pendingOnly }}</div>
        <div class="stat-label">待催缴</div>
      </div>
      <div class="stat-card calling">
        <div class="stat-num">{{ summary.calling }}</div>
        <div class="stat-label">催缴中</div>
      </div>
      <div class="stat-card ok">
        <div class="stat-num">{{ summary.done }}</div>
        <div class="stat-label">已缴清</div>
      </div>
      <div v-if="summary.overdue > 0" class="stat-card overdue">
        <div class="stat-num">{{ summary.overdue }}</div>
        <div class="stat-label">已逾期</div>
      </div>
    </div>

    <!-- ============ 搜索区 ============ -->
    <el-card shadow="never" class="search-card">
      <!-- ★ 2026-10-19：筛选全部「选完即查」（@change → handleSearch），不用再点查询 -->
      <el-form :model="query" inline>
        <el-form-item label="关键字">
          <el-input
            v-model="query.keyword"
            placeholder="学生姓名/学号/单号"
            clearable
            style="width: 180px"
            @keyup.enter="handleSearch"
            @clear="handleSearch"
          />
        </el-form-item>
        <el-form-item label="费用类别">
          <el-select v-model="query.feeType" placeholder="全部" clearable style="width: 120px" @change="handleSearch">
            <el-option
              v-for="(name, value) in FEE_CALL_CATEGORY_NAME"
              :key="value"
              :label="name"
              :value="Number(value)"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="催缴状态">
          <el-select v-model="query.callStatus" placeholder="全部" clearable style="width: 120px" @change="handleSearch">
            <el-option
              v-for="(name, value) in FEE_CALL_STATUS_NAME"
              :key="value"
              :label="name"
              :value="Number(value)"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="到期日期">
          <el-date-picker
            v-model="dateRange"
            type="daterange"
            range-separator="至"
            start-placeholder="开始"
            end-placeholder="结束"
            value-format="YYYY-MM-DD"
            style="width: 240px"
            @change="handleSearch"
          />
        </el-form-item>
        <el-form-item v-if="!isHeadTeacher">
          <el-checkbox v-model="query.onlyMine" @change="handleSearch">只看我发起的</el-checkbox>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :icon="Search" @click="handleSearch">查询</el-button>
          <el-button :icon="Refresh" @click="handleReset">重置</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <!-- ============ 表格 ============ -->
    <el-card shadow="never" class="table-card">
      <div class="toolbar">
        <el-button v-readonly-hide v-if="canInitiate" type="primary" :icon="Plus" @click="handleOpenCreate">
          发起催费
        </el-button>
        <span class="toolbar-tip">
          教务老师发起 → 系统自动发站内信通知班主任 → 班主任催缴并回填结果
          &nbsp;|&nbsp;
          ⚠️ 本模块只做催办，不收款（收费走财务模块）
        </span>
      </div>

      <el-table
        v-loading="loading"
        :data="tableData"
        border
        stripe
        style="width: 100%"
        empty-text="暂无催费单"
      >
        <el-table-column type="index" label="序号" width="60" align="center" />
        <el-table-column label="费用类别" width="100" align="center">
          <template #default="{ row }">
            <el-tag size="small" effect="plain">{{ row.feeTypeName }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="学生" min-width="130">
          <template #default="{ row }">
            <div>{{ row.studentName }}</div>
            <div class="sub-text">{{ row.studentNo }}</div>
          </template>
        </el-table-column>
        <el-table-column prop="className" label="班级" min-width="110" show-overflow-tooltip>
          <template #default="{ row }">{{ row.className || '—' }}</template>
        </el-table-column>
        <el-table-column label="应缴金额" width="110" align="right">
          <template #default="{ row }">
            <span v-if="row.feeAmountText" class="money">¥{{ row.feeAmountText }}</span>
            <span v-else class="sub-text">未填</span>
          </template>
        </el-table-column>
        <el-table-column label="到期时间" width="130" align="center">
          <template #default="{ row }">
            <span :class="{ 'overdue-text': row.overdue }">
              {{ row.dueDate }}
              <el-tag v-if="row.overdue" type="danger" size="small" effect="dark">逾期</el-tag>
            </span>
          </template>
        </el-table-column>
        <el-table-column prop="headTeacherName" label="班主任" width="95" align="center">
          <template #default="{ row }">{{ row.headTeacherName || '—' }}</template>
        </el-table-column>
        <el-table-column label="催缴状态" width="110" align="center">
          <template #default="{ row }">
            <el-tag :type="statusTagType(row.callStatus)" size="small">
              {{ row.callStatusName }}
            </el-tag>
            <div v-if="row.handleTime" class="sub-text">{{ row.handleTime }}</div>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="170" fixed="right" align="center">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="handleDetail(row)">
              详情
            </el-button>
            <el-button v-readonly-hide
              v-if="row.canHandle"
              link
              type="success"
              size="small"
              @click="handleOpenHandle(row)"
            >
              处理
            </el-button>
            <el-button v-readonly-hide
              v-if="canVoid(row)"
              link
              type="danger"
              size="small"
              @click="handleVoid(row)"
            >
              作废
            </el-button>
          </template>
        </el-table-column>
      </el-table>

      <div class="pager">
        <el-pagination
          v-model:current-page="query.page"
          v-model:page-size="query.size"
          :page-sizes="[10, 20, 50]"
          :total="total"
          layout="total, sizes, prev, pager, next, jumper"
          background
          @size-change="loadData"
          @current-change="loadData"
        />
      </div>
    </el-card>

    <!-- ============ 发起催费弹窗 ============ -->
    <el-dialog
      v-model="createVisible"
      title="发起催费"
      width="640px"
      :close-on-click-modal="false"
    >
      <el-form ref="formRef" :model="form" :rules="rules" label-width="110px">
        <el-form-item label="费用类别" prop="feeType">
          <el-radio-group v-model="form.feeType">
            <el-radio-button :value="2">住宿费</el-radio-button>
            <el-radio-button :value="4">保险费</el-radio-button>
            <el-radio-button :value="3">餐费</el-radio-button>
          </el-radio-group>
          <div class="tip-line">只有这三类（没有学费）</div>
        </el-form-item>

        <el-form-item label="选择学生" prop="studentId">
          <el-select
            v-model="form.studentId"
            placeholder="输入姓名或学号搜索"
            filterable
            remote
            :remote-method="searchStudents"
            :loading="studentLoading"
            style="width: 100%"
            @change="handleStudentChange"
          >
            <el-option
              v-for="s in studentOptions"
              :key="s.studentId"
              :label="`${s.studentName}（${s.studentNo}）${s.className || ''}`"
              :value="s.studentId"
            />
          </el-select>
        </el-form-item>

        <!-- 选中后展示学生快照 -->
        <template v-if="selectedStudent">
          <el-descriptions :column="2" border size="small" class="stu-box">
            <el-descriptions-item label="学号">
              {{ selectedStudent.studentNo }}
            </el-descriptions-item>
            <el-descriptions-item label="姓名">
              {{ selectedStudent.studentName }}
            </el-descriptions-item>
            <el-descriptions-item label="班级">
              {{ selectedStudent.className || '—' }}
            </el-descriptions-item>
            <el-descriptions-item label="部门">
              {{ selectedStudent.deptName || '—' }}
            </el-descriptions-item>
            <el-descriptions-item label="本人电话">
              {{ selectedStudent.phone || '—' }}
            </el-descriptions-item>
            <el-descriptions-item label="家长电话">
              {{ selectedStudent.parentPhone || '—' }}
            </el-descriptions-item>
            <el-descriptions-item label="班主任" :span="2">
              {{ selectedStudent.headTeacherName || '—' }}
              <span class="tip-inline">（发起后会自动通知 TA）</span>
            </el-descriptions-item>
          </el-descriptions>
        </template>

        <el-form-item label="应缴金额">
          <el-input-number
            v-model="form.feeAmountYuan"
            :min="0"
            :precision="2"
            :step="100"
            style="width: 200px"
          />
          <span class="unit">元</span>
          <div class="tip-line">选填；确定金额时填，不确定可留空</div>
        </el-form-item>

        <el-form-item label="到期时间" prop="dueDate">
          <el-date-picker
            v-model="form.dueDate"
            type="date"
            value-format="YYYY-MM-DD"
            placeholder="请选择"
            :disabled-date="disablePast"
            style="width: 100%"
          />
          <div class="tip-line">不能早于今天</div>
        </el-form-item>

        <el-form-item label="催缴说明">
          <el-input
            v-model="form.callReason"
            type="textarea"
            :rows="3"
            maxlength="500"
            show-word-limit
            placeholder="选填，如：本学期住宿费尚未缴纳"
          />
        </el-form-item>

        <el-form-item label="备注">
          <el-input
            v-model="form.remark"
            type="textarea"
            :rows="2"
            maxlength="500"
            show-word-limit
            placeholder="选填"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button v-readonly-hide @click="createVisible = false">取消</el-button>
        <el-button v-readonly-hide type="primary" :loading="saving" @click="handleSave">确认发起</el-button>
      </template>
    </el-dialog>

    <!-- ============ 处理催费弹窗 ============ -->
    <el-dialog v-model="handleVisible" title="处理催费单" width="560px">
      <template v-if="handleRow">
        <el-descriptions :column="2" border size="small" style="margin-bottom: 16px">
          <el-descriptions-item label="费用类别">
            {{ handleRow.feeTypeName }}
          </el-descriptions-item>
          <el-descriptions-item label="学生">
            {{ handleRow.studentName }}（{{ handleRow.studentNo }}）
          </el-descriptions-item>
          <el-descriptions-item label="应缴金额">
            <span v-if="handleRow.feeAmountText">¥{{ handleRow.feeAmountText }}</span>
            <span v-else>—</span>
          </el-descriptions-item>
          <el-descriptions-item label="学生电话">
            {{ handleRow.phone || '—' }}
          </el-descriptions-item>
          <el-descriptions-item label="家长电话">
            {{ handleRow.parentPhone || '—' }}
          </el-descriptions-item>
          <el-descriptions-item label="到期时间" :span="2">
            <span :class="{ 'overdue-text': handleRow.overdue }">{{ handleRow.dueDate }}</span>
          </el-descriptions-item>
          <el-descriptions-item v-if="handleRow.callReason" label="催缴说明" :span="2">
            {{ handleRow.callReason }}
          </el-descriptions-item>
        </el-descriptions>

        <el-form ref="handleFormRef" :model="handleForm" :rules="handleRules" label-width="110px">
          <el-form-item label="处理结果" prop="callStatus">
            <el-radio-group v-model="handleForm.callStatus">
              <el-radio-button :value="2">催缴中（已联系，等待缴纳）</el-radio-button>
              <el-radio-button :value="3">已缴清（费用已到账）</el-radio-button>
            </el-radio-group>
          </el-form-item>
          <el-form-item label="处理备注">
            <el-input
              v-model="handleForm.handleRemark"
              type="textarea"
              :rows="3"
              maxlength="500"
              show-word-limit
              placeholder="如：已电话联系家长，承诺本周内缴清"
            />
          </el-form-item>
        </el-form>
      </template>
      <template #footer>
        <el-button @click="handleVisible = false">取消</el-button>
        <el-button v-readonly-hide type="primary" :loading="handling" @click="handleSubmitHandle">
          确认提交
        </el-button>
      </template>
    </el-dialog>

    <!-- ============ 详情弹窗 ============ -->
    <el-dialog v-model="detailVisible" title="催费单详情" width="700px">
      <template v-if="detail">
        <el-descriptions :column="3" border size="small">
          <el-descriptions-item label="费用类别">{{ detail.feeTypeName }}</el-descriptions-item>
          <el-descriptions-item label="催缴状态">
            <el-tag :type="statusTagType(detail.callStatus)" size="small">
              {{ detail.callStatusName }}
            </el-tag>
          </el-descriptions-item>

          <el-descriptions-item label="学号">{{ detail.studentNo }}</el-descriptions-item>
          <el-descriptions-item label="姓名">{{ detail.studentName }}</el-descriptions-item>
          <el-descriptions-item label="班级">{{ detail.className || '—' }}</el-descriptions-item>

          <el-descriptions-item label="部门">{{ detail.deptName || '—' }}</el-descriptions-item>
          <el-descriptions-item label="班主任">
            {{ detail.headTeacherName || '—' }}
          </el-descriptions-item>
          <el-descriptions-item label="本人电话">{{ detail.phone || '—' }}</el-descriptions-item>

          <el-descriptions-item label="家长电话">
            {{ detail.parentPhone || '—' }}
          </el-descriptions-item>
          <el-descriptions-item label="应缴金额">
            <span v-if="detail.feeAmountText" class="money">¥{{ detail.feeAmountText }}</span>
            <span v-else>未填</span>
          </el-descriptions-item>
          <el-descriptions-item label="到期时间">
            <span :class="{ 'overdue-text': detail.overdue }">
              {{ detail.dueDate }}
              <el-tag v-if="detail.overdue" type="danger" size="small" effect="dark">逾期</el-tag>
            </span>
          </el-descriptions-item>

          <el-descriptions-item label="发起人">{{ detail.applicantName || '—' }}</el-descriptions-item>
          <el-descriptions-item label="发起时间">{{ detail.createTime }}</el-descriptions-item>
          <el-descriptions-item label="处理时间">
            {{ detail.handleTime || '—' }}
          </el-descriptions-item>

          <el-descriptions-item v-if="detail.callReason" label="催缴说明" :span="3">
            {{ detail.callReason }}
          </el-descriptions-item>
          <el-descriptions-item v-if="detail.handleRemark" label="处理备注" :span="3">
            {{ detail.handleRemark }}
          </el-descriptions-item>
          <el-descriptions-item v-if="detail.remark" label="备注" :span="3">
            {{ detail.remark }}
          </el-descriptions-item>
        </el-descriptions>

        <!-- 该生历史催费记录 -->
        <div class="log-title">该学生历史催费记录（{{ detail.history?.length || 0 }} 条）</div>
        <el-table
          v-if="detail.history?.length"
          :data="detail.history"
          size="small"
          border
          style="width: 100%"
        >
          <el-table-column prop="feeTypeName" label="类别" width="90" align="center" />
          <el-table-column prop="dueDate" label="到期时间" width="110" align="center" />
          <el-table-column label="状态" width="100" align="center">
            <template #default="{ row }">
              <el-tag :type="statusTagType(row.callStatus)" size="small">
                {{ row.callStatusName }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="createTime" label="发起时间" min-width="150" />
        </el-table>
        <div v-else class="sub-text" style="padding: 8px 0">该学生暂无其他催费记录</div>
      </template>

      <template #footer>
        <el-button @click="detailVisible = false">关闭</el-button>
        <el-button v-readonly-hide
          v-if="detail?.canHandle"
          type="primary"
          @click="handleOpenHandle(detail as any)"
        >
          处理
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { FormInstance, FormRules } from 'element-plus';
import { Search, Refresh, Plus } from '@element-plus/icons-vue';
import {
  FEE_CALL_CATEGORY_NAME,
  FEE_CALL_STATUS_NAME,
  FeeCallStatus,
  RoleCode,
} from 'shared-types';
import type {
  FeeCallListItem,
  FeeCallDetail,
  FeeCallStudentOption,
  FeeCallSummary,
} from 'shared-types';
import {
  fetchFeeCallList,
  fetchFeeCallDetail,
  fetchFeeCallStudentOptions,
  createFeeCall,
  handleFeeCall,
  voidFeeCall,
  fetchFeeCallSummary,
} from '@/api/feeCall';
import { isSuperTest, myRoles, canAct } from '@/store/permission';

/* ============ 权限 ============ */
/** 发起 = 教务老师（或管理员） */
const canInitiate = computed(
  () =>
    // ★ 万能测试号：业务验证用，全部放行
    // ★ 2026-10-07：叠加「权限树撤销」（取消「实训-催费管理·发起」后按钮消失）
    canAct(
      'job:feeCall:add',
      isSuperTest.value ||
        myRoles.value.includes(RoleCode.ACAD_STAFF) ||
        myRoles.value.includes(RoleCode.SYS_ADMIN),
    ),
);
/** 班主任视角（只看自己班，隐藏"只看我发起的"）
 *  ★ 2026-10-08：项目经理（实训阶段带班）同口径 —— 他看不到"只看我发起的"这个开关
 */
const isHeadTeacher = computed(
  () =>
    (myRoles.value.includes(RoleCode.TEACH_HEAD) ||
      myRoles.value.includes(RoleCode.PROJECT_MANAGER)) &&
    !canInitiate.value,
);
/** 作废：发起人本人 / 管理员 */
function canVoid(row: FeeCallListItem): boolean {
  if (row.callStatus === FeeCallStatus.PAID) return false;
  if (myRoles.value.includes(RoleCode.SYS_ADMIN)) return true;
  return false;
}

/* ============ 列表 ============ */
const loading = ref(false);
const tableData = ref<FeeCallListItem[]>([]);
const total = ref(0);
const dateRange = ref<[string, string] | null>(null);

const query = reactive({
  page: 1,
  size: 10,
  keyword: '',
  feeType: undefined as number | undefined,
  callStatus: undefined as number | undefined,
  onlyMine: false,
});

const summary = ref<FeeCallSummary>({
  total: 0,
  pending: 0,
  called: 0,
  done: 0,
  overdue: 0,
  pendingOnly: 0,
  calling: 0,
});

async function loadData() {
  loading.value = true;
  try {
    const res = await fetchFeeCallList({
      page: query.page,
      size: query.size,
      keyword: query.keyword || undefined,
      feeType: query.feeType,
      callStatus: query.callStatus,
      onlyMine: query.onlyMine || undefined,
      startDate: dateRange.value?.[0],
      endDate: dateRange.value?.[1],
    });
    tableData.value = res.list;
    total.value = res.total;
  } catch {
    /* 拦截器已提示 */
  } finally {
    loading.value = false;
  }
}

async function loadSummary() {
  try {
    summary.value = await fetchFeeCallSummary();
  } catch {
    /* ignore */
  }
}

function handleSearch() {
  query.page = 1;
  loadData();
}

function handleReset() {
  query.keyword = '';
  query.feeType = undefined;
  query.callStatus = undefined;
  query.onlyMine = false;
  dateRange.value = null;
  query.page = 1;
  loadData();
}

/* ============ 发起 ============ */
const createVisible = ref(false);
const saving = ref(false);
const formRef = ref<FormInstance>();
const studentLoading = ref(false);
const studentOptions = ref<FeeCallStudentOption[]>([]);
const selectedStudent = ref<FeeCallStudentOption | null>(null);

const form = reactive({
  feeType: 2,
  studentId: '',
  feeAmountYuan: undefined as number | undefined,
  dueDate: '',
  callReason: '',
  remark: '',
});

const rules: FormRules = {
  feeType: [{ required: true, message: '请选择费用类别', trigger: 'change' }],
  studentId: [{ required: true, message: '请选择学生', trigger: 'change' }],
  dueDate: [{ required: true, message: '请选择到期时间', trigger: 'change' }],
};

function disablePast(date: Date): boolean {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return date.getTime() < today.getTime();
}

async function searchStudents(keyword: string) {
  studentLoading.value = true;
  try {
    studentOptions.value = await fetchFeeCallStudentOptions({ keyword, limit: 50 });
  } catch {
    /* ignore */
  } finally {
    studentLoading.value = false;
  }
}

function handleStudentChange(id: string) {
  selectedStudent.value = studentOptions.value.find((s) => s.studentId === id) || null;
}

function handleOpenCreate() {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  form.feeType = 2;
  form.studentId = '';
  form.feeAmountYuan = undefined;
  form.dueDate = d.toISOString().slice(0, 10);
  form.callReason = '';
  form.remark = '';
  selectedStudent.value = null;
  studentOptions.value = [];
  createVisible.value = true;
  searchStudents('');
  formRef.value?.clearValidate();
}

async function handleSave() {
  await formRef.value?.validate(async (valid) => {
    if (!valid) return;
    saving.value = true;
    try {
      // ★ 金额：界面填"元"，接口传"分"（×100 取整，防浮点误差）
      const feeAmount =
        form.feeAmountYuan === undefined || form.feeAmountYuan === null
          ? null
          : Math.round(form.feeAmountYuan * 100);

      await createFeeCall({
        feeType: form.feeType,
        studentId: form.studentId,
        feeAmount,
        dueDate: form.dueDate,
        callReason: form.callReason || null,
        remark: form.remark || null,
      });
      ElMessage.success('已发起，已通知班主任');
      createVisible.value = false;
      loadData();
      loadSummary();
    } catch {
      /* 拦截器已提示 */
    } finally {
      saving.value = false;
    }
  });
}

/* ============ 处理 ============ */
const handleVisible = ref(false);
const handling = ref(false);
const handleRow = ref<FeeCallListItem | FeeCallDetail | null>(null);
const handleFormRef = ref<FormInstance>();

const handleForm = reactive({
  callStatus: 2,
  handleRemark: '',
});

const handleRules: FormRules = {
  callStatus: [{ required: true, message: '请选择处理结果', trigger: 'change' }],
};

function handleOpenHandle(row: FeeCallListItem | FeeCallDetail) {
  handleRow.value = row;
  handleForm.callStatus = row.callStatus === FeeCallStatus.PENDING ? 2 : row.callStatus;
  handleForm.handleRemark = (row as FeeCallDetail).handleRemark || '';
  handleVisible.value = true;
  handleFormRef.value?.clearValidate();
}

async function handleSubmitHandle() {
  await handleFormRef.value?.validate(async (valid) => {
    if (!valid || !handleRow.value) return;
    handling.value = true;
    try {
      await handleFeeCall({
        id: handleRow.value.id,
        callStatus: handleForm.callStatus,
        handleRemark: handleForm.handleRemark || null,
      });
      ElMessage.success(handleForm.callStatus === 3 ? '已标记为已缴清' : '已标记为催缴中');
      handleVisible.value = false;
      if (detailVisible.value && detail.value) await refreshDetail(detail.value.id);
      loadData();
      loadSummary();
    } catch {
      /* 拦截器已提示 */
    } finally {
      handling.value = false;
    }
  });
}

/* ============ 作废 ============ */
async function handleVoid(row: FeeCallListItem) {
  try {
    await ElMessageBox.confirm(
      `确认作废这张催费单？作废后不再显示在列表中。`,
      '作废确认',
      { type: 'warning', confirmButtonText: '确认作废', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  try {
    await voidFeeCall(row.id);
    ElMessage.success('已作废');
    loadData();
    loadSummary();
  } catch {
    /* 拦截器已提示 */
  }
}

/* ============ 详情 ============ */
const detailVisible = ref(false);
const detail = ref<FeeCallDetail | null>(null);

async function handleDetail(row: FeeCallListItem) {
  try {
    detail.value = await fetchFeeCallDetail(row.id);
    detailVisible.value = true;
  } catch {
    /* ignore */
  }
}

async function refreshDetail(id: string) {
  detail.value = await fetchFeeCallDetail(id);
}

/* ============ 展示辅助 ============ */
function statusTagType(status: number): 'info' | 'warning' | 'success' | 'danger' {
  switch (status) {
    case FeeCallStatus.PENDING:
      return 'danger';
    case FeeCallStatus.CALLING:
      return 'warning';
    case FeeCallStatus.PAID:
      return 'success';
    default:
      return 'info';
  }
}

onMounted(() => {
  loadData();
  loadSummary();
});
</script>

<style scoped>
.stat-row {
  display: flex;
  gap: 12px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.stat-card {
  flex: 1;
  min-width: 110px;
  background: #fff;
  border: 1px solid #F1EAE5;
  border-radius: 6px;
  padding: 14px 16px;
  border-left: 3px solid #CD3A33;
}
.stat-card.total {
  border-left-color: #CD3A33;
}
.stat-card.pending {
  border-left-color: #CD3A33;
}
.stat-card.calling {
  border-left-color: #C9852E;
}
.stat-card.ok {
  border-left-color: #5FA36F;
}
.stat-card.overdue {
  border-left-color: #CD3A33;
}
.stat-num {
  font-size: 22px;
  font-weight: 600;
  color: #443432;
  line-height: 1.3;
}
.stat-label {
  font-size: 12px;
  color: #A2938E;
  margin-top: 2px;
}
.search-card {
  margin-bottom: 12px;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.toolbar-tip {
  font-size: 12px;
  color: #A2938E;
  line-height: 1.6;
}
.sub-text {
  font-size: 12px;
  color: #A2938E;
  margin-top: 2px;
}
.money {
  color: #CD3A33;
  font-weight: 600;
}
.overdue-text {
  color: #CD3A33;
  font-weight: 600;
}
.pager {
  display: flex;
  justify-content: flex-end;
  margin-top: 14px;
}
.stu-box {
  margin: 4px 0 16px;
}
.tip-line {
  font-size: 12px;
  color: #A2938E;
  line-height: 1.6;
  margin-top: 4px;
}
.tip-inline {
  font-size: 12px;
  color: #A2938E;
}
.unit {
  margin-left: 8px;
  color: #7A6C67;
}
.log-title {
  font-weight: 600;
  font-size: 14px;
  margin: 18px 0 10px;
  color: #443432;
}
</style>
