/**
 * 回归自检：发起申请的「部门」下拉（取代原「学段」）
 * ============================================================
 *
 * 【背景 / 需求】
 *   2026-10-16 用户口径：把学段改为部门，当时下拉四项：初高中 / 大学 / 实训 / 就业
 *   （「就业」是 stage=null 的占位，暂不办理）。
 *   ★ 2026-10-21 用户要求：部门「实训」改为「就业」，占位删掉 ——
 *   现在是 **3 项：初高中 / 大学 / 就业**，就业 = 原实训（stage 仍是 job，
 *   共用 `sms_job` 库），休学 / 退学 / 复学 三项功能一并可用。
 *
 * 【这条链上最容易坏的地方】
 *   ① 部门列表被抄成两份（后端一份、前端一份）→ 改一处漏一处，两边不一致
 *      → 本自检钉住「后端 /meta 是权威来源，且三项目的中文名/顺序稳定」；
 *   ② 「就业占位」被误加回来 → 用户又会选到一个做不了单的空部门
 *      → 本自检钉住「employ 不在下拉里、也不是合法 stage 参数」；
 *   ③ 三个可用部门的学段映射被改错（比如 初高中 指到 class）→ 学生搜不到 /
 *      单子落到别的库 → 本自检用真实数据清点各学段的候选学生数来钉住。
 *      ⚠️ 交叉核对必须用**同一口径**，且规则在测试里**独立重算**：
 *      候选数 = 该库「非终态（退学 7 / 流失 11 / 已就业 10 已排除）
 *               且无未办结单（待提交 / 待学管 / 待校长）」
 *      （口径 2026-10-16 两次变化：先加终态剔除，再加未办结剔除 ——
 *        规则改了这里必须一起改，等于把规则钉住。）
 *
 * 【跑法】在 server-job 目录下（前后端已在 8004/5173 运行）：
 *     node scripts/_test-leave-department-options.mjs
 */
import { BASE, conn, login, makeChecker, req } from './_e2e-lib.mjs';

const API = `${BASE}/api/teaching/leave`;
const { check, summary } = makeChecker();

/** 部门码 → 期望学段（学段是中转层的技术值，部门是用户看到的业务值） */
const EXPECT = [
  { code: 'jh', name: '初高中', stage: 'jh' },
  { code: 'class', name: '大学', stage: 'class' },
  { code: 'job', name: '就业', stage: 'job' },
];

(async () => {
  const dbJh = conn('sms_class_jh');
  try {
    /* ---------- A. 服务就绪 ---------- */
    const health = await req('http://127.0.0.1:8004/health', { timeout: 4000 });
    check('后端在跑（/health 200）', health.json?.code === 200, `code=${health.json?.code}`);
    if (health.json?.code !== 200) {
      console.log('  ⚠️ 后端没起，请先启动服务（一键启动.bat），再跑本脚本。');
      return;
    }

    const token = await login('qiansy'); // 三学段都可见
    check('登录成功', !!token);

    /* ---------- B. /meta 下发三个部门 ---------- */
    const meta = await req(`${API}/meta`, { token });
    const depts = meta.json?.data?.departments || [];
    check(
      '★ /meta 下发 departments（前端不另抄一份，改后端即可）',
      meta.json?.code === 200 && Array.isArray(depts) && depts.length === 3,
      `共 ${depts.length} 项：${depts.map((d) => d.name).join('/')}`,
    );
    check(
      // ★ 2026-10-21：「实训」改叫「就业」，占位删掉 → 三项
      '★ 三个部门的中文名与顺序 = 初高中 / 大学 / 就业（不再有「实训」与占位「就业」）',
      depts.map((d) => d.name).join(',') === '初高中,大学,就业',
      depts.map((d) => d.name).join(','),
    );
    check(
      '★ 部门 → 学段映射正确（初高中→jh、大学→class、就业→job）',
      EXPECT.every((e) => depts.find((d) => d.code === e.code)?.stage === e.stage),
      depts.map((d) => `${d.name}→${d.stage ?? 'null'}`).join(' '),
    );
    check(
      // ★ 2026-10-21：占位「就业」删掉后，下拉里不允许再出现 employ
      '★ 「就业」= 原实训（stage=job，可办单），占位 employ 不再下发',
      depts.find((d) => d.code === 'job')?.stage === 'job' && !depts.some((d) => d.code === 'employ'),
      `job.stage=${JSON.stringify(depts.find((d) => d.code === 'job')?.stage)}`,
    );

    /* ---------- C. 三个可用部门各自能搜到「该部门库里的学生」（映射没被改错） ---------- */
    /** 学段 → 该学段的学生表 / 异动单表（用于与接口返回人数交叉核对） */
    const STAGE_TABLES = {
      jh: { stu: ['sms_class_jh', 't_class_student'], leave: ['sms_class_jh', 't_class_flow'] },
      class: { stu: ['sms_class', 't_class_student'], leave: ['sms_class', 't_class_suspend_apply'] },
      job: { stu: ['sms_job', 't_student_base'], leave: ['sms_job', 't_job_student_leave'] },
    };

    /**
     * ★★ 这里**刻意在测试里独立重算一遍「谁会出现在下拉里」的规则**
     *
     * 原来只减掉「终态学生」，于是每次下游口径一变（终态 → 又加未办结），
     * 这条等式就被打破一次，两次都表现为「接口人数 ≠ 库里人数」，
     * 看着像「部门映射指错库」，其实是测试没跟上规则。
     * → 索性把规则抄进来重算，规则改了这里就必须一起改（等于把规则钉住）。
     *
     * 规则（与 service.ts / repo.*.ts 一致）：
     *   候选 = 该库在册学生
     *          − 终态（退学 7 / 流失 11 / 已就业 10）
     *          − 已有**未办结**异动单的学生（待提交 / 待学管 / 待校长）
     *   ⚠️ 未办结状态用的是**各库原码**：初高 1/2/5（3 才是已同意）、大学与实训 1/2/3。
     *   ⚠️ 老数据 student_status 可能为 NULL → 与仓储一样补 `OR IS NULL`。
     */
    const TERMINAL = [7, 10, 11];
    const PENDING_RULE = {
      jh: { statusCol: 'flow_status', statuses: [1, 2, 5], typeCol: 'flow_type', types: [1, 2, 5] },
      class: { statusCol: 'apply_status', statuses: [1, 2, 3], typeCol: 'apply_type', types: [1, 2] },
      job: { statusCol: 'approval_status', statuses: [1, 2, 3], typeCol: null, types: [] },
    };
    const LIMIT = 200;
    for (const e of EXPECT.filter((x) => x.stage)) {
      const stage = e.stage;
      const t = STAGE_TABLES[stage];
      const db = t.stu[0] === 'sms_class_jh' ? dbJh : conn(t.stu[0]);

      // ① 未办结的学生 id
      const rule = PENDING_RULE[stage];
      const pendQ = db(t.leave[1])
        .where('is_deleted', 0)
        .whereIn(rule.statusCol, rule.statuses)
        .whereNotNull('student_id');
      if (rule.typeCol) pendQ.whereIn(rule.typeCol, rule.types);
      const pendIds = new Set(
        (await pendQ.select('student_id')).map((r) => String(r.student_id || '')),
      );

      // ② 在册 + 非终态的学生
      const stuRows = await db(t.stu[1])
        .where('is_deleted', 0)
        .andWhere((b) => b.whereNotIn('student_status', TERMINAL).orWhereNull('student_status'))
        .select('id');
      if (t.stu[0] !== 'sms_class_jh') await db.destroy();

      const expect = stuRows.filter((r) => !pendIds.has(String(r.id))).length;

      const r = await req(`${API}/student-options?stage=${stage}&limit=${LIMIT}`, { token });
      const n = (r.json?.data || []).length;
      // ★ 不写死「必须有人」，只要求「接口人数 = 按规则算出来的候选数（受 limit 截断）」——
      //   映射指错库时这个等式立刻不成立（比如指到空的库 → 0 vs 28）。
      check(
        `★ 部门「${e.name}」（stage=${stage}）候选人数 = 该库「非终态 且 无未办结单」的人数`,
        r.json?.code === 200 && n === Math.min(expect, LIMIT),
        `接口 ${n} 人 / 按规则应 ${expect} 人（在册 ${stuRows.length}、未办结 ${pendIds.size}）`,
      );
    }
    const jhTotal = Number(
      (await dbJh('t_class_student').where('is_deleted', 0).count({ c: '*' }).first())?.c || 0,
    );
    check(
      '★ 初高部门确实有在册学生（保证上面那条等式不是 0=0 的空转）',
      jhTotal > 0,
      `库内初高在册 ${jhTotal} 人`,
    );

    /* ---------- D. 「就业」不能当学段传下去 ---------- */
    const asStage = await req(`${API}/student-options?stage=employ&limit=5`, { token });
    check(
      '★ employ 不是合法 stage 参数 → 后端明确拒绝（40000），不会被当成真学段',
      asStage.json?.code === 40000,
      `code=${asStage.json?.code} msg=${asStage.json?.message}`,
    );

    const asCreate = await req(`${API}/create`, {
      method: 'POST',
      token,
      body: {
        stage: 'employ',
        studentId: 'not-a-real-student',
        bizType: 1,
        leaveReason: '自检-就业部门不该能建单',
      },
    });
    check(
      '★ 用 employ 建单 → 被拒（不会静默写进某个库）',
      asCreate.json?.code === 40000,
      `code=${asCreate.json?.code} msg=${asCreate.json?.message}`,
    );
  } catch (e) {
    check('脚本执行未抛异常', false, e?.message || String(e));
  } finally {
    await dbJh.destroy();
    const ok = summary();
    process.exit(ok ? 0 : 1);
  }
})();
