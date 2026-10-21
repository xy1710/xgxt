<script setup lang="ts">
/**
 * 权限总览
 *
 * 页面结构严格对齐高保真原型《学管系统-权限体系高保真原型.html》：
 *   · 第 1439~1469 行 renderHome()      —— KPI 4 卡 + 最近操作动态表
 *   · 第 3008~3040 行 openLogDetail()   —— 点表格行打开的日志详情弹窗
 *
 * 样式不写在这里：原型的 <style> 已整体移植到 src/styles/prototype.css
 * （main.ts 全局引入），这里只产出与原型同名同层级的 DOM。
 */
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { PERM_ROUTE } from '@/perm/utils/links';
import type { PermLog, PermOverview } from 'shared-types/perm';
import { overviewApi } from '@/perm/api/perm';
import ProtoDialog from '@/perm/components/ProtoDialog.vue';
import { toast } from '@/perm/utils/toast';

const router = useRouter();

const loading = ref(false);
const data = ref<PermOverview | null>(null);

/** 原型是 LOGS.slice(0, 6)：最近动态只展示 6 条 */
const recentLogs = computed<PermLog[]>(() => (data.value?.recentLogs ?? []).slice(0, 6));

async function load(): Promise<void> {
  loading.value = true;
  try {
    data.value = await overviewApi.get();
  } catch {
    /* 错误已在 request 拦截器里弹过提示 */
  } finally {
    loading.value = false;
  }
}

onMounted(load);

function go(path: string): void {
  void router.push(path);
}

/** 极简 HTML 转义（弹窗标题会拼接日志字段，避免把数据当标签渲染） */
function esc(s: string): string {
  return String(s ?? '').replace(/[&<>"]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;',
  );
}

/* ============================================================
 * 日志详情（原型 openLogDetail）
 * ============================================================ */

const detailOpen = ref(false);
const cur = ref<PermLog | null>(null);

const detailTitle = computed(
  () => `日志详情 · <span class="em">${esc(cur.value?.actionType ?? '')}</span>`,
);

const isFail = (r: string): boolean => r === '失败';

/** 操作前值为空 / 「—」= 新增操作（原型判定 l.before === '—'） */
const isNew = (l: PermLog): boolean => !l.beforeValue || l.beforeValue === '—';

/** 变更明细里的「字段」取操作对象的第一个词（原型 l.obj.split(' ')[0]） */
const fieldOf = (obj: string): string => (obj || '').split(' ')[0] || '—';

function openLogDetail(l: PermLog): void {
  cur.value = l;
  detailOpen.value = true;
}

/* ---------- 导出单条（原型 openLogDetail 底部的嵌套小弹窗） ---------- */

const exportOpen = ref(false);

function doExportOne(): void {
  exportOpen.value = false;
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
</script>

<template>
  <div>
    <!-- ==================== KPI（原型 renderHome 第 1447~1452 行） ==================== -->
    <div class="kpi">
      <div class="k" @click="go(PERM_ROUTE.role)">
        <div class="n b">{{ data?.roleTotal ?? '—' }}</div>
        <div class="l">👥 职位总数 <span class="tag g">启用 {{ data?.roleEnabled ?? 0 }}</span></div>
      </div>
      <div class="k" @click="go(PERM_ROUTE.user)">
        <div class="n g">{{ data?.userTotal ?? '—' }}</div>
        <div class="l">🙋 账号总数 <span class="tag b">正常 {{ data?.userNormal ?? 0 }}</span></div>
      </div>
      <div class="k" @click="go(PERM_ROUTE.assign)">
        <div class="n p">{{ data?.permPointTotal ?? '—' }}</div>
        <div class="l">🔑 可配置权限点</div>
      </div>
      <div class="k" @click="go(PERM_ROUTE.dept)">
        <div class="n w">{{ data?.deptTotal ?? '—' }}</div>
        <div class="l">🏢 部门数</div>
      </div>
    </div>

    <!-- ==================== 最近操作动态（原型第 1454~1467 行） ==================== -->
    <div class="card">
      <div class="card-h">
        <div class="t"><span class="bar"></span>最近操作动态</div>
        <div class="r">
          <button class="btn sm" type="button" @click="go(PERM_ROUTE.log)">查看全部日志</button>
        </div>
      </div>
      <div class="card-b p0">
        <table class="tb">
          <thead>
            <tr>
              <th style="width: 150px">时间</th>
              <th>操作人</th>
              <th>模块</th>
              <th>操作</th>
              <th>对象</th>
              <th style="width: 70px">结果</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="l in recentLogs"
              :key="l.id"
              style="cursor: pointer"
              @click="openLogDetail(l)"
            >
              <td class="desc num">{{ l.logTime }}</td>
              <td><b>{{ l.operatorName }}</b> <span class="tag n">{{ l.operatorRole }}</span></td>
              <td>{{ l.moduleName }}</td>
              <td>{{ l.actionType }}</td>
              <td class="desc">{{ l.targetObj }}</td>
              <td>
                <span v-if="!isFail(l.result)" class="tag g">成功</span>
                <span v-else class="tag d">失败</span>
              </td>
            </tr>
            <tr v-if="!recentLogs.length">
              <td colspan="6">
                <div class="empty">
                  <div class="ic">📜</div>
                  {{ loading ? '加载中…' : '暂无操作记录' }}
                </div>
              </td>
            </tr>
          </tbody>
        </table>
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
            <div><span class="tag b">{{ cur.operatorRole }}</span></div>
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

        <div v-if="isNew(cur)" class="notice g">✓<div>本条为<b>新增</b>操作，无变更前值。新增对象：<b>{{ cur.afterValue || '—' }}</b></div></div>
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

        <div v-if="isFail(cur.result)" class="notice d mt12">✕<div>操作失败原因：账号「{{ cur.operatorName }}」密码错误，该账号已被锁定。</div></div>
      </template>

      <template #footer>
        <div class="lft">日志不可修改、不可删除</div>
        <button class="btn" type="button" @click="detailOpen = false">关闭</button>
        <button class="btn" type="button" @click="exportOpen = true">导出此条</button>
        <button class="btn pri" type="button" @click="copyLogId">复制编号</button>
      </template>
    </ProtoDialog>

    <!-- 原型 openLogDetail 里「导出此条」弹出的二级弹窗 -->
    <ProtoDialog v-model="exportOpen" title="导出单条日志" size="sm">
      <div class="notice i">ℹ<div>将导出为 PDF 格式，包含操作人与时间戳信息。</div></div>
      <template #footer>
        <button class="btn" type="button" @click="exportOpen = false">取消</button>
        <button class="btn pri" type="button" @click="doExportOne">确认导出</button>
      </template>
    </ProtoDialog>
  </div>
</template>
