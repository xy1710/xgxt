/**
 * 迁移：t_class_info 增加「班号」列（★ 2026-10-21 学号新规）
 *
 * 背景（用户口径）：
 *   学号 = LZ + 学段字母(J初中/T高中) + 班号(3位) + 班内序号(3位)
 *   班号在【创建班级时】按学部组顺序分配，101 起：
 *     · J 组（预科 101 + 初中 102~104）各自计数：第一个初中班 LZJ101
 *     · T 组（高中 105~107）各自计数：第一个高中班 LZT101
 *   班内序号每班从 001 独立重排（见 src/class-jh/utils/classNo.ts）。
 *
 * 本迁移只做两件事：
 *   ① 加列 class_no（int, 可空 —— 兼容回填前的历史班）
 *   ② 按「组内创建顺序」回填现有班级：组内 ROW_NUMBER() + 100
 *      （J 组：预科+初中；T 组：高中。按 create_time 升序，先建的班号小）
 *
 * ⚠️ up()/down() 都先判存在再改，可重复执行、可回滚（项目铁律）。
 * ⚠️ 只动 sms_class_jh（初高部）。大学部 sms_class 的学号规则不变，不加列。
 */

/**
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  /* ★ P8 之后这批老表已 DROP（统一表是 t_uni_*）：表不在就跳过，
     否则 npm run migrate 会断在 hasColumn 上。 */
  if (!(await knex.schema.hasTable('t_class_info'))) return;
  const hasCol = await knex.schema.hasColumn('t_class_info', 'class_no');
  if (!hasCol) {
    await knex.schema.alterTable('t_class_info', (t) => {
      t.integer('class_no').comment('班号(101起,同学部组按创建顺序分配;学号=LZ+J/T+班号+班内序号)');
    });
  }

  // 回填：组内按创建顺序编号（MySQL 8 窗口函数）
  //   J 组 = stage < 105（预科101 + 初中102~104）；T 组 = stage >= 105（高中105~107）
  //   只补 class_no 为 NULL 的行，可重复执行不覆盖已有班号。
  await knex.raw(`
    UPDATE t_class_info ci
    JOIN (
      SELECT id,
             ROW_NUMBER() OVER (
               PARTITION BY IF(stage >= 105, 'T', 'J')
               ORDER BY create_time
             ) AS rn
      FROM t_class_info
      WHERE class_no IS NULL
    ) t ON ci.id = t.id
    SET ci.class_no = 100 + t.rn
  `);
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  const hasCol = await knex.schema.hasColumn('t_class_info', 'class_no');
  if (hasCol) {
    await knex.schema.alterTable('t_class_info', (t) => {
      t.dropColumn('class_no');
    });
  }
};
