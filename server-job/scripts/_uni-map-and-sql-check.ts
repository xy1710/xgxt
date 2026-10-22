/**
 * 切读层「开关关」SQL 形状校验（P3/P4 收口专用 · 纯离线，不连库不起服务）
 *
 * 【为什么需要它】
 *   P3/P4 把几十处 `db('老表')` 改成了 `tbl(db, 库, 表, 学段)`。
 *   整条改造的底线是：**开关关（默认）时生成的 SQL 与改造前逐字节相同**
 *   —— 否则「没开开关也变了行为」，风险完全不可控。
 *   本脚本用假 knex 连接（只连元信息、不真连库）把 SQL 抠出来比对：
 *     ① 同库调用**不加库名前缀**（与旧代码 `db('表')` 一致）
 *     ② 跨库调用**自动补库名前缀**（与旧代码 `db('库.表')` 一致）
 *     ③ `tblRef()` 开关关时原样返回表名 → `stageScope.ts` 里拼出来的
 *        「列限定名」与改造前一字不差
 *
 * 跑法：cd server-job && node_modules/tsx/dist/cli.mjs scripts/_uni-map-and-sql-check.ts
 *
 * 【配套】`UNI_MAP` 两份副本的一致性要靠 `_e2e-lib.mjs` 的
 *   `assertUniMapConsistent()`（需 `TEACHING_UNI_TABLE=1` 才会真正校验）；
 *   映射 key 指向的老表是否真实存在，用 `_uni-map-coverage.mjs` 核对。
 */
import knexFactory from 'knex';
import { tbl, tblRef } from '../src/teaching/shared/uniTable';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    pass += 1;
    console.log(`  ✅ ${name}${extra ? '  —— ' + extra : ''}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${name}${extra ? '  —— ' + extra : ''}`);
  }
}

function fakeDb(database: string) {
  return knexFactory({
    client: 'mysql2',
    connection: { host: '127.0.0.1', user: 'x', database, charset: 'utf8mb4' },
    pool: { min: 0, max: 1 },
  });
}

const fromOf = (qb: any): string => {
  const sql: string = qb.toSQL().sql;
  const m = sql.match(/from\s+(`[^`]+`(?:\.`[^`]+`)?)/i);
  return m ? m[1] : '';
};

console.log('\n① 开关关（默认）：同库不加前缀 / 跨库补前缀\n');
{
  const job = fakeDb('sms_job');
  check(
    `sms_job 连接读 t_job_dorm → from \`t_job_dorm\`（无前缀，与旧代码一致）`,
    fromOf(tbl(job, 'sms_job', 't_job_dorm', 'job')) === '`t_job_dorm`',
    fromOf(tbl(job, 'sms_job', 't_job_dorm', 'job')),
  );
  check(
    `sms_job 连接读 sms_class.t_class_student → from \`sms_class\`.\`t_class_student\`（补前缀）`,
    fromOf(tbl(job, 'sms_class', 't_class_student', 'class')) === '`sms_class`.`t_class_student`',
    fromOf(tbl(job, 'sms_class', 't_class_student', 'class')),
  );

  const jh = fakeDb('sms_class_jh');
  check(
    `sms_class_jh 连接读 t_class_setting → from \`t_class_setting\`（无前缀）`,
    fromOf(tbl(jh, 'sms_class_jh', 't_class_setting', 'jh')) === '`t_class_setting`',
    fromOf(tbl(jh, 'sms_class_jh', 't_class_setting', 'jh')),
  );

  const fin = fakeDb('sms_finance');
  check(
    `sms_finance 连接读 sms_class_jh.t_class_fee → 补前缀（finance→class-sync 场景）`,
    fromOf(tbl(fin, 'sms_class_jh', 't_class_fee', 'jh')) === '`sms_class_jh`.`t_class_fee`',
    fromOf(tbl(fin, 'sms_class_jh', 't_class_fee', 'jh')),
  );
}

console.log('\n② tblRef（拼「列限定名」用，stageScope 依赖它）\n');
{
  const cases: Array<[string, string, string]> = [
    ['sms_job', 't_job_dorm', 't_job_dorm'],
    ['sms_job', 't_student_base', 't_student_base'],
    ['sms_job', 't_job_exam_score', 't_job_exam_score'],
    ['sms_job', 't_job_fee_call', 't_job_fee_call'],
    ['sms_job', 't_employment_log', 't_employment_log'],
  ];
  for (const [dbn, t, expect] of cases) {
    const got = tblRef(dbn, t);
    check(`tblRef('${dbn}','${t}') 开关关 → '${expect}'`, got === expect, got);
  }
  // 别名不是老表名 → 调用方不许传 dbName，这里只验证「传了老表名才会翻译」
  check(`tblRef 对未登记的别名原样返回`, tblRef('sms_job', 'cs') === 'cs', tblRef('sms_job', 'cs'));
}

console.log(`\n===== 结果：${pass}/${pass + fail} 通过 =====`);
if (fail) process.exit(1);
