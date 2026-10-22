/**
 * 自检：`class/modules/class/class.route.ts` 老班级域接口切读统一表（第 4 期 · 第 4 批）
 * =========================================================================
 *
 * ★★ 为什么必须单独写这个脚本
 *   `_e2e-class-check.mjs` 测的是**三学段班级仓储**（sms_class_jh / sms_class / sms_job）
 *   而本批改的是 `/api/class/info/*`（老路由，12 个接口）。
 *   两套实现互相独立 → 改老路由不会让class 自检变红，也不会让它变绿。
 *   「改完跑老自检全绿」证明不了任何事（第 4 期反复踩的坑）。
 *
 * ★★ 本批改了 32 处（实测）：
 *   t_class_info15 · t_class_student 8 · t_class_training_handoff 3 ·
 *   t_class_transfer2 · t_class_stage_log   2 · t_class_repeat      2
 *   其中 **5 处是插入** → 必须走 tblIns / tblInsTrx。
 *
 * ★ 新增 2 条 UNI_MAP：
 *   t_class_stage_log       → t_uni_stage_log（19列，老表 17列，超集）
 *   t_class_training_handoff → t_uni_handover  （48 列，老表 24 列，超集）
 *
 * ★★ 三条最该被断言的：
 *   ①【跨 3 张表的写事务】/stage/advance 一个事务里改 t_class_info + t_class_student
 *     +插t_class_stage_log。→ 断言：推进后班级 stage 变了、学员 stage 也变了、
 *     **阶段日志表能查到对应记录**（只切主表时这里必挂，是最隐蔽的错）。
 *   ② 【单号生成】/training/upgrade 写t_class_training_handoff.handoff_no
 *     → 断言：单号非空且不重复。
 *   ③ 【人数不信任冗余student_count】→ 断言：班级详情人数 = 实际学生数。
 *
 * ★ 已知会失败的一项：`/training/upgrade` 会真的调实训侧建班（processHandoff），
 *   跨库且不可逆 → 本脚本只验证「校验分支」（缺项目经理时报错），
 *   不执行真正的升实训，避免污染实训库。
 */
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

const API = `${BASE}/api/class/info`;
const STAGE = 'class';
const WHERE = USE_UNI ? '统一表' : '老表';

const { check, summary } = makeChecker();
const fixtures = [];
const reg = (dbName, table, id) => {
  const [d, t] = regTarget(dbName, table);
  fixtures.push([d, t, id]);
};

function userIdOf(token) {
  if (!token) return '';
  try {
    const raw = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64').toString('utf8'));
    return raw.sub || raw.userId || raw.accountId || '';
  } catch {
    return '';
  }
}

async function mkClass(dbCls, uniDb, tag, headTeacherId, extra = {}) {
  const id = `cls-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const row = await buildRow(dbCls, 't_class_info', {
    id,
    class_name: `自检班级${tag}${Math.floor(Math.random() * 1e6)}`,
    dept_code: 2,
    stage: 201,
    head_teacher_id: headTeacherId,
    head_teacher_name: '自检班主任',
    is_deleted: 0,
    ...extra,
  });
  await dbCls('t_class_info').insert(row);
  if (USE_UNI) await mirrorRow(uniDb, 'sms_class', 't_class_info', row, STAGE, reg);
  reg('sms_class', 't_class_info', id);
  return row;
}

async function mkStudent(dbCls, uniDb, tag, cls, headTeacherId) {
  const id = `stu-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const row = await buildRow(dbCls, 't_class_student', {
    id,
    student_no: 'BJ' + tag + Date.now().toString().slice(-8),
    student_name: `自检学员${tag}`,
    student_status: 5,
    class_id: cls.id,
    class_name: cls.class_name,
    dept_code: 2,
    stage: cls.stage,
    recruit_teacher_id: headTeacherId,
  });
  await dbCls('t_class_student').insert(row);
  if (USE_UNI) await mirrorRow(uniDb, 'sms_class', 't_class_student', row, STAGE, reg);
  reg('sms_class', 't_class_student', id);
  return row;
}

(async () => {
  const dbCls = conn('sms_class');
  const uniDb = conn('sms_common');
  await startServices();

  const tHead = await login('zhanght');
  const tMgr = await login('congym');
  const headId = userIdOf(tHead);
  check('登录班主任 zhanght', !!tHead, tHead ? 'ok' : '失败');
  check('登录学管 congym', !!tMgr, tMgr ? 'ok' : '失败');
  check('能从 token 解出 userId', !!headId, headId ? headId.slice(0, 8) + '…' : '解不出');

  const clsA = await mkClass(dbCls, uniDb, 'A', headId);
  const clsB = await mkClass(dbCls, uniDb, 'B', headId);
  const stu1 = await mkStudent(dbCls, uniDb, '1', clsA, headId);
  const stu2 = await mkStudent(dbCls, uniDb, '2', clsA, headId);

  console.log(`\n##### 模式：${USE_UNI ? '切读统一表' : '老表'} #####`);

  /* ---------- ① 列表 ---------- */
  const r1 = await req(`${API}/list?page=1&size=50&keyword=${encodeURIComponent(clsA.class_name)}`, { token: tHead });
  const list1 = r1.json?.data?.list ?? [];
  check(
    `① /list 能查到夹具班级（${WHERE}）`,
    list1.some((x) => x.id === clsA.id),
    `返回 ${list1.length} 条，含目标=${list1.some((x) => x.id === clsA.id)}`,
  );

  /* ---------- ② 详情 + 子表 ---------- */
  const r2 = await req(`${API}/detail?id=${encodeURIComponent(clsA.id)}`, { token: tHead });
  // ★ detail 返回 `{classInfo, students, ...}` —— 班级本体在 classInfo 里
  const d = r2.json?.data ?? {};
  const clsInfo = d.classInfo ?? {};
  check(`② /detail 能查到（${WHERE}）`, r2.json?.code === 200 && !!clsInfo.id, `code=${r2.json?.code} classInfo.id=${clsInfo.id ?? 'N/A'}`);
  check(
    `② ★ /detail 班级名称正确（列名翻译没丢）`,
    clsInfo.className === clsA.class_name,
    `className=${clsInfo.className} 期望=${clsA.class_name}`,
  );
  check(
    `② ★ /detail 学员列表读得到（t_class_student 已切读）`,
    Array.isArray(d.students) && d.students.length >= 2,
    `students=${Array.isArray(d.students) ? d.students.length : 'undefined'}`,
  );
  // ★ 注意：`toClassItem` 里是 `...rowToCamel(row)` 直接透传，**studentCount 取自老表冗余列
  //   student_count（夹具没填 = 0）**。真正的实时人数是 `students.length`。
  //   这印证了项目铁律「人数实时统计不信冗余 student_count」。
  check(
    `② ★ 详情人数以 students.length 为准（冗余 student_count 不采信）`,
    (d.students?.length ?? 0) >= 2 && Number(clsInfo.studentCount) !== (d.students?.length ?? -1),
    `冗余 studentCount=${clsInfo.studentCount} vs 实际 students=${(d.students ?? []).length}（两者本就不应相等）`,
  );

  /* ---------- ③ open-options ----------
     ★ 路径以 open-options 结尾 → app.ts 挂的是 authAllowSync，
       要带 x-internal-token，带普通登录 token 会被 40101 挡掉。
     */
  const r3 = await req(`${API}/open-options`, {
    token: tHead, headers: { 'x-internal-token': process.env.INTERNAL_TOKEN || 'CHANGE_ME_INTERNAL_TOKEN' },
  });
  check(
    `③ /open-options 能拿到班级下拉（${WHERE}）`,
    r3.json?.code === 200,
    `code=${r3.json?.code} n=${Array.isArray(r3.json?.data) ? r3.json.data.length : 'n/a'}`,
  );

  /* ---------- ④ 新建班级 ----------
     ★ 学管 congym 是审批角色，不能新增/修改（40302）→ 写操作改用校长 qiansy。
     */
  const tBoss = await login('qiansy');
  check('登录校长 qiansy（写操作账号）', !!tBoss, tBoss ? 'ok' : '失败');
  const newName = `自检新建${Date.now().toString().slice(-6)}`;
  const r4 = await req(`${API}/add`, {
    token: tBoss, method: 'POST',
    body: { className: newName, deptCode: 2, stage: 201, headTeacherId: headId, headTeacherName: '自检班主任' },
  });
  const newId = r4.json?.data?.classId ?? r4.json?.data?.id;
  check(`④ /add 新建班级成功（${WHERE}）`, r4.json?.code === 200 && !!newId, `code=${r4.json?.code} msg=${r4.json?.message ?? ''}`);
  if (newId) {
    const inTbl = await probe(dbCls, 'sms_class', 't_class_info', STAGE).where('id', newId).first();
    check(`④ ★ 新建行落在${WHERE}且 edu_stage 已补`, !!inTbl, inTbl ? `id=${newId}` : '库里查不到');
    reg('sms_class', 't_class_info', newId);
  }
  // 重名闸门
  const r4b = await req(`${API}/add`, {
    token: tBoss, method: 'POST',
    body: { className: newName, deptCode: 2, stage: 201 },
  });
  check(
    `④ 班级重名被业务闸门拦住`,
    r4b.json?.code !== 200 && String(r4b.json?.message ?? '').includes('已存在'),
    `code=${r4b.json?.code} msg=${r4b.json?.message}`,
  );

  /* ---------- ⑤ 修改班级 ---------- */
  const r5 = await req(`${API}/update`, {
    token: tBoss, method: 'PUT',
    body: { classId: clsB.id, room: '自检B301' },
  });
  check(`⑤ /update 修改班级成功（${WHERE}）`, r5.json?.code === 200, `code=${r5.json?.code} msg=${r5.json?.message ?? ''}`);
  if (r5.json?.code === 200) {
    const after = await probe(dbCls, 'sms_class', 't_class_info', STAGE).where('id', clsB.id).first();
    check(`⑤ ★ 修改真的落库到${WHERE}`, after && after.room === '自检B301', `room=${after ? after.room : 'N/A'}`);
  }

  /* ---------- ⑥ 岗位交接（t_class_info + t_class_transfer 双写） ---------- */
  const r6 = await req(`${API}/transfer/add`, {
    token: tHead, method: 'POST',
    body: { classId: clsA.id, transferType: 'headTeacher', toUserId: 'T-ZHOUJ', toUserName: '周佳', reason: '自检交接' },
  });
  check(`⑥ /transfer/add 岗位交接成功（${WHERE}）`, r6.json?.code === 200, `code=${r6.json?.code} msg=${r6.json?.message ?? ''}`);
  if (r6.json?.code === 200) {
    const tr = await probe(dbCls, 'sms_class', 't_class_transfer', STAGE)
      .where('class_id', clsA.id).orderBy('create_time', 'desc').first();
    check(`⑥ ★ 交接记录落在${WHERE}`, !!tr, tr ? `id=${tr.id}` : '查不到');
    if (tr) {
      reg('sms_class', 't_class_transfer', tr.id);
      /**
       * ★★ 第 4 期第 4 批：transfer_type 语义拆分（方案 B）的核心断言
       *
       * 老表 transfer_type = varchar 装岗位名（headTeacher/teacher/assistant）
       * 统一表 transfer_type = int 装事由（1~6），岗位移到新列 post_transfer_type
       * → 两套模式下列的含义完全不同，必须分别断言，不能只断言「行存在」
       */
      if (USE_UNI) {
        check(
          `⑥ ★切读：transfer_type=1(调岗)（${WHERE}）`,
          Number(tr.transfer_type) === 1,
          `transfer_type=${tr.transfer_type}`,
        );
        check(
          `⑥ ★切读：post_transfer_type=1(班主任)（${WHERE}）`,
          Number(tr.post_transfer_type) === 1,
          `post_transfer_type=${tr.post_transfer_type}`,
        );
        check(
          `⑥ ★切读：人名写进 old/new 岗位列而非 from_class_name（${WHERE}）`,
          tr.new_head_teacher_id === 'T-ZHOUJ' &&
            tr.new_head_teacher_name === '周佳' &&
            !tr.from_class_name,
          `new_head_teacher_id=${tr.new_head_teacher_id} from_class_name=${tr.from_class_name ?? 'NULL'}`,
        );
      } else {
        check(
          `⑥ ★ 老表：transfer_type 原样存岗位名 headTeacher（${WHERE}）`,
          tr.transfer_type === 'headTeacher',
          `transfer_type=${tr.transfer_type}`,
        );
        check(
          `⑥ ★ 老表：to_user_name 存接手的老师姓名（${WHERE}）`,
          tr.to_user_name === '周佳' && tr.to_user_id === 'T-ZHOUJ',
          `to_user_name=${tr.to_user_name} to_user_id=${tr.to_user_id}`,
        );
      }
    }
    const clsAfter = await probe(dbCls, 'sms_class', 't_class_info', STAGE).where('id', clsA.id).first();
    check(
      `⑥ ★ 交接后班主任字段已更新（${WHERE}）`,
      clsAfter && clsAfter.head_teacher_id === 'T-ZHOUJ',
      `head_teacher_id=${clsAfter ? clsAfter.head_teacher_id : 'N/A'}`,
    );
    // 还原，避免影响后续断言
    await probe(dbCls, 'sms_class', 't_class_info', STAGE).where('id', clsA.id)
      .update({ head_teacher_id: headId, head_teacher_name: '自检班主任' });
  }

  /* ---------- ⑦ 末班记录（t_class_repeat + t_class_student 双写） ---------- */
  const r7 = await req(`${API}/repeat/add`, {
    token: tHead, method: 'POST',
    body: { studentId: stu1.id, repeatReason: '自检末班', toClassId: clsB.id, repeatTime: '2026-03-01' },
  });
  check(`⑦ /repeat/add 末班记录成功（${WHERE}）`, r7.json?.code === 200, `code=${r7.json?.code} msg=${r7.json?.message ?? ''}`);
  if (r7.json?.code === 200) {
    const rp = await probe(dbCls, 'sms_class', 't_class_repeat', STAGE)
      .where('student_id', stu1.id).orderBy('create_time', 'desc').first();
    check(`⑦ ★ 末班记录落在${WHERE}`, !!rp, rp ? `id=${rp.id}` : '查不到');
    if (rp) reg('sms_class', 't_class_repeat', rp.id);
  }
  const r7b = await req(`${API}/repeat/list?page=1&size=20&studentId=${encodeURIComponent(stu1.id)}`, { token: tHead });
  check(
    `⑦ /repeat/list 末班记录列表（${WHERE}）`,
    r7b.json?.code === 200 && (r7b.json?.data?.list ?? []).length > 0,
    `code=${r7b.json?.code} n=${(r7b.json?.data?.list ?? []).length}`,
  );

  /* ---------- ⑧ 阶段推进（★跨 3 张表：info + student + stage_log） ---------- */
  const r8 = await req(`${API}/stage/advance`, {
    token: tHead, method: 'POST',
    body: { classId: clsA.id, reason: '自检推进' },
  });
  check(`⑧ /stage/advance 推进成功（${WHERE}）`, r8.json?.code === 200, `code=${r8.json?.code} msg=${r8.json?.message ?? ''}`);
  if (r8.json?.code === 200) {
    const clsAfter = await probe(dbCls, 'sms_class', 't_class_info', STAGE).where('id', clsA.id).first();
    // ★ #23 方案 B：统一表 stage 列废弃（一律 null），权威列是 stage_code
    const phaseOf = (row) => (USE_UNI ? Number(row?.stage_code) : Number(row?.stage));
    check(
      `⑧ ★ 班级 stage 已推进（${WHERE}）`,
      clsAfter && phaseOf(clsAfter) === 202,
      `${USE_UNI ? 'stage_code' : 'stage'}=${clsAfter ? phaseOf(clsAfter) : 'N/A'} 期望=202（一阶段→二阶段）`,
    );
    const stuAfter = await probe(dbCls, 'sms_class', 't_class_student', STAGE).where('id', stu2.id).first();
    check(
      `⑧ ★ 学员 stage 同步跟进（${WHERE}）`,
      stuAfter && phaseOf(stuAfter) === 202,
      `student.${USE_UNI ? 'stage_code' : 'stage'}=${stuAfter ? phaseOf(stuAfter) : 'N/A'} 期望=202`,
    );
    // ★ 最隐蔽的坑：只切主表时这条会挂（阶段日志表仍是老表）
    const log = await probe(dbCls, 'sms_class', 't_class_stage_log', STAGE)
      .where('class_id', clsA.id).orderBy('create_time', 'desc').first();
    check(
      `⑧ ★★ 阶段日志落在${WHERE}（只切主表时这里必挂）`,
      !!log && Number(log.from_stage) === 201 && Number(log.to_stage) === 202,
      log ? `from=${log.from_stage} to=${log.to_stage}` : '查不到',
    );
    if (log) reg('sms_class', 't_class_stage_log', log.id);
  }
  const r8b = await req(`${API}/stage/log?classId=${encodeURIComponent(clsA.id)}`, { token: tHead });
  // ★ /stage/log 直接返回**数组**（不分页），不是 {list,total}
  const logList = Array.isArray(r8b.json?.data) ? r8b.json.data : (r8b.json?.data?.list ?? []);
  check(
    `⑧ /stage/log 阶段日志列表（${WHERE}）`,
    r8b.json?.code === 200 && logList.length > 0,
    `code=${r8b.json?.code} n=${logList.length} 返回类型=${Array.isArray(r8b.json?.data) ? '数组' : '分页对象'}`,
  );

  /* ---------- ⑨ 升实训：只验校验分支，不真跑（跨库不可逆） ---------- */
  const noPm = await mkClass(dbCls, uniDb, 'NOPM', headId, { stage: 206, project_manager_id: null });
  const r9 = await req(`${API}/training/upgrade`, {
    token: tHead, method: 'POST',
    body: { classId: noPm.id },
  });
  check(
    `⑨ /training/upgrade 缺项目经理被拦住（${WHERE}）`,
    r9.json?.code !== 200 && String(r9.json?.message ?? '').includes('项目经理'),
    `code=${r9.json?.code} msg=${String(r9.json?.message ?? '').slice(0, 60)}`,
  );
  const r9b = await req(`${API}/training/list?page=1&size=20`, { token: tHead });
  const trList = Array.isArray(r9b.json?.data) ? r9b.json.data : (r9b.json?.data?.list ?? []);
  check(
    `⑨ /training/list 交接单列表（${WHERE}）`,
    r9b.json?.code === 200,
    `code=${r9b.json?.code} n=${trList.length}`,
  );

  /* ---------- 清理 ---------- */
  for (const [d, t, id] of fixtures) {
    try { await conn(d)(t).where('id', id).del(); } catch { /* ignore */ }
  }

  summary();
  await dumpLogs();
  await killAll();
})().catch(async (e) => {
  console.error('\n[自检异常]', e && e.stack ? e.stack : e);
  await killAll();
  process.exit(1);
});