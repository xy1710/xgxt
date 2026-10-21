<script setup lang="ts">
/**
 * 审批中心（咨询经理专属）
 *
 * 待办：待我审批的退费申请 → 批准 / 驳回
 */

import { ref, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { ApproveCenterData } from 'shared-types/consult';
import { fetchApproveCenter, approveRefund, rejectRefund } from '@/consult/api/consult';

const loading = ref(false);
const data = ref<ApproveCenterData | null>(null);

async function load() {
  loading.value = true;
  try {
    data.value = await fetchApproveCenter();
  } finally {
    loading.value = false;
  }
}

async function doApprove(row: any) {
  await ElMessageBox.confirm(
    `确认批准「${row.studentName}」退费 ¥${(row.refundAmount / 100).toFixed(2)}？`,
    '审批通过',
    { type: 'warning' },
  );
  await approveRefund(row.refundId);
  ElMessage.success('已批准，已上报财务');
  load();
}

async function doReject(row: any) {
  const { value } = await ElMessageBox.prompt('请输入驳回原因', '驳回退费', {
    inputValidator: (v) => (!!v?.trim() ? true : '驳回原因必填'),
  });
  await rejectRefund(row.refundId, value.trim());
  ElMessage.success('已驳回');
  load();
}

const fmtMoney = (cent?: number) => (cent == null ? '—' : `¥${(cent / 100).toFixed(2)}`);

onMounted(load);
</script>

<template>
  <div v-loading="loading" class="page">
    <!-- 待审批退费 -->
    <el-card shadow="never">
      <template #header>
        <div class="card-head">
          <span>待我审批的退费申请</span>
          <el-tag size="small" type="warning">
            {{ data?.pendingRefundList?.length || 0 }} 条待办
          </el-tag>
        </div>
      </template>

      <el-table v-if="data?.pendingRefundList?.length" :data="data.pendingRefundList" size="small">
        <el-table-column prop="studentName" label="学生" min-width="110" />
        <el-table-column prop="applyByName" label="发起人" min-width="110" />
        <el-table-column label="试学天数" width="100" align="center">
          <template #default="{ row }">{{ row.trialDays }} 天</template>
        </el-table-column>
        <el-table-column label="消耗扣减" width="120">
          <template #default="{ row }">
            <span class="warn">{{ fmtMoney(row.deductTotal) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="应退金额" width="120">
          <template #default="{ row }">
            <b class="ok">{{ fmtMoney(row.refundAmount) }}</b>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="140" fixed="right">
          <template #default="{ row }">
            <el-button link type="success" @click="doApprove(row)">批准</el-button>
            <el-button link type="danger" @click="doReject(row)">驳回</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-else description="暂无待审批退费" :image-size="70" />
    </el-card>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-weight: 600;
}

.ok {
  color: #5FA36F;
}

.warn {
  color: #C9852E;
}
</style>
