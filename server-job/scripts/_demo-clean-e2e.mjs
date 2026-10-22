/**
 * 清理自检夹具残留（默认只预演，不删）
 * ============================================================
 * 用法：
 *   node scripts/_demo-clean-e2e.mjs            # 预演：只统计，不删
 *   node scripts/_demo-clean-e2e.mjs --apply    # 真删（事务内），删前自动备份
 *
 * 【为什么会有这些数据】
 *   17 个 e2e 套件（_e2e-*.mjs）会造「班级/学生/考试」夹具，命名两种：
 *     · E2E 开头（E2E-GRADE-erypke-A / E2Egraypke636177）—— 早期套件
 *     · 自检 开头（自检初高缺师称 / 自检新建大学班）—— 负面用例造了但没删
 *   正常跑完会自己清理；中途失败 / 被打断就会留残留 → 界面上像乱码，
 *   也会污染「目标班级」这类下拉。
 *
 * 【口径】只删「名字以上述前缀开头」的记录及其子表，绝不动其它数据。
 *   --apply 前把命中行整表 dump 到 数据库备份/ 下，可回滚。
 */

import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env') });
const APPLY = process.argv.includes('--apply');

/** 夹具前缀（两种） */
const C = `(class_name like 'E2E%' or class_name like '自检%' or class_name like '【自检】%')`;
const S = `(student_name like 'E2E%' or student_name like '自检%' or student_name like '【自检】%' or student_name like '【自检】%')`;
const E = `(exam_name like 'E2E%' or exam_name like '自检%' or exam_name like '【自检】%')`;

const conn = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: 'sms_common',
});

const ids = async (sql) => (await conn.query(sql))[0].map((r) => String(r.id));

const classIds = await ids(`select id from t_uni_class where ${C}`);
const stuIds = await ids(`select id from t_uni_student where ${S}`);
const examIds = await ids(`select id from t_uni_exam where ${E}`);

const inList = (arr) => (arr.length ? arr.map(() => '?').join(',') : 'null');

// 子表 → 主表，顺序即删除顺序（先子后主）
const plan = [
  ['t_uni_exam_score', `exam_id in (${inList(examIds)}) or student_name like 'E2E%' or student_name like '自检%' or student_name like '【自检】%'`, examIds],
  ['t_uni_exam_content', `exam_id in (${inList(examIds)})`, examIds],
  [
    't_uni_attendance_detail',
    `student_name like 'E2E%' or student_name like '自检%' or student_name like '【自检】%' or attendance_id in (select id from t_uni_attendance where class_id in (${inList(classIds)}) or ${C})`,
    classIds,
  ],
  ['t_uni_attendance', `class_id in (${inList(classIds)}) or ${C}`, classIds],
  [
    't_uni_class_student',
    `class_id in (${inList(classIds)}) or ${C} or student_id in (${inList(stuIds)}) or ${S}`,
    [...classIds, ...stuIds],
  ],
  ['t_uni_repeat', `student_id in (${inList(stuIds)}) or ${S} or from_class_name like '自检%' or to_class_name like '自检%'`, stuIds],
  // ★ 2026-10-22：待接收单（末班/升班/咨询/升学推送）也要清 ——
  //   漏了它，自检单据会一直堆着，把后续套件的列表顶到分页上限。
  [
    't_uni_consult_push',
    `student_name like 'E2E%' or student_name like '自检%' or student_name like '【自检】%' or origin_student_id in (${inList(stuIds)}) or student_no in (${inList(stuIds)}) or consult_no like 'E2E%' or consult_no like 'LB%'`,
    // ⚠️ 绑定要给两份：where 里有 origin_student_id / student_no 两个 IN
    [...stuIds, ...stuIds],
  ],
  ['t_uni_class_transfer', `student_id in (${inList(stuIds)}) or ${S} or from_class_name like '自检%' or to_class_name like '自检%'`, stuIds],
  ['t_uni_approval', `student_id in (${inList(stuIds)}) or ${S}`, stuIds],
  ['t_uni_refund', `student_id in (${inList(stuIds)}) or ${S}`, stuIds],
  ['t_uni_exam', `id in (${inList(examIds)}) or ${E}`, examIds],
  ['t_uni_student', `id in (${inList(stuIds)}) or ${S}`, stuIds],
  ['t_uni_class', `id in (${inList(classIds)}) or ${C}`, classIds],
];

console.log(
  `${APPLY ? '【真删】' : '【预演】'} 夹具：班级 ${classIds.length} · 学生 ${stuIds.length} · 考试 ${examIds.length}\n`,
);

/* ---------- 备份 ---------- */
let backupPath = null;
if (APPLY) {
  const dump = {};
  for (const [table, where, params] of plan) {
    try {
      const [rows] = await conn.query(`select * from ${table} where ${where}`, params);
      if (rows.length) dump[table] = rows;
    } catch (e) {
      console.log(`  ⚠️ 备份跳过 ${table}：${e.code || e.message}`);
    }
  }
  const dir = path.join(ROOT, '..', '数据库备份');
  fs.mkdirSync(dir, { recursive: true });
  backupPath = path.join(dir, `e2e-clean-${new Date().toISOString().slice(0, 10)}-${Date.now()}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(dump, null, 1));
  const total = Object.values(dump).reduce((a, r) => a + r.length, 0);
  console.log(`已备份 ${total} 行 → ${backupPath}\n`);
}

/* ---------- 删除 ---------- */
let total = 0;
if (APPLY) await conn.beginTransaction();
for (const [table, where, params] of plan) {
  try {
    const [[c]] = await conn.query(`select count(*) c from ${table} where ${where}`, params);
    const n = Number(c.c);
    if (!n) continue;
    total += n;
    if (APPLY) await conn.query(`delete from ${table} where ${where}`, params);
    console.log(`  ${APPLY ? '删除' : '命中'} ${String(n).padStart(4)} 行  ${table}`);
  } catch (e) {
    console.log(`  ⚠️ 跳过 ${table}：${e.code || e.message}`);
  }
}
if (APPLY) await conn.commit();

console.log(`\n${APPLY ? '已删除' : '将删除'} ${total} 行（未包含其它数据）`);
if (!APPLY) console.log('确认无误后加 --apply 执行（会自动备份到 数据库备份/）');
else console.log(`备份文件：${backupPath}`);

await conn.end();
