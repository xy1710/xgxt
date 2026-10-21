/**
 * 缴费管理相关类型契约 —— 教务版
 *
 * 来源：教务管理原型 payment.html（缴费管理页）
 *
 * ⚠️ 这些取值和文案必须与原型保持一致，否则页面显示会和原型对不上。
 *    原型里这些都是写在页面脚本里的常量，这里把它们提升为前后端共用的契约。
 */
import { StudentStatus, FeeType } from './edu-enums.js';

// ========== 常量 ==========

/**
 * 费用类别（原型 FEE_TYPES）
 *
 * 原型里类别是中文字符串，就直接按字符串存，保证和原型显示完全一致。
 * （注意：edu-enums.ts 里另有一个数字枚举 FeeType 给后续财务模块用，两者不冲突，
 *   这里为了避免同名导出，类型别名取名 PaymentCategory。）
 */
export const FEE_TYPES = ['学费', '住宿费', '保险费', '餐费'] as const;

export type PaymentCategory = (typeof FEE_TYPES)[number];

/**
 * ⭐ 2026-10-15 新增：教务「中文类别」→ 财务「数字费用类型」的映射
 *
 * 【为什么需要它】
 *   教务的缴费记录存的是【中文类别】（原型就是中文），而财务的
 *   `t_finance_fee.fee_type` 是【数字枚举】（1 学费 / 2 住宿费 / 3 餐费 / 4 保险费）。
 *   教务上传的缴费截图要回传给财务，就必须把两边的口径对上。
 *
 * ⚠️ 这是**唯一**的换算口径 —— 不许在路由、service 里各写一份 if-else，
 *    否则以后加类别（如「教材费」）必然漏改一处。
 *
 * 💡 试学费(5)不在此表内：它由咨询模块发起，教务侧没有这个类别。
 */
export const CATEGORY_TO_FEE_TYPE: Record<string, FeeType> = {
  学费: FeeType.TUITION,
  住宿费: FeeType.ACCOMMODATION,
  餐费: FeeType.MEAL,
  保险费: FeeType.INSURANCE,
};

/**
 * 类别徽章配色（原型 FEE_BADGES）
 * 值是 Element Plus 的 el-tag type，视觉沿用已联库的页面风格。
 * 原型原配色：住宿费=蓝 #4668F2 / 保险费=紫 / 餐费=橙
 */
export const FEE_TAG_TYPE: Record<string, 'primary' | 'success' | 'warning' | 'danger' | 'info'> = {
  学费: 'danger',
  住宿费: 'primary',
  保险费: 'warning',
  餐费: 'success',
};

/**
 * 各类别的参考收费标准（新建缴费时带出的默认金额）
 * 和迁移 20261002_003 里回填历史数据用的是同一套基准价
 */
export const FEE_BASE_AMOUNT: Record<string, number> = {
  学费: 5800,
  住宿费: 1200,
  保险费: 300,
  餐费: 800,
};

/** 班主任池（原型 TEACHERS），班级下标对应班主任 */
export const HEAD_TEACHERS = [
  '王老师',
  '李老师',
  '张老师',
  '刘老师',
  '陈老师',
  '杨老师',
  '赵老师',
  '周老师',
] as const;

/**
 * 临期天数阈值（原型 EXPIRING_DAYS）
 * 剩余天数在 [0, 30] 内算临期；原型判定是 `daysLeft >= 0 && daysLeft <= 30`
 */
export const EXPIRING_DAYS = 30;

/** 分页大小（原型 pageSize） */
export const PAYMENT_PAGE_SIZE = 10;

/** 剩余天数 ≤ 7 时，原型直接把状态置为「待上传」 */
export const URGENT_DAYS = 7;

// ========== 枚举 ==========

/** 临期状态（原型 statuses：待通知 / 待上传 / 已上传） */
export enum ExpStatus {
  WAIT_NOTIFY = '待通知',
  WAIT_UPLOAD = '待上传',
  UPLOADED = '已上传',
}

export const EXP_STATUS_LIST = [
  ExpStatus.WAIT_NOTIFY,
  ExpStatus.WAIT_UPLOAD,
  ExpStatus.UPLOADED,
] as string[];

/** 临期状态徽章配色（原型 statusBadge） */
export const EXP_STATUS_TAG_TYPE: Record<string, 'warning' | 'danger' | 'success'> = {
  [ExpStatus.WAIT_NOTIFY]: 'warning', // 原型 badge-orange
  [ExpStatus.WAIT_UPLOAD]: 'danger', // 原型 badge-red
  [ExpStatus.UPLOADED]: 'success', // 原型 badge-green
};

/** 冻结状态（原型 frozen 布尔值） */
export const PAY_STATUS_NORMAL = '正常';
export const PAY_STATUS_FROZEN = '已冻结';

/* ============================================================
 * 缴费状态 / 凭证状态
 *
 * 「即将到期」页按缴费类别分了四个子页（学费 / 住宿费 / 保险费 / 餐费），
 * 每行要展示：缴费金额、缴费状态（已缴 / 未缴）、凭证状态（已传 / 未传 / 被打回）。
 *
 * 操作按钮的业务规则（前端展示和后端校验用同一份，见 payment.route.ts）：
 *   1. 只有「缴费状态 = 已缴」且「凭证 ≠ 已传」时，才能上传凭证
 *   2. 只有「凭证 = 被打回」时，重新上传 和 通知 才能操作
 * ============================================================ */

/**
 * 缴费状态：这笔费用缴了没有
 *
 * ⚠️ 不叫 PayStatus —— enums.ts 里已经有一个给财务模块用的数字枚举 PayStatus
 *    （待缴/待核对/已缴/冻结），这里是中文字符串，命名要区分开。
 */
export enum PayPaidStatus {
  PAID = '已缴',
  UNPAID = '未缴',
}

export const PAY_PAID_STATUS_LIST = [PayPaidStatus.PAID, PayPaidStatus.UNPAID] as string[];

/** 缴费状态徽章配色 */
export const PAY_PAID_TAG_TYPE: Record<string, 'success' | 'info'> = {
  [PayPaidStatus.PAID]: 'success',
  [PayPaidStatus.UNPAID]: 'info',
};

/** 凭证状态：缴费凭证的审核状态 */
export enum CertStatus {
  /** 还没传凭证 */
  NONE = '未传',
  /** 已传且通过 */
  UPLOADED = '已传',
  /** 传了但被打回，需要重新上传 */
  REJECTED = '被打回',
}

export const CERT_STATUS_LIST = [
  CertStatus.NONE,
  CertStatus.UPLOADED,
  CertStatus.REJECTED,
] as string[];

/** 凭证状态徽章配色 */
export const CERT_STATUS_TAG_TYPE: Record<string, 'info' | 'success' | 'danger'> = {
  [CertStatus.NONE]: 'info',
  [CertStatus.UPLOADED]: 'success',
  [CertStatus.REJECTED]: 'danger',
};

/** 按钮不可点时的原因提示，前后端用同一份文案 */
export const UPLOAD_NEED_PAID_TIP = '该笔费用尚未缴纳，缴清后才能上传凭证';
export const UPLOAD_ALREADY_TIP = '凭证已上传，无需重复上传';
export const REUPLOAD_NEED_REJECT_TIP = '只有凭证被打回时才能重新上传';
export const NOTIFY_NEED_REJECT_TIP = '只有凭证被打回时才能发送通知';

/* ============================================================
 * 上传凭证 · 截图识别（OCR）
 *
 * 业务规则：教务点「上传 / 重新上传」后，先上传缴费截图，系统自动识别截图上的
 *           缴费金额 和 订单号 并回填到弹窗里；这两个框只读，不允许手改；
 *           点「确认」后才落库，列表里才看得到金额和订单号。
 *
 * 订单号为空的老数据处理：列表里显示「-」。
 * ============================================================ */

/** 识别失败 / 未传截图时的提示文案，前后端共用 */
export const OCR_NEED_IMAGE_TIP = '请先上传缴费截图';
export const OCR_FAILED_TIP = '未能从截图识别到缴费金额或订单号，请更换更清晰的截图重试';
export const OCR_READONLY_TIP = '金额和订单号由截图自动识别，不支持手动修改';

/** 上传凭证弹窗支持的截图格式 */
export const OCR_ACCEPT = '.jpg,.jpeg,.png,.bmp,.webp';

/** 截图大小上限：10MB */
export const OCR_MAX_SIZE_MB = 10;

/** 缴费总记录页「状态」筛选项：值和后端 list 接口的 frozenFilter 对应 */
export const PAY_STATUS_FILTERS = [
  { label: '全部', value: 'all' },
  { label: PAY_STATUS_NORMAL, value: 'normal' },
  { label: PAY_STATUS_FROZEN, value: 'frozen' },
] as const;

/* ============================================================
 * 学生状态 → 缴费自动冻结
 *
 * 业务规则：学生在读状态一旦变成「休学 / 退学」，TA 名下所有缴费记录
 *          由系统自动冻结，且不允许人工解冻 —— 要解冻必须先把学生状态改回在读。
 *
 * 这条规则在三个地方生效（见 payment.route.ts）：
 *   1. 学生档案改状态时同步落库
 *   2. 缴费列表查询时兜底判定（防止历史数据没同步到）
 *   3. 新建 / 导入缴费记录时即时判定
 * ============================================================ */

/** 会触发自动冻结的学生状态 */
export const AUTO_FROZEN_STUDENT_STATUSES = [
  StudentStatus.SUSPENDED,
  StudentStatus.QUIT,
] as const;

/** 该学生状态下，缴费记录是否属于系统自动冻结 */
export function isAutoFreezeStudentStatus(status?: number | null): boolean {
  return status != null && (AUTO_FROZEN_STUDENT_STATUSES as readonly number[]).includes(status);
}

/** 自动冻结时写进备注的文案，页面上的 tooltip 也用同一句 */
export const AUTO_FROZEN_TIP = '该学生已休学/退学，由系统自动冻结，需先在学生档案中恢复在读状态';

// ========== 数据结构 ==========

/** 缴费记录列表项 */
export interface PaymentItem {
  paymentId: string;
  /** 费用类别 */
  category: string;
  className?: string;
  headTeacherName?: string;
  /** 学号（关联学生档案，导入时没填学号则可能为空） */
  studentNo?: string;
  studentName: string;
  /** 学生状态：试学中 / 正式在读 / 休学 / 退学 …（取自学生档案，未关联到学生时为空） */
  studentStatusName?: string;
  /** 学生状态的数字值，前端用来判断「系统冻结」能不能手动解冻 */
  studentStatus?: number;
  /** 缴费时间 YYYY-MM-DD */
  payDate?: string;
  /** 到期时间 YYYY-MM-DD */
  expiryDate?: string;
  /**
   * 是否已被冻结（= 教务手动冻结，或学生休学/退学导致的系统冻结）
   */
  frozen: boolean;
  /**
   * 是否由「学生休学/退学」触发的系统冻结
   * ⚠️ true 时不允许人工解冻，必须先改回在读状态
   */
  autoFrozen?: boolean;
  /** 冻结状态文案：正常 / 已冻结 */
  payStatusName: string;
}

/** 即将到期列表项（从缴费记录派生） */
export interface ExpiringItem {
  paymentId: string;
  category: string;
  className?: string;
  headTeacherName?: string;
  /** 学号（关联学生档案，导入时没填学号则可能为空） */
  studentNo?: string;
  studentName: string;
  /** 缴费金额【单位：分】（上传凭证时由截图识别填入） */
  amount?: number;
  /** 支付订单号（上传凭证时由截图识别填入，未上传凭证时为空） */
  orderNo?: string;
  /** 缴费状态：已缴 / 未缴 */
  payStatus: string;
  payStatusName: string;
  /** 缴费时间 YYYY-MM-DD */
  payDate?: string;
  expiryDate?: string;
  /** 剩余天数：负数表示已过期 */
  daysLeft: number;
  /** 备注：剩余N天 / 已到期，请尽快处理 */
  remark: string;
  /** 凭证状态：未传 / 已传 / 被打回 */
  certStatus: string;
  certStatusName: string;
  /** 备注文字是否要用警示色（剩余 ≤7 天或已到期） */
  urgent: boolean;
  /** 内部催缴流转状态（待通知 / 待上传 / 已上传），页面上不展示，仅供批量操作判断 */
  expStatus: ExpStatus;
  expStatusName: string;
  certificateName?: string;
  uploadRemark?: string;
  /** 能否点「上传」：已缴 且 凭证未传 */
  canUpload: boolean;
  /** 能否点「重新上传」：凭证被打回 */
  canReupload: boolean;
  /** 能否点「通知」：凭证被打回 */
  canNotify: boolean;
  /** 按钮不可点时的原因，直接拿去当 tooltip */
  actionTip?: string;
}

/** 缴费总记录页的查询参数 */
export interface PaymentQuery {
  page?: number;
  size?: number;
  /** 类别 */
  category?: string;
  /** 班级 */
  className?: string;
  /** 冻结状态过滤：all / normal / frozen */
  frozenFilter?: 'all' | 'normal' | 'frozen';
  /** 关键字：匹配 类别/班级/班主任/姓名/缴费时间/到期时间 */
  keyword?: string;
}

/** 即将到期页的查询参数 */
export interface ExpiringQuery {
  page?: number;
  size?: number;
  category?: string;
  className?: string;
  expStatus?: string;
  /** 缴费状态筛选：已缴 / 未缴 */
  payStatus?: string;
  /** 凭证状态筛选：未传 / 已传 / 被打回 */
  certStatus?: string;
  keyword?: string;
}

/**
 * 批量上传凭证的入参
 *
 * 传了 ids 就只处理页面勾选的那几行（表格复选框选谁传谁）；
 * 不传 ids 才按筛选条件整批处理，保留给「一键处理当前筛选结果」用。
 */
export interface ExpiringBatchPayload extends ExpiringQuery {
  ids?: string[];
}

/** 批量上传的结果 */
export interface BatchUploadResult {
  /** 实际上传成功的条数 */
  count: number;
  /** 因「未缴」或「凭证已传」被跳过的条数 */
  skipped: number;
}

/** 新建缴费记录的入参 */
export interface PaymentSavePayload {
  category: string;
  className?: string;
  headTeacherName?: string;
  /** 学号：填了就和学生档案关联，页面上会带出学生状态 */
  studentNo?: string;
  studentName: string;
  /** 缴费金额【单位：分】 */
  amount?: number;
  /** 缴费状态：已缴 / 未缴，不传默认已缴 */
  payStatus?: string;
  payDate: string;
  expiryDate: string;
}

// ========== 统计 ==========

/** 缴费总记录 Tab 的统计卡 */
export interface PaymentTotalStats {
  /** 缴费总记录 */
  total: number;
  /** 正常（未冻结） */
  normal: number;
  /** 已冻结 */
  frozen: number;
  /** 临期记录 */
  expiring: number;
  /** 每个缴费类别各有多少条（子页签上显示的计数） */
  byCategory: Record<string, number>;
}

/** 即将到期 Tab 的统计卡（按当前类别子页统计） */
export interface PaymentExpiringStats {
  /** 临期总记录 */
  total: number;
  /** 已缴 */
  paid: number;
  /** 未缴 */
  unpaid: number;
  /** 凭证已传 */
  certUploaded: number;
  /** 凭证被打回，待重新上传 */
  certRejected: number;
  /** 每个缴费类别各有多少条临期（子页签上显示的计数） */
  byCategory: Record<string, number>;
}

// ========== 操作载荷 ==========

/** 批量冻结 / 解冻的入参 */
export interface BatchFreezePayload {
  /** 要操作的缴费记录 id 列表（页面上勾选的行） */
  ids: string[];
  /** true=冻结，false=解冻 */
  frozen: boolean;
}

/** 批量冻结 / 解冻的结果 */
export interface BatchFreezeResult {
  /** 本次实际发生变更的条数（已经是目标状态的不重复计入） */
  count: number;
  /** 因「学生休学/退学系统冻结」而被跳过的条数（只可能出现在解冻时） */
  skipped: number;
}

/**
 * 截图识别结果（POST /ocr 的返回）
 *
 * amount / orderNo 都可能为空 —— 识别不到就是空，前端只读展示，不给手填。
 * rawText 是 OCR 出来的原始文本，仅用于排查识别问题，页面上不展示。
 */
export interface OcrResult {
  /** 识别到的缴费金额【单位：分】 */
  amount?: number;
  /** 识别到的支付订单号 */
  orderNo?: string;
  /** OCR 原始文本（调试用） */
  rawText?: string;
  /** 是否至少识别出了一项 */
  recognized: boolean;
  /**
   * ⭐ 2026-10-15 新增：截图落盘后的相对地址，如 `/uploads/voucher/edu_xxx.png`
   *
   * 【为什么返回它】
   *   教务的缴费截图原先只在 OCR 时「路过」后端就被丢掉了 ——
   *   图片从来没落盘，所以财务侧永远看不到凭证（用户反馈的问题）。
   *   识别时顺手把图存下来、把地址带回去，前端点「确认」时再一并提交，
   *   由 `/upload` 落库并回传给财务。
   */
  certificateUrl?: string;
}

/** 上传凭证 */
export interface UploadCertificatePayload {
  id: string;
  certificateName?: string;
  uploadRemark?: string;
  /** 截图识别出的缴费金额【单位：分】（只读回填，不允许手改） */
  amount?: number;
  /** 截图识别出的订单号（只读回填，不允许手改） */
  orderNo?: string;
  /**
   * ⭐ 2026-10-15 新增：截图地址（来自 `/ocr` 的返回）
   *
   * 落库到 `t_edu_payment.certificate_url`，并由本模块回传给财务 ——
   * 财务侧「缴费管理」核对时看到的就是这张图。
   */
  certificateUrl?: string;
}

/**
 * ⭐ 2026-10-15 新增：上传凭证的返回
 *
 * 【为什么不是 void】
 *   教务上传凭证后还要把图回传给财务，这一步可能失败（财务没建对应缴费单 /
 *   财务服务没起 / 类别对不上）。如果只返回 null，页面上看不出来，
 *   就成了「教务以为传好了、财务其实没有」——这正是用户反馈的问题本质。
 *   所以把同步结果返回给页面，失败时能明确提示。
 */
export interface UploadCertificateResult {
  /** 是否已成功同步到财务（财务缴费管理里能看到这张凭证） */
  financeSynced: boolean;
  /** 未同步时的原因（已转成人话可直接展示）；成功时为 null */
  financeSyncMessage: string | null;
}

/** 批量/单个通知的结果 */
export interface NotifyResult {
  /** 本次通知成功的条数 */
  count: number;
}
