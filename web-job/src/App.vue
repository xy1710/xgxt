<script setup lang="ts">
/**
 * 布局页 —— 顶部栏 + 左侧菜单 + 内容区（统一门户版）
 *
 * ★ 2026-10-05 深度单体合并：
 *   左侧菜单现在是【一个统一菜单】，按模块分组：
 *     市场咨询 / 财务管理 / 权限管理   ← 来自门户登录下发的 visibleModules（动态）
 *     就业管理 / 教务管理 / 班级管理   ← 来自 /src/config/menu.ts（静态，沿用原逻辑）
 *
 *   判定规则：
 *     · 门户模块分组：账号 visibleModules 里有该模块 → 显示（模块内的页面也按 menus 过滤）
 *     · 就业/教务/班级：沿用「菜单项有 pageCode → hasPage(path) 通过才显示」
 *
 * ⚠️ 再次强调：这里过滤菜单只是"不碍眼"，真正的拦截在后端接口。
 *
 * ★ 2026-10-16 工作台 = 系统首页（用户指令：每个角色进来第一个页面就是工作台）：
 *   侧栏顶部固定一个「工作台」单层菜单项（所有登录角色可见）；
 *   菜单分组计算整体抽到 config/sideMenu.ts，与首页快捷入口共用同一份口径。
 */
import { RouterView, useRoute, useRouter } from 'vue-router';
import { computed, onMounted, ref, watch } from 'vue';
/* ★ 第 1 期「入口合并」：matchTeachingPath —— 直连老路由时，左侧菜单要亮在合并后的菜单项上 */
import { matchTeachingPath } from '@/teaching/domainConfig';
import { ROLE_CODE_NAME } from 'shared-types';
import * as ElementPlusIconsVue from '@element-plus/icons-vue';
import {
  myRoles,
  permissionLoaded,
  loadMyPermissions,
} from '@/store/permission';
import { useAuthStore as usePortalStore } from '@/portal/stores/auth';
import { portalLogout } from '@/store/modules';
/* 面包屑导航（内容区顶部的位置指示） */
import BreadcrumbBar from '@/components/BreadcrumbBar.vue';
/* ★ 2026-10-15 新增：顶栏「修改密码」—— 登录人自助改密（所有角色都能用）
 *   ★ 2026-10-16 改名：原来叫「重置密码」，与「账号管理 → 重置密码」
 *     （管理员代忘记密码的人重置）撞名，改成「修改密码」以示区分。 */
import { ElMessage } from 'element-plus';
import type { FormInstance, FormRules } from 'element-plus';
import { changeMyPassword, fetchPwdPolicy, verifyMyPassword } from '@/portal/api/portal';
import type { PwdPolicy } from '@/portal/api/portal';
/* ★ 2026-10-16 侧栏菜单计算抽到 config/sideMenu.ts：
 *   工作台首页（views/Workbench.vue）的「快捷入口」要和侧栏用同一套显隐口径，
 *   两处共用一份，避免口径漂移。
 *   注：原先在本文件 import 的 moduleAllowed / moduleOfPageCode / pageEnabled
 *   已随菜单计算一并搬去 sideMenu.ts，本文件不再直接使用，故不再重复引入。 */
import { useSideMenu, type ViewChild } from '@/config/sideMenu';
/* ★ 催费/缴费菜单红点：有待催办事项（初高待缴/大学逾期/就业待催缴）时菜单项亮红点 */
import { useFeeUrgeBadge } from '@/store/feeUrgeBadge';

const route = useRoute();
const router = useRouter();
const portal = usePortalStore();

/** 当前激活的菜单项（hash 路由下 route.path 就是 /xxx） */
const activeMenu = computed(() => {
  /* ★ 第 1 期「入口合并」：
   *   左侧菜单现在只有一个「教学管理」分组，重复业务域指向 /teaching/<域>。
   *   用户直连老路由（/exam、/class/exam、/class-jh/exam …）时，
   *   要把高亮归到合并后的菜单项上，否则菜单不亮、用户会以为"点丢了"。
   *   匹配不上（如 /edu/student 之外的杂项页）→ 原样返回，不影响任何逻辑。 */
  const merged = matchTeachingPath(route.path);
  if (merged) return merged;
  return route.path;
});

/* ★ 2026-10-16 菜单计算（门户模块分组 / 教学管理分组 / 工作台置顶项 / 默认展开）
 *   原先写在本文件的 portalGroups / jobGroups / mergedDomainMenuAllowed /
 *   legacyMenuAllowed 整体抽到 config/sideMenu.ts，逻辑一行未改；
 *   唯一新增：visibleMenu 顶部固定「工作台」单层菜单项（系统首页）。 */
const { visibleMenu, defaultOpeneds } = useSideMenu();

/** 菜单数据到位后再创建 el-menu，default-openeds 才生效 */
const menuReady = computed(() => visibleMenu.value.length > 0);

function getIcon(name?: string) {
  if (!name) return undefined;
  return (ElementPlusIconsVue as Record<string, any>)[name];
}

function goChild(child: ViewChild) {
  return { path: child.path || '/coming', query: { title: child.title } };
}

/** 顶栏显示的身份：门户账号姓名 */
const userNameText = computed(
  () => portal.account?.userName || '未登录',
);

/** 顶栏显示的头衔：门户账号 kind / title */
const roleText = computed(() => {
  const a = portal.account;
  if (a) {
    if (a.title) return a.title;
    if (a.kind === 'sys_admin') return '系统管理员';
    return '模块负责人';
  }
  // 兜底：老口径的角色码（就业/教务/班级账号）
  return myRoles.value.map((r) => ROLE_CODE_NAME[r] || r).join('、') || '未登录';
});

/** 登录页全屏显示，不套左侧菜单的壳 */
const isLoginPage = computed(() => route.path === '/login');

/* 催费/缴费红点 */
const feeUrgeBadge = useFeeUrgeBadge();

/** 退出登录 → 回统一登录页 */
function doLogout(): void {
  portalLogout();
  router.replace('/login');
}

/* ============================================================
 * ★ 2026-10-15 新增：顶栏「修改密码」（登录人自助改密）
 *
 * 交互口径（用户指定）：
 *   ① 先填【原密码】→ 点「验证」，后端确认无误后，才解锁下面两栏；
 *   ② 再填【新密码】；
 *   ③ 最后【再输一遍新密码】，两次一致才能提交。
 *
 * ⚠️ 前端这一步「验证后解锁」只是交互引导，真正的把关在后端：
 *    /change-password 里会再复核一次原密码，跳过验证直接调接口也改不了。
 * ============================================================ */

/** 弹窗显隐 */
const pwdOpen = ref(false);
/** 原密码是否已通过后端校验 —— 未通过时「新密码 / 确认密码」两栏不可填 */
const pwdVerified = ref(false);
const pwdVerifying = ref(false);
const pwdSubmitting = ref(false);
/** 内联错误（后端也会弹 toast，这里再落到输入框下方，方便用户就地改） */
const pwdError = ref('');
const pwdFormRef = ref<FormInstance>();

const pwdForm = ref({
  oldPassword: '',
  newPassword: '',
  confirmPassword: '',
});

/* ============================================================
 * ★ 2026-10-19 修复：改密规则与后端对齐
 *
 * 【问题】规则要求含大写字母，但测试时全小写也能改成功。
 * 【根因】规则被写死在三个地方且口径不一：
 *     · 后端 perm 的 assertPwdStrength（账号管理用）＝ ≥8 位 + 大写 + 数字
 *     · 后端 portal 的 assertNewPassword（自助改密用）＝ 6~20 位 + 无空格 + 不等于原密码
 *     · 本弹窗的提示文案与校验＝照着后者写
 * 【做法】后端两个入口共用 perm/services/pwdPolicy.ts 一份策略；
 *        前端打开弹窗时向 /api/portal/account/pwd-policy 取当前策略，
 *        按它渲染提示并做预校验。
 *   ⚠️ 前端校验只是「少跑一趟请求」的体验优化，后端仍是最终把关。
 * ============================================================ */

/** 取回来的当前策略；接口失败就退回这份默认值，别让弹窗打不开 */
const pwdPolicy = ref<PwdPolicy>({
  min: 8,
  upper: true,
  digit: true,
  symbol: false,
  tip: '不少于 8 位，且需包含大写字母、数字',
});

/** 规则最小长度（策略里没给就按 8 位兜底） */
const pwdMinLen = computed(() => Number(pwdPolicy.value.min) || 8);

/** 规则说明文案（提交按钮上方那条） */
const pwdRuleTip = computed(() => {
  const p = pwdPolicy.value;
  if (p.tip) return p.tip;
  const need: string[] = [];
  if (p.upper) need.push('大写字母');
  if (p.digit) need.push('数字');
  if (p.symbol) need.push('特殊符号');
  return need.length ? `不少于 ${p.min} 位，且需包含${need.join('、')}` : `不少于 ${p.min} 位`;
});

/** 密码强度 0~3 —— 只是观感反馈；能不能提交由 pwdRules 判、最终由后端判 */
const pwdScore = computed(() => {
  const p = pwdForm.value.newPassword;
  if (!p) return 0;
  let s = 0;
  if (p.length >= pwdMinLen.value) s += 1;
  // ★ 2026-10-19：由 [A-Za-z] 收紧为「必须有大写字母」，与密码策略口径一致
  if (/[A-Z]/.test(p) && /\d/.test(p)) s += 1;
  if (/[^A-Za-z0-9]/.test(p) || p.length >= 12) s += 1;
  return s;
});
const pwdScoreText = computed(() => ['', '偏弱', '中等', '较强'][pwdScore.value] || '');

const pwdRules: FormRules = {
  oldPassword: [{ required: true, message: '请输入原密码', trigger: 'blur' }],
  newPassword: [
    { required: true, message: '请输入新密码', trigger: 'blur' },
    {
      /**
       * ★ 2026-10-19：逐条对齐后端策略 —— 少一条就会出现「前端放过、后端才拒」。
       *   顺序按用户最常踩的坑排：长度 → 大写字母 → 数字 → 特殊符号 → 空格 → 与原密码相同。
       */
      validator: (_rule, value, callback) => {
        const s = String(value || '');
        const p = pwdPolicy.value;
        if (s.length < pwdMinLen.value) {
          return callback(new Error(`新密码不少于 ${pwdMinLen.value} 位`));
        }
        if (s.length > 20) return callback(new Error('新密码不超过 20 位'));
        if (p.upper && !/[A-Z]/.test(s)) return callback(new Error('新密码需包含大写字母'));
        if (p.digit && !/\d/.test(s)) return callback(new Error('新密码需包含数字'));
        if (p.symbol && !/[^A-Za-z0-9]/.test(s)) return callback(new Error('新密码需包含特殊符号'));
        if (/\s/.test(s)) return callback(new Error('新密码不能包含空格'));
        if (s === pwdForm.value.oldPassword) return callback(new Error('新密码不能与原密码相同'));
        callback();
      },
      trigger: 'blur',
    },
  ],
  confirmPassword: [
    { required: true, message: '请再次输入新密码', trigger: 'blur' },
    {
      validator: (_rule, value, callback) => {
        if (value !== pwdForm.value.newPassword) return callback(new Error('两次输入的新密码不一致'));
        callback();
      },
      trigger: 'blur',
    },
  ],
};

function openPwdDialog(): void {
  pwdOpen.value = true;
  // ★ 2026-10-19：拉一次「当前生效的密码策略」——提示与预校验都照着它来。
  //   失败就沿用 pwdPolicy 的默认值，绝不因为取不到策略而打不开弹窗。
  fetchPwdPolicy()
    .then((p) => {
      if (p && p.min) pwdPolicy.value = p;
    })
    .catch(() => undefined);
}

/** 关闭后必须把「已验证」的闸门复位，否则下次打开能跳过第一步直接填新密码 */
function onPwdClosed(): void {
  pwdVerified.value = false;
  pwdVerifying.value = false;
  pwdSubmitting.value = false;
  pwdError.value = '';
  pwdForm.value = { oldPassword: '', newPassword: '', confirmPassword: '' };
  pwdFormRef.value?.clearValidate();
}

/** 改了新密码 → 顺手复验「确认密码」，否则会出现「两次明明一样却还提示不一致」 */
function onNewPwdInput(): void {
  if (pwdForm.value.confirmPassword) {
    pwdFormRef.value?.validateField('confirmPassword').catch(() => undefined);
  }
}

/** 第一步：验证原密码 */
async function doVerifyOld(): Promise<void> {
  pwdError.value = '';
  if (!pwdForm.value.oldPassword) {
    pwdError.value = '请输入原密码';
    return;
  }
  pwdVerifying.value = true;
  try {
    await verifyMyPassword(pwdForm.value.oldPassword);
    pwdVerified.value = true;
    ElMessage.success('原密码正确，请设置新密码');
  } catch {
    pwdVerified.value = false;
    pwdError.value = '原密码不正确，请重新输入';
  } finally {
    pwdVerifying.value = false;
  }
}

/** 第二步：提交修改 */
async function doChangePwd(): Promise<void> {
  pwdError.value = '';
  if (!pwdVerified.value) {
    pwdError.value = '请先验证原密码';
    return;
  }
  const passed = await pwdFormRef.value?.validate().catch(() => false);
  if (!passed) return;

  pwdSubmitting.value = true;
  try {
    await changeMyPassword({
      oldPassword: pwdForm.value.oldPassword,
      newPassword: pwdForm.value.newPassword,
    });
    ElMessage.success('密码修改成功，下次登录请使用新密码');
    pwdOpen.value = false;
  } catch {
    // 后端已弹错误提示；这里只把弹窗留在原位，方便用户就地修改
  } finally {
    pwdSubmitting.value = false;
  }
}

onMounted(() => {
  // 登录页 / 未登录时不拉（否则会打出一个无 token 的 401）
  if (isLoginPage.value) return;
  if (!localStorage.getItem('sms_token')) return;
  if (!permissionLoaded.value) loadMyPermissions();
  // 催费/缴费红点：登录后拉一次
  feeUrgeBadge.refresh();
});

// 进入催费/缴费页时强刷（处理完回来红点随之更新）
watch(() => route.fullPath, (p) => {
  if (p.startsWith('/teaching/fee')) feeUrgeBadge.refresh(true);
});
</script>

<template>
  <RouterView v-if="isLoginPage" />
  <el-container v-else class="layout">
    <!-- ============ 顶部栏（2026-10-15 改版：良志红暖色主题，LOGO 左上角） ============ -->
    <el-header class="header">
      <div class="header-left">
        <img class="header-logo" src="/logo.png" alt="良志教育" />
        <span class="header-div"></span>
        <span class="header-title">学管系统</span>
        <el-tag size="small" effect="light" round class="header-tag">统一门户</el-tag>
      </div>
      <el-input
        class="header-search"
        placeholder="搜索学员、班级、功能…"
        :prefix-icon="getIcon('Search')"
      />
      <div class="header-user">
        <el-badge is-dot class="header-badge">
          <el-button circle class="header-icbtn" title="消息通知">
            <el-icon><component :is="getIcon('Bell')" /></el-icon>
          </el-button>
        </el-badge>
        <el-button circle class="header-icbtn" title="刷新权限" @click="loadMyPermissions">
          <el-icon><component :is="getIcon('Refresh')" /></el-icon>
        </el-button>
        <div class="header-me">
          <div class="header-avatar">{{ (userNameText || 'U').slice(0, 1) }}</div>
          <div class="header-me-txt">
            <span class="header-uname">{{ userNameText }}</span>
            <span class="header-urole">{{ roleText }}</span>
          </div>
        </div>
        <!--
          ★ 2026-10-15 改版：退出登录整体左移，右侧新增「修改密码」。
            两者都在最右侧的操作区，所有角色登录后都能看到并使用。
        -->
        <el-button size="small" text class="switch-role" @click="doLogout">退出登录</el-button>
        <el-button size="small" class="reset-pwd-btn" @click="openPwdDialog">
          <el-icon class="reset-pwd-ic"><component :is="getIcon('Key')" /></el-icon>
          <span>修改密码</span>
        </el-button>
      </div>
    </el-header>

    <!-- ==================== 修改密码弹窗（所有角色可用） ==================== -->
    <el-dialog
      v-model="pwdOpen"
      title="修改密码"
      width="440px"
      append-to-body
      :close-on-click-modal="false"
      class="pwd-dialog"
      @closed="onPwdClosed"
    >
      <div class="pwd-who">
        <span class="pwd-who-lb">当前账号</span>
        <b class="pwd-who-name">{{ userNameText }}</b>
        <span class="pwd-who-acc">{{ portal.account?.account || '' }}</span>
      </div>

      <el-form
        ref="pwdFormRef"
        :model="pwdForm"
        :rules="pwdRules"
        label-width="82px"
        class="pwd-form"
        @submit.prevent
      >
        <!-- ① 原密码：验证通过后才解锁下面两栏 -->
        <el-form-item label="原密码" prop="oldPassword">
          <div class="pwd-row">
            <el-input
              v-model="pwdForm.oldPassword"
              type="password"
              show-password
              placeholder="请输入当前登录密码"
              :disabled="pwdVerified"
              @keyup.enter="doVerifyOld"
            />
            <el-button
              class="pwd-verify"
              :type="pwdVerified ? 'success' : 'primary'"
              :loading="pwdVerifying"
              :disabled="pwdVerified"
              @click="doVerifyOld"
            >
              {{ pwdVerified ? '已验证' : '验证' }}
            </el-button>
          </div>
        </el-form-item>

        <!-- ② 新密码 -->
        <el-form-item label="新密码" prop="newPassword">
          <el-input
            v-model="pwdForm.newPassword"
            type="password"
            show-password
            :disabled="!pwdVerified"
            :placeholder="`${pwdMinLen} 位以上，需包含大写字母和数字`"
            @input="onNewPwdInput"
          />
        </el-form-item>

        <!-- ★ 2026-10-19：把当前生效的密码规则如实写在输入框下方 ——
             原来只有 placeholder 里一句「建议字母 + 数字组合」，
             用户以为是建议、不照做也被放过；现在按后端策略说明。 -->
        <div v-if="pwdVerified" class="pwd-rule">密码须{{ pwdRuleTip }}，且不能包含空格。</div>

        <!-- ③ 再输一遍新密码 -->
        <el-form-item label="确认密码" prop="confirmPassword" class="pwd-item-last">
          <el-input
            v-model="pwdForm.confirmPassword"
            type="password"
            show-password
            :disabled="!pwdVerified"
            placeholder="请再次输入新密码"
            @keyup.enter="doChangePwd"
          />
        </el-form-item>

        <!-- 强度提示（只提示，不拦截） -->
        <div v-if="pwdVerified" class="pwd-score">
          <span class="pwd-score-lb">密码强度</span>
          <span class="pwd-score-track">
            <i :style="{ width: pwdScore * 33.34 + '%' }" :class="`lv${pwdScore}`"></i>
          </span>
          <span class="pwd-score-txt" :class="`lv${pwdScore}`">{{ pwdScoreText }}</span>
        </div>
      </el-form>

      <div v-if="pwdError" class="pwd-err">{{ pwdError }}</div>
      <div v-else-if="!pwdVerified" class="pwd-tip">
        为了防止误操作，请先验证原密码，验证通过后才能设置新密码。
      </div>
      <div v-else class="pwd-tip">新密码设置成功后，下次登录请使用新密码。</div>

      <template #footer>
        <el-button @click="pwdOpen = false">取消</el-button>
        <el-button
          type="primary"
          :disabled="!pwdVerified"
          :loading="pwdSubmitting"
          @click="doChangePwd"
        >
          确认修改
        </el-button>
      </template>
    </el-dialog>

    <el-container class="body-wrap">
      <!-- ============ 左侧菜单（统一） ============ -->
      <el-aside width="228px" class="aside">
        <el-scrollbar>
          <el-menu
            v-if="menuReady"
            :default-active="activeMenu"
            :default-openeds="defaultOpeneds"
            router
            class="side-menu"
          >
            <template v-for="mod in visibleMenu" :key="mod.title">
              <!-- 有子菜单 → 分组 -->
              <el-sub-menu v-if="mod.children?.length" :index="mod.title">
                <template #title>
                  <el-icon v-if="getIcon(mod.icon)">
                    <component :is="getIcon(mod.icon)" />
                  </el-icon>
                  <span class="menu-title">{{ mod.title }}</span>
                  <el-tag
                    v-if="mod.stage"
                    size="small"
                    :type="mod.stage === '已完成' ? 'success' : mod.stage === '开发中' ? 'warning' : mod.stage === '暂缓' ? 'info' : 'danger'"
                    effect="plain"
                    class="menu-stage"
                  >
                    {{ mod.stage }}
                  </el-tag>
                </template>

                <el-menu-item
                  v-for="child in mod.children"
                  :key="child.key || child.title"
                  :index="child.path || child.title"
                  @click="router.push(goChild(child))"
                >
                  <span class="child-title">{{ child.title }}</span>
                  <span
                    v-if="child.title === '催费' && feeUrgeBadge.count > 0"
                    class="menu-red-dot"
                    :title="feeUrgeBadge.tooltip"
                  />
                  <el-tag
                    v-if="child.phase"
                    size="small"
                    :type="child.phase === '就业' ? 'success' : 'info'"
                    effect="plain"
                    class="menu-stage"
                  >
                    {{ child.phase }}
                  </el-tag>
                  <el-tag
                    v-else-if="child.stage === '已完成'"
                    size="small"
                    type="success"
                    effect="plain"
                    class="menu-stage"
                  >
                    已开发
                  </el-tag>
                </el-menu-item>
              </el-sub-menu>

              <!-- 无子菜单 → 单层菜单项（★ 2026-10-16：index 支持 path，工作台 '/' 可正常高亮） -->
              <el-menu-item
                v-else
                :index="mod.index || mod.title"
                @click="router.push(mod.path || '/coming')"
              >
                <el-icon v-if="getIcon(mod.icon)">
                  <component :is="getIcon(mod.icon)" />
                </el-icon>
                <span class="menu-title">{{ mod.title }}</span>
              </el-menu-item>
            </template>
          </el-menu>
        </el-scrollbar>
      </el-aside>

      <!-- ============ 内容区 ============ -->
      <el-main class="main">
        <!-- 面包屑：让用户随时知道自己在哪里（首页 / 分组 / 页面 / 学段） -->
        <BreadcrumbBar />
        <RouterView />
      </el-main>
    </el-container>
  </el-container>
</template>

<style scoped>
/* ★ 催费/缴费菜单红点（右上角） */
:deep(.el-menu-item) {
  position: relative;
}
.menu-red-dot {
  position: absolute;
  top: 8px;
  right: 14px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--el-color-danger);
  cursor: help;
  z-index: 2;
}
/* ============================================================
 * 2026-10-05 修：让「左侧导航」与「右侧内容」各自独立滚动
 *
 * 原来只有 .layout{height:100vh}，缺两样东西：
 *   ① overflow:hidden —— 外层容器没有把高度「锁死」；
 *   ② 内层 .el-container 的 min-height:0 —— flex 列方向子项默认
 *      min-height:auto，不会被压缩到小于内容高度。
 * 结果：内层容器长到内容那么高（实测 1736px），aside/main 也跟着
 *      变成内容高度、自己都不需要滚动 → 变成【整份文档】一根滚动条，
 *      左导航和右内容就一起滚了。
 *
 * 修完：高度锁在 100vh，内层容器被压到「视口 - 顶栏」，
 *      aside 内部 el-scrollbar 滚、main 自己滚，互不影响。
 * ============================================================ */
.layout {
  height: 100vh;
  overflow: hidden;
}

/* 顶栏下面那层（左导航 + 右内容）：必须允许被压缩，否则撑破 100vh */
.body-wrap {
  min-height: 0;
}

/* ============================================================
 * 2026-10-15 顶栏改版（良志红暖色主题）
 *   LOGO 左上角 + 白底 + 暖灰边框 + 搜索框 + 头像身份区
 *   配色与 ui-preview 设计稿一致：红 #CD3A33 只做点缀
 * ============================================================ */
.header {
  display: flex;
  align-items: center;
  gap: 18px;
  background: #fff;
  border-bottom: 1px solid #efe7e2;
  color: #443432;
  flex: none;
  height: 62px;
  padding: 0 18px;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 13px;
  flex: none;
}

.header-logo {
  height: 34px;
  width: auto;
}

.header-div {
  width: 1px;
  height: 22px;
  background: #e2d7d1;
}

.header-title {
  font-size: 16px;
  font-weight: 600;
  letter-spacing: 0.5px;
}

.header-tag {
  background: #fdf4f2;
  border-color: #f9e4e1;
  color: #cd3a33;
}

.header-search {
  width: 280px;
  margin-left: 8px;
}

/* 搜索框：胶囊形 + 暖底，聚焦变白 + 红边柔光 */
.header-search :deep(.el-input__wrapper) {
  border-radius: 18px;
  background: #f6f3ef;
  box-shadow: 0 0 0 1px #efe7e2 inset;
}

.header-search :deep(.el-input__wrapper:hover) {
  box-shadow: 0 0 0 1px #f2c8c3 inset;
}

.header-search :deep(.el-input__wrapper.is-focus) {
  background: #fff;
  box-shadow: 0 0 0 1px #cd3a33 inset, 0 0 0 3px rgba(205, 58, 51, 0.12);
}

.header-user {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 14px;
}

.header-icbtn {
  border: 1px solid #efe7e2;
  color: #6b5c58;
  background: #fff;
}

.header-icbtn:hover {
  border-color: #f2c8c3;
  color: #cd3a33;
  background: #fdf4f2;
}

.header-me {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-left: 12px;
  border-left: 1px solid #efe7e2;
}

.header-avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: linear-gradient(135deg, #dc7568, #b22a23);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  font-weight: 600;
  flex: none;
  box-shadow: 0 2px 8px rgba(205, 58, 51, 0.3);
}

.header-me-txt {
  display: flex;
  flex-direction: column;
  line-height: 1.25;
}

.header-uname {
  font-size: 13px;
  font-weight: 600;
}

.header-urole {
  font-size: 11px;
  color: #9c8d88;
}

/* 顶栏白底，「退出登录」用暖灰描边按钮，悬停转红 */
.switch-role {
  color: #6b5c58;
  border: 1px solid #efe7e2;
  padding: 6px 10px;
  height: auto;
  border-radius: 8px;
}

.switch-role:hover {
  color: #cd3a33;
  background: #fdf4f2;
  border-color: #f2c8c3;
}

.aside {
  background: #fff;
  border-right: 1px solid #E2D7D1;
  /* 高度由 flex 撑满 body-wrap；自己不再溢出，交给内部 el-scrollbar 滚 */
  overflow: hidden;
}

.side-menu {
  border-right: none;
  height: 100%;
}

.menu-title {
  font-weight: 500;
}

.child-title {
  font-size: 13px;
}

/* 菜单里的状态小标签：靠右、缩小、降低存在感 */
.menu-stage {
  margin-left: auto;
  transform: scale(0.85);
  transform-origin: right center;
}

.main {
  background: #F6F3EF;
  padding: 0;
  overflow: auto;
  /* 右侧内容区独立滚动（与左侧导航互不影响） */
  min-height: 0;
}

:deep(.el-menu-item),
:deep(.el-sub-menu__title) {
  height: 44px;
  line-height: 44px;
}

/* ============================================================
 * ★ 2026-10-15 顶栏右侧操作区：退出登录（左移）+ 修改密码（新增，最右）
 *    配色沿用顶栏的良志红，修改密码做成实心主按钮 ——
 *    它比退出登录更「需要被点」，放最右侧、视觉更重。
 * ============================================================ */
.reset-pwd-btn {
  color: #fff;
  background: #cd3a33;
  border: 1px solid #cd3a33;
  padding: 6px 12px;
  height: auto;
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(205, 58, 51, 0.24);
}

.reset-pwd-btn:hover,
.reset-pwd-btn:focus {
  color: #fff;
  background: #b22a23;
  border-color: #b22a23;
}

.reset-pwd-ic {
  margin-right: 4px;
}

/* ---------- 修改密码弹窗 ---------- */

/* 顶部「当前账号」信息条：让用户确认改的是哪个账号 */
.pwd-who {
  display: flex;
  align-items: center;
  gap: 8px;
  background: #fbf7f4;
  border: 1px solid #f1eae5;
  border-radius: 9px;
  padding: 9px 12px;
  margin-bottom: 16px;
  font-size: 12.5px;
}

.pwd-who-lb {
  color: #9c8d88;
}

.pwd-who-name {
  color: #443432;
  font-size: 13px;
}

.pwd-who-acc {
  margin-left: auto;
  color: #b3a69f;
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 11.5px;
}

.pwd-form :deep(.el-form-item) {
  margin-bottom: 16px;
}

.pwd-form :deep(.el-form-item__label) {
  font-size: 12.5px;
  color: #7a6c67;
}

/* 原密码 + 「验证」按钮同一行 */
.pwd-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
}

.pwd-verify {
  flex: none;
  width: 78px;
}

/* 「确认密码」是最后一个输入项，下面紧跟密码强度条：
 * ⚠️ 它的校验错误（如「两次输入的新密码不一致」）是**绝对定位**在输入框正下方、
 *    只占 item 的 margin-bottom 那一段。所以这里要多留 10px，
 *    否则错误红字会和「密码强度」挤在同一行、看着像叠在一起。 */
.pwd-item-last {
  margin-bottom: 26px;
}

/* 密码强度条（不拦截，只提示） */
.pwd-score {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 10px 82px;
  font-size: 11.5px;
}

.pwd-score-lb {
  color: #9c8d88;
}

.pwd-score-track {
  flex: 1;
  max-width: 120px;
  height: 6px;
  border-radius: 3px;
  background: #f1eae5;
  overflow: hidden;
  display: inline-block;
}

.pwd-score-track i {
  display: block;
  height: 100%;
  border-radius: 3px;
  transition: width 0.2s;
}

.pwd-score-track i.lv0 {
  background: transparent;
}
.pwd-score-track i.lv1 {
  background: #d9534f;
}
.pwd-score-track i.lv2 {
  background: #e0a33e;
}
.pwd-score-track i.lv3 {
  background: #3f7a55;
}

.pwd-score-txt.lv1 {
  color: #d9534f;
}
.pwd-score-txt.lv2 {
  color: #c98a24;
}
.pwd-score-txt.lv3 {
  color: #3f7a55;
}

/* 底部提示 / 错误 */
.pwd-tip {
  font-size: 11.5px;
  color: #9c8d88;
  line-height: 1.6;
}

/* ★ 2026-10-19：改密弹窗的密码规则说明 —— 与 .pwd-score 同缩进，对齐输入框左边缘 */
.pwd-rule {
  margin: 0 0 10px 82px;
  font-size: 11.5px;
  color: #9c8d88;
  line-height: 1.6;
}

.pwd-err {
  font-size: 11.5px;
  color: #b22a23;
  background: #fdf4f2;
  border: 1px solid #f9e4e1;
  border-radius: 8px;
  padding: 8px 12px;
  line-height: 1.6;
}

</style>
