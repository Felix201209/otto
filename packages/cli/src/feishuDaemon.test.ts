/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 飞书 daemon 进程管理层单测。
 *
 * 重点覆盖：
 *   - start 的 O_EXCL pid 文件互斥（并发 start 占位让路 / stale 残留接管）；
 *   - stop 的进程身份校验（防 PID 被系统复用后误杀无关进程）。
 *
 * 通过 mock os.homedir 把 ~/.otto-user 指到临时目录，绝不触碰真实用户目录
 * （本机可能有真的 daemon 在跑）。spawn 用 /bin/sleep 替身，不真连飞书。
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const fsMod = await import('node:fs');
  const pathMod = await import('node:path');
  const fakeHome = fsMod.mkdtempSync(
    pathMod.join(actual.tmpdir(), 'otto-daemon-home-'),
  );
  const homedir = (): string => fakeHome;
  return { ...actual, homedir, default: { ...actual, homedir } };
});

// 注意：必须在 vi.mock 之后 import，daemon 模块顶层用 os.homedir() 算路径。
import {
  feishuDaemonStart,
  feishuDaemonStop,
  _daemonPaths,
  type ProcIdentity,
} from './feishuDaemon.js';

const PID_FILE = _daemonPaths.PID_FILE;
/** 无害长驻替身进程（不真跑 otto，不连飞书）。 */
const SLEEP_OVERRIDE = { command: '/bin/sleep', args: ['60'] };

function readPidFileRaw(): { pid: number; startedAt?: number } {
  return JSON.parse(fs.readFileSync(PID_FILE, 'utf8'));
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilDead(pid: number, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !pidAlive(pid);
}

describe('feishuDaemon 进程管理', () => {
  const children: number[] = [];

  afterEach(() => {
    for (const pid of children) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* 已退出 */
      }
    }
    children.length = 0;
    try {
      fs.unlinkSync(PID_FILE);
    } catch {
      /* 不存在即可 */
    }
  });

  it('start：O_EXCL 原子建 pid 文件并记录 pid+startedAt；重复 start 报已在运行', () => {
    const now = Date.now();
    const r = feishuDaemonStart(now, SLEEP_OVERRIDE);
    expect(r.pid).toBeGreaterThan(0);
    children.push(r.pid!);

    const info = readPidFileRaw();
    expect(info.pid).toBe(r.pid);
    expect(info.startedAt).toBe(now);

    const r2 = feishuDaemonStart(Date.now(), SLEEP_OVERRIDE);
    expect(r2.pid).toBe(r.pid);
    expect(r2.text).toContain('已在运行');
  });

  it('start：发现新鲜的占位 pid 文件（并发 start 进行中）→ 让路不启动', () => {
    fs.mkdirSync(_daemonPaths.CONFIG_DIR, { recursive: true });
    // 模拟另一个 start 刚创建的占位（pid:0，readPidInfo 解析不出有效 pid）。
    fs.writeFileSync(
      PID_FILE,
      JSON.stringify({ pid: 0, startedAt: Date.now() }),
    );

    const r = feishuDaemonStart(Date.now(), SLEEP_OVERRIDE);
    expect(r.pid).toBeUndefined();
    expect(r.text).toContain('另一个 daemon start');
  });

  it('start：陈旧损坏的 pid 文件 → 清理接管后正常启动', () => {
    fs.mkdirSync(_daemonPaths.CONFIG_DIR, { recursive: true });
    fs.writeFileSync(PID_FILE, 'not-a-json-pid-file');
    const oldSec = (Date.now() - 3600_000) / 1000; // 1 小时前
    fs.utimesSync(PID_FILE, oldSec, oldSec);

    const r = feishuDaemonStart(Date.now(), SLEEP_OVERRIDE);
    expect(r.pid).toBeGreaterThan(0);
    children.push(r.pid!);
    expect(readPidFileRaw().pid).toBe(r.pid);
  });

  it('stop：启动时间对不上（PID 被复用）→ 只清 pid 文件，不杀进程', () => {
    const r = feishuDaemonStart(Date.now(), SLEEP_OVERRIDE);
    children.push(r.pid!);
    const recorded = readPidFileRaw();

    // 注入的实测身份：启动时间比记录晚 10 分钟 → 判定 PID 已被复用。
    const fakeIdentity = (): ProcIdentity => ({
      startedAtMs: recorded.startedAt! + 10 * 60_000,
      command: 'node /some/path/otto.js --feishu',
    });
    const stop = feishuDaemonStop(fakeIdentity);

    expect(stop.text).toContain('复用');
    expect(fs.existsSync(PID_FILE)).toBe(false);
    // 原进程未被误杀。
    expect(pidAlive(r.pid!)).toBe(true);
  });

  it('stop：命令行不像 otto/node 进程 → 只清 pid 文件，不杀进程', () => {
    const r = feishuDaemonStart(Date.now(), SLEEP_OVERRIDE);
    children.push(r.pid!);
    const recorded = readPidFileRaw();

    const fakeIdentity = (): ProcIdentity => ({
      startedAtMs: recorded.startedAt!,
      command: '/usr/libexec/some-unrelated-service',
    });
    const stop = feishuDaemonStop(fakeIdentity);

    expect(stop.text).toContain('不发送停止信号');
    expect(fs.existsSync(PID_FILE)).toBe(false);
    expect(pidAlive(r.pid!)).toBe(true);
  });

  it('stop：身份匹配（命令行像 otto/node 且启动时间相符）→ SIGTERM 停止', async () => {
    const r = feishuDaemonStart(Date.now(), SLEEP_OVERRIDE);
    children.push(r.pid!);
    const recorded = readPidFileRaw();

    const fakeIdentity = (): ProcIdentity => ({
      startedAtMs: recorded.startedAt!,
      command: 'node /some/path/otto.js --feishu',
    });
    const stop = feishuDaemonStop(fakeIdentity);

    expect(stop.text).toContain('已停止');
    expect(fs.existsSync(PID_FILE)).toBe(false);
    expect(await waitUntilDead(r.pid!)).toBe(true);
  });
});
