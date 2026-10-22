/**
 * 自检：学生档案域（第2 期 · 第 6 个业务域）
 * ============================================================
 * ★★ 这是唯一有 **4 个学段** 的域（初高 / 大学 / 就业 / 教务），
 *   也是唯一必须做「跨库按学号去重」的域。
 *
 * 本脚本最关键的几条断言：
 *   ①【四入口同构】同一套接口 /list /detail /save /delete 走stage 参数切四库
 *   ②【★ 学段隔离】sunmin（只有 classjh:student:view）查 job 必须被拦，
 *      而且要连列表里的 stage 过滤一起验（不能只拦详情）
 *   ③【★ 去重规则】同一个学号在 job 与 class 各有一条 → 「全部」视图只出现 1 条，
 *      且保留**阶段更靠后**的那条（job > class > jh > edu）—— 这条最容易写反
 *   ④【实训口径】job 学段显示 待就业 / 已就业 / 实训中 / 休学 / 退学
 *      （实训中(8) 于 2026-10-15 纳入：项目经理 = 实训阶段班主任，必须能看到实训学员）
 *   ⑤【统计= 列表】summary 的 total 必须等于同筛选下 list 的 total
 *   ⑥【写操作守门】只读管理员 + 无权学段 都要被拦
 *
 * 演示库四张学生表都是空的 → 自己造夹具、测完删干净。
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
  probe,
  req,
  regTarget,
  startServices,
} from './_e2e-lib.mjs';

const API = `${BASE}/api/teaching/student`;
const ST = { WAIT_CONSULT: 1, TRIAL: 3, STUDYING: 5, SUSPENDED: 6, QUIT: 7, TRAINING: 8, WAIT_EMPLOY: 9, EMPLOYED: 10 };
/** job 学段 VISIBLE_STATUS = 实训中(8) / 待就业(9) / 已就业(10) / 休学(6) / 退学(7) */
const JOB_VISIBLE = [ST.TRAINING, ST.WAIT_EMPLOY, ST.EMPLOYED, ST.SUSPENDED, ST.QUIT];

const { check, summary } = makeChecker();

/**
 * ★★ 本项目「业务失败」的表达是 **HTTP 200 + code !== 200**
 *   （BizError 默认 httpStatus=200，code 才是真信号；只有 401/403 才改HTTP 状态）
 *   所以判断"被拦/校验失败"必须看 json.code，不能看 HTTP 状态 —— 否则全判成通过。
 */
const OK = 200;
const isOk = (r) => r.json?.code === OK;
const isBlocked = (r) => r.json?.code !== OK;
const fixtures = [];
// ★ 第4期步骤2：切读时数据落在统一表，登记必须跟着改指向，否则清理删不掉
const reg = (dbName, table, id) => { const [d, t] = regTarget(dbName, table); fixtures.push([d, t, id]); };
/** sms_common 连接（双写目标库），在 IIFE 里赋值 */
let uniDb = null;

/** 库名 → 学段码（学生档案域 4 个库；sms_edu 不在 UNI_MAP，镜像层会自动跳过） */
const STAGE_OF = { sms_class_jh: 'jh', sms_class: 'class', sms_job: 'job', sms_edu: 'edu' };
/** 造一个学生夹具（NOT NULL 无默认列由 buildRow 兜底） */
async function mkStudent(db, table, over = {}) {
  const row = await buildRow(db, table, {
    student_no: 'STU' + Math.random().toString(36).slice(2, 8).toUpperCase(),
    student_name: '自检-' + Math.random().toString(36).slice(2, 4).toUpperCase(),
    gender: 1,
    student_status: ST.STUDYING,
    is_deleted: 0,
    ...over,
  });
  await db(table).insert(row);
  reg(db.__name, table, row.id);
  // ★ 双写统一表 t_uni_student（sms_edu 不在 UNI_MAP → 内部返回 null，自动跳过）
  await mirrorRow(uniDb, db.__name, table, row, STAGE_OF[db.__name], (_d, t, id) =>
    reg('sms_common', t, id),
  );
  return row;
}

(async () => {
  const dbJh = conn('sms_class_jh');
  const dbCls = conn('sms_class');
  const dbJob = conn('sms_job');
  const dbEdu = conn('sms_edu');
  uniDb = conn('sms_common');
  dbJh.__name = 'sms_class_jh';
  dbCls.__name = 'sms_class';
  dbJob.__name = 'sms_job';
  dbEdu.__name = 'sms_edu';

  try {
    /* ============ A. 环境 ============ */
    const { backendReady, frontendReady } = await startServices();
    check('服务就绪（后端 8004 + 前端 5173）', backendReady && frontendReady);
    if (!backendReady) {
      dumpLogs();
      return;
    }

    const tJhHead = await login('sunmin'); // 初高班主任：只有 classjh:student:view
    const tHead = await login('zhanght'); // 大学班主任：只有 class:student:view
    const tEdu = await login('zhengym'); // 教务：只有 edu:student:view
    const tJob = await login('zhouj'); // 就业老师：只有 job:empArchive:view
    const tDean = await login('congym'); // 学管：初高 + 大学
    const tPrincipal = await login('qiansy'); // 校长：四学段全有
    const tAdmin = await login('admin'); // 只读管理员
    check(
      '登录 7 个账号',
      [tJhHead, tHead, tEdu, tJob, tDean, tPrincipal, tAdmin].every(Boolean),
    );

    /* ============ B. 夹具：四个学段各 1 人 + 1 组同学号（测去重） ============ */
    const sJh = await mkStudent(dbJh, 't_class_student', {
      student_no: 'U0001',
      student_name: '自检-初高生',
      student_status: ST.STUDYING,
      class_id: 'U0001',
      class_name: '自检-初高班',
      head_teacher_name: '孙敏',
    });
    const sCls = await mkStudent(dbCls, 't_class_student', {
      student_no: 'U0002',
      student_name: '自检-大学生',
      student_status: ST.STUDYING,
      class_id: 'U0002',
      class_name: '自检-大学班',
      dept_code: 1,
    });
    const sJob = await mkStudent(dbJob, 't_student_base', {
      student_no: 'U0003',
      student_name: '自检-就业生',
      student_status: ST.WAIT_EMPLOY,
      class_id: 'U0003',
      class_name: '自检-实训班',
      // ★ 2026-10-22 新口径：就业部 = sms_job 里 dept_code=3 的学生（job/emp 两种 stage_key 都算）
      dept_code: 3,
    });
    const sEdu = await mkStudent(dbEdu, 't_student_base', {
      student_no: 'U0004',
      student_name: '自检-教务生',
      student_status: ST.STUDYING,
      class_id: 'U0004',
      class_name: '自检-教务班',
      dept_code: 1,
    });

    // ★ 去重夹具：同一学号 DUP001 在大学 + 就业各一条
    const dupCls = await mkStudent(dbCls, 't_class_student', {
      student_no: 'DUP001',
      student_name: '自检-重复号-大学那条',
      student_status: ST.STUDYING,
      dept_code: 1,
    });
    const dupJob = await mkStudent(dbJob, 't_student_base', {
      student_no: 'DUP001',
      student_name: '自检-重复号-就业那条',
      student_status: ST.WAIT_EMPLOY,
      dept_code: 3,
    });

    // 实训口径夹具：状态=实训中(8)。
    // ★ 2026-10-15 起 TRAINING(8) 已进 VISIBLE_STATUS（项目经理 = 实训阶段班主任，
    //   必须能看到实训中的学员）→ 该学生**应当**出现在 job 列表里。
    await mkStudent(dbJob, 't_student_base', {
      student_no: 'U0005',
      student_name: '自检-实训中',
      student_status: ST.TRAINING,
      dept_code: 3,
    });

    check('夹具写入 7 条学生（4 学段 + 重复号 2 + 实训中1）', true);

    /* ---- 班级夹具：三个学段的班级表演示库是空的，不造就没有下拉项 ---- */
    const mkClass = async (db, dbName, table, name, classCode, extra = {}) => {
      const row = await buildRow(db, table, { class_name: name, class_status: 1, is_deleted: 0, ...extra });
      // ★ 老表没有 class_code 列（该列只在统一表），别写进老表 insert
      await db(table).insert(row);
      reg(dbName, table, row.id);
      // ★ 双写统一表 t_uni_class（班号新规：镜像里带上班级编号）
      await mirrorRow(
        uniDb,
        dbName,
        table,
        classCode ? { ...row, class_code: classCode } : row,
        STAGE_OF[dbName],
        (_d, t, id) => reg('sms_common', t, id),
      );
      return { ...row, classCode };
    };
    await mkClass(dbJh, 'sms_class_jh', 't_class_info', '自检-初高班');
    const uniCls = await mkClass(
      dbCls,
      'sms_class',
      't_class_info',
      '自检-大学班',
      'UC' + Math.random().toString(36).slice(2, 6).toUpperCase(),
      // ★ 数据范围按责任人过滤：夹具班必须挂到 zhanght 名下，否则他读不到详情
      { head_teacher_id: '85a47f05-6f96-4602-944e-d5c29b0154ae', head_teacher_name: '张海涛' },
    );
    await mkClass(dbJob, 'sms_job', 't_job_class', '自检-实训班');

    /* ============ C. 四入口同构：按 stage 查列表 ============ */
    const byStage = {};
    for (const stage of ['jh', 'class', 'emp']) {
      const r = await req(`${API}/list?stage=${stage}&page=1&size=50`, { token: tPrincipal });
      byStage[stage] = r.json?.data?.list || [];
      check(
        `列表 stage=${stage} 正常返回（校长）`,
        isOk(r) && Array.isArray(byStage[stage]),
        `返回 ${byStage[stage].length} 条`,
      );
    }

    const has = (stage, no) => byStage[stage].some((x) => x.studentNo === no);
    check('初高库命中 U0001', has('jh', 'U0001'));
    check('大学库命中 U0002', has('class', 'U0002'));
    // ★ 2026-10-22 新口径：三学段（jh/class/emp），就业部 = dept_code=3（含原实训学生）
    check('就业部命中 U0003', has('emp', 'U0003'));
    check('教务库不再列出（学段已删）', !has('emp', 'U0004'));
    check('★ 就业部口径：实训中(8) 也在列表里（dept_code=3 全算）', has('emp', 'U0005'));

    /* ============ D. ★ 学段隔离（安全边界） ============ */
    const rJhSeesJob = await req(`${API}/list?stage=emp&page=1&size=50`, { token: tJhHead });
    check(
      '★ 初高班主任查就业部被拦（403/无权限）',
      isBlocked(rJhSeesJob) || (rJhSeesJob.json?.data?.list || []).length === 0,
      `HTTP ${rJhSeesJob.status} ${rJhSeesJob.json?.message || ''}`,
    );

    const rJobSeesJh = await req(`${API}/list?stage=jh&page=1&size=50`, { token: tJob });
    check('★ 就业老师查初高被拦', isBlocked(rJobSeesJh) || (rJobSeesJh.json?.data?.list || []).length === 0);

    // ★ 「全部」视图：sunmin 只有初高权 → 只能看到初高，不能看到就业的 U0003
    const rJhAll = await req(`${API}/list?page=1&size=100`, { token: tJhHead });
    const allJh = rJhAll.json?.data?.list || [];
    check('★ sunmin「全部」视图只含初高学段', allJh.length > 0 && allJh.every((x) => x.stage === 'jh'), `${allJh.length} 条`);
    check('★ sunmin 看不到就业的 U0003', !allJh.some((x) => x.studentNo === 'U0003'));

    const rDeanAll = await req(`${API}/list?page=1&size=100`, { token: tDean });
    const allDean = rDeanAll.json?.data?.list || [];
    check('学管「全部」视图含初高 + 大学两学段', new Set(allDean.map((x) => x.stage)).size === 2, [...new Set(allDean.map((x) => x.stage))].join(','));

    /* ============ E. ★ 跨库按学号去重（最容易写反的一条） ============ */
    const rPrinAll = await req(`${API}/list?page=1&size=200`, { token: tPrincipal });
    const allPrin = rPrinAll.json?.data?.list || [];
    const dupRows = allPrin.filter((x) => x.studentNo === 'DUP001');
    check('★ 同学号合并后只出现 1 条', dupRows.length === 1, `实际 ${dupRows.length} 条`);
    check(
      '★ 保留的是就业部那条（emp > class > jh）',
      dupRows[0]?.stage === 'emp' && dupRows[0]?.studentName === '自检-重复号-就业那条',
      `拿到 stage=${dupRows[0]?.stage} name=${dupRows[0]?.studentName}`,
    );
    // 单学段查询不去重（同一张表内学号本就唯一）
    const dupInClass = byStage.class.filter((x) => x.studentNo === 'DUP001');
    check('单学段视图保留大学那条（不去重）', dupInClass.length === 1 && dupInClass[0].stage === 'class');

    /* ============ F. 统计卡片 = 列表（同一套筛选、同一套去重） ============ */
    const sumAll = await req(`${API}/summary`, { token: tPrincipal });
    const sum = sumAll.json?.data || {};
    check('summary 统计总数 = 列表总数', sum.total === allPrin.length, `summary=${sum.total} list=${allPrin.length}`);
    check(
      'summary 在读数与列表口径一致',
      sum.studying === allPrin.filter((x) => x.studentStatus === ST.STUDYING).length,
      `studying=${sum.studying}`,
    );

    // 带筛选时也要一致
    const kw = '自检-大学生';
    const lKw = await req(`${API}/list?keyword=${encodeURIComponent(kw)}`, { token: tPrincipal });
    const sKw = await req(`${API}/summary?keyword=${encodeURIComponent(kw)}`, { token: tPrincipal });
    check(
      '★ 带 keyword 筛选时 summary 仍 = list',
      sKw.json?.data?.total === lKw.json?.data?.total && lKw.json.data.total > 0,
      `sum=${sKw.json?.data?.total} list=${lKw.json?.data?.total}`,
    );

    /* ============ G. 详情 ============ */
    const dJob = await req(`${API}/detail?stage=emp&id=${sJob.id}`, { token: tPrincipal });
    check(
      '就业部详情返回统一结构（base/profile/market/flows）',
      isOk(dJob) &&
        dJob.json?.data?.base?.studentNo === 'U0003' &&
        !!dJob.json?.data?.profile &&
        Array.isArray(dJob.json?.data?.flows),
    );
    const dJhByWrongUser = await req(`${API}/detail?stage=jh&id=${sJh.id}`, { token: tJob });
    check('★ 无权学段查详情被拦', isBlocked(dJhByWrongUser), `code=${dJhByWrongUser.json?.code}`);
    const dNotFound = await req(`${API}/detail?stage=emp&id=${randomUUID()}`, { token: tPrincipal });
    check('不存在的学生返回业务错误（非 200）', isBlocked(dNotFound));

    /* ============ H. 写：新增 / 修改 / 学号重复 / 校验 ============ */
    const newNo = 'NEW' + Math.random().toString(36).slice(2, 7).toUpperCase();
    const created = await req(`${API}/save`, {
      method: 'POST',
      token: tHead,
      body: {
        stage: 'class',
        studentNo: newNo,
        studentName: '自检-新建',
        gender: 2,
        deptCode: 1,
        studentStatus: ST.STUDYING,
        phone: '13800000001',
        // ★ 班号新规：显式学号也必须挂班级（学号跟班级编号走）
        classId: uniCls.id,
      },
    });
    // ★ 保存接口返回的是 { id }（不是 studentId）
    check('大学学段新增学生成功', isOk(created) && !!created.json?.data?.id, created.json?.message || '');
    const newId = created.json?.data?.id;
    if (newId) reg('sms_class', 't_class_student', newId);

    // ★ 2026-10-22 学号新规：不传学号 → 自动生成 LZ + 班级编号 + 3 位序号
    const autoNo = await req(`${API}/save`, {
      method: 'POST',
      token: tHead,
      body: { stage: 'class', studentName: '自检-自动学号', gender: 1, deptCode: 1, studentStatus: ST.STUDYING, classId: uniCls.id },
    });
    const autoNoId = autoNo.json?.data?.id;
    if (autoNoId) reg('sms_class', 't_class_student', autoNoId);
    const autoRow = autoNoId ? await probe(dbCls, 'sms_class', 't_class_student', 'class').where({ id: autoNoId }).first() : null;
    check(
      '★ 不传学号 → 自动生成 LZ+班级编号+序号（新规）',
      isOk(autoNo) && new RegExp('^LZ' + uniCls.classCode + '\\d{3}$').test(String(autoRow?.student_no)),
      `学号=${autoRow?.student_no}`,
    );

    /* ★ 2026-10-22 学号新规：学号一律自动生成，前端手填值被忽略 ——
       「同学号建两次」不再可能撞号，改为断言「两次拿到的学号都是 LZ 且互不相同」。 */
    const dupNo = await req(`${API}/save`, {
      method: 'POST',
      token: tHead,
      body: { stage: 'class', studentNo: newNo, studentName: '自检-重号', gender: 1, deptCode: 1, classId: uniCls.id },
    });
    const dupNoId = dupNo.json?.data?.id;
    if (dupNoId) reg('sms_class', 't_class_student', dupNoId);
    const firstRow = newId ? await probe(dbCls, 'sms_class', 't_class_student', 'class').where({ id: newId }).first() : null;
    const dupRow = dupNoId ? await probe(dbCls, 'sms_class', 't_class_student', 'class').where({ id: dupNoId }).first() : null;
    check(
      '★ 显式学号被忽略 → 自动生成 LZ 学号且互不相同（新规）',
      isOk(dupNo) &&
        /^LZ/.test(String(firstRow?.student_no)) &&
        /^LZ/.test(String(dupRow?.student_no)) &&
        dupRow?.student_no !== firstRow?.student_no,
      `${firstRow?.student_no} vs ${dupRow?.student_no}`,
    );

    const noName = await req(`${API}/save`, {
      method: 'POST',
      token: tHead,
      body: { stage: 'class', studentNo: 'X' + Date.now().toString(36).toUpperCase(), studentName: '', gender: 1, deptCode: 1 },
    });
    check('姓名为空被拦', isBlocked(noName));

    const noDept = await req(`${API}/save`, {
      method: 'POST',
      token: tHead,
      body: { stage: 'class', studentNo: 'Y' + Date.now().toString(36).toUpperCase(), studentName: '自检-无部门', gender: 1 },
    });
    check('★ 大学学段缺部门被拦（列NOT NULL）', isBlocked(noDept), noDept.json?.message || '');

    const noStage = await req(`${API}/save`, {
      method: 'POST',
      token: tHead,
      body: { studentNo: 'Z' + Date.now().toString(36).toUpperCase(), studentName: '自检-无学段', gender: 1 },
    });
    check('stage 缺失被拦', isBlocked(noStage));

    const badDate = await req(`${API}/save`, {
      method: 'POST',
      token: tHead,
      body: { stage: 'class', studentNo: 'W' + Date.now().toString(36).toUpperCase(), studentName: '自检-坏日期', gender: 1, deptCode: 1, birthDate: '2020/01/01' },
    });
    check('日期格式错误被拦（YYYY-MM-DD）', isBlocked(badDate));

    // 修改：改手机号后回读
    const updated = await req(`${API}/save`, {
      method: 'POST',
      token: tHead,
      body: { stage: 'class', id: newId, studentNo: newNo, studentName: '自检-新建', gender: 2, deptCode: 1, phone: '13900000002' },
    });
    const reread = await req(`${API}/detail?stage=class&id=${newId}`, { token: tHead });
    check(
      '★ 修改落库正确（回读手机号）',
      isOk(updated) && reread.json?.data?.base?.phone === '13900000002',
      `phone=${reread.json?.data?.base?.phone}`,
    );

    /* ============ I. 写守门：只读管理员 / 无权学段 ============ */
    const adminSave = await req(`${API}/save`, {
      method: 'POST',
      token: tAdmin,
      body: { stage: 'class', studentNo: 'A' + Date.now().toString(36).toUpperCase(), studentName: '只读管理员', gender: 1, deptCode: 1 },
    });
    check('★ 只读管理员写被拦', isBlocked(adminSave), `HTTP ${adminSave.status}`);

    const jhSaveJob = await req(`${API}/save`, {
      method: 'POST',
      token: tJhHead,
      body: { stage: 'job', studentNo: 'B' + Date.now().toString(36).toUpperCase(), studentName: '越权写', gender: 1, deptCode: 1 },
    });
    check('★ 初高账号往job 库写被拦', isBlocked(jhSaveJob));

    /* ============ J. 逻辑删除 ============ */
    const del = await req(`${API}/delete?stage=class&id=${newId}`, { method: 'DELETE', token: tHead });
    const afterDel = await req(`${API}/list?stage=class&keyword=${newNo}`, { token: tHead });
    check(
      '★ 删除后列表查不到（逻辑删除生效）',
      isOk(del) && (afterDel.json?.data?.total || 0) === 0,
      `code=${del.json?.code} total=${afterDel.json?.data?.total}`,
    );
    const raw = newId
      ? await probe(dbCls, 'sms_class', 't_class_student', 'class').where({ id: newId }).first()
      : null;
    check('数据库里是软删（is_deleted=1）而不是物理删除', !!raw && Number(raw.is_deleted) === 1);

    /* ============ K. 元信息 / 班级下拉 ============ */
    const meta = await req(`${API}/meta`, { token: tPrincipal });
    const metas = meta.json?.data || [];
    check('meta 返回 3 个学段（jh/class/emp，就业与教务已删）', metas.length === 3, metas.map((m) => m.stage).join(','));
    check('meta 含阶段码选项与区块声明', metas.every((m) => Array.isArray(m.phaseOptions) && Array.isArray(m.sections)));

    const metaJh = await req(`${API}/meta`, { token: tJhHead });
    check('meta 权限隔离：sunmin 只拿到 1 个学段', (metaJh.json?.data || []).length === 1);

    const cls = await req(`${API}/classes`, { token: tPrincipal });
    const clsList = cls.json?.data || [];
    // ★ 2026-10-22：学生档案收成三学段（教务/就业入口已删）
    check('班级下拉合并 3 学段（jh/class/emp）', new Set(clsList.map((c) => c.stage)).size === 3, clsList.length + ' 项');
    check('班级下拉含就业部班级', clsList.some((c) => c.stage === 'emp'));

    /* ============ L. 分页 ============ */
    const p1 = await req(`${API}/list?stage=class&page=1&size=1`, { token: tHead });
    const p2 = await req(`${API}/list?stage=class&page=2&size=1`, { token: tHead });
    check(
      '分页生效（size=1 时两页不同）',
      (p1.json?.data?.list || []).length === 1 && p2.json?.data?.list?.length === 1 && p1.json.data.list[0].studentId !== p2.json.data.list[0].studentId,
    );

    /* ============ M. 业务事实：教务/就业学段入口已删（2026-10-22 用户口径） ============ */
    const dEduGone = await req(`${API}/detail?stage=edu&id=${sEdu.id}`, { token: tEdu });
    check('★ edu 学段已删 → 详情被拦（40000/403）', isBlocked(dEduGone), `code=${dEduGone.json?.code}`);
    const dJobGone = await req(`${API}/detail?stage=job&id=${sJob.id}`, { token: tJob });
    check('★ job 学段已删 → 详情被拦', isBlocked(dJobGone), `code=${dJobGone.json?.code}`);
  } catch (e) {
    console.log('\n💥 脚本异常：', e && e.stack ? e.stack : e);
    check('脚本执行未抛异常', false, String(e && e.message));
  } finally {
    /* ============ 清理：精确删掉自己造的夹具 ============ */
    try {
      for (const [dbName, table, id] of fixtures) {
        if (!id) continue;
        const map = { sms_class_jh: dbJh, sms_class: dbCls, sms_job: dbJob, sms_edu: dbEdu, sms_common: uniDb };
        await map[dbName]?.(table).where({ id }).del();
      }
      // ★ 第4期步骤2：切读时去重夹具落在统一表，直查老库会误报「残留」
      const left = await probe(dbJob, 'sms_job', 't_student_base', 'job').where('student_no', 'DUP001').count({ c: '*' }).first();
      check('清理干净（job 库 DUP001 残留 0 条）', Number(left.c) === 0, `残留 ${left.c}`);
    } catch (e) {
      console.log('清理异常（需人工核查）：', e.message);
    }
    killAll();
    console.log('\n');
    summary();
    process.exit(0);
  }
})();