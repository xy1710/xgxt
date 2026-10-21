import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'path';

/**
 * Vite 配置
 *
 * ⚠️ 重点看 server.proxy：
 *    前端写 /api/xxx，Vite 自动转发到后端端口。
 *    这样本地开发时，前端和后端是"同一个地址"，天然没有跨域问题。
 *
 * 💡 这个文件在生成"专属包"时已经帮你改好了，通常不用动。
 *    只有当你要【调用别的模块的接口】时，才需要用到下面其他几条。
 */
export default defineConfig({
  plugins: [vue()],

  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },

  server: {
    // ★ 2026-10-08：端口支持被环境变量覆盖。
    //    一键启动器（tools/start.mjs）会传 FRONTEND_PORT / PORT，
    //    这样同一台机器上可以同时跑两个副本而不抢 5173。
    //    没传就还是默认 5173。
    port: Number(process.env.FRONTEND_PORT || process.env.PORT || 5173),
    strictPort: false,

    // ★ 2026-10-09：允许【局域网内其他电脑】访问。
    //    默认不写 host 时，Vite 只监听 localhost（127.0.0.1），
    //    外面的人即使知道你的 IP 也连不上（会被拒）。
    //    '0.0.0.0' = 监听本机【所有网卡】，别人访问 http://你的局域网IP:5173 即可。
    //    ⚠️ 用 '0.0.0.0' 而不是 true：本机有 4 张网卡（含 VMware 虚拟网卡），
    //       写 true 可能绑错网卡导致依然访问不到。
    //    ⚠️ 改成对外后，同局域网的人都能打开这个页面，注意数据安全。
    host: '0.0.0.0',

    // 💡 open: true 会让 Vite【每次重启都自动打开一个新浏览器窗口】。
    //    开发时改文件会频繁触发重启，于是窗口一直往外弹，很烦。
    //    所以这里默认关掉 —— 自己开一次 http://localhost:5173 就行。
    //    （如果你确实想让它自动开，改回 true 即可）
    open: false,

    proxy: {
      // ---- 你自己模块的接口（已配好，不用动）----
      '/api/job': { target: 'http://localhost:8004', changeOrigin: true },

      // ---- 其他模块 ----
      // ★★ 2026-10-05 深度单体合并：门户 / 咨询 / 财务 / 权限 四个模块
      //    已经【全部并入 8004 单进程】，不再有 8001 / 8005 / 8006 独立服务。
      //    ⚠️ 不改这里的端口，请求会打到没人监听的端口 → 前端全报「服务异常」。
      '/api/portal': { target: 'http://localhost:8004', changeOrigin: true },   // 统一门户（登录 + 账号）
      '/api/consult': { target: 'http://localhost:8004', changeOrigin: true },  // 市场咨询（已并入 8004）
      '/api/edu': { target: 'http://localhost:8004', changeOrigin: true },      // 教务管理（已并入 8004）
      // ⚠️ 教学管理（初高）必须写在 /api/class 之前：
      //    Vite 的 proxy 键是【前缀匹配】，/api/class 能匹配 /api/class-jh/...，
      //    两条都指向 8004 时功能上无差别，但显式列出来更好排查。
      '/api/class-jh': { target: 'http://localhost:8004', changeOrigin: true }, // 教学管理（初高·已并入 8004）
      '/api/class': { target: 'http://localhost:8004', changeOrigin: true },    // 班级管理（大学部·已并入 8004）
      '/api/finance': { target: 'http://localhost:8004', changeOrigin: true },  // 财务管理（已并入 8004）
      '/api/perm': { target: 'http://localhost:8004', changeOrigin: true },     // 权限管理（已并入 8004）
      '/api/stat': { target: 'http://localhost:8004', changeOrigin: true },     // 数据统计

      // ---- ★ 第 2 期「业务域合并」统一教学接口 ----
      //    ⚠️ 千万别漏这一条：漏了的话 /api/teaching/* 会被 Vite 当成**前端路由**，
      //       返回 index.html（HTTP 200 + HTML），前端解析 JSON 失败 →
      //       现象是"接口没报错但数据全是空的"，极难排查。
      //       （这正是本期端到端自检脚本抓出来的第一个真 bug。）
      '/api/teaching': { target: 'http://localhost:8004', changeOrigin: true }, // 统一教学接口（出勤等）

      // ---- ★ 2026-10-20：缴费凭证等上传文件的静态托管 ----
      //   后端 app.ts 把 /uploads 挂在 server-job/uploads（咨询/财务/初高的凭证都在这里）。
      //   漏了这条，<img src="/uploads/..."> 会被 Vite 当**前端路由**返回 index.html，
      //   现象是「凭证图片打不开、也没有 404 报错」，极难排查。
      //   （2026-10-15 版本只提到 /uploads/voucher/，这里补全为整个 /uploads。）
      '/uploads': { target: 'http://localhost:8004', changeOrigin: true },
    },
  },
});
