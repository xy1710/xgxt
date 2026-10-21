/**
 * 第 4 期 · 第 9 批（2026-10-11 · 考试域）：t_uni_exam 补索引 + t_uni_exam_field.field_type 改 varchar
 * ============================================================
 *
 * ── 本批考试域 5 张表实测「零缺列」──
 *   t_class_exam  (14) → t_uni_exam     (27) 缺 0
 *   t_class_exam_content(10) → t_uni_exam_content(12) 缺 0
 *   t_class_exam_field(10) → t_uni_exam_field(16) 缺 0
 *   t_class_grade  (20) → t_uni_exam_score(39) 缺 0
 *   t_class_info   (25) → t_uni_class (33) 缺 0
 * → 不需要补列，只处理下面两处结构冲突。
 *
 * ── ① t_uni_exam 补idx_exam_class_date(edu_stage, class_id, exam_date) ──
 *
 *   实测索引现状：
 *     t_uni_exam PRIMARY(id)
 *     t_uni_exam uk_exam(exam_name, exam_date, edu_stage)   ← 唯一，迁移 024「加宽」的成果
 *     t_uni_exam idx_edu_stage(edu_stage)
 *     t_uni_exam idx_exam_stage_date(edu_stage, exam_date)
 *
 *   老表 t_class_exam 有idx(class_id, exam_date)。
 *   而考试列表页主查询路径就是「按班级 + 日期范围筛」（`exam.route.ts` 的
 *   `applyDataScope(classIdColumn:'class_id')` + `where('exam_date','>=',...)`），
 *   现有索引**没有一个含class_id** → 切读后每次列表查询都要扫 edu_stage 下全部考试。
 *
 *   本迁移补的索引把 `edu_stage` 放最前（铁律①必带 stage），
 *   再补 class_id、exam_date，与老表查询路径逐列对齐 —— 属于「对齐」不是「凭空加」。
 *
 * ── ② t_uni_exam_field.field_type：int(11) → varchar(20) ──
 *
 *   实测三个来源：
 *     sms_class.t_class_exam_field.field_type    = varchar(20)  ← 大学老表，存中文 '数值'
 *     sms_class_jh.t_class_exam_field.field_type = int(11)      ← 初高老表，存1/2
 *     sms_common.t_uni_exam_field.field_type     = int(11)，现12 行全是 1
 *
 *   业务代码 `exam/route.ts` 的 zod schema 是 `z.string().default('数值')`，
 *   写进统一表会直接炸：
 *     Field 'field_type' doesn't have a default value  → 不至于，
 *     实测是 Truncated incorrect INTEGER value: '数值'（MariaDB 严格模式是 ERROR 不是 warning）
 *
 *   即当前统一表这一列的口径跟现有代码**完全对不上**，切读模式一调/field/add 就500。
 *   统一表另有 `field_type_text varchar(20)`（当前全 NULL），保留不动。
 *
 *   改 varchar 的理由：大学侧（sms_class）是当前唯一被业务代码实际走通的老表，
 *   代码写的就是中文字符串；改列类型对齐它 = 代码零改动、老表/切读行为一致。
 *
 * ⚠️ 改类型前必须先清串（铁律）：
 *   MariaDB 严格模式下 int → varchar 会尝试把 '1' 塞进 int 表达式，
 *   反向（int→varchar）虽安全，但为保险仍分两步：先 ADD 临时列回填，再改原列。
 *   实测 12 行的 field_type 全是数字 1，直接 MODIFY 即可，无需临时列。
 *
 * ── 幂等 & 自检 ──
 *   up 先查 information_schema：索引已存在 / 列已是 varchar(20) 就跳过；
 *   改完回查类型与索引 Non_unique（铁律：ADD INDEX ≠ ADD UNIQUE）。
 */

/**
 * 取当前连接的真实库名
 *
 * ★ 2026-10-15：原来这里是写死的 `const DB = 'sms_common'`。
 *   换成别的库名部署时会查错库，故改为从 knex 连接动态取。
 */
const dbOf = (knex) => knex.client.config.connection.database || 'sms_common';

/**
 * ⚠️ 2026-10-15 修复：information_schema 的列名必须【大小写不敏感】地读。
 *
 * 【原来的 bug —— 会让整条 npm run migrate 链断掉】
 *   原代码直接读 `r.index_name` / `r.non_unique`。
 *   但 MySQL/MariaDB 从 information_schema 返回的列名一律是 **大写**
 *   （实测 keys = ["INDEX_NAME","NON_UNIQUE","COLUMN_NAME","SEQ_IN_INDEX"]），
 *   于是 `r.index_name` 恒为 undefined → hasIndex() 恒返回 false
 *   → 明明索引在，也去执行 `ALTER TABLE ... ADD INDEX` →
 *     报 `Duplicate key name 'idx_exam_class_date'` → 本迁移失败。
 *
 *   而 package.json 的 migrate 是 `... && --env class-common && --env class-jh`，
 *   前一步失败 → **`--env class-jh` 永远不会执行** →
 *   sms_class_jh 库里一张表都没有（31 个迁移全 pending）→
 *   初高/学生档案（合并页）查 t_student_base 报 ER_NO_SUCH_TABLE
 *   → 前端显示「数据表不存在（请先执行 npm run migrate）」（极具误导）。
 */
function lowerKeys(row) {
  if (!row) return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) out[k.toLowerCase()] = v;
  return out;
}

async function columnType(knex, table, column) {
  const r = await knex('information_schema.COLUMNS')
    .where({ TABLE_SCHEMA: dbOf(knex), TABLE_NAME: table, COLUMN_NAME: column })
    .first();
  return r ? String(lowerKeys(r).column_type) : null;
}

/**
 * 查表的索引信息
 *
 * ★★★ 2026-10-15 修：`select()` 里的小写列名，在 **MySQL 8.0 上会被强制转成大写 key**
 *   （information_schema 是内部表，列名不随查询书写的大小写变化）。
 *   而 MariaDB 会保留查询书写的小写 → 于是同一份代码：
 *     · 本机 MariaDB  → 返回 `{index_name}` → 判断正常
 *     · 虚拟机 MySQL 8.0 → 返回 `{INDEX_NAME}` → `r.index_name` 是 undefined
 *       → `hasIndex()` 恒为 false → 去 ADD INDEX → 报 `Duplicate key name`
 *
 *   **修法：显式加 `as` 别名**，强制把 key 统一成小写。
 *   这样底层返回大写还是小写都无所谓，代码这边永远拿到 `index_name`。
 *   （MySQL 8.0 / MariaDB 实测均通过。）
 */
async function indexRows(knex, table) {
  return await knex('information_schema.STATISTICS')
    .where({ TABLE_SCHEMA: dbOf(knex), TABLE_NAME: table })
    .select(
      'INDEX_NAME as index_name',
      'NON_UNIQUE as non_unique',
      'COLUMN_NAME as column_name',
      'SEQ_IN_INDEX as seq_in_index',
    );
}

async function hasIndex(knex, table, indexName) {
  const rows = await indexRows(knex, table);
  return rows.some((r) => r.index_name === indexName);
}

exports.up = async function up(knex) {
  // ── ① t_uni_exam 补复合索引 ──
  if (await hasIndex(knex, 't_uni_exam', 'idx_exam_class_date')) {
    console.log('· t_uni_exam.idx_exam_class_date 已存在，跳过');
  } else {
    const cols = (await indexRows(knex, 't_uni_exam'))
      .filter((r) => r.index_name === 'idx_exam_class_date')
      .length;
    if (cols === 0) {
      await knex.raw(
        'ALTER TABLE `t_uni_exam` ADD INDEX `idx_exam_class_date` (`edu_stage`, `class_id`, `exam_date`)',
      );
      const check = (await indexRows(knex, 't_uni_exam')).filter(
        (r) => r.index_name === 'idx_exam_class_date',
      );
      const nonUniq = check.length ? Number(check[0].non_unique) : -1;
      console.log(
        `  ✔ t_uni_exam 新增 idx_exam_class_date(edu_stage, class_id, exam_date)，Non_unique=${nonUniq}` +
          (nonUniq === 1 ? '' : '  ⚠️ 期望 1'),
      );
    }
  }

  // ── ② t_uni_exam_field.field_type 改 varchar(20) ──
  const cur = await columnType(knex, 't_uni_exam_field', 'field_type');
  if (!cur) {
    console.log('· t_uni_exam_field.field_type 不存在，跳过');
    return;
  }
  if (cur === 'varchar(20)') {
    console.log('· t_uni_exam_field.field_type 已是 varchar(20)，跳过');
    return;
  }
  // ⚠️ 执行顺序铁律：int 列**不能直接写中文**，
  //    `UPDATE ... SET field_type='数值' WHERE field_type=1` 在列还是 int 时会报
  //    `Incorrect integer value: '数值'`（严格模式是 ERROR，整条迁移失败）。
  //    正确顺序：先把列类型改成 varchar（值1 变字符串 '1'），再翻译成中文。
  //    这与「varchar → int 改类型前必须先清串」是同一条纪律的两面。
  await knex.raw(
    "ALTER TABLE `t_uni_exam_field` MODIFY COLUMN `field_type` varchar(20) NOT NULL DEFAULT '数值'",
  );
  const midType = await columnType(knex, 't_uni_exam_field', 'field_type');
  console.log(`  · field_type ${cur} → ${midType}（先改类型，避免 int 列写中文报错）`);

  // 把数字码翻译成中文，保证切读后前端/业务口径与大学老表一致：
  //   1 = 数值，2 = 文本（口径见 _p3-migrate-to-uni.cjs:113 注释）
  const n1 = await knex('t_uni_exam_field').where('field_type', '1').update({ field_type: '数值' });
  const n2 = await knex('t_uni_exam_field').where('field_type', '2').update({ field_type: '文本' });
  if (n1 || n2) console.log(`  · 数字码翻译为中文：1→数值 ${n1} 行，2→文本 ${n2} 行`);

  // 任何残留的未知值统一归为 '数值'，保证口径唯一
  const rest = await knex('t_uni_exam_field')
    .whereNotIn('field_type', ['数值', '文本'])
    .select('id', 'field_type');
  for (const r of rest) {
    console.log(`    · id=${r.id} field_type=${JSON.stringify(r.field_type)} 非已知码，归为 '数值'`);
    await knex('t_uni_exam_field').where('id', r.id).update({ field_type: '数值' });
  }
  if (rest.length) console.log(`  · 归一未知值 ${rest.length} 行`);
  const after = await columnType(knex, 't_uni_exam_field', 'field_type');
  console.log(`  ✔ t_uni_exam_field.field_type ${cur} → ${after}（对齐大学老表 varchar(20)）`);
};

exports.down = async function down() {
  console.log('· 本迁移为结构对齐 + 中文回填，回滚会丢中文语义，无业务意义');
};