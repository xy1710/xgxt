<template>
  <div class="page-container">
    <!-- ============ 表格区（原型是「一个卡片」装下 Tab + 条件 + 表格 + 分页）============ -->
    <el-card shadow="never" class="table-card card-flush">
      <!-- 部门二级 Tab（原型 .dept-tabs：二三期 / 大学部） -->
      <div class="dept-tabs">
        <b :class="{ on: dept === 'all' }" @click="handleDept('all')">全部部门</b>
        <b :class="{ on: dept === '二三期' }" @click="handleDept('二三期')">二三期</b>
        <b :class="{ on: dept === '大学部' }" @click="handleDept('大学部')">大学部</b>
      </div>

      <!--
        条件行：搜索 + 各筛选
        ⭐ 2026-10-03 用户指令：改为【实时筛选】——
           任一条件变更立即触发查询，不用再点「查询」按钮。
           「查询」按钮保留作兜底（部分浏览器/输入法不触发 change 时可用）。
      -->
      <div class="filter-row">
        <el-input
          v-model="query.studentName"
          placeholder="搜索学号 / 姓名"
          clearable
          style="width: 190px"
          @input="handleKeywordInput"
          @keyup.enter="handleSearch"
        />
        <el-select
          v-model="className"
          placeholder="全部班级"
          clearable
          filterable
          style="width: 150px"
          @change="handleSearch"
        >
          <el-option v-for="c in classOptions" :key="c" :label="c" :value="c" />
        </el-select>
        <el-select
          v-model="query.feeType"
          placeholder="缴费类型"
          clearable
          style="width: 120px"
          @change="handleSearch"
        >
          <el-option v-for="(name, v) in FEE_TYPE_NAME" :key="v" :label="name" :value="Number(v)" />
        </el-select>
        <el-select
          v-model="query.payStatus"
          placeholder="缴费状态"
          clearable
          style="width: 120px"
          @change="handleSearch"
        >
          <!--
            ⚠️ 这里只列「本页可能出现」的状态。
               本页硬约束为「只看已上传凭证、且非冻结的单据」，所以
               「待缴」「冻结」永远不会出现，列出来只会让财务白踩一次坑。
          -->
          <el-option
            v-for="(name, v) in payStatusOptions"
            :key="v"
            :label="name"
            :value="Number(v)"
          />
        </el-select>
        <el-select
          v-model="query.sourceModule"
          placeholder="来源模块"
          clearable
          style="width: 120px"
          @change="handleSearch"
        >
          <el-option
            v-for="(name, v) in SOURCE_MODULE_NAME"
            :key="v"
            :label="name"
            :value="Number(v)"
          />
        </el-select>
        <el-date-picker
          v-model="dateRange"
          type="daterange"
          value-format="YYYY-MM-DD"
          range-separator="至"
          start-placeholder="起"
          end-placeholder="止"
          style="width: 230px"
          @change="handleSearch"
        />
        <el-button type="primary" @click="handleSearch">查询</el-button>
        <el-button @click="handleReset">重置</el-button>
        <span class="live-hint">条件变更即筛选</span>
      </div>

      <!-- 工具条：左边说明，右边统计 + 主按钮（原型 .toolbar） -->
      <div class="table-toolbar">
        <div class="tools">
          <span class="count-hint">共 {{ total }} 条已上传凭证的缴费单</span>
        </div>
        <div class="tools">
          <!--
            内联统计：财务核对台只关心这三件事。
            ⚠️ 2026-10-04 起本页只显示「已上传凭证」的单据，
               所以不再有「待缴费 / 待传凭证」（那两类根本不在结果集里）。
          -->
          <span class="stat-line">
            待核对 <b>{{ stat.waitVerify }}</b> · 已缴 <b>{{ stat.verified }}</b> · 已打回
            <b>{{ stat.rejected }}</b> · 已选 <b>{{ selectedRows.length }}</b> 人
          </span>
          <!-- 财务的核心动作：批量核对（原型主按钮） -->
          <el-button
            type="primary"
            :disabled="selectedRows.length === 0"
            @click="handleBatchVerify"
          >
            批量财务核对
          </el-button>
        </div>
      </div>

      <el-table
        v-loading="loading"
        :data="viewList"
        stripe
        style="width: 100%"
        empty-text="暂无已上传凭证的缴费单"
        @selection-change="handleSelectionChange"
      >
        <!-- 只有可核对的才能勾选，避免财务误操作 -->
        <el-table-column type="selection" width="46" :selectable="isSelectable" />
        <el-table-column prop="studentNo" label="学号" width="120" />
        <el-table-column prop="studentName" label="姓名" width="90" />
        <el-table-column prop="className" label="班级" width="100">
          <template #default="{ row }">{{ dash(row.className) }}</template>
        </el-table-column>
        <el-table-column label="缴费类型" width="120" align="center">
          <template #default="{ row }">
            <div>{{ row.feeTypeName }}</div>
            <!--
              ★ 2026-10-19 用户口径：总金额下面要知道包含什么。
                列表放不下明细，先在这里标「含 N 项」，点详情看分项。
            -->
            <div v-if="(row.itemCount || 1) > 1" class="voucher-group">
              含 {{ row.itemCount }} 项
            </div>
          </template>
        </el-table-column>
        <!-- 来源模块：这笔钱是谁发起的（咨询/教务/财务自建） -->
        <el-table-column label="来源" width="100" align="center">
          <template #default="{ row }">
            <el-tag :type="sourceTagType(row.sourceModule)" size="small" effect="plain">
              {{ dash(row.sourceModuleName) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="金额" width="120" align="right">
          <template #default="{ row }">
            <span class="money" :class="{ due: row.payStatus === PayStatus.UNPAID }">
              {{ formatAmount(row.amount) }}
            </span>
          </template>
        </el-table-column>
        <el-table-column prop="payStatusName" label="缴费状态" width="100" align="center">
          <template #default="{ row }">
            <el-tag :type="payStatusTagType(row.payStatus)" size="small">
              {{ row.payStatusName }}
            </el-tag>
          </template>
        </el-table-column>
        <!-- 到期日期：下方小字提示剩余天数（原型 restTag） -->
        <el-table-column label="到期日期" width="118" align="center">
          <template #default="{ row }">
            <div class="cell2">
              <div>{{ dash(row.expireDate) }}</div>
              <div v-if="restDays(row.expireDate) !== null">
                <el-tag
                  :type="restTagType(restDays(row.expireDate)!)"
                  size="small"
                  effect="plain"
                >
                  {{ restTagText(restDays(row.expireDate)!) }}
                </el-tag>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="缴费日期" width="100" align="center">
          <template #default="{ row }">{{ dash(row.payDate) }}</template>
        </el-table-column>
        <el-table-column label="缴费凭证" width="132" align="center">
          <template #default="{ row }">
            <el-tag v-if="row.hasVoucher" type="primary" size="small" effect="plain">已上传 ›</el-tag>
            <el-tag v-else-if="row.payDate" type="warning" size="small" effect="plain">待上传</el-tag>
            <el-tag v-else type="info" size="small" effect="plain">—</el-tag>
            <!--
              ★ 2026-10-19 一张凭证可能覆盖多张单据（一次缴清多项费用只有一张转账截图），
                此时本行金额只是其中一项，凭证截图是合计 —— 必须标出来，
                否则财务会以为「凭证和实缴金额对不上」。
            -->
            <div v-if="(row.voucherGroupCount || 1) > 1" class="voucher-group">
              共 {{ row.voucherGroupCount }} 笔 · {{ formatAmount(row.voucherGroupAmount) }}
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="headTeacherName" label="班主任" width="90">
          <template #default="{ row }">{{ dash(row.headTeacherName) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="140" fixed="right" align="center">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="handleDetail(row)">详情</el-button>
            <el-button
              v-if="row.canVerify"
              link
              type="primary"
              size="small"
              @click="handleVerify(row)"
            >
              核对
            </el-button>
            <el-button
              v-if="row.canVerify"
              link
              type="warning"
              size="small"
              @click="handleReject(row)"
            >
              打回
            </el-button>
          </template>
        </el-table-column>
      </el-table>

      <!-- 分页文案条（原型 pager：左文案 + 右页码） -->
      <div class="pager-bar">
        <span>共 {{ total }} 条记录，第 {{ query.page }}/{{ totalPages }} 页</span>
        <el-pagination
          v-model:current-page="query.page"
          v-model:page-size="query.size"
          :page-sizes="[10, 20, 50, 100]"
          :total="total"
          layout="sizes, prev, pager, next"
          @size-change="loadData"
          @current-change="loadData"
        />
      </div>
    </el-card>

    <!-- ============ 详情弹窗 ============ -->
    <el-dialog v-model="detailVisible" title="缴费单详情" width="720px" top="6vh">
      <el-descriptions v-if="detail" :column="2" border size="small">
        <el-descriptions-item label="学号">{{ detail.studentNo }}</el-descriptions-item>
        <el-descriptions-item label="姓名">{{ detail.studentName }}</el-descriptions-item>
        <el-descriptions-item label="班级">{{ dash(detail.className) }}</el-descriptions-item>
        <el-descriptions-item label="部门">{{ dash(detail.deptName) }}</el-descriptions-item>
        <el-descriptions-item label="缴费类型">{{ detail.feeTypeName }}</el-descriptions-item>
        <el-descriptions-item label="金额">
          <span class="amount">{{ formatAmount(detail.amount) }}</span>
          <!-- ★ 2026-10-19 一张凭证覆盖多张单据时，本单只是其中一项 -->
          <div v-if="(detail.voucherGroupCount || 1) > 1" class="voucher-group">
            本单为其中一项，该凭证合计 {{ formatAmount(detail.voucherGroupAmount) }}
            （共 {{ detail.voucherGroupCount }} 笔）
          </div>
        </el-descriptions-item>
        <el-descriptions-item label="缴费状态">
          <el-tag :type="payStatusTagType(detail.payStatus)" size="small">
            {{ detail.payStatusName }}
          </el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="费用周期">{{ dash(detail.period) }}</el-descriptions-item>
        <el-descriptions-item label="缴费日期">{{ dash(detail.payDate) }}</el-descriptions-item>
        <el-descriptions-item label="到期日期">{{ dash(detail.expireDate) }}</el-descriptions-item>
        <el-descriptions-item label="是否已核对">
          <el-tag :type="detail.isVerified ? 'success' : 'info'" size="small">
            {{ detail.isVerified ? '已核对' : '未核对' }}
          </el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="核对人">{{ dash(detail.verifiedByName) }}</el-descriptions-item>
        <el-descriptions-item label="是否入账">
          <el-tag :type="detail.isInBill ? 'success' : 'info'" size="small">
            {{ detail.isInBill ? '已入账单' : '未入账' }}
          </el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="核对时间">{{ dash(detail.verifiedTime) }}</el-descriptions-item>
        <el-descriptions-item v-if="detail.isRejected" label="打回原因" :span="2">
          <span class="reject-text">{{ dash(detail.rejectReason) }}</span>
        </el-descriptions-item>
        <el-descriptions-item label="备注" :span="2">{{ dash(detail.remark) }}</el-descriptions-item>
      </el-descriptions>

      <!--
        ============ 这笔钱包含什么（总金额下面列的小列）============

        ★ 2026-10-19 用户口径：
          一张凭证 = 交的总金额，总金额下面列出包含的费用项。
          合计单（家长一次转一笔钱交多类费用）才有明细；
          单项单的物品就是「缴费类型」那一行，不重复列。
      -->
      <div v-if="detail && (detail.items?.length || 0) > 1" class="items-block">
        <div class="items-head">
          <span class="items-title">这笔钱包含</span>
          <span class="items-total">
            共 {{ detail.items?.length }} 项 · 合计 {{ formatAmount(detail.amount) }}
          </span>
        </div>
        <el-table :data="detail.items" size="small" border>
          <el-table-column prop="feeTypeName" label="费用项" min-width="140" />
          <el-table-column label="应缴" width="120" align="right">
            <template #default="{ row }">¥{{ row.standardAmountYuan }}</template>
          </el-table-column>
          <el-table-column label="实缴" width="120" align="right">
            <template #default="{ row }">
              <span class="items-amount">¥{{ row.amountYuan }}</span>
            </template>
          </el-table-column>
          <el-table-column label="优惠" width="120" align="right">
            <template #default="{ row }">
              <span v-if="row.discount > 0" class="items-discount">
                -¥{{ row.discountYuan }}
              </span>
              <span v-else class="dash">—</span>
            </template>
          </el-table-column>
        </el-table>
        <div class="items-note">
          实缴合计 = 本单金额 = 缴费凭证上的金额，财务按整单核对一次即可。
        </div>
      </div>

      <!-- ============ 缴费凭证（截图 + 转账单号）============ -->
      <div v-if="detail" class="voucher-block">
        <div class="voucher-head">
          <span class="voucher-title">缴费凭证</span>
          <el-tag v-if="detail.hasVoucher" type="success" size="small" effect="plain">已上传</el-tag>
          <el-tag v-else type="info" size="small" effect="plain">未上传</el-tag>
        </div>

        <!-- 有凭证：左右布局，左边截图右边信息 -->
        <div v-if="detail.hasVoucher" class="voucher-body">
          <!-- 截图 -->
          <div class="voucher-thumb-wrap">
            <el-image
              :src="voucherFullUrl(detail.voucherUrl)"
              :preview-src-list="[voucherFullUrl(detail.voucherUrl)]"
              :initial-index="0"
              fit="cover"
              class="voucher-thumb"
              :preview-teleported="true"
              hide-on-click-modal
            >
              <template #placeholder>
                <div class="thumb-loading">
                  <el-icon class="is-loading"><Loading /></el-icon>
                </div>
              </template>
              <template #error>
                <div class="thumb-error">
                  <el-icon><PictureFilled /></el-icon>
                  <span>截图加载失败</span>
                </div>
              </template>
            </el-image>
            <div class="thumb-tip">点击查看原图</div>
          </div>

          <!-- 转账信息 -->
          <div class="voucher-info">
            <div class="info-row">
              <span class="info-label">转账单号</span>
              <span class="info-value mono">{{ dash(detail.voucherNo) }}</span>
            </div>
            <div class="info-row">
              <span class="info-label">上传时间</span>
              <span class="info-value">{{ dash(detail.voucherTime) }}</span>
            </div>
            <!--
              ★ 2026-10-19 一次缴清多项费用：一张转账截图覆盖多张单据，
                截图金额是合计，本单只是其中一项 —— 这里明确写出来。
            -->
            <div v-if="(detail.voucherGroupCount || 1) > 1" class="info-row">
              <span class="info-label">凭证覆盖</span>
              <span class="info-value">
                共 {{ detail.voucherGroupCount }} 笔 · 合计
                <b>{{ formatAmount(detail.voucherGroupAmount) }}</b>
                <span class="voucher-group-inline">（本单 {{ formatAmount(detail.amount) }}）</span>
              </span>
            </div>
            <div class="info-row">
              <span class="info-label">凭证规则</span>
              <span class="info-value">
                <el-tag
                  :type="detail.voucherReusable ? 'warning' : 'info'"
                  size="small"
                  effect="plain"
                >
                  {{ detail.voucherReusable ? '可多人共用' : '一人一张' }}
                </el-tag>
              </span>
            </div>
            <div class="info-row">
              <span class="info-label">凭证截图</span>
              <span class="info-value">
                <el-button link type="primary" size="small" @click="openPreview(detail.voucherUrl)">
                  查看大图
                </el-button>
                <el-button link type="primary" size="small" @click="openInNewTab(detail.voucherUrl)">
                  新窗口打开
                </el-button>
              </span>
            </div>

            <!-- 餐费场景：同一张凭证还被谁用了 -->
            <div v-if="detail.sharedVoucherBy?.length" class="info-row shared-row">
              <span class="info-label">共用此凭证</span>
              <span class="info-value">
                <el-tag
                  v-for="s in detail.sharedVoucherBy"
                  :key="s.id"
                  size="small"
                  type="warning"
                  effect="plain"
                  class="shared-tag"
                >
                  {{ s.studentName }}（{{ s.studentNo }}）· {{ s.feeTypeName }}
                </el-tag>
              </span>
            </div>
          </div>
        </div>

        <!-- 无凭证 -->
        <el-empty v-else :image-size="70" description="该缴费单尚未上传缴费凭证" />
      </div>

      <template #footer>
        <el-button @click="detailVisible = false">关闭</el-button>
        <el-button
          v-if="detail?.canVerify"
          type="success"
          @click="detail && (detailVisible = false, handleVerify(detail))"
        >
          核对这笔
        </el-button>
      </template>
    </el-dialog>

    <!-- 凭证大图预览（点缩略图或「查看大图」都会打开） -->
    <el-image-viewer
      v-if="previewVisible"
      :url-list="previewList"
      :initial-index="0"
      teleported
      hide-on-click-modal
      @close="previewVisible = false"
    />

    <!-- ============ 打回弹窗 ============ -->
    <el-dialog v-model="rejectVisible" title="打回缴费单" width="520px" @closed="rejectReason = ''">
      <el-alert
        type="warning"
        :closable="false"
        show-icon
        title="打回后退回「已缴」状态，等待班主任重新上传凭证"
        style="margin-bottom: 12px"
      />
      <el-form label-width="80px">
        <el-form-item label="打回原因" required>
          <el-input
            v-model="rejectReason"
            type="textarea"
            :rows="3"
            maxlength="255"
            show-word-limit
            placeholder="请说明凭证的问题，例如：金额模糊、凭证与缴费金额不一致"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="rejectVisible = false">取消</el-button>
        <el-button type="danger" :loading="submitting" @click="confirmReject">确定打回</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
/**
 * 缴费管理
 *
 * 财务在这一页做的核心动作只有两个：
 *   ① 核对（钱到账了 → 记账）  ② 打回（凭证有问题 → 退回重传）
 *
 * ⚠️ 只有 canVerify 为 true 的行才显示这两个按钮。
 *    按钮的显示条件必须由【后端算】，
 *    前端自己判断「已缴 && 有凭证」容易和后端逻辑跑偏。
 */

import { ref, reactive, computed, onMounted, watch } from 'vue';
import { ElMessage, ElMessageBox, ElImageViewer } from 'element-plus';
import { Loading, PictureFilled } from '@element-plus/icons-vue';
import {
  FEE_TYPE_NAME,
  PAY_STATUS_NAME,
  SOURCE_MODULE_NAME,
  DeptCode,
  PayStatus,
  type FeeListItem,
  type FeeClassOption,
  type FeeDetail,
  type FeeListQuery,
  type FeeStats,
} from 'shared-types/finance';
import {
  fetchFeeList,
  fetchFeeClasses,
  fetchFeeStats,
  fetchFeeDetail,
  verifyFee,
  rejectFee,
  batchVerifyFee,
} from '@/finance/api/finance';
import { formatAmount, payStatusTagType, dash } from '@/finance/utils/finance';

/* ---------- 列表 ---------- */

const loading = ref(false);
const tableData = ref<FeeListItem[]>([]);
const total = ref(0);
const selectedRows = ref<FeeListItem[]>([]);

/**
 * 部门二级筛选（原型 .dept-tabs：二三期 / 大学部）。
 *
 * ⭐ 2026-10-03 用户指令后已升级为【服务端筛选】：
 *    直接传 deptCode 给 _list 接口，分页统计才准，
 *    也不会再出现「第 1 页有大学部、翻页就没了」的情况。
 */
const dept = ref<'all' | '二三期' | '大学部'>('all');
const className = ref<string | undefined>(undefined);

/** 部门 Tab → deptCode（'all' → undefined 表示不传该条件） */
const DEPT_CODE: Record<string, number | undefined> = {
  all: undefined,
  二三期: DeptCode.JUNIOR_SENIOR,
  大学部: DeptCode.UNIVERSITY,
};

const query = reactive<FeeListQuery>({
  page: 1,
  size: 20,
  studentNo: undefined,
  studentName: undefined,
  feeType: undefined,
  sourceModule: undefined,
  payStatus: undefined,
});

/** 日期区间单独存，提交时拆成 startDate / endDate */
const dateRange = ref<[string, string] | null>(null);

/**
 * 「缴费状态」筛选下拉的可选项。
 *
 * ⚠️ 只列本页真的可能出现的那几个 —— 本页硬约束是
 *    「只看已上传凭证、且非冻结的单据」，所以：
 *      · 「待缴」没有凭证 → 不会出现
 *      · 「冻结」被后端硬性排除 → 不会出现
 *    列出来等于给财务挖坑（选了就是空列表）。
 *
 * 命名对照（2026-10-04 起）：2 = 待核对，3 = 已缴。
 */
const payStatusOptions = computed(() => ({
  [PayStatus.PAID]: PAY_STATUS_NAME[PayStatus.PAID],
  [PayStatus.VERIFIED]: PAY_STATUS_NAME[PayStatus.VERIFIED],
}));

/**
 * ⭐ 班级下拉：从后端「班级字典」接口取【所有拥有的班级】
 *
 * ⚠️ 原来的写法是 `[...new Set(tableData.map(r => r.className))]`，
 *    即「只从当前页数据去重」—— 翻页就变、没缴费记录的班级永远看不到，
 *    这正是用户反馈的「看不到所有拥有的班级」。
 */
const classOptionsRaw = ref<FeeClassOption[]>([]);

/**
 * 下拉里展示的班级：
 *   - 选了「二三期 / 大学部」→ 只看该部门的班级（与 Tab 联动）
 *   - 选「全部部门」→ 所有班级
 */
const classOptions = computed(() => {
  const code = DEPT_CODE[dept.value];
  const rows = code == null ? classOptionsRaw.value : classOptionsRaw.value.filter((c) => c.deptCode === code);
  return rows.map((c) => c.className);
});

/** 加载班级字典（部门切换后要重新拉，保证下拉与 Tab 一致） */
async function loadClassOptions() {
  try {
    classOptionsRaw.value = await fetchFeeClasses(DEPT_CODE[dept.value]);
  } catch (e) {
    console.error('加载班级字典失败', e);
  }
}

/** 页面实际展示的列表（服务端已做完所有筛选，这里直接用） */
const viewList = computed(() => tableData.value);

/** 分页总页数（原型 pager 里的「第 N/M 页」） */
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / (query.size || 20))));

/**
 * 工具栏内联统计（原型 statTip）。
 *
 * ⭐ 2026-10-03 起走 /fee/stats 接口，是【全量口径】。
 *
 * ⚠️ 2026-10-04 修正：这里必须【不带筛选条件】拉取。
 *    原因：工具栏同一行左边显示「共 N 条已上传凭证的缴费单」（N=total，随筛选变），
 *    右边显示「待核对 X · 已缴 Y」，如果 X/Y 也是按筛选算的，
 *    就会出现「筛了已缴 → 左边共 4 条、右边待核对 0」这种自相矛盾的数字，
 *    财务看一眼就懵。所以统计固定为「全部已上传凭证单据」的构成，
 *    与筛选无关，才是这张核对台真正有意义的全局概览。
 */
const stats = ref<FeeStats>({
  total: 0,
  waitVerify: 0,
  verified: 0,
  rejected: 0,
  frozen: 0,
});

const stat = computed(() => ({
  waitVerify: stats.value.waitVerify,
  verified: stats.value.verified,
  rejected: stats.value.rejected,
}));

/* ---------- 实时筛选（2026-10-03 用户指令） ---------- */

/**
 * 每次请求的序号。
 *
 * 实时筛选会「每敲一个字就发一次请求」，响应不保证按顺序回来；
 * 只认最后一次发出的结果，避免「先发的慢请求后到」把新结果覆盖掉。
 */
let reqSeq = 0;

/** 搜索框防抖定时器 */
let keywordTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 搜索框输入 → 防抖 300ms 后自动查询。
 *
 * 为什么不像下拉那样立即查：打字会连发多次请求，防抖能少打十几次接口。
 * 日期区间 / 下拉选择的动作都是一次性的，不需要防抖。
 */
function handleKeywordInput() {
  if (keywordTimer) clearTimeout(keywordTimer);
  keywordTimer = setTimeout(() => {
    handleSearch();
  }, 300);
}

/**
 * 收集当前全部筛选条件（列表与统计共用，保证口径一致）。
 *
 * ⚠️ 下拉（班级/类型/状态/来源/日期）全部走【服务端筛选】，
 *    前端只负责把值拼进请求 —— 这样翻页、统计都是对的。
 */
function buildParams(): FeeListQuery {
  return {
    page: query.page,
    size: query.size,
    studentNo: query.studentNo || undefined,
    studentName: query.studentName || undefined,
    className: className.value || undefined,
    deptCode: DEPT_CODE[dept.value] as any,
    feeType: query.feeType,
    sourceModule: query.sourceModule,
    payStatus: query.payStatus,
    startDate: dateRange.value?.[0],
    endDate: dateRange.value?.[1],
  };
}

async function loadData() {
  const seq = ++reqSeq;
  loading.value = true;
  try {
    const params = buildParams();
    const data = await fetchFeeList(params);
    // 只认最后一次请求的结果（实时筛选下防止旧响应覆盖新结果）
    if (seq !== reqSeq) return;
    tableData.value = data.list;
    total.value = data.total;

    // ⚠️ 统计【不带任何筛选条件】：它是工具栏右侧的「全局构成」概览，
    //    必须与筛选无关，否则会和左边的「共 N 条」自相矛盾（详见 stats 的注释）。
    const s = await fetchFeeStats({});
    if (seq === reqSeq) stats.value = s;
  } catch (e) {
    if (seq === reqSeq) console.error('加载缴费列表失败', e);
  } finally {
    if (seq === reqSeq) loading.value = false;
  }
}

/** 条件变更后的统一入口：回到第 1 页再查（筛选变了还停在第 3 页会看到空列表） */
function handleSearch() {
  if (keywordTimer) {
    clearTimeout(keywordTimer);
    keywordTimer = null;
  }
  query.page = 1;
  loadData();
}

/**
 * 切换部门 Tab。
 * ⭐ 与原来不同：现在会真的重新请求（服务端筛选），并同步刷新班级下拉。
 */
async function handleDept(d: 'all' | '二三期' | '大学部') {
  if (dept.value === d) return;
  dept.value = d;
  // 部门变了，原来选的班级可能不属于新部门，必须清掉
  className.value = undefined;
  query.page = 1;
  await loadClassOptions();
  await loadData();
}

function handleReset() {
  query.page = 1;
  query.size = 20;
  query.studentNo = undefined;
  query.studentName = undefined;
  query.feeType = undefined;
  query.sourceModule = undefined;
  query.payStatus = undefined;
  dateRange.value = null;
  // 部门 Tab 和班级下拉也要一起复位，否则「重置」看着没清干净
  dept.value = 'all';
  className.value = undefined;
  loadClassOptions();
  loadData();
}

/**
 * 距到期还剩几天。
 * 返回 null 表示没有到期日期（不该显示剩余天数）。
 */
function restDays(due?: string | null): number | null {
  if (!due) return null;
  const t = new Date(String(due).replace(/-/g, '/')).getTime();
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - Date.now()) / 86400000);
}

/** 剩余天数的标签颜色（原型 restTag：过期红 / ≤30 天橙 / 其余蓝） */
function restTagType(d: number): 'danger' | 'warning' | 'primary' {
  if (d < 0) return 'danger';
  if (d <= 30) return 'warning';
  return 'primary';
}

function restTagText(d: number): string {
  if (d < 0) return `已过期 ${Math.abs(d)} 天`;
  return `剩余 ${d} 天`;
}

function handleSelectionChange(rows: FeeListItem[]) {
  selectedRows.value = rows;
}

/** 只有 canVerify 的行才能勾选（批量核对的前提） */
function isSelectable(row: FeeListItem): boolean {
  return row.canVerify;
}

/** 来源模块标签颜色：咨询蓝 / 教务绿 / 财务自建灰 */
function sourceTagType(m?: number): 'primary' | 'success' | 'info' {
  if (m === 1) return 'primary';
  if (m === 2) return 'success';
  return 'info';
}

/* ---------- 详情 ---------- */

const detailVisible = ref(false);
const detail = ref<FeeDetail | null>(null);

async function handleDetail(row: FeeListItem) {
  try {
    detail.value = await fetchFeeDetail(row.id);
    detailVisible.value = true;
  } catch (e) {
    console.error('加载缴费详情失败', e);
  }
}

/* ---------- 缴费凭证查看 ---------- */

const previewVisible = ref(false);
const previewList = ref<string[]>([]);

/**
 * 把数据库里的相对路径拼成完整 URL。
 *
 * 数据库存的是 "/uploads/voucher/v001.jpg"（相对路径），
 * 不能写死后端地址 —— 本地开发走 Vite 代理，联调时后端在同事机器上。
 * 用相对路径让浏览器按当前页面的 origin 去请求，
 * 由 Vite 代理（或生产环境的 Nginx）转发到后端。
 */
function voucherFullUrl(url?: string): string {
  if (!url) return '';
  // 已经是完整 URL 就原样返回
  if (/^https?:\/\//i.test(url)) return url;
  return url.startsWith('/') ? url : `/${url}`;
}

/** 「查看大图」——打开图片查看器（支持缩放/旋转/切换） */
function openPreview(url?: string) {
  if (!url) return;
  previewList.value = [voucherFullUrl(url)];
  previewVisible.value = true;
}

/** 「新窗口打开」——有些凭证字很小，新标签页看更清楚，也方便下载 */
function openInNewTab(url?: string) {
  if (!url) return;
  window.open(voucherFullUrl(url), '_blank', 'noopener,noreferrer');
}

/* ---------- 核对 ---------- */

async function handleVerify(row: FeeListItem) {
  /**
   * ★ 2026-10-19 一张凭证覆盖多张单据时，把「本单只是其中一项」讲清楚：
   *    财务核对的是「钱到账了没有」，凭证上的合计金额和本单金额本来就不同，
   *    不提示的话会被当成数据错乱，或者误以为少记了钱。
   */
  const groupTip =
    (row.voucherGroupCount || 1) > 1
      ? `（注意：这张凭证共覆盖 ${row.voucherGroupCount} 笔单据，合计 ${formatAmount(
          row.voucherGroupAmount,
        )}，本单只是其中一项；本次只核对本单，其余同凭证单据需分别核对）`
      : '';
  try {
    await ElMessageBox.confirm(
      `确认「${row.studentName}」的 ${row.feeTypeName} ${formatAmount(row.amount)} 已到账并核对入账吗？${groupTip}`,
      '核对确认',
      { type: 'warning', confirmButtonText: '确认核对', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }

  try {
    const r = await verifyFee({ id: row.id });
    ElMessage.success(`核对成功，已生成账单 ${r.billNo}`);
    loadData();
  } catch (e) {
    // 错误提示已由 request.ts 统一处理
  }
}

/* ---------- 批量核对 ---------- */

async function handleBatchVerify() {
  const ids = selectedRows.value.map((r) => r.id);
  if (!ids.length) return;

  try {
    await ElMessageBox.confirm(
      `确认核对选中的 ${ids.length} 笔缴费单吗？核对后会自动生成账单。`,
      '批量核对',
      { type: 'warning', confirmButtonText: '确认核对', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }

  try {
    const r = await batchVerifyFee({ ids });
    ElMessage.success(`成功核对 ${r.successCount} 笔，生成账单 ${r.billNos.length} 张`);
    loadData();
  } catch (e) {
    // 已统一处理
  }
}

/* ---------- 打回 ---------- */

const rejectVisible = ref(false);
const rejectReason = ref('');
const submitting = ref(false);
const rejectTarget = ref<FeeListItem | null>(null);

function handleReject(row: FeeListItem) {
  rejectTarget.value = row;
  rejectReason.value = '';
  rejectVisible.value = true;
}

async function confirmReject() {
  if (!rejectReason.value.trim()) {
    ElMessage.warning('请填写打回原因');
    return;
  }
  if (!rejectTarget.value) return;

  submitting.value = true;
  try {
    await rejectFee({ id: rejectTarget.value.id, rejectReason: rejectReason.value.trim() });
    ElMessage.success('已打回');
    rejectVisible.value = false;
    loadData();
  } catch (e) {
    // 已统一处理
  } finally {
    submitting.value = false;
  }
}

/**
 * 首次进入：并发拉「班级字典」和「缴费列表」。
 *
 * ⚠️ 两个请求互不依赖，用 Promise.all 并发，别串行等（串行会白等一个来回）。
 */
onMounted(async () => {
  await Promise.all([loadClassOptions(), loadData()]);
});
</script>

<style scoped>
.page-container {
  padding: 16px;
}

/* 卡片内的通栏版式由 element-theme.css 的 .card-flush 统一控制 */

/* 条件行：搜索 + 筛选 + 查询/重置，一行平铺（原型 .toolbar 上半部分） */
.filter-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 12px 16px;
  border-bottom: 1px solid #F6F3EF;
}

.count-hint {
  font-size: 12px;
  color: #9C8D88;
}

/* 「条件变更即筛选」的浅色提示，让用户知道不用点查询 */
.live-hint {
  font-size: 12px;
  color: #B3A69F;
  margin-left: 4px;
  user-select: none;
}

.amount {
  font-weight: 600;
  color: #443432;
}

/* 一张凭证覆盖多张单据时的小字说明（共 N 笔 · 合计 ¥X） */
.voucher-group {
  margin-top: 2px;
  font-size: 11px;
  line-height: 1.3;
  color: #A2938E;
  white-space: nowrap;
}

/* 详情弹窗里「凭证覆盖」那一行的括号说明 */
.voucher-group-inline {
  color: #A2938E;
  font-size: 12px;
}

/* ---------- 「这笔钱包含」子表（合计单的分项） ---------- */

.items-block {
  margin-top: 16px;
}

.items-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 6px;
}

.items-title {
  font-weight: 600;
  color: #443432;
  font-size: 13px;
}

.items-total {
  font-size: 12px;
  color: #A2938E;
}

.items-amount {
  font-weight: 600;
  color: #443432;
}

.items-discount {
  color: #C06B2A;
}

.items-note {
  margin-top: 6px;
  font-size: 12px;
  color: #A2938E;
}

.dash {
  color: #C4B8B4;
}

.reject-text {
  color: #B22A23;
}

/* ---------- 缴费凭证区块 ---------- */

.voucher-block {
  margin-top: 16px;
  border: 1px solid #F1EAE5;
  border-radius: 6px;
  overflow: hidden;
}

.voucher-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  background: #FAF7F4;
  border-bottom: 1px solid #F1EAE5;
}

.voucher-title {
  font-size: 14px;
  font-weight: 600;
  color: #443432;
}

.voucher-body {
  display: flex;
  gap: 18px;
  padding: 14px;
}

.voucher-thumb-wrap {
  flex-shrink: 0;
  width: 150px;
  text-align: center;
}

.voucher-thumb {
  width: 150px;
  height: 200px;
  border: 1px solid #F1EAE5;
  border-radius: 6px;
  cursor: zoom-in;
  background: #F6F3EF;
  transition: border-color 0.2s;
}

.voucher-thumb:hover {
  border-color: #CD3A33;
}

.thumb-tip {
  margin-top: 6px;
  font-size: 12px;
  color: #A2938E;
}

.thumb-loading,
.thumb-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 100%;
  color: #C4B8B2;
  font-size: 12px;
}

.voucher-info {
  flex: 1;
  min-width: 0;
}

.info-row {
  display: flex;
  align-items: center;
  padding: 8px 0;
  border-bottom: 1px dashed #F1EBE7;
  font-size: 13px;
}

.info-row:last-child {
  border-bottom: none;
}

.info-label {
  flex-shrink: 0;
  width: 76px;
  color: #A2938E;
}

.info-value {
  flex: 1;
  min-width: 0;
  color: #443432;
  word-break: break-all;
}

.info-value.mono {
  font-family: Consolas, Monaco, 'Courier New', monospace;
  letter-spacing: 0.3px;
}

.shared-row {
  align-items: flex-start;
}

.shared-tag {
  margin: 0 6px 6px 0;
}
</style>
