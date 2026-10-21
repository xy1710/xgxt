/**
 * 回归自检：学生档案「按班级筛选」
 * ============================================================
 *
 * 【背景】
 *   用户反馈「根据班级筛选功能无法实现」。排查结论：
 *   后端四个学段仓储（repo.{jh,class,edu,job}.ts）都实现了
 *   `if (q.classId) qb.andWhere('class_id', q.classId)`，接口层是通的；
 *   真正的问题是**前端班级下拉没有 @change，选完班级列表不动**，
 *   必须再点一次「查询」才生效 —— 用户视角就是「筛选没实现」。
 *   （前端已改为选完即查；本脚本把接口层的正确性固化成回归，防止以后真坏。）
 *
 * 【断言】
 *   ① 班级下拉 /api/teaching/student/classes 有数据（四学段合并、带学段标签）
 *   ② 用下拉里的真实 classId 过滤 → 返回的每一行都属于该班、total ≤ 不筛选的 total
 *   ③ 用不存在的 classId 过滤 → total = 0（证明参数真的参与查询，而不是被忽略）
 *
 * 【跑法】在 server-job 目录下（前端 5173 / 后端 8004 已启动）：
 *     node scripts/_test-student-class-filter.mjs
 */
import { BASE, login, makeChecker, req } from './_e2e-lib.mjs';

const { check, summary } = makeChecker();

(async () => {
  const token = await login('qiansy');
  check('演示账号登录成功', !!token);

  /* ---------- ① 班级下拉 ---------- */
  const cls = await req(`${BASE}/api/teaching/student/classes`, { token });
  const options = cls.json?.data || [];
  check(
    '班级下拉 /student/classes 返回 200 且非空',
    cls.json?.code === 200 && options.length > 0,
    `code=${cls.json?.code} 共 ${options.length} 个班`,
  );
  check(
    '下拉项含 stage/stageName/id/name（前端要靠 stage 分组展示）',
    options.every((o) => o.stage && o.stageName && o.id && typeof o.name === 'string'),
  );

  /* ---------- ② 真实 classId 过滤 ---------- */
  for (const stage of ['jh', 'class', 'job', 'edu']) {
    const all = await req(`${BASE}/api/teaching/student/list?stage=${stage}&page=1&size=1`, { token });
    const total = all.json?.data?.total || 0;
    const first = (all.json?.data?.list || [])[0];
    if (!first?.classId) {
      console.log(`  ⏭  [${stage}] 该学段暂无带班级的学生（total=${total}），跳过`);
      continue;
    }
    const cid = String(first.classId);
    const r = await req(
      `${BASE}/api/teaching/student/list?stage=${stage}&classId=${encodeURIComponent(cid)}&page=1&size=500`,
      { token },
    );
    const rows = r.json?.data?.list || [];
    const wrong = rows.filter((x) => String(x.classId) !== cid);
    check(
      `[${stage}] 按 classId 过滤后每一行都属于该班`,
      r.json?.code === 200 && wrong.length === 0,
      `classId=${cid} 返回 ${rows.length} 条，串班 ${wrong.length} 条`,
    );
    check(
      `[${stage}] 过滤后 total ≤ 不过滤的 total（参数真的参与了查询）`,
      (r.json?.data?.total || 0) <= total,
      `filtered=${r.json?.data?.total} unfiltered=${total}`,
    );
  }

  /* ---------- ③ 不存在的 classId ---------- */
  const bogus = await req(
    `${BASE}/api/teaching/student/list?classId=__no_such_class__&page=1&size=50`,
    { token },
  );
  check(
    '不存在的 classId → total = 0',
    bogus.json?.code === 200 && (bogus.json?.data?.total || 0) === 0,
    `total=${bogus.json?.data?.total}`,
  );

  const allOk = summary();
  process.exit(allOk ? 0 : 1);
})();
