/**
 * 学号生成（★ 2026-10-22 用户口径）
 * ============================================================
 *
 * 【规则】学号 = LZ + 班级编号 + 班内序号(3位)
 *   例：班级编号 Q17 → LZQ17001、LZQ17002…
 *   序号取该班**已用过的最大序号 + 1**（含已逻辑删除的行 —— 学号是物理唯一索引，
 *   删掉的学生仍占着号，不复用）。
 *
 * 【什么时候生成】
 *   ① 学生档案「新增学生」（留不留空都一样，一律按规则生成）
 *   ② 待接收页面接收咨询学生（初高 / 大学两个入口）
 *   生成后**终身不变**：升云（初高→大学）、升实训（大学→就业）都原样带学号。
 *
 * 【边界】
 *   · 必须选班级：没班级就没有班级编号，生成不了 → 直接报错，不造兜底号段
 *   · 班级必须有「班级编号」：历史班没填 → 拦住，提示先去班级管理补
 *     （编码规则统一，不出现「一半新号一半旧号」的班）
 *   · 班级编号三部门全局唯一（见 shared/classCode.ts），所以 LZ+编号 天然不撞段
 *   · 学号列是 varchar(32)：LZ + 编号 + 3 位超出上限时直接报错，不静默截断
 */

import { BizCode } from 'shared-types';
import { BizError } from '../../middleware/errorHandler';
import { db as jhDb } from '../../class-jh/utils/db';
import { db as classDb } from '../../class/db';
import { db as jobDb } from '../../utils/db';
import { tbl } from './uniTable';

/** 能按班级生成学号的三个学段（实训 job 与就业部 emp 共用 sms_job，归到 emp） */
export type StudentNoStage = 'jh' | 'class' | 'emp';

interface Src {
  conn: any;
  schema: string;
  classTable: string;
  studentTable: string;
  label: string;
}

const SRC: Record<StudentNoStage, Src> = {
  jh: { conn: jhDb, schema: 'sms_class_jh', classTable: 't_class_info', studentTable: 't_class_student', label: '初高部' },
  class: { conn: classDb, schema: 'sms_class', classTable: 't_class_info', studentTable: 't_class_student', label: '大学部' },
  emp: { conn: jobDb, schema: 'sms_job', classTable: 't_job_class', studentTable: 't_student_base', label: '就业部' },
};

/** 学号列宽（三张学生表都是 varchar(32)） */
const STUDENT_NO_MAX = 32;
/** 班内序号上限（3 位） */
const SEQ_MAX = 999;

/**
 * 按班级生成下一个学号
 *
 * @throws BizError 没选班级 / 班级不存在 / 班级没编号 / 编号太长 / 序号用尽
 */
export async function nextStudentNoForClass(stage: StudentNoStage, classId: unknown): Promise<string> {
  const cid = String(classId ?? '').trim();
  if (!cid) {
    throw new BizError(BizCode.PARAM_ERROR, '请先选择班级：学号按「LZ + 班级编号 + 序号」自动生成');
  }

  const src = SRC[stage];
  const cls = (await tbl(src.conn, src.schema, src.classTable, stage)
    .where({ id: cid, is_deleted: false })
    .first()) as Record<string, any> | undefined;
  if (!cls) throw new BizError(BizCode.PARAM_ERROR, '所选班级不存在或已删除');

  const classCode = String(cls.class_code ?? '').trim();
  if (!classCode) {
    throw new BizError(
      BizCode.PARAM_ERROR,
      `「${String(cls.class_name ?? '')}」还没有班级编号，学号无法生成 —— 请先到「班级管理」给这个班补上班级编号`,
    );
  }

  const prefix = `LZ${classCode}`;
  if (prefix.length + 3 > STUDENT_NO_MAX) {
    throw new BizError(
      BizCode.PARAM_ERROR,
      `班级编号「${classCode}」太长，生成的学号会超过 ${STUDENT_NO_MAX} 位上限，请缩短班级编号`,
    );
  }

  // 该班已用过的学号（**含已删除**：学号是物理唯一索引，删掉的学生仍占号）
  const rows = (await tbl(src.conn, src.schema, src.studentTable, stage)
    .where('class_id', cid)
    .where('student_no', 'like', `${prefix}%`)
    .select('student_no')) as Array<{ student_no: string }>;

  let max = 0;
  for (const r of rows) {
    const n = parseInt(String(r.student_no).slice(prefix.length), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }

  // 兜底：算出来的号若被**别的班**的历史数据占着（老数据/手工号），往后顺延直到空闲
  for (let n = max + 1; n <= SEQ_MAX; n += 1) {
    const candidate = `${prefix}${String(n).padStart(3, '0')}`;
    const taken = (await tbl(src.conn, src.schema, src.studentTable, stage)
      .where({ student_no: candidate })
      .first()) as Record<string, any> | undefined;
    if (!taken) return candidate;
  }

  throw new BizError(
    BizCode.PARAM_ERROR,
    `班级「${String(cls.class_name ?? '')}」的学号序号已用满（${SEQ_MAX}），请联系管理员`,
  );
}
