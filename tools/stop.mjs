#!/usr/bin/env node
/**
 * 良志学管 · 统一门户版 —— 停止服务
 *
 * 只结束监听 8004 / 5173 的进程（按端口精确匹配 + 进程树），
 * 不碰 MySQL，也不用 taskkill /IM node.exe 这种会误杀别人的宽匹配。
 *
 * 用法：双击 stop-all.bat，或 node tools/stop.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// ★ 2026-10-15 加固：PATH 自愈 + 系统命令绝对路径
//   这台机器的 PATH 曾丢掉 C:\Windows\System32，导致 netstat / taskkill
//   静默失效（杀不掉进程，还看不出原因）。这里在进程内补回，并给系统工具
//   一个绝对路径兜底。原因与细节见 tools/start.mjs 顶部同一段注释。
// ---------------------------------------------------------------------------
const SYS_ROOT = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
const REQUIRED_PATH_DIRS = [
  path.dirname(process.execPath),
  path.join(SYS_ROOT, 'System32'),
  SYS_ROOT,
  path.join(SYS_ROOT, 'System32', 'Wbem'),
  path.join(SYS_ROOT, 'System32', 'WindowsPowerShell', 'v1.0'),
];
{
  const norm = (s) => s.trim().replace(/[\\/]+$/, '').toLowerCase();
  const current = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const have = new Set(current.map(norm));
  const missing = REQUIRED_PATH_DIRS.filter((d) => !have.has(norm(d)));
  if (missing.length) process.env.PATH = [...missing, ...current].join(path.delimiter);
}
function sysTool(name) {
  if (process.platform !== 'win32') return name;
  const exe = path.join(SYS_ROOT, 'System32', `${name}.exe`);
  return fs.existsSync(exe) ? exe : name;
}

const C = { reset: '\x1b[0m', bold: '\x1b[1m', green: '\x1b[32m', gray: '\x1b[90m', cyan: '\x1b[36m' };
const paint = (c, s) => (process.env.NO_COLOR === '1' ? s : c + s + C.reset);

const PORTS = [
  [8004, '后端'],
  [5173, '前端'],
];

console.log('');
console.log(paint(C.bold + C.cyan, '═'.repeat(58)));
console.log(paint(C.bold, '  良志学管 · 统一门户版   停止服务'));
console.log(paint(C.gray, '  只结束监听 8004 / 5173 的进程，不碰 MySQL'));
console.log(paint(C.bold + C.cyan, '═'.repeat(58)));

/** netstat -ano → 该端口的 LISTENING PID 列表（去重） */
function pidsOnPort(port) {
  const pids = new Set();
  const isWin = process.platform === 'win32';
  try {
    if (isWin) {
      const out = spawnSync(sysTool('netstat'), ['-ano'], { encoding: 'utf8', windowsHide: true }).stdout || '';
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/^\s*TCP\s+\S*:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
        if (m && Number(m[1]) === port) pids.add(m[2]);
      }
    } else {
      const out = spawnSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout || '';
      out.split(/\s+/).filter(Boolean).forEach((p) => pids.add(p));
    }
  } catch { /* 忽略 */ }
  return [...pids];
}

let stopped = 0;
for (const [port, label] of PORTS) {
  const pids = pidsOnPort(port);
  if (pids.length === 0) {
    console.log(paint(C.gray, `  [跳过] 端口 ${port}（${label}）没在运行`));
    continue;
  }
  for (const pid of pids) {
    const isWin = process.platform === 'win32';
    const r = isWin
      ? spawnSync(sysTool('taskkill'), ['/PID', pid, '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      : spawnSync('kill', ['-9', pid], { stdio: 'ignore' });
    if (r.status === 0) {
      console.log(paint(C.green, `  [停止] 端口 ${port}（${label}）已结束进程树 PID ${pid}`));
      stopped++;
    } else {
      console.log(`  [失败] 端口 ${port} PID ${pid} 结束失败（可能需要管理员权限）`);
    }
  }
}

console.log('');
console.log(paint(C.bold, '─'.repeat(58)));
console.log(stopped ? `  已停止 ${stopped} 个进程。MySQL 仍在运行。` : '  没有需要停止的进程。');
console.log(paint(C.gray, '  如需连 MySQL 一起停掉：'));
console.log(paint(C.gray, '    管理员 cmd → net stop mysql57   （服务名按实际情况，可能是 mysql80）'));
console.log(paint(C.bold, '─'.repeat(58)));
console.log('');
