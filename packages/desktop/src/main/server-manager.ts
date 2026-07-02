/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ServerManager —— 主进程侧的「确保有一个可用 otto-server」逻辑（Issue #4 + #9）。
 *
 * 策略（embedded-only，产品决定）：
 *   1. 先读端点文件发现已运行的 server；探活（pid 存活 + /health 应答）通过即复用
 *      （headless / CLI 已在跑时直接连上它，不重复拉起）。
 *   2. 没有可用的现存 server → **直接同进程内嵌** OttoServer 跑起来（随 app 退出而停）。
 *
 * 历史：曾尝试以 detached 子进程跑 server bin 实现「app 关了 server 仍活」，但打包形态下
 * 该路径必失败（process.execPath 是 Electron 二进制，缺 ELECTRON_RUN_AS_NODE 不会当 node
 * 脚本跑，且 single-instance lock 让第二实例立即 quit；bin.js 又在 asar 内），结果永远 15s
 * 超时后静默回退内嵌。既然内嵌才是实际生产路径，这里直接走内嵌，消掉那段必然超时的卡顿。
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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

/** 一次健康探测的超时（ms）。 */
const HEALTH_TIMEOUT_MS = 1500;

/**
 * server 的归属：
 * - 'discovered'：复用了别的进程已起的 server（app 不负责其生命周期）。
 * - 'embedded'：本进程内嵌拉起（随 app 退出而停）。
 */
export type ServerOwnership = 'discovered' | 'embedded';

export interface EnsuredServer {
  endpoint: ServerEndpoint;
  ownership: ServerOwnership;
}

export class ServerManager {
  /** 仅当本进程内嵌拉起时持有，用于 before-quit 时停掉。 */
  private embedded?: OttoServer;
  private ownership: ServerOwnership = 'discovered';
  /**
   * 已进入退出流程（shutdown 被调过）。ensure 的每个异步完成点都要检查它：
   * 用户可能在 ensure 完成前就关窗退出，此时 shutdown 先跑完、拉起才结束，
   * 不检查就会留下一个没人管的孤儿 server。
   */
  private shuttingDown = false;

  /**
   * 确保有可用 server，返回其端点。已尽量幂等：可重复调用（重连场景）。
   */
  async ensure(): Promise<EnsuredServer> {
    this.throwIfShuttingDown();
    // 1) 发现并探活已运行的 server（headless / CLI 已在跑时直接复用）。
    const discovered = readEndpoint();
    if (discovered && pidAlive(discovered.pid)) {
      const healthy = await probeHealth(discovered.host, discovered.port);
      this.throwIfShuttingDown();
      if (healthy) {
        this.ownership = 'discovered';
        return { endpoint: discovered, ownership: 'discovered' };
      }
    }
    // 端点文件陈旧（进程没了或不应答）→ 清掉，避免误导后续读取。
    if (discovered && !pidAlive(discovered.pid)) {
      clearEndpoint();
    }

    // 2) 没有现成 server → 直接同进程内嵌拉起（embedded-only，见文件头说明）。
    const port = resolvePort();
    const embeddedEp = await this.startEmbedded(port);
    this.ownership = 'embedded';
    return { endpoint: embeddedEp, ownership: 'embedded' };
  }

  /** 当前 server 归属（lifecycle 决定退出时是否停 server）。 */
  get currentOwnership(): ServerOwnership {
    return this.ownership;
  }

  /**
   * app 退出清理：只在内嵌时停 server（discovered 的 server 故意留活）。
   * 先置 shuttingDown，让还在跑的 ensure()/startEmbedded() 在完成点自行终止。
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    // 判 this.embedded 而非 ownership：embedded 只在本进程拉起时赋值，
    // 且 ownership 的赋值晚于拉起完成，退出竞态窗口内以 embedded 为准。
    if (this.embedded) {
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

  /** 已进入退出流程时抛错，令 ensure 调用方终止后续动作。 */
  private throwIfShuttingDown(): void {
    if (this.shuttingDown) {
      throw new Error('app 正在退出，放弃确保 server');
    }
  }

  /** 同进程内嵌 OttoServer（embedded-only 的唯一拉起路径）。 */
  private async startEmbedded(port: number): Promise<ServerEndpoint> {
    // 用户已 setup 飞书凭证时启用飞书网关，让桌面 app 的飞书双向同步真正激活
    // （adapter 对无凭证已 fail-soft，这里仅在凭证文件存在时开）。Issue #3/#6。
    const enableFeishu = feishuCredentialsExist();
    const server = new OttoServer({ host: DEFAULT_HOST, port, enableFeishu });
    await server.start();
    // listen 完成时若已进入退出流程（shutdown 与 ensure 竞态：shutdown 先跑完、
    // 这里才 listen 成功），立即停掉刚起的 server 并清理端点文件，不留孤儿。
    if (this.shuttingDown) {
      try {
        await server.stop();
      } catch {
        // 退出路径，吞掉。
      } finally {
        clearEndpoint();
      }
      throw new Error('app 正在退出，已停掉刚拉起的内嵌 server');
    }
    // start 成功且未在退出流程，才把引用交给 shutdown 管理
    // （避免 shutdown 对一个 start 尚未完成的 server 调 stop）。
    this.embedded = server;
    const { host, port: boundPort } = server.endpoint;
    // 内嵌 server 由本进程写端点文件。
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
 * 飞书凭证文件是否存在（~/.otto-user/feishu-credentials.json）。
 * 路径与 server 侧 feishuAdapter 的 loadCredentials 一致；存在即说明用户已 setup 飞书，
 * 据此决定内嵌 server 是否启用飞书网关。
 */
function feishuCredentialsExist(): boolean {
  try {
    const p = path.join(os.homedir(), '.otto-user', 'feishu-credentials.json');
    return fs.existsSync(p);
  } catch {
    return false;
  }
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
