<template>
  <div class="page-container">
    <!-- ============ 表格区 ============ -->
    <el-card shadow="never" class="table-card card-flush">
      <!-- 条件行：搜索 + 筛选 + 查询/重置 -->
      <div class="filter-row">
        <el-input
          v-model="query.studentName"
          placeholder="搜索学号 / 姓名"
          clearable
          style="width: 190px"
          @keyup.enter="handleSearch"
        />
        <el-select v-model="query.freezeSource" placeholder="冻结来源" clearable style="width: 140px">
          <el-option label="自动冻结（学籍）" :value="1" />
          <el-option label="手动冻结" :value="2" />
        </el-select>
        <el-switch v-model="onlyFrozen" active-text="只看冻结中" @change="handleSearch" />
        <el-button type="primary" @click="handleSearch">查询</el-button>
        <el-button @click="handleReset">重置</el-button>
      </div>

      <!-- 工具条：左边说明，右边统计 -->
      <div class="table-toolbar">
        <div class="tools">
          <!-- ⚠️ 统计口径：后端列表接口没有「冻结中/已解冻」聚合字段，
               这里只能按【当前页】算，所以文案写成「本页」避免误解全量。 -->
          <span class="stat-line">
            本页 <b>{{ frozenCount }}</b> 人冻结中 · 共 <b>{{ total }}</b> 条记录
          </span>
        </div>
        <div class="tools">
          <span class="stat-line">学生的餐费、住宿费在休学期间不消耗，复学后自动解冻</span>
        </div>
      </div>

      <el-table
        v-loading="loading"
        :data="tableData"
        stripe
        style="width: 100%"
        empty-text="暂无匹配数据"
      >
        <el-table-column type="index" label="序号" width="60" align="center" />
        <!-- 未分班的学生没有学号，显示「—」（与缴费核对台同口径） -->
        <el-table-column label="学号" width="115">
          <template #default="{ row }">{{ dash(row.studentNo) }}</template>
        </el-table-column>
        <el-table-column prop="studentName" label="姓名" width="90" />
        <el-table-column prop="className" label="班级" width="85">
          <template #default="{ row }">{{ dash(row.className) }}</template>
        </el-table-column>
        <el-table-column label="学生状态" width="100" align="center">
          <template #default="{ row }">
            <el-tag :type="row.studentStatus === 6 ? 'warning' : 'info'" size="small">
              {{ row.studentStatusName }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="freezeScope" label="冻结范围" width="120" align="center" />
        <el-table-column label="冻结来源" width="110" align="center">
          <template #default="{ row }">
            <el-tag :type="freezeSourceTagType(row.freezeSource)" size="small" effect="plain">
              {{ row.freezeSourceName }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="餐费冻结期" width="200" align="center">
          <template #default="{ row }">
            <div v-if="row.mealFrom" class="period">
              {{ row.mealFrom }} ~ {{ dash(row.mealExpire) }}
            </div>
            <span v-else class="muted">未冻结餐费</span>
          </template>
        </el-table-column>
        <el-table-column label="餐费剩余" width="130" align="center">
          <template #default="{ row }">
            <el-tag v-if="row.mealFrom" :type="restDaysTagType(row.mealRestDays)" size="small">
              {{ restDaysText(row.mealRestDays) }}
            </el-tag>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="住宿费冻结期" width="200" align="center">
          <template #default="{ row }">
            <div v-if="row.dormFrom" class="period">
              {{ row.dormFrom }} ~ {{ dash(row.dormExpire) }}
            </div>
            <span v-else class="muted">未冻结住宿费</span>
          </template>
        </el-table-column>
        <el-table-column label="住宿费剩余" width="130" align="center">
          <template #default="{ row }">
            <el-tag v-if="row.dormFrom" :type="restDaysTagType(row.dormRestDays)" size="small">
              {{ restDaysText(row.dormRestDays) }}
            </el-tag>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="90" align="center">
          <template #default="{ row }">
            <el-tag :type="row.isFrozen ? 'danger' : 'info'" size="small">
              {{ row.isFrozen ? '冻结中' : '已解冻' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="130" fixed="right" align="center">
          <template #default="{ row }">
            <el-button
              v-if="row.isFrozen"
              link
              type="primary"
              size="small"
              @click="handleUnfreeze(row)"
            >
              解冻
            </el-button>
            <span v-else class="muted">—</span>
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

    <!-- ============ 解冻弹窗 ============ -->
    <el-dialog v-model="unfreezeVisible" title="解冻" width="520px" @closed="unfreezeReason = ''">
      <el-alert
        v-if="unfreezeTarget?.freezeSource === 1"
        type="warning"
        :closable="false"
        show-icon
        title="这条是「自动冻结」，正常应由教务复学后自动解冻。手动解冻仅用于处理异常情况。"
        style="margin-bottom: 12px"
      />
      <el-descriptions v-if="unfreezeTarget" :column="2" border size="small" style="margin-bottom: 12px">
        <el-descriptions-item label="学生">{{ unfreezeTarget.studentName }}</el-descriptions-item>
        <el-descriptions-item label="冻结范围">{{ unfreezeTarget.freezeScope }}</el-descriptions-item>
        <el-descriptions-item label="冻结日期">{{ unfreezeTarget.freezeDate }}</el-descriptions-item>
        <el-descriptions-item label="冻结原因">{{ unfreezeTarget.freezeReason }}</el-descriptions-item>
      </el-descriptions>

      <el-form label-width="80px">
        <el-form-item label="解冻原因" required>
          <el-input
            v-model="unfreezeReason"
            type="textarea"
            :rows="3"
            maxlength="255"
            show-word-limit
            placeholder="请说明解冻原因（会记入解冻记录）"
          />
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="unfreezeVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="confirmUnfreeze">确认解冻</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
/**
 * 冻结名单
 *
 * ⚠️ 这一页和别的列表页不一样：它是「学籍联动的结果视图」。
 *    数据主要不是财务手工录的，而是教务模块把学生改成「休学」时
 *    调 /api/finance/freeze/sync 自动生成的。
 *    所以这里只提供「解冻」这一个兜底操作，不提供「冻结」（走手工接口）。
 */

import { ref, reactive, computed, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';

import type { FreezeListItem, FreezeListQuery } from 'shared-types/finance';
import { fetchFreezeList, unfreeze } from '@/finance/api/finance';
import {
  freezeSourceTagType,
  restDaysTagType,
  restDaysText,
  dash,
} from '@/finance/utils/finance';

const loading = ref(false);
const tableData = ref<FreezeListItem[]>([]);
const total = ref(0);
const onlyFrozen = ref(false);

/** 当前页里仍处于冻结中的条数（工具栏统计） */
const frozenCount = computed(() => tableData.value.filter((r) => r.isFrozen).length);

/** 分页总页数（原型 pager 里的「第 N/M 页」） */
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / (query.size || 20))));

const query = reactive<FreezeListQuery>({
  page: 1,
  size: 20,
  studentNo: undefined,
  studentName: undefined,
  freezeSource: undefined,
});

async function loadData() {
  loading.value = true;
  try {
    const data = await fetchFreezeList({ ...query, onlyFrozen: onlyFrozen.value || undefined });
    tableData.value = data.list;
    total.value = data.total;
  } catch (e) {
    console.error('加载冻结名单失败', e);
  } finally {
    loading.value = false;
  }
}

function handleSearch() {
  query.page = 1;
  loadData();
}

function handleReset() {
  query.page = 1;
  query.size = 20;
  query.studentNo = undefined;
  query.studentName = undefined;
  query.freezeSource = undefined;
  onlyFrozen.value = false;
  loadData();
}

/* ---------- 解冻 ---------- */

const unfreezeVisible = ref(false);
const unfreezeTarget = ref<FreezeListItem | null>(null);
const unfreezeReason = ref('');
const submitting = ref(false);

function handleUnfreeze(row: FreezeListItem) {
  unfreezeTarget.value = row;
  unfreezeReason.value = '';
  unfreezeVisible.value = true;
}

async function confirmUnfreeze() {
  if (!unfreezeReason.value.trim()) {
    ElMessage.warning('请填写解冻原因');
    return;
  }
  if (!unfreezeTarget.value) return;

  submitting.value = true;
  try {
    await unfreeze({ id: unfreezeTarget.value.id, unfreezeReason: unfreezeReason.value.trim() });
    ElMessage.success('已解冻');
    unfreezeVisible.value = false;
    loadData();
  } catch (e) {
    // 已统一处理
  } finally {
    submitting.value = false;
  }
}

onMounted(loadData);
</script>

<style scoped>
.page-container {
  padding: 16px;
}

/* 卡片内通栏版式（.filter-row / .table-toolbar / .pager-bar）由 element-theme.css 统一提供 */

.period {
  font-size: 12px;
  color: #6B5C58;
}

.muted {
  color: #C4B8B2;
  font-size: 12px;
}
</style>
