/**
 * 回归自检：学籍异动审批通过后，学生状态写成什么（**各学段不一样**）
 * ============================================================
 *
 * 【背景 / 需求】用户报「有 3 个休学的，发起复学申请却没有学生的数据」。
 *   排查后：真实流程是通的（休学批准 → 学生=休学(6) → 复学下拉就能选到人），
 *   那 3 条「休学单」里有 2 条之后又办过复学（学生已经回到在读）、1 条还在待审批，
 *   所以当下确实**没有**处于休学的学生 —— 空名单是对的，只是页面没解释。
 *
 *   但排查过程中实跑出一个**真 bug**：初高学生复学批准后，状态被写成
 *   **8（实训中）**，而初高应当是 **5（正式在读）**。
 *   原因：统一三学段时 `repo.classJh.afterApproved` 照抄了实训的映射
 *   （实训的复学 = 回实训 → 8），而初高老流程（class-jh/routes/flow.route.ts）
 *   是 `RESUME → STUDYING(5)`。
 *
 * 【为什么这个必须钉住】
 *   `student_status` 是全系统主状态字段：出勤「应到名单」、宿舍在住校验、
 *   各类统计都按它过滤。初高学生一复学就被标成「实训中」，那些地方会跟着错，
 *   而且**页面不报错**，极难事后发现。
 *
 * 【断言】走真实流程（建单 → 提交 → 学管审批通过），逐学段核对目标状态：
 *   · 初高：休学 → 6，复学 → **5**（本次修的）
 *   · 实训：休学 → 6，复学 → **8**（实训本来就是 8，别被上面那刀改坏）
 *   · 大学：休学 → 6；复学 → 5（2026-10-16 起大学开放复学，与初高同口径）
 *
 * 【跑法】在 server-job 目录下（前后端已在 8004/5173 运行）：
 *     node scripts/_test-leave-status-sideeffect.mjs
 *   ★ 不起服务、不杀端口；夹具测完自删。
 */
import {
  BASE,
  buildRow,
  conn,
  login,
  makeChecker,
  mirrorRow,
  regTarget,
  req,
} from './_e2e-lib.mjs';

const API = `${BASE}/api/teaching/leave`;
const BIZ = { SUSPEND: 1, QUIT: 2, RESUME: 3 };
const SS = { STUDYING: 5, SUSPENDED: 6, QUIT: 7, TRAINING: 8 };

const { check, summary } = makeChecker();
const fixtures = [];
const reg = (dbName, table, id) => {
  const [d, t] = regTarget(dbName, table);
  fixtures.push([d, t, id]);
};

const TODAY = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
})();

/** 各学段的夹具位置：学生表 / 异动单表 / 复学班表 */
const STAGE_CONF = {
  jh: { db: 'sms_class_jh', stu: 't_class_student', leave: 't_class_flow', cls: 't_class_info' },
  job: { db: 'sms_job', stu: 't_student_base', leave: 't_job_student_leave', cls: 't_job_class' },
  class: {
    db: 'sms_class',
    stu: 't_class_student',
    leave: 't_class_suspend_apply',
    cls: 't_class_info',
  },
};

(async () => {
  const conns = {};
  const uniDb = conn('sms_common');
  const db = (name) => {
    if (!conns[name]) conns[name] = conn(name);
    return conns[name];
  };

  try {
    const health = await req('http://127.0.0.1:8004/health', { timeout: 4000 });
    check('后端在跑（/health 200）', health.json?.code === 200, `code=${health.json?.code}`);
    if (health.json?.code !== 200) {
      console.log('  ⚠️ 后端没起，请先启动服务（一键启动.bat），再跑本脚本。');
      return;
    }

    // 三个发起人 / 审批人（学管主任三学段都有权限，但它是**纯审批角色**、不能建单）
    const tJh = await login('sunmin'); // 初高班主任
    const tJob = await login('sunjl'); // 项目经理（实训）
    // ⚠️ 大学部班主任（zhanght）**没有**这个审批页的权限（class:suspend:view）→ 40302，
    //    与 e2e 一致用校长（全权角色）来发起大学学段的单子。
    const tCls = await login('qiansy'); // 校长（可发起任意学段）
    const tDean = await login('congym'); // 学管主任（审批）
    check(
      '登录（初高班主任 / 项目经理 / 校长 / 学管主任）',
      !!tJh && !!tJob && !!tCls && !!tDean,
    );

    /** 造学生 + 复学班 */
    const mkFixtures = async (stage) => {
      const c = STAGE_CONF[stage];
      const stu = await buildRow(db(c.db), c.stu, {
        student_no: 'RSS' + Math.random().toString(36).slice(2, 7).toUpperCase(),
        student_name: `自检RSS-${stage}`,
        student_status: SS.STUDYING,
        is_deleted: 0,
      });
      await db(c.db)(c.stu).insert(stu);
      reg(c.db, c.stu, stu.id);
      await mirrorRow(uniDb, c.db, c.stu, stu, stage, (_d, t, id) => reg('sms_common', t, id));

      // 复学班（复学终审必须选班）
      const cls = await buildRow(db(c.db), c.cls, {
        ...(stage === 'job' ? { class_name: '自检RSS-复学班' } : { class_name: '自检RSS-复学班' }),
        is_deleted: 0,
      });
      await db(c.db)(c.cls).insert(cls);
      reg(c.db, c.cls, cls.id);
      await mirrorRow(uniDb, c.db, c.cls, cls, stage, (_d, t, id) => reg('sms_common', t, id));
      return { stu, cls };
    };

    /** 建单 → 提交 → 终审通过；返回 { ok, id, msg } */
    const runToApproved = async (stage, token, student, bizType, newClassId) => {
      const c = STAGE_CONF[stage];
      let r = await req(`${API}/create`, {
        method: 'POST',
        token,
        // ★ 2026-10-16 起「复学必须在发起申请时填复学班」→ 建单就要带上 newClassId
        body: {
          stage,
          studentId: student.id,
          bizType,
          leaveDate: TODAY,
          leaveReason: `自检RSS-${bizType}`,
          submit: true,
          ...(newClassId ? { newClassId } : {}),
        },
      });
      if (r.json?.code !== 200) return { ok: false, msg: r.json?.message || '建单失败' };
      const id = r.json?.data?.id;
      if (id) reg(c.db, c.leave, id);
      r = await req(`${API}/approve`, {
        method: 'POST',
        token: tDean,
        body: { stage, id, comment: '自检', ...(newClassId ? { newClassId } : {}) },
      });
      return { ok: r.json?.code === 200, id, msg: r.json?.message || '' };
    };

    /* ================= 初高：休学 → 6，复学 → 5（本次修复点） ================= */
    {
      const stage = 'jh';
      const c = STAGE_CONF[stage];
      const { stu, cls } = await mkFixtures(stage);

      const s1 = await runToApproved(stage, tJh, stu, BIZ.SUSPEND);
      check('[jh] 休学审批通过', s1.ok, s1.msg);
      let now = await db(c.db)(c.stu).where({ id: stu.id }).first();
      check(
        '[jh] 休学 → 学生状态 = 6（休学）',
        Number(now?.student_status) === SS.SUSPENDED,
        `实际 ${now?.student_status}`,
      );

      // ★ 休学期间，复学的学生下拉必须能选到他（用户报的正是这一步是空的）
      const opts = await req(`${API}/student-options?stage=jh&bizType=${BIZ.RESUME}&keyword=${stu.student_no}`, {
        token: tDean,
      });
      check(
        '★[jh] 休学中的人能在「复学」的学生下拉里选到',
        (opts.json?.data || []).some((o) => o.id === stu.id),
        `命中 ${(opts.json?.data || []).length} 人`,
      );

      const s2 = await runToApproved(stage, tJh, stu, BIZ.RESUME, cls.id);
      check('[jh] 复学审批通过（必须选复学班）', s2.ok, s2.msg);
      now = await db(c.db)(c.stu).where({ id: stu.id }).first();
      check(
        '★★[jh] 复学 → 学生状态 = 5（正式在读）—— 不是 8（实训中）',
        Number(now?.student_status) === SS.STUDYING,
        `实际 ${now?.student_status}${Number(now?.student_status) === SS.TRAINING ? '（错：写成实训中了）' : ''}`,
      );
      check(
        '[jh] 复学 → 学生回到所选的复学班',
        String(now?.class_id) === String(cls.id),
        `class_id=${now?.class_id}`,
      );

      /* ★★ 用户报的那个场景，正面钉住：
         「休学单已通过」的人一旦复学，就**不该**再出现在复学下拉里；
          而列表必须能一眼看出来（「学生现状」= 正式在读），
          并且他的**休学单和复学单两条记录都在**，不会看不到复学记录。 */
      const optsAfter = await req(
        `${API}/student-options?stage=jh&bizType=${BIZ.RESUME}&keyword=${stu.student_no}`,
        { token: tDean },
      );
      check(
        '★[jh] 已复学的人不再出现在「复学」的学生下拉里（候选 = 当前休学中）',
        !(optsAfter.json?.data || []).some((o) => o.id === stu.id),
        `命中 ${(optsAfter.json?.data || []).length} 人`,
      );

      const listed = await req(`${API}/list?stage=jh&keyword=${stu.student_no}&size=50`, {
        token: tDean,
      });
      const rows = listed.json?.data?.list || [];
      const suspendRow = rows.find((r) => r.bizType === BIZ.SUSPEND);
      check(
        '★[jh] 列表「学生现状」= 正式在读（休学单虽已通过，人早就复学了）',
        !!suspendRow &&
          Number(suspendRow.studentStatus) === SS.STUDYING &&
          suspendRow.studentStatusName === '正式在读',
        `休学单行 studentStatus=${suspendRow?.studentStatus}/${suspendRow?.studentStatusName}`,
      );
      check(
        '★[jh] 同一学生的「休学单」与「复学单」都能查到（复学记录不会丢）',
        rows.some((r) => r.bizType === BIZ.SUSPEND) && rows.some((r) => r.bizType === BIZ.RESUME),
        `共 ${rows.length} 条：${rows.map((r) => r.bizTypeName).join('/')}`,
      );
    }

    /* ================= 实训：休学 → 6，复学 → 8（别被上面那刀改坏） ================= */
    {
      const stage = 'job';
      const c = STAGE_CONF[stage];
      const { stu, cls } = await mkFixtures(stage);

      const s1 = await runToApproved(stage, tJob, stu, BIZ.SUSPEND);
      check('[job] 休学审批通过', s1.ok, s1.msg);
      let now = await db(c.db)(c.stu).where({ id: stu.id }).first();
      check(
        '[job] 休学 → 学生状态 = 6（休学）',
        Number(now?.student_status) === SS.SUSPENDED,
        `实际 ${now?.student_status}`,
      );

      const s2 = await runToApproved(stage, tJob, stu, BIZ.RESUME, cls.id);
      check('[job] 复学审批通过', s2.ok, s2.msg);
      now = await db(c.db)(c.stu).where({ id: stu.id }).first();
      check(
        '★[job] 复学 → 学生状态 = 8（实训中）—— 实训口径与初高不同，不能被「统一」掉',
        Number(now?.student_status) === SS.TRAINING,
        `实际 ${now?.student_status}`,
      );
    }

    /* ================= 大学：休学 → 6，复学 → 5（2026-10-16 起开放） ================= */
    {
      const stage = 'class';
      const c = STAGE_CONF[stage];
      const { stu, cls } = await mkFixtures(stage);

      const s1 = await runToApproved(stage, tCls, stu, BIZ.SUSPEND);
      check('[class] 休学审批通过', s1.ok, s1.msg);
      let now = await db(c.db)(c.stu).where({ id: stu.id }).first();
      check(
        '[class] 休学 → 学生状态 = 6（休学）',
        Number(now?.student_status) === SS.SUSPENDED,
        `实际 ${now?.student_status}`,
      );

      const s2 = await runToApproved(stage, tCls, stu, BIZ.RESUME, cls.id);
      check('[class] 复学审批通过（发起时填复学班）', s2.ok, s2.msg);
      now = await db(c.db)(c.stu).where({ id: stu.id }).first();
      check(
        '★★[class] 复学 → 学生状态 = 5（正式在读）—— 大学与初高同口径，不是 8（实训中）',
        Number(now?.student_status) === SS.STUDYING,
        `实际 ${now?.student_status}${Number(now?.student_status) === SS.TRAINING ? '（错：写成实训中了）' : ''}`,
      );
      check(
        '[class] 复学 → 学生回到所选的复学班',
        String(now?.class_id) === String(cls.id),
        `class_id=${now?.class_id}`,
      );
    }
  } catch (e) {
    check('脚本执行未抛异常', false, e?.message || String(e));
  } finally {
    for (const [dbName, table, id] of fixtures.reverse()) {
      try {
        if (dbName === 'sms_common') await uniDb(table).where({ id }).del();
        else await db(dbName)(table).where({ id }).del();
      } catch {
        /* 忽略：已不存在 */
      }
    }
    // 审批单是统一表的行，夹具单删了它就成孤儿 → 一并清掉
    try {
      const ids = fixtures.map((f) => f[2]);
      const jd = conn('sms_job');
      await jd('t_job_approval').whereIn('biz_id', ids).del();
      await jd.destroy();
    } catch {
      /* 忽略 */
    }
    for (const k of Object.keys(conns)) await conns[k].destroy();
    await uniDb.destroy();
    const ok = summary();
    process.exit(ok ? 0 : 1);
  }
})();
