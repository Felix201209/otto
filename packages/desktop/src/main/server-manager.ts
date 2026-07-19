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
 *
 * 同样，enterprise-server 也是 ESM，经 loadEnterpriseServer() 动态 import。
 */

import * as http from 'node:http';
import type { Server as HttpServer } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  OttoServer as OttoServerType,
  ServerEndpoint,
} from 'otto-server';
import type { AuthenticatedEnterpriseAccountInput } from './enterprise-identity.js';

type ServerEndpointRecord = ServerEndpoint & { controlToken?: string };
type TrustedOttoServer = OttoServerType & {
  readonly endpoint: {
    host: string;
    port: number;
    clientToken: string;
  };
  readonly controlToken: string;
  setAuthenticatedEnterpriseAccount(
    account: AuthenticatedEnterpriseAccountInput | null,
  ): unknown;
};

/** otto-server（ESM）动态加载并缓存：避免每次调用都重新 import()。 */
let ottoServerModulePromise: Promise<typeof import('otto-server')> | undefined;
function loadOttoServer(): Promise<typeof import('otto-server')> {
  if (!ottoServerModulePromise) {
    ottoServerModulePromise = import('otto-server');
  }
  return ottoServerModulePromise;
}

/** enterprise-server（ESM）动态加载并缓存。 */
let enterpriseServerModulePromise: Promise<typeof import('otto-server/dist/src/enterprise/server.js')> | undefined;
function loadEnterpriseServer(): Promise<typeof import('otto-server/dist/src/enterprise/server.js')> {
  if (!enterpriseServerModulePromise) {
    enterpriseServerModulePromise = import('otto-server/dist/src/enterprise/server.js');
  }
  return enterpriseServerModulePromise;
}

/** enterprise-server 默认端口。 */
const ENTERPRISE_DEFAULT_PORT = 7777;
/** enterprise-server 监听完成的最长等待时间。 */
const ENTERPRISE_LISTEN_TIMEOUT_MS = 3000;

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

export type EnterpriseServerOwnership =
  | 'external'
  | 'discovered'
  | 'embedded'
  | 'unavailable';

/**
 * ServerManager 的可替换边界。生产环境使用下面的真实默认值；单测注入隔离实现，
 * 才能覆盖「主服务已发现」「7777 竞争」「监听永不完成」这些生命周期分支。
 */
export interface ServerManagerDependencies {
  loadOttoServer: typeof loadOttoServer;
  loadEnterpriseServer: typeof loadEnterpriseServer;
  pidAlive: typeof pidAlive;
  probeHealth: typeof probeHealth;
  fetchImpl: typeof fetch;
  enterpriseListenTimeoutMs: number;
}

const DEFAULT_DEPENDENCIES: ServerManagerDependencies = {
  loadOttoServer,
  loadEnterpriseServer,
  pidAlive,
  probeHealth,
  fetchImpl: fetch,
  enterpriseListenTimeoutMs: ENTERPRISE_LISTEN_TIMEOUT_MS,
};

export interface ServerManagerOptions {
  /**
   * 桌面企业身份服务的实际入口。公网/自托管远端由外部部署负责；只有显式
   * localhost/loopback 开发入口才由桌面进程内嵌拉起，避免每台客户端创建
   * 一套与中心企业库脱节的本机数据库。
   */
  enterpriseServerUrl?: string | null;
  dependencies?: ServerManagerDependencies;
}

export class ServerManager {
  /** 仅当本进程内嵌拉起时持有，用于 before-quit 时停掉。 */
  private embedded?: TrustedOttoServer;
  /** 最近一次确保成功的内部端点记录；可含控制令牌，绝不返回 renderer。 */
  private currentEndpointRecord?: ServerEndpointRecord;
  /** 主服务 ensure 中的共享 Promise，避免启动期 IPC 与 app ready 重复拉起。 */
  private mainEnsurePromise?: Promise<EnsuredServer>;
  /** 身份变更严格按调用顺序执行，防 401 清理反压覆盖随后成功的新登录。 */
  private enterpriseIdentitySyncTail: Promise<void> = Promise.resolve();
  /** 企业后台 server（管理员登录 / 看板 / 账号管理）。本进程内嵌拉起时持有。 */
  private enterpriseSrv?: HttpServer;
  /** enterprise 启动中的共享 Promise，防并发 ensure 重复抢占同一端口。 */
  private enterpriseEnsurePromise?: Promise<void>;
  /** 退出时中止尚未完成的 listen。 */
  private enterpriseListenAbort?: AbortController;
  /** 企业服务的真实可用状态，供诊断和回归测试读取。 */
  private enterpriseOwnership: EnterpriseServerOwnership = 'unavailable';
  private ownership: ServerOwnership = 'discovered';
  /**
   * 已进入退出流程（shutdown 被调过）。ensure 的每个异步完成点都要检查它：
   * 用户可能在 ensure 完成前就关窗退出，此时 shutdown 先跑完、拉起才结束，
   * 不检查就会留下一个没人管的孤儿 server。
   */
  private shuttingDown = false;
  private readonly dependencies: ServerManagerDependencies;
  private readonly localEnterpriseServerUrl: string | null;

  constructor(options: ServerManagerOptions = {}) {
    this.dependencies = options.dependencies ?? DEFAULT_DEPENDENCIES;
    this.localEnterpriseServerUrl = loopbackServerUrl(options.enterpriseServerUrl);
    if (!this.localEnterpriseServerUrl && options.enterpriseServerUrl) {
      this.enterpriseOwnership = 'external';
    }
  }

  /**
   * 确保有可用 server，返回其端点。已尽量幂等：可重复调用（重连场景）。
   */
  async ensure(): Promise<EnsuredServer> {
    if (this.mainEnsurePromise) return this.mainEnsurePromise;
    this.throwIfShuttingDown();
    const operation = this.ensureOnce();
    this.mainEnsurePromise = operation;
    try {
      return await operation;
    } finally {
      if (this.mainEnsurePromise === operation) this.mainEnsurePromise = undefined;
    }
  }

  /** 单次主服务发现/拉起；并发折叠由 ensure() 负责。 */
  private async ensureOnce(): Promise<EnsuredServer> {
    this.throwIfShuttingDown();
    // 同一 manager 已经内嵌拉起时直接复用，不能把自己的端点误判成 discovered。
    if (this.embedded && this.currentEndpointRecord) {
      this.ownership = 'embedded';
      return {
        endpoint: publicServerEndpoint(this.currentEndpointRecord),
        ownership: 'embedded',
      };
    }
    const mod = await this.dependencies.loadOttoServer();
    this.throwIfShuttingDown();
    // 1) 发现并探活已运行的 server（headless / CLI 已在跑时直接复用）。
    const readEndpointRecord = (mod as typeof mod & {
      readEndpointRecord?: () => ServerEndpointRecord | undefined;
    }).readEndpointRecord;
    // 新 server 通过 trusted-only API 读取令牌；旧模块只剩公开端点，后续身份
    // 同步会因缺 token 明确 fail closed，而不是退回不受保护的控制方式。
    const discovered = readEndpointRecord?.() ?? mod.readEndpoint();
    if (discovered && this.dependencies.pidAlive(discovered.pid)) {
      const healthy = await this.dependencies.probeHealth(
        discovered.host,
        discovered.port,
        mod.HTTP_ROUTES.health,
      );
      this.throwIfShuttingDown();
      if (healthy) {
        this.ownership = 'discovered';
        this.currentEndpointRecord = discovered;
        // 主服务由 CLI/headless 进程持有时，桌面端仍必须单独保证企业后台可用。
        // 旧实现从这里提前返回，导致管理员登录/邀请码接口从未启动。
        if (this.localEnterpriseServerUrl) await this.ensureEnterprise();
        return {
          endpoint: publicServerEndpoint(discovered),
          ownership: 'discovered',
        };
      }
    }
    // 端点文件陈旧（进程没了或不应答）→ 清掉，避免误导后续读取。
    if (discovered && !this.dependencies.pidAlive(discovered.pid)) {
      mod.clearEndpoint();
    }

    // 2) 没有现成 server → 直接同进程内嵌拉起（embedded-only，见文件头说明）。
    const port = resolvePort(mod.DEFAULT_PORT);
    const embeddedEp = await this.startEmbedded(port, mod);
    this.ownership = 'embedded';
    this.currentEndpointRecord = embeddedEp;
    // 3) 同时拉起 enterprise-server（管理员登录 / 看板功能依赖）。
    // 静默失败：企业后台是辅助功能，不影响主对话。
    if (this.localEnterpriseServerUrl) await this.ensureEnterprise();
    return {
      endpoint: publicServerEndpoint(embeddedEp),
      ownership: 'embedded',
    };
  }

  /**
   * 把中心企业服务已经验证的账号应用到本机 OttoServer。
   * embedded 走同进程 setter；discovered 只能走 loopback + 端点控制令牌。
   */
  setAuthenticatedEnterpriseAccount(
    account: AuthenticatedEnterpriseAccountInput | null,
  ): Promise<void> {
    const operation = this.enterpriseIdentitySyncTail
      .catch(() => undefined)
      .then(() => this.syncAuthenticatedEnterpriseAccount(account));
    this.enterpriseIdentitySyncTail = operation;
    return operation;
  }

  /** 当前 server 归属（lifecycle 决定退出时是否停 server）。 */
  get currentOwnership(): ServerOwnership {
    return this.ownership;
  }

  /** 当前 enterprise-server 是复用、内嵌还是不可用。 */
  get currentEnterpriseOwnership(): EnterpriseServerOwnership {
    return this.enterpriseOwnership;
  }

  /**
   * app 退出清理：只在内嵌时停 server（discovered 的 server 故意留活）。
   * 先置 shuttingDown，让还在跑的 ensure()/startEmbedded() 在完成点自行终止。
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    // listen 尚未完成时 enterpriseSrv 还没有赋值；必须显式中止并等待启动路径收尾。
    this.enterpriseListenAbort?.abort();
    if (this.enterpriseEnsurePromise) {
      try {
        await this.enterpriseEnsurePromise;
      } catch {
        // ensureEnterprise 会降级处理；退出路径再兜底吞掉。
      }
    }
    // 停 enterprise-server（内嵌时才有）。
    if (this.enterpriseSrv) {
      try {
        await new Promise<void>((resolve) => {
          this.enterpriseSrv!.close(() => resolve());
          // 兜底：3 秒后无论如何 resolve
          setTimeout(resolve, 3000);
        });
      } catch {
        // 退出路径，吞掉。
      }
      this.enterpriseSrv = undefined;
      this.enterpriseOwnership = 'unavailable';
    }
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
        const mod = await this.dependencies.loadOttoServer();
        mod.clearEndpoint();
        this.embedded = undefined;
        this.currentEndpointRecord = undefined;
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
  ): Promise<ServerEndpointRecord> {
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
    }) as TrustedOttoServer;
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
    const {
      host,
      port: boundPort,
      clientToken,
    } = server.endpoint;
    const { controlToken } = server;
    // 内嵌 server 由本进程写端点文件。
    const publicEndpoint = mod.writeEndpoint(
      host,
      boundPort,
      clientToken,
      controlToken,
    );
    return { ...publicEndpoint, controlToken };
  }

  private async syncAuthenticatedEnterpriseAccount(
    account: AuthenticatedEnterpriseAccountInput | null,
  ): Promise<void> {
    if (!this.currentEndpointRecord) await this.ensure();
    this.throwIfShuttingDown();

    if (this.ownership === 'embedded') {
      if (!this.embedded) {
        throw new Error('本机 OttoServer 状态不完整，请重启 Otto 后重试');
      }
      this.embedded.setAuthenticatedEnterpriseAccount(account);
      return;
    }

    const record = this.currentEndpointRecord;
    if (!record) throw new Error('本机 OttoServer 尚未就绪，请重启 Otto 后重试');
    if (!record.controlToken?.trim()) {
      throw new Error(
        '检测到旧版本本机 OttoServer，无法安全同步企业身份。' +
        '请退出所有 Otto/CLI 进程后重新启动 Otto。',
      );
    }
    if (!isLoopbackHost(record.host)) {
      throw new Error('本机 OttoServer 端点不是 loopback，已拒绝发送企业身份');
    }

    const mod = await this.dependencies.loadOttoServer();
    const identityRoute = (mod.HTTP_ROUTES as typeof mod.HTTP_ROUTES & {
      enterpriseIdentity?: string;
    }).enterpriseIdentity;
    if (!identityRoute) {
      throw new Error(
        '检测到旧版本本机 OttoServer，缺少企业身份控制接口。' +
        '请退出所有 Otto/CLI 进程后重新启动 Otto。',
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3_000);
    try {
      const response = await this.dependencies.fetchImpl(
        `http://${formatHttpHost(record.host)}:${record.port}${identityRoute}`,
        {
          method: 'POST',
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${record.controlToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ account }),
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: unknown };
        const detail = typeof body.error === 'string' && body.error.trim()
          ? `：${body.error.trim()}`
          : `（HTTP ${response.status}）`;
        throw new Error(
          `本机 OttoServer 拒绝身份同步${detail}。` +
          '请退出所有 Otto/CLI 进程后重新启动 Otto。',
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('请退出所有 Otto/CLI')) {
        throw error;
      }
      const detail = error instanceof Error && error.name === 'AbortError'
        ? '请求超时'
        : error instanceof Error ? error.message : String(error);
      throw new Error(
        `本机 OttoServer 身份同步失败：${detail}。` +
        '请退出所有 Otto/CLI 进程后重新启动 Otto。',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** 确保 enterprise-server（管理员登录/看板）在同进程内嵌拉起。幂等：已跑就跳过。 */
  private async ensureEnterprise(): Promise<void> {
    if (this.enterpriseSrv) {
      this.enterpriseOwnership = 'embedded';
      return;
    }
    if (this.enterpriseEnsurePromise) return this.enterpriseEnsurePromise;
    if (this.shuttingDown) return;
    const operation = this.startEnterprise();
    this.enterpriseEnsurePromise = operation;
    try {
      await operation;
    } finally {
      if (this.enterpriseEnsurePromise === operation) {
        this.enterpriseEnsurePromise = undefined;
      }
    }
  }

  /** enterprise-server 单次启动尝试；调用方负责并发去重。 */
  private async startEnterprise(): Promise<void> {
    const localUrl = new URL(this.localEnterpriseServerUrl!);
    const host = localUrl.hostname === 'localhost'
      ? '127.0.0.1'
      : localUrl.hostname.replace(/^\[|\]$/g, '');
    const port = localUrl.port ? Number(localUrl.port) : ENTERPRISE_DEFAULT_PORT;
    try {
      // 先探活再监听：CLI 或另一个 Otto 实例已经启动企业服务时直接复用，
      // 避免把正常的 EADDRINUSE 当成后台不可用。
      if (await this.dependencies.probeHealth(host, port, '/enterprise/health')) {
        this.enterpriseOwnership = 'discovered';
        return;
      }
      const { createEnterpriseServer } = await this.dependencies.loadEnterpriseServer();
      if (this.shuttingDown) return;
      const created = createEnterpriseServer({
        host,
        port,
        publicUrl: this.localEnterpriseServerUrl ?? undefined,
      });
      const { server } = created;
      if (this.shuttingDown) {
        server.close();
        return;
      }
      const abort = new AbortController();
      this.enterpriseListenAbort = abort;
      await listenWithTimeout(
        server,
        created.host,
        created.port,
        this.dependencies.enterpriseListenTimeoutMs,
        abort.signal,
      );
      this.throwIfShuttingDown();
      this.enterpriseSrv = server;
      this.enterpriseOwnership = 'embedded';
      console.log(
        `[ServerManager] enterprise-server 已就绪: http://${created.host}:${created.port}`,
      );
    } catch (err) {
      // 探活与 listen 之间可能有另一个进程抢先占住 7777。只要它此刻健康，
      // 就视为成功复用；否则才诚实标为不可用。
      if (
        (err as NodeJS.ErrnoException)?.code === 'EADDRINUSE'
        && await this.dependencies.probeHealth(host, port, '/enterprise/health')
      ) {
        this.enterpriseOwnership = 'discovered';
        return;
      }
      this.enterpriseOwnership = 'unavailable';
      if (!this.shuttingDown) {
        console.warn('[ServerManager] enterprise-server 启动失败（非致命，管理后台不可用）:',
          (err as Error)?.message ?? String(err));
      }
    } finally {
      this.enterpriseListenAbort = undefined;
    }
  }
}

// ── 自由函数 ──

/** 明确挑选公开字段，避免将未来新增的敏感端点字段经 IPC 泄露给 renderer。 */
function publicServerEndpoint(record: ServerEndpointRecord): ServerEndpoint {
  return {
    host: record.host,
    port: record.port,
    protocolVersion: record.protocolVersion,
    pid: record.pid,
    startedAt: record.startedAt,
    clientToken: record.clientToken,
  };
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/g, '').toLowerCase();
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '::1';
}

function formatHttpHost(host: string): string {
  const normalized = host.replace(/^\[|\]$/g, '');
  return normalized.includes(':') ? `[${normalized}]` : normalized;
}

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

/** 仅识别桌面能够真实提供的明文 loopback 服务；HTTPS/远端均由外部部署负责。 */
function loopbackServerUrl(input: string | null | undefined): string | null {
  if (!input) return null;
  try {
    const url = new URL(input);
    const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
    if (url.protocol !== 'http:' || !isLoopback || url.username || url.password) return null;
    if (url.search || url.hash) return null;
    const pathname = url.pathname.replace(/\/+$/, '');
    if (pathname && pathname !== '/') return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * 等待 http.Server 真正进入 listening。超时不是成功：必须关掉半启动实例并拒绝，
 * 否则后续逻辑会持有一个从未监听的 server，界面却没有任何失败信号。
 */
function listenWithTimeout(
  server: HttpServer,
  host: string,
  port: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.off('listening', onListening);
      server.off('error', onError);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onListening = () => finish();
    const onError = (error: Error) => finish(error);
    const onAbort = () => {
      try {
        server.close();
      } catch {
        // 尚未监听时 close 可能失败；仍要立即结束等待。
      }
      finish(new Error('enterprise-server 启动已取消'));
    };
    const timer = setTimeout(() => {
      try {
        server.close();
      } catch {
        // 尚未真正监听时 close 可能抛 ERR_SERVER_NOT_RUNNING；原始超时仍是主错误。
      }
      finish(new Error(`enterprise-server 监听超时（${timeoutMs}ms）`));
    }, timeoutMs);
    server.once('listening', onListening);
    server.once('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      server.listen(port, host);
    } catch (error) {
      finish(error as Error);
    }
  });
}
