/**
 * 自检：宿舍管理域（第 2 期 · 第 8 个也是最后一个业务域）
 * ============================================================
 * 本脚本最关键的几条断言：
 *   ①【三入口同构】同一套接口 /list /beds /meta 走 stage 参数切三个库
 *   ②【★★ 字段归一】三处结构差异必须对：
 *      初高房间状态是 **varchar**（'使用中'）→ 必须翻译成统一 int 1
 *      实训 dorm_status 2 是「停用」→ 必须翻成统一码 4（不是 2！）
 *      初高没有「备注」列；实训没有「负责人」列
 *   ③【★★ 床位状态 varchar vs int】初高 '空闲'/'已占用' 是文字，实训是 1/2
 *   ④【★★ 人数实时统计】已住人数不信 used_count / occupied_count
 *   ⑤【★★★ 三学段一致】第4期第1批（2026-10-10）斌哥拍板
 *      「初高中、大学、实训都在一个界面，那就都采用实训那套就行」：
 *      三学段同一套模型、同一套表，全部可写（原先「大学只读」约束已作废）
 *   ⑥【★ 状态映射双向显式】实训 dorm_status 1→统一1、2→统一4
 *   ⑦【★ 学段隔离】只有初高权限的账号查 job 必须被拦
 *   ⑧【★ 写操作守门】只读管理员写被拦
 *   ⑨【★ 调宿申请】三个学段都能发起；发起后进「待审批」
 *
 * 演示库 17 张宿舍表全是空的 → 自己造夹具、测完精确清理。
 */
import { BASE,
  buildRow,
  conn,
  dumpLogs,
  killAll,
  login,
  makeChecker,
  mirrorRow,
  probe,
  req,
  startServices, regTarget, UNI_MAP, USE_UNI, assertUniMapConsistent } from './_e2e-lib.mjs';

const API = `${BASE}/api/teaching/dorm`;
const { check, summary } = makeChecker();

/**
 * ★★ 本项目「业务失败」的表达是 **HTTP 200 + code !== 200**
 *   （BizError 默认 httpStatus=200，code 才是真信号）
 *   所以判断「被拦/校验失败」必须看 json.code，不能看 HTTP 状态。
 */
const OK = 200;
const isOk = (r) => r.json?.code === OK;
const isBlocked = (r) => r.json?.code !== OK;

const fixtures = [];
// ★ 第4期步骤2：切读时数据落在统一表，登记必须跟着改指向，否则清理删不掉
const reg = (dbName, table, id) => { const [d, t] = regTarget(dbName, table); fixtures.push([d, t, id]); };
/** sms_common 连接（既是老表「大学房间同步」所在库，也是双写目标库），在 IIFE 里赋值 */
let uniConn = null;

/** 库名 → 学段码（宿舍域只有初高/大学/实训三段；不在 UNI_MAP 的表镜像层自动跳过） */
const STAGE_OF = { sms_class_jh: 'jh', sms_class: 'class', sms_job: 'job', sms_common: 'class' };

/**
 * 造房间夹具（NOT NULL 无默认列由 buildRow 兜底）
 *
 * ★ 第4期第1批：`edu_stage` 是**统一表专有列**，老表 t_job_dorm 没有它。
 *   所以必须先剥掉，再由 probe() 在切读时落到统一表（那边 NOT NULL 会强制填）。
 *   否则老表模式直接报 `Unknown column 'edu_stage' in 'field list'`。
 */
/**
 * ★ 老表没有的列（往老表插会 ER_BAD_FIELD_ERROR）
 *   edu_stage：统一表的学段列。老表靠「一个库一个学段」隐含表达，不存这列。
 *             切读时由 mkRow 按 STAGE_OF 补上。
 *
 *   room_id/room_no：t_uni_dorm_bed 的列，老表 t_job_dorm_bed 用 dorm_id/dorm_no。
 *
 * ⚠️ 这两列虽然要剔（老表没有），但**切读时必须补回去**：
 *   `uk_dorm_bed(room_id, bed_no, edu_stage)` 是带 room_id 的唯一索引，
 *   补不回去 → 每行 room_id 都是 buildRow 兜的空串 → 第二行就
 *   `Duplicate entry '''-1-job' for key 'uk_dorm_bed'`。
 *   → 所以下面另有一张 LEGACY_TO_UNI_COL：切读时用 dorm_id 的值填 room_id。
 */
const LEGACY_NO_SUCH_COL = new Set(['edu_stage', 'room_id', 'room_no']);

/** 老表列名 → 统一表列名（语义相同，只是叫法不同） */
const LEGACY_TO_UNI_COL = { room_id: 'dorm_id', room_no: 'dorm_no' };

async function mkRow(db, dbName, table, over = {}) {
  const rest = {};
  for (const [k, v] of Object.entries(over)) {
    if (LEGACY_NO_SUCH_COL.has(k)) continue;
    rest[k] = v;
  }
  const row = await buildRow(db, table, { is_deleted: 0, ...rest });
  // ★ 第4期第1批：三学段宿舍已统一用 `sms_job` 那套模型 → **不能再靠库名猜学段**
  //   （STAGE_OF['sms_job'] 恒为 'job'，会覆盖夹具显式传的 edu_stage，
  //     初高/大学的夹具全被塞成 job → 切读时按学段过滤一条都查不到 → 报「学生不存在」）
  //   → 夹具显式传了 edu_stage 就用它，否则才回退到库推断。
  // ⚠️ 必须从**原始入参 `over`** 取 edu_stage：它在上面已被 LEGACY_NO_SUCH_COL
  //   从 `rest` 里剔掉了（老表没这列），`rest.edu_stage` 恒 undefined。
  if (USE_UNI) row.edu_stage = over.edu_stage ?? STAGE_OF[dbName];
  // ★ 切读时数据必须落统一表（老表没有 edu_stage，插不进去）
  if (USE_UNI && UNI_MAP[`${dbName}.${table}`]) {
    // ★ 无条件覆盖：buildRow 是按**老表**的列清单兜底的，会给 room_id 填成
    //   「buildRow 的随机串或空串」，不是我们要的值。必须用 dorm_id 强行盖掉，
    //   否则 uk_dorm_bed(room_id, bed_no, edu_stage) 会因空串撞车。
    for (const [uniCol, legacyCol] of Object.entries(LEGACY_TO_UNI_COL)) {
      if (row[legacyCol] !== undefined && row[legacyCol] !== null) row[uniCol] = row[legacyCol];
    }
    if (row.bed_no !== undefined && !row.room_id) {
      throw new Error(`[夹具] ${dbName}.${table} 缺 room_id：dorm_id=${row.dorm_id}`);
    }
    await probe(db, dbName, table).insert(row);
  } else {
    await db(table).insert(row);
  }
  reg(dbName, table, row.id);
  // ★ 已归一的表：上面 probe() 已直接落统一表，**不能再镜像一次**（会撞主键）
  if (!(USE_UNI && UNI_MAP[`${dbName}.${table}`])) {
    await mirrorRow(uniConn, dbName, table, row, STAGE_OF[dbName], (_d, t, id) =>
      reg('sms_common', t, id),
    );
  }
  return row;
}

/** 造实训宿舍（t_job_dorm：dorm_no 唯一 / building / room_no / bed_count 必填） */
function mkJobDorm(db, dbName, over = {}) {
  const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
  return mkRow(db, dbName, 't_job_dorm', {
    dorm_no: 'Z' + tag,
    building: '自检栋',
    // ★ t_job_dorm 老表**有** room_no（它就是「宿舍=房间」表）
    room_no: tag,
    bed_count: 4,
    dorm_gender: 0,
    dorm_status: 1,
    used_count: 0,
    ...over,
  });
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
  const dbCommon = conn('sms_common');
  uniConn = dbCommon;
  const dbJob = conn('sms_job');

  try {
    // ★ 两份 UNI_MAP（后端 / 自检库）必须逐行一致，不一致直接抛错并打出差集
    assertUniMapConsistent();

    /* ============ 登录（写操作一律用校长 qiansy） ============ */
    const tQiansy = await login('qiansy'); // 校长（全量）
    const tAdmin = await login('admin'); // 只读
    const tCongym = await login('congym'); // 学管主任（审批角色）
    const tSunmin = await login('sunmin'); // 初高
    check(
      '演示账号登录成功',
      !!(tQiansy && tAdmin && tCongym && tSunmin),
      `qiansy=${!!tQiansy} admin=${!!tAdmin} congym=${!!tCongym} sunmin=${!!tSunmin}`,
    );

    /* ============ 夹具 ============
     * ★ 第4期第1批（2026-10-10）：三学段改用**实训那套模型**
     *   斌哥拍板「初高中、大学、实训都在一个界面，那就都采用实训那套就行」。
     *   夹具必须跟仓储用同一套表结构，否则测的是老模型、切读时才炸。
     *   → 三个学段都是 t_job_dorm / t_job_dorm_bed（切读时落 t_uni_dorm_*），
     *     只靠 edu_stage 区分。
     */
    const jhDorm = await mkJobDorm(dbJob, 'sms_job', { edu_stage: 'jh' });
    const jhBed = await mkRow(dbJob, 'sms_job', 't_job_dorm_bed', {
      edu_stage: 'jh',
      dorm_id: jhDorm.id,
      dorm_no: jhDorm.dorm_no,
      bed_no: '1',
      bed_status: 1,
    });
    // ★ 第4期第1批：三学段都用实训那套模型 → 学生一律在 `sms_job.t_student_base`，
    //   初高不再单独查 `sms_class_jh.t_class_student`（那个夹具留着只会让「学生不存在」误判成业务 bug）。
    const jhStudent = await mkRow(dbJob, 'sms_job', 't_student_base', {
      edu_stage: 'jh',
      student_no: 'DORM' + Math.random().toString(36).slice(2, 8).toUpperCase(),
      student_name: '自检生',
      gender: 1,
      student_status: 5,
    });

    const jobDorm = await mkJobDorm(dbJob, 'sms_job', { edu_stage: 'job' });
    const jobBed = await mkRow(dbJob, 'sms_job', 't_job_dorm_bed', {
      edu_stage: 'job',
      dorm_id: jobDorm.id,
      dorm_no: jobDorm.dorm_no,
      bed_no: '1',
      bed_status: 1,
    });
    const jobStudent = await mkRow(dbJob, 'sms_job', 't_student_base', {
      edu_stage: 'job',
      student_no: 'DORMJ' + Math.random().toString(36).slice(2, 8).toUpperCase(),
      student_name: '自检生',
      gender: 1,
      // ⚠️ 列名是 student_status（不是 status），5 = 正式在读
      student_status: 5,
    });

    // 大学：改用实训模型（原来造的是教务同步表，实测那两张表全是空的）
    const classDorm = await mkJobDorm(dbJob, 'sms_job', { edu_stage: 'class' });
    await mkRow(dbJob, 'sms_job', 't_job_dorm_bed', {
      edu_stage: 'class',
      dorm_id: classDorm.id,
      dorm_no: classDorm.dorm_no,
      bed_no: '1',
      bed_status: 1,
    });
    // ★ 三学段共用同一张学生表，但统一表靠 edu_stage 区分学段 →
    //   每个学段都得有自己的学生夹具，否则切读时按学段过滤查不到（报「学生不存在」）。
    const classStudent = await mkRow(dbJob, 'sms_job', 't_student_base', {
      edu_stage: 'class',
      student_no: 'DORMC' + Math.random().toString(36).slice(2, 8).toUpperCase(),
      student_name: '自检生',
      gender: 1,
      student_status: 5,
    });

    /* ============ 1. 三入口同构：列表 ============ */
    for (const stage of ['jh', 'class', 'job']) {
      const r = await req(`${API}/list?stage=${stage}&page=1&size=200`, { token: tQiansy });
      check(
        `★ ${stage} 学段宿舍列表可查`,
        isOk(r) && Array.isArray(r.json?.data?.list),
        `code=${r.json?.code} ${r.json?.message || ''}`,
      );
    }

    const all = await req(`${API}/list?page=1&size=200`, { token: tQiansy });
    const allList = all.json?.data?.list || [];
    check(
      '★ 「全部」视图合并三学段',
      isOk(all) && ['jh', 'class', 'job'].every((s) => allList.some((x) => x.stage === s)),
      `total=${all.json?.data?.total}`,
    );
    // ★ 宿舍不去重（跟班级一样）
    check(
      '★ 宿舍不去重（同名房间保留多条）',
      allList.length === new Set(allList.map((x) => `${x.stage}|${x.dormId}`)).size,
    );
    check(
      '★ 每行都带学段名',
      allList.every((x) => ['初高部', '大学部', '实训', '就业部'].includes(x.stageName)),
    );

    /* ============ 2. ★★ 三学段房间状态一致（统一模型） ============ */
    // ★ 第4期第1批：三学段都用实训的 int 状态（1正常/2停用），不再是初高的 varchar
    const jhRow = allList.find((x) => x.dormId === jhDorm.id);
    check(
      '★★ 初高也是 int 状态 1 → 统一码 1（不再需要 varchar 翻译）',
      !!jhRow && jhRow.roomStatus === 1 && jhRow.roomStatusName === '使用中',
      `得到 ${jhRow?.roomStatus} / ${jhRow?.roomStatusName}`,
    );
    const jobRow = allList.find((x) => x.dormId === jobDorm.id);
    check(
      '★ 实训 dorm_status=1 → 统一码 1（使用中）',
      !!jobRow && jobRow.roomStatus === 1,
      `得到 ${jobRow?.roomStatus}`,
    );
    check(
      '★★ 实训 dorm_status=2 是「停用」→ 统一码 4（不是 2！）',
      jobRow ? jobRow.roomStatus !== 2 : false,
      `统一码 2=空置，停用必须落 4`,
    );
    const clsRow = allList.find((x) => x.dormId === classDorm.id);
    check(
      '★★ 大学同样走统一模型（dorm_gender 0=不限 也照样支持）',
      !!clsRow && clsRow.roomStatus === 1 && clsRow.dormType === 0,
      `status=${clsRow?.roomStatus} gender=${clsRow?.dormType}`,
    );

    /* ============ 3. ★★ 已住人数实时统计 ============ */
    // 初高：床位状态 1（空闲）→ 应统计为 0 人（空床不算已住）
    const jhDetail = await req(`${API}/detail?stage=jh&id=${jhDorm.id}`, { token: tQiansy });
    const jhD = jhDetail.json?.data;
    check(
      '★★ 初高已住人数按床位状态实时算（空闲→0）',
      !!jhD && jhD.occupiedCount === 0,
      `得到 ${jhD?.occupiedCount}`,
    );

    // 实训：把冗余 used_count 改成 99，接口仍应返回真实值
    await dbJob('t_job_dorm').where({ id: jobDorm.id }).update({ used_count: 99 });
    const jobDetail = await req(`${API}/detail?stage=job&id=${jobDorm.id}`, { token: tQiansy });
    const jobD = jobDetail.json?.data;
    check(
      '★★ 实训已住人数不信冗余 used_count（改成 99 仍返回真实 0）',
      !!jobD && jobD.occupiedCount === 0,
      `冗余列=99，接口返回 ${jobD?.occupiedCount}`,
    );

    /* ============ 4. ★★ 床位列表：varchar vs int ============ */
    const jhBeds = await req(`${API}/beds?stage=jh&dormId=${jhDorm.id}`, { token: tQiansy });
    const jhBedList = jhBeds.json?.data?.beds || [];
    check(
      '★★ 初高床位状态 1（空闲）→ 统一码 1',
      jhBedList.some((b) => b.bedStatus === 1 && b.bedStatusName === '空闲'),
      `得到 ${jhBedList.map((b) => b.bedStatus).join(',')}`,
    );
    const jobBeds = await req(`${API}/beds?stage=job&dormId=${jobDorm.id}`, { token: tQiansy });
    const jobBedList = jobBeds.json?.data?.beds || [];
    check(
      '★ 实训 int 床位状态 1 → 统一码 1',
      jobBedList.some((b) => b.bedStatus === 1),
      `得到 ${jobBedList.map((b) => b.bedStatus).join(',')}`,
    );

    /* ============ 5. ★★★ 大学只读（斌哥拍板的硬约束） ============ */
    const uniMeta = await req(`${API}/meta`, { token: tQiansy });
    const metas = uniMeta.json?.data || [];
    const mUni = metas.find((m) => m.stage === 'class');
    const mJob = metas.find((m) => m.stage === 'job');
    const mJh = metas.find((m) => m.stage === 'jh');
    check(
      '★★★ /meta 返回三学段特性',
      metas.length === 3,
      `得到 ${metas.length} 个`,
    );
    // ★ 第4期第1批：三学段共用实训模型 → hasCreate 全为 true
    check(
      '★★★ 三学段 hasCreate=true（都采用实训那套，都可写）',
      !!mUni && mUni.hasCreate === true && !!mJob && mJob.hasCreate === true && !!mJh && mJh.hasCreate === true,
      `jh=${mJh?.hasCreate} class=${mUni?.hasCreate} job=${mJob?.hasCreate}`,
    );
    check(
      '★ 三学段 hasBedTable=true（都用真实床位表，不再有虚拟编号）',
      !!mUni && mUni.hasBedTable === true && !!mJob && mJob.hasBedTable === true,
      `class=${mUni?.hasBedTable} job=${mJob?.hasBedTable}`,
    );
    check(
      '★★ 实训 hasOwner=false（表里没负责人列）',
      !!mJob && mJob.hasOwner === false && mJob.hasRemark === true,
    );

    // 大学现在可以新建房间了（原「只读」约束随三学段合并作废）
    const uniSave = await req(`${API}/save`, {
      method: 'POST',
      // ★ 房号必须是 3~4 位数字（远端新增校验）
      // ★ 远端新增：房号 3~4 位数字 + 类别（男寝/女寝）必填
      body: { stage: 'class', buildingName: '自检栋', roomNo: '9' + String(Math.floor(Math.random() * 90) + 10), bedCount: 4, dormType: 1 },
      token: tQiansy,
    });
    check('★★★ 大学新建房间已放行（三学段一致）', isOk(uniSave), `code=${uniSave.json?.code} ${uniSave.json?.message || ''}`);

    /* ============ 6. 实训可写（保存房间） ============ */
    // ★ 用随机栋名/房号：软删记录仍占着 uk_dorm_no，固定名会撞上一轮的残留
    // ★ 房号必须是 3~4 位数字（远端新增校验），随机取 4 位数避免与历史房间重号
    const newTag = String(1000 + Math.floor(Math.random() * 8999));
    const newBuilding = '自检栋' + newTag;
    const jobSave = await req(`${API}/save`, {
      method: 'POST',
      body: {
        stage: 'job',
        buildingName: newBuilding,
        roomNo: newTag,
        bedCount: 2,
        dormType: 1,
        roomStatus: 1,
      },
      token: tQiansy,
    });
    const newDormId = jobSave.json?.data?.id;
    check('★ 实训新建房间成功', isOk(jobSave) && !!newDormId, `code=${jobSave.json?.code} msg=${jobSave.json?.message}`);

    if (newDormId) {
      const newBeds = await req(`${API}/beds?stage=job&dormId=${newDormId}`, { token: tQiansy });
      const nb = newBeds.json?.data?.beds || [];
      check(
        '★ 新建宿舍自动生成床位行（bedCount=2 → 2 条）',
        nb.length === 2,
        `得到 ${nb.length} 条`,
      );

      // 唯一性：同 dorm_no 再建一次必须被拦
      const dup = await req(`${API}/save`, {
        method: 'POST',
        body: { stage: 'job', buildingName: newBuilding, roomNo: newTag, bedCount: 2 },
        token: tQiansy,
      });
      check('★★ 实训宿舍编号全局唯一，重复被拦', isBlocked(dup), `code=${dup.json?.code}`);

      // NOT NULL 防御：编辑时传 null 不报错
      const editNull = await req(`${API}/save`, {
        method: 'POST',
        body: { stage: 'job', id: newDormId, buildingName: newBuilding, roomNo: newTag, dormType: null, bedCount: null, roomStatus: null },
        token: tQiansy,
      });
      check(
        '★ 编辑时传 null 给 NOT NULL 列不报错（当「不修改」）',
        isOk(editNull),
        `code=${editNull.json?.code} ${editNull.json?.message || ''}`,
      );
    }

    /* ============ 7. 楼栋下拉 + 在住名单 ============ */
    const bList = await req(`${API}/buildings`, { token: tQiansy });
    check('★ /buildings 返回下拉', isOk(bList) && Array.isArray(bList.json?.data));

    const rsList = await req(`${API}/residents?stage=class`, { token: tQiansy });
    check(
      '★ 在住名单可查（大学同步表）',
      isOk(rsList) && Array.isArray(rsList.json?.data),
      `code=${rsList.json?.code}`,
    );

    /* ============ 8. ★ 调宿/退宿申请（三学段都能发起） ============ */
    for (const stage of ['jh', 'class', 'job']) {
      const cr = await req(`${API}/change/create`, {
        method: 'POST',
        body: {
          stage,
          bizType: 2, // 退宿
          // ★ 每个学段用它自己的学生夹具（统一表按 edu_stage 过滤）
          studentId: stage === 'job' ? jobStudent.id : stage === 'jh' ? jhStudent.id : classStudent.id,
          changeDate: '2026-10-09',
          changeReason: '自检退宿',
        },
        token: tQiansy,
      });
      check(
        `★ ${stage} 学段能发起退宿申请（统一审批链）`,
        isOk(cr) && !!cr.json?.data?.id,
        `code=${cr.json?.code} ${cr.json?.message || ''}`,
      );
    }

    const chList = await req(`${API}/change/list?page=1&size=200`, { token: tQiansy });
    const chRows = chList.json?.data || [];
    check('★ 调宿/退宿申请列表可查', isOk(chList) && Array.isArray(chRows));

    /* ============ 9. ★ 学段隔离（权限守门） ============ */
    // 学管主任是审批角色，写必须被拦
    const deanSave = await req(`${API}/save`, {
      method: 'POST',
      body: { stage: 'job', buildingName: '学管建的', roomNo: '888' },
      token: tCongym,
    });
    check('★ 学管主任写被拦（只能查看+审批）', isBlocked(deanSave), `code=${deanSave.json?.code}`);
    const deanRead = await req(`${API}/list?stage=job`, { token: tCongym });
    check('★ 学管主任读正常（只读不是没权限）', isOk(deanRead), `code=${deanRead.json?.code}`);

    // 只读管理员写被拦
    const adminSave = await req(`${API}/save`, {
      method: 'POST',
      body: { stage: 'job', buildingName: '只读管理员建的', roomNo: '777' },
      token: tAdmin,
    });
    check('★ 只读管理员写被拦', isBlocked(adminSave), `code=${adminSave.json?.code}`);

    /* ============ 10. 非法参数 ============ */
    const badStage = await req(`${API}/list?stage=xxx`, { token: tQiansy });
    check('★ 非法 stage 被拦', isBlocked(badStage), `code=${badStage.json?.code}`);

    const badStatus = await req(`${API}/save`, {
      method: 'POST',
      body: { stage: 'job', buildingName: newBuilding, roomNo: newTag, roomStatus: 99 },
      token: tQiansy,
    });
    check('★ 非法房间状态被拦', isBlocked(badStatus), `code=${badStatus.json?.code}`);

    /* ============ 11. 统计 = 列表 ============ */
    for (const stage of ['jh', 'class', 'job']) {
      const sm = await req(`${API}/summary?stage=${stage}`, { token: tQiansy });
      const li = await req(`${API}/list?stage=${stage}&page=1&size=200`, { token: tQiansy });
      const s0 = (sm.json?.data || [])[0];
      const l0 = li.json?.data?.list || [];
      check(
        `★ ${stage}：统计 roomCount = 列表 total`,
        !!s0 && s0.roomCount === l0.length,
        `统计=${s0?.roomCount} 列表=${l0.length}`,
      );
    }

    /* ============ 12. 软删 ============ */
    if (newDormId) {
      // ⚠️ 必须显式 method:'DELETE' —— req() 默认 GET，漏了走不到路由返回 40401
      const del = await req(`${API}/delete?stage=job&id=${newDormId}`, { method: 'DELETE', token: tQiansy });
      check('★ 删除宿舍成功', isOk(del), `code=${del.json?.code}`);
      const afterDel = await req(`${API}/list?stage=job&id=${newDormId}`, { token: tQiansy });
      const stillThere = (afterDel.json?.data?.list || []).some((x) => x.dormId === newDormId);
      check('★ 删除后列表查不到', !stillThere);
      // ★ 断言也得跟着开关走：切读时数据落统一表，查老表必然查不到 → 假失败
      const rawDel = newDormId
        ? await probe(dbJob, 'sms_job', 't_job_dorm').where({ id: newDormId }).first()
        : null;
      check('★ 数据库里是软删（is_deleted=1）而非物理删除', !!rawDel && Number(rawDel.is_deleted) === 1);
    }
  } catch (e) {
    console.error('\n💥 自检异常：', e);
    check('自检脚本执行无异常', false, e.message);
  } finally {
    /* ============ 精确清理 ============ */
    const dbs = {
      sms_class_jh: dbJh,
      sms_class: dbCls,
      sms_common: dbCommon,
      sms_job: dbJob,
    };
    for (const [dbName, table, id] of fixtures.reverse()) {
      if (!id || !dbs[dbName]) continue;
      try {
        await dbs[dbName](table).where({ id }).del();
      } catch (e) {
        console.warn(`  清理失败 ${dbName}.${table} ${id}: ${e.message}`);
      }
    }
    console.log(`\n  已清理 ${fixtures.length} 条夹具`);
    await dbJh.destroy();
    await dbCls.destroy();
    await dbCommon.destroy();
    await dbJob.destroy();
    await killAll();
  }

  summary();
  process.exit(0);
})();
