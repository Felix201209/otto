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
import { spawn, execFileSync } from 'node:child_process';
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

/** 进程身份信息（stop 前校验用，防 PID 复用误杀无关进程）。 */
export interface ProcIdentity {
  /** 进程启动时间（毫秒时间戳）；ps lstart 解析失败时为 null。 */
  startedAtMs: number | null;
  /** 进程完整命令行。 */
  command: string;
}

/**
 * pid 文件记录的 startedAt 与 ps 实测启动时间的允许误差。
 * 正常 spawn → 写 pid 文件间隔 <1s（ps lstart 精度 1s）；PID 被复用的无关进程
 * 启动时间通常与记录相差极大，60s 容差足以区分且不误伤。
 */
const PID_START_TOLERANCE_MS = 60_000;

/**
 * 用 ps 读取进程的启动时间与命令行（macOS/Linux 通用列）。
 * 进程不存在 / ps 不可用返回 null。
 */
function readProcIdentity(pid: number): ProcIdentity | null {
  try {
    const lstart = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
    }).trim();
    const command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
    }).trim();
    if (!command) return null;
    const parsed = Date.parse(lstart);
    return { startedAtMs: Number.isNaN(parsed) ? null : parsed, command };
  } catch {
    return null;
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

/**
 * 停止 daemon。
 * @param readIdentity 仅供测试注入：进程身份读取器（缺省用 ps 实测）。
 */
export function feishuDaemonStop(
  readIdentity: (pid: number) => ProcIdentity | null = readProcIdentity,
): { text: string } {
  const info = readPidInfo();
  if (!info || !isAlive(info.pid)) {
    clearPidFile();
    clearHealth();
    return { text: '⚪ 飞书 daemon 未在运行。' };
  }

  // 🛡️ 防 PID 复用误杀：SIGTERM 前校验该 pid 的命令行确实像 otto/node 进程，
  // 且（若 pid 文件记录了 startedAt）实测启动时间与记录相符（允许合理误差）。
  // 校验不过 → 只清理 pid 文件，不发信号。
  const ident = readIdentity(info.pid);
  const looksLikeOtto = ident !== null && /otto|node/i.test(ident.command);
  const startMatches =
    !info.startedAt ||
    ident?.startedAtMs == null ||
    Math.abs(ident.startedAtMs - info.startedAt) <= PID_START_TOLERANCE_MS;
  if (!ident || !looksLikeOtto || !startMatches) {
    clearPidFile();
    clearHealth();
    return {
      text:
        `⚠️ PID ${info.pid} 已不是当初启动的 daemon 进程（疑似 PID 被系统复用给了无关进程），` +
        `仅清理记录，不发送停止信号。`,
    };
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

/** 新建占位 pid 文件被视为「另一个 start 正在进行」的时效窗口。 */
const PID_PLACEHOLDER_FRESH_MS = 30_000;

/**
 * O_EXCL 原子创建 pid 文件（并发 start 互斥）。
 *
 * 成功返回打开的 fd（已写入 pid:0 占位内容）；EEXIST 时：
 *   - 持有者 pid 存活 → 返回 null（已在运行/正在启动）；
 *   - 文件无法解析且很新 → 视为另一个 start 的占位，返回 null；
 *   - 其余（stale 残留：持有者已死 / 老旧损坏文件）→ 清掉重试一轮。
 */
function openPidFileExclusive(now: number): number | null {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(PID_FILE, 'wx', 0o600);
      fs.writeSync(fd, JSON.stringify({ pid: 0, startedAt: now }));
      return fd;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return null;
      const holder = readPidInfo();
      if (holder && isAlive(holder.pid)) return null; // 真有 daemon 在跑/在启动
      if (!holder) {
        // 解析不出 pid：可能是并发 start 刚创建的占位文件 —— 很新就让路。
        try {
          const st = fs.statSync(PID_FILE);
          if (now - st.mtimeMs < PID_PLACEHOLDER_FRESH_MS) return null;
        } catch {
          /* 文件已消失，直接重试 */
        }
      }
      clearPidFile(); // stale 残留 → 清掉重试一轮
    }
  }
  return null;
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

  // 🔒 并发 start 互斥：O_EXCL 原子创建 pid 文件占位（先写 pid:0 占位，spawn 成功
  // 后回填真实 pid）。上面的存活探测与写 pid 之间原本无锁，双开 start 会各 spawn
  // 一个子进程、后写者覆盖前者的 pid 记录，产生不被追踪的孤儿进程。
  const pidFd = openPidFileExclusive(now);
  if (pidFd === null) {
    return {
      text: '⚠️ 检测到另一个 daemon start 正在进行（pid 文件已被占用），本次不启动。稍后用 otto feishu daemon status 查看。',
    };
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
    // spawn 失败：释放占位 pid 文件，避免死锁后续 start。
    try {
      fs.closeSync(pidFd);
    } catch {
      /* ignore */
    }
    clearPidFile();
    return { text: '❌ 启动失败：无法 spawn daemon 进程。' };
  }

  // 回填真实 pid（占位内容长度可能不同，先截断再从头写）。
  fs.ftruncateSync(pidFd, 0);
  fs.writeSync(pidFd, JSON.stringify({ pid: child.pid, startedAt: now }), 0);
  fs.closeSync(pidFd);

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
