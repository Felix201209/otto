/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ServerManager —— 主进程侧的「确保有一个可用 otto-server」逻辑（Issue #4 + #9）。
 *
 * 策略（detached-first）：
 *   1. 先读端点文件发现已运行的 server；探活（pid 存活 + /health 应答）通过即复用
 *      （headless / CLI 已在跑时直接连上它，不重复拉起）。
 *   2. 没有可用的现存 server → 以 detached 子进程拉起 server，
 *      关窗不杀 server（飞书继续活），仅托盘「退出 Otto」才 SIGTERM。
 *   3. 开发/非打包形态无法走 detached 时，回退同进程内嵌（embedded）。
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
 * enterprise server 也经 otto-server 公共入口动态 import，避免 desktop 深导入
 * server/src 或 dist/src。
 */

import * as childProcess from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as http from 'node:http';
import type { Server as HttpServer } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  readActiveKernelBinPath,
  readActiveKernelModulePath,
} from './incremental-kernel-store.js';
import type { OttoServer as OttoServerType, ServerEndpoint } from 'otto-server';
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
const kernelOverlayModulePromises = new Map<
  string,
  Promise<typeof import('otto-server')>
>();
async function loadOttoServer(
  kernelUpdateRoot?: string,
): Promise<typeof import('otto-server')> {
  const activeModulePath = kernelUpdateRoot
    ? await readActiveKernelModulePath(kernelUpdateRoot).catch(() => null)
    : null;
  if (activeModulePath) {
    const url = pathToFileURL(activeModulePath).href;
    let promise = kernelOverlayModulePromises.get(url);
    if (!promise) {
      promise = import(url) as Promise<typeof import('otto-server')>;
      kernelOverlayModulePromises.set(url, promise);
    }
    return promise;
  }
  if (!ottoServerModulePromise) {
    ottoServerModulePromise = import('otto-server');
  }
  return ottoServerModulePromise;
}

/** enterprise-server（ESM）动态加载并缓存。 */
let enterpriseServerModulePromise:
  Promise<typeof import('otto-server')> | undefined;
function loadEnterpriseServer(): Promise<typeof import('otto-server')> {
  if (!enterpriseServerModulePromise) {
    enterpriseServerModulePromise = import('otto-server');
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

/** 固定日志目录：~/.otto-user/logs/ */
function logsDir(): string {
  return path.join(os.homedir(), '.otto-user', 'logs');
}

function serverLogPath(): string {
  return path.join(logsDir(), 'otto-server.log');
}

export function prepareDesktopSqlCipherRuntime(
  environment: NodeJS.ProcessEnv = process.env,
  options: {
    homeDirectory?: string;
    resourcesPath?: string;
  } = {},
): { keyPath: string | null; nativeBindingPath: string | null } {
  const encryptionMode = environment.OTTO_DATABASE_ENCRYPTION
    ?.trim()
    .toLowerCase();
  if (['disabled', 'off', 'false', '0'].includes(encryptionMode ?? '')) {
    return { keyPath: null, nativeBindingPath: null };
  }

  let keyPath = environment.OTTO_DATABASE_ENCRYPTION_KEY_FILE?.trim() || null;
  if (!keyPath) {
    const userDirectory =
      environment.OTTO_USER_DIR?.trim() ||
      path.join(options.homeDirectory ?? os.homedir(), '.otto-user');
    const custodyDirectory = path.join(userDirectory, 'custody');
    keyPath = path.join(custodyDirectory, 'database-sqlcipher.key');
    fs.mkdirSync(custodyDirectory, { recursive: true, mode: 0o700 });
    const custodyMetadata = fs.lstatSync(custodyDirectory);
    if (custodyMetadata.isSymbolicLink() || !custodyMetadata.isDirectory()) {
      throw new Error('desktop SQLCipher custody directory must be a real directory');
    }

    const key = randomBytes(32);
    try {
      try {
        fs.writeFileSync(keyPath, key, { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    } finally {
      key.fill(0);
    }

    const keyMetadata = fs.lstatSync(keyPath);
    if (
      keyMetadata.isSymbolicLink() ||
      !keyMetadata.isFile() ||
      keyMetadata.size !== 32
    ) {
      throw new Error('desktop SQLCipher custody key must be a 32-byte regular file');
    }
    try {
      fs.chmodSync(custodyDirectory, 0o700);
      fs.chmodSync(keyPath, 0o600);
    } catch {
      // Windows protects these paths with the current user's directory ACL.
    }
    environment.OTTO_DATABASE_ENCRYPTION_KEY_FILE = keyPath;
    environment.OTTO_DATABASE_ENCRYPTION_KEY_ID ??= 'desktop-local-custody';
  }

  let nativeBindingPath =
    environment.OTTO_SQLCIPHER_NATIVE_BINDING?.trim() || null;
  if (!nativeBindingPath && options.resourcesPath) {
    const packagedBinding = path.join(
      options.resourcesPath,
      'sqlcipher',
      'better_sqlite3.node',
    );
    if (fs.existsSync(packagedBinding)) {
      nativeBindingPath = packagedBinding;
      environment.OTTO_SQLCIPHER_NATIVE_BINDING = packagedBinding;
    }
  }

  return { keyPath, nativeBindingPath };
}

/** 一次健康探测的超时（ms）。 */
const HEALTH_TIMEOUT_MS = 1500;
/** 定期健康检查间隔（ms）。 */
const HEALTH_CHECK_INTERVAL_MS = 30_000;
/** 连续失败多少次触发自动重启。 */
const MAX_HEALTH_FAILURES = 3;
/** 自动重启最大次数（防止无限重启循环）。 */
const MAX_RESTART_COUNT = 3;
/** 端口冲突时最多尝试多少个端口。 */
const MAX_PORT_RETRIES = 10;

/**
 * server 的归属：
 * - 'discovered'：复用了别的进程已起的 server（app 不负责其生命周期）。
 * - 'detached'：本进程以 detached 子进程拉起（关窗不杀，显式退出才停）。
 * - 'embedded'：本进程内嵌拉起（开发回退路径，随 app 退出而停）。
 */
export type ServerOwnership = 'discovered' | 'detached' | 'embedded';

export interface EnsuredServer {
  endpoint: ServerEndpoint;
  ownership: ServerOwnership;
}

/**
 * Renderer-safe startup snapshot. Keep this deliberately small: it reports
 * the path actually selected by the desktop process without leaking endpoint
 * tokens, filesystem paths, or raw exception stacks.
 */
export interface DesktopRuntimeDiagnostic {
  contractVersion: 1;
  server: {
    status: 'ready' | 'starting' | 'unavailable';
    ownership?: ServerOwnership;
    message?: string;
  };
  nativeCore: {
    mode: 'auto' | 'required' | 'off';
    status: 'disabled' | 'not_probed' | 'configured';
    message: string;
  };
}

export type EnterpriseServerOwnership =
  'external' | 'discovered' | 'embedded' | 'unavailable';

/**
 * ServerManager 的可替换边界。生产环境使用下面的真实默认值；单测注入隔离实现，
 * 才能覆盖「主服务已发现」「7777 竞争」「监听永不完成」这些生命周期分支。
 */
export interface ServerManagerDependencies {
  loadOttoServer: typeof loadOttoServer;
  loadEnterpriseServer: typeof loadEnterpriseServer;
  /** 子进程边界可注入，避免单测真的拉起另一个 Otto server。 */
  spawnDetached: typeof childProcess.spawn;
  pidAlive: typeof pidAlive;
  probeHealth: typeof probeHealth;
  fetchImpl: typeof fetch;
  enterpriseListenTimeoutMs: number;
}

const DEFAULT_DEPENDENCIES: ServerManagerDependencies = {
  loadOttoServer,
  loadEnterpriseServer,
  spawnDetached: childProcess.spawn,
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
  /** 健康状态变更回调（用于托盘图标/窗口状态提示）。 */
  onHealthChange?: (status: string) => void;
  /** 已签名 kernel 增量更新的本地 store root；存在 active kernel 时优先加载。 */
  kernelUpdateRoot?: string;
}

export class ServerManager {
  /** 仅当本进程内嵌拉起时持有，用于 before-quit 时停掉。 */
  private embedded?: TrustedOttoServer;
  /** 仅当本进程以 detached 子进程拉起时持有。 */
  private detachedChild?: childProcess.ChildProcess;
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
  private lastEnsureError?: string;
  /**
   * 已进入退出流程（shutdown 被调过）。ensure 的每个异步完成点都要检查它：
   * 用户可能在 ensure 完成前就关窗退出，此时 shutdown 先跑完、拉起才结束，
   * 不检查就会留下一个没人管的孤儿 server。
   */
  private shuttingDown = false;
  /** 健康检查定时器。 */
  private healthCheckTimer?: ReturnType<typeof setInterval>;
  /** 健康检查连续失败计数。 */
  private consecutiveHealthFailures = 0;
  /** 已自动重启的次数（防无限循环）。 */
  private restartCount = 0;
  private readonly dependencies: ServerManagerDependencies;
  private readonly localEnterpriseServerUrl: string | null;
  private readonly kernelUpdateRoot?: string;
  private readonly onHealthChange?: (status: string) => void;

  constructor(options: ServerManagerOptions = {}) {
    if (process.env.NODE_ENV !== 'test') {
      prepareDesktopSqlCipherRuntime(process.env, {
        homeDirectory: os.homedir(),
        resourcesPath: process.resourcesPath,
      });
    }
    this.kernelUpdateRoot = options.kernelUpdateRoot;
    this.dependencies = options.dependencies ?? {
      ...DEFAULT_DEPENDENCIES,
      loadOttoServer: () => loadOttoServer(this.kernelUpdateRoot),
    };
    this.localEnterpriseServerUrl = loopbackServerUrl(
      options.enterpriseServerUrl,
    );
    this.onHealthChange = options.onHealthChange;
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
      const ensured = await operation;
      this.lastEnsureError = undefined;
      return ensured;
    } catch (error) {
      this.lastEnsureError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      if (this.mainEnsurePromise === operation)
        this.mainEnsurePromise = undefined;
    }
  }

  /** A renderer-facing status snapshot for Settings & Diagnostics. */
  getDesktopRuntimeDiagnostic(): DesktopRuntimeDiagnostic {
    const rawMode = String(process.env.OTTO_NATIVE_CORE ?? 'auto').toLowerCase();
    const mode: DesktopRuntimeDiagnostic['nativeCore']['mode'] =
      rawMode === 'required' || rawMode === 'off' ? rawMode : 'auto';
    const binaryConfigured = Boolean(process.env.OTTO_NATIVE_CORE_BINARY?.trim());
    const nativeCore = mode === 'off'
      ? { mode, status: 'disabled' as const, message: '原生 bridge 已按配置关闭。' }
      : binaryConfigured
        ? { mode, status: 'configured' as const, message: '已配置原生核心二进制；具体热路径会在首次使用时验证。' }
        : { mode, status: 'not_probed' as const, message: '未在桌面启动阶段探测原生热路径；auto 模式会在不可用时使用 TypeScript fallback。' };
    if (this.currentEndpointRecord) {
      return {
        contractVersion: 1,
        server: { status: 'ready', ownership: this.ownership, message: '本地服务已就绪。' },
        nativeCore,
      };
    }
    if (this.mainEnsurePromise) {
      return { contractVersion: 1, server: { status: 'starting', message: '本地服务正在启动。' }, nativeCore };
    }
    return {
      contractVersion: 1,
      server: { status: 'unavailable', message: this.lastEnsureError ?? '本地服务尚未启动。' },
      nativeCore,
    };
  }

  /** 单次主服务发现/拉起；并发折叠由 ensure() 负责。 */
  private async ensureOnce(): Promise<EnsuredServer> {
    this.throwIfShuttingDown();
    // 同一 manager 已经拉起时直接复用。
    if (this.currentEndpointRecord) {
      const isAlive =
        this.ownership === 'embedded'
          ? this.embedded != null
          : this.ownership === 'detached'
            ? this.detachedChild?.exitCode === null
            : true;
      if (isAlive) {
        return {
          endpoint: publicServerEndpoint(this.currentEndpointRecord),
          ownership: this.ownership,
        };
      }
    }
    const mod = await this.dependencies.loadOttoServer();
    this.throwIfShuttingDown();
    // 1) 发现并探活已运行的 server（headless / CLI / detached 已在跑时直接复用）。
    const readEndpointRecord = (
      mod as typeof mod & {
        readEndpointRecord?: () => ServerEndpointRecord | undefined;
      }
    ).readEndpointRecord;
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
        this.onHealthChange?.('服务运行中');
        if (this.localEnterpriseServerUrl) await this.ensureEnterprise();
        return {
          endpoint: publicServerEndpoint(discovered),
          ownership: 'discovered',
        };
      }
    }
    if (discovered && !this.dependencies.pidAlive(discovered.pid)) {
      mod.clearEndpoint();
    }

    // 2) 没有现成 server → detached 优先，失败则回退嵌入式。
    const port = resolvePort(mod.DEFAULT_PORT);
    try {
      const detachedEp = await this.startDetached(port);
      this.ownership = 'detached';
      this.currentEndpointRecord = detachedEp;
      if (this.localEnterpriseServerUrl) await this.ensureEnterprise();
      this.startHealthCheck();
      this.onHealthChange?.('服务运行中');
      return {
        endpoint: publicServerEndpoint(detachedEp),
        ownership: 'detached',
      };
    } catch (detachedErr) {
      console.warn(
        '[ServerManager] detached 启动失败，回退内嵌:',
        (detachedErr as Error)?.message ?? String(detachedErr),
      );
      // 回退：同进程内嵌
      const embeddedEp = await this.startEmbedded(port, mod);
      this.ownership = 'embedded';
      this.currentEndpointRecord = embeddedEp;
      if (this.localEnterpriseServerUrl) await this.ensureEnterprise();
      this.startHealthCheck();
      this.onHealthChange?.('服务运行中');
      return {
        endpoint: publicServerEndpoint(embeddedEp),
        ownership: 'embedded',
      };
    }
  }

  /**
   * 以 detached 子进程拉起 otto-server。
   * 使用 process.execPath + ELECTRON_RUN_AS_NODE=1 打包形态可用。
   * 开发形态：直接 node bin.js。
   */
  private async startDetached(port: number): Promise<ServerEndpointRecord> {
    const nodeExec = process.execPath;
    const mod = await this.dependencies.loadOttoServer();

    // 查找 bin.js 路径；active kernel overlay 优先，其次回退安装包内 otto-server。
    let binPath: string;
    const activeKernelBinPath = this.kernelUpdateRoot
      ? await readActiveKernelBinPath(this.kernelUpdateRoot).catch(() => null)
      : null;
    if (activeKernelBinPath) {
      binPath = activeKernelBinPath;
    } else {
      try {
        // 打包/开发形态：尝试通过 otto-server 模块解析
        const serverPkg = path.dirname(
          require.resolve('otto-server/package.json'),
        );
        binPath = path.join(serverPkg, 'dist', 'bin.js');
        if (!fs.existsSync(binPath)) {
          // 二次尝试：直接用 argv0 (node) 运行，开发环境
          throw new Error('bin.js not found via require.resolve');
        }
      } catch {
        // 终极回退：找 node 二进制
        binPath = path.join(path.dirname(process.execPath), 'bin.js');
      }
    }

    // 通过 writeEndpoint 写一个临时文件让 bin.js 的 writeEndpoint 覆盖
    // 实际上我们读到的是 bin.js 启动后写的端点

    const env: Record<string, string> = {
      ...process.env,
      OTTO_SERVER_PORT: String(port),
      OTTO_DEFAULT_WORKSPACE_PATH: os.homedir(),
    };

    let spawnArgs: string[];
    let spawnOpts: childProcess.SpawnOptions;

    if (nodeExec.endsWith('Electron') || nodeExec.includes('electron')) {
      // 打包形态：Electron 主二进制 + ELECTRON_RUN_AS_NODE
      env.ELECTRON_RUN_AS_NODE = '1';
      env.OTTO_SQLCIPHER_NATIVE_BINDING = path.join(
        process.resourcesPath,
        'sqlcipher',
        'better_sqlite3.node',
      );
      spawnArgs = [binPath, 'start'];
      spawnOpts = {
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      };
    } else {
      // 开发形态：直接用 node 跑
      spawnArgs = [binPath, 'start'];
      spawnOpts = {
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: true, // Windows 开发环境需要 shell
      };
    }

    const child = this.dependencies.spawnDetached(
      process.execPath,
      spawnArgs,
      spawnOpts,
    );
    this.detachedChild = child;
    child.unref(); // 不计入父进程事件循环引用

    // 监听子进程退出
    child.on('exit', (code, signal) => {
      console.warn(
        `[ServerManager] detached server 退出 code=${code} signal=${signal}`,
      );
      if (this.detachedChild === child) {
        this.detachedChild = undefined;
      }
    });

    // 收集启动输出用于诊断
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    // 等 server 写端点文件（轮询最多 15 秒）
    const timeoutMs = 15000;
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      if (this.shuttingDown) {
        try {
          child.kill('SIGTERM');
        } catch {}
        throw new Error('app 正在退出，已停掉刚拉起的 detached server');
      }
      const ep = mod.readEndpointRecord?.() ?? mod.readEndpoint();
      if (ep && this.dependencies.pidAlive(ep.pid)) {
        const healthy = await this.dependencies.probeHealth(
          ep.host,
          ep.port,
          mod.HTTP_ROUTES.health,
        );
        if (healthy) {
          console.log(
            `[ServerManager] detached server 就绪 → http://${ep.host}:${ep.port}`,
          );
          return ep;
        }
      }
      if (child.exitCode !== null) {
        if (this.detachedChild === child) this.detachedChild = undefined;
        throw new Error(
          `detached server 异常退出 code=${child.exitCode} stderr=${stderr.slice(-200)}`,
        );
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(
      `detached server 启动超时 (${timeoutMs}ms) stdout=${stdout.slice(-200)} stderr=${stderr.slice(-200)}`,
    );
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
  async shutdown(forceKill = false): Promise<void> {
    this.shuttingDown = true;
    this.stopHealthCheck();

    const logPrefix = forceKill ? 'FORCE_SHUTDOWN' : 'SHUTDOWN';
    try {
      fs.appendFileSync(
        serverLogPath(),
        `[${new Date().toISOString()}] ${logPrefix} 进程退出\n`,
      );
    } catch {}

    this.enterpriseListenAbort?.abort();
    if (this.enterpriseEnsurePromise) {
      try {
        await this.enterpriseEnsurePromise;
      } catch {}
    }
    if (this.enterpriseSrv) {
      try {
        await new Promise<void>((resolve) => {
          this.enterpriseSrv!.close(() => resolve());
          setTimeout(resolve, 3000);
        });
      } catch {}
      this.enterpriseSrv = undefined;
      this.enterpriseOwnership = 'unavailable';
    }
    if (this.embedded) {
      try {
        await this.embedded.stop();
      } catch {
      } finally {
        try {
          const mod = await this.dependencies.loadOttoServer();
          mod.clearEndpoint();
        } catch {}
        this.embedded = undefined;
        this.currentEndpointRecord = undefined;
      }
    }
    if (this.detachedChild) {
      if (forceKill) {
        console.log('[ServerManager] 强制停止 detached server…');
        try {
          const mod = await this.dependencies.loadOttoServer();
          const ep = mod.readEndpoint();
          if (ep?.pid && this.dependencies.pidAlive(ep.pid)) {
            process.kill(ep.pid, 'SIGTERM');
            await new Promise((r) => setTimeout(r, 2000));
            if (this.dependencies.pidAlive(ep.pid))
              process.kill(ep.pid, 'SIGKILL');
          }
          mod.clearEndpoint();
        } catch {}
        try {
          this.detachedChild.kill('SIGTERM');
        } catch {}
      } else {
        console.log('[ServerManager] detached server 留活（飞书继续运行）');
      }
      this.detachedChild = undefined;
      this.currentEndpointRecord = undefined;
    }
  }

  // ─── 健康检查与自动重启 ────────────────────────────────────────

  /** 启动定期健康检查（embedded 和 detached 模式）。 */
  private startHealthCheck(): void {
    if (this.healthCheckTimer) return;
    this.consecutiveHealthFailures = 0;
    this.healthCheckTimer = setInterval(() => {
      void this.runHealthCheck();
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  private stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
    }
  }

  private async runHealthCheck(): Promise<void> {
    if (!this.currentEndpointRecord) return;
    const { host, port } = this.currentEndpointRecord;
    try {
      const mod = await this.dependencies.loadOttoServer();
      const healthy = await this.dependencies.probeHealth(
        host,
        port,
        mod.HTTP_ROUTES.health,
      );
      if (healthy) {
        this.consecutiveHealthFailures = 0;
        // 健康恢复后重置重启计数（给后续故障一个新的重启机会）
        this.restartCount = 0;
        this.onHealthChange?.('服务运行中');
        return;
      }
    } catch {
      // probeHealth 自己吞异常，到这里就是 unhealthy
    }
    this.consecutiveHealthFailures++;
    this.onHealthChange?.(
      `心跳异常 (${this.consecutiveHealthFailures}/${MAX_HEALTH_FAILURES})`,
    );
    console.warn(
      `[ServerManager] 健康检查失败 (${this.consecutiveHealthFailures}/${MAX_HEALTH_FAILURES})`,
    );
    try {
      fs.appendFileSync(
        serverLogPath(),
        `[${new Date().toISOString()}] HEALTH_FAIL #${this.consecutiveHealthFailures}\n`,
      );
    } catch {}
    if (this.consecutiveHealthFailures >= MAX_HEALTH_FAILURES) {
      await this.restartServer();
    }
  }

  /** 自动重启 server（embedded 或 detached，带退避和上限）。 */
  private async restartServer(): Promise<void> {
    if (!this.currentEndpointRecord) return;
    this.restartCount++;
    if (this.restartCount > MAX_RESTART_COUNT) {
      const msg = `[ServerManager] 已重启 ${MAX_RESTART_COUNT} 次依然不健康，停止自动重启。请手动排查。`;
      console.error(msg);
      try {
        fs.appendFileSync(
          serverLogPath(),
          `[${new Date().toISOString()}] ${msg}\n`,
        );
      } catch {}
      this.stopHealthCheck();
      return;
    }
    const backoffMs = [1000, 3000, 5000][this.restartCount - 1] ?? 5000;
    console.warn(
      `[ServerManager] ${backoffMs / 1000}s 后尝试第 ${this.restartCount} 次重启…`,
    );
    await new Promise((r) => setTimeout(r, backoffMs));
    if (this.shuttingDown) return;

    // 停旧实例
    if (this.embedded) {
      try {
        await this.embedded.stop();
      } catch {}
    }
    if (this.detachedChild) {
      try {
        this.detachedChild.kill('SIGTERM');
      } catch {}
      this.detachedChild = undefined;
    }
    try {
      const mod = await this.dependencies.loadOttoServer();
      const ep = mod.readEndpoint();
      if (ep?.pid && this.dependencies.pidAlive(ep.pid)) {
        process.kill(ep.pid, 'SIGTERM');
        await new Promise((r) => setTimeout(r, 1000));
      }
      mod.clearEndpoint();
    } catch {}
    this.embedded = undefined;
    this.currentEndpointRecord = undefined;
    this.consecutiveHealthFailures = 0;

    // 重新拉起：detached 优先
    try {
      const mod = await this.dependencies.loadOttoServer();
      const port = resolvePort(mod.DEFAULT_PORT);
      try {
        const ep = await this.startDetached(port);
        this.ownership = 'detached';
        this.currentEndpointRecord = ep;
      } catch {
        const ep = await this.startEmbedded(port, mod);
        this.ownership = 'embedded';
        this.currentEndpointRecord = ep;
      }
      this.startHealthCheck();
      const restartMsg = `[ServerManager] server 已成功重启于端口 ${this.currentEndpointRecord.port}`;
      console.log(restartMsg);
      try {
        fs.appendFileSync(
          serverLogPath(),
          `[${new Date().toISOString()}] ${restartMsg}\n`,
        );
      } catch {}
    } catch (err) {
      const failMsg = `[ServerManager] 自动重启失败: ${(err as Error)?.message ?? String(err)}`;
      console.error(failMsg);
      try {
        fs.appendFileSync(
          serverLogPath(),
          `[${new Date().toISOString()}] ${failMsg}\n`,
        );
      } catch {}
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
    const enableFeishu = feishuCredentialsExist();
    const store = new mod.PersistentSessionStore(sessionsDir(), {
      defaultWorkspacePath: os.homedir(),
    });
    // 确保日志目录存在并设置固定日志路径
    try {
      fs.mkdirSync(logsDir(), { recursive: true });
    } catch {}
    process.env.OTTO_LOG_DIR = logsDir();
    const server = new mod.OttoServer({
      host: mod.DEFAULT_HOST,
      port,
      enableFeishu,
      store,
      defaultWorkspacePath: os.homedir(),
    }) as TrustedOttoServer;
    try {
      await server.start();
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'EADDRINUSE') {
        // 端口冲突：自动 +1 重试，最多 MAX_PORT_RETRIES 次
        const nextPort = port + 1;
        if (nextPort - resolvePort(mod.DEFAULT_PORT) > MAX_PORT_RETRIES) {
          throw new Error(
            `端口 ${port}~${nextPort - 1} 均被占用，请关闭占用端口的进程后重试`,
          );
        }
        console.warn(`[ServerManager] 端口 ${port} 被占用，尝试 ${nextPort}…`);
        try {
          fs.appendFileSync(
            serverLogPath(),
            `[${new Date().toISOString()}] WARN 端口 ${port} 被占用，尝试 ${nextPort}\n`,
          );
        } catch {}
        return this.startEmbedded(nextPort, mod);
      }
      try {
        fs.appendFileSync(
          serverLogPath(),
          `[${new Date().toISOString()}] ERROR server启动失败: ${(err as Error)?.message ?? String(err)}\n`,
        );
      } catch {}
      throw err;
    }
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
    const { host, port: boundPort, clientToken } = server.endpoint;
    const logMsg = `[ServerManager] otto-server 已就绪 → http://${host}:${boundPort} | 飞书:${enableFeishu ? '已启用' : '未启用'} | 日志: ${serverLogPath()}`;
    const logFile = serverLogPath();
    try {
      fs.mkdirSync(logsDir(), { recursive: true });
    } catch {}
    try {
      fs.appendFileSync(
        logFile,
        `[${new Date().toISOString()}] STARTED ${logMsg}\n`,
      );
    } catch {}
    console.log(logMsg);
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
    if (!record)
      throw new Error('本机 OttoServer 尚未就绪，请重启 Otto 后重试');
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
    const identityRoute = (
      mod.HTTP_ROUTES as typeof mod.HTTP_ROUTES & {
        enterpriseIdentity?: string;
      }
    ).enterpriseIdentity;
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
        const body = (await response.json().catch(() => ({}))) as {
          error?: unknown;
        };
        const detail =
          typeof body.error === 'string' && body.error.trim()
            ? `：${body.error.trim()}`
            : `（HTTP ${response.status}）`;
        throw new Error(
          `本机 OttoServer 拒绝身份同步${detail}。` +
            '请退出所有 Otto/CLI 进程后重新启动 Otto。',
        );
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes('请退出所有 Otto/CLI')
      ) {
        throw error;
      }
      const detail =
        error instanceof Error && error.name === 'AbortError'
          ? '请求超时'
          : error instanceof Error
            ? error.message
            : String(error);
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
    const host =
      localUrl.hostname === 'localhost'
        ? '127.0.0.1'
        : localUrl.hostname.replace(/^\[|\]$/g, '');
    const port = localUrl.port
      ? Number(localUrl.port)
      : ENTERPRISE_DEFAULT_PORT;
    try {
      // 先探活再监听：CLI 或另一个 Otto 实例已经启动企业服务时直接复用，
      // 避免把正常的 EADDRINUSE 当成后台不可用。
      if (
        await this.dependencies.probeHealth(host, port, '/enterprise/health')
      ) {
        this.enterpriseOwnership = 'discovered';
        return;
      }
      const { createEnterpriseServer } =
        await this.dependencies.loadEnterpriseServer();
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
        (err as NodeJS.ErrnoException)?.code === 'EADDRINUSE' &&
        (await this.dependencies.probeHealth(host, port, '/enterprise/health'))
      ) {
        this.enterpriseOwnership = 'discovered';
        return;
      }
      this.enterpriseOwnership = 'unavailable';
      if (!this.shuttingDown) {
        console.warn(
          '[ServerManager] enterprise-server 启动失败（非致命，管理后台不可用）:',
          (err as Error)?.message ?? String(err),
        );
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
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1'
  );
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
    const isLoopback =
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1';
    if (url.protocol !== 'http:' || !isLoopback || url.username || url.password)
      return null;
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
