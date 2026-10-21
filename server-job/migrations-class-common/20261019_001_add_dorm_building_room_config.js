/**
 * 迁移：宿舍楼栋设置表增加「楼层数 / 每层房间数 / 每间床位数」
 * ============================================================
 *
 * 【业务背景】
 *   之前「系统设置 → 楼栋设置」只维护一个楼栋名，宿舍要一间一间手加。
 *   现在新增楼栋时直接填：
 *     · 楼层数      floor_count      （1 ~ 9）
 *     · 每层房间数  rooms_per_floor  （1 ~ 99）
 *     · 每间床位数  bed_per_room     （1 ~ 50，默认 4）
 *   点确定 → 后端按「楼层 + 两位序号」自动生成 3 位宿舍号的房间
 *   （1 楼第 1 间 = 101，5 楼第 8 间 = 508），并同步生成床位行。
 *
 * 【★ 为什么楼层数上限 9、每层上限 99】
 *   宿舍号的口径是「3 位数字，第 1 位是楼层、后 2 位是房号」（见
 *   `teaching/dorm/route.ts` 的 /save 校验）。3 位数字最多表达到第 9 层，
 *   每层最多 99 间 → 这两个上限**不是随便定的，是房号格式决定的**。
 *   要支持更高的楼，得先改房号格式（那是另一个改动，不在本次范围）。
 *
 * 【★ 为什么不存「宿舍数」】
 *   宿舍数 = 该楼栋名下未删除的房间数，是**随时会变**的：
 *   宿舍管理里删一间，楼栋设置里的宿舍数就要少 1。
 *   存字段就必须在每一条删/加路径上同步维护，漏一处就永久漂移；
 *   → 改成 `building.service.listBuildings()` 实时 count，天然永远对。
 *
 * 【为什么三列都允许 NULL / 默认 0】
 *   老楼栋（1号楼/2号楼/3号楼）是手工加房间的，没有这套配置。
 *   0 表示「未配置」，列表里显示「—」，编辑时补上即可触发补生成。
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const hasTable = await knex.schema.hasTable('t_dorm_building');
  if (!hasTable) return;

  const cols = {
    floor_count: '楼层数（1 ~ 9，0 = 未配置）',
    rooms_per_floor: '每层房间数（1 ~ 99，0 = 未配置）',
    bed_per_room: '每间床位数（1 ~ 50，默认 4）',
  };

  for (const [col, comment] of Object.entries(cols)) {
    const has = await knex.schema.hasColumn('t_dorm_building', col);
    if (has) continue;
    await knex.schema.table('t_dorm_building', (table) => {
      const c = table.integer(col).nullable().defaultTo(0).comment(comment);
      void c;
    });
  }
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  const hasTable = await knex.schema.hasTable('t_dorm_building');
  if (!hasTable) return;
  for (const col of ['floor_count', 'rooms_per_floor', 'bed_per_room']) {
    const has = await knex.schema.hasColumn('t_dorm_building', col);
    if (!has) continue;
    await knex.schema.table('t_dorm_building', (table) => {
      table.dropColumn(col);
    });
  }
};
