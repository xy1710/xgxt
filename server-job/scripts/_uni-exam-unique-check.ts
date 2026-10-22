/**
 * 任务 #20 验证：考试「先查后写」查重
 * ============================================================
 *
 * 背景：`t_uni_exam.uk_exam(exam_name, exam_date, edu_stage)` 唯一索引
 *       已由迁移 `20261016_007` **删除**（它违反铁律⑧「唯一索引不能凭空加」，
 *       且不含 `class_id` → 两个班同日同名考试会被误拦），
 *       改由 `src/teaching/exam/uniExamUnique.ts::assertExamNotDuplicated()` 兜底。
 *
 * 本脚本**自己造夹具、验完即删**，因此开关关 / 开关开都能跑，输出可直接对比：
 *   ① 命中：同班 + 同日 + 同名 → 抛 EXAM_DUPLICATE(40031)，且提示是人话
 *   ② 放行：换个不存在的考试名 → 不抛
 *   ③ 编辑自身：excludeId 传自己 → 不抛（改考试不该被自己拦住）
 *   ④ 跨班放行：换成**别的**班级 → 不抛（两班同日同名是合法业务，正是删唯一索引的原因）
 *
 * 清理：结束前把自检前缀的行**物理删除**，并回查确认为 0（跑完库是干净的）。
 *
 * 用法：
 *   node node_modules/tsx/dist/cli.mjs scripts/_uni-exam-unique-check.ts
 *   TEACHING_UNI_TABLE=1 node node_modules/tsx/dist/cli.mjs scripts/_uni-exam-unique-check.ts
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { BizCode } from 'shared-types';
import { db as classDb } from '../src/class/db';
import { db as jhDb } from '../src/class-jh/utils/db';
import { db as jobDb } from '../src/utils/db';
import { USE_UNI_TABLE } from '../src/teaching/shared/uniTable';
import { assertExamNotDuplicated } from '../src/teaching/exam/uniExamUnique';
import type { TeachingStage } from '../src/teaching/shared/dto';

/** 自检数据前缀（清理靠它） */
const TAG = '__归一自检_考试唯一性__';
const DATE = '2099-12-31'; // 远期日期，绝不可能和真实业务撞

const COMMON = process.env.DB_NAME_COMMON || 'sms_common';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, extra = '') {
  if (ok) {
    pass++;
    console.log(`  ✔ ${name}${extra ? '  ' + extra : ''}`);
  } else {
    fail++;
    console.log(`  ✘ ${name}${extra ? '  ' + extra : ''}`);
  }
}

/** 各学段：连接 / 目标表 / 日期列 / 班级列口径（与 uniExamUnique.ts 的 CONF 对应） */
function loc(stage: TeachingStage) {
  const uni = USE_UNI_TABLE ? `${COMMON}.t_uni_exam` : null;
  if (stage === 'job') {
    return { db: jobDb, table: uni ?? 't_job_exam', dateCol: 'exam_time', datetime: true, multi: true };
  }
  if (stage === 'jh') {
    return { db: jhDb, table: uni ?? `${process.env.DB_NAME_CLASS_JH || 'sms_class_jh'}.t_class_exam`, dateCol: 'exam_date', datetime: false, multi: false };
  }
  return { db: classDb, table: uni ?? `${process.env.DB_NAME_CLASS || 'sms_class'}.t_class_exam`, dateCol: 'exam_date', datetime: false, multi: false };
}

/** 找一个真实存在的班级 id（当 class_id 用；只要是个字符串即可，本表无外键） */
async function anyClassId(stage: TeachingStage, offset = 0): Promise<string> {
  const cfg =
    stage === 'job'
      ? { db: jobDb, table: 't_job_class' }
      : stage === 'jh'
        ? { db: jhDb, table: 't_class_info' }
        : { db: classDb, table: 't_class_info' };
  const rows = await cfg.db.raw(
    `select id from ${cfg.table} where is_deleted = 0 order by id limit 2 offset ?`,
    [offset],
  );
  const r = (Array.isArray(rows) ? rows[0] : rows)?.[0];
  return r ? String(r.id) : `SELFTEST-CLS-${offset}`;
}

/** 插入一条自检考试；返回主键 id */
async function insertSelfTest(stage: TeachingStage, name: string, classIds: string[]): Promise<string> {
  const cfg = loc(stage);
  const id = randomUUID();
  if (stage === 'job') {
    await cfg.db.raw(
      `insert into ${cfg.table} (id, ${USE_UNI_TABLE ? 'edu_stage, ' : ''}exam_name, exam_type, exam_time, class_ids, class_names, content_types, is_deleted, create_time)
       values (?, ${USE_UNI_TABLE ? "?," : ''} ?, ?, ?, ?, ?, ?, 0, now())`,
      USE_UNI_TABLE
        ? [id, stage, name, 1, `${DATE} 09:00:00`, classIds.join(','), '自检班级', '1']
        : [id, name, 1, `${DATE} 09:00:00`, classIds.join(','), '自检班级', '1'],
    );
    return id;
  }
  if (stage === 'jh') {
    await cfg.db.raw(
      `insert into ${cfg.table} (id, ${USE_UNI_TABLE ? 'edu_stage, ' : ''}exam_name, exam_type, exam_date, class_id, class_name, exam_content_types, exam_status, is_deleted, create_time)
       values (?, ${USE_UNI_TABLE ? "?," : ''} ?, ?, ?, ?, ?, ?, 2, 0, now())`,
      USE_UNI_TABLE
        ? [id, stage, name, 1, DATE, classIds[0], '自检班级', '[]']
        : [id, name, 1, DATE, classIds[0], '自检班级', '[]'],
    );
    return id;
  }
  await cfg.db.raw(
    `insert into ${cfg.table} (id, ${USE_UNI_TABLE ? 'edu_stage, ' : ''}exam_name, exam_type, exam_date, class_id, class_name, attendee_count, is_deleted, create_time)
     values (?, ${USE_UNI_TABLE ? "?," : ''} ?, ?, ?, ?, ?, 0, 0, now())`,
    USE_UNI_TABLE
      ? [id, stage, name, 1, DATE, classIds[0], '自检班级']
      : [id, name, 1, DATE, classIds[0], '自检班级'],
  );
  return id;
}

/** 清掉全部自检行（物理删），返回删除条数 */
async function cleanup(): Promise<number> {
  let n = 0;
  const targets: Array<{ db: any; table: string }> = [
    { db: classDb, table: `${process.env.DB_NAME_CLASS || 'sms_class'}.t_class_exam` },
    { db: jhDb, table: `${process.env.DB_NAME_CLASS_JH || 'sms_class_jh'}.t_class_exam` },
    { db: jobDb, table: `${process.env.DB_NAME || 'sms_job'}.t_job_exam` },
  ];
  if (USE_UNI_TABLE) targets.push({ db: jobDb, table: `${COMMON}.t_uni_exam` });
  for (const t of targets) {
    const [res] = await t.db.raw(`delete from ${t.table} where exam_name like ?`, [`${TAG}%`]);
    n += Number(res?.affectedRows ?? 0);
  }
  return n;
}

/** 调用被验函数，捕获业务码 */
async function call(
  stage: TeachingStage,
  input: { classIds: string[]; examName: string; examDate: string; excludeId?: string },
) {
  const db = stage === 'jh' ? jhDb : stage === 'job' ? jobDb : classDb;
  try {
    await assertExamNotDuplicated(db, stage, input);
    return { threw: false as const };
  } catch (e: any) {
    return { threw: true as const, code: Number(e?.code), msg: String(e?.message ?? '') };
  }
}

(async () => {
  console.log('===== 任务 #20 · 考试查重验证 =====');
  console.log(`模式：TEACHING_UNI_TABLE = ${USE_UNI_TABLE ? '1（统一表 t_uni_exam）' : '0（老表）'}`);
  console.log(`夹具：自建（前缀 ${TAG}，日期 ${DATE}），验完即删\n`);

  const pre = await cleanup(); // 清掉上轮可能的残留
  if (pre) console.log(`（起手清掉上轮残留 ${pre} 行）\n`);

  for (const stage of ['class', 'jh', 'job'] as TeachingStage[]) {
    console.log(`--- 学段 ${stage} ---`);
    const c1 = await anyClassId(stage, 0);
    const c2 = await anyClassId(stage, 1);
    const name = `${TAG}${stage}`;
    const classIds = stage === 'job' ? [c1, c2] : [c1];

    const id = await insertSelfTest(stage, name, classIds);
    console.log(`  夹具：${name} | ${DATE} | 班级 ${classIds.join(',')}`);

    try {
      // ① 命中
      const hit = await call(stage, { classIds, examName: name, examDate: DATE });
      check(
        '① 同班+同日+同名 → 抛 EXAM_DUPLICATE',
        hit.threw && hit.code === BizCode.EXAM_DUPLICATE,
        hit.threw ? `code=${hit.code} "${hit.msg}"` : '未抛错',
      );

      // ② 放行：换个名字
      const free = await call(stage, { classIds, examName: `${name}_别的名字`, examDate: DATE });
      check('② 换考试名 → 放行', !free.threw, free.threw ? `意外抛错 code=${free.code}` : '');

      // ③ 编辑自身
      const self = await call(stage, { classIds, examName: name, examDate: DATE, excludeId: id });
      check('③ excludeId=自己 → 放行', !self.threw, self.threw ? `意外抛错 code=${self.code}` : '');

      // ④ 跨班放行：换一个和夹具**不相交**的班级
      const otherClass = `${name}_OTHER_CLASS`;
      const other = await call(stage, { classIds: [otherClass], examName: name, examDate: DATE });
      check('④ 换成别的班级 → 放行（两班同日同名合法）', !other.threw, other.threw ? `意外抛错 code=${other.code}` : '');
    } finally {
      await cleanup();
    }
    console.log('');
  }

  const left = await cleanup();
  check('⑤ 清理干净（无自检残留）', left === 0, `残留 ${left} 行`);

  console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
  for (const k of [classDb, jhDb, jobDb]) await k.destroy();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error('脚本异常：', e);
  try {
    await cleanup();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
