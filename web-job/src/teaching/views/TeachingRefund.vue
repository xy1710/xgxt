<template>
  <div class="trf">
    <!-- ★ 把"走哪几步"显式告诉用户（合并后审批链变了，不能让人猜） -->
    <el-alert class="trf-chain" type="info" :closable="false" show-icon>
      <template #title>
        本模块审批链（三部门统一）：
        <b>班主任 / 项目经理发起 → 学管审批 → 校长审批 → 通过后通知财务出款</b>
      </template>
    </el-alert>

    <!-- 汇总卡片 -->
    <div class="trf-cards">
      <div v-for="s in summaries" :key="s.stage" class="trf-card">
        <div class="trf-card__head">{{ deptNameOf(s.stage, s.stageName) }}</div>
        <div class="trf-card__row">
          <span>共 <b>{{ s.total }}</b> 单</span>
          <span class="warn">审批中 <b>{{ s.pendingCount }}</b></span>
          <span class="ok">已通过 <b>{{ s.approvedCount }}</b></span>
          <span class="bad">已驳回 <b>{{ s.rejectedCount }}</b></span>
        </div>
        <div class="trf-card__amt">已通过金额：¥{{ fmtCent(s.approvedAmount) }}</div>
      </div>
      <el-empty v-if="!summaries.length" description="当前账号没有可访问的部门" :image-size="60" />
    </div>

    <!--
      筛选栏 ★ 2026-10-16 完善（与 TeachingLeave 同一纪律）：
        · 「学段」改叫「部门」（选项 = /summary 派生的可见部门，名字走 deptNameOf）；
        · 新增「班级」「申请日期」两个筛选（后端 list 早支持 classId / startDate / endDate，页面原来没暴露）；
        · 所有筛选项「选完即查」（@change → load(1)），关键字回车/清空即查，
          不用再点「查询」；「查询」按钮保留，用于主动刷一遍。
    -->
    <el-form class="trf-filter" inline>
      <el-form-item label="部门">
        <el-select
          v-model="query.stage"
          clearable
          placeholder="全部部门"
          style="width: 130px"
          @change="onFilterStageChange"
        >
          <el-option v-for="d in deptFilterOptions" :key="d.value" :label="d.name" :value="d.value" />
        </el-select>
      </el-form-item>
      <el-form-item label="班级">
        <el-select
          v-model="query.classId"
          clearable
          filterable
          placeholder="全部班级"
          style="width: 160px"
          @change="load(1)"
        >
          <el-option v-for="c in classFilterOptions" :key="c.id" :label="c.name" :value="c.id" />
        </el-select>
      </el-form-item>
      <el-form-item label="状态">
        <el-select v-model="query.status" clearable placeholder="全部" style="width: 130px" @change="load(1)">
          <el-option v-for="(n, v) in REFUND_STATUS_NAME" :key="v" :label="n" :value="Number(v)" />
        </el-select>
      </el-form-item>
      <!--
        ★ 2026-10-19 修 bug：原来是一个 daterange 区间选择器，用户带已有区间重开面板、
          想只改「结束日期」时，EP 把第一次点击当作「新的开始」，高亮立刻塌缩成
          单日；再点一下确认后输入框变成「D 至 D」——看起来就是「开始日期同步成了
          结束日期」。EP 区间面板没有「只改一端」的语义（useRangePicker 的
          selecting 状态机决定），拆成两个独立日期选择器后此问题结构性消失；
          开始晚于结束时在 onDateChange 里自动调换。
        ★ 2026-10-19：筛选项拆成「申请日期」「结束日期」两个独立标签（用户要求，
          不再用「申请日期 至 结束日期」合成一项）；占位符用「不限」与
          本页其它筛选（全部部门/全部班级）的空态描述风格一致。
      -->
      <el-form-item label="申请日期">
        <el-date-picker
          v-model="query.startDate"
          type="date"
          placeholder="不限"
          value-format="YYYY-MM-DD"
          class="trf-date-start"
          style="width: 135px"
          @change="onDateChange"
        />
      </el-form-item>
      <el-form-item label="结束日期">
        <el-date-picker
          v-model="query.endDate"
          type="date"
          placeholder="不限"
          value-format="YYYY-MM-DD"
          class="trf-date-end"
          style="width: 135px"
          @change="onDateChange"
        />
      </el-form-item>
      <el-form-item label="关键字">
        <el-input
          v-model="query.keyword"
          placeholder="学生姓名 / 学号"
          clearable
          style="width: 170px"
          @keyup.enter="load(1)"
          @clear="load(1)"
        />
      </el-form-item>
      <el-form-item>
        <el-checkbox v-model="query.onlyMine" @change="load(1)">只看待我审批</el-checkbox>
      </el-form-item>
      <el-form-item>
        <el-button type="primary" @click="load(1)">查询</el-button>
        <el-button @click="reset">重置</el-button>
        <el-button type="success" @click="openCreate">发起退费</el-button>
      </el-form-item>
    </el-form>

    <!-- 列表 -->
    <el-table v-loading="loading" :data="rows" border stripe size="small">
      <!--
        ★ 部门列**始终显示**（2026-10-16 用户要求，与 TeachingLeave 同款）：
          原来用 `v-if="!query.stage"` 判断 —— 用部门筛选之后这列就消失了，
          用户以为「筛完数据没归属」。现在不管筛没筛、筛到哪个部门，这一列都在。
      -->
      <el-table-column label="部门" width="80" align="center">
        <template #default="{ row }">{{ deptNameOf(row.stage, row.stageName) }}</template>
      </el-table-column>
      <el-table-column label="学生" min-width="130">
        <template #default="{ row }">
          {{ row.studentName }}
          <span class="muted">{{ row.studentNo }}</span>
        </template>
      </el-table-column>
      <el-table-column label="班级" min-width="120">
        <template #default="{ row }">{{ row.className || '—' }}</template>
      </el-table-column>
      <el-table-column label="费用类型" min-width="110">
        <template #default="{ row }">{{ row.feeTypeName || '—' }}</template>
      </el-table-column>
      <el-table-column label="退费金额" width="110" align="right">
        <template #default="{ row }">
          <b>¥{{ row.refundAmountText }}</b>
        </template>
      </el-table-column>
      <el-table-column label="申请日期" width="105" align="center">
        <template #default="{ row }">{{ row.applyDate || '—' }}</template>
      </el-table-column>
      <!--
        ★ 结束日期（2026-10-19 用户要求新增）＝ 出款时间（退款流程完结）：
          2026-10-21 起三个部门都有出款时间了（大学部补列，见迁移 migrations-class/20261021_001，
          且「登记出款」按钮原来焊死不显示的 bug 一并修了），没登记过的显示 —。
      -->
      <el-table-column label="结束日期" width="105" align="center">
        <template #default="{ row }">{{ row.refundTime ? row.refundTime.slice(0, 10) : '—' }}</template>
      </el-table-column>
      <el-table-column label="状态" width="105" align="center">
        <template #default="{ row }">
          <el-tag :type="tagType(row.approvalStatus)" size="small">
            {{ row.approvalStatusName }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="250" fixed="right" align="center">
        <template #default="{ row }">
          <el-button link type="primary" size="small" @click="openDetail(row)">详情</el-button>
          <el-button
            v-if="row.canSubmit"
            link
            type="primary"
            size="small"
            @click="doSubmit(row)"
          >
            提交
          </el-button>
          <el-button v-if="row.canApprove" link type="success" size="small" @click="doApprove(row)">
            审批通过
          </el-button>
          <el-button v-if="row.canApprove" link type="danger" size="small" @click="doReject(row)">
            驳回
          </el-button>
          <el-button v-if="row.canCancel" link type="warning" size="small" @click="doCancel(row)">
            撤回
          </el-button>
          <el-button
            v-if="row.approvalStatus === REFUND_STATUS.APPROVED && canFinanceConfirm"
            link
            type="info"
            size="small"
            @click="doFinanceConfirm(row)"
          >
            登记出款
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-pagination
      class="trf-page"
      :current-page="query.page"
      :page-size="query.size"
      :total="total"
      layout="total, prev, pager, next"
      @current-change="(p: number) => load(p)"
    />

    <!-- 新建对话框 -->
    <el-dialog v-model="createVisible" title="发起退费申请" width="640px">
      <el-form label-width="90px">
        <el-form-item label="部门" required>
          <el-select v-model="form.stage" style="width: 160px" @change="onStageChange">
            <el-option v-for="d in deptFilterOptions" :key="d.value" :label="d.name" :value="d.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="学生" required>
          <el-select
            v-model="form.studentId"
            filterable
            remote
            reserve-keyword
            placeholder="输入姓名 / 学号搜索"
            :remote-method="searchStudents"
            :loading="stuLoading"
            style="width: 100%"
          >
            <el-option
              v-for="s in students"
              :key="s.id"
              :label="`${s.name}（${s.no}）${s.className ? ' · ' + s.className : ''}`"
              :value="s.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="费用项" required>
          <div v-for="(it, i) in form.items" :key="i" class="trf-item">
            <el-select v-model="it.feeType" style="width: 150px">
              <el-option v-for="o in FEE_TYPE_OPTIONS" :key="o.value" :label="o.label" :value="o.value" />
            </el-select>
            <el-input-number
              v-model="it.yuan"
              :min="0"
              :max="REFUND_ITEM_MAX_YUAN"
              :precision="2"
              :step="100"
              controls-position="right"
              style="width: 180px"
            />
            <span class="muted">元</span>
            <el-button v-if="form.items.length > 1" link type="danger" @click="form.items.splice(i, 1)">
              删除
            </el-button>
          </div>
          <el-button link type="primary" @click="form.items.push({ feeType: 1, yuan: 0 })">
            + 增加一项
          </el-button>
          <div class="muted">单项费用上限 10 万元，超出无法填写</div>
        </el-form-item>
        <el-form-item label="退费总额">
          <b class="amt">¥{{ formTotalText }}</b>
          <span class="muted">（自动汇总各项）</span>
        </el-form-item>
        <el-form-item label="申请日期">
          <!-- ★ 不给用户选择：系统自动取提交当天（2026-10-19 用户要求），置灰展示；
               openCreate 里 form.applyDate = todayStr() 自动填，提交时也传当天 -->
          <el-date-picker
            v-model="form.applyDate"
            type="date"
            value-format="YYYY-MM-DD"
            disabled
            style="width: 180px"
          />
          <span class="muted">系统自动取当天，不可修改</span>
        </el-form-item>
        <el-form-item label="退费原因" required>
          <el-input v-model="form.refundReason" type="textarea" :rows="3" maxlength="500" show-word-limit />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button :loading="saving" @click="doCreate(false)">保存草稿</el-button>
        <el-button type="primary" :loading="saving" @click="doCreate(true)">保存并提交</el-button>
      </template>
    </el-dialog>

    <!-- 详情对话框 -->
    <el-dialog v-model="detailVisible" title="退费单详情" width="680px">
      <template v-if="detail">
        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="部门">{{ deptNameOf(detail.record.stage, detail.record.stageName) }}</el-descriptions-item>
          <el-descriptions-item label="学生">
            {{ detail.record.studentName }}（{{ detail.record.studentNo }}）
          </el-descriptions-item>
          <el-descriptions-item label="班级">{{ detail.record.className || '—' }}</el-descriptions-item>
          <el-descriptions-item label="申请日期">{{ detail.record.applyDate || '—' }}</el-descriptions-item>
          <el-descriptions-item label="费用类型">{{ detail.record.feeTypeName || '—' }}</el-descriptions-item>
          <el-descriptions-item label="退费金额">
            <b>¥{{ detail.record.refundAmountText }}</b>
          </el-descriptions-item>
          <el-descriptions-item label="状态">
            <el-tag :type="tagType(detail.record.approvalStatus)" size="small">
              {{ detail.record.approvalStatusName }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="退费原因" :span="2">
            {{ detail.record.refundReason || '—' }}
          </el-descriptions-item>
          <el-descriptions-item v-if="detail.record.refundTime" label="出款时间" :span="2">
            {{ detail.record.refundTime }}
          </el-descriptions-item>
        </el-descriptions>

        <el-divider content-position="left">费用项明细</el-divider>
        <el-table :data="detail.record.items" size="small" border>
          <el-table-column label="费用类型">
            <template #default="{ row }">{{ row.feeTypeName }}</template>
          </el-table-column>
          <el-table-column label="金额" align="right">
            <template #default="{ row }">¥{{ row.amountText }}</template>
          </el-table-column>
        </el-table>

        <el-divider content-position="left">审批轨迹</el-divider>
        <el-empty v-if="!detail.logs.length" description="暂无审批轨迹" :image-size="50" />
        <el-timeline v-else>
          <el-timeline-item
            v-for="(l, i) in detail.logs"
            :key="i"
            :timestamp="l.time || ''"
            placement="top"
          >
            <b>{{ l.operatorName }}</b> · {{ l.actionName }}（{{ l.nodeName }}）
            <div v-if="l.comment" class="muted">{{ l.comment }}</div>
          </el-timeline-item>
        </el-timeline>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
/**
 * 退费管理 · 统一页（第 2 期第 4 个域）
 *
 * ★ 一个页面取代原来三套（初高 / 大学 / 实训），靠顶部「部门」筛选切换。
 * ★ 审批链统一采用实训那套（学管 → 校长），与后端 `service.ts` 口径一致。
 * ★ 金额：接口一律传「分」，页面用「元」输入/展示。
 * ★ 2026-10-16：全页面统一叫「部门」，不再出现「学段」（内部技术词）——
 *   汇总卡片 / 部门筛选 / 列表「部门」列 / 详情全走 deptNameOf() 翻成部门名
 *   （初高中 / 大学 / 就业，2026-10-21 起「实训」叫「就业」），与 TeachingLeave.vue 同一份口径。
 *   ⚠️ 列表「部门」列始终显示（原来 v-if="!query.stage"，筛完这列就消失）。
 * ★ 筛选/搜索：部门 / 班级 / 状态 / 申请日期（开始/结束）/ 关键字 / 只看待我审批，
 *   全部「选完即查」（@change → load(1)，与 TeachingLeave 同一纪律）。
 *   班级与日期走的是后端 list 本来就支持的 classId / startDate / endDate。
 * ★ 2026-10-19 修 bug：「申请日期」由单个 daterange 拆成「开始/结束」两个独立
 *   日期选择器——EP 区间面板重开后第一次点击会被当作「新的开始」，想只改
 *   结束日期时高亮塌缩成单日，再点一下确认后输入框变成「D 至 D」（用户报的
 *   「开始日期同步成结束日期」）。拆开后结构上不再可能互相污染。
 * ★ 2026-10-19 列表：新增「结束日期」列（＝ 出款时间，大学部 2026-10-21 补列后三部门都有）；
 *   按用户要求去掉「当前处理」列与详情里的当前处理项。
 * ★ 2026-10-21 用户要求：部门「实训」改叫「就业」（REFUND_DEPARTMENTS 的 job 项）；
 *   大学部补出款时间列并真正落库（原来 setFinance 是空实现）；「登记出款」按钮原来
 *   因 canFinanceConfirm 永远 false 谁都看不见，改按门户可见模块（finance）判。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { useBreadcrumbStageKey } from '@/store/breadcrumb';
import { useAuthStore as usePortalStore } from '@/portal/stores/auth';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  FEE_TYPE_OPTIONS,
  REFUND_DEPARTMENTS,
  REFUND_ITEM_MAX_YUAN,
  REFUND_STATUS,
  REFUND_STATUS_NAME,
  approveRefund,
  cancelRefund,
  createRefund,
  financeConfirm,
  getRefundDetail,
  getRefundSummary,
  listClasses,
  listRefunds,
  listStudentOptions,
  rejectRefund,
  submitRefund,
  type RefundDepartment,
  type RefundDetail,
  type RefundRow,
  type RefundSummary,
  type StudentOption,
  type TeachingStage,
} from '../api/refund';

const loading = ref(false);
const saving = ref(false);
const portal = usePortalStore();
const rows = ref<RefundRow[]>([]);
const total = ref(0);
const summaries = ref<RefundSummary[]>([]);
/** 部门口径（与 api/leave.ts / 后端 LEAVE_DEPARTMENTS 同源；退费无「就业」业务，只有 3 个） */
const departments = ref<RefundDepartment[]>([...REFUND_DEPARTMENTS]);
/** 班级下拉候选（/classes 按可见学段下发；选了部门就只列该部门的班） */
const allClasses = ref<Array<{ stage: TeachingStage; stageName: string; id: string; name: string }>>([]);

const query = reactive({
  stage: undefined as TeachingStage | undefined,
  classId: undefined as string | undefined,
  status: undefined as number | undefined,
  keyword: '',
  onlyMine: false,
  startDate: undefined as string | undefined,
  endDate: undefined as string | undefined,
  page: 1,
  size: 20,
});

/* 面包屑第 4 级：当前正在查看的学段（筛选器变化时自动同步，页面卸载自动清空） */
useBreadcrumbStageKey(() => query.stage || '');

/**
 * 财务登记出款按钮：仅能看到「财务」模块的账号显示（后端有二次校验）。
 *
 * ★ 2026-10-21 修复：这个 ref 原来**永远是 false**，「登记出款」按钮对谁都不出现 ——
 *   后端 `/finance-confirm` 只要求"该部门可见 + 单据已审批通过"，并不要求财务角色，
 *   前端却把它焊死。这直接导致三件事串不起来：
 *   审批通过 → 通知财务 → **没人能登记出款** → 「结束日期（出款时间）」永远是空的
 *   （大学部连出款时间列都还没有，本次一并补了，见迁移 migrations-class/20261021_001）。
 *   现在按「门户下发的可见模块里有没有 finance」判（与财务侧 auth store 的菜单口径同源）。
 */
const canFinanceConfirm = computed(() =>
  (portal.visibleModules || []).some((m) => String(m.key) === 'finance'),
);

/**
 * ★ 学段码 → 部门名（界面上不再出现「学段」；与 TeachingLeave.deptNameOf 同一份口径）
 *   取不到时回落到后端给的 stageName，不凭空编名字。
 */
function deptNameOf(stage?: TeachingStage | string | null, fallback = '') {
  if (!stage) return fallback;
  return departments.value.find((d) => d.stage === stage)?.name || fallback;
}

/**
 * ★ 部门下拉（筛选 + 发起表单共用）：由 `/summary` 派生 —— 只含**当前账号有权限**的部门。
 *   不能用全量部门表：选了无权限的部门，后端 list 直接 40302 报错（原来根本选不到）。
 *   某部门暂时没有单据也仍然可选（summary 里会出现，total=0）。
 */
const deptFilterOptions = computed(() =>
  summaries.value.map((s) => ({
    value: s.stage as TeachingStage,
    name: deptNameOf(s.stage, s.stageName),
  })),
);

/** 班级筛选项：选了部门只列该部门的班，没选部门列全部 */
const classFilterOptions = computed(() =>
  query.stage ? allClasses.value.filter((c) => c.stage === query.stage) : allClasses.value,
);

/* ---------------- 加载 ---------------- */

function tagType(s: number) {
  if (s === REFUND_STATUS.APPROVED) return 'success';
  if (s === REFUND_STATUS.REJECTED) return 'danger';
  if (s === REFUND_STATUS.PENDING_MANAGER || s === REFUND_STATUS.PENDING_PRINCIPAL) return 'warning';
  return 'info';
}

function fmtCent(cent: number) {
  return (Number(cent || 0) / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2 });
}

/** 今天（本地时区）的 YYYY-MM-DD —— 发起退费的申请日期默认值。
 *  不用 toISOString()（那是 UTC，凌晨 0~8 点会差一天）。 */
function todayStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function load(p = query.page) {
  query.page = p;
  loading.value = true;
  try {
    const res = await listRefunds({
      stage: query.stage,
      classId: query.classId,
      status: query.status,
      keyword: query.keyword || undefined,
      onlyMine: query.onlyMine || undefined,
      startDate: query.startDate,
      endDate: query.endDate,
      page: query.page,
      size: query.size,
    });
    rows.value = res.list || [];
    total.value = res.total || 0;
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || e?.message || '加载失败');
  } finally {
    loading.value = false;
  }
}

async function loadSummary() {
  try {
    const list = await getRefundSummary();
    summaries.value = list || [];
  } catch {
    /* 汇总失败不影响主流程 */
  }
}

async function loadClasses() {
  try {
    allClasses.value = (await listClasses()) || [];
  } catch {
    /* 班级下拉失败不阻塞列表 */
  }
}

/** 切部门：班级是部门内的，清掉不匹配的已选班级，避免带着上一个部门的筛选去查 */
function onFilterStageChange() {
  if (query.classId && !classFilterOptions.value.some((c) => c.id === query.classId)) {
    query.classId = undefined;
  }
  load(1);
}

/**
 * 申请日期（开始/结束两个独立选择器）选完即查；
 * 开始晚于结束自动调换，避免「筛选结果为空却不知道为什么」的困惑。
 */
function onDateChange() {
  if (query.startDate && query.endDate && query.startDate > query.endDate) {
    const s = query.startDate;
    query.startDate = query.endDate;
    query.endDate = s;
    ElMessage.info('开始日期晚于结束日期，已自动调换');
  }
  load(1);
}

function reset() {
  query.stage = undefined;
  query.classId = undefined;
  query.status = undefined;
  query.keyword = '';
  query.onlyMine = false;
  query.startDate = undefined;
  query.endDate = undefined;
  load(1);
}

onMounted(async () => {
  await Promise.all([loadSummary(), loadClasses()]);
  await load(1);
});

/* ---------------- 新建 ---------------- */

const createVisible = ref(false);
const students = ref<StudentOption[]>([]);
const stuLoading = ref(false);

const form = reactive<{
  stage: TeachingStage;
  studentId: string;
  items: Array<{ feeType: number; yuan: number }>;
  applyDate: string;
  refundReason: string;
}>({
  stage: 'job',
  studentId: '',
  items: [{ feeType: 1, yuan: 0 }],
  applyDate: '',
  refundReason: '',
});

const formTotalText = computed(() =>
  form.items.reduce((a, x) => a + Number(x.yuan || 0), 0).toFixed(2),
);

function openCreate() {
  form.stage = (query.stage || deptFilterOptions.value[0]?.value || 'job') as TeachingStage;
  form.studentId = '';
  form.items = [{ feeType: 1, yuan: 0 }];
  form.applyDate = todayStr(); // ★ 默认当天（2026-10-19 用户要求；后端对空值原本也兜底今天，但表单应直接显示出来）
  form.refundReason = '';
  students.value = [];
  createVisible.value = true;
  searchStudents('');
}

function onStageChange() {
  form.studentId = '';
  students.value = [];
  searchStudents('');
}

async function searchStudents(kw: string) {
  if (!form.stage) return;
  stuLoading.value = true;
  try {
    students.value = (await listStudentOptions(form.stage, kw)) || [];
  } catch {
    students.value = [];
  } finally {
    stuLoading.value = false;
  }
}

async function doCreate(submit: boolean) {
  if (!form.studentId) return ElMessage.warning('请选择学生');
  if (!form.refundReason.trim()) return ElMessage.warning('请填写退费原因');
  const items = form.items.map((x) => ({
    feeType: x.feeType,
    amount: Math.round(Number(x.yuan || 0) * 100),
  }));
  // ★ 单项上限 10 万元：输入框有 max，这里兜底（粘贴/程序赋值仍可能带进来的情况）
  if (items.some((x) => x.amount > REFUND_ITEM_MAX_YUAN * 100)) {
    return ElMessage.warning('单项费用最高 10 万元，请调整费用项');
  }
  const refundAmount = items.reduce((a, x) => a + x.amount, 0);
  if (refundAmount <= 0) return ElMessage.warning('退费金额必须大于 0');

  saving.value = true;
  try {
    await createRefund({
      stage: form.stage,
      studentId: form.studentId,
      items,
      refundAmount,
      applyDate: form.applyDate || undefined,
      refundReason: form.refundReason,
      submit,
    });
    ElMessage.success(submit ? '已创建并提交，等待学管审批' : '已保存草稿');
    createVisible.value = false;
    await Promise.all([load(1), loadSummary()]);
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || e?.message || '创建失败');
  } finally {
    saving.value = false;
  }
}

/* ---------------- 详情 ---------------- */

const detailVisible = ref(false);
const detail = ref<RefundDetail | null>(null);

async function openDetail(row: RefundRow) {
  try {
    detail.value = await getRefundDetail(row.id);
    detailVisible.value = true;
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || e?.message || '加载详情失败');
  }
}

/* ---------------- 动作 ---------------- */

async function doSubmit(row: RefundRow) {
  try {
    await submitRefund(row.stage, row.id);
    ElMessage.success('已提交');
    await Promise.all([load(), loadSummary()]);
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || e?.message || '提交失败');
  }
}

async function doApprove(row: RefundRow) {
  try {
    const { value } = await ElMessageBox.prompt('审批意见（可空）', '审批通过', {
      inputPlaceholder: '可填写审批意见',
      confirmButtonText: '通过',
      cancelButtonText: '取消',
      inputValue: '',
    });
    const r = await approveRefund(row.stage, row.id, value || undefined);
    ElMessage.success(
      r.finished
        ? r.pushed
          ? '审批通过，已通知财务出款'
          : '审批通过（推送财务失败，请人工补录）'
        : '本环节已通过，流转到下一节点',
    );
    await Promise.all([load(), loadSummary()]);
  } catch (e: any) {
    if (e === 'cancel' || e?.message === 'cancel') return;
    ElMessage.error(e?.response?.data?.message || e?.message || '审批失败');
  }
}

async function doReject(row: RefundRow) {
  try {
    const { value } = await ElMessageBox.prompt('请填写驳回原因（必填）', '驳回退费申请', {
      inputPlaceholder: '驳回原因会通知到发起人',
      confirmButtonText: '确认驳回',
      cancelButtonText: '取消',
      inputValidator: (v: string) => (v && v.trim() ? true : '驳回原因必填'),
    });
    await rejectRefund(row.stage, row.id, value);
    ElMessage.success('已驳回');
    await Promise.all([load(), loadSummary()]);
  } catch (e: any) {
    if (e === 'cancel' || e?.message === 'cancel') return;
    ElMessage.error(e?.response?.data?.message || e?.message || '驳回失败');
  }
}

async function doCancel(row: RefundRow) {
  try {
    const { value } = await ElMessageBox.prompt('撤回原因（可空）', '撤回申请', {
      confirmButtonText: '确认撤回',
      cancelButtonText: '取消',
      inputValue: '',
    });
    await cancelRefund(row.stage, row.id, value || undefined);
    ElMessage.success('已撤回');
    await Promise.all([load(), loadSummary()]);
  } catch (e: any) {
    if (e === 'cancel' || e?.message === 'cancel') return;
    ElMessage.error(e?.response?.data?.message || e?.message || '撤回失败');
  }
}

async function doFinanceConfirm(row: RefundRow) {
  try {
    const { value } = await ElMessageBox.prompt('出款备注（可空）', '登记出款', {
      confirmButtonText: '确认',
      cancelButtonText: '取消',
      inputValue: '',
    });
    await financeConfirm(row.stage, row.id, { financeRemark: value || undefined });
    ElMessage.success('已登记出款');
    await load();
  } catch (e: any) {
    if (e === 'cancel' || e?.message === 'cancel') return;
    ElMessage.error(e?.response?.data?.message || e?.message || '登记失败');
  }
}
</script>

<style scoped>
.trf {
  padding: 12px;
}
.trf-chain {
  margin-bottom: 12px;
}
.trf-cards {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.trf-card {
  flex: 1 1 220px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  padding: 10px 12px;
}
.trf-card__head {
  font-weight: 600;
  margin-bottom: 6px;
}
.trf-card__row {
  display: flex;
  gap: 12px;
  font-size: 13px;
  flex-wrap: wrap;
}
.trf-card__amt {
  margin-top: 6px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.warn {
  color: var(--el-color-warning);
}
.ok {
  color: var(--el-color-success);
}
.bad {
  color: var(--el-color-danger);
}
.trf-filter {
  margin-bottom: 8px;
}
.trf-page {
  margin-top: 10px;
  justify-content: flex-end;
}
.trf-item {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.muted {
  color: var(--el-text-color-secondary);
  font-size: 12px;
  margin-left: 4px;
}
.amt {
  color: var(--el-color-danger);
  font-size: 16px;
}
</style>
