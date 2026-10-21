<script setup lang="ts">
/**
 * 统一门户 · 登录页
 *
 * ⚠️⚠️ 这是【全系统唯一登录入口】。
 *
 * 用户指令原文：
 *   「给财务也补录账号，然后系统管理员也能看到财务的模块，全部糅合到一个系统中，
 *    系统管理员登录之后在右侧显示咨询模块和财务模块的目录，
 *    然后点击目录之后展开为模块内的功能，各模块的负责人只能查看自己的模块内容。」
 *
 * 登录后拿到的 visibleModules 决定侧栏目录树长什么样：
 *   - admin（系统管理员）→ 市场咨询 + 财务管理 两个模块
 *   - zhoum（财务负责人）→ 只有财务管理
 *   - wangjl（咨询经理）→ 只有市场咨询
 *
 * ⚠️ 账号来源：server-portal/migrations/20261002_002_seed_sys_account.js
 *    改动种子数据后请同步核对本页 demoAccounts，密码统一 123456。
 */

import { ref, onMounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';
import { useAuthStore } from '@/portal/stores/auth';

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();

const form = ref({ account: '', password: '' });
const errMsg = ref('');

/**
 * 演示账号（点一下自动填入）
 *
 * ⚠️ 必须与 t_sys_account 种子数据一致，否则点了登不上。
 */
const demoAccounts = [
  { account: 'admin', name: '系统管理员', scope: '全部模块', tag: 'admin' },
  { account: 'wangjl', name: '王经理', scope: '市场咨询', tag: 'consult' },
  { account: 'lilx', name: '李老师', scope: '市场咨询', tag: 'consult' },
  { account: 'zhangls', name: '张老师', scope: '市场咨询', tag: 'consult' },
  { account: 'zhoum', name: '周铭', scope: '财务管理', tag: 'finance' },
  { account: 'liukj', name: '刘会计', scope: '财务管理', tag: 'finance' },
  { account: 'linx', name: '林晓', scope: '权限管理', tag: 'perm' },
  /* ============================================================
   * ★ 2026-10-05 补充：就业 / 教务 / 班级 三大模块的【可编辑】账号
   *
   * 【为什么必须补】
   *   合并后旧模块（就业/教务/班级）的页面权限来自「角色 → 页面」，
   *   而这些角色（班主任、教务老师、就业老师、校长…）此前**没有门户账号**，
   *   进不来 → 谁也用不了这些页面上的「新增/编辑」按钮。
   *   （admin 是「只读管理员」，按设计不能写，见 app.ts 全局只读闸）
   *
   * 【怎么来的】见 数据库导出/sms_portal.sql 的「业务角色门户账号」段，
   *   与「权限管理 → 账号管理」里的 t_perm_user 按【登录名】一一对应，
   *   角色由权限模块解析（middleware/auth.ts 的 resolveBusinessRoles）。
   * ============================================================ */
  { account: 'qiansy', name: '钱守义', scope: '校长（全模块）', tag: 'job' },
  { account: 'congym', name: '丛玉梅', scope: '学管主任', tag: 'job' },
  { account: 'zhanght', name: '张海涛', scope: '班主任（大学部）', tag: 'class' },
  { account: 'sunmin', name: '孙敏', scope: '班主任（初高）', tag: 'class' },
  { account: 'zhengym', name: '郑一鸣', scope: '教务老师', tag: 'edu' },
  /* ★ 2026-10-06 补：项目经理（实训阶段）——
   *   权限库里早就有这个账号（U_sunjl / RM_PROJECT），但登录页漏列了，
   *   导致「实训阶段负责人」这个角色没有直观入口可点。
   *   ⚠️ 他的页面权限 = 就业管理板块里的【实训】分组（8 页），
   *      就业阶段的 5 页归下面的就业老师。 */
  { account: 'sunjl', name: '孙建龙', scope: '项目经理（实训）', tag: 'job' },
  { account: 'zhouj', name: '周杰', scope: '就业老师', tag: 'job' },
];

function pick(a: { account: string }) {
  form.value.account = a.account;
  form.value.password = '123456';
  errMsg.value = '';
}

async function doLogin() {
  errMsg.value = '';
  if (!form.value.account.trim()) {
    errMsg.value = '请输入登录账号';
    return;
  }
  if (!form.value.password) {
    errMsg.value = '请输入密码';
    return;
  }

  try {
    const res = await auth.login(form.value.account.trim(), form.value.password);
    ElMessage.success(`欢迎回来，${res.account.userName}`);

    if (!res.visibleModules.length) {
      ElMessage.warning('该账号未被授权任何模块，请联系系统管理员');
      router.replace('/no-permission');
      return;
    }

    // 带 redirect 就回原页（但要过一遍守卫），否则落到系统首页工作台
    // ★ 2026-10-16：工作台 = 首页，服务端 landingPathOf 对所有角色统一返回 '/'
    const redirect = route.query.redirect as string | undefined;
    router.replace(redirect || res.landingPath || auth.landingHash);
  } catch (err: any) {
    errMsg.value = err?.message || '登录失败，请检查账号密码';
  }
}

onMounted(() => {
  // 已登录再进登录页 → 交给守卫统一处理落地
  if (auth.isLogin) {
    router.replace('/');
  }
});
</script>

<template>
  <div class="login-page">
    <div class="login-card">
      <!-- 左：品牌 -->
      <div class="brand-pane">
        <div class="bp-logo-card">
          <img class="bp-logo" src="/logo.png" alt="良志教育" />
        </div>
        <h1>良志学管系统</h1>
        <p class="bp-sub">让教学管理更简单</p>
      </div>

      <!-- 右：登录表单 -->
      <div class="form-pane">
        <h2>登录</h2>
        <p class="fp-sub">请使用系统管理员分配的账号登录</p>

        <div class="fi">
          <label>登录账号</label>
          <input
            v-model="form.account"
            type="text"
            placeholder="请输入登录账号"
            autocomplete="username"
            @keyup.enter="doLogin"
          />
        </div>

        <div class="fi">
          <label>密码</label>
          <input
            v-model="form.password"
            type="password"
            placeholder="请输入密码"
            autocomplete="current-password"
            @keyup.enter="doLogin"
          />
        </div>

        <div v-if="errMsg" class="err">{{ errMsg }}</div>

        <button class="submit" :disabled="auth.loading" @click="doLogin">
          {{ auth.loading ? '登录中…' : '登 录' }}
        </button>

        <div class="demo">
          <div class="demo-title">演示账号（点击自动填入，密码均为 123456）</div>
          <div class="demo-grid">
            <div
              v-for="a in demoAccounts"
              :key="a.account"
              class="demo-item"
              @click="pick(a)"
            >
              <span class="di-name">{{ a.name }}</span>
              <span class="di-scope" :class="a.tag">{{ a.scope }}</span>
              <span class="di-account">{{ a.account }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.login-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #FBEFED 0%, #FBF7F4 55%, #F6F3EF 100%);
  padding: 24px;
}

.login-card {
  width: 880px;
  max-width: 100%;
  display: flex;
  background: #fff;
  border-radius: 18px;
  overflow: hidden;
  box-shadow: 0 18px 60px rgba(68, 52, 50, 0.12);
}

/* ---------- 左侧品牌 ---------- */
.brand-pane {
  width: 356px;
  flex: none;
  padding: 40px 36px;
  background: linear-gradient(160deg, #CD3A33 0%, #B22A23 58%, #8C201B 100%);
  color: #fff;
  display: flex;
  flex-direction: column;
  justify-content: center;
}

/* LOGO 白卡（2026-10-16：LOGO 放大、白色内边距收窄） */
.bp-logo-card {
  background: #fff;
  border-radius: 14px;
  padding: 10px 16px;
  display: inline-flex;
  align-self: flex-start;
  box-shadow: 0 14px 40px rgba(40, 8, 5, 0.35);
  margin-bottom: 22px;
}

.bp-logo {
  height: 72px;
  width: auto;
  display: block;
}

.brand-pane h1 {
  font-size: 28px;
  font-weight: 700;
  letter-spacing: 1px;
}

.bp-sub {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.85);
  margin-top: 9px;
  letter-spacing: 3px;
}

/* ---------- 右侧表单 ---------- */
.form-pane {
  flex: 1;
  min-width: 0;
  padding: 38px 40px 30px;
  display: flex;
  flex-direction: column;
}

.form-pane h2 {
  font-size: 19px;
  font-weight: 700;
  color: #443432;
}

.fp-sub {
  font-size: 12px;
  color: #8A7B76;
  margin: 6px 0 26px;
}

.fi {
  display: flex;
  flex-direction: column;
  gap: 7px;
  margin-bottom: 15px;
}

.fi label {
  font-size: 12px;
  color: #7A6C67;
}

.fi input {
  height: 40px;
  border: 1px solid #E2D7D1;
  border-radius: 9px;
  padding: 0 13px;
  font-size: 13px;
  color: #5F5350;
  font-family: inherit;
  outline: none;
  transition: 0.15s;
  background: #fff;
  width: 100%;
}

.fi input:focus {
  border-color: #E6A99C;
  box-shadow: 0 0 0 3px rgba(205, 58, 51, 0.1);
}

.fi input::placeholder {
  color: #C4B8B2;
}

.err {
  font-size: 12px;
  color: #B22A23;
  background: #FDF4F2;
  border: 1px solid #F9E4E1;
  border-radius: 8px;
  padding: 9px 12px;
  margin-bottom: 12px;
  line-height: 1.55;
}

.submit {
  height: 42px;
  border: none;
  border-radius: 9px;
  background: #CD3A33;
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  font-family: inherit;
  letter-spacing: 2px;
  cursor: pointer;
  transition: 0.15s;
  box-shadow: 0 2px 8px rgba(205, 58, 51, 0.26);
  margin-top: 4px;
}

.submit:hover:not(:disabled) {
  background: #B22A23;
}

.submit:disabled {
  opacity: 0.62;
  cursor: default;
}

/* ---------- 演示账号 ---------- */
.demo {
  margin-top: 26px;
  border-top: 1px solid #F1EAE5;
  padding-top: 16px;
}

.demo-title {
  font-size: 11.5px;
  color: #B3A69F;
  margin-bottom: 10px;
}

.demo-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 5px;
}

.demo-item {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 7px 9px;
  border-radius: 7px;
  border: 1px solid transparent;
  cursor: pointer;
  font-size: 11.5px;
  transition: 0.15s;
}

.demo-item:hover {
  background: #FBF7F4;
  border-color: #F9E4E1;
}

.di-name {
  font-weight: 600;
  color: #5F5350;
  white-space: nowrap;
}

.di-scope {
  font-size: 10px;
  border-radius: 9px;
  padding: 1px 7px;
  white-space: nowrap;
}

.di-scope.admin {
  background: #FDF4F2;
  color: #B22A23;
}

.di-scope.consult {
  background: #F3EFF8;
  color: #7A5AA6;
}

.di-scope.finance {
  background: #EBF5EF;
  color: #3F7A55;
}

.di-scope.perm {
  background: #FBF3E5;
  color: #A66A1F;
}

/* ★ 2026-10-05：就业 / 教务 / 班级 三个模块的标签配色 */
.di-scope.job {
  background: #FDF4F2;
  color: #B22A23;
}

.di-scope.edu {
  background: #EBF5EF;
  color: #3F7A55;
}

.di-scope.class {
  background: #F3EFF8;
  color: #7A5AA6;
}

.di-account {
  margin-left: auto;
  color: #C4B8B2;
  font-family: "SFMono-Regular", Consolas, monospace;
  font-size: 11px;
}

@media (max-width: 800px) {
  .brand-pane {
    display: none;
  }
  .login-card {
    width: 440px;
  }
}
</style>
