/**
 * 迁移：t_consult_student 增加「转介绍招生老师」两列（★ 补 2026-10-15 漏掉的迁移）
 *
 * 背景（E2E 实测发现的真实缺陷）：
 *   2026-10-15 咨询模块加了「来源=转介绍时填招生老师」功能，
 *   代码（student.route.ts 的 /add）开始写 referrer_name / referrer_phone，
 *   建库 SQL（sql/init/sms_consult.sql）也加了这两列 ——
 *   但【没有对应的 knex 迁移】。后果：任何从旧库升级的环境
 *   （本机 10-02 之后就没再跑过 consult 迁移）在「新增咨询学员」时
 *   直接撞 50002「数据库字段不存在」，咨询模块第一线功能瘫痪。
 *
 * 为什么放 migrations/ 主目录而不是新建 migrations-consult/：
 *   consult 库的历史迁移记录（sms_consult.knex_migrations 的 8 条）
 *   就在主目录体系里，保持一致；本文件用裸表名，跟随 knex 实例连接的库，
 *   对 sms_consult 执行即可（其他库没有 t_consult_student，hasColumn 为 false 时跳过）。
 *
 * ⚠️ 部署注意：sms_consult 需要显式跑一次 migrate（knexfile 目前没有 consult 专属 env）。
 * ⚠️ up()/down() 都先判存在再改，可重复执行、可回滚（项目铁律）。
 */

/**
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  /* ★ P8 之后这批老表已 DROP（统一表是 t_uni_*）：表不在就跳过，
     否则 npm run migrate 会断在 hasColumn 上。 */
  if (!(await knex.schema.hasTable('t_consult_student'))) return;
  const hasName = await knex.schema.hasColumn('t_consult_student', 'referrer_name');
  const hasPhone = await knex.schema.hasColumn('t_consult_student', 'referrer_phone');
  if (!hasName || !hasPhone) {
    await knex.schema.alterTable('t_consult_student', (t) => {
      if (!hasName) t.string('referrer_name', 50).comment('转介绍招生老师姓名（来源=转介绍时填）');
      if (!hasPhone) t.string('referrer_phone', 20).comment('转介绍招生老师电话');
    });
  }
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  const hasName = await knex.schema.hasColumn('t_consult_student', 'referrer_name');
  const hasPhone = await knex.schema.hasColumn('t_consult_student', 'referrer_phone');
  if (hasName || hasPhone) {
    await knex.schema.alterTable('t_consult_student', (t) => {
      if (hasPhone) t.dropColumn('referrer_phone');
      if (hasName) t.dropColumn('referrer_name');
    });
  }
};
