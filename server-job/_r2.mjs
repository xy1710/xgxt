import fs from 'node:fs';
const P = 'src/teaching/dorm/repo.uni.ts';
let s = fs.readFileSync(P, 'utf8');

/* 标记变成 ours/theirs（--conflict=merge 会带标签） */
const open = (label) => `<<<<<<< ${label}`;
const findBlock = (from) => {
  const i0 = s.indexOf(open('ours'), from);
  const mid = s.indexOf('=======', i0);
  const i1 = s.indexOf('>>>>>>>', mid);
  const end = s.indexOf('\n', i1);
  if (i0 < 0 || mid < 0 || i1 < 0) throw new Error('块定位失败');
  return { i0, mid, i1: end < 0 ? s.length : end + 1 };
};

/* ---------- 块 1（导入）：两边都要 ---------- */
{
  const { i0, i1 } = findBlock(0);
  s =
    s.slice(0, i0) +
    `import { visibleClassIds } from '../shared/dataScope';
import { listBuildingNames as listDormBuildingNames } from './building.service';
` +
    s.slice(i1);
}

/* ---------- 块 2（scopedDormIds 上半段）---------- */
{
  const { i0, i1 } = findBlock(0);
  s =
    s.slice(0, i0) +
    `    /* ★ 2026-10-19：统一走「交棒模型」的班级范围（与出勤/成绩/班级同口径）
         · 项目经理 → 自己负责且未结业的实训班
         · 就业老师 → 已结业（交棒）的班
         · 班主任三人组 → 自己带的班
         原来这里只按 head/teacher/assistant 查，项目经理/就业老师匹配不到 → 恒为空。 */
    const classIds = await visibleClassIds(stage, user);
    if (classIds === null) return null;
    if (!classIds.length) return [];

    const ids = new Set<string>();

    /**
     * ★ 2026-10-21（远端）：班主任要能看到**教务分派给本班的宿舍**，哪怕还没有学生入住 ——
     *   否则教务刚分派完、班主任还没填学生时，他看到的仍是「暂无数据」，分派等于白做。
     *   分派表只有 class_name 快照（没有 class_id），所以先按我的班取班名再匹配。
     */
    try {
      const myNames = (await uniDb('t_uni_class')
        .whereIn('id', classIds)
        .where({ is_deleted: 0 })
        .select('class_name')) as Array<{ class_name: string }>;
      const nameList = myNames.map((r) => String(r.class_name || '')).filter(Boolean);
      if (nameList.length) {
        const assigned = (await db(ASSIGN_T)
          .whereIn('class_name', nameList)
          .where({ is_deleted: false })
          .distinct('room_id')) as any[];
        for (const a of assigned) if (str(a.room_id)) ids.add(String(a.room_id));
      }
    } catch {
      /* 分派表不存在 → 跳过 */
    }
` +
    s.slice(i1);
}

/* ---------- ② 段：把 mine.ids / mine.names 换成 classIds ---------- */
const A = '    // ② 本班学生已经入住的房间（学生主档 dorm_id 是权威来源）';
const B = '    return [...ids];';
const j0 = s.indexOf(A);
const j1 = s.indexOf(B, j0);
if (j0 < 0 || j1 < 0) throw new Error('② 段定位失败');
s =
  s.slice(0, j0) +
  `    // ② 本班学生已经入住的房间（学生主档 dorm_id 是权威来源）
    //   ★ 统一表 sms_common.t_uni_student 为主，sms_perm.t_student_base 兜底老数据
    const stayingSources: Array<() => any> = [
      () => tbl(db, SRC_DB, STUDENT_T, stage).whereIn('class_id', classIds),
      () => db(PERM_STUDENT).whereIn('class_id', classIds),
    ];
    for (const src of stayingSources) {
      try {
        const rows = (await src()
          .where({ is_deleted: false })
          .whereIn('student_status', IN_SCHOOL_STATUS)
          .whereNotNull('dorm_id')
          .andWhere('dorm_id', '<>', '')
          .distinct('dorm_id')) as any[];
        for (const r of rows) if (str(r.dorm_id)) ids.add(String(r.dorm_id));
      } catch {
        /* 表不存在 → 跳过 */
      }
    }
` +
  s.slice(j1);

fs.writeFileSync(P, s);
console.log('dorm 已合并（导入 + 范围）');
