/**
 * 迁移：补「就业部」阶段字典（301 / 302 / 303）
 * ============================================================
 * 【为什么】
 *   t_uni_stage_def 里只有 jh 的阶段（dept 1 七个 / dept 2 四个），
 *   dept 3（就业部，实训与就业共用）一个都没有 →
 *   就业部阶段方案建出来了，但方案里没阶段可选。
 *
 * 【口径】沿用远端 20261019_003 的定义：301 一阶段 / 302 二阶段 / 303 三阶段，
 *         学制月数留空（可在系统设置里改）。
 *         已有班级（如 SX2601 phase_code=301）正好对上，不产生孤儿编码。
 *
 * 【注意】统一表在 sms_common，而本迁移按惯例跑在 sms_class_jh 连接上，
 *         所以直接用全限定名 sms_common.t_uni_stage_def。
 *
 * 【幂等】按 (edu_stage='job', dept_code=3, stage_code) 查重。
 */

const now = new Date();

const PHASES = [
  { code: 301, name: '一阶段', months: null },
  { code: 302, name: '二阶段', months: null },
  { code: 303, name: '三阶段', months: null },
];

let seq = 0;
const uuid = () =>
  `sd-emp-${Date.now().toString(36)}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

async function findOne(knex, sql, params) {
  const r = await knex.raw(sql, params);
  const rows = Array.isArray(r) ? r[0] : r;
  return rows && rows.length ? rows[0] : null;
}

exports.up = async function up(knex) {
  const hasTable = await findOne(
    knex,
    `select 1 from information_schema.tables where table_schema='sms_common' and table_name='t_uni_stage_def' limit 1`,
    [],
  );
  if (!hasTable) return;

  for (const [i, p] of PHASES.entries()) {
    const dup = await findOne(
      knex,
      `select 1 from sms_common.t_uni_stage_def
        where edu_stage='job' and dept_code=3 and stage_code=? and is_deleted=0 limit 1`,
      [p.code],
    );
    if (dup) continue;
    await knex.raw(
      `insert into sms_common.t_uni_stage_def
         (id, edu_stage, stage_code, stage_name, dept_code, study_months, sort_no,
          is_deleted, create_time, create_by)
       values (?, 'job', ?, ?, 3, ?, ?, 0, ?, 'migration')`,
      [uuid(), p.code, p.name, p.months, i, now],
    );
  }
};

exports.down = async function down() {
  // 数据迁移，不回滚（回滚会让班级/学生的阶段码变孤儿）
};
