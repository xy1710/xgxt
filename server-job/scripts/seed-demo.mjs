/**
 * 演示数据生成脚本（实训 + 就业 合并后通用）
 *
 * 用法：
 *   node scripts/seed-demo.mjs          # 造数据
 *   node scripts/seed-demo.mjs clean    # 清理（只删本脚本造的，前缀 demo- / 学号 S2026 001x|002x）
 *
 * 设计原则：
 *   ① 所有记录的 ID 统一以 `demo-` 开头 → 清理时按前缀删，绝不误伤真实数据
 *   ② 可重复执行（先删后插，幂等）
 *   ③ 只新增，不动现有任何一条数据
 *
 * 造出来的场景：
 *   实训四期1班（开放）  6 人 —— 4 实训中 + 1 休学 + 1 无宿舍
 *   实训四期2班（已结业） 4 人 —— 3 待就业 + 1 已就业（模拟"已转就业"）
 *   实训宿舍 A-301 / A-302 / B-201（含上下铺）
 *   就业基地宿舍 E-101 / E-102 / E-201
 *   就业日志 6 条 · 复盘 3 条 · 考试 1 场 + 成绩 5 条 · 出勤 3 天 · 催费 1 条 · 站内信 2 条
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });
import mysql from 'mysql2/promise';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

/**
 * ★ P8（2026-10-19）：教学域老表已 DROP，本脚本仍按老表列名写数据 ——
 *   流程包成「临时重建老表 → 按老逻辑写 → 定向同步进统一表 → 清除临时老表」。
 *   同步用 `_uni-sync-legacy.mjs --prefix=demo-`（只搬运本脚本造的行，不碰其它数据）。
 */
const SCRIPTS = fileURLToPath(new URL('.', import.meta.url));
const runNode = (script, ...args) =>
  spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], { stdio: 'inherit' });

const DB = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'sms_job',
};
if (!process.env.DB_PASSWORD) throw new Error('DB_PASSWORD is required; configure server-job/.env');

/** 本脚本造的所有记录都带这个前缀 */
const P = 'demo-';
/** 本脚本用的学号 */
const STU_NOS = [
  'S20260011', 'S20260012', 'S20260013', 'S20260014', 'S20260015', 'S20260016',
  'S20260021', 'S20260022', 'S20260023', 'S20260024',
];

/** 教师（真人 ID，演示时用 test-TEACH_HEAD@T001 进入即为本人视角） */
const HEAD = { id: 'T001', name: '马志斌' };
const TUTOR = { id: 'T004', name: '周铭' };
const ACAD = { id: 'A001', name: '教务老师' };

const at = (s) => new Date(s);
const D = (s) => s; // DATE / DATETIME 直接给字符串

/* ============================================================
 * 数据定义
 * ============================================================ */

const CLS_T4A = `${P}class-t4a`; // 实训四期1班（开放）
const CLS_T4B = `${P}class-t4b`; // 实训四期2班（已结业）

const CLASSES = [
  {
    id: CLS_T4A,
    class_name: '实训四期1班',
    class_code: 'SX2026010',
    dept_code: 2,
    stage: 3,
    head_teacher_id: HEAD.id,
    head_teacher_name: HEAD.name,
    teacher_id: TUTOR.id,
    teacher_name: TUTOR.name,
    assistant_id: null,
    assistant_name: null,
    classroom: '3号楼201',
    open_date: '2026-09-01',
    close_date: null,
    student_count: 6,
    class_status: 1, // 开放
    remark: '【演示数据】正常在读的班：含实训中 / 休学 / 无宿舍等场景',
  },
  {
    id: CLS_T4B,
    class_name: '实训四期2班',
    class_code: 'SX2026011',
    dept_code: 2,
    stage: 3,
    head_teacher_id: HEAD.id,
    head_teacher_name: HEAD.name,
    teacher_id: TUTOR.id,
    teacher_name: TUTOR.name,
    classroom: '3号楼202',
    open_date: '2026-06-01',
    close_date: '2026-09-20',
    student_count: 4,
    class_status: 4, // 已结业
    prev_class_status: 1,
    remark: '【演示数据】已结业并转就业的班 —— 就业模块的学生都来自这里',
  },
];

/** 学生：s = 状态(6休学 8实训中 9待就业 10已就业) */
const STUDENTS = [
  // ---- 实训四期1班（在读）----
  {
    id: `${P}stu-011`, student_no: 'S20260011', student_name: '周晓明', gender: 1, age: 21,
    student_status: 8, class: CLS_T4A, className: '实训四期1班',
    phone: '13800001101', parent_phone: '13900001101',
    education: '本科', dormId: `${P}dorm-c401`, dormNo: 'C-401',
    native_place: '山东济南', graduate_school: '山东理工大学', home_address: '山东省济南市历下区文化东路 88 号',
    birth_date: '2005-03-12', enroll_date: '2026-09-01',
    admission_teacher: '王寒逸', admission_teacher_phone: '13700002001',
    consult_teacher: '李思雨', consult_teacher_phone: '13700002002',
    remark: '【演示】普通在读生，有宿舍',
  },
  {
    id: `${P}stu-012`, student_no: 'S20260012', student_name: '吴雨桐', gender: 2, age: 20,
    student_status: 8, class: CLS_T4A, className: '实训四期1班',
    phone: '13800001102', parent_phone: '13900001102',
    education: '大专', dormId: `${P}dorm-d301`, dormNo: 'D-301',
    native_place: '江苏南京', graduate_school: '南京工业职业技术大学', home_address: '江苏省南京市鼓楼区中山北路 12 号',
    birth_date: '2006-07-25', enroll_date: '2026-09-01',
    admission_teacher: '王寒逸', admission_teacher_phone: '13700002001',
    consult_teacher: '李思雨', consult_teacher_phone: '13700002002',
    remark: '【演示】普通在读生，有宿舍',
  },
  {
    id: `${P}stu-013`, student_no: 'S20260013', student_name: '郑凯', gender: 1, age: 22,
    student_status: 8, class: CLS_T4A, className: '实训四期1班',
    phone: '13800001103', parent_phone: '13900001103',
    education: '本科', dormId: null, dormNo: null,
    native_place: '河南郑州', graduate_school: '郑州轻工业大学', home_address: '河南省郑州市金水区花园路 66 号',
    birth_date: '2004-11-08', enroll_date: '2026-09-01',
    admission_teacher: '王寒逸', admission_teacher_phone: '13700002001',
    consult_teacher: '李思雨', consult_teacher_phone: '13700002002',
    remark: '【演示】★ 没有宿舍 —— 用来演示「宿舍管理 → 分派宿舍」',
  },
  {
    id: `${P}stu-014`, student_no: 'S20260014', student_name: '何静怡', gender: 2, age: 21,
    student_status: 6, class: CLS_T4A, className: '实训四期1班',
    phone: '13800001104', parent_phone: '13900001104',
    education: '本科', dormId: `${P}dorm-d301`, dormNo: 'D-301',
    native_place: '湖北武汉', graduate_school: '武汉纺织大学', home_address: '湖北省武汉市洪山区珞喻路 200 号',
    birth_date: '2005-05-30', enroll_date: '2026-09-01',
    admission_teacher: '王寒逸', admission_teacher_phone: '13700002001',
    consult_teacher: '李思雨', consult_teacher_phone: '13700002002',
    remark: '【演示】★ 休学中 —— 操作列只应出现「复学」，且保留床位',
  },
  {
    id: `${P}stu-015`, student_no: 'S20260015', student_name: '林子豪', gender: 1, age: 20,
    student_status: 8, class: CLS_T4A, className: '实训四期1班',
    phone: '13800001105', parent_phone: '13900001105',
    education: '大专', dormId: `${P}dorm-c401`, dormNo: 'C-401',
    native_place: '河北石家庄', graduate_school: '河北工业职业技术大学', home_address: '河北省石家庄市裕华区槐安路 9 号',
    birth_date: '2006-02-14', enroll_date: '2026-09-01',
    admission_teacher: '王寒逸', admission_teacher_phone: '13700002001',
    consult_teacher: '李思雨', consult_teacher_phone: '13700002002',
    remark: '【演示】★ 用来演示「退学」：通过后会自动生成退宿单 + 退费单',
  },
  {
    id: `${P}stu-016`, student_no: 'S20260016', student_name: '苏晴', gender: 2, age: 19,
    student_status: 8, class: CLS_T4A, className: '实训四期1班',
    phone: '13800001106', parent_phone: '13900001106',
    education: '高中', dormId: null, dormNo: null,
    native_place: '四川成都', graduate_school: '成都市第十二中学', home_address: '四川省成都市武侯区人民南路 4 段 15 号',
    birth_date: '2007-09-03', enroll_date: '2026-09-01',
    admission_teacher: '王寒逸', admission_teacher_phone: '13700002001',
    consult_teacher: '李思雨', consult_teacher_phone: '13700002002',
    remark: '【演示】无宿舍，成绩偏低（可演示「末班」）',
  },
  // ---- 实训四期2班（已结业 → 已转就业）----
  {
    id: `${P}stu-021`, student_no: 'S20260021', student_name: '许文博', gender: 1, age: 22,
    student_status: 9, class: CLS_T4B, className: '实训四期2班',
    phone: '13800002101', parent_phone: '13900002101',
    education: '本科', dormId: `${P}edorm-e101`, dormNo: 'E-101',
    native_place: '陕西西安', graduate_school: '西安理工大学', home_address: '陕西省西安市雁塔区长安南路 5 号',
    birth_date: '2004-01-20', enroll_date: '2026-06-01',
    remark: '【演示】★ 待就业：就业模块的主角，有 3 条就业日志 + 1 条复盘',
  },
  {
    id: `${P}stu-022`, student_no: 'S20260022', student_name: '秦晓月', gender: 2, age: 21,
    student_status: 9, class: CLS_T4B, className: '实训四期2班',
    phone: '13800002102', parent_phone: '13900002102',
    education: '本科', dormId: `${P}edorm-e201`, dormNo: 'E-201',
    native_place: '浙江杭州', graduate_school: '浙江工商大学', home_address: '浙江省杭州市西湖区文一路 33 号',
    birth_date: '2005-06-18', enroll_date: '2026-06-01',
    remark: '【演示】待就业，有 1 条就业日志 + 1 条复盘',
  },
  {
    id: `${P}stu-023`, student_no: 'S20260023', student_name: '邓一鸣', gender: 1, age: 23,
    student_status: 10, class: CLS_T4B, className: '实训四期2班',
    phone: '13800002103', parent_phone: '13900002103',
    education: '本科', dormId: `${P}edorm-e102`, dormNo: 'E-102',
    native_place: '辽宁沈阳', graduate_school: '沈阳工业大学', home_address: '辽宁省沈阳市和平区南京街 101 号',
    birth_date: '2003-12-05', enroll_date: '2026-06-01',
    remark: '【演示】★ 已就业：做过复盘、已签约，用于「数据统计」页的就业率',
  },
  {
    id: `${P}stu-024`, student_no: 'S20260024', student_name: '高远', gender: 1, age: 22,
    student_status: 9, class: CLS_T4B, className: '实训四期2班',
    phone: '13800002104', parent_phone: '13900002104',
    education: '大专', dormId: null, dormNo: null,
    native_place: '福建厦门', graduate_school: '厦门理工学院', home_address: '福建省厦门市思明区湖滨南路 22 号',
    birth_date: '2004-08-11', enroll_date: '2026-06-01',
    remark: '【演示】待就业，刚转过来还没建日志 —— 用于演示「就业宿舍分派」',
  },
];

/** 实训基地宿舍 */
const DORMS = [
  { id: `${P}dorm-c401`, dorm_no: 'C-401', building: 'C栋（演示楼）', room_no: '401', bed_count: 4, dorm_gender: 1, facility: '独立卫浴/空调', remark: '【演示】男生宿舍' },
  { id: `${P}dorm-c402`, dorm_no: 'C-402', building: 'C栋（演示楼）', room_no: '402', bed_count: 4, dorm_gender: 1, facility: '独立卫浴/空调', remark: '【演示】男生宿舍（全空，演示调换用）' },
  { id: `${P}dorm-d301`, dorm_no: 'D-301', building: 'D栋（演示楼）', room_no: '301', bed_count: 4, dorm_gender: 2, facility: '独立卫浴/空调', remark: '【演示】女生宿舍' },
];

/** 床位占用：bedId → { studentId, studentNo, studentName, gender, date } */
const BED_OCCUPY = {
  [`${P}bed-c-401-1上`]: { s: `${P}stu-011`, no: 'S20260011', name: '周晓明', g: 1, d: '2026-09-01' },
  [`${P}bed-c-401-1下`]: { s: `${P}stu-015`, no: 'S20260015', name: '林子豪', g: 1, d: '2026-09-01' },
  [`${P}bed-d-301-1上`]: { s: `${P}stu-012`, no: 'S20260012', name: '吴雨桐', g: 2, d: '2026-09-01' },
  [`${P}bed-d-301-1下`]: { s: `${P}stu-014`, no: 'S20260014', name: '何静怡', g: 2, d: '2026-09-01' },
};

/** 就业基地宿舍（独立一套，不走审批） */
const EMP_DORMS = [
  { id: `${P}edorm-e101`, dorm_no: 'E-101', building: '就业公寓A栋', floor: 1, room_type: 1, bed_total: 4, remark: '【演示】就业基地男生宿舍' },
  { id: `${P}edorm-e102`, dorm_no: 'E-102', building: '就业公寓A栋', floor: 1, room_type: 1, bed_total: 4, remark: '【演示】就业基地男生宿舍' },
  { id: `${P}edorm-e201`, dorm_no: 'E-201', building: '就业公寓B栋', floor: 2, room_type: 2, bed_total: 4, remark: '【演示】就业基地女生宿舍' },
];

/** 就业日志 */
const ELOGS = [
  { id: `${P}elog-001`, stu: `${P}stu-021`, no: 'S20260021', name: '许文博', cls: '实训四期2班', date: '2026-09-22', resume: 12, invite: 3, cnt: 1, time: '09-25 14:00', company: '杭州数联科技有限公司', position: 'Java 开发工程师', salary: 9000, situation: '一面通过，等二面通知。技术问题答得还行，项目经验讲得不够细。' },
  { id: `${P}elog-002`, stu: `${P}stu-021`, no: 'S20260021', name: '许文博', cls: '实训四期2班', date: '2026-09-25', resume: 8, invite: 4, cnt: 2, time: '09-28 10:00', company: '浙江天软信息技术', position: '后端开发', salary: 8500, situation: '二面（技术+HR）已过，口头 offer，等正式邮件。' },
  { id: `${P}elog-003`, stu: `${P}stu-021`, no: 'S20260021', name: '许文博', cls: '实训四期2班', date: '2026-09-30', resume: 5, invite: 2, cnt: 1, time: '10-01 15:30', company: '杭州数联科技有限公司', position: 'Java 开发工程师', salary: 9000, situation: 'HR 谈薪，期望 9500，对方说再走审批流程。' },
  { id: `${P}elog-004`, stu: `${P}stu-022`, no: 'S20260022', name: '秦晓月', cls: '实训四期2班', date: '2026-09-24', resume: 15, invite: 5, cnt: 2, time: '09-27 09:30', company: '杭州云图数字', position: '前端开发工程师', salary: 8000, situation: '两家都进了复试，简历投递量大，反馈率高。' },
  { id: `${P}elog-005`, stu: `${P}stu-023`, no: 'S20260023', name: '邓一鸣', cls: '实训四期2班', date: '2026-09-18', resume: 10, invite: 6, cnt: 3, time: '09-21 13:00', company: '上海睿智软件', position: 'Java 开发工程师', salary: 11000, situation: '三面通过，已发正式 offer，10-08 入职。' },
  { id: `${P}elog-006`, stu: `${P}stu-024`, no: 'S20260024', name: '高远', cls: '实训四期2班', date: '2026-09-29', resume: 6, invite: 1, cnt: 0, time: '', company: '', position: '', salary: null, situation: '刚转过来，简历还在改，暂无面试邀约。' },
];

/** 复盘 */
const REVIEWS = [
  { id: `${P}review-001`, stu: `${P}stu-023`, no: 'S20260023', name: '邓一鸣', cls: '实训四期2班', reviewTime: '2026-09-21 16:00', interviewTime: '09-21 13:00', position: 'Java 开发工程师', salary: 11000, icon: 3, rcon: 4, detail: '面试官认可项目经验，重点表扬了分布式项目的落地细节。已签约，10-08 入职。复盘要点：项目难点要讲"我解决了什么"，不要只讲流程。' },
  { id: `${P}review-002`, stu: `${P}stu-021`, no: 'S20260021', name: '许文博', cls: '实训四期2班', reviewTime: '2026-09-26 17:00', interviewTime: '09-25 14:00', position: 'Java 开发工程师', salary: 9000, icon: 1, rcon: 2, detail: '一面通过。技术面答题流畅，但讲项目时偏"我做了一个 XX 系统"，缺少量化结果。下轮改进：准备 2 个带数据的项目故事。' },
  { id: `${P}review-003`, stu: `${P}stu-022`, no: 'S20260022', name: '秦晓月', cls: '实训四期2班', reviewTime: '2026-09-28 10:30', interviewTime: '09-27 09:30', position: '前端开发工程师', salary: 8000, icon: 1, rcon: 1, detail: '两家进复试，节奏很好。保持当前投递策略，重点补一下 Vite / 工程化相关内容。' },
];

/** 考试 + 成绩 */
const EXAM = {
  id: `${P}exam-001`,
  exam_name: '实训四期1班·9月阶段考核',
  exam_type: 3, // 阶段考核
  exam_time: '2026-09-28 09:00:00',
  class_ids: CLS_T4A,
  class_names: '实训四期1班',
  content_types: '1,2,3',
  creator_id: HEAD.id,
  creator_name: HEAD.name,
  remark: '【演示】三个学生成绩良好，两个偏低（可演示「末班」）',
};

/** 成绩：paper 卷面 / machine 机试 / interview 面试 */
const SCORES = [
  { s: `${P}stu-011`, no: 'S20260011', name: '周晓明', paper: 88, machine: 92, interview: 85 },
  { s: `${P}stu-012`, no: 'S20260012', name: '吴雨桐', paper: 92, machine: 95, interview: 90 },
  { s: `${P}stu-013`, no: 'S20260013', name: '郑凯', paper: 76, machine: 80, interview: 78 },
  { s: `${P}stu-015`, no: 'S20260015', name: '林子豪', paper: 58, machine: 62, interview: 60 },
  { s: `${P}stu-016`, no: 'S20260016', name: '苏晴', paper: 52, machine: 55, interview: 50 },
];

/** 出勤：最近三天（不含休学的何静怡） */
const ATT_DATES = ['2026-09-28', '2026-09-29', '2026-09-30'];
/** 每人每天的出勤状态（1出勤 2缺勤 3迟到 5请假） */
const ATT_PLAN = {
  [`${P}stu-011`]: [1, 1, 1],
  [`${P}stu-012`]: [1, 1, 3],
  [`${P}stu-013`]: [1, 5, 1],
  [`${P}stu-015`]: [1, 1, 2],
  [`${P}stu-016`]: [3, 1, 1],
};

/* ============================================================
 * 执行
 * ============================================================ */

async function clean(c) {
  const del = async (sql, args = []) => {
    const [r] = await c.query(sql, args);
    return r.affectedRows;
  };
  console.log('===== 清理演示数据（按前缀 demo- 与固定学号）=====');
  const steps = [
    ['t_job_exam_score', `DELETE FROM t_job_exam_score WHERE id LIKE '${P}%' OR exam_id LIKE '${P}%'`],
    ['t_job_exam',        `DELETE FROM t_job_exam WHERE id LIKE '${P}%'`],
    ['t_job_attendance',  `DELETE FROM t_job_attendance WHERE id LIKE '${P}%'`],
    ['t_job_fee_call',    `DELETE FROM t_job_fee_call WHERE id LIKE '${P}%'`],
    ['t_job_notice',      `DELETE FROM t_job_notice WHERE id LIKE '${P}%'`],
    ['t_job_dorm_bed',    `DELETE FROM t_job_dorm_bed WHERE id LIKE '${P}%' OR dorm_id LIKE '${P}%'`],
    ['t_job_dorm',        `DELETE FROM t_job_dorm WHERE id LIKE '${P}%'`],
    ['t_employment_log',  `DELETE FROM t_employment_log WHERE id LIKE '${P}%'`],
    ['t_review',          `DELETE FROM t_review WHERE id LIKE '${P}%'`],
    ['t_dorm',            `DELETE FROM t_dorm WHERE id LIKE '${P}%'`],
    ['t_job_class_student', `DELETE FROM t_job_class_student WHERE id LIKE '${P}%' OR class_id LIKE '${P}%'`],
    ['t_job_student_leave', `DELETE FROM t_job_student_leave WHERE id LIKE '${P}%' OR student_id LIKE '${P}%'`],
    ['t_job_refund',      `DELETE FROM t_job_refund WHERE id LIKE '${P}%' OR student_id LIKE '${P}%'`],
    ['t_job_dorm_change', `DELETE FROM t_job_dorm_change WHERE id LIKE '${P}%' OR student_id LIKE '${P}%'`],
    ['t_student_base',    `DELETE FROM t_student_base WHERE id LIKE '${P}%'`],
    ['t_job_class',       `DELETE FROM t_job_class WHERE id LIKE '${P}%'`],
  ];
  let total = 0;
  for (const [t, sql] of steps) {
    const n = await del(sql);
    total += n;
    if (n > 0) console.log(`  ${t.padEnd(24)} 删除 ${n} 行`);
  }
  console.log(`\n合计清除 ${total} 行。`);
}

async function seed(c) {
  console.log('===== ① 先清理旧演示数据（保证可重复执行）=====');
  await clean(c);

  const base = {
    create_time: at('2026-10-02 10:00:00'),
    create_by: HEAD.id,
    is_deleted: 0,
  };

  console.log('\n===== ② 班级 =====');
  for (const r of CLASSES) {
    await c.query('INSERT INTO t_job_class SET ?', [{ ...base, ...r }]);
    console.log(`  ${r.class_name}  状态=${r.class_status === 1 ? '开放' : '已结业'}  在班 ${r.student_count} 人`);
  }

  console.log('\n===== ③ 学生主档 =====');
  for (const s of STUDENTS) {
    await c.query('INSERT INTO t_student_base SET ?', [{
      ...base,
      id: s.id,
      student_no: s.student_no,
      student_name: s.student_name,
      gender: s.gender,
      age: s.age,
      dept_code: 2,
      stage: 3,
      class_id: s.class,
      class_name: s.className,
      head_teacher_id: HEAD.id,
      head_teacher_name: HEAD.name,
      teacher_id: TUTOR.id,
      teacher_name: TUTOR.name,
      student_status: s.student_status,
      phone: s.phone,
      parent_phone: s.parent_phone,
      education: s.education,
      dorm_id: s.dormId,
      dorm_no: s.dormNo,
      enroll_date: s.enroll_date,
      birth_date: s.birth_date,
      native_place: s.native_place,
      graduate_school: s.graduate_school,
      home_address: s.home_address,
      admission_teacher: s.admission_teacher || null,
      admission_teacher_phone: s.admission_teacher_phone || null,
      consult_teacher: s.consult_teacher || null,
      consult_teacher_phone: s.consult_teacher_phone || null,
      repeat_count: 0,
      remark: s.remark,
    }]);
  }
  const byStatus = (n) => STUDENTS.filter((s) => s.student_status === n).length;
  console.log(`  共 ${STUDENTS.length} 人：实训中 ${byStatus(8)} · 休学 ${byStatus(6)} · 待就业 ${byStatus(9)} · 已就业 ${byStatus(10)}`);

  console.log('\n===== ④ 花名册 =====');
  for (const s of STUDENTS) {
    const inClass = s.student_status === 8 || s.student_status === 6; // 结业班的人已离班
    await c.query('INSERT INTO t_job_class_student SET ?', [{
      ...base,
      id: `${P}cs-${s.student_no}`,
      class_id: s.class,
      class_name: s.className,
      student_id: s.id,
      student_no: s.student_no,
      student_name: s.student_name,
      join_date: s.enroll_date,
      join_type: 1,
      leave_date: inClass ? null : '2026-09-20',
      leave_type: inClass ? null : 5, // 5 结业
      leave_reason: inClass ? null : '班级结业，转就业',
      status: inClass ? 1 : 2,
      remark: inClass ? null : '【演示】随班级结业离班',
    }]);
  }
  console.log(`  共 ${STUDENTS.length} 条（在班 ${STUDENTS.filter((s) => s.student_status === 8 || s.student_status === 6).length} / 已离班 ${STUDENTS.filter((s) => s.student_status === 9 || s.student_status === 10).length}）`);

  console.log('\n===== ⑤ 实训基地宿舍 + 床位 =====');
  for (const d of DORMS) {
    const used = Object.values(BED_OCCUPY).filter((o) => {
      const stu = STUDENTS.find((s) => s.id === o.s);
      return stu && stu.dormId === d.id;
    }).length;
    await c.query('INSERT INTO t_job_dorm SET ?', [{
      ...base,
      ...d,
      used_count: used,
      dept_code: 2,
      dorm_status: 1,
    }]);
    // 按 bed_count 生成上下铺：1上/1下/2上/2下 ...
    const beds = [];
    for (let i = 1; i <= d.bed_count; i++) {
      const pos = i % 2 === 1 ? '上' : '下';
      const idx = Math.ceil(i / 2);
      beds.push(`${idx}${pos}`);
    }
    for (const bedNo of beds) {
      const bedId = `${P}bed-${d.dorm_no.toLowerCase()}-${bedNo}`;
      const occ = BED_OCCUPY[bedId];
      await c.query('INSERT INTO t_job_dorm_bed SET ?', [{
        ...base,
        id: bedId,
        dorm_id: d.id,
        dorm_no: d.dorm_no,
        bed_no: bedNo,
        bed_status: occ ? 2 : 1,
        student_id: occ ? occ.s : null,
        student_no: occ ? occ.no : null,
        student_name: occ ? occ.name : null,
        student_gender: occ ? occ.g : null,
        check_in_date: occ ? occ.d : null,
      }]);
    }
    console.log(`  ${d.dorm_no}（${d.building}）${d.bed_count} 床，已住 ${used}：${beds.join(' / ')}`);
  }

  console.log('\n===== ⑥ 就业基地宿舍（独立一套，不走审批）=====');
  for (const d of EMP_DORMS) {
    await c.query('INSERT INTO t_dorm SET ?', [{ ...base, ...d }]);
    console.log(`  ${d.dorm_no}（${d.building}）${d.bed_total} 床 ${d.room_type === 1 ? '男寝' : '女寝'}`);
  }

  console.log('\n===== ⑦ 考试 + 成绩 =====');
  await c.query('INSERT INTO t_job_exam SET ?', [{ ...base, ...EXAM }]);
  console.log(`  ${EXAM.exam_name}`);
  for (const sc of SCORES) {
    const writtenAvg = Math.round(((sc.paper * 0.5) + (sc.machine * 0.5)) * 100) / 100;
    const total = Math.round(((writtenAvg * 0.5) + (sc.interview * 0.5)) * 100) / 100;
    await c.query('INSERT INTO t_job_exam_score SET ?', [{
      ...base,
      id: `${P}score-${sc.no}`,
      exam_id: EXAM.id,
      exam_name: EXAM.exam_name,
      student_id: sc.s,
      student_no: sc.no,
      student_name: sc.name,
      class_id: CLS_T4A,
      class_name: '实训四期1班',
      paper_score: sc.paper,
      machine_score: sc.machine,
      written_avg: writtenAvg,
      interview_score: sc.interview,
      total_score: total,
      exam_result: null, // 留空 —— 让你自己点「末班」演示
      entry_by: HEAD.id,
      entry_by_name: HEAD.name,
      entry_time: at('2026-09-28 17:00:00'),
    }]);
    console.log(`  ${sc.name}  卷面${sc.paper} / 机试${sc.machine} → 笔试均分${writtenAvg} / 面试${sc.interview} → 综合 ${total}${total < 70 ? '   ← 偏低，可点「末班」' : ''}`);
  }

  console.log('\n===== ⑧ 出勤记录 =====');
  let attN = 0;
  for (const [sid, plan] of Object.entries(ATT_PLAN)) {
    const stu = STUDENTS.find((s) => s.id === sid);
    for (let i = 0; i < ATT_DATES.length; i++) {
      const st = plan[i];
      await c.query('INSERT INTO t_job_attendance SET ?', [{
        ...base,
        id: `${P}att-${stu.student_no}-${i + 1}`,
        class_id: CLS_T4A,
        class_name: '实训四期1班',
        student_id: stu.id,
        student_no: stu.student_no,
        student_name: stu.student_name,
        attend_date: ATT_DATES[i],
        attend_status: st,
        attend_type: st === 5 ? 1 : null,
        reason: st === 5 ? '家中有事' : st === 2 ? '未到且未请假' : null,
        registrar_id: HEAD.id,
        registrar_name: HEAD.name,
      }]);
      attN++;
    }
  }
  console.log(`  ${ATT_DATES.length} 天 × ${Object.keys(ATT_PLAN).length} 人 = ${attN} 条（休学的何静怡不登记）`);

  console.log('\n===== ⑨ 催费单 =====');
  const zxm = STUDENTS.find((s) => s.student_no === 'S20260011');
  await c.query('INSERT INTO t_job_fee_call SET ?', [{
    ...base,
    id: `${P}feecall-001`,
    fee_type: 2, // 住宿费
    student_id: zxm.id,
    student_no: zxm.student_no,
    student_name: zxm.student_name,
    phone: zxm.phone,
    parent_phone: zxm.parent_phone,
    class_id: CLS_T4A,
    class_name: '实训四期1班',
    dept_code: 2,
    head_teacher_id: HEAD.id,
    head_teacher_name: HEAD.name,
    fee_amount: 120000, // 1200.00 元
    due_date: '2026-10-15',
    call_reason: '10 月住宿费尚未缴纳，请班主任联系家长。',
    call_status: 1, // 待催缴
    applicant_id: ACAD.id,
    applicant_name: ACAD.name,
    remark: '【演示】教务发起 → 班主任处理',
  }]);
  console.log('  周晓明 · 住宿费 ¥1,200.00 · 待催缴（等 T001 处理）');

  console.log('\n===== ⑩ 就业日志 =====');
  for (const e of ELOGS) {
    await c.query('INSERT INTO t_employment_log SET ?', [{
      ...base,
      id: e.id,
      student_id: e.stu,
      student_no: e.no,
      student_name: e.name,
      class_name: e.cls,
      log_date: e.date,
      resume_count: e.resume,
      interview_invite: e.invite,
      interview_count: e.cnt,
      interview_time: e.time || null,
      company: e.company || null,
      position: e.position || null,
      salary: e.salary,
      interview_situation: e.situation,
    }]);
    console.log(`  ${e.date}  ${e.name}  投递${e.resume}/邀约${e.invite}/面试${e.cnt}${e.company ? '  ' + e.company : ''}`);
  }

  console.log('\n===== ⑪ 就业复盘 =====');
  for (const r of REVIEWS) {
    await c.query('INSERT INTO t_review SET ?', [{
      ...base,
      id: r.id,
      student_id: r.stu,
      student_no: r.no,
      student_name: r.name,
      class_name: r.cls,
      review_time: r.reviewTime,
      interview_time: r.interviewTime,
      position: r.position,
      salary: r.salary,
      interview_conclusion: r.icon,
      review_conclusion: r.rcon,
      detail: r.detail,
    }]);
    console.log(`  ${r.name}  复盘（面试结论 ${r.icon} / 复盘结论 ${r.rcon}）`);
  }

  console.log('\n===== ⑫ 站内信 =====');
  const notices = [
    { id: `${P}notice-001`, type: 4, title: '实训四期1班已开班', content: '实训四期1班（6 人）已开班，请及时录入成绩与出勤。', biz: null },
    { id: `${P}notice-002`, type: 4, title: '实训四期2班已结业转就业', content: '实训四期2班 4 名学生已转入就业阶段，请就业老师跟进。', biz: CLS_T4B },
  ];
  for (const n of notices) {
    await c.query('INSERT INTO t_job_notice SET ?', [{
      ...base,
      id: n.id,
      notice_type: n.type,
      title: n.title,
      content: n.content,
      receiver_id: HEAD.id,
      receiver_name: HEAD.name,
      receiver_role: 'TEACH_HEAD',
      sender_id: ACAD.id,
      sender_name: ACAD.name,
      class_id: n.biz || CLS_T4A,
      class_name: n.biz ? '实训四期2班' : '实训四期1班',
      is_read: 0,
    }]);
  }
  console.log(`  ${notices.length} 条（收件人：${HEAD.name} / T001）`);
}

/* ---- main ---- */
(async () => {
  const isClean = process.argv[2] === 'clean';

  /* ★ P8：老表已 DROP —— 先把空壳老表临时建出来，否则下面每条 SQL 都 ER_NO_SUCH_TABLE */
  console.log('→ 临时重建教学域老表…');
  if (runNode('_uni-recreate-legacy.mjs').status !== 0) {
    throw new Error('临时老表重建失败（检查 exports/p8-final-backup 是否存在）');
  }

  const c = await mysql.createConnection(DB);
  try {
    if (isClean) {
      await clean(c);
    } else {
      await seed(c);
      console.log('\n============================================');
      console.log(' 演示数据生成完成 ✅');
      console.log('============================================');
      console.log('\n怎么看：');
      console.log('  1) 起服务：双击 一键启动.bat');
      console.log('  2) 选「班主任」→「以 马志斌 的身份进入」');
      console.log('     → 班级信息管理能看到「实训四期1班」6 个学生');
      console.log('  3) 选「就业老师」→ 就业日志 / 数据统计 / 复盘 都有数据');
      console.log('  4) 选「教务老师」→ 催费管理有 1 条待处理\n');
    }
  } finally {
    await c.end();
    /* ★ 同步进统一表（产品只读统一表）；清理模式则从统一表删掉演示行 */
    console.log(`\n→ ${isClean ? '从统一表删除演示行' : '定向同步进统一表'}…`);
    runNode('_uni-sync-legacy.mjs', '--prefix=demo-', ...(isClean ? ['--delete'] : []));
    console.log('→ 清除临时老表…');
    runNode('_uni-recreate-legacy.mjs', '--drop');
  }
})().catch((e) => {
  console.error('❌ 出错：', e.message);
  process.exit(1);
});
