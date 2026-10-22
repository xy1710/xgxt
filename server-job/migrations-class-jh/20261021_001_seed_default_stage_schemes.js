/**
 * 迁移：给三个部门补默认「阶段方案」+ 方案内阶段
 * ============================================================
 * 【为什么】
 *   阶段方案改版后有两套模型并存：
 *     · 新（设置页在用）：t_class_stage_scheme + t_class_stage_scheme_stage
 *     · 老（teaching 侧读）：t_class_stage_plan + t_class_stage.plan_id
 *   本库跑过 create_stage_scheme，但**没有种子数据** →
 *   班级/学生页的「阶段方案」下拉是空的（页面能用，因为阶段回落仓储常量）。
 *
 * 【本迁移做什么】
 *   按部门 1 初高 / 2 大学 / 3 就业（含实训）各建一个默认方案，
 *   再把 sms_common.t_uni_stage_def 里同部门、未删除的阶段写进方案明细。
 *
 * 【幂等】
 *   · 同部门已有未删除方案 → 不新建，只补缺失的阶段
 *   · 方案明细按 (scheme_id, stage_name) 查重
 */

const DB = 'sms_class_jh';
const SCHEME = 't_class_stage_scheme';
const SCHEME_STAGE = 't_class_stage_scheme_stage';

const DEPTS = [
  { deptCode: 1, schemeName: '初高部阶段方案', sortNo: 1 },
  { deptCode: 2, schemeName: '大学部阶段方案', sortNo: 2 },
  { deptCode: 3, schemeName: '就业部阶段方案', sortNo: 3 },
];

let seq = 0;
const uuid = () =>
  `sch-${Date.now().toString(36)}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

exports.up = async function up(knex) {
  const hasScheme = await knex.schema.hasTable(SCHEME);
  const hasStage = await knex.schema.hasTable(SCHEME_STAGE);
  if (!hasScheme || !hasStage) return; // 表都没建：不发种子

  const hasUniDb = await knex.raw(
    `select 1 from information_schema.schemata where schema_name = 'sms_common' limit 1`,
  );
  const uniRows = Array.isArray(hasUniDb) ? hasUniDb[0] : hasUniDb;

  for (const d of DEPTS) {
    let scheme = await knex(SCHEME)
      .where({ dept_code: d.deptCode, is_deleted: false })
      .first();

    if (!scheme) {
      const id = uuid();
      await knex(SCHEME).insert({
        id,
        create_time: new Date(),
        is_deleted: false,
        scheme_name: d.schemeName,
        dept_code: d.deptCode,
        sort_no: d.sortNo,
      });
      scheme = { id };
    }

    if (!uniRows || !uniRows.length) continue; // 统一库不在同一实例：跳过阶段明细

    const stages = (
      await knex.raw(
        `select stage_code, stage_name, study_months, sort_no
           from sms_common.t_uni_stage_def
          where dept_code = ? and is_deleted = 0
          order by sort_no asc, stage_code asc`,
        [d.deptCode],
      )
    )[0];

    let i = 0;
    for (const s of stages || []) {
      const name = String(s.stage_name || '').trim();
      if (!name) continue;
      const exists = await knex(SCHEME_STAGE)
        .where({ scheme_id: String(scheme.id), stage_name: name, is_deleted: false })
        .first();
      if (exists) continue;
      await knex(SCHEME_STAGE).insert({
        id: uuid(),
        create_time: new Date(),
        is_deleted: false,
        scheme_id: String(scheme.id),
        stage_name: name,
        study_months: s.study_months ?? null,
        sort_no: s.sort_no ?? i,
      });
      i += 1;
    }
  }
};

exports.down = async function down() {
  // 只做加法，不回滚数据
};
