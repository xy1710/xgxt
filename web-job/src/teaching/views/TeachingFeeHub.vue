<template>
  <div class="tfh">
    <!--
      ★ 2026-10-19 域重组（按用户二次要求调整）：本域原来有两个页签——
        · 「催费」= 原「初高」页（FeeList：缴费台账 + 导出）改的名，功能一行没动；
        · 第二个页签 = 教务缴费总记录页（缴费管理），列表内容与「财务管理 · 缴费管理」重叠。
      ★ 2026-10-20 用户要求：「缴费」页签整页删除（截图里右边的那个标签）。
        删完后本域只剩「催费」一页，一个页签的标签条本身就是多余的 → el-tabs 一并去掉，
        页面直接渲染 FeeList，不用再套一层页签容器。
        老页面 / 老路由（/class-jh/fee、/class/urge、/fee-call、/edu/fee）未删，可回退。
    -->
    <FeeList v-if="showUrge" />
    <el-empty v-else description="当前账号没有催费权限" :image-size="60" />
  </div>
</template>

<script setup lang="ts">
import { defineAsyncComponent } from 'vue';
import { stageVisible } from '../access';

const FeeList = defineAsyncComponent(() => import('@/class-jh/views/FeeList.vue'));

/** 页签显隐沿用原学段页签的权限码（初高缴费台账） */
const showUrge = stageVisible('fee', 'jh');
</script>

<style scoped>
.tfh {
  padding: 8px 12px;
}
</style>
