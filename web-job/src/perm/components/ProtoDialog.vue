<script setup lang="ts">
/**
 * ProtoDialog —— 原型弹窗容器（.mask > .dlg > .dlg-h / .dlg-b / .dlg-f）
 *
 * 原型的 dlg(opt) 是命令式拼 DOM；这里改成 Vue 组件，但【DOM 结构与 class 完全一致】，
 * 因此 prototype.css 里的 .mask / .dlg / .dlg-h / .dlg-b / .dlg-f 样式直接生效，视觉 1:1。
 *
 * 用法：
 *   <ProtoDialog v-model="show" title="新建<b>职位</b>" size="md">
 *     ...主体...
 *     <template #footer>
 *       <div class="lft">提示文案</div>
 *       <button class="btn" @click="show=false">取消</button>
 *       <button class="btn pri" @click="submit">确定</button>
 *     </template>
 *   </ProtoDialog>
 */
import { ref, watch, computed, onBeforeUnmount } from 'vue';
import { acquireZIndex } from '@/perm/composables/useDialogZIndex';

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    /** 标题（允许含 HTML，如「新建<b>职位</b>」） */
    title?: string;
    /** 尺寸：与原型 .dlg.sm/.md/.lg/.xl 对应 */
    size?: 'sm' | 'md' | 'lg' | 'xl';
    /** 点遮罩是否关闭 */
    maskClosable?: boolean;
  }>(),
  { title: '', size: 'md', maskClosable: true },
);

const emit = defineEmits<{ 'update:modelValue': [boolean] }>();

/**
 * ⭐ 弹窗层级（2026-10-04 修复「配置权限弹窗被新建职位弹窗盖住」）
 *
 * 所有 ProtoDialog 都 Teleport 到 body，而 .mask 的 z-index 原来是固定 1000，
 * 于是「谁在模板里写得靠后谁在上面」——跟「谁后打开」无关。
 * RoleManage.vue 里「配置权限」(treeOpen) 写在「新建职位」(formOpen) 之前，
 * 就导致从新建职位里点「＋ 配置权限」时被压在下面。
 *
 * 现在改为：每次打开领一个全局递增的层级，保证【后打开的在上层】。
 * 详见 @/perm/composables/useDialogZIndex.ts
 */
const zIndex = ref(0);

function close(): void {
  emit('update:modelValue', false);
}

/** Esc 关闭（原型 dlg() 里也有这一段） */
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') close();
}

watch(
  () => props.modelValue,
  (on) => {
    if (on) {
      zIndex.value = acquireZIndex();
      document.addEventListener('keydown', onKey);
    } else {
      document.removeEventListener('keydown', onKey);
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey);
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="modelValue"
      class="mask on"
      :style="{ zIndex }"
      @click.self="maskClosable && close()"
    >
      <div class="dlg" :class="size">
        <div class="dlg-h">
          <div class="t" v-html="title"></div>
          <button class="x" type="button" title="关闭" @click="close">✕</button>
        </div>
        <div class="dlg-b">
          <slot></slot>
        </div>
        <div v-if="$slots.footer" class="dlg-f">
          <slot name="footer"></slot>
        </div>
      </div>
    </div>
  </Teleport>
</template>
