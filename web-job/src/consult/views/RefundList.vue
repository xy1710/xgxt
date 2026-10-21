<script setup lang="ts">
/**
 * 退费管理
 *
 * 流程：咨询师发起 → 经理审批 → 上报财务 → 财务打款 → 已退费
 * 规则：经理自审自批（自己发起直接进「待财务打款」）
 */

import { ref, onMounted, computed } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import type {
  ConsultRefundOrder,
  ConsultRefundStats,
  ConsultRefundCalcResult,
  ConsultStudentListItem,
} from 'shared-types/consult';
import { ConsultRefundStatus as CRS, CONSULT_REFUND_STATUS_NAME } from 'shared-types/consult';
import {
  fetchRefundList,
  fetchRefundStats,
  calcRefund,
  applyRefund,
  approveRefund,
  rejectRefund,
  fetchRefundPrefill,
  fetchStudentList,
} from '@/consult/api/consult';
import { useAuthStore } from '@/consult/stores/auth';

const auth = useAuthStore();

/* ---------- 列表 ---------- */
const loading = ref(false);
const list = ref<ConsultRefundOrder[]>([]);
const total = ref(0);

/** 分页总页数（原型 pager 里的「第 N/M 页」） */
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / (size.value || 20))));
const page = ref(1);
const size = ref(10);
const query = ref({ keyword: '', status: undefined as number | undefined });
const stats = ref<ConsultRefundStats | null>(null);

async function load() {
  loading.value = true;
  try {
    const [res, st] = await Promise.all([
      fetchRefundList({
        page: page.value,
        size: size.value,
        keyword: query.value.keyword || undefined,
        status: query.value.status,
      }),
      fetchRefundStats(),
    ]);
    list.value = res.list;
    total.value = res.total;
    stats.value = st;
  } finally {
    loading.value = false;
  }
}

function search() {
  page.value = 1;
  load();
}

function resetQuery() {
  query.value = { keyword: '', status: undefined };
  page.value = 1;
  load();
}

/* ---------- 发起退费 ---------- */
const applyVisible = ref(false);
const applyForm = ref({
  consultStudentId: '',
  trialStart: '',
  trialEnd: '',
  lossReason: '',
  remark: '',
  /** ★ 2026-10-08 消耗项多选：存勾选的 key（住宿/餐费/保险 + 物品），逐项参与计算 */
  deductItems: [] as string[],
});
const calcResult = ref<ConsultRefundCalcResult | null>(null);
const calcLoading = ref(false);

/** 可勾选的消耗项（住宿/餐费/保险 + 物品）
 *  ★ 2026-10-16 用户指令：取消「工具包」「宿舍门禁卡」，不再参与退费扣减 */
const DEDUCT_OPTIONS = [
  { key: 'accommodation', label: '住宿费 ¥15/天' },
  { key: 'meal', label: '餐费 ¥28/天' },
  { key: 'insurance', label: '保险费 ¥5/天' },
  { key: 'uniform', label: '校服 ¥120' },
  { key: 'bedding', label: '被褥三件套 ¥150' },
  { key: 'textbook', label: '教材资料 ¥60' },
  { key: 'military', label: '军训服 ¥90' },
];

/* ---------- 学生选择（★ 2026-10-08：必填项由「学生ID」改为「学生姓名」） ---------- */
const studentOptions = ref<Array<{ consultStudentId: string; studentName: string; consultStateName?: string }>>([]);
const studentSearching = ref(false);

/** 远程搜索学生（按姓名/学号模糊匹配），供下拉选择 */
async function searchStudents(keyword: string) {
  studentSearching.value = true;
  try {
    const res = await fetchStudentList({ page: 1, size: 20, keyword: keyword || undefined });
    studentOptions.value = res.list.map((s: ConsultStudentListItem) => ({
      consultStudentId: s.consultStudentId,
      studentName: s.studentName,
      consultStateName: s.consultStateName,
    }));
  } catch {
    studentOptions.value = [];
  } finally {
    studentSearching.value = false;
  }
}

function openApply(row?: ConsultRefundOrder) {
  applyForm.value = {
    consultStudentId: row?.consultStudentId || '',
    trialStart: '',
    trialEnd: '',
    lossReason: '',
    remark: '',
    // ★ 2026-10-08：消耗项全部非必填，默认一项都不勾；按实际消耗勾选后才计入扣减
    deductItems: [] as string[],
  };
  // 从行内带出学生：把该学生放进候选，保证下拉能显示姓名
  studentOptions.value = row?.consultStudentId
    ? [{ consultStudentId: row.consultStudentId, studentName: row.studentName }]
    : [];
  calcResult.value = null;
  applyVisible.value = true;
  if (row?.consultStudentId) onStudentChange();
}

/** 选中学生 → 自动预填试学开始日期和已到账金额 */
async function onStudentChange() {
  if (!applyForm.value.consultStudentId) return;
  try {
    const pre = await fetchRefundPrefill(applyForm.value.consultStudentId);
    if (pre.trialStart) applyForm.value.trialStart = pre.trialStart;
    if (!applyForm.value.trialEnd) {
      const d = new Date();
      const p = (n: number) => String(n).padStart(2, '0');
      applyForm.value.trialEnd = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    }
    doCalc();
  } catch {
    /* 学生不存在或试学费未到账，后端会提示 */
  }
}

/** 勾选的「物品」名称（住宿/餐费/保险是每日消耗项，走 dailyItems 传） */
function checkedItemNames(): string[] {
  const ITEM_KEYS = ['uniform', 'bedding', 'textbook', 'military'];
  return applyForm.value.deductItems
    .filter((k) => ITEM_KEYS.includes(k))
    .map((k) => {
      const opt = DEDUCT_OPTIONS.find((o) => o.key === k);
      // 「校服 ¥120」→「校服」
      return opt ? opt.label.split(' ')[0] : k;
    });
}

/** 勾选的每日消耗项 key（★ 2026-10-08：按多选参与计算） */
function dailyChecked(): string[] {
  return applyForm.value.deductItems.filter((k) =>
    ['accommodation', 'meal', 'insurance'].includes(k),
  );
}

async function doCalc() {
  if (!applyForm.value.consultStudentId || !applyForm.value.trialStart || !applyForm.value.trialEnd) {
    calcResult.value = null;
    return;
  }
  calcLoading.value = true;
  try {
    calcResult.value = await calcRefund({
      consultStudentId: applyForm.value.consultStudentId,
      trialStart: applyForm.value.trialStart,
      trialEnd: applyForm.value.trialEnd,
      itemNames: checkedItemNames(),
      dailyItems: dailyChecked(),
    });
  } catch {
    // 试学费未到账 / 学生不存在等，由提交时后端统一拦截提示，这里静默清空预览
    calcResult.value = null;
  } finally {
    calcLoading.value = false;
  }
}

async function submitApply() {
  if (!applyForm.value.consultStudentId) {
    ElMessage.warning('请选择学生');
    return;
  }
  if (!applyForm.value.lossReason) {
    ElMessage.warning('请填写流失原因');
    return;
  }
  const c = calcResult.value;
  const tip = !c
    ? '尚未试算成功（请确认已填学生、试学期间，且试学费已确认到账）。确认继续发起退费申请？'
    : c.deductTotal === 0
      ? `未勾选任何消耗项，将按已到账试学费全额退费 ¥${(c.refundAmount / 100).toFixed(2)}。确认发起退费申请？`
      : `消耗扣减 ¥${(c.deductTotal / 100).toFixed(2)}，应退 ¥${(c.refundAmount / 100).toFixed(2)}。确认发起退费申请？`;
  await ElMessageBox.confirm(tip, '发起退费', { type: 'warning' });
  await applyRefund({
    consultStudentId: applyForm.value.consultStudentId,
    trialStart: applyForm.value.trialStart,
    trialEnd: applyForm.value.trialEnd,
    itemNames: checkedItemNames(),
    dailyItems: dailyChecked(),
    remark: [applyForm.value.lossReason, applyForm.value.remark]
      .filter(Boolean)
      .join(' · ') || undefined,
  });
  ElMessage.success('退费申请已提交');
  applyVisible.value = false;
  load();
}

/* ---------- 审批 ---------- */
async function doApprove(row: ConsultRefundOrder) {
  await ElMessageBox.confirm(
    `确认批准「${row.studentName}」的退费 ¥${(row.refundAmount / 100).toFixed(2)}？批准后将上报财务打款。`,
    '审批通过',
    { type: 'warning' },
  );
  await approveRefund(row.refundId);
  ElMessage.success('已批准，已上报财务');
  load();
}

async function doReject(row: ConsultRefundOrder) {
  const { value } = await ElMessageBox.prompt('请输入驳回原因', '驳回退费', {
    inputPlaceholder: '如「扣减明细有误，请核对后重新提交」',
    inputValidator: (v) => (!!v?.trim() ? true : '驳回原因必填'),
  });
  await rejectRefund(row.refundId, value.trim());
  ElMessage.success('已驳回，学生退回「试学中」');
  load();
}

/* ---------- 展示 ---------- */
const fmtMoney = (cent?: number) => (cent == null ? '—' : `¥${(cent / 100).toFixed(2)}`);

const statusTag = (s: number) => {
  if (s === CRS.PAID) return 'success';
  if (s === CRS.REJECTED) return 'danger';
  if (s === CRS.PENDING_FINANCE) return 'warning';
  return 'info';
};

/** 当前用户能否审批这条（经理 + 状态为待经理审批） */
function canApprove(row: ConsultRefundOrder) {
  return auth.isManagerUp && row.status === CRS.PENDING_MANAGER;
}

onMounted(load);
</script>

<template>
  <div class="page">
    <!-- 统计 -->
    <div v-if="stats" class="stats">
      <el-card shadow="never" class="stat">
        <div class="stat-label">退费申请</div>
        <div class="stat-value">{{ stats.pendingManagerCount + stats.pendingFinanceCount + stats.paidCount + stats.rejectedCount }}</div>
      </el-card>
      <el-card shadow="never" class="stat">
        <div class="stat-label">待经理审批</div>
        <div class="stat-value warn">{{ stats.pendingManagerCount }}</div>
      </el-card>
      <el-card shadow="never" class="stat">
        <div class="stat-label">待财务打款</div>
        <div class="stat-value warn">{{ stats.pendingFinanceCount }}</div>
      </el-card>
      <el-card shadow="never" class="stat">
        <div class="stat-label">已退费金额</div>
        <div class="stat-value ok">{{ fmtMoney(stats.paidAmount) }}</div>
      </el-card>
    </div>

    <!-- 列表（单卡片通栏：条件行 + 工具条 + 表格 + 分页，与财务模块版式一致） -->
    <el-card shadow="never" class="table-card card-flush">
      <!-- 条件行 -->
      <div class="filter-row">
        <el-input
          v-model="query.keyword"
          placeholder="搜索学生 / 咨询老师 / 班级 / 退费单号"
          clearable
          style="max-width: 280px"
          @keyup.enter="search"
          @clear="search"
        />
        <el-select v-model="query.status" placeholder="全部状态" clearable style="width: 160px">
          <el-option
            v-for="(name, val) in CONSULT_REFUND_STATUS_NAME"
            :key="val"
            :value="Number(val)"
            :label="name"
          />
        </el-select>
        <el-button type="primary" @click="search">查询</el-button>
        <el-button @click="resetQuery">重置</el-button>
      </div>

      <!-- 工具条：左主按钮，右统计 -->
      <div class="table-toolbar">
        <div class="tools">
          <el-button type="primary" @click="openApply()">＋ 发起退费</el-button>
        </div>
        <div class="tools">
          <span class="stat-line">
            共 <b>{{ total }}</b> 条 · <span v-if="stats">待经理审批 <b>{{ stats.pendingManagerCount }}</b> · 待财务打款
            <b>{{ stats.pendingFinanceCount }}</b></span>
          </span>
        </div>
      </div>

      <el-table v-loading="loading" :data="list" stripe>
        <el-table-column label="学生 / 单号" min-width="170">
          <template #default="{ row }">
            <div class="stu-name">{{ row.studentName }}</div>
            <div class="stu-sub">{{ row.refundNo }}</div>
          </template>
        </el-table-column>

        <el-table-column label="发起人" min-width="120">
          <template #default="{ row }">
            {{ row.applyByName }}
            <div v-if="row.selfApprove" class="stu-sub">自审自批</div>
          </template>
        </el-table-column>

        <el-table-column label="试学天数" width="100" align="center">
          <template #default="{ row }">{{ row.trialDays }} 天</template>
        </el-table-column>

        <el-table-column label="消耗扣减" min-width="150">
          <template #default="{ row }">
            <span class="warn">{{ fmtMoney(row.deductTotal) }}</span>
            <el-popover v-if="row.deductDetail?.length" placement="top" width="260" trigger="click">
              <template #reference>
                <el-button link type="primary" size="small">明细</el-button>
              </template>
              <div v-for="(d, i) in row.deductDetail" :key="i" class="dd-item">
                <span>{{ d.name }}</span>
                <span>{{ fmtMoney(d.amount) }}</span>
              </div>
            </el-popover>
          </template>
        </el-table-column>

        <el-table-column label="应退金额" width="120">
          <template #default="{ row }">
            <b class="ok">{{ fmtMoney(row.refundAmount) }}</b>
          </template>
        </el-table-column>

        <el-table-column label="状态" width="140">
          <template #default="{ row }">
            <el-tag size="small" :type="statusTag(row.status)">{{ row.statusName }}</el-tag>
            <div v-if="row.rejectReason" class="stu-sub">驳回：{{ row.rejectReason }}</div>
          </template>
        </el-table-column>

        <el-table-column prop="applyAt" label="发起时间" min-width="140" />

        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <template v-if="canApprove(row)">
              <el-button link type="success" @click="doApprove(row)">批准</el-button>
              <el-button link type="danger" @click="doReject(row)">驳回</el-button>
            </template>
            <span v-else class="stu-sub">—</span>
          </template>
        </el-table-column>
      </el-table>

      <div class="pager-bar">
        <span>共 {{ total }} 条记录，第 {{ page }}/{{ totalPages }} 页</span>
        <el-pagination
          v-model:current-page="page"
        v-model:page-size="size"
        :total="total"
        :page-sizes="[10, 20, 50]"
        layout="sizes, prev, pager, next"
        @current-change="load"
        @size-change="search"
        />
      </div>
    </el-card>

    <!-- 规则说明 -->
    <el-card shadow="never" class="rule-card">
      <div class="rule-title">退费规则</div>
      <p>
        试学阶段流失，由该学生的<b>咨询老师</b>发起退费（咨询经理也可发起）。从已到账的试学费中扣除试学期间
        <b>实际消耗</b>：住宿费 ¥15/天、餐费 ¥28/天、保险费 ¥5/天，以及领用的个人物品（校服、被褥等），
        实退 = 试学费 − 消耗合计。
      </p>
      <div class="rule-title">审批与打款</div>
      <p>
        咨询老师发起 → <b>咨询经理审批</b> → 上报财务 → <b>财务打款</b> → 状态流转为「已退费」。
        <b>咨询经理自己发起则自审自批</b>，直接进入「待财务打款」。驳回的退回「试学中」，可修改后重新提交。
      </p>
    </el-card>

    <!-- ============ 发起退费 ============ -->
    <el-dialog v-model="applyVisible" title="发起退费申请" width="600px">
      <el-form label-width="110px">
        <el-form-item label="学生姓名" required>
          <el-select
            v-model="applyForm.consultStudentId"
            filterable
            remote
            clearable
            reserve-keyword
            :remote-method="searchStudents"
            :loading="studentSearching"
            placeholder="输入学生姓名搜索选择"
            style="width: 100%"
            @change="onStudentChange"
          >
            <el-option
              v-for="s in studentOptions"
              :key="s.consultStudentId"
              :value="s.consultStudentId"
              :label="s.consultStateName ? `${s.studentName}（${s.consultStateName}）` : s.studentName"
            />
          </el-select>
        </el-form-item>

        <el-form-item label="试学期间">
          <div class="date-row">
            <el-date-picker
              v-model="applyForm.trialStart"
              type="date"
              placeholder="开始日期"
              value-format="YYYY-MM-DD"
              style="width: 160px"
              @change="doCalc"
            />
            <span>至</span>
            <el-date-picker
              v-model="applyForm.trialEnd"
              type="date"
              placeholder="结束日期"
              value-format="YYYY-MM-DD"
              style="width: 160px"
              @change="doCalc"
            />
          </div>
        </el-form-item>

        <el-form-item label="消耗项">
          <!-- ★ 2026-10-08 标准多选框：v-model 直绑 key 数组，勾选/取消即时重算；全部为选填 -->
          <div class="deduct-wrap">
            <div class="deduct-tip">
              均为选填：按试学期间实际消耗勾选，未勾选的不计入扣减；一项都不勾即为全额退费。
            </div>
            <el-checkbox-group v-model="applyForm.deductItems" @change="doCalc">
              <el-checkbox v-for="opt in DEDUCT_OPTIONS" :key="opt.key" :value="opt.key">
                {{ opt.label }}
              </el-checkbox>
            </el-checkbox-group>
          </div>
        </el-form-item>

        <el-form-item label="试算结果">
          <div v-loading="calcLoading" class="calc-box">
            <template v-if="calcResult">
              <div class="calc-row">
                <span>已到账试学费</span>
                <b>{{ fmtMoney(calcResult.incomeAmount) }}</b>
              </div>
              <div class="calc-row">
                <span>试学天数</span>
                <b>{{ calcResult.trialDays }} 天</b>
              </div>
              <!-- ★ 逐项扣减明细：勾选/取消任一消耗项都会即时重算 -->
              <template v-if="calcResult.deductItems.length">
                <div class="calc-sub">扣减明细（{{ calcResult.deductItems.length }} 项）</div>
                <div v-for="(d, i) in calcResult.deductItems" :key="i" class="calc-row calc-detail">
                  <span>{{ d.item }} <i class="calc-formula">{{ d.calc }}</i></span>
                  <b class="warn">− {{ fmtMoney(d.amount) }}</b>
                </div>
              </template>
              <div v-else class="calc-sub calc-sub-empty">未勾选任何消耗项，无扣减</div>
              <div class="calc-row">
                <span>消耗扣减合计</span>
                <b class="warn">− {{ fmtMoney(calcResult.deductTotal) }}</b>
              </div>
              <el-divider class="calc-divider" />
              <div class="calc-row total">
                <span>应退金额 = 已到账试学费 − 消耗扣减合计</span>
                <b class="ok">{{ fmtMoney(calcResult.refundAmount) }}</b>
              </div>
            </template>
            <span v-else class="stu-sub">选好学生和试学期间后自动试算</span>
          </div>
        </el-form-item>

        <el-form-item label="流失原因" required>
          <el-input v-model="applyForm.lossReason" placeholder="如「试学体验不满意」" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="applyForm.remark" type="textarea" :rows="2" />
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="applyVisible = false">取消</el-button>
        <el-button type="primary" @click="submitApply">提交申请</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}

.stat {
  text-align: center;
}

.stat-label {
  font-size: 12px;
  color: #A2938E;
}

.stat-value {
  font-size: 20px;
  font-weight: 700;
  margin-top: 4px;
}

.stat-value.ok {
  color: #5FA36F;
}

.stat-value.warn {
  color: #C9852E;
}

.toolbar-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.spacer {
  flex: 1;
}

.table-card {
  flex: 1;
}

.stu-name {
  font-weight: 600;
  color: #443432;
}

.stu-sub {
  font-size: 12px;
  color: #A2938E;
  margin-top: 2px;
}

.ok {
  color: #5FA36F;
}

.warn {
  color: #C9852E;
}

.dd-item {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  padding: 2px 0;
}

.rule-card {
  font-size: 12px;
  color: #7A6C67;
  line-height: 1.7;
}

.rule-title {
  font-weight: 600;
  color: #443432;
  margin-bottom: 4px;
}

.date-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.calc-box {
  width: 100%;
  background: #F6F3EF;
  border-radius: 6px;
  padding: 10px 12px;
  min-height: 48px;
}

.calc-row {
  display: flex;
  justify-content: space-between;
  font-size: 13px;
  padding: 3px 0;
}

.calc-row.total {
  font-size: 15px;
}

.calc-sub {
  font-size: 12px;
  color: #A2938E;
  margin-top: 6px;
  padding: 3px 0;
}

.calc-sub-empty {
  color: #C4B8B2;
}

.deduct-wrap {
  width: 100%;
}

.deduct-tip {
  font-size: 12px;
  color: #A2938E;
  line-height: 1.6;
  margin-bottom: 6px;
}

.calc-detail {
  color: #7A6C67;
  padding-left: 12px;
}

.calc-formula {
  font-style: normal;
  font-size: 12px;
  color: #A2938E;
  margin-left: 6px;
}

.calc-divider {
  margin: 6px 0;
}
</style>
