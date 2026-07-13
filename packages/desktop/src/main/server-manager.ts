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
 *
 * 注意：模块加载方式（打包崩溃根因修复）：otto-server 是纯 ESM 包（package.json
 * "type":"module"），而本文件编译目标是 CJS（tsconfig.main.json 无 "type":"module"，
 * Electron 主进程标准做法）。CJS 对 ESM 只能用**动态** `import()`，静态
 * `import {...} from 'otto-server'` 会被 tsc 编译成 `require('otto-server')`，
 * 在真机运行时抛 `ERR_REQUIRE_ESM` 直接崩溃（Node/Electron 官方错误信息本身就是这句
 * 建议）。因此这里只保留 `import type` 型引入（纯类型，编译期擦除，不产生 require），
 * 运行期需要的值全部经 loadOttoServer() 懒加载并缓存。
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  OttoServer as OttoServerType,
  ServerEndpoint,
} from 'otto-server';

/** otto-server（ESM）动态加载并缓存：避免每次调用都重新 import()。 */
let ottoServerModulePromise: Promise<typeof import('otto-server')> | undefined;
function loadOttoServer(): Promise<typeof import('otto-server')> {
  if (!ottoServerModulePromise) {
    ottoServerModulePromise = import('otto-server');
  }
  return ottoServerModulePromise;
}

/** 聊天记录落盘目录：~/.otto-user/sessions/（每个会话一个 json 文件）。 */
function sessionsDir(): string {
  return path.join(os.homedir(), '.otto-user', 'sessions');
}

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
  private embedded?: OttoServerType;
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
    const mod = await loadOttoServer();
    this.throwIfShuttingDown();
    // 1) 发现并探活已运行的 server（headless / CLI 已在跑时直接复用）。
    const discovered = mod.readEndpoint();
    if (discovered && pidAlive(discovered.pid)) {
      const healthy = await probeHealth(
        discovered.host,
        discovered.port,
        mod.HTTP_ROUTES.health,
      );
      this.throwIfShuttingDown();
      if (healthy) {
        this.ownership = 'discovered';
        return { endpoint: discovered, ownership: 'discovered' };
      }
    }
    // 端点文件陈旧（进程没了或不应答）→ 清掉，避免误导后续读取。
    if (discovered && !pidAlive(discovered.pid)) {
      mod.clearEndpoint();
    }

    // 2) 没有现成 server → 直接同进程内嵌拉起（embedded-only，见文件头说明）。
    const port = resolvePort(mod.DEFAULT_PORT);
    const embeddedEp = await this.startEmbedded(port, mod);
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
        // loadOttoServer 此时必已完成过一次（embedded 存在即说明 ensure 跑过），
        // 缓存命中不会真的再 import()。
        const mod = await loadOttoServer();
        mod.clearEndpoint();
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
  private async startEmbedded(
    port: number,
    mod: typeof import('otto-server'),
  ): Promise<ServerEndpoint> {
    // 用户已 setup 飞书凭证时启用飞书网关，让桌面 app 的飞书双向同步真正激活
    // （adapter 对无凭证已 fail-soft，这里仅在凭证文件存在时开）。Issue #3/#6。
    const enableFeishu = feishuCredentialsExist();
    // 聊天记录落盘（被动保存）：内嵌 server 用文件持久化会话/消息，重启后原样恢复
    // （否则 InMemorySessionStore 一退出全丢）。落 ~/.otto-user/sessions/。
    const store = new mod.PersistentSessionStore(sessionsDir());
    const server = new mod.OttoServer({
      host: mod.DEFAULT_HOST,
      port,
      enableFeishu,
      store,
    });
    await server.start();
    // listen 完成时若已进入退出流程（shutdown 与 ensure 竞态：shutdown 先跑完、
    // 这里才 listen 成功），立即停掉刚起的 server 并清理端点文件，不留孤儿。
    if (this.shuttingDown) {
      try {
        await server.stop();
      } catch {
        // 退出路径，吞掉。
      } finally {
        mod.clearEndpoint();
      }
      throw new Error('app 正在退出，已停掉刚拉起的内嵌 server');
    }
    // start 成功且未在退出流程，才把引用交给 shutdown 管理
    // （避免 shutdown 对一个 start 尚未完成的 server 调 stop）。
    this.embedded = server;
    const { host, port: boundPort } = server.endpoint;
    // 内嵌 server 由本进程写端点文件。
    return mod.writeEndpoint(host, boundPort);
  }
}

// ── 自由函数 ──

/** 解析监听端口：env 覆盖 > 默认。 */
function resolvePort(defaultPort: number): number {
  const fromEnv = Number(process.env.OTTO_SERVER_PORT);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : defaultPort;
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
function probeHealth(
  host: string,
  port: number,
  healthPath: string,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const req = http.get(
      { host, port, path: healthPath, timeout: HEALTH_TIMEOUT_MS },
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
