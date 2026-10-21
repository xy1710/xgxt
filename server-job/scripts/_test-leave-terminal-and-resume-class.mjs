/**
 * 回归自检：① 终态学生不再出现在发起申请的「学生」下拉；② 复学必须填「复学班级」
 * ============================================================
 *
 * 【背景 / 需求】（2026-10-16 用户提出）
 *   ① 「系统中退学审批页面成功退学后就不在发起申请功能中的学生栏出现
 *      （不能退学再休学等，退学了就不能操作了）」
 *      → 终态学生（**退学 7 / 流失 11 / 已就业 10**，用户确认口径）
 *        任何异动类型都不再出现在学生下拉里；且 create() 再拦一道。
 *   ② 「复学要填写复学班级」
 *      → 复学**发起申请时**就必须填 `newClassId`，学管审批时可改，终审才写库。
 *
 * 【为什么必须写这个自检】
 *   ① 下拉过滤 / 建单校验这两处都是「不加断言就没人发现它坏了」的改动：
 *      过滤掉了不该滤的 → 用户看到「搜不到学生」，像功能坏了；
 *      漏滤了终态 → 用户能给退学的人再开休学单，审批通过时把 student_status 改坏。
 *   ② 两个口子都要堵：下拉（可绕过）+ create（服务端）。
 *   ③ 三个学段是三份独立仓储（repo.job / repo.classJh / repo.class）——
 *      只改一处会漏（本项目反复踩过「三处同构改两处」）。
 *
 * 【断言】
 *   A. 初高（repo.classJh）
 *     - student-options（休学/退学两种 bizType）里：在读学生在、退学/流失/已就业**都不在**
 *     - 绕过下拉直调 create：给退学/流失/已就业的学生开单 → 被拒，提示含对应状态名
 *     - 复学建单不填复学班 → 被拒（「复学必须填写复学班级」）
 *     - 复学建单填了复学班 → 放行；终审不传班级 → 用建单时填的班，学生回到该班
 *     - ★ 列表接口返回的 `newClassName` 必须是**班级名**（不是 null/「—」）
 *       —— 初高老表只存 `resume_class_id`、没有名字列，原来列表恒为「—」
 *   B. 实训（repo.job）：终态三态在学生下拉里都不出现；复学班级在列表里也能显示
 *
 * 【跑法】在 server-job 目录下（前后端已在 8004/5173 运行）：
 *     node scripts/_test-leave-terminal-and-resume-class.mjs
 *   ★ 本脚本**不起服务、不杀端口**，可直接在用户正在用的服务上跑；夹具测完自删。
 */
import {
  BASE,
  buildRow,
  conn,
  login,
  makeChecker,
  mirrorRow,
  probe,
  regTarget,
  req,
} from './_e2e-lib.mjs';

const API = `${BASE}/api/teaching/leave`;
const BIZ = { SUSPEND: 1, QUIT: 2, RESUME: 3 };
/** 学生状态：在读 5 / 休学 6 / 退学 7 / 已就业 10 / 流失 11 */
const SS = { STUDYING: 5, SUSPENDED: 6, QUIT: 7, EMPLOYED: 10, LOST: 11 };

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

/** 关键字：所有夹具学号都带这个前缀，用来把结果收窄到本脚本的数据 */
const KW = 'RTM';

/** 各学段的学生表 / 班级表 / 异动单表 */
const STAGE_CONF = {
  jh: { db: 'sms_class_jh', stu: 't_class_student', leave: 't_class_flow', cls: 't_class_info' },
  job: { db: 'sms_job', stu: 't_student_base', leave: 't_job_student_leave', cls: 't_job_class' },
};

(async () => {
  const conns = {};
  const uniDb = conn('sms_common');
  const db = (name) => {
    if (!conns[name]) conns[name] = conn(name);
    return conns[name];
  };

  try {
    /* ============ 0. 服务就绪（只探，不拉起） ============ */
    const health = await req('http://127.0.0.1:8004/health', { timeout: 4000 });
    check('后端在跑（/health 200）', health.json?.code === 200, `code=${health.json?.code}`);
    if (health.json?.code !== 200) {
      console.log('  ⚠️ 后端没起，请先启动服务（一键启动.bat），再跑本脚本。');
      return;
    }

    const tJh = await login('sunmin'); // 初高班主任（可发起）
    const tJob = await login('sunjl'); // 实训项目经理（可发起）
    const tDean = await login('congym'); // 学管主任（审批）
    check('登录（初高班主任 / 项目经理 / 学管主任）', !!tJh && !!tJob && !!tDean);

    /* ============ 1. 造夹具 ============ */
    const mkStudent = async (stage, name, status) => {
      const c = STAGE_CONF[stage];
      const row = await buildRow(db(c.db), c.stu, {
        student_no: KW + Math.random().toString(36).slice(2, 7).toUpperCase(),
        student_name: name,
        student_status: status,
        is_deleted: 0,
      });
      await db(c.db)(c.stu).insert(row);
      reg(c.db, c.stu, row.id);
      await mirrorRow(uniDb, c.db, c.stu, row, stage, (_d, t, id) => reg('sms_common', t, id));
      return row;
    };

    const mkClass = async (stage, name) => {
      const c = STAGE_CONF[stage];
      const row = await buildRow(db(c.db), c.cls, { class_name: name, is_deleted: 0 });
      await db(c.db)(c.cls).insert(row);
      reg(c.db, c.cls, row.id);
      await mirrorRow(uniDb, c.db, c.cls, row, stage, (_d, t, id) => reg('sms_common', t, id));
      return row;
    };

    const jhQuit = await mkStudent('jh', '自检RTM-初高退学', SS.QUIT);
    const jhLost = await mkStudent('jh', '自检RTM-初高流失', SS.LOST);
    const jhEmp = await mkStudent('jh', '自检RTM-初高已就业', SS.EMPLOYED);
    const jhOn = await mkStudent('jh', '自检RTM-初高在读', SS.STUDYING);
    const jhSus = await mkStudent('jh', '自检RTM-初高休学', SS.SUSPENDED);
    const jhCls = await mkClass('jh', '自检RTM-复学班');

    const jobQuit = await mkStudent('job', '自检RTM-实训退学', SS.QUIT);
    const jobLost = await mkStudent('job', '自检RTM-实训流失', SS.LOST);
    const jobEmp = await mkStudent('job', '自检RTM-实训已就业', SS.EMPLOYED);
    const jobOn = await mkStudent('job', '自检RTM-实训在读', SS.STUDYING);
    // 复学用例：需要一个「休学中」的学生 + 一个复学班（两个学段各一套）
    const jobSus = await mkStudent('job', '自检RTM-实训休学', SS.SUSPENDED);
    const jobCls = await mkClass('job', '自检RTM-实训复学班');

    check(
      '夹具就绪（初高 5 学生 + 1 班；实训 5 学生 + 1 班）',
      [jhQuit, jhLost, jhEmp, jhOn, jhSus, jhCls, jobQuit, jobLost, jobEmp, jobOn, jobSus, jobCls].every(
        (r) => !!r.id,
      ),
    );

    /** 某学段某 bizType 的学生下拉 id 集合 */
    const optionIds = async (stage, bizType, token) => {
      const r = await req(
        `${API}/student-options?stage=${stage}&bizType=${bizType}&keyword=${KW}&limit=200`,
        { token },
      );
      return { code: r.json?.code, ids: (r.json?.data || []).map((o) => o.id), msg: r.json?.message };
    };

    /** 在「异动单列表」里按单据 id 找出那一行（用 KW 收窄到本脚本的数据） */
    const listRowOf = async (stage, token, id) => {
      const r = await req(`${API}/list?stage=${stage}&keyword=${KW}&size=200`, { token });
      return (r.json?.data?.list || []).find((x) => x.id === id) || null;
    };

    /* ============ 2. 初高：终态学生不在下拉 + 直调 create 被拒 ============ */
    {
      const stage = 'jh';
      for (const biz of [BIZ.SUSPEND, BIZ.QUIT]) {
        const o = await optionIds(stage, biz, tJh);
        check(`[${stage}] student-options(bizType=${biz}) 200`, o.code === 200, o.msg || '');
        check(
          `★★[${stage}] bizType=${biz}：退学/流失/已就业**都不在**下拉里`,
          !o.ids.includes(jhQuit.id) && !o.ids.includes(jhLost.id) && !o.ids.includes(jhEmp.id),
          `退学=${o.ids.includes(jhQuit.id) ? '在(❌)' : '不在'} 流失=${
            o.ids.includes(jhLost.id) ? '在(❌)' : '不在'
          } 已就业=${o.ids.includes(jhEmp.id) ? '在(❌)' : '不在'}`,
        );
        check(
          `[${stage}] bizType=${biz}：在读学生仍在（证明不是「把名单全滤空」）`,
          o.ids.includes(jhOn.id),
          `在读=${o.ids.includes(jhOn.id) ? '在' : '不在(❌)'}`,
        );
      }

      // 绕过下拉：直调 create 给终态学生开单 → 必须被拒（每种终态各一次）
      const cases = [
        { stu: jhQuit, biz: BIZ.QUIT, kw: '退学' },
        { stu: jhLost, biz: BIZ.SUSPEND, kw: '流失' },
        { stu: jhEmp, biz: BIZ.SUSPEND, kw: '已就业' },
      ];
      for (const cs of cases) {
        const r = await req(`${API}/create`, {
          method: 'POST',
          token: tJh,
          body: {
            stage,
            studentId: cs.stu.id,
            bizType: cs.biz,
            leaveDate: TODAY,
            leaveReason: `自检RTM-给终态学生（${cs.kw}）开单（应被拒）`,
            submit: false,
          },
        });
        check(
          `★★[${stage}] 绕过下拉：给「${cs.kw}」学生开单 → 被拒且提示含「${cs.kw}」`,
          r.json?.code !== 200 && String(r.json?.message || '').includes(cs.kw),
          `code=${r.json?.code} msg=${r.json?.message}`,
        );
      }
    }

    /* ============ 3. 初高：复学建单必须填复学班 ============ */
    {
      const stage = 'jh';

      // 3.1 不填班 → 被拒
      const bad = await req(`${API}/create`, {
        method: 'POST',
        token: tJh,
        body: {
          stage,
          studentId: jhSus.id,
          bizType: BIZ.RESUME,
          leaveDate: TODAY,
          leaveReason: '自检RTM-复学不填班（应被拒）',
          submit: true,
        },
      });
      check(
        '★★[jh] 复学建单不填复学班 → 被拒且提示含「复学班级」',
        bad.json?.code !== 200 && String(bad.json?.message || '').includes('复学班级'),
        `code=${bad.json?.code} msg=${bad.json?.message}`,
      );

      // 3.2 填了班 → 放行，且班级落到单上
      const good = await req(`${API}/create`, {
        method: 'POST',
        token: tJh,
        body: {
          stage,
          studentId: jhSus.id,
          bizType: BIZ.RESUME,
          leaveDate: TODAY,
          newClassId: jhCls.id,
          leaveReason: '自检RTM-复学（填班，应放行）',
          submit: true,
        },
      });
      check('★[jh] 复学建单填了复学班 → 放行', good.json?.code === 200, good.json?.message || '');
      const flowId = good.json?.data?.id;
      if (flowId) {
        reg('sms_class_jh', 't_class_flow', flowId);
        // 审批单固定落在 sms_job.t_job_approval（见后端 utils/approval.ts 的 APPROVAL_TABLE）
        const ap = await db('sms_job')('t_job_approval')
          .where({ biz_type: 'resume', biz_id: flowId, is_deleted: 0 })
          .first()
          .catch(() => null);
        if (ap) reg('sms_job', 't_job_approval', ap.id);
        const row1 = await probe(db('sms_class_jh'), 'sms_class_jh', 't_class_flow', 'jh')
          .where({ id: flowId })
          .first();
        check(
          '★[jh] 建单时填的复学班已落到单上（resume_class_id）',
          String(row1?.resume_class_id || '') === String(jhCls.id),
          `resume_class_id=${row1?.resume_class_id}`,
        );

        /* ★★ 2026-10-16 用户报的：选了复学班，但**列表的「复学班级」列不体现**。
           根因 = 初高老表只有 resume_class_id、没有名字列，decorate 里恒为 null。
           这里直接钉住「列表接口返回的 newClassName 必须是班级名」。 */
        const listed = await listRowOf(stage, tJh, flowId);
        check(
          '★★[jh] 列表里的「复学班级」列能显示班级名（不是 —）',
          listed?.newClassName === jhCls.class_name,
          `列表 newClassName=${listed?.newClassName} 期望=${jhCls.class_name}`,
        );
      }

      // 3.3 终审**不传** newClassId → 用建单时填的班，学生回到该班
      const ap = await req(`${API}/approve`, {
        method: 'POST',
        token: tDean,
        body: { stage, id: flowId, comment: '自检RTM-同意（不传复学班）' },
      });
      check(
        '★[jh] 复学终审不传班级 → 用建单时填的班，正常通过',
        ap.json?.code === 200 && ap.json?.data?.finished === true,
        `code=${ap.json?.code} msg=${ap.json?.message}`,
      );
      const stuAfter = await probe(db('sms_class_jh'), 'sms_class_jh', 't_class_student', 'jh')
        .where({ id: jhSus.id })
        .first();
      check(
        '★[jh] 复学通过后学生状态 = 5（正式在读）且归属到复学班',
        Number(stuAfter?.student_status) === SS.STUDYING &&
          String(stuAfter?.class_id) === String(jhCls.id),
        `status=${stuAfter?.student_status} class_id=${stuAfter?.class_id}`,
      );
    }

    /* ============ 4. 实训：终态学生不在下拉 ============ */
    {
      const stage = 'job';
      const o = await optionIds(stage, BIZ.SUSPEND, tJob);
      check(`[${stage}] student-options 200`, o.code === 200, o.msg || '');
      check(
        `★★[${stage}] 退学/流失/已就业**都不在**下拉里`,
        !o.ids.includes(jobQuit.id) && !o.ids.includes(jobLost.id) && !o.ids.includes(jobEmp.id),
        `退学=${o.ids.includes(jobQuit.id) ? '在(❌)' : '不在'} 流失=${
          o.ids.includes(jobLost.id) ? '在(❌)' : '不在'
        } 已就业=${o.ids.includes(jobEmp.id) ? '在(❌)' : '不在'}`,
      );
      check(
        `[${stage}] 在读学生仍在名单里`,
        o.ids.includes(jobOn.id),
        `在读=${o.ids.includes(jobOn.id) ? '在' : '不在(❌)'}`,
      );

      const r = await req(`${API}/create`, {
        method: 'POST',
        token: tJob,
        body: {
          stage,
          studentId: jobQuit.id,
          bizType: BIZ.SUSPEND,
          leaveDate: TODAY,
          leaveReason: '自检RTM-实训给退学生开休学单（应被拒）',
          submit: false,
        },
      });
      check(
        `★[${stage}] 绕过下拉：给退学学生开单 → 被拒且提示含「退学」`,
        r.json?.code !== 200 && String(r.json?.message || '').includes('退学'),
        `code=${r.json?.code} msg=${r.json?.message}`,
      );
    }

    /* ============ 5. 实训：复学班级在列表里也要能显示 ============ */
    {
      const stage = 'job';
      const r = await req(`${API}/create`, {
        method: 'POST',
        token: tJob,
        body: {
          stage,
          studentId: jobSus.id,
          bizType: BIZ.RESUME,
          leaveDate: TODAY,
          newClassId: jobCls.id,
          leaveReason: '自检RTM-实训复学（列表要能看到复学班级）',
          submit: false,
        },
      });
      check(`[${stage}] 复学建单填了复学班 → 放行`, r.json?.code === 200, r.json?.message || '');
      const id = r.json?.data?.id;
      if (id) {
        reg('sms_job', 't_job_student_leave', id);
        const ap = await db('sms_job')('t_job_approval')
          .where({ biz_type: 'resume', biz_id: id, is_deleted: 0 })
          .first()
          .catch(() => null);
        if (ap) reg('sms_job', 't_job_approval', ap.id);
        const listed = await listRowOf(stage, tJob, id);
        check(
          `★★[${stage}] 列表里的「复学班级」列能显示班级名（不是 —）`,
          listed?.newClassName === jobCls.class_name,
          `列表 newClassName=${listed?.newClassName} 期望=${jobCls.class_name}`,
        );
      }
    }
  } catch (e) {
    check('脚本执行未抛异常', false, e?.message || String(e));
  } finally {
    /* ============ 清理夹具（自检数据，测完删干净） ============ */
    for (const [dbName, table, id] of fixtures.reverse()) {
      try {
        if (dbName === 'sms_common') await uniDb(table).where({ id }).del();
        else await db(dbName)(table).where({ id }).del();
      } catch {
        /* 忽略：已不存在 */
      }
    }
    // 审批单是统一表的行，夹具单删了就成孤儿 → 一并清掉
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
