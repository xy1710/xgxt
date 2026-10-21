<script setup lang="ts">
/**
 * 操作日志
 *
 * 页面结构严格对齐高保真原型《学管系统-权限体系高保真原型.html》：
 *   · 第 2950~3007 行 renderLogs()      —— KPI 5 卡 + 操作日志表
 *   · 第 3008~3040 行 openLogDetail()   —— 点行 / 点「详情」打开的日志详情弹窗
 *
 * 样式不写在这里：原型的 <style> 已整体移植到 src/styles/prototype.css
 * （main.ts 全局引入），这里只产出与原型同名同层级的 DOM。
 *
 * ⚠️ 只读页面：日志不提供增删改。写入由后端在关键动作处自动完成，
 *    日志一旦能被前端改写，就不再是「留痕」，而是「可以伪造的记录」。
 *
 * ⚠️ 与原型的一处必要差异：原型是前端全量过滤（LOG_FILTER + LOGS.filter），
 *    开发版数据在服务端，所以筛选走的是一次接口查询 —— 但【筛选条的位置和顺序
 *    与原型保持一致】：都在 .card-h 的 .r 里，顺序是 搜索 / 模块 / 类型 / 操作人 / 结果 / 重置 / 导出。
 *    输入框加了 320ms 防抖，用来模拟原型的 oninput 即时过滤体验。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import type { LogOverview, PermLog } from 'shared-types/perm';
import { exportApi, logApi } from '@/perm/api/perm';
import { useOptionStore } from '@/perm/stores/option';
import ProtoDialog from '@/perm/components/ProtoDialog.vue';
import { toast } from '@/perm/utils/toast';

/** 可选项字典走 Pinia 缓存：整个会话只请求一次 */
const optionStore = useOptionStore();

/** 极简 HTML 转义（弹窗标题拼接了日志字段，避免把数据当标签渲染） */
function esc(s: string): string {
  return String(s ?? '').replace(/[&<>"]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;',
  );
}

/* ============================================================
 * 一、数据加载（原型 LOG_FILTER + LOGS.filter）
 * ============================================================ */

const loading = ref(false);
const list = ref<PermLog[]>([]);
const total = ref(0);
const overview = ref<LogOverview | null>(null);

const query = reactive({
  page: 1,
  size: 10,
  keyword: '',
  moduleName: '',
  actionType: '',
  result: '',
  operatorName: '',
  startDate: '',
  endDate: '',
});

/** 服务端分页 → 总页数 */
const totalPages = computed<number>(() => Math.max(1, Math.ceil(total.value / query.size)));

/** 操作人下拉候选：原型取 LOGS 里去重后的 by；开发版按当前页数据去重（接口未提供操作人字典） */
const operatorNames = computed<string[]>(() => {
  const set = new Set<string>();
  list.value.forEach((l) => {
    if (l.operatorName) set.add(l.operatorName);
  });
  if (query.operatorName) set.add(query.operatorName);
  return Array.from(set);
});

async function load(): Promise<void> {
  loading.value = true;
  try {
    const res = await logApi.list({ ...query });
    list.value = res.list;
    total.value = res.total;
  } catch {
    /* 错误已在 request 拦截器里弹过提示 */
  } finally {
    loading.value = false;
  }
}

async function loadOverview(): Promise<void> {
  try {
    overview.value = await logApi.overview();
  } catch {
    /* 错误已在 request 拦截器里弹过提示 */
  }
}

onMounted(async () => {
  await optionStore.load();
  await Promise.all([loadOverview(), load()]);
});

/** 查询（开发版多出来的显式触发点） */
function search(): void {
  query.page = 1;
  load();
}

/** 关键字输入防抖：原型是 oninput 即时过滤，开发版每次都要请求，加 320ms 防抖 */
let kwTimer: number | undefined;
function onKeywordInput(): void {
  window.clearTimeout(kwTimer);
  kwTimer = window.setTimeout(() => search(), 320);
}

/** 重置筛选（原型 LOG_FILTER = {q:'',mod:'',act:'',res:'',by:''}） */
function resetQuery(): void {
  Object.assign(query, {
    page: 1,
    keyword: '',
    moduleName: '',
    actionType: '',
    result: '',
    operatorName: '',
    startDate: '',
    endDate: '',
  });
  load();
  toast('已重置筛选', 'warn');
}

/** 点 KPI 卡片按条件筛选（原型 5 张卡各自改 LOG_FILTER） */
function filterBy(key: 'all' | 'success' | 'fail' | 'login' | 'approve'): void {
  query.page = 1;
  query.result = '';
  query.actionType = '';
  if (key === 'success') query.result = '成功';
  if (key === 'fail') query.result = '失败';
  if (key === 'login') query.actionType = '登录';
  if (key === 'approve') query.actionType = '审批';
  load();
}

function gotoPage(p: number): void {
  if (p < 1 || p > totalPages.value || p === query.page) return;
  query.page = p;
  load();
}

/* ============================================================
 * 二、表格单元渲染（与原型 class 一一对应）
 * ============================================================ */

/** 操作类型标签配色：新增 g / 删除 d / 审批 w / 登录 p / 其它 n（原型 renderLogs） */
function actionTagClass(a: string): string {
  if (a === '新增') return 'tag g';
  if (a === '删除') return 'tag d';
  if (a === '审批') return 'tag w';
  if (a === '登录') return 'tag p';
  return 'tag n';
}

const isFail = (r: string): boolean => r === '失败';

/**
 * 所属职位 → 胶囊用的数组
 *
 * ★ 2026-10-20 按用户要求（截图对比「账号管理」的所属职位列）：
 *   原来这一列是 `{{ l.operatorRole }}` 裸文本，界面上直接显示 `SYS_STAFF` 这种英文编码，
 *   且字体颜色是 .desc 的灰 —— 与「账号管理」里那种中文胶囊完全两个样子。
 *   现在跟账号管理保持同一套观感：中文职位名 + `.tag.b` 胶囊，多职位拆成多个胶囊。
 *   （编码 → 中文名的解析在后端做，见 perm.service.ts 的 resolveLogRoleLabels；
 *     前端只负责显示，拿到的已经是中文。）
 */
function roleList(raw?: string): string[] {
  return (raw || '')
    .split('、')
    .map((s) => s.trim())
    .filter(Boolean);
}

/* ============================================================
 * 三、日志详情（原型 openLogDetail）
 * ============================================================ */

const detailOpen = ref(false);
const cur = ref<PermLog | null>(null);

const detailTitle = computed(
  () => `日志详情 · <span class="em">${esc(cur.value?.actionType ?? '')}</span>`,
);

/** 操作前值为空 / 「—」= 新增操作（原型判定 l.before === '—'） */
const isNew = (l: PermLog): boolean => !l.beforeValue || l.beforeValue === '—';

/** 变更明细里的「字段」取操作对象的第一个词（原型 l.obj.split(' ')[0]） */
const fieldOf = (obj: string): string => (obj || '').split(' ')[0] || '—';

async function openDetail(row: PermLog): Promise<void> {
  cur.value = row;
  detailOpen.value = true;
  try {
    cur.value = await logApi.detail(row.id);
  } catch {
    /* 用列表行兜底展示，与原型一致 */
  }
}

/* ---------- 导出单条（原型 openLogDetail 底部的嵌套小弹窗） ---------- */

const exportOneOpen = ref(false);

function doExportOne(): void {
  exportOneOpen.value = false;
  detailOpen.value = false;
  toast('日志已导出为 PDF');
}

/** 复制编号（原型：关闭详情后 toast 提示） */
function copyLogId(): void {
  const id = cur.value?.id ?? '';
  try {
    void navigator.clipboard.writeText(id);
  } catch {
    /* 非安全上下文下不可用，忽略即可——与原型一样只做提示 */
  }
  detailOpen.value = false;
  toast(`已复制日志编号 ${id}`);
}

/* ============================================================
 * 四、导出（原型 exportDlg —— 开发版直接走导出接口）
 * ============================================================ */

async function doExport(): Promise<void> {
  const hasFilter =
    query.keyword || query.moduleName || query.actionType || query.result || query.operatorName;
  try {
    const res = await exportApi.do({
      resource: 'log',
      scope: hasFilter ? '全部筛选结果' : '全部数据',
      format: 'excel',
      query: { ...query, page: 1, size: 100 },
    });
    toast(`已导出 ${res.total} 条日志`);
  } catch {
    /* 已提示 */
  }
}
</script>

<template>
  <div>
    <!-- ==================== KPI 5 卡（原型 renderLogs 第 2957~2963 行） ==================== -->
    <div class="kpi">
      <div class="k" @click="filterBy('all')">
        <div class="n b">{{ overview?.logTotal ?? '—' }}</div>
        <div class="l">日志总数</div>
      </div>
      <div class="k" @click="filterBy('success')">
        <div class="n g">{{ overview?.successTotal ?? '—' }}</div>
        <div class="l">成功操作</div>
      </div>
      <div class="k" @click="filterBy('fail')">
        <div class="n d">{{ overview?.failTotal ?? '—' }}</div>
        <div class="l">失败操作</div>
      </div>
      <div class="k" @click="filterBy('login')">
        <div class="n w">{{ overview?.loginTotal ?? '—' }}</div>
        <div class="l">登录记录</div>
      </div>
      <div class="k" @click="filterBy('approve')">
        <div class="n p">{{ overview?.approveTotal ?? '—' }}</div>
        <div class="l">审批操作</div>
      </div>
    </div>

    <!-- ==================== 操作日志表（原型第 2964~3006 行） ==================== -->
    <div class="card">
      <div class="card-h">
        <div class="t">
          <span class="bar"></span>操作日志 <span class="sub">共 {{ total }} 条</span>
        </div>
        <!-- 筛选条位置与顺序严格对齐原型 renderLogs() 的 .card-h .r：
             搜索 → 全部模块 → 全部操作类型 → 全部操作人 → 全部结果 → 重置 → 导出 -->
        <div class="r">
          <input
            v-model="query.keyword"
            class="inp"
            placeholder="搜索操作人 / 对象 / IP"
            style="width: 190px"
            @input="onKeywordInput"
            @keyup.enter="search"
          />
          <select v-model="query.moduleName" class="inp" @change="search">
            <option value="">全部模块</option>
            <option v-for="m in optionStore.logModules" :key="m.value" :value="m.value">
              {{ m.label }}
            </option>
          </select>
          <select v-model="query.actionType" class="inp" @change="search">
            <option value="">全部操作类型</option>
            <option v-for="a in optionStore.logActionTypes" :key="a.value" :value="a.value">
              {{ a.label }}
            </option>
          </select>
          <select v-model="query.operatorName" class="inp" @change="search">
            <option value="">全部操作人</option>
            <option v-for="b in operatorNames" :key="b" :value="b">{{ b }}</option>
          </select>
          <select v-model="query.result" class="inp" @change="search">
            <option value="">全部结果</option>
            <option v-for="r in optionStore.logResults" :key="r.value" :value="r.value">
              {{ r.label }}
            </option>
          </select>
          <button class="btn" type="button" @click="resetQuery">重置</button>
          <button class="btn" type="button" @click="doExport">导出</button>
        </div>
      </div>
      <div class="card-b p0">
        <div class="tb-wrap">
          <table class="tb">
            <thead>
              <tr>
                <th style="width: 142px">操作时间</th>
                <th style="width: 130px">操作人</th>
                <th style="width: 118px">所属职位</th>
                <th style="width: 100px">操作模块</th>
                <th style="width: 80px">操作类型</th>
                <th>操作对象</th>
                <th style="width: 112px">操作前 → 后</th>
                <th style="width: 118px">IP 地址</th>
                <th style="width: 70px">结果</th>
                <th style="width: 70px">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="l in list"
                :key="l.id"
                style="cursor: pointer"
                @click="openDetail(l)"
              >
                <td class="desc num">{{ l.logTime }}</td>
                <td><b>{{ l.operatorName }}</b></td>
                <td>
                  <!-- 与「账号管理 → 所属职位」同一套观感：中文名 + .tag.b 胶囊
                       ★ 2026-10-20 用户第二次指出「所属职位这个字段与下面的职位对齐，不要歪着」：
                         胶囊盒子虽然在 14px（与表头文字同一起点），但胶囊自带 8px 左右内边距，
                         胶囊**里的文字**实际落在 22px，肉眼就是表头比内容偏左 8px。
                         `.tags` 用 -8px 外边距把胶囊整体往左顶回去，让胶囊文字与表头文字
                         对齐（见 shared-ui.css 的 .tb .tags 注释）。 -->
                  <span v-if="roleList(l.operatorRole).length" class="tags">
                    <span v-for="n in roleList(l.operatorRole)" :key="n" class="tag b">{{ n }}</span>
                  </span>
                  <span v-else class="desc">—</span>
                </td>
                <td>{{ l.moduleName }}</td>
                <td>
                  <span :class="actionTagClass(l.actionType)">{{ l.actionType }}</span>
                </td>
                <td>{{ l.targetObj || '—' }}</td>
                <td class="desc" style="font-size: 11.5px">
                  {{ l.beforeValue || '—' }} → {{ l.afterValue || '—' }}
                </td>
                <td class="desc num">{{ l.ip || '—' }}</td>
                <td>
                  <span v-if="!isFail(l.result)" class="tag g">成功</span>
                  <span v-else class="tag d">失败</span>
                </td>
                <td>
                  <span class="lk" @click.stop="openDetail(l)">详情</span>
                </td>
              </tr>
              <tr v-if="!list.length">
                <td colspan="10">
                  <div class="empty">
                    <div class="ic">📜</div>
                    {{ loading ? '加载中…' : '没有符合条件的日志' }}
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- 服务端分页条（原型无分页器；开发版必须保留，用原型风格的 .desc + .btn.sm） -->
        <div
          class="desc"
          style="display: flex; align-items: center; justify-content: flex-end; gap: 10px; margin-top: 12px"
        >
          <span>共 {{ total }} 条 · 第 {{ query.page }} / {{ totalPages }} 页</span>
          <button class="btn sm" type="button" :disabled="query.page <= 1" @click="gotoPage(query.page - 1)">
            上一页
          </button>
          <button
            class="btn sm"
            type="button"
            :disabled="query.page >= totalPages"
            @click="gotoPage(query.page + 1)"
          >
            下一页
          </button>
        </div>
      </div>
    </div>

    <!-- ==================== 日志详情（原型 openLogDetail 第 3008~3040 行） ==================== -->
    <ProtoDialog v-model="detailOpen" :title="detailTitle" size="md">
      <template v-if="cur">
        <div class="fm" style="grid-template-columns: repeat(2, 1fr)">
          <div class="f"><label>日志编号</label><div class="num">{{ cur.id }}</div></div>
          <div class="f"><label>操作时间</label><div class="num">{{ cur.logTime }}</div></div>
          <div class="f"><label>操作人</label><div><b>{{ cur.operatorName }}</b></div></div>
          <div class="f">
            <label>所属职位</label>
            <div>
              <span v-if="cur.operatorRole" class="tag b">{{ cur.operatorRole }}</span>
              <span v-else class="desc">—</span>
            </div>
          </div>
          <div class="f"><label>操作模块</label><div>{{ cur.moduleName }}</div></div>
          <div class="f"><label>操作类型</label><div>{{ cur.actionType }}</div></div>
          <div class="f full"><label>操作对象</label><div>{{ cur.targetObj || '—' }}</div></div>
          <div class="f"><label>操作前值</label><div>{{ cur.beforeValue || '—' }}</div></div>
          <div class="f"><label>操作后值</label><div>{{ cur.afterValue || '—' }}</div></div>
          <div class="f"><label>IP 地址</label><div class="num">{{ cur.ip || '—' }}</div></div>
          <div class="f">
            <label>操作结果</label>
            <div>
              <span v-if="!isFail(cur.result)" class="tag g">成功</span>
              <span v-else class="tag d">失败</span>
            </div>
          </div>
          <div class="f"><label>设备</label><div class="desc">Chrome 128 / Windows 11</div></div>
        </div>

        <div class="divider"></div>
        <div class="sec-t"><span class="bar"></span>变更明细</div>

        <div v-if="isNew(cur)" class="notice g">
          ✓<div>本条为<b>新增</b>操作，无变更前值。新增对象：<b>{{ cur.afterValue || '—' }}</b></div>
        </div>
        <table v-else class="tb">
          <thead>
            <tr>
              <th style="width: 150px">字段</th>
              <th>变更前</th>
              <th>变更后</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{{ fieldOf(cur.targetObj) }}</td>
              <td><span class="diff-old">{{ cur.beforeValue || '—' }}</span></td>
              <td><span class="diff-new">{{ cur.afterValue || '—' }}</span></td>
            </tr>
          </tbody>
        </table>

        <div v-if="isFail(cur.result)" class="notice d mt12">
          ✕<div>操作失败原因：账号「{{ cur.operatorName }}」密码错误，该账号已被锁定。</div>
        </div>
      </template>

      <template #footer>
        <div class="lft">日志不可修改、不可删除</div>
        <button class="btn" type="button" @click="detailOpen = false">关闭</button>
        <button class="btn" type="button" @click="exportOneOpen = true">导出此条</button>
        <button class="btn pri" type="button" @click="copyLogId">复制编号</button>
      </template>
    </ProtoDialog>

    <!-- 原型 openLogDetail 里「导出此条」弹出的二级弹窗 -->
    <ProtoDialog v-model="exportOneOpen" title="导出单条日志" size="sm">
      <div class="notice i">ℹ<div>将导出为 PDF 格式，包含操作人与时间戳信息。</div></div>
      <template #footer>
        <button class="btn" type="button" @click="exportOneOpen = false">取消</button>
        <button class="btn pri" type="button" @click="doExportOne">确认导出</button>
      </template>
    </ProtoDialog>
  </div>
</template>
