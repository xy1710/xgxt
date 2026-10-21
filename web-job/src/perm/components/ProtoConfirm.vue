<script setup lang="ts">
/**
 * ProtoConfirm —— 原型 confirmDlg() 的等价组件
 *
 * 原型里确认框是「图标 + 居中标题 + 说明 + 明细键值表 + 警示条」的结构，
 * DOM 与 class 在这里保持完全一致，所以样式 1:1。
 *
 * 用法：
 *   <ProtoConfirm v-model="confirm.show" :title="confirm.title" icon="🗑" icon-bg="var(--dg-l)"
 *     msg="确定删除该职位？" :detail="confirm.detail" :warn="confirm.warn"
 *     ok-text="确认删除" ok-class="dg" @ok="doDelete" />
 */
import { ref, watch } from 'vue';
import { acquireZIndex } from '@/perm/composables/useDialogZIndex';

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    title?: string;
    /** 顶部圆形图标（emoji） */
    icon?: string;
    /** 图标底色，如 var(--dg-l) */
    iconBg?: string;
    /** 居中主标题 */
    msg?: string;
    /** 居中说明文字（允许 HTML） */
    desc?: string;
    /** 明细键值对 */
    detail?: { k: string; v: string }[];
    /** 红色警示条 */
    warn?: string;
    /** 蓝色提示条 */
    tip?: string;
    /** 中间按钮文案（可选） */
    midText?: string;
    okText?: string;
    /** ok 按钮配色：pri（默认）/ dg / ok / wn */
    okClass?: string;
    cancelText?: string;
  }>(),
  {
    title: '确认操作',
    icon: '',
    iconBg: 'var(--brand-l)',
    msg: '',
    desc: '',
    detail: () => [],
    warn: '',
    tip: '',
    midText: '',
    okText: '确定',
    okClass: 'pri',
    cancelText: '取消',
  },
);

const emit = defineEmits<{ ok: []; mid: []; cancel: []; 'update:modelValue': [boolean] }>();

/**
 * ⭐ 弹窗层级：与 ProtoDialog 共用同一套「后打开的在上层」机制。
 *
 * 为什么确认框也需要？
 *   确认框经常是「从另一个弹窗里点出来的」（如弹窗里点删除 → 弹确认框）。
 *   z-index 固定的话，确认框会被它所属的弹窗盖住，用户点删除后看不到确认。
 */
const zIndex = ref(0);

watch(
  () => props.modelValue,
  (on) => {
    if (on) zIndex.value = acquireZIndex();
  },
  { immediate: true },
);

function cancel(): void {
  emit('cancel');
  emit('update:modelValue', false);
}
</script>

<template>
  <Teleport to="body">
    <div v-if="modelValue" class="mask on" :style="{ zIndex }" @click.self="cancel">
      <div class="dlg sm" @click.stop>
        <div class="dlg-h">
          <div class="t">{{ title }}</div>
          <button class="x" type="button" title="关闭" @click="cancel">✕</button>
        </div>
        <div class="dlg-b">
          <div v-if="icon" style="text-align: center; margin-bottom: 12px">
            <div
              style="
                width: 48px;
                height: 48px;
                border-radius: 50%;
                display: grid;
                place-items: center;
                font-size: 23px;
                margin: 0 auto;
              "
              :style="{ background: iconBg }"
            >
              {{ icon }}
            </div>
          </div>
          <div v-if="msg" style="text-align: center; font-size: 13.5px; font-weight: 600; margin-bottom: 6px">
            {{ msg }}
          </div>
          <div
            v-if="desc"
            style="text-align: center; font-size: 12.5px; color: var(--tx2); line-height: 1.7"
            v-html="desc"
          ></div>
          <div v-if="detail && detail.length" style="background: #FAF7F4; border-radius: 8px; padding: 11px 13px; margin-top: 14px">
            <div
              v-for="(d, i) in detail"
              :key="i"
              class="fm"
              style="grid-template-columns: 96px 1fr; gap: 6px"
            >
              <label style="color: var(--tx3)">{{ d.k }}</label>
              <div style="font-size: 12.5px" v-html="d.v"></div>
            </div>
          </div>
          <div v-if="warn" class="notice d mt12">⚠<div v-html="warn"></div></div>
          <div v-if="tip" class="notice i mt12">ℹ<div v-html="tip"></div></div>
          <slot></slot>
        </div>
        <div class="dlg-f">
          <button class="btn" type="button" @click="cancel">{{ cancelText }}</button>
          <button v-if="midText" class="btn" type="button" @click="emit('mid')">{{ midText }}</button>
          <button class="btn" :class="okClass" type="button" @click="emit('ok')">{{ okText }}</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
