<script setup lang="ts">
/**
 * 收款与缴费
 *
 * 规则在此页的体现：
 *   - 规则2：发起收费时金额由财务按「费用标准」取值，页面只展示预览值，不让手填
 *   - 规则3-①：只能发起咨询模块负责的费用类型（学费 / 试学费），其他类型调用会被拒
 *   - 规则3-②：上传凭证时，非餐费一人一张；重复时财务拒绝并提示占用方
 */

import { ref, onMounted, computed, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import type {
  ConsultFeeOrder,
  ConsultFeeStats,
  ConsultInstallmentPlan,
  ConsultInstallmentItem,
  ConsultSupplementPlan,
  FinanceStandardView,
  ConsultStudentListItem,
} from 'shared-types/consult';
import {
  FeeType,
  FEE_TYPE_NAME,
  CONSULT_FEE_STATUS_NAME,
  ConsultFeeStatus,
  PAY_METHODS,
} from 'shared-types/consult';
import {
  fetchFeeList,
  fetchFeeStats,
  createFees,
  uploadFile,
  uploadVoucher,
  resubmitOrder,
  // ★ 2026-10-19 作废（重复发起 / 发起错了的撤销通道）
  cancelFeeOrders,
  fetchStandardBatch,
  fetchStudentList,
  // ★ 2026-10-20 补费（试学转正尾款 / 差额补收）
  createSupplementFee,
  fetchSupplementPlan,
  // ★ 2026-10-16 分期付款
  createInstallment,
  payInstallmentStage,
  fetchInstallmentDetail,
} from '@/consult/api/consult';
import { useAuthStore } from '@/consult/stores/auth';

const auth = useAuthStore();

/* ---------- 列表 ---------- */
const loading = ref(false);
const list = ref<ConsultFeeOrder[]>([]);
const total = ref(0);

/** 分页总页数（原型 pager 里的「第 N/M 页」） */
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / (size.value || 20))));
const page = ref(1);
const size = ref(10);
const query = ref({
  keyword: '',
  feeType: undefined as number | undefined,
  status: undefined as number | undefined,
});

const stats = ref<ConsultFeeStats | null>(null);

async function load() {
  loading.value = true;
  try {
    const [res, st] = await Promise.all([
      fetchFeeList({
        page: page.value,
        size: size.value,
        keyword: query.value.keyword || undefined,
        feeType: query.value.feeType,
        status: query.value.status,
      }),
      fetchFeeStats(),
    ]);
    list.value = res.list;
    total.value = res.total;
    stats.value = st;
  } finally {
    loading.value = false;
  }
}

function search() {
  page.value = 1;
  load();
}

function resetQuery() {
  query.value = { keyword: '', feeType: undefined, status: undefined };
  page.value = 1;
  load();
}

/* ---------- 发起收费 ---------- */
/**
 * ★ 2026-10-15 用户口径改造：
 *   ① 收费类型二选一：试学费（整档）/ 正式学费（多选，合计自动算）
 *   ② 缴费方式改下拉选择：微信支付 / 支付宝支付 / 银行卡转账 / 现金 / 其他
 *   ③ 凭证就在这个弹窗里上传，不用建完单再去列表二次操作
 *   ★ 2026-10-16：正式学费含「试学费」并列项（试学结束后补缴）
 */
type FeeCategory = 'TRIAL' | 'FORMAL';

/**
 * 正式学费的可选项（含试学费，共 7 项）
 *
 * ⚠️ fallback 只是【财务标准取不到时的兜底展示值】（单位：元），
 *    真实金额一律以 t_finance_fee_standard 为准（规则2：金额由财务取值，不让手填）。
 *    calc 是给老师看的算式说明（如住宿费 = 450 × 6 个月）。
 */
const FORMAL_FEE_ITEMS = [
  { feeType: FeeType.TUITION, label: '学费', calc: '', fallback: 28000 },
  /**
   * ★ 2026-10-16 用户口径：试学费与学费是并列费用项，正式学费可以包含试学费
   *    （如悠悠：学费 28000 + 试学费 5000 = 33000）。
   *    试学期间单独收试学费走「试学费」类型；试学结束后未收的，
   *    转正式时勾选「试学费」一并补缴。
   */
  { feeType: FeeType.TRIAL_FEE, label: '试学费', calc: '试学结束后补缴', fallback: 5000 },
  { feeType: FeeType.ACCOMMODATION, label: '住宿费', calc: '450 × 6', fallback: 2700 },
  { feeType: FeeType.DEPOSIT, label: '押金', calc: '', fallback: 200 },
  { feeType: FeeType.INSURANCE, label: '保险费', calc: '', fallback: 150 },
  { feeType: FeeType.MEAL, label: '餐费', calc: '', fallback: 850 },
  { feeType: FeeType.UNIFORM, label: '校服', calc: '', fallback: 500 },
];

/** 试学费的兜底金额（单位：元） */
const TRIAL_FEE_FALLBACK = 5000;

/**
 * ★ 2026-10-15 试学费金额可自定义
 *
 * null = 老师没改过 → 跟随财务费用标准；
 * 有值  = 老师本次手填的实收金额（试学金额常因优惠/减免而变，所以要能改）。
 */
const trialAmount = ref<number | null>(null);

/**
 * ★ 2026-10-16 正式学费的「实缴金额」（元）
 *
 * null = 老师没改 → 实缴 = 应缴（无优惠）；
 * 有值  = 本次实际收的钱。优惠 = 应缴 - 实缴（实缴 > 应缴 时显示「补收」）。
 */
const formalPaid = ref<number | null>(null);

const createVisible = ref(false);
const creating = ref(false);
const createForm = ref<{
  consultStudentId: string;
  category: FeeCategory;
  formalFeeTypes: number[];
  payMethod: string;
  /** 弹窗内选择的凭证（base64 预览/上传用） */
  dataUrl: string;
  voucherNo: string;
}>({
  consultStudentId: '',
  category: 'TRIAL',
  formalFeeTypes: [],
  payMethod: '',
  dataUrl: '',
  voucherNo: '',
});

/* ---------- 学生选择（★ 2026-10-08：必填项由「学生ID」改为「学生姓名」） ---------- */
const studentOptions = ref<Array<{ consultStudentId: string; studentName: string; consultStateName?: string }>>([]);
const studentSearching = ref(false);

/**
 * 远程搜索学生（按姓名/学号模糊匹配）
 *
 * ★ 状态全流转：不传 consultState，候选覆盖【全部状态】的学生 ——
 *    待面试 / 试学费·待确认 / 试学中 / 正式……都能被选中发起收费。
 *    之前「齐甜甜搜不到」就是因为旧弹窗要手输学生ID，而不是搜索范围的锅。
 */
async function searchStudents(keyword: string) {
  studentSearching.value = true;
  try {
    const res = await fetchStudentList({ page: 1, size: 20, keyword: keyword || undefined });
    studentOptions.value = res.list.map((s: ConsultStudentListItem) => ({
      consultStudentId: s.consultStudentId,
      studentName: s.studentName,
      consultStateName: s.consultStateName,
    }));
  } catch {
    studentOptions.value = [];
  } finally {
    studentSearching.value = false;
  }
}

/**
 * 费用标准（金额单位：分），key = feeType
 *
 * ⚠️ 打开弹窗时一次性把「试学费 + 正式学费六项」全拉下来，
 *    勾选时即时算合计，不用每次勾选都跑一趟接口。
 */
const standardMap = ref<Record<number, number>>({});

async function loadStandards() {
  try {
    const res = await fetchStandardBatch([
      FeeType.TRIAL_FEE,
      ...FORMAL_FEE_ITEMS.map((i) => i.feeType),
    ]);
    const map: Record<number, number> = {};
    (res.list || []).forEach((s: FinanceStandardView) => {
      map[s.feeType] = s.amount;
    });
    standardMap.value = map;
  } catch {
    // 取不到就走兜底展示值，不阻塞老师操作
    standardMap.value = {};
  }
}

/** 某项费用的金额（单位：元）：优先财务标准，取不到用兜底值 */
function amountYuan(feeType: number, fallback: number): number {
  const std = standardMap.value[feeType];
  return std == null ? fallback : std / 100;
}

/** 试学费金额输入（元）：没改过时显示标准值，改了就用老师的 */
const trialAmountInput = computed({
  get: () => trialAmount.value ?? amountYuan(FeeType.TRIAL_FEE, TRIAL_FEE_FALLBACK),
  set: (v: number) => {
    trialAmount.value = Number.isFinite(v) ? v : null;
  },
});

/**
 * 本次发起的合计金额（单位：元）
 *
 * ★ 2026-10-16 正式学费：合计 = 【实缴】（可能含优惠），不再是应缴；
 *    试学费保持原来的「老师手填金额」语义。
 */
const createTotal = computed(() => {
  if (createForm.value.category === 'TRIAL') {
    return trialAmountInput.value;
  }
  return formalPaidInput.value;
});

/** 正式学费的【应缴】合计（元）：勾选各项的财务标准之和 */
const formalDue = computed(() => {
  if (createForm.value.category !== 'FORMAL') return 0;
  return createForm.value.formalFeeTypes.reduce((sum, ft) => {
    const item = FORMAL_FEE_ITEMS.find((i) => i.feeType === ft);
    return sum + (item ? amountYuan(item.feeType, item.fallback) : 0);
  }, 0);
});

/** 正式学费的【实缴】输入框：没改过时显示应缴，改了就用老师的（元）
 *  ★ 2026-10-16 用户口径：实缴不能大于应缴，超出直接钳回应缴 */
const formalPaidInput = computed({
  get: () => formalPaid.value ?? formalDue.value,
  set: (v: number) => {
    if (!Number.isFinite(v)) {
      formalPaid.value = null;
      return;
    }
    formalPaid.value = formalDue.value > 0 && v > formalDue.value ? formalDue.value : v;
  },
});

/** 正式学费的【优惠】（元）：应缴 - 实缴（实缴已被钳制 ≤ 应缴，不会为负） */
const formalDiscount = computed(() => formalDue.value - formalPaidInput.value);

/** 改勾选 / 切换收费类型时，实缴回到「按应缴」 */
watch(
  () => [createForm.value.category, createForm.value.formalFeeTypes.join(',')],
  () => {
    formalPaid.value = null;
  },
);

/* ============================================================
 * ★ 2026-10-16 分期付款
 *
 * 用户口径：分期的学生首付到账即可分班，尾款挂在待缴余额里继续收。
 * 老师在「发起收费」时选分期 → 填期数 → 系统自动平均分配 → 可再手改每期金额与到期日。
 * ============================================================ */

/** 收款方式：一次性 / 分期 */
type PayMode = 'ONCE' | 'INSTALLMENT';
const payMode = ref<PayMode>('ONCE');

/** 期数（2 ~ 12） */
const stageCount = ref(3);

/** 期次明细：金额单位「元」 */
const stages = ref<Array<{ stageNo: number; amount: number; dueDate: string }>>([]);

const p2 = (n: number) => String(n).padStart(2, '0');

/** 第 i 期的默认到期日：今天 + 30×(i-1) 天 */
function defaultDueDate(i: number): string {
  const d = new Date();
  d.setDate(d.getDate() + 30 * (i - 1));
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/**
 * 按当前实缴金额平均分配到各期
 *
 * ⚠️ 除不尽的零头全部落在【最后一期】上，保证各期之和 = 实缴（分不丢不涨）。
 */
function splitEvenly() {
  const totalCent = Math.round(Number(createTotal.value || 0) * 100);
  const n = stageCount.value;
  if (totalCent <= 0 || n < 2) {
    stages.value = [];
    return;
  }
  const base = Math.floor(totalCent / n);
  const arr: Array<{ stageNo: number; amount: number; dueDate: string }> = [];
  let sum = 0;
  for (let i = 1; i <= n; i++) {
    const cent = i === n ? totalCent - sum : base;
    sum += cent;
    arr.push({ stageNo: i, amount: cent / 100, dueDate: defaultDueDate(i) });
  }
  stages.value = arr;
}

/** 各期之和（元） */
const stagesSum = computed(() =>
  stages.value.reduce((s, i) => s + (Number(i.amount) || 0), 0),
);

/** 各期之和与实缴的差额（元）；不为 0 时禁止提交（后端也会拦） */
const stagesDiff = computed(() => stagesSum.value - Number(createTotal.value || 0));

/** 本期是否有到期日已过（提示老师，不阻断） */
const anyOverdue = computed(() =>
  stages.value.some((s) => !!s.dueDate && s.dueDate < `${new Date().getFullYear()}-${p2(new Date().getMonth() + 1)}-${p2(new Date().getDate())}`),
);

/** 实缴金额变化 / 切换到分期时，重新平均分配 */
watch([() => createTotal.value, stageCount, payMode], () => {
  if (payMode.value === 'INSTALLMENT') splitEvenly();
});

/** 本次实际要发起的费用类型列表 */
const currentFeeTypes = computed<FeeType[]>(() =>
  createForm.value.category === 'TRIAL'
    ? [FeeType.TRIAL_FEE]
    : (createForm.value.formalFeeTypes as FeeType[]),
);

/** 弹窗里的凭证选文件 → 转 base64 */
function onCreateFileChange(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    ElMessage.error('图片不能超过 5MB');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    createForm.value.dataUrl = String(reader.result || '');
  };
  reader.readAsDataURL(file);
}

function openCreate(row?: ConsultFeeOrder) {
  createForm.value = {
    consultStudentId: row?.consultStudentId || '',
    category: 'TRIAL',
    formalFeeTypes: [],
    payMethod: '',
    dataUrl: '',
    voucherNo: '',
  };
  // 每次打开都回到「按标准取值」，不把上一次手填的金额带过来
  trialAmount.value = null;
  formalPaid.value = null;
  // ★ 2026-10-16 分期：默认一次性，期数回到 3 期
  payMode.value = 'ONCE';
  stageCount.value = 3;
  stages.value = [];
  // 从行内带出学生：把该学生放进候选，保证下拉能显示姓名
  studentOptions.value = row?.consultStudentId
    ? [{ consultStudentId: row.consultStudentId, studentName: row.studentName }]
    : [];
  createVisible.value = true;
  loadStandards();
}

async function submitCreate() {
  const f = createForm.value;
  if (!f.consultStudentId) {
    ElMessage.warning('请选择学生');
    return;
  }
  if (!f.payMethod) {
    ElMessage.warning('请选择缴费方式');
    return;
  }
  const feeTypes = currentFeeTypes.value;
  if (!feeTypes.length) {
    ElMessage.warning('请至少勾选一项费用');
    return;
  }
  /**
   * ★ 2026-10-15 凭证必填：
   *    列表与详情都取消了补传入口，这里不传，单据会永远停在「待上传凭证」。
   */
  if (!f.dataUrl) {
    ElMessage.warning('请先上传缴费凭证截图');
    return;
  }

  /**
   * ★ 2026-10-15 试学费金额自定义：
   *   老师手填的金额（元）→ 换算成分传给后端，后端会同时写给财务，两边口径一致。
   *   正式学费六项不传 → 仍按财务费用标准取值。
   */
  let amountByType: Record<number, number> | undefined;
  if (f.category === 'TRIAL') {
    const yuan = Number(trialAmountInput.value);
    if (!Number.isFinite(yuan) || yuan <= 0) {
      ElMessage.warning('请填写试学费金额（需大于 0）');
      return;
    }
    amountByType = { [FeeType.TRIAL_FEE]: Math.round(yuan * 100) };
  } else {
    /**
     * ★ 2026-10-16 正式学费：实缴 ≠ 应缴 时，差额落在【学费】上
     *    （没有勾学费就落在第一项）。优惠后该项金额不能为负。
     */
    const due = Number(formalDue.value);
    const paid = Number(formalPaidInput.value);
    if (!Number.isFinite(paid) || paid <= 0) {
      ElMessage.warning('请填写实缴金额（需大于 0）');
      return;
    }
    // ★ 2026-10-16 用户口径：实缴不能大于应缴
    if (paid > due) {
      ElMessage.warning('实缴金额不能大于应缴金额');
      return;
    }
    const diff = due - paid; // ≥0 优惠（实缴已被钳制 ≤ 应缴）
    if (diff !== 0 && f.formalFeeTypes.length) {
      const target = f.formalFeeTypes.includes(FeeType.TUITION)
        ? FeeType.TUITION
        : f.formalFeeTypes[0];
      const item = FORMAL_FEE_ITEMS.find((i) => i.feeType === target);
      const std = item ? amountYuan(item.feeType, item.fallback) : 0;
      const targetPaid = std - diff;
      if (targetPaid < 0) {
        ElMessage.warning(
          `优惠金额过大：「${item?.label || ''}」应缴 ¥${std.toFixed(2)}，无法再减 ¥${diff.toFixed(2)}。请调整实缴金额。`,
        );
        return;
      }
      amountByType = { [target]: Math.round(targetPaid * 100) };
    }
  }

  /* ---------- ★ 2026-10-16 分期：各期之和必须等于实缴 ---------- */
  if (payMode.value === 'INSTALLMENT') {
    if (stages.value.length < 2) {
      ElMessage.warning('分期至少需要 2 期');
      return;
    }
    if (Math.abs(stagesDiff.value) > 0.001) {
      ElMessage.warning(
        `各期合计 ¥${stagesSum.value.toFixed(2)} 与实缴金额 ¥${Number(createTotal.value).toFixed(2)} 不一致（差 ¥${stagesDiff.value.toFixed(2)}），请调整`,
      );
      return;
    }
  }

  creating.value = true;
  try {
    /**
     * ★ 2026-10-19 用户口径：「只要缴费就要有凭证」。
     *
     * 顺序改成「先传凭证拿 url → 再建单」，凭证随建单一起落库：
     *   原来「先建单、再绑凭证」一旦第二步失败（如截图被占用），
     *   就会留一张没有凭证的单据，财务永远看不到。
     */
    const up = await uploadFile(f.dataUrl, 'voucher');

    /* ---------- ★ 2026-10-16 分期：建计划 + 立刻发起第 1 期 ---------- */
    if (payMode.value === 'INSTALLMENT') {
      const plan = await createInstallment({
        consultStudentId: f.consultStudentId,
        feeTypes,
        amountByType,
        payMethod: f.payMethod,
        stages: stages.value.map((s) => ({
          stageNo: s.stageNo,
          amount: Math.round(Number(s.amount) * 100),
          dueDate: s.dueDate || undefined,
        })),
        // ★ 第 1 期的凭证随计划一起落库
        voucherUrl: up.url,
        voucherNo: f.voucherNo || undefined,
      });

      ElMessage.success(
        `分期计划 ${plan.planNo} 已创建（共 ${plan.stageCount} 期，应收 ¥${plan.totalAmountYuan}），凭证已上传，等待财务确认`,
      );
      createVisible.value = false;
      load();
      return;
    }

    const res = await createFees({
      consultStudentId: f.consultStudentId,
      feeTypes,
      payMethod: f.payMethod,
      amountByType,
      voucherUrl: up.url,
      voucherNo: f.voucherNo || undefined,
    });

    ElMessage.success(res.message || '已发起收费，凭证已上传，等待财务确认');
    createVisible.value = false;
    load();
  } catch (err: any) {
    ElMessage.error(err?.message || '发起收费失败');
  } finally {
    creating.value = false;
  }
}

/**
 * ★ 2026-10-19 已废弃 bindVoucher（「先建单、再绑凭证」的两步流）。
 *
 * 用户口径「只要缴费就要有凭证」→ 现在改成「先传凭证拿 url，再建单」，
 * 凭证随建单一起落库，不会再出现「单建了、凭证没绑上」的中间态。
 */

/* ============================================================
 * ★ 2026-10-20 补费（试学转正尾款 / 差额补收，金额自定义）
 *
 * 用户口径：「交了试学费的，后边在收款与缴费管理那儿操作里面
 *            添加一个补费功能，补费金额自定义。」
 *
 * 入口只挂在【试学费且已到账】那一行：还没交过试学费的学生不显示。
 * 金额默认带出「全款缺口」，老师可以改成实际收到的数（可能有优惠/只补一部分）。
 * ============================================================ */

const suppVisible = ref(false);
const suppRow = ref<ConsultFeeOrder | null>(null);
/** 全款缺口预览（调 /supplement-plan，失败不挡操作） */
const suppPlan = ref<ConsultSupplementPlan | null>(null);
const suppLoading = ref(false);
const suppSaving = ref(false);
const suppForm = ref({
  amountYuan: undefined as number | undefined,
  payMethod: '',
  remark: '试学转正补缴尾款',
  dataUrl: '',
  voucherNo: '',
});

/** 已缴试学费的行才给「补费」入口 */
function canSupplement(row: ConsultFeeOrder): boolean {
  return Number(row.feeType) === FeeType.TRIAL_FEE && row.status === ConsultFeeStatus.ARRIVED;
}

async function openSupplement(row: ConsultFeeOrder) {
  suppRow.value = row;
  suppPlan.value = null;
  suppForm.value = {
    amountYuan: undefined,
    payMethod: '',
    remark: '试学转正补缴尾款',
    dataUrl: '',
    voucherNo: '',
  };
  suppVisible.value = true;

  suppLoading.value = true;
  try {
    const plan = await fetchSupplementPlan(row.consultStudentId);
    suppPlan.value = plan;
    // 默认带出缺口，老师可改（缺口为 0 时留空，让他自己填）
    const gap = Number(plan.missingAmount || 0) / 100;
    if (gap > 0) suppForm.value.amountYuan = gap;
  } catch {
    // 预览失败不影响补费：金额由老师手填
  } finally {
    suppLoading.value = false;
  }
}

function onSuppFileChange(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    ElMessage.error('图片不能超过 5MB');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    suppForm.value.dataUrl = String(reader.result || '');
  };
  reader.readAsDataURL(file);
}

async function submitSupplement() {
  const row = suppRow.value;
  if (!row) return;

  const yuan = Number(suppForm.value.amountYuan);
  if (!Number.isFinite(yuan) || yuan <= 0) {
    ElMessage.warning('请填写补费金额（需大于 0）');
    return;
  }
  if (!suppForm.value.payMethod) {
    ElMessage.warning('请选择缴费方式');
    return;
  }
  if (!suppForm.value.dataUrl) {
    ElMessage.warning('请先上传缴费凭证截图');
    return;
  }

  suppSaving.value = true;
  try {
    // 先传图拿 url，再建单 —— 与「发起收费」同一顺序，凭证随单落库
    const up = await uploadFile(suppForm.value.dataUrl, 'voucher');
    const res = await createSupplementFee({
      consultStudentId: row.consultStudentId,
      amount: Math.round(yuan * 100),
      voucherUrl: up.url,
      voucherNo: suppForm.value.voucherNo || undefined,
      payMethod: suppForm.value.payMethod,
      remark: suppForm.value.remark || undefined,
    });

    ElMessage.success(res ? `补费 ¥${yuan.toFixed(2)} 已发起，等待财务确认到账` : '补费已发起');
    suppVisible.value = false;
    load();
  } catch (err: any) {
    ElMessage.error(err?.message || '发起补费失败');
  } finally {
    suppSaving.value = false;
  }
}

/* ---------- 上传凭证 ---------- */

/**
 * ★ 2026-10-15 一次缴清的多项费用在列表里是【一行】，但底下是 N 张单据。
 *    上传凭证 / 重新提交都要作用到这一行覆盖的全部单据上（一张截图挂多张单）。
 */
function orderIdsOf(row: ConsultFeeOrder): string[] {
  const ids = row.orderIds?.filter(Boolean) || [];
  return ids.length ? ids : [row.orderId];
}

/**
 * ★ 2026-10-15 用户口径：凭证只能在【发起收费】弹窗里上传。
 *    列表操作列、详情弹窗都不再提供独立的「上传凭证 / 重新上传」入口，
 *    相关的 voucherVisible / voucherForm / openVoucher / onFileChange / submitVoucher
 *    一并移除，避免出现「以为能在列表补传、其实入口不存在」的死胡同。
 *
 *    被驳回的单据如需换凭证：对该学生重新发起一次收费，在新弹窗里上传新截图。
 */

/* ---------- 重新提交 ---------- */
async function doResubmit(row: ConsultFeeOrder) {
  const ids = orderIdsOf(row);
  await ElMessageBox.confirm(
    ids.length > 1
      ? `确认重新提交单号 ${row.orderNo}（含 ${ids.length} 项费用）？提交后财务将重新核对。`
      : `确认重新提交单号 ${row.orderNo}？提交后财务将重新核对。`,
    '重新提交',
    { type: 'warning' },
  );
  for (const id of ids) {
    await resubmitOrder(id).catch(() => {});
  }
  ElMessage.success('已重新提交');
  load();
}

/* ---------- ★ 2026-10-19 作废（重复发起 / 发起错了） ---------- */
/**
 * 为什么要给老师这个入口：
 *   以前没有撤销通道，多发起一笔后只能再发起一次去「覆盖」，
 *   结果同一费用项堆出好几张单，账面像交了好几次钱。
 *
 * ⚠️ 整批作废：一张凭证可能覆盖多张单据（row.orderIds），只作废一张会留下半截。
 */
async function doCancel(row: ConsultFeeOrder) {
  const ids = orderIdsOf(row);
  try {
    await ElMessageBox.confirm(
      `确认作废单号 ${row.orderNo}（${row.feeTypeName} ¥${row.amountYuan}）？` +
        (ids.length > 1 ? `\n该行含 ${ids.length} 张单据，将整批作废。` : '') +
        `\n作废后财务侧同步撤销，不可恢复；如果这笔钱已经到账，请改走「退费」。`,
      '作废收款单',
      { type: 'warning', confirmButtonText: '确认作废', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  const res = await cancelFeeOrders(ids, '重复发起，人工作废');
  if (res.skipped?.length) {
    ElMessage.warning(
      `已作废 ${res.cancelled} 张；未作废：${res.skipped
        .map((s) => `${s.orderNo}（${s.reason}）`)
        .join('；')}`,
    );
  } else {
    ElMessage.success(`已作废 ${res.cancelled} 张单据`);
  }
  load();
}

/* ---------- 展示辅助 ---------- */
const fmtMoney = (cent?: number) => (cent == null ? '—' : `¥${(cent / 100).toFixed(2)}`);

const statusTag = (s: number) => {
  if (s === ConsultFeeStatus.ARRIVED) return 'success';
  if (s === ConsultFeeStatus.PENDING) return 'warning';
  if (s === ConsultFeeStatus.REJECTED) return 'danger';
  return 'info';
};

/**
 * ★ 2026-10-15 凭证直接在列表「缴费凭证」列以缩略图展示（点击放大），
 *    不再需要单独的看图弹窗 —— imgVisible / imgUrl / imgTitle / openVoucherImage 已移除。
 */

/* ---------- ★ 2026-10-15 收费单详情（操作列「查看」） ---------- */
/**
 * 缴费完成（已到账）后，老师主要想做的是「回看这一笔到底收了多少、凭证长啥样」，
 * 所以操作列统一给一个「查看」入口，弹出详情 + 缴费截图（点图可放大）。
 */
const detailVisible = ref(false);
const detailRow = ref<ConsultFeeOrder | null>(null);

function openDetail(row: ConsultFeeOrder) {
  detailRow.value = row;
  detailVisible.value = true;
}

/* ---------- ★ 2026-10-16 分期计划详情 ---------- */
const planVisible = ref(false);
const planLoading = ref(false);
const planRow = ref<ConsultInstallmentPlan | null>(null);

/** 从分期收款单打开所属计划 */
async function openPlan(row: ConsultFeeOrder) {
  if (!row.planId) return;
  planLoading.value = true;
  planVisible.value = true;
  try {
    planRow.value = await fetchInstallmentDetail(row.planId);
  } catch (err: any) {
    ElMessage.error(err?.message || '分期计划加载失败');
    planVisible.value = false;
  } finally {
    planLoading.value = false;
  }
}

/**
 * ★ 2026-10-16 用户口径：无论一次性还是分期，发起收款都要当场传凭证，
 *    传完状态直接「待确认（待财务确认）」。这里改成弹窗选图，不再只弹确认框。
 */
const stagePayVisible = ref(false);
const stagePaySubmitting = ref(false);
const stagePayItem = ref<ConsultInstallmentItem | null>(null);
const stagePayForm = ref({ dataUrl: '', voucherNo: '' });

function openPayStage(item: ConsultInstallmentItem) {
  if (!planRow.value) return;
  stagePayItem.value = item;
  stagePayForm.value = { dataUrl: '', voucherNo: '' };
  stagePayVisible.value = true;
}

function onStagePayFileChange(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    ElMessage.error('图片不能超过 5MB');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    stagePayForm.value.dataUrl = String(reader.result || '');
  };
  reader.readAsDataURL(file);
}

async function submitPayStage() {
  if (!planRow.value || !stagePayItem.value) return;
  if (!stagePayForm.value.dataUrl) {
    ElMessage.warning('请先上传缴费凭证截图');
    return;
  }
  stagePaySubmitting.value = true;
  try {
    const up = await uploadFile(stagePayForm.value.dataUrl, 'voucher');
    planRow.value = await payInstallmentStage({
      planId: planRow.value.planId,
      stageNo: stagePayItem.value.stageNo,
      voucherUrl: up.url,
      voucherNo: stagePayForm.value.voucherNo || undefined,
    });
    ElMessage.success(`第 ${stagePayItem.value.stageNo} 期收款单已发起，等待财务确认到账`);
    stagePayVisible.value = false;
    load();
  } catch (err: any) {
    ElMessage.error(err?.message || '发起失败');
  } finally {
    stagePaySubmitting.value = false;
  }
}

/** 期次状态 → Tag 类型 */
function stageTagType(item: ConsultInstallmentItem): string {
  if (item.status === 2) return 'success'; // 已到账
  if (item.status === 1) return 'warning'; // 待确认
  if (item.postponeCount) return 'warning'; // 顺延过（到期未缴自动后移）
  return 'info'; // 待缴
}

/**
 * ★ 2026-10-16 用户口径：分期单不再显示「待上传凭证」，
 *    但要在分期的操作处留一个「补缴凭证」入口 —— 分期是逐期发起收款的，
 *    历史单（或漏传的单据）如果一直没凭证，财务没法核对到账。
 */
const voucherVisible = ref(false);
const voucherSubmitting = ref(false);
const voucherTarget = ref<{
  orderId: string;
  /** 该行覆盖的全部单据（合并单可能不止一张） */
  orderIds?: string[];
  orderNo?: string;
  studentName: string;
  label: string;
} | null>(null);
const voucherForm = ref({ dataUrl: '', voucherNo: '' });

/** 从列表行打开（任何未到账、没凭证的单据） */
function openVoucher(row: ConsultFeeOrder) {
  if (!row.orderId) return;
  voucherTarget.value = {
    orderId: row.orderId,
    orderIds: orderIdsOf(row),
    orderNo: row.orderNo,
    studentName: row.studentName,
    label: row.stageText ? `${row.stageText} · ${row.feeTypeName}` : row.feeTypeName,
  };
  voucherForm.value = { dataUrl: '', voucherNo: '' };
  voucherVisible.value = true;
}

/** 从分期计划弹窗的期次行打开 */
function openVoucherForItem(item: ConsultInstallmentItem) {
  if (!item.feeOrderId || !planRow.value) return;
  voucherTarget.value = {
    orderId: item.feeOrderId,
    orderIds: [item.feeOrderId],
    orderNo: item.orderNo,
    studentName: planRow.value.studentName,
    label: `第 ${item.stageNo} 期应收 ¥${item.dueAmountYuan}`,
  };
  voucherForm.value = { dataUrl: '', voucherNo: '' };
  voucherVisible.value = true;
}

function onVoucherFileChange(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    ElMessage.error('图片不能超过 5MB');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    voucherForm.value.dataUrl = String(reader.result || '');
  };
  reader.readAsDataURL(file);
}

async function submitVoucher() {
  if (!voucherTarget.value) return;
  if (!voucherForm.value.dataUrl) {
    ElMessage.warning('请先上传缴费凭证截图');
    return;
  }
  voucherSubmitting.value = true;
  try {
    const up = await uploadFile(voucherForm.value.dataUrl, 'voucher');
    const ids = voucherTarget.value.orderIds?.length
      ? voucherTarget.value.orderIds
      : [voucherTarget.value.orderId];
    for (const id of ids) {
      await uploadVoucher(id, up.url, voucherForm.value.voucherNo || undefined);
    }
    ElMessage.success(`凭证已上传（${ids.length} 张单据），状态 → 待财务确认`);
    voucherVisible.value = false;
    if (planRow.value) {
      planRow.value = await fetchInstallmentDetail(planRow.value.planId);
    }
    load();
  } catch (err: any) {
    ElMessage.error(err?.message || '凭证上传失败');
  } finally {
    voucherSubmitting.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="page">
    <!-- 统计 -->
    <div v-if="stats" class="stats">
      <el-card shadow="never" class="stat">
        <div class="stat-label">收款单总数</div>
        <div class="stat-value">{{ stats.voucherCount + stats.pendingCount + stats.arrivedCount }}</div>
      </el-card>
      <el-card shadow="never" class="stat">
        <div class="stat-label">被驳回</div>
        <div class="stat-value warn">{{ stats.rejectedCount }}</div>
      </el-card>
      <el-card shadow="never" class="stat">
        <div class="stat-label">待财务确认</div>
        <div class="stat-value warn">{{ stats.pendingCount }}</div>
      </el-card>
      <el-card shadow="never" class="stat">
        <div class="stat-label">已到账金额</div>
        <div class="stat-value ok">{{ fmtMoney(stats.arrivedAmount) }}</div>
      </el-card>
    </div>

    <!-- 列表（单卡片通栏：条件行 + 工具条 + 表格 + 分页，与财务模块版式一致） -->
    <el-card shadow="never" class="table-card card-flush">
      <!-- 条件行 -->
      <div class="filter-row">
        <el-input
          v-model="query.keyword"
          placeholder="搜索学生姓名 / 咨询老师 / 班级 / 单号"
          clearable
          style="max-width: 280px"
          @keyup.enter="search"
          @clear="search"
        />
        <el-select v-model="query.feeType" placeholder="全部费用类型" clearable style="width: 150px">
          <el-option
            v-for="(name, val) in FEE_TYPE_NAME"
            :key="val"
            :value="Number(val)"
            :label="name"
          />
        </el-select>
        <el-select v-model="query.status" placeholder="全部状态" clearable style="width: 140px">
          <el-option
            v-for="(name, val) in CONSULT_FEE_STATUS_NAME"
            :key="val"
            :value="Number(val)"
            :label="name"
          />
        </el-select>
        <el-button type="primary" @click="search">查询</el-button>
        <el-button @click="resetQuery">重置</el-button>
      </div>

      <!-- 工具条：左主按钮，右统计 -->
      <div class="table-toolbar">
        <div class="tools">
          <el-button type="primary" @click="openCreate()">＋ 发起收费</el-button>
        </div>
        <div class="tools">
          <span class="stat-line">共 <b>{{ total }}</b> 条收费单 · 待财务确认 <b>{{ stats?.pendingCount ?? 0 }}</b> 笔</span>
        </div>
      </div>

      <el-table v-loading="loading" :data="list" stripe>
        <el-table-column label="学生" min-width="140">
          <template #default="{ row }">
            <div class="stu-name">{{ row.studentName }}</div>
            <div class="stu-sub">{{ row.className || '未分班' }}</div>
          </template>
        </el-table-column>

        <el-table-column prop="orderNo" label="单号" width="160" />

        <!-- ★ 2026-10-15 一次缴清的多项费用不再分多条列，只显示「包含哪些」 -->
        <el-table-column label="费用类型" min-width="170">
          <template #default="{ row }">
            <el-tag size="small">{{ row.feeTypeName }}</el-tag>
            <!-- 老的多单合并行 & 新的「一张合计单」都要显示包含哪些 -->
            <div v-if="row.included && row.included.length > 1" class="fee-included">
              含：{{ row.included.map((i: any) => i.feeTypeName).join('、') }}
            </div>
            <!-- ★ 2026-10-16 分期：标出这是第几期，点击可看整个分期计划 -->
            <el-tag
              v-if="row.stageText"
              size="small"
              type="warning"
              class="stage-tag"
              @click="openPlan(row)"
            >
              {{ row.stageText }}
            </el-tag>
          </template>
        </el-table-column>

        <el-table-column label="金额" width="130">
          <template #default="{ row }">
            {{ row.amountYuan }}
            <div v-if="row.stageText && row.totalDueAmountYuan" class="fee-included">
              整单应收 {{ row.totalDueAmountYuan }}
            </div>
          </template>
        </el-table-column>

        <el-table-column label="咨询侧状态" width="120">
          <template #default="{ row }">
            <el-tag size="small" :type="statusTag(row.status)">{{ row.statusName }}</el-tag>
          </template>
        </el-table-column>

        <el-table-column label="财务侧状态" width="110">
          <template #default="{ row }">
            <el-tag size="small" type="info">{{ row.financePayStatusName }}</el-tag>
          </template>
        </el-table-column>

        <!--
          ★ 2026-10-15 用户口径：这里的操作人 / 操作时间是【咨询侧发起收费】的那个人和时间，
            不是财务确认到账的人。财务核对人只在详情弹窗里看。
        -->
        <el-table-column label="操作人" width="110">
          <template #default="{ row }">
            <span v-if="row.createdByName">{{ row.createdByName }}</span>
            <span v-else class="stu-sub">—</span>
          </template>
        </el-table-column>

        <el-table-column label="操作时间" width="170">
          <template #default="{ row }">
            <span v-if="row.createTime">{{ row.createTime }}</span>
            <span v-else class="stu-sub">—</span>
          </template>
        </el-table-column>

        <!-- ★ 缴费凭证直接显示缩略图，点击放大 -->
        <el-table-column label="缴费凭证" width="110" align="center">
          <template #default="{ row }">
            <el-image
              v-if="row.voucherUrl"
              :src="row.voucherUrl"
              :preview-src-list="[row.voucherUrl]"
              fit="cover"
              :initial-index="0"
              class="voucher-thumb"
              preview-teleported
            >
              <template #error>
                <div class="thumb-fail" title="凭证文件缺失，请重新发起收费并上传">缺</div>
              </template>
            </el-image>
            <span v-else class="stu-sub">未上传</span>
          </template>
        </el-table-column>

        <el-table-column prop="lastAction" label="最近操作" min-width="200" show-overflow-tooltip />

        <el-table-column label="操作" width="370" fixed="right">
          <template #default="{ row }">
            <!-- ★ 2026-10-15 任何状态都能「查看」：详情里含缴费截图，点图可放大 -->
            <el-button link type="primary" @click="openDetail(row)">查看</el-button>
            <!--
              ★ 2026-10-20 补费（用户口径）：
                只对「已缴试学费」的行开放 —— 试学结束后补缴尾款 / 补差额，
                金额老师自定义。补费单单独记「补学费」，不占用学费额度。
            -->
            <el-button v-if="canSupplement(row)" link type="success" @click="openSupplement(row)">
              补费
            </el-button>
            <el-button
              v-if="row.status === ConsultFeeStatus.REJECTED"
              link
              type="warning"
              @click="doResubmit(row)"
            >
              重新提交
            </el-button>
            <!--
              ★ 2026-10-19 用户口径：「只要缴费就要有凭证」。
                任何还没有凭证的单据（含历史单、分期单，甚至已到账但漏图的），
                都必须留补传入口 —— 否则这张单的凭证永远打不开。
            -->
            <el-button
              v-if="!row.voucherUrl"
              link
              type="warning"
              @click="openVoucher(row)"
            >
              上传凭证
            </el-button>
            <!--
              ★ 2026-10-19 作废入口（重复发起 / 发起错了）：
                以前没有撤销通道，老师只能「再发起一次」去覆盖，
                结果同一费用项堆了好几张单 → 学生档案里出现两组一样的金额。
                已到账的不给作废（要走退费），所以这里按状态隐藏。
            -->
            <el-button
              v-if="row.status !== ConsultFeeStatus.ARRIVED"
              link
              type="danger"
              @click="doCancel(row)"
            >
              作废
            </el-button>
            <!--
              ★ 2026-10-15 用户口径：
                · 缴费完成之后操作是「查看」；
                · 「分班」不在这个页面 —— 已到账的学生去【学生管理】里分班；
                · 「上传凭证」也不在这里 —— 凭证只能在【发起收费】弹窗里上传
                  （驳回的单据如需换凭证，请对该学生重新发起一次收费并上传新截图）。
            -->
          </template>
        </el-table-column>
      </el-table>

      <div class="pager-bar">
        <span>共 {{ total }} 条记录，第 {{ page }}/{{ totalPages }} 页</span>
        <el-pagination
          v-model:current-page="page"
        v-model:page-size="size"
        :total="total"
        :page-sizes="[10, 20, 50]"
        layout="sizes, prev, pager, next"
        @current-change="load"
        @size-change="search"
        />
      </div>
    </el-card>

    <!-- ============ 发起收费 ============ -->
    <el-dialog v-model="createVisible" title="发起收费" width="640px">
      <el-alert type="info" :closable="false" show-icon class="mb">
        <template #title>
          金额由财务按「费用标准」自动取值，无需手动填写；
          选「正式学费」后可勾选多项，合计金额自动计算。
          <b>缴费凭证请在这里一并上传</b> —— 一次性收费建单后列表里没有补传入口；
          分期单如漏传，可在列表「操作」列或分期计划里点「补缴凭证」补上。
        </template>
      </el-alert>

      <el-form label-width="110px">
        <el-form-item label="学生姓名" required>
          <el-select
            v-model="createForm.consultStudentId"
            filterable
            remote
            clearable
            reserve-keyword
            :remote-method="searchStudents"
            :loading="studentSearching"
            placeholder="输入学生姓名搜索选择（全状态可选）"
            style="width: 100%"
          >
            <el-option
              v-for="s in studentOptions"
              :key="s.consultStudentId"
              :value="s.consultStudentId"
              :label="s.consultStateName ? `${s.studentName}（${s.consultStateName}）` : s.studentName"
            />
          </el-select>
        </el-form-item>

        <el-form-item label="收费类型" required>
          <el-radio-group v-model="createForm.category">
            <el-radio value="TRIAL">试学费</el-radio>
            <el-radio value="FORMAL">正式学费</el-radio>
          </el-radio-group>
        </el-form-item>

        <!-- 试学费：金额可自定义（默认取标准值，可直接改） -->
        <el-form-item v-if="createForm.category === 'TRIAL'" label="试学费金额" required>
          <el-input-number
            v-model="trialAmountInput"
            :min="0"
            :step="100"
            :precision="2"
            style="width: 200px"
          />
          <span class="fee-note">
            默认按财务标准取值（¥{{ amountYuan(FeeType.TRIAL_FEE, TRIAL_FEE_FALLBACK).toFixed(2) }}），
            实收金额不同可直接修改
          </span>
        </el-form-item>

        <!-- 正式学费：多选 + 自动算合计 -->
        <el-form-item v-if="createForm.category === 'FORMAL'" label="费用项目" required>
          <el-checkbox-group v-model="createForm.formalFeeTypes" class="fee-grid">
            <el-checkbox v-for="i in FORMAL_FEE_ITEMS" :key="i.feeType" :value="i.feeType">
              {{ i.label }}
              <b class="fee-amt">¥{{ amountYuan(i.feeType, i.fallback).toFixed(2) }}</b>
              <span v-if="i.calc" class="fee-calc">{{ i.calc }}</span>
            </el-checkbox>
          </el-checkbox-group>
          <div v-if="!createForm.formalFeeTypes.length" class="stu-sub mt8">
            勾选本次要缴的费用项，合计会自动计算
          </div>
        </el-form-item>

        <!-- ★ 2026-10-16 正式学费：应缴 / 实缴 / 优惠 -->
        <el-form-item v-if="createForm.category === 'FORMAL'" label="应缴金额">
          <b class="amount-strong">¥{{ formalDue.toFixed(2) }}</b>
          <span class="fee-note">按财务费用标准自动计算</span>
        </el-form-item>
        <el-form-item v-if="createForm.category === 'FORMAL'" label="实缴金额" required>
          <el-input-number
            v-model="formalPaidInput"
            :min="0"
            :max="formalDue > 0 ? formalDue : Infinity"
            :step="100"
            :precision="2"
            style="width: 200px"
          />
          <span class="fee-note">学生实际交的钱，不能大于应缴金额</span>
        </el-form-item>
        <el-form-item v-if="createForm.category === 'FORMAL'" label="优惠金额">
          <b :class="formalDiscount > 0 ? 'discount-strong' : 'amount-strong'">
            ¥{{ formalDiscount.toFixed(2) }}
          </b>
          <span class="fee-note">
            {{ formalDiscount > 0 ? '优惠（应缴 - 实缴）' : '无优惠' }}
          </span>
        </el-form-item>

        <el-form-item label="合计金额">
          <b class="amount-strong">¥{{ createTotal.toFixed(2) }}</b>
          <span v-if="createForm.category === 'FORMAL'" class="fee-note">本次实际收取（= 实缴）</span>
        </el-form-item>

        <!-- ★ 2026-10-16 收款方式：一次性 / 分期 -->
        <el-form-item label="收款方式" required>
          <el-radio-group v-model="payMode">
            <el-radio value="ONCE">一次性缴清</el-radio>
            <el-radio value="INSTALLMENT">分期付款</el-radio>
          </el-radio-group>
          <span v-if="payMode === 'INSTALLMENT'" class="fee-note">
            首付（第 1 期）到账即可分班，尾款挂在待缴余额里继续收
          </span>
        </el-form-item>

        <!-- 分期：期数 + 每期金额与到期日 -->
        <el-form-item v-if="payMode === 'INSTALLMENT'" label="分期计划" required>
          <div class="stage-box">
            <div class="stage-head">
              <span>分</span>
              <el-input-number
                v-model="stageCount"
                :min="2"
                :max="12"
                :step="1"
                size="small"
                style="width: 110px"
              />
              <span>期</span>
              <el-button link type="primary" @click="splitEvenly">重新平均分配</el-button>
              <span class="stage-sum">
                合计 ¥{{ stagesSum.toFixed(2) }}
                <b v-if="Math.abs(stagesDiff) > 0.001" class="extra-strong">
                  （差 ¥{{ stagesDiff.toFixed(2) }}，需与实缴一致）
                </b>
                <b v-else class="discount-strong">✓ 与实缴一致</b>
              </span>
            </div>

            <el-table :data="stages" size="small" border max-height="240">
              <el-table-column label="期次" width="70" align="center">
                <template #default="{ row }">第 {{ row.stageNo }} 期</template>
              </el-table-column>
              <el-table-column label="本期金额（元）" min-width="130">
                <template #default="{ row }">
                  <el-input-number
                    v-model="row.amount"
                    :min="0"
                    :step="100"
                    :precision="2"
                    :controls="false"
                    size="small"
                    style="width: 100%"
                  />
                </template>
              </el-table-column>
              <el-table-column label="到期日" min-width="150">
                <template #default="{ row }">
                  <el-date-picker
                    v-model="row.dueDate"
                    type="date"
                    value-format="YYYY-MM-DD"
                    placeholder="选择到期日"
                    size="small"
                    style="width: 100%"
                  />
                </template>
              </el-table-column>
            </el-table>

            <div class="stu-sub mt8">
              各期金额之和必须等于实缴金额 ¥{{ Number(createTotal).toFixed(2) }}；
              除不尽的零头会自动落在最后一期。到期日只用于提醒，过了不会自动改状态。
            </div>
          </div>
        </el-form-item>

        <el-form-item label="缴费方式" required>
          <el-select
            v-model="createForm.payMethod"
            placeholder="请选择缴费方式"
            style="width: 100%"
          >
            <el-option v-for="m in PAY_METHODS" :key="m" :label="m" :value="m" />
          </el-select>
        </el-form-item>

        <!--
          ★ 2026-10-15：凭证就在这里上传，建完单自动绑到新单据上。
          ★ 必填 —— 列表与详情都已不再提供补传入口，不在这里传就永远传不了。
        -->
        <el-form-item label="缴费凭证" required>
          <input type="file" accept="image/*" @change="onCreateFileChange" />
          <div class="stu-sub mt8">
            必填。一张转账截图可以覆盖本次勾选的多项费用（不超过 5MB）
          </div>
          <div v-if="createForm.dataUrl" class="preview">
            <img :src="createForm.dataUrl" alt="凭证预览" />
          </div>
        </el-form-item>

        <el-form-item label="转账单号">
          <el-input v-model="createForm.voucherNo" placeholder="如微信/支付宝交易单号（选填）" />
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="creating" @click="submitCreate">确认发起</el-button>
      </template>
    </el-dialog>

    <!-- ============ ★ 2026-10-20 补费（试学转正尾款 / 差额补收，金额自定义） ============ -->
    <el-dialog v-model="suppVisible" title="补费" width="620px">
      <el-alert type="success" :closable="false" show-icon class="mb">
        <template #title>
          补费金额<strong>由老师自定义</strong>（按实际收到的钱填，可含优惠）。
          补费单在列表里单独显示为「补学费」，不占用学费额度；
          财务确认到账后，试学中的学员会自动转为正式在读。
        </template>
      </el-alert>

      <el-descriptions v-if="suppRow" :column="2" border size="small" class="mb">
        <el-descriptions-item label="学生">{{ suppRow.studentName }}</el-descriptions-item>
        <el-descriptions-item label="班级">{{ suppRow.className || '未分班' }}</el-descriptions-item>
        <el-descriptions-item label="已缴试学费">¥{{ suppRow.amountYuan }}</el-descriptions-item>
        <el-descriptions-item label="试学费单号">{{ suppRow.orderNo }}</el-descriptions-item>
        <template v-if="suppPlan">
          <el-descriptions-item label="全款应缴">
            ¥{{ (suppPlan.totalAmount / 100).toFixed(2) }}
          </el-descriptions-item>
          <el-descriptions-item label="全款已到账">
            ¥{{ (suppPlan.arrivedAmount / 100).toFixed(2) }}
          </el-descriptions-item>
          <el-descriptions-item label="还差（参考）" :span="2">
            <b class="amount-strong">¥{{ (suppPlan.missingAmount / 100).toFixed(2) }}</b>
            <span v-if="suppPlan.missing.length" class="fee-note">
              （{{ suppPlan.missing.map((t: number) => FEE_TYPE_NAME[t] || t).join('、') }}）
            </span>
            <span v-if="suppPlan.inFlightAmount" class="fee-note">
              另有 ¥{{ (suppPlan.inFlightAmount / 100).toFixed(2) }} 在途，等财务确认
            </span>
          </el-descriptions-item>
        </template>
      </el-descriptions>
      <div v-if="suppPlan" class="stu-sub" style="margin: -4px 0 12px">
        全款 = 学费 + 住宿费 + 餐费 + 保险费；试学费单独收取、不抵扣全款。
      </div>

      <el-form v-loading="suppLoading" label-width="120px">
        <el-form-item label="补费金额（元）" required>
          <el-input-number
            v-model="suppForm.amountYuan"
            :min="0"
            :precision="2"
            :step="100"
            placeholder="自定义填写"
            style="width: 220px"
          />
          <span class="fee-note" style="margin-left: 8px">
            必填，可改（默认已带出缺口，可少于缺口）
          </span>
        </el-form-item>

        <el-form-item label="补费说明">
          <el-input
            v-model="suppForm.remark"
            maxlength="200"
            placeholder="如：试学转正补缴尾款 / 补差价"
          />
        </el-form-item>

        <el-form-item label="缴费方式" required>
          <el-select v-model="suppForm.payMethod" placeholder="请选择缴费方式" style="width: 100%">
            <el-option v-for="m in PAY_METHODS" :key="m" :label="m" :value="m" />
          </el-select>
        </el-form-item>

        <el-form-item label="缴费凭证" required>
          <input type="file" accept="image/*" @change="onSuppFileChange" />
          <div class="stu-sub mt8">必填，不超过 5MB。凭证随补费单一起落库，财务按它核对到账</div>
          <div v-if="suppForm.dataUrl" class="preview">
            <img :src="suppForm.dataUrl" alt="凭证预览" />
          </div>
        </el-form-item>

        <el-form-item label="转账单号">
          <el-input v-model="suppForm.voucherNo" placeholder="如微信/支付宝交易单号（选填）" />
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="suppVisible = false">取消</el-button>
        <el-button type="primary" :loading="suppSaving" @click="submitSupplement">确认补费</el-button>
      </template>
    </el-dialog>

    <!-- ============ ★ 2026-10-15 收费单详情（操作列「查看」） ============ -->
    <el-dialog v-model="detailVisible" title="收费单详情" width="720px">
      <el-descriptions v-if="detailRow" :column="2" border>
        <el-descriptions-item label="学生">
          {{ detailRow.studentName }}
          <span v-if="detailRow.consultStateName" class="stu-sub">（{{ detailRow.consultStateName }}）</span>
        </el-descriptions-item>
        <el-descriptions-item label="单号">{{ detailRow.orderNo }}</el-descriptions-item>

        <el-descriptions-item label="费用类型">{{ detailRow.feeTypeName }}</el-descriptions-item>
        <!-- ★ 2026-10-16 实缴 = 单据金额；有明细时额外展示应缴与优惠 -->
        <el-descriptions-item label="实缴金额">
          <b class="amount-strong">{{ detailRow.amountYuan }}</b>
        </el-descriptions-item>
        <el-descriptions-item v-if="detailRow.dueAmount != null" label="应缴金额">
          ¥{{ (detailRow.dueAmount / 100).toFixed(2) }}
        </el-descriptions-item>
        <el-descriptions-item v-if="detailRow.dueAmount != null" label="优惠金额">
          <b :class="(detailRow.discountAmount || 0) > 0 ? 'discount-strong' : 'amount-strong'">
            ¥{{ (Math.abs(detailRow.discountAmount || 0) / 100).toFixed(2) }}
          </b>
          <span class="fee-note">
            {{ (detailRow.discountAmount || 0) > 0 ? '优惠' : (detailRow.discountAmount || 0) < 0 ? '补收' : '无优惠' }}
          </span>
        </el-descriptions-item>

        <el-descriptions-item label="缴费方式">{{ detailRow.payMethod || '—' }}</el-descriptions-item>
        <el-descriptions-item label="转账单号">{{ detailRow.voucherNo || '—' }}</el-descriptions-item>

        <el-descriptions-item label="咨询侧状态">
          <el-tag size="small" :type="statusTag(detailRow.status)">{{ detailRow.statusName }}</el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="财务侧状态">
          <el-tag size="small" type="info">{{ detailRow.financePayStatusName || '—' }}</el-tag>
        </el-descriptions-item>

        <el-descriptions-item label="班级">{{ detailRow.className || '未分班' }}</el-descriptions-item>
        <!-- 咨询侧：发起收费的人与时间（列表「操作人 / 操作时间」列取的就是这两个） -->
        <el-descriptions-item label="操作人">{{ detailRow.createdByName }}</el-descriptions-item>

        <el-descriptions-item label="操作时间">{{ detailRow.createTime }}</el-descriptions-item>
        <el-descriptions-item label="财务确认时间">{{ detailRow.paidTime || '—' }}</el-descriptions-item>

        <el-descriptions-item label="财务确认人" :span="2">
          {{ detailRow.paidByName || '—（财务尚未确认到账）' }}
        </el-descriptions-item>
        <el-descriptions-item v-if="detailRow.rejectReason" label="驳回原因" :span="2">
          <span class="danger-text">{{ detailRow.rejectReason }}</span>
        </el-descriptions-item>
        <el-descriptions-item label="最近操作" :span="2">{{ detailRow.lastAction || '—' }}</el-descriptions-item>
      </el-descriptions>

      <!-- ★ 一次缴清的多项费用：详情里把「包含哪些」逐项列出来 -->
      <div v-if="detailRow?.included?.length" class="mt">
        <div class="detail-label">
          本次包含费用（{{ detailRow.included.length }} 项，合计 {{ detailRow.amountYuan }}）
        </div>
        <el-table :data="detailRow.included" size="small" border>
          <el-table-column prop="feeTypeName" label="费用项" />
          <el-table-column prop="amountYuan" label="金额" width="120" />
          <el-table-column prop="statusName" label="状态" width="120" />
        </el-table>
      </div>

      <div v-if="detailRow" class="mt">
        <div class="detail-label">缴费截图</div>
        <div v-if="detailRow.voucherUrl" class="img-box img-box-col">
          <el-image
            :src="detailRow.voucherUrl"
            :preview-src-list="[detailRow.voucherUrl]"
            fit="contain"
            :initial-index="0"
          >
            <template #error>
              <div class="img-fail">
                凭证文件缺失（服务器上已找不到这张图）。
                <br />
                请对该学生重新发起一次收费并上传新截图。
              </div>
            </template>
          </el-image>
          <div class="stu-sub mt8">点击图片可放大查看</div>
        </div>
        <span v-else class="stu-sub">该单据暂未上传缴费截图</span>
      </div>

      <!--
        ★ 2026-10-15：这里不再放「上传凭证」按钮。
        凭证只在【发起收费】弹窗里上传，详情只负责查看。
      -->
      <template #footer>
        <el-button @click="detailVisible = false">关闭</el-button>
        <el-button v-if="detailRow?.planId" type="primary" @click="openPlan(detailRow)">
          查看分期计划
        </el-button>
      </template>
    </el-dialog>

    <!-- ============ ★ 2026-10-16 分期计划详情 ============ -->
    <el-dialog v-model="planVisible" title="分期计划" width="780px">
      <div v-loading="planLoading">
        <template v-if="planRow">
          <el-descriptions :column="4" border class="mb">
            <el-descriptions-item label="计划号">{{ planRow.planNo }}</el-descriptions-item>
            <el-descriptions-item label="学生">{{ planRow.studentName }}</el-descriptions-item>
            <el-descriptions-item label="状态">
              <el-tag size="small" :type="planRow.status === 2 ? 'success' : planRow.status === 3 ? 'info' : 'warning'">
                {{ planRow.statusName }}
              </el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="期数">
              {{ planRow.paidStages }} / {{ planRow.stageCount }} 期已结清
            </el-descriptions-item>

            <el-descriptions-item label="应收">
              <b class="amount-strong">¥{{ planRow.totalAmountYuan }}</b>
            </el-descriptions-item>
            <el-descriptions-item label="已缴">
              <b class="discount-strong">¥{{ planRow.paidAmountYuan }}</b>
            </el-descriptions-item>
            <el-descriptions-item label="优惠">
              ¥{{ planRow.discountAmountYuan }}
            </el-descriptions-item>
            <el-descriptions-item label="待缴">
              <b :class="planRow.pendingAmount > 0 ? 'extra-strong' : 'amount-strong'">
                ¥{{ planRow.pendingAmountYuan }}
              </b>
            </el-descriptions-item>
          </el-descriptions>

          <div class="detail-label">期次明细</div>
          <el-table :data="planRow.items" size="small" border>
            <el-table-column label="期次" width="70" align="center">
              <template #default="{ row }">第 {{ row.stageNo }} 期</template>
            </el-table-column>
            <el-table-column label="本期应收" width="110">
              <template #default="{ row }">¥{{ row.dueAmountYuan }}</template>
            </el-table-column>
            <el-table-column label="到期日" width="120">
              <template #default="{ row }">
                {{ row.dueDate || '—' }}
                <div v-if="row.postponeCount" class="stage-postpone">
                  已顺延{{ row.postponeCount }}次
                </div>
              </template>
            </el-table-column>
            <el-table-column label="状态" width="110">
              <template #default="{ row }">
                <el-tag size="small" :type="stageTagType(row)">
                  {{ row.overdue ? '已逾期' : row.statusName }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="关联单号" min-width="140">
              <template #default="{ row }">{{ row.orderNo || '—' }}</template>
            </el-table-column>
            <el-table-column label="到账时间" width="170">
              <template #default="{ row }">{{ row.payTime || '—' }}</template>
            </el-table-column>
            <el-table-column label="操作" width="168" fixed="right">
              <template #default="{ row }">
                <el-button
                  v-if="row.status === 0 || row.status === 3"
                  link
                  type="primary"
                  @click="openPayStage(row)"
                >
                  发起收款
                </el-button>
                <!--
                  ★ 2026-10-19 已发起收款但没绑凭证的期次：留补缴凭证入口。
                    已到账但漏图的期次（历史数据）也要能补，否则凭证列永远是空的。
                -->
                <el-button
                  v-if="row.feeOrderId && !row.voucherUrl"
                  link
                  type="warning"
                  @click="openVoucherForItem(row)"
                >
                  {{ row.status === 1 ? '补缴凭证' : '补凭证' }}
                </el-button>
                <span v-if="!row.feeOrderId && row.status !== 0 && row.status !== 3" class="stu-sub">
                  —
                </span>
              </template>
            </el-table-column>
          </el-table>

          <div v-if="planRow.itemDetail?.length" class="mt">
            <div class="detail-label">本次包含费用</div>
            <el-table :data="planRow.itemDetail" size="small" border>
              <el-table-column prop="feeTypeName" label="费用项" />
              <el-table-column label="应缴" width="110">
                <template #default="{ row }">
                  ¥{{ ((row.standardAmount ?? row.amount) / 100).toFixed(2) }}
                </template>
              </el-table-column>
              <el-table-column label="实缴" width="110">
                <template #default="{ row }">¥{{ (row.amount / 100).toFixed(2) }}</template>
              </el-table-column>
              <el-table-column label="优惠" width="110">
                <template #default="{ row }">
                  ¥{{ ((row.discount ?? 0) / 100).toFixed(2) }}
                </template>
              </el-table-column>
            </el-table>
          </div>

          <el-alert
            v-if="planRow.pendingAmount > 0"
            type="warning"
            :closable="false"
            show-icon
            class="mt"
          >
            <template #title>
              该学生尚有尾款 ¥{{ planRow.pendingAmountYuan }} 未缴清（首付到账即可分班，尾款继续催收）。
              待缴归零后计划自动变为「已完成」。
            </template>
          </el-alert>
        </template>
      </div>

      <template #footer>
        <el-button @click="planVisible = false">关闭</el-button>
      </template>
    </el-dialog>

    <!-- ★ 2026-10-16 发起分期收款（必须当场传凭证 → 待财务确认） -->
    <el-dialog v-model="stagePayVisible" title="发起分期收款" width="480px">
      <el-descriptions v-if="stagePayItem" :column="2" size="small" border class="mb">
        <el-descriptions-item label="期次">第 {{ stagePayItem.stageNo }} 期</el-descriptions-item>
        <el-descriptions-item label="本期应收">¥{{ stagePayItem.dueAmountYuan }}</el-descriptions-item>
      </el-descriptions>
      <el-form label-width="96px">
        <el-form-item label="缴费凭证" required>
          <div>
            <input type="file" accept="image/*" @change="onStagePayFileChange" />
            <div v-if="stagePayForm.dataUrl" class="preview">
              <img :src="stagePayForm.dataUrl" alt="凭证预览" />
            </div>
            <div class="fee-note">上传转账成功截图，财务将凭此核对到账</div>
          </div>
        </el-form-item>
        <el-form-item label="转账单号">
          <el-input v-model="stagePayForm.voucherNo" placeholder="如微信/支付宝交易单号（选填）" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="stagePayVisible = false">取消</el-button>
        <el-button type="primary" :loading="stagePaySubmitting" @click="submitPayStage">
          发起收款
        </el-button>
      </template>
    </el-dialog>

    <!-- ★ 2026-10-19 上传缴费凭证（历史单 / 漏传的单据补张截图） -->
    <el-dialog v-model="voucherVisible" title="上传缴费凭证" width="480px">
      <el-descriptions v-if="voucherTarget" :column="1" size="small" border class="mb">
        <el-descriptions-item label="学生">{{ voucherTarget.studentName }}</el-descriptions-item>
        <el-descriptions-item label="单据">
          {{ voucherTarget.orderNo || '—' }}<span class="stu-sub"> （{{ voucherTarget.label }}）</span>
        </el-descriptions-item>
      </el-descriptions>
      <el-form label-width="96px">
        <el-form-item label="缴费凭证" required>
          <div>
            <input type="file" accept="image/*" @change="onVoucherFileChange" />
            <div v-if="voucherForm.dataUrl" class="preview">
              <img :src="voucherForm.dataUrl" alt="凭证预览" />
            </div>
            <div class="fee-note">上传转账成功截图，补缴后状态变为「待财务确认」</div>
          </div>
        </el-form-item>
        <el-form-item label="转账单号">
          <el-input v-model="voucherForm.voucherNo" placeholder="如微信/支付宝交易单号（选填）" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="voucherVisible = false">取消</el-button>
        <el-button type="primary" :loading="voucherSubmitting" @click="submitVoucher">
          提交凭证
        </el-button>
      </template>
    </el-dialog>

    <!--
      ★ 2026-10-15：凭证已直接在列表里以缩略图展示（点击即放大），
        独立的「查看缴费截图」弹窗随之移除。
    -->

    <!--
      ★ 2026-10-15：独立的「上传缴费截图」弹窗已移除。
      用户口径「上传凭证只能在发起收费那里上传」——
      凭证统一在【发起收费】弹窗里选图，建单时一次性绑定。
    -->

    <!--
      ★ 2026-10-15：分班弹窗已从这里移除。
      用户口径「缴费完成之后学生管理那里分班，分班不能在收款与缴费那里」——
      分班统一去【学生管理】操作。
    -->
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}

.stat {
  text-align: center;
}

.stat-label {
  font-size: 12px;
  color: #A2938E;
}

.stat-value {
  font-size: 20px;
  font-weight: 700;
  margin-top: 4px;
  color: #443432;
}

.stat-value.ok {
  color: #5FA36F;
}

.stat-value.warn {
  color: #C9852E;
}

.toolbar-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.spacer {
  flex: 1;
}

.table-card {
  flex: 1;
}

.stu-name {
  font-weight: 600;
  color: #443432;
}

.stu-sub {
  font-size: 12px;
  color: #A2938E;
}

.std-preview {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
}

.std-item {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}

.voucher-info {
  display: flex;
  gap: 20px;
  padding: 10px 12px;
  background: #F6F3EF;
  border-radius: 6px;
  font-size: 13px;
}

.preview {
  margin-top: 8px;
}

.preview img {
  max-width: 220px;
  max-height: 220px;
  border: 1px solid #DCD2CB;
  border-radius: 6px;
}

.mb {
  margin-bottom: 12px;
}

.mt {
  margin-top: 12px;
}

.mt8 {
  margin-top: 8px;
}

/* ---- 正式学费：费用项目多选区 ---- */
.fee-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 6px 12px;
  width: 100%;
}

.fee-amt {
  margin-left: 4px;
  color: #e6a23c;
  font-weight: 600;
}

.fee-calc {
  margin-left: 4px;
  font-size: 12px;
  color: #909399;
}

/* 合计金额：口径上属于「要收多少钱」，用醒目样式区分只读预览值 */
.amount-strong {
  font-size: 20px;
  color: #f56c6c;
  font-weight: 700;
}

/* ★ 2026-10-16 优惠金额：绿色（省钱），补收用橙色区分 */
.discount-strong {
  font-size: 20px;
  color: #67c23a;
  font-weight: 700;
}

.extra-strong {
  font-size: 20px;
  color: #e6a23c;
  font-weight: 700;
}

/* ---------- ★ 2026-10-16 分期计划编辑区 ---------- */
.stage-box {
  width: 100%;
  border: 1px solid var(--el-border-color-lighter, #ebeef5);
  border-radius: 8px;
  padding: 10px;
  background: var(--el-fill-color-lighter, #fafafa);
}

.stage-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 10px;
  font-size: 13px;
}

.stage-sum {
  margin-left: auto;
  font-size: 13px;
  color: var(--el-text-color-secondary, #909399);
}

/* 期次到期日下方的「已顺延N次」小字 */
.stage-postpone {
  font-size: 11px;
  color: #c9852e;
  margin-top: 2px;
}

/* 列表里的「第 X 期 / 共 N 期」标签：可点，鼠标给手型提示 */
.stage-tag {
  cursor: pointer;
  margin-top: 2px;
}

/* ---- 凭证截图弹窗 ---- */
.img-box {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 220px;
}

/* 详情弹窗里：图在上、提示文字在下 */
.img-box.img-box-col {
  flex-direction: column;
  gap: 8px;
}

.img-box :deep(.el-image),
.img-box :deep(img) {
  max-width: 100%;
  max-height: 66vh;
  border: 1px solid #dcdfe6;
  border-radius: 6px;
}

/* ---- 试学费金额可自定义：输入框旁的小字说明 ---- */
.fee-note {
  margin-left: 10px;
  font-size: 12px;
  color: #909399;
}

/* ---- 合并行：费用类型下方的「含：学费、住宿费…」 ---- */
.fee-included {
  margin-top: 2px;
  font-size: 12px;
  color: #909399;
  line-height: 1.4;
}

/* ---- 列表里的缴费凭证缩略图（点击放大） ---- */
.voucher-thumb {
  width: 48px;
  height: 48px;
  border: 1px solid #dcdfe6;
  border-radius: 4px;
  cursor: pointer;
  vertical-align: middle;
}

/* 凭证文件在服务器上已不存在时的兜底（历史演示数据常见） */
.thumb-fail {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  font-size: 12px;
  color: #c0c4cc;
  background: #f5f7fa;
  border: 1px dashed #dcdfe6;
  border-radius: 4px;
}

.img-fail {
  padding: 24px;
  font-size: 13px;
  color: #909399;
  text-align: center;
  background: #f5f7fa;
  border: 1px dashed #dcdfe6;
  border-radius: 6px;
}

/* ---- 收费单详情 ---- */
.detail-label {
  margin-bottom: 8px;
  font-size: 13px;
  font-weight: 600;
  color: #303133;
}

.danger-text {
  color: #f56c6c;
}
</style>
