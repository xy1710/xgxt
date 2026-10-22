/**
 * 演示数据：就业部（emp）两个班 + 7 名学员
 * ============================================================
 * 用途：就业老师的「学生档案 / 就业日志 / 复盘 / 统计」页面目前全空
 *       （库里 emp 学段 0 条），造一批可看的演示数据。
 *
 * 口径：
 *   · 学段 edu_stage='emp'、stage_key='emp'、部门 dept_code=3（就业部）
 *   · 阶段码取统一阶段字典 301（一阶段）/ 302（二阶段）
 *   · 就业老师 = 周杰（门户 UUID 3ac048b5-… / 权限库 U009，两套都写不进去，
 *     所以写在 employment_teacher_id 的用门户 UUID —— dataScope 两个 id 都比）
 *   · 学员状态：9 待就业 / 10 已就业（就业部页面的可见状态）
 *
 * 幂等：所有行 id 以 `DEMO-EMP-` 开头，重跑会先删后建。
 *
 * 用法：node scripts/_seed-emp-demo.mjs [--drop]
 */

import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env') });
const DROP = process.argv.includes('--drop');

const conn = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: 'sms_common',
});

const TEACHER = { id: '3ac048b5-3866-47cb-b23a-b01fcd3d2b12', name: '周杰' };
const now = new Date();

const CLASSES = [
  {
    id: 'DEMO-EMP-C1',
    class_code: 'QJ2601',
    class_name: '就业部2601期',
    stage_code: 301,
    open_date: '2026-09-01',
    classroom: '就业基地A-201',
    remark: '演示数据',
  },
  {
    id: 'DEMO-EMP-C2',
    class_code: 'QJ2602',
    class_name: '就业部2602期',
    stage_code: 302,
    open_date: '2026-09-15',
    classroom: '就业基地A-202',
    remark: '演示数据',
  },
];

const STUDENTS = [
  ['DEMO-EMP-S1', 'QJ2601001', '王子豪', 1, 9, CLASSES[0]],
  ['DEMO-EMP-S2', 'QJ2601002', '李欣怡', 2, 9, CLASSES[0]],
  ['DEMO-EMP-S3', 'QJ2601003', '陈宇航', 1, 10, CLASSES[0]],
  ['DEMO-EMP-S4', 'QJ2602001', '赵雨桐', 2, 9, CLASSES[1]],
  ['DEMO-EMP-S5', 'QJ2602002', '刘子轩', 1, 10, CLASSES[1]],
  ['DEMO-EMP-S6', 'QJ2602003', '孙梦琪', 2, 9, CLASSES[1]],
  ['DEMO-EMP-S7', 'QJ2602004', '吴俊杰', 1, 10, CLASSES[1]],
];

const PREFIX = 'DEMO-EMP-';

async function dropDemo() {
  await conn.query(`delete from t_uni_student where id like '${PREFIX}%'`);
  await conn.query(`delete from t_uni_class where id like '${PREFIX}%'`);
  // 关联留痕（就业日志/复盘/宿舍）一并清掉，避免孤儿
  for (const t of ['t_uni_employment_log', 't_uni_review']) {
    try {
      await conn.query(`delete from ${t} where student_id like '${PREFIX}%'`);
    } catch {
      /* 表不存在忽略 */
    }
  }
}

await dropDemo();
if (DROP) {
  console.log('演示数据已清除');
  await conn.end();
  process.exit(0);
}

for (const c of CLASSES) {
  await conn.query(
    `insert into t_uni_class
      (id, edu_stage, stage_key, class_code, class_name, stage_code, dept_code, class_status,
       classroom, open_date, employment_teacher_id, employment_teacher_name,
       student_count, is_deleted, remark, create_time, create_by)
     values (?, 'emp', 'emp', ?, ?, ?, 3, 2, ?, ?, ?, ?, 0, 0, ?, ?, 'demo-seed')`,
    [
      c.id, c.class_code, c.class_name, c.stage_code, c.classroom, c.open_date,
      TEACHER.id, TEACHER.name, c.remark, now,
    ],
  );
}

for (const [id, no, name, gender, status, cls] of STUDENTS) {
  await conn.query(
    `insert into t_uni_student
      (id, edu_stage, stage_key, student_no, student_name, gender, dept_code, stage_code,
       class_id, class_name, student_status, is_deleted, remark, create_time, create_by)
     values (?, 'emp', 'emp', ?, ?, ?, 3, ?, ?, ?, ?, 0, '演示数据', ?, 'demo-seed')`,
    [id, no, name, gender, cls.stage_code, cls.id, cls.class_name, status, now],
  );
}

// 班级人数（列表里的 student_count 只是冗余字段，页面上会实时统计；这里顺手对齐）
for (const c of CLASSES) {
  const n = STUDENTS.filter((s) => s[5].id === c.id).length;
  await conn.query(`update t_uni_class set student_count = ? where id = ?`, [n, c.id]);
}

console.log(`已造演示数据：就业部 ${CLASSES.length} 个班、${STUDENTS.length} 名学员`);
console.log(`  班级：${CLASSES.map((c) => `${c.class_name}(${c.class_code})`).join('、')}`);
console.log(`  就业老师：${TEACHER.name}`);
console.log(`  清除：node scripts/_seed-emp-demo.mjs --drop`);

await conn.end();
