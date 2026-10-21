/**
 * 第 4 期 · 步骤 2：统一表切读路由层（v2 ·★学段列已改名 edu_stage）
 * ============================================================
 *
 * 【★★ v2 的关键变化：学段列从 `stage` 改名为 `edu_stage`】
 *
 *   实测发现（第 4 期开工前的审计）：
 *     统一表 `stage` = 学段标识（jh/class/job）← 第 3 期新加
 *     老表   `stage` = 学段内阶段码（初高 101 / 大学 201~206）
 *   **同名、不同义、类型还不同（varchar vs int）**。
 *
 *   不改名的后果：切读时 `where stage = 'class'` 套到老表上
 *   → 变成「找阶段码等于字符串 'class' 的行」→ **一行都找不到，且不报错**。
 *
 *   已在迁移 `20261010_022_rename_uni_stage_to_edu_stage.js` 里把
 *   8 张统一表的学段列改名为 `edu_stage`，老表一列未动（斌哥拍板方案 A）。
 *   老表的阶段码在统一表里叫 `stage_code`（第 3 期已建，实测类型一致）。
 *
 *   → 本文件所有查询条件的 `stage` 全部改为 `edu_stage`。
 *
 * 【★ 改名后的"同名不同义"仍有一处，必须显式映射】
 *   统一表 `t_uni_repeat.from_stage` / `to_stage` 存的仍是**阶段码**（int），
 *   和 `edu_stage` 不是一回事 → 路由层**不做任何转换，原样读出**，
 *   由仓储自己解释（它们本来就 int，语义没变）。
 *
 * 【本层的职责边界】
 *   ✅ 做：老表名 → 统一表名的映射 + 强制注入 edu_stage 过滤
 *   ❌ 不做：列名转换（stage ↔ stage_code 由仓储显式处理）、数据搬运
 *   ❌ 不做：业务判断（状态机、审批角色一律留在仓储）
 *
 * 【为什么必须有这一层，而不是直接改 25 个仓储】
 *   直接改 → 出问题要回退 25 个文件。
 *   这一层 → 出问题只把环境变量去掉，**一个文件、一个常量**。
 *
 * 【环境变量】
 *   TEACHING_UNI_TABLE=1 → 走统一表；不设 → 走老表（默认）
 */

import type { Knex } from 'knex';
import { db as jobDb } from '../../utils/db';
import { commonDb } from '../../class/db';
import type { TeachingStage } from '../shared/dto';

/* ============================================================
 * 开关
 * ============================================================ */

/**
 * ★ 是否让统一域仓储改读 `t_uni_*` 统一表
 *
 * 【切开关的正确顺序（前两步已完成，第三步现在才允许做）】
 *   ① 补齐缺列 + 修类型错误           —— ✅ 步骤 0（20261010_020 / _021）
 *   ② 自检夹具双写（老表 + 统一表）   —— ✅ 步骤 1（八个 `_e2e-*-check.mjs`）
 *   ③ 学段列改名 stage → edu_stage   —— ✅ 20261010_022
 *   ④ 加环境变量启动跑对比回归       —— ⏳ 步骤 2 本步
 */
export const USE_UNI_TABLE = process.env.TEACHING_UNI_TABLE === '1';

/** 某学段是否该走统一表（当前是全局开关，学段粒度留待后续细化） */
export function useUni(stage: TeachingStage): boolean {
  return USE_UNI_TABLE;
}

/* ============================================================
 * 连接
 * ============================================================ */

/** ★ 统一表在 `sms_common`，复用 `class/db.ts` 导出的 `commonDb` */
export const uniDb = commonDb;

/* ============================================================
 * ★ 老表 → 统一表映射（★权威表，改这里等于改全部 25 个仓储的读路径）
 * ============================================================ */

/**
 * key   = `库名.老表名`
 * value = 统一表名
 *
 * ⚠️ 有几个老表在**多个库**里都有（`t_class_info` 初高/大学都有、
 *    `t_class_student` 初高/大学都有）→ 所以 key 必须带库名。
 * ⚠️ 这份映射必须与自检夹具的 `UNI_MAP`（`_e2e-lib.mjs`）**逐行一致**，
 *    不一致 = 双写写一张表、切读读另一张表 → 全部查不到数据。
 */
export const UNI_MAP: Record<string, string> = {
  'sms_class_jh.t_class_info': 't_uni_class',
  'sms_class.t_class_info': 't_uni_class',
  'sms_job.t_job_class': 't_uni_class',
  'sms_class_jh.t_class_student': 't_uni_student',
  'sms_class.t_class_student': 't_uni_student',
  'sms_job.t_student_base': 't_uni_student',
  'sms_job.t_job_class_student': 't_uni_class_student',
  'sms_class_jh.t_class_attendance': 't_uni_attendance',
  'sms_class.t_class_attendance': 't_uni_attendance',
  'sms_class_jh.t_class_exam': 't_uni_exam',
  'sms_class.t_class_exam': 't_uni_exam',
  'sms_job.t_job_exam': 't_uni_exam',
  'sms_class_jh.t_class_exam_field': 't_uni_exam_field',
  'sms_class.t_class_exam_field': 't_uni_exam_field',
  // ★ 第4期步骤3补（2026-10-10）：大学的考试内容项子表原来漏了映射，
  //   症状 = 写子表成功但 detail 读回 contents 为空（老表模式正常）。
  //   t_class_exam_content 的 10 列与 t_uni_exam_content 逐列兼容，只差 edu_stage/stage_code。
  'sms_class.t_class_exam_content': 't_uni_exam_content',
  'sms_class_jh.t_class_repeat': 't_uni_repeat',
  'sms_class.t_class_repeat': 't_uni_repeat',
  'sms_class_jh.t_class_dorm_apply': 't_uni_dorm_apply',
  'sms_class.t_class_dorm_apply': 't_uni_dorm_apply',

  /* ==========================================================
   * ★ 第 4 期 · 第 1 批（2026-10-10 · 宿舍域）补 10 条
   *
   * 【斌哥 2026-10-10 拍板：三学段宿舍统一用实训那套模型】
   *   原文：「初高中、大学、实训都在一个界面，那就都采用实训那套就行」
   *   语义：三学段共用一套「楼栋/房间/床位/在住/换宿单」模型，
   *        数据全部进 `sms_common` 的 `t_uni_dorm_*`，靠 `edu_stage` 区分学段。
   *   → 原先「大学是教务同步的只读数据」这个设定**作废**，
   *     `t_class_dorm_room_sync` / `t_class_dorm_live_sync` 两张同步表
   *     实测均为 **0 行**，本来就没有任何数据进来（大学宿舍页面本来就是空的）。
   *
   * 【★★ 表所在库，容易搞错 —— 4 处都实测确认过】
   *   ① `sms_job.t_job_dorm` 是**房间表**不是楼栋表（它有 room_no/bed_count），
   *      真正的楼栋表是 `sms_job.t_dorm` → 一度映射错，症状是「切读后宿舍全空」。
   *   ② 大学的 `t_class_dorm_room_sync` / `t_class_dorm_live_sync` 在
   *      **`sms_common`**（不是 sms_class）—— 学管项目已有先例：跨库共享表放 common。
   *   ③ 大学的 `t_class_dorm_change_log` 在 **`sms_class`**（不是 sms_class_jh）。
   *   ④ 初高没有 change_log 表（换宿直接改床位，无申请单）。
   *
   * 【换宿单为什么是 t_uni_dorm_change 而不是 t_uni_dorm_change_log】
   *   迁移 `20261010_025` 新建了 33 列的 `t_uni_dorm_change`（实训 31 列全搬）。
   *   原因：老表 `t_job_dorm_change` 31 列，旧的 `t_uni_dorm_change_log` 只有 17 列，
   *   **缺 21 列**，缺的全是换宿核心（old/new 的 dorm_id + bed_id、班主任意见、审批状态）。
   *   → 「从哪换到哪」没了，等于表没建。两张表语义不同，都保留：
   *      `t_uni_dorm_change_log` = 换宿流水日志（before/after 房号）
   *      `t_uni_dorm_change`      = 换宿**申请单**（带审批链）
   */
  // —— 房间（实训的 dorm = 大学/初高的 room，同一张统一表）——
  'sms_job.t_job_dorm': 't_uni_dorm_room',
  'sms_class_jh.t_class_room': 't_uni_dorm_room',
  'sms_common.t_class_dorm_room_sync': 't_uni_dorm_room',
  // —— 床位 ——
  'sms_job.t_job_dorm_bed': 't_uni_dorm_bed',
  'sms_class_jh.t_class_bed': 't_uni_dorm_bed',
  // —— 在住 ——
  'sms_class_jh.t_class_dorm_resident': 't_uni_dorm_resident',
  'sms_common.t_class_dorm_live_sync': 't_uni_dorm_resident',
  // —— 楼栋 ——
  'sms_job.t_dorm': 't_uni_dorm_building',
  // —— 换宿单 ——
  'sms_job.t_job_dorm_change': 't_uni_dorm_change',
  'sms_class.t_class_dorm_change_log': 't_uni_dorm_change_log',

  /* ==========================================================
   * ★ 第 4 期 · 第 2 批（2026-10-10 · 审批链）补 5 条
   *
   * 【★★ 这个映射本该第 1 批就有 —— 它藏了很久】
   *   `teaching/leave/repo.*.ts` 第 33 行写的是 `const T = 't_class_suspend_apply'`，
   *   但下面所有查询用的是**裸 `db(T)` 而不是 `tbl(...)`** —— 这就是审批域
   *   「自检 37/37 全绿但其实一直在读老表」的原因：绿灯验证的是老表，不是新表。
   *   更隐蔽的是 `class/modules/approval`（1997 行、前端在用）读的是**同一批老表**，
   *   两套实现互为掩护 → 谁都没暴露。
   *
   * 【t_uni_approval 87 列 = 三张源表合并，这是归一该有的样子】
   *   sms_class.t_class_suspend_apply   34 列（休学/退学 + 人工审批链）
   *   sms_class_jh.t_class_flow         51 列（初高全流程 + 转班/交棒/复学）
   *   sms_job.t_job_student_leave31 列（实训休学/复学，退款关联）
   *   三表合计 116 列 → 并集去重后 **87 列，一张表装下**，靠 `edu_stage` 区分学段。
   *   → 这是「三学段同一业务」的正确归一形态：**合表不丢字段**。
   *
   * 【审批流水单独一张】
   *   `t_uni_approval_log`（32 列）= 审批动作流水。
   *   ⚠️ 注意语义冲突：审批引擎状态是 `flow_status`/`approval_status`（统一码），
   *     单据自身状态是 `apply_status` —— **两个不是一回事**，跟 `t_uni_repeat`
   *     那组坑同源，改写时不能混用。
   */
  'sms_class.t_class_suspend_apply': 't_uni_approval',
  'sms_class_jh.t_class_flow': 't_uni_approval',
  'sms_job.t_job_student_leave': 't_uni_approval',
  'sms_class.t_class_approval_log': 't_uni_approval_log',
  'sms_class_jh.t_class_approval_log': 't_uni_approval_log',

  /* ------------------------------------------------------------
   * ★ 第 4 期第 2 批：`class/modules/approval` 老审批接口切读
   * ------------------------------------------------------------
   *
   * 【背景：为什么审批要拆成4 张统一表，而不是全塞 t_uni_approval】
   *   老表把「审批引擎」和「单据本体」揉在一起，但**三类单据字段完全不同**：
   *   休学单管的是学籍状态、退费单管的是钱和明细项、升学单管的是班级和成绩快照。
   *   → 硬塞进 `t_uni_approval` 那87 列里会有大量互不相干的空列，
   *     等于把三件不同的衣服缝进一件外套里。**按单据类型分表才是对的归一。**
   *
   * 【实测列覆盖 —— 全部逐列对过，不是凭印象写的】
   *   t_class_refund_apply  22 列 → t_uni_refund22 列缺 0
   *   t_class_refund_item    9 列 → t_uni_refund_item     9 列 缺 0
   *   t_class_upgrade_apply 30 列 → t_uni_upgrade_apply   30 列 缺 0
   *   t_class_approval_log  17 列 → t_uni_approval_log     17 列 缺 0
   *
   * 【★ 唯一一处「缺 5 列」，已查清不是丢数据】
   *   `t_class_transfer`(15) → `t_uni_class_transfer`(46) 缺：
   *     from_user_id / from_user_name / to_user_id / to_user_name / reason
   *   读 `upgrade.route.ts:273` 的写入代码后确认：**老表把这5 列挪用来装班级信息**
   *     from_user_name ← apply.from_class_name（原班级名）
   *     to_user_name   ← toClassName（目标班级名）
   *     reason         ← `升学：{原阶段} → {新阶段}`
   *   → 属于老表的**列语义借用**（字段名和装的不是一回事）。
   *     统一表有语义正确的 `from_class_name` / `to_class_name` / `transfer_reason`，
   *     改写时直接换成正确列名。**这不是数据丢失，是把借用的列名还给它该有的名字。**
   */
  'sms_class.t_class_refund_apply': 't_uni_refund',
  'sms_class.t_class_refund_item': 't_uni_refund_item',
  'sms_class.t_class_upgrade_apply': 't_uni_upgrade_apply',
  'sms_class.t_class_transfer': 't_uni_class_transfer',

  /**
   * ★ 站内通知（第 2 批扫描时才发现的隐藏点）
   *
   * 【为什么容易漏 —— 这个函数的写法很"安全"】
   *   `logApproval` / `sendNotify` 收的是 `Tx`（Knex | Knex.Transaction），
   *   内部 `db('t_class_approval_log')` 长得跟普通连接没两样，
   *   而且**它是三个审批路由共用的公共件**，藏在 `shared/` 下，
   *   扫 `approval/` 目录时天然扫不到。
   *   → 但它写的表一旦被删，「提交申请」会直接挂：
   *     单子建到一半、日志写不进去 → 整个事务回滚。
   *
   * 【实测】t_class_notify 17 列 → t_uni_notify 缺0 列。
   */
  'sms_class.t_class_notify': 't_uni_notify',
  // ★ 第 3 批（学生档案域）新增3 张：consult_push / student_transfer / grade
  'sms_class.t_class_consult_push': 't_uni_consult_push',
  'sms_class.t_class_student_transfer': 't_uni_class_transfer',
  'sms_class.t_class_grade': 't_uni_exam_score',
  // ★ 第 4 批（班级域）新增 2 张：stage_log / training_handoff
  'sms_class.t_class_stage_log': 't_uni_stage_log',
  'sms_class.t_class_training_handoff': 't_uni_handover',

  /* ==========================================================
   * ★ 第 10 批（2026-10-12 · 出勤/通知/催费/费用 四域收尾）新增 5 张
   * ========================================================== */

  /**
   * 【出勤域】
   *   t_class_attendance / t_class_attendance_absent
   *   → t_uni_attendance / t_uni_attendance_detail
   *   老表 15+13 列，统一表 32+19 列，缺 0；唯一类型冲突 phone 已由
   *   迁移 006 加宽到 varchar(32) 对齐。
   */
  'sms_class.t_class_attendance_absent': 't_uni_attendance_detail',

  /**
   * 【催费域】★ 副本与流水是两张表，不合并
   *
   * t_class_urge_log（15 列）= **催费动作流水**
   *   谁在什么时候用什么渠道催了（channel / operator_id / urge_time）
   *   → t_uni_urge_log（17 列）缺 0，直接映射
   *
   * t_class_urge_sync（26 列）= **教务推来的催费副本**
   *   某学生欠多少（fee_type / amount / expire_date / pay_status）+催了几次
   *   → t_uni_urge（28 列 = 26 业务列 + stage_code）
   *
   * 【为什么必须分两张】
   *   实测 t_uni_urge_log 60 行的 student_id 挂 t_uni_fee.id 命中 0
   *   → 副本和流水不是同一件事。
   *   而且副本是「每学生一条」、流水是「每次催一条」，
   *   混表会让记录随催收次数无限膨胀（违反归一铁律④）。
   */
  'sms_class.t_class_urge_log': 't_uni_urge_log',
  'sms_common.t_class_urge_sync': 't_uni_urge',

  /**
   * 【费用域】缴费同步副本
   *   t_class_fee_sync（26 列）→ t_uni_fee（35+5=40 列）
   *
   * 【⚠️ `amount` 列要走 UNI_COL_RENAME → `fee_amount`】
   *   老表叫 amount、统一表叫 fee_amount，是同一件事两个名字。
   *   迁移 006 刻意**没有**建 amount 列 —— 凭空加一列重复金额
   *   会让「欠费 = amount - paid_amount」的算法在两套列之间跑偏。
   *
   * 【为什么放在 sms_common 的映射里而不是 sms_class】
   *   t_class_fee_sync / t_class_urge_sync 本来就住在 sms_common
   *   （共享库的「只读副本」），不是三学段老表——
   *   但它们仍需切读，才能被统一表的种子数据接管。
   */
  'sms_common.t_class_fee_sync': 't_uni_fee',

  /**
   * 【实训侧第 11 批】退费业务表
   *   sms_job.t_job_refund（28 列）→ t_uni_refund（50 列）
   *   实测缺列 0、类型冲突 0，干净对齐。
   *   索引：老表 7 个普通索引，主键 + uk_refund(apply_no, edu_stage)
   */
  'sms_job.t_job_refund': 't_uni_refund',
};

/** 该老表是否已归一（未归一的仓储继续读老表，不受开关影响） */
export function isUnified(dbName: string, table: string): boolean {
  return !!UNI_MAP[`${dbName}.${table}`];
}

/** 老表名 → 统一表名（未归一返回 null） */
export function uniTableOf(dbName: string, table: string): string | null {
  return UNI_MAP[`${dbName}.${table}`] ?? null;
}

/* ============================================================
 * ★ 路由核心
 * ============================================================ */

/**
 * 表路由：返回可直接链式调用的 query builder
 *
 * @param db     **老表所在的 knex 连接**（必须由调用方传入，不能在这里 require）
 * @param dbName 老表所在库名（'sms_class_jh' / 'sms_class' / 'sms_job'）
 * @param table  老表名
 * @param stage  学段
 *
 * ★ 为什么 db 必须由调用方传入：
 *   三个学段的仓储各自 import 不同模块的连接
 *     初高 ← `../../class-jh/utils/db`
 *     大学 ← `../../class/db`
 *     实训 ← `../../utils/db`
 *   在这一层 require 任何一个都会**用错库**（表现：能连上但查不到数据）。
 *   → 所以 db 是参数，不是内部依赖。
 *
 * 返回值两种：
 *   开关关 → `db(老表)`  —— 与切读前**完全一致**（保证默认行为不变）
 *   开关开 → `commonDb(统一表).where({ edu_stage: stage })`
 *
 * ★ 为什么要注入 edu_stage：
 *   统一表把三个学段**合并在一张表**里，老表是每个学段一张表。
 *   不加这个条件 = 大学班级接口会把初高和实训的班级一起查出来。
 */
export function tbl(
  db: Knex,
  dbName: string,
  table: string,
  stage: TeachingStage | 'emp',
): Knex.QueryBuilder {
  if (!USE_UNI_TABLE) return db(table);
  const uni = UNI_MAP[`${dbName}.${table}`];
  if (!uni) return db(table); // 未归一的表 → 仍走老库
  return uniDb(uni).where({ edu_stage: stage });
}

/**
 * ★ `tbl()` 的事务版：在 `trx` 上按同一套映射取查询构造器
 *
 * 【为什么需要】第4期步骤3实测（2026-10-10 · 考试域大学）
 *   `repo.class.ts` 的子表 `t_class_exam_content` 读写全走裸 `db(CT)` / `trx(CT)`
 *   —— 从没接切读层。切读打开后：
 *     主表 t_uni_exam  ✅ 能查到
 *     子表 老库 CT     ❌ 仍是老表
 *   → detail 读回 contents 恒为空（写子表成功、断言子表有行，却读不出来）。
 *   典型症状：**「写得进、读不回来」**。
 *
 * 【怎么用】
 *   事务内把 `trx(CT)` 全替换为 `tblTrx(trx, 'sms_class', CT, STAGE)`。
 *
 * 【★★★ 第 2 批实测踩到的跨库地雷（本函数原来埋着的坑）】
 *   原实现开关关时直接 `return trx(table)`。这**只在 trx 与目标表同库时才对**。
 *   审批链的实情是：
 *     `service.ts` 的 `db` 来自 `src/utils/db.ts` → **连的是 sms_job**
 *     事务 `db.transaction(...)` 因此跑在 sms_job 上
 *     而初高仓储要写 `sms_class_jh.t_class_flow`、大学要写 `sms_class.t_class_suspend_apply`
 *   → `trx('t_class_flow')` 会在 **sms_job 库里**找这张表 → `ER_NO_SUCH_TABLE`
 *     → errorHandler 翻译成「数据表不存在（请先执行 npm run migrate）」
 *     → **极具误导**：迁移全跑了，是代码用错了连接。
 *
 *   为什么老代码没事：它写的是 `conn('sms_class_jh.t_class_flow')` ——
 *   knex 支持「`库名`.`表名`」简写，会**自己切到该库**，不依赖当前连接是哪个库。
 *   → 所以这里必须还原这个能力，不能退化成裸 `table`。
 */
export function tblTrx(
  trx: Knex,
  dbName: string,
  table: string,
  stage: TeachingStage | 'emp',
): Knex.QueryBuilder {
  // ⚠️ 开关关时也要带库名前缀（跨库事务场景，见上方说明）
  if (!USE_UNI_TABLE) return trx(`${dbName}.${table}`);
  const uni = UNI_MAP[`${dbName}.${table}`];
  if (!uni) return trx(`${dbName}.${table}`);
  // ⚠️ 跨库事务：trx 来自 job 连接（sms_job），写 sms_common 会脱离这个事务。
  //   目前各域「子表与主表同库同表」的写法都是分步写，事务性由业务层保证；
  //   若将来需要真跨库事务，要改用两阶段提交，不要以为这里已经有原子性了。
  return uniDb(uni).where({ edu_stage: stage });
}

/**
 * 插入包装：切读后写入统一表时**必须补 edu_stage**
 *
 * ★ 为什么必须包一层：
 *   统一表的 `edu_stage` 是 `NOT NULL` 且**故意没有默认值**
 *   （迁移 20261010_022 去掉了 `DEFAULT 'jh'`）。
 *   仓储里的 insert 语句不可能知道自己在写哪个学段（老表是每个学段一张表），
 *   → 不补就是 `Field 'edu_stage' doesn't have a default value`。
 *
 * ⚠️ 报错信息容易被误读：它长得像「迁移脚本没跑」，实际是「写入方没传学段」。
 *   这就是当初把默认值从 'jh' 去掉的目的 —— **当场炸，不静默写错学段**。
 */
export function ins(
  db: Knex,
  dbName: string,
  table: string,
  stage: TeachingStage | 'emp',
  payload: Record<string, any>,
): Knex.QueryBuilder {
  if (!USE_UNI_TABLE) return db(table).insert(payload);
  const uni = UNI_MAP[`${dbName}.${table}`];
  if (!uni) return db(table).insert(payload);
  return uniDb(uni).insert({ ...payload, edu_stage: stage });
}

/**
 * 更新包装：切读后统一表的 update 必须带 edu_stage 条件
 *
 * 不带的话会跨学段误更新（统一表三个学段的数据在同一张表里）。
 * 仓储里的 `where({ id })` 也要被补上 `edu_stage` ——
 * 因为 `id` 是随机 UUID，全表唯一，理论上不会撞，但**加上学段才是正确语义**。
 */
export function upd(
  qb: Knex.QueryBuilder,
  dbName: string,
  table: string,
  stage: TeachingStage | 'emp',
): Knex.QueryBuilder {
  if (!USE_UNI_TABLE) return qb;
  return qb.where({ edu_stage: stage });
}

/**
 * 事务版路由（写路径用）
 *
 * ⚠️⚠️ **第 4 期步骤 2 刻意不切这 4 个混合事务函数**（斌哥拍板）：
 *   attendance/repo.class.ts::save()
 *   attendance/repo.classJh.ts::save()
 *   exam/repo.class.ts::save() / ::remove()
 *   它们在**同一个事务里**既写已归一表又写未归一表，
 *   切读后两者在不同数据库 → knex 事务只绑定一个连接 → 做不到原子性。
 *   → 这些函数继续用老库的 `db.transaction` + `trx(老表名)`。
 *   → 到第 4 期步骤 5（出勤明细归一）后 attendance 就不再混合；
 *     步骤 3（考试内容归一）后 exam 也不再混合。届时再切。
 */
export function trxTbl(
  trx: any,
  dbName: string,
  table: string,
  stage: TeachingStage | 'emp',
): any {
  if (!USE_UNI_TABLE) return trx(table);
  const uni = UNI_MAP[`${dbName}.${table}`];
  if (!uni) return trx(table);
  return trx(uni).where({ edu_stage: stage });
}

/* ============================================================
 * ★ 写入（insert）
 * ============================================================
 *
 * 【★ 为什么不能把 `edu_stage` 直接写在仓储的 payload 里】
 *   迁移 022 之后 `edu_stage` **只在统一表存在**，老表没有这列。
 *   如果在仓储里硬写 `.insert({ edu_stage: STAGE, ... })`：
 *     开关关（读老表）→ 往老表插一个不存在的列
 *     → `Unknown column 'edu_stage' in 'field list'`
 *     → 被 errorHandler 翻译成「数据库字段不存在（可能是迁移脚本没跑）」，
 *       **极具误导性**（实际迁移都跑了，是代码写死了）。
 *   → 所以「往 payload 里塞 edu_stage」这件事必须收在路由层，
 *     而且要**跟着开关走**：开关关时原样透传，一个字段都不加。
 *
 * 用法：把 `tbl(db,库,表,STAGE).insert({...})` 换成
 *      `tblIns(db,库,表,STAGE,{...})`
 */
/**
 * ★ 统一表有、老表没有的列（切读关时必须剔除，否则 ER_BAD_FIELD_ERROR）
 *
 * 【本轮踩出来的，具体两条】
 *   `room_id` / `room_no` —— `t_uni_dorm_bed` 有，老表 `t_job_dorm_bed` 用
 *   `dorm_id` / `dorm_no`。但 `uk_dorm_bed(room_id, bed_no, edu_stage)`
 *   **是带 room_id 的唯一索引** → 切读时必须写，切读关时必须剔，两个都要。
 *
 * 【为什么收在路由层而不是仓储里 if】
 *   之前在 `syncBeds` 里写死 `room_id: dormId`，结果老表模式直接炸
 *   `Unknown column 'room_id' in 'field list'`。
 *   → 「写什么」由仓储决定，「给哪张表写哪些列」由这一层决定，各管一段。
 */
/**
 * ★ 候选「统一表专有列」= 两套叫法都算上，**是否真剔除由目标表的真实列决定**
 *
 * 【为什么不能一刀切按名单剔 —— 本轮踩的坑】
 *   原来名单只有 `['room_id','room_no']`，`stripUniOnlyCols` 无条件剔。
 *   但 `room_no` 其实是**老表 `sms_job.t_job_dorm`（房间表）自带的合法列**
 *   （房间表的主键语义就是 dorm_no + room_no）→ 被误剔 →
 *   `Field 'room_no' doesn't have a default value`，新建房间直接挂。
 *   同一个 `room_no`，在房间表是「老表原有列」，在床位表才是「统一表专有列」。
 *   → 列名不能判断归属，**只有目标表自己的 schema 能判断**。
 *
 * 【★ `apply_no` 是第 4 期第 2 批加进来的（第 3 批审批链）】
 *   `t_uni_approval` 有 `apply_no`，唯一索引 `uk_approval(apply_no, edu_stage)`。
 *   而**初高 `t_class_flow` 和实训 `t_job_student_leave` 实测都没有这一列**
 *   （只有大学 `t_class_suspend_apply` 有）。
 *   → 切读时必须写（否则落空串、同学段第二行就撞），老表模式必须剔
 *     （否则 `Unknown column 'apply_no' in 'field list'`）。
 *   → 三种情况一份名单全靠 `legacyColumnsOf()` 现场判定，不用在仓储里 if。
 */
const UNI_ONLY_COLS = new Set(['room_id', 'room_no', 'apply_no']);

/**
 * ★★ 切读时的**列名翻译表**（第 4 期第 2 批 · 转班记录）
 *
 * 【为什么需要这一层，而不只是"剔掉不存在的列"】
 *   `t_class_transfer` 的 5 个列名在统一表里**语义变了**：
 *     老表 from_user_name← 实际装的是「原班级名」（字段名和装的内容不是一回事）
 *     老表 to_user_name   ← 实际装的是「目标班级名」
 *     老表 reason         ← 实际装的是「转班原因」
 *   统一表把这层借用纠正了，列名变成 `from_class_name` / `to_class_name` /
 *   `transfer_reason`。
 *   → 光"剔掉不存在的列"会让转班记录**整条信息丢失**（原班级、目标班级、原因全没了），
 *     而这正是转班业务最需要的三项。症状是写入直接ER_BAD_FIELD_ERROR。
 *
 * 【为什么只给这一张表做，而不是搞成全局别名机制】
 *   别名机制一旦铺开，将来每张表都能"随便写列名"，最后没人知道实际存了哪列。
 *   本表是唯一实测出列语义借用的，按表精确登记最省心也最安全。
 *   新增前请先用information_schema 逐列核对，别凭印象加。
 *
 * 【key 是 `${dbName}.${table}`，value 是 { 老列名: 统一表列名 }】
 *   只在**切读时**改名；老表模式原样保留（老表本来就只有老列名）。
 */
const UNI_COL_RENAME: Record<string, Record<string, string>> = {
  'sms_class.t_class_transfer': {
    from_user_name: 'from_class_name',
    to_user_name: 'to_class_name',
    reason: 'transfer_reason',
    // from_user_id / to_user_id 在老代码里恒为 null，且统一表无对应列
    //→ 直接归入「统一表专有列」由 stripUniOnlyCols 剔除，不需要 rename。
  },

  /**
   * ★ 第 4 期第 5 批（2026-10-11 · 宿舍域）：住宿表的房间指向列改名
   *
   * 【为什么是「正名」而不是「另建映射」】
   *   老表 `t_class_dorm_live_sync` 用 `dorm_id` / `dorm_no` 指房间，
   *   但**它装的其实是房间 id / 房间号**，不是「宿舍号」—— 这是老表的命名遗留。
   *   统一表 `t_uni_dorm_resident` 把它正名为 `room_id` / `room_no`，
   *   与 `t_uni_dorm_bed.room_id`（床位指向房间）同一口径 ——
   *   这正是第 1 批「三学段采用实训那套模型」的成果，全库一致才叫归一。
   *
   * 【⚠️ 这里只管写入，读路径不会自动改名】
   *   `toUniColumns` 只在 insert payload 上做改名；
   *   **查询条件里的列名一律不翻译**（路由层不做业务列名改写，
   *   否则每张表都要维护别名，最后没人知道实际查的是哪列）。
   *   → 读路径由业务代码自己按开关取列名，见
   *     `class/modules/dorm/dorm.route.ts` 的 `liveRoomIdCol()` / `liveRoomNoCol()`。
   *
   * 【为什么这张表必须有 rename，而不能靠「剔除不存在的列」】
   *   剔除只能保证「不报错」，但 `dorm_id` 的数据会被**整列丢掉** →
   *   住宿记录全部失去「住哪间房」的关联，而症状只是「房间显示为空」，不报错。
   *   → 所以必须 rename 保住数据。
   */
  'sms_common.t_class_dorm_live_sync': {
    dorm_id: 'room_id',
    dorm_no: 'room_no',
  },

  /**
   * ★★ 第 10 批（2026-10-12 · 费用域）：缴费副本的金额列改名
   *
   * 【为什么这一条特别重要 —— 不改的症状是「静默算错钱」】
   *   老表 `t_class_fee_sync.amount` 与统一表 `t_uni_fee.fee_amount`
   *   是同一笔钱（应收金额），只是老表名字短。
   *
   *   如果只做「剔除统一表没有的列」（常见做法）：
   *     insert 路径 → amount 被剔掉 → 走DEFAULT → fee_amount=0
   *     update 路径 → amount 保留 → **Unknown column 报错**
   *   → 接口 200 但 `failed=1`，错误藏在 errors[].reason 里。
   *
   *   更隐蔽的是：如果统一表恰好也有个默认值的 amount 类列，
   *   金额会**静静地写成 0**，
   *   /fee/summary 算出的 totalUnpaid 变成 0 元，
   *   student.route.ts 的欠费人数统计恒为 0 —— **不报任何错**。
   *
   * 【范围】只管写入（insert + update 两条路径都过，见 uniUpdCols）。
   *   读路径的列名由业务代码按开关取，见 fee.route.ts 的 `amountCol()`。
   */
  'sms_common.t_class_fee_sync': {
    amount: 'fee_amount',
  },
};

/** 取某张老表对应的列名翻译表（没有则空对象） */
function colRenameOf(dbName: string, table: string): Record<string, string> {
  return UNI_COL_RENAME[`${dbName}.${table}`] ?? {};
}

/**
 * ★★ 更新 payload 的列名翻译（第 4 期第 5 批 · 宿舍域实测踩到）
 *
 * 【为什么 `toUniColumns` 不够用】
 *   它只在 **insert** 路径上被调用（`tblIns` / `tblInsTrx`）。
 *   而 `/sync` 的 upsert 是**先查后写**：查到已存在的行就走 `.update({...fields})`
 *   —— 这条路径**从来没经过任何翻译** → 切读时把 `dorm_id` 原样送进
 *   `update t_uni_dorm_resident ... set dorm_id = ?`
 *   → `Unknown column 'dorm_id' in 'field list'`。
 *
 * 【症状为什么极具误导】
 *   首次同步成功（走 insert，有翻译），**第二次同步必失败**（走 update，没翻译）
 *   → 接口照样返回 200，只是 `failed` 从 0 变成 1、错误藏在 `errors[].reason` 里
 *   → 不看 `errors` 就会以为「同步是好的」。
 *   这也是为什么自检必须断言 `failed === 0` **并打印 errors[].reason**。
 *
 * 【修法】新增这个函数，在**业务代码写 update 的地方**先过一遍：
 *   `patch = await uniUpdCols(commonDb, 'sms_common', 't_class_dorm_live_sync', patch)`
 *   开关关时原样返回（零行为变化），开关开时按翻译表改名并剔除统一表没有的列。
 */
export async function uniUpdCols(
  db: Knex,
  dbName: string,
  table: string,
  patch: Record<string, any>,
): Promise<Record<string, any>> {
  const uni = USE_UNI_TABLE ? UNI_MAP[`${dbName}.${table}`] : null;
  if (!uni) {
    /**
     * 开关关：**仍要剔掉老表没有的列**。
     *   反例（本轮实测）：`/sync` 现在会同时写 `room_no`（为切读的 uk_dorm_room 三元组），
     *   而老房间表 `t_class_dorm_room_sync` 只有 19 列、**没有 room_no**
     *   → `Unknown column 'room_no' in 'field list'`，
     *   而且只在「第二次同步（走 update）」时才炸 —— 首次 insert 走的是另一条剔除逻辑。
     *   → 开关关时也必须按**老表真实列清单**剔，不能原样返回。
     */
    return stripUniOnlyCols(db, dbName, table, patch);
  }
  const cols = await uniColumnsOf(uni);
  const rename = colRenameOf(dbName, table);
  const out: Record<string, any> = {};
  for (const k of Object.keys(patch)) {
    const target = rename[k] ?? k;
    if (!cols.has(target)) continue;
    out[target] = patch[k];
  }
  return out;
}

/**
 * 切读写统一表前的列名翻译
 *
 * 只做两件事：
 *   1. 命中翻译表的列 → 改名成统一表的正确列名
 *   2. 统一表**根本没有**的列 → 剔除（老代码写了统一表不认的列，写进去必挂）
 */
function toUniColumns(
  dbName: string,
  table: string,
  payload: Record<string, any>,
  uniCols: Set<string>,
): Record<string, any> {
  const rename = colRenameOf(dbName, table);
  const out: Record<string, any> = {};
  for (const k of Object.keys(payload)) {
    const target = rename[k] ?? k;
    // 目标表没这一列 → 剔（对齐 stripUniOnlyCols 的行为，但按统一表列判定）
    if (!uniCols.has(target)) continue;
    out[target] = payload[k];
  }
  return out;
}

/**
 * 查一张统一表真实有哪些列（带进程内缓存）
 *
 * ★ 用`uniDb`（= commonDb，固定连 sms_common）查，不要接受调用方传连接 ——
 *   `uniDb(x)` 返回的是 QueryBuilder 不是 Knex 实例，传进来类型就不对；
 *   而且统一表**全部**在 sms_common，没有按连接区分的必要。
 */
const UNI_COLS_CACHE = new Map<string, Set<string>>();
async function uniColumnsOf(table: string): Promise<Set<string>> {
  let cols = UNI_COLS_CACHE.get(table);
  if (cols) return cols;
  const rows = await uniDb
    .select(uniDb.raw('COLUMN_NAME AS name'))
    .from(uniDb.raw('information_schema.COLUMNS'))
    .whereRaw('TABLE_SCHEMA = ? AND TABLE_NAME = ?', ['sms_common', table]);
  cols = new Set(rows.map((r: any) => r.name || r.COLUMN_NAME));
  UNI_COLS_CACHE.set(table, cols);
  return cols;
}

/**
 * ★ 第 4 批新增：查一张统一表**不允许为 NULL** 的列（带进程内缓存）
 *
 * 【为什么必须有这个 —— 归一铁律③「NOT NULL 一律给默认」的补充】
 *   统一表很多列是 `NOT NULL DEFAULT ''`（比如 `t_uni_class.head_teacher_id`）。
 *   但**列上有 DEFAULT 不等于可以显式传 null**：
 *   knex 传 `{head_teacher_id: null}` 是「显式给NULL」，MariaDB 直接报
 *   `Column 'head_teacher_id' cannot be null`；只有「键根本不出现在 insert 里」才会走 DEFAULT。
 *
 *   老表侧这些列是可空的（业务允许留空），所以老表模式一路绿灯，
 *   切读统一表时才炸 —— 而且是 `Column 'xxx' cannot be null`，从报错看不出是哪个业务字段。
 *
 * 【症状实测】
 *   班级域`/add` 建班没传教员 → `Column 'teacher_id' cannot be null`
 *   →修法：插入统一表前，把「统一表 NOT NULL」且「值为 null/undefined」的列**整个键删掉**，
 *     让它走DEFAULT，而不是传 null。
 *
 *  ★ 这是**通用层防御**，不针对某一张表 —— 后面几个域（宿舍/成绩/咨询）都会踩同一个坑。
 */
const UNI_NOTNULL_CACHE = new Map<string, Set<string>>();
async function uniNotNullColsOf(table: string): Promise<Set<string>> {
  let cols = UNI_NOTNULL_CACHE.get(table);
  if (cols) return cols;
  const rows = await uniDb
    .select(uniDb.raw('COLUMN_NAME AS name'))
    .from(uniDb.raw('information_schema.COLUMNS'))
    .whereRaw(
      "TABLE_SCHEMA = ? AND TABLE_NAME = ? AND IS_NULLABLE = 'NO'",
      ['sms_common', table],
    );
  cols = new Set(rows.map((r: any) => r.name || r.COLUMN_NAME));
  UNI_NOTNULL_CACHE.set(table, cols);
  return cols;
}

/** 老表列清单缓存：`${dbName}.${table}` → Set<列名> */
const LEGACY_COLS_CACHE = new Map<string, Set<string>>();

/** 查一张老表真实有哪些列（带进程内缓存） */
export async function legacyColumnsOf(
  db: Knex,
  dbName: string,
  table: string,
): Promise<Set<string>> {
  const key = `${dbName}.${table}`;
  let cols = LEGACY_COLS_CACHE.get(key);
  if (cols) return cols;
  const rows = await db
    .select(db.raw('COLUMN_NAME AS name'))
    .from(db.raw('information_schema.COLUMNS'))
    .whereRaw('TABLE_SCHEMA = ? AND TABLE_NAME = ?', [dbName, table]);
  cols = new Set(rows.map((r: any) => r.name || r.COLUMN_NAME));
  LEGACY_COLS_CACHE.set(key, cols);
  return cols;
}

/**
 * 剔除目标老表**不存在**的列（切读关时用）
 *
 * ⚠️ 已改成 async：必须对着目标表的真实列清单剔，不能靠列名名单硬剔。
 *   （`room_no` 在床位表要剔、在房间表要留 —— 同名不同归属。）
 */
export async function stripUniOnlyCols(
  db: Knex,
  dbName: string,
  table: string,
  payload: Record<string, any>,
): Promise<Record<string, any>> {
  const cols = await legacyColumnsOf(db, dbName, table);
  const out: Record<string, any> = {};
  for (const k of Object.keys(payload)) {
    /**
     * ★★★ 第 4 期第 6 批改：从「名单制」改成「老表真实列清单为准」
     *
     *   原写法是`if (UNI_ONLY_COLS.has(k) && !cols.has(k)) continue;`
     *   —— 只剔 `UNI_ONLY_COLS` 名单里那几个列名。
     *   实测踩坑（第 6 批咨询域）：业务代码为了切读补了几列
     *   （`t_uni_class_transfer` 的 `class_id` / `transfer_type` / `transfer_date` / `remark`），
     *   这些**不在名单里** → 老表模式下原样insert → `ER_BAD_FIELD_ERROR`（50002
     *   「数据库字段不存在」），而切读模式完全正常 → 又是「老表挂、切读绿」的假象。
     *
     *   **名单制永远追不上**：只要业务代码给某张表补了新列，名单就得同步维护，
     *   而漏维护的症状是「老表模式整条业务链路 500」。
     *   → 直接以老表真实列清单为准：不在清单里的一律剔。
     *   代价是每次 insert 多一次 `information_schema` 查询（`legacyColumnsOf` 有缓存）。
     */
    if (!cols.has(k)) continue;
    out[k] = payload[k];
  }
  return out;
}

export async function tblIns(
  db: Knex,
  dbName: string,
  table: string,
  stage: TeachingStage | 'emp',
  payload: Record<string, any>,
): Promise<any> {
  const uni = USE_UNI_TABLE ? UNI_MAP[`${dbName}.${table}`] : null;
  if (!uni) return db(table).insert(await stripUniOnlyCols(db, dbName, table, payload));
  const cols = await uniColumnsOf(uni);
  const mapped = toUniColumns(dbName, table, payload, cols);
  // ★ NOT NULL 列收到 null/undefined 时**删掉整个键**，让它走列DEFAULT
  //   （列上有 DEFAULT ≠ 可以显式传 null；显式传 null 会报 `Column 'xxx' cannot be null`）
  const notNull = await uniNotNullColsOf(uni);
  for (const k of Object.keys(mapped)) {
    if (notNull.has(k) && (mapped[k] === null || mapped[k] === undefined)) delete mapped[k];
  }
  return uniDb(uni).insert({ ...mapped, edu_stage: stage });
}

/**
 * ★ 事务版插入（审批链专用）
 *
 * 【和 tblIns 的区别 —— 别混用】
 *   `tblIns(db, ...)`   第一个参数是**普通连接**，用它插等于**脱离事务**。
 *   `tblInsTrx(trx, ...)` 第一个参数是**事务对象**，切读分支也走 `trx`。
 *
 * 【为什么要专门加这个（第 2 批实测踩到）】
 *   `teaching/leave/repo.*.ts` 的 `insert(conn, ...)` / `afterApproved(conn, ...)`
 *   收到的 `conn` 是 service 层 `db.transaction(async (trx) => …)` 传进来的**真事务**。
 *   审批单的「写单 + 改审批链 + 改学生状态」三步必须同生共死：
 *   若插入走了 `uniDb`（独立连接），事务回滚时**统一表那行不会回滚**
 *   → 单子已经建出来、学生状态却没改 → 出现「幽灵申请单」，比报错更难查。
 *
 * ⚠️ 但跨库写（sms_common）与 trx 所属库不同，knex 无法真正把两个库绑进一个事务。
 *   → 切读时**仍然是「脱离事务」**，与 `tblTrx` 同款局限，已在函数注释里显式警告。
 *   本函数的价值是：**开关关时 100% 等价于原 `trx(table).insert()`**，
 *   开关开时的原子性问题与 `tblTrx` 完全一致，不引入新的不一致。
 */
export async function tblInsTrx(
  trx: Knex,
  dbName: string,
  table: string,
  stage: TeachingStage | 'emp',
  payload: Record<string, any>,
): Promise<any> {
  const uni = USE_UNI_TABLE ? UNI_MAP[`${dbName}.${table}`] : null;
  // ⚠️ 同 tblTrx：必须带库名前缀，否则跨库事务会 ER_NO_SUCH_TABLE
  if (!uni) return trx(`${dbName}.${table}`).insert(await stripUniOnlyCols(trx, dbName, table, payload));
  // ⚠️ 同 tblTrx：写 sms_common 会脱离 trx，原子性由业务层保证，不要误以为有事务
  const cols = await uniColumnsOf(uni);
  const mapped = toUniColumns(dbName, table, payload, cols);
  // ★ 同 tblIns：NOT NULL 列收到 null 时删键，让它走 DEFAULT
  const notNull = await uniNotNullColsOf(uni);
  for (const k of Object.keys(mapped)) {
    if (notNull.has(k) && (mapped[k] === null || mapped[k] === undefined)) delete mapped[k];
  }
  return uniDb(uni).insert({ ...mapped, edu_stage: stage });
}

/* ============================================================
 * ★ 阶段码列名（老表 stage ↔ 统一表 stage_code）
 * ============================================================
 *
 * 【为什么需要这一层】
 *   老表 `stage` = **阶段码**（int，初高 101 / 大学 201~206）
 *   统一表 `stage_code` = 阶段码（同一个东西，列名不同）
 *   统一表 `edu_stage` = **学段**（jh/class/job）
 *
 *   迁移 20261010_022 把学段列改名成 `edu_stage` 之后，
 *   老表的 `stage` 必须在读写两侧都翻译成 `stage_code`，
 *   否则切读后「按阶段码筛选」和「阶段码的读写」会静默失效。
 *
 * 【为什么不直接改 20 处仓储代码】
 *   开关关时老表列名必须仍是 `stage`。
 *   → 用一个函数按开关返回列名，是唯一能让两套行为都正确的写法。
 */
export function phaseCodeCol(): string {
  return USE_UNI_TABLE ? 'stage_code' : 'stage';
}

/** 从一行里读阶段码（两套列名都兼容，避免漏改时报 undefined） */
export function readPhaseCode(row: Record<string, any>): any {
  const v = USE_UNI_TABLE ? row.stage_code ?? row.stage : row.stage ?? row.stage_code;
  return v === undefined || v === null || v === '' ? null : Number(v);
}

/* ============================================================
 * 通用查询片段
 * ============================================================ */

/** 统一的「未删除」过滤（学段已由 tbl() 注入） */
export function uniScope<T extends Record<string, any>>(qb: T): T {
  return qb.where({ is_deleted: false });
}

/* ============================================================
 * 各表读取（按学段自动过滤）
 * ============================================================ */

/** 班级（t_uni_class） */
export async function listUniClasses(stage: TeachingStage | 'emp', where: Record<string, any> = {}) {
  const qb = uniDb('t_uni_class').where({ is_deleted: false, edu_stage: stage });
  for (const [k, v] of Object.entries(where)) {
    if (v !== undefined && v !== null && v !== '') qb.andWhere(k, v);
  }
  return qb.select('*');
}

export async function getUniClass(stage: TeachingStage | 'emp', id: string) {
  const r = await uniDb('t_uni_class')
    .where({ id, is_deleted: false, edu_stage: stage })
    .first();
  return r || null;
}

/** 学生主档（t_uni_student） */
export async function listUniStudents(stage: TeachingStage | 'emp', where: Record<string, any> = {}) {
  const qb = uniDb('t_uni_student').where({ is_deleted: false, edu_stage: stage });
  for (const [k, v] of Object.entries(where)) {
    if (v !== undefined && v !== null && v !== '') qb.andWhere(k, v);
  }
  return qb.select('*');
}

export async function getUniStudent(stage: TeachingStage | 'emp', id: string) {
  const r = await uniDb('t_uni_student')
    .where({ id, is_deleted: false, edu_stage: stage })
    .first();
  return r || null;
}

/** 花名册（t_uni_class_student） */
export async function listUniRoster(stage: TeachingStage | 'emp', classId: string) {
  return uniDb('t_uni_class_student')
    .where({ is_deleted: false, edu_stage: stage, class_id: classId })
    .select('*');
}

/** 出勤（t_uni_attendance） */
export async function listUniAttendance(
  stage: TeachingStage | 'emp',
  where: Record<string, any> = {},
) {
  const qb = uniDb('t_uni_attendance').where({ is_deleted: false, edu_stage: stage });
  for (const [k, v] of Object.entries(where)) {
    if (v !== undefined && v !== null && v !== '') qb.andWhere(k, v);
  }
  return qb.select('*');
}

/** 考试（t_uni_exam） */
export async function listUniExams(stage: TeachingStage | 'emp', where: Record<string, any> = {}) {
  const qb = uniDb('t_uni_exam').where({ is_deleted: false, edu_stage: stage });
  for (const [k, v] of Object.entries(where)) {
    if (v !== undefined && v !== null && v !== '') qb.andWhere(k, v);
  }
  return qb.select('*');
}

/** 考试字段（t_uni_exam_field） */
export async function listUniExamFields(stage: TeachingStage | 'emp', examId?: string) {
  const qb = uniDb('t_uni_exam_field').where({ is_deleted: false, edu_stage: stage });
  if (examId) qb.andWhere('exam_id', examId);
  return qb.select('*');
}

/** 末班（t_uni_repeat）—— 注意 from_stage/to_stage 仍是阶段码 int，原样读 */
export async function listUniRepeats(stage: TeachingStage | 'emp', where: Record<string, any> = {}) {
  const qb = uniDb('t_uni_repeat').where({ is_deleted: false, edu_stage: stage });
  for (const [k, v] of Object.entries(where)) {
    if (v !== undefined && v !== null && v !== '') qb.andWhere(k, v);
  }
  return qb.select('*');
}

/** 调宿/退宿申请（t_uni_dorm_apply） */
export async function listUniDormApplies(stage: TeachingStage | 'emp', where: Record<string, any> = {}) {
  const qb = uniDb('t_uni_dorm_apply').where({ is_deleted: false, edu_stage: stage });
  for (const [k, v] of Object.entries(where)) {
    if (v !== undefined && v !== null && v !== '') qb.andWhere(k, v);
  }
  return qb.select('*');
}

/* ============================================================
 * 计数（给 /summary 用）
 * ============================================================ */

export async function countUni(table: string, stage: TeachingStage | 'emp', where: Record<string, any> = {}) {
  const qb = uniDb(table).where({ is_deleted: false, edu_stage: stage });
  for (const [k, v] of Object.entries(where)) {
    if (v !== undefined && v !== null && v !== '') qb.andWhere(k, v);
  }
  const [r] = await qb.count({ n: '*' });
  return Number(r?.n || 0);
}

/**
 * 调试用：把某学段的某张统一表全查出来（自检脚本会用）
 * ⚠️ 生产代码不要用
 */
export async function dumpUni(table: string, stage?: TeachingStage) {
  const qb = uniDb(table).where({ is_deleted: false });
  if (stage) qb.andWhere('edu_stage', stage);
  return qb.select('*').limit(50);
}

/** 确认统一表是否可用 */
export async function pingUni(): Promise<boolean> {
  try {
    await uniDb('t_uni_class').select('id').limit(1);
    return true;
  } catch {
    return false;
  }
}

/** 实训老库仍需要的连接（仓储里其它地方还在用，别删这个 export） */
export { jobDb };
