<template>
  <div class="page-container">
    <el-card shadow="never" class="table-card card-flush">
      <!-- ============ 部门二级 Tab（原型 .dept-tabs）============ -->
      <div class="dept-tabs">
        <b :class="{ on: dept === 'all' }" @click="handleDept('all')">全部部门</b>
        <b :class="{ on: dept === '二三期' }" @click="handleDept('二三期')">二三期</b>
        <b :class="{ on: dept === '大学部' }" @click="handleDept('大学部')">大学部</b>
      </div>

      <!-- ============ 条件行：搜索 + 班级下拉 ============ -->
      <div class="filter-row">
        <el-input
          v-model="query.keyword"
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
      </div>

      <!-- ============ 工具条 ============ -->
      <div class="table-toolbar">
        <div class="tools">
          <span class="count-hint">
            共 <b>{{ total }}</b> 位学员 · 按学员归集缴费记录（点「详情」展开四类费用）
          </span>
        </div>
        <div class="tools">
          <span class="stat-line">
            合计 <b>{{ formatAmount(pageTotalAmount) }}</b> · 缴费
            <b>{{ pageTotalCount }}</b> 笔
          </span>
        </div>
      </div>

      <!--
        ============ 明细表（按学员归集）============
        ⭐ 原型规则（学管财务管理原型-20260923）：
           一行 = 一个学员；四类列各自显示 金额 + 笔数 + 最近缴费日期；
           点「详情」→ 展开四类分组（默认折叠）→ 点某组展开该组每笔记录
           （日期 + 凭证号 + 查看凭证）。
      -->
      <el-table
        ref="tableRef"
        v-loading="loading"
        :data="tableData"
        stripe
        style="width: 100%"
        empty-text="暂无缴费账单"
        row-key="studentId"
      >
        <!-- 未分班的学生没有学号，显示「—」（与缴费核对台同口径） -->
        <el-table-column label="学号" width="110">
          <template #default="{ row }">{{ dash(row.studentNo) }}</template>
        </el-table-column>
        <el-table-column prop="studentName" label="姓名" width="90" />
        <el-table-column label="班级" width="100">
          <template #default="{ row }">{{ dash(row.className) }}</template>
        </el-table-column>

        <!-- 五类费用列 -->
        <el-table-column
          v-for="g in GROUP_COLS"
          :key="g.key"
          :label="g.title"
          min-width="150"
        >
          <template #default="{ row }">
            <div class="cell2">
              <span class="money income">{{ formatAmount(row[g.key]?.amount) }}</span>
              <span class="tag tag-gray">{{ row[g.key]?.count ?? 0 }} 笔</span>
              <div class="sub">
                <template v-if="row[g.key]?.count">
                  最近缴费 {{ row[g.key]?.latestDate || '—' }}
                </template>
                <template v-else>暂无缴费记录</template>
              </div>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="操作" width="90" fixed="right">
          <template #default="{ row }">
            <el-button
              link
              type="primary"
              size="small"
              @click="toggleExpand(row)"
            >
              {{ isExpanded(row.studentId) ? '收起 ‹' : '详情 ›' }}
            </el-button>
          </template>
        </el-table-column>

        <!--
          ============ 展开行：四类分组（默认折叠）============
          ⚠️ 两级展开：
             第一级 = 这个学员的四类费用分组（本展开行）
             第二级 = 点某个分组标题，展开该组每笔缴费记录
        -->
        <el-table-column type="expand" width="1" class-name="expand-col">
          <template #default="{ row }">
            <div class="detail">
              <div class="dgrid">
                <div
                  v-for="g in GROUP_COLS"
                  :key="g.key"
                  class="dbox"
                  :class="{ open: isGroupOpen(row.studentId, g.key) }"
                >
                  <h4 @click="toggleGroup(row.studentId, g.key)">
                    <span class="dt">{{ row[g.key]?.name || g.title }}</span>
                    <em>{{ row[g.key]?.count ?? 0 }} 笔</em>
                    <span class="money">{{ formatAmount(row[g.key]?.amount) }}</span>
                    <i class="ar">{{ isGroupOpen(row.studentId, g.key) ? '收起 ‹' : '展开 ›' }}</i>
                  </h4>
                  <div v-if="isGroupOpen(row.studentId, g.key)" class="dbody">
                    <div v-if="!(row[g.key]?.records || []).length" class="none">
                      暂无缴费记录
                    </div>
                    <div
                      v-for="rec in row[g.key]?.records || []"
                      :key="rec.billNo"
                      class="rec"
                    >
                      <div class="l">
                        <b>{{ rec.feeTypeName }} {{ formatAmount(rec.amount) }}</b>
                        <span>{{ rec.date }} · 凭证号 {{ rec.voucherNo || '—' }}</span>
                      </div>
                      <el-button
                        v-if="rec.voucherUrl"
                        link
                        type="primary"
                        size="small"
                        @click="openPreview(rec.voucherUrl)"
                      >
                        查看凭证
                      </el-button>
                      <span v-else class="no-voucher">无凭证</span>
                    </div>
                  </div>
                </div>
              </div>
              <div class="dtip">点击任一费用分组可展开该组的全部缴费记录与凭证</div>
            </div>
          </template>
        </el-table-column>
      </el-table>

      <!-- 分页文案条 -->
      <div class="pager-bar">
        <span>共 {{ total }} 条记录，第 {{ query.page }}/{{ totalPages }} 页</span>
        <el-pagination
          v-model:current-page="query.page"
          v-model:page-size="query.size"
          :page-sizes="[10, 20, 50, 100]"
          :total="total"
          layout="sizes, prev, pager, next"
          @size-change="handleSizeChange"
          @current-change="loadData"
        />
      </div>
    </el-card>

    <!-- ============ 凭证大图预览 ============ -->
    <el-image-viewer
      v-if="previewVisible"
      :url-list="previewList"
      @close="previewVisible = false"
    />
  </div>
</template>

<script setup lang="ts">
/**
 * 账单明细（按学员归集）· 缴费明细
 *
 * ⭐ 原型规则（2026-10-04 用户指令要求还原）：
 *    1) 列表按【学员】归集 —— 一行一个学生，显示 学号/姓名/班级
 *       + 四类列（学费/餐费/住宿费/保险费）各自的 金额 + 笔数 + 最近缴费日期
 *    2) 点「详情」→ 展开四类分组（默认全部折叠）
 *    3) 点某个分组 → 展开该组【每一笔】缴费记录：类型 + 金额 + 日期 + 凭证号 + 查看凭证
 *
 * ⚠️ 与「流水视角」（一行一笔账单）的区别：
 *    原型 `学管财务管理原型-20260923/index.html` 的 RENDER['bill-pay'] 用的是
 *    【按学员归集】。财务看账的诉求是「这个学生一共交了哪些费、凭证在哪」，
 *    而不是「今天一共收了几笔」。所以列表以学员为主体。
 *
 * ⚠️ 展开状态用「studentId + 分组 key」做键，不用行对象引用，
 *    因为分页/重新查询后行对象会换新实例，用引用做键会全部丢失展开态。
 */

import { ref, reactive, computed, onMounted } from 'vue';
import { ElMessage } from 'element-plus';

import type { BillStudentRow, BillStudentQuery, DeptCode } from 'shared-types/finance';
import { fetchBillStudents, fetchBillClasses } from '@/finance/api/finance';
import { formatAmount, dash } from '@/finance/utils/finance';

/** 五类费用列（顺序与原型一致：学费 / 餐费 / 住宿费 / 保险费 + 杂费） */
const GROUP_COLS = [
  { key: 'tuition', title: '学费缴费记录' },
  { key: 'meal', title: '餐费缴费记录' },
  { key: 'dorm', title: '住宿费缴费记录' },
  { key: 'insurance', title: '保险费' },
  // ★ 2026-10-22：押金 + 校服单独成「杂费」列
  { key: 'other', title: '杂费缴费记录' },
] as const;

const loading = ref(false);
const tableData = ref<BillStudentRow[]>([]);
const total = ref(0);
const classOptions = ref<string[]>([]);

/** 部门 Tab：all / 二三期(1) / 大学部(2) */
const dept = ref<'all' | '二三期' | '大学部'>('all');
const className = ref<string | undefined>(undefined);
const dateRange = ref<[string, string] | null>(null);

// ⚠️ 展开状态（expandedStudents / openGroups）的声明在下方「两级展开」小节，
//    这里不重复声明。

const previewVisible = ref(false);
const previewList = ref<string[]>([]);

const query = reactive<BillStudentQuery>({
  page: 1,
  size: 20,
  keyword: undefined,
  className: undefined,
  deptCode: undefined,
  startDate: undefined,
  endDate: undefined,
});

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / (query.size || 20))));

/** 本页合计（当前页所有学员的金额与笔数） */
const pageTotalAmount = computed(() =>
  tableData.value.reduce((s, r) => s + (Number(r.totalAmount) || 0), 0),
);
const pageTotalCount = computed(() =>
  tableData.value.reduce((s, r) => s + (Number(r.totalCount) || 0), 0),
);

const deptCodeOf = (d: typeof dept.value): DeptCode | undefined =>
  d === '二三期' ? 1 : d === '大学部' ? 2 : undefined;

/** 班级下拉：随部门 Tab 收敛（与缴费管理同思路，保证「选了就查得到」） */
async function loadClassOptions() {
  try {
    const list = await fetchBillClasses(deptCodeOf(dept.value));
    classOptions.value = list.map((c) => c.className);
    // 切部门后原来选的班级可能不在新部门里 → 清掉，避免选出空列表
    if (className.value && !classOptions.value.includes(className.value)) {
      className.value = undefined;
      query.className = undefined;
    }
  } catch (e) {
    console.error('加载班级字典失败', e);
    classOptions.value = [];
  }
}

async function loadData() {
  loading.value = true;
  try {
    query.deptCode = deptCodeOf(dept.value);
    query.className = className.value;
    query.startDate = dateRange.value?.[0];
    query.endDate = dateRange.value?.[1];

    const data = await fetchBillStudents(query);
    tableData.value = data.list;
    total.value = data.total;
    // 换页后收起展开行，避免「上一页的展开态串到下一页」
    expandedStudents.value = new Set();
    openGroups.value = new Set();
  } catch (e) {
    console.error('加载账单明细失败', e);
    ElMessage.error('加载账单明细失败');
  } finally {
    loading.value = false;
  }
}

/** 搜索框防抖（打字连发太费接口） */
let kwTimer: ReturnType<typeof setTimeout> | null = null;
function handleKeywordInput() {
  if (kwTimer) clearTimeout(kwTimer);
  kwTimer = setTimeout(() => handleSearch(), 300);
}

function handleSearch() {
  query.page = 1;
  loadData();
}

function handleSizeChange() {
  query.page = 1;
  loadData();
}

async function handleDept(d: typeof dept.value) {
  if (dept.value === d) return;
  dept.value = d;
  query.page = 1;
  await Promise.all([loadClassOptions(), loadData()]);
}

function handleReset() {
  query.page = 1;
  query.size = 20;
  query.keyword = undefined;
  className.value = undefined;
  dateRange.value = null;
  dept.value = 'all';
  Promise.all([loadClassOptions(), loadData()]);
}

/* ---------- 两级展开 ---------- */

/**
 * el-table 实例引用。
 *
 * ⚠️ 用 tableRef.toggleRowExpansion(row) 而不是自己去改 DOM / 找内部 store：
 *    el-table 的展开态是它自己维护的，外部硬改容易和它打架（箭头状态不同步）。
 *    官方暴露了 toggleRowExpansion，配合 row-key="studentId" 就能稳定定位行。
 */
const tableRef = ref<any>(null);

/** 自维护的展开集合 —— 只用来渲染按钮文案（「详情 ›」/「收起 ‹」） */
const expandedStudents = ref<Set<string>>(new Set());

/** 二级展开：`${studentId}:${groupKey}` → true（四类分组里哪些被展开） */
const openGroups = ref<Set<string>>(new Set());

function isExpanded(studentId: string): boolean {
  return expandedStudents.value.has(studentId);
}

function toggleExpand(row: BillStudentRow) {
  tableRef.value?.toggleRowExpansion(row);
  const s = new Set(expandedStudents.value);
  if (s.has(row.studentId)) s.delete(row.studentId);
  else s.add(row.studentId);
  expandedStudents.value = s;
}

function isGroupOpen(studentId: string, groupKey: string): boolean {
  return openGroups.value.has(`${studentId}:${groupKey}`);
}

function toggleGroup(studentId: string, groupKey: string) {
  const key = `${studentId}:${groupKey}`;
  const s = new Set(openGroups.value);
  if (s.has(key)) s.delete(key);
  else s.add(key);
  openGroups.value = s;
}

/* ---------- 凭证查看 ---------- */

function voucherFullUrl(url?: string): string {
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  return url.startsWith('/') ? url : `/${url}`;
}

function openPreview(url?: string) {
  if (!url) return;
  previewList.value = [voucherFullUrl(url)];
  previewVisible.value = true;
}

onMounted(() => {
  loadClassOptions();
  loadData();
});
</script>

<style scoped>
.page-container {
  padding: 16px;
}

/* 四类费用单元格（金额 + 笔数 + 最近日期） */
.cell2 {
  line-height: 1.5;
}

.cell2 .money {
  font-weight: 600;
}

.cell2 .tag {
  display: inline-block;
  margin-left: 6px;
  padding: 0 6px;
  font-size: 11px;
  border-radius: 8px;
  background: #F6F1EC;
  color: #7A6C67;
}

.cell2 .sub {
  font-size: 11.5px;
  color: #9C8D88;
  margin-top: 2px;
}

.income {
  color: #B22A23;
  font-weight: 600;
}

/* ---------- 展开区：四类分组 ---------- */
.detail {
  padding: 8px 12px 12px;
  background: #FAF6F2;
}

.dgrid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

/* ★ 2026-10-22：五类分组为奇数，最后一项独占整行时拉满宽度，避免右侧留空 */
.dbox:last-child:nth-child(odd) {
  grid-column: span 2;
}

.dbox {
  border: 1px solid #E7DDD7;
  border-radius: 8px;
  background: #fff;
  overflow: hidden;
}

.dbox h4 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  padding: 9px 12px;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  background: #FAF7F4;
  user-select: none;
}

.dbox h4 .dt {
  color: #443432;
}

.dbox h4 em {
  font-style: normal;
  font-size: 11px;
  color: #9C8D88;
  background: #F4EEE9;
  border-radius: 8px;
  padding: 0 6px;
}

.dbox h4 .money {
  margin-left: auto;
  color: #B22A23;
}

.dbox h4 .ar {
  font-style: normal;
  font-size: 11px;
  color: #B22A23;
}

.dbox .dbody {
  padding: 4px 12px 10px;
}

.rec {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 0;
  border-bottom: 1px dashed #F4EEE9;
}

.rec:last-child {
  border-bottom: none;
}

.rec .l b {
  display: block;
  font-size: 12.5px;
  color: #443432;
}

.rec .l span {
  font-size: 11.5px;
  color: #9C8D88;
}

.none {
  font-size: 12px;
  color: #B3A69F;
  padding: 8px 0;
}

.no-voucher {
  font-size: 11.5px;
  color: #C4B8B2;
}

.dtip {
  margin-top: 10px;
  font-size: 11.5px;
  color: #B3A69F;
}

/* 隐藏 el-table 默认展开列的小箭头（我们的「详情」在操作列） */
:deep(.expand-col) {
  width: 1px;
  padding: 0 !important;
}

:deep(.expand-col .cell) {
  display: none;
}

/* 卡片内通栏版式（.filter-row / .table-toolbar / .pager-bar）由 element-theme.css 统一提供 */
</style>
