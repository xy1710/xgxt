<script setup lang="ts">
/**
 * 宿舍管理 → 班级分派
 * ============================================================
 *
 * 【做什么】
 *   教务按班级给各班分宿舍：列表显示每班的男/女生人数、分派状态、已分宿舍；
 *   点「分派」后左右两栏分别挑男寝 / 女寝的宿舍。
 *
 * 【计数口径】
 *   男/女生人数 = 该班学生里 gender=1 / gender=2 的条数（后端算）。
 *   剩余床位 = 额定人数 - 已住（已住 = 床位表里 student_name 非空的条数）。
 *   勾选一间宿舍 → 已选床位 += 该宿舍**剩余床位**；已选床位达到班级人数后，
 *   其余未勾选的宿舍置灰不可再选。
 *
 * 【一间宿舍只归一个班】
 *   被别人班占了的宿舍置灰（后端保存时还会再拦一次）。
 */

import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { Search, Refresh, Plus } from '@element-plus/icons-vue';
import {
  listAllocateClasses,
  listAllocateBuildings,
  listAllocateRooms,
  saveAllocate,
  type AllocateClassRow,
  type AllocateRoomRef,
  type AllocateRoomRow,
} from '@/teaching/api/dormAllocate';

type Gender = 'male' | 'female';

const loading = ref(false);
const rows = ref<AllocateClassRow[]>([]);
const keyword = ref('');

async function load() {
  loading.value = true;
  try {
    rows.value = await listAllocateClasses(keyword.value.trim() || undefined);
  } catch (e) {
    ElMessage.error((e as Error).message || '加载失败');
  } finally {
    loading.value = false;
  }
}

function reset() {
  keyword.value = '';
  load();
}

/* ================= 分派弹窗 ================= */
const dialogVisible = ref(false);
const cur = ref<AllocateClassRow | null>(null);
const saving = ref(false);

const maleBuildings = ref<string[]>([]);
const femaleBuildings = ref<string[]>([]);
const maleBuilding = ref('');
const femaleBuilding = ref('');

const maleRooms = ref<AllocateRoomRow[]>([]);
const femaleRooms = ref<AllocateRoomRow[]>([]);
const maleLoading = ref(false);
const femaleLoading = ref(false);

const maleSelected = ref<string[]>([]);
const femaleSelected = ref<string[]>([]);

/** ★ 无学生班级的分派床位上限（与后端 EMPTY_CLASS_MAX_BEDS 同口径） */
const EMPTY_CLASS_MAX_BEDS = 100;

/**
 * 房间缓存：切换楼栋后已选中的宿舍仍要能算床位，
 * 所以把每次加载过的房间都留一份（不随下拉切换丢失）。
 */
const maleCache = reactive<Record<string, AllocateRoomRow>>({});
const femaleCache = reactive<Record<string, AllocateRoomRow>>({});

function refToRoom(r: AllocateRoomRef, className: string): AllocateRoomRow {
  return {
    roomId: r.roomId,
    building: r.building,
    room: r.room,
    category: r.category,
    capacity: r.capacity,
    occupied: 0,
    remaining: r.capacity,
    full: false,
    assignedTo: className,
    freeBeds: [],
  };
}

function cacheOf(g: Gender) {
  return g === 'male' ? maleCache : femaleCache;
}
function selectedOf(g: Gender) {
  return g === 'male' ? maleSelected : femaleSelected;
}
function targetOf(g: Gender) {
  return g === 'male' ? cur.value?.maleCount || 0 : cur.value?.femaleCount || 0;
}

/** 已选床位数 = 已选宿舍的剩余床位之和 */
function selectedBeds(g: Gender): number {
  const cache = cacheOf(g);
  return selectedOf(g).value.reduce((s, id) => s + (cache[id]?.remaining ?? 0), 0);
}
const maleSelectedBeds = computed(() => selectedBeds('male'));
const femaleSelectedBeds = computed(() => selectedBeds('female'));

/** ★ 该班没有任何学生（新建班还没导学生）：不按人数选，改按 100 床上限 */
const isEmptyClass = computed(
  () => !!cur.value && (cur.value.maleCount || 0) + (cur.value.femaleCount || 0) === 0,
);
/** 无学生班级：男女两栏合计已选床位 */
const totalSelectedBeds = computed(() => maleSelectedBeds.value + femaleSelectedBeds.value);

function isChecked(g: Gender, roomId: string): boolean {
  return selectedOf(g).value.includes(roomId);
}

/** 是否禁选：住满 / 已选够人数（无学生班级按 100 床上限） */
function roomDisabled(g: Gender, r: AllocateRoomRow): boolean {
  if (isChecked(g, r.roomId)) return false;
  if (r.full) return true;
  if (isEmptyClass.value) return totalSelectedBeds.value >= EMPTY_CLASS_MAX_BEDS;
  const target = targetOf(g);
  if (target <= 0) return true;
  return selectedBeds(g) >= target;
}

function roomHint(g: Gender, r: AllocateRoomRow): string {
  if (r.full) {
    return r.assignedTo && r.assignedTo !== cur.value?.className
      ? `已满 · 原属 ${r.assignedTo}`
      : '已住满';
  }
  const base = `余 ${r.remaining} 床`;
  if (r.assignedTo && r.assignedTo !== cur.value?.className) return `${base} · 原属 ${r.assignedTo}`;
  return base;
}

function toggleRoom(g: Gender, r: AllocateRoomRow, checked: boolean) {
  const sel = selectedOf(g);
  const cache = cacheOf(g);
  cache[r.roomId] = r;
  if (checked) {
    if (!sel.value.includes(r.roomId)) sel.value = [...sel.value, r.roomId];
  } else {
    sel.value = sel.value.filter((id) => id !== r.roomId);
  }
}

async function loadRooms(g: Gender) {
  const category = g === 'male' ? 1 : 2;
  const building = g === 'male' ? maleBuilding.value : femaleBuilding.value;
  const target = g === 'male' ? maleRooms : femaleRooms;
  const flag = g === 'male' ? maleLoading : femaleLoading;
  if (!building) {
    target.value = [];
    return;
  }
  flag.value = true;
  try {
    const list = await listAllocateRooms(category, building);
    target.value = list;
    for (const r of list) cacheOf(g)[r.roomId] = r;
  } catch (e) {
    ElMessage.error((e as Error).message || '加载宿舍失败');
    target.value = [];
  } finally {
    flag.value = false;
  }
}

async function openDialog(row: AllocateClassRow) {
  cur.value = row;
  dialogVisible.value = true;

  const [mb, fb] = await Promise.all([
    listAllocateBuildings(1).catch(() => [] as string[]),
    listAllocateBuildings(2).catch(() => [] as string[]),
  ]);
  maleBuildings.value = mb;
  femaleBuildings.value = fb;

  /**
   * 预选已分派的房间
   *
   * ⚠️ 只预选**属于当前楼栋字典**的房间：历史分派可能指向教务宿舍（A-1/B-1 等），
   *   那些房间不是「楼栋设置」建的，保存时后端校验会报「宿舍不存在」。
   *   遇到这类旧数据就当作未预选，用户重新挑一次即可（保存会覆盖旧分派）。
   */
  const seedOf = (refs: AllocateRoomRef[], buildings: string[]) =>
    refs.filter((r) => buildings.includes(String(r.building || '').trim()));
  const mSeed = seedOf(row.maleRooms, mb);
  const fSeed = seedOf(row.femaleRooms, fb);

  maleSelected.value = mSeed.map((r) => r.roomId);
  femaleSelected.value = fSeed.map((r) => r.roomId);

  // 清掉上一次的缓存（不同班级的已选集合不能串）
  for (const k of Object.keys(maleCache)) delete maleCache[k];
  for (const k of Object.keys(femaleCache)) delete femaleCache[k];
  for (const r of mSeed) maleCache[r.roomId] = refToRoom(r, row.className);
  for (const r of fSeed) femaleCache[r.roomId] = refToRoom(r, row.className);

  // 默认落在「已分派房间所在楼栋」，没有就第一栋
  maleBuilding.value = mSeed[0]?.building || mb[0] || '';
  femaleBuilding.value = fSeed[0]?.building || fb[0] || '';

  await Promise.all([loadRooms('male'), loadRooms('female')]);
}

async function doSave() {
  if (!cur.value) return;
  const c = cur.value;

  if (isEmptyClass.value) {
    // ★ 新建班还没有学生：不按人数校验，只卡 100 床上限
    if (totalSelectedBeds.value > EMPTY_CLASS_MAX_BEDS) {
      ElMessage.warning(`该班暂无学生，分派床位数不能超过 ${EMPTY_CLASS_MAX_BEDS} 个（当前 ${totalSelectedBeds.value} 个）`);
      return;
    }
  } else {
    if (c.maleCount > 0 && maleSelectedBeds.value < c.maleCount) {
      ElMessage.warning(`男寝已选 ${maleSelectedBeds.value} 床，还差 ${c.maleCount - maleSelectedBeds.value} 床`);
      return;
    }
    if (c.femaleCount > 0 && femaleSelectedBeds.value < c.femaleCount) {
      ElMessage.warning(`女寝已选 ${femaleSelectedBeds.value} 床，还差 ${c.femaleCount - femaleSelectedBeds.value} 床`);
      return;
    }
  }

  saving.value = true;
  try {
    await saveAllocate({
      className: c.className,
      headTeacherName: c.headTeacherName,
      maleRoomIds: maleSelected.value,
      femaleRoomIds: femaleSelected.value,
    });
    ElMessage.success('分派已保存');
    dialogVisible.value = false;
    await load();
  } catch (e) {
    ElMessage.error((e as Error).message || '保存失败');
  } finally {
    saving.value = false;
  }
}

/* ================= 展示 ================= */

/** 一栏的「楼栋 房号」文本：A-1 101、102；A-2 201 */
function roomsText(list: AllocateRoomRef[]): string {
  if (!list.length) return '';
  const byBuilding = new Map<string, string[]>();
  for (const r of list) {
    if (!byBuilding.has(r.building)) byBuilding.set(r.building, []);
    byBuilding.get(r.building)!.push(r.room);
  }
  return [...byBuilding.entries()]
    .map(([b, rooms]) => `${b} ${rooms.sort().join('、')}`)
    .join('；');
}

onMounted(load);
</script>

<template>
  <div class="alloc">
    <el-alert class="alloc-tip" type="info" :closable="false" show-icon>
      <template #title>
        班级来自「班级管理」已建班级；男/女生人数按各班的实际学生数（性别）统计；
        点「分派」后左右两栏分别挑男寝 / 女寝宿舍，<b>已选床位数达到班级人数后不能再选</b>。
        <b>暂无学生的新班级也可以直接分派，床位上限 {{ EMPTY_CLASS_MAX_BEDS }} 个。</b>
        楼栋来自「系统设置 → 楼栋设置」，宿舍号取各楼栋已建的房间。
      </template>
    </el-alert>

    <el-form class="alloc-filter" inline>
      <el-form-item label="关键字">
        <el-input
          v-model="keyword"
          placeholder="班级 / 班主任"
          clearable
          style="width: 220px"
          @keyup.enter="load"
        />
      </el-form-item>
      <el-form-item>
        <el-button type="primary" :icon="Search" @click="load">查询</el-button>
        <el-button :icon="Refresh" @click="reset">重置</el-button>
      </el-form-item>
    </el-form>

    <el-table v-loading="loading" :data="rows" border stripe empty-text="暂无班级">
      <el-table-column prop="className" label="班级" min-width="140" />
      <el-table-column label="班主任" width="120">
        <template #default="{ row }">{{ row.headTeacherName || '—' }}</template>
      </el-table-column>
      <el-table-column label="男生人数" width="100" align="center">
        <template #default="{ row }">{{ row.maleCount }}</template>
      </el-table-column>
      <el-table-column label="女生人数" width="100" align="center">
        <template #default="{ row }">{{ row.femaleCount }}</template>
      </el-table-column>
      <el-table-column label="状态" width="100" align="center">
        <template #default="{ row }">
          <el-tag :type="row.status === '已分派' ? 'success' : 'info'" size="small">
            {{ row.status }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="所分宿舍" min-width="300">
        <template #default="{ row }">
          <div v-if="!row.maleRooms.length && !row.femaleRooms.length" class="muted">暂未分派</div>
          <div v-else class="assigned">
            <div v-if="row.maleRooms.length">
              <el-tag size="small" type="primary" effect="plain">男寝</el-tag>
              <span class="assigned-text">{{ roomsText(row.maleRooms) }}</span>
            </div>
            <div v-if="row.femaleRooms.length">
              <el-tag size="small" type="danger" effect="plain">女寝</el-tag>
              <span class="assigned-text">{{ roomsText(row.femaleRooms) }}</span>
            </div>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="100" align="center" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" :icon="Plus" @click="openDialog(row)">分派</el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- ============ 分派弹窗：左男寝 / 右女寝 ============ -->
    <el-dialog
      v-model="dialogVisible"
      :title="cur ? `分派宿舍 · ${cur.className}` : '分派宿舍'"
      width="1000px"
      top="6vh"
      destroy-on-close
    >
      <template v-if="cur">
        <div class="alloc-summary">
          <span>班级：<b>{{ cur.className }}</b></span>
          <span>班主任：{{ cur.headTeacherName || '—' }}</span>
          <template v-if="isEmptyClass">
            <span>
              该班暂无学生 · 分派床位上限 <b>{{ EMPTY_CLASS_MAX_BEDS }}</b> 床 · 已选
              <b :class="totalSelectedBeds <= EMPTY_CLASS_MAX_BEDS ? 'ok' : 'warn'">{{ totalSelectedBeds }}</b> 床
            </span>
          </template>
          <template v-else>
            <span>
              男生 <b>{{ cur.maleCount }}</b> 人 · 已选
              <b :class="maleSelectedBeds >= cur.maleCount ? 'ok' : 'warn'">{{ maleSelectedBeds }}</b> 床
            </span>
            <span>
              女生 <b>{{ cur.femaleCount }}</b> 人 · 已选
              <b :class="femaleSelectedBeds >= cur.femaleCount ? 'ok' : 'warn'">{{ femaleSelectedBeds }}</b> 床
            </span>
          </template>
        </div>

        <el-alert
          v-if="isEmptyClass"
          class="alloc-empty-tip"
          type="warning"
          :closable="false"
          show-icon
          :title="`该班还没有学生信息：可直接分派宿舍，男女两栏合计不超过 ${EMPTY_CLASS_MAX_BEDS} 个床位`"
        />

        <div class="alloc-cols">
          <!-- 左：男寝 -->
          <div class="alloc-col">
            <div class="alloc-col__head">
              <span class="alloc-col__title"><el-tag size="small" type="primary" effect="plain">男寝</el-tag> 选择宿舍</span>
              <div class="alloc-col__pick">
                <span class="alloc-col__label">选择楼栋</span>
                <el-select v-model="maleBuilding" placeholder="选择楼栋" style="width: 160px" @change="loadRooms('male')">
                  <el-option v-for="b in maleBuildings" :key="b" :label="b" :value="b" />
                </el-select>
              </div>
            </div>
            <el-alert
              v-if="!cur.maleCount && !isEmptyClass"
              type="info"
              :closable="false"
              show-icon
              title="该班没有男生，无需分派男寝"
            />
            <div v-else v-loading="maleLoading" class="alloc-rooms">
              <label
                v-for="r in maleRooms"
                :key="r.roomId"
                class="alloc-room"
                :class="{ 'is-full': roomDisabled('male', r) && !isChecked('male', r.roomId) }"
              >
                <el-checkbox
                  :model-value="isChecked('male', r.roomId)"
                  :disabled="roomDisabled('male', r)"
                  @change="(v: any) => toggleRoom('male', r, !!v)"
                />
                <span class="alloc-room__no">{{ r.building }} {{ r.room }}</span>
                <span class="alloc-room__hint">{{ roomHint('male', r) }}</span>
              </label>
              <el-empty v-if="!maleRooms.length && !maleLoading" description="该楼栋暂无男寝" :image-size="60" />
            </div>
          </div>

          <!-- 右：女寝 -->
          <div class="alloc-col">
            <div class="alloc-col__head">
              <span class="alloc-col__title"><el-tag size="small" type="danger" effect="plain">女寝</el-tag> 选择宿舍</span>
              <div class="alloc-col__pick">
                <span class="alloc-col__label">选择楼栋</span>
                <el-select v-model="femaleBuilding" placeholder="选择楼栋" style="width: 160px" @change="loadRooms('female')">
                  <el-option v-for="b in femaleBuildings" :key="b" :label="b" :value="b" />
                </el-select>
              </div>
            </div>
            <el-alert
              v-if="!cur.femaleCount && !isEmptyClass"
              type="info"
              :closable="false"
              show-icon
              title="该班没有女生，无需分派女寝"
            />
            <div v-else v-loading="femaleLoading" class="alloc-rooms">
              <label
                v-for="r in femaleRooms"
                :key="r.roomId"
                class="alloc-room"
                :class="{ 'is-full': roomDisabled('female', r) && !isChecked('female', r.roomId) }"
              >
                <el-checkbox
                  :model-value="isChecked('female', r.roomId)"
                  :disabled="roomDisabled('female', r)"
                  @change="(v: any) => toggleRoom('female', r, !!v)"
                />
                <span class="alloc-room__no">{{ r.building }} {{ r.room }}</span>
                <span class="alloc-room__hint">{{ roomHint('female', r) }}</span>
              </label>
              <el-empty v-if="!femaleRooms.length && !femaleLoading" description="该楼栋暂无女寝" :image-size="60" />
            </div>
          </div>
        </div>
      </template>

      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="doSave">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.alloc {
  padding: 4px 0;
}
.alloc-tip {
  margin-bottom: 12px;
}
.alloc-filter {
  margin-bottom: 8px;
}
.muted {
  color: #a2938e;
}
.assigned {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.assigned-text {
  margin-left: 6px;
  color: #443432;
}
.alloc-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 18px;
  padding: 10px 12px;
  margin-bottom: 12px;
  border-radius: 8px;
  background: #faf7f4;
  font-size: 13px;
  color: #443432;
}
.alloc-summary .ok {
  color: #5fa36f;
}
.alloc-summary .warn {
  color: #c9852e;
}
.alloc-cols {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}
.alloc-col {
  border: 1px solid #e2d7d1;
  border-radius: 8px;
  padding: 10px;
  min-height: 260px;
}
.alloc-col__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.alloc-col__title {
  font-size: 13px;
  color: #443432;
}
/* ★ 「选择楼栋」四个字 + 下拉框，整体靠右 */
.alloc-col__pick {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
}
.alloc-col__label {
  font-size: 12px;
  color: #6b5b55;
  white-space: nowrap;
}
.alloc-empty-tip {
  margin-bottom: 10px;
}
.alloc-rooms {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(215px, 1fr));
  gap: 8px;
  max-height: 380px;
  overflow-y: auto;
}
.alloc-room {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border: 1px solid #e2d7d1;
  border-radius: 6px;
  background: #fff;
  font-size: 12px;
  cursor: pointer;
}
.alloc-room.is-full {
  background: #f5f3f2;
  color: #b8aeaa;
  cursor: not-allowed;
}
.alloc-room__no {
  font-weight: 600;
}
.alloc-room__hint {
  margin-left: auto;
  color: #a2938e;
  white-space: nowrap;
}
</style>
