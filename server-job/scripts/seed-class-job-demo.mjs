/**
 * 演示种子数据（大学部 sms_class + 实训 sms_job）—— 幂等、**只增不删**
 * ============================================================
 *
 * 执行：npm run seed:class-job   （等价于 node scripts/seed-class-job-demo.mjs）
 *
 * 【为什么要有这个脚本】
 *   初高（sms_class_jh）一直有演示数据（见 seed-class-jh-demo.js：4 个班 / 32 名学生 /
 *   流程单），但**大学部和实训部是空的** —— 学籍异动模块在这两个学段上没数据可测：
 *   学生下拉空、列表空、复学选不到班。
 *   本脚本按**同一套规模与口径**把这两个学段补齐。
 *
 * 【★ 与 seed-all-demo.mjs 的区别（别选错）】
 *   - `seed-all-demo.mjs` 是**全系统清空重建**（7 个库），学号体系是 U26/J26/ZX26，
 *     跑它会把现有的初高数据换掉。
 *   - 本脚本**只增不删**，只碰 sms_class / sms_job 的业务表，
 *     已有记录按唯一键（班级名 / 学号 / 固定 id）跳过，可以随便重复跑。
 *
 * 【范围（用户 2026-10-16 确认：只补「学籍异动」这条链）】
 *   · 班级 4 个 + 学生 32 名 + 学籍异动单（休学/退学；实训另含复学）
 *   · 不造宿舍/出勤/考试/缴费/退费 —— 那些是另外的域，
 *     真要全套请用 seed-all-demo.mjs（注意它是破坏性的）。
 *
 * 【★ 三个刻意的口径，都是踩过的坑】
 *   ① 学生姓名**必须唯一**：初高那个脚本用
 *      `SURNAMES[i % 16] + GIVEN[i % 16]`（两个数组用同一个下标）→ 周期只有 16 →
 *      32 个学生里每个名字出现两次，用户按名字搜会搜出两个同名的人。
 *      本脚本用 `SURNAMES[i % 16] + GIVEN[i]`，GIVEN 是 32 个**互不相同**的名字，
 *      所以 32 个姓名天然唯一。
 *   ② 班级 `head_teacher_id` 挂**门户账号真实 id**（从 sms_portal.t_sys_account 现查），
 *      不写 'T001' 这种假 id —— 假 id 会让「班主任按班取数」永远为空
 *      （seed-all-demo.mjs 的注释里专门记过这个坑）。
 *   ③ 实训学号用 `SX26xxx`、大学用 `U26xxx`：**故意不重号**。
 *      因为实训异动审批通过后会把学生状态**跨库同步到 sms_class.t_class_student**
 *      （按 student_no 匹配），两边如果同号，演示时会互相改对方的学生状态。
 *
 * ⚠️ 不写统一表 t_uni_*：本域默认读老表（TEACHING_UNI_TABLE 未开时走老表），
 *    与 seed-class-jh-demo.js 口径一致。
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/* ============================================================
 * 0. 连接（读 server-job/.env，与 seed-all-demo.mjs 同款）
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
const knex = require('knex');
const mkConn = (database) =>
  knex({
    client: 'mysql2',
    connection: {
      host: ENV.DB_HOST || '127.0.0.1',
      port: Number(ENV.DB_PORT || 3306),
      user: ENV.DB_USER || 'root',
      password: ENV.DB_PASSWORD || '',
      database,
      charset: 'utf8mb4',
      timezone: '+08:00',
      dateStrings: true,
    },
    pool: { min: 0, max: 3 },
  });

const DB = {
  cls: ENV.DB_NAME_CLASS || 'sms_class',
  job: ENV.DB_NAME || 'sms_job',
  portal: ENV.DB_NAME_PORTAL || 'sms_portal',
};

const dbCls = mkConn(DB.cls);
const dbJob = mkConn(DB.job);
const dbPortal = mkConn(DB.portal);

/* ============================================================
 * 1. 常量
 * ============================================================ */

/** 部门码（shared-types 的 DeptCode：1 初高部 / 2 大学部；实训不单列，沿用大学部 2） */
const DEPT_UNIV = 2;

/** 学生状态（shared-types 的 StudentStatus） */
const ST = {
  STUDYING: 5,
  SUSPENDED: 6,
  QUIT: 7,
  TRAINING: 8,
  EMPLOYED: 10,
  LOST: 11,
};
const ST_NAME = {
  5: '正式在读',
  6: '休学',
  7: '退学',
  8: '实训中',
  10: '已就业',
  11: '流失',
};

/** 异动类型（统一码：1 休学 / 2 退学 / 3 复学）—— 大学/实训的老表与统一码恒等 */
const BIZ = { SUSPEND: 1, QUIT: 2, RESUME: 3 };
const BIZ_NAME = { 1: '休学', 2: '退学', 3: '复学' };

/**
 * 异动单状态（统一码 1..6）
 * ⚠️ 大学 `apply_status` 与实训 `approval_status` 都**恒等**于这套码；
 *    初高那套不一样（3=已同意），本脚本不涉及。
 */
const LST = { DRAFT: 1, PENDING_MANAGER: 2, PENDING_PRINCIPAL: 3, APPROVED: 4, REJECTED: 5 };
const LST_NAME = { 1: '待提交', 2: '待学管审批', 3: '待校长审批', 4: '已通过', 5: '已驳回' };

const NOW = () => new Date();
const today = () => new Date().toISOString().slice(0, 10);
const dateOffset = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};
/** 日志用 */
const created = [];

/* ============================================================
 * 2. 幂等工具
 * ============================================================ */

/** 按 id 存在则跳过 */
async function ensureId(db, table, id, data) {
  const row = await db(table).where({ id }).first();
  if (row) return { id, skipped: true };
  await db(table).insert({ id, ...data, is_deleted: 0, create_time: NOW(), create_by: 'seed' });
  created.push(`${table} ${id}`);
  return { id, skipped: false };
}

/** 按自定义条件存在则跳过（唯一键就是这里的 where） */
async function ensureBy(db, table, where, data) {
  const row = await db(table).where(where).first();
  if (row) return { id: row.id, skipped: true };
  const id = data.id;
  await db(table).insert({ ...data, is_deleted: 0, create_time: NOW(), create_by: 'seed' });
  created.push(`${table} ${id}`);
  return { id, skipped: false };
}

/* ============================================================
 * 3. 门户账号（班级负责人必须挂真实 id）
 * ============================================================ */

/** 按 account 查门户账号真实 id；查不到返回 null（并告警，不假装成功） */
async function portalIdOf(account) {
  const row = await dbPortal('t_sys_account').where({ account, is_deleted: 0 }).first();
  if (!row) {
    console.warn(`  ⚠️ 门户账号「${account}」不存在 → 班级负责人留空（该账号将看不到这些班级）`);
    return { id: null, name: '' };
  }
  return { id: String(row.id), name: String(row.user_name || '') };
}

/* ============================================================
 * 4. 学生姓名池
 * ============================================================
 *
 * ★ GIVEN 必须是 **32 个互不相同** 的名字：
 *   姓名 = SURNAMES[i % 16] + GIVEN[i]。
 *   因为 GIVEN 两两不同，32 个组合必然两两不同 —— 不存在初高那种重名。
 */
const SURNAMES = ['张', '李', '王', '刘', '陈', '杨', '赵', '黄', '周', '吴', '徐', '孙', '马', '朱', '胡', '郭'];
const UNIV_GIVEN = [
  '子轩', '子涵', '子墨', '雨桐', '思远', '静怡', '一鸣', '浩然', '晓彤', '子豪', '凯文', '欣怡', '子睿', '天佑',
  '雪晴', '志远', '静宜', '远航', '若曦', '嘉怡', '宇轩', '梓涵', '诗涵', '晨曦', '梦琪', '俊杰', '文博', '晓月',
  '一诺', '明轩', '佳琪', '雅娜',
];
const JOB_SURNAMES = ['郑', '林', '何', '高', '罗', '梁', '宋', '唐', '许', '韩', '冯', '邓', '曹', '彭', '曾', '萧'];
const JOB_GIVEN = [
  '浩宇', '雨欣', '嘉豪', '诗琪', '文轩', '雅静', '子骞', '晓晨', '逸凡', '思琪', '昊然', '雨萱', '明杰', '静雯',
  '皓轩', '语彤', '泽宇', '梦洁', '锦程', '思翰', '雨泽', '欣然', '云天', '若涵', '致远', '晓萱', '君豪', '雨萌',
  '子恒', '婉清', '嘉诚', '倩雯',
];

/* ============================================================
 * 5. 大学部
 * ============================================================ */

const UNIV_CLASSES = [
  { id: 'seed-ucls-1', name: 'U2601', stage: 201, room: '教学楼 A-101' },
  { id: 'seed-ucls-2', name: 'U2602', stage: 202, room: '教学楼 A-102' },
  { id: 'seed-ucls-3', name: 'U2603', stage: 203, room: '教学楼 A-201' },
  { id: 'seed-ucls-4', name: 'U2604', stage: 206, room: '教学楼 A-202' },
];

/** 状态分布：27 在读 / 2 休学 / 2 退学 / 1 流失 = 32 人 */
function univStatusOf(i) {
  if (i === 26 || i === 27) return ST.SUSPENDED;
  if (i === 28 || i === 29) return ST.QUIT;
  if (i === 30) return ST.LOST;
  return ST.STUDYING;
}

async function seedUniv(head) {
  console.log('\n【1/2】大学部 sms_class');

  // 5.1 班级
  for (const [i, c] of UNIV_CLASSES.entries()) {
    const stuCount = 8; // 32 人 / 4 班
    await ensureBy(
      dbCls,
      't_class_info',
      { class_name: c.name, is_deleted: 0 },
      {
        id: c.id,
        class_name: c.name,
        dept_code: DEPT_UNIV,
        stage: c.stage,
        head_teacher_id: head.id,
        head_teacher_name: head.name,
        teacher_id: null,
        teacher_name: null,
        assistant_id: null,
        assistant_name: null,
        room: c.room,
        open_date: dateOffset(-120 + i),
        student_count: stuCount,
        class_status: 1, // 开放
        attendance_rate: 96.2,
        university_no: c.name,
      },
    );
  }
  console.log(`  班级：${UNIV_CLASSES.length} 个（${UNIV_CLASSES.map((c) => c.name).join('/')}）`);

  // 5.2 学生（32 名）
  const students = [];
  for (let i = 0; i < 32; i++) {
    const no = `U26${String(i + 1).padStart(3, '0')}`; // U26001 ~ U26032
    const cls = UNIV_CLASSES[i % UNIV_CLASSES.length];
    const name = SURNAMES[i % SURNAMES.length] + UNIV_GIVEN[i];
    const status = univStatusOf(i);
    const age = 18 + (i % 3);
    const r = await ensureBy(
      dbCls,
      't_class_student',
      { student_no: no },
      {
        id: `seed-ustu-${String(i + 1).padStart(2, '0')}`,
        source_system: 'manual',
        source_id: null,
        source_update_time: null,
        sync_status: 1,
        student_no: no,
        student_name: name,
        gender: i % 2 === 0 ? 1 : 2,
        age,
        dept_code: DEPT_UNIV,
        student_status: status,
        stage: cls.stage,
        id_card: null,
        phone: `1360000${String(i + 1).padStart(4, '0')}`,
        parent_phone: `1370000${String(i + 1).padStart(4, '0')}`,
        education: '高中',
        enroll_date: dateOffset(-120),
        repeat_count: 0,
        attendance_rate: 96.5,
        remark: '演示学员（seed-class-job-demo）',
        class_id: cls.id,
        class_name: cls.name,
        head_teacher_id: head.id,
        head_teacher_name: head.name,
        teacher_id: null,
        teacher_name: null,
        assistant_id: null,
        assistant_name: null,
        dorm_id: null,
        dorm_no: null,
        birth_date: `${2026 - age}-05-12`,
        origin: '河南郑州',
        graduate_school: '郑州市实验中学',
        home_address: '河南省郑州市金水区文化路 1 号',
      },
    );
    students.push({ id: r.id, no, name, status, cls, gender: i % 2 === 0 ? 1 : 2 });
  }
  const dist = students.reduce((m, s) => ((m[ST_NAME[s.status]] = (m[ST_NAME[s.status]] || 0) + 1), m), {});
  console.log(`  学生：${students.length} 名，状态分布 ${JSON.stringify(dist)}`);

  // 5.3 学籍异动单（休学/退学；大学复学 2026-10-16 起开放，演示数据仍只造休学/退学）
  const plans = [
    { k: 1, biz: BIZ.SUSPEND, st: LST.APPROVED, idx: 26, reason: '因病休学' },
    { k: 2, biz: BIZ.QUIT, st: LST.APPROVED, idx: 28, reason: '家庭原因退学' },
    { k: 3, biz: BIZ.QUIT, st: LST.PENDING_MANAGER, idx: 0, reason: '长期缺勤，申请退学' },
    { k: 4, biz: BIZ.SUSPEND, st: LST.PENDING_PRINCIPAL, idx: 1, reason: '身体状况不佳，申请休学' },
    { k: 5, biz: BIZ.SUSPEND, st: LST.REJECTED, idx: 2, reason: '申请休学（已被驳回）' },
    { k: 6, biz: BIZ.SUSPEND, st: LST.DRAFT, idx: 3, reason: '拟申请休学（草稿）' },
  ];
  for (const p of plans) {
    const s = students[p.idx];
    await ensureId(dbCls, 't_class_suspend_apply', `seed-uflow-${p.k}`, {
      apply_no: `DEMO-U${String(p.k).padStart(4, '0')}`,
      apply_type: p.biz,
      student_id: s.id,
      student_no: s.no,
      student_name: s.name,
      class_id: s.cls.id,
      class_name: s.cls.name,
      dept_code: DEPT_UNIV,
      id_card: null,
      parent_phone: null,
      apply_reason: p.reason,
      effect_date: dateOffset(-p.k),
      expect_resume_date: p.biz === BIZ.SUSPEND ? dateOffset(60) : null,
      apply_status: p.st,
      applicant_id: head.id,
      applicant_name: head.name,
      apply_time: `${dateOffset(-p.k)} 09:00:00`,
      reject_reason: p.st === LST.REJECTED ? '材料不全，请补齐后再提交' : null,
    });
  }
  console.log(`  异动单：${plans.length} 张（${plans.map((p) => BIZ_NAME[p.biz] + '(' + LST_NAME[p.st] + ')').join('、')}）`);
  return students;
}

/* ============================================================
 * 6. 实训（就业库 sms_job）
 * ============================================================ */

const JOB_CLASSES = [
  { id: 'seed-jcls-1', name: 'SX2601', stage: 301, classroom: '实训基地 B-101' },
  { id: 'seed-jcls-2', name: 'SX2602', stage: 302, classroom: '实训基地 B-102' },
  { id: 'seed-jcls-3', name: 'SX2603', stage: 303, classroom: '实训基地 B-201' },
  { id: 'seed-jcls-4', name: 'SX2604', stage: 304, classroom: '实训基地 B-202' },
];

/** 状态分布：26 实训中 / 2 休学 / 2 退学 / 1 已就业 / 1 流失 = 32 人 */
function jobStatusOf(i) {
  if (i === 26 || i === 27) return ST.SUSPENDED;
  if (i === 28 || i === 29) return ST.QUIT;
  if (i === 30) return ST.EMPLOYED;
  if (i === 31) return ST.LOST;
  return ST.TRAINING;
}

async function seedJob(pm) {
  console.log('\n【2/2】实训/就业 sms_job');

  // 6.1 班级
  for (const [i, c] of JOB_CLASSES.entries()) {
    await ensureBy(
      dbJob,
      't_job_class',
      { class_name: c.name, is_deleted: 0 },
      {
        id: c.id,
        class_name: c.name,
        class_code: c.name,
        dept_code: DEPT_UNIV, // 实训不单列部门码，沿用大学部（与 seed-all-demo.mjs 一致）
        stage: c.stage,
        head_teacher_id: pm.id,
        head_teacher_name: pm.name,
        teacher_id: null,
        teacher_name: null,
        assistant_id: null,
        assistant_name: null,
        classroom: c.classroom,
        open_date: dateOffset(-60 + i),
        close_date: null,
        student_count: 8,
        class_status: 1,
        attendance_rate: 97.0,
        remark: '演示班级（seed-class-job-demo）',
        project_manager_id: pm.id,
        project_manager_name: pm.name,
        employment_teacher_id: pm.id,
        employment_teacher_name: pm.name,
        university_no: c.name,
      },
    );
  }
  console.log(`  班级：${JOB_CLASSES.length} 个（${JOB_CLASSES.map((c) => c.name).join('/')}）`);

  // 6.2 学生（32 名）
  const students = [];
  for (let i = 0; i < 32; i++) {
    const no = `SX26${String(i + 1).padStart(3, '0')}`; // 故意与大学部 U26xxx 不同号（见文件头 ③）
    const cls = JOB_CLASSES[i % JOB_CLASSES.length];
    const name = JOB_SURNAMES[i % JOB_SURNAMES.length] + JOB_GIVEN[i];
    const status = jobStatusOf(i);
    const age = 19 + (i % 3);
    const r = await ensureBy(
      dbJob,
      't_student_base',
      { student_no: no },
      {
        id: `seed-jstu-${String(i + 1).padStart(2, '0')}`,
        student_no: no,
        student_name: name,
        gender: i % 2 === 0 ? 1 : 2,
        age,
        dept_code: DEPT_UNIV,
        class_id: cls.id,
        class_name: cls.name,
        head_teacher_id: pm.id,
        head_teacher_name: pm.name,
        teacher_id: null,
        teacher_name: null,
        assistant_id: null,
        assistant_name: null,
        student_status: status,
        stage: cls.stage,
        phone: `1350000${String(i + 1).padStart(4, '0')}`,
        parent_phone: `1340000${String(i + 1).padStart(4, '0')}`,
        dorm_id: null,
        dorm_no: null,
        education: '高中',
        enroll_date: dateOffset(-60),
        attendance_rate: 97.0,
        repeat_count: 0,
        remark: '演示学员（seed-class-job-demo）',
        birth_date: `${2026 - age}-06-18`,
        native_place: '河南郑州',
        graduate_school: '郑州市实验中学',
        home_address: '河南省郑州市金水区文化路 1 号',
      },
    );
    students.push({ id: r.id, no, name, status, cls, gender: i % 2 === 0 ? 1 : 2 });
  }
  const dist = students.reduce((m, s) => ((m[ST_NAME[s.status]] = (m[ST_NAME[s.status]] || 0) + 1), m), {});
  console.log(`  学生：${students.length} 名，状态分布 ${JSON.stringify(dist)}`);

  // 6.3 学籍异动单（休学/退学/复学）
  const resumeTo = JOB_CLASSES[1]; // 复学落到的班（演示「复学班级」列）
  const plans = [
    { k: 1, biz: BIZ.SUSPEND, st: LST.APPROVED, idx: 26, reason: '因病休学', newCls: null },
    { k: 2, biz: BIZ.RESUME, st: LST.PENDING_MANAGER, idx: 27, reason: '病愈复学', newCls: resumeTo },
    { k: 3, biz: BIZ.QUIT, st: LST.APPROVED, idx: 28, reason: '考核不合格退学', newCls: null },
    { k: 4, biz: BIZ.SUSPEND, st: LST.DRAFT, idx: 0, reason: '拟申请休学（草稿）', newCls: null },
    { k: 5, biz: BIZ.QUIT, st: LST.PENDING_PRINCIPAL, idx: 1, reason: '长期缺勤，申请退学', newCls: null },
  ];
  for (const p of plans) {
    const s = students[p.idx];
    await ensureId(dbJob, 't_job_student_leave', `seed-jflow-${p.k}`, {
      biz_type: p.biz,
      student_id: s.id,
      student_no: s.no,
      student_name: s.name,
      gender: s.gender,
      class_id: s.cls.id,
      class_name: s.cls.name,
      dept_code: DEPT_UNIV,
      head_teacher_id: pm.id,
      head_teacher_name: pm.name,
      attended_hours: 120,
      leave_date: dateOffset(-p.k),
      leave_reason: p.reason,
      approval_status: p.st,
      new_class_id: p.newCls ? p.newCls.id : null,
      new_class_name: p.newCls ? p.newCls.name : null,
    });
  }
  console.log(`  异动单：${plans.length} 张（${plans.map((p) => BIZ_NAME[p.biz] + '(' + LST_NAME[p.st] + ')').join('、')}）`);
  return students;
}

/* ============================================================
 * 7. main
 * ============================================================ */

async function main() {
  console.log('演示数据播种：大学部 + 实训（幂等，只增不删）');
  console.log(`  DB：大学=${DB.cls}｜实训=${DB.job}｜门户=${DB.portal}`);

  const head = await portalIdOf('zhanght'); // 大学部班主任 张海涛
  const pm = await portalIdOf('sunjl'); // 实训项目经理 孙建龙

  const u = await seedUniv(head);
  const j = await seedJob(pm);

  console.log(`\n完成：本次新建 ${created.length} 行（已存在的行自动跳过）`);
  if (created.length) for (const c of created.slice(0, 6)) console.log(`  + ${c}`);
  if (created.length > 6) console.log(`  … 其余 ${created.length - 6} 行略`);

  // 简单自检：三个学段在「学籍异动」里都能取到数据
  const [{ n: uStu }] = await dbCls('t_class_student').where('is_deleted', 0).count({ n: '*' });
  const [{ n: uCls }] = await dbCls('t_class_info').where('is_deleted', 0).count({ n: '*' });
  const [{ n: uFlow }] = await dbCls('t_class_suspend_apply').where('is_deleted', 0).count({ n: '*' });
  const [{ n: jStu }] = await dbJob('t_student_base').where('is_deleted', 0).count({ n: '*' });
  const [{ n: jCls }] = await dbJob('t_job_class').where('is_deleted', 0).count({ n: '*' });
  const [{ n: jFlow }] = await dbJob('t_job_student_leave').where('is_deleted', 0).count({ n: '*' });
  console.log(
    `\n现状：大学 班级=${uCls} 学生=${uStu} 异动单=${uFlow}｜实训 班级=${jCls} 学生=${jStu} 异动单=${jFlow}`,
  );
  console.log(`（本次脚本创建：大学学生 ${u.length} / 实训学生 ${j.length}）`);
}

main()
  .catch((e) => {
    console.error('\n播种失败：', e?.message || e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await dbCls.destroy();
    await dbJob.destroy();
    await dbPortal.destroy();
  });
