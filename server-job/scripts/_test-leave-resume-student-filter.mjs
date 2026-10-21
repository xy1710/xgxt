/**
 * 回归自检：复学申请的学生下拉「只能选休学中的学生」
 * ============================================================
 *
 * 【背景 / 需求】
 *   用户反馈：休学/退学/复学审批页里发起申请时，「复学」的学生下拉
 *   把所有人都列出来了 —— 复学是「把休学的人接回来」，
 *   在读生/退学生出现在名单里既让人选错，也会把学生状态改坏。
 *   → 复学（bizType=3）时下拉只列 `student_status = 休学(6)` 的学生。
 *
 * 【为什么要写这个自检】
 *   ① 这是**下拉过滤**，属于「不加断言就没人会发现它坏了」的那类改动
 *      （过滤掉了不该滤的 → 用户看到的是「搜不到学生」，像功能坏了）；
 *   ② 光过滤下拉是不够的 —— **下拉可以被绕过**（直接 POST /create），
 *      所以 `create()` 里还有第二道校验，两道都要被钉住；
 *   ③ 三个学段是**三份独立仓储**（repo.job / repo.classJh / repo.class），
 *      只改一处会漏（本项目已经反复踩过「三处同构改两处」）。
 *
 * 【断言】（初高 / 实训 / 大学 三个学段各跑一遍；大学复学 2026-10-16 起开放）
 *   ① 服务就绪（后端 8004 / 前端 5173）
 *   ② ★ bizType=3：返回的每一行**去库里核对** student_status 都是 6，
 *      且休学夹具在、在读夹具不在
 *   ③ bizType=1（休学）：两个夹具都在 —— 证明过滤**只对复学生效**，
 *      不是「把所有学生都滤没了」这种假通过
 *   ④ ★ 绕过下拉直调 create：复学 + 在读学生 → 必须被拒，且提示里出现「休学」
 *   ⑤ 复学 + 休学学生 → 放行（否则就是「过滤过头」，真用户也用不了）
 *
 * 【跑法】在 server-job 目录下（前后端已在 8004/5173 运行）：
 *     node scripts/_test-leave-resume-student-filter.mjs
 *   ★ 本脚本**不起服务、不杀端口**（不像 _e2e-*.mjs），可以直接在
 *     用户正在用的服务上跑，跑完自己清理夹具。
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
  USE_UNI,
} from './_e2e-lib.mjs';

const API = `${BASE}/api/teaching/leave`;
const BIZ = { SUSPEND: 1, QUIT: 2, RESUME: 3 };
const STATUS = { STUDYING: 5, SUSPENDED: 6 };

/** 异动日期一律用「今天」：后端有「今天 ± 10 天」的窗口校验（见 shared/format.ts） */
const TODAY = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
})();

const { check, summary } = makeChecker();
const fixtures = [];
/** 夹具登记：切读模式下数据落在统一表，清理必须跟着改指向，否则一行都删不掉 */
const reg = (dbName, table, id) => {
  const [d, t] = regTarget(dbName, table);
  fixtures.push([d, t, id]);
};

(async () => {
  const dbJh = conn('sms_class_jh');
  const dbJob = conn('sms_job');
  const dbCls = conn('sms_class');
  const uniDb = conn('sms_common');

  try {
    /* ============ A. 服务就绪（只探，不拉起） ============ */
    const health = await req('http://127.0.0.1:8004/health', { timeout: 4000 });
    const fe = await req(`${BASE}/`, { timeout: 4000 });
    check(
      '服务在跑（后端 8004 健康检查 + 前端 5173）',
      health.json?.code === 200 && fe.status > 0 && fe.status < 400,
      `backend=${health.json?.code} frontend=${fe.status}`,
    );
    if (health.json?.code !== 200) {
      console.log('  ⚠️ 后端没起，请先启动服务（一键启动.bat），再跑本脚本。');
      return;
    }

    const tHead = await login('sunmin'); // 初高班主任（复学链的发起角色 TEACH_HEAD）
    const tPm = await login('sunjl'); // 实训项目经理（复学链的发起角色 PROJECT_MANAGER）
    // ⚠️ 大学部班主任（zhanght）没有这个审批页的权限（class:suspend:view）→ 40302，
    //    与 _e2e-leave-check / _test-leave-status-sideeffect 一致用校长发起大学学段的单子。
    const tCls = await login('qiansy'); // 校长（可发起任意学段）
    check('登录发起人账号（班主任 / 项目经理 / 校长）', !!tHead && !!tPm && !!tCls);

    /* ============ B. 夹具：每个学段各造 1 休学 + 1 在读 ============ */
    const mkStudent = async (db, dbName, table, stage, name, status) => {
      const row = await buildRow(db, table, {
        student_no: 'RSF' + Math.random().toString(36).slice(2, 7).toUpperCase(),
        student_name: name,
        student_status: status,
        is_deleted: 0,
      });
      await db(table).insert(row);
      reg(dbName, table, row.id);
      // ★ 与 _e2e-leave-check.mjs 同口径：夹具双写，切读前后都能被仓储查到
      await mirrorRow(uniDb, dbName, table, row, stage, (_d, t, id) => reg('sms_common', t, id));
      return row;
    };

    const jhSus = await mkStudent(
      dbJh, 'sms_class_jh', 't_class_student', 'jh', '自检RSF-初高休学中', STATUS.SUSPENDED,
    );
    const jhOn = await mkStudent(
      dbJh, 'sms_class_jh', 't_class_student', 'jh', '自检RSF-初高在读', STATUS.STUDYING,
    );
    const jobSus = await mkStudent(
      dbJob, 'sms_job', 't_student_base', 'job', '自检RSF-实训休学中', STATUS.SUSPENDED,
    );
    const jobOn = await mkStudent(
      dbJob, 'sms_job', 't_student_base', 'job', '自检RSF-实训在读', STATUS.STUDYING,
    );
    // ★ 2026-10-16 起大学开放复学 → 大学也要一套夹具
    const clsSus = await mkStudent(
      dbCls, 'sms_class', 't_class_student', 'class', '自检RSF-大学休学中', STATUS.SUSPENDED,
    );
    const clsOn = await mkStudent(
      dbCls, 'sms_class', 't_class_student', 'class', '自检RSF-大学在读', STATUS.STUDYING,
    );
    check(
      '夹具就绪（初高/实训/大学 各 1 休学 + 1 在读）',
      !!(jhSus.id && jhOn.id && jobSus.id && jobOn.id && clsSus.id && clsOn.id),
    );

    // ★ 2026-10-16 起「复学必须在发起申请时填复学班」→ 正例需要一个真实班级
    const jhCls = await buildRow(dbJh, 't_class_info', {
      class_name: '自检RSF-复学班',
      is_deleted: 0,
    });
    await dbJh('t_class_info').insert(jhCls);
    reg('sms_class_jh', 't_class_info', jhCls.id);
    await mirrorRow(uniDb, 'sms_class_jh', 't_class_info', jhCls, 'jh', (_d, t, id) =>
      reg('sms_common', t, id),
    );

    // ★ 大学复学班（大学复学建单必填复学班）
    const clsClsRow = await buildRow(dbCls, 't_class_info', {
      class_name: '自检RSF-大学复学班',
      is_deleted: 0,
    });
    await dbCls('t_class_info').insert(clsClsRow);
    reg('sms_class', 't_class_info', clsClsRow.id);
    await mirrorRow(uniDb, 'sms_class', 't_class_info', clsClsRow, 'class', (_d, t, id) =>
      reg('sms_common', t, id),
    );

    /** 关键字：夹具的学号都带 RSF 前缀，用它把结果收窄到本脚本的数据 */
    const KW = 'RSF';

    /**
     * 逐行核对：把下拉返回的 id 拿去库里查 student_status
     * ★ 只断言「休学的在、在读的不在」是不够的 —— 仓储若把 `andWhere` 挂错
     *   （比如拼到 orWhere 上），过滤会失效或过宽；逐行核状态才是硬证据。
     */
    const rowsByStatus = async (db, table, ids) => {
      if (!ids.length) return [];
      // 切读模式读统一表，老表模式读老表 —— 与仓储的读路径保持一致
      const q = USE_UNI
        ? uniDb('t_uni_student').whereIn('id', ids)
        : db(table).whereIn('id', ids);
      return q.select('id', 'student_status');
    };

    /* ============ C. 初高（repo.classJh） ============ */
    {
      const stage = 'jh';
      const opts3 = await req(
        `${API}/student-options?stage=${stage}&bizType=${BIZ.RESUME}&keyword=${KW}&limit=200`,
        { token: tHead },
      );
      const list3 = opts3.json?.data || [];
      const ids3 = list3.map((o) => o.id);
      const dbRows = await rowsByStatus(dbJh, 't_class_student', ids3);
      const notSuspended = dbRows.filter((r) => Number(r.student_status) !== STATUS.SUSPENDED);

      check(
        `[${stage}] bizType=3 下拉接口 200`,
        opts3.json?.code === 200,
        opts3.json?.message || '',
      );
      check(
        `★[${stage}] bizType=3 返回的行**去库里核对**全是休学(6)`,
        dbRows.length > 0 && notSuspended.length === 0,
        `共 ${dbRows.length} 行，非休学 ${notSuspended.length} 行`,
      );
      check(
        `★[${stage}] bizType=3：休学夹具在名单里、在读夹具不在`,
        ids3.includes(jhSus.id) && !ids3.includes(jhOn.id),
        `休学夹具=${ids3.includes(jhSus.id) ? '在' : '不在'} 在读夹具=${ids3.includes(jhOn.id) ? '在(❌)' : '不在'}`,
      );

      const opts1 = await req(
        `${API}/student-options?stage=${stage}&bizType=${BIZ.SUSPEND}&keyword=${KW}&limit=200`,
        { token: tHead },
      );
      const ids1 = (opts1.json?.data || []).map((o) => o.id);
      check(
        `[${stage}] bizType=1（休学）不剔在读学生：两个夹具都在（证明「只留休学」只作用于复学）`,
        ids1.includes(jhSus.id) && ids1.includes(jhOn.id),
        `共 ${ids1.length} 行`,
      );

      /* ---- ④ 绕过下拉直调 create ---- */
      const bad = await req(`${API}/create`, {
        method: 'POST',
        token: tHead,
        body: {
          stage,
          studentId: jhOn.id, // ★ 在读生
          bizType: BIZ.RESUME,
          leaveDate: TODAY,
          leaveReason: '自检RSF-给在读生办复学（应被拒）',
          submit: false,
        },
      });
      check(
        `★[${stage}] 绕过下拉：复学 + 在读学生 → 被拒且提示含「休学」`,
        bad.json?.code !== 200 && String(bad.json?.message || '').includes('休学'),
        `code=${bad.json?.code} msg=${bad.json?.message}`,
      );

      /* ---- ⑤ 正常路径必须通 ---- */
      const good = await req(`${API}/create`, {
        method: 'POST',
        token: tHead,
        body: {
          stage,
          studentId: jhSus.id, // ★ 休学生
          bizType: BIZ.RESUME,
          leaveDate: TODAY,
          newClassId: jhCls.id, // ★ 复学建单必填复学班（2026-10-16）
          leaveReason: '自检RSF-休学生复学（应放行）',
          submit: false,
        },
      });
      check(
        `★[${stage}] 复学 + 休学学生 → 放行（防止「过滤过头」把正常流程也堵死）`,
        good.json?.code === 200,
        good.json?.message || '',
      );
      const flowId = good.json?.data?.id;
      if (flowId) {
        reg('sms_class_jh', 't_class_flow', flowId);
        const ap = await dbJob('t_job_approval')
          .where({ biz_type: 'resume', biz_id: flowId, is_deleted: 0 })
          .first();
        if (ap) reg('sms_job', 't_job_approval', ap.id);
      }
    }

    /* ============ D. 实训（repo.job） ============ */
    {
      const stage = 'job';
      const opts3 = await req(
        `${API}/student-options?stage=${stage}&bizType=${BIZ.RESUME}&keyword=${KW}&limit=200`,
        { token: tPm },
      );
      const ids3 = (opts3.json?.data || []).map((o) => o.id);
      const dbRows = await rowsByStatus(dbJob, 't_student_base', ids3);
      const notSuspended = dbRows.filter((r) => Number(r.student_status) !== STATUS.SUSPENDED);

      check(
        `★[${stage}] bizType=3 返回的行**去库里核对**全是休学(6)`,
        dbRows.length > 0 && notSuspended.length === 0,
        `共 ${dbRows.length} 行，非休学 ${notSuspended.length} 行`,
      );
      check(
        `★[${stage}] bizType=3：休学夹具在名单里、在读夹具不在`,
        ids3.includes(jobSus.id) && !ids3.includes(jobOn.id),
        `休学夹具=${ids3.includes(jobSus.id) ? '在' : '不在'} 在读夹具=${ids3.includes(jobOn.id) ? '在(❌)' : '不在'}`,
      );

      const bad = await req(`${API}/create`, {
        method: 'POST',
        token: tPm,
        body: {
          stage,
          studentId: jobOn.id,
          bizType: BIZ.RESUME,
          leaveDate: TODAY,
          leaveReason: '自检RSF-实训给在读生办复学（应被拒）',
          submit: false,
        },
      });
      check(
        `★[${stage}] 绕过下拉：复学 + 在读学生 → 被拒且提示含「休学」`,
        bad.json?.code !== 200 && String(bad.json?.message || '').includes('休学'),
        `code=${bad.json?.code} msg=${bad.json?.message}`,
      );
    }

    /* ============ E. 大学（repo.class，2026-10-16 起开放复学） ============ */
    {
      const stage = 'class';
      const opts3 = await req(
        `${API}/student-options?stage=${stage}&bizType=${BIZ.RESUME}&keyword=${KW}&limit=200`,
        { token: tCls },
      );
      const ids3 = (opts3.json?.data || []).map((o) => o.id);
      const dbRows = await rowsByStatus(dbCls, 't_class_student', ids3);
      const notSuspended = dbRows.filter((r) => Number(r.student_status) !== STATUS.SUSPENDED);

      check(
        `★[${stage}] bizType=3 返回的行**去库里核对**全是休学(6)`,
        dbRows.length > 0 && notSuspended.length === 0,
        `共 ${dbRows.length} 行，非休学 ${notSuspended.length} 行`,
      );
      check(
        `★[${stage}] bizType=3：休学夹具在名单里、在读夹具不在`,
        ids3.includes(clsSus.id) && !ids3.includes(clsOn.id),
        `休学夹具=${ids3.includes(clsSus.id) ? '在' : '不在'} 在读夹具=${ids3.includes(clsOn.id) ? '在(❌)' : '不在'}`,
      );

      /* ---- 绕过下拉直调 create：在读学生必须被拒 ---- */
      const bad = await req(`${API}/create`, {
        method: 'POST',
        token: tCls,
        body: {
          stage,
          studentId: clsOn.id, // ★ 在读生
          bizType: BIZ.RESUME,
          leaveDate: TODAY,
          leaveReason: '自检RSF-大学给在读生办复学（应被拒）',
          submit: false,
        },
      });
      check(
        `★[${stage}] 绕过下拉：复学 + 在读学生 → 被拒且提示含「休学」`,
        bad.json?.code !== 200 && String(bad.json?.message || '').includes('休学'),
        `code=${bad.json?.code} msg=${bad.json?.message}`,
      );

      /* ---- 正常路径必须通（校长发起；大学班主任无审批页权限，同 e2e 口径） ---- */
      const good = await req(`${API}/create`, {
        method: 'POST',
        token: tCls,
        body: {
          stage,
          studentId: clsSus.id, // ★ 休学生
          bizType: BIZ.RESUME,
          leaveDate: TODAY,
          newClassId: clsClsRow.id, // ★ 复学建单必填复学班（2026-10-16）
          leaveReason: '自检RSF-大学休学生复学（应放行）',
          submit: false,
        },
      });
      check(
        `★[${stage}] 复学 + 休学学生 → 放行（防止「过滤过头」把正常流程也堵死）`,
        good.json?.code === 200,
        good.json?.message || '',
      );
      const applyId = good.json?.data?.id;
      if (applyId) {
        reg('sms_class', 't_class_suspend_apply', applyId);
        const ap = await dbJob('t_job_approval')
          .where({ biz_type: 'resume', biz_id: applyId, is_deleted: 0 })
          .first();
        if (ap) reg('sms_job', 't_job_approval', ap.id);
      }
    }
  } catch (e) {
    check('脚本执行未抛异常', false, e?.message || String(e));
  } finally {
    /* ============ 清理夹具（自检数据，测完删干净；业务数据不受影响） ============ */
    // ★ 复用已有连接，不要每条再 conn() 一次（会漏连接、脚本不退出）
    const conns = {
      sms_class_jh: dbJh,
      sms_job: dbJob,
      sms_class: dbCls,
      sms_common: uniDb,
    };
    for (const [dbName, table, id] of fixtures.reverse()) {
      try {
        await (conns[dbName] || dbJob)(table).where({ id }).del();
      } catch {
        /* 忽略：已不存在 */
      }
    }
    await dbJh.destroy();
    await dbJob.destroy();
    await dbCls.destroy();
    await uniDb.destroy();
    const ok = summary();
    process.exit(ok ? 0 : 1);
  }
})();
