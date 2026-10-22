/**
 * 第 2 期「成绩管理」端到端验证
 * ============================================================
 * ★ 重点断言：三套公式**各自算对**
 *   初高：综合 = 笔试+机试+面试+其他（求和），再按 总分 ≥ 满分×0.6 判定通过
 *   大学：综合 = 笔试×50% + 面试×50%（缺项按 0 计），不判通过
 *   实训：笔试均分 = 卷面×50% + 机试×50%；综合 = 笔试均分×50% + 面试×50%
 */

import { randomUUID } from 'node:crypto';
import {
  BASE,
  buildRow,
  conn,
  dumpBackendError,
  killAll,
  login,
  makeChecker,
  mirrorRow,
  req,
  startServices,
  USE_UNI,
} from './_e2e-lib.mjs';

/** 把 [table,id][] 聚成 {table: [ids]}，便于一次 whereIn 删干净 */
function groupByTable(pairs) {
  const m = new Map();
  for (const [t, id] of pairs) {
    if (!t || !id) continue;
    if (!m.has(t)) m.set(t, []);
    m.get(t).push(id);
  }
  return m;
}

const EXAM_API = `${BASE}/api/teaching/exam`;
const SCORE_API = `${BASE}/api/teaching/score`;
const { check, summary } = makeChecker();
const TAG = '【自检】';

(async () => {
  const jhDb = conn(process.env.DB_NAME_CLASS_JH || 'sms_class_jh');
  const classDb = conn(process.env.DB_NAME_CLASS || 'sms_class');
  const jobDb = conn(process.env.DB_NAME || 'sms_job');
  // ★ 第 4 期步骤 1：统一表连接
  const uniDb = conn('sms_common');
  // ★ P6 适配：断言/清理按开关分流（开关开时产品写 t_uni_exam_score）
  const scoreT = (stage) =>
    USE_UNI
      ? uniDb('t_uni_exam_score')
      : stage === 'class'
        ? classDb('t_class_grade')
        : stage === 'jh'
          ? jhDb('t_class_exam_score')
          : jobDb('t_job_exam_score');
  const made = { jhClass: null, classCls: null, jobClass: null, students: [], exams: [], scores: [], uni: [] };

  /**
   * ★ 第 4 期步骤 1：夹具双写
   *   老表照写 + 镜像写统一表 → 切读开关前后跑同一套断言，结果必须一致。
   * ⚠️ 走 API 建的考试/成绩单**不镜像**（那条路经过仓储，切读后自己会写统一表）。
   * ⚠️ 成绩链 4 张表（exam_content/exam_score/job_exam_score/grade）
   *    本轮不在 UNI_MAP 内 —— 它们属于第 4 期步骤 3「成绩链归一」。
   */
  const mirror = async (dbName, table, row, stage) => {
    await mirrorRow(uniDb, dbName, table, row, stage, (_d, t, id) =>
      made.uni.push([t, id]),
    );
  };

  try {
    const { backendReady, frontendReady } = await startServices();
    check('服务就绪（后端 8004 + 前端 5173）', backendReady && frontendReady);

    const tokenJh = await login('sunmin'); // 初高：有 classjh:score:view
    /* ★ 数据范围按责任人过滤后，夹具班必须挂到登录人名下 */
    const decodeUid = (tk) => { try { return JSON.parse(Buffer.from(String(tk).split('.')[1], 'base64').toString()).userId || ''; } catch { return ''; } };
    const jhHeadId = decodeUid(tokenJh);
    // ★ 大学/实训的成绩页只授权给校长+管理员 → 用 qiansy(校长)
    const tokenAll = await login('qiansy');
    const tokenAdmin = await login('admin');
    const tokenNoPerm = await login('zhouj'); // 就业老师：无成绩页权限
    check('登录（初高班主任 / 校长 / 管理员 / 无权限账号）', !!tokenJh && !!tokenAll && !!tokenAdmin && !!tokenNoPerm);

    /* ---------- A. 公式接口：三套确实不同 ---------- */
    const f = await req(`${SCORE_API}/formula`, { token: tokenAdmin });
    const fm = f.json?.data;
    const jhTotal = JSON.stringify(fm?.jh?.total?.parts);
    const clsTotal = JSON.stringify(fm?.class?.total?.parts);
    const jobTotal = JSON.stringify(fm?.job?.total?.parts);
    check(
      '公式接口返回三套**不同**的公式',
      f.json?.code === 200 && jhTotal !== clsTotal && clsTotal !== jobTotal,
      `初高${jhTotal} / 大学${clsTotal} / 实训${jobTotal}`,
    );
    check(
      '只有实训配了「笔试均分」',
      !!fm?.job?.writtenAvg && !fm?.jh?.writtenAvg && !fm?.class?.writtenAvg,
      `job.writtenAvg=${JSON.stringify(fm?.job?.writtenAvg?.parts)}`,
    );
    check('只有初高按满分比例判定通过', fm?.jh?.passByRatio === true && fm?.class?.passByRatio !== true, `passRatio=${fm?.jh?.passRatio}`);

    /* ---------- B. 造夹具 ---------- */
    // 初高：1 班 2 学生
    const jhClassId = randomUUID();
    made.jhClass = jhClassId;
    await jhDb('t_class_info').insert(
      await buildRow(jhDb, 't_class_info', {
        id: jhClassId,
        class_name: `${TAG}成绩初高班`,
        stage: 201,
        /* ★ 数据范围按责任人过滤：夹具班必须挂到 sunmin 名下，否则她看不到/不能录 */
        head_teacher_id: jhHeadId || null,
        head_teacher_name: '自检班主任',
        teacher_name: '自检教员',
        is_deleted: 0,
      }),
    );
    // ★ 双写 t_uni_class（初高）
    await mirror('sms_class_jh', 't_class_info', await jhDb('t_class_info').where({ id: jhClassId }).first(), 'jh');
    const jhStu = [];
    for (let i = 1; i <= 2; i++) {
      const id = randomUUID();
      jhStu.push(id);
      made.students.push({ db: jhDb, table: 't_class_student', id });
      await jhDb('t_class_student').insert(
        await buildRow(jhDb, 't_class_student', {
          id,
          class_id: jhClassId,
          class_name: `${TAG}成绩初高班`,
          student_no: `SE-A-${i}`,
          student_name: `${TAG}初高生${i}`,
          gender: 1,
          student_status: 3,
          is_deleted: 0,
        }),
      );
      // ★ 双写 t_uni_student（初高）
      await mirror('sms_class_jh', 't_class_student', await jhDb('t_class_student').where({ id }).first(), 'jh');
    }

    // 大学：1 班 1 学生
    const clsClassId = randomUUID();
    made.classCls = clsClassId;
    await classDb('t_class_info').insert(
      await buildRow(classDb, 't_class_info', { id: clsClassId, class_name: `${TAG}成绩大学班`, is_deleted: 0 }),
    );
    // ★ 双写 t_uni_class（大学）
    await mirror('sms_class', 't_class_info', await classDb('t_class_info').where({ id: clsClassId }).first(), 'class');
    const clsStu = randomUUID();
    made.students.push({ db: classDb, table: 't_class_student', id: clsStu });
    await classDb('t_class_student').insert(
      await buildRow(classDb, 't_class_student', {
        id: clsStu,
        class_id: clsClassId,
        class_name: `${TAG}成绩大学班`,
        student_no: 'SE-B-1',
        student_name: `${TAG}大学生1`,
        gender: 1,
        student_status: 3,
        is_deleted: 0,
      }),
    );
    // ★ 双写 t_uni_student（大学）
    await mirror('sms_class', 't_class_student', await classDb('t_class_student').where({ id: clsStu }).first(), 'class');

    // 实训：1 班 1 学生（花名册 t_job_class_student + t_student_base）
    const jobClassId = randomUUID();
    made.jobClass = jobClassId;
    await jobDb('t_job_class').insert(
      await buildRow(jobDb, 't_job_class', { id: jobClassId, class_name: `${TAG}成绩实训班`, is_deleted: 0 }),
    );
    // ★ 双写 t_uni_class（实训）
    await mirror('sms_job', 't_job_class', await jobDb('t_job_class').where({ id: jobClassId }).first(), 'job');
    const jobStuBase = randomUUID();
    const jobStu = randomUUID();
    made.students.push({ db: jobDb, table: 't_student_base', id: jobStuBase });
    made.students.push({ db: jobDb, table: 't_job_class_student', id: jobStu });
    await jobDb('t_student_base').insert(
      await buildRow(jobDb, 't_student_base', {
        id: jobStuBase,
        student_no: 'SE-C-1',
        student_name: `${TAG}实训生1`,
        gender: 1,
        student_status: 8,
        is_deleted: 0,
      }),
    );
    // ★ 双写 t_uni_student（实训，t_student_base → t_uni_student）
    await mirror('sms_job', 't_student_base', await jobDb('t_student_base').where({ id: jobStuBase }).first(), 'job');
    await jobDb('t_job_class_student').insert(
      await buildRow(jobDb, 't_job_class_student', {
        id: jobStu,
        class_id: jobClassId,
        class_name: `${TAG}成绩实训班`,
        student_id: jobStuBase,
        student_no: 'SE-C-1',
        student_name: `${TAG}实训生1`,
        status: 1,
        is_deleted: 0,
      }),
    );
    // ★ 双写 t_uni_class_student（实训花名册）
    await mirror('sms_job', 't_job_class_student', await jobDb('t_job_class_student').where({ id: jobStu }).first(), 'job');
    console.log('  已造夹具：初高 2 人 / 大学 1 人 / 实训 1 人（含统一表镜像）');

    /* ---------- C. 建考试（走统一考试接口） ---------- */
    const mkExam = async (stage, token, classId, name, contents) => {
      const r = await req(`${EXAM_API}/save`, {
        method: 'POST',
        token,
        body: { stage, examName: name, examType: 1, examDate: '1999-03-01', classIds: [classId], contents },
      });
      if (r.json?.code !== 200) throw new Error(`建考试失败(${stage})：${r.json?.message}`);
      made.exams.push({ stage, id: r.json.data.id });
      return r.json.data.id;
    };
    const jhExam = await mkExam('jh', tokenJh, jhClassId, `${TAG}初高成绩考`, [
      { type: 1, name: '笔试', fullScore: 100 },
      { type: 2, name: '机试', fullScore: 100 },
      { type: 3, name: '面试', fullScore: 100 },
      { type: 4, name: '其他', fullScore: 100 },
    ]);
    const clsExam = await mkExam('class', tokenAll, clsClassId, `${TAG}大学成绩考`, [
      { type: 1, name: '笔试', fullScore: 100 },
      { type: 3, name: '面试', fullScore: 100 },
    ]);
    const jobExam = await mkExam('job', tokenAll, jobClassId, `${TAG}实训成绩考`, [
      { type: 1, name: '笔试' },
      { type: 2, name: '机试' },
      { type: 3, name: '面试' },
    ]);
    check('三学段考试创建成功', !!jhExam && !!clsExam && !!jobExam);

    /* ---------- D. ★ 初高：求和 + 按满分比例判定 ---------- */
    // 满分合计 = 400；及格线 0.6 → 240
    // 学生1：80+90+70+60 = 300 ≥ 240 → 通过
    // 学生2：10+10+10+10 = 40  < 240 → 未通过
    const rJh = await req(`${SCORE_API}/save`, {
      method: 'POST',
      token: tokenJh,
      body: {
        stage: 'jh',
        examId: jhExam,
        rows: [
          { studentId: jhStu[0], writtenScore: 80, machineScore: 90, interviewScore: 70, otherScore: 60 },
          { studentId: jhStu[1], writtenScore: 10, machineScore: 10, interviewScore: 10, otherScore: 10 },
        ],
      },
    });
    check('初高成绩保存成功', rJh.json?.code === 200, rJh.json?.message || '');
    const jhRows = (await scoreT('jh').where({ exam_id: jhExam, is_deleted: 0 }).orderBy('student_no'));
    check(
      '★ 初高公式：四项求和',
      jhRows.length === 2 && Number(jhRows[0]?.score_total) === 300 && Number(jhRows[1]?.score_total) === 40,
      `落库 score_total = [${jhRows.map((r) => r.score_total)}]（应 [300,40]）`,
    );
    check(
      '★ 初高判定：≥ 满分×0.6 通过',
      Number(jhRows[0]?.exam_result) === 1 && Number(jhRows[1]?.exam_result) === 2,
      `exam_result = [${jhRows.map((r) => r.exam_result)}]（应 [1通过,2未通过]）`,
    );

    /* ---------- E. ★ 大学：笔试×50% + 面试×50%，缺项按 0 ---------- */
    const rCls = await req(`${SCORE_API}/save`, {
      method: 'POST',
      token: tokenAll,
      body: { stage: 'class', examId: clsExam, rows: [{ studentId: clsStu, writtenScore: 80, interviewScore: 60, examResult: 1 }] },
    });
    check('大学成绩保存成功', rCls.json?.code === 200, rCls.json?.message || '');
    const clsRows = (await scoreT('class').where({ exam_id: clsExam, is_deleted: 0 }));
    check(
      '★ 大学公式：笔试×0.5 + 面试×0.5（机试缺失按 0）',
      clsRows.length === 1 && Number(clsRows[0]?.comp_score) === 70,
      `落库 comp_score = ${clsRows[0]?.comp_score}（应 70）`,
    );
    check('★ 大学「考试结果」尊重老师手选', Number(clsRows[0]?.exam_result) === 1, `exam_result=${clsRows[0]?.exam_result}（传 1）`);
    // 再手选「未通过」，确认确实按入参走（不是后端写死）
    await req(`${SCORE_API}/save`, {
      method: 'POST',
      token: tokenAll,
      body: { stage: 'class', examId: clsExam, rows: [{ studentId: clsStu, writtenScore: 80, interviewScore: 60, examResult: 2 }] },
    });
    const clsRows2 = (await scoreT('class').where({ exam_id: clsExam, is_deleted: 0 }));
    check('★ 大学手选「未通过」也生效', Number(clsRows2[0]?.exam_result) === 2, `exam_result=${clsRows2[0]?.exam_result}（传 2）`);

    /* ---------- F. ★ 实训：两次加权 + 笔试均分 ---------- */
    const rJob = await req(`${SCORE_API}/save`, {
      method: 'POST',
      token: tokenAll,
      body: { stage: 'job', examId: jobExam, rows: [{ studentId: jobStuBase, writtenScore: 80, machineScore: 90, interviewScore: 70 }] },
    });
    check('实训成绩保存成功', rJob.json?.code === 200, rJob.json?.message || '');
    const jobRows = (await scoreT('job').where({ exam_id: jobExam, is_deleted: 0 }));
    check(
      '★ 实训笔试均分：卷面×0.5 + 机试×0.5',
      jobRows.length === 1 && Number(jobRows[0]?.written_avg) === 85,
      `落库 written_avg = ${jobRows[0]?.written_avg}（应 85）`,
    );
    check(
      '★ 实训综合：笔试均分×0.5 + 面试×0.5',
      Number(jobRows[0]?.total_score) === 77.5,
      `落库 total_score = ${jobRows[0]?.total_score}（应 77.5）`,
    );

    /* ---------- G. 列表 / 录入表 / 汇总 ---------- */
    for (const s of ['', 'jh', 'class', 'job']) {
      const r = await req(`${SCORE_API}/list${s ? `?stage=${s}` : ''}`, { token: tokenAdmin });
      check(`GET /list${s ? `?stage=${s}` : '（全部）'} 返回 200`, r.json?.code === 200, `total=${r.json?.data?.total}`);
    }
    const ent = await req(`${SCORE_API}/entry?stage=jh&examId=${jhExam}&classId=${jhClassId}`, { token: tokenJh });
    check(
      'GET /entry 返回全班名单 + 已录分数',
      ent.json?.code === 200 && ent.json?.data?.rows?.length === 2 && !!ent.json?.data?.rows?.[0]?.scoreId,
      `rows=${ent.json?.data?.rows?.length} fullTotal=${ent.json?.data?.fullTotal}`,
    );
    const sum = await req(`${SCORE_API}/summary`, { token: tokenAdmin });
    check('GET /summary 返回 200', sum.json?.code === 200, (sum.json?.data || []).map((x) => `${x.stageName} 均${x.avgTotal}`).join(' / '));

    /* ---------- H. 权限闸 ---------- */
    const cross = await req(`${SCORE_API}/list?stage=class`, { token: tokenJh });
    check('学段隔离：初高账号查大学成绩被拒(40302)', cross.json?.code === 40302, cross.json?.message || '');
    const noPerm = await req(`${SCORE_API}/list`, { token: tokenNoPerm });
    check('无成绩页权限账号整组被拦(40302)', noPerm.json?.code === 40302, noPerm.json?.message || '');
    const anon = await req(`${SCORE_API}/list`);
    check('未登录被拒(401/40101)', anon.status === 401 && anon.json?.code === 40101);
    const wAdmin = await req(`${SCORE_API}/save`, {
      method: 'POST',
      token: tokenAdmin,
      body: { stage: 'jh', examId: jhExam, rows: [{ studentId: jhStu[0], writtenScore: 1 }] },
    });
    check('系统管理员写请求被拦(只读 40302)', wAdmin.json?.code === 40302, wAdmin.json?.message || '');
  } catch (e) {
    console.log('  ❌ 异常：' + (e?.stack || e));
    check('执行未抛异常', false);
    dumpBackendError();
  } finally {
    try {
      for (const e of made.exams) {
        const db = e.stage === 'jh' ? jhDb : e.stage === 'class' ? classDb : jobDb;
        await db(e.stage === 'class' ? 't_class_grade' : e.stage === 'jh' ? 't_class_exam_score' : 't_job_exam_score')
          .where({ exam_id: e.id })
          .del();
      }
      const ids = made.exams.map((e) => e.id);
      if (ids.length) {
        await jhDb('t_class_exam').whereIn('id', ids).del();
        await classDb('t_class_exam_content').whereIn('exam_id', ids).del();
        await classDb('t_class_exam').whereIn('id', ids).del();
        await jobDb('t_job_exam').whereIn('id', ids).del();
      }
      for (const s of made.students) await s.db(s.table).where({ id: s.id }).del();
      if (made.jhClass) await jhDb('t_class_info').where({ id: made.jhClass }).del();
      if (made.classCls) await classDb('t_class_info').where({ id: made.classCls }).del();
      if (made.jobClass) await jobDb('t_job_class').where({ id: made.jobClass }).del();
      // ★ 第 4 期：清理统一表镜像行
      for (const [t, ids] of groupByTable(made.uni)) {
        await uniDb(t).whereIn('id', ids).del();
      }
      console.log(`  🧹 已删除本次全部自检夹具（含统一表镜像 ${made.uni.length} 条）`);
    } catch (e) {
      console.log('  清理失败：' + e.message);
    }
    await Promise.allSettled([jhDb.destroy(), classDb.destroy(), jobDb.destroy(), uniDb.destroy()]);
    killAll();
    summary();
    console.log('DONE');
    process.exit(0);
  }
})();
