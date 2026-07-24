/**
 * @license
 * Copyright 2026 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 最终 DMG 的动态交付门禁。
 *
 * 静态看到 app.asar 里存在 preload 不代表它能在 Electron sandbox 中执行。
 * 本脚本从 DMG 启动真实 Otto.app，并通过 CDP 验证：
 *   1. renderer 确实来自最终 app.asar；
 *   2. preload 暴露真实 window.otto；
 *   3. main IPC 可往返，且浏览器预览 bridge 无法伪造成功；
 *   4. preload 与隔离本地 server 的 WS 可往返 sessions_list；
 *   5. 登录页没有 preload 失败导致的空值错误。
 */

import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { basename, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptDir, '..');
const packageJson = JSON.parse(
  readFileSync(resolve(desktopDir, 'package.json'), 'utf8'),
);
const expectedVersion = packageJson.version;
const enterpriseSmokeUrl = 'https://enterprise-smoke.invalid';
const dmgPath = resolve(
  process.argv[2] ?? resolve(desktopDir, `release/Otto-${expectedVersion}-arm64.dmg`),
);

if (process.platform !== 'darwin') {
  throw new Error('最终 DMG 动态验收只能在 macOS 上执行');
}
if (!existsSync(dmgPath)) {
  throw new Error(`DMG 不存在: ${dmgPath}`);
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function reservePort() {
  const server = createServer();
  server.unref();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('无法取得随机 loopback 端口');
  }
  const { port } = address;
  await new Promise((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
  return port;
}

async function waitForDebugger(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '尚未发现 renderer page';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const targets = await response.json();
      const page = targets.find((target) =>
        target.type === 'page'
        && typeof target.webSocketDebuggerUrl === 'string'
        && String(target.url).includes('/app.asar/dist/renderer/index.html')
      );
      if (page) return page;
      lastError = `目标列表没有 Otto renderer: ${JSON.stringify(targets)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(250);
  }
  throw new Error(`等待 Electron CDP 超时: ${lastError}`);
}

async function createCdpClient(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  await Promise.race([
    once(socket, 'open'),
    sleep(10_000).then(() => {
      throw new Error('连接 Electron CDP WebSocket 超时');
    }),
  ]);

  let nextId = 1;
  const pending = new Map();
  const runtimeExceptions = [];

  socket.on('message', (data) => {
    const message = JSON.parse(String(data));
    if (message.method === 'Runtime.exceptionThrown') {
      runtimeExceptions.push(message.params?.exceptionDetails ?? message.params);
      return;
    }
    if (!message.id) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timeout);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  const rejectPending = (error) => {
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    pending.clear();
  };
  socket.on('error', (error) => rejectPending(error));
  socket.on('close', () => rejectPending(new Error('Electron CDP WebSocket 已关闭')));

  function send(method, params = {}) {
    const id = nextId++;
    return new Promise((resolveResult, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Electron CDP ${method} 超时`));
      }, 15_000);
      pending.set(id, { resolve: resolveResult, reject, timeout });
      socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (!error) return;
        const request = pending.get(id);
        if (!request) return;
        pending.delete(id);
        clearTimeout(request.timeout);
        reject(error);
      });
    });
  }

  return {
    runtimeExceptions,
    send,
    close: () => socket.close(),
  };
}

function assertSmokeResult(result) {
  const failures = [];
  if (!result || typeof result !== 'object') failures.push('未返回结构化验收结果');
  if (!result?.pageUrl?.includes('/app.asar/dist/renderer/index.html')) {
    failures.push(`renderer 不是最终 app.asar: ${result?.pageUrl ?? '(missing)'}`);
  }
  if (!result?.hasBridge) failures.push('window.otto 未注入');
  if (result?.missingMethods?.length) {
    failures.push(`bridge 缺少方法: ${result.missingMethods.join(', ')}`);
  }
  if (result?.appVersion !== expectedVersion) {
    failures.push(`appVersion=${result?.appVersion ?? '(missing)'}，期望 ${expectedVersion}`);
  }
  if (!result?.sessionIsValid) {
    failures.push(`enterpriseSession 返回无效: ${JSON.stringify(result?.session)}`);
  }
  if (result?.session?.serverUrl !== enterpriseSmokeUrl || result?.session?.account !== null) {
    failures.push(
      `隔离企业会话被污染: ${JSON.stringify(result?.session)}`,
    );
  }
  if (!String(result?.loginProbeError ?? '').includes('登录信息格式不正确')) {
    failures.push(`main IPC 探针未按预期拒绝: ${result?.loginProbeError ?? '(missing)'}`);
  }
  if (result?.connected !== true) failures.push('preload 未连接隔离本地 server');
  if (result?.frameType !== 'sessions_list') {
    failures.push(`WS 未收到 sessions_list: ${result?.frameType ?? '(missing)'}`);
  }
  if (!result?.hasLoginEntry) failures.push('最终页面未显示登录入口');
  if (result?.bodyHasNullServerError) failures.push('登录页仍出现 null/serverUrl 错误');
  if (failures.length > 0) {
    throw new Error(`最终 DMG 动态验收失败:\n- ${failures.join('\n- ')}`);
  }
}

const tempRoot = mkdtempSync(resolve(tmpdir(), 'otto-packaged-smoke-'));
const mountPoint = resolve(tempRoot, 'mount');
const homeDir = resolve(tempRoot, 'home');
const userDataDir = resolve(tempRoot, 'user-data');
const ottoUserDir = resolve(tempRoot, 'otto-user');
mkdirSync(mountPoint);
mkdirSync(homeDir);
mkdirSync(userDataDir);
mkdirSync(ottoUserDir);

let mounted = false;
let appProcess;
let cdp;
let output = '';
try {
  execFileSync(
    'hdiutil',
    ['attach', '-readonly', '-nobrowse', '-mountpoint', mountPoint, dmgPath],
    { stdio: 'pipe' },
  );
  mounted = true;

  const appPath = resolve(mountPoint, 'Otto.app');
  const executable = resolve(appPath, 'Contents/MacOS/Otto');
  if (!existsSync(executable)) {
    throw new Error(`DMG 内缺少 Otto.app 可执行文件: ${executable}`);
  }

  const [serverPort, debuggerPort] = await Promise.all([
    reservePort(),
    reservePort(),
  ]);
  appProcess = spawn(
    executable,
    [
      `--user-data-dir=${userDataDir}`,
      `--remote-debugging-port=${debuggerPort}`,
      '--enable-logging=stderr',
    ],
    {
      cwd: homeDir,
      detached: true,
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        OTTO_USER_DATA_DIR: userDataDir,
        OTTO_USER_DIR: ottoUserDir,
        OTTO_SERVER_PORT: String(serverPort),
        OTTO_ENTERPRISE_SERVER_URL: enterpriseSmokeUrl,
        ELECTRON_ENABLE_LOGGING: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const capture = (chunk) => {
    output = (output + String(chunk)).slice(-200_000);
  };
  appProcess.stdout.on('data', capture);
  appProcess.stderr.on('data', capture);
  appProcess.on('error', capture);

  const page = await waitForDebugger(debuggerPort);
  cdp = await createCdpClient(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');

  const expression = `(() => new Promise(async (resolve) => {
    const timeout = setTimeout(() => resolve({ smokeTimeout: true }), 12000);
    try {
      const uiDeadline = Date.now() + 5000;
      while (
        Date.now() < uiDeadline
        && (!document.body || !(document.body.innerText || '').trim())
      ) {
        await new Promise((next) => setTimeout(next, 50));
      }
      const bridge = window.otto;
      const required = [
        'enterpriseSession', 'enterprisePasswordLogin', 'appVersion',
        'connect', 'send', 'onFrame'
      ];
      const missingMethods = required.filter((name) => typeof bridge?.[name] !== 'function');
      if (!bridge || missingMethods.length > 0) {
        clearTimeout(timeout);
        resolve({
          pageUrl: location.href,
          hasBridge: Boolean(bridge),
          missingMethods,
          bodyText: document.body?.innerText ?? ''
        });
        return;
      }

      const appVersion = await bridge.appVersion();
      const session = await bridge.enterpriseSession();
      let loginProbeError = '';
      try {
        await bridge.enterprisePasswordLogin(null);
      } catch (error) {
        loginProbeError = error instanceof Error ? error.message : String(error);
      }

      const framePromise = new Promise((resolveFrame) => {
        const stop = bridge.onFrame((frame) => {
          if (frame?.type !== 'sessions_list') return;
          stop();
          resolveFrame(frame.type);
        });
        setTimeout(() => {
          stop();
          resolveFrame(null);
        }, 5000);
      });
      const connected = await bridge.connect();
      bridge.send({ type: 'list_sessions', payload: {} });
      const frameType = await framePromise;
      const bodyText = document.body?.innerText ?? '';
      clearTimeout(timeout);
      resolve({
        pageUrl: location.href,
        hasBridge: true,
        missingMethods,
        appVersion,
        session,
        sessionIsValid: Boolean(
          session
          && typeof session === 'object'
          && typeof session.serverUrl === 'string'
          && (session.account === null || typeof session.account === 'object')
        ),
        loginProbeError,
        connected,
        frameType,
        hasLoginEntry: bodyText.includes('进入 Otto'),
        bodyHasNullServerError:
          bodyText.includes("Cannot read properties of null")
          || bodyText.includes("reading 'serverUrl'")
      });
    } catch (error) {
      clearTimeout(timeout);
      resolve({
        pageUrl: location.href,
        smokeError: error instanceof Error ? error.stack || error.message : String(error),
        bodyText: document.body?.innerText ?? ''
      });
    }
  }))()`;
  const evaluation = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (evaluation.exceptionDetails) {
    throw new Error(`CDP evaluate 异常: ${JSON.stringify(evaluation.exceptionDetails)}`);
  }
  const result = evaluation.result?.value;
  if (result?.smokeTimeout) throw new Error('最终 DMG 动态验收超时');
  if (result?.smokeError) throw new Error(`最终 DMG 动态验收异常: ${result.smokeError}`);
  assertSmokeResult(result);

  const fatalOutput = [
    /Unable to load preload script/i,
    /Cannot find module ['"][^'"]*dist[\\/]preload/i,
    /uncaught exception/i,
  ].some((signature) => signature.test(output));
  if (fatalOutput) {
    throw new Error(`Electron 日志包含 preload/未捕获异常:\n${output}`);
  }
  if (cdp.runtimeExceptions.length > 0) {
    throw new Error(
      `renderer 出现未捕获异常: ${JSON.stringify(cdp.runtimeExceptions)}`,
    );
  }

  console.log(
    `[packaged-smoke] 通过: ${basename(dmgPath)}; `
    + `version=${result.appVersion}; IPC=ok; WS=${result.frameType}`,
  );
} finally {
  try {
    cdp?.close();
  } catch {
    // best effort
  }
  if (appProcess?.pid) {
    try {
      process.kill(-appProcess.pid, 'SIGTERM');
    } catch {
      // 进程可能已退出。
    }
    await Promise.race([
      once(appProcess, 'exit').catch(() => undefined),
      sleep(5_000),
    ]);
    if (appProcess.exitCode === null && appProcess.signalCode === null) {
      const killedExit = once(appProcess, 'exit').catch(() => undefined);
      try {
        process.kill(-appProcess.pid, 'SIGKILL');
      } catch {
        // 进程可能已退出。
      }
      await Promise.race([killedExit, sleep(5_000)]);
    }
  }
  if (mounted) {
    let detachError;
    // Electron/WindowServer 退出后，macOS 偶尔还会短暂占用只读 APFS DMG。
    // 旧的 5 × 500ms 会把已通过的产品验收误报成失败；先给系统完整的释放窗口。
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      try {
        execFileSync('hdiutil', ['detach', mountPoint], { stdio: 'pipe' });
        mounted = false;
        detachError = undefined;
        break;
      } catch (error) {
        detachError = error;
        if (attempt < 20) await sleep(500);
      }
    }
    // 目标始终是本脚本刚挂载的临时、只读镜像；正常重试耗尽后才强制卸载。
    if (mounted) {
      try {
        execFileSync(
          'hdiutil',
          ['detach', '-force', mountPoint],
          { stdio: 'pipe' },
        );
        mounted = false;
        detachError = undefined;
      } catch (error) {
        detachError = error;
      }
    }
    if (mounted) {
      throw new Error(
        `[packaged-smoke] 正常重试与只读镜像强制卸载后仍失败: ${String(detachError)}`,
      );
    }
  }
  rmSync(tempRoot, { recursive: true, force: true });
}
