/**
 * 自检：退费域（第 2 期 · 第 4 个业务域）
 * ============================================================
 *
 * ★★ 本域的核心决策：**审批链统一采用「实训那一套」**
 *      班主任/项目经理发起 → 学管审批 → 校长审批 → 通过后通知财务出款。
 *
 * 因此本脚本最关键的三条断言：
 *   ①【读路径】老库里的老码要正确**归并**成统一码
 *      例：初高的「4 待财务出款」→ 统一「3 待校长审批」；「6 已退费」→「4 已通过」
 *   ②【写路径 · ★新链生效点】学管审完，**落库的原码必须是 5（待校长）**
 *      —— 而不是老链的 3（待教务核算）。这是"新链真的生效了"唯一的可靠证据。
 *   ③【真正统一】三学段的审批单都落在**同一张表** `sms_job.t_job_approval`
 *
 * 演示库里三张退费表都是空的 → 本脚本**自己造夹具，测完删干净**。
 */
import { randomUUID } from 'node:crypto';
import {
  BASE,
  buildRow,
  conn,
  dumpLogs,
  killAll,
  login,
  makeChecker,
  mirrorRow,
  req,
  startServices,
  USE_UNI,
} from './_e2e-lib.mjs';

const API = `${BASE}/api/teaching/refund`;
const BIZ_REFUND = 'refund';

const { check, summary } = makeChecker();

/** 夹具登记（用于测完清理）：[库, 表, id] */
const fixtures = [];
function reg(db, table, id) {
  fixtures.push([db, table, id]);
}

(async () => {
  const dbJh = conn('sms_class_jh');
  const dbCls = conn('sms_class');
  const dbJob = conn('sms_job');
  // ★ 第 4 期步骤 1：统一表连接
  const uniDb = conn('sms_common');

  /**
   * ★ 第 4 期步骤 1：夹具双写
   *   老表照写 + 镜像写统一表 → 切读开关前后跑同一套断言，结果必须一致。
   * ⚠️ 退费单/审批单走 API（经过仓储），切读后仓储自己写统一表，**不镜像**。
   * ⚠️ 审批链 4 张老表（class_refund / class_refund_apply / class_refund_item /
   *    job_refund）本轮不在 UNI_MAP —— 属第 4 期步骤 4「审批链归一」。
   */
  const mirror = async (dbName, table, row, stage) => {
    await mirrorRow(uniDb, dbName, table, row, stage, (_d, t, id) => reg('sms_common', t, id));
  };

  /* ★ #24 开关开适配：产品在开关开时写统一表 → 断言与清理都按开关分流。
     表名对照：
       实训退费   sms_job.t_job_refund        → t_uni_refund
       大学退费   sms_class.t_class_refund_apply → t_uni_refund（同表！靠 edu_stage 区分）
       审批单     sms_job.t_job_approval      → t_uni_approval_main
       费用项     sms_class.t_class_refund_item → t_uni_refund_item
       审批轨迹   sms_job.t_job_approval_log  → t_uni_approval_log */
  const jobRefundT = () => (USE_UNI ? uniDb('t_uni_refund') : dbJob('t_job_refund'));
  const clsRefundT = () => (USE_UNI ? uniDb('t_uni_refund') : dbCls('t_class_refund_apply'));
  const approvalT = () => (USE_UNI ? uniDb('t_uni_approval_main') : dbJob('t_job_approval'));
  /** 产品写进统一表的行也要登记清理（老表模式下登记老表行即可） */
  const regUniRefund = (id) => {
    if (id && USE_UNI) reg('sms_common', 't_uni_refund', id);
  };
  const regUniApproval = (id) => {
    if (id && USE_UNI) reg('sms_common', 't_uni_approval_main', id);
  };

  /** 本次自检创建的两张单（finally 里清理审批轨迹要用） */
  let jobId;
  let clsId;
  let jhId;

  try {
    /* ============ A. 环境 ============ */
    const { backendReady, frontendReady } = await startServices();
    check('服务就绪（后端 8004 + 前端 5173）', backendReady && frontendReady);
    if (!backendReady) {
      dumpLogs();
      return;
    }

    const tJhHead = await login('sunmin'); // 初高班主任（TEACH_HEAD）
    const tPm = await login('sunjl'); // 实训项目经理（RM_PROJECT）
    const tDean = await login('congym'); // 学管主任（三学段都有权限）
    const tPrincipal = await login('qiansy'); // 校长（三学段都有权限）
    const tAdmin = await login('admin'); // 只读管理员
    check('登录 5 个账号', !!tJhHead && !!tPm && !!tDean && !!tPrincipal && !!tAdmin);

    /* ============ B. ★ 读路径：老码归并 ============ */
    const mkJhRefund = async (rawStatus, name) => {
      const row = await buildRow(dbJh, 't_class_refund', {
        student_id: randomUUID(),
        student_no: 'AUTO' + Math.random().toString(36).slice(2, 7).toUpperCase(),
        student_name: name,
        fee_type: 1,
        refund_amount: 12345,
        refund_reason: '自检夹具',
        apply_date: '2026-10-09',
        refund_status: rawStatus,
        is_deleted: 0,
      });
      await dbJh('t_class_refund').insert(row);
      reg('sms_class_jh', 't_class_refund', row.id);
      /* ★ P8 后老表已 DROP：夹具只保留统一表那一份 ——
         产品若还读老表，本节断言必红（此前本套件正是因为老表还在而被"假绿"掩盖）。 */
      await mirror('sms_class_jh', 't_class_refund', row, 'jh');
      await dbJh('t_class_refund').where({ id: row.id }).del();
      return row.id;
    };

    const jhRaw4 = await mkJhRefund(4, '自检-待财务出款'); // 老码 4
    const jhRaw6 = await mkJhRefund(6, '自检-已退费'); // 老码 6
    const jhRaw8 = await mkJhRefund(8, '自检-已撤回'); // 老码 8

    const rList = await req(`${API}/list?stage=jh&size=100`, { token: tJhHead });
    const jhRows = (rList.json?.data?.list || []).filter((x) => x.studentName?.startsWith('自检-'));
    const pick = (id) => jhRows.find((x) => x.id === id);

    check(
      '★ 读路径·归并：老码 4（待财务出款）→ 统一 3（待校长审批）',
      pick(jhRaw4)?.approvalStatus === 3 && pick(jhRaw4)?.approvalStatusName === '待校长审批',
      `得到 ${pick(jhRaw4)?.approvalStatus}/${pick(jhRaw4)?.approvalStatusName}`,
    );
    check(
      '★ 读路径：老码 6（已退费）→ 统一 4（已通过）',
      pick(jhRaw6)?.approvalStatus === 4 && pick(jhRaw6)?.approvalStatusName === '已通过',
      `得到 ${pick(jhRaw6)?.approvalStatus}/${pick(jhRaw6)?.approvalStatusName}`,
    );
    check(
      '★ 读路径：老码 8（已撤回）→ 统一 6（已撤销）',
      pick(jhRaw8)?.approvalStatus === 6 && pick(jhRaw8)?.approvalStatusName === '已撤销',
      `得到 ${pick(jhRaw8)?.approvalStatus}/${pick(jhRaw8)?.approvalStatusName}`,
    );
    // 老单（无审批单）的按钮：
    //   · **学管**应能看到「审批」→ 说明不会因合并而卡死（这是本断言的目的）
    //   · **班主任**本来就不该有审批按钮 → 一并断言，防止"顺手多放一个"
    const rListDean = await req(`${API}/list?stage=jh&size=100`, { token: tDean });
    const deanRows = (rListDean.json?.data?.list || []).filter((x) =>
      x.studentName?.startsWith('自检-'),
    );
    const deanPick = (id) => deanRows.find((x) => x.id === id);
    check(
      '老单（无审批单）：学管仍看得到「审批」按钮（不会因合并而卡死）',
      deanPick(jhRaw4)?.canApprove === true,
      `canApprove=${deanPick(jhRaw4)?.canApprove}`,
    );
    check(
      '老单：班主任看不到「审批」按钮（权限口径正确，没多放）',
      pick(jhRaw4)?.canApprove === false,
      `canApprove=${pick(jhRaw4)?.canApprove}`,
    );

    /* ============ B2. ★ 初高：写路径（P8 后老表已 DROP，只认统一表） ============
       【为什么单独加这一段】
         `repo.classJh.ts` 曾有 7 处裸访 `t_class_refund`（list/detail/aggregate/
         insert/setStatus/setFinance/hasPending），P8 DROP 后初高退费整域 50002。
         此前本节只读路径 + 老表夹具还在 → 被"假绿"掩盖；现在老表行插完即删，
         产品只要回退到读老表，下面每条都会红。
         ------------------------------------------------------------ */
    const jhStu = await buildRow(dbJh, 't_class_student', {
      student_no: 'JT' + Math.random().toString(36).slice(2, 7).toUpperCase(),
      student_name: '自检-初高生',
      student_status: 1,
      is_deleted: 0,
    });
    await dbJh('t_class_student').insert(jhStu);
    reg('sms_class_jh', 't_class_student', jhStu.id);
    await mirror('sms_class_jh', 't_class_student', jhStu, 'jh');
    await dbJh('t_class_student').where({ id: jhStu.id }).del();

    const cJh = await req(`${API}/create`, {
      method: 'POST',
      token: tJhHead,
      body: {
        stage: 'jh',
        studentId: jhStu.id,
        items: [{ feeType: 1, amount: 100000 }],
        refundAmount: 100000,
        refundReason: '自检-初高退费',
        submit: true,
      },
    });
    check('初高：发起退费（老表已 DROP，写路径必须走统一表）', cJh.json?.code === 200, cJh.json?.message || '');
    jhId = cJh.json?.data?.id;
    if (jhId) {
      regUniRefund(jhId);
      const jhRow = await uniDb('t_uni_refund').where({ id: jhId }).first();
      check(
        '★ 初高：退费单落在 t_uni_refund 且 edu_stage=jh',
        !!jhRow && jhRow.edu_stage === 'jh',
        jhRow ? `edu_stage=${jhRow.edu_stage}` : '统一表没有该行',
      );
      check(
        '初高：发起并提交 → refund_status = 2（待学管）',
        Number(jhRow?.refund_status) === 2,
        `refund_status=${jhRow?.refund_status}`,
      );
    }

    const dJh = await req(`${API}/detail?id=${jhId}`, { token: tJhHead });
    check('初高：详情可读（detail 走统一表）', dJh.json?.code === 200 && !!dJh.json?.data, dJh.json?.message || '');

    const aJh = await req(`${API}/approve`, {
      method: 'POST',
      token: tDean,
      body: { stage: 'jh', id: jhId, comment: '自检-学管同意' },
    });
    check('初高：学管审批（setStatus 写统一表）', aJh.json?.code === 200, aJh.json?.message || '');
    const jhAfter = jhId ? await uniDb('t_uni_refund').where({ id: jhId }).first() : null;
    check(
      '初高：审批后状态推进（不再是 1/2）',
      Number(jhAfter?.refund_status) >= 2,
      `refund_status=${jhAfter?.refund_status}`,
    );
    // 审批单登记清理（产品写进 t_uni_approval_main）
    const apJh = jhId
      ? await uniDb('t_uni_approval_main').where({ biz_type: 'refund', biz_id: jhId }).first()
      : null;
    if (apJh) regUniApproval(apJh.id);

    /* ============ C. 实训：全链路（蓝本） ============ */
    const jobStu = await buildRow(dbJob, 't_student_base', {
      student_no: 'JT' + Math.random().toString(36).slice(2, 7).toUpperCase(),
      student_name: '自检-实训生',
      student_status: 1,
      is_deleted: 0,
    });
    await dbJob('t_student_base').insert(jobStu);
    reg('sms_job', 't_student_base', jobStu.id);
    // ★ 双写 t_uni_student（实训）
    await mirror('sms_job', 't_student_base', jobStu, 'job');

    const cJob = await req(`${API}/create`, {
      method: 'POST',
      token: tPm,
      body: {
        stage: 'job',
        studentId: jobStu.id,
        items: [{ feeType: 1, amount: 100000 }],
        refundAmount: 100000,
        refundReason: '自检-实训退费',
        submit: true,
      },
    });
    check('实训：项目经理发起退费（可提交）', cJob.json?.code === 200, cJob.json?.message || '');
    jobId = cJob.json?.data?.id;
    if (jobId) reg('sms_job', 't_job_refund', jobId);
    regUniRefund(jobId);

    const jobRow1 = await jobRefundT().where({ id: jobId }).first();
    check(
      '实训：发起后直接提交 → 状态 = 2（待学管审批）',
      Number(jobRow1?.approval_status) === 2,
      `approval_status=${jobRow1?.approval_status}`,
    );

    const apJob = await approvalT()
      .where({ biz_type: BIZ_REFUND, biz_id: jobId, is_deleted: 0 })
      .first();
    check(
      `★ 实训：审批单落在${USE_UNI ? ' t_uni_approval_main（统一审批表）' : ' t_job_approval（统一审批表）'}`,
      !!apJob,
      apJob ? '有' : '无',
    );
    if (apJob) reg('sms_job', 't_job_approval', apJob.id);
    regUniApproval(apJob?.id);

    const ap1 = await req(`${API}/approve`, {
      method: 'POST',
      token: tDean,
      body: { stage: 'job', id: jobId, comment: '学管同意' },
    });
    check('实训：学管审批通过', ap1.json?.code === 200, ap1.json?.message || '');
    const jobRow2 = await jobRefundT().where({ id: jobId }).first();
    check(
      '实训：学管审完 → 状态 = 3（待校长审批）',
      Number(jobRow2?.approval_status) === 3,
      `approval_status=${jobRow2?.approval_status}`,
    );

    const ap2 = await req(`${API}/approve`, {
      method: 'POST',
      token: tPrincipal,
      body: { stage: 'job', id: jobId, comment: '校长同意' },
    });
    check('实训：校长审批通过（链路走完）', ap2.json?.code === 200 && ap2.json?.data?.finished === true,
      JSON.stringify(ap2.json?.data || ap2.json?.message));
    const jobRow3 = await jobRefundT().where({ id: jobId }).first();
    check(
      '实训：终审通过 → 状态 = 4（已通过）',
      Number(jobRow3?.approval_status) === 4,
      `approval_status=${jobRow3?.approval_status}`,
    );

    /* ============ D. ★★ 大学：新链生效点 ============ */
    const clsStu = await buildRow(dbCls, 't_class_student', {
      student_no: 'CT' + Math.random().toString(36).slice(2, 7).toUpperCase(),
      student_name: '自检-大学生',
      student_status: 1,
      is_deleted: 0,
    });
    await dbCls('t_class_student').insert(clsStu);
    reg('sms_class', 't_class_student', clsStu.id);
    // ★ 双写 t_uni_student（大学）
    await mirror('sms_class', 't_class_student', clsStu, 'class');

    // 校长发起（走 canInitiate 的全权角色口子）
    const cCls = await req(`${API}/create`, {
      method: 'POST',
      token: tPrincipal,
      body: {
        stage: 'class',
        studentId: clsStu.id,
        items: [
          { feeType: 1, amount: 60000 },
          { feeType: 2, amount: 40000 },
        ],
        refundAmount: 100000,
        refundReason: '自检-大学退费',
        submit: true,
      },
    });
    check('大学：发起退费（含两项费用）', cCls.json?.code === 200, cCls.json?.message || '');
    clsId = cCls.json?.data?.id;
    if (clsId) {
      reg('sms_class', 't_class_refund_apply', clsId);
      regUniRefund(clsId);
      // 子表
      const itemsT = USE_UNI ? uniDb('t_uni_refund_item') : dbCls('t_class_refund_item');
      const items = await itemsT.where({ refund_id: clsId });
      for (const it of items) {
        reg('sms_class', 't_class_refund_item', it.id);
        // ★ 开关开时产品写的是统一表费用项，也要登记清理（否则残留）
        if (USE_UNI) reg('sms_common', 't_uni_refund_item', it.id);
      }
      check('大学：费用项写入子表（2 项）', items.length === 2, `items=${items.length}`);
    }

    const clsRow1 = await clsRefundT().where({ id: clsId }).first();
    check(
      '大学：发起并提交 → refund_status = 2（待学管）',
      Number(clsRow1?.refund_status) === 2,
      `refund_status=${clsRow1?.refund_status}`,
    );

    const apC1 = await req(`${API}/approve`, {
      method: 'POST',
      token: tDean,
      body: { stage: 'class', id: clsId, comment: '学管同意' },
    });
    check('大学：学管审批通过', apC1.json?.code === 200, apC1.json?.message || '');
    const clsRow2 = await clsRefundT().where({ id: clsId }).first();
    check(
      '★★ 大学·新链生效点：学管审完落库原码 = 5（待校长），而不是老链的 3（待教务核算）',
      Number(clsRow2?.refund_status) === 5,
      `refund_status=${clsRow2?.refund_status}（期望 5；若为 3 说明新链没生效）`,
    );

    const apC2 = await req(`${API}/approve`, {
      method: 'POST',
      token: tPrincipal,
      body: { stage: 'class', id: clsId, comment: '校长同意' },
    });
    check('大学：校长审批通过', apC2.json?.code === 200, apC2.json?.message || '');
    const clsRow3 = await clsRefundT().where({ id: clsId }).first();
    check(
      '大学：终审通过 → 落库原码 = 6（已退费）',
      Number(clsRow3?.refund_status) === 6,
      `refund_status=${clsRow3?.refund_status}`,
    );

    const apCls = await approvalT()
      .where({ biz_type: BIZ_REFUND, biz_id: clsId, is_deleted: 0 })
      .first();
    check(
      `★ 大学：审批单同样落在${USE_UNI ? ' t_uni_approval_main' : ' t_job_approval'}（跨库写入成功）`,
      !!apCls,
      apCls ? '有' : '无',
    );
    if (apCls) reg('sms_job', 't_job_approval', apCls.id);
    regUniApproval(apCls?.id);

    // 统一接口读回 → 应是统一码 4（已通过）
    const dCls = await req(`${API}/detail?id=${clsId}`, { token: tPrincipal });
    check(
      '★ 大学：统一接口读回 = 统一 4（已通过）+ 费用项为「学费/住宿费」',
      dCls.json?.data?.record?.approvalStatus === 4 &&
        String(dCls.json?.data?.record?.feeTypeName || '').includes('学费'),
      `status=${dCls.json?.data?.record?.approvalStatus} fee=${dCls.json?.data?.record?.feeTypeName}`,
    );
    check(
      '大学：详情返回审批轨迹（学管 + 校长两条）',
      (dCls.json?.data?.logs || []).length >= 2,
      `logs=${(dCls.json?.data?.logs || []).length}`,
    );

    /* ============ E. 三学段审批单在同一张表 ============ */
    const allAp = await approvalT()
      .where({ biz_type: BIZ_REFUND, is_deleted: 0 })
      .whereIn('biz_id', [jobId, clsId, jhId].filter(Boolean));
    check(
      `★ 真正统一：初高 + 实训 + 大学的审批单都在${USE_UNI ? ' sms_common.t_uni_approval_main' : ' sms_job.t_job_approval'}`,
      allAp.length === 3,
      `找到 ${allAp.length} 条（期望 3：jh/class/job 各一）`,
    );

    /* ============ F. 权限 ============ */
    const cross = await req(`${API}/list?stage=class`, { token: tJhHead });
    check('学段隔离：初高账号查大学退费被拒(40302)', cross.json?.code === 40302, cross.json?.message || '');

    const anon = await req(`${API}/list`);
    check('未登录被拒(401/40101)', anon.status === 401, `status=${anon.status} code=${anon.json?.code}`);

    const wAdmin = await req(`${API}/create`, {
      method: 'POST',
      token: tAdmin,
      body: {
        stage: 'job',
        studentId: jobStu.id,
        items: [{ feeType: 1, amount: 100 }],
        refundAmount: 100,
        refundReason: 'x',
      },
    });
    check('只读管理员写请求被拦(40302)', wAdmin.json?.code === 40302, wAdmin.json?.message || '');

    /* ============ G. 汇总 / 审批链 ============ */
    const sum = await req(`${API}/summary`, { token: tPrincipal });
    check(
      '汇总：校长可见 3 个学段',
      Array.isArray(sum.json?.data) && sum.json.data.length === 3,
      `学段数=${(sum.json?.data || []).length}`,
    );

    const chain = await req(`${API}/chain`, { token: tPrincipal });
    check(
      '审批链说明接口返回 2 个节点（学管 → 校长）',
      chain.json?.data?.nodes?.length === 2,
      JSON.stringify(chain.json?.data?.nodes || []),
    );
  } catch (e) {
    check('执行过程无异常', false, e?.message || String(e));
  } finally {
    /* ---------- 清理夹具 ---------- */
    let removed = 0;
    for (const [dbName, table, id] of fixtures.reverse()) {
      // ★ 第 4 期：sms_common 是镜像行，走 uniDb
      const k =
        dbName === 'sms_class_jh'
          ? dbJh
          : dbName === 'sms_class'
            ? dbCls
            : dbName === 'sms_common'
              ? uniDb
              : dbJob;
      try {
        const n = await k(table).where({ id }).del();
        removed += Number(n || 0);
      } catch {
        /* 忽略 */
      }
    }
    console.log(`\n（已清理自检夹具 ${removed} 行）`);
    // 顺带清掉本条自检产生的审批轨迹（按开关落到对应轨迹表）
    try {
      if (USE_UNI) {
        await uniDb('t_uni_approval_log')
          .whereIn(
            'approval_id',
            uniDb('t_uni_approval_main').select('id').whereIn('biz_id', [jobId, clsId, jhId].filter(Boolean)),
          )
          .del();
      } else {
        await dbJob('t_job_approval_log')
          .whereIn(
            'approval_id',
            dbJob('t_job_approval').select('id').whereIn('biz_id', [jobId, clsId, jhId].filter(Boolean)),
          )
          .del();
      }
    } catch {
      /* 忽略 */
    }
    await dbJh.destroy();
    await dbCls.destroy();
    await dbJob.destroy();
    await uniDb.destroy(); // ★ 第 4 期：统一表镜像连接
    summary();
    killAll();
    process.exit(0);
  }
})();

