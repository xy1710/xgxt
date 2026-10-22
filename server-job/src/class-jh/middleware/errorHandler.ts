/**
 * 统一错误处理中间件
 *
 * ⚠️ 作用：
 *   1. 把所有异常统一成 {code, message, data} 格式
 *   2. 把技术错误翻译成人话，不让用户看到堆栈
 *
 * 必须在 app.ts 里最后注册：app.use(errorHandler)
 */

import { Request, Response, NextFunction } from 'express';
import { BizCode, ApiResponse } from 'shared-types/class-jh';
import { config } from '../config';

/** 业务异常（在代码里 throw new BizError(...) 即可） */
export class BizError extends Error {
  code: BizCode;
  httpStatus: number;

  constructor(code: BizCode, message: string, httpStatus = 200) {
    super(message);
    /**
     * ★ 2026-10-05 并入统一门户版时新增：必须显式设 name。
     *
     *   合并后本模块的 errorHandler **不再注册**（由主工程 8004 的统一错误中间件接管），
     *   而主工程是靠「鸭子类型」识别外来 BizError 的 ——
     *   判据正是 `err.name === 'BizError'`（见 src/middleware/errorHandler.ts 的 isClassBizError）。
     *   父类 Error 默认 name 是 'Error'，不设这一行的话
     *   **所有业务错误都会掉进"未知错误"分支**，前端看到的是
     *   「服务器开小差了」，而不是「学号已存在」这类能直接给用户看的提示。
     */
    this.name = 'BizError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export function errorHandler(
  err: any,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  // ---- 业务异常：直接返回约定好的码和提示 ----
  if (err instanceof BizError) {
    const body: ApiResponse<null> = { code: err.code, message: err.message, data: null };
    res.status(err.httpStatus).json(body);
    return;
  }

  // ---- 唯一约束冲突：这是业务问题（学号/班级名/房间号重复），不是系统故障 ----
  //      ⚠️ 单独处理有三个原因：
  //        1) 不能返回 50002(DB_ERROR)，否则前端把它当"服务器开小差"；
  //        2) 应用层预检存在竞态（两人同时提交），这里兜底保证错误码一致；
  //        3) 逻辑删除后用同一唯一值重建时，会走到这里（预检已按物理范围拦截），
  //           仍返回明确的业务码而不是 50002。
  if (err && err.code === 'ER_DUP_ENTRY') {
    const body: ApiResponse<null> = {
      code: BizCode.DATA_DUPLICATE,
      message: '数据已存在：学号 / 名称 / 房间号等唯一字段重复，请修改后重试',
      data: null,
    };
    res.status(200).json(body);
    return;
  }

  // ---- 数据库常见错误：翻译成人话 ----
  const dbMessage = translateDbError(err);
  if (dbMessage) {
    console.error('[DB ERROR]', req.method, req.url, err.code);
    const body: ApiResponse<null> = {
      code: BizCode.DB_ERROR,
      message: dbMessage,
      data: null,
    };
    res.status(200).json(body);
    return;
  }

  // ---- 其他未知错误 ----
  console.error('[UNHANDLED ERROR]', req.method, req.url, err);

  const body: ApiResponse<null> = {
    code: BizCode.INTERNAL_ERROR,
    message: config.env === 'development'
      ? `服务器错误：${err.message}`   // 开发环境给详细信息，方便排查
      : '服务器开小差了，请稍后重试',      // 生产环境不暴露细节
    data: null,
  };
  res.status(200).json(body);
}

/** 把 MySQL 的错误码翻译成中文提示 */
function translateDbError(err: any): string | null {
  if (!err || !err.code) return null;

  const map: Record<string, string> = {
    ER_DUP_ENTRY: '数据已存在，请勿重复添加',
    ER_NO_REFERENCED_ROW_2: '关联的数据不存在',
    ER_ROW_IS_REFERENCED_2: '该数据被其他记录引用，无法删除',
    ER_ACCESS_DENIED_ERROR: '数据库账号或密码错误',
    ECONNREFUSED: '无法连接数据库，请检查数据库是否启动',
    ER_BAD_FIELD_ERROR: '数据库字段不存在（可能是迁移脚本没跑）',
    ER_NO_SUCH_TABLE:
      '数据表不存在 —— 教学域老表已 DROP，请检查是否有代码漏切读（应走 t_uni_*）',
    ER_DATA_TOO_LONG: '输入的内容太长了',
  };

  return map[err.code] || null;
}
