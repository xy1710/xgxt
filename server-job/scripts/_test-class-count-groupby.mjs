/**
 * 回归自检：班级列表「按班统计在班人数」的分组查询
 * ============================================================
 *
 * 【缺陷】
 *   `src/teaching/class/repo.{classJh,class,job}.ts` 里的 `countStudents()`
 *   写成 `select('class_id').count({ c: '*' })`，却**漏了 `groupBy('class_id')`**。
 *   SELECT 里 `class_id` 是非聚合列 → 在 MySQL `only_full_group_by` 下直接报：
 *     `In aggregated query without GROUP BY, expression #1 of SELECT list contains
 *      nonaggregated column 'sms.jh_t_class_student.class_id'; this is incompatible
 *      with sql_mode=only_full_group_by`
 *   现象：班级管理页（「全部」视图会同时拉三学段列表）连弹 3 条报错、人数恒为 0。
 *
 * 【为什么单列一个脚本】
 *   `_e2e-class-check.mjs` 是重资产自检（起前后端 + 造夹具 + 演示账号），
 *   要跑几十秒。而这条回归只关心「分组统计 SQL 在 only_full_group_by 下不炸」，
 *   属于**库级 + 接口级**的轻量验证，可在改完随时单跑。
 *
 * 【★★ 一个极易踩空的细节：单元素 IN 列表不会触发这个错】
 *   MySQL 8 的 only_full_group_by 带**函数依赖检测**：
 *   `WHERE class_id IN ('x')`（只有一个取值）会被当成 `class_id = 'x'`，
 *   `class_id` 被唯一确定 → **判定为函数依赖成立 → 放行不报错**。
 *   所以复现缺陷必须保证 IN 列表里**至少 2 个不同取值**，否则会得到
 *   「SQL 明明漏了 group by 却不报错」的假阴性。（本脚本用哨兵值兜底）
 *
 * 【四层断言】
 *   ① 环境：确认 sql_mode 真开了 ONLY_FULL_GROUP_BY（否则缺陷复现不了，结论不成立）
 *   ② 库级：忠实复现「漏 group by」的旧 SQL 必须报错；加上 group by 的新 SQL 必须通过
 *   ③ 接口级：用真实登录态打三学段 `/api/teaching/class/list`，必须 200 且每行
 *      `studentCount` 是数字（这是用户实际看到的那条路径）
 *   ④ 交叉核对：API 的 studentCount 必须**逐班等于** DB 分组统计值，
 *      且存在人数>0 的班 —— 防「不报错但人数恒 0」的静默劣化
 *
 * 【跑法】在 server-job 目录下：
 *     node scripts/_test-class-count-groupby.mjs
 *   （依赖：后端 8004 / 前端 5173 已启动；演示账号已 seed）
 */
import { BASE, conn, login, makeChecker, req } from './_e2e-lib.mjs';

const { check, summary } = makeChecker();

/** 三学段：仓储实际查询的库.表 + 学生「在班」判定条件（与仓储口径一致） */
const STAGES = [
  {
    stage: 'jh',
    db: 'sms_class_jh',
    table: 't_class_student',
    // repo.classJh：is_deleted=false 且 student_status IN (1,2,3,6)
    whereSql: '`is_deleted` = 0 AND `student_status` IN (1,2,3,6)',
  },
  {
    stage: 'class',
    db: 'sms_class',
    table: 't_class_student',
    // repo.class：只过滤 is_deleted（大学学生表没有 student_status 口径）
    whereSql: '`is_deleted` = 0',
  },
  {
    stage: 'job',
    db: 'sms_job',
    table: 't_job_class_student',
    // repo.job：走独立花名册，is_deleted=false 且 status=1
    whereSql: '`is_deleted` = 0 AND `status` = 1',
  },
];

/** 取库里有数据的 class_id（用于拼贴近乎真实的 IN 列表） */
async function sampleClassIds(db, table, limit = 4) {
  const rows = await db(table).select('class_id').where('class_id', '!=', '').limit(limit);
  return [...new Set(rows.map((r) => String(r.class_id)).filter(Boolean))];
}

/** 依次尝试演示账号登录，返回第一个成功的 token */
async function loginAny() {
  for (const acc of ['qiansy', 'admin', 'congym']) {
    const t = await login(acc);
    if (t) return { acc, token: t };
  }
  return { acc: '', token: '' };
}

(async () => {
  const dbs = {};
  for (const s of STAGES) dbs[s.db] = conn(s.db);

  try {
    /* ============ ① 环境前提：only_full_group_by 必须开着 ============ */
    const [modeRows] = await dbs.sms_class_jh.raw('SELECT @@sql_mode AS m');
    const sqlMode = String(modeRows?.[0]?.m || '');
    const hasOFGB = sqlMode.includes('ONLY_FULL_GROUP_BY');
    check(
      '环境前提：sql_mode 含 ONLY_FULL_GROUP_BY（缺陷可复现）',
      hasOFGB,
      hasOFGB ? '' : `当前 sql_mode=${sqlMode}（缺省时本缺陷不触发，但分组语义仍需正确）`,
    );

    /* ============ ② 库级：旧 SQL 必须炸 / 新 SQL 必须通 ============ */
    for (const s of STAGES) {
      const db = dbs[s.db];
      const ids = await sampleClassIds(db, s.table);

      // ★ 关键：必须有 ≥2 个不同取值，否则单元素 IN 走函数依赖被放行（假阴性）。
      //   真实数据不足 2 个时补哨兵值（不存在也不影响报错判定）。
      const probeIds = [...ids.slice(0, 3), '__no_such_class__', '__no_such_class_2__'];
      const inList = probeIds.map((x) => `'${x}'`).join(',');

      // ②-1 忠实复现缺陷写法：select 非聚合列 + count，但无 group by
      let buggyThrew = false;
      let buggyMsg = '';
      try {
        await db.raw(
          `SELECT class_id, count(*) AS c FROM ${s.table} WHERE class_id IN (${inList}) AND ${s.whereSql}`,
        );
      } catch (e) {
        buggyThrew = true;
        buggyMsg = e.message;
      }
      if (hasOFGB) {
        check(
          `[${s.stage}] 复现缺陷 SQL（漏 group by）在 only_full_group_by 下报错`,
          buggyThrew,
          buggyThrew ? '' : '未报错 —— 该 SQL 并非缺陷写法或库配置不同',
        );
        if (buggyThrew) {
          check(
            `[${s.stage}] 缺陷报错文案符合预期（nonaggregated column）`,
            /nonaggregated column/i.test(buggyMsg),
            buggyMsg.split('\n')[0].slice(0, 130),
          );
        }
      } else {
        console.log(`  ⏭  [${s.stage}] 未开 only_full_group_by，跳过「旧 SQL 必炸」断言`);
      }

      // ②-2 修复后的写法：带上 group by class_id
      let fixedRows = null;
      let fixedErr = '';
      try {
        const [rows] = await db.raw(
          `SELECT class_id, count(*) AS c FROM ${s.table} WHERE class_id IN (${inList}) AND ${s.whereSql} GROUP BY class_id`,
        );
        fixedRows = rows;
      } catch (e) {
        fixedErr = e.message;
      }
      check(
        `[${s.stage}] 修复后的分组统计 SQL 执行成功`,
        Array.isArray(fixedRows),
        fixedErr || `返回 ${fixedRows?.length ?? 0} 行`,
      );
      if (Array.isArray(fixedRows)) {
        check(
          `[${s.stage}] 结果每行含 class_id + 数字 c`,
          fixedRows.every((r) => r.class_id !== undefined && !Number.isNaN(Number(r.c))),
          `库内实有 class_id=${ids.length ? ids.join('/') : '(无)'}`,
        );
      }
    }

    /* ============ ③ 接口级：真实用户路径不报错 ============ */
    const { acc, token } = await loginAny();
    check('演示账号登录成功（qiansy/admin/congym 任一）', !!token, acc ? `账号=${acc}` : '均失败');
    if (token) {
      for (const s of STAGES) {
        const r = await req(`${BASE}/api/teaching/class/list?stage=${s.stage}&page=1&size=200`, {
          token,
        });
        const list = r.json?.data?.list;
        check(
          `[${s.stage}] /class/list 返回 200 且有列表`,
          r.json?.code === 200 && Array.isArray(list),
          `code=${r.json?.code} ${r.json?.message || ''}`,
        );
        if (Array.isArray(list) && list.length) {
          check(
            `[${s.stage}] 列表每行 studentCount 是可用的数字（不是 NaN/undefined）`,
            list.every((x) => typeof x.studentCount === 'number' && !Number.isNaN(x.studentCount)),
            `样本 studentCount=${list[0].studentCount}`,
          );
        } else {
          console.log(`  ⏭  [${s.stage}] 该学段列表为空，跳过 studentCount 断言`);
        }
      }
    }

    /* ============ ④ 交叉核对：API 的 studentCount 必须等于 DB 分组统计 ============ */
    // 这是最强的一条 —— 修复后的分组 SQL 若没接对（如 group by 写错列），
    // 会出现「不报错但人数恒 0」的静默劣化，光看 200 抓不到，必须逐班对数。
    if (token) {
      for (const s of STAGES) {
        const [dbRows] = await dbs[s.db].raw(
          `SELECT class_id, count(*) AS c FROM ${s.table} WHERE ${s.whereSql} GROUP BY class_id`,
        );
        const dbMap = new Map(dbRows.map((r) => [String(r.class_id), Number(r.c)]));
        const r = await req(`${BASE}/api/teaching/class/list?stage=${s.stage}&page=1&size=500`, {
          token,
        });
        const list = r.json?.data?.list || [];
        if (!list.length) {
          console.log(`  ⏭  [${s.stage}] 列表为空，跳过逐班交叉核对`);
          continue;
        }
        const mismatch = list.filter(
          (x) => Number(x.studentCount) !== (dbMap.get(String(x.classId)) ?? 0),
        );
        check(
          `[${s.stage}] API studentCount == DB 分组统计（逐班核对）`,
          mismatch.length === 0,
          mismatch.length
            ? `不一致 ${mismatch.length} 个，例：${JSON.stringify(mismatch[0])}`
            : `核对 ${list.length} 个班`,
        );
        const dbPositive = [...dbMap.values()].filter((v) => v > 0).length;
        if (dbPositive > 0) {
          check(
            `[${s.stage}] 存在人数>0 的班（证明分组映射真算出来了，不是恒 0）`,
            list.some((x) => Number(x.studentCount) > 0),
            `DB 有 ${dbPositive} 个班人数>0，API 返回 ${list.filter((x) => Number(x.studentCount) > 0).length} 个`,
          );
        }
      }
    }
  } catch (e) {
    console.error('\n💥 自检异常：', e);
    check('自检脚本执行无异常', false, e.message);
  } finally {
    for (const db of Object.values(dbs)) {
      try {
        await db.destroy();
      } catch {}
    }
  }

  const allOk = summary();
  process.exit(allOk ? 0 : 1);
})();
