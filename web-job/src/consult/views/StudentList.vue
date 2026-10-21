<script setup lang="ts">
/**
 * 学生管理
 *
 * 功能：
 *   - 列表 + 搜索 + 状态筛选
 *   - 新建学生
 *   - 详情抽屉（档案 / 跟进历史 / 缴费单 / 退费单）
 *   - 按状态显示可执行动作：分配(经理) / 领取 / 面试 / 分班 / 入班 / 转正式 / 流失
 */

import { ref, onMounted, computed } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { InfoFilled } from '@element-plus/icons-vue';
import type {
  ConsultStudentListItem,
  ConsultStudent,
  ConsultState,
  ConsultSupplementPlan,
  FormalPayMode,
  // ★ 2026-10-16 分期付款
  ConsultStudentLedger,
  // ★ 2026-10-16 缴费单：总金额 + 包含的费用项
  ConsultStudentFeeGroup,
} from 'shared-types/consult';
import {
  CONSULT_STATE_NAME,
  ConsultState as CS,
  DEPT_NAME,
  DEPT_OPTIONS,
  FEE_TYPE_NAME,
  FeeType,
  FormalPayMode as FPM,
} from 'shared-types/consult';
import {
  fetchStudentList,
  fetchStudentDetail,
  addStudent,
  updateStudentExtra,
  assignOwner,
  claimStudent,
  recordLoss,
  fetchConsultants,
  toFormal,
  fetchSupplementPlan,
  submitInterviewResult as submitInterviewResultApi,
  cancelNotEnrolled,
  enrollToClass as enrollToClassApi,
  fetchOpenClasses,
  fetchAssignStatus,
  // ★ 2026-10-16 分期付款账本
  fetchStudentLedger,
  // ★ 2026-10-19 作废收款单（档案里发现重复批次时直接收拾）
  cancelFeeOrders,
  // ★ 2026-10-19 转正式必须带缴费凭证
  uploadFile,
  uploadVoucher,
  type AssignStatusItem,
  type OpenClassItem,
} from '@/consult/api/consult';
import { useAuthStore } from '@/consult/stores/auth';

const auth = useAuthStore();

/* ---------- 列表 ---------- */
const loading = ref(false);
const list = ref<ConsultStudentListItem[]>([]);
const total = ref(0);

/** 分页总页数（原型 pager 里的「第 N/M 页」） */
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / (size.value || 20))));
const page = ref(1);
const size = ref(10);

const query = ref({
  keyword: '',
  consultState: undefined as number | undefined,
  deptCode: undefined as number | undefined,
});

/**
 * 状态筛选按钮 —— ★ 2026-10-14 用户指令：只保留学生主线状态
 *   待分配 → 待面试 → 咨询中 → 待分班 → 试学中 → 正式在读
 *
 * ★ 2026-10-15 用户指令：补上「咨询中」（缴费阶段）——
 *   面试通过并确认报名后即进入本状态；「没缴费」或「已缴费但财务还没确认」
 *   都算咨询中，财务确认到账后 → 待分班。交完费（试学费到账）才能分班进试学。
 *
 * ★ 2026-10-15 用户指令：补上「流失」——
 *   财务完成退费打款后，学生状态自动流转为「流失」
 *   （流失原因 = 发起退款时填写的流失原因），所以筛选里也要能看到流失名单。
 *
 * 涉及退费中间态（退费待审批×2、已退费）与「未通过」不作为筛选入口，
 * 列表数据与状态机不受影响。
 * ⚠️ FULL_FEE_PENDING（试学中·转正式补缴待确认）不并入「咨询中」：
 *    此时学生已分班在试学，归入咨询中会误导。
 */
const STUDENT_STATE_WHITELIST: ConsultState[] = [
  CS.WAIT_ASSIGN, // 待分配
  CS.WAIT_INTERVIEW, // 待面试
  CS.TRIAL_FEE_PENDING, // 咨询中（缴费阶段：未缴费 / 缴费待财务确认）
  CS.TRIAL_WAIT_CLASS, // 待分班（费用已到账）
  CS.TRIAL, // 试学中
  CS.FORMAL, // 正式在读
  CS.LOST, // 流失（含财务退款后自动流转）
];

const stateOptions = computed(() =>
  Object.entries(CONSULT_STATE_NAME)
    .map(([k, v]) => ({ value: Number(k), label: v }))
    .filter((s) => STUDENT_STATE_WHITELIST.includes(s.value as ConsultState)),
);

async function load() {
  loading.value = true;
  try {
    const res = await fetchStudentList({
      page: page.value,
      size: size.value,
      keyword: query.value.keyword || undefined,
      consultState: query.value.consultState,
      deptCode: query.value.deptCode,
    });
    list.value = res.list;
    total.value = res.total;
    // 拉取「分配班级」权威状态，用于禁用已入班的「分配班级」按钮
    await loadAssignStatus();
  } finally {
    loading.value = false;
  }
}

function search() {
  page.value = 1;
  load();
}

function resetQuery() {
  query.value = { keyword: '', consultState: undefined, deptCode: undefined };
  page.value = 1;
  load();
}

/* ---------- 详情 ---------- */
const detailVisible = ref(false);
const detail = ref<ConsultStudent | null>(null);
const detailLoading = ref(false);

/**
 * ★ 2026-10-16 缴费账本（应收 / 已收 / 优惠 / 待缴）
 *
 * 只有分期付款的学生才有账本；一次性缴清的学生 plans 为空、金额全为 0，
 * 这时抽屉里不显示这一块，避免"全是 0"的空表格干扰阅读。
 */
const ledger = ref<ConsultStudentLedger | null>(null);

/**
 * ★ 2026-10-16 用户口径：缴费单只显示【总金额】一行，凭证挂在总金额上；
 *    总金额下面（子行）列出它包含的费用项 —— 用树表 default-expand-all 实现。
 *    一项的时候不开子行，避免重复显示同一笔。
 */
const feeRows = computed(() => {
  const list = (detail.value?.fees || []) as ConsultStudentFeeGroup[];
  return list.map((g) => ({
    ...g,
    rowKey: g.orderId,
    children:
      (g.included?.length || 0) > 1
        ? g.included.map((it, i) => ({
            ...it,
            rowKey: `${g.orderId}-${i}`,
            orderNo: '',
            /**
             * ★ 2026-10-19 子项共享主单的凭证。
             *    用户口径「缴费单后边的凭证都要有凭证」——
             *    明细行也是这笔钱的一部分，凭证列不该出现「—」。
             */
            voucherUrl: g.voucherUrl,
            // 子行也带上主单 id / 姓名，缺凭证时子行同样能补传
            orderId: g.orderId,
            studentName: detail.value?.studentName,
            createTime: '',
            isChild: true,
          }))
        : undefined,
  }));
});

/** 缴费单状态 → Tag 类型 */
function feeTagType(status: number): string {
  if (status === 2) return 'success'; // 已到账
  if (status === 1) return 'warning'; // 待财务确认
  if (status === 3) return 'danger'; // 已驳回
  return 'info'; // 待上传凭证
}

/**
 * ★ 2026-10-19 「同一个费用项被收了两遍」的行
 *
 * 用户反馈：学生档案里出现两组一模一样的 ¥32,400，像是交了好几次钱。
 * 根因是同一批费用被发起过两轮（老批次按类型 6 张单 + 后来一张合计单），
 * 后端会标 duplicated=true，这里据此给出显式提示 + 作废入口。
 */
const dupFeeRows = computed(() => feeRows.value.filter((r) => r.duplicated));

/** 重复的费用项名称（提示文案用） */
const dupTypesText = computed(() => {
  const names = new Set<string>();
  for (const r of dupFeeRows.value) for (const t of r.duplicatedTypes || []) names.add(t);
  return [...names].join('、');
});

/**
 * ★ 2026-10-19 缺凭证的单据（用户口径：每一行都得有凭证可看）
 *
 * 历史单（分期首期、强制凭证之前的单据）确实没有截图，
 * 抽屉顶部给出数量提示，凭证列逐行提供补传入口。
 */
const missingVoucherRows = computed(() =>
  feeRows.value.filter((r) => !r.voucherUrl && !(r as any).isChild),
);

/** 疑似重复行的底色（整行标红，避免老师漏看） */
function feeRowClass({ row }: { row: any }) {
  return row.duplicated ? 'fee-row-dup' : '';
}

/** 作废一整批缴费单（重复发起 / 发起错了） */
async function cancelFeeGroup(row: ConsultStudentFeeGroup) {
  const ids = row.orderIds || [];
  if (!ids.length) {
    ElMessage.warning('这张单据没有可作废的明细');
    return;
  }
  try {
    await ElMessageBox.confirm(
      `确认作废单号 ${row.orderNo}（${row.feeTypeName} ¥${row.amountYuan}）？` +
        (ids.length > 1 ? `\n该行含 ${ids.length} 张单据，将整批作废。` : '') +
        `\n作废后财务侧同步撤销，不可恢复；如果这笔钱已经到账，请改走「退费」。`,
      '作废缴费单',
      { type: 'warning', confirmButtonText: '确认作废', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  const res = await cancelFeeOrders(ids, '档案中人工核对为重复发起，作废');
  if (res.skipped?.length) {
    ElMessage.warning(
      `已作废 ${res.cancelled} 张；未作废：${res.skipped
        .map((s) => `${s.orderNo}（${s.reason}）`)
        .join('；')}`,
    );
  } else {
    ElMessage.success(`已作废 ${res.cancelled} 张单据`);
  }
  await refreshDetail();
}

async function openDetail(row: ConsultStudentListItem) {
  detailVisible.value = true;
  detailLoading.value = true;
  ledger.value = null;
  try {
    detail.value = await fetchStudentDetail(row.consultStudentId);
    // 账本加载失败不影响档案本身，静默降级为「不显示账本」
    ledger.value = await fetchStudentLedger(row.consultStudentId).catch(() => null);
  } finally {
    detailLoading.value = false;
  }
}

async function refreshDetail() {
  if (detail.value) {
    detail.value = await fetchStudentDetail(detail.value.id);
    ledger.value = await fetchStudentLedger(detail.value.consultStudentId).catch(() => null);
  }
}

/* ---------- 新建学生 ---------- */
const newVisible = ref(false);
const newForm = ref({
  studentName: '',
  gender: 1,
  phone: '',
  deptCode: 1,
  sourceChannel: 1,
  sourceRemark: '',
  /** ★ 2026-10-15 来源=转介绍时填写的招生老师信息 */
  referrerName: '',
  referrerPhone: '',
  parentContact: '',
  parentPhone: '',
});

function openNew() {
  newForm.value = {
    studentName: '',
    gender: 1,
    phone: '',
    deptCode: 1,
    sourceChannel: 1,
    sourceRemark: '',
    referrerName: '',
    referrerPhone: '',
    parentContact: '',
    parentPhone: '',
  };
  newVisible.value = true;
}

async function submitNew() {
  if (!newForm.value.studentName.trim()) {
    ElMessage.warning('请填写学生姓名');
    return;
  }
  const f = newForm.value;
  // ★ 2026-10-15 来源=转介绍时招生老师姓名必填
  if (f.sourceChannel === 3 && !f.referrerName.trim()) {
    ElMessage.warning('来源为「转介绍」时，请填写招生老师姓名');
    return;
  }
  const res = await addStudent({
    studentName: f.studentName.trim(),
    gender: f.gender,
    phone: f.phone || undefined,
    deptCode: f.deptCode,
    sourceChannel: f.sourceChannel,
    sourceRemark: f.sourceRemark || undefined,
    referrerName: f.sourceChannel === 3 ? f.referrerName.trim() || undefined : undefined,
    referrerPhone: f.sourceChannel === 3 ? f.referrerPhone.trim() || undefined : undefined,
    parentContact: f.parentContact || undefined,
    parentPhone: f.parentPhone || undefined,
  });
  ElMessage.success('新建成功，状态为「待分配」');
  newVisible.value = false;
  load();
}

/* ---------- 分配 / 领取 ---------- */
const assignVisible = ref(false);
const consultants = ref<Array<{ id: string; name: string; title: string }>>([]);
const assignForm = ref({ consultStudentId: '', ownerName: '' });

async function openAssign(row: ConsultStudentListItem | ConsultStudent) {
  const id = (row as any).consultStudentId || (row as any).id;
  assignForm.value = { consultStudentId: id, ownerName: '' };
  if (!consultants.value.length) {
    consultants.value = await fetchConsultants();
  }
  assignVisible.value = true;
}

async function submitAssign() {
  if (!assignForm.value.ownerName) {
    ElMessage.warning('请选择咨询老师');
    return;
  }
  await assignOwner(assignForm.value);
  ElMessage.success('已分配咨询老师');
  assignVisible.value = false;
  await load();
  if (detailVisible.value) await refreshDetail();
}

async function doClaim(row: ConsultStudentListItem | ConsultStudent) {
  const id = (row as any).consultStudentId || (row as any).id;
  await claimStudent(id);
  ElMessage.success('已领取，现在由你跟进');
  await load();
  if (detailVisible.value) await refreshDetail();
}

/* ---------- 面试结果（流程图：「是否接收该学生」→「是否当场报名」） ---------- */
const interviewVisible = ref(false);
const interviewForm = ref({
  consultStudentId: '',
  accepted: true,
  /** ★ 2026-10-08：接收后当场确定是否报名，一步到位 */
  enrolled: true,
  reason: '',
});

function openInterview(row: ConsultStudentListItem | ConsultStudent) {
  const id = (row as any).consultStudentId || (row as any).id;
  interviewForm.value = { consultStudentId: id, accepted: true, enrolled: true, reason: '' };
  interviewVisible.value = true;
}

/**
 * 提交面试结果
 *
 * ★ 2026-10-08 口径：面试结果直接确定「报名 / 未报名 / 不接收」，且只能录一次：
 *    · 接收 + 当场报名   → 状态 → 「试学费·待确认」，去「收费与到账」缴费（面试按钮随之消失）
 *    · 接收 + 未当场报名 → 「未报名·待跟进」（可取消，不计入流失率）
 *    · 不接收            → 到此结束，**不做统计、不计入流失**（状态 REJECTED）
 *  后端有防重护栏：非「待面试」状态再提交会被拒绝，杜绝重复面试。
 */
async function submitInterviewResult() {
  const f = interviewForm.value;
  if (!f.accepted && !f.reason.trim()) {
    ElMessage.warning('不接收时请填写原因，便于复盘');
    return;
  }
  if (f.accepted && !f.enrolled && !f.reason.trim()) {
    ElMessage.warning('未当场报名时请填写原因（如「家长想再对比一下」）');
    return;
  }
  await submitInterviewResultApi(
    f.consultStudentId,
    f.accepted,
    f.reason || undefined,
    f.accepted ? f.enrolled : undefined,
  );
  ElMessage.success(
    !f.accepted
      ? '已记录：不予接收（不计入流失统计）'
      : f.enrolled
        ? '已确认当场报名，请到「收费与到账」发起试学费收费'
        : '已记录「未报名·待跟进」，可随时取消',
  );
  interviewVisible.value = false;
  await load();
  if (detailVisible.value) await refreshDetail();
}

/* ---------- ★ 2026-10-20 分配班级（分班 + 入班合并） ----------
 *
 * 用户口径：「缴费结束之后，直接给他分配班级。分配班级之后，到什么部认领，
 *           就是入班和分班合并。」
 *
 * ★ 2026-10-20 二次确认（最终口径）：
 *   「大学侧和初高中一样，都需要老师接收之后入班」
 *   → 两个学段落地方式**完全一致**：
 *       咨询侧确认分配 = 推一条「待接收」单（不建档、不改状态）
 *       对应学段班主任在「待接收学员」点接收 → 建档 + 回写咨询侧状态
 */

/* ---------- ★ 分配班级（选学部 + 选开放班级） ---------- */
/**
 * 用户口径（2026-10-20）：
 *   「缴费结束之后，直接给他分配班级。分配班级之后，到什么部认领，
 *     就是入班和分班合并。」
 *
 * 老流程是两步：分班（只写班级名）→ 入班（推送到班级管理）。
 * 现在合成一步：选学部 + 选班级 → 确认 → 推到对应学段的「待接收学员」，
 * 由该班班主任接收后建档（初高 / 大学部同一套流程）。
 *
 * 后端统一走 /enroll-to-class（module 只用于目标库定位）。
 * 幂等：重复确认不会重复推送。
 */
const enrollVisible = ref(false);
const enrollSaving = ref(false);
const enrollForm = ref<{ row: ConsultStudentListItem | ConsultStudent | null; side: 'univ' | 'jh'; classId: string }>({
  row: null,
  side: 'univ',
  classId: '',
});
const enrollOpenClasses = ref<{ univ: OpenClassItem[]; jh: OpenClassItem[] }>({ univ: [], jh: [] });

/**
 * 列表整体的分班状态（和「收款与缴费」页同一口径）：
 * 已推送 / 已接收 / 初高已入班 → 「入班」按钮禁用并提示，避免点了才知道报错。
 */
const assignStatus = ref<Record<string, AssignStatusItem>>({});

async function loadAssignStatus() {
  const ids = Array.from(
    new Set(list.value.map((r) => (r as any).consultStudentId || (r as any).id).filter(Boolean) as string[]),
  );
  if (!ids.length) {
    assignStatus.value = {};
    return;
  }
  try {
    assignStatus.value = await fetchAssignStatus(ids);
  } catch {
    // 查不到不阻塞页面：按「可点」展示，后端 /enroll-to-class 仍会二次拦截
    assignStatus.value = {};
  }
}

/** 当前行还能不能分配班级（没查到状态时不误伤） */
function canEnrollOf(row: ConsultStudentListItem | ConsultStudent): boolean {
  const s = assignStatus.value[(row as any).consultStudentId || (row as any).id];
  return s ? s.canAssign : true;
}

/** 按钮禁用原因 */
function enrollTipOf(row: ConsultStudentListItem | ConsultStudent): string {
  const s = assignStatus.value[(row as any).consultStudentId || (row as any).id];
  return s ? s.label : '选择学部与开放班级后，推送给该班班主任接收';
}

/** 按学段切开放班级（初高/大学部字段名不同：classId / id） */
const enrollClassOptions = computed(() => {
  const list = enrollForm.value.side === 'jh' ? enrollOpenClasses.value.jh : enrollOpenClasses.value.univ;
  return (list || [])
    .map((c) => ({
      value: String(c.classId ?? c.id ?? ''),
      label: c.className + (c.stageName ? `（${c.stageName}）` : ''),
    }))
    .filter((o) => o.value);
});

async function openEnroll(row: ConsultStudentListItem | ConsultStudent) {
  enrollForm.value = { row, side: 'univ', classId: '' };
  enrollVisible.value = true;
  try {
    enrollOpenClasses.value = await fetchOpenClasses();
  } catch {
    enrollOpenClasses.value = { univ: [], jh: [] };
  }
}

async function submitEnroll() {
  const f = enrollForm.value;
  if (!f.row) return;
  if (!f.classId) {
    ElMessage.warning('请选择要进入的开放班级');
    return;
  }
  const id = (f.row as any).consultStudentId || (f.row as any).id;
  const name = (f.row as any).studentName || '该学员';
  const opt = enrollClassOptions.value.find((o) => o.value === f.classId);
  const target = `「${opt?.label ?? f.classId}」`;
  /* ★ 2026-10-20 最终口径：两个学段都要班主任接收后才入班，
   *   咨询侧确认分配只是「交人」，所以提示语统一（只有学部名不同） */
  const sideName = f.side === 'jh' ? '初高' : '大学部';

  try {
    await ElMessageBox.confirm(
      `确认把「${name}」分配到 ${target}（${sideName}）？\n确认后推送到该学部的「待接收学员」，由对应班级班主任接收后才建立学籍并入班。`,
      '确认分配班级',
      { confirmButtonText: '确认分配', cancelButtonText: '取消', type: 'info' },
    );
  } catch {
    return; // 用户取消
  }

  enrollSaving.value = true;
  try {
    await enrollToClassApi(id, f.classId, f.side === 'jh' ? 'class-jh' : 'class');
    ElMessage.success(
      `已把「${name}」推送到 ${target} 的「待接收学员」，等${sideName}班主任接收后建档入班`,
    );
    enrollVisible.value = false;
    await load();
    await loadAssignStatus();
    if (detailVisible.value) await refreshDetail();
  } catch {
    /* 后端已提示（未缴 / 已分班 / 班级模块不可用 等） */
  } finally {
    enrollSaving.value = false;
  }
}

/* ---------- ★ 2026-10-08 取消「未报名」 ---------- */
/**
 * 用户口径：还未报名的，可以取消掉 ——
 * 取消后回到「咨询中」（报名确认态），直接重走缴费流程。
 * ★ 面试结果只能录一次：取消未报名 ≠ 重新面试，所以不回「待面试」。
 */
async function doCancelNotEnroll(row: ConsultStudentListItem | ConsultStudent) {
  const id = (row as any).consultStudentId || (row as any).id;
  const name = (row as any).studentName;
  const { value } = await ElMessageBox.prompt(
    `将取消「${name}」的「未报名·待跟进」标记，状态恢复为「咨询中」，可继续走缴费流程（无需重复面试）。可填备注：`,
    '取消未报名',
    {
      confirmButtonText: '确认取消',
      cancelButtonText: '返回',
      inputPlaceholder: '如「学生又愿意报了」（选填）',
    },
  );
  await cancelNotEnrolled(id, value || undefined);
  ElMessage.success('已取消「未报名」，请到「收费与到账」继续缴费流程');
  await load();
  if (detailVisible.value) await refreshDetail();
}

/* ---------- 流失（明确不来了，计入流失率） ---------- */
const LOSS_REASONS = [
  '学费超出预算',
  '选择其他学校',
  '家庭原因',
  '试学体验不满意',
  '联系方式失效',
  '其他',
];
const lossVisible = ref(false);
const lossForm = ref({ consultStudentId: '', lossReason: '', remark: '' });

function openLoss(row: ConsultStudentListItem | ConsultStudent) {
  const id = (row as any).consultStudentId || (row as any).id;
  lossForm.value = { consultStudentId: id, lossReason: '', remark: '' };
  lossVisible.value = true;
}

async function submitLoss() {
  if (!lossForm.value.lossReason) {
    ElMessage.warning('请选择流失原因');
    return;
  }
  await recordLoss(lossForm.value);
  ElMessage.success('已记录流失（计入流失率）');
  lossVisible.value = false;
  await load();
  if (detailVisible.value) await refreshDetail();
}

/* ============================================================
 * 转正式 · 补缴（流程图：「是否一次性付清学费」）
 *
 * ⚠️ 流程图在这里是一个分叉：
 *    · 是（一次性缴清）→ 把还差的各类型一次全发
 *    · 否（分笔补缴）  → 学生这次缴哪几笔，就只发哪几笔，剩下的下次再发
 * 金额永远由财务按费用标准决定（规则2），本模块**不传 amount**。
 * ============================================================ */
const formalVisible = ref(false);
const formalLoading = ref(false);
const formalForm = ref<{
  consultStudentId: string;
  studentName: string;
  payMode: FormalPayMode;
  feeTypes: FeeType[];
  /** ★ 2026-10-19 缴费凭证（base64 预览用），建单时上传并随单落库 */
  voucherDataUrl: string;
  voucherNo: string;
}>({
  consultStudentId: '',
  studentName: '',
  payMode: FPM.FULL,
  feeTypes: [],
  voucherDataUrl: '',
  voucherNo: '',
});

/** 补缴明细（全款 / 已到账 / 还差） */
const supplementPlan = ref<ConsultSupplementPlan | null>(null);

/** 补缴弹窗里可勾选的类型 = 当前缺口（只让勾还差的，避免重复建单） */
const missingTypes = computed(() => supplementPlan.value?.missing || []);

/**
 * ⚠️ 规则3-①：咨询侧只能发起「学费 / 试学费」。
 *    住宿费 / 餐费 / 保险费归教务模块发起 —— 这里把它们挑出来，
 *    在界面上禁勾并说明原因，而不是让老师勾了再被后端拒绝。
 */
const CONSULT_OWNED_TYPES: FeeType[] = [FeeType.TUITION, FeeType.TRIAL_FEE];

/** 本次可勾选的缺口类型（咨询侧有权发起的） */
const selectableTypes = computed(() =>
  missingTypes.value.filter((t) => CONSULT_OWNED_TYPES.includes(t)),
);

/** 缺口里但归其他模块发起的类型（禁勾 + 提示原因） */
const notOwnedTypes = computed(() =>
  missingTypes.value.filter((t) => !CONSULT_OWNED_TYPES.includes(t)),
);

async function openToFormal(d: ConsultStudent) {
  formalForm.value = {
    consultStudentId: d.id,
    studentName: d.studentName,
    payMode: FPM.FULL,
    feeTypes: [],
    voucherDataUrl: '',
    voucherNo: '',
  };
  supplementPlan.value = null;
  formalVisible.value = true;
  formalLoading.value = true;
  try {
    supplementPlan.value = await fetchSupplementPlan(d.id);
  } catch (e: any) {
    ElMessage.error(e?.message || '补缴明细加载失败');
  } finally {
    formalLoading.value = false;
  }
}

/** 切换「一次性缴清 / 分笔补缴」时同步勾选状态 */
function onPayModeChange(mode: FormalPayMode) {
  if (mode === FPM.FULL) {
    formalForm.value.feeTypes = [];
  }
}

/** ★ 2026-10-19 转正式弹窗里的凭证选图 → base64（提交时上传拿 url） */
function onFormalFileChange(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    ElMessage.error('图片不能超过 5MB');
    input.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    formalForm.value.voucherDataUrl = String(reader.result || '');
  };
  reader.readAsDataURL(file);
}

async function submitToFormal() {
  const f = formalForm.value;
  if (f.payMode === FPM.INSTALLMENT && !f.feeTypes.length) {
    ElMessage.warning('分笔补缴请至少勾选一笔费用类型');
    return;
  }

  /**
   * ★ 2026-10-19 用户口径：「只要缴费就要有凭证」。
   *    转正式会真的建缴费单，所以凭证必传；
   *    但如果缺口里没有咨询侧可发的类型（不建单），就不要求传。
   */
  const willCreate =
    f.payMode === FPM.INSTALLMENT ? f.feeTypes.length > 0 : selectableTypes.value.length > 0;
  if (willCreate && !f.voucherDataUrl) {
    ElMessage.warning('请先上传缴费凭证截图');
    return;
  }

  try {
    await ElMessageBox.confirm(
      f.payMode === FPM.FULL
        ? `将为「${f.studentName}」一次性发起全部欠费（${
            supplementPlan.value?.missing.map((t) => FEE_TYPE_NAME[t]).join(' / ') || '—'
          }），金额由财务按费用标准取值。是否继续？`
        : `将为「${f.studentName}」发起补缴：${f.feeTypes
            .map((t) => FEE_TYPE_NAME[t])
            .join(' / ')}，剩余欠费下次再缴。是否继续？`,
      '转正式 · 发起收费',
      { type: 'warning', confirmButtonText: '确认发起' },
    );

    // 先传凭证拿 url，再建单（凭证随单落库，不会有「单建了、凭证没绑上」）
    let voucherUrl: string | undefined;
    if (willCreate) {
      const up = await uploadFile(f.voucherDataUrl, 'voucher');
      voucherUrl = up.url;
    }

    const res = await toFormal(
      f.consultStudentId,
      f.payMode,
      f.payMode === FPM.INSTALLMENT ? f.feeTypes : undefined,
      voucherUrl,
      f.voucherNo || undefined,
    );
    ElMessage.success({ message: res.message || '已发起收费', duration: 5000 });
    formalVisible.value = false;
    await load();
    if (detailVisible.value) await refreshDetail();
  } catch {
    /* 用户取消，或后端已提示（如「已到账无需重复发起」） */
  }
}

/* ---------- 档案完善 ---------- */
const extraVisible = ref(false);
const extraForm = ref({
  consultStudentId: '',
  idCard: '',
  school: '',
  address: '',
  targetCollege: '',
  birthday: '',
  payMode: '',
  remark: '',
});

function openExtra(d: ConsultStudent) {
  extraForm.value = {
    consultStudentId: d.id,
    idCard: d.idCard || '',
    school: d.school || '',
    address: d.address || '',
    targetCollege: d.targetCollege || '',
    birthday: (d as any).birthday || '',
    payMode: d.payMode || '',
    remark: d.remark || '',
  };
  extraVisible.value = true;
}

async function submitExtra() {
  await updateStudentExtra(extraForm.value);
  ElMessage.success('档案已更新');
  extraVisible.value = false;
  await load();
  await refreshDetail();
}

/* ---------- 状态 → 可执行动作 ----------
 *
 * ⚠️ 这里的映射直接对应流程图上的判断点：
 *    待分配   → 分配(经理) / 领取(咨询师)
 *    待面试   → 面试（★ 只能录一次）→「是否接收」+「是否当场报名」
 *    咨询中   → 面试已结束、进入缴费阶段：去「收费与到账」发起收费/传凭证（本页无面试按钮）
 *    待分班   → 财务确认到账后可分班
 *    试学中   → 转正式 →「是否一次性付清学费」（转正式弹窗里分 FULL/INSTALLMENT）
 *    未报名·待跟进 → 取消未报名（回「咨询中」，不重复面试）
 */

/**
 * ★ 2026-10-20 面试只能由「学生所属的那个咨询老师」录入
 *
 * 用户口径（原话）：「经理已经分配给咨询老师，经理这里就不可以再面试了」
 *  → 学生已经分配给张三 → 只有张三能录面试结果；经理/管理员在旁边只能看，不能替他面试。
 *  → 未分配（owner 为空）→ 视为公海，谁都能面（经理接待的走「领取」后 owner 就是自己）。
 *
 * 注：`/claim` 认领时经理的 owner_name 会带「（本人接待）」后缀，比对前先剥掉。
 */
function isMyStudent(row: any): boolean {
  const owner = String(row?.ownerName || '').trim();
  if (!owner) return true;
  const me = String(auth.account?.userName || '').trim();
  if (!me) return false;
  const normalized = owner.replace(/[（(]本人接待[）)]$/, '').trim();
  return normalized === me || owner === me;
}

function actionsOf(row: ConsultStudentListItem | ConsultStudent) {
  const s = (row as any).consultState as ConsultState;
  const isMgr = auth.isManagerUp;

  return {
    canAssign: s === CS.WAIT_ASSIGN && isMgr,
    canClaim: s === CS.WAIT_ASSIGN && !isMgr,
    /** ★ 2026-10-20：已分配给他人 → 经理也不能替人面试 */
    canInterview: s === CS.WAIT_INTERVIEW && isMyStudent(row),
    /**
     * ★ 2026-10-20 分配班级（分班 + 入班合并）
     *
     * 缴费到账（待分班）就可以分配；已经试学 / 缴费中 / 正式的学生
     * 如果之前在「待接收」里没落地，也允许补分配一次（后端幂等）。
     * 两个学段一律推到「待接收学员」，等对应班主任接收后才建档入班。
     */
    canEnroll: [CS.TRIAL_WAIT_CLASS, CS.TRIAL, CS.FULL_FEE_PENDING, CS.FORMAL].includes(s),
    canToFormal: s === CS.TRIAL || s === CS.FULL_FEE_PENDING,
    /**
     * ★ 2026-10-08：「未报名」不再是待面试阶段的独立按钮 ——
     * 面试结果弹窗里直接确定「报名 / 未报名」。
     * 未报名·待跟进状态 → 显示「取消未报名」。
     */
    canCancelNotEnroll: s === CS.NOT_ENROLLED,
    /** 可记录流失：已经进入试学/缴费阶段才谈得上「流失」 */
    canLoss: [
      CS.TRIAL_FEE_PENDING,
      CS.TRIAL_WAIT_CLASS,
      CS.TRIAL,
      CS.FULL_FEE_PENDING,
    ].includes(s),
  };
}

const fmtMoney = (cent?: number) => (cent == null ? '—' : `¥${(cent / 100).toFixed(2)}`);

/** 从补缴明细里取某类型的金额（用于勾选框后面的「· ¥XXXX」） */
function planAmountOf(t: FeeType): number | undefined {
  return supplementPlan.value?.items.find((i) => i.feeType === t)?.amount;
}

const completenessTag = (c?: { level: string }) => {
  if (!c) return 'info';
  return c.level === 'FULL' ? 'success' : c.level === 'PARTIAL' ? 'warning' : 'info';
};

/**
 * ★ 2026-10-15 凭证改为弹窗预览（与收款页口径一致）：
 *    点「查看」不再跳新标签页，而是弹窗内展示截图，点图可放大。
 */
const voucherVisible = ref(false);
const voucherUrl = ref('');

function openVoucher(url: string) {
  voucherUrl.value = url;
  voucherVisible.value = true;
}

/* ============================================================
 * ★ 2026-10-19 补传凭证
 *
 * 用户口径：「缴费单后边的凭证都得能查看，都得有。」
 *
 * 老数据（分期首期、强制凭证之前发起的单）确实没有截图，
 * 财务和咨询两边都查不到，所以这里必须给一个补传入口：
 *   · 没凭证 → 凭证列显示「缺凭证 · 上传」
 *   · 传完 → 立刻变「查看」，并同步到财务侧
 * ============================================================ */
const voucherUploadVisible = ref(false);
const voucherUploading = ref(false);
const voucherUploadDataUrl = ref('');
const voucherUploadNo = ref('');
const voucherUploadTarget = ref<{
  orderId: string;
  orderNo: string;
  studentName: string;
  label: string;
} | null>(null);

/** 打开补传弹窗（无凭证的行；子行指向同一张主单） */
function openUploadVoucher(row: any) {
  if (!row.orderId) return;
  voucherUploadTarget.value = {
    orderId: row.orderId,
    orderNo: row.orderNo,
    studentName: row.studentName || detail.value?.studentName || '',
    label: `${row.feeTypeName} ¥${row.amountYuan}`,
  };
  voucherUploadDataUrl.value = '';
  voucherUploadNo.value = '';
  voucherUploadVisible.value = true;
}

/** 选图 → base64 */
function onVoucherUploadFileChange(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    ElMessage.error('图片不能超过 5MB');
    input.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    voucherUploadDataUrl.value = String(reader.result || '');
  };
  reader.readAsDataURL(file);
}

async function submitUploadVoucher() {
  const t = voucherUploadTarget.value;
  if (!t) return;
  if (!voucherUploadDataUrl.value) {
    ElMessage.warning('请先选择缴费凭证截图');
    return;
  }
  voucherUploading.value = true;
  try {
    const up = await uploadFile(voucherUploadDataUrl.value, 'voucher');
    await uploadVoucher(t.orderId, up.url, voucherUploadNo.value || undefined);
    ElMessage.success('凭证已补传，财务侧同步更新');
    voucherUploadVisible.value = false;
    await refreshDetail();
  } catch (err: any) {
    ElMessage.error(err?.message || '凭证上传失败');
  } finally {
    voucherUploading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="page">
    <!-- 搜索栏 -->
    <el-card shadow="never" class="toolbar">
      <!--
        ★ 2026-10-21 用户口径：搜索区与「新建学生」原来是上下两行，
          现在合成一行并整体居中 —— 新建学生紧跟在「重置」后面。
      -->
      <div class="toolbar-row">
        <el-input
          v-model="query.keyword"
          class="kw-input"
          placeholder="搜索姓名 / 手机号 / 咨询老师 / 班级 / 来源"
          clearable
          @keyup.enter="search"
          @clear="search"
        />
        <el-select v-model="query.deptCode" placeholder="全部部门" clearable style="width: 130px">
          <!-- ★ 2026-10-20 初中部 / 高中部 / 大学部（顺序由 DEPT_OPTIONS 统一给出） -->
          <el-option v-for="d in DEPT_OPTIONS" :key="d" :value="d" :label="DEPT_NAME[d]" />
        </el-select>
        <el-button type="primary" @click="search">查询</el-button>
        <el-button @click="resetQuery">重置</el-button>
        <el-button type="primary" plain @click="openNew">＋ 新建学生</el-button>
      </div>

      <!-- 状态筛选 -->
      <div class="state-filter">
        <el-tag
          :effect="query.consultState === undefined ? 'dark' : 'plain'"
          class="state-tag"
          @click="
            () => {
              query.consultState = undefined;
              search();
            }
          "
        >
          全部
        </el-tag>
        <el-tag
          v-for="s in stateOptions"
          :key="s.value"
          :effect="query.consultState === s.value ? 'dark' : 'plain'"
          class="state-tag"
          @click="
            () => {
              query.consultState = s.value;
              search();
            }
          "
        >
          {{ s.label }}
        </el-tag>
      </div>
    </el-card>

    <!-- 列表 -->
    <el-card shadow="never" class="table-card">
      <el-table v-loading="loading" :data="list" stripe style="width: 100%">
        <el-table-column label="学生" min-width="150">
          <template #default="{ row }">
            <div class="stu-name">{{ row.studentName }}</div>
            <div class="stu-sub">{{ row.genderName }} · {{ row.phone || '无手机号' }}</div>
          </template>
        </el-table-column>

        <el-table-column label="来源" min-width="150">
          <template #default="{ row }">
            <el-tag size="small" plain>{{ row.sourceChannelName }}</el-tag>
            <div class="stu-sub">{{ row.source || '—' }}</div>
          </template>
        </el-table-column>

        <el-table-column label="跟进人" min-width="120">
          <template #default="{ row }">
            <span v-if="row.ownerName">{{ row.ownerName }}</span>
            <el-tag v-else size="small" type="warning">待分配</el-tag>
          </template>
        </el-table-column>

        <el-table-column label="当前状态" min-width="130">
          <template #default="{ row }">
            <el-tag size="small" type="primary">{{ row.consultStateName }}</el-tag>
          </template>
        </el-table-column>

        <el-table-column label="信息完整度" min-width="180">
          <template #default="{ row }">
            <el-tag size="small" :type="completenessTag(row.infoCompleteness)">
              {{ row.infoCompleteness.label }}
            </el-tag>
            <div class="stu-sub">
              基本 {{ row.infoCompleteness.baseCount }}/{{ row.infoCompleteness.baseTotal }} · 档案
              {{ row.infoCompleteness.extraCount }}/{{ row.infoCompleteness.extraTotal }}
            </div>
          </template>
        </el-table-column>

        <el-table-column label="收费 / 到账" min-width="150">
          <template #default="{ row }">
            <div>已缴 <b class="ok">{{ row.paidCount }}</b> 笔</div>
            <div class="stu-sub">待财务确认 {{ row.pendingCount }} 笔</div>
            <!-- ★ 2026-10-16 分期：有尾款没缴清的打「欠费」标记 -->
            <el-tag v-if="row.inArrear" size="small" type="danger" class="arrear-tag">
              欠费 ¥{{ (row.arrearAmount / 100).toFixed(2) }}
            </el-tag>
          </template>
        </el-table-column>

        <el-table-column label="操作" width="390" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openDetail(row)">详情</el-button>
            <el-button v-if="actionsOf(row).canAssign" link type="warning" @click="openAssign(row)">
              分配
            </el-button>
            <el-button v-if="actionsOf(row).canClaim" link type="warning" @click="doClaim(row)">
              领取
            </el-button>
            <el-button
              v-if="actionsOf(row).canInterview"
              link
              type="primary"
              @click="openInterview(row)"
            >
              面试
            </el-button>
            <el-button
              v-if="actionsOf(row).canCancelNotEnroll"
              link
              type="warning"
              @click="doCancelNotEnroll(row)"
            >
              取消未报名
            </el-button>
            <!-- ★ 2026-10-20 分配班级 = 分班 + 入班（两个学段都推到「待接收」，班主任接收后建档） -->
            <el-tooltip
              v-if="actionsOf(row).canEnroll"
              :content="enrollTipOf(row)"
              placement="top"
            >
              <span>
                <el-button
                  link
                  type="primary"
                  :disabled="!canEnrollOf(row)"
                  @click="openEnroll(row)"
                >
                  分配班级
                </el-button>
              </span>
            </el-tooltip>
            <el-button v-if="actionsOf(row).canLoss" link type="danger" @click="openLoss(row)">
              流失
            </el-button>
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

    <!-- ============ 详情抽屉 ============ -->
    <el-drawer v-model="detailVisible" title="学生档案" size="720px">
      <div v-loading="detailLoading">
        <template v-if="detail">
          <div class="d-head">
            <div>
              <div class="d-name">
                {{ detail.studentName }}
                <el-tag size="small" type="primary">{{ detail.consultStateName }}</el-tag>
              </div>
              <div class="d-sub">
                {{ detail.genderName }} · {{ detail.phone || '无手机号' }} · {{ detail.deptName }}
              </div>
            </div>
            <div class="d-actions">
              <el-button size="small" @click="openExtra(detail)">完善档案</el-button>
              <el-button
                v-if="actionsOf(detail).canInterview"
                size="small"
                type="primary"
                @click="openInterview(detail)"
              >
                录入面试结果
              </el-button>
              <el-tooltip
                v-if="actionsOf(detail).canEnroll"
                :content="enrollTipOf(detail)"
                placement="top"
              >
                <span>
                  <el-button
                    size="small"
                    type="primary"
                    plain
                    :disabled="!canEnrollOf(detail)"
                    @click="openEnroll(detail)"
                  >
                    分配班级
                  </el-button>
                </span>
              </el-tooltip>
              <el-button
                v-if="actionsOf(detail).canToFormal"
                size="small"
                type="success"
                @click="openToFormal(detail)"
              >
                转正式
              </el-button>
              <el-button
                v-if="actionsOf(detail).canCancelNotEnroll"
                size="small"
                type="warning"
                @click="doCancelNotEnroll(detail)"
              >
                取消未报名
              </el-button>
              <el-button
                v-if="actionsOf(detail).canToFormal"
                size="small"
                type="warning"
                @click="openToFormal(detail)"
              >
                补缴
              </el-button>
            </div>
          </div>

          <el-descriptions title="基本信息" :column="2" border size="small" class="d-block">
            <el-descriptions-item label="来源">
              {{ detail.sourceChannelName }}{{ detail.sourceRemark ? ' · ' + detail.sourceRemark : '' }}
            </el-descriptions-item>
            <!-- ★ 2026-10-15 转介绍来源时展示招生老师信息 -->
            <el-descriptions-item v-if="detail.referrerName" label="转介绍招生老师">
              {{ detail.referrerName }}{{ detail.referrerPhone ? ' · ' + detail.referrerPhone : '' }}
            </el-descriptions-item>
            <el-descriptions-item label="跟进人">
              {{ detail.ownerName || '待分配' }}
              <span v-if="detail.ownerTitle" class="d-sub">（{{ detail.ownerTitle }}）</span>
            </el-descriptions-item>
            <el-descriptions-item label="建档人">{{ detail.creatorName || '—' }}</el-descriptions-item>
            <el-descriptions-item label="家长联系人">{{ detail.parentContact || '—' }}</el-descriptions-item>
            <el-descriptions-item label="家长电话">{{ detail.parentPhone || '—' }}</el-descriptions-item>
            <el-descriptions-item label="班级">{{ detail.className || '未分班' }}</el-descriptions-item>
            <el-descriptions-item label="试学开始">{{ detail.trialStart || '—' }}</el-descriptions-item>
            <el-descriptions-item label="身份证号">{{ detail.idCard || '—' }}</el-descriptions-item>
            <el-descriptions-item label="就读/毕业学校">{{ detail.school || '—' }}</el-descriptions-item>
            <el-descriptions-item label="家庭住址" :span="2">{{ detail.address || '—' }}</el-descriptions-item>
            <el-descriptions-item label="报考院校">{{ detail.targetCollege || '—' }}</el-descriptions-item>
            <el-descriptions-item label="缴费方式">{{ detail.payMode || '—' }}</el-descriptions-item>
            <el-descriptions-item label="备注" :span="2">{{ detail.remark || '—' }}</el-descriptions-item>
          </el-descriptions>

          <div v-if="detail.fullFeeStatus" class="d-block">
            <el-alert
              :type="detail.fullFeeStatus.allArrived ? 'success' : 'info'"
              :closable="false"
              show-icon
            >
              <template #title>
                {{
                  detail.fullFeeStatus.allArrived
                    ? '全款 4 项（学费/住宿费/餐费/保险费）均已到账'
                    : '全款未齐：还缺 ' + detail.fullFeeStatus.missing.length + ' 项'
                }}
              </template>
            </el-alert>
          </div>

          <!--
            ★ 2026-10-16 分期账本：只有办过分期的学生才有账本。
               一次性缴清的学生 ledger.plans 为空，这块自动不显示。
          -->
          <div v-if="ledger && ledger.plans.length" class="d-block">
            <div class="d-title">缴费账本（分期）</div>
            <el-descriptions :column="4" border>
              <el-descriptions-item label="应收">
                <b>¥{{ ledger.totalAmountYuan }}</b>
              </el-descriptions-item>
              <el-descriptions-item label="已缴">
                <b class="ok">¥{{ ledger.paidAmountYuan }}</b>
              </el-descriptions-item>
              <el-descriptions-item label="优惠">
                ¥{{ ledger.discountAmountYuan }}
              </el-descriptions-item>
              <el-descriptions-item label="待缴">
                <b :class="ledger.inArrear ? 'warn' : ''">¥{{ ledger.pendingAmountYuan }}</b>
                <el-tag v-if="ledger.inArrear" size="small" type="danger">欠费</el-tag>
              </el-descriptions-item>
            </el-descriptions>

            <el-table :data="ledger.plans" size="small" border class="mt8">
              <el-table-column prop="planNo" label="计划号" width="150" />
              <el-table-column label="期数" width="90" align="center">
                <template #default="{ row }">{{ row.paidStages }} / {{ row.stageCount }}</template>
              </el-table-column>
              <el-table-column label="应收" width="100">
                <template #default="{ row }">¥{{ row.totalAmountYuan }}</template>
              </el-table-column>
              <el-table-column label="已缴" width="100">
                <template #default="{ row }">¥{{ row.paidAmountYuan }}</template>
              </el-table-column>
              <el-table-column label="待缴" width="100">
                <template #default="{ row }">
                  <b :class="row.pendingAmount > 0 ? 'warn' : ''">¥{{ row.pendingAmountYuan }}</b>
                </template>
              </el-table-column>
              <el-table-column label="状态" width="100">
                <template #default="{ row }">
                  <el-tag size="small" :type="row.status === 2 ? 'success' : row.status === 3 ? 'info' : 'warning'">
                    {{ row.statusName }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column label="各期情况" min-width="200">
                <template #default="{ row }">
                  <span
                    v-for="it in row.items"
                    :key="it.stageNo"
                    class="stage-chip"
                    :class="it.status === 2 ? 'is-paid' : it.overdue ? 'is-overdue' : ''"
                  >
                    {{ it.stageNo }}期 ¥{{ it.dueAmountYuan }}
                  </span>
                </template>
              </el-table-column>
            </el-table>
          </div>

          <div class="d-block">
            <div class="d-title">缴费单（{{ feeRows.length }}）</div>
            <!--
              ★ 2026-10-19 用户反馈「缴费凭证和实缴金额对不上」：
                一次缴清多项费用时只有一张转账截图，截图金额是【合计】；
                所以这里明确写清：父行金额 = 实缴总额 = 凭证金额，子行才是分项。
            -->
            <!--
              ★ 2026-10-19 用户口径：一张缴费单只传一张【总金额】凭证，
                下面子行只是这笔钱的拆分，不再各自给上传入口。
                分期单同理：每一期一张单、一张凭证（不是每个费用项各一张）。
            -->
            <div v-if="feeRows.length" class="d-sub" style="margin-bottom: 6px">
              合计行金额 = 本次实缴总额（即缴费凭证上的金额）；下面子行是它包含的费用项，
              加总等于合计行 —— 凭证只传这一张总金额的截图。
            </div>
            <!--
              ★ 2026-10-19 疑似重复收费提示：
                同一费用项同时挂在两张没走完流程的单据上（例如学费既待财务确认、
                又有一张待上传凭证），账面就会出现两组一样的金额。
                这里直接说清楚，并把作废入口放在行上。
            -->
            <el-alert
              v-if="dupFeeRows.length"
              type="error"
              :closable="false"
              show-icon
              style="margin-bottom: 8px"
            >
              <template #title>
                发现疑似重复收费：{{ dupFeeRows.length }} 组单据包含相同的费用项（{{
                  dupTypesText
                }}）。同一笔费用只应保留一张在途单，请核对后作废多余的一批。
              </template>
            </el-alert>
            <!--
              ★ 2026-10-19 用户口径：缴费单后边的凭证都得有。
                历史单（分期首期 / 强制凭证之前发起的）确实没有截图，
                这里点明数量，凭证列上逐行补传，补完就能「查看」。
            -->
            <el-alert
              v-if="missingVoucherRows.length"
              type="warning"
              :closable="false"
              show-icon
              style="margin-bottom: 8px"
            >
              <template #title>
                有 {{ missingVoucherRows.length }} 张单据还没有缴费凭证（历史单据），
                请在「凭证」列点「上传」补齐 —— 补完即可查看，并同步到财务。
              </template>
            </el-alert>
            <el-table
              v-if="feeRows.length"
              :data="feeRows"
              size="small"
              border
              row-key="rowKey"
              default-expand-all
              :tree-props="{ children: 'children' }"
              :row-class-name="feeRowClass"
            >
              <el-table-column prop="orderNo" label="单号" width="150" />
              <!--
                ★ 2026-10-19 分期单标出期次：
                  分期是「每期一张单」，同一张计划会出现多行相同金额，
                  不标第几期老师会以为是重复收费。
              -->
              <el-table-column label="类型" min-width="150">
                <template #default="{ row }">
                  <el-tag
                    v-if="row.stageNo"
                    size="small"
                    type="warning"
                    effect="plain"
                    style="margin-right: 4px"
                  >
                    第{{ row.stageNo }}期
                  </el-tag>
                  {{ row.feeTypeName }}
                </template>
              </el-table-column>
              <el-table-column label="金额" width="110">
                <template #default="{ row }">¥{{ row.amountYuan }}</template>
              </el-table-column>
              <el-table-column label="状态" width="112">
                <template #default="{ row }">
                  <el-tag size="small" :type="feeTagType(row.status)">{{ row.statusName }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="凭证" width="104">
                <template #default="{ row }">
                  <el-button
                    v-if="row.voucherUrl"
                    link
                    type="primary"
                    @click="openVoucher(row.voucherUrl)"
                  >
                    查看
                  </el-button>
                  <!--
                    ★ 2026-10-19 用户口径：一张单只需要一张【总金额】凭证。
                      子行是合计行的拆分（学费/试学费…），不是独立的收款，
                      所以子行不给上传入口，也不会出现「每个项目各传一张」。
                      老数据（分期首期 / 强制凭证之前发起的单）确实没有截图，
                      只在合计行给补传入口，传完子行一起变「查看」。
                  -->
                  <span v-else-if="row.isChild" class="d-sub">— 见合计行</span>
                  <el-tooltip
                    v-else
                    content="这张单据还没有缴费凭证，点击补传（一张总金额截图即可）"
                    placement="top"
                  >
                    <el-button link type="danger" @click="openUploadVoucher(row)">上传</el-button>
                  </el-tooltip>
                </template>
              </el-table-column>
              <el-table-column prop="createTime" label="创建时间" min-width="140" />
              <!-- ★ 2026-10-19 作废（重复发起 / 发起错了）；分期单不给，撤期要回分期计划里处理 -->
              <el-table-column label="操作" width="90">
                <template #default="{ row }">
                  <el-button
                    v-if="!row.isChild && !row.planId && row.status !== 2"
                    link
                    type="danger"
                    @click="cancelFeeGroup(row)"
                  >
                    作废
                  </el-button>
                  <span v-else class="d-sub">—</span>
                </template>
              </el-table-column>
            </el-table>
            <el-empty v-else description="暂无缴费单" :image-size="60" />
          </div>

          <div v-if="detail.refund" class="d-block">
            <div class="d-title">退费单</div>
            <el-descriptions :column="2" border size="small">
              <el-descriptions-item label="退费单号">{{ detail.refund.refundNo }}</el-descriptions-item>
              <el-descriptions-item label="状态">{{ detail.refund.statusName }}</el-descriptions-item>
              <el-descriptions-item label="试学天数">{{ detail.refund.trialDays }} 天</el-descriptions-item>
              <el-descriptions-item label="消耗扣减">
                {{ fmtMoney(detail.refund.deductTotal) }}
              </el-descriptions-item>
              <el-descriptions-item label="应退金额" :span="2">
                <b class="warn">{{ fmtMoney(detail.refund.refundAmount) }}</b>
              </el-descriptions-item>
            </el-descriptions>
          </div>

          <div class="d-block">
            <div class="d-title">跟进历史（{{ detail.history?.length || 0 }}）</div>
            <el-timeline v-if="detail.history?.length">
              <el-timeline-item
                v-for="(h, i) in detail.history"
                :key="i"
                :timestamp="h.at"
                placement="top"
              >
                <div class="h-action">{{ h.text }}</div>
                <div class="d-sub">
                  {{ h.by }}{{ h.byTitle ? ' · ' + h.byTitle : '' }}
                </div>
              </el-timeline-item>
            </el-timeline>
            <el-empty v-else description="暂无跟进记录" :image-size="60" />
          </div>
        </template>
      </div>
    </el-drawer>

    <!-- 缴费凭证预览弹窗 -->
    <el-dialog v-model="voucherVisible" title="缴费凭证" width="480px">
      <div v-if="voucherUrl" class="voucher-box">
        <el-image
          :src="voucherUrl"
          :preview-src-list="[voucherUrl]"
          fit="contain"
          style="max-width: 100%; max-height: 60vh"
        >
          <template #error>
            <div class="voucher-fail">凭证文件缺失（服务器上已找不到这张图）。</div>
          </template>
        </el-image>
        <div class="d-sub mt8">点击图片可放大查看</div>
      </div>
    </el-dialog>

    <!--
      ★ 2026-10-19 补传缴费凭证
        用户口径：「缴费单后边的凭证都得有查看」。历史单据确实没有截图，
        这里补齐后咨询/财务两侧同时更新，行内「上传」立刻变「查看」。
    -->
    <el-dialog v-model="voucherUploadVisible" title="补传缴费凭证" width="460px">
      <div v-if="voucherUploadTarget" class="voucher-upload">
        <div class="d-sub">
          {{ voucherUploadTarget.studentName }} · {{ voucherUploadTarget.label }}
          <span v-if="voucherUploadTarget.orderNo">（{{ voucherUploadTarget.orderNo }}）</span>
        </div>
        <input type="file" accept="image/*" class="mt8" @change="onVoucherUploadFileChange" />
        <div class="d-sub mt6">选这张单据对应的转账截图，不超过 5MB</div>
        <div v-if="voucherUploadDataUrl" class="voucher-preview mt8">
          <img :src="voucherUploadDataUrl" alt="凭证预览" />
        </div>
        <el-input
          v-model="voucherUploadNo"
          class="mt8"
          placeholder="转账单号（选填）"
          clearable
        />
      </div>
      <template #footer>
        <el-button @click="voucherUploadVisible = false">取消</el-button>
        <el-button type="primary" :loading="voucherUploading" @click="submitUploadVoucher">
          上传并保存
        </el-button>
      </template>
    </el-dialog>

    <!-- ============ 新建学生 ============ -->
    <el-dialog v-model="newVisible" title="新建学生" width="560px">
      <el-form label-width="96px">
        <el-form-item label="姓名" required>
          <el-input v-model="newForm.studentName" placeholder="学生姓名" />
        </el-form-item>
        <el-form-item label="性别">
          <el-radio-group v-model="newForm.gender">
            <el-radio :value="1">男</el-radio>
            <el-radio :value="2">女</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="手机号">
          <el-input v-model="newForm.phone" placeholder="学生本人手机号" />
        </el-form-item>
        <el-form-item label="部门">
          <el-select v-model="newForm.deptCode" style="width: 100%">
            <!-- ★ 2026-10-20 初中部 / 高中部 / 大学部 -->
            <el-option v-for="d in DEPT_OPTIONS" :key="d" :value="d" :label="DEPT_NAME[d]" />
          </el-select>
        </el-form-item>
        <el-form-item label="来源">
          <el-select v-model="newForm.sourceChannel" style="width: 100%">
            <el-option :value="1" label="家访" />
            <el-option :value="2" label="线上咨询" />
            <el-option :value="3" label="转介绍" />
            <el-option :value="4" label="主动上门" />
            <el-option :value="5" label="电话咨询" />
            <el-option :value="9" label="其他" />
          </el-select>
        </el-form-item>
        <el-form-item label="来源备注">
          <el-input v-model="newForm.sourceRemark" placeholder="如「青山社区」" />
        </el-form-item>
        <!-- ★ 2026-10-15 来源=转介绍时：填招生老师姓名 + 手机号 -->
        <template v-if="newForm.sourceChannel === 3">
          <el-form-item label="招生老师姓名" required>
            <el-input v-model="newForm.referrerName" placeholder="转介绍的招生老师姓名" />
          </el-form-item>
          <el-form-item label="招生老师手机号">
            <el-input v-model="newForm.referrerPhone" placeholder="转介绍的招生老师手机号" maxlength="20" />
          </el-form-item>
        </template>
        <el-form-item label="家长联系人">
          <el-input v-model="newForm.parentContact" placeholder="如「陈建国（父）」" />
        </el-form-item>
        <el-form-item label="家长电话">
          <el-input v-model="newForm.parentPhone" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="newVisible = false">取消</el-button>
        <el-button type="primary" @click="submitNew">确定</el-button>
      </template>
    </el-dialog>

    <!-- ============ 分配 ============ -->
    <el-dialog v-model="assignVisible" title="分配咨询老师" width="420px">
      <el-select v-model="assignForm.ownerName" placeholder="请选择咨询老师" style="width: 100%">
        <el-option
          v-for="c in consultants"
          :key="c.id"
          :value="c.name"
          :label="`${c.name}（${c.title}）`"
        />
      </el-select>
      <template #footer>
        <el-button @click="assignVisible = false">取消</el-button>
        <el-button type="primary" @click="submitAssign">确定分配</el-button>
      </template>
    </el-dialog>

    <!-- ============ 面试结果（流程图：「是否接收该学生」→「是否当场报名」） ============ -->
    <el-dialog v-model="interviewVisible" title="录入面试结果" width="520px">
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="对应流程图「是否接收该学生」：不接收则流程到此结束，不计统计、不计流失"
        class="mb"
      />
      <el-form label-width="110px">
        <el-form-item label="是否接收" required>
          <el-radio-group v-model="interviewForm.accepted">
            <el-radio :value="true">接收（继续走报名流程）</el-radio>
            <el-radio :value="false">不接收（结束，不计统计）</el-radio>
          </el-radio-group>
        </el-form-item>
        <!-- ★ 2026-10-08：面试通过后当场确定「报名 / 未报名」，一步到位 -->
        <el-form-item v-if="interviewForm.accepted" label="是否当场报名" required>
          <el-radio-group v-model="interviewForm.enrolled">
            <el-radio :value="true">当场报名（进入缴费流程）</el-radio>
            <el-radio :value="false">未报名（记「未报名·待跟进」，可取消）</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="原因 / 评价">
          <el-input
            v-model="interviewForm.reason"
            type="textarea"
            :rows="3"
            :placeholder="
              !interviewForm.accepted
                ? '不接收的原因（必填），如「基础太弱，建议明年再来」'
                : interviewForm.enrolled
                  ? '面试通过评价（选填）'
                  : '未当场报名的原因（必填），如「家长想再对比一下其他机构」'
            "
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="interviewVisible = false">取消</el-button>
        <el-button type="primary" @click="submitInterviewResult">提交</el-button>
      </template>
    </el-dialog>

    <!-- 取消「未报名」：用 ElMessageBox.prompt 轻量确认，无需独立弹窗 -->

    <!-- ============ 转正式 / 补缴（流程图：「是否一次性付清学费」） ============ -->
    <el-dialog v-model="formalVisible" title="转正式 · 发起收费" width="620px">
      <div v-loading="formalLoading">
        <!-- 补缴明细 -->
        <div v-if="supplementPlan" class="plan-box">
          <div class="plan-row">
            <span>全款合计</span>
            <b>{{ fmtMoney(supplementPlan.totalAmount) }}</b>
          </div>
          <div class="plan-row">
            <span>已到账</span>
            <b class="ok">{{ fmtMoney(supplementPlan.arrivedAmount) }}</b>
          </div>
          <div class="plan-row">
            <span>仍缺</span>
            <b class="warn">
              {{ fmtMoney(supplementPlan.missingAmount) }}
              <span v-if="supplementPlan.missing.length" class="d-sub">
                （{{ supplementPlan.missing.map((t) => FEE_TYPE_NAME[t]).join('、') }}）
              </span>
            </b>
          </div>

          <el-table :data="supplementPlan.items" size="small" border class="plan-table">
            <el-table-column label="费用类型" width="90">
              <template #default="{ row }">{{ row.feeTypeName }}</template>
            </el-table-column>
            <el-table-column label="金额" width="110">
              <template #default="{ row }">{{ fmtMoney(row.amount) }}</template>
            </el-table-column>
            <el-table-column label="状态" width="100">
              <template #default="{ row }">
                <el-tag
                  size="small"
                  :type="
                    row.state === 'ARRIVED'
                      ? 'success'
                      : row.state === 'PENDING'
                        ? 'warning'
                        : row.state === 'REJECTED'
                          ? 'danger'
                          : 'info'
                  "
                >
                  {{ row.stateName }}
                </el-tag>
              </template>
            </el-table-column>
          </el-table>
        </div>

        <el-alert
          v-if="supplementPlan?.allArrived"
          type="success"
          :closable="false"
          show-icon
          title="全款已到账，无需再次发起"
          class="mb"
        />

        <!-- 缴费方式分支 -->
        <el-form v-else label-width="110px" class="mt">
          <el-form-item label="缴费方式" required>
            <el-radio-group
              v-model="formalForm.payMode"
              @change="onPayModeChange(formalForm.payMode)"
            >
              <el-radio :value="FPM.FULL">一次性缴清（把欠费全发）</el-radio>
              <el-radio :value="FPM.INSTALLMENT">分笔补缴（本次缴哪几笔就发哪几笔）</el-radio>
            </el-radio-group>
          </el-form-item>

          <el-form-item v-if="formalForm.payMode === FPM.INSTALLMENT" label="本次补缴">
            <div>
              <el-checkbox-group v-model="formalForm.feeTypes">
                <el-checkbox v-for="t in selectableTypes" :key="t" :value="t">
                  {{ FEE_TYPE_NAME[t] }} · {{ fmtMoney(planAmountOf(t)) }}
                </el-checkbox>
              </el-checkbox-group>

              <div v-if="!selectableTypes.length" class="d-sub">
                当前缺口里没有咨询模块可发起的类型。
              </div>

              <!-- 规则3-①：归属其他模块的类型，禁勾并说明 -->
              <div v-if="notOwnedTypes.length" class="owned-tip">
                <el-icon><InfoFilled /></el-icon>
                <span>
                  以下类型归其他模块发起，咨询侧无权建单：
                  <b>{{ notOwnedTypes.map((t) => FEE_TYPE_NAME[t]).join('、') }}</b>
                  <span class="d-sub">（住宿费/餐费/保险费请由教务模块发起）</span>
                </span>
              </div>

              <div class="d-sub mt6">
                只能勾选「仍缺」且本模块有权发起的类型；未勾选的留到下次补缴。
                金额由财务按费用标准给出，本模块不填金额。
              </div>
            </div>
          </el-form-item>

          <!-- 一次性缴清时也提前告知哪些不会由本模块发起 -->
          <el-alert
            v-else-if="notOwnedTypes.length"
            type="info"
            :closable="false"
            show-icon
            :title="`一次性缴清只会发起咨询侧可建的 ${
              selectableTypes.map((t) => FEE_TYPE_NAME[t]).join('、') || '（无）'
            }；${notOwnedTypes.map((t) => FEE_TYPE_NAME[t]).join('、')} 需由教务模块发起`"
            class="mt"
          />

          <!--
            ★ 2026-10-19 用户口径：「只要缴费就要有凭证」。
              转正式会真的建缴费单，所以凭证必须在这里当场传；
              建单时随单落库，财务侧立刻是「待核对」，不会留「待上传凭证」的单。
          -->
          <el-form-item
            v-if="
              formalForm.payMode === FPM.INSTALLMENT
                ? formalForm.feeTypes.length > 0
                : selectableTypes.length > 0
            "
            label="缴费凭证"
            required
          >
            <div>
              <input type="file" accept="image/*" @change="onFormalFileChange" />
              <div class="d-sub mt6">
                必填。一次缴费对应一张转账截图，金额即本次实缴合计（不超过 5MB）
              </div>
              <div v-if="formalForm.voucherDataUrl" class="voucher-preview">
                <img :src="formalForm.voucherDataUrl" alt="凭证预览" />
              </div>
            </div>
          </el-form-item>

          <el-form-item label="转账单号">
            <el-input
              v-model="formalForm.voucherNo"
              placeholder="如微信/支付宝交易单号（选填）"
            />
          </el-form-item>
        </el-form>
      </div>

      <template #footer>
        <el-button @click="formalVisible = false">取消</el-button>
        <el-button
          type="primary"
          :disabled="!supplementPlan || supplementPlan.allArrived"
          @click="submitToFormal"
        >
          {{ formalForm.payMode === FPM.FULL ? '一次性发起收费' : '发起本次补缴' }}
        </el-button>
      </template>
    </el-dialog>

    <!-- ============ ★ 分配班级（分班 + 入班，一次完成） ============ -->
    <el-dialog v-model="enrollVisible" title="分配班级" width="560px">
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="交完试学费或学费（财务确认到账）后即可分配；确认后推到该学部的「待接收学员」，由对应班级班主任接收后才建档入班并回写学生状态"
        class="mb"
      />
      <el-alert
        type="success"
        :closable="false"
        show-icon
        title="只交了试学费 → 接收后为「试学中」；学费等全款已缴清 → 接收后直接是「正式在读」"
        class="mb"
      />
      <el-form label-width="90px" label-position="right">
        <el-form-item label="学生">
          <span>{{ (enrollForm.row && (enrollForm.row.studentName || '—')) || '—' }}</span>
        </el-form-item>
        <el-form-item label="进入学部" required>
          <el-radio-group
            v-model="enrollForm.side"
            :disabled="enrollSaving"
            @change="enrollForm.classId = ''"
          >
            <el-radio-button value="univ">大学部</el-radio-button>
            <el-radio-button value="jh">初中部 / 高中部</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="开放班级" required>
          <el-select
            v-model="enrollForm.classId"
            placeholder="请选择该学段下的开放班级"
            style="width: 100%"
            :disabled="enrollSaving"
            filterable
          >
            <el-option
              v-for="o in enrollClassOptions"
              :key="o.value"
              :value="o.value"
              :label="o.label"
            />
          </el-select>
          <div v-if="!enrollClassOptions.length" class="tip-warn">
            该学段当前没有开放班级（班级管理 / 教学管理（初高）里把班级状态置为「开放」后才会出现）
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button :disabled="enrollSaving" @click="enrollVisible = false">取消</el-button>
        <el-button type="primary" :loading="enrollSaving" @click="submitEnroll">
          确认分配
        </el-button>
      </template>
    </el-dialog>

    <!-- ============ 流失 ============ -->
    <el-dialog v-model="lossVisible" title="记录流失" width="460px">
      <el-form label-width="90px">
        <el-form-item label="流失原因" required>
          <el-select v-model="lossForm.lossReason" placeholder="请选择" style="width: 100%">
            <el-option v-for="r in LOSS_REASONS" :key="r" :value="r" :label="r" />
          </el-select>
        </el-form-item>
        <el-form-item label="补充说明">
          <el-input v-model="lossForm.remark" type="textarea" :rows="3" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="lossVisible = false">取消</el-button>
        <el-button type="danger" @click="submitLoss">确认流失</el-button>
      </template>
    </el-dialog>

    <!-- ============ 完善档案 ============ -->
    <el-dialog v-model="extraVisible" title="完善档案" width="520px">
      <el-form label-width="110px">
        <el-form-item label="身份证号">
          <el-input v-model="extraForm.idCard" />
        </el-form-item>
        <el-form-item label="就读/毕业学校">
          <el-input v-model="extraForm.school" />
        </el-form-item>
        <el-form-item label="家庭住址">
          <el-input v-model="extraForm.address" />
        </el-form-item>
        <el-form-item label="报考院校">
          <el-input v-model="extraForm.targetCollege" />
        </el-form-item>
        <el-form-item label="出生日期">
          <el-input v-model="extraForm.birthday" placeholder="YYYY-MM-DD" />
        </el-form-item>
        <el-form-item label="缴费方式">
          <el-input v-model="extraForm.payMode" placeholder="如「分期缴纳」" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="extraForm.remark" type="textarea" :rows="3" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="extraVisible = false">取消</el-button>
        <el-button type="primary" @click="submitExtra">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.toolbar-row {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  flex-wrap: nowrap;
}

/* ★ 2026-10-15 工具栏一行放齐：关键词输入框可伸缩，其余控件不压缩，
     「重置」紧跟在「查询」后面，不再被挤到第二行 */
/* ★ 2026-10-21 搜索区 + 新建学生合并为一行，整体水平居中（不再用左右 spacer 撑开） */
.toolbar-row > * {
  flex-shrink: 0;
}

.kw-input {
  flex: 1 1 240px;
  max-width: 380px;
  min-width: 160px;
}

.state-filter {
  margin-top: 12px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.state-tag {
  cursor: pointer;
  user-select: none;
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
  margin-top: 2px;
}

.ok {
  color: #5FA36F;
}

.warn {
  color: #C9852E;
}

/* ---------- ★ 2026-10-16 分期欠费 / 期次小标签 ---------- */
.arrear-tag {
  margin-top: 4px;
}

.stage-chip {
  display: inline-block;
  margin: 2px 4px 2px 0;
  padding: 1px 6px;
  font-size: 12px;
  line-height: 18px;
  border-radius: 4px;
  background: #f4f4f5;
  color: #909399;
}

.stage-chip.is-paid {
  background: #e8f6ec;
  color: #5fa36f;
}

.stage-chip.is-overdue {
  background: #fdeeee;
  color: #d05a5a;
}

.d-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 12px;
  border-bottom: 1px solid #F1EAE5;
}

.d-name {
  font-size: 18px;
  font-weight: 700;
  display: flex;
  align-items: center;
  gap: 8px;
}

.d-sub {
  font-size: 12px;
  color: #A2938E;
  margin-top: 4px;
}

/* ---- 缴费凭证预览弹窗 ---- */
.voucher-box {
  display: flex;
  flex-direction: column;
  align-items: center;
}

/* 转正式弹窗里的凭证缩略图 */
.voucher-preview {
  margin-top: 8px;
}

.voucher-preview img {
  max-width: 180px;
  max-height: 120px;
  border: 1px solid #eadfd9;
  border-radius: 6px;
}

.voucher-fail {
  padding: 24px;
  font-size: 13px;
  color: #f56c6c;
  text-align: center;
}

.d-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}

.d-block {
  margin-top: 18px;
}

.d-title {
  font-weight: 600;
  color: #443432;
  margin-bottom: 8px;
}

/*
 * ★ 2026-10-19 疑似重复收费的行（同一费用项挂在两张在途单上）
 * 用淡红底 + 左侧红条提示，扫一眼就能看出"这组重复了"。
 */
:deep(.fee-row-dup) {
  background: #FEF0F0;
}
:deep(.fee-row-dup td) {
  background: #FEF0F0 !important;
}
:deep(.fee-row-dup td:first-child) {
  box-shadow: inset 3px 0 0 #E56A6A;
}

.h-action {
  font-size: 13px;
  color: #443432;
}

.mb {
  margin-bottom: 12px;
}

/* ---- 转正式 / 补缴弹窗 ---- */
.plan-box {
  background: #FBF7F4;
  border: 1px solid #EFE9E4;
  border-radius: 6px;
  padding: 12px 14px;
}

.plan-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  font-size: 13px;
  color: #7A6C67;
  padding: 3px 0;
}

.plan-table {
  margin-top: 10px;
}

.mt {
  margin-top: 14px;
}

.mt6 {
  margin-top: 6px;
}

/* 规则3-① 归属提示：其他模块发起的类型，禁勾说明 */
.owned-tip {
  display: flex;
  align-items: flex-start;
  gap: 5px;
  margin-top: 8px;
  padding: 7px 9px;
  background: #FBF3E5;
  border: 1px solid #EFD9B5;
  border-radius: 4px;
  font-size: 12px;
  color: #A66A1F;
  line-height: 1.6;
}
</style>
