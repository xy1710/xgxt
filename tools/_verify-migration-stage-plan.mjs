/**
 * 迁移 20261016_001 / 002（阶段方案）的可重复验证
 * ============================================================
 *
 * 【为什么需要一个「假升级」测试】
 *   这两个迁移在开发机上跑过一次就再也不会重跑了（knex 有 knex_migrations 记账），
 *   但**部署到别的环境**时它必须能在一个「老库」上安全跑通。
 *   所以这里把真库的**表结构**克隆到临时库，手动拆掉新表/新列还原成「升级前」，
 *   再灌几条数据跑迁移 —— 相当于把「客户环境升级」在本地彩排一遍。
 *
 * 【做法】
 *   ① mysqldump --no-data 克隆 sms_class_jh 结构到 sms_class_jh_migtest
 *   ② 临时库里：DROP TABLE t_class_stage_plan、ALTER TABLE t_class_stage DROP COLUMN plan_id
 *   ③ 灌 3 个阶段 / 1 个班 / 1 个学生（学生的阶段故意写成错值，看迁移会不会纠正）
 *   ④ 跑两个迁移的 up()，断言；再跑一遍 up() 验证幂等
 *   ⑤ DROP DATABASE 收尾（全程不碰真库）
 *
 * 用法：node tools/_verify-migration-stage-plan.mjs   （需要本机 MySQL 在跑）
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server-job');

const require = createRequire(path.join(SERVER, 'package.json'));
require('dotenv').config({ path: path.join(SERVER, '.env') });
const knexLib = require('knex');
const dbConfig = require(path.join(SERVER, 'knexfile.js'))['class-jh'];

const MYSQL = process.env.MYSQL_BIN || 'D:/mysql/bin/mysql.exe';
const DUMP = process.env.MYSQLDUMP_BIN || 'D:/mysql/bin/mysqldump.exe';
const TESTDB = 'sms_class_jh_migtest';
const BASE = ['--protocol=TCP', '-h127.0.0.1', '-P3306', `-u${dbConfig.connection.user}`, `-p${dbConfig.connection.password}`];

const sql = (q) => execFileSync(MYSQL, [...BASE, '-e', q], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed += 1;
};
const countOne = (q) => sql(q).split('\n')[1].trim();

/* ---- 1. 造临时库：克隆结构 → 还原成「升级前」 ---- */
console.log('【准备】克隆 sms_class_jh 结构到临时库，并还原成「升级前」的样子');

const schema = execFileSync(
  DUMP,
  [...BASE, '--no-data', '--skip-comments', '--skip-add-drop-table', '--no-tablespaces', 'sms_class_jh'],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 },
);

sql(`DROP DATABASE IF EXISTS \`${TESTDB}\`; CREATE DATABASE \`${TESTDB}\` DEFAULT CHARACTER SET utf8mb4;`);
try {
  execFileSync(MYSQL, [...BASE], {
    input: `USE \`${TESTDB}\`;\n` + schema.replace(/USE `[^`]+`;/g, `USE \`${TESTDB}\`;`),
    encoding: 'utf8',
    stdio: ['pipe', 'ignore', 'pipe'],
  });
} catch (e) {
  console.error('导入结构失败：', String(e.stderr || e.message).slice(0, 800));
  process.exit(1);
}

sql(`USE \`${TESTDB}\`;
     SET FOREIGN_KEY_CHECKS=0;
     DROP TABLE IF EXISTS t_class_stage_plan;
     ALTER TABLE t_class_stage DROP COLUMN plan_id;
     DELETE FROM t_class_stage;
     INSERT INTO t_class_stage (id, create_time, create_by, is_deleted, stage_code, stage_name, dept_code, study_months, sort_no)
     VALUES ('s101', NOW(), 'test', 0, 101, '预科', 1, 3, 0),
            ('s102', NOW(), 'test', 0, 102, '初中部1期', 1, 6, 1),
            ('s201', NOW(), 'test', 0, 201, '一阶段', 2, 4, 2);
     DELETE FROM t_class_info;
     INSERT INTO t_class_info (id, create_time, create_by, is_deleted, class_name, stage, dept_code, class_status, student_count)
     VALUES ('c1', NOW(), 'test', 0, 'G104', 102, 1, 1, 1);
     DELETE FROM t_class_student;
     INSERT INTO t_class_student (id, create_time, create_by, is_deleted, student_no, student_name, gender, dept_code, class_id, class_name, stage, student_status)
     VALUES ('st1', NOW(), 'test', 0, 'S0001', '测试学生', 1, 2, 'c1', 'G104', 201, 5);
     SET FOREIGN_KEY_CHECKS=1;`);

const hasTable = () =>
  countOne(`SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='${TESTDB}' AND TABLE_NAME='t_class_stage_plan';`);
const hasCol = () =>
  countOne(`SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='${TESTDB}' AND TABLE_NAME='t_class_stage' AND COLUMN_NAME='plan_id';`);

check('起点：临时库没有 t_class_stage_plan', hasTable() === '0');
check('起点：临时库 t_class_stage 没有 plan_id 列', hasCol() === '0');

/* ---- 2. 跑迁移 ---- */
const db = knexLib({ ...dbConfig, connection: { ...dbConfig.connection, database: TESTDB } });
const mig1 = require(path.join(SERVER, 'migrations-class-jh/20261016_001_create_class_stage_plan.js'));
const mig2 = require(path.join(SERVER, 'migrations-class-jh/20261016_002_seed_stage_plans.js'));

console.log('\n【执行】20261016_001（建表 + 加列）');
await mig1.up(db);
check('t_class_stage_plan 已建', hasTable() === '1');
check('t_class_stage.plan_id 已加', hasCol() === '1');

console.log('\n【执行】20261016_002（按部门归成两个方案 + 学生跟随班级）');
await mig2.up(db);

const [plans] = await db.raw(
  `SELECT dept_code, plan_name FROM t_class_stage_plan WHERE is_deleted=0 ORDER BY dept_code`,
);
check('生成了 2 个方案（初高部 / 大学部）', plans.length === 2, plans.map((p) => `${p.dept_code}:${p.plan_name}`).join(' / '));

const [stages] = await db.raw(
  `SELECT stage_code, dept_code, plan_id FROM t_class_stage WHERE is_deleted=0 ORDER BY dept_code, stage_code`,
);
check('老阶段全部归入方案', stages.length === 3 && stages.every((s) => !!s.plan_id), JSON.stringify(stages));
check(
  '初高部阶段挂初高部方案、大学部阶段挂大学部方案',
  stages.filter((s) => s.dept_code === 1).every((s) => String(s.plan_id).includes('jh')) &&
    stages.filter((s) => s.dept_code === 2).every((s) => String(s.plan_id).includes('uni')),
);
const orphan = await db('t_class_stage').where('is_deleted', 0).whereNull('plan_id').count({ c: '*' }).first();
check('没有游离阶段', Number(orphan.c) === 0, `游离 ${orphan.c} 条`);

const [[stu]] = await db.raw(`SELECT stage, dept_code FROM t_class_student WHERE id='st1'`);
check(
  '学生阶段/部门已跟随所在班级（201/2 → 102/1）',
  Number(stu.stage) === 102 && Number(stu.dept_code) === 1,
  JSON.stringify(stu),
);

/* ---- 3. 幂等 ---- */
console.log('\n【幂等】两个迁移各再跑一遍');
await mig1.up(db);
await mig2.up(db);
const planCount = await db('t_class_stage_plan').count({ c: '*' }).first();
check('方案没有重复生成', Number(planCount.c) === 2, `实际 ${planCount.c}`);
const stillOrphan = await db('t_class_stage').where('is_deleted', 0).whereNull('plan_id').count({ c: '*' }).first();
check('阶段归属没被冲掉', Number(stillOrphan.c) === 0);

await db.destroy();
sql(`DROP DATABASE \`${TESTDB}\`;`);
console.log('\n临时库已删除。结果：' + (failed === 0 ? '全部通过 ✓' : failed + ' 项失败 ✗'));
process.exit(failed === 0 ? 0 : 1);
