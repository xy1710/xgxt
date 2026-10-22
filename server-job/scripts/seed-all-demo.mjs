/**
 * ★★★ 全系统演示数据统一重建脚本 ★★★
 *
 * 用法：
 *    node scripts/seed-all-demo.mjs            # 重建（会先清空业务表）
 *    node scripts/seed-all-demo.mjs --dry      # 只打印计划，不写库
 *
 * ============================================================
 * 【它解决什么问题】
 *   合并成统一门户单体之前，6 个业务库各自被人塞过演示数据：
 *     · 学号三套体系互不相通（咨询 ZX000n / 大学部 S202600nn / 初高 S202600nn）
 *     · 同一学号在两库里是两个人（财务 S20260001=王梓涵 ≠ 初高 S20260001=王伟）
 *     · 班级的 head_teacher_id 挂的是旧体系（U_T001 / T001），
 *       与门户账号 ID 对不上 → 班主任按班取数永远为空
 *     · 咨询库里 50+ 条测试垃圾（"测试-不接收" / ZX0007 重复 20 条）
 *   本脚本把这 6 个库 + sms_common 的同步副本**一次性清空重建**，
 *   用【一套统一学号】造出贯通全链路的一套数据。
 *
 * 【统一学号体系】（跨库一致，认人只认学号）
 *   大学部   U26xxx   如 U26001
 *   初高部   J26xxx   如 J26001
 *   纯咨询线索 ZX26xxx 如 ZX26001（尚未定部门）
 *
 * 【链路覆盖】（造出来的数据要能跑通这些流转）
 *   咨询 → 大学部班级   待接收学员（2 条待接收 + 1 条已驳回 + 5 条已接收）
 *   咨询 → 初高         直建入班（2 条，不走审批）
 *   大学部 → 实训       升实训交接（5 人 U26011~U26015）
 *   财务 → 大学部班级   缴费副本 t_class_fee_sync
 *   财务 → 初高         缴费台账 t_class_fee（source_system='finance'）
 *   教务 → 大学部班级   催费 t_class_urge_sync（来自 t_job_fee_call）
 *   教务 → 大学部班级   宿舍 t_class_dorm_room_sync / t_class_dorm_live_sync
 *
 * ⚠️ 不动：sms_perm / sms_portal（账号与权限）与所有 knex_migrations 表。
 *    sms_perm.t_student_base 会被重灌（它是学生主档的影子表）。
 */

import { readFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRY = process.argv.includes('--dry');

/* ============================================================
 * 0.1 种子凭证图片
 *
 * ⚠️ 为什么需要这段：数据库里的 voucher_url 指向 /uploads/seed/*.png，
 *    但 uploads/ 被 .gitignore 忽略、种子数据本身也不带图片文件 ——
 *    不生成的话，财务在「缴费管理」点开凭证就是 404（截图加载失败），
 *    这正是 2026-10-15 用户反馈的「其他模块上传的缴费凭证财务无法查看」。
 *
 *    做法：仓库里随包分发一组示例凭证图（assets/sample-vouchers/），
 *    种子脚本按「费用类型 + 部门」把对应那张复制到 uploads/seed/ 下。
 * ============================================================ */

/** 示例凭证图目录（随仓库分发） */
const SAMPLE_VOUCHER_DIR = resolve(__dirname, '..', 'assets', 'sample-vouchers');
/** 种子凭证落盘目录（与 app.ts 里 /uploads 的静态托管根**必须一致**） */
const SEED_UPLOAD_DIR = resolve(__dirname, '..', 'uploads', 'seed');

/** 本脚本生成过的文件名，避免重复复制 */
const generatedVouchers = new Set();

/**
 * 按「费用类型 + 部门」生成一张种子凭证图片
 *
 * @param {string} fileName 目标文件名，如 voucher-J26001-1.png
 * @param {number} feeType  费用类型 1~5，决定用哪张示例图
 * @param {number} deptCode 部门 1 二三期 / 2 大学部
 */
function ensureSeedVoucher(fileName, feeType, deptCode) {
  if (DRY || !fileName || generatedVouchers.has(fileName)) return;
  generatedVouchers.add(fileName);

  const ft = [1, 2, 3, 4, 5].includes(Number(feeType)) ? Number(feeType) : 1;
  const dp = Number(deptCode) === 2 ? 2 : 1;
  const src = resolve(SAMPLE_VOUCHER_DIR, `voucher-type${ft}-dept${dp}.png`);
  const dst = resolve(SEED_UPLOAD_DIR, fileName);

  try {
    if (!existsSync(SEED_UPLOAD_DIR)) mkdirSync(SEED_UPLOAD_DIR, { recursive: true });
    if (!existsSync(dst)) copyFileSync(src, dst);
  } catch (e) {
    // 生成失败不阻断 seed：只是财务侧暂时看不到那张图
    console.warn(`[seed] 生成种子凭证图失败 ${fileName}: ${e.message}`);
  }
}

/* ============================================================
 * 0. 连接配置（读 server-job/.env）
 * ============================================================ */

function loadEnv() {
  const env = {};
  try {
    const raw = readFileSync(resolve(__dirname, '../.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    /* 没有 .env 就用下面默认 */
  }
  return env;
}

const ENV = loadEnv();
const CONN = {
  host: ENV.DB_HOST || '127.0.0.1',
  port: Number(ENV.DB_PORT || 3306),
  user: ENV.DB_USER || 'root',
  password: ENV.DB_PASSWORD || '',
  multipleStatements: true,
  charset: 'utf8mb4',
};

const DB = {
  job: ENV.DB_NAME || 'sms_job',
  edu: ENV.DB_NAME_EDU || 'sms_edu',
  cls: ENV.DB_NAME_CLASS || 'sms_class',
  cjh: ENV.DB_NAME_CLASS_JH || 'sms_class_jh',
  common: ENV.DB_NAME_COMMON || 'sms_common',
  consult: ENV.DB_NAME_CONSULT || 'sms_consult',
  finance: ENV.DB_NAME_FINANCE || 'sms_finance',
  perm: ENV.DB_NAME_PERM || 'sms_perm',
};

/* ============================================================
 * 1. 常量：门户账号（t_sys_account.id）—— 班级负责人必须挂这些 ID
 * ============================================================ */

/**
 * ★★ 2026-10-06 修复：「班主任/就业老师登录后没有数据」
 *
 * 【原来错在哪】
 *   这里原来把 13 个门户账号的 UUID **写死**了。但其中 6 个
 *   （qiansy / congym / zhanght / sunmin / zhengym / zhouj）
 *   在交付包里并不存在 —— 它们由 `npm run seed:portal` 现建，
 *   而门户账号的 id 是**入库时随机生成的 UUID**。
 *   于是硬编码值和真实值对不上，班主任/就业老师被挂到了
 *   「查无此人」的 ID 上：
 *     · 班级模块 fillClassIds() 查 `t_class_info.head_teacher_id = 当前登录人 id`
 *       → 查空 → req.user.classIds = [] → 班主任看不到任何班级/学生
 *     · 就业模块按 `t_job_class.employment_teacher_id` 取「我的班级」
 *       → 查空 → 就业老师列表全空
 *   （包里自带的 7 个账号 admin/zhoum/liukj/linx/wangjl/zhangls/lilx
 *     因为是从 sms_portal.sql 原样导入的，id 固定，所以不受影响。）
 *
 * 【怎么修】
 *   把下面的值降级为**兜底值**，启动时按 account 从
 *   `sms_portal.t_sys_account` 现查真实 id 覆盖（见 resolvePortalIds）。
 *   这样无论账号是谁、什么时候建的，都能对上。
 */
const PORTAL_FALLBACK = {
  admin: 'f67aa1f0-cbeb-3f59-2bb9-355e8530cf57',
  qiansy: 'a414dfaf-1598-42e3-b6d9-de8e867600ee',
  congym: '9be40e5e-39c4-4d4d-bd31-fbc74093db4c',
  zhanght: '13a26e90-1dda-47cd-8762-5bd62f308d19',
  sunmin: 'bb9643b1-49c3-4b27-b288-e07fdb767be5',
  zhengym: '963e649a-4e3f-4539-90c4-080cc754b706',
  zhouj: '7352e70e-4a64-4489-a098-57c6a9604f4c',
  zhoum: '9e73138b-d35e-de46-9873-3836bed7cd60',
  liukj: '1d20dc8b-825f-e496-35c4-82585029ef8a',
  linx: '43575dc6-50ef-05ec-b6b3-dee3cace36e2',
  wangjl: '580b3414-8b48-99b0-1f30-dde66d9ca8fe',
  zhangls: '0e3fc0db-b0de-7bdc-0194-a3a7f126df0d',
  lilx: '31405408-2041-e9b3-9844-427a5df70a49',
};

/** 运行时实际使用的门户 id（启动时由 resolvePortalIds 校准） */
const PORTAL = { ...PORTAL_FALLBACK };

/**
 * ★★★ 权限库用户 id（`U004` / `U_sunjl` …）—— **业务表责任人列必须用这个**
 *
 * 【为什么必须用 permUserId 而不是门户 UUID】
 *   后端 `src/middleware/auth.ts` 的注释写得很明确：
 *     `businessUserId` (= permUserId) —— 「业务表责任人列用它做『我带的班』过滤」
 *   即数据权限过滤走的是：
 *     `user.businessUserId || user.userId`  → 与业务表的 head_teacher_id 比较
 *   而 permUserId 是**优先值**。如果业务表里填门户 UUID，权限库又查得到账号
 *   （businessUserId 非空 = U004），比较时 `U004 ≠ 85a47f05-…` → 永远匹配不上
 *   → 班主任/项目经理登录后「我带的班」查空 → 页面 0 条。
 *
 *   （实测：本机能正常显示的机器，数据里就是 `U004`；而本脚本原先填的是门户 UUID。）
 *
 * 【为什么不能把编号写死】
 *   权限库里编号格式并不统一：老账号是 `U001`~`U021`，
 *   后建的是 `U_sunjl` / `U_chenxf` / `U_zhaomx`（带账号名）。
 *   → 只能**按 account 实时查**。
 */
const PERMID = {};

/** 从 sms_perm.t_perm_user 按 account 查权限库 id，并回填 S.<key>.id */
async function resolvePermIds(conn) {
  const permDb = ENV.DB_NAME_PERM || 'sms_perm';
  try {
    const [rows] = await conn.query(
      `SELECT account, id FROM \`${permDb}\`.t_perm_user WHERE is_deleted = 0`,
    );
    const byAcc = new Map(rows.map((r) => [String(r.account), String(r.id)]));

    const missing = [];
    for (const acc of Object.values(STAFF_ACCOUNT)) {
      const real = byAcc.get(acc);
      if (!real) {
        missing.push(acc);
        continue;
      }
      PERMID[acc] = real;
    }

    // ★ 回填 S（岗位 → 权限库 id）—— 业务表责任字段全部用它
    for (const [key, acc] of Object.entries(STAFF_ACCOUNT)) {
      if (S[key] && PERMID[acc]) S[key].id = PERMID[acc];
    }

    const filled = Object.keys(PERMID).length;
    say(`  业务责任人 ID 校准：${filled} 个岗位已按 ${permDb}.t_perm_user 取到权限库 id（如 ${STAFF_ACCOUNT.headU}=${PERMID[STAFF_ACCOUNT.headU] || '?'}）`);
    if (missing.length) {
      say(`  ⚠️ ${permDb}.t_perm_user 里找不到：${missing.join(', ')} —— 相关责任人字段会为空。`);
    }
  } catch (e) {
    say(`  ⚠️ 权限库 id 校准失败（业务责任人列会挂空，班主任将看不到数据）：${e.message}`);
  }
}

/** S 里每个岗位对应哪个门户账号 —— 校准时回填 S.<key>.id 用 */
const STAFF_ACCOUNT = {
  principal: 'qiansy',
  dean: 'congym',
  headU: 'zhanght',
  headJ: 'sunmin',
  acad: 'zhengym',
  job: 'zhouj',
  /* ★ 2026-10-15 新增：项目经理（孙建龙）。
   *   业务上「项目经理 = 实训阶段的班主任」（斌哥 2026-10-15 明确），
   *   所以实训班的 head_teacher_id / project_manager_id 都挂他，
   *   他登录后才能在「学生档案 / 班级管理」里看到自己带的班。 */
  pm: 'sunjl',
  finMgr: 'zhoum',
  finStaff: 'liukj',
};

/** 咨询库自己的账号 ID（t_consult_account.id）—— owner_id 用它 */
const CONSULT_ACCT = {
  admin: 'cf9463d2-c420-417e-9d7f-7f56e472abf8',
  wangjl: '1b6c0d9d-f07f-4808-9b75-0763f68690ff',
  zhangls: '278d7a01-b3bc-45e1-84aa-154d02734351',
  lilx: 'a964420e-2f15-4eea-a565-75b58a0eb626',
};

/**
 * 岗位 → 责任人（id 会在运行时被 resolvePermIds 覆盖成**权限库 id**）
 *   ⚠️ 这里的 `PORTAL.xxx` 只是占位；真正写进业务表的是 permUserId（U004…），
 *      否则班主任/项目经理的「我带的班」过滤会匹配不上（详见 PERMID 注释）。
 */
const S = {
  principal: { id: PORTAL.qiansy, name: '钱守义' },   // 校长
  dean: { id: PORTAL.congym, name: '丛玉梅' },        // 学管主任
  headU: { id: PORTAL.zhanght, name: '张海涛' },      // 大学部班主任
  headJ: { id: PORTAL.sunmin, name: '孙敏' },         // 初高班主任
  acad: { id: PORTAL.zhengym, name: '郑一鸣' },       // 教务老师
  job: { id: PORTAL.zhouj, name: '周杰' },            // 就业老师
  /* ★ 项目经理（孙建龙）—— 业务上等同「实训阶段的班主任」，
   *   所以实训班的班主任/项目经理解字段都挂他。id 初始为空，由 resolvePermIds 回填。 */
  pm: { id: '', name: '孙建龙' },
  finMgr: { id: PORTAL.zhoum, name: '周铭' },     // 财务负责人
  finStaff: { id: PORTAL.liukj, name: '刘会计' },     // 财务专员
};

/* 枚举（与 shared-types 数值契约一致，这里不引 TS，直接写字面量） */
const E = {
  ST_TRIAL: 3, ST_STUDYING: 5, ST_SUSPENDED: 6, ST_QUIT: 7, ST_TRAINING: 8,
  CLS_OPEN: 1, CLS_CLOSED: 2, CLS_TRAINING: 5,
  PAY_UNPAID: 1, PAY_PAID: 2, PAY_VERIFIED: 3, PAY_OVERDUE: 4, PAY_FROZEN: 5,
  FEE_TUITION: 1, FEE_DORM: 2, FEE_MEAL: 3, FEE_INSURANCE: 4, FEE_TRIAL: 5,
  PUSH_PENDING: 1, PUSH_RECEIVED: 2, PUSH_REJECTED: 3,
  CONSULT_NO_VOUCHER: 0, CONSULT_PENDING: 1, CONSULT_ARRIVED: 2, CONSULT_REJECTED: 3,
  CST_WAIT_ASSIGN: 1, CST_WAIT_INTERVIEW: 2, CST_TRIAL_WAIT_CLASS: 4,
  CST_TRIAL: 5, CST_FULL_FEE_PENDING: 6, CST_FORMAL: 7,
  CST_NOT_ENROLLED: 11, CST_LOST: 12,
  DEPT_JH: 1, DEPT_UNIV: 2, DEPT_EMP: 3, // 2026-10-19：就业部（实训也归它）
};

/* 缴费标准（分）——与财务 t_finance_fee_standard 一致 */
const STDD = { 1: 1280000, 2: 360000, 3: 180000, 4: 30000, 5: 98000 };            // 初高/二三期
const STDU = { 1: 1580000, 2: 420000, 3: 210000, 4: 30000, 5: 98000 };            // 大学部
const feeStd = (dept, type) => (dept === E.DEPT_JH ? STDD[type] : STDU[type]);

const TODAY = new Date();
const D = (offsetDays) => {
  const d = new Date(TODAY);
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};
const DT = (offsetDays) => `${D(offsetDays)} 09:00:00`;

/* ============================================================
 * 2. 班级定义
 * ============================================================ */

const UNIV_CLASSES = [
  {
    // ★ 2026-10-06：特意放在【六阶段（206）】且未升实训 →
    //   左侧「班级管理 → 班级管理」该行会出现「升实训」按钮，
    //   点开即演示「选项目经理 + 就业指导老师 → 交接到就业管理」的完整流程。
    id: 'CLS-U2601', name: 'U2601', stage: 206, head: S.headU,
    room: '教学楼 A-101', students: ['U26001', 'U26002', 'U26003', 'U26004', 'U26005'],
  },
  {
    // 这台班停在三阶段，用来演示「阶段推进」逐级往上走
    id: 'CLS-U2602', name: 'U2602', stage: 203, head: S.headU,
    room: '教学楼 A-102', students: ['U26006', 'U26007', 'U26008', 'U26009', 'U26010'],
  },
];

const JH_CLASSES = [
  {
    id: 'CLS-JH-G2601', name: 'G2601', stage: 102, head: S.headJ, teacher: S.headJ, room: '综合楼 201',
    students: ['J26001', 'J26002', 'J26003', 'J26004', 'J26005', 'J26011', 'J26013'],
  },
  {
    id: 'CLS-JH-J2602', name: 'J2602', stage: 105, head: S.headJ, teacher: S.headJ, room: '综合楼 202',
    students: ['J26006', 'J26007', 'J26008', 'J26009', 'J26010', 'J26012', 'J26014'],
  },
];

const JOB_CLASS = {
  id: 'CLS-JOB-SX2601', name: 'SX2601', stage: 301, head: S.job,
  room: '实训基地 B-1', students: ['U26011', 'U26012', 'U26013', 'U26014', 'U26015'],
};

/* ============================================================
 * 3. 主名单（唯一事实来源）—— 学号 / 姓名 / 性别 / 年龄 / 部门 / 状态
 * ============================================================ */

/** [学号, 姓名, 性别(1男2女), 年龄, 状态] */
const UNIV_STUDENTS = [
  ['U26001', '张子轩', 1, 18, E.ST_STUDYING],
  ['U26002', '李子涵', 2, 19, E.ST_STUDYING],
  ['U26003', '王子墨', 1, 18, E.ST_STUDYING],
  ['U26004', '刘雨桐', 2, 19, E.ST_STUDYING],
  ['U26005', '陈思远', 1, 18, E.ST_STUDYING],
  ['U26006', '杨静怡', 2, 19, E.ST_STUDYING],
  ['U26007', '赵一鸣', 1, 18, E.ST_STUDYING],
  ['U26008', '孙浩然', 1, 19, E.ST_STUDYING],
  ['U26009', '周晓彤', 2, 18, E.ST_STUDYING],
  ['U26010', '吴子豪', 1, 19, E.ST_STUDYING],
  ['U26011', '郑凯文', 1, 18, E.ST_TRAINING],
  ['U26012', '林欣怡', 2, 19, E.ST_TRAINING],
  ['U26013', '黄子睿', 1, 18, E.ST_TRAINING],
  ['U26014', '徐天佑', 1, 19, E.ST_TRAINING],
  ['U26015', '冯雪晴', 2, 18, E.ST_TRAINING],
  ['U26016', '马志远', 1, 18, E.ST_STUDYING], // 咨询已推送 → 待接收
  ['U26017', '何静宜', 2, 19, E.ST_STUDYING], // 咨询已推送 → 待接收
  ['U26018', '高远航', 1, 18, E.ST_STUDYING], // 咨询已推送 → 被驳回，可再分派
];

const JH_STUDENTS = [
  ['J26001', '王伟', 1, 15, E.ST_STUDYING],
  ['J26002', '李芳', 2, 14, E.ST_STUDYING],
  ['J26003', '张娜', 2, 15, E.ST_STUDYING],
  ['J26004', '刘敏', 2, 14, E.ST_STUDYING],
  ['J26005', '陈静', 2, 15, E.ST_STUDYING],
  ['J26006', '杨强', 1, 16, E.ST_STUDYING],
  ['J26007', '赵磊', 1, 17, E.ST_STUDYING],
  ['J26008', '黄艳', 2, 16, E.ST_STUDYING],
  ['J26009', '周勇', 1, 17, E.ST_STUDYING],
  ['J26010', '吴军', 1, 16, E.ST_STUDYING],
  ['J26011', '邓雨欣', 2, 14, E.ST_STUDYING], // 咨询直建入班
  ['J26012', '罗佳怡', 2, 16, E.ST_STUDYING], // 咨询直建入班
  ['J26013', '陈嘉豪', 1, 15, E.ST_QUIT],
  ['J26014', '梁诗涵', 2, 17, E.ST_SUSPENDED],
];

/** 纯咨询线索（还没定部门） [学号, 姓名, 性别, 年龄, 咨询状态] */
const LEAD_STUDENTS = [
  ['ZX26001', '唐俊杰', 1, 18, E.CST_WAIT_ASSIGN],
  ['ZX26002', '苏雅雯', 2, 17, E.CST_WAIT_INTERVIEW],
  ['ZX26003', '谢铭轩', 1, 16, E.CST_NOT_ENROLLED],
  ['ZX26004', '郭子睿', 1, 19, E.CST_LOST],
];

/** 咨询已分班的名单：[学号, 咨询单号, 归属咨询师, 分班去向, 状态] */
const CONSULT_PLACED = [
  // 已推送 + 班主任已接收（大学部）
  ['U26006', 'ZX20261001001', 'zhangls', { kind: 'univ', classId: 'CLS-U2602' }, E.PUSH_RECEIVED],
  ['U26007', 'ZX20261001002', 'zhangls', { kind: 'univ', classId: 'CLS-U2602' }, E.PUSH_RECEIVED],
  ['U26008', 'ZX20261001003', 'lilx', { kind: 'univ', classId: 'CLS-U2602' }, E.PUSH_RECEIVED],
  ['U26009', 'ZX20261001004', 'lilx', { kind: 'univ', classId: 'CLS-U2602' }, E.PUSH_RECEIVED],
  ['U26010', 'ZX20261001005', 'wangjl', { kind: 'univ', classId: 'CLS-U2602' }, E.PUSH_RECEIVED],
  // 已推送 → 待接收（显示在「待接收学员」）
  ['U26016', 'ZX20261001006', 'zhangls', { kind: 'univ', classId: 'CLS-U2601' }, E.PUSH_PENDING],
  ['U26017', 'ZX20261001007', 'lilx', { kind: 'univ', classId: 'CLS-U2602' }, E.PUSH_PENDING],
  // 已推送 → 被驳回（可重新分派）
  ['U26018', 'ZX20261001008', 'wangjl', { kind: 'univ', classId: 'CLS-U2601' }, E.PUSH_REJECTED],
  // 初高：咨询直建入班（不走班主任审批）
  ['J26011', 'ZX20261001009', 'zhangls', { kind: 'jh', classId: 'CLS-JH-G2601' }, E.PUSH_RECEIVED],
  ['J26012', 'ZX20261001010', 'lilx', { kind: 'jh', classId: 'CLS-JH-J2602' }, E.PUSH_RECEIVED],
];

const ALL_UNIV = UNIV_STUDENTS.map((r) => ({ no: r[0], name: r[1], gender: r[2], age: r[3], status: r[4], dept: E.DEPT_UNIV }));
const ALL_JH = JH_STUDENTS.map((r) => ({ no: r[0], name: r[1], gender: r[2], age: r[3], status: r[4], dept: E.DEPT_JH }));
const ALL_STUDENTS = [...ALL_UNIV, ...ALL_JH];
const stuByNo = new Map(ALL_STUDENTS.map((s) => [s.no, s]));

/* ============================================================
 * 4. 工具
 * ============================================================ */

const NOW = () => new Date();
const log = [];
function say(msg) { log.push(msg); console.log(msg); }

/** 基础审计列 */
const base = (id, extra = {}) => ({
  id, create_time: NOW(), create_by: 'SEED', update_time: NOW(), update_by: 'SEED', is_deleted: 0, ...extra,
});

/**
 * 列名缓存 —— 各表的真实列集合。
 * ⚠️ 必须过滤：有些表缺 update_time / update_by（如 t_consult_history / t_job_approval_log），
 *    直接把统一审计列塞进去会报 Unknown column。
 */
const COL_CACHE = new Map();
async function tableColumns(conn, qualified) {
  if (COL_CACHE.has(qualified)) return COL_CACHE.get(qualified);
  const [db, t] = qualified.split('.');
  const [rows] = await conn.query(
    'SELECT COLUMN_NAME AS c, IS_NULLABLE AS n, COLUMN_DEFAULT AS d, EXTRA AS e FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
    [db, t],
  );
  if (!rows.length) throw new Error(`表不存在或不可读：${qualified}`);
  const isAuto = (r) => String(r.e).includes('auto_increment');
  const isGenerated = (r) => String(r.e).includes('GENERATED');
  const meta = {
    // ⚠️ 生成列（如 t_job_class_student.uk_in_class）不能显式写入，务必剔除
    all: new Set(rows.filter((r) => !isGenerated(r)).map((r) => r.c)),
    generated: new Set(rows.filter(isGenerated).map((r) => r.c)),
    // NOT NULL 且无默认值、非自增的列 —— 这些列的 undefined 会被 MySQL 拒绝，提前报清楚
    required: new Set(
      rows.filter((r) => r.n === 'NO' && r.d === null && !isAuto(r) && !isGenerated(r)).map((r) => r.c),
    ),
  };
  COL_CACHE.set(qualified, meta);
  return meta;
}

async function insertMany(conn, table, rows) {
  if (!rows.length) return 0;
  if (DRY) return rows.length;
  const meta = await tableColumns(conn, table);
  const cols = Object.keys(rows[0]).filter((c) => meta.all.has(c));
  const dropped = Object.keys(rows[0]).filter((c) => !meta.all.has(c) && !meta.generated.has(c));
  if (dropped.length) say(`    ⚠ ${table} 忽略不存在的列：${dropped.join(', ')}`);

  // 提前发现「NOT NULL 列拿了 undefined」——比 MySQL 的 ER_BAD_NULL_ERROR 好定位
  for (const [i, r] of rows.entries()) {
    for (const c of cols) {
      if (r[c] === undefined && meta.required.has(c)) {
        throw new Error(`${table} 第 ${i + 1} 行（${r.id ?? '?'}）的必填列 ${c} 是 undefined`);
      }
    }
  }

  const sql = `INSERT INTO ${table} (${cols.map((c) => `\`${c}\``).join(',')}) VALUES ?`;
  const values = rows.map((r) => cols.map((c) => (r[c] === undefined ? null : r[c])));
  await conn.query(sql, [values]);
  return rows.length;
}

const phone = (i) => `138${String(10000000 + i).slice(-8)}`;
const parentPhone = (i) => `139${String(10000000 + i).slice(-8)}`;
const idCard = (i, age) => `410100${2026 - age}0${String(i).padStart(4, '0')}${String(i % 9000 + 1000)}`;

/** 学号 → 稳定序号（用于生成手机号等） */
const seqOf = (no) => Number(no.replace(/\D/g, '')) || 0;

/* ============================================================
 * 5. 清空
 * ============================================================ */

const CLEAR_DBS = [DB.consult, DB.finance, DB.cls, DB.cjh, DB.edu, DB.job, DB.common];

async function truncateAll(conn) {
  await conn.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const db of CLEAR_DBS) {
    const [tables] = await conn.query(
      'SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME NOT LIKE ?',
      [db, 'knex%'],
    );
    for (const { t } of tables) {
      if (DRY) continue;
      const [r] = await conn.query(`DELETE FROM \`${db}\`.\`${t}\``);
      say(`  清空 ${db}.${t} → ${r.affectedRows} 行`);
    }
  }
  // sms_perm / sms_portal 整体保留（账号、角色、门户账号都是「配置」不是「业务数据」），
  // 但 perm 里的 **学生影子表** t_student_base 是业务数据，必须一并清掉，
  // 否则重跑会撞主键 'PSB-<学号>'（第一次跑成功、第二次跑 ER_DUP_ENTRY 的坑）。
  const [pr] = await conn.query(`DELETE FROM \`${DB.perm}\`.\`t_student_base\``);
  say(`  清空 ${DB.perm}.t_student_base → ${pr.affectedRows} 行`);
  await conn.query('SET FOREIGN_KEY_CHECKS = 1');
}

/* ============================================================
 * 6. 种子：财务（sms_finance）—— 全系统的缴费权威源
 * ============================================================ */

const FIN = { fees: [], stds: [] };

async function seedFinance(conn) {
  say('\n【1/7】财务 sms_finance');

  // 6.1 缴费标准
  for (const dept of [E.DEPT_JH, E.DEPT_UNIV]) {
    for (const t of [1, 2, 3, 4, 5]) {
      FIN.stds.push(base(`STD-${dept}-${t}`, {
        fee_type: t, dept_code: dept, amount: feeStd(dept, t), is_enabled: 1,
        remark: `${dept === E.DEPT_JH ? '二三期' : '大学部'}标准`,
      }));
    }
  }
  await insertMany(conn, `${DB.finance}.t_finance_fee_standard`, FIN.stds);

  // 6.2 学生主档（全量 32 人）
  const baseRows = ALL_STUDENTS.map((s) => {
    const cls = classOfStudent(s.no);
    return base(`FSB-${s.no}`, {
      student_no: s.no, student_name: s.name, gender: s.gender, age: s.age,
      dept_code: s.dept, class_id: cls?.id ?? null, class_name: cls?.name ?? null,
      head_teacher_id: cls?.head.id ?? null, head_teacher_name: cls?.head.name ?? null,
      student_status: s.status, stage: cls?.stage ?? null,
      phone: phone(seqOf(s.no)), parent_phone: parentPhone(seqOf(s.no)),
      education: s.dept === E.DEPT_JH ? '初中' : '高中',
      enroll_date: D(-120), attendance_rate: 96.5, repeat_count: 0, remark: '演示数据',
    });
  });
  await insertMany(conn, `${DB.finance}.t_student_base`, baseRows);

  // 6.3 缴费记录
  //   ★ 已分班的咨询学员 → 学费「已缴（已核对）」=3，这样咨询侧「分班」按钮才出得来
  //     （前端要求 order.status === 已到账）
  const rows = [];
  let n = 0;
  const pushFee = (s, cls, feeType, payStatus, offsetDays, period) => {
    n += 1;
    const id = `FEE-${s.no}-${feeType}`;
    // ★ 2026-10-15：凭证图片必须真的落盘，否则财务点开就是 404
    const hasVoucher = payStatus >= E.PAY_PAID;
    const voucherFile = `voucher-${s.no}-${feeType}.png`;
    if (hasVoucher) ensureSeedVoucher(voucherFile, feeType, s.dept);
    rows.push(base(id, {
      student_id: `FSB-${s.no}`, student_no: s.no, student_name: s.name,
      class_id: cls?.id ?? null, class_name: cls?.name ?? null,
      dept_code: s.dept, head_teacher_id: cls?.head.id ?? null, head_teacher_name: cls?.head.name ?? null,
      fee_type: feeType, amount: feeStd(s.dept, feeType),
      pay_status: payStatus, pay_date: payStatus >= E.PAY_PAID ? D(offsetDays) : null,
      expire_date: D(offsetDays + 180), period,
      voucher_url: hasVoucher ? `/uploads/seed/${voucherFile}` : null,
      voucher_no: hasVoucher ? `PZ${s.no}${feeType}` : null,
      is_verified: payStatus === E.PAY_VERIFIED ? 1 : 0,
      verified_by: payStatus === E.PAY_VERIFIED ? S.finMgr.id : null,
      verified_by_name: payStatus === E.PAY_VERIFIED ? S.finMgr.name : null,
      verified_time: payStatus === E.PAY_VERIFIED ? NOW() : null,
      is_in_bill: payStatus === E.PAY_VERIFIED ? 1 : 0,
      source_module: 0, remark: `第 ${n} 条演示缴费`,
    }));
    return id;
  };

  for (const s of ALL_STUDENTS) {
    const cls = classOfStudent(s.no);
    const placed = CONSULT_PLACED.find((p) => p[0] === s.no);
    let tuitionStatus, dormStatus, mealStatus;
    if (placed) {
      // 咨询推过来的 → 全款到账
      tuitionStatus = E.PAY_VERIFIED; dormStatus = E.PAY_VERIFIED; mealStatus = E.PAY_PAID;
    } else if (s.status === E.ST_QUIT) {
      tuitionStatus = E.PAY_PAID; dormStatus = E.PAY_OVERDUE; mealStatus = E.PAY_UNPAID;
    } else if (s.status === E.ST_SUSPENDED) {
      tuitionStatus = E.PAY_VERIFIED; dormStatus = E.PAY_FROZEN; mealStatus = E.PAY_UNPAID;
    } else {
      // 校内直招：学费已核对、住宿已缴、餐费有欠
      tuitionStatus = E.PAY_VERIFIED; dormStatus = E.PAY_VERIFIED;
      mealStatus = seqOf(s.no) % 3 === 0 ? E.PAY_OVERDUE : E.PAY_UNPAID;
    }
    pushFee(s, cls, E.FEE_TUITION, tuitionStatus, -90, '2026-09-01~2027-02-28');
    if (s.status !== E.ST_QUIT) {
      pushFee(s, cls, E.FEE_DORM, dormStatus, -90, '2026-09-01~2027-02-28');
      pushFee(s, cls, E.FEE_MEAL, mealStatus, -30, '2026-10-01~2026-10-31');
    }
  }

  // 6.4 纯线索的试学费单（未到账，演示"待上传凭证/待确认"）
  for (const [no, name, , , ] of LEAD_STUDENTS) {
    const st = stuByNo.get(no) ?? { no, name, dept: E.DEPT_JH, gender: 1, age: 18, status: 1 };
    pushFee({ ...st, dept: E.DEPT_JH }, null, E.FEE_TRIAL,
      no === 'ZX26002' ? E.PAY_PAID : E.PAY_UNPAID, -5, '试学 7 天');
  }

  FIN.fees = rows;
  await insertMany(conn, `${DB.finance}.t_finance_fee`, rows);

  // 6.5 缴费单（已核对入账的流水）
  const bills = rows.filter((r) => r.pay_status === E.PAY_VERIFIED).map((r, i) => base(`BILL-${i + 1}`, {
    bill_no: `BILL2026${String(i + 1).padStart(4, '0')}`,
    bill_type: 1, source_id: r.id, source_no: r.id,
    student_id: r.student_id, student_no: r.student_no, student_name: r.student_name,
    class_id: r.class_id, class_name: r.class_name, dept_code: r.dept_code,
    head_teacher_name: r.head_teacher_name, fee_type: r.fee_type, amount: r.amount,
    bill_date: D(-60), operator_id: S.finStaff.id, operator_name: S.finStaff.name,
    voucher_no: r.voucher_no, pay_method: 1, remark: '演示入账流水',
  }));
  await insertMany(conn, `${DB.finance}.t_finance_bill`, bills);

  // 6.6 冻结（休学学生）
  const frozen = ALL_STUDENTS.filter((s) => s.status === E.ST_SUSPENDED).map((s) => {
    const cls = classOfStudent(s.no);
    return base(`FRZ-${s.no}`, {
      student_id: `FSB-${s.no}`, student_no: s.no, student_name: s.name,
      class_id: cls?.id ?? null, class_name: cls?.name ?? null, dept_code: s.dept,
      student_status: s.status, freeze_scope: 'meal,dorm',
      meal_from: D(-10), meal_expire: D(20), meal_rest_days: 20,
      dorm_from: D(-10), dorm_expire: D(20), dorm_rest_days: 20,
      freeze_reason: '休学', freeze_date: D(-10), freeze_source: 1,
      operator_id: S.finMgr.id, operator_name: S.finMgr.name, is_frozen: 1,
    });
  });
  await insertMany(conn, `${DB.finance}.t_finance_freeze`, frozen);

  // 6.7 退费单（1 条走到财务打款）
  const quit = ALL_STUDENTS.find((s) => s.no === 'J26013');
  const qcls = classOfStudent('J26013');
  await insertMany(conn, `${DB.finance}.t_finance_refund`, [
    base('RFD-1', {
      order_no: 'TK20261001001', student_id: `FSB-${quit.no}`, student_no: quit.no, student_name: quit.name,
      class_id: qcls?.id ?? null, class_name: qcls?.name ?? null, dept_code: quit.dept,
      refund_type: 1, refund_amount: 500000, refund_reason: '退学退费',
      refund_status: 6, source_type: 1, apply_time: DT(-20),
      applicant_id: S.headJ.id, applicant_name: S.headJ.name,
      manager_approve_time: DT(-18), manager_approve_by: S.dean.id,
      academic_check_time: DT(-16), academic_check_by: S.acad.id,
      pushed_time: DT(-15), finance_pay_time: DT(-12), finance_pay_by: S.finMgr.id,
      is_in_bill: 1, remark: '演示退费',
    }),
  ]);

  say(`  ✓ 学生主档 ${baseRows.length} · 缴费 ${rows.length} · 入账流水 ${bills.length} · 冻结 ${frozen.length} · 退费 1`);
}

/* ============================================================
 * 7. 种子：咨询（sms_consult）
 * ============================================================ */

function seedConsult(conn) {
  say('\n【2/7】咨询 sms_consult');

  const students = [];

  // 7.1 纯线索
  for (const [no, name, gender, age, cst] of LEAD_STUDENTS) {
    const owner = no === 'ZX26001' ? CONSULT_ACCT.zhangls : CONSULT_ACCT.lilx;
    const ownerName = no === 'ZX26001' ? '张老师' : '李老师';
    students.push(base(`CST-${no}`, {
      student_no: no, student_name: name, gender, age,
      phone: phone(seqOf(no)), dept_code: null,
      birthday: `${2026 - age}-05-12`, source_channel: 2, source_remark: '线上留资',
      owner_id: owner, owner_name: ownerName, owner_title: '咨询师',
      intend_course: 'IT 就业班', parent_contact: '父亲', parent_phone: parentPhone(seqOf(no)),
      id_card: idCard(seqOf(no), age), school: '郑州市第某中学', address: '河南省郑州市金水区',
      target_college: '郑州大学', pay_mode: '一次性',
      remark: cst === E.CST_LOST ? '明确不来了' : '待跟进',
      consult_state: cst,
      student_status: cst === E.CST_WAIT_ASSIGN ? 1 : cst === E.CST_WAIT_INTERVIEW ? 2 : 11,
      class_id: null, class_name: null,
      loss_reason: cst === E.CST_LOST ? '已选择其他机构' : null,
    }));
  }

  // 7.2 已分班（大学部 / 初高）
  for (const [no, , ownerAcct, dest, pushStatus] of CONSULT_PLACED) {
    const s = stuByNo.get(no);
    const cls = dest.kind === 'univ'
      ? UNIV_CLASSES.find((c) => c.id === dest.classId)
      : JH_CLASSES.find((c) => c.id === dest.classId);
    const ownerMap = { zhangls: [CONSULT_ACCT.zhangls, '张老师'], lilx: [CONSULT_ACCT.lilx, '李老师'], wangjl: [CONSULT_ACCT.wangjl, '王经理'] };
    const [ownerId, ownerName] = ownerMap[ownerAcct];
    students.push(base(`CST-${no}`, {
      student_no: no, student_name: s.name, gender: s.gender, age: s.age,
      phone: phone(seqOf(no)), dept_code: s.dept,
      birthday: `${2026 - s.age}-05-12`, source_channel: 4, source_remark: '到校咨询',
      owner_id: ownerId, owner_name: ownerName, owner_title: ownerName === '王经理' ? '咨询经理' : '咨询师',
      intend_course: 'IT 就业班', parent_contact: '母亲', parent_phone: parentPhone(seqOf(no)),
      id_card: idCard(seqOf(no), s.age), school: '郑州市第某中学', address: '河南省郑州市金水区',
      target_college: '郑州大学', pay_mode: '一次性',
      remark: dest.kind === 'jh' ? '初高直建入班' : `已推送 ${cls.name}（${pushStatus === E.PUSH_RECEIVED ? '已接收' : pushStatus === E.PUSH_PENDING ? '待接收' : '被驳回'}）`,
      consult_state: pushStatus === E.PUSH_REJECTED ? E.CST_FULL_FEE_PENDING : E.CST_FORMAL,
      student_status: pushStatus === E.PUSH_RECEIVED ? E.ST_STUDYING : null,
      class_id: pushStatus === E.PUSH_RECEIVED ? dest.classId : null,
      class_name: pushStatus === E.PUSH_RECEIVED ? cls.name : null,
      trial_start: D(-100), loss_reason: null,
    }));
  }

  // 7.3 收款与缴费单
  const orders = [];
  let on = 0;
  for (const s of students) {
    const isPlaced = s.consult_state === E.CST_FORMAL || s.consult_state === E.CST_FULL_FEE_PENDING;
    const isLead = s.student_no.startsWith('ZX');
    on += 1;
    let status, financePayStatus, feeType, amount, clsName, deptCode;
    if (isPlaced) {
      status = E.CONSULT_ARRIVED; financePayStatus = E.PAY_VERIFIED;
      feeType = E.FEE_TUITION; amount = feeStd(s.dept_code ?? E.DEPT_UNIV, E.FEE_TUITION);
      clsName = s.class_name; deptCode = s.dept_code ?? E.DEPT_UNIV;
    } else if (isLead) {
      status = s.student_no === 'ZX26002' ? E.CONSULT_PENDING : E.CONSULT_NO_VOUCHER;
      financePayStatus = s.student_no === 'ZX26002' ? E.PAY_PAID : E.PAY_UNPAID;
      feeType = E.FEE_TRIAL; amount = STDD[E.FEE_TRIAL];
      clsName = null; deptCode = E.DEPT_JH;
    } else {
      status = E.CONSULT_ARRIVED; financePayStatus = E.PAY_VERIFIED;
      feeType = E.FEE_TUITION; amount = feeStd(s.dept_code ?? E.DEPT_UNIV, E.FEE_TUITION);
      clsName = s.class_name; deptCode = s.dept_code ?? E.DEPT_UNIV;
    }
    const feeRow = FIN.fees.find((f) => f.student_no === s.student_no && f.fee_type === feeType);
    // ★ 2026-10-15：咨询收款单的凭证图同样要落盘
    const noVoucher = status === E.CONSULT_NO_VOUCHER;
    const consultVoucherFile = `voucher-${s.student_no}.png`;
    if (!noVoucher) ensureSeedVoucher(consultVoucherFile, feeType, deptCode);
    orders.push(base(`ORD-${String(on).padStart(3, '0')}`, {
      order_no: `SK2026${String(on).padStart(4, '0')}`,
      finance_fee_id: feeRow?.id ?? null,
      consult_student_id: s.id, student_name: s.student_name, student_no: s.student_no,
      class_name: clsName, dept_code: deptCode, fee_type: feeType, amount,
      status, finance_pay_status: financePayStatus,
      reject_reason: status === E.CONSULT_REJECTED ? '凭证模糊' : null,
      voucher_url: noVoucher ? null : `/uploads/seed/${consultVoucherFile}`,
      voucher_no: noVoucher ? null : `QPZ${s.student_no}`,
      voucher_by: noVoucher ? null : s.owner_name,
      pay_method: 'wechat', batch_no: on,
    }));
  }

  // 7.4 跟进历史
  const hist = [];
  let hn = 0;
  for (const s of students) {
    for (const [action, text] of [['create', '创建学员档案'], ['follow', '电话回访，家长意向明确']]) {
      hn += 1;
      hist.push(base(`CH-${hn}`, {
        consult_student_id: s.id, by_name: s.owner_name || '张老师',
        by_title: s.owner_title || '咨询师', action, text,
      }));
    }
  }

  /* ---- ★ 2026-10-06：本模块自己的账号表（重建会清库 → 必须重新播种）----
   *
   * ⚠️ 这张表是「历史遗留的影子表」：
   *    · 岗位判定的**首选**已改为「门户账号 × sms_perm 角色」
   *      （server-job/src/consult/services/perm-roles.ts）
   *    · 但 t_consult_student.owner_id 仍然引用这里的 id，
   *      且 /middleware/auth.ts 对老 token 还要按 account 回查这张表。
   *   上次全量重建漏播了它 → 全表为空 →
   *      「分配咨询老师」下拉无数据 + 经理被静默降级成咨询师（403）。 */
  const accounts = [
    ['admin', '系统管理员', 'admin', '系统管理员', '信息中心'],
    ['wangjl', '王经理', 'manager', '咨询经理', '市场咨询部'],
    ['zhangls', '张老师', 'consult', '咨询师', '市场咨询部'],
    ['lilx', '李老师', 'consult', '咨询师', '市场咨询部'],
  ].map(([account, userName, role, roleTitle, dept], i) =>
    base(CONSULT_ACCT[account], {
      account, password: '123456', user_name: userName, role,
      role_title: roleTitle, dept, phone: `1370000000${i + 1}`,
      active: 1, last_login: null, create_by_name: 'SEED',
    }));

  return {
    students,
    orders,
    hist,
    async write() {
      await insertMany(conn, `${DB.consult}.t_consult_account`, accounts);
      await insertMany(conn, `${DB.consult}.t_consult_student`, students);
      await insertMany(conn, `${DB.consult}.t_consult_fee_order`, orders);
      await insertMany(conn, `${DB.consult}.t_consult_history`, hist);
      // 消费项字典 + 配置（★ 2026-10-16 用户指令：取消「工具包」「宿舍门禁卡」）
      await insertMany(conn, `${DB.consult}.t_consult_consume_item`, [
        ['校服', 12000, 1], ['被褥三件套', 15000, 2],
        ['教材资料', 6000, 4], ['军训服', 9000, 5],
      ].map(([name, price, sort], i) => base(`CIT-${i + 1}`, { item_name: name, price, sort_no: sort, is_enabled: 1 })));
      await insertMany(conn, `${DB.consult}.t_consult_config`, [
        base('CCFG-1', { config_key: 'trialDays', config_value: '7', remark: '试学默认天数' }),
        base('CCFG-2', { config_key: 'lossReasons', config_value: '已选其他机构,距离太远,费用太高', remark: '流失原因候选' }),
      ]);
      say(`  ✓ 学员 ${students.length} · 费单 ${orders.length} · 跟进历史 ${hist.length}`);
    },
  };
}

/* ============================================================
 * 8. 种子：大学部班级（sms_class）
 * ============================================================ */

function classOfStudent(no) {
  if (no.startsWith('J')) return JH_CLASSES.find((c) => c.students.includes(no)) ?? null;
  const u = UNIV_CLASSES.find((c) => c.students.includes(no));
  if (u) return u;
  const j = JOB_CLASS.students.includes(no) ? JOB_CLASS : null;
  return j;
}

function seedClass(conn) {
  say('\n【3/7】大学部班级 sms_class');

  // 8.1 班级
  const classes = UNIV_CLASSES.map((c) => base(c.id, {
    class_name: c.name, dept_code: E.DEPT_UNIV, stage: c.stage,
    head_teacher_id: c.head.id, head_teacher_name: c.head.name,
    teacher_id: null, teacher_name: null, assistant_id: null, assistant_name: null,
    room: c.room, open_date: D(-120), student_count: c.students.length,
    class_status: E.CLS_OPEN, attendance_rate: 96.2,
    /* ★ 2026-10-06（用户口径）：项目经理 / 就业指导老师 **在升实训时选**，
       所以大学部班级建班后这两位留空 —— 升实训弹窗里现选现填。
       （原来在这里预填了周杰，但周杰是「就业老师」不是「项目经理」，
         下拉里没有他 → 弹窗会把 UUID 当显示值，很难看。） */
    project_manager_id: null, project_manager_name: null,
    employment_teacher_id: null, employment_teacher_name: null,
    university_no: c.name,
  }));

  // 8.2 学员（在读 10 人；U26011~15 已升实训 → 不进本库花名册）
  const stu = [];
  for (const c of UNIV_CLASSES) {
    for (const no of c.students) {
      const s = stuByNo.get(no);
      const placed = CONSULT_PLACED.find((p) => p[0] === no);
      stu.push(base(`SC-${no}`, {
        source_system: placed ? 'consult' : 'manual',
        // source_id 与推送单 consult_no 同口径（= 咨询学员 student_no）
        source_id: placed ? placed[0] : null,
        source_update_time: NOW(), sync_status: placed ? 2 : 1,
        student_no: no, student_name: s.name, gender: s.gender, age: s.age,
        dept_code: E.DEPT_UNIV, student_status: s.status, stage: c.stage,
        id_card: idCard(seqOf(no), s.age), phone: phone(seqOf(no)), parent_phone: parentPhone(seqOf(no)),
        education: '高中', enroll_date: D(-120), repeat_count: 0, attendance_rate: 96.5,
        remark: '演示学员',
        class_id: c.id, class_name: c.name,
        head_teacher_id: c.head.id, head_teacher_name: c.head.name,
        teacher_id: null, teacher_name: null, assistant_id: null, assistant_name: null,
        dorm_id: null, dorm_no: null, birth_date: `${2026 - s.age}-05-12`,
        origin: '郑州', graduate_school: '郑州市第某中学', home_address: '河南省郑州市金水区',
        recruit_teacher_id: PORTAL.zhangls, recruit_teacher_name: '张老师', recruit_phone: '13700000001',
        consult_teacher_id: PORTAL.lilx, consult_teacher_name: '李老师', consult_phone: '13700000002',
        quality_study: 'A', quality_discipline: 'A', quality_ability: 'B',
        quality_comprehension: 'A', quality_expression: 'B', quality_social: 'A',
        quality_note: '学习态度端正', source_batch_no: 'SEED-2026',
      }));
    }
  }

  // 8.3 咨询推送单（待接收 2 / 已接收 5 / 已驳回 1 = 8 条）
  //  ⚠️ 跨模块认人键 = 咨询学员的 **student_no**（见 consult/routes/student.route.ts 的 consultNoOf），
  //     不是 ZX 开头的「咨询单号」。此前误用 cno → 咨询侧 /assign-status 查不到推送单，
  //     「已分班不可再分派」在演示数据上会失效（显示成「未分班」）。这里统一用 no。
  const pushes = CONSULT_PLACED.filter((p) => p[3].kind === 'univ').map((p) => {
    const [no, , , dest, st] = p;
    const s = stuByNo.get(no);
    const cls = UNIV_CLASSES.find((c) => c.id === dest.classId);
    return base(`PUSH-${no}`, {
      consult_no: no, student_name: s.name, gender: s.gender,
      phone: phone(seqOf(no)), parent_phone: parentPhone(seqOf(no)), age: s.age,
      education: '高中', origin: '郑州', graduate_school: '郑州市第某中学',
      home_address: '河南省郑州市金水区',
      intend_dept_code: E.DEPT_UNIV, intend_stage: cls.stage,
      intend_class_id: cls.id, intend_class_name: cls.name,
      remark: st === E.PUSH_REJECTED ? '成绩未达该阶段要求' : '咨询推荐入班',
      apply_status: st, push_time: DT(-15),
      receiver_id: st === E.PUSH_RECEIVED ? cls.head.id : null,
      receiver_name: st === E.PUSH_RECEIVED ? cls.head.name : null,
      receive_time: st === E.PUSH_RECEIVED ? DT(-13) : null,
      reject_reason: st === E.PUSH_REJECTED ? '本班已满，建议改推 U2602' : null,
      student_id: st === E.PUSH_RECEIVED ? `SC-${no}` : null,
      student_no: st === E.PUSH_RECEIVED ? no : null,
      source_system: 'consult', origin_student_id: null,
      from_class_id: null, from_class_name: null,
      is_repeat_in: 0, transfer_reason: null,
    });
  });

  // 8.4 出勤 + 缺勤
  const att = [];
  const absent = [];
  for (const c of UNIV_CLASSES) {
    for (const off of [-3, -2, -1]) {
      const aid = `ATT-${c.id}-${off}`;
      att.push(base(aid, {
        class_id: c.id, class_name: c.name, attendance_date: D(off),
        should_count: c.students.length, present_count: c.students.length - 1, absent_count: 1,
        attendance_rate: Number((((c.students.length - 1) / c.students.length) * 100).toFixed(2)),
        teacher_name: '—', head_teacher_name: c.head.name,
      }));
      const absentNo = c.students[Math.abs(off) % c.students.length];
      const as = stuByNo.get(absentNo);
      absent.push(base(`ABS-${c.id}-${off}`, {
        attendance_id: aid, student_id: `SC-${absentNo}`, student_no: absentNo,
        student_name: as.name, class_name: c.name, phone: phone(seqOf(absentNo)),
        absent_reason: '病假',
      }));
    }
  }

  // 8.5 考试 + 成绩
  const exams = [];
  const grades = [];
  for (const c of UNIV_CLASSES) {
    const eid = `EXM-${c.id}-1`;
    exams.push(base(eid, {
      exam_name: `${c.name} 阶段测评`, exam_type: 1, creator_id: S.principal.id,
      creator_name: S.principal.name, exam_date: D(-10), class_id: c.id,
      class_name: c.name, attendee_count: c.students.length,
    }));
    c.students.forEach((no, i) => {
      const s = stuByNo.get(no);
      const w = 78 + (i % 5) * 3, m = 80 + (i % 4) * 3, itv = 75 + (i % 6) * 2;
      grades.push(base(`GRD-${c.id}-${no}`, {
        student_id: `SC-${no}`, student_no: no, student_name: s.name,
        class_id: c.id, class_name: c.name, exam_id: eid, exam_name: `${c.name} 阶段测评`,
        written_score: w, machine_score: m, interview_score: itv,
        comp_score: Number(((w + m + itv) / 3).toFixed(2)), exam_result: 1,
        analysis: '掌握良好', remark: null,
      }));
    });
  }

  // 8.6 催费记录
  const urges = ALL_UNIV.filter((s) => s.status === E.ST_STUDYING).slice(0, 3).map((s, i) => {
    const cls = classOfStudent(s.no);
    return base(`URG-${i + 1}`, {
      student_id: `SC-${s.no}`, student_no: s.no, student_name: s.name,
      amount: STDU[E.FEE_MEAL], channel: 'phone', remark: '餐费到期提醒',
      operator_id: S.acad.id, operator_name: S.acad.name, urge_time: DT(-2),
    });
  });

  return {
    classes, stu, pushes, att, absent, exams, grades, urges,
    async write() {
      await insertMany(conn, `${DB.cls}.t_class_info`, classes);
      await insertMany(conn, `${DB.cls}.t_class_student`, stu);
      await insertMany(conn, `${DB.cls}.t_class_consult_push`, pushes);
      await insertMany(conn, `${DB.cls}.t_class_attendance`, att);
      await insertMany(conn, `${DB.cls}.t_class_attendance_absent`, absent);
      await insertMany(conn, `${DB.cls}.t_class_exam`, exams);
      await insertMany(conn, `${DB.cls}.t_class_grade`, grades);
      await insertMany(conn, `${DB.cls}.t_class_urge_log`, urges);
      say(`  ✓ 班级 ${classes.length} · 学员 ${stu.length} · 推送 ${pushes.length}（待接收 2 / 已接收 5 / 已驳回 1）· 出勤 ${att.length} · 成绩 ${grades.length}`);
    },
  };
}

/* ============================================================
 * 9. 种子：初高（sms_class_jh）
 * ============================================================ */

function seedClassJh(conn) {
  say('\n【4/7】初高 sms_class_jh');

  // 9.1 阶段方案（★ 2026-10-16：一个方案可含多个阶段）
  const PLANS = [
    ['JHPLAN-JH', '初高部阶段方案', 1],
    ['JHPLAN-UNI', '大学部阶段方案', 2],
  ].map(([id, name, dept], i) => base(id, { plan_name: name, dept_code: dept, sort_no: i }));

  // 9.1.1 阶段字典（挂在方案下）
  const STAGES = [
    [101, '预科', 1, 3], [102, '初中部1期', 1, 6], [103, '初中部2期', 1, 6], [104, '初中部3期', 1, 6],
    [105, '高中部1期', 1, 6], [106, '高中部2期', 1, 6], [107, '高中部3期', 1, 6],
    [201, '一阶段', 2, 4], [202, '二阶段', 2, 4], [203, '三阶段', 2, 4], [204, '四阶段', 2, 4],
  ].map(([code, name, dept, months], i) => base(`JHSTG-${code}`, {
    stage_code: code, stage_name: name, dept_code: dept, study_months: months, sort_no: i,
    plan_id: dept === 2 ? 'JHPLAN-UNI' : 'JHPLAN-JH',
  }));

  // 9.2 系统设置
  const settings = [
    ['attendanceTargetRate', '出勤率目标（%）', '90', '低于该值告警'],
    ['attendanceScope', '出勤统计口径', JSON.stringify({ shouldStatuses: [3, 4, 5], presentStatuses: [1, 2] }), '分母=在读/试学/预读'],
    ['feeRemindDays', '催费提前提醒天数', '7', '剩余天数<=该值标红'],
    ['feeUrgeWindowDays', '催费列表窗口天数', '20', '到期日距今<=该值才进催费列表（含已逾期）'],
    ['refundThresholdAmount', '退费审批阈值（分）', '500000', '超阈值走校长审批'],
    ['closedClassIntakeTypes', '封班可转入类型', JSON.stringify([1, 2]), '休学复学/末班'],
  ].map(([k, n, v, r]) => base(`JHSET-${k}`, { setting_key: k, setting_name: n, setting_value: v, remark: r }));

  // 9.3 班级
  const classes = JH_CLASSES.map((c) => base(c.id, {
    class_name: c.name, stage: c.stage,
    head_teacher_id: c.head.id, head_teacher_name: c.head.name,
    teacher_id: c.teacher.id, teacher_name: c.teacher.name,
    assistant_id: null, assistant_name: null,
    classroom: c.room, open_date: D(-150), dept_code: E.DEPT_JH,
    class_status: E.CLS_OPEN, student_count: c.students.length,
    today_attendance_rate: 95.5, remark: `${c.name} 演示班级`,
  }));

  // 9.4 学期
  const terms = JH_CLASSES.map((c) => base(`JHTERM-${c.id}`, {
    class_id: c.id, class_name: c.name, term_name: '2026 秋',
    start_date: D(-120), end_date: D(60), remark: '演示学期',
  }));

  // 9.5 学生
  const stu = [];
  for (const c of JH_CLASSES) {
    for (const no of c.students) {
      const s = stuByNo.get(no);
      const placed = CONSULT_PLACED.find((p) => p[0] === no);
      stu.push(base(`JHS-${no}`, {
        student_no: no, student_name: s.name, gender: s.gender,
        birth_date: `${2026 - s.age}-05-12`, age: s.age, native_place: '河南郑州',
        dept_code: E.DEPT_JH, class_id: c.id, class_name: c.name, stage: c.stage,
        head_teacher_id: c.head.id, head_teacher_name: c.head.name,
        teacher_id: null, teacher_name: null, assistant_id: null, assistant_name: null,
        student_status: s.status, pending_flow_type: null,
        education: '初中', graduate_school: '郑州市实验中学', enroll_date: D(-150),
        phone: phone(seqOf(no)), parent_phone: parentPhone(seqOf(no)),
        home_address: '河南省郑州市金水区文化路 1 号',
        id_card_no: idCard(seqOf(no), s.age), agreement_status: 1,
        net_account: no.toLowerCase(), net_init_password: '123456',
        recruit_teacher_name: '张老师', recruit_teacher_phone: '13700000001',
        consult_teacher_name: '李老师', consult_teacher_phone: '13700000002',
        dorm_id: null, dorm_no: null, bed_no: null, attendance_rate: 96.5, repeat_count: 0,
        remark: placed ? `来自咨询（单号 ${placed[1]}）` : '演示学生',
        literacy_desc: '学习态度端正，动手能力强。',
        // ⚠️ 初高 /student/enrolled-status 按 source_id 查（键 = 咨询学员 student_no），
        //    必须与咨询侧 consultNoOf 同口径，否则「已直接进入初高」的按钮拦截会失效。
        source_system: placed ? 'consult' : null,
        source_id: placed ? placed[0] : null,
      }));
    }
  }

  // 9.6 宿舍：楼栋 / 房间 / 床位 / 入住
  const buildings = [
    base('JHBLD-1', { building_name: '初高A栋', campus_name: '主校区', floor_count: 5, manager_name: '宿管老王', manager_phone: '13600000001', dept_name: '教务部', building_status: '使用中', data_source: '教务同步' }),
    base('JHBLD-2', { building_name: '初高B栋', campus_name: '主校区', floor_count: 5, manager_name: '宿管张姨', manager_phone: '13600000002', dept_name: '教务部', building_status: '使用中', data_source: '教务同步' }),
  ];
  const rooms = [];
  const beds = [];
  let rn = 0;
  for (const [bi, b] of buildings.entries()) {
    const dormType = bi === 0 ? 1 : 2;
    for (let f = 2; f <= 3; f++) {
      rn += 1;
      const roomNo = `${f}-0${f - 1}`;
      const roomId = `JHROOM-${rn}`;
      rooms.push(base(roomId, {
        building_id: b.id, building_name: b.building_name, floor_no: f, room_no: roomNo,
        dorm_type: dormType, bed_count: 4, occupied_count: 0, occupancy_rate: 0,
        owner_name: b.manager_name, data_source: '教务同步', room_status: '使用中',
        class_id: null, class_name: null,
      }));
      for (let bed = 1; bed <= 4; bed++) {
        beds.push(base(`JHBD-${rn}-${bed}`, {
          room_id: roomId, room_no: roomNo, building_id: b.id,
          bed_no: `${bed}号床`, dorm_type: dormType, bed_status: '空闲', student_id: null,
        }));
      }
    }
  }
  // 入住：给 G2601 的前 4 人分床位
  const residents = [];
  const maleRooms = rooms.filter((r) => r.dorm_type === 1);
  const femaleRooms = rooms.filter((r) => r.dorm_type === 2);
  let mi = 0, fi = 0;
  for (const no of ['J26002', 'J26003', 'J26004', 'J26005']) {
    const s = stuByNo.get(no);
    const cls = classOfStudent(no);
    const room = s.gender === 1 ? maleRooms[mi++ % maleRooms.length] : femaleRooms[fi++ % femaleRooms.length];
    const bed = beds.find((b) => b.room_id === room.id && b.bed_status === '空闲' && !b.student_id);
    if (!bed) continue;
    bed.bed_status = '已占用';
    bed.student_id = `JHS-${no}`;
    residents.push(base(`JHRES-${no}`, {
      student_id: `JHS-${no}`, student_no: no, student_name: s.name,
      class_id: cls.id, class_name: cls.name, gender: s.gender,
      building_id: room.building_id, room_id: room.id, room_no: room.room_no,
      bed_id: bed.id, bed_no: bed.bed_no, check_in_date: D(-100),
      owner_name: '宿管', is_active: 1,
    }));
  }
  for (const r of rooms) {
    const used = beds.filter((b) => b.room_id === r.id && b.bed_status === '已占用').length;
    r.occupied_count = used;
    r.occupancy_rate = Number(((used / r.bed_count) * 100).toFixed(2));
  }
  // 回写学生宿舍号
  for (const res of residents) {
    const t = stu.find((x) => x.id === res.student_id);
    if (t) { t.dorm_id = res.room_id; t.dorm_no = res.room_no; t.bed_no = res.bed_no; }
  }

  // 9.7 缴费台账（来源 = 财务，与 t_finance_fee 一一对应）
  const fees = [];
  for (const s of ALL_JH) {
    const cls = classOfStudent(s.no);
    for (const ft of [E.FEE_TUITION, E.FEE_DORM]) {
      const src = FIN.fees.find((f) => f.student_no === s.no && f.fee_type === ft);
      fees.push(base(`JHFEE-${s.no}-${ft}`, {
        student_id: `JHS-${s.no}`, student_no: s.no, student_name: s.name,
        class_id: cls?.id ?? null, class_name: cls?.name ?? null, dept_code: E.DEPT_JH,
        fee_type: ft, fee_amount: feeStd(E.DEPT_JH, ft),
        pay_status: src?.pay_status ?? E.PAY_UNPAID,
        pay_date: src?.pay_date ?? null, expire_date: src?.expire_date ?? D(180),
        voucher_url: src?.voucher_url ?? null,
        source_system: 'finance', source_id: src?.id ?? null,
        period: src?.period ?? null,
      }));
    }
  }

  // 9.8 出勤台账 + 明细
  const att = [];
  const details = [];
  for (const c of JH_CLASSES) {
    for (const off of [-2, -1]) {
      const aid = `JHATT-${c.id}-${off}`;
      att.push(base(aid, {
        class_id: c.id, class_name: c.name, attendance_date: D(off), attendance_rate: 95.0,
        should_count: c.students.length, actual_count: c.students.length - 1,
        month_unqualified_count: 0, teacher_id: null, teacher_name: null,
        head_teacher_id: c.head.id, head_teacher_name: c.head.name,
        file_url: null, remark: '演示出勤',
      }));
      c.students.forEach((no, i) => {
        const s = stuByNo.get(no);
        details.push(base(`JHDET-${c.id}-${off}-${no}`, {
          attendance_id: aid, class_id: c.id, attendance_date: D(off),
          student_id: `JHS-${no}`, student_no: no, student_name: s.name,
          phone: phone(seqOf(no)), parent_phone: parentPhone(seqOf(no)),
          attendance_status: i === 1 ? 4 : 1, absent_reason: i === 1 ? '病假' : null,
        }));
      });
    }
  }

  // 9.9 考试 + 成绩
  const exams = [];
  const scores = [];
  for (const c of JH_CLASSES) {
    const eid = `JHEXM-${c.id}-1`;
    exams.push(base(eid, {
      exam_name: `${c.name} 月考`, exam_type: 1, exam_date: D(-7), class_id: c.id,
      class_name: c.name, exam_content_types: JSON.stringify([1, 2, 3]),
      content_full_score: JSON.stringify([100, 100, 100]), exam_status: 3,
      score_teacher_ids: JSON.stringify([c.head.id]), judge_ids: JSON.stringify([]),
      create_by_name: c.head.name, remark: '演示考试',
    }));
    c.students.forEach((no, i) => {
      const s = stuByNo.get(no);
      const w = 80 + (i % 5) * 3, m = 82 + (i % 4) * 2, itv = 78 + (i % 6) * 2;
      const total = w + m + itv;
      scores.push(base(`JHSCR-${c.id}-${no}`, {
        exam_id: eid, exam_type: 1, exam_date: D(-7), class_id: c.id,
        student_id: `JHS-${no}`, student_no: no, student_name: s.name,
        score_written: w, score_machine: m, score_interview: itv, score_other: 0,
        score_total: total, score_teacher_id: c.head.id, score_teacher_name: c.head.name,
        exam_result: 1, is_passed: 1, custom_values: null, remark: null,
      }));
    });
  }

  return {
    classes, stu, fees, att, details, exams, scores,
    async write() {
      await insertMany(conn, `${DB.cjh}.t_class_stage_plan`, PLANS);
      await insertMany(conn, `${DB.cjh}.t_class_stage`, STAGES);
      await insertMany(conn, `${DB.cjh}.t_class_setting`, settings);
      await insertMany(conn, `${DB.cjh}.t_class_info`, classes);
      await insertMany(conn, `${DB.cjh}.t_class_term`, terms);
      await insertMany(conn, `${DB.cjh}.t_class_student`, stu);
      await insertMany(conn, `${DB.cjh}.t_class_building`, buildings);
      await insertMany(conn, `${DB.cjh}.t_class_room`, rooms);
      await insertMany(conn, `${DB.cjh}.t_class_bed`, beds);
      await insertMany(conn, `${DB.cjh}.t_class_dorm_resident`, residents);
      await insertMany(conn, `${DB.cjh}.t_class_fee`, fees);
      await insertMany(conn, `${DB.cjh}.t_class_attendance`, att);
      await insertMany(conn, `${DB.cjh}.t_class_attendance_detail`, details);
      await insertMany(conn, `${DB.cjh}.t_class_exam`, exams);
      await insertMany(conn, `${DB.cjh}.t_class_exam_score`, scores);
      // 学生主档影子表
      await insertMany(conn, `${DB.cjh}.t_student_base`, ALL_JH.map((s) => {
        const cls = classOfStudent(s.no);
        return base(`JHSB-${s.no}`, {
          student_no: s.no, student_name: s.name, gender: s.gender, age: s.age,
          dept_code: E.DEPT_JH, class_id: cls.id, class_name: cls.name,
          head_teacher_id: cls.head.id, head_teacher_name: cls.head.name,
          student_status: s.status, stage: cls.stage,
          phone: phone(seqOf(s.no)), parent_phone: parentPhone(seqOf(s.no)),
          education: '初中', enroll_date: D(-150), attendance_rate: 96.5,
          repeat_count: 0, remark: '演示数据',
        });
      }));
      say(`  ✓ 班级 ${classes.length} · 学生 ${stu.length} · 缴费 ${fees.length} · 出勤 ${att.length} · 成绩 ${scores.length} · 楼栋 ${buildings.length}/房间 ${rooms.length}/床位 ${beds.length}/入住 ${residents.length}`);
    },
  };
}

/* ============================================================
 * 10. 种子：教务（sms_edu）
 * ============================================================ */

function seedEdu(conn) {
  say('\n【5/7】教务 sms_edu');

  // 教务管 大学部 + 实训 学生
  const eduStudents = ALL_UNIV;

  const baseRows = eduStudents.map((s) => {
    const cls = classOfStudent(s.no);
    return base(`ESB-${s.no}`, {
      student_no: s.no, student_name: s.name, gender: s.gender, age: s.age,
      dept_code: E.DEPT_UNIV, class_id: cls?.id ?? null, class_name: cls?.name ?? null,
      head_teacher_id: cls?.head.id ?? null, head_teacher_name: cls?.head.name ?? null,
      student_status: s.status, stage: cls?.stage ?? null,
      phone: phone(seqOf(s.no)), parent_phone: parentPhone(seqOf(s.no)),
      education: '高中', enroll_date: D(-120), attendance_rate: 96.5, repeat_count: 0,
      quality: '良', last_class_count: 1, remark: '演示数据',
    });
  });

  // 宿舍房间（教务侧）
  const ROOMS = [
    { id: 'EROOM-1', category: 1, building: '实训A栋', room: '301', capacity: 4 },
    { id: 'EROOM-2', category: 1, building: '实训A栋', room: '302', capacity: 4 },
    { id: 'EROOM-3', category: 2, building: '实训B栋', room: '201', capacity: 4 },
  ];
  const rooms = ROOMS.map((r) => base(r.id, { category: r.category, building: r.building, room: r.room, capacity: r.capacity }));

  // 床位：实训 5 人入住（男 3 / 女 2）
  const beds = [];
  const jobStu = JOB_CLASS.students.map((no) => stuByNo.get(no));
  const maleBeds = ['EROOM-1', 'EROOM-2'].flatMap((rid) => [1, 2, 3, 4].map((b) => ({ rid, b })));
  const femaleBeds = ['EROOM-3'].flatMap((rid) => [1, 2, 3, 4].map((b) => ({ rid, b })));
  let mi = 0, fi = 0;
  jobStu.forEach((s) => {
    const cls = classOfStudent(s.no);
    const pick = s.gender === 1 ? maleBeds[mi++] : femaleBeds[fi++];
    if (!pick) return;
    const room = ROOMS.find((r) => r.id === pick.rid);
    const bedId = `EBED-${pick.rid}-${pick.b}`;
    beds.push(base(bedId, {
      room_id: pick.rid, bed_no: `${pick.b}`, bed_index: pick.b,
      student_no: s.no, student_name: s.name,
      class_name: cls?.name ?? JOB_CLASS.name, head_teacher_name: cls?.head.name ?? S.job.name,
    }));
  });
  // ⚠️ t_edu_dorm_assignment 有唯一键 uk_assign_room（一间房一条），不能按学生建
  const assignments = ROOMS.map((r) => base(`EASG-${r.id}`, {
    class_name: JOB_CLASS.name, head_teacher_name: S.job.name,
    room_id: r.id, building: r.building, room: r.room,
    category: r.category, remark: '演示分配',
  }));
  // 其余空床位
  for (const r of ROOMS) {
    for (let b = 1; b <= r.capacity; b++) {
      if (beds.some((x) => x.id === `EBED-${r.id}-${b}`)) continue;
      beds.push(base(`EBED-${r.id}-${b}`, {
        room_id: r.id, bed_no: `${b}`, bed_index: b,
        student_no: null, student_name: null, class_name: null, head_teacher_name: null,
      }));
    }
  }

  // 缴费（教务侧缴费视图）
  const payments = ALL_UNIV.map((s, i) => {
    const cls = classOfStudent(s.no);
    const src = FIN.fees.find((f) => f.student_no === s.no && f.fee_type === E.FEE_TUITION);
    return base(`EPAY-${s.no}`, {
      category: '学费', class_name: cls?.name ?? null, head_teacher_name: cls?.head.name ?? null,
      student_name: s.name, pay_date: src?.pay_date ? new Date(`${src.pay_date} 09:00:00`) : null,
      expiry_date: new Date(`${D(180)} 09:00:00`),
      frozen: src?.pay_status === E.PAY_FROZEN ? 1 : 0,
      exp_status: src?.pay_status === E.PAY_OVERDUE ? '逾期' : '正常',
      notify_time: null, upload_time: NOW(),
      certificate_name: `凭证-${s.no}.png`, upload_remark: '教务侧演示',
      student_no: s.no, auto_frozen: i % 7 === 0 ? 1 : 0,
      /**
       * ⚠️ 2026-10-15 修正：教务的 pay_status 用的是 PayPaidStatus（'已缴' / '未缴'），
       *    原先直接写了财务的数字状态（'3'）—— 后果是
       *    `payStatus === PayPaidStatus.PAID('已缴')` 永远不成立，
       *    教务「上传凭证」永远不可用（接口报「该笔费用尚未缴纳，缴清后才能上传凭证」）。
       *    映射口径：财务 2 待核对 / 3 已缴 = 钱已到账 → '已缴'；其余（1 待缴 / 5 冻结）→ '未缴'。
       */
      pay_status: [2, 3].includes(Number(src?.pay_status)) ? '已缴' : '未缴',
      /**
       * ⚠️ 2026-10-15 修正：凭证状态必须是 CertStatus 的取值（未传 / 已传 / 被打回），
       *    原先写成「已上传」—— 那是 exp_status（到期状态）的取值。
       *    后果：code 里 `certStatus === CertStatus.UPLOADED('已传')` 永远不成立，
       *    教务「凭证状态」筛选筛不到、「已上传」提示也不出现。
       */
      cert_status: '已传', order_no: `EDU2026${String(i + 1).padStart(4, '0')}`,
      amount: src?.amount ?? STDU[E.FEE_TUITION],
    });
  });

  return {
    async write() {
      await insertMany(conn, `${DB.edu}.t_student_base`, baseRows);
      await insertMany(conn, `${DB.edu}.t_edu_dorm_room`, rooms);
      await insertMany(conn, `${DB.edu}.t_edu_dorm_bed`, beds);
      await insertMany(conn, `${DB.edu}.t_edu_dorm_assignment`, assignments);
      await insertMany(conn, `${DB.edu}.t_edu_payment`, payments);
      say(`  ✓ 学生档案 ${baseRows.length} · 房间 ${rooms.length} · 床位 ${beds.length} · 分配 ${assignments.length} · 缴费 ${payments.length}`);
    },
  };
}

/* ============================================================
 * 11. 种子：就业/实训（sms_job）
 * ============================================================ */

function seedJob(conn) {
  say('\n【6/7】就业/实训 sms_job');

  const jobStu = JOB_CLASS.students.map((no) => stuByNo.get(no));

  // 11.1 实训班
  const classes = [base(JOB_CLASS.id, {
    class_name: JOB_CLASS.name, class_code: JOB_CLASS.name, dept_code: E.DEPT_EMP, stage: JOB_CLASS.stage,
    stage_key: 'job',
    head_teacher_id: S.job.id, head_teacher_name: S.job.name,
    teacher_id: null, teacher_name: null, assistant_id: null, assistant_name: null,
    classroom: JOB_CLASS.room, open_date: D(-60), close_date: null,
    student_count: jobStu.length, class_status: E.CLS_OPEN, attendance_rate: 97.0,
    remark: '由大学部 U2601/U2602 升实训交接而来',
    prev_class_status: E.CLS_TRAINING,
    project_manager_id: S.pm.id, project_manager_name: S.pm.name,
    employment_teacher_id: S.job.id, employment_teacher_name: S.job.name,
    university_no: 'U2601/U2602',
  })];

  // 11.2 学生主档 + 花名册
  const baseRows = jobStu.map((s) => {
    return base(`JSB-${s.no}`, {
      student_no: s.no, student_name: s.name, gender: s.gender, age: s.age,
      dept_code: E.DEPT_EMP, stage_key: 'job', class_id: JOB_CLASS.id, class_name: JOB_CLASS.name,
      head_teacher_id: S.job.id, head_teacher_name: S.job.name,
      student_status: E.ST_TRAINING, stage: JOB_CLASS.stage,
      phone: phone(seqOf(s.no)), parent_phone: parentPhone(seqOf(s.no)),
      education: '高中', enroll_date: D(-120), attendance_rate: 97.0, repeat_count: 0,
      remark: '演示数据', birth_date: `${2026 - s.age}-05-12`, native_place: '河南郑州',
      graduate_school: '郑州市第某中学', home_address: '河南省郑州市金水区',
      admission_teacher: '张老师', admission_teacher_phone: '13700000001',
      consult_teacher: '李老师', consult_teacher_phone: '13700000002',
      id_card: idCard(seqOf(s.no), s.age),
    });
  });

  const classStudents = jobStu.map((s) => base(`JCS-${s.no}`, {
    class_id: JOB_CLASS.id, class_name: JOB_CLASS.name,
    student_id: `JSB-${s.no}`, student_no: s.no, student_name: s.name,
    join_date: D(-60), join_type: 1, leave_date: null, leave_type: null, leave_reason: null,
    status: 1, remark: '升实训入班', uk_in_class: `${JOB_CLASS.id}#${s.no}`,
  }));

  // 11.3 升实训交接单（3 条，来自大学部两个班）
  const handoffs = [
    base('HOFF-1', {
      handoff_no: 'SJ20261001001', source_system: 'class',
      source_class_id: UNIV_CLASSES[0].id, source_class_name: UNIV_CLASSES[0].name, source_stage: 201,
      source_head_teacher_id: S.headU.id, source_head_teacher_name: S.headU.name,
      target_class_id: JOB_CLASS.id, target_class_name: JOB_CLASS.name,
      student_count: 3, student_nos: 'U26011,U26012,U26013',
      receive_status: 2, result_json: JSON.stringify({ ok: 3 }),
      receive_time: DT(-60), operator_id: S.dean.id, operator_name: S.dean.name, remark: '演示交接',
    }),
    base('HOFF-2', {
      handoff_no: 'SJ20261001002', source_system: 'class',
      source_class_id: UNIV_CLASSES[1].id, source_class_name: UNIV_CLASSES[1].name, source_stage: 202,
      source_head_teacher_id: S.headU.id, source_head_teacher_name: S.headU.name,
      target_class_id: JOB_CLASS.id, target_class_name: JOB_CLASS.name,
      student_count: 2, student_nos: 'U26014,U26015',
      receive_status: 2, result_json: JSON.stringify({ ok: 2 }),
      receive_time: DT(-60), operator_id: S.dean.id, operator_name: S.dean.name, remark: '演示交接',
    }),
  ];

  // 11.4 宿舍
  const dorms = [
    base('JDORM-1', { dorm_no: 'SX-301', building: '实训A栋', room_no: '301', bed_count: 4, used_count: 3, dorm_gender: 1, dept_code: E.DEPT_UNIV, dorm_status: 1, facility: '空调,热水', remark: '演示' }),
    base('JDORM-2', { dorm_no: 'SX-201', building: '实训B栋', room_no: '201', bed_count: 4, used_count: 2, dorm_gender: 2, dept_code: E.DEPT_UNIV, dorm_status: 1, facility: '空调,热水', remark: '演示' }),
  ];
  const dormBeds = [];
  const males = jobStu.filter((s) => s.gender === 1);
  const females = jobStu.filter((s) => s.gender === 2);
  males.forEach((s, i) => dormBeds.push(base(`JBD-1-${i + 1}`, {
    dorm_id: 'JDORM-1', dorm_no: 'SX-301', bed_no: `${i + 1}`, bed_status: 2,
    student_id: `JSB-${s.no}`, student_no: s.no, student_name: s.name, student_gender: 1,
    check_in_date: D(-58), remark: '演示',
  })));
  females.forEach((s, i) => dormBeds.push(base(`JBD-2-${i + 1}`, {
    dorm_id: 'JDORM-2', dorm_no: 'SX-201', bed_no: `${i + 1}`, bed_status: 2,
    student_id: `JSB-${s.no}`, student_no: s.no, student_name: s.name, student_gender: 2,
    check_in_date: D(-58), remark: '演示',
  })));
  for (const d of dorms) {
    for (let b = 1; b <= d.bed_count; b++) {
      if (dormBeds.some((x) => x.dorm_id === d.id && x.bed_no === String(b))) continue;
      dormBeds.push(base(`JBD-${d.id}-${b}`, {
        dorm_id: d.id, dorm_no: d.dorm_no, bed_no: String(b), bed_status: 1,
        student_id: null, student_no: null, student_name: null, student_gender: d.dorm_gender,
        check_in_date: null, remark: null,
      }));
    }
  }

  // 11.5 催费单（教务发起 → 推 班级）
  const feeCalls = ALL_UNIV.filter((s) => s.status === E.ST_STUDYING).slice(0, 3).map((s, i) => {
    const cls = classOfStudent(s.no);
    return base(`JFC-${i + 1}`, {
      fee_type: E.FEE_MEAL, student_id: `JSB-${s.no}`, student_no: s.no, student_name: s.name,
      phone: phone(seqOf(s.no)), parent_phone: parentPhone(seqOf(s.no)),
      class_id: cls?.id ?? null, class_name: cls?.name ?? null, dept_code: E.DEPT_UNIV,
      head_teacher_id: cls?.head.id ?? S.headU.id, head_teacher_name: cls?.head.name ?? S.headU.name,
      fee_amount: STDU[E.FEE_MEAL], due_date: D(5),
      call_reason: '餐费即将到期', remark: '演示催费',
      call_status: i === 0 ? 2 : 1, handle_time: i === 0 ? NOW() : null,
      handle_remark: i === 0 ? '已电话通知家长' : null,
      applicant_id: S.acad.id, applicant_name: S.acad.name,
    });
  });

  // 11.6 出勤
  const att = [];
  const attSummary = [];
  for (const off of [-2, -1, 0]) {
    attSummary.push(base(`JAS-${off}`, {
      class_id: JOB_CLASS.id, class_name: JOB_CLASS.name, attend_date: D(off),
      should_count: jobStu.length, actual_count: jobStu.length - 1, absent_count: 1,
      attendance_rate: Number((((jobStu.length - 1) / jobStu.length) * 100).toFixed(2)),
      head_teacher_name: S.job.name, teacher_name: '—',
    }));
    att.push(base(`JATT-${off}`, {
      class_id: JOB_CLASS.id, class_name: JOB_CLASS.name,
      student_id: `JSB-${jobStu[0].no}`, student_no: jobStu[0].no, student_name: jobStu[0].name,
      attend_date: D(off), attend_status: 3, attend_type: 1, reason: '事假', remark: '演示',
      registrar_id: S.job.id, registrar_name: S.job.name,
    }));
  }

  // 11.7 就业日志 / 复盘 / KPI
  const logs = jobStu.map((s, i) => base(`JLOG-${i + 1}`, {
    student_id: `JSB-${s.no}`, student_no: s.no, student_name: s.name, class_name: JOB_CLASS.name,
    log_date: D(-5), resume_count: 8 + i, interview_invite: 3 + (i % 3),
    interview_count: 2 + (i % 3), interview_time: '2026-10-05', company: '郑州某科技公司',
    position: 'Java 开发工程师', salary: 8000 + i * 500,
    interview_situation: '一面已通过，等待二面',
  }));
  const reviews = jobStu.slice(0, 3).map((s, i) => base(`JREV-${i + 1}`, {
    student_id: `JSB-${s.no}`, student_no: s.no, student_name: s.name, class_name: JOB_CLASS.name,
    review_time: '2026-10-05', interview_time: '2026-10-04', position: 'Java 开发工程师',
    salary: 8000 + i * 500, interview_conclusion: 1, review_conclusion: 1,
    audio_name: null, audio_data: null, detail: '表达清晰，技术基础扎实。',
  }));

  return {
    async write() {
      await insertMany(conn, `${DB.job}.t_student_base`, baseRows);
      await insertMany(conn, `${DB.job}.t_job_class`, classes);
      await insertMany(conn, `${DB.job}.t_job_class_student`, classStudents);
      await insertMany(conn, `${DB.job}.t_job_training_handoff`, handoffs);
      await insertMany(conn, `${DB.job}.t_job_dorm`, dorms);
      await insertMany(conn, `${DB.job}.t_job_dorm_bed`, dormBeds);
      await insertMany(conn, `${DB.job}.t_job_fee_call`, feeCalls);
      await insertMany(conn, `${DB.job}.t_job_attendance_summary`, attSummary);
      await insertMany(conn, `${DB.job}.t_job_attendance`, att);
      await insertMany(conn, `${DB.job}.t_employment_log`, logs);
      await insertMany(conn, `${DB.job}.t_review`, reviews);
      await insertMany(conn, `${DB.job}.t_kpi_target`, [
        base('KPI-1', { target_rate: 92.0, target_offer: 40, target_resume: 8.5 }),
      ]);
      say(`  ✓ 实训班 ${classes.length} · 学生 ${baseRows.length} · 交接 ${handoffs.length} · 催费 ${feeCalls.length} · 就业日志 ${logs.length}`);
    },
  };
}

/* ============================================================
 * 12. 种子：公共同步副本（sms_common）+ perm 学生影子表
 * ============================================================ */

function seedCommon(conn) {
  say('\n【7/7】公共同步副本 sms_common + sms_perm');

  // 12.1 财务 → 大学部班级（缴费副本）
  const feeSync = [];
  for (const s of ALL_UNIV) {
    const cls = classOfStudent(s.no);
    if (!cls) continue;
    for (const ft of [E.FEE_TUITION, E.FEE_DORM, E.FEE_MEAL]) {
      const src = FIN.fees.find((f) => f.student_no === s.no && f.fee_type === ft);
      if (!src) continue;
      feeSync.push(base(`CSYNC-${s.no}-${ft}`, {
        source_system: 'finance', source_id: src.id, source_batch_no: 'SYNC-20261006',
        source_update_time: NOW(), sync_status: 2,
        student_id: `SC-${s.no}`, student_no: s.no, student_name: s.name,
        class_id: cls.id, class_name: cls.name, fee_type: ft, amount: src.amount,
        paid_amount: src.pay_status >= E.PAY_PAID ? src.amount : 0,
        pay_status: src.pay_status, pay_date: src.pay_date, expire_date: src.expire_date,
        voucher_url: src.voucher_url, pay_method: 'wechat', period: src.period,
        dept_code: E.DEPT_UNIV,
      }));
    }
  }

  // 12.2 教务催费 → 大学部班级（催费副本）
  const urgeSync = ALL_UNIV.filter((s) => s.status === E.ST_STUDYING).slice(0, 3).map((s, i) => {
    const cls = classOfStudent(s.no);
    return base(`USYNC-${i + 1}`, {
      source_system: 'edu', source_id: `JFC-${i + 1}`, source_batch_no: 'SYNC-20261006',
      source_update_time: NOW(), sync_status: 2,
      student_id: `SC-${s.no}`, student_no: s.no, student_name: s.name,
      class_id: cls.id, class_name: cls.name,
      phone: phone(seqOf(s.no)), parent_phone: parentPhone(seqOf(s.no)),
      head_teacher_id: cls.head.id, head_teacher_name: cls.head.name,
      fee_type: E.FEE_MEAL, amount: STDU[E.FEE_MEAL], expire_date: D(5),
      pay_status: E.PAY_UNPAID, urge_count: i + 1, last_urge_time: NOW(),
    });
  });

  // 12.3 教务宿舍 → 大学部班级（房间 + 在住副本）
  const roomSync = [
    base('RSYNC-1', {
      source_system: 'edu', source_id: 'EROOM-1', source_batch_no: 'SYNC-20261006',
      source_update_time: NOW(), sync_status: 2,
      building_id: 'EDU-BLD-A', building_name: '实训A栋', dorm_type: 1, dorm_no: '301',
      bed_count: 4, used_count: 3, leader_student_id: `SC-U26011`, leader_student_name: '郑凯文',
    }),
    base('RSYNC-2', {
      source_system: 'edu', source_id: 'EROOM-3', source_batch_no: 'SYNC-20261006',
      source_update_time: NOW(), sync_status: 2,
      building_id: 'EDU-BLD-B', building_name: '实训B栋', dorm_type: 2, dorm_no: '201',
      bed_count: 4, used_count: 2, leader_student_id: `SC-U26012`, leader_student_name: '林欣怡',
    }),
  ];
  const liveSync = JOB_CLASS.students.map((no, i) => {
    const s = stuByNo.get(no);
    const cls = classOfStudent(no);
    return base(`LSYNC-${no}`, {
      source_system: 'edu', source_id: `EROOM-${i < 3 ? 1 : 3}##STU_${no}`,
      source_batch_no: 'SYNC-20261006', source_update_time: NOW(), sync_status: 2,
      student_id: `SC-${no}`, student_no: no, student_name: s.name,
      class_id: cls?.id ?? null, class_name: cls?.name ?? null,
      dorm_id: i < 3 ? 'EROOM-1' : 'EROOM-3', dorm_no: i < 3 ? '301' : '201',
      check_in_date: D(-58),
    });
  });

  // 12.4 perm 学生影子表（全量）
  const permBase = ALL_STUDENTS.map((s) => {
    const cls = classOfStudent(s.no);
    return base(`PSB-${s.no}`, {
      student_no: s.no, student_name: s.name, gender: s.gender, age: s.age,
      dept_code: s.dept, class_id: cls?.id ?? null, class_name: cls?.name ?? null,
      head_teacher_id: cls?.head.id ?? null, head_teacher_name: cls?.head.name ?? null,
      student_status: s.status, stage: cls?.stage ?? null,
      phone: phone(seqOf(s.no)), parent_phone: parentPhone(seqOf(s.no)),
      education: s.dept === E.DEPT_JH ? '初中' : '高中',
      enroll_date: D(-120), attendance_rate: 96.5, repeat_count: 0, remark: '演示数据',
    });
  });

  return {
    feeSync, urgeSync, roomSync, liveSync, permBase,
    async write() {
      await insertMany(conn, `${DB.common}.t_class_fee_sync`, feeSync);
      await insertMany(conn, `${DB.common}.t_class_urge_sync`, urgeSync);
      await insertMany(conn, `${DB.common}.t_class_dorm_room_sync`, roomSync);
      await insertMany(conn, `${DB.common}.t_class_dorm_live_sync`, liveSync);
      await insertMany(conn, `${DB.perm}.t_student_base`, permBase);
      say(`  ✓ 缴费副本 ${feeSync.length} · 催费副本 ${urgeSync.length} · 宿舍副本 ${roomSync.length}+${liveSync.length} · perm 学生 ${permBase.length}`);
    },
  };
}

/* ============================================================
 * 12.5 门户账号 ID 校准（修「班主任/就业老师看不到数据」）
 * ============================================================ */

/**
 * 按 account 从 sms_portal.t_sys_account 现查真实 id，覆盖 PORTAL 与 S。
 *
 * 为什么要连同 S 一起回填：`const S = { principal: { id: PORTAL.qiansy } }`
 * 是在**模块加载时**把值复制进去的，之后再改 PORTAL 不会影响 S。
 * 而 CLASSES / JOB_CLASS 里存的是 `head: S.headU` 这种**对象引用**，
 * 所以只要就地改 `S.headU.id`，引用方也一起生效。
 */
async function resolvePortalIds(conn) {
  const portalDb = ENV.DB_NAME_PORTAL || 'sms_portal';
  try {
    const [rows] = await conn.query(
      `SELECT account, id FROM \`${portalDb}\`.t_sys_account WHERE is_deleted = 0`,
    );
    const byAcc = new Map(rows.map((r) => [String(r.account), String(r.id)]));

    const changed = [];
    const missing = [];
    /* ★ 2026-10-15 修：遍历范围从「PORTAL_FALLBACK 的键」改成
     *   「**岗位真正需要的账号**」的并集 ——
     *   因为项目经理 sunjl 根本不在 PORTAL_FALLBACK 名单里（那份名单只有 13 个老账号），
     *   于是 S.pm.id 永远是空串 → 实训班/实训学生的责任字段全挂空
     *   → 项目经理登录后「我带的班」匹配不到 → 学生档案 0 条（实测踩到）。
     *   改成按 STAFF_ACCOUNT 的值取，岗位缺谁就会出现在 missing 提示里。 */
    const needAccounts = new Set([
      ...Object.keys(PORTAL_FALLBACK),
      ...Object.values(STAFF_ACCOUNT),
    ]);
    for (const acc of needAccounts) {
      const real = byAcc.get(acc);
      if (!real) {
        missing.push(acc);
        continue;
      }
      if (real !== PORTAL_FALLBACK[acc]) {
        changed.push(acc);
      }
      PORTAL[acc] = real;
    }

    // 回填 S（岗位 → 门户账号）
    for (const [key, acc] of Object.entries(STAFF_ACCOUNT)) {
      if (S[key] && PORTAL[acc]) S[key].id = PORTAL[acc];
    }

    if (changed.length) {
      say(`  门户账号 ID 校准：${changed.length} 个与硬编码值不同，已按 ${portalDb} 实际值覆盖 → ${changed.join(', ')}`);
    } else {
      say('  门户账号 ID 校准：全部与库中一致');
    }
    if (missing.length) {
      say(`  ⚠️ ${portalDb} 里找不到这些账号：${missing.join(', ')} ——` +
          ' 它们相关的班级/实训负责人会挂空，请先跑 npm run seed:portal 建账号。');
    }
  } catch (e) {
    say(`  ⚠️ 门户账号 ID 校准失败（沿用兜底值）：${e.message}`);
  }
}

/* ============================================================
 * 13. 主流程
 * ============================================================ */

async function main() {
  say('════════════════════════════════════════════');
  say('  全系统演示数据统一重建');
  say(`  连接 ${CONN.host}:${CONN.port}  库前缀 ${DB.job} / ${DB.cls} / ${DB.cjh} …`);
  say(DRY ? '  ⚠️ --dry 模式：只打印计划，不写库' : '');
  say('════════════════════════════════════════════');

  const conn = await mysql.createConnection(CONN);
  try {
    // ★ 先校准门户账号 id（否则班主任/就业老师会被挂到失效的硬编码 UUID 上）
    await resolvePortalIds(conn);
    /* ⚠️ 2026-10-15 回滚：这里**暂不调** resolvePermIds。
     *   原因：业务表责任人列的 ID 口径在代码里**自相矛盾**：
     *     ·  用的是 （**门户 UUID**）
     *     ·  的  注释说应用 permUserId（U004）
     *   两套鉴权口径不一致，填哪种都会有一处对不上。
     *   经测试：填 permUserId 后老接口（/job/class-info/my-class）反而变空，
     *   说明当前实际生效的是门户 UUID 口径 → 回滚到原行为。
     *   待鉴权口径统一后再决定数据填哪种（resolvePermIds 函数保留备用）。 */
    // await resolvePermIds(conn);

    say('\n【0/7】清空业务表（保留 knex_migrations / sms_perm / sms_portal）');
    await truncateAll(conn);

    await seedFinance(conn);
    const consult = seedConsult(conn);
    const cls = seedClass(conn);
    const cjh = seedClassJh(conn);
    const edu = seedEdu(conn);
    const job = seedJob(conn);
    const common = seedCommon(conn);

    say('\n【写入】');
    await consult.write();
    await cls.write();
    await cjh.write();
    await edu.write();
    await job.write();
    await common.write();

    say('\n════════════════════════════════════════════');
    say('  ✓ 完成');

    /* ★ P8（阶段 7，2026-10-19）：老表已 DROP，本脚本的写数据逻辑（按老表列）不改——
         流程改为「临时重建老表 → 灌数据 → 搬迁进统一表 → 清除临时老表」四步闭环。
         ① 临时重建老表（仅结构，来自 P5 备份 DDL） */
    say('\n→ 临时重建教学域老表（node scripts/_uni-recreate-legacy.mjs）…');
    const rec = spawnSync(process.execPath, [resolve(__dirname, '_uni-recreate-legacy.mjs')], {
      stdio: 'inherit',
    });
    if (rec.status !== 0) throw new Error('临时老表重建失败（中止 seed）');

    /* ③ 搬迁进统一表（幂等：先清统一表再搬） */
    say('\n→ 同步统一表（node scripts/_uni-migrate-p5.mjs）…');
    const mig = spawnSync(process.execPath, [resolve(__dirname, '_uni-migrate-p5.mjs')], {
      stdio: 'inherit',
    });
    say(
      mig.status === 0
        ? '  ✓ 统一表已同步（产品读到的就是本批种子）'
        : '  ✗ 统一表同步失败 —— 手动补跑：node scripts/_uni-migrate-p5.mjs',
    );

    /* ④ 清除临时老表，库里恢复「无老表」状态 */
    say('\n→ 清除临时老表…');
    const drop = spawnSync(
      process.execPath,
      [resolve(__dirname, '_uni-recreate-legacy.mjs'), '--drop'],
      { stdio: 'inherit' },
    );
    say(drop.status === 0 ? '  ✓ 完成' : '  ✗ 清除失败（不影响数据，可手动跑 --drop）');
    say('════════════════════════════════════════════');
    say('\n【演示账号】共 16 个（密码统一 123456）');
    say('  钱守义 qiansy   校长      → ★ 全部 7 个模块（全模块展示）');
    say('  丛玉梅 congym   学管主任  → 大学部班级 / 初高 / 实训');
    say('  张海涛 zhanght  班主任    → 大学部班级（U2601 / U2602，可接收学员）');
    say('  孙敏   sunmin   班主任    → 初高（G2601 / J2602）');
    say('  陈晓峰 chenxf   教员      → 大学部班级（建班「教员」下拉）');
    say('  赵梦雪 zhaomx   助教      → 大学部班级（建班「助教」下拉）');
    say('  孙建龙 sunjl    项目经理  → 实训/就业（升实训「项目经理」下拉）');
    say('  郑一鸣 zhengym  教务老师  → 教务 + 初高（调宿/审批）');
    say('  周杰   zhouj    就业老师  → 实训/就业（SX2601，升实训「就业指导老师」）');
    say('  周铭 zhoum  财务负责人 → 财务管理（全权）');
    say('  刘会计 liukj    财务专员  → 财务管理（写操作）');
    say('  林晓 linx      权限管理员 → 权限管理');
    say('  王经理 wangjl   咨询经理  → 市场咨询');
    say('  张老师 zhangls / 李老师 lilx  咨询师 → 市场咨询');
    say('  admin           系统管理员 → 全部模块（只读）');
  } catch (e) {
    say(`\n✗ 失败：${e.message}`);
    console.error(e);
    process.exitCode = 1;
  } finally {
    await conn.end();
  }
}

main();
