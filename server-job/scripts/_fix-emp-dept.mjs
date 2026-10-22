/**
 * 数据修复：实训班（edu_stage=job）归入就业部口径 dept_code=3
 * ============================================================
 * 【为什么】
 *   2026-10-21 学生档案收成三学段，就业部 = sms_job 里 dept_code=3 的学生，
 *   而「实训」只是就业部内部的一个阶段（不是并列的部门）。
 *   历史数据里 SX2601 这类实训班 dept_code 写的是 2 →
 *   repo.emp 的范围过滤（empClasses/empStudents 都按 dept_code=3）会把它整班排除，
 *   表现是「项目经理能看到学生档案页面，但一条数据都没有」。
 *   同为实训班的 U2601 dept_code 已经是 3，说明 2 才是脏值。
 *
 * 【做什么】
 *   把 edu_stage='job' 的班级与学员的 dept_code 统一成 3（班级与学员一起改，保持一致）。
 *   幂等：已是 3 的行不动；先备份受影响的行到 数据库导出/ 下的 JSON。
 *
 * 用法：node scripts/_fix-emp-dept.mjs [--dry]
 */

import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env') });
const DRY = process.argv.includes('--dry');

const conn = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: 'sms_common',
});

const classes = await conn.query(
  "select id, class_name, dept_code from t_uni_class where edu_stage='job' and is_deleted=0 and dept_code <> 3",
);
const clsRows = classes[0];
const ids = clsRows.map((r) => r.id);
const stus = ids.length
  ? await conn.query(
      `select id, student_no, class_name, dept_code from t_uni_student
       where edu_stage='job' and is_deleted=0 and dept_code <> 3 and class_id in (${ids.map(() => '?').join(',')})`,
      ids,
    )
  : [[]];
const stuRows = stus[0];

console.log(`待修正：班级 ${clsRows.length} 个 / 学员 ${stuRows.length} 名`);
for (const r of clsRows) console.log(`  班级 ${r.class_name}(${r.id.slice(0, 8)}) dept ${r.dept_code} → 3`);
for (const r of stuRows.slice(0, 12)) console.log(`  学员 ${r.student_no} ${r.student_name} dept ${r.dept_code} → 3`);
if (stuRows.length > 12) console.log(`  … 其余 ${stuRows.length - 12} 名`);

const backup = path.join(ROOT, '..', '数据库导出', `emp-dept-备份-${Date.now()}.json`);
fs.mkdirSync(path.dirname(backup), { recursive: true });
fs.writeFileSync(backup, JSON.stringify({ classes: clsRows, students: stuRows }, null, 2));
console.log(`备份：${backup}`);

if (DRY) {
  console.log('--dry：未执行写入');
} else {
  if (ids.length) await conn.query(`update t_uni_class set dept_code=3 where id in (${ids.map(() => '?').join(',')})`, ids);
  if (stuRows.length) {
    await conn.query(
      `update t_uni_student set dept_code=3 where id in (${stuRows.map(() => '?').join(',')})`,
      stuRows.map((r) => r.id),
    );
  }
  console.log('已修正完成（就业部口径统一为 dept_code=3）');
}

await conn.end();