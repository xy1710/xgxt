<script setup lang="ts">
/**
 * 账号编辑弹窗（可复用）
 *
 * 【为什么抽成组件】
 *   原先只有「账号管理」能编辑账号。其余入口（部门管理 → 查看账号 → 编辑）
 *   是 `router.push('/user?edit=<id>')` 跳到账号管理页再打开表单 ——
 *   用户原话：「跳转到账号管理进行修改很别扭」。
 *   抽成本组件后，部门管理点「编辑」就地弹出，保存后调用方刷新自己的列表即可。
 *
 * 【口径与账号管理完全一致】
 *   字段：姓名 / 性别 / 年龄 / 手机号 / 登录账号 / 账号状态（= 图二的「基本信息」）
 *   校验：汉字姓名≥2 · 性别必选 · 年龄 20-65 · 手机号 11 位 · 账号 4-20 位字母数字 · 状态必选
 *   保存：PUT /api/perm/user/update（职位、部门、可访问模块原样带回，界面不改它们）
 *
 *   ⚠️ 传不传 `modules` 有讲究：后端 update 里「modules 不传 = 不动门户那边的模块配置」，
 *      所以这里刻意不传 —— 编辑基础信息不该顺手改写门户可访问模块。
 *
 * 【自取数据】调用方只给 userId（可选再给一行列表数据做首屏秒开）：
 *   详情由本组件自己拉，保证「点到哪个账号就编哪个」。
 */
import { computed, reactive, ref, watch } from 'vue';
import type { PermUserListItem, UserStatus } from 'shared-types/perm';
import ProtoDialog from './ProtoDialog.vue';
import { userApi } from '@/perm/api/perm';
import { useOptionStore } from '@/perm/stores/option';
import { toast } from '@/perm/utils/toast';

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    /** 要编辑的账号 id（'' 时不开表单） */
    userId: string;
    /** 列表行数据：先填进表单秒开，随后用详情覆盖（可选） */
    fallback?: PermUserListItem | null;
  }>(),
  { fallback: null },
);

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  /** 保存成功（调用方据此刷新自己的列表 / KPI） */
  (e: 'saved'): void;
}>();

const optionStore = useOptionStore();

/** 账号状态下拉：优先用字典接口，兜底原型写死的三档（与账号管理同一口径） */
const statusOptions = computed<{ value: string; label: string }[]>(() => {
  const opts = optionStore.userStatuses;
  if (opts && opts.length) return opts.map((o) => ({ value: String(o.value), label: o.label }));
  return [
    { value: '正常', label: '正常' },
    { value: '已停用', label: '已停用' },
    { value: '已锁定', label: '已锁定' },
  ];
});

interface EditForm {
  id: string;
  userName: string;
  account: string;
  phone: string;
  /** 0 = 未选 */
  gender: number;
  /** null = 未填 */
  age: number | null;
  deptId: string;
  /** 枚举以字符串承接，提交时再断言成 UserStatus（与账号管理同一写法） */
  userStatus: string;
  /** 界面不可改，仅原样带回，避免保存时把职位清空 */
  roleIds: string[];
}

const form = reactive<EditForm>({
  id: '',
  userName: '',
  account: '',
  phone: '',
  gender: 0,
  age: null,
  deptId: '',
  userStatus: '',
  roleIds: [],
});

const loading = ref(false);
const saving = ref(false);
/** 校验未通过的问题清单（就地显示在表单顶部，不再叠一层「校验失败」弹窗） */
const errs = ref<string[]>([]);
/** 二次确认（与账号管理的「保存账号修改」确认框同文案） */
const confirmOpen = ref(false);

const title = computed(() => {
  const n = esc(form.userName || props.fallback?.userName || '');
  return `编辑账号 · <span class="em">${n}</span> <span class="tag n">修改账号基础信息</span>`;
});

function esc(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/** 手机号只收数字（粘贴带空格 / 横线时也能纠正） */
function onPhoneInput(e: Event): void {
  const el = e.target as HTMLInputElement;
  const v = el.value.replace(/\D/g, '').slice(0, 11);
  el.value = v;
  form.phone = v;
}

function fillFrom(row: Partial<PermUserListItem> & { roleIds?: string[] }): void {
  form.id = row.id || form.id;
  form.userName = row.userName ?? '';
  form.account = row.account ?? '';
  form.phone = row.phone ?? '';
  form.gender = row.gender ?? 0;
  form.age = (row.age ?? null) as number | null;
  form.deptId = row.deptId ?? '';
  form.userStatus = String(row.userStatus ?? '');
  form.roleIds = [...((row.roleIds as string[]) || [])];
}

/** 拉最新详情覆盖表单（列表行可能是几秒前的快照） */
async function loadDetail(id: string): Promise<void> {
  loading.value = true;
  try {
    const d = await userApi.detail(id);
    // ⚠️ /user/detail 实际返回「列表项形态」，契约只声明了 PermUser + roleIds/roleNames，
    //    这里过一道 unknown 再读，避免 TS 判「类型不相交」（与账号管理深链接同写法）。
    fillFrom({ ...d } as unknown as PermUserListItem);
  } catch {
    /* 已提示；保留 fallback 的值，仍可继续编辑 */
  } finally {
    loading.value = false;
  }
}

watch(
  () => [props.modelValue, props.userId] as const,
  ([on, id]) => {
    if (!on) return;
    errs.value = [];
    confirmOpen.value = false;
    fillFrom(props.fallback && props.fallback.id === id ? props.fallback : {});
    form.id = id;
    if (id) void loadDetail(id);
  },
  { immediate: true },
);

function validate(): string[] {
  const list: string[] = [];
  if (!form.userName) list.push('请输入姓名');
  else if (!/^[\u4e00-\u9fa5]{2,}$/.test(form.userName)) list.push('姓名只能是汉字，且不少于 2 个字');
  if (form.gender !== 1 && form.gender !== 2) list.push('请选择性别');
  if (!form.age || form.age < 20 || form.age > 65) list.push('年龄需在 20-65 之间');
  if (!/^1[3-9]\d{9}$/.test(form.phone || '')) {
    list.push('手机号格式不正确（11 位，1 开头，请勿输入空格/横线）');
  }
  if (!/^[A-Za-z0-9]{4,20}$/.test(form.account || '')) list.push('登录账号需 4-20 位字母/数字');
  if (!form.userStatus) list.push('请选择账号状态');
  // 登录账号 / 手机号是否被占用由后端唯一校验兜底（本弹窗拿不到全量列表，
  // 但后端的报错文案已经足够明确：「登录账号「xxx」已存在」）。
  return list;
}

function onSubmit(): void {
  const list = validate();
  errs.value = list;
  if (list.length) return;
  confirmOpen.value = true;
}

async function doSave(): Promise<void> {
  if (saving.value) return;
  saving.value = true;
  try {
    await userApi.update({
      id: form.id,
      userName: form.userName,
      account: form.account,
      phone: form.phone,
      gender: form.gender,
      age: Number(form.age),
      deptId: form.deptId,
      roleIds: [...form.roleIds],
      userStatus: form.userStatus as UserStatus,
      // ⚠️ 刻意不传 modules：不传 = 后端不动门户那边的模块配置
    });
    toast(`已保存账号「${form.userName}」的修改`);
    confirmOpen.value = false;
    emit('saved');
    emit('update:modelValue', false);
  } catch {
    /* 已提示（含账号/手机号重复） */
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <ProtoDialog :model-value="modelValue" :title="title" size="xl" @update:model-value="emit('update:modelValue', $event)">
    <!-- 校验未通过：就地列出来，不叠第二层弹窗 -->
    <div v-if="errs.length" class="notice d mb12">
      ✕<div>
        请修正以下 {{ errs.length }} 处问题：
        <ul style="padding-left: 18px; margin: 5px 0 0; line-height: 1.85">
          <li v-for="e in errs" :key="e">{{ e }}</li>
        </ul>
      </div>
    </div>

    <div class="sec-t"><span class="bar"></span>基本信息</div>
    <div class="fm" style="grid-template-columns: 1fr 1fr">
      <div class="f">
        <label>姓名 <span class="req">*</span></label>
        <input v-model="form.userName" class="inp" placeholder="请输入真实姓名" />
      </div>
      <div class="f">
        <label>性别 <span class="req">*</span></label>
        <div class="radios">
          <label><input v-model="form.gender" type="radio" name="ue_gen" :value="1" /> 男</label>
          <label><input v-model="form.gender" type="radio" name="ue_gen" :value="2" /> 女</label>
        </div>
      </div>
      <div class="f">
        <label>年龄 <span class="req">*</span></label>
        <input
          v-model.number="form.age"
          class="inp"
          type="number"
          min="20"
          max="65"
          placeholder="20-65"
        />
      </div>
      <div class="f">
        <label>手机号 <span class="req">*</span></label>
        <input
          :value="form.phone"
          class="inp"
          placeholder="11 位手机号"
          maxlength="11"
          inputmode="numeric"
          @input="onPhoneInput"
        />
      </div>
      <div class="f">
        <label>登录账号 <span class="req">*</span></label>
        <input v-model="form.account" class="inp" placeholder="字母/数字，4-20 位" />
      </div>
      <div class="f">
        <label>账号状态 <span class="req">*</span></label>
        <select v-model="form.userStatus" class="inp">
          <option value="" disabled>请选择</option>
          <option v-for="o in statusOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
      </div>
    </div>

    <!-- 只改基础信息：职位 / 部门不在这里改，写清楚免得用户以为能改 -->
    <div class="desc" style="margin-top: 10px">
      仅修改基础信息；所属职位与部门不受影响（如需调整请用列表里的「分配职位」）。
      <span v-if="loading">正在读取最新资料…</span>
    </div>

    <template #footer>
      <div class="lft">账号 ID：{{ form.id || '—' }}</div>
      <button class="btn" type="button" @click="emit('update:modelValue', false)">取消</button>
      <button
        class="btn"
        type="button"
        @click="toast('已保存为草稿，可在列表中继续编辑')"
      >
        存草稿
      </button>
      <button class="btn pri" type="button" :disabled="saving || loading" @click="onSubmit">
        保存修改
      </button>
    </template>
  </ProtoDialog>

  <!-- 保存前二次确认（与账号管理同一个问法）—— 写在外层弹窗之外，
       避免外层 v-if 关闭时把确认框一起卸掉 -->
  <ProtoDialog v-model="confirmOpen" title="保存账号修改" size="sm">
    <div class="notice i mb12">ℹ<div>确认保存对「{{ form.userName }}」的修改？</div></div>
    <div style="font-size: 12.5px; color: var(--tx2); line-height: 1.9">
      <div>
        姓名 / 性别：<b>{{ form.userName }}</b> · {{ form.gender === 2 ? '女' : '男' }} ·
        {{ form.age }} 岁
      </div>
      <div>登录账号：<code>{{ form.account }}</code></div>
      <div>手机号：{{ form.phone }}</div>
      <div>账号状态：{{ form.userStatus || '—' }}</div>
    </div>
    <div class="desc mt12">
      仅修改基础信息；所属职位与部门不受影响（如需调整请用列表里的「分配职位」）。
    </div>
    <template #footer>
      <button class="btn" type="button" @click="confirmOpen = false">再改改</button>
      <button class="btn pri" type="button" :disabled="saving" @click="doSave">确认保存</button>
    </template>
  </ProtoDialog>
</template>
