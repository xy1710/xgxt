/**
 * 演示种子数据（教学管理初高）——幂等
 *
 * 执行：npm run seed:class-jh      （等价于 node scripts/seed-class-jh-demo.js）
 * 特点：所有记录使用固定 ID / 唯一键，重复执行只做「存在则跳过」，不报错、不重复。
 *
 * 生成内容：系统设置项、4 个班级、32 名学生、楼栋/房间/床位/入住、出勤台账+明细、
 *          考试+成绩+自定义字段、缴费台账、退费单、流程单、操作日志。
 *
 * ★ 2026-10-05 并入统一门户版时改了两处：
 *   ① 连的库从 knexfile 的 `development`（那是就业库 sms_job！）
 *      改成 `'class-jh'`（sms_class_jh）—— 不改的话会把初高的演示数据灌进就业库。
 *   ② 脚本从 server-class/seeds/ 挪到 server-job/scripts/ 下，仍是 server-job 的下一级，
 *      所以 `require('../knexfile.js')` 依然指向正确位置，不用动。
 */

require('dotenv').config();
const knexLib = require('knex');
const dbConfig = require('../knexfile.js')['class-jh'];
const db = knexLib(dbConfig);

/* ============================================================
 * 工具
 * ============================================================ */

const NOW = () => new Date();
const today = () => new Date().toISOString().slice(0, 10);
const dateOffset = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};

/** 存在则跳过（按 id） */
async function ensure(table, id, data) {
  const row = await db(table).where({ id }).first();
  if (row) return false;
  await db(table).insert({ id, ...data, is_deleted: false, create_time: NOW(), create_by: 'seed' });
  return true;
}

/** 存在则跳过（按自定义条件） */
async function ensureBy(table, where, data) {
  const row = await db(table).where(where).first();
  if (row) return false;
  await db(table).insert({ ...data, is_deleted: false, create_time: NOW(), create_by: 'seed' });
  return true;
}

/* ============================================================
 * 1. 系统设置
 * ============================================================ */

const SETTINGS = [
  { key: 'attendanceTargetRate', name: '出勤率目标（%）', value: '90', remark: '低于该值告警' },
  {
    key: 'attendanceScope',
    name: '出勤统计口径',
    value: JSON.stringify({ shouldStatuses: [3, 4, 5], presentStatuses: [1, 2] }),
    remark: '分母=在读/试学/预读，分子=出勤+迟到',
  },
  { key: 'feeRemindDays', name: '催费提前提醒天数', value: '7', remark: '剩余天数<=该值标红' },
  { key: 'feeUrgeWindowDays', name: '催费列表窗口天数', value: '20', remark: '到期日距今<=该值才进催费列表（含已逾期）' },
  { key: 'refundThresholdAmount', name: '退费审批阈值（分）', value: '500000', remark: '超阈值走校长审批' },
  { key: 'closedClassIntakeTypes', name: '封班可转入类型', value: JSON.stringify([1, 2]), remark: '休学复学/末班' },
  { key: 'allowStudentAdd', name: '是否允许手动新增学生', value: 'false', remark: '默认关闭' },
];

async function seedSettings() {
  for (const s of SETTINGS) {
    await ensureBy(
      't_class_setting',
      { setting_key: s.key },
      {
        id: `seed-set-${s.key}`,
        setting_key: s.key,
        setting_name: s.name,
        setting_value: s.value,
        remark: s.remark,
      },
    );
  }
}

/* ============================================================
 * 2. 学习阶段字典（★ 2026-10-16 改成「阶段方案 → 多个阶段」）
 * ============================================================ */

/** 阶段方案（一个部门一个默认方案） */
const STAGE_PLANS = [
  { id: 'seed-plan-jh', name: '初高部阶段方案', dept: 1 },
  { id: 'seed-plan-uni', name: '大学部阶段方案', dept: 2 },
];

async function seedStagePlans() {
  let i = 0;
  for (const p of STAGE_PLANS) {
    await ensure('t_class_stage_plan', p.id, { plan_name: p.name, dept_code: p.dept, sort_no: i });
    i += 1;
  }
}

const STAGES = [
  { code: 101, name: '预科', dept: 1, months: 3 },
  { code: 102, name: '初中部1期', dept: 1, months: 6 },
  { code: 103, name: '初中部2期', dept: 1, months: 6 },
  { code: 104, name: '初中部3期', dept: 1, months: 6 },
  { code: 105, name: '高中部1期', dept: 1, months: 6 },
  { code: 106, name: '高中部2期', dept: 1, months: 6 },
  { code: 107, name: '高中部3期', dept: 1, months: 6 },
  { code: 201, name: '一阶段', dept: 2, months: 4 },
  { code: 202, name: '二阶段', dept: 2, months: 4 },
  { code: 203, name: '三阶段', dept: 2, months: 4 },
  { code: 204, name: '四阶段', dept: 2, months: 4 },
];

/** 部门 → 默认方案 ID */
const DEFAULT_PLAN = { 1: 'seed-plan-jh', 2: 'seed-plan-uni' };

async function seedStages() {
  let i = 0;
  for (const s of STAGES) {
    await ensureBy(
      't_class_stage',
      { stage_code: s.code, dept_code: s.dept },
      {
        id: `seed-stage-${s.code}`,
        stage_code: s.code,
        stage_name: s.name,
        dept_code: s.dept,
        plan_id: DEFAULT_PLAN[s.dept],
        study_months: s.months,
        sort_no: i,
      },
    );
    i += 1;
  }
}

/* ============================================================
 * 2b. 阶段方案（★ 2026-10-16 新增：阶段字典升级为「方案 + 多阶段」）
 *
 *   一个部门一个默认方案，阶段明细直接取自上面的 STAGES ——
 *   让「系统设置 · 阶段方案」页和班级表单开箱就有数据可选。
 *   按（方案名 + 部门）判重：迁移里已搬过的不会被重复插入。
 * ============================================================ */

const SCHEMES = [
  { id: 'seed-scheme-1', name: '初高部阶段方案', dept: 1 },
  { id: 'seed-scheme-2', name: '大学部阶段方案', dept: 2 },
];

async function seedStageSchemes() {
  for (const sc of SCHEMES) {
    await ensureBy(
      't_class_stage_scheme',
      { scheme_name: sc.name, dept_code: sc.dept },
      { id: sc.id, scheme_name: sc.name, dept_code: sc.dept, sort_no: sc.dept },
    );

    const rows = STAGES.filter((s) => s.dept === sc.dept);
    let i = 0;
    for (const s of rows) {
      await ensureBy(
        't_class_stage_scheme_stage',
        { scheme_id: sc.id, stage_name: s.name },
        { id: `${sc.id}-s${i + 1}`, scheme_id: sc.id, stage_name: s.name, study_months: s.months, sort_no: i },
      );
      i += 1;
    }
  }
}

/* ============================================================
 * 3. 班级
 * ============================================================ */

const CLASSES = [
  { id: 'seed-cls-1', name: 'G104', stage: 102, status: 2, head: ['T001', '张国强'], teacher: ['T002', '李明'], room: '101' },
  { id: 'seed-cls-2', name: 'G105', stage: 103, status: 1, head: ['T003', '王海燕'], teacher: ['T004', '赵刚'], room: '102' },
  { id: 'seed-cls-3', name: 'J106', stage: 105, status: 1, head: ['T005', '刘芳'], teacher: ['T006', '陈军'], room: '201' },
  { id: 'seed-cls-4', name: 'G107', stage: 106, status: 1, head: ['T007', '孙丽'], teacher: ['T008', '周涛'], room: '202' },
];

async function seedClasses() {
  for (const c of CLASSES) {
    await ensure('t_class_info', c.id, {
      class_name: c.name,
      stage: c.stage,
      head_teacher_id: c.head[0],
      head_teacher_name: c.head[1],
      teacher_id: c.teacher[0],
      teacher_name: c.teacher[1],
      assistant_id: null,
      assistant_name: null,
      classroom: c.room,
      open_date: dateOffset(-90),
      dept_code: 1,
      class_status: c.status,
      student_count: 0,
      today_attendance_rate: null,
      remark: `${c.name} 演示班级`,
    });
  }
}

/* ============================================================
 * 4. 学生（32 名）
 * ============================================================ */

const SURNAMES = ['王', '李', '张', '刘', '陈', '杨', '赵', '黄', '周', '吴', '徐', '孙', '马', '朱', '胡', '郭'];
const GIVEN = ['伟', '芳', '娜', '敏', '静', '强', '磊', '洋', '艳', '勇', '军', '杰', '娟', '涛', '明', '超'];

async function seedStudents() {
  const created = [];
  for (let i = 1; i <= 32; i++) {
    const idx = i - 1;
    const cls = CLASSES[idx % CLASSES.length];
    // 特例：3~4 试学、5 预读、6 休学、30~32 退学，其余正式在读
    let status = 5;
    if (i % 8 === 3) status = 3;
    else if (i % 8 === 5) status = 4;
    else if (i === 6) status = 6;
    if (i >= 30) status = 7;

    const gender = i % 2 === 0 ? 2 : 1;
    const name = SURNAMES[idx % SURNAMES.length] + GIVEN[idx % GIVEN.length];
    const studentNo = `S2026${String(i).padStart(4, '0')}`;
    const id = `seed-stu-${String(i).padStart(2, '0')}`;

    const ok = await ensureBy(
      't_class_student',
      { student_no: studentNo },
      {
        id,
        student_no: studentNo,
        student_name: name,
        gender,
        birth_date: dateOffset(-365 * (14 + (i % 6))),
        age: 14 + (i % 6),
        native_place: '河南郑州',
        dept_code: 1,
        class_id: cls.id,
        class_name: cls.name,
        stage: cls.stage,
        head_teacher_id: cls.head[0],
        head_teacher_name: cls.head[1],
        teacher_id: cls.teacher[0],
        teacher_name: cls.teacher[1],
        assistant_id: null,
        assistant_name: null,
        student_status: status,
        pending_flow_type: null,
        education: '初中',
        graduate_school: '郑州市实验中学',
        enroll_date: dateOffset(-80),
        phone: `1380000${String(i).padStart(4, '0')}`,
        parent_phone: `1390000${String(i).padStart(4, '0')}`,
        home_address: '河南省郑州市金水区文化路 1 号',
        id_card_no: `4101002000${String(i).padStart(4, '0')}0000`,
        agreement_status: 1,
        recruit_teacher_name: '招生张老师',
        recruit_teacher_phone: '13700000001',
        consult_teacher_name: '咨询李老师',
        consult_teacher_phone: '13700000002',
        attendance_rate: null,
        repeat_count: 0,
        remark: '演示学生',
        literacy_desc: '学习态度端正，动手能力强。',
      },
    );
    if (ok) created.push({ id, studentNo, name, gender, cls, status });
  }
  return created;
}

/** 根据学生统计回写班级人数 */
async function recalcClassCounts() {
  for (const c of CLASSES) {
    const [{ cnt }] = await db('t_class_student').where({ class_id: c.id, is_deleted: false }).count({ cnt: '*' });
    await db('t_class_info').where({ id: c.id }).update({ student_count: Number(cnt) });
  }
}

/* ============================================================
 * 5. 宿舍：楼栋 / 房间 / 床位 / 入住
 * ============================================================ */

// 楼栋本身不分男女（无 building_type 字段）；这里的 `gender` 仅用于生成房间/床位时决定房间类型。
const BUILDINGS = [
  { id: 'seed-bld-1', name: 'A栋', campus: '主校区', floors: 5, manager: '宿管老王', phone: '13600000001', gender: '男' },
  { id: 'seed-bld-2', name: 'B栋', campus: '主校区', floors: 5, manager: '宿管张姨', phone: '13600000002', gender: '女' },
];

async function seedDorm(students) {
  // 楼栋
  for (const b of BUILDINGS) {
    await ensureBy('t_class_building', { building_name: b.name }, {
      id: b.id,
      building_name: b.name,
      campus_name: b.campus,
      floor_count: b.floors,
      manager_name: b.manager,
      manager_phone: b.phone,
      dept_name: '教务部',
      building_status: '使用中',
      data_source: '教务同步',
    });
  }

  // 房间 + 床位（每栋 2 间，每间 4 床）
  // ⚠️ 房间号只在「楼栋内」唯一（uk_building_room_no）→ 不同楼栋可同名（A栋/B栋 都有 2-01）。
  const rooms = [];
  let rn = 0;
  for (const b of BUILDINGS) {
    const dormType = b.gender === '男' ? 1 : 2;
    let seq = 0; // 房间号在楼栋内从 1 重新计数
    for (let f = 2; f <= 3; f++) {
      rn += 1;
      seq += 1;
      const roomNo = `${f}-${String(seq).padStart(2, '0')}`;
      const roomId = `seed-room-${rn}`;
      // 匹配键必须是「楼栋 + 房间号」，否则第二栋的同名房间会被误判为已存在
      await ensureBy('t_class_room', { building_id: b.id, room_no: roomNo }, {
        id: roomId,
        building_id: b.id,
        building_name: b.name,
        floor_no: f,
        room_no: roomNo,
        dorm_type: dormType,
        bed_count: 4,
        occupied_count: 0,
        occupancy_rate: 0,
        owner_name: b.manager,
        data_source: '教务同步',
        room_status: '使用中',
        class_id: null,
        class_name: null,
      });
      rooms.push({ id: roomId, dormType, buildingId: b.id, buildingName: b.name, roomNo });
      for (let bed = 1; bed <= 4; bed++) {
        const bedNo = `${bed}号床`;
        const bedId = `seed-bed-${rn}-${bed}`;
        await ensure('t_class_bed', bedId, {
          room_id: roomId,
          room_no: roomNo,
          building_id: b.id,
          bed_no: bedNo,
          dorm_type: dormType,
          bed_status: '空闲',
          student_id: null,
        });
      }
    }
  }

  // 入住：给前 8 名符合性别的在住学生分派床位
  const maleRooms = rooms.filter((r) => r.dormType === 1);
  const femaleRooms = rooms.filter((r) => r.dormType === 2);
  const assignable = students.filter((s) => [3, 4, 5].includes(s.status)).slice(0, 8);
  let mi = 0;
  let fi = 0;
  let seq = 0;
  for (const s of assignable) {
    seq += 1;
    const room = s.gender === 1 ? maleRooms[mi++ % maleRooms.length] : femaleRooms[fi++ % femaleRooms.length];
    // 找该房间一个空闲未占用床位
    const bed = await db('t_class_bed').where({ room_id: room.id, bed_status: '空闲' }).whereNull('student_id').first();
    if (!bed) continue;

    const residentId = `seed-res-${String(seq).padStart(2, '0')}`;
    const residentExists = await db('t_class_dorm_resident').where({ id: residentId }).first();
    if (residentExists) continue;

    await db('t_class_dorm_resident').insert({
      id: residentId,
      student_id: s.id,
      student_no: s.studentNo,
      student_name: s.name,
      class_id: s.cls.id,
      class_name: s.cls.name,
      gender: s.gender,
      building_id: room.buildingId,
      room_id: room.id,
      room_no: room.roomNo,
      bed_id: bed.id,
      bed_no: bed.bed_no,
      check_in_date: dateOffset(-30),
      owner_name: '宿管',
      is_active: true,
      is_deleted: false,
      create_time: NOW(),
      create_by: 'seed',
    });
    await db('t_class_bed').where({ id: bed.id }).update({ bed_status: '已占用', student_id: s.id });
    await db('t_class_student').where({ id: s.id }).update({ dorm_id: room.id, dorm_no: room.roomNo, bed_no: bed.bed_no });
    const [{ cnt }] = await db('t_class_dorm_resident').where({ room_id: room.id, is_active: true, is_deleted: false }).count({ cnt: '*' });
    await db('t_class_room').where({ id: room.id }).update({
      occupied_count: Number(cnt),
      occupancy_rate: Number(((Number(cnt) / 4) * 100).toFixed(2)),
    });
  }

  // 一条待审核调宿申请（男生）
  const mStudent = assignable.find((s) => s.gender === 1);
  if (mStudent) {
    const resident = await db('t_class_dorm_resident').where({ student_id: mStudent.id, is_active: true }).first();
    const targetRoom = maleRooms.find((r) => r.id !== (resident && resident.room_id));
    if (resident && targetRoom) {
      const targetBed = await db('t_class_bed').where({ room_id: targetRoom.id, bed_status: '空闲' }).whereNull('student_id').first();
      if (targetBed) {
        await ensure('t_class_dorm_apply', 'seed-apply-1', {
          student_id: mStudent.id,
          student_no: mStudent.studentNo,
          student_name: mStudent.name,
          class_id: mStudent.cls.id,
          class_name: mStudent.cls.name,
          from_room_id: resident.room_id,
          from_room_no: resident.room_no,
          from_bed_id: resident.bed_id,
          to_room_id: targetRoom.id,
          to_room_no: targetRoom.roomNo,
          to_bed_id: targetBed.id,
          apply_reason: '希望与同班同学同住',
          apply_user_id: 'U001',
          apply_user_name: '演示用户',
          apply_time: NOW(),
          apply_status: 1,
          approve_user_id: null,
          approve_user_name: null,
          approve_time: null,
          is_item_intact: null,
          reject_reason: null,
        });
      }
    }
  }

  // 一条退宿申请记录
  const fStudent = assignable.find((s) => s.gender === 2);
  if (fStudent) {
    const resident = await db('t_class_dorm_resident').where({ student_id: fStudent.id, is_active: true }).first();
    if (resident) {
      await ensure('t_class_checkout_apply', 'seed-checkout-1', {
        student_id: fStudent.id,
        student_no: fStudent.studentNo,
        student_name: fStudent.name,
        class_id: fStudent.cls.id,
        class_name: fStudent.cls.name,
        room_id: resident.room_id,
        room_no: resident.room_no,
        bed_id: resident.bed_id,
        bed_no: resident.bed_no,
        checkout_reason: '办理走读',
        apply_user_id: 'U001',
        apply_user_name: '演示用户',
        apply_time: NOW(),
        apply_status: 1,
        approve_user_id: null,
        approve_user_name: null,
        approve_time: null,
        reject_reason: null,
      });
    }
  }
}

/* ============================================================
 * 6. 出勤台账 + 明细（对 G105）
 * ============================================================ */

async function seedAttendance() {
  const cls = CLASSES[1]; // G105
  const classStudents = await db('t_class_student')
    .where({ class_id: cls.id, is_deleted: false })
    .whereIn('student_status', [3, 4, 5]);

  const dates = [today(), dateOffset(-1)];
  let seq = 0;
  for (const d of dates) {
    seq += 1;
    const attId = `seed-att-${seq}`;
    const exists = await db('t_class_attendance').where({ id: attId }).first();
    if (exists) continue;

    const shouldCount = classStudents.length;
    let actualCount = 0;
    const details = [];
    classStudents.forEach((s, i) => {
      // 每 5 个里 1 个缺勤
      const status = i % 5 === 2 ? 5 : 1;
      if (status === 1) actualCount += 1;
      details.push({ s, status });
    });
    const rate = shouldCount > 0 ? Number(((actualCount / shouldCount) * 100).toFixed(2)) : 0;

    await db('t_class_attendance').insert({
      id: attId,
      class_id: cls.id,
      class_name: cls.name,
      attendance_date: d,
      attendance_rate: rate,
      should_count: shouldCount,
      actual_count: actualCount,
      month_unqualified_count: 0,
      teacher_id: cls.teacher[0],
      teacher_name: cls.teacher[1],
      head_teacher_id: cls.head[0],
      head_teacher_name: cls.head[1],
      file_url: 'https://example.com/attendance.xlsx',
      remark: '演示出勤',
      is_deleted: false,
      create_time: NOW(),
      create_by: 'seed',
    });

    let di = 0;
    for (const item of details) {
      di += 1;
      await db('t_class_attendance_detail').insert({
        id: `seed-attd-${seq}-${di}`,
        attendance_id: attId,
        class_id: cls.id,
        attendance_date: d,
        student_id: item.s.id,
        student_no: item.s.student_no,
        student_name: item.s.student_name,
        phone: item.s.phone,
        parent_phone: item.s.parent_phone,
        attendance_status: item.status,
        absent_reason: item.status === 5 ? '未请假缺勤' : null,
        is_deleted: false,
        create_time: NOW(),
        create_by: 'seed',
      });
    }

    // 回流出勤率到学生
    for (const s of classStudents) {
      await db('t_class_student').where({ id: s.id }).update({ attendance_rate: rate });
    }
    await db('t_class_info').where({ id: cls.id }).update({ today_attendance_rate: rate });
  }
}

/* ============================================================
 * 7. 考试 + 成绩 + 自定义字段
 * ============================================================ */

async function seedExam() {
  const cls = CLASSES[1]; // G105
  const examId = 'seed-exam-1';
  const exists = await db('t_class_exam').where({ id: examId }).first();
  if (!exists) {
    await db('t_class_exam').insert({
      id: examId,
      exam_name: '2026年10月月考',
      exam_type: 1,
      exam_date: dateOffset(-10),
      class_id: cls.id,
      class_name: cls.name,
      exam_content_types: JSON.stringify([1, 2]),
      content_full_score: JSON.stringify({ 1: 100, 2: 100 }),
      exam_status: 2,
      score_teacher_ids: JSON.stringify([cls.teacher[0]]),
      judge_ids: null,
      create_by_name: '演示用户',
      remark: '演示考试',
      is_deleted: false,
      create_time: NOW(),
      create_by: 'seed',
    });

    await db('t_class_exam_field').insert({
      id: 'seed-field-1',
      exam_id: examId,
      field_name: '实验操作',
      field_type: 2,
      sort_no: 0,
      is_deleted: false,
      create_time: NOW(),
      create_by: 'seed',
    });
  }

  const students = await db('t_class_student').where({ class_id: cls.id, is_deleted: false }).whereIn('student_status', [3, 4, 5]);
  let i = 0;
  for (const s of students) {
    i += 1;
    const scoreId = `seed-score-${String(i).padStart(2, '0')}`;
    const dup = await db('t_class_exam_score').where({ id: scoreId }).first();
    if (dup) continue;
    const w = 60 + ((i * 7) % 40);
    const m = 55 + ((i * 5) % 45);
    const total = Number((w + m).toFixed(2));
    const passed = total >= 200 * 0.6 ? 1 : 2;
    await db('t_class_exam_score').insert({
      id: scoreId,
      exam_id: examId,
      exam_type: 1,
      exam_date: dateOffset(-10),
      class_id: cls.id,
      student_id: s.id,
      student_no: s.student_no,
      student_name: s.student_name,
      score_written: w,
      score_machine: m,
      score_interview: null,
      score_other: null,
      score_total: total,
      score_teacher_id: cls.teacher[0],
      score_teacher_name: cls.teacher[1],
      exam_result: passed,
      is_passed: null,
      custom_values: JSON.stringify({ 实验操作: '合格' }),
      remark: null,
      is_deleted: false,
      create_time: NOW(),
      create_by: 'seed',
    });
  }
}

/* ============================================================
 * 8. 缴费台账 + 催费记录
 * ============================================================ */

async function seedFee(students) {
  let i = 0;
  for (const s of students) {
    i += 1;
    // 学费
    await ensure('t_class_fee', `seed-fee-${String(i).padStart(2, '0')}-1`, {
      student_id: s.id,
      student_no: s.studentNo,
      student_name: s.name,
      class_id: s.cls.id,
      class_name: s.cls.name,
      dept_code: 1,
      fee_type: 1,
      fee_amount: 1280000,
      pay_status: i % 4 === 0 ? 1 : 2,
      pay_date: i % 4 === 0 ? null : dateOffset(-20),
      expire_date: i % 4 === 0 ? dateOffset(i % 6) : dateOffset(60),
      voucher_url: i % 4 === 0 ? null : 'https://example.com/voucher.jpg',
    });
    // 住宿费
    await ensure('t_class_fee', `seed-fee-${String(i).padStart(2, '0')}-2`, {
      student_id: s.id,
      student_no: s.studentNo,
      student_name: s.name,
      class_id: s.cls.id,
      class_name: s.cls.name,
      dept_code: 1,
      fee_type: 2,
      fee_amount: 120000,
      pay_status: i % 3 === 0 ? 4 : 2,
      pay_date: i % 3 === 0 ? null : dateOffset(-20),
      expire_date: i % 3 === 0 ? dateOffset(-3) : dateOffset(45),
      voucher_url: null,
    });
  }

  // 一条催费记录
  const first = students[0];
  if (first) {
    await ensure('t_class_fee_notify', 'seed-notify-1', {
      student_id: first.id,
      student_no: first.studentNo,
      student_name: first.name,
      class_id: first.cls.id,
      class_name: first.cls.name,
      fee_type: 1,
      fee_amount: 1280000,
      expire_date: dateOffset(3),
      share_channel: 1,
      notify_user_id: 'U001',
      notify_user_name: '演示用户',
      notify_time: NOW(),
      remark: '电话+站内消息提醒',
    });
  }
}

/* ============================================================
 * 9. 退费单（针对 3 名退学学生）
 * ============================================================ */

async function seedRefund(students) {
  const quitStudents = students.filter((s) => s.status === 7).slice(0, 3);
  const statuses = [1, 2, 6];
  quitStudents.forEach(async (s, idx) => {
    const refundId = `seed-refund-${idx + 1}`;
    const st = statuses[idx] || 1;
    const handler = { 1: '班主任', 2: '教质/学术经理', 3: '教务老师', 4: '财务', 5: '校长', 6: '—', 7: '班主任' };
    await ensure('t_class_refund', refundId, {
      student_id: s.id,
      student_no: s.studentNo,
      student_name: s.name,
      class_id: s.cls.id,
      class_name: s.cls.name,
      dept_code: 1,
      fee_type: 1,
      refund_amount: 320000,
      refund_reason: '学生退学，申请退还剩余学费',
      head_teacher_opinion: '同意，请财务核算',
      apply_date: dateOffset(-5),
      is_fee_used_up: false,
      refund_status: st,
      current_handler_name: handler[st],
      apply_user_id: 'U001',
      apply_user_name: '演示用户',
      approve_user_id: null,
      approve_user_name: null,
      approve_time: null,
      reject_reason: null,
      threshold_amount: 500000,
      pay_out_time: st === 6 ? NOW() : null,
      pay_out_voucher_no: st === 6 ? 'PO-DEMO-001' : null,
    });
  });

  // 已退费单的审批日志
  const lastRefund = `seed-refund-3`;
  const logExists = await db('t_class_refund_log').where({ id: 'seed-rflog-1' }).first();
  if (!logExists) {
    const refund = await db('t_class_refund').where({ id: lastRefund }).first();
    if (refund) {
      await db('t_class_refund_log').insert([
        {
          id: 'seed-rflog-1', refund_id: lastRefund, node_status: 2,
          approve_user_id: 'U002', approve_user_name: '教质经理', approve_time: dateOffset(-4) + ' 10:00:00',
          approve_result: 1, reject_reason: null, remark: '同意', is_deleted: false, create_time: NOW(), create_by: 'seed',
        },
        {
          id: 'seed-rflog-2', refund_id: lastRefund, node_status: 3,
          approve_user_id: 'U003', approve_user_name: '教务老师', approve_time: dateOffset(-3) + ' 10:00:00',
          approve_result: 1, reject_reason: null, remark: '核算无误', is_deleted: false, create_time: NOW(), create_by: 'seed',
        },
      ]);
    }
  }
}

/* ============================================================
 * 10. 流程单 + 操作日志
 * ============================================================ */

async function seedFlow(students) {
  const suspended = students.find((s) => s.status === 6);
  if (suspended) {
    await ensure('t_class_flow', 'seed-flow-1', {
      flow_type: 1,
      student_id: suspended.id,
      student_no: suspended.studentNo,
      student_name: suspended.name,
      class_id: suspended.cls.id,
      class_name: suspended.cls.name,
      apply_user_id: 'U001',
      apply_user_name: '演示用户',
      apply_time: NOW(),
      apply_reason: '因病休学',
      flow_status: 3,
      current_node_name: '已同意',
      approve_user_id: 'U002',
      approve_user_name: '教质经理',
      approve_time: NOW(),
      reject_reason: null,
      suspend_status: 3,
      suspend_start_date: dateOffset(-10),
      expect_resume_date: dateOffset(80),
      suspend_reason: '因病休学',
      id_card_no: suspended.id ? '410100200000000000' : null,
      phone: '13800000000',
      attended_hours: 120,
      resume_class_id: null,
      resume_date: null,
      is_meal_dorm_restored: false,
      from_class_id: null,
      to_class_id: null,
      from_stage: null,
      to_stage: null,
      transfer_reason: null,
      handover_role: null,
      from_user_id: null,
      to_user_id: null,
      handover_reason: null,
      handover_content: null,
      handover_time: null,
      arrange_user_id: null,
      agreement_status: null,
      sign_date: null,
      agreement_file_url: null,
    });
  }

  // 一条待审批流程（末班示例 - 挂在某在读学生）
  const studying = students.find((s) => s.status === 5);
  if (studying) {
    await ensure('t_class_flow', 'seed-flow-2', {
      flow_type: 3,
      student_id: studying.id,
      student_no: studying.studentNo,
      student_name: studying.name,
      class_id: studying.cls.id,
      class_name: studying.cls.name,
      apply_user_id: 'U001',
      apply_user_name: '演示用户',
      apply_time: NOW(),
      apply_reason: '申请转入更适合的班级',
      flow_status: 2,
      current_node_name: '待经理审批',
      suspend_status: 2,
      from_class_id: studying.cls.id,
      to_class_id: CLASSES[2].id,
      from_stage: studying.cls.stage,
      to_stage: CLASSES[2].stage,
      transfer_reason: '调整学习进度',
    });
    await db('t_class_student').where({ id: studying.id }).update({ pending_flow_type: 3 });
  }

  // 操作日志
  await ensure('t_class_op_log', 'seed-oplog-1', {
    module: 'student',
    biz_type: '休学',
    biz_id: 'seed-flow-1',
    student_id: suspended ? suspended.id : null,
    class_id: suspended ? suspended.cls.id : null,
    op_user_id: 'U002',
    op_user_name: '教质经理',
    op_time: NOW(),
    op_desc: '演示：休学审批通过',
    before_value: JSON.stringify({ studentStatus: 5 }),
    after_value: JSON.stringify({ studentStatus: 6 }),
  });
}

/* ============================================================
 * 11. 师资交接 + 学期 + 末班记录
 * ============================================================ */

async function seedHandoverTerm() {
  const cls = CLASSES[1]; // G105
  await ensure('t_class_handover', 'seed-hv-1', {
    class_id: cls.id,
    class_name: cls.name,
    handover_role: 2,
    from_user_id: 'T099',
    from_user_name: '原教员·郑老师',
    to_user_id: cls.teacher[0],
    to_user_name: cls.teacher[1],
    handover_reason: '原教员调岗',
    handover_content: '已交接本学期教学进度、作业批改标准与班级学生情况。',
    handover_time: NOW(),
    arrange_user_id: 'U002',
    arrange_user_name: '学术经理',
  });

  await ensure('t_class_term', 'seed-term-1', {
    class_id: cls.id,
    class_name: cls.name,
    term_name: '2026 春季学期',
    start_date: dateOffset(-120),
    end_date: dateOffset(-30),
    remark: '已完成',
  });
  await ensure('t_class_term', 'seed-term-2', {
    class_id: cls.id,
    class_name: cls.name,
    term_name: '2026 秋季学期',
    start_date: dateOffset(-30),
    end_date: dateOffset(60),
    remark: '进行中',
  });
}

async function seedRepeat(students) {
  const s = students.find((x) => x.id === 'seed-stu-10' && x.status === 5) || students.find((x) => x.status === 5);
  if (!s) return;
  await ensure('t_class_repeat', 'seed-repeat-1', {
    student_id: s.id,
    student_no: s.studentNo,
    student_name: s.name,
    from_class_id: CLASSES[3].id,
    from_class_name: CLASSES[3].name,
    from_stage: CLASSES[3].stage,
    to_class_id: s.cls.id,
    to_class_name: s.cls.name,
    to_stage: s.cls.stage,
    repeat_reason: '阶段考核未通过，末班重修',
    repeat_time: NOW(),
    repeat_count: 1,
    notify_user_id: 'T001',
    is_notified: true,
  });
  await db('t_class_student').where({ id: s.id }).update({ repeat_count: 1 });
}

/* ============================================================
 * 主流程
 * ============================================================ */

async function main() {
  console.log('开始灌入演示种子数据（幂等）...');
  await seedSettings();
  console.log('  ✓ 系统设置');
  await seedStagePlans();
  console.log('  ✓ 阶段方案');
  await seedStages();
  console.log('  ✓ 学习阶段字典');
  await seedStageSchemes();
  console.log('  ✓ 阶段方案');
  await seedClasses();
  console.log('  ✓ 班级');
  const students = await seedStudents();
  console.log(`  ✓ 学生（本次新建 ${students.length} 条）`);
  await recalcClassCounts();
  console.log('  ✓ 班级人数回写');
  // 取全部学生（含已存在的）用于后续关联
  const allStudents = await db('t_class_student')
    .where('is_deleted', false)
    .select('id', 'student_no as studentNo', 'student_name as name', 'gender', 'student_status as status', 'class_id', 'class_name')
    .then((rows) =>
      rows.map((r) => ({
        id: r.id,
        studentNo: r.studentNo,
        name: r.name,
        gender: r.gender,
        status: r.status,
        cls: CLASSES.find((c) => c.id === r.class_id) || CLASSES[1],
      })),
    );

  await seedDorm(allStudents);
  console.log('  ✓ 宿舍（楼栋/房间/床位/入住/调宿/退宿）');
  await seedAttendance();
  console.log('  ✓ 出勤台账+明细');
  await seedExam();
  console.log('  ✓ 考试+成绩');
  await seedFee(allStudents);
  console.log('  ✓ 缴费台账+催费记录');
  await seedRefund(allStudents);
  console.log('  ✓ 退费单');
  await seedFlow(allStudents);
  console.log('  ✓ 流程单+操作日志');
  await seedHandoverTerm();
  console.log('  ✓ 师资交接+学期');
  await seedRepeat(allStudents);
  console.log('  ✓ 末班记录');

  console.log('种子数据灌入完成。');
}

main()
  .catch((err) => {
    console.error('种子数据灌入失败：', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.destroy();
  });
