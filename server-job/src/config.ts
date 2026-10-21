/**
 * 服务配置
 *
 * ⚠️ 所有配置从环境变量读，不要硬编码！
 *    本地开发和联调时地址不一样，硬编码会导致每个人都要改代码。
 *
 * ⚠️⚠️ 这里故意【不给 PORT 和 DB_NAME 设默认值】。原因：
 *    如果给了默认值，有人忘改 .env 时程序不会报错，
 *    而是悄悄用默认值启动 —— 结果连到了【别人的库】，改错了别人的数据。
 *    这种错误在联调时极难排查，所以我们宁可让它启动失败，也不让它跑错。
 */

import * as dotenv from 'dotenv';
dotenv.config();

/**
 * 读一个"必须存在"的环境变量。
 * 读不到就直接抛错，让服务起不来 —— 起不来比跑错强。
 */
function requireEnv(key: string, hint: string): string {
  const value = process.env[key];
  if (!value || !value.trim()) {
    throw new Error(
      [
        '',
        '══════════════════════════════════════════════',
        `  ❌ 启动失败：缺少环境变量 ${key}`,
        '',
        `  怎么修：打开本目录下的 .env 文件，补上这一行：`,
        `      ${key}=${hint}`,
        '',
        '  如果你还没有 .env 文件：',
        '      复制 .env.example 改名为 .env',
        '',
        '  ⚠️ 注意：.env 要和 package.json 在同一个目录里。',
        '══════════════════════════════════════════════',
        '',
      ].join('\n'),
    );
  }
  return value.trim();
}

/**
 * 本服务端口（必填，无默认值）
 * ★ 抽成局部常量：`services` 里的跨模块地址默认值要用它，
 *   但在 `config` 对象字面量内部无法引用 `config.port`（还没有赋值完）。
 */
const SELF_PORT = Number(requireEnv('PORT', '8004'));

export const config = {
  /** 本服务端口（必填，无默认值） */
  port: SELF_PORT,

  /** 运行环境 */
  env: process.env.NODE_ENV || 'development',

  /** 数据库配置 */
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD ?? '',
    /** 本模块自己的库名（必填，无默认值 —— 防止连错库） */
    database: requireEnv('DB_NAME', 'sms_job'),
    charset: 'utf8mb4',
    /** ⚠️ 必须设，否则时间差 8 小时 */
    timezone: '+08:00',
  },

  /** JWT 配置（登录模块用） */
  jwt: {
    secret: process.env.JWT_SECRET || 'sms-dev-secret-change-me',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },

  /**
   * ⭐ 内部服务令牌（模块间同步用）
   *
   * ★ 2026-10-05 合并：统一唯一来源 —— 全进程只有这一处算出默认值。
   *
   * 【为什么必须统一】
   *   合并前三处各自写了不同的默认值：
   *     · class/middleware/auth.ts  → 未配置则**跳过校验**（最危险，等于裸奔）
   *     · consult/config.ts         → 默认 'test'
   *     · routes/upgrade.route.ts   → 默认 'liangzhi-internal-dev-token'
   *   只要有一台机器的 .env 漏配，A 推 B 就会「凭证无效」或「静默放行」，
   *   而且报错信息完全指不到原因。
   *
   * 【现在的行为】默认值非空 → 校验【永远生效】；双方都读这一处 → 永远一致。
   *
   * ★ 2026-10-14：默认值由 `'sms-internal-token'` 改成 `'CHANGE_ME_INTERNAL_TOKEN'`。
   *   原因是这个仓库是公开的 —— 原来那个默认值等于把「内部服务令牌」写在
   *   任何人都能看到的地方，一旦某台机器漏配 .env，就等于用公开的令牌在跑。
   *   新默认值仍然「非空且全局一致」（校验照常生效、各模块互相匹配），
   *   但字面意思明确告诉人：这是占位符，必须配置。
   *   **生产环境请在 .env 里设成随机串。**
   */
  internalToken: process.env.INTERNAL_TOKEN || 'CHANGE_ME_INTERNAL_TOKEN',

  /**
   * 其他服务的地址（跨模块调用用）
   *
   * ⚠️ 本地开发时，把同事的机器 IP 填进去就能互相调
   *    例：AUTH_URL=http://<your-host>:8001
   *
   * ★ 2026-10-08 深度单体合并后：原「门户/咨询/财务/权限」四个独立服务
   *   （8000/8001/8005/8006）**已全部并入本服务（8004）**。
   *   所以这里的默认值不能再指旧端口 —— 那几个端口上根本没有服务，
   *   跨模块调用会直接连接失败（最典型：就业侧推退费给财务，
   *   打向 8005 空端口 → 财务永远收不到单子）。
   *   统一兜底到「本进程自己」= `http://localhost:<本服务端口>`。
   */
  services: {
    auth: process.env.AUTH_URL || `http://localhost:${SELF_PORT}`,
    edu: process.env.EDU_URL || `http://localhost:${SELF_PORT}`,
    class: process.env.CLASS_URL || `http://localhost:${SELF_PORT}`,
    job: process.env.JOB_URL || `http://localhost:${SELF_PORT}`,
    finance: process.env.FINANCE_URL || `http://localhost:${SELF_PORT}`,
    perm: process.env.PERM_URL || `http://localhost:${SELF_PORT}`,
    stat: process.env.STAT_URL || `http://localhost:${SELF_PORT}`,
    /**
     * ★ 2026-10-20 新增：咨询模块（原 8001，现已并入本进程）
     *
     * 用途：试学闭环里「班主任发起补费」「退学通过后回写咨询状态」，
     * 班级模块要调咨询侧的 /api/consult/student/internal/* 内部接口。
     */
    consult: process.env.CONSULT_URL || `http://localhost:${SELF_PORT}`,
  },
};
