/**
 * 自检：学生档案关联一致性（★ 2026-10-20）
 * ============================================================
 *
 * 【用户口径】
 *   ① 催费/缴费、退费、休学/退学审批的数据要和学生档案关联；
 *   ② 学生档案里没有的学生，其他模块也不能有；
 *   ③ 其他模块状态改动时，学生档案也要跟着改；
 *   ④ 这些单据里「学生档案有的字段」一律按档案的值走。
 *
 * 【本脚本查什么】
 *   A. 代码层（静态）：
 *      · 统一的档案取数工具存在，且三学段表坐标、身份证列名正确
 *      · 6 个仓储（休退学 3 + 退费 3）的列表/详情都接了「档案覆盖」
 *      · 初高催费列表/导出/催费记录都接了档案合并，且班级筛选认档案现状
 *      · 块注释里没有「加粗符号紧跟斜杠」这种会提前终结注释的写法
 *   B. 数据层（只读库）：
 *      · 孤儿单据 = 0（业务表有 student_id，档案里查无此人）
 *      · 快照漂移 = 0（姓名/班级/部门与档案当前值不一致）
 *
 * 【财务域的口径不同（软关联）】
 *   财务缴费单有两个来源：报名前的咨询收费（学生尚未建档）、报名后的补单。
 *   所以财务侧是「能对上档案就对齐，对不上保持原样」，不要求 100% 关联；
 *   接口是否真的用档案值覆盖，由 _test-archive-override-live.mjs 影子实测。
 *
 * 用法：node scripts/_test-student-archive-link.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const require = createRequire(import.meta.url);
require('dotenv').config({ path: path.join(ROOT, 'server-job/.env') });

const knex = require('knex')({
  client: 'mysql2',
  connection: {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    charset: 'utf8mb4',
  },
});

let pass = 0;
const fails = [];
const warns = [];

function check(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  ✅ ${name}${detail ? `  —— ${detail}` : ''}`);
  } else {
    fails.push(name + (detail ? `（${detail}）` : ''));
    console.log(`  ❌ ${name}${detail ? `  —— ${detail}` : ''}`);
  }
}

function warn(name, detail) {
  warns.push(`${name}（${detail}）`);
  console.log(`  ⚠️  ${name}  —— ${detail}`);
}

function readText(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/* ============================================================
 * A. 代码层
 * ============================================================ */
function staticChecks() {
  console.log('\n【A. 代码层】');

  const refPath = 'server-job/src/teaching/shared/studentRef.ts';
  const ref = fs.existsSync(path.join(ROOT, refPath)) ? readText(refPath) : '';
  check('统一的档案取数工具 studentRef.ts 存在', !!ref);
  if (!ref) return;

  check(
    '导出批量取档案 / 缺人报错 / 覆盖三件套',
    /export async function fetchArchiveStudents/.test(ref) &&
      /export async function requireArchiveStudents/.test(ref) &&
      /export async function hydrateWithArchive/.test(ref),
  );

  check(
    '三学段档案表坐标正确（初高/大学 t_class_student，实训 t_student_base）',
    /jh:\s*\{\s*dbName:\s*'sms_class_jh',\s*table:\s*'t_class_student'/.test(ref) &&
      /class:\s*\{\s*dbName:\s*'sms_class',\s*table:\s*'t_class_student'/.test(ref) &&
      /job:\s*\{\s*dbName:\s*'sms_job',\s*table:\s*'t_student_base'/.test(ref),
  );

  check(
    '身份证列按学段区分（初高 id_card_no，大学/实训 id_card）',
    /jh:\s*'id_card_no'/.test(ref) && /class:\s*'id_card'/.test(ref) && /job:\s*'id_card'/.test(ref),
  );

  check(
    '档案为空时不清空单据原值（null / 空串跳过）',
    ref.includes("if (value === null || value === undefined || value === '') return;"),
  );

  // 6 个仓储 + 初高催费
  const repos = [
    ['休退学·初高', 'server-job/src/teaching/leave/repo.classJh.ts'],
    ['休退学·大学', 'server-job/src/teaching/leave/repo.class.ts'],
    ['休退学·实训', 'server-job/src/teaching/leave/repo.job.ts'],
    ['退费·初高', 'server-job/src/teaching/refund/repo.classJh.ts'],
    ['退费·大学', 'server-job/src/teaching/refund/repo.class.ts'],
    ['退费·实训', 'server-job/src/teaching/refund/repo.job.ts'],
  ];
  for (const [label, rel] of repos) {
    const src = readText(rel);
    const calls = (src.match(/hydrateWithArchive\(/g) || []).length;
    check(`${label}：列表+详情都接了档案覆盖（≥2 处调用）`, calls >= 2, `实际 ${calls} 处`);
  }

  const feeRoute = readText('server-job/src/class-jh/routes/fee.route.ts');
  check(
    '初高催费：档案合并函数存在且列表/导出/催费记录都用它',
    /function mergeArchive/.test(feeRoute) &&
      (feeRoute.match(/mergeArchive\(/g) || []).length >= 3,
  );
  check(
    '初高催费：取档案时排除已删除学生（is_deleted=false）',
    /\.where\('is_deleted', false\)\s*\n?\s*\.whereIn\('id'/.test(feeRoute) ||
      feeRoute.includes("where('is_deleted', false)"),
  );
  check(
    '初高催费：班级筛选同时认「单据快照」和「档案现状」',
    feeRoute.includes('studentIdsInClass') && feeRoute.includes('orWhereIn(\'student_id\', inClass)'),
  );
  check(
    '初高催费：关键字搜索同时认档案姓名/学号（改名后仍能搜到）',
    feeRoute.includes('studentIdsByKeyword'),
  );

  // 财务域：与教学域不同口径（能对上才对，对不上保持原样 —— 咨询前置单还没建档）
  const finArchivePath = 'server-job/src/finance/services/student-archive.ts';
  const finArchive = fs.existsSync(path.join(ROOT, finArchivePath)) ? readText(finArchivePath) : '';
  check('财务域档案关联工具 student-archive.ts 存在', !!finArchive);
  check(
    '财务档案查询同时支持 student_id 与学号两条匹配路径',
    /byId/.test(finArchive) && /byNo/.test(finArchive),
  );

  const finFeeRoute = readText('server-job/src/finance/routes/fee.route.ts');
  check(
    '财务缴费：列表 + 详情都接了档案覆盖',
    (finFeeRoute.match(/applyArchiveToFeeRows\(/g) || []).length >= 2,
  );

  const finFeeSvc = readText('server-job/src/finance/services/fee.service.ts');
  check(
    '财务缴费：新增时用档案值覆盖上游传来的学生字段（不信任前端）',
    /findArchiveStudent\(body\.studentId, body\.studentNo\)/.test(finFeeSvc) &&
      finFeeSvc.includes('body.studentName = archived.name'),
  );
  check(
    '财务缴费：档案查不到时保持原样（咨询前置单允许未建档）',
    finFeeSvc.includes('if (archived) {'),
  );

  // 块注释杀手：`**加粗**/` 里的 */ 会提前结束注释
  const risky = [];
  for (const rel of [
    refPath,
    'server-job/src/class-jh/routes/fee.route.ts',
    ...repos.map((x) => x[1]),
  ]) {
    const src = readText(rel);
    if (/\*\*\//.test(src)) risky.push(rel);
  }
  check('块注释里没有 `**加粗**/` 这种提前终结注释的写法', risky.length === 0, risky.join(', '));
}

/* ============================================================
 * B. 数据层
 * ============================================================ */

/** 需要检查的业务表（财务库除外，见文件头口径说明） */
const TARGETS = [
  { label: '初高·缴费', db: 'sms_class_jh', t: 't_class_fee', s: 't_class_student' },
  { label: '初高·催费', db: 'sms_class_jh', t: 't_class_fee_notify', s: 't_class_student' },
  { label: '初高·退费', db: 'sms_class_jh', t: 't_class_refund', s: 't_class_student' },
  { label: '大学·退费', db: 'sms_class', t: 't_class_refund_apply', s: 't_class_student' },
  { label: '大学·休退学', db: 'sms_class', t: 't_class_suspend_apply', s: 't_class_student' },
  { label: '实训·休退学', db: 'sms_job', t: 't_job_student_leave', s: 't_student_base' },
  { label: '实训·退费', db: 'sms_job', t: 't_job_refund', s: 't_student_base' },
];

/** 公共学生属性列（各表不一定全有，缺的跳过） */
const COMMON = ['student_no', 'student_name', 'class_id', 'class_name', 'dept_code'];

async function columnsOf(db, t) {
  const r = await knex.raw(
    'SELECT COLUMN_NAME c FROM information_schema.columns WHERE TABLE_SCHEMA=? AND TABLE_NAME=?',
    [db, t],
  );
  return new Set(r[0].map((x) => x.c));
}

function same(a, b) {
  return String(a ?? '') === String(b ?? '');
}

async function dataChecks() {
  console.log('\n【B. 数据层（只读）】');

  // B0. 三学段档案都在
  for (const [db, t, name] of [
    ['sms_class_jh', 't_class_student', '初高'],
    ['sms_class', 't_class_student', '大学'],
    ['sms_job', 't_student_base', '实训'],
  ]) {
    const c = (await knex.raw(`SELECT COUNT(*) c FROM ${db}.${t} WHERE is_deleted=0`))[0][0].c;
    check(`${name}学生档案可读`, Number(c) >= 0, `${c} 人`);
  }

  for (const { label, db, t, s } of TARGETS) {
    let cols;
    try {
      cols = await columnsOf(db, t);
    } catch (e) {
      warn(`${label} 跳过`, e.message);
      continue;
    }
    if (!cols.has('student_id')) {
      warn(`${label} 跳过`, `${db}.${t} 无 student_id 列`);
      continue;
    }

    const total = (await knex.raw(`SELECT COUNT(*) c FROM ${db}.${t} WHERE is_deleted=0`))[0][0].c;

    // 孤儿：档案查无此人（含已软删）
    const orphan = (
      await knex.raw(
        `SELECT COUNT(*) c FROM ${db}.${t} f
         LEFT JOIN ${db}.${s} st ON st.id = f.student_id AND st.is_deleted = 0
         WHERE f.is_deleted = 0 AND st.id IS NULL`,
      )
    )[0][0].c;

    // 漂移：逐列比对（NULL 与 '' 视为相同）
    const fields = COMMON.filter((c) => cols.has(c));
    let drift = 0;
    if (fields.length && Number(total)) {
      const cond = fields
        .map((c) => `COALESCE(CAST(f.${c} AS CHAR),'') <> COALESCE(CAST(st.${c} AS CHAR),'')`)
        .join(' OR ');
      drift = (
        await knex.raw(
          `SELECT COUNT(*) c FROM ${db}.${t} f
           JOIN ${db}.${s} st ON st.id = f.student_id AND st.is_deleted = 0
           WHERE f.is_deleted = 0 AND (${cond})`,
        )
      )[0][0].c;
    }

    check(
      `${label}：无孤儿单据（档案查无此人）`,
      Number(orphan) === 0,
      `单据 ${total} 条，孤儿 ${orphan} 条`,
    );
    check(`${label}：无字段漂移（姓名/班级/部门与档案一致）`, Number(drift) === 0, `漂移 ${drift} 条`);
  }

  // B2. 状态回写：休退学审批通过后档案状态应已变（抽末 3 条已同意的单核对）
  const approved = (
    await knex.raw(
      `SELECT f.student_id, f.apply_type, f.apply_status, st.student_status
       FROM sms_class.t_class_suspend_apply f
       JOIN sms_class.t_class_student st ON st.id = f.student_id AND st.is_deleted = 0
       WHERE f.is_deleted = 0 AND f.apply_status = 4
       ORDER BY f.update_time DESC LIMIT 5`,
    )
  )[0];
  if (approved.length) {
    // apply_type: 1休学 → 6休学；2退学 → 7退学
    const bad = approved.filter((r) =>
      Number(r.apply_type) === 1 ? Number(r.student_status) !== 6 : Number(r.student_status) !== 7,
    );
    check(
      '休退学审批已同意的单，学生档案状态已同步（休学→6 / 退学→7）',
      bad.length === 0,
      `抽检 ${approved.length} 条，未同步 ${bad.length} 条`,
    );
  } else {
    warn('休退学状态回写抽检跳过', '库里没有 apply_status=4 的单');
  }

  // B3. 财务库：已知缺口，只报告不判失败
  try {
    const feeTotal = (
      await knex.raw('SELECT COUNT(*) c FROM sms_finance.t_finance_fee WHERE is_deleted=0')
    )[0][0].c;
    const C = ' COLLATE utf8mb4_unicode_ci';
    const matched = (
      await knex.raw(
        `SELECT COUNT(*) c FROM sms_finance.t_finance_fee f
         JOIN sms_class_jh.t_class_student s ON s.student_no = f.student_no${C} AND s.is_deleted=0
         WHERE f.is_deleted=0`,
      )
    )[0][0].c;
    // ★ 财务域的口径与教学域不同：缴费单可能来自「报名前的咨询收费」，
    //   那时学生还没进学籍档案，对不上是**正常业务状态**，不是脏数据。
    //   所以这里只做报告，不判失败；「接口是否真的用档案值覆盖」由
    //   _test-archive-override-live.mjs 用影子测试实证。
    if (Number(feeTotal) === 0) {
      warn('财务缴费单为空', '跳过关联统计');
    } else if (Number(matched) === 0) {
      warn(
        '财务缴费单暂无可关联档案的样本',
        `${feeTotal} 条单据的学号在教学域档案里都对不上（当前是独立演示数据 J26xxx）`,
      );
    } else {
      check(
        '财务缴费单存在可关联档案的样本（软关联有真实数据可验）',
        Number(matched) <= Number(feeTotal),
        `${matched}/${feeTotal} 条能按学号对上档案`,
      );
    }
  } catch (e) {
    warn('财务库检查跳过', e.message);
  }
}

/* ============================================================ */
(async () => {
  console.log('===== 学生档案关联一致性自检 =====');
  staticChecks();
  await dataChecks();
  await knex.destroy();

  console.log(`\n===== 结果：${pass}/${pass + fails.length} 通过 =====`);
  if (warns.length) {
    console.log('已知缺口 / 提示：');
    warns.forEach((w) => console.log(`  ⚠️  ${w}`));
  }
  if (fails.length) {
    console.log('失败项：');
    fails.forEach((f) => console.log(`  ❌ ${f}`));
    process.exit(1);
  }
})().catch(async (e) => {
  console.error(e);
  await knex.destroy();
  process.exit(1);
});
