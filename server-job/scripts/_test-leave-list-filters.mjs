/**
 * 回归自检：休学/退学审批列表的**每一个筛选都要真的生效**
 * ============================================================
 *
 * 【背景 / 需求】用户：「这个休学|退学模块要求所有筛选要生效」。
 *
 * 排查结论（两类问题，都不是「没写筛选」）：
 *   ① **前端**：下拉没挂 `@change` → 选完不点「查询」列表不动，
 *      用户视角就是「筛选没生效」。（已改为选完即查）
 *   ② **后端 · 真 bug**：`onlyMine`（只看待我审批）只能算出来，不能在 SQL 里表达，
 *      而旧实现是「**先按页切片、再对切片过滤**」：
 *        · 数据库给回 20 条，其中只有 2 条待我审批 → 页面只显示 2 条，
 *          真正的第 3 条在后面几页里永远翻不出来；
 *        · `total` 取的是**过滤前**的总数 → 分页器说「共 47 条」，
 *          翻到第 3 页却是空的。
 *      已改为「取全量池 → 补审批单 → 过滤 → 排序 → 最后才分页」。
 *   ③ 顺带：学段与类型不兼容（当年的例子是大学 + 复学）旧实现会 `where biz_type = NULL`
 *      → 恒不成立 → **静默返回空列表**，用户以为「没数据」。现在明确报 40000。
 *      ⚠️ 2026-10-16 起大学开放复学，三学段 × 三类型已无不兼容组合，
 *         F 段改为正向断言（大学 + 复学 → 200）。
 *
 * 【断言】
 *   A 关键字 / B 类型 / C 状态 / D 组合筛选：返回的**每一行**都满足条件，
 *     且该出现的一定在、不该出现的一定不在（用夹具学号定位）
 *   E 学段筛选：每一行都是该学段
 *   F 大学 + 复学：200（2026-10-16 起支持；旧口径 40000 已随矩阵放开失效）
 *   G ★ onlyMine 分页自洽：`total` 必须等于「按 size=1 逐页翻完能收集到的行数」，
 *     且不重复 —— 这一条正是旧实现会挂的地方
 *
 * 【跑法】在 server-job 目录下（前后端已在 8004/5173 运行）：
 *     node scripts/_test-leave-list-filters.mjs
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
  USE_UNI,
} from './_e2e-lib.mjs';

const API = `${BASE}/api/teaching/leave`;
const BIZ = { SUSPEND: 1, QUIT: 2, RESUME: 3 };
const ST = { DRAFT: 1, PENDING: 2, PENDING_PRINCIPAL: 3, APPROVED: 4 };

/** 夹具学号前缀：用它当关键字，把结果收窄到本脚本造的数据 */
const PREFIX = 'RSF2';

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

(async () => {
  const dbJh = conn('sms_class_jh');
  const dbJob = conn('sms_job');
  const uniDb = conn('sms_common');

  try {
    const health = await req('http://127.0.0.1:8004/health', { timeout: 4000 });
    check('后端在跑（/health 200）', health.json?.code === 200, `code=${health.json?.code}`);
    if (health.json?.code !== 200) {
      console.log('  ⚠️ 后端没起，请先启动服务（一键启动.bat），再跑本脚本。');
      return;
    }

    const tHead = await login('sunmin'); // 初高班主任（发起）
    const tPm = await login('sunjl'); // 实训项目经理（发起）
    const tDean = await login('congym'); // 学管主任（三学段可见 + 可审批）
    check('登录 3 个账号', !!tHead && !!tPm && !!tDean);

    /* ================= 夹具：学生 ================= */
    const mkStu = async (db, dbName, table, stage, noSuffix) => {
      const row = await buildRow(db, table, {
        student_no: `${PREFIX}${noSuffix}`,
        student_name: `${PREFIX}-${noSuffix}`,
        student_status: 5,
        is_deleted: 0,
      });
      await db(table).insert(row);
      reg(dbName, table, row.id);
      await mirrorRow(uniDb, dbName, table, row, stage, (_d, t, id) => reg('sms_common', t, id));
      return row;
    };

    const s1 = await mkStu(dbJh, 'sms_class_jh', 't_class_student', 'jh', 'A1');
    const s2 = await mkStu(dbJh, 'sms_class_jh', 't_class_student', 'jh', 'A2');
    const s3 = await mkStu(dbJh, 'sms_class_jh', 't_class_student', 'jh', 'A3');
    const s4 = await mkStu(dbJob, 'sms_job', 't_student_base', 'job', 'B1');
    check('夹具就绪（3 个初高学生 + 1 个实训学生）', !!(s1.id && s2.id && s3.id && s4.id));

    /* ================= 夹具：异动单（走真实接口） ================= */
    const mkLeave = async (token, stage, student, bizType, submit, dbName, table, bizTypeName) => {
      const r = await req(`${API}/create`, {
        method: 'POST',
        token,
        body: {
          stage,
          studentId: student.id,
          bizType,
          leaveDate: TODAY,
          leaveReason: `自检${PREFIX}-${bizTypeName}`,
          submit,
        },
      });
      const id = r.json?.data?.id;
      if (!id) {
        check(`夹具建单成功（${stage}/${bizTypeName}）`, false, r.json?.message || '');
        return null;
      }
      reg(dbName, table, id);
      const ap = await dbJob('t_job_approval')
        .where({ biz_id: id, is_deleted: 0 })
        .first();
      if (ap) reg('sms_job', 't_job_approval', ap.id);
      return id;
    };

    // 初高：休学(已提交) / 退学(已提交) / 休学(仅草稿)
    const jhSuspend = await mkLeave(tHead, 'jh', s1, BIZ.SUSPEND, true, 'sms_class_jh', 't_class_flow', '初高休学');
    const jhQuit = await mkLeave(tHead, 'jh', s2, BIZ.QUIT, true, 'sms_class_jh', 't_class_flow', '初高退学');
    const jhDraft = await mkLeave(tHead, 'jh', s3, BIZ.SUSPEND, false, 'sms_class_jh', 't_class_flow', '初高休学草稿');
    // 实训：休学(已提交)
    const jobSuspend = await mkLeave(tPm, 'job', s4, BIZ.SUSPEND, true, 'sms_job', 't_job_student_leave', '实训休学');
    check('夹具建单就绪（4 单）', !!(jhSuspend && jhQuit && jhDraft && jobSuspend));

    /** 取一页（默认按夹具关键字收窄） */
    const q = (params) => {
      const sp = new URLSearchParams({ keyword: PREFIX, size: '50', ...params });
      return req(`${API}/list?${sp.toString()}`, { token: tDean });
    };
    const ids = (r) => (r.json?.data?.list || []).map((x) => x.id);

    /* ================= A. 关键字 ================= */
    const kw = await q({ stage: 'jh', keyword: `${PREFIX}A1` });
    check(
      'A 关键字：按学号搜 → 命中的每一行都匹配关键字',
      kw.json?.code === 200 &&
        (kw.json?.data?.list || []).every(
          (x) => String(x.studentNo).includes(`${PREFIX}A1`) || String(x.studentName).includes(`${PREFIX}A1`),
        ),
      `返回 ${(kw.json?.data?.list || []).length} 条`,
    );
    check(
      'A 关键字：A1 的单在、A2/A3 的单不在',
      ids(kw).includes(jhSuspend) && !ids(kw).includes(jhQuit) && !ids(kw).includes(jhDraft),
      `ids=${ids(kw).length}`,
    );

    /* ================= A2. ★ 每行都带「学生现状」（实时值） ================= */
    {
      const all = await q({ stage: 'jh' });
      const rows = all.json?.data?.list || [];
      check(
        '★ 列表每行都带「学生现状」（studentStatus + 中文名）——与「单据状态」区分开',
        rows.length > 0 && rows.every((x) => x.studentStatus != null && x.studentStatusName),
        `共 ${rows.length} 行，缺字段 ${rows.filter((x) => x.studentStatus == null).length} 行`,
      );
      // 交叉核对：接口给的状态必须与直接读学生表一致（不能是编出来的）
      const idsAll = rows.map((x) => x.studentId);
      const dbRows = await (USE_UNI
        ? uniDb('t_uni_student').whereIn('id', idsAll)
        : dbJh('t_class_student').whereIn('id', idsAll)
      ).select('id', 'student_status');
      const dbMap = new Map(dbRows.map((r) => [String(r.id), Number(r.student_status)]));
      const mismatched = rows.filter((x) => dbMap.get(String(x.studentId)) !== Number(x.studentStatus));
      check(
        '★ 「学生现状」与库里 student_status 逐行一致（不是快照、也不是编的）',
        mismatched.length === 0,
        `不一致 ${mismatched.length} 行`,
      );
    }

    /* ================= B. 类型 ================= */
    const b1 = await q({ stage: 'jh', bizType: String(BIZ.SUSPEND) });
    check(
      'B 类型=休学：每一行都是休学，且含 A1/A3 的单、不含 A2 的退学单',
      b1.json?.code === 200 &&
        (b1.json?.data?.list || []).every((x) => x.bizType === BIZ.SUSPEND) &&
        ids(b1).includes(jhSuspend) &&
        ids(b1).includes(jhDraft) &&
        !ids(b1).includes(jhQuit),
      `返回 ${(b1.json?.data?.list || []).length} 条`,
    );
    const b2 = await q({ stage: 'jh', bizType: String(BIZ.QUIT) });
    check(
      'B 类型=退学：只出退学，含 A2 的单、不含 A1/A3',
      b2.json?.code === 200 &&
        (b2.json?.data?.list || []).every((x) => x.bizType === BIZ.QUIT) &&
        ids(b2).includes(jhQuit) &&
        !ids(b2).includes(jhSuspend) &&
        !ids(b2).includes(jhDraft),
      `返回 ${(b2.json?.data?.list || []).length} 条`,
    );

    /* ================= C. 状态 ================= */
    const c1 = await q({ stage: 'jh', status: String(ST.DRAFT) });
    check(
      'C 状态=待提交：每一行都是 1，含 A3 草稿、不含 A1/A2',
      c1.json?.code === 200 &&
        (c1.json?.data?.list || []).every((x) => x.approvalStatus === ST.DRAFT) &&
        ids(c1).includes(jhDraft) &&
        !ids(c1).includes(jhSuspend) &&
        !ids(c1).includes(jhQuit),
      `返回 ${(c1.json?.data?.list || []).length} 条`,
    );
    const c2 = await q({ stage: 'jh', status: String(ST.PENDING) });
    check(
      'C 状态=待学管审批：每一行都是 2，含 A1/A2、不含 A3 草稿',
      c2.json?.code === 200 &&
        (c2.json?.data?.list || []).every((x) => x.approvalStatus === ST.PENDING) &&
        ids(c2).includes(jhSuspend) &&
        ids(c2).includes(jhQuit) &&
        !ids(c2).includes(jhDraft),
      `返回 ${(c2.json?.data?.list || []).length} 条`,
    );

    /* ================= D. 组合（类型 + 状态 + 关键字） ================= */
    const d1 = await q({ stage: 'jh', bizType: String(BIZ.SUSPEND), status: String(ST.DRAFT) });
    check(
      'D 组合（休学 + 待提交）：只剩 A3 那单',
      d1.json?.code === 200 && ids(d1).length === 1 && ids(d1)[0] === jhDraft,
      `返回 ${ids(d1).length} 条`,
    );
    const d2 = await q({ stage: 'jh', bizType: String(BIZ.QUIT), status: String(ST.DRAFT) });
    check(
      'D 组合（退学 + 待提交）：交集为空（参数真的都参与了查询，不是被忽略）',
      d2.json?.code === 200 && ids(d2).length === 0 && (d2.json?.data?.total || 0) === 0,
      `返回 ${ids(d2).length} 条`,
    );

    /* ================= E. 学段 ================= */
    const e1 = await q({ stage: 'jh' });
    const e2 = await q({ stage: 'job' });
    check(
      // ★ 2026-10-20 合并 main：main 侧已把「学段」改叫「部门」，jh 的中文名
      //    由「初高」改成「初高部」（见 server-job/src/teaching/shared/dto.ts 的
      //    TEACHING_STAGE_NAME）。这里按新口径断言，否则这条永远红。
      'E 部门=初高部：每一行都是初高部，且实训那单不在',
      e1.json?.code === 200 &&
        (e1.json?.data?.list || []).every((x) => x.stage === 'jh' && x.stageName === '初高部') &&
        !ids(e1).includes(jobSuspend),
      `返回 ${ids(e1).length} 条`,
    );
    check(
      'E 学段=实训：每一行都是实训，且含实训那单',
      e2.json?.code === 200 &&
        (e2.json?.data?.list || []).every((x) => x.stage === 'job' && x.stageName === '实训') &&
        ids(e2).includes(jobSuspend),
      `返回 ${ids(e2).length} 条`,
    );

    /* ================= F. 大学 + 复学：2026-10-16 起大学开放复学 ================= */
    // 旧口径（大学无复学）这里钉的是「明确 40000」；矩阵放开后改为正向断言：
    // 查询要 200，且返回的每一行都是「大学 + 复学」，不再静默空列表。
    const f1 = await req(`${API}/list?stage=class&bizType=${BIZ.RESUME}`, { token: tDean });
    check(
      'F 大学 + 复学（2026-10-16 起支持）→ 200，且每行都是 大学+复学',
      f1.json?.code === 200 &&
        (f1.json?.data?.list || []).every((x) => x.stage === 'class' && x.bizType === BIZ.RESUME),
      `code=${f1.json?.code} 返回 ${(f1.json?.data?.list || []).length} 条`,
    );

    /* ================= G. ★ onlyMine：过滤必须发生在分页之前 ================= */
    const pageOf = async (page, size) => {
      const r = await req(
        `${API}/list?keyword=${PREFIX}&onlyMine=true&page=${page}&size=${size}`,
        { token: tDean },
      );
      return r.json?.data || { list: [], total: 0 };
    };

    const g1 = await pageOf(1, 50);
    check(
      'G 只看待我审批：每一行都是「我能审的」（canApprove=true）',
      (g1.list || []).length > 0 && (g1.list || []).every((x) => x.canApprove === true),
      `返回 ${(g1.list || []).length} 条，total=${g1.total}`,
    );
    check(
      'G 只看待我审批：已提交的 3 单在、草稿那单不在',
      [jhSuspend, jhQuit, jobSuspend].every((id) => ids({ json: { data: g1 } }).includes(id)) &&
        !ids({ json: { data: g1 } }).includes(jhDraft),
      `ids=${(g1.list || []).map((x) => x.id).length}`,
    );
    check(
      'G 只看待我审批：跨学段（初高 + 实训）都能捞到',
      new Set((g1.list || []).map((x) => x.stage)).size >= 2,
      `学段=${[...new Set((g1.list || []).map((x) => x.stage))].join(',')}`,
    );

    // ★★ 分页自洽：total 必须等于「size=1 逐页翻完」收集到的行数（旧实现这里必挂）
    const total = g1.total || 0;
    const collected = [];
    for (let p = 1; p <= total; p++) {
      const pg = await pageOf(p, 1);
      if (!pg.list?.length) break; // 旧实现：第 2 页就空了
      collected.push(...pg.list.map((x) => x.id));
    }
    check(
      `★ G 分页自洽：total=${total} 与逐页（size=1）收集到的 ${collected.length} 条一致`,
      total > 0 && collected.length === total,
      `收集 ${collected.length} / total ${total}`,
    );
    check(
      '★ G 分页无重复：逐页收集的 id 各不相同（不会同一单重复出现）',
      new Set(collected).size === collected.length,
      `去重后 ${new Set(collected).size} 条`,
    );

    const g2 = await req(`${API}/list?keyword=${PREFIX}&size=50`, { token: tDean });
    check(
      'G 关掉「只看待我审批」后条数 ≥ 开启时（草稿等也算进来）',
      (g2.json?.data?.total || 0) >= total,
      `不勾选 total=${g2.json?.data?.total} / 勾选 total=${total}`,
    );
  } catch (e) {
    check('脚本执行未抛异常', false, e?.message || String(e));
  } finally {
    const jobDb = () => conn('sms_job');
    for (const [dbName, table, id] of fixtures.reverse()) {
      try {
        if (dbName === 'sms_common') await uniDb(table).where({ id }).del();
        else if (dbName === 'sms_job') {
          const d = jobDb();
          await d(table).where({ id }).del();
          await d.destroy();
        } else await dbJh(table).where({ id }).del();
      } catch {
        /* 忽略：已不存在 */
      }
    }
    await dbJh.destroy();
    await dbJob.destroy();
    await uniDb.destroy();
    const ok = summary();
    process.exit(ok ? 0 : 1);
  }
})();
