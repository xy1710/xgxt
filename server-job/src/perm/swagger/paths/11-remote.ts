/**
 * Swagger 注解 —— 跨模块调用（3 个接口）
 *
 * 这一组接口用的就是《技术选型表》里「跨服务调用：axios」那一项的能力，
 * 底层是 src/utils/http.ts 的统一封装（超时 / 重试 / 解包 / 错误翻译一次写好）。
 */

/**
 * @openapi
 * /api/perm/remote/modules:
 *   get:
 *     tags:
 *       - 跨模块调用
 *     summary: 7 个模块联通自检
 *     description: |
 *       并发探测 auth(8001) / edu(8002) / class(8003) / job(8004) /
 *       finance(8005) / perm(8006) / stat(8007) 七个模块的 `/health`。
 *
 *       **联调期最实用**：一个请求就能看出「谁没起来」，不用逐个 curl。
 *
 *       ⚠️ 本接口是**容错**的 —— 某个模块挂了不会让整个请求失败，
 *       而是把失败原因（已翻译成中文，如「无法连接 教务管理(8002)，请确认该模块已启动」）
 *       记进 `list` 里返回。总耗时 ≈ 最慢的那个模块，不是 7 个相加。
 *     parameters:
 *       - name: timeout
 *         in: query
 *         required: false
 *         schema:
 *           type: integer
 *           default: 2000
 *           minimum: 500
 *           maximum: 10000
 *         description: 单个模块的探测超时（毫秒），超出范围会被夹到 500~10000
 *     responses:
 *       200:
 *         description: 自检完成
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
 *                   example: 自检完成：1/7 个模块在线
 *                 data:
 *                   $ref: '#/components/schemas/ModuleProbeReport'
 */

/**
 * @openapi
 * /api/perm/remote/modules/{name}:
 *   get:
 *     tags:
 *       - 跨模块调用
 *     summary: 单个模块探活
 *     description: |
 *       探测指定模块的 `/health`。`name` 只允许
 *       `auth / edu / class / job / finance / perm / stat`，
 *       传其他值会返回 400（防止拿它当跳板去打任意地址）。
 *     parameters:
 *       - name: name
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *           enum: [auth, edu, class, job, finance, perm, stat]
 *         example: perm
 *       - name: timeout
 *         in: query
 *         required: false
 *         schema:
 *           type: integer
 *           default: 2000
 *         description: 探测超时（毫秒）
 *     responses:
 *       200:
 *         description: 探测完成（不代表模块在线，看 `data.online`）
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
 *                   example: 模块在线
 *                 data:
 *                   $ref: '#/components/schemas/ModuleProbe'
 *       400:
 *         description: 模块名不合法
 */

/**
 * @openapi
 * /api/perm/remote/auth-profile:
 *   get:
 *     tags:
 *       - 跨模块调用
 *     summary: 去登录模块取账号档案（跨模块业务调用示例）
 *     description: |
 *       调用登录模块（8001）的 `GET /api/auth/profile?account=xxx`，
 *       拿账号的职位 / 权限 / 数据范围，并透传调用方的 `Authorization`。
 *
 *       ⚠️ 与上面两个探活接口不同，**这个接口不吞异常**：
 *       如果登录模块没启动，会返回一条
 *       「无法连接 登录与市场咨询(8001)，请确认该模块已启动」的友好提示，
 *       而不是 500 堆栈 —— 这就是「统一拦截错误」的效果。
 *     parameters:
 *       - name: account
 *         in: query
 *         required: true
 *         schema:
 *           type: string
 *         example: admin
 *         description: 账号
 *     responses:
 *       200:
 *         description: 成功取到账号档案（失败时返回业务错误码，HTTP 仍为 200）
 *       400:
 *         description: 缺少 account 参数
 */

export {};
