/**
 * 考试「先查后写」查重（任务 #20 配套）
 * ============================================================
 *
 * 【背景：为什么不用数据库唯一索引，而用应用层查重】
 *   `t_uni_exam` 建表时凭空加了 `uk_exam(exam_name, exam_date, edu_stage)`，
 *   而三张老表（`sms_class` / `sms_class_jh` 的 `t_class_exam`、`sms_job` 的 `t_job_exam`）
 *   **一个唯一索引都没有** —— 违反本项目铁律⑧「唯一索引不能凭空加」。
 *
 *   更关键的是它**必然误拦合法业务**：考试是**单班**的（`class_id` 就是「这场考试属于哪个班」），
 *   两个班同一天各有一场「期中考试」完全正常，而该唯一键不含 `class_id`。
 *
 *   以及它让**开关关 / 开关开行为不一致**：
 *     开关关（老表）→ 没有唯一键 → 允许重复
 *     开关开（统一表）→ 有唯一键 → 拒绝重复（且报的是 `Duplicate entry` 技术错误）
 *   这正是 P6「开开关双跑对比回归」的差异源。
 *
 *   → 2026-10-16（斌哥拍板）**删除该唯一索引**（迁移 `20261016_007`），
 *     改由本文件在写入前查重，两种模式**走同一段逻辑**，行为一致。
 *
 * 【口径（= 老表语义 + 一条防误录）】
 *   同一个班级 + 同一天 + 同名考试，**在未删除的记录里**只允许一条。
 *   · 只查 `is_deleted = 0` → **删掉再用同名重建是允许的**（老表本来就这样）
 *   · 单班学段（初高 / 大学）按 `class_id` 比对
 *   · 实训是多班（`class_ids` 逗号串）→ 用 `FIND_IN_SET` 判定「有班级交集」即算重复
 *
 * 【为什么列名在老表 / 统一表下都一样，可以共用一套 SQL】
 *   日期列：老表实训是 `exam_time(datetime)`、初高/大学是 `exam_date(date)`；
 *          统一表两列**都有**，且写入方（`repo.job.ts` 写 `exam_time`、
 *          `repo.class*` 写 `exam_date`）沿用了老列名（`UNI_COL_RENAME` 未登记本表）
 *          → 两种模式下**列名与含义一致**。
 *   班级列：老表实训 `class_ids`、初高/大学 `class_id`，统一表两列也都有 → 同理一致。
 *   → 所以本文件用 `tbl()` 取表，列名写死即可，**不需要按开关分支**。
 */

import type { Knex } from 'knex';
import { BizCode } from 'shared-types';
import { BizError } from '../../middleware/errorHandler';
import { tbl } from '../shared/uniTable';
import type { TeachingStage } from '../shared/dto';

interface ExamUniqueConf {
  /** 老表所在库（`tbl()` 靠 `库名.表名` 查 UNI_MAP 决定切不切） */
  dbName: string;
  /** 老表名 */
  table: string;
  /** 存「考试日期」的列名 */
  dateCol: string;
  /** 该列是 datetime（实训）还是 date（初高/大学） */
  dateIsDatetime: boolean;
  /** 班级指向：单班 `class_id` / 多班 `class_ids`（逗号串） */
  classMode: 'single' | 'multi';
}

const CONF: Record<TeachingStage, ExamUniqueConf> = {
  jh: {
    dbName: 'sms_class_jh',
    table: 't_class_exam',
    dateCol: 'exam_date',
    dateIsDatetime: false,
    classMode: 'single',
  },
  class: {
    dbName: 'sms_class',
    table: 't_class_exam',
    dateCol: 'exam_date',
    dateIsDatetime: false,
    classMode: 'single',
  },
  job: {
    dbName: 'sms_job',
    table: 't_job_exam',
    dateCol: 'exam_time',
    dateIsDatetime: true,
    classMode: 'multi',
  },
};

/**
 * 写入前查重；命中即抛 `BizCode.EXAM_DUPLICATE`。
 *
 * @param db        该学段的连接（大学 `src/class/db`、初高 `src/class-jh/utils/db`、实训 `src/utils/db`）
 * @param stage     学段
 * @param input     `excludeId` 传「正在编辑的考试 id」，避免自己和自己比
 *
 * ⚠️ 信息不全（无名称 / 无日期 / 无班级）时**直接放行**，不在这里补必填校验
 *    （必填由 `service.ts::saveExam` 与仓储自己负责，这里只管「重复」）。
 */
export async function assertExamNotDuplicated(
  db: Knex,
  stage: TeachingStage,
  input: {
    classIds?: string[] | null;
    examName?: string | null;
    examDate?: string | null;
    excludeId?: string | null;
  },
): Promise<void> {
  const cfg = CONF[stage];
  const name = String(input.examName ?? '').trim();
  const date = String(input.examDate ?? '').slice(0, 10);
  const classIds = (input.classIds ?? []).map((v) => String(v)).filter(Boolean);
  if (!name || !date || !classIds.length) return;

  const qb = tbl(db, cfg.dbName, cfg.table, stage)
    .where('exam_name', name)
    .where('is_deleted', 0)
    .whereRaw(
      cfg.dateIsDatetime ? `DATE(\`${cfg.dateCol}\`) = ?` : `\`${cfg.dateCol}\` = ?`,
      [date],
    );

  if (input.excludeId) qb.whereNot('id', String(input.excludeId));

  if (cfg.classMode === 'single') {
    qb.whereIn('class_id', classIds);
  } else {
    qb.where((b: Knex.QueryBuilder) => {
      classIds.forEach((id, i) => {
        if (i === 0) b.whereRaw('FIND_IN_SET(?, class_ids)', [id]);
        else b.orWhereRaw('FIND_IN_SET(?, class_ids)', [id]);
      });
    });
  }

  const hit = (await qb.first('id')) as { id?: string } | undefined;
  if (hit) {
    throw new BizError(
      BizCode.EXAM_DUPLICATE,
      `该班级在 ${date} 已有一场名为「${name}」的考试，请勿重复添加`,
    );
  }
}
