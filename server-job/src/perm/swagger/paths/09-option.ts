/**
 * Swagger 注解 —— 可选项字典（1 个接口）
 */

/**
 * @openapi
 * /api/perm/option/get:
 *   get:
 *     tags:
 *       - 可选项字典
 *     summary: 全部可选项字典
 *     description: |
 *       前端所有下拉框的取值集中在这里。
 *
 *       > 集中在一个接口是为了避免「A 页面叫管理职位、B 页面叫管理层」这类脏数据。
 *
 *       > ⚠️ 所有字段都是 **`{ value, label }` 对象数组**，不是裸字符串数组。
 *       >   `logActionTypes / logModules / logResults` 在 `PermOptions` 类型里没声明，
 *       >   但接口实际会返回（前端按 `Record<string, any>` 兜底），此处以**实际返回**为准。
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
 *                     roleTypes:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/PermOptionItem'
 *                       description: 业务职位 / 管理职位 / 职能职位 / 系统职位
 *                     roleStatuses:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/PermOptionItem'
 *                       description: 启用 / 停用
 *                     userStatuses:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/PermOptionItem'
 *                       description: 正常 / 已停用 / 已锁定
 *                     deptLevels:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/PermOptionItem'
 *                       description: 1 校级 / 2 部门 / 3 学段
 *                     dataScopes:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/PermOptionItem'
 *                       description: 1 本人 / 2 本班级 / 3 本部门 / 4 全部数据
 *                     baseActions:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/PermOptionItem'
 *                       description: 6 个动作基类
 *                     exportScopes:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/PermOptionItem'
 *                       description: 当前页 / 全部筛选结果 / 全部数据
 *                     logActionTypes:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/PermOptionItem'
 *                       description: 登录 / 新增 / 修改 / 删除 / 审批 / 导出 / 权限变更
 *                     logModules:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/PermOptionItem'
 *                       description: 与 t_perm_log.module_name 取值一致
 *                     logResults:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/PermOptionItem'
 *                       description: 成功 / 失败
 *                     pwdTipText:
 *                       type: string
 *                       description: 由当前密码策略**动态拼接**的提示文案
 *                       example: 不少于 8 位，含大写字母、数字、特殊符号，90 天需更换，首次登录须修改
 */

export {};
