/**
 * 迁移：t_class_suspend_apply 增加「复学班」两列（大学开放复学）
 *
 * ============================================================
 * 【为什么加这两列】（用户要求 2026-10-16：大学生休学后也可以复学）
 * ============================================================
 *   大学老表 ApplyType 原本只有 1休学 2退学 3退费 4升学，**没有复学**。
 *   开放复学后，单据上要能同时表达两个班：
 *     class_id / class_name       = 学生【原班】（建单时快照，"从哪休学的"）
 *     new_class_id / new_class_name = 【复学班】（发起申请时必填，学管审批时仍可改）
 *
 *   ⚠️ 与初高老表（只有 resume_class_id、没有名字列，列表复学班恒为「—」）不同，
 *      这里**直接带名字快照列**（对齐实训的 new_class_id / new_class_name），
 *      列表展示不用再反查班级名。
 *
 *   ⚠️ 这两列**只有复学单**会用到；休学/退学恒为 NULL。
 *
 *   复学类型原码：apply_type = 5（复学；1休学 2退学 3退费 4升学 已被占用）。
 *   映射见 src/teaching/shared/conf.ts 的 DEFAULT_LEAVE_BIZ_MAP.class。
 *
 * ⚠️ 铁律：不许直接连数据库改表结构，一切变更走脚本！
 */

/**
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('t_class_suspend_apply', (table) => {
    table.string('new_class_id', 36).nullable().comment('复学班ID（发起申请时必填，审批可改；仅复学单有值）');
    table.string('new_class_name', 50).nullable().comment('复学班名称（快照）');
  });
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex.schema.alterTable('t_class_suspend_apply', (table) => {
    table.dropColumn('new_class_id');
    table.dropColumn('new_class_name');
  });
};
