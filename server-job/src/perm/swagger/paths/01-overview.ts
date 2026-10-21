/**
 * Swagger 注解 —— 权限总览
 */

/**
 * @openapi
 * /api/perm/overview/get:
 *   get:
 *     tags:
 *       - 权限总览
 *     summary: 首屏 KPI 与最近操作动态
 *     description: |
 *       返回权限总览页顶部 KPI 卡片数据 + 最近 10 条操作动态。
 *
 *       **口径说明**：`deptTotal = 7`（排除校级「全部门」与 3 个学段）；`permPointTotal = 185`（按全部功能点求和，含二级功能点）。
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
 *                   example: 操作成功
 *                 data:
 *                   type: object
 *                   properties:
 *                     roleTotal:
 *                       type: integer
 *                       example: 14
 *                     roleEnabled:
 *                       type: integer
 *                       example: 14
 *                     userTotal:
 *                       type: integer
 *                       example: 17
 *                     userNormal:
 *                       type: integer
 *                       example: 15
 *                     permPointTotal:
 *                       type: integer
 *                       example: 185
 *                     moduleTotal:
 *                       type: integer
 *                       example: 8
 *                     itemTotal:
 *                       type: integer
 *                       example: 53
 *                     deptTotal:
 *                       type: integer
 *                       example: 6
 *                     stageTotal:
 *                       type: integer
 *                       example: 5
 *                     recentLogs:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/Log'
 *       401:
 *         description: 未登录
 */

export {};
