/**
 * 回归自检：异动日期的「今天 ± 10 天」窗口
 * ============================================================
 *
 * 【需求】异动日期只能选「当日临近」的日期 —— 用户口径是前后各 10 天。
 *
 * 【为什么值得单独钉】
 *   ① 这是**防手滑**的校验（2026-10-09 写成 2025-10-09 在列表上完全看不出来，
 *      但会让出勤、按天退费、宿舍退宿一串下游数据错位）；
 *   ② 它有两个执行点：前端 picker 的 disabled-date 与后端 create 的校验。
 *      只做前端 = 表单可绕过；只做后端 = 用户选完才被拒，体验差。
 *      两边天数都来自 `/meta.leaveDateWindowDays`（后端 LEAVE_DATE_WINDOW_DAYS），
 *      本脚本钉住「这个数确实下发了」，避免哪天两边各写一份常量、悄悄不同步；
 *   ③ 边界最容易被写成「开区间」或「少一天」—— 所以 ±10 必须**通过**、±11 必须**被拒**。
 *
 * 【跑法】在 server-job 目录下（前后端已在 8004/5173 运行）：
 *     node scripts/_test-leave-date-window.mjs
 *   ★ 本脚本不起服务、不杀端口；夹具测完自删。
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
const WINDOW = 10; // 与后端 LEAVE_DATE_WINDOW_DAYS 一致（脚本会先核对 /meta 再断言）

const { check, summary } = makeChecker();
const fixtures = [];
const reg = (dbName, table, id) => {
  const [d, t] = regTarget(dbName, table);
  fixtures.push([d, t, id]);
};

/** 今天 ± offset 天的 `YYYY-MM-DD`（本地时区） */
const dayOffset = (offset) => {
  const d = new Date();
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(
    x.getDate(),
  ).padStart(2, '0')}`;
};

(async () => {
  const dbJh = conn('sms_class_jh');
  const uniDb = conn('sms_common');

  try {
    const health = await req('http://127.0.0.1:8004/health', { timeout: 4000 });
    check('后端在跑（/health 200）', health.json?.code === 200, `code=${health.json?.code}`);
    if (health.json?.code !== 200) {
      console.log('  ⚠️ 后端没起，请先启动服务（一键启动.bat），再跑本脚本。');
      return;
    }

    const token = await login('sunmin'); // 初高班主任（可发起）
    check('登录成功', !!token);

    /* ---------- A. 窗口天数由 /meta 下发（前后端同源） ---------- */
    const meta = await req(`${API}/meta`, { token });
    check(
      `★ /meta 下发 leaveDateWindowDays = ${WINDOW}（前端 disabled-date 与后端校验同源）`,
      meta.json?.data?.leaveDateWindowDays === WINDOW,
      `实际 ${JSON.stringify(meta.json?.data?.leaveDateWindowDays)}`,
    );

    /* ---------- B. 夹具：4 个初高学生（每次建单要一个不重复的） ---------- */
    const mkStudent = async (name) => {
      const row = await buildRow(dbJh, 't_class_student', {
        student_no: 'RSW' + Math.random().toString(36).slice(2, 7).toUpperCase(),
        student_name: name,
        student_status: 5, // 正式在读（休学类型不受「必须休学」那条限制）
        is_deleted: 0,
      });
      await dbJh('t_class_student').insert(row);
      reg('sms_class_jh', 't_class_student', row.id);
      await mirrorRow(uniDb, 'sms_class_jh', 't_class_student', row, 'jh', (_d, t, id) =>
        reg('sms_common', t, id),
      );
      return row;
    };

    const stu = [];
    for (let i = 0; i < 4; i++) stu.push(await mkStudent(`自检RSW-${i + 1}`));
    check('夹具就绪（4 个初高在读学生）', stu.every((s) => !!s.id));

    /** 建一单（不提交），返回接口响应 */
    const tryCreate = async (student, leaveDate, reason) => {
      const r = await req(`${API}/create`, {
        method: 'POST',
        token,
        body: {
          stage: 'jh',
          studentId: student.id,
          bizType: BIZ.SUSPEND,
          leaveDate,
          leaveReason: reason,
          submit: false,
        },
      });
      const id = r.json?.data?.id;
      if (id) {
        reg('sms_class_jh', 't_class_flow', id);
        const ap = await conn('sms_job')('t_job_approval')
          .where({ biz_type: 'suspend', biz_id: id, is_deleted: 0 })
          .first();
        if (ap) reg('sms_job', 't_job_approval', ap.id);
      }
      return r;
    };

    /* ---------- C. 窗口内：今天 / ±10 边界 必须放行 ---------- */
    const inside = [
      { d: dayOffset(0), label: '今天' },
      { d: dayOffset(-WINDOW), label: `今天-${WINDOW} 天（边界，含）` },
      { d: dayOffset(WINDOW), label: `今天+${WINDOW} 天（边界，含）` },
    ];
    for (let i = 0; i < inside.length; i++) {
      const r = await tryCreate(stu[i], inside[i].d, `自检RSW-窗口内-${inside[i].label}`);
      check(
        `★ 窗口内放行：${inside[i].label}（${inside[i].d}）`,
        r.json?.code === 200,
        r.json?.message || '',
      );
    }

    /* ---------- D. 窗口外：±11 必须被拒，且提示里有窗口天数 ---------- */
    const outside = [
      { d: dayOffset(-(WINDOW + 1)), label: `今天-${WINDOW + 1} 天` },
      { d: dayOffset(WINDOW + 1), label: `今天+${WINDOW + 1} 天` },
      { d: dayOffset(-365), label: '一年前（年份写错那种手滑）' },
    ];
    for (const o of outside) {
      const r = await tryCreate(stu[3], o.d, `自检RSW-窗口外-${o.label}`);
      check(
        `★ 窗口外被拒：${o.label}（${o.d}）`,
        r.json?.code === 40000 && String(r.json?.message || '').includes(`${WINDOW} 天`),
        `code=${r.json?.code} msg=${r.json?.message}`,
      );
    }

    /* ---------- E. 不填日期：不受窗口限制（日期本来就是可选项） ---------- */
    const blank = await tryCreate(stu[3], '' /* 空串 = 不传 leaveDate */, '自检RSW-不填日期');
    check(
      '不填异动日期 → 不触发窗口校验（该字段是可选的）',
      blank.json?.code === 200,
      blank.json?.message || '',
    );
  } catch (e) {
    check('脚本执行未抛异常', false, e?.message || String(e));
  } finally {
    const conns = { sms_class_jh: dbJh, sms_common: uniDb, sms_job: dbJh };
    for (const [dbName, table, id] of fixtures.reverse()) {
      try {
        const db = dbName === 'sms_common' ? uniDb : dbName === 'sms_job' ? conn('sms_job') : dbJh;
        await db(table).where({ id }).del();
        if (dbName === 'sms_job') await db.destroy();
      } catch {
        /* 忽略 */
      }
    }
    await dbJh.destroy();
    await uniDb.destroy();
    const ok = summary();
    process.exit(ok ? 0 : 1);
  }
})();
