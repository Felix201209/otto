/**
 * @license
 * Copyright 2026 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 飞书后台常驻 daemon 的进程管理层。
 *
 * 设计：复用现成的 `otto --feishu`（启动后自动跑 /feishu start，render 对非 TTY
 * 有 dummyStdin 兜底）。daemon = 把它以 detached 子进程拉起，写 pid/日志到
 * ~/.otto-user/，关掉终端也继续运行。这里只做进程管理，不重写飞书逻辑。
 *
 * 命令：otto feishu daemon <start|stop|status>
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const CONFIG_DIR = path.join(os.homedir(), '.otto-user');
const PID_FILE = path.join(CONFIG_DIR, 'feishu-daemon.pid');
const LOG_FILE = path.join(CONFIG_DIR, 'feishu-daemon.log');

interface PidInfo {
  pid: number;
  startedAt?: number;
}

/** 读取 pid 文件（兼容旧的纯数字格式与 JSON 格式）。 */
function readPidInfo(): PidInfo | null {
  try {
    const raw = fs.readFileSync(PID_FILE, 'utf8').trim();
    if (!raw) return null;
    if (raw.startsWith('{')) {
      const obj = JSON.parse(raw);
      const pid = Number(obj.pid);
      return Number.isInteger(pid) && pid > 0 ? { pid, startedAt: obj.startedAt } : null;
    }
    const pid = parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? { pid } : null;
  } catch {
    return null;
  }
}

/** 进程是否存活（signal 0 探测，不真正发信号）。 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function clearPidFile(): void {
  try {
    fs.unlinkSync(PID_FILE);
  } catch {
    /* 文件不存在即可忽略 */
  }
}

function humanUptime(startedAt?: number, now = Date.now()): string {
  if (!startedAt) return '';
  const sec = Math.max(0, Math.floor((now - startedAt) / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return `${h}h${m}m`;
  if (m) return `${m}m${s}s`;
  return `${s}s`;
}

export function feishuDaemonStatus(now = Date.now()): { text: string; running: boolean } {
  const info = readPidInfo();
  if (info && isAlive(info.pid)) {
    const up = humanUptime(info.startedAt, now);
    return {
      running: true,
      text: [
        `✅ 飞书 daemon 正在后台运行 (PID ${info.pid}${up ? `, 已运行 ${up}` : ''})`,
        `   日志: ${LOG_FILE}`,
        `   停止: otto feishu daemon stop`,
      ].join('\n'),
    };
  }
  if (info) clearPidFile(); // 残留的过期 pid 文件
  return {
    running: false,
    text: ['⚪ 飞书 daemon 未运行', '   启动: otto feishu daemon start'].join('\n'),
  };
}

export function feishuDaemonStop(): { text: string } {
  const info = readPidInfo();
  if (!info || !isAlive(info.pid)) {
    clearPidFile();
    return { text: '⚪ 飞书 daemon 未在运行。' };
  }
  try {
    process.kill(info.pid, 'SIGTERM');
    clearPidFile();
    return { text: `🛑 已停止飞书 daemon (PID ${info.pid})。` };
  } catch (e) {
    return { text: `❌ 停止失败 (PID ${info.pid}): ${(e as Error).message}` };
  }
}

/**
 * 后台拉起飞书 bot。复用 `otto --feishu`（自动 /feishu start）。
 * @param now 注入当前时间戳（脚本环境 Date.now 不可用时用，测试也可注入）。
 * @param spawnCommandOverride 仅供测试：用一个无害的长驻进程替代真实 otto，
 *        以便验证 pid/detach/stop/status 机制而不真正连飞书。
 */
export function feishuDaemonStart(
  now = Date.now(),
  spawnCommandOverride?: { command: string; args: string[] },
): { text: string; pid?: number } {
  const existing = readPidInfo();
  if (existing && isAlive(existing.pid)) {
    return {
      pid: existing.pid,
      text: `飞书 daemon 已在运行 (PID ${existing.pid})。需重启：先 otto feishu daemon stop 再 start。`,
    };
  }

  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  } catch {
    /* 目录已存在即可忽略 */
  }

  const logFd = fs.openSync(LOG_FILE, 'a');
  const entry = process.argv[1]; // otto.js / dist/index.js
  const cmd = spawnCommandOverride?.command ?? process.execPath;
  const args = spawnCommandOverride?.args ?? [entry, '--feishu'];

  const child = spawn(cmd, args, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    cwd: process.cwd(),
    env: { ...process.env, OTTO_FEISHU_DAEMON: '1' },
  });
  child.unref();

  if (!child.pid) {
    return { text: '❌ 启动失败：无法 spawn daemon 进程。' };
  }

  fs.writeFileSync(PID_FILE, JSON.stringify({ pid: child.pid, startedAt: now }), 'utf8');

  return {
    pid: child.pid,
    text: [
      `🚀 飞书 daemon 已在后台启动 (PID ${child.pid})。`,
      `   工作目录: ${process.cwd()}`,
      `   日志: ${LOG_FILE}`,
      `   状态: otto feishu daemon status  ｜  停止: otto feishu daemon stop`,
      `   关掉这个终端它也会继续运行。`,
    ].join('\n'),
  };
}

/** 命令分发：otto feishu daemon <start|stop|status>。返回打印文本与退出码。 */
export function runFeishuDaemonControl(action: string | undefined): {
  text: string;
  code: number;
} {
  switch ((action || '').toLowerCase()) {
    case 'start':
      return { text: feishuDaemonStart().text, code: 0 };
    case 'stop':
      return { text: feishuDaemonStop().text, code: 0 };
    case 'status':
      return { text: feishuDaemonStatus().text, code: 0 };
    default:
      return {
        text: '用法: otto feishu daemon <start|stop|status>',
        code: action ? 1 : 0,
      };
  }
}

export const _daemonPaths = { PID_FILE, LOG_FILE, CONFIG_DIR };
