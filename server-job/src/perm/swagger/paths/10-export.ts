/**
 * Swagger 注解 —— 通用导出（2 个接口）
 */

/**
 * @openapi
 * /api/perm/export/do:
 *   post:
 *     tags:
 *       - 通用导出
 *     summary: 生成导出文件并返回下载地址
 *     description: |
 *       权限标识 `perm:操作日志:export`。文件落在 `server-perm/exports/`，同时记一条「导出」操作日志。
 *
 *       - `format = excel`：产出 `.xls`（HTML 表格 + Excel MIME，Excel 可直接打开）
 *       - `format = csv`：带 UTF-8 BOM，防中文乱码
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - resource
 *               - scope
 *             properties:
 *               resource:
 *                 type: string
 *                 enum: [dept, role, user, log]
 *                 example: role
 *               scope:
 *                 type: string
 *                 enum: [当前页, 全部筛选结果, 全部数据]
 *                 example: 全部筛选结果
 *               format:
 *                 type: string
 *                 enum: [excel, csv]
 *                 default: excel
 *               query:
 *                 type: object
 *                 description: 与列表接口一致的筛选 / 分页参数
 *                 example:
 *                   page: 1
 *                   size: 20
 *     responses:
 *       200:
 *         description: 成功
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code:
 *                   type: integer
 *                   example: 200
 *                 message:
 *                   type: string
 *                   example: 导出成功
 *                 data:
 *                   type: object
 *                   properties:
 *                     fileName:
 *                       type: string
 *                       example: 职位清单_20260929205528_db9812.xls
 *                     total:
 *                       type: integer
 *                       example: 14
 *                     downloadUrl:
 *                       type: string
 *                       example: /api/perm/export/download/%E8%A7%92%E8%89%B2%E6%B8%85%E5%8D%95_20260929205528_db9812.xls
 */

/**
 * @openapi
 * /api/perm/export/download/{fileName}:
 *   get:
 *     tags:
 *       - 通用导出
 *     summary: 下载导出文件（静态 · 不鉴权）
 *     description: '文件名带随机后缀，无法猜测，因此本接口不挂鉴权（浏览器直接跳转下载不带 Header）。'
 *     security: []
 *     parameters:
 *       - name: fileName
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *         description: URL 编码后的文件名
 *         example: '%E8%A7%92%E8%89%B2%E6%B8%85%E5%8D%95_20260929205528_db9812.xls'
 *     responses:
 *       200:
 *         description: 文件流
 *         content:
 *           application/octet-stream:
 *             schema:
 *               type: string
 *               format: binary
 *       404:
 *         description: 文件不存在
 */

export {};
