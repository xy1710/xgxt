import { Router } from 'express';

import { studentRouter } from './student.route';
import { classInfoRouter } from './classInfo.route';
import { attendanceRouter } from './attendance.route';
import { examRouter, examScoreRouter } from './exam.route';
import { dormRouter } from './dorm.route';
import { dormApplyRouter } from './dormApply.route';
import { feeRouter } from './fee.route';
import { refundRouter } from './refund.route';
import { flowRouter, repeatRouter } from './flow.route';
import { settingRouter, stageRouter, stageSchemeRouter, opLogRouter } from './setting.route';
import { statsRouter } from './stats.route';
import { handoverRouter } from './handover.route';

/**
 * 教学管理（初高）· 路由注册中心
 *
 * ★ 2026-10-05 并入统一门户版：
 *   原来是独立服务 server-class(8003)，自己在 app.ts 里挂 `/api/class/**`。
 *   合并后 8004 是单进程，而 `/api/class/**` 已经被【大学部班级管理】占用
 *   （两套模块的表名/前缀原本完全撞车），所以整体挪到 `/api/class-jh/**`。
 *
 *   ⚠️ 前缀只改这一处：路由内部的子路径（'/list'、'/add'…）一个字没动，
 *      前端 api 层做同样的 `/api/class/` → `/api/class-jh/` 替换即可对上。
 *
 *   挂载方式见 `src/app.ts`：
 *     for (const r of buildRouters()) app.use(r.path, classJhAuth, r.router);
 */
export interface MountedRouter {
  path: string;
  router: Router;
}

export function buildRouters(): MountedRouter[] {
  return [
    // ---------- 基础数据 ----------
    { path: '/api/class-jh/student', router: studentRouter },

    // ---------- 班级 / 交接 / 学期 ----------
    { path: '/api/class-jh/classInfo', router: classInfoRouter },

    // ---------- 出勤 ----------
    { path: '/api/class-jh/attendance', router: attendanceRouter },

    // ---------- 考试与成绩 ----------
    { path: '/api/class-jh/exam', router: examRouter },
    { path: '/api/class-jh/examScore', router: examScoreRouter },

    // ---------- 宿舍 ----------
    { path: '/api/class-jh/dorm', router: dormRouter },
    { path: '/api/class-jh/dormApply', router: dormApplyRouter },

    // ---------- 费用 ----------
    { path: '/api/class-jh/fee', router: feeRouter },
    { path: '/api/class-jh/refund', router: refundRouter },

    // ---------- 流程（休学/复学/退学/就业协议）与末班 ----------
    { path: '/api/class-jh/flow', router: flowRouter },
    { path: '/api/class-jh/repeat', router: repeatRouter },

    // ---------- 系统设置 / 阶段（字典 + 方案）/ 操作日志 ----------
    { path: '/api/class-jh/setting', router: settingRouter },
    { path: '/api/class-jh/stage', router: stageRouter },
    // ★ 2026-10-16：阶段方案（阶段字典升级版）
    { path: '/api/class-jh/stage-scheme', router: stageSchemeRouter },
    { path: '/api/class-jh/opLog', router: opLogRouter },

    // ---------- 工作台统计 ----------
    { path: '/api/class-jh/dashboard', router: statsRouter },

    // ---------- 班级交接 / 学期管理 ----------
    // ⚠️ 必须放最后：它的路径是 `/handover/*`、`/term/*`（不带自己的段名），
    //    挂在 /api/class-jh 这一层。放前面会抢走别的路由的请求。
    { path: '/api/class-jh', router: handoverRouter },
  ];
}
