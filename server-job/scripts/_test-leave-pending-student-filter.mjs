/**
 * 回归自检：已有「未办结」申请的学生，不再出现在发起申请的学生下拉里
 * ============================================================
 *
 * 【背景 / 需求】（2026-10-16 用户原话）
 *   「发起学籍异动时已有进行中的申请的学生不显示在学生下拉处」
 *   改之前只有 `create()` 里的 `hasPending` 拦一道 —— 下拉里照样能看到这个人，
 *   用户费劲选完、填完原因，提交时才被拒「请勿重复提交」，白跑一趟。
 *
 * 【★ 未办结 = 待提交 / 待学管 / 待校长（统一码 1/2/3）】
 *   草稿也算：它是一张还没办完的单子；而且**下拉剔除必须与 hasPending 同口径**，
 *   否则会出现「下拉里选得到、提交却被拒」的错位。
 *   （顺带统一：实训原来只算 [2,3]，漏了草稿；本次与初高/大学对齐成 1/2/3。）
 *
 * 【断言】（jh / class / job 三个学段各跑一遍）
 *   ① 打底：两个夹具学生都在下拉里
 *   ② 给其中一人开一张**未办结**的单（草稿）→ 他**不在**了，另一人仍在
 *      —— 「另一人仍在」是为了证明不是「把名单整个滤空」这种假通过
 *   ③ 绕过下拉直调 create 再开一张 → 必须被拒（服务端那道 hasPending 还在）
 *   ④ 把那张单改成**已通过**（直接改库，模拟办结）→ 他**又回到**下拉里
 *      —— 证明这是「未办结」过滤，不是永久拉黑
 *
 * 【跑法】在 server-job 目录下（前后端已在 8004/5173 运行）：
 *     node scripts/_test-leave-pending-student-filter.mjs
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
const BIZ = { SUSPEND: 1 };
const KW = 'RPF'; // 夹具学号前缀：把查询结果收窄到本脚本的数据

const TODAY = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
})();

const { check, summary } = makeChecker();
const fixtures = [];
const reg = (dbName, table, id) => {
  const [d, t] = regTarget(dbName, table);
  fixtures.push([d, t, id]);
};

const STAGE_CONF = {
  jh: {
    db: 'sms_class_jh',
    stu: 't_class_student',
    leave: 't_class_flow',
    statusCol: 'flow_status',
    /** 初高原码：已同意 = 3（统一码是 4） */
    doneRaw: 3,
    stuStatus: 5,
    token: 'sunmin', // 初高班主任
  },
  class: {
    db: 'sms_class',
    stu: 't_class_student',
    leave: 't_class_suspend_apply',
    statusCol: 'apply_status',
    doneRaw: 4,
    stuStatus: 5,
    token: 'qiansy', // 大学部班主任没有该页权限 → 用校长
  },
  job: {
    db: 'sms_job',
    stu: 't_student_base',
    leave: 't_job_student_leave',
    statusCol: 'approval_status',
    doneRaw: 4,
    stuStatus: 8,
    token: 'sunjl', // 实训项目经理
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
    const token = await login('qiansy');
    const tJob = await login('sunjl');
    const tJh = await login('sunmin');
    const TOKEN = { jh: tJh, class: token, job: tJob };
    check('登录（校长 / 初高班主任 / 项目经理）', !!token && !!tJob && !!tJh);

    /** 造学生 + 班级 */
    const mkStudent = async (stage, name) => {
      const c = STAGE_CONF[stage];
      const row = await buildRow(db(c.db), c.stu, {
        student_no: KW + Math.random().toString(36).slice(2, 7).toUpperCase(),
        student_name: name,
        student_status: c.stuStatus,
        is_deleted: 0,
      });
      await db(c.db)(c.stu).insert(row);
      reg(c.db, c.stu, row.id);
      await mirrorRow(uniDb, c.db, c.stu, row, stage, (_d, t, id) => reg('sms_common', t, id));
      return row;
    };

    /** 某学段学生下拉里有没有这个人 */
    const inOptions = async (stage, token, studentId) => {
      const r = await req(
        `${API}/student-options?stage=${stage}&bizType=${BIZ.SUSPEND}&keyword=${KW}&limit=200`,
        { token },
      );
      const ids = (r.json?.data || []).map((o) => o.id);
      return { code: r.json?.code, hit: ids.includes(studentId), count: ids.length };
    };

    for (const stage of ['jh', 'class', 'job']) {
      const c = STAGE_CONF[stage];
      const tk = TOKEN[stage];

      /* ---- 夹具：两个学生（同一前缀，便于一起收窄） ---- */
      const sA = await mkStudent(stage, `自检RPF-${stage}-A`);
      const sB = await mkStudent(stage, `自检RPF-${stage}-B`);
      check(`[${stage}] 夹具就绪（2 名学生）`, !!sA.id && !!sB.id);

      /* ---- ① 打底：两人都在 ---- */
      const base = await inOptions(stage, tk, sA.id);
      check(
        `[${stage}] 打底：两个夹具学生都在下拉里`,
        base.code === 200 && base.hit,
        `A=${base.hit ? '在' : '不在'} 命中 ${base.count} 人`,
      );

      /* ---- ② 给 A 开一张草稿（未办结）→ A 消失，B 仍在 ---- */
      const cr = await req(`${API}/create`, {
        method: 'POST',
        token: tk,
        body: {
          stage,
          studentId: sA.id,
          bizType: BIZ.SUSPEND,
          leaveDate: TODAY,
          leaveReason: '自检RPF-开一张草稿，用于验证下拉剔除',
          submit: false, // ★ 草稿也是「未办结」，也要剔
        },
      });
      check(`[${stage}] 给 A 开一张草稿单（submit:false）`, cr.json?.code === 200, cr.json?.message || '');
      const orderId = cr.json?.data?.id;
      if (orderId) {
        reg(c.db, c.leave, orderId);
        const ap = await db('sms_job')('t_job_approval')
          .where({ biz_id: orderId, is_deleted: 0 })
          .first()
          .catch(() => null);
        if (ap) reg('sms_job', 't_job_approval', ap.id);
      }

      const after = await inOptions(stage, tk, sA.id);
      const other = await inOptions(stage, tk, sB.id);
      check(
        `★★[${stage}] 有未办结申请的学生**不在**下拉里（含草稿）`,
        after.code === 200 && !after.hit,
        `A=${after.hit ? '在(❌)' : '不在'} 命中 ${after.count} 人`,
      );
      check(
        `[${stage}] 另一个人仍在（证明不是「把名单整个滤空」）`,
        other.hit,
        `B=${other.hit ? '在' : '不在(❌)'}`,
      );

      /* ---- ③ 绕过下拉再开一张 → 服务端 hasPending 仍要拦 ---- */
      const dup = await req(`${API}/create`, {
        method: 'POST',
        token: tk,
        body: {
          stage,
          studentId: sA.id,
          bizType: BIZ.SUSPEND,
          leaveDate: TODAY,
          leaveReason: '自检RPF-重复提交（应被拒）',
          submit: false,
        },
      });
      check(
        `★[${stage}] 绕过下拉重复建单 → 被拒（提示含「进行中」）`,
        dup.json?.code !== 200 && String(dup.json?.message || '').includes('进行中'),
        `code=${dup.json?.code} msg=${dup.json?.message}`,
      );

      /* ---- ④ 把那张单改成「已通过」（模拟办结）→ A 回到下拉 ---- */
      await db(c.db)(c.leave).where({ id: orderId }).update({ [c.statusCol]: c.doneRaw });
      const back = await inOptions(stage, tk, sA.id);
      check(
        `★[${stage}] 单子办结后学生**又回到**下拉（不是永久拉黑）`,
        back.hit,
        `A=${back.hit ? '在' : '不在(❌)'}`,
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
