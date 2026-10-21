<template>
  <div ref="wrapRef" class="dca">
    <el-alert class="dca-tip" type="info" :closable="false" show-icon>
      <template #title>
        班主任提交的<b>换宿 / 退宿</b>申请在这里审批。
        <b>通过后会自动改宿舍数据</b>：调换宿舍 = 释放原床位 + 占用新床位 + 更新学生宿舍；
        退宿 = 释放原床位 + 清空学生宿舍。驳回只改状态，不动床位。
      </template>
    </el-alert>

    <el-form class="dca-filter" inline>
      <el-form-item label="状态">
        <el-select v-model="query.status" style="width: 130px">
          <el-option label="待审批" :value="2" />
          <el-option label="已通过" :value="4" />
          <el-option label="已驳回" :value="5" />
          <el-option label="全部" :value="0" />
        </el-select>
      </el-form-item>
      <el-form-item label="关键字">
        <el-input
          v-model="query.keyword"
          placeholder="学生 / 学号 / 宿舍号"
          clearable
          style="width: 220px"
          @keyup.enter="load"
        />
      </el-form-item>
      <el-form-item>
        <el-button type="primary" @click="load">查询</el-button>
        <el-button @click="reset">重置</el-button>
      </el-form-item>
    </el-form>

    <el-table ref="tableRef" v-loading="loading" :data="pageRows" border stripe empty-text="暂无申请">
      <!-- ★ 2026-10-21：列收成 7 列（学生、换宿各占两行），1080 宽也不用横向拖 -->
      <el-table-column label="类型" width="78" align="center">
        <template #default="{ row }">
          <el-tag :type="row.bizType === 2 ? 'warning' : 'primary'" size="small" effect="plain">
            {{ row.bizTypeName }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="学生" min-width="140">
        <template #default="{ row }">
          <div class="dca-cell">
            <b>{{ row.studentName || '—' }}</b>
            <span class="muted">{{ row.studentNo || '' }}</span>
          </div>
          <div class="muted">{{ row.className || '—' }}</div>
        </template>
      </el-table-column>
      <el-table-column label="换宿（原 → 目标）" min-width="200">
        <template #default="{ row }">
          <div class="dca-move">
            <span class="dca-move__from">
              {{ row.oldDormNo || '未入住' }}<span v-if="row.oldBedNo" class="muted"> · {{ row.oldBedNo }}</span>
            </span>
            <span class="dca-move__arrow">→</span>
            <span v-if="row.bizType === 2" class="muted">退宿</span>
            <span v-else class="dca-move__to">
              {{ row.newDormNo || '—' }}<span v-if="row.newBedNo" class="muted"> · {{ row.newBedNo }}</span>
            </span>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="日期" width="104" align="center">
        <template #default="{ row }">
          <div>{{ row.changeDate || '—' }}</div>
          <div class="muted">{{ (row.createTime || '').slice(11) }}</div>
        </template>
      </el-table-column>
      <el-table-column label="原因" min-width="110" show-overflow-tooltip>
        <template #default="{ row }">{{ row.changeReason || '—' }}</template>
      </el-table-column>
      <el-table-column label="状态" width="84" align="center">
        <template #default="{ row }">
          <el-tag :type="STATUS_TAG[row.approvalStatus] || 'info'" size="small">{{ row.approvalStatusName }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="100" align="center" fixed="right">
        <template #default="{ row }">
          <template v-if="row.approvalStatus === 2 || row.approvalStatus === 3">
            <el-button link type="success" :disabled="isReadOnlyUser" @click="doApprove(row)">通过</el-button>
            <el-button link type="danger" :disabled="isReadOnlyUser" @click="doReject(row)">驳回</el-button>
          </template>
          <span v-else class="muted">已处理</span>
        </template>
      </el-table-column>
    </el-table>

    <el-pagination
      v-model:current-page="query.page"
      class="dca-page"
      layout="total, prev, pager, next"
      :total="filtered.length"
      :page-size="query.size"
    />
  </div>
</template>

<script setup lang="ts">
/**
 * 宿舍管理 · 申请审批（★ 2026-10-21 新增）
 * ============================================================
 *
 * 班主任在「调宿/退宿申请」里提交的单子进这里。审批动作会**真正改宿舍数据**：
 *   调换宿舍 → 释放原床位、占用目标床位、学生主档 dorm_id/dorm_no 改成新宿舍；
 *   退宿     → 释放原床位、学生宿舍清空。
 * 驳回只改状态（理由写 remark），床位与学生都不动。
 *
 * 权限：教务老师 / 校长 / 学管主任可批；班主任看不到本页签。
 * 只读账号（系统管理员）能看但不能点（后端也会拦）。
 */

import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { TableInstance } from 'element-plus';
import { isReadOnlyUser } from '@/store/permission';
import {
  approveDormChange,
  listDormChanges,
  rejectDormChange,
  type DormChangeRow,
} from '@/teaching/api/dorm';

const STATUS_TAG: Record<number, 'success' | 'info' | 'warning' | 'danger' | 'primary'> = {
  1: 'info',
  2: 'warning',
  3: 'warning',
  4: 'success',
  5: 'danger',
  6: 'info',
};

const loading = ref(false);
const rows = ref<DormChangeRow[]>([]);
const query = reactive({
  status: 2,
  keyword: '',
  page: 1,
  size: 10,
});

const filtered = computed(() => {
  const kw = query.keyword.trim();
  return rows.value.filter((r) => {
    if (query.status && r.approvalStatus !== query.status) return false;
    if (!kw) return true;
    return (
      (r.studentName || '').includes(kw) ||
      (r.studentNo || '').includes(kw) ||
      (r.className || '').includes(kw) ||
      (r.oldDormNo || '').includes(kw) ||
      (r.newDormNo || '').includes(kw)
    );
  });
});

const pageRows = computed(() => {
  const start = (query.page - 1) * query.size;
  return filtered.value.slice(start, start + query.size);
});

async function load() {
  loading.value = true;
  try {
    rows.value = (await listDormChanges({})) || [];
    query.page = 1;
  } catch (e) {
    ElMessage.error((e as Error).message || '加载申请失败');
    rows.value = [];
  } finally {
    loading.value = false;
    // ★ 表格在隐藏页签里挂载时算不出宽度 → 渲染完立刻重算一次列宽/横向滚动
    await nextTick();
    tableRef.value?.doLayout();
  }
}

function reset() {
  query.status = 2;
  query.keyword = '';
  query.page = 1;
  load();
}

function describe(row: DormChangeRow): string {
  if (row.bizType === 2) {
    return `确认通过【退宿】：${row.studentName} 将从 ${row.oldDormNo || '当前宿舍'} 退宿，床位会被释放。`;
  }
  return `确认通过【调换宿舍】：${row.studentName} 将从 ${row.oldDormNo || '当前宿舍'} 换到 ${
    row.newDormNo || '目标宿舍'
  }${row.newBedNo ? ` · ${row.newBedNo}` : ''}。`;
}

async function doApprove(row: DormChangeRow) {
  try {
    await ElMessageBox.confirm(describe(row), '审批通过', { type: 'warning', confirmButtonText: '通过' });
  } catch {
    return;
  }
  try {
    await approveDormChange({ stage: row.stage, id: row.changeId });
    ElMessage.success('已通过，床位与学生宿舍已更新');
    await load();
  } catch (e) {
    ElMessage.error((e as Error).message || '审批失败');
  }
}

async function doReject(row: DormChangeRow) {
  let reason = '';
  try {
    const r = await ElMessageBox.prompt('请填写驳回原因（必填）', '驳回申请', {
      inputType: 'textarea',
      inputValidator: (v: string) => (v && v.trim() ? true : '驳回原因必填'),
      confirmButtonText: '驳回',
      cancelButtonText: '取消',
    });
    reason = (r as { value?: string }).value || '';
  } catch {
    return;
  }
  try {
    await rejectDormChange({ stage: row.stage, id: row.changeId, reason });
    ElMessage.success('已驳回');
    await load();
  } catch (e) {
    ElMessage.error((e as Error).message || '驳回失败');
  }
}

/**
 * ★ 2026-10-21 修「左右拖动时表头不动」：
 *   本页是 lazy 页签，首次渲染时容器可能还没最终宽度，
 *   Element 会误判「不需要横向滚动」→ 内表比容器宽、溢出的部分靠页面滚动，
 *   表头不会跟着动。挂载后 + 容器尺寸变化时主动 doLayout() 重算即可。
 */
const tableRef = ref<TableInstance>();
const wrapRef = ref<HTMLElement | null>(null);
let ro: ResizeObserver | null = null;

onMounted(async () => {
  await load();
  await nextTick();
  tableRef.value?.doLayout();
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => tableRef.value?.doLayout());
    if (wrapRef.value) ro.observe(wrapRef.value);
  }
});

onBeforeUnmount(() => {
  ro?.disconnect();
  ro = null;
});
</script>

<style scoped>
.dca {
  padding: 4px 0;
}
.dca-tip {
  margin-bottom: 12px;
}
.dca-filter {
  margin-bottom: 4px;
}
.dca-cell {
  display: flex;
  gap: 8px;
  align-items: baseline;
}
/* 原宿舍 → 目标宿舍：一行显示，窄屏也不撑破表格 */
.dca-move {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  line-height: 1.4;
}
.dca-move__from {
  color: #6b5b55;
}
.dca-move__arrow {
  color: #b22a23;
  font-weight: 600;
}
.dca-move__to {
  color: #443432;
  font-weight: 600;
}
.dca-page {
  margin-top: 12px;
  justify-content: flex-end;
}
.muted {
  color: #a2938e;
  font-size: 12px;
}
</style>
