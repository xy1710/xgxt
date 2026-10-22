/**
 * 第 2 期「考试管理」端到端验证
 * ============================================================
 * 重点断言（三套考试结构的差异点）：
 *   ★ 内容项三套格式不同 → 统一成 contents 数组后必须往返一致
 *      初高：exam_content_types(JSON) + content_full_score(JSON)
 *      大学：子表 t_class_exam_content
 *      实训：content_types 逗号串（**没有满分**）
 *   ★ 实训多班（class_ids 逗号串） vs 初高/大学单班
 *   ★ 实训 exam_time 是 datetime → 接口必须返回 YYYY-MM-DD
 *   ★ 初高有审批状态（草稿），另两个恒为「已提交」
 */

import { randomUUID } from 'node:crypto';
import {
  BASE,
  conn,
  dumpBackendError,
  killAll,
  login,
  makeChecker,
  mirrorRow,
  req,
  probeFirst,
  USE_UNI,
  startServices,
} from './_e2e-lib.mjs';

const API = `${BASE}/api/teaching/exam`;
const { check, summary } = makeChecker();
const TAG = '【自检】';

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

/** 按表结构补全 NOT NULL 无默认 的列（避免硬编码各库差异） */
async function buildRow(db, table, provided) {
  const [cols] = await db.raw(
    `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
       AND IS_NULLABLE = 'NO' AND COLUMN_DEFAULT IS NULL
       AND EXTRA NOT LIKE '%auto_increment%'`,
    [table],
  );
  const row = { ...provided };
  const uniq = () => 'T' + Math.random().toString(36).slice(2, 8).toUpperCase();
  for (const c of cols) {
    if (row[c.name] !== undefined) continue;
    const isNum = /int|decimal|float|double/.test(c.type);
    if (c.name === 'id') row[c.name] = randomUUID();
    else if (isNum) row[c.name] = 0;
    else if (/date|time/.test(c.type)) row[c.name] = new Date();
    // ⚠️ 带唯一键的业务编码字段（如 class_code / student_no）必须给唯一值，
    //    否则多条夹具会撞唯一键（'Duplicate entry' for key 'uk_class_code'）
    else if (c.name.endsWith('_code') || c.name.endsWith('_no')) row[c.name] = uniq();
    else row[c.name] = '';
  }
  return row;
}

(async () => {
  /**
   * ★ 第 4 期步骤 1：夹具双写
   *   老表照写（喂未切读的仓储）+ 镜像写统一表（喂已切读的仓储）
   *   → 切读开关前后各跑一次，结果必须完全一致
   * ⚠️ 走 API 建的业务单据（考试/成绩/审批单）**不用镜像** ——
   *    那条路径本来就经过仓储，切读后仓储自己会写统一表。
   *    只有**直接 insert 老表**的夹具才需要手动镜像。
   */
  const mirror = async (dbName, table, row, stage) => {
    await mirrorRow(uniDb, dbName, table, row, stage, (_d, t, id) =>
      made.uni.push([t, id]),
    );
  };

  const jhDb = conn(process.env.DB_NAME_CLASS_JH || 'sms_class_jh');
  const classDb = conn(process.env.DB_NAME_CLASS || 'sms_class');
  const jobDb = conn(process.env.DB_NAME || 'sms_job');
  // ★ 第 4 期：统一表连接
  const uniDb = conn('sms_common');
  const made = { jhClasses: [], classClasses: [], jobClasses: [], exams: {}, uni: [] };

  try {
    console.log('== 启动服务 ==');
    const { backendReady, frontendReady } = await startServices();
    check('服务就绪（后端 8004 + 前端 5173）', backendReady && frontendReady);

    const tokenAdmin = await login('admin');
    const tokenJh = await login('sunmin'); // 初高班主任（只有 classjh:exam:view）
    /* ★ 数据范围按责任人过滤后，夹具班必须挂到登录人名下 */
    const decodeUid = (tk) => { try { return JSON.parse(Buffer.from(String(tk).split('.')[1], 'base64').toString()).userId || ''; } catch { return ''; } };
    const jhHeadId = decodeUid(tokenJh);
    // ★ 大学 / 实训的考试页只授权给「校长 + 管理员」，所以用 qiansy（校长）测写入；
    //   zhouj（就业老师，无考试页权限）专门用来验证「无权限被拦」。
    const tokenAll = await login('qiansy'); // 校长：三学段考试权限齐全
    const tokenNoPerm = await login('zhouj'); // 就业老师：无考试页权限
    check(
      '登录管理端 + 初高班主任 + 校长 + 无权限账号',
      !!tokenAdmin && !!tokenJh && !!tokenAll && !!tokenNoPerm,
    );

    const tokenClass = tokenAll;
    const tokenJob = tokenAll;

    /* ---------- 造夹具：三学段各造测试班（实训多造一个测多班） ---------- */
    const jhClassId = randomUUID();
    made.jhClasses.push(jhClassId);
    await jhDb('t_class_info').insert(
      await buildRow(jhDb, 't_class_info', {
        id: jhClassId,
        class_name: `${TAG}考试初高班`,
        stage: 201,
        /* ★ 数据范围按责任人过滤：夹具班必须挂到 sunmin 名下，否则她读不到详情 */
        head_teacher_id: jhHeadId || null,
        head_teacher_name: '自检班主任',
        teacher_name: '自检教员',
        is_deleted: 0,
      }),
    );
    // ★ 双写：t_uni_class（初高）
    await mirror('sms_class_jh', 't_class_info', await jhDb('t_class_info').where({ id: jhClassId }).first(), 'jh');

    const clsClassId = randomUUID();
    made.classClasses.push(clsClassId);
    await classDb('t_class_info').insert(
      await buildRow(classDb, 't_class_info', {
        id: clsClassId,
        class_name: `${TAG}考试大学班`,
        is_deleted: 0,
      }),
    );
    // ★ 双写：t_uni_class（大学）
    await mirror('sms_class', 't_class_info', await classDb('t_class_info').where({ id: clsClassId }).first(), 'class');

    const jobClass1 = randomUUID();
    const jobClass2 = randomUUID();
    made.jobClasses.push(jobClass1, jobClass2);
    for (const [id, name] of [
      [jobClass1, `${TAG}考试实训A班`],
      [jobClass2, `${TAG}考试实训B班`],
    ]) {
      await jobDb('t_job_class').insert(
        await buildRow(jobDb, 't_job_class', { id, class_name: name, is_deleted: 0 }),
      );
      // ★ 双写：t_uni_class（实训，2 个班）
      await mirror('sms_job', 't_job_class', await jobDb('t_job_class').where({ id }).first(), 'job');
    }
    console.log('  已造夹具：初高 1 班 / 大学 1 班 / 实训 2 班');

    /* ---------- A. 班级下拉 ---------- */
    const cls = await req(`${API}/classes`, { token: tokenAdmin });
    const clsList = cls.json?.data || [];
    check(
      'GET /classes 能取到三学段班级',
      cls.json?.code === 200 && clsList.some((c) => c.id === jhClassId) && clsList.some((c) => c.id === jobClass1),
      `共 ${clsList.length} 个班`,
    );

    /* ---------- B. 三学段列表 ---------- */
    for (const s of ['', 'jh', 'class', 'job']) {
      const r = await req(`${API}/list${s ? `?stage=${s}` : ''}`, { token: tokenAdmin });
      check(`GET /list${s ? `?stage=${s}` : '（全部）'} 返回 200`, r.json?.code === 200, `total=${r.json?.data?.total}`);
    }

    /* ---------- C. ★ 初高：内容项 JSON 往返 + 草稿状态 ---------- */
    const saveJh = await req(`${API}/save`, {
      method: 'POST',
      token: tokenJh,
      body: {
        stage: 'jh',
        examName: `${TAG}初高月考`,
        examType: 1,
        examDate: '1999-02-01',
        classIds: [jhClassId],
        contents: [
          { type: 1, name: '笔试', fullScore: 100 },
          { type: 3, name: '面试', fullScore: 50 },
        ],
      },
    });
    made.exams.jh = saveJh.json?.data?.id;
    if (saveJh.json?.code === 200) {
      const raw = await probeFirst(jhDb, 'sms_class_jh', 't_class_exam', { id: made.exams.jh }, 'jh');
      const rawTypes = JSON.parse(raw.exam_content_types || '[]');
      const rawFull = JSON.parse(raw.content_full_score || '{}');
      check(
        '★ 初高内容项落库格式（JSON 数组 + 满分对象）',
        JSON.stringify(rawTypes) === JSON.stringify([1, 3]) && String(rawFull['1']) === '100',
        `exam_content_types=${raw.exam_content_types} content_full_score=${raw.content_full_score}`,
      );
      const d = await req(`${API}/detail?stage=jh&id=${made.exams.jh}`, { token: tokenJh });
      const cs = d.json?.data?.contents || [];
      check(
        '★ 初高内容项读回（统一成 contents 数组，含满分）',
        cs.length === 2 && cs[0].type === 1 && cs[0].fullScore === 100 && cs[1].fullScore === 50,
        JSON.stringify(cs),
      );
      check('★ 初高状态默认为草稿', d.json?.data?.record?.status === 1, d.json?.data?.record?.statusName);
    } else {
      check('★ 初高内容项落库格式（JSON 数组 + 满分对象）', false, `save 被拒 ${saveJh.json?.message}`);
      check('★ 初高内容项读回（统一成 contents 数组，含满分）', false, '跳过');
      check('★ 初高状态默认为草稿', false, '跳过');
    }

    /* ---------- D. ★ 大学：内容项子表往返 ---------- */
    const saveCls = await req(`${API}/save`, {
      method: 'POST',
      token: tokenClass,
      body: {
        stage: 'class',
        examName: `${TAG}大学阶段考`,
        examType: 3,
        examDate: '1999-02-02',
        classIds: [clsClassId],
        contents: [{ type: 1, name: '笔试', fullScore: 120 }],
      },
    });
    made.exams.class = saveCls.json?.data?.id;
    if (saveCls.json?.code === 200) {
      // ★ 第4期步骤3：切读打开后写入落统一表，断言必须跟着切表查
      const CT_T = USE_UNI ? 't_uni_exam_content' : 't_class_exam_content';
      const CT_DB = USE_UNI ? uniDb : classDb;
      const raw = await CT_DB(CT_T).where({ exam_id: made.exams.class, is_deleted: 0 });
      check(
        '★ 大学内容项落到子表 t_class_exam_content',
        raw.length === 1 && Number(raw[0].full_score) === 120,
        `子表 ${raw.length} 行，full_score=${raw[0]?.full_score}`,
      );
      const d = await req(`${API}/detail?stage=class&id=${made.exams.class}`, { token: tokenClass });
      const cs = d.json?.data?.contents || [];
      check('★ 大学内容项读回统一结构', cs.length === 1 && cs[0].fullScore === 120, JSON.stringify(cs));
    } else {
      check('★ 大学内容项落到子表 t_class_exam_content', false, `save 被拒 ${saveCls.json?.message}`);
      check('★ 大学内容项读回统一结构', false, '跳过');
    }

    /* ---------- E. ★ 实训：多班 + datetime → 日期 + 无满分 ---------- */
    const saveJob = await req(`${API}/save`, {
      method: 'POST',
      token: tokenJob,
      body: {
        stage: 'job',
        examName: `${TAG}实训综合考试`,
        examType: 5,
        examDate: '1999-02-03',
        classIds: [jobClass1, jobClass2],
        contents: [{ type: 1, name: '笔试' }, { type: 2, name: '机试' }],
      },
    });
    made.exams.job = saveJob.json?.data?.id;
    if (saveJob.json?.code === 200) {
      const raw = await probeFirst(jobDb, 'sms_job', 't_job_exam', { id: made.exams.job }, 'job');
      check(
        '★ 实训多班落库（class_ids 逗号串）',
        String(raw.class_ids).split(',').length === 2,
        `class_ids=${raw.class_ids} 班名=${raw.class_names}`,
      );
      const d = await req(`${API}/detail?stage=job&id=${made.exams.job}`, { token: tokenJob });
      const rec = d.json?.data?.record;
      check(
        '★ 实训 datetime → 接口返回 YYYY-MM-DD',
        rec?.examDate === '1999-02-03',
        `examDate=${rec?.examDate}（库中 exam_time 是 datetime）`,
      );
      check('★ 实训多班读回 classIds 长度 2', (rec?.classIds || []).length === 2, JSON.stringify(rec?.classIds));
      check('★ 实训无满分概念', JSON.stringify(rec?.contentTypes) === '[1,2]', `contentTypes=${JSON.stringify(rec?.contentTypes)}`);
    } else {
      check('★ 实训多班落库（class_ids 逗号串）', false, `save 被拒 ${saveJob.json?.message}`);
      check('★ 实训 datetime → 接口返回 YYYY-MM-DD', false, '跳过');
      check('★ 实训多班读回 classIds 长度 2', false, '跳过');
      check('★ 实训无满分概念', false, '跳过');
    }

    /* ---------- F. 学段隔离 / 登录闸 ---------- */
    const cross = await req(`${API}/list?stage=class`, { token: tokenJh });
    check('学段隔离：初高账号查大学考试被拒(40302)', cross.json?.code === 40302, cross.json?.message || '');
    const noPerm = await req(`${API}/list`, { token: tokenNoPerm });
    check(
      '无考试页权限的账号（就业老师）整组被拦(40302)',
      noPerm.json?.code === 40302,
      noPerm.json?.message || '',
    );
    const anon = await req(`${API}/list`);
    check('未登录被拒(401/40101)', anon.status === 401 && anon.json?.code === 40101, `code=${anon.json?.code}`);
    const wAdmin = await req(`${API}/save`, {
      method: 'POST',
      token: tokenAdmin,
      body: { stage: 'jh', examName: 'x', examType: 1, examDate: '1999-01-01', classIds: [jhClassId] },
    });
    check('系统管理员写请求被拦(只读 40302)', wAdmin.json?.code === 40302, wAdmin.json?.message || '');
  } catch (e) {
    console.log('  ❌ 异常：' + (e?.stack || e));
    check('执行未抛异常', false);
    dumpBackendError();
  } finally {
    /* ---------- 清理 ---------- */
    try {
      const ids = Object.values(made.exams).filter(Boolean);
      if (ids.length) {
        await jhDb('t_class_exam').whereIn('id', ids).del();
        await classDb('t_class_exam').whereIn('id', ids).del();
        await classDb('t_class_exam_content').whereIn('exam_id', ids).del();
        // 第4期步骤3：切读模式下夹具落统一表，老库删不到 → 补删
        await uniDb('t_uni_exam').whereIn('id', ids).del();
        await uniDb('t_uni_exam_content').whereIn('exam_id', ids).del();
        await jobDb('t_job_exam').whereIn('id', ids).del();
        // ★ 第4期步骤2：切读时考试单本体落在统一表（内容项子表 t_class_exam_content 未归一，仍在老库）
        if (USE_UNI) await uniDb('t_uni_exam').whereIn('id', ids).del();
      }
      if (made.jhClasses.length) await jhDb('t_class_info').whereIn('id', made.jhClasses).del();
      if (made.classClasses.length) await classDb('t_class_info').whereIn('id', made.classClasses).del();
      if (made.jobClasses.length) await jobDb('t_job_class').whereIn('id', made.jobClasses).del();
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
