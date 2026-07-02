/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Electron 主进程（Issue #4 + #9）。
 *
 * 职责：
 *   1. 建主窗口（含图标占位），加载 renderer（dist/renderer/index.html）。
 *   2. 安全基线：禁 nodeIntegration、开 contextIsolation + sandbox、本地 CSP、
 *      导航/新窗口/权限/webview 全部按白名单收紧。
 *   3. 用 ServerManager 确保有可用 otto-server：发现已运行的就复用，否则
 *      同进程内嵌拉起（embedded-only；随 app 退出而停）。
 *   4. 把发现/拉起的 server 端点经 IPC（拉取 + 主动推送）交给 preload，
 *      供 renderer 建 WS 连接。
 *   5. 完整生命周期：单实例锁、activate、window-all-closed、before-quit、
 *      渲染进程崩溃 / 卡死处置。
 *
 * 注意：main 是 ESM（package "type":"module"）；preload 是 CJS（Electron 标准）。
 */

import {
  app,
  BrowserWindow,
  ipcMain,
  nativeImage,
  session,
  shell,
  type NativeImage,
} from 'electron';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_HOST, DEFAULT_PORT, type ServerEndpoint } from 'otto-server';
import { ServerManager } from './server-manager.js';
import { installAppMenu } from './menu.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * renderer 静态资源目录。与 createWindow 的 loadFile 用同一推导
 * （dist/main → dist/renderer），开发模式与 asar 打包内路径均成立；
 * 也是 isLocalAppUrl 白名单的锚点。
 */
const RENDERER_DIR = path.join(__dirname, '../renderer');

/** 渲染进程崩溃自动重载的退避：窗口期内超过上限就不再 reload，防白屏无限闪烁。 */
const CRASH_RELOAD_WINDOW_MS = 60_000;
const CRASH_RELOAD_MAX = 3;

/** server 生命周期管理器（发现/拉起/探活/退出清理）。 */
const serverManager = new ServerManager();
/** 当前 server 端点（发现的或拉起的）。renderer 经 IPC 取它建 WS。 */
let endpoint: ServerEndpoint | undefined;
/** 主窗口单例引用。 */
let mainWindow: BrowserWindow | undefined;

// ── IPC channel 名（与 preload 对齐）──
const IPC = {
  getEndpoint: 'otto:get-endpoint',
  endpointChanged: 'otto:endpoint-changed',
  openExternal: 'otto:open-external',
  openPath: 'otto:open-path',
} as const;

// ────────────────────────────────────────────────────────────────────────
// 窗口
// ────────────────────────────────────────────────────────────────────────

/**
 * 加载窗口图标占位：dist/renderer/icon.png 存在则用，否则返回空 image
 * （Electron 在无图标时回退默认，不报错）。真正的品牌图标由 #8 打包时补。
 */
function loadIcon(): NativeImage {
  const iconPath = path.join(RENDERER_DIR, 'icon.png');
  if (fs.existsSync(iconPath)) {
    return nativeImage.createFromPath(iconPath);
  }
  return nativeImage.createEmpty();
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    title: 'Otto',
    backgroundColor: '#181818',
    icon: loadIcon(),
    // 内容就绪再显示，避免白屏闪烁。
    show: false,
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      // ── 安全基线（Issue #4）──
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
      // 禁用 renderer 直接走 Node 的 experimental features。
      preload: path.join(__dirname, '../preload/index.js'),
    },
  });

  win.once('ready-to-show', () => win.show());

  hardenWebContents(win);

  void win.loadFile(path.join(RENDERER_DIR, 'index.html'));
  return win;
}

/** 收紧单个窗口 webContents 的导航 / 新窗口行为。 */
function hardenWebContents(win: BrowserWindow): void {
  // 外链统一走系统浏览器，不在 app 内开新窗口。
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  // 阻止 renderer 导航离开本地 app（防被劫持加载远程页）。
  win.webContents.on('will-navigate', (event, url) => {
    if (!isLocalAppUrl(url)) {
      event.preventDefault();
      if (isExternalUrl(url)) void shell.openExternal(url);
    }
  });

  // 渲染进程崩溃 / 卡死：记录并尝试恢复（重载）。带退避：60s 内最多重载
  // CRASH_RELOAD_MAX 次，超限视为必现崩溃，改为展示错误页，防白屏无限闪烁。
  let crashReloadTimes: number[] = [];
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[otto-desktop] renderer 进程退出:', details.reason);
    if (details.reason === 'clean-exit' || win.isDestroyed()) return;
    const now = Date.now();
    crashReloadTimes = crashReloadTimes.filter(
      (t) => now - t < CRASH_RELOAD_WINDOW_MS,
    );
    if (crashReloadTimes.length < CRASH_RELOAD_MAX) {
      crashReloadTimes = [...crashReloadTimes, now];
      win.webContents.reload();
    } else {
      console.error(
        '[otto-desktop] renderer 短时间内反复崩溃，停止自动重载，改为展示错误页',
      );
      void win.webContents.loadURL(crashPageDataUrl());
    }
  });
  win.webContents.on('unresponsive', () => {
    console.warn('[otto-desktop] renderer 无响应');
  });
}

/**
 * 是否本地 app 资源：仅放行 renderer 目录内的 file:// URL。
 * 只判 file:// 前缀会放行任意本地文件，被劫持时可导航到磁盘上任何页面。
 */
function isLocalAppUrl(url: string): boolean {
  if (!url.startsWith('file://')) return false;
  try {
    const target = path.resolve(fileURLToPath(url));
    return (
      target === RENDERER_DIR || target.startsWith(RENDERER_DIR + path.sep)
    );
  } catch {
    // 非法 file URL（如带 host 段）→ 拒绝。
    return false;
  }
}

/** 反复崩溃后的兜底错误页（data: URL；朴素静态页，无脚本）。 */
function crashPageDataUrl(): string {
  const html =
    '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>Otto - 界面已停止响应</title></head>' +
    '<body style="margin:0;display:flex;align-items:center;justify-content:center;' +
    'min-height:100vh;background:#181818;color:#ddd;' +
    'font-family:system-ui,-apple-system,sans-serif">' +
    '<div style="max-width:32em;padding:2em;line-height:1.8">' +
    '<h1 style="font-size:1.3em;color:#fff">Otto 界面多次崩溃</h1>' +
    '<p>渲染进程在短时间内反复异常退出，已停止自动恢复以避免闪烁。</p>' +
    '<p>请退出并重新启动 Otto；若问题持续出现，请附终端日志反馈。</p>' +
    '</div></body></html>';
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/** 是否可放行到系统浏览器的外链（仅 http/https）。 */
function isExternalUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

// ────────────────────────────────────────────────────────────────────────
// 安全：CSP + 权限
// ────────────────────────────────────────────────────────────────────────

/** 本地 CSP：只允许自身资源 + 连本地 server WS/HTTP。 */
function applyCsp(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const host = endpoint?.host ?? DEFAULT_HOST;
    const port = endpoint?.port ?? DEFAULT_PORT;
    const csp = [
      "default-src 'self'",
      // renderer 由 webpack 内联样式（style-loader）→ 需要 'unsafe-inline' 样式。
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self' data:",
      // 仅允许连本地 server（HTTP 拉历史 + WS 实时）。
      `connect-src 'self' http://${host}:${port} ws://${host}:${port}`,
      "script-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-src 'none'",
    ].join('; ');
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });

  // 一律拒绝 renderer 的权限请求（摄像头/麦克风/地理位置等都用不到）。
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) =>
    cb(false),
  );
}

// ────────────────────────────────────────────────────────────────────────
// server 端点：发现/拉起 + 推送给 renderer
// ────────────────────────────────────────────────────────────────────────

/** 确保 server 可用并把端点缓存下来；失败不抛（renderer 显示「未连接」）。 */
async function ensureEndpoint(): Promise<void> {
  try {
    const ensured = await serverManager.ensure();
    endpoint = ensured.endpoint;
    console.log(
      `[otto-desktop] server ${ensured.ownership} @ http://${endpoint.host}:${endpoint.port}`,
    );
    pushEndpointToRenderer();
  } catch (e) {
    console.error('[otto-desktop] server 启动失败:', e);
  }
}

/** 主动把最新端点推给 renderer（preload 据此触发 connect）。 */
function pushEndpointToRenderer(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.endpointChanged, endpoint ?? null);
  }
}

// ────────────────────────────────────────────────────────────────────────
// IPC
// ────────────────────────────────────────────────────────────────────────

function registerIpc(): void {
  // renderer 经 preload 拉当前端点（连接前 / 重连时）。
  ipcMain.handle(IPC.getEndpoint, () => endpoint ?? null);

  // host-only 命令（替代 webview 的 vscode host 命令；交付文档 [WEBVIEW] §5）。
  ipcMain.handle(IPC.openExternal, (_e, url: unknown) => {
    if (typeof url === 'string' && isExternalUrl(url)) {
      return shell.openExternal(url);
    }
    return Promise.resolve();
  });
  ipcMain.handle(IPC.openPath, (_e, p: unknown) => {
    // 仅允许打开用户 home 目录内的绝对路径（防越界打开 /etc/passwd 等敏感文件，code review LOW）。
    // realpath 解析符号链接后再比较前缀，防 home 内 symlink 指向外部绕过；
    // 目标不存在（realpath 抛 ENOENT）时直接拒绝。
    if (typeof p === 'string' && p.length > 0 && path.isAbsolute(p)) {
      let home: string;
      let resolved: string;
      try {
        home = fs.realpathSync(app.getPath('home'));
        resolved = fs.realpathSync(path.resolve(p));
      } catch {
        return Promise.resolve('');
      }
      if (resolved === home || resolved.startsWith(home + path.sep)) {
        return shell.openPath(resolved);
      }
    }
    return Promise.resolve('');
  });
}

// ────────────────────────────────────────────────────────────────────────
// 生命周期
// ────────────────────────────────────────────────────────────────────────

// 单实例锁：第二次启动直接聚焦已开窗口，避免多开多个 server 抢端口。
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    registerIpc();
    installAppMenu(() => mainWindow);

    // 先建窗（show:false，ready-to-show 再显），同时并发确保 server。
    mainWindow = createWindow();
    applyCsp();
    await ensureEndpoint();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createWindow();
        // 窗口重建后把已知端点补推一次。
        mainWindow.webContents.once('did-finish-load', pushEndpointToRenderer);
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    // 仅内嵌 server 随 app 退出而停；discovered（headless/CLI 已在跑）故意留活。
    void serverManager.shutdown();
  });
}
