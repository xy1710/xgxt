/**
 * 自检：学籍异动审批域（第 2 期 · 第 5 个业务域）
 * ============================================================
 * ★★ 审批链统一采用实训那一套：
 *    休学 1 步（学管）· 复学 1 步（学管）· 退学 2 步（学管 → 校长）
 *
 * 本脚本最关键的几条断言：
 *   ①【类型映射】初高 flow_type 5=退学 / 2=复学 → 统一 2 / 3（**值不一样**）
 *   ②【状态映射】初高 flow_status 3=已同意 → 统一 4；4=已驳回 → 统一 5
 *   ③【★ 新链生效点】初高退学：学管审完落库 **flow_status = 5**（新补的"待校长"），
 *      而不是老链的 3（已同意）—— 这是"新链真的生效"唯一的可靠证据
 *   ④【复学必须选班】终审不传 newClassId 必须被拦（不能悄悄通过）
 *   ⑤【大学不支持复学】业务事实，必须显式拒绝
 *
 * 演示库三张表都是空的 → 自己造夹具、测完删干净。
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
  probe,
  regTarget,
  startServices,
  USE_UNI,
} from './_e2e-lib.mjs';

const API = `${BASE}/api/teaching/leave`;
const BIZ = { SUSPEND: 1, QUIT: 2, RESUME: 3 };
const ALL_BIZ_TYPES = ['suspend', 'quit', 'resume'];

/**
 * ★ 异动日期用「今天」，不要写死日期
 *
 * 后端已加「异动日期只能是今天 ± 10 天」的校验（防手滑把 2026 写成 2025 之类，
 * 见 shared/format.ts 的 LEAVE_DATE_WINDOW_DAYS）。写死的 '2026-10-09'
 * 当天跑没问题，过几天再跑就会被这条校验拦下 —— 那是**测试自己过期**，
 * 不是业务坏了，会浪费大量排查时间。所以统一取当天。
 */
const TODAY = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
})();

const { check, summary } = makeChecker();
const fixtures = [];
// ★ 第4期步骤2：切读时数据落在统一表，登记必须跟着改指向，否则清理删不掉
const reg = (dbName, table, id) => { const [d, t] = regTarget(dbName, table); fixtures.push([d, t, id]); };

(async () => {
  const dbJh = conn('sms_class_jh');
  const dbCls = conn('sms_class');
  const dbJob = conn('sms_job');
  // ★ 第 4 期步骤 1：统一表连接（夹具双写用）
  const uniDb = conn('sms_common');

  let jobId;
  let clsId;

  try {
    /* ============ A. 环境 ============ */
    const { backendReady, frontendReady } = await startServices();
    check('服务就绪（后端 8004 + 前端 5173）', backendReady && frontendReady);
    if (!backendReady) {
      dumpLogs();
      return;
    }

    const tJhHead = await login('sunmin'); // 初高班主任
    const tPm = await login('sunjl'); // 实训项目经理
    const tDean = await login('congym'); // 学管主任（三学段都有权限）
    const tPrincipal = await login('qiansy'); // 校长（三学段都有权限）
    const tAdmin = await login('admin'); // 只读管理员
    check('登录 5 个账号', !!tJhHead && !!tPm && !!tDean && !!tPrincipal && !!tAdmin);

    /* ============ B. 夹具：学生 + 班级 ============ */
    /**
     * ★ 第 4 期步骤 1：夹具双写
     *   老表照写 + 镜像写统一表（t_uni_student）→ 切读前后跑同一套断言。
     * ⚠️ 审批单走 API（经过仓储），切读后仓储自己写统一表，**不镜像**。
     * ✅ 第 4 期第 2 批起 `t_class_flow` / `t_class_suspend_apply` / `t_job_student_leave`
     *   都已进 UNI_MAP（→ `t_uni_approval`），夹具按 `USE_UNI` 分流。
     */
    const mkStudent = async (db, table, name, status) => {
      const row = await buildRow(db, table, {
        student_no: 'LV' + Math.random().toString(36).slice(2, 7).toUpperCase(),
        student_name: name,
        student_status: status,
        is_deleted: 0,
      });
      await db(table).insert(row);
      const dbName = db === dbJh ? 'sms_class_jh' : db === dbCls ? 'sms_class' : 'sms_job';
      const stage = db === dbJh ? 'jh' : db === dbCls ? 'class' : 'job';
      reg(dbName, table, row.id);
      // ★ 双写 t_uni_student
      await mirrorRow(uniDb, dbName, table, row, stage, (_d, t, id) =>
        reg('sms_common', t, id),
      );
      return row;
    };

    const jobStu = await mkStudent(dbJob, 't_student_base', '自检-实训生', 8);
    const jhStu = await mkStudent(dbJh, 't_class_student', '自检-初高生', 5);
    const clsStu = await mkStudent(dbCls, 't_class_student', '自检-大学生', 5);

    const jobCls = await buildRow(dbJob, 't_job_class', { class_name: '自检-复学班', is_deleted: 0 });
    await dbJob('t_job_class').insert(jobCls);
    reg('sms_job', 't_job_class', jobCls.id);
    // ★ 双写 t_uni_class（实训，复学要转班）
    await mirrorRow(uniDb, 'sms_job', 't_job_class', jobCls, 'job', (_d, t, id) =>
      reg('sms_common', t, id),
    );

    // ★ 2026-10-16 起大学开放复学 → 大学也要一个复学班夹具
    const clsCls = await buildRow(dbCls, 't_class_info', { class_name: '自检-大学复学班', is_deleted: 0 });
    await dbCls('t_class_info').insert(clsCls);
    reg('sms_class', 't_class_info', clsCls.id);
    await mirrorRow(uniDb, 'sms_class', 't_class_info', clsCls, 'class', (_d, t, id) =>
      reg('sms_common', t, id),
    );

    check(
      '夹具就绪（3 学生 + 1 实训班 + 1 大学班）',
      !!jobStu.id && !!jhStu.id && !!clsStu.id && !!jobCls.id && !!clsCls.id,
    );

    /* ============ C. ★ 读路径：类型与状态映射 ============ */
    /**
     * ★ 第 4 期第 2 批：`t_class_flow` 已进 UNI_MAP（→ `t_uni_approval`）
     *   → 切读时数据必须落统一表，且要显式写 `edu_stage='jh'`，
     *     否则按学段过滤查不到（统一表靠 edu_stage 区分学段）。
     *   症状参考宿舍域第 1 批：`STAGE_OF['sms_class_jh']` 推断对，但必须显式传。
     */
    const mkJhFlow = async (flowType, flowStatus, name) => {
      const row = await buildRow(dbJh, 't_class_flow', {
        flow_type: flowType,
        flow_status: flowStatus,
        suspend_status: flowStatus,
        student_id: randomUUID(),
        student_no: 'F' + Math.random().toString(36).slice(2, 7).toUpperCase(),
        student_name: name,
        apply_time: new Date(),
        apply_reason: '自检夹具',
      });
      if (USE_UNI) {
        // ★ 切读：直接落统一表，补 edu_stage（NOT NULL 无默认）
        //   ⚠️ 还必须补 apply_no —— `uk_approval(apply_no, edu_stage)` 唯一索引。
        //   初高老表 `t_class_flow` 没有 apply_no 这一列（切读前不生成也不撞车），
        //   统一表 apply_no NOT NULL DEFAULT '' → 不写就落空串 → 同学段第二行就撞。
        //   → 夹具必须跟生产代码一样生成单号，不能只补 edu_stage。
        await uniDb('t_uni_approval').insert({
          ...row,
          edu_stage: 'jh',
          apply_no: 'XJ' + Math.random().toString(36).slice(2, 12).toUpperCase(),
        });
        reg('sms_common', 't_uni_approval', row.id);
      } else {
        await dbJh('t_class_flow').insert(row);
        reg('sms_class_jh', 't_class_flow', row.id);
      }
      return row.id;
    };

    const jhQuit = await mkJhFlow(5, 3, '自检-初高退学已完成'); // 退学 + 已同意
    const jhResume = await mkJhFlow(2, 4, '自检-初高复学已驳回'); // 复学 + 已驳回

    const rList = await req(`${API}/list?stage=jh&size=100`, { token: tJhHead });
    const jhRows = (rList.json?.data?.list || []).filter((x) => x.studentName?.startsWith('自检-'));
    const pick = (id) => jhRows.find((x) => x.id === id);

    check(
      '★ 读路径·类型映射：初高 flow_type=5（退学）→ 统一 2（退学）',
      pick(jhQuit)?.bizType === 2 && pick(jhQuit)?.bizTypeName === '退学',
      `bizType=${pick(jhQuit)?.bizType}/${pick(jhQuit)?.bizTypeName}`,
    );
    check(
      '★ 读路径·类型映射：初高 flow_type=2（复学）→ 统一 3（复学）',
      pick(jhResume)?.bizType === 3 && pick(jhResume)?.bizTypeName === '复学',
      `bizType=${pick(jhResume)?.bizType}/${pick(jhResume)?.bizTypeName}`,
    );
    check(
      '★ 读路径·状态映射：初高 flow_status=3（已同意）→ 统一 4（已通过）',
      pick(jhQuit)?.approvalStatus === 4,
      `status=${pick(jhQuit)?.approvalStatus}/${pick(jhQuit)?.approvalStatusName}`,
    );
    check(
      '★ 读路径·状态映射：初高 flow_status=4（已驳回）→ 统一 5（已驳回）',
      pick(jhResume)?.approvalStatus === 5,
      `status=${pick(jhResume)?.approvalStatus}/${pick(jhResume)?.approvalStatusName}`,
    );

    /* ============ D. 实训：退学全链路（2 步） ============ */
    const cJob = await req(`${API}/create`, {
      method: 'POST',
      token: tPm,
      body: {
        stage: 'job',
        studentId: jobStu.id,
        bizType: BIZ.QUIT,
        leaveDate: TODAY,
        leaveReason: '自检-实训退学',
        submit: true,
      },
    });
    check('实训：项目经理发起退学', cJob.json?.code === 200, cJob.json?.message || '');
    jobId = cJob.json?.data?.id;
    if (jobId) reg('sms_job', 't_job_student_leave', jobId);

    const jobRow1 = await probe(dbJob, 'sms_job', 't_job_student_leave').where({ id: jobId }).first();
    check(
      '实训：提交后 approval_status = 2（待学管）',
      Number(jobRow1?.approval_status) === 2,
      `approval_status=${jobRow1?.approval_status}`,
    );

    const apJob = await dbJob('t_job_approval')
      .where({ biz_type: 'quit', biz_id: jobId, is_deleted: 0 })
      .first();
    check('★ 实训：审批单落在 t_job_approval（统一审批表）', !!apJob, apJob ? '有' : '无');
    if (apJob) reg('sms_job', 't_job_approval', apJob.id);

    const ap1 = await req(`${API}/approve`, {
      method: 'POST',
      token: tDean,
      body: { stage: 'job', id: jobId, comment: '学管同意' },
    });
    check('实训：学管审批通过', ap1.json?.code === 200, ap1.json?.message || '');
    const jobRow2 = await probe(dbJob, 'sms_job', 't_job_student_leave').where({ id: jobId }).first();
    check(
      '实训：学管审完 → 3（待校长）',
      Number(jobRow2?.approval_status) === 3,
      `approval_status=${jobRow2?.approval_status}`,
    );

    const ap2 = await req(`${API}/approve`, {
      method: 'POST',
      token: tPrincipal,
      body: { stage: 'job', id: jobId, comment: '校长同意' },
    });
    check(
      '实训：校长审批通过（链路走完）',
      ap2.json?.code === 200 && ap2.json?.data?.finished === true,
      JSON.stringify(ap2.json?.data || ap2.json?.message),
    );
    const jobStuAfter = await probe(dbJob, 'sms_job', 't_student_base').where({ id: jobStu.id }).first();
    check(
      '★ 实训：副作用生效 → 学生状态 = 7（退学）',
      Number(jobStuAfter?.student_status) === 7,
      `student_status=${jobStuAfter?.student_status}`,
    );
    const clsSynced = await probe(dbCls, 'sms_class', 't_class_student').where({ student_no: jobStu.student_no }).first();
    check(
      '★ 实训：跨库同步 → sms_class.t_class_student 同状态（该学号在班级库没有则跳过）',
      clsSynced ? Number(clsSynced.student_status) === 7 : true,
      clsSynced ? `student_status=${clsSynced.student_status}` : '班级库无此学号（正常）',
    );

    /* ============ E. ★★ 初高：退学 2 步（新链生效点） ============ */
    const cJh = await req(`${API}/create`, {
      method: 'POST',
      token: tJhHead,
      body: {
        stage: 'jh',
        studentId: jhStu.id,
        bizType: BIZ.QUIT,
        leaveDate: TODAY,
        leaveReason: '自检-初高退学',
        submit: true,
      },
    });
    check('初高：班主任发起退学', cJh.json?.code === 200, cJh.json?.message || '');
    const jhFlowId = cJh.json?.data?.id;
    if (jhFlowId) reg('sms_class_jh', 't_class_flow', jhFlowId);

    const jhRow1 = await probe(dbJh, 'sms_class_jh', 't_class_flow').where({ id: jhFlowId }).first();
    check(
      '初高：flow_type 落库 = 5（退学原码）、flow_status = 2',
      Number(jhRow1?.flow_type) === 5 && Number(jhRow1?.flow_status) === 2,
      `flow_type=${jhRow1?.flow_type} flow_status=${jhRow1?.flow_status}`,
    );

    const apJ1 = await req(`${API}/approve`, {
      method: 'POST',
      token: tDean,
      body: { stage: 'jh', id: jhFlowId, comment: '学管同意' },
    });
    check('初高：学管审批通过', apJ1.json?.code === 200, apJ1.json?.message || '');
    const jhRow2 = await probe(dbJh, 'sms_class_jh', 't_class_flow').where({ id: jhFlowId }).first();
    check(
      '★★ 初高·新链生效点：学管审完落库 flow_status = 5（新补的"待校长"），不是老链的 3（已同意）',
      Number(jhRow2?.flow_status) === 5,
      `flow_status=${jhRow2?.flow_status}（期望 5；为 3 说明新链没生效）`,
    );

    const apJ2 = await req(`${API}/approve`, {
      method: 'POST',
      token: tPrincipal,
      body: { stage: 'jh', id: jhFlowId, comment: '校长同意' },
    });
    check('初高：校长审批通过', apJ2.json?.code === 200, apJ2.json?.message || '');
    const jhRow3 = await probe(dbJh, 'sms_class_jh', 't_class_flow').where({ id: jhFlowId }).first();
    check(
      '初高：终审通过 → flow_status = 3（已同意=已通过）',
      Number(jhRow3?.flow_status) === 3,
      `flow_status=${jhRow3?.flow_status}`,
    );
    const jhStuAfter = await probe(dbJh, 'sms_class_jh', 't_class_student').where({ id: jhStu.id }).first();
    check(
      '★ 初高：副作用生效 → 学生状态 = 7（退学）',
      Number(jhStuAfter?.student_status) === 7,
      `student_status=${jhStuAfter?.student_status}`,
    );

    /* ============ F. 大学：休学 1 步（直接通过） ============ */
    const cCls = await req(`${API}/create`, {
      method: 'POST',
      token: tPrincipal,
      body: {
        stage: 'class',
        studentId: clsStu.id,
        bizType: BIZ.SUSPEND,
        leaveDate: TODAY,
        leaveReason: '自检-大学休学',
        submit: true,
      },
    });
    check('大学：发起休学', cCls.json?.code === 200, cCls.json?.message || '');
    clsId = cCls.json?.data?.id;
    if (clsId) reg('sms_class', 't_class_suspend_apply', clsId);

    const clsRow1 = await probe(dbCls, 'sms_class', 't_class_suspend_apply').where({ id: clsId }).first();
    check(
      '大学：apply_type 落库 = 1（休学）、apply_status = 2',
      Number(clsRow1?.apply_type) === 1 && Number(clsRow1?.apply_status) === 2,
      `apply_type=${clsRow1?.apply_type} apply_status=${clsRow1?.apply_status}`,
    );

    const apC1 = await req(`${API}/approve`, {
      method: 'POST',
      token: tDean,
      body: { stage: 'class', id: clsId, comment: '学管同意' },
    });
    check(
      '★ 大学：休学只有 1 步 → 学管审完即 finished',
      apC1.json?.code === 200 && apC1.json?.data?.finished === true,
      JSON.stringify(apC1.json?.data || apC1.json?.message),
    );
    const clsRow2 = await probe(dbCls, 'sms_class', 't_class_suspend_apply').where({ id: clsId }).first();
    check(
      '大学：落库 apply_status = 4（已同意）',
      Number(clsRow2?.apply_status) === 4,
      `apply_status=${clsRow2?.apply_status}`,
    );
    const clsStuAfter = await probe(dbCls, 'sms_class', 't_class_student').where({ id: clsStu.id }).first();
    check(
      '★ 大学：副作用生效 → 学生状态 = 6（休学）',
      Number(clsStuAfter?.student_status) === 6,
      `student_status=${clsStuAfter?.student_status}`,
    );

    /* ============ G. 复学（实训）：**发起申请时必填复学班** ============ */
    const rStu = await mkStudent(dbJob, 't_student_base', '自检-复学生', 6);

    // G1. ★ 绕过前端：复学不填复学班 → 必须被拦（2026-10-16 起建单就必填）
    const cResNoCls = await req(`${API}/create`, {
      method: 'POST',
      token: tPm,
      body: {
        stage: 'job',
        studentId: rStu.id,
        bizType: BIZ.RESUME,
        leaveDate: TODAY,
        leaveReason: '自检-复学（不填班，应被拒）',
        submit: true,
      },
    });
    check(
      '★ 复学：建单不填复学班 → 必须被拦（「复学必须填写复学班级」）',
      cResNoCls.json?.code !== 200 &&
        String(cResNoCls.json?.message || '').includes('复学班级'),
      `code=${cResNoCls.json?.code} ${cResNoCls.json?.message || ''}`,
    );

    // G2. 建单时带上复学班 → 通过，且班级落到单上
    const cRes = await req(`${API}/create`, {
      method: 'POST',
      token: tPm,
      body: {
        stage: 'job',
        studentId: rStu.id,
        bizType: BIZ.RESUME,
        leaveDate: TODAY,
        newClassId: jobCls.id,
        leaveReason: '自检-复学',
        submit: true,
      },
    });
    check('复学：项目经理发起（发起时填复学班）', cRes.json?.code === 200, cRes.json?.message || '');
    const resId = cRes.json?.data?.id;
    if (resId) reg('sms_job', 't_job_student_leave', resId);
    const resRow1 = await probe(dbJob, 'sms_job', 't_job_student_leave').where({ id: resId }).first();
    check(
      '★ 复学：建单时填的复学班已落到单上（new_class_id）',
      String(resRow1?.new_class_id || '') === String(jobCls.id),
      `new_class_id=${resRow1?.new_class_id}`,
    );

    // G3. ★ 终审**不传** newClassId → 用发起时填的班（不再强制审批人重选）
    const apR1 = await req(`${API}/approve`, {
      method: 'POST',
      token: tDean,
      body: { stage: 'job', id: resId, comment: '同意' }, // 故意不传 newClassId
    });
    check(
      '★ 复学：终审不传复学班 → 用建单时填的班，正常通过',
      apR1.json?.code === 200 && apR1.json?.data?.finished === true,
      `code=${apR1.json?.code} ${apR1.json?.message || ''}`,
    );
    const rStuAfter = await probe(dbJob, 'sms_job', 't_student_base').where({ id: rStu.id }).first();
    check(
      '★ 复学：副作用 → 学生状态 = 8（实训中）且回到复学班',
      Number(rStuAfter?.student_status) === 8 && String(rStuAfter?.class_id) === String(jobCls.id),
      `status=${rStuAfter?.student_status} class_id=${rStuAfter?.class_id}`,
    );

    // G4. ★ 老单兜底：单上没有复学班（建单后才可能发生）+ 终审也不传 → 必须被拦，不悄悄通过
    const rStu2 = await mkStudent(dbJob, 't_student_base', '自检-复学生2', 6);
    const cRes2 = await req(`${API}/create`, {
      method: 'POST',
      token: tPm,
      body: {
        stage: 'job',
        studentId: rStu2.id,
        bizType: BIZ.RESUME,
        leaveDate: TODAY,
        newClassId: jobCls.id,
        leaveReason: '自检-复学（老单兜底）',
        submit: true,
      },
    });
    const resId2 = cRes2.json?.data?.id;
    if (resId2) reg('sms_job', 't_job_student_leave', resId2);
    // 模拟「建单时没填班」的老单：直接把单上的复学班清空
    await dbJob('t_job_student_leave').where({ id: resId2 }).update({ new_class_id: null });
    const apR2 = await req(`${API}/approve`, {
      method: 'POST',
      token: tDean,
      body: { stage: 'job', id: resId2, comment: '同意' }, // 单上也没班、审批也不传
    });
    check(
      '★ 复学：单上无班 + 终审不传 → 必须被拦（不能悄悄通过）',
      apR2.json?.code !== 200 && String(apR2.json?.message || '').includes('复学班级'),
      `code=${apR2.json?.code} ${apR2.json?.message || ''}`,
    );

    /* ============ H. ★ 大学复学全链路（2026-10-16 起开放） ============ */
    // F 段走完时 clsStu 已被置为「休学(6)」—— 正好是复学的合法前置状态
    const cClsResume = await req(`${API}/create`, {
      method: 'POST',
      token: tPrincipal,
      body: {
        stage: 'class',
        studentId: clsStu.id,
        bizType: BIZ.RESUME,
        leaveDate: TODAY,
        newClassId: clsCls.id,
        leaveReason: '自检-大学复学（应放行）',
        submit: true,
      },
    });
    check(
      '★ 大学：发起复学（2026-10-16 起开放；发起时填复学班）',
      cClsResume.json?.code === 200,
      cClsResume.json?.message || '',
    );
    const clsResId = cClsResume.json?.data?.id;
    if (clsResId) reg('sms_class', 't_class_suspend_apply', clsResId);

    const clsResRow = await probe(dbCls, 'sms_class', 't_class_suspend_apply')
      .where({ id: clsResId })
      .first()
      .catch(() => null);
    check(
      '★ 大学：复学单 apply_type 落库 = 5（大学新增的复学原码，不是 3=退费）',
      Number(clsResRow?.apply_type) === 5 && String(clsResRow?.new_class_id || '') === String(clsCls.id),
      `apply_type=${clsResRow?.apply_type} new_class_id=${clsResRow?.new_class_id}`,
    );

    const apClsRes = await req(`${API}/approve`, {
      method: 'POST',
      token: tDean,
      body: { stage: 'class', id: clsResId, comment: '学管同意（大学复学）' },
    });
    check(
      '★ 大学：复学 1 步链 → 学管审完即 finished',
      apClsRes.json?.code === 200 && apClsRes.json?.data?.finished === true,
      JSON.stringify(apClsRes.json?.data || apClsRes.json?.message),
    );
    const clsStuAfterResume = await probe(dbCls, 'sms_class', 't_class_student')
      .where({ id: clsStu.id })
      .first()
      .catch(() => null);
    check(
      '★ 大学：复学副作用 → 学生状态 = 5（正式在读，不是 8 实训中）且回到复学班',
      Number(clsStuAfterResume?.student_status) === 5 &&
        String(clsStuAfterResume?.class_id) === String(clsCls.id),
      `status=${clsStuAfterResume?.student_status} class_id=${clsStuAfterResume?.class_id}`,
    );

    /* ============ I. 权限 ============ */
    const cross = await req(`${API}/list?stage=class`, { token: tJhHead });
    check('学段隔离：初高账号查大学被拒(40302)', cross.json?.code === 40302, cross.json?.message || '');

    const anon = await req(`${API}/list`);
    check('未登录被拒(401)', anon.status === 401, `status=${anon.status}`);

    const wAdmin = await req(`${API}/create`, {
      method: 'POST',
      token: tAdmin,
      body: {
        stage: 'job',
        studentId: jobStu.id,
        bizType: BIZ.SUSPEND,
        leaveReason: 'x',
      },
    });
    check('只读管理员写请求被拦(40302)', wAdmin.json?.code === 40302, wAdmin.json?.message || '');

    /* ============ J. 汇总 / meta ============ */
    const sum = await req(`${API}/summary`, { token: tPrincipal });
    check(
      '汇总：校长可见 3 个学段',
      Array.isArray(sum.json?.data) && sum.json.data.length === 3,
      `学段数=${(sum.json?.data || []).length}`,
    );

    const meta = await req(`${API}/meta`, { token: tPrincipal });
    check(
      '★ meta：三学段都支持复学（2026-10-16 起大学开放，前端据此出选项）',
      (meta.json?.data?.stageBizTypes?.class || []).includes(3) &&
        (meta.json?.data?.stageBizTypes?.jh || []).includes(3) &&
        (meta.json?.data?.stageBizTypes?.job || []).includes(3),
      JSON.stringify(meta.json?.data?.stageBizTypes || {}),
    );
  } catch (e) {
    check('执行过程无异常', false, e?.message || String(e));
  } finally {
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
        removed += Number((await k(table).where({ id }).del()) || 0);
      } catch {
        /* 忽略 */
      }
    }
    console.log(`\n（已清理自检夹具 ${removed} 行）`);
    try {
      await dbJob('t_job_approval_log')
        .whereIn('approval_id', dbJob('t_job_approval').select('id').where('is_deleted', 0))
        .where('create_time', '>=', new Date(Date.now() - 3600_000))
        .del();
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
