/**
 * 财务域 · 学生档案关联（★ 2026-10-20）
 * ============================================================
 *
 * 【背景 · 为什么财务不能像教学域那样直接覆盖】
 *   教学域的缴费/退费/异动是**学籍业务**，单据上的学生一定来自学生档案，
 *   所以读取时可以直接「档案值覆盖快照」。
 *
 *   财务域不一样：`t_finance_fee` 的缴费单有两个来源 ——
 *     ① 咨询模块在报名前建的单（consult/services/fee-order.service.ts）
 *        → 此时学生**还没进学籍档案**，档案里查无此人是正常业务状态，不是脏数据；
 *     ② 报名/建档之后补的单 → 这时档案里已经有了，应该跟着档案走。
 *
 *   所以财务侧的口径是「**能对上就对齐，对不上就保持原样**」：
 *     · 对得上（按 student_id 或学号命中档案）→ 姓名/班级/部门取档案最新值；
 *     · 对不上 → 不动，也不删 —— 硬改只会把「未建档案」这个真实状态藏起来。
 *
 * 【匹配顺序】
 *   先按 `student_id`（最准），再按 `student_no`（学号跨模块认人的共同键，
 *   见 utils/financeFeeRef.ts 的注释：各库学生主键是不同 uuid，只有学号能跨库对上）。
 *
 * ⚠️ 本文件只读档案，不写任何学生数据。
 */

import { db } from '../utils/db';

/** 三学段档案表坐标 */
const ARCHIVE_TABLES = [
  { db: 'sms_class_jh', table: 't_class_student' },
  { db: 'sms_class', table: 't_class_student' },
  { db: 'sms_job', table: 't_student_base' },
];

/** 档案里取出来的学生（字段已归一） */
export interface ArchivedStudent {
  /** 档案主键 */
  id: string;
  /** 学号 */
  no: string;
  /** 姓名 */
  name: string;
  /** 班级ID */
  classId: string | null;
  /** 班级名称 */
  className: string | null;
  /** 部门 1初高部 2大学部 */
  deptCode: number | null;
}

/** whereIn 分片（导出/批量场景防止超长 SQL） */
const CHUNK = 500;

function cleanIds(v: Array<string | null | undefined>): string[] {
  return [...new Set(v.map((x) => String(x ?? '').trim()).filter(Boolean))];
}

function toStudent(r: Record<string, any>): ArchivedStudent {
  return {
    id: String(r.id),
    no: String(r.student_no ?? ''),
    name: String(r.student_name ?? ''),
    classId: r.class_id ? String(r.class_id) : null,
    className: r.class_name ?? null,
    deptCode: r.dept_code == null ? null : Number(r.dept_code),
  };
}

/**
 * 批量在学生档案里找人：返回 `id → 学生` 与 `学号 → 学生` 两张索引
 *
 * 三个学段各查两次（按 id / 按学号），共 6 条 SQL；
 * 每张表内部走主键/唯一索引，成本可忽略。
 */
export async function lookupArchive(
  studentIds: Array<string | null | undefined>,
  studentNos: Array<string | null | undefined>,
): Promise<{ byId: Map<string, ArchivedStudent>; byNo: Map<string, ArchivedStudent> }> {
  const byId = new Map<string, ArchivedStudent>();
  const byNo = new Map<string, ArchivedStudent>();

  const ids = cleanIds(studentIds);
  const nos = cleanIds(studentNos);
  if (!ids.length && !nos.length) return { byId, byNo };

  for (const { db: dbName, table } of ARCHIVE_TABLES) {
    const full = `${dbName}.${table}`;

    for (let i = 0; i < ids.length; i += CHUNK) {
      try {
        const rows = (await db(full)
          .where({ is_deleted: false })
          .whereIn('id', ids.slice(i, i + CHUNK))
          .select('id', 'student_no', 'student_name', 'class_id', 'class_name', 'dept_code')) as any[];
        for (const r of rows) byId.set(String(r.id), toStudent(r));
      } catch {
        // 某个库没建/不可达 → 跳过，不影响其它学段
      }
    }

    for (let i = 0; i < nos.length; i += CHUNK) {
      try {
        const rows = (await db(full)
          .where({ is_deleted: false })
          .whereIn('student_no', nos.slice(i, i + CHUNK))
          .select('id', 'student_no', 'student_name', 'class_id', 'class_name', 'dept_code')) as any[];
        for (const r of rows) {
          // 同一学号在多个学段都存在时，先命中的那个学段优先（初高 → 大学 → 实训）
          if (!byNo.has(String(r.student_no))) byNo.set(String(r.student_no), toStudent(r));
        }
      } catch {
        // 同上
      }
    }
  }

  return { byId, byNo };
}

/**
 * 把档案值合并进财务缴费行（就地覆盖快照列）
 *
 * @returns `linked` = 命中档案的行数（自检用它断言「真关联上了」，
 *          而不是「接口没报错」）
 */
export function applyArchiveToFeeRows<T extends Record<string, any>>(
  rows: T[],
  lookup: { byId: Map<string, ArchivedStudent>; byNo: Map<string, ArchivedStudent> },
): { rows: T[]; linked: number } {
  let linked = 0;

  for (const row of rows) {
    const a =
      lookup.byId.get(String(row.student_id ?? '').trim()) ||
      lookup.byNo.get(String(row.student_no ?? '').trim());
    if (!a) continue; // 档案里没这个人（咨询前置单）→ 保持原样

    const t = row as Record<string, any>;
    // 档案有值才覆盖：档案某列是空的时候保留单据原值，不抹成空
    if (a.no) t.student_no = a.no;
    if (a.name) t.student_name = a.name;
    if (a.classId) t.class_id = a.classId;
    if (a.className) t.class_name = a.className;
    if (a.deptCode != null) t.dept_code = a.deptCode;

    linked += 1;
  }

  return { rows, linked };
}

/** 取一行的档案学生（详情页单行场景） */
export async function findArchiveStudent(
  studentId: string | null | undefined,
  studentNo: string | null | undefined,
): Promise<ArchivedStudent | null> {
  const { byId, byNo } = await lookupArchive([studentId], [studentNo]);
  return byId.get(String(studentId ?? '').trim()) || byNo.get(String(studentNo ?? '').trim()) || null;
}
