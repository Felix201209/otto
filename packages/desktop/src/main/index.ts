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
 * 注意：package.json 无 "type":"module" → main/preload 均编译为 CJS（Electron 标准，
 * 且 import.meta.url 在 CJS 输出下会被 tsc 直接拒绝/TS1470）。__dirname 用 CJS 原生
 * 全局变量，不需要（也不能用）ESM 的 fileURLToPath(import.meta.url) 重建。
 *
 * 注意：otto-server 是纯 ESM 包，本文件是 CJS：不能静态 `import {...} from 'otto-server'`
 * （会被编译成 require()，真机运行时抛 ERR_REQUIRE_ESM 崩溃）。DEFAULT_HOST/DEFAULT_PORT
 * 只是 CSP 兜底默认值的字面量，这里直接内联同样的值，避免为两个常量单独走一次
 * import()（server-manager.ts 已经承担了对 otto-server 真正需要的值的动态加载）。
 */

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  session,
  shell,
  type NativeImage,
} from 'electron';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  HealthInfo,
  ServerEndpoint,
} from 'otto-server';

/** 脱敏后的飞书配置视图（不含 secret）。 */
interface FeishuConfigPublic {
  appId: string;
  appSecret: string;
  verificationToken: string | null;
  encryptKey: string | null;
}

/** 客户端保存飞书配置的请求体。 */
interface FeishuConfigSaveRequest {
  appId: string;
  appSecret: string;
  verificationToken?: string | null;
  encryptKey?: string | null;
}

interface FeishuHealthStatusLocal {
  running: boolean;
  forwarding: boolean;
  configured: boolean;
  lastEventAt: number | null;
  reconnectAttempts: number;
}

interface FeishuStatusInfo {
  enabled: boolean;
  connected: boolean;
  status?: FeishuHealthStatusLocal;
}

import { ServerManager } from './server-manager.js';
import { installAppMenu } from './menu.js';
import { UpdateService } from './update-service.js';
import {
  generateAndSaveWorkReport,
  localDateKey,
  readRecentWorkLogs,
  readWorkLogEntries,
  summarizeWorkLog,
} from './workLogData.js';
import { loadVoiceConfig, saveVoiceConfig, type VoiceConfigInput } from './voiceConfig.js';
import { transcribeAudio } from './voiceService.js';

/** 与 packages/server/src/protocol.ts 的 DEFAULT_HOST/DEFAULT_PORT 保持一致的字面量
 * （仅用作 CSP 的兜底默认值；真实值在 ensureEndpoint() 拿到后覆盖）。 */
const CSP_FALLBACK_HOST = '127.0.0.1';
const CSP_FALLBACK_PORT = 7637;

/**
 * renderer 静态资源目录。与 createWindow 的 loadFile 用同一推导
 * （dist/main → dist/renderer），开发模式与 asar 打包内路径均成立；
 * 也是 isLocalAppUrl 白名单的锚点。
 */
const RENDERER_DIR = path.join(__dirname, '../renderer');

function worklogRootDir(): string {
  const explicit = process.env['OTTO_WORKLOG_DIR']?.trim();
  if (explicit) return explicit;
  const userDir = process.env['OTTO_USER_DIR']?.trim();
  if (userDir) return path.join(userDir, 'memory', 'worklog');
  return path.join(os.homedir(), '.otto-user', 'memory', 'worklog');
}

/** 部门 Skill 共享记录（.otto/org/skill-shares.json 条目；krx 企业面板数据）。 */
interface SkillShareRecord {
  skillName?: string;
  version?: number;
  featureDescription?: string;
  sharedBy?: string;
  sharedByName?: string;
  teamId?: string;
  teamName?: string;
  status?: string;
  note?: string;
  rating?: number;
  ratingCount?: number;
  installCount?: number;
  usageCount?: number;
  successCount?: number;
  publishedToMarketplace?: boolean;
}

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
  saveTextFile: 'otto:save-text-file',
  feishuStart: 'otto:feishu-start',
  feishuStop: 'otto:feishu-stop',
  feishuStatus: 'otto:feishu-status',
  feishuGetConfig: 'otto:feishu-get-config',
  feishuSaveConfig: 'otto:feishu-save-config',
  feishuClearConfig: 'otto:feishu-clear-config',
  parkConfig: 'otto:park-config',
  themeGet: 'otto:theme-get',
  themeSet: 'otto:theme-set',
  skillLeaderboard: 'otto:skill-leaderboard',
  workLogToday: 'otto:worklog-today',
  workLogRecent: 'otto:worklog-recent',
  workLogReport: 'otto:worklog-report',
  skillShareList: 'otto:skill-share-list',
  skillMarketplace: 'otto:skill-marketplace',
  setLocalTestUrl: 'otto:set-local-test-url',
  appVersion: 'otto:app-version',
  updateCheck: 'otto:update-check',
  updateDownload: 'otto:update-download',
  updateCancel: 'otto:update-cancel',
  updateInstall: 'otto:update-install',
  updateProgress: 'otto:update-progress',
  voiceGetConfig: 'otto:voice-get-config',
  voiceSaveConfig: 'otto:voice-save-config',
  voiceTranscribe: 'otto:voice-transcribe',
} as const;

/**
 * 软件更新服务（检查 / 下载 / 安装，逻辑见 update-service.ts）。
 * 进度经 IPC.updateProgress 推给当前主窗口；窗口可能重建，故传 getter。
 */
const updateService = new UpdateService(
  () => mainWindow?.webContents,
  IPC.updateProgress,
);

/**
 * 飞书状态/启停在桌面端的通路（诚实原则，全部真实）。
 *
 * 状态（feishuStatus）：桌面端连接的 server（内嵌或发现的）在 /health 里带出
 * 飞书守护详情（connected / 重连第 N 次 / 下次重试 / 锁被哪个 pid 持有），
 * 这里直接查询透传——绝不假报「已连接」；锁被别的进程（如 CLI daemon）拿着时
 * 如实说「另一进程持有」。
 *
 * 启停（feishuStart/feishuStop）：真调 server 的运行期端点
 * POST /feishu/start、POST /feishu/stop：
 *   - start：server 未启用（含运行期才配好凭证）→ 现场注册并启动守护；
 *     已在跑 → 幂等返回当前状态；无凭证 → server 诚实报错（ok:false），
 *     桌面端原样透传，不谎报「已启动」。
 *   - stop：有意停止，之后不自动重连，直到再次 start。
 * 每次操作后附最新真实状态文案。
 */

/** /health 单次查询超时（ms）。 */
const FEISHU_HEALTH_TIMEOUT_MS = 1500;
/** 启停端点超时（ms）：start 含 registerFeishu（不阻塞等建连），给宽一点。 */
const FEISHU_OP_TIMEOUT_MS = 5000;

/**
 * POST 一个 server 端点（无 body），解析 ApiResponse 信封。
 * 网络失败/超时/server 未就绪 → 返回 null（调用方给「未就绪」诚实文案）。
 */
function postServerEndpoint(
  routePath: string,
): Promise<{ ok: boolean; data: any; error: string | null } | null> {
  const ep = endpoint;
  if (!ep) return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: ep.host,
        port: ep.port,
        path: routePath,
        method: 'POST',
        timeout: FEISHU_OP_TIMEOUT_MS,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => {
          try {
            resolve(
              JSON.parse(body) as {
                ok: boolean;
                data: any;
                error: string | null;
              },
            );
          } catch {
            resolve(null);
          }
        });
        res.on('error', () => resolve(null));
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

/**
 * 请求 /feishu/config（GET/POST/DELETE），解析 ApiResponse 信封。
 * 网络失败/超时/server 未就绪 → null。POST body 里含 appSecret，
 * 只走回环 HTTP 到本机 server，不落任何日志。
 */
function requestFeishuConfig(
  method: 'GET' | 'POST' | 'DELETE',
  body?: FeishuConfigSaveRequest,
): Promise<{ ok: boolean; data: FeishuConfigPublic | null; error: string | null } | null> {
  const ep = endpoint;
  if (!ep) return Promise.resolve(null);
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: ep.host,
        port: ep.port,
        path: '/feishu/config',
        method,
        timeout: FEISHU_OP_TIMEOUT_MS,
        ...(payload !== undefined
          ? {
              headers: {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload),
              },
            }
          : {}),
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          text += chunk;
        });
        res.on('end', () => {
          try {
            resolve(
              JSON.parse(text) as {
                ok: boolean;
                data: FeishuConfigPublic | null;
                error: string | null;
              },
            );
          } catch {
            resolve(null);
          }
        });
        res.on('error', () => resolve(null));
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
    req.end(payload);
  });
}

/** 查询当前 server 的 /health（信封 {ok,data,error}），失败/未就绪返回 null。 */
function fetchServerHealth(): Promise<HealthInfo | null> {
  const ep = endpoint;
  if (!ep) return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = http.get(
      {
        host: ep.host,
        port: ep.port,
        path: '/health',
        timeout: FEISHU_HEALTH_TIMEOUT_MS,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body) as {
              ok?: boolean;
              data?: HealthInfo | null;
            };
            resolve(parsed.ok && parsed.data ? parsed.data : null);
          } catch {
            resolve(null);
          }
        });
        res.on('error', () => resolve(null));
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
  });
}

/** 把 /health 的飞书守护状态渲染成给用户看的一句人话（状态必须诚实）。 */
function renderFeishuStatusText(feishu: any): string {
  const st = (feishu as any).status || feishu;
  if (!feishu.enabled || !st) {
    return (
      '本地 server 未启用飞书网关（未检测到飞书凭证）。\n' +
      '到「设置与诊断 → 飞书接入」填写 App ID / App Secret 即可启用。'
    );
  }
  if (!st.configured) {
    return '飞书凭证缺失或损坏（~/.otto-user/feishu-credentials.json），网关未启动。';
  }
  if (st.connected) {
    return '飞书已连接（WS 长连接就绪，断线自动重连守护中）。';
  }
  if (st.lockHeldByOtherPid != null) {
    return (
      `飞书连接被另一进程持有（pid ${st.lockHeldByOtherPid}，可能是 otto feishu daemon）。\n` +
      '本进程未连接（避免同一消息被处理两遍），对方退出后将自动接管。'
    );
  }
  if (st.reconnecting) {
    const eta = st.nextRetryAt
      ? Math.max(0, Math.round((st.nextRetryAt - Date.now()) / 1000))
      : null;
    return (
      `飞书重连中（第 ${st.reconnectAttempts} 次${eta !== null ? `，约 ${eta}s 后重试` : ''}）` +
      `${st.lastDisconnectReason ? `：${st.lastDisconnectReason}` : ''}。`
    );
  }
  if (!st.running) {
    return '飞书守护未在运行。';
  }
  return `飞书离线${st.lastDisconnectReason ? `：${st.lastDisconnectReason}` : ''}。`;
}

// ────────────────────────────────────────────────────────────────────────
// 窗口
// ────────────────────────────────────────────────────────────────────────

/**
 * 加载窗口图标占位：dist/renderer/icon.png 存在则用，否则返回空 image
 * （Electron 在无图标时回退默认，不报错）。真正的品牌图标由 #8 打包时补。
 */
/** 主题选择的持久化文件（userData/theme.json）。 */
function themeFilePath(): string {
  return path.join(app.getPath('userData'), 'theme.json');
}

/** 读上次保存的主题选择；无文件/内容非法 → 'system'。 */
function loadSavedThemeSource(): 'system' | 'light' | 'dark' {
  try {
    const raw = JSON.parse(fs.readFileSync(themeFilePath(), 'utf8')) as {
      themeSource?: unknown;
    };
    if (raw.themeSource === 'light' || raw.themeSource === 'dark') return raw.themeSource;
  } catch {
    /* 首次启动无文件，走默认 */
  }
  return 'system';
}

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
    // 初始底色跟随系统深浅：暗色 #181818 / 浅色 #ffffff。硬编码任一固定色会在
    // 系统主题与之相反时于内容就绪前（及窗口边缘）闪出错误底色。themeSource 已
    // 在 whenReady 里设为 'system'，故 shouldUseDarkColors 反映的即 OS 当前主题。
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#181818' : '#ffffff',
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
    const host = endpoint?.host ?? CSP_FALLBACK_HOST;
    const port = endpoint?.port ?? CSP_FALLBACK_PORT;
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

  // 仅放行本地 renderer 的音频录制；摄像头/地理位置等继续拒绝。
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb, details) => {
    const trusted = wc === mainWindow?.webContents;
    const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : [];
    const wantsAudio = perm === 'media' && mediaTypes?.includes('audio');
    const wantsVideo = perm === 'media' && mediaTypes?.includes('video');
    cb(Boolean(trusted && wantsAudio && !wantsVideo));
  });
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
  ipcMain.handle(IPC.voiceGetConfig, () => loadVoiceConfig().public);
  ipcMain.handle(IPC.voiceSaveConfig, (_e, body: VoiceConfigInput) => saveVoiceConfig(body));
  ipcMain.handle(IPC.voiceTranscribe, async (_e, bytes: unknown, mimeType: unknown) => {
    if (!(bytes instanceof Uint8Array) || typeof mimeType !== 'string') {
      throw new Error('语音数据格式不合法');
    }
    return transcribeAudio(bytes, mimeType, loadVoiceConfig());
  });
  // renderer 经 preload 拉当前端点（连接前 / 重连时）。
  ipcMain.handle(IPC.getEndpoint, () => endpoint ?? null);

  // host-only 命令（替代 webview 的 vscode host 命令；交付文档 [WEBVIEW] §5）。
  ipcMain.handle(IPC.openExternal, (_e, url: unknown) => {
    if (typeof url === 'string' && isExternalUrl(url)) {
      return shell.openExternal(url);
    }
    return Promise.resolve();
  });
  // 飞书状态：真查当前 server 的 /health 并透传守护详情（见文件上方说明）。
  // 状态诚实：server 未就绪 / 查询失败一律如实报告，绝不假报「已连接/运行中」。
  ipcMain.handle(IPC.feishuStatus, async () => {
    const health = await fetchServerHealth();
    if (!health) {
      return {
        text: '本地 server 未就绪，暂时无法查询飞书状态。',
        running: false,
      };
    }
    return {
      text: renderFeishuStatusText(health.feishu),
      // running = server 启用了飞书且守护在跑（≠已连接；连接态看 feishu.connected）。
      running: health.feishu.enabled && (health.feishu.status?.running ?? false),
      feishu: health.feishu,
    };
  });
  // 启停：真调 server 运行期端点 POST /feishu/start | /feishu/stop，
  // 透传真实结果（失败原样报错，不谎报动作已执行），并附最新守护状态。
  ipcMain.handle(IPC.feishuStart, async () => {
    const r = await postServerEndpoint('/feishu/start');
    if (!r) {
      return { text: '本地 server 未就绪，无法启动飞书守护，请稍后重试。' };
    }
    if (!r.ok) {
      // server 诚实报错（典型：凭证未配置），原样透传。
      return { text: `飞书守护启动失败：${r.error ?? '未知原因'}` };
    }
    const health = await fetchServerHealth();
    return {
      text:
        '飞书守护已启动（断线自动重连，连上一次后绝不永久断开）。\n' +
        (health ? renderFeishuStatusText(health.feishu) : ''),
    };
  });
  ipcMain.handle(IPC.feishuStop, async () => {
    const r = await postServerEndpoint('/feishu/stop');
    if (!r) {
      return { text: '本地 server 未就绪，无法执行停止操作。' };
    }
    if (!r.ok) {
      return { text: `飞书守护停止失败：${r.error ?? '未知原因'}` };
    }
    return {
      text:
        '飞书守护已停止（有意停止：不会自动重连，再次启动即恢复守护）。\n' +
        '注：若另有 CLI 守护进程（otto feishu daemon）在跑，请在终端单独停止。',
    };
  });
  // 飞书凭证配置（「飞书接入」面板）：转发 server /feishu/config。
  // GET 返回的本来就是脱敏视图（appSecret 只进不出，见 server 端约定）。
  ipcMain.handle(IPC.feishuGetConfig, async () => {
    const r = await requestFeishuConfig('GET');
    if (!r) return { ok: false, config: null, error: '本地 server 未就绪。' };
    return { ok: r.ok, config: r.data, error: r.error };
  });
  ipcMain.handle(IPC.feishuSaveConfig, async (_e, body: unknown) => {
    // 形状粗校验后转发；细校验（appId/domain/secret 规则）由 server 端负责。
    if (typeof body !== 'object' || body === null) {
      return { ok: false, config: null, error: '配置格式不合法。' };
    }
    const r = await requestFeishuConfig('POST', body as FeishuConfigSaveRequest);
    if (!r) return { ok: false, config: null, error: '本地 server 未就绪，凭证未保存。' };
    return { ok: r.ok, config: r.data, error: r.error };
  });
  ipcMain.handle(IPC.feishuClearConfig, async () => {
    const r = await requestFeishuConfig('DELETE');
    if (!r) return { ok: false, config: null, error: '本地 server 未就绪。' };
    return { ok: r.ok, config: r.data, error: r.error };
  });
  // 园区服务定制（不同企业不同品牌名/服务清单）：读 ~/.otto-user/park-services.json。
  // 文件不存在/解析失败 → null，renderer 用内置默认（宏创AI园区服务）。
  // ── 外观主题（跟随系统/浅色/深色）：nativeTheme.themeSource + userData 持久化 ──
  ipcMain.handle(IPC.themeGet, () => nativeTheme.themeSource);
  ipcMain.handle(IPC.themeSet, (_e, v: unknown) => {
    if (v !== 'system' && v !== 'light' && v !== 'dark') return nativeTheme.themeSource;
    nativeTheme.themeSource = v;
    try {
      fs.writeFileSync(themeFilePath(), JSON.stringify({ themeSource: v }), 'utf8');
    } catch {
      /* 写盘失败只影响下次启动的记忆，本次已生效 */
    }
    return nativeTheme.themeSource;
  });

  // ── krx 的企业面板 IPC（排行榜/工作日志/Skill 共享与市场）──
  // 这批 handler 在 a01198db 的 merge 解冲突时被误删（renderer 调用还在、
  // 通路没了，面板按钮全哑）。从 8a22244e 原样移植回来，仅做类型化（去 any）。
  ipcMain.handle(IPC.skillLeaderboard, async (_e, teamId?: string) => {
    const emptyTabs = [
      { id: 'leaderboard', label: '排行榜', icon: '' },
      { id: 'stars', label: '明星榜', icon: '' },
    ];
    try {
      const sharesPath = path.join(process.cwd(), '.otto', 'org', 'skill-shares.json');
      let shares: SkillShareRecord[] = [];
      try {
        shares = JSON.parse(await fs.promises.readFile(sharesPath, 'utf-8')) as SkillShareRecord[];
      } catch {
        /* 文件不存在，返回空 */
      }

      const activeShares = shares.filter(
        (s) => (!teamId || s.teamId === teamId) && s.status === 'active',
      );
      const teamName = activeShares[0]?.teamName || '本小组';

      const medals = ['1.', '2.', '3.'];
      const maxInstalls = Math.max(...activeShares.map((s) => s.installCount || 0), 1);
      const maxUsage = Math.max(...activeShares.map((s) => s.usageCount || 0), 1);

      const lbLines: string[] = [`${teamName} Skill 排行榜`, ''];
      const scored = activeShares
        .map((s) => {
          const ratingScore = ((s.rating || 0) / 5) * 100;
          const installScore = ((s.installCount || 0) / maxInstalls) * 100;
          const successRate =
            (s.usageCount || 0) > 0 ? ((s.successCount || 0) / (s.usageCount || 1)) * 100 : 50;
          const usageScore = ((s.usageCount || 0) / maxUsage) * 100;
          return {
            s,
            score: ratingScore * 0.35 + installScore * 0.25 + successRate * 0.25 + usageScore * 0.15,
          };
        })
        .sort((a, b) => b.score - a.score);

      scored.forEach((item, i) => {
        const rank = i < 3 ? medals[i] : `${i + 1}.`;
        const rating = item.s.rating ? `${item.s.rating.toFixed(1)}/5` : '暂无';
        lbLines.push(`${rank} ${item.s.skillName} (v${item.s.version || 1})`);
        lbLines.push(`   ${item.s.featureDescription || ''}`);
        lbLines.push(
          `   ${item.s.sharedByName} | ${rating} (${item.s.ratingCount || 0}人) | 装${item.s.installCount || 0} | 用${item.s.usageCount || 0} | ${item.score.toFixed(0)}分`,
        );
        lbLines.push('');
      });

      const contributorMap: Record<
        string,
        { name?: string; count: number; installs: number; skills: Array<string | undefined> }
      > = {};
      for (const s of activeShares) {
        const key = s.sharedBy || 'unknown';
        if (!contributorMap[key]) {
          contributorMap[key] = { name: s.sharedByName, count: 0, installs: 0, skills: [] };
        }
        contributorMap[key].count++;
        contributorMap[key].installs += s.installCount || 0;
        contributorMap[key].skills.push(s.skillName);
      }
      const sbLines: string[] = [`${teamName} 贡献明星榜`, ''];
      Object.values(contributorMap)
        .sort((a, b) => b.installs - a.installs)
        .forEach((c, i) => {
          const rank = i < 3 ? medals[i] : `${i + 1}.`;
          sbLines.push(`${rank} ${c.name}`);
          sbLines.push(`   分享${c.count}个 | 安装${c.installs}次 | ${c.skills.join('、')}`);
          sbLines.push('');
        });

      return { leaderboard: lbLines.join('\n'), starBoard: sbLines.join('\n'), tabs: emptyTabs };
    } catch {
      return { leaderboard: '暂无排行榜数据', starBoard: '暂无明星榜数据', tabs: emptyTabs };
    }
  });

  // 工作日志：读取本地日历的今天，展示业务成果 + 支撑操作。
  ipcMain.handle(IPC.workLogToday, async () => {
    const worklogRoot = worklogRootDir();
    const today = localDateKey(new Date());
    const entries = await readWorkLogEntries(worklogRoot, today);
    return summarizeWorkLog(today, entries);
  });

  // 工作日志·近 N 天逐日明细（日历视图数据源：hover 某天列出当天条目）。
  ipcMain.handle(IPC.workLogRecent, async (_e, days?: number) => {
    const worklogRoot = worklogRootDir();
    return readRecentWorkLogs(worklogRoot, days, new Date());
  });

  // 一键生成真正的 Markdown 工作报告并保存到 summaries，返回完整路径供界面打开。
  ipcMain.handle(IPC.workLogReport, async () => {
    const worklogRoot = worklogRootDir();
    return generateAndSaveWorkReport(worklogRoot, localDateKey(new Date()));
  });

  // 部门共享 Skill 列表
  ipcMain.handle(IPC.skillShareList, async (_e, teamId?: string) => {
    try {
      const sharesPath = path.join(process.cwd(), '.otto', 'org', 'skill-shares.json');
      let shares: SkillShareRecord[] = [];
      try {
        shares = JSON.parse(await fs.promises.readFile(sharesPath, 'utf-8')) as SkillShareRecord[];
      } catch {
        /* 无文件 */
      }

      const active = shares.filter((s) => s.status === 'active' && (!teamId || s.teamId === teamId));

      if (active.length === 0) {
        return { text: '本部门暂无共享 Skill。' };
      }

      const lines: string[] = ['部门共享 Skill 列表', ''];
      for (const s of active) {
        const rating = s.rating ? `${s.rating.toFixed(1)}/5` : '暂无';
        lines.push(`${s.skillName} (v${s.version || 1})`);
        lines.push(`  功能：${s.featureDescription || '暂无描述'}`);
        lines.push(`  分享者：${s.sharedByName}`);
        lines.push(
          `  评分：${rating} (${s.ratingCount || 0}人) | 安装：${s.installCount || 0}次 | 使用：${s.usageCount || 0}次`,
        );
        if (s.note) lines.push(`  备注：${s.note}`);
        lines.push('');
      }
      return { text: lines.join('\n') };
    } catch {
      return { text: '读取 Skill 列表失败。' };
    }
  });

  // 公司 Skill 市场
  ipcMain.handle(IPC.skillMarketplace, async () => {
    try {
      const sharesPath = path.join(process.cwd(), '.otto', 'org', 'skill-shares.json');
      let shares: SkillShareRecord[] = [];
      try {
        shares = JSON.parse(await fs.promises.readFile(sharesPath, 'utf-8')) as SkillShareRecord[];
      } catch {
        /* 无文件 */
      }

      const market = shares.filter((s) => s.publishedToMarketplace === true && s.status === 'active');

      if (market.length === 0) {
        return {
          text: '公司 Skill 市场暂无已发布的 Skill。\n\n部门共享的 Skill 需要分享者「发布到市场」后才会在此显示。',
        };
      }

      market.sort((a, b) => (b.rating || 0) - (a.rating || 0));

      const lines: string[] = ['公司 Skill 市场', ''];
      for (const s of market) {
        const rating = s.rating ? `${s.rating.toFixed(1)}/5` : '暂无';
        lines.push(`${s.skillName} (v${s.version || 1})`);
        lines.push(`  功能：${s.featureDescription || '暂无描述'}`);
        lines.push(`  分享者：${s.sharedByName} (${s.teamName})`);
        lines.push(
          `  评分：${rating} (${s.ratingCount || 0}人) | 安装：${s.installCount || 0}次 | 使用：${s.usageCount || 0}次`,
        );
        lines.push('');
      }
      return { text: lines.join('\n') };
    } catch {
      return { text: '读取 Skill 市场失败。' };
    }
  });

  ipcMain.handle(IPC.parkConfig, async () => {
    try {
      const p = path.join(os.homedir(), '.otto-user', 'park-services.json');
      const raw = await fs.promises.readFile(p, 'utf8');
      const cfg = JSON.parse(raw) as Record<string, unknown>;
      if (typeof cfg !== 'object' || cfg === null) return null;
      // 宽松形状校验：只透传认识的字段，坏字段丢弃不炸。
      const services = Array.isArray(cfg.services)
        ? cfg.services
            .filter(
              (s): s is Record<string, unknown> =>
                typeof s === 'object' && s !== null,
            )
            .map((s) => ({
              name: typeof s.name === 'string' ? s.name : '',
              desc: typeof s.desc === 'string' ? s.desc : '',
              prompt: typeof s.prompt === 'string' ? s.prompt : '',
            }))
            .filter((s) => s.name && s.prompt)
        : undefined;
      return {
        brandName: typeof cfg.brandName === 'string' ? cfg.brandName : undefined,
        parkName: typeof cfg.parkName === 'string' ? cfg.parkName : undefined,
        ...(services && services.length > 0 ? { services } : {}),
      };
    } catch {
      return null;
    }
  });

  // 本地测试模式：应用/清除 customProxyServerUrl。
  // renderer 通过 preload.setLocalTestUrl() 调用。
  // 实现方式：将 OTTO_SERVER_URL env 设为指定地址，待下次会话创建时 proxyConfig
  // 会读到该改变的环境变量，从而路由请求到本地。
  ipcMain.handle(IPC.setLocalTestUrl, (_e, url: unknown) => {
    if (typeof url !== 'string') return Promise.resolve();
    const trimmed = url.trim();
    if (trimmed) {
      // 应用本地测试地址（真实状态只存 env，不留影子变量）
      process.env.OTTO_SERVER_URL = trimmed;
      console.log(`[otto-desktop] 本地测试模式已应用： OTTO_SERVER_URL=${trimmed}`);
    } else {
      // 清除本地测试
      delete process.env.OTTO_SERVER_URL;
      console.log('[otto-desktop] 本地测试模式已清除， OTTO_SERVER_URL 已移除。');
    }
    return Promise.resolve();
  });

  // ── 软件更新：检查 / 下载 / 取消 / 安装 + 版本查询（逻辑在 update-service.ts）──
  // 结果全部结构化透传，不在这里加工：「检查失败」与「已是最新」是 UpdateService
  // 返回的两种不同 status，任何一层都不许把失败粉饰成最新。
  ipcMain.handle(IPC.appVersion, () => app.getVersion());
  ipcMain.handle(IPC.updateCheck, () => updateService.checkForUpdate());
  ipcMain.handle(IPC.updateDownload, () => updateService.downloadUpdate());
  ipcMain.handle(IPC.updateCancel, () => {
    updateService.cancelDownload();
  });
  ipcMain.handle(IPC.updateInstall, () => updateService.installUpdate());

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

  // 导出会话（对齐 CLI /export）：原生保存对话框 + 写文件。取消返回 null，
  // 写入失败抛错由 renderer 侧捕获展示；内容/文件名均来自 server 的 export_result 帧。
  ipcMain.handle(
    IPC.saveTextFile,
    async (_e, suggestedFileName: unknown, content: unknown) => {
      if (typeof suggestedFileName !== 'string' || typeof content !== 'string') {
        return null;
      }
      const win = mainWindow;
      const result = win
        ? await dialog.showSaveDialog(win, {
            defaultPath: path.join(app.getPath('documents'), suggestedFileName),
            filters: [{ name: 'Markdown', extensions: ['md'] }],
          })
        : await dialog.showSaveDialog({
            defaultPath: path.join(app.getPath('documents'), suggestedFileName),
            filters: [{ name: 'Markdown', extensions: ['md'] }],
          });
      if (result.canceled || !result.filePath) return null;
      await fs.promises.writeFile(result.filePath, content, 'utf-8');
      return result.filePath;
    },
  );
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
    // 外观主题：默认跟随系统（'system' 让 renderer 的 prefers-color-scheme 生效）；
    // 用户在偏好里手动选过浅色/深色则恢复上次选择（userData/theme.json）。
    nativeTheme.themeSource = loadSavedThemeSource();

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
    // 退出前中止未完成的更新下载（审查 M2）：abort 触发下载循环的 AbortError
    // 清理路径，best-effort 删掉 Downloads 里的 .part 临时文件。幂等，无任务时空操作。
    // 即使进程赶在异步清理完成前退出，下次下载同一资产会截断重写同名 .part，
    // 且 sha256 校验兜底完整性，残留无危害。
    updateService.cancelDownload();
    // 仅内嵌 server 随 app 退出而停；discovered（headless/CLI 已在跑）故意留活。
    void serverManager.shutdown();
  });
}
