/**
 * Swagger / OpenAPI 3 接口文档 —— 规格构建器
 *
 * ⚠️ 为什么单开一个目录，而不是把注解写在 routes/*.ts 里？
 *    1. 本模块的接口清单是「先定契约、再写实现」的产物（见 架构设计改造/02-接口契约规范.md）；
 *    2. 注解集中放 src/swagger/paths/*.ts，路由文件保持零改动 —— 加文档不会碰到业务逻辑，
 *       也就不会出现「为了写文档把接口改坏了」这种事；
 *    3. 改接口时同步改对应 paths 文件即可，swagger-jsdoc 在启动时扫描并生成，不需要手工维护 json。
 *
 * 访问方式（服务起来后）：
 *   http://localhost:8006/api-docs        Swagger UI（可直接点「Try it out」调接口）
 *   http://localhost:8006/api-docs.json   原始 OpenAPI 规格（可导入 Postman / Apifox）
 */

import path from 'path';
import swaggerJsdoc from 'swagger-jsdoc';
import { config } from '../config';

const PORT = config.port;

/** 业务错误码表（与 shared-types 的 BizCode 保持一致），写进文档方便前端对照 */
const errorCodeTable = `
| 码 | 含义 |
| --- | --- |
| 200 | 成功 |
| 40001 | 参数校验失败（zod 统一拦截，message 是中文） |
| 40010 | 职位编码已存在 |
| 40011 | 职位名称已存在 |
| 40012 | 职位有关联账号，不可删除 |
| 40013 | 系统预置职位受保护 |
| 40014 | 职位已停用，不可分配给账号 |
| 40015 | 部门名称已存在 |
| 40016 | 部门被引用，不可删除 |
| 40017 | 部门下还有子部门 |
| 40018 | 手机号已存在 |
| 40019 | 登录账号已存在 |
| 40020 | 工号已存在 |
| 40021 | 账号有业务数据，不可删除 |
| 40022 | 账号必须至少有一个职位 |
| 40023 | 密码强度不符合当前策略 |
| 40024 | 规则取值不合法 |
| 40025 | 权限全量覆盖内容为空 |
| 40101 | 未登录（前端跳登录页） |
| 40301 / 40302 | 已登录但无权限（前端只弹提示，不跳登录页） |
| 40410 | 职位不存在 |
| 40411 | 账号不存在 |
| 40412 | 部门不存在 |
| 40413 | 日志不存在 |
| 40414 | 功能点不存在 |
`;

const definition: swaggerJsdoc.Options['definition'] = {
  openapi: '3.0.3',
  info: {
    title: '学管系统 · 权限管理（server-perm）',
    version: '1.0.0',
    description: [
      '模块：**权限管理**（负责人 林晓）',
      '',
      `- 服务端口：**${PORT}**`,
      '- 接口前缀：**`/api/perm`**',
      '- 数据库：**`sms_perm`**（MySQL 8）',
      `- 业务接口：**48 个** + 1 个健康检查 ${errorCodeTable}`,
      '## 通用约定',
      '',
      '| 项 | 约定 |',
      '| --- | --- |',
      '| 响应体 | `{ code, message, data }`，`code = 200` 为成功；`message` 是可直接展示的中文 |',
      '| 分页入参 | `page`（从 1 开始）、`size` |',
      '| 分页出参 | `{ total, page, size, list }` |',
      '| 鉴权 | `Authorization: Bearer <token>`；开发态可用 `Bearer test` |',
      '| 时间格式 | `YYYY-MM-DD HH:mm:ss` |',
      '| 枚举 | 双返回：`xxx` 原值 + `xxxName` 中文名 |',
      '| 401 vs 403 | 401 = 未登录（跳登录页）；403 = 已登录无权限（只弹提示） |',
      '',
      '> 右上角 **Authorize** 按钮里填 `test`（开发态假 token），即可直接试调全部带鉴权的接口。',
    ].join('\n'),
  },
  servers: [
    { url: `http://localhost:${PORT}`, description: '本地开发（直连后端）' },
    { url: 'http://localhost:8080', description: '本地开发（经 Nginx 网关反向代理）' },
  ],
  tags: [
    { name: '健康检查', description: '不鉴权，用于快速确认服务活着' },
    { name: '权限总览', description: '首屏 KPI 与最近操作动态' },
    { name: '部门管理', description: '部门两级树（校级 / 部门 / 学段）' },
    { name: '职位管理', description: '职位 CRUD、启停、导入导出' },
    { name: '账号管理', description: '账号 CRUD、状态、重置密码、解锁' },
    { name: '权限树', description: '8 模块 / 53 个顶级功能点 / 185 动作' },
    { name: '职位权限分配', description: '全量覆盖式保存' },
    /* ★ 2026-10-06 新增：板块 → 页面 台账 */
    { name: '页面管理', description: '板块 → 页面 台账：打勾即该板块有此页面（全量覆盖式保存）' },
    { name: '操作日志', description: '只读：不提供新增 / 修改 / 删除接口' },
    { name: '规则配置', description: '密码策略 / 登录限制 / 审批流' },
    { name: '可选项字典', description: '前端所有下拉框的取值集中在这里' },
    { name: '通用导出', description: '生成 Excel / CSV 并下载' },
    { name: '跨模块调用', description: '7 模块联通自检 · 经统一 axios 客户端调用其他模块' },
  ],
  components: {
    parameters: {
      Page: {
        name: 'page',
        in: 'query',
        required: false,
        schema: { type: 'integer', minimum: 1, default: 1 },
        description: '页码，从 1 开始',
      },
      Size: {
        name: 'size',
        in: 'query',
        required: false,
        schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        description: '每页条数，最大 100',
      },
      IdQuery: {
        name: 'id',
        in: 'query',
        required: true,
        schema: { type: 'string' },
        description: '主键 ID',
      },
      IdPath: {
        name: 'id',
        in: 'path',
        required: true,
        schema: { type: 'string' },
        description: '主键 ID',
      },
    },
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: '开发态直接填 `test` 即可；正式环境由登录模块签发 JWT',
      },
    },
    schemas: {
      /* ---------- 通用信封 ---------- */
      ApiResponse: {
        type: 'object',
        description: '单条数据的统一响应信封',
        properties: {
          code: { type: 'integer', example: 200 },
          message: { type: 'string', example: '操作成功' },
          data: { nullable: true, description: '业务数据，失败时为 null' },
        },
        required: ['code', 'message'],
      },
      PageData: {
        type: 'object',
        description: '分页数据的统一结构',
        properties: {
          total: { type: 'integer', example: 15 },
          page: { type: 'integer', example: 1 },
          size: { type: 'integer', example: 20 },
          list: { type: 'array', items: { type: 'object' } },
        },
        required: ['total', 'page', 'size', 'list'],
      },
      PageResponse: {
        type: 'object',
        properties: {
          code: { type: 'integer', example: 200 },
          message: { type: 'string', example: '查询成功' },
          data: { $ref: '#/components/schemas/PageData' },
        },
      },
      OkNull: {
        type: 'object',
        description: '无返回数据的成功响应',
        properties: {
          code: { type: 'integer', example: 200 },
          message: { type: 'string', example: '操作成功' },
          data: { nullable: true, example: null },
        },
      },

      /* ---------- 分页 / 通用查询参数 ---------- */
      PageQuery: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1, default: 1, description: '页码，从 1 开始' },
          size: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: '每页条数' },
        },
      },

      /* ---------- 业务实体 ---------- */
      Dept: {
        type: 'object',
        properties: {
          id: { type: 'string', example: 'D01', description: '部门 ID' },
          deptName: { type: 'string', example: '教学部' },
          deptShort: { type: 'string', example: '教学', nullable: true, description: '简称' },
          parentId: { type: 'string', example: 'D00', nullable: true, description: '上级部门 ID' },
          parentName: { type: 'string', example: '全部门', nullable: true },
          deptLevel: { type: 'integer', example: 2, description: '1 校级 / 2 部门 / 3 学段（后端计算，前端不传）' },
          sortNo: { type: 'integer', example: 1 },
          remark: { type: 'string', nullable: true },
          roleCount: { type: 'integer', example: 3, description: '含子部门口径' },
          userCount: { type: 'integer', example: 5, description: '含子部门口径' },
        },
      },
      DeptTreeNode: {
        allOf: [
          { $ref: '#/components/schemas/Dept' },
          { type: 'object', properties: { children: { type: 'array', items: { $ref: '#/components/schemas/DeptTreeNode' } } } },
        ],
      },
      DeptSavePayload: {
        type: 'object',
        required: ['deptName'],
        properties: {
          deptName: { type: 'string', minLength: 1, example: '教学部' },
          deptShort: { type: 'string', nullable: true, example: '教学' },
          parentId: { type: 'string', nullable: true, example: 'D00' },
          sortNo: { type: 'integer', example: 1 },
          remark: { type: 'string', nullable: true },
        },
      },
      Role: {
        type: 'object',
        properties: {
          id: { type: 'string', example: 'R01' },
          roleCode: { type: 'string', example: 'SYS_ADMIN' },
          roleName: { type: 'string', example: '系统管理员' },
          roleType: { type: 'string', example: '管理职位' },
          roleStatus: { type: 'string', enum: ['启用', '停用'], example: '启用' },
          deptId: { type: 'string', nullable: true, example: 'D01' },
          deptName: { type: 'string', nullable: true, example: '教学部' },
          isSys: { type: 'boolean', example: true, description: '系统预置职位：不可删、编码不可改' },
          permCount: { type: 'integer', example: 185 },
          userCount: { type: 'integer', example: 2 },
          sortNo: { type: 'integer', example: 1 },
          remark: { type: 'string', nullable: true },
        },
      },
      RoleSavePayload: {
        type: 'object',
        required: ['roleName'],
        properties: {
          roleName: { type: 'string', example: '助教组长' },
          roleCode: {
            type: 'string',
            nullable: true,
            description:
              '★ 2026-10-19 起界面不再维护（用户要求全系统去掉「职位编码」）：' +
              '不传由后端自动生成（如 ROLE_0001）。该字段是跨模块鉴权连接键，响应里仍会返回。',
            example: 'ROLE_0001',
          },
          roleType: {
            type: 'string',
            nullable: true,
            description:
              '★ 2026-10-20 起界面不再维护（用户要求去掉「职位类型」）：不传按默认「业务职位」落库；' +
              '字段与接口保留，编辑时不传则保持原值。',
            example: '管理职位',
          },
          roleStatus: { type: 'string', enum: ['启用', '停用'], default: '启用' },
          deptId: { type: 'string', nullable: true, example: 'D01' },
          sortNo: { type: 'integer', example: 99 },
          remark: { type: 'string', nullable: true },
          perms: {
            type: 'object',
            description: '可选：同时提交权限映射。key = `模块key||功能点名`，value = 动作编码数组',
            additionalProperties: { type: 'array', items: { type: 'string' } },
            example: { 'market||预到校名单': ['view', 'add'], 'perm||职位管理': ['view'] },
          },
        },
      },
      User: {
        type: 'object',
        properties: {
          id: { type: 'string', example: 'U013' },
          userName: { type: 'string', example: '系统管理员', description: '仅汉字，≥ 2 位' },
          account: { type: 'string', example: 'admin', description: '字母/数字，4-20 位，全局唯一' },
          gwNo: { type: 'string', example: 'GW1016', description: 'GW + 4 位数字' },
          phone: { type: 'string', example: '13800000013', description: '11 位、以 1 开头，全局唯一' },
          gender: { type: 'integer', enum: [1, 2], example: 1, description: '1 男 / 2 女' },
          genderName: { type: 'string', example: '男' },
          age: { type: 'integer', example: 30, description: '20-65' },
          deptId: { type: 'string', example: 'D_ADM' },
          deptName: { type: 'string', example: '行政' },
          roleIds: { type: 'array', items: { type: 'string' }, example: ['R13'], description: '至少 1 个' },
          roleNames: { type: 'array', items: { type: 'string' }, example: ['系统管理员'] },
          userStatus: { type: 'string', enum: ['正常', '已停用', '已锁定'], example: '正常' },
          needChangePwd: { type: 'boolean', example: false },
          effectivePermCount: { type: 'integer', example: 185, description: '实际生效权限点数' },
          lastLoginTime: { type: 'string', nullable: true, example: '2026-09-29 15:00:00' },
        },
      },
      UserSavePayload: {
        type: 'object',
        required: ['userName', 'account', 'gwNo', 'roleIds'],
        properties: {
          userName: { type: 'string', pattern: '^[\\u4e00-\\u9fa5]{2,}$', example: '林晓' },
          account: { type: 'string', pattern: '^[A-Za-z0-9]{4,20}$', example: 'qitian' },
          gwNo: { type: 'string', pattern: '^GW\\d{4}$', example: 'GW1018' },
          phone: { type: 'string', pattern: '^1\\d{10}$', example: '13800000018' },
          gender: { type: 'integer', enum: [1, 2], example: 2 },
          age: { type: 'integer', minimum: 16, maximum: 70, example: 22 },
          deptId: { type: 'string', example: 'D_ADM' },
          roleIds: { type: 'array', items: { type: 'string' }, minItems: 1, example: ['R13'] },
          userStatus: { type: 'string', enum: ['正常', '已停用', '已锁定'], default: '正常' },
          password: { type: 'string', description: '留空则由后端按当前密码策略生成' },
          needChangePwd: { type: 'boolean', default: true },
          remark: { type: 'string', nullable: true },
        },
      },
      AuthProfile: {
        type: 'object',
        description: '跨模块：登录模块拿这个签发 token',
        properties: {
          userId: { type: 'string', example: 'U013' },
          userName: { type: 'string', example: '系统管理员' },
          account: { type: 'string', example: 'admin' },
          deptId: { type: 'string', example: 'D_ADM' },
          deptName: { type: 'string', example: '行政' },
          userStatus: { type: 'string', example: '正常' },
          roles: { type: 'array', items: { type: 'string' }, example: ['SYS_ADMIN'] },
          roleIds: { type: 'array', items: { type: 'string' }, example: ['R13'] },
          roleNames: { type: 'array', items: { type: 'string' }, example: ['系统管理员'] },
          permissions: {
            type: 'array',
            items: { type: 'string' },
            description: '所有职位权限的并集去重，元素形如 模块:功能点:动作中文名',
            example: ['market:预到校名单:查看', 'market:预到校名单:新建'],
          },
          dataScope: { type: 'integer', enum: [1, 2, 3, 4], example: 4, description: '1 本人 / 2 本班级 / 3 本部门 / 4 全部数据（取最宽一档）' },
          needChangePwd: { type: 'boolean', example: false },
        },
      },
      PermActionItem: {
        type: 'object',
        description: '细粒度动作（权限树叶子节点）',
        properties: {
          actionCode: { type: 'string', example: 'view', description: '如 view / import / confirmPay' },
          actionName: { type: 'string', example: '查看', description: '如 查看 / 导入 / 确认出款' },
          baseAction: { type: 'string', example: 'view', description: '归入字典的 6 个基类之一' },
          baseActionName: { type: 'string', example: '查看' },
          remark: { type: 'string', nullable: true, description: '动作说明' },
        },
      },
      PermItem: {
        type: 'object',
        description: '功能点（权限树二级节点）',
        properties: {
          id: { type: 'string', example: 'I01' },
          itemName: { type: 'string', example: '预到校名单' },
          parentItemName: { type: 'string', nullable: true, example: '教质/学术审批', description: '二级功能点的父功能点名' },
          actions: { type: 'array', items: { $ref: '#/components/schemas/PermActionItem' } },
          remark: { type: 'string', nullable: true },
          isCustom: {
            type: 'boolean',
            example: false,
            description: 'true = 管理员自建（可改可删）；false / 缺省 = 系统预置，只读',
          },
          checked: {
            type: 'array',
            items: { type: 'string' },
            description: '该职位在此功能点下已勾选的动作名（职位权限详情接口返回）',
          },
        },
      },
      PermItemSavePayload: {
        type: 'object',
        description: '新增 / 修改自建权限点的入参（模块 → 功能点 → 动作，与预置格式一致）',
        required: ['itemName', 'actions'],
        properties: {
          moduleKey: { type: 'string', example: 'market', description: '已有板块标识；新建板块传 __new__' },
          moduleName: { type: 'string', example: '招生管理', description: '新建板块时的名称' },
          moduleIcon: { type: 'string', example: '🎓' },
          moduleSort: { type: 'integer', example: 9 },
          itemName: { type: 'string', example: '招生报名登记' },
          parentItemName: { type: 'string', nullable: true },
          remark: { type: 'string', nullable: true },
          actions: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              required: ['actionName'],
              properties: {
                actionCode: { type: 'string', example: 'view', description: '留空时后端按 baseAction 自动补' },
                actionName: { type: 'string', example: '查看' },
                baseAction: { type: 'integer', enum: [1, 2, 3, 4, 5, 6], example: 1 },
                remark: { type: 'string', nullable: true },
              },
            },
          },
        },
      },
      PermModule: {
        type: 'object',
        description: '权限模块（权限树一级节点）',
        properties: {
          moduleKey: { type: 'string', example: 'perm', description: '模块 key' },
          moduleName: { type: 'string', example: '权限管理' },
          moduleIcon: { type: 'string', example: '🔐', description: '模块图标 emoji' },
          sortNo: { type: 'integer', example: 8 },
          items: { type: 'array', items: { $ref: '#/components/schemas/PermItem' } },
          grantedItemCount: { type: 'integer', description: '已授权功能点数（职位权限详情接口返回）' },
          itemCount: { type: 'integer', description: '功能点总数' },
          checkedCount: { type: 'integer', description: '该模块已勾选动作数（职位权限详情接口返回）' },
        },
      },
      PermOptionItem: {
        type: 'object',
        description: '字典项统一结构（不是裸字符串），前端 el-select 直接用 value / label',
        properties: {
          value: { example: '管理职位', description: '提交给后端的原值' },
          label: { type: 'string', example: '管理职位', description: '展示给用户的中文名' },
        },
      },
      Log: {
        type: 'object',
        properties: {
          id: { type: 'string', example: 'L001' },
          logTime: { type: 'string', example: '2026-09-29 15:00:00' },
          operatorName: { type: 'string', example: '系统管理员' },
          moduleName: { type: 'string', example: '权限管理' },
          actionType: { type: 'string', example: '登录' },
          targetObj: { type: 'string', example: 'Web 后台' },
          beforeValue: { type: 'string', example: '—' },
          afterValue: { type: 'string', example: '登录成功' },
          ip: { type: 'string', example: '127.0.0.1' },
          result: { type: 'string', enum: ['成功', '失败'], example: '成功' },
        },
      },

      /* ---------- 跨模块调用 ---------- */
      ModuleProbe: {
        type: 'object',
        description: '单个模块的探活结果',
        properties: {
          module: { type: 'string', example: 'edu', description: '模块简称' },
          label: { type: 'string', example: '教务管理(8002)' },
          url: { type: 'string', example: 'http://localhost:8002' },
          online: { type: 'boolean', example: true },
          latency: { type: 'integer', example: 12, description: '往返耗时（毫秒）' },
          service: { type: 'string', nullable: true, example: 'server-edu' },
          message: { type: 'string', example: '在线' },
        },
      },
      ModuleProbeReport: {
        type: 'object',
        description: '全部模块的探活汇总',
        properties: {
          total: { type: 'integer', example: 7 },
          onlineCount: { type: 'integer', example: 1 },
          offlineCount: { type: 'integer', example: 6 },
          checkedAt: { type: 'string', example: '2026-09-30 20:15:33' },
          list: {
            type: 'array',
            items: { $ref: '#/components/schemas/ModuleProbe' },
          },
        },
      },
    },
  },
  security: [{ bearerAuth: [] }],
};

/**
 * ⚠️ 踩坑记录：swagger-jsdoc 内部用 glob 扫描文件，而 **glob 不认 Windows 反斜杠**
 *    （它会当成转义字符）。所以这里必须把 `path.join()` 的结果统一换成 `/`，
 *    否则在 Windows 上会静默扫到 0 个文件 —— 文档打开是空的，但不报任何错。
 *    另外本机项目路径含中文（交付包/林晓），实测 glob 对中文路径没问题。
 */
const pathsGlob = path
  /* ⚠️ 2026-10-06 修：这里原来写 `src/swagger/paths/*.ts`（少了 `perm/`）。
   *   单体合并时 swagger 目录从 src/swagger/ 挪到了 src/perm/swagger/，
   *   但这条 glob 没跟着改 → 扫到 0 个文件 → /api-docs.json 的 paths 恒为空，
   *   12 个注解文件（48 个接口）全部被静默忽略（实测 paths 数 = 0）。 */
  .join(process.cwd(), 'src/perm/swagger/paths/*.ts')
  .split(path.sep)
  .join('/');

export const swaggerSpec = swaggerJsdoc({
  definition,
  apis: [pathsGlob],
});
