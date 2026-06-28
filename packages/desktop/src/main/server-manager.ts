/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ServerManager —— 主进程侧的「确保有一个可用 otto-server」逻辑（Issue #4 + #9）。
 *
 * 策略（按 §1 目标架构「server 可 headless 常驻，app 打开时自动拉起」）：
 *   1. 先读端点文件发现已运行的 server；探活（pid 存活 + /health 应答）通过即复用。
 *   2. 没有可用的现存 server → 拉起一个。
 *      - 优先以 **detached 子进程** 跑 otto-server 的 bin（Issue #9 的「server 随 app 自启
 *        且 app 关了仍活」目标）：app 退出不杀 server，飞书继续在线。
 *      - 找不到可执行 bin（开发环境未 build server）→ 回退到 **同进程内嵌** OttoServer，
 *        保证 app 在任何环境都能独立跑通（内嵌 server 随 app 退出而停）。
 *   3. 起好后轮询 /health 直到就绪，再把端点交回 main。
 *
 * 与 bin（otto-server start/stop/status）对齐：detached 子进程跑的就是同一个 bin，
 * 它自己会写端点文件；本管理器只负责发现/拉起/探活，不重复造端点写盘逻辑。
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import * as http from 'node:http';
import {
  OttoServer,
  readEndpoint,
  writeEndpoint,
  clearEndpoint,
  DEFAULT_HOST,
  DEFAULT_PORT,
  HTTP_ROUTES,
  type ServerEndpoint,
} from 'otto-server';

const require = createRequire(import.meta.url);

/** 一次健康探测的超时（ms）。 */
const HEALTH_TIMEOUT_MS = 1500;
/** 拉起后等 server 就绪的总轮询时长上限（ms）。 */
const READY_TIMEOUT_MS = 15_000;
/** 轮询间隔（ms）。 */
const POLL_INTERVAL_MS = 250;

/**
 * server 的归属：
 * - 'discovered'：复用了别的进程已起的 server（app 不负责其生命周期）。
 * - 'detached'：本 app 以独立子进程拉起（app 关了它仍活，符合 Issue #9）。
 * - 'embedded'：本进程内嵌拉起（回退路径；随 app 退出而停）。
 */
export type ServerOwnership = 'discovered' | 'detached' | 'embedded';

export interface EnsuredServer {
  endpoint: ServerEndpoint;
  ownership: ServerOwnership;
}

export class ServerManager {
  /** 仅当 ownership==='embedded' 时持有，用于 before-quit 时停掉。 */
  private embedded?: OttoServer;
  private ownership: ServerOwnership = 'discovered';

  /**
   * 确保有可用 server，返回其端点。已尽量幂等：可重复调用（重连场景）。
   */
  async ensure(): Promise<EnsuredServer> {
    // 1) 发现并探活已运行的 server。
    const discovered = readEndpoint();
    if (discovered && pidAlive(discovered.pid)) {
      const healthy = await probeHealth(discovered.host, discovered.port);
      if (healthy) {
        this.ownership = 'discovered';
        return { endpoint: discovered, ownership: 'discovered' };
      }
    }
    // 端点文件陈旧（进程没了或不应答）→ 清掉，避免误导后续读取。
    if (discovered && !pidAlive(discovered.pid)) {
      clearEndpoint();
    }

    // 2) 拉起：优先 detached 子进程，失败回退内嵌。
    const port = resolvePort();
    const spawned = await this.spawnDetached(port);
    if (spawned) {
      this.ownership = 'detached';
      return { endpoint: spawned, ownership: 'detached' };
    }

    // 3) 回退：同进程内嵌。
    const embeddedEp = await this.startEmbedded(port);
    this.ownership = 'embedded';
    return { endpoint: embeddedEp, ownership: 'embedded' };
  }

  /** 当前 server 归属（lifecycle 决定退出时是否停 server）。 */
  get currentOwnership(): ServerOwnership {
    return this.ownership;
  }

  /**
   * app 退出清理：只在内嵌时停 server（detached/discovered 的 server 故意留活）。
   */
  async shutdown(): Promise<void> {
    if (this.ownership === 'embedded' && this.embedded) {
      try {
        await this.embedded.stop();
      } catch {
        // 退出路径，吞掉。
      } finally {
        clearEndpoint();
        this.embedded = undefined;
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────

  /**
   * 以 detached 子进程拉起 otto-server 的 bin。
   * 解析 bin 路径用 require.resolve('otto-server')（拿到 dist/index.js）再换算到
   * 同目录的 dist/bin.js —— 与 server package.json 的 main/bin 布局一致。
   * 拉起后轮询 /health 直到就绪；超时视为失败（交由调用方回退内嵌）。
   *
   * 返回端点（成功）或 null（拉不起/未就绪 → 回退）。
   */
  private async spawnDetached(port: number): Promise<ServerEndpoint | null> {
    const binPath = resolveServerBin();
    if (!binPath) return null;

    try {
      const child = spawn(process.execPath, [binPath, 'start'], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, OTTO_SERVER_PORT: String(port) },
      });
      // 让子进程脱离 app 的进程组：app 退出后 server 继续活（Issue #9）。
      child.unref();
      // 子进程立刻失败（如 spawn 抛 ENOENT）时，error 事件会触发；这里不挂死等，
      // 直接进入 /health 轮询：就绪→成功；超时→失败回退。
      child.on('error', () => {
        /* 探活轮询会因超时失败并回退，无需在此处理 */
      });
    } catch {
      return null;
    }

    return waitForReady(DEFAULT_HOST, port);
  }

  /** 同进程内嵌 OttoServer（最后回退路径）。 */
  private async startEmbedded(port: number): Promise<ServerEndpoint> {
    this.embedded = new OttoServer({ host: DEFAULT_HOST, port });
    await this.embedded.start();
    const { host, port: boundPort } = this.embedded.endpoint;
    // 内嵌 server 由本进程写端点文件（bin 路径下是 bin 自己写）。
    return writeEndpoint(host, boundPort);
  }
}

// ── 自由函数 ──

/** 解析监听端口：env 覆盖 > 默认。 */
function resolvePort(): number {
  const fromEnv = Number(process.env.OTTO_SERVER_PORT);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_PORT;
}

/** pid 是否存活（kill 0 探针）。 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 解析 otto-server 的 bin 入口路径。
 * require.resolve('otto-server') → .../packages/server/dist/index.js；
 * 同目录的 bin.js 就是 CLI 入口。解析不到（未 build / 打包形态不同）返回 null。
 */
function resolveServerBin(): string | null {
  try {
    const mainEntry = require.resolve('otto-server'); // dist/index.js
    const binPath = mainEntry.replace(/index\.js$/, 'bin.js');
    return binPath !== mainEntry ? binPath : null;
  } catch {
    return null;
  }
}

/**
 * 轮询 /health 直到 server 就绪或超时。就绪后读端点文件返回（bin 已写好）。
 * 超时返回 null。
 */
async function waitForReady(
  host: string,
  port: number,
): Promise<ServerEndpoint | null> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await probeHealth(host, port)) {
      // bin 子进程已写端点文件；读回它（含真实 pid）。
      const ep = readEndpoint();
      if (ep) return ep;
      // 极少数竞态：health 通了但端点文件还没落盘 → 用已知 host/port 兜底构造。
      return {
        host,
        port,
        protocolVersion: '1',
        pid: -1,
        startedAt: Date.now(),
      };
    }
    await delay(POLL_INTERVAL_MS);
  }
  return null;
}

/** 单次 GET /health 探活：2xx 即视为健康。 */
function probeHealth(host: string, port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const req = http.get(
      { host, port, path: HTTP_ROUTES.health, timeout: HEALTH_TIMEOUT_MS },
      (res) => {
        const okStatus =
          typeof res.statusCode === 'number' &&
          res.statusCode >= 200 &&
          res.statusCode < 300;
        // 必须 drain，否则 socket 不释放。
        res.resume();
        resolve(okStatus);
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
