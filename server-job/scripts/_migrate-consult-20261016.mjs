/**
 * 咨询模块补迁移（2026-10-16 分期功能）
 * ============================================================
 * 【背景】
 *   `sql/init/sms_consult.sql` 已经包含 2026-10-16 分期相关的表/列，
 *   但这台库没执行升级 → 学生管理一开就报
 *     「数据表不存在：sms_consult.t_consult_installment_plan」
 *
 * 【本脚本只做加法，不删不改数据】
 *   ① 建 2 张表（IF NOT EXISTS）
 *   ② 给 2 张表补 7 个列（先查 information_schema，缺了才加）
 *
 * 用法：node scripts/_migrate-consult-20261016.mjs [--apply]
 *      默认预演（只打印将执行什么）；加 --apply 才真正执行。
 */

import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env') });
const APPLY = process.argv.includes('--apply');

const DDL = [
  `CREATE TABLE IF NOT EXISTS \`t_consult_installment_plan\` (
    \`id\` varchar(36) NOT NULL COMMENT '分期计划ID',
    \`create_time\` datetime NOT NULL COMMENT '创建时间',
    \`create_by\` varchar(36) DEFAULT NULL COMMENT '创建人ID',
    \`create_by_name\` varchar(50) DEFAULT NULL COMMENT '创建人姓名（快照）',
    \`update_time\` datetime DEFAULT NULL COMMENT '修改时间',
    \`update_by\` varchar(36) DEFAULT NULL COMMENT '修改人ID',
    \`is_deleted\` tinyint(1) NOT NULL DEFAULT '0' COMMENT '逻辑删除',
    \`plan_no\` varchar(32) NOT NULL COMMENT '分期计划号 FP20261016-001',
    \`consult_student_id\` varchar(36) NOT NULL COMMENT '咨询学生ID',
    \`student_name\` varchar(50) DEFAULT NULL COMMENT '学生姓名快照',
    \`student_no\` varchar(32) DEFAULT NULL COMMENT '学号快照',
    \`dept_code\` int DEFAULT NULL COMMENT '部门',
    \`total_amount\` int NOT NULL DEFAULT '0' COMMENT '应收总额（分）',
    \`paid_amount\` int NOT NULL DEFAULT '0' COMMENT '已缴（分，到账才计入）',
    \`discount_amount\` int NOT NULL DEFAULT '0' COMMENT '整单优惠（分）',
    \`pending_amount\` int NOT NULL DEFAULT '0' COMMENT '待缴（分）= total - discount - paid',
    \`stage_count\` int NOT NULL DEFAULT '1' COMMENT '总期数',
    \`paid_stages\` int NOT NULL DEFAULT '0' COMMENT '已结清期数',
    \`status\` int NOT NULL DEFAULT '1' COMMENT '1进行中 2已完成 3已终止',
    \`item_detail\` text COMMENT '费用项明细快照 JSON',
    \`remark\` varchar(200) DEFAULT NULL COMMENT '备注',
    PRIMARY KEY (\`id\`),
    UNIQUE KEY \`uk_cip_plan_no\` (\`plan_no\`),
    KEY \`idx_cip_student\` (\`consult_student_id\`),
    KEY \`idx_cip_status\` (\`status\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='咨询分期计划表'`,

  `CREATE TABLE IF NOT EXISTS \`t_consult_installment_item\` (
    \`id\` varchar(36) NOT NULL COMMENT '期次ID',
    \`create_time\` datetime NOT NULL COMMENT '创建时间',
    \`update_time\` datetime DEFAULT NULL COMMENT '修改时间',
    \`is_deleted\` tinyint(1) NOT NULL DEFAULT '0' COMMENT '逻辑删除',
    \`plan_id\` varchar(36) NOT NULL COMMENT '分期计划ID',
    \`stage_no\` int NOT NULL COMMENT '第几期，从1开始',
    \`due_amount\` int NOT NULL DEFAULT '0' COMMENT '本期应收（分）',
    \`due_date\` date DEFAULT NULL COMMENT '到期日',
    \`paid_amount\` int NOT NULL DEFAULT '0' COMMENT '本期已缴（分）',
    \`status\` int NOT NULL DEFAULT '0' COMMENT '0待缴 1待确认 2已到账 3已顺延(历史)',
    \`postpone_count\` int NOT NULL DEFAULT '0' COMMENT '★ 2026-10-16 自动顺延次数：到期未缴每次自动后移一个周期并+1',
    \`fee_order_id\` varchar(36) DEFAULT NULL COMMENT '关联缴费单ID',
    \`pay_time\` datetime DEFAULT NULL COMMENT '到账时间',
    \`remark\` varchar(200) DEFAULT NULL COMMENT '备注',
    PRIMARY KEY (\`id\`),
    KEY \`idx_cii_plan\` (\`plan_id\`),
    KEY \`idx_cii_order\` (\`fee_order_id\`),
    KEY \`idx_cii_due\` (\`due_date\`, \`status\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='咨询分期期次明细表'`,
];

const COLUMNS = [
  ['t_consult_fee_order', 'plan_id', "varchar(36) DEFAULT NULL COMMENT '★ 2026-10-16 分期：所属分期计划ID（一次性缴费为 NULL）'", 'batch_no'],
  ['t_consult_fee_order', 'stage_no', "int DEFAULT NULL COMMENT '★ 2026-10-16 分期：第几期，从 1 开始（一次性缴费为 NULL）'", 'plan_id'],
  ['t_consult_fee_order', 'total_due_amount', "int DEFAULT NULL COMMENT '★ 2026-10-16 分期：整单应收（分）；一次性缴费为 NULL'", 'stage_no'],
  ['t_consult_fee_order', 'item_detail', "text COMMENT '★ 2026-10-15 合并缴费的明细（JSON 数组：[{feeType,feeTypeName,amount}]）'", 'total_due_amount'],
  ['t_consult_student', 'referrer_name', "varchar(50) DEFAULT NULL COMMENT '转介绍招生老师姓名（来源=转介绍时填）'", 'source_remark'],
  ['t_consult_student', 'referrer_phone', "varchar(20) DEFAULT NULL COMMENT '转介绍招生老师手机号'", 'referrer_name'],
  ['t_consult_student', 'arrear_amount', "int NOT NULL DEFAULT '0' COMMENT '★ 2026-10-16 欠费金额（分），分期计划待缴余额 > 0 即为欠费'", 'loss_reason'],
];

const conn = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: 'sms_consult',
});

const hasTable = async (t) => {
  const [r] = await conn.query(
    `select 1 from information_schema.tables where table_schema='sms_consult' and table_name=? limit 1`,
    [t],
  );
  return r.length > 0;
};
const hasColumn = async (t, c) => {
  const [r] = await conn.query(
    `select 1 from information_schema.columns where table_schema='sms_consult' and table_name=? and column_name=? limit 1`,
    [t, c],
  );
  return r.length > 0;
};

console.log(`${APPLY ? '【执行】' : '【预演】'} sms_consult 补迁移\n`);

for (const ddl of DDL) {
  const name = ddl.match(/`(t_consult_[a-z_]+)`/)[1];
  if (await hasTable(name)) {
    console.log(`  跳过（已存在） ${name}`);
    continue;
  }
  console.log(`  ${APPLY ? '创建' : '将创建'} ${name}`);
  if (APPLY) await conn.query(ddl);
}

for (const [table, col, def, after] of COLUMNS) {
  if (await hasColumn(table, col)) {
    console.log(`  跳过（已有列） ${table}.${col}`);
    continue;
  }
  console.log(`  ${APPLY ? '加列' : '将加列'} ${table}.${col}`);
  if (APPLY) await conn.query(`alter table \`${table}\` add column \`${col}\` ${def} after \`${after}\``);
}

console.log(`\n${APPLY ? '补迁移完成' : '预演结束，加 --apply 执行'}`);
await conn.end();
