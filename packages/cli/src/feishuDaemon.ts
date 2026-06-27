/**
 * @license
 * Copyright 2026 Felix
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
// 健康标记：daemon 子进程自启完成后写入真实状态（ready=飞书已连接 / failed=进程活着但没连上）。
// status 据此诚实汇报，而不是纯 PID 探活（否则 bot 死了也会谎报"运行中"）。
const HEALTH_FILE = path.join(CONFIG_DIR, 'feishu-daemon.health');

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

interface DaemonHealth {
  status: 'ready' | 'failed';
  reason?: string;
  at?: number;
}

function readHealth(): DaemonHealth | null {
  try {
    return JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8')) as DaemonHealth;
  } catch {
    return null;
  }
}

function clearHealth(): void {
  try {
    fs.unlinkSync(HEALTH_FILE);
  } catch {
    /* 文件不存在即可忽略 */
  }
}

/**
 * 由 daemon 子进程（`otto --feishu`，OTTO_FEISHU_DAEMON=1）在自启 `/feishu start`
 * 完成后调用，回报飞书是否真的连上。这样 `otto feishu daemon status` 能诚实区分
 * 「进程活着且 bot 已连」与「进程活着但 bot 没连上」，不再谎报健康。
 */
export function writeDaemonHealth(
  status: 'ready' | 'failed',
  reason = '',
  now = Date.now(),
): void {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(HEALTH_FILE, JSON.stringify({ status, reason, at: now }), {
      encoding: 'utf8',
      mode: 0o600,
    });
  } catch {
    /* best effort，写不进也不影响 bot 运行 */
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
    const health = readHealth();

    if (health?.status === 'ready') {
      return {
        running: true,
        text: [
          `✅ 飞书 daemon 正在后台运行,bot 已连接 (PID ${info.pid}${up ? `, 已运行 ${up}` : ''})`,
          `   日志: ${LOG_FILE}`,
          `   停止: otto feishu daemon stop`,
        ].join('\n'),
      };
    }

    if (health?.status === 'failed') {
      return {
        running: true,
        text: [
          `⚠️ daemon 进程在跑 (PID ${info.pid}),但飞书未连接${health.reason ? `(${health.reason})` : ''}。`,
          `   多半是凭证/权限/网络问题。请看日志: ${LOG_FILE}`,
          `   修好后: otto feishu daemon stop 再 otto feishu daemon start`,
        ].join('\n'),
      };
    }

    // 尚未回报健康：刚启动给宽限期,超时则诚实提示疑似未连上(不再谎报"运行中")。
    const sinceStart = info.startedAt ? now - info.startedAt : Number.POSITIVE_INFINITY;
    if (sinceStart < 90_000) {
      return {
        running: true,
        text: [
          `⏳ 飞书 daemon 启动中 (PID ${info.pid}${up ? `, ${up}` : ''})…`,
          `   稍候再 otto feishu daemon status 查看;若长时间停在此请看日志: ${LOG_FILE}`,
        ].join('\n'),
      };
    }
    return {
      running: true,
      text: [
        `⚠️ daemon 进程在跑 (PID ${info.pid}, 已运行 ${up}),但未确认飞书已连接(疑似启动失败)。`,
        `   请看日志: ${LOG_FILE},或 otto feishu daemon stop 再 start`,
      ].join('\n'),
    };
  }
  if (info) {
    clearPidFile(); // 残留的过期 pid 文件
    clearHealth();
  }
  return {
    running: false,
    text: ['⚪ 飞书 daemon 未运行', '   启动: otto feishu daemon start'].join('\n'),
  };
}

export function feishuDaemonStop(): { text: string } {
  const info = readPidInfo();
  if (!info || !isAlive(info.pid)) {
    clearPidFile();
    clearHealth();
    return { text: '⚪ 飞书 daemon 未在运行。' };
  }
  try {
    process.kill(info.pid, 'SIGTERM');
    clearPidFile();
    clearHealth();
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

  // 清掉上一轮的健康标记，本次由子进程自启完成后重新写入（避免旧标记污染宽限期判断）。
  clearHealth();

  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  } catch {
    /* 目录已存在即可忽略 */
  }

  // 日志会捕获子进程 stdout/stderr（含 OAuth 授权 URL 等敏感输出），与同目录其它
  // 文件一样收紧到 0o600（openSync 的 mode 仅对新建文件生效，旧日志再 chmod 兜底）。
  const logFd = fs.openSync(LOG_FILE, 'a', 0o600);
  try {
    fs.chmodSync(LOG_FILE, 0o600);
  } catch {
    /* ignore */
  }
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

  fs.writeFileSync(PID_FILE, JSON.stringify({ pid: child.pid, startedAt: now }), {
    encoding: 'utf8',
    mode: 0o600,
  });

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
