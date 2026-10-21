<script setup lang="ts">
/**
 * 楼栋设置（独立页面）
 * ============================================================
 *
 * 【为什么单独一个页面】
 *   系统设置页（/class-jh/setting）的四个页签共用 `classjh:setting:view`，
 *   而教务老师只需要「楼栋设置」这一个页签，不能把系统设置 KV / 阶段字典 /
 *   操作日志一并放开。
 *   → 把楼栋面板抽出来，单独挂 `classjh:building:view`，只授给教务老师。
 *
 * 页面内容 = `BuildingSettingPanel`，与系统设置页里的页签**完全同一个组件**。
 */
import BuildingSettingPanel from '@/class-jh/components/setting/BuildingSettingPanel.vue';
</script>

<template>
  <div class="page-container">
    <el-alert class="tip" type="info" :closable="false" show-icon>
      <template #title>
        楼栋字典（男寝 / 女寝）—— 与「宿舍管理」的楼栋下拉、「分派宿舍」的楼栋选项是同一份数据，
        这里新增后立即生效，不需要改代码。
      </template>
    </el-alert>
    <BuildingSettingPanel />
  </div>
</template>

<style scoped>
.page-container {
  padding: 16px;
}
.tip {
  margin-bottom: 12px;
}
</style>
