<script setup lang="ts">
/**
 * 楼栋设置面板（可复用）
 * ============================================================
 *
 * 【为什么抽成组件】
 *   同一份楼栋字典有两个入口：
 *     ① 系统设置 → 楼栋设置页签（学管主任 / 校长）
 *     ② 教学管理 → 楼栋设置（独立页面，单独授权给教务老师）
 *   两边必须**完全相同**（同一个接口、同一套校验、同一张表），
 *   复制一份代码迟早分叉，所以这里抽成公共面板，两处直接复用。
 *
 * 【数据口径】
 *   sms_common.t_dorm_building，与「宿舍管理」的楼栋下拉是同一份数据。
 *   这里加一栋 → 宿舍管理的下拉立刻多一项，不需要改任何代码。
 */

import { onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Plus, Delete, EditPen } from '@element-plus/icons-vue';
import {
  listDormBuildings,
  saveDormBuilding,
  deleteDormBuilding,
  DORM_FLOOR_MAX,
  DORM_ROOMS_PER_FLOOR_MAX,
  DORM_BED_PER_ROOM_MAX,
  DORM_BED_PER_ROOM_DEFAULT,
  type DormBuildingRow,
} from '@/teaching/api/building';
import { dash } from '@/class-jh/utils/format';

const loading = ref(false);
const data = ref<DormBuildingRow[]>([]);
const visible = ref(false);
const submitting = ref(false);

/**
 * 楼栋表单
 *
 * ★ floorCount / roomsPerFloor / bedPerRoom（2026-10-19 加）
 *   填了「楼层数 + 每层房间数」→ 点确定后端按「楼层 + 两位序号」自动生成宿舍号
 *   （1 楼第 8 间 = 108；10 楼第 8 间 = 1008，楼层两位数时房号自动变 4 位）。
 *   0 表示未配置（老楼栋的房间是手工加的，不动它）。
 */
const form = reactive({
  id: '',
  buildingName: '',
  category: 1 as number,
  floorCount: 0,
  roomsPerFloor: 0,
  bedPerRoom: DORM_BED_PER_ROOM_DEFAULT,
  remark: '',
});

const CATEGORY_OPTIONS = [
  { value: 1, label: '男寝' },
  { value: 2, label: '女寝' },
];

function categoryName(category: number | null | undefined) {
  if (category === 1) return '男寝';
  if (category === 2) return '女寝';
  return '未设置';
}

async function load() {
  loading.value = true;
  try {
    data.value = await listDormBuildings();
  } catch {
    /* 错误已统一处理 */
  } finally {
    loading.value = false;
  }
}

/**
 * ★ 楼栋名自动顺延（2026-10-19）
 *   扫一遍现有楼栋名里「数字 + 号楼」的编号，取最大值 +1 预填（1/2/3 号楼 → 4 号楼）。
 *   预填只是默认值，用户可以在输入框里改（比如把 4 改成 8）。
 *
 * 【为什么只认「^数字号楼$」】楼栋名是自由文本，可能有「培训楼」「专家公寓」这类，
 *   它们不参与编号排队 —— 否则建一个「培训楼」就会把序号顶到奇怪的位置。
 *   一条都没匹配上 → 从 1 号楼开始。
 */
function nextBuildingName(): string {
  const nums = data.value
    .map((b) => /^(\d+)\s*号楼$/.exec(String(b.buildingName || '').trim()))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n) && n > 0);
  const max = nums.length ? Math.max(...nums) : 0;
  return `${max + 1}号楼`;
}

function openCreate() {
  Object.assign(form, {
    id: '',
    buildingName: nextBuildingName(),
    category: 1,
    floorCount: 0,
    roomsPerFloor: 0,
    bedPerRoom: DORM_BED_PER_ROOM_DEFAULT,
    remark: '',
  });
  visible.value = true;
}

function openEdit(row: DormBuildingRow) {
  Object.assign(form, {
    id: row.id,
    buildingName: row.buildingName,
    category: row.category ?? 1,
    floorCount: row.floorCount ?? 0,
    roomsPerFloor: row.roomsPerFloor ?? 0,
    bedPerRoom: row.bedPerRoom || DORM_BED_PER_ROOM_DEFAULT,
    remark: row.remark || '',
  });
  visible.value = true;
}

/** 按当前表单配置算一下会生成多少间（给弹窗里的提示文案用） */
function planCount(): number {
  const f = Number(form.floorCount) || 0;
  const r = Number(form.roomsPerFloor) || 0;
  return f > 0 && r > 0 ? f * r : 0;
}

async function submit() {
  const name = form.buildingName.trim();
  if (!name) {
    ElMessage.warning('请填写楼栋名称');
    return;
  }
  submitting.value = true;
  try {
    const r = await saveDormBuilding({
      id: form.id || undefined,
      buildingName: name,
      category: form.category,
      floorCount: Number(form.floorCount) || 0,
      roomsPerFloor: Number(form.roomsPerFloor) || 0,
      bedPerRoom: Number(form.bedPerRoom) || DORM_BED_PER_ROOM_DEFAULT,
      remark: form.remark || undefined,
    });
    /**
     * ★ 提示里要说清楚**实际建了几间**：
     *   配置 6 层 × 15 间，但其中 3 间之前建过 → 实际只新建 87 间。
     */
    const rooms = r?.rooms;
    if (rooms) {
      const parts: string[] = [];
      if (rooms.created) parts.push(`新建 ${rooms.created} 间`);
      if (rooms.revived) parts.push(`恢复 ${rooms.revived} 间`);
      if (rooms.skipped) parts.push(`${rooms.skipped} 间已存在`);
      ElMessage.success(`${form.id ? '楼栋已更新' : '新增成功'}，自动生成宿舍：${parts.join('，') || '无变化'}`);
    } else {
      ElMessage.success(form.id ? '楼栋已更新' : '新增成功');
    }
    visible.value = false;
    load();
  } catch {
    /* 错误已统一处理（如「楼栋已存在」「名下还有宿舍不能删」） */
  } finally {
    submitting.value = false;
  }
}

async function handleDelete(row: DormBuildingRow) {
  try {
    await ElMessageBox.confirm(
      `确定删除楼栋「${row.buildingName}」吗？（名下已有宿舍的楼栋不能删）`,
      '删除确认',
      { type: 'warning', confirmButtonText: '确定删除', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  try {
    await deleteDormBuilding(row.id);
    ElMessage.success('删除成功');
    load();
  } catch {
    /* 错误已统一处理 */
  }
}

onMounted(load);
</script>

<template>
  <div class="building-panel">
    <div class="toolbar">
      <el-button v-readonly-hide type="primary" :icon="Plus" @click="openCreate">新增楼栋</el-button>
      <el-text type="info" size="small" class="ml12">
        这里的楼栋就是「宿舍管理」里楼栋下拉的选项，两边实时一致
      </el-text>
    </div>
    <el-table v-loading="loading" :data="data" border stripe empty-text="暂无楼栋">
      <el-table-column type="index" label="序号" width="60" align="center" />
      <el-table-column prop="buildingName" label="楼栋名称" min-width="180" />
      <el-table-column label="类别" width="100" align="center">
        <template #default="{ row }">
          <el-tag v-if="row.category" :type="row.category === 1 ? 'primary' : 'danger'" size="small">
            {{ categoryName(row.category) }}
          </el-tag>
          <el-tag v-else type="info" size="small">未设置</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="楼层" width="90" align="center">
        <template #default="{ row }">
          <span v-if="row.floorCount">{{ row.floorCount }} 层</span>
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>
      <!-- 宿舍数 = 该楼栋名下当前在用的房间数（后端实时统计） -->
      <el-table-column label="宿舍数" width="90" align="center">
        <template #default="{ row }">
          <b :class="row.roomCount ? 'ok' : 'muted'">{{ row.roomCount }}</b>
        </template>
      </el-table-column>
      <el-table-column prop="remark" label="备注" min-width="200">
        <template #default="{ row }">{{ dash(row.remark) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="140" align="center" fixed="right">
        <template #default="{ row }">
          <el-button v-readonly-hide link type="primary" size="small" :icon="EditPen" @click="openEdit(row)">编辑</el-button>
          <el-button v-readonly-hide link type="danger" size="small" :icon="Delete" @click="handleDelete(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 新增 / 编辑楼栋 -->
    <el-dialog v-model="visible" :title="form.id ? '编辑楼栋' : '新增楼栋'" width="560px">
      <el-form :model="form" label-width="100px">
        <el-form-item label="楼栋名称" required>
          <el-input v-model="form.buildingName" maxlength="50" placeholder="如 4号楼" />
          <el-text type="info" size="small" class="ml12">默认按已有楼栋顺延，编号可自行修改</el-text>
        </el-form-item>
        <el-form-item label="类别" required>
          <el-radio-group v-model="form.category">
            <el-radio v-for="d in CATEGORY_OPTIONS" :key="d.value" :value="d.value">
              {{ d.label }}
            </el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="楼层数">
          <el-input-number v-model="form.floorCount" :min="0" :max="DORM_FLOOR_MAX" :step="1" step-strictly style="width: 140px" />
          <el-text type="info" size="small" class="ml12">最多 {{ DORM_FLOOR_MAX }} 层</el-text>
        </el-form-item>
        <el-form-item label="每层房间数">
          <el-input-number v-model="form.roomsPerFloor" :min="0" :max="DORM_ROOMS_PER_FLOOR_MAX" :step="1" step-strictly style="width: 140px" />
          <el-text type="info" size="small" class="ml12">填 0 表示不自动生成</el-text>
        </el-form-item>
        <el-form-item label="每间床位数">
          <el-input-number v-model="form.bedPerRoom" :min="1" :max="DORM_BED_PER_ROOM_MAX" :step="1" step-strictly style="width: 140px" />
        </el-form-item>
        <el-alert
          v-if="planCount() > 0"
          type="info"
          :closable="false"
          show-icon
          class="mb12"
          :title="`确定后将自动生成 ${planCount()} 间宿舍（房号 101 ~ ${form.floorCount}${String(form.roomsPerFloor).padStart(2, '0')}）；已存在的房间不会重复生成`"
        />
        <el-form-item label="备注">
          <el-input v-model="form.remark" maxlength="100" placeholder="选填" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="visible = false">取消</el-button>
        <el-button v-readonly-hide type="primary" :loading="submitting" @click="submit">确定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.ml12 {
  margin-left: 12px;
}
.mb12 {
  margin-bottom: 12px;
}
.toolbar {
  margin-bottom: 12px;
}
.muted {
  color: #c0c4cc;
}
.ok {
  color: #303133;
}
</style>
