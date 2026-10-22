/**
 * 第 4 期 · 阶段 2 收口（任务 #20）：**废弃 `t_uni_exam.uk_exam` 唯一索引**
 * ============================================================
 *
 * 【★★ 结论先行】
 *   把 `uk_exam(exam_name, exam_date, edu_stage)` **整个删掉**，
 *   改由**应用层「先查后写」查重**保证「同一班级 + 同一天 + 同名考试」不重复。
 *   删完**不再补任何索引** —— 现状的 3 条普通索引已覆盖全部查询。
 *
 * 【为什么要删 —— 它违反本项目的铁律⑧「唯一索引不能凭空加」】
 *   实测三张老表的索引（`scripts/_uni-exam-uk-audit.mjs`）：
 *     sms_class.t_class_exam     / sms_class_jh.t_class_exam / sms_job.t_job_exam
 *     → **一个唯一索引都没有**，老库压根允许「同一学段建两个同名考试」。
 *   而统一表在**建表时**凭空加了 uk_exam。
 *   字典第 546~548 行已经自己判过刑了：
 *     「`consult_push` 凭空加唯一索引，这是第 ⑧ 条铁律的**第三次重演**
 *       （前两次：`t_uni_exam.uk_exam`、`t_uni_dorm_room.uk_dorm_room`）」
 *   —— 第 3 次（consult_push）已降为普通索引，第 2 次（dorm_room）已加宽收口，
 *      **只剩 exam 这一处一直挂着**。本次清掉。
 *
 * 【为什么不是「加宽」而是「删掉」（与迁移 024 的方案 B 相反）】
 *   迁移 `20261010_024` 曾按「方案 B」把 `(exam_name, edu_stage)`
 *   加宽成 `(exam_name, exam_date, edu_stage)`，当时保住的是
 *   「同一学段 + 同一天 + 同名」不重复。
 *   但实测业务口径是**单班考试**（`repo.class.ts` / `repo.classJh.ts` 都取
 *   `classIds[0]`，`t_uni_exam.class_id` 就是「这场考试属于哪个班」）：
 *     → 两个班同一天各有一场「期中考试」是**完全正常**的，
 *       `(exam_name, exam_date, edu_stage)` 不含 `class_id` → **必然误拦**。
 *     → 若再「加宽」成含 class_id，就要连带处理「软删行仍占坑」
 *       （删掉考试后无法用同名重建），复杂度和风险都高于直接删。
 *
 * 【★★★ 决定性理由：消除「开关关 / 开关开」的行为不对称】
 *   开关关（老表）→ 没有 uk → 允许重复
 *   开关开（统一表）→ 有 uk → 拒绝重复
 *   同一个接口两种模式行为不同 → 正是 P6「开开关双跑对比回归」的差异源。
 *   删掉 uk 后两种模式都靠应用层同一段查重逻辑 → **行为一致**，
 *   也与隔壁 `t_uni_exam_score` 的既定做法对齐
 *   （字典第 841~842 行：本表无任何唯一索引，幂等由业务代码「先查后写」保证）。
 *
 * 【删掉后靠什么兜底】
 *   新增 `src/teaching/exam/uniExamUnique.ts::assertExamNotDuplicated()`，
 *   在三个学段的考试 `save()` 里做「先查后写」：
 *     class / jh → `class_id + exam_name + exam_date`（单班，date 列）
 *     job        → `exam_name + DATE(exam_time) + 班级有交集`（多班，datetime 列）
 *   查重条件带 `is_deleted = 0` —— 只拦「未删除的记录里重复」，
 *   删掉再用同名重建是允许的（老表语义）。
 *
 * 【幂等】uk_exam 不存在 → 打印一行直接返回。
 * 【回滚】down 能重建 uk_exam（前提是无「同班同日同名」重复数据）。
 */

const TABLE = 't_uni_exam';
const INDEX = 'uk_exam';

const SCHEMA = (knex) => knex.client.config.connection.database || 'sms_common';

/** 读某个索引的列顺序（不存在则空数组） */
async function indexCols(knex, name) {
  const rows = await knex('information_schema.STATISTICS')
    .select('COLUMN_NAME as cn')
    .where('TABLE_SCHEMA', SCHEMA(knex))
    .where('TABLE_NAME', TABLE)
    .where('INDEX_NAME', name)
    .orderBy('SEQ_IN_INDEX');
  return rows.map((r) => r.cn);
}

/** 表是否存在（迁移可能在没有统一表的库上被误跑） */
async function tableExists(knex) {
  const [rows] = await knex.raw(
    `select count(*) as n from information_schema.tables
      where table_schema=? and table_name=?`,
    [SCHEMA(knex), TABLE],
  );
  const r = Array.isArray(rows) ? rows[0] : rows;
  return !!(r && Number(r.n) > 0);
}

/**
 * 查「分组内出现 >= 2 次」的数据
 *
 * ★ 沿用 024 的教训（本项目连踩三次），这里必须用 query builder：
 *   MariaDB 驱动下 `knex.raw(SELECT …)` 返回的是**原始协议字段数组**而不是行对象，
 *   `rows[0].exam_name` 恒为 undefined、`rows.length` 恒等于字段个数
 *   → 会把「0 组重复」误判成「多组重复」。
 *   `.groupBy(...).havingRaw('COUNT(*) >= 2')` 返回正常行对象，且不经过运算符解析。
 */
function dupGroups(knex, cols) {
  return knex
    .select(...cols, knex.raw('COUNT(*) AS n'))
    .from(TABLE)
    .groupBy(...cols)
    .havingRaw('COUNT(*) >= 2');
}

const up = async function (knex) {
  if (!(await tableExists(knex))) {
    console.log('  · ' + SCHEMA(knex) + '.' + TABLE + ' 不存在，跳过（本库没有统一表）');
    return;
  }

  const cur = await indexCols(knex, INDEX);
  if (!cur.length) {
    console.log('  · ' + INDEX + ' 不存在，已是目标状态（无唯一索引），跳过');
    return;
  }

  const nu = await knex('information_schema.STATISTICS')
    .select('NON_UNIQUE as nu')
    .where('TABLE_SCHEMA', SCHEMA(knex))
    .where('TABLE_NAME', TABLE)
    .where('INDEX_NAME', INDEX)
    .first();
  console.log(
    '  · ' + INDEX + ' 现为 (' + cur.join(', ') + ')，Non_unique=' +
      (nu ? nu.nu : '无') + ' → 删除',
  );

  /* 删之前先把「同名同日期同学段」的存量数据列出来（不阻塞，只是留痕：
     本索引本来就是凭空加的，历史上真出过这批数据也不该拦着删索引）。
     真正会拦人去路的是「同班同日同名」，那由应用层查重负责，且只针对新写入。 */
  const dup = await dupGroups(knex, ['exam_name', 'exam_date', 'edu_stage']);
  if (dup.length) {
    console.log('  ⚠ 现存 ' + dup.length + ' 组「同名同日期同学段」数据（删索引不影响它们）：');
    dup.forEach((d) =>
      console.log('      ' + d.exam_name + ' | ' + d.exam_date + ' | ' + d.edu_stage + ' × ' + d.n),
    );
  }

  await knex.raw('ALTER TABLE `' + TABLE + '` DROP INDEX `' + INDEX + '`');
  console.log('  ✔ 已删除 ' + INDEX + '(' + cur.join(', ') + ')');

  /* ★ 自检：确认真的没了。
     （踩过「ADD INDEX / ADD UNIQUE INDEX 只差一个词」的坑，
       删也要复核，别只信命令返回 0 行。） */
  const after = await indexCols(knex, INDEX);
  if (after.length) {
    throw new Error(INDEX + ' 删除后仍存在（' + after.join(', ') + '），已中止');
  }
  console.log('  ✔ 自检通过：' + INDEX + ' 已不存在，t_uni_exam 不再有任何唯一索引');
};

const down = async function (knex) {
  if (!(await tableExists(knex))) {
    console.log('  · ' + SCHEMA(knex) + '.' + TABLE + ' 不存在，跳过');
    return;
  }

  const cur = await indexCols(knex, INDEX);
  if (cur.length) {
    console.log('  · ' + INDEX + ' 已存在 (' + cur.join(', ') + ')，无需回滚');
    return;
  }

  /* 回滚前必须先确认没有「同班同日同名」重复，否则加唯一索引必失败 */
  const dup = await dupGroups(knex, ['class_id', 'exam_name', 'exam_date', 'edu_stage']);
  if (dup.length) {
    dup.forEach((d) =>
      console.log(
        '      ' + d.class_id + ' | ' + d.exam_name + ' | ' + d.exam_date + ' | ' + d.edu_stage + ' × ' + d.n,
      ),
    );
    throw new Error('存在「同班同日同名」数据 ' + dup.length + ' 组，无法回滚重建唯一索引，请先清理');
  }

  await knex.raw(
    'ALTER TABLE `' + TABLE +
      '` ADD UNIQUE INDEX `' + INDEX + '` (`exam_name`, `exam_date`, `edu_stage`)',
  );
  console.log('  ✔ 已重建 ' + INDEX + '(exam_name, exam_date, edu_stage)');

  const nu = await knex('information_schema.STATISTICS')
    .select('NON_UNIQUE as nu')
    .where('TABLE_SCHEMA', SCHEMA(knex))
    .where('TABLE_NAME', TABLE)
    .where('INDEX_NAME', INDEX)
    .first();
  if (!nu || Number(nu.nu) !== 0) {
    throw new Error(INDEX + ' 建出来不是唯一索引（Non_unique=' + (nu ? nu.nu : '无') + '），已中止');
  }
  console.log('  ✔ 自检通过：' + INDEX + ' 的 Non_unique = 0（确为唯一索引）');
};

module.exports = { up, down };
