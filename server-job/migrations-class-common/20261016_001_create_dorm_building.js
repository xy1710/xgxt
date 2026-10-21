/**
 * 迁移：宿舍楼栋设置表（sms_common · 全局共享）
 * ============================================================
 *
 * 【为什么新建一张，而不是复用 `t_uni_dorm_building`】
 *   `t_uni_dorm_building` 是「老表 t_dorm → 统一表」映射的**房间/楼栋合并表**，
 *   带 `edu_stage`（按学段隔离），且 dorm_no / building / floor / room_type /
 *   bed_total 全是 NOT NULL —— 它装的是「一栋楼一层一个房型」的明细，
 *   不是「楼栋字典」。拿它当楼栋下拉的来源，会出现「三个学段各有一份 1 号楼」。
 *
 *   而用户要的语义是：**楼栋是一份全局字典** ——
 *   「系统设置 → 楼栋设置」里加一栋，宿舍管理的楼栋下拉立刻多一项，两边永远一致。
 *   → 所以单独建一张不带 edu_stage 的字典表。
 *
 * 【为什么放 sms_common】
 *   跨模块共享的字典表放公共库（本项目既有先例：t_class_dorm_room_sync、
 *   t_class_urge_sync 都在 sms_common）。宿舍管理跨 初高/大学/实训 三学段，
 *   楼栋设置又在「系统设置」页，两边都要读写同一份。
 *
 * 【★ 故意不加 building_name 唯一索引】
 *   本表用软删（is_deleted）。唯一索引不会区分软删行 ——
 *   删掉「3号楼」再想加回来会撞 `ER_DUP_ENTRY`，而且**报错信息完全看不出原因**
 *   （本项目在 t_job_dorm.dorm_no 上踩过同款坑，详见 repo.uni.ts 注释）。
 *   → 唯一性改由 service 层校验（只跟未删除的行比），报错能给一句人话。
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const exists = await knex.schema.hasTable('t_dorm_building');
  if (!exists) {
    await knex.schema.createTable('t_dorm_building', (table) => {
      // ---- 公共字段 ----
      table.string('id', 36).primary().comment('主键UUID');
      table.datetime('create_time').comment('创建时间');
      table.string('create_by', 36).comment('创建人ID');
      table.datetime('update_time').comment('修改时间');
      table.string('update_by', 36).comment('修改人ID');
      table.boolean('is_deleted').notNullable().defaultTo(false).comment('逻辑删除');

      // ---- 业务字段 ----
      table.string('building_name', 50).notNullable().comment('楼栋名称，如 1号楼');
      table.integer('sort_no').notNullable().defaultTo(0).comment('排序号（小的在前）');
      table.string('remark', 100).comment('备注');

      // ---- 索引 ----
      table.index(['building_name'], 'idx_dorm_building_name');
      table.index(['sort_no'], 'idx_dorm_building_sort');

      table.comment('宿舍楼栋设置表（全局字典，系统设置维护，宿舍管理下拉读）');
    });
  }

  // ---- 种子：默认三栋楼（幂等：只补不覆盖） ----
  const SEED = ['1号楼', '2号楼', '3号楼'];
  for (let i = 0; i < SEED.length; i += 1) {
    const name = SEED[i];
    const dup = await knex('t_dorm_building').where({ building_name: name }).first();
    if (dup) continue;
    await knex('t_dorm_building').insert({
      id: `BLD-${String(i + 1).padStart(3, '0')}`,
      building_name: name,
      sort_no: i + 1,
      remark: null,
      is_deleted: false,
      create_time: new Date(),
      create_by: 'system',
      update_time: new Date(),
      update_by: 'system',
    });
  }
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('t_dorm_building');
};
