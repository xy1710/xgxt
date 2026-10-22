/**
 * 自检：班级信息域（第 2 期 · 第 7 个业务域）
 * ============================================================
 * 本脚本最关键的几条断言：
 *   ①【三入口同构】同一套接口 /list /detail /save 走 stage 参数切三库
 *   ②【★ 学段隔离】只有初高权限的账号查 job 必须被拦（列表 + 详情都拦）
 *   ③【★★ 字段归一】四处结构差异必须对：
 *      大学教室列名是 `room`（写入和读取都要翻译）
 *      大学/初高没有 class_code、close_date
 *      初高出勤率列名是 `today_attendance_rate`（今日），不是累计
 *   ④【★ 状态机】1开放/2封班/3待结业/4已结业；已结业是终态不可回退；
 *      非法流转必须被拦（如 待结业 → 开放）
 *   ⑤【★ 唯一性】实训的班级编号必填 + 唯一；同部门内班级名不重复
 *   ⑥【统计 = 列表】summary 的 total 必须等于同筛选下 list 的 total
 *   ⑦【写操作守门】只读管理员写被拦
 *   ⑧【★ 人数实时统计】人数不信表里的冗余 student_count，按在班学生实时算
 *
 * 演示库三张班级表基本是空的 → 自己造夹具、测完精确清理。
 */
import { BASE,
  buildRow,
  conn,
  dumpLogs,
  killAll,
  login,
  makeChecker,
  mirrorToUni,
  probe,
  req,
  startServices, regTarget } from './_e2e-lib.mjs';

const API = `${BASE}/api/teaching/class`;
const { check, summary } = makeChecker();

/**
 * ★★ 本项目「业务失败」的表达是 **HTTP 200 + code !== 200**
 *   （BizError 默认 httpStatus=200，code 才是真信号；只有 401/403 才改 HTTP 状态）
 *   所以判断「被拦/校验失败」必须看 json.code，不能看 HTTP 状态 —— 否则全判成通过。
 */
const OK = 200;
const isOk = (r) => r.json?.code === OK;
const isBlocked = (r) => r.json?.code !== OK;

const fixtures = [];
// ★ 第4期步骤2：切读时数据落在统一表，登记必须跟着改指向，否则清理删不掉
const reg = (dbName, table, id) => { const [d, t] = regTarget(dbName, table); fixtures.push([d, t, id]); };

/**
 * 造一个班级夹具（NOT NULL 无默认列由 buildRow 兜底）
 *
 * ★ 第 4 期步骤 1：同时**镜像一份到统一表** `t_uni_class`。
 *   切读开关打开时仓储读统一表，关时读老表 —— 两边都有数据才能做对比回归。
 */
async function mkClass(db, dbName, table, over = {}, stage = null) {
  const row = await buildRow(db, table, {
    class_name: '自检班' + Math.random().toString(36).slice(2, 5).toUpperCase(),
    class_status: 1,
    student_count: 0,
    is_deleted: 0,
    ...over,
  });
  await db(table).insert(row);
  reg(dbName, table, row.id);
  if (stage) await mirrorToUni(dbName, table, row, stage, reg);
  return row;
}

/** 造一个学生夹具（挂在某班下，用于验人数实时统计） */
async function mkStudent(db, dbName, table, classId, over = {}, stage = null) {
  const row = await buildRow(db, table, {
    student_no: 'CLS' + Math.random().toString(36).slice(2, 8).toUpperCase(),
    student_name: '自检生' + Math.random().toString(36).slice(2, 4).toUpperCase(),
    gender: 1,
    class_id: classId,
    is_deleted: 0,
    ...over,
  });
  await db(table).insert(row);
  reg(dbName, table, row.id);
  // ★ 第 4 期步骤 1：镜像到 t_uni_student（人数实时统计切读后要靠它）
  if (stage) await mirrorToUni(dbName, table, row, stage, reg);
  return row;
}

(async () => {
  const svc = await startServices();
  check('前后端启动成功', svc.backendReady && svc.frontendReady);
  if (!svc.backendReady) {
    dumpLogs();
    summary();
    await killAll();
    process.exit(1);
  }

  const dbJh = conn('sms_class_jh');
  const dbCls = conn('sms_class');
  const dbJob = conn('sms_job');
  // ★ 第 4 期步骤 1：统一表连接（镜像写入 + 清理）
  const uniDb = conn('sms_common');

  try {
    /* ============ 夹具 ============ */
    const jhCls = await mkClass(dbJh, 'sms_class_jh', 't_class_info', {
      class_name: '自检初高A',
      stage: 102,
      dept_code: 1,
      head_teacher_id: 'T-SUNMIN',
      head_teacher_name: '孙敏',
      today_attendance_rate: 96.5,
      remark: '初高夹具',
    }, 'jh');
    const clsCls = await mkClass(dbCls, 'sms_class', 't_class_info', {
      class_name: '自检大学A',
      stage: 202,
      dept_code: 2,
      room: '教学楼B301',
      attendance_rate: 91.2,
      head_teacher_id: 'T-ZHANGHT',
      head_teacher_name: '张海涛',
    }, 'class');
    const jobCls = await mkClass(dbJob, 'sms_job', 't_job_class', {
      class_name: '自检实训A',
      class_code: 'E2E' + Math.random().toString(36).slice(2, 8).toUpperCase(),
      stage: 2,
      dept_code: 2,
      class_status: 2, // ★ 新建默认封班（远端口径：开放→已结业 走不通）
      classroom: '3号楼201',
      head_teacher_id: 'T-ZHOUJ',
      head_teacher_name: '周佳',
      project_manager_id: 'T-ZHOUJ',
      project_manager_name: '周佳',
      open_date: '2026-03-01',
      attendance_rate: 88.8,
    }, 'job');

    // 各班挂 2 个学生（验人数实时统计）
    await mkStudent(dbJh, 'sms_class_jh', 't_class_student', jhCls.id, { student_status: 5 }, 'jh');
    await mkStudent(dbJh, 'sms_class_jh', 't_class_student', jhCls.id, { student_status: 5 }, 'jh');
    await mkStudent(dbCls, 'sms_class', 't_class_student', clsCls.id, { student_status: 5 }, 'class');
    await mkStudent(dbCls, 'sms_class', 't_class_student', clsCls.id, { student_status: 5 }, 'class');

    // 实训花名册表要单独造（不是学生表挂 class_id）
    // ⚠️ uk_in_class 是**生成列**（DB 自动按 班级_学生ID 算），手动插入会报 errno 1906
    //    "The value specified for generated column has been ignored" → 不能出现在 insert 里
    const roster1 = await buildRow(dbJob, 't_job_class_student', {
      class_id: jobCls.id,
      class_name: jobCls.class_name,
      student_id: 'STU-E2E-1',
      student_no: 'SX001',
      student_name: '自检生甲',
      join_date: '2026-03-01',
      join_type: 1,
      status: 1,
      is_deleted: 0,
    });
    await dbJob('t_job_class_student').insert(roster1);
    reg('sms_job', 't_job_class_student', roster1.id);
    // ★ 第 4 期步骤 1：镜像到 t_uni_class_student
    await mirrorToUni('sms_job', 't_job_class_student', roster1, 'job', reg);
    const roster2 = await buildRow(dbJob, 't_job_class_student', {
      class_id: jobCls.id,
      class_name: jobCls.class_name,
      student_id: 'STU-E2E-2',
      student_no: 'SX002',
      student_name: '自检生乙',
      join_date: '2026-03-01',
      join_type: 2,
      status: 1,
      is_deleted: 0,
    });
    await dbJob('t_job_class_student').insert(roster2);
    reg('sms_job', 't_job_class_student', roster2.id);
    await mirrorToUni('sms_job', 't_job_class_student', roster2, 'job', reg);

    check('夹具写入 3 个班（初高/大学/实训）+ 6 名学生', true);

    /* ============ 登录 ============ */
    const tAdmin = await login('admin'); // 只读管理员
    const tSunmin = await login('sunmin'); // 初高班主任
    const tCongym = await login('congym'); // 学管（应有多学段权限）
    const tQiansy = await login('qiansy'); // 校长（全量）
    check('演示账号登录成功', !!(tAdmin && tSunmin && tCongym && tQiansy));

    /* ============ 1. 三入口同构：列表 ============ */
    for (const stage of ['jh', 'class', 'job']) {
      const r = await req(`${API}/list?stage=${stage}&page=1&size=200`, { token: tQiansy });
      check(
        `★ ${stage} 学段列表可查`,
        isOk(r) && Array.isArray(r.json?.data?.list),
        `code=${r.json?.code} ${r.json?.message || ''}`,
      );
    }

    // 「全部」= 三学段合并
    const all = await req(`${API}/list?page=1&size=200`, { token: tQiansy });
    const allList = all.json?.data?.list || [];
    check(
      '★ 「全部」视图合并三学段（校长可见 3 个夹具班）',
      isOk(all) && ['jh', 'class', 'job'].every((s) => allList.some((x) => x.stage === s)),
      `total=${all.json?.data?.total}`,
    );
    // ★ 班级不去重：同名也要都留着
    check('★ 班级不去重（同名的班保留两条）', allList.length === new Set(allList.map((x) => x.classId)).size);

    /* ============ 2. ★ 字段归一（四处结构差异） ============ */
    const rJh = await req(`${API}/list?stage=jh&keyword=自检初高A`, { token: tQiansy });
    const rowJh = (rJh.json?.data?.list || [])[0];
    check('★ 初高：出勤率读的是 today_attendance_rate（今日 96.5）', rowJh?.attendanceRate === 96.5, `得到 ${rowJh?.attendanceRate}`);
    check('★ 初高：attendanceRateKind 必须是 today', rowJh?.attendanceRateKind === 'today', `得到 ${rowJh?.attendanceRateKind}`);
    check('★ 初高：没有 class_code 列 → 恒 null', rowJh?.classCode === null, `得到 ${rowJh?.classCode}`);
    check('★ 初高：没有 close_date 列 → 恒 null', rowJh?.closeDate === null, `得到 ${rowJh?.closeDate}`);
    check('★ 初高：没有交棒字段 → 恒 null', rowJh?.projectManagerId === null && rowJh?.employmentTeacherId === null);
    check('★ 初高：remark 有值（这张表有 remark 列）', rowJh?.remark === '初高夹具', `得到 ${rowJh?.remark}`);
    check('★ 初高：人数实时统计 = 2', rowJh?.studentCount === 2, `得到 ${rowJh?.studentCount}`);

    const rCls = await req(`${API}/list?stage=class&keyword=自检大学A`, { token: tQiansy });
    const rowCls = (rCls.json?.data?.list || [])[0];
    check('★★ 大学：教室列名是 room → 要读到「教学楼B301」', rowCls?.classroom === '教学楼B301', `得到 ${rowCls?.classroom}`);
    check('★★ 大学：出勤率读的是 attendance_rate（累计 91.2）', rowCls?.attendanceRate === 91.2, `得到 ${rowCls?.attendanceRate}`);
    check('★ 大学：没有 remark 列 → 恒 null', rowCls?.remark === null, `得到 ${rowCls?.remark}`);
    check('★ 大学：没有 class_code → 恒 null', rowCls?.classCode === null);
    check('★ 大学：有交棒字段（project_manager_* 存在）', rowCls?.projectManagerId === null || typeof rowCls?.projectManagerId === 'string');

    const rJob = await req(`${API}/list?stage=job&keyword=自检实训A`, { token: tQiansy });
    const rowJob = (rJob.json?.data?.list || [])[0];
    check('★ 实训：有班级编号（唯一表才有这列）', !!rowJob?.classCode, `得到 ${rowJob?.classCode}`);
    check('★ 实训：出勤率口径是 total', rowJob?.attendanceRateKind === 'total');
    check('★ 实训：教室列名 classroom → 「3号楼201」', rowJob?.classroom === '3号楼201');
    check('★ 实训：交棒字段有值', rowJob?.projectManagerName === '周佳', `得到 ${rowJob?.projectManagerName}`);

    /* ============ 3. ★ 人数实时统计（不信冗余列） ============ */
    // 把表里的冗余 student_count 改成 99，人数仍应是 2
    await probe(dbJob, 'sms_job', 't_job_class', 'job').where({ id: jobCls.id }).update({ student_count: 99 });
    const rJob2 = await req(`${API}/list?stage=job&keyword=自检实训A`, { token: tQiansy });
    const rowJob2 = (rJob2.json?.data?.list || [])[0];
    check('★ 人数不信表里的冗余 student_count（写了 99，仍返回 2）', rowJob2?.studentCount === 2, `得到 ${rowJob2?.studentCount}`);

    /* ============ 4. 详情 + 花名册 ============ */
    const dJh = await req(`${API}/detail?stage=jh&id=${jhCls.id}`, { token: tQiansy });
    check('★ 初高详情：花名册 2 人', isOk(dJh) && (dJh.json?.data?.roster || []).length === 2, `code=${dJh.json?.code}`);
    const dJob = await req(`${API}/detail?stage=job&id=${jobCls.id}`, { token: tQiansy });
    check('★ 实训详情：花名册 2 人', isOk(dJob) && (dJob.json?.data?.roster || []).length === 2);
    check('★ 实训花名册带「入班方式」（它有独立花名册表）', (dJob.json?.data?.roster || [])[0]?.joinTypeName !== '');
    check(
      '★ 初高花名册无入班方式（学生表挂 class_id，没有花名册表）',
      (dJh.json?.data?.roster || [])[0]?.joinType === null,
    );
    const notFound = await req(`${API}/detail?stage=jh&id=NOT-EXIST-ID`, { token: tQiansy });
    check('★ 班级不存在被拦', isBlocked(notFound), `code=${notFound.json?.code}`);

    /* ============ 5. ★ 学段隔离（越权） ============ */
    // sunmin 只有初高权限 → 查 job 必须被拦
    const jhSeesJob = await req(`${API}/list?stage=job`, { token: tSunmin });
    check('★ 初高班主任查 job 列表被拦', isBlocked(jhSeesJob), `code=${jhSeesJob.json?.code} ${jhSeesJob.json?.message || ''}`);
    const jobDetailByJh = await req(`${API}/detail?stage=job&id=${jobCls.id}`, { token: tSunmin });
    check('★ 初高班主任直查 job 班级详情被拦（防拿 id 直查）', isBlocked(jobDetailByJh), `code=${jobDetailByJh.json?.code}`);
    const jhOwn = await req(`${API}/list?stage=jh`, { token: tSunmin });
    check('★ 初高班主任查自己学段正常', isOk(jhOwn), `code=${jhOwn.json?.code}`);

    /* ============ 6. ★ 状态机 ============ */
    // ★ 用校长 qiansy，不能用学管 congym ——
    //   学管主任是**审批角色**：denyApprovalOnlyWrite 总闸规定他「只能看 + 审批」，
    //   建班/改班/改状态全都不许（业务口径 2026-10-06）。
    const toSealed = await req(`${API}/change-status`, {
      method: 'POST',
      body: { stage: 'jh', id: jhCls.id, classStatus: 2 },
      token: tQiansy,
    });
    check('★ 合法流转 开放→封班 成功', isOk(toSealed), `code=${toSealed.json?.code} ${toSealed.json?.message || ''}`);

    // ★ 2026-10-19 远端口径：「待结业」状态已废弃（页面不再出现），
    //   封班之后**直接**进「已结业」；3→已结业 仅保留给历史数据。
    const toGraduating = await req(`${API}/change-status`, {
      method: 'POST',
      body: { stage: 'jh', id: jhCls.id, classStatus: 3 },
      token: tQiansy,
    });
    check(
      '★ 新口径：封班→待结业 被状态机拦（待结业已废弃）',
      isBlocked(toGraduating) && /不可从/.test(toGraduating.json?.message || ''),
      `code=${toGraduating.json?.code} ${toGraduating.json?.message || ''}`,
    );

    const toGraduated = await req(`${API}/change-status`, {
      method: 'POST',
      body: { stage: 'jh', id: jhCls.id, classStatus: 4 },
      token: tQiansy,
    });
    check('★ 合法流转 封班→已结业 成功', isOk(toGraduated), `code=${toGraduated.json?.code} ${toGraduated.json?.message || ''}`);

    // 终态：已结业 → 开放（非结业撤销专用动作，必须拦）
    const fromTerminal = await req(`${API}/change-status`, {
      method: 'POST',
      body: { stage: 'jh', id: jhCls.id, classStatus: 1 },
      token: tQiansy,
    });
    check(
      '★ 已结业是终态 → 不能再退回开放',
      isBlocked(fromTerminal) && /不可从/.test(fromTerminal.json?.message || ''),
      `code=${fromTerminal.json?.code} ${fromTerminal.json?.message || ''}`,
    );

    const badStatus = await req(`${API}/change-status`, {
      method: 'POST',
      body: { stage: 'jh', id: jhCls.id, classStatus: 9 },
      token: tQiansy,
    });
    check('★ 状态码 9（不存在）被拦', isBlocked(badStatus), `code=${badStatus.json?.code}`);

    // 实训结业同样「封班 → 已结业」，并自动写结业日期
    const jobGraduate = await req(`${API}/change-status`, {
      method: 'POST',
      body: { stage: 'job', id: jobCls.id, classStatus: 4 },
      token: tQiansy,
    });
    check('★ 实训 封班→已结业 成功', isOk(jobGraduate), `code=${jobGraduate.json?.code} ${jobGraduate.json?.message || ''}`);
    const jobRow = await probe(dbJob, 'sms_job', 't_job_class', 'job').where({ id: jobCls.id }).first();
    check('★ 实训结业自动写入 close_date', !!jobRow?.close_date, `close_date=${jobRow?.close_date}`);
    check('★ 实训结业记录 prev_class_status（撤销结业用）', Number(jobRow?.prev_class_status) === 2, `prev=${jobRow?.prev_class_status}`);

    /* ============ 7. 保存（新增 / 修改）+ 唯一性 ============ */
    // 编辑不清阶段的测试对象（复用大学夹具班，测完统一清理）
    const newIdProbe = clsCls.id;
    // 实训：编号必填
    const noCode = await req(`${API}/save`, {
      method: 'POST',
      body: { stage: 'job', className: '自检无编号班' },
      token: tQiansy,
    });
    check('★ 实训新增：缺班级编号被拦（那张表里 NOT NULL）', isBlocked(noCode), `code=${noCode.json?.code} ${noCode.json?.message || ''}`);

    // 实训：编号唯一
    // ⚠️ 必填项（班主任 / 开班日期）要一起给全，否则会被「班主任必填」先拦下 →
    //    看着"被拦了"，其实压根没走到编号唯一性那一步（假通过）。
    // ★ 班号新规：编号跨部门唯一。先建 A 拿到编号，再用同一编号建 B → 必须被拦
    const dupTag = 'DC' + Math.random().toString(36).slice(2, 6).toUpperCase();
    const dupA = await req(`${API}/save`, {
      method: 'POST',
      body: {
        stage: 'job',
        className: '自检重复编号A-' + dupTag,
        classCode: dupTag,
        deptCode: 2,
        headTeacherId: 'T-X',
        headTeacherName: '某',
        openDate: '2026-09-01',
      },
      token: tQiansy,
    });
    if (isOk(dupA)) reg('sms_common', 't_uni_class', dupA.json?.data?.id);
    const dupCode = await req(`${API}/save`, {
      method: 'POST',
      body: {
        stage: 'job',
        className: '自检重复编号B-' + dupTag,
        classCode: dupTag,
        deptCode: 2,
        headTeacherId: 'T-X',
        headTeacherName: '某',
        openDate: '2026-09-01',
      },
      token: tQiansy,
    });
    check(
      '★ 实训新增：班级编号重复被拦（跨部门唯一）',
      isBlocked(dupCode) && /占用|已存在/.test(dupCode.json?.message || ''),
      `code=${dupCode.json?.code} ${dupCode.json?.message || ''}`,
    );

    // 同部门内班级名重复
    const dupName = await req(`${API}/save`, {
      method: 'POST',
      // ★ 班级编号必填（2026-10-21 新口径），否则被「编号必填」先拦、走不到同名检查
      body: { stage: 'class', className: clsCls.class_name, classCode: 'C' + Math.random().toString(36).slice(2, 6).toUpperCase(), deptCode: 2, phaseCode: 202 },
      token: tQiansy,
    });
    check(
      '★ 大学新增：同部门班级名重复被拦（且必须确认是被"同名"拦的）',
      isBlocked(dupName) && /已有班级叫/.test(dupName.json?.message || ''),
      `code=${dupName.json?.code} ${dupName.json?.message || ''}`,
    );

    // ★ 2026-10-15 需求：初高「班主任 / 教员 / 助教」改为下拉选人、**允许不选**
    //   （迁移 20261015_002_class_info_relax_required 已把这几列放宽为可空）
    //   ⚠️ 这条以前是"缺班主任必须被拦"，长期靠残留的同名班撞「已有班级叫…」才
    //      侥幸通过 —— 清掉夹具后就露馅了，所以改成按新口径断言。
    const jhNoTeacher = await req(`${API}/save`, {
      method: 'POST',
      // 名字带随机后缀：这个用例以前会撞上一次运行留下的同名班
      body: { stage: 'jh', className: '自检无班主任-' + Math.random().toString(36).slice(2, 6), classCode: 'J' + Math.random().toString(36).slice(2, 6).toUpperCase(), deptCode: 1 },
      token: tQiansy,
    });
    check(
      '★ 初高新增：班主任/教员全留空也能建（2026-10-15 放宽）',
      isOk(jhNoTeacher) && !!jhNoTeacher.json?.data?.id,
      `code=${jhNoTeacher.json?.code} ${jhNoTeacher.json?.message || ''}`,
    );
    const jhNoTeacherId = jhNoTeacher.json?.data?.id;
    if (jhNoTeacherId) {
      await req(`${API}/delete?stage=jh&id=${jhNoTeacherId}`, { method: 'DELETE', token: tQiansy });
    }

    // 班级名必填
    const noName = await req(`${API}/save`, {
      method: 'POST',
      body: { stage: 'class', className: '', deptCode: 2 },
      token: tQiansy,
    });
    check('★ 班级名必填被拦', isBlocked(noName), `code=${noName.json?.code}`);

    /* ----★ 必填列防御（各表不同，必须各自提前拦，
       否则会漏到 DB 层报 ER_BAD_NULL_ERROR，错误信息很难定位）---- */
    // 实训：open_date 仍是必填（head_teacher 已放宽，不再要求）
    const jobNoDate = await req(`${API}/save`, {
      method: 'POST',
      body: {
        stage: 'job',
        className: '自检实训缺日期',
        classCode: 'E2E' + Math.random().toString(36).slice(2, 8).toUpperCase(),
        headTeacherId: 'T-X',
        headTeacherName: '某',
      },
      token: tQiansy,
    });
    check('★ 实训新增：缺开班日期被拦（业务必填）', isBlocked(jobNoDate), `code=${jobNoDate.json?.code} ${jobNoDate.json?.message || ''}`);

    // 大学：class_name 之外只有 dept_code/stage 必填，缺阶段码要有兜底而不是炸库
    const clsNoPhase = await req(`${API}/save`, {
      method: 'POST',
      body: { stage: 'class', className: '自检大学无阶段', classCode: 'U' + Math.random().toString(36).slice(2, 6).toUpperCase(), deptCode: 2 },
      token: tQiansy,
    });
    check('★ 大学新增：不传阶段码也能建（该表 stage NOT NULL → 后端兜底）', isOk(clsNoPhase), `code=${clsNoPhase.json?.code} ${clsNoPhase.json?.message || ''}`);
    if (isOk(clsNoPhase)) reg('sms_class', 't_class_info', clsNoPhase.json?.data?.id);

    /* ----★★ NOT NULL 列不能被「没传」写成 NULL（这是本域最隐蔽的一个坑）----
       场景：前端编辑弹窗只提交用户改过的字段，没填的传 null。
       如果后端把 null 直接写进 update → ER_BAD_NULL_ERROR（改个教室名都保存不了），
       更危险的是若列可空，会把已有阶段码悄悄抹掉。 */
    const keepStage = await req(`${API}/save`, {
      method: 'POST',
      body: { stage: 'class', id: newIdProbe, className: '自检改名字班', classroom: '只改教室', deptCode: null, phaseCode: null },
      token: tQiansy,
    });
    check('★ 编辑时传 null 给 NOT NULL 列不报错（当「不修改」）', isOk(keepStage), `code=${keepStage.json?.code} ${keepStage.json?.message || ''}`);
    if (isOk(keepStage)) {
      const after = await probe(dbCls, 'sms_class', 't_class_info', 'class').where({ id: newIdProbe }).first();
      check('★★ 编辑不传阶段码 → 原阶段码没被抹掉', (after?.stage_code ?? after?.stage) != null, `stage=${after?.stage_code ?? after?.stage}`);
    }

    // 非法 stage
    const badStage = await req(`${API}/list?stage=xxx`, { token: tQiansy });
    check('★ 非法 stage 被拦', isBlocked(badStage), `code=${badStage.json?.code}`);

    // 正常新增（大学 —— 校验 room 列真的写进去了）
    const created = await req(`${API}/save`, {
      method: 'POST',
      body: {
        stage: 'class',
        className: '自检新建大学班',
        classCode: 'UN' + Math.random().toString(36).slice(2, 5).toUpperCase(),
        deptCode: 2,
        phaseCode: 203,
        classroom: '新建教室A101',
        headTeacherId: 'T-NEW',
        headTeacherName: '新老师',
        openDate: '2026-09-01',
      },
      token: tQiansy,
    });
    check('★ 大学新增班级成功', isOk(created) && !!created.json?.data?.id, `code=${created.json?.code} ${created.json?.message || ''}`);
    const newId = created.json?.data?.id;
    const newRow = newId ? await probe(dbCls, 'sms_class', 't_class_info', 'class').where({ id: newId }).first() : null;
    // ★ 2026-10-19 远端新增教室规范化：'新建教室A101' → 'A-101'
    check('★★ 大学新增：教室规范化后写进 room 列', newRow?.room === 'A-101', `room=${newRow?.room}`);
    reg('sms_class', 't_class_info', newId);

    // 修改
    const updated = await req(`${API}/save`, {
      method: 'POST',
      body: { stage: 'class', id: newId, className: '自检改名大学班', deptCode: 2, classroom: '改后教室B202' },
      token: tQiansy,
    });
    check('★ 修改班级成功', isOk(updated), `code=${updated.json?.code} ${updated.json?.message || ''}`);
    const reread = await probe(dbCls, 'sms_class', 't_class_info', 'class').where({ id: newId }).first();
    check('★ 修改后教室更新', reread?.room === 'B-202' && reread?.class_name === '自检改名大学班', `room=${reread?.room}`);

    // 生成编号（只有实训有）
    const genJob = await req(`${API}/gen-code?stage=job`, { token: tQiansy });
    check('★ 实训能生成班级编号', isOk(genJob) && !!genJob.json?.data?.classCode, `得到 ${genJob.json?.data?.classCode}`);
    const genClass = await req(`${API}/gen-code?stage=class`, { token: tQiansy });
    check('★ 大学生成编号返回 null（那张表没这列）', isOk(genClass) && genClass.json?.data?.classCode === null);

    /* ============ 8. 元信息 ============ */
    const meta = await req(`${API}/meta`, { token: tQiansy });
    const metaList = meta.json?.data || [];
    check('★ /meta 返回四学段特性（含就业部 emp）', isOk(meta) && metaList.length === 4, `得到 ${metaList.length} 个`);
    const mJob = metaList.find((m) => m.stage === 'job');
    const mJh = metaList.find((m) => m.stage === 'jh');
    const mCls = metaList.find((m) => m.stage === 'class');
    check('★ meta：实训 hasClassCode=true / hasCloseDate=true', mJob?.hasClassCode === true && mJob?.hasCloseDate === true);
    // ★ 班号新规：三部门都有班级编号字段（初高 meta 也返回 hasClassCode=true）
    check('★ meta：初高 hasClassCode=true（班号新规）', mJh?.hasClassCode === true, `得到 ${mJh?.hasClassCode}`);
    check('★ meta：教室标签各学段不同', mJob?.classroomLabel !== mCls?.classroomLabel, `job=${mJob?.classroomLabel} class=${mCls?.classroomLabel}`);
    check('★ meta：阶段码选项按学段不同', (mJh?.phaseOptions?.length || 0) > 0 && (mJob?.phaseOptions?.length || 0) > 0);

    /* ============ 9. ★ 统计 = 列表 ============ */
    for (const stage of ['jh', 'class', 'job']) {
      const l = await req(`${API}/list?stage=${stage}&page=1&size=200`, { token: tQiansy });
      const s = await req(`${API}/summary?stage=${stage}`, { token: tQiansy });
      const lt = l.json?.data?.total || 0;
      const st = (s.json?.data || [])[0]?.total ?? -1;
      check(`★ ${stage}：统计 total = 列表 total`, isOk(s) && lt === st, `list=${lt} summary=${st}`);
    }
    // 统计的状态分布应加起来 = total
    const sJh = await req(`${API}/summary?stage=jh`, { token: tQiansy });
    const sj = (sJh.json?.data || [])[0] || {};
    check(
      '★ 统计的状态分布之和 = total',
      (sj.openCount || 0) + (sj.closedCount || 0) + (sj.graduatingCount || 0) + (sj.graduatedCount || 0) === sj.total,
      `open=${sj.openCount} closed=${sj.closedCount} graduating=${sj.graduatingCount} graduated=${sj.graduatedCount} total=${sj.total}`,
    );

    /* ============ 10. 班级下拉 ============ */
    const opts = await req(`${API}/options`, { token: tQiansy });
    const optList = opts.json?.data || [];
    check('★ /options 返回下拉', isOk(opts) && Array.isArray(optList));
    // 已结业的班不作为「可转入」选项
    check('★ /options 排除已结业的班', !optList.some((o) => o.classId === jobCls.id), `含已结业班？${optList.some((o) => o.classId === jobCls.id)}`);
    check('★ /options 含未结业的班', optList.some((o) => o.classId === clsCls.id));

    /* ============ 11. ★ 写操作守门 ============ */
    // ★ 学管主任是**审批角色**：只能看 + 审批，不能建班/改班（业务口径 2026-10-06）
    const deanSave = await req(`${API}/save`, {
      method: 'POST',
      body: { stage: 'class', className: '学管建的班', deptCode: 2 },
      token: tCongym,
    });
    check(
      '★ 学管主任写被拦（他只能审批+查看）',
      isBlocked(deanSave) && /审批角色/.test(deanSave.json?.message || ''),
      `code=${deanSave.json?.code} ${deanSave.json?.message || ''}`,
    );
    const deanRead = await req(`${API}/list?stage=class`, { token: tCongym });
    check('★ 学管主任读正常（只读不是没权限）', isOk(deanRead), `code=${deanRead.json?.code}`);

    const adminSave = await req(`${API}/save`, {
      method: 'POST',
      body: { stage: 'class', className: '只读管理员建的班', deptCode: 2 },
      token: tAdmin,
    });
    check('★ 只读管理员写被拦', isBlocked(adminSave), `code=${adminSave.json?.code}`);

    /* ============ 12. 软删 ============ */
    // ⚠️ 必须显式 method:'DELETE' —— req() 默认是 GET，
    //    漏了会走不到路由 → 返回 40401「接口不存在」（看起来像接口没挂，其实是调用错）
    const del = await req(`${API}/delete?stage=class&id=${newId}`, { method: 'DELETE', token: tQiansy });
    check('★ 删除班级成功', isOk(del), `code=${del.json?.code}`);
    const afterDel = await req(`${API}/list?stage=class&keyword=自检改名大学班`, { token: tQiansy });
    check('★ 删除后列表查不到', (afterDel.json?.data?.list || []).length === 0);
    const rawDel = newId ? await probe(dbCls, 'sms_class', 't_class_info', 'class').where({ id: newId }).first() : null;
    check('★ 数据库里是软删（is_deleted=1）而非物理删除', !!rawDel && Number(rawDel.is_deleted) === 1);
  } catch (e) {
    console.error('\n💥 自检异常：', e);
    check('自检脚本执行无异常', false, e.message);
  } finally {
    /* ============ 精确清理 ============ */
    const dbs = {
      sms_class_jh: dbJh,
      sms_class: dbCls,
      sms_job: dbJob,
      sms_common: uniDb,
    };
    for (const [dbName, table, id] of fixtures.reverse()) {
      if (!id) continue;
      try {
        await dbs[dbName](table).where({ id }).del();
      } catch (e) {
        console.warn(`  清理失败 ${dbName}.${table} ${id}: ${e.message}`);
      }
    }
    console.log(`\n  已清理 ${fixtures.length} 条夹具`);
    await dbJh.destroy();
    await dbCls.destroy();
    await dbJob.destroy();
    await uniDb.destroy();
    await killAll();
  }

  summary();
  process.exit(0);
})();