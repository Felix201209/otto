/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Preload（CJS, contextIsolation 下的安全桥）。
 *
 * 暴露 `window.otto`：renderer 经它收发 server 帧 + 调 host-only 命令。
 * 这是替代 webview `acquireVsCodeApi()` / `window.vscode.postMessage` 的落点
 * （交付文档 [WEBVIEW] §5「必须替换」第 1、3 条）。
 *
 * 设计：preload 自己持有 WS 连接（renderer sandbox 不直接开 socket），
 * 把 ServerToClient 帧经回调转发给 renderer，把 ClientToServer 帧经 send() 发出。
 * renderer 侧只需把 `multiSessionMessageService` 的传输底换成 `window.otto`，
 * 保持 `{ type, payload }` 信封不变即可零改组件。
 *
 * 健壮性（Issue #4 收尾）：
 *   - 连接前 send() 进入队列，连上后 flush（renderer 不必等握手）。
 *   - 断线后指数退避自动重连；端点变更（main 推送）触发重连到新端点。
 *   - 连接状态变化经 onConnectionChange 通知 renderer 做 UI 指示。
 */

import { contextBridge, ipcRenderer } from 'electron';
import type {
  ClientToServer,
  FeishuConfigPublic,
  FeishuConfigSaveRequest,
  HealthInfo,
  ServerEndpoint,
  ServerToClient,
} from 'otto-server';

/**
 * 飞书守护状态（main 从 server /health 透传；renderer 徽标据此渲染）。
 * 即 HealthInfo 里的 feishu 字段：enabled/connected + 守护详情 status。
 */
export type FeishuStatusDetail = HealthInfo['feishu'];

/** 飞书凭证配置操作的统一返回：config 为脱敏视图（绝无 appSecret）。 */
export interface FeishuConfigResult {
  ok: boolean;
  config: FeishuConfigPublic | null;
  error: string | null;
}
export type { FeishuConfigPublic, FeishuConfigSaveRequest };

// ── 软件更新的跨进程形状 ──
// 与 src/main/update-core.ts / update-service.ts 里的定义结构一致的副本。
// main 的 tsconfig rootDir 限制两边不能互相 import（同 IPC 常量表的既有做法：
// 两处各持一份、改动时同步）；renderer 一律从本文件 import type。

/** 单个平台的安装包资产（latest.json 的 assets[platformKey]）。 */
export interface UpdateAssetInfo {
  name: string;
  url: string;
  size: number;
  /** 64 位十六进制；下载后 main 强制校验，不匹配删文件报错。 */
  sha256: string;
}

/** 检查更新三态：有新版 / 已是最新 / 检查失败——失败绝不冒充最新。 */
export type UpdateCheckResult =
  | {
      status: 'update-available';
      currentVersion: string;
      version: string;
      notes: string;
      publishedAt: string | null;
      /** 本平台资产；清单没有本平台包（或兜底源拿不到 sha256）时为 null。 */
      asset: UpdateAssetInfo | null;
      /** 资产缺失时引导用户浏览器手动下载的发布页。 */
      releasePageUrl: string;
    }
  | { status: 'up-to-date'; currentVersion: string; latestVersion: string | null }
  | { status: 'check-failed'; currentVersion: string; message: string };

/** 下载进度（main 经 IPC.updateProgress 节流推送）。 */
export interface UpdateProgressInfo {
  percent: number;
  transferred: number;
  total: number;
}

/** 下载结果（结构化；reused=同名文件 sha256 已匹配、直接复用跳过下载）。 */
export type UpdateDownloadResult =
  | { ok: true; filePath: string; reused: boolean }
  | { ok: false; cancelled?: boolean; error: string };

/** 安装结果（message 为按平台给的下一步指引，如「装完请重启 Otto」）。 */
export interface UpdateInstallResult {
  ok: boolean;
  message: string;
}

// ── IPC channel 名（与 main 对齐）──
const IPC = {
  getEndpoint: 'otto:get-endpoint',
  endpointChanged: 'otto:endpoint-changed',
  openExternal: 'otto:open-external',
  openPath: 'otto:open-path',
  saveTextFile: 'otto:save-text-file',
  menu: 'otto:menu',
  setLocalTestUrl: 'otto:set-local-test-url',
  appVersion: 'otto:app-version',
  updateCheck: 'otto:update-check',
  updateDownload: 'otto:update-download',
  updateCancel: 'otto:update-cancel',
  updateInstall: 'otto:update-install',
  updateProgress: 'otto:update-progress',
} as const;

/** renderer 注册的入站帧回调。 */
type FrameHandler = (frame: ServerToClient) => void;
/** 连接状态变化回调。 */
type ConnectionHandler = (connected: boolean) => void;
/** 应用菜单动作回调（'new-chat' | 'open-settings'）。 */
type MenuHandler = (action: string) => void;

/** preload 暴露给 renderer 的 API 形状（renderer 据此声明 window.otto 类型）。 */
export interface OttoBridge {
  /** 连接到本地 server（解析端点后建 WS）。返回是否连上。 */
  connect(): Promise<boolean>;
  /** 主动断开（不自动重连，直到下次 connect()）。 */
  disconnect(): void;
  /** 发一帧到 server。未连接时入队，连上后按序 flush。 */
  send(frame: ClientToServer): void;
  /** 订阅 server 入站帧，返回取消函数。 */
  onFrame(handler: FrameHandler): () => void;
  /** 订阅连接状态变化，返回取消函数。立即以当前状态回调一次。 */
  onConnectionChange(handler: ConnectionHandler): () => void;
  /** 连接状态。 */
  isConnected(): boolean;
  /**
   * 订阅应用菜单动作（main 经 IPC.menu 下发）：'new-chat' | 'open-settings'。
   * 返回取消订阅函数。
   */
  onMenu(handler: MenuHandler): () => void;
  /** host-only 命令：用系统浏览器打开外链。 */
  openExternal(url: string): Promise<void>;
  /** host-only 命令：用系统默认程序打开本地路径。 */
  openPath(path: string): Promise<void>;
  /**
   * host-only 命令：原生保存对话框 + 写文本文件（导出会话用）。
   * 返回实际写入路径；用户取消对话框时返回 null。
   */
  saveTextFile(suggestedFileName: string, content: string): Promise<string | null>;
  feishuStart(): Promise<{ text: string; pid?: number }>;
  feishuStop(): Promise<{ text: string }>;
  /**
   * 飞书守护状态查询（main 真查 server /health）。
   * text 为人话说明；running=守护是否在跑；feishu 为结构化守护详情
   * （connected / 重连第 N 次 / 下次重试时间 / 锁冲突持有者 pid），
   * server 未就绪时缺省。
   */
  feishuStatus(): Promise<{
    text: string;
    running: boolean;
    feishu?: FeishuStatusDetail;
  }>;
  /**
   * 飞书凭证配置（「飞书接入」面板）。config 是脱敏视图：
   * 只有 appId / domain / 授权人等元信息，appSecret 永不回传。
   */
  feishuGetConfig(): Promise<FeishuConfigResult>;
  /** 保存凭证并让守护立即用上（server 侧 stop→start 重读凭证）。 */
  feishuSaveConfig(body: FeishuConfigSaveRequest): Promise<FeishuConfigResult>;
  /** 停守护 + 清除凭证（对应 CLI /feishu logout）。 */
  feishuClearConfig(): Promise<FeishuConfigResult>;
  /**
   * 本地测试模式：把 customProxyServerUrl 设为指定地址（不空）或清除（空字符串）。
   * main 进程需要把该 URL 注入到 server manager（如设置 OTTO_SERVER_URL env）。
   * 返回是否应用成功。
   */
  setLocalTestUrl?(url: string): Promise<void>;
  /** 当前 app 版本号（main 的 app.getVersion()）。 */
  appVersion(): Promise<string>;
  /**
   * 检查软件更新（main 拉 latest.json，兜底 GitHub API）。
   * 三态结果：有新版 / 已是最新 / 检查失败——失败绝不冒充最新。
   */
  updateCheck(): Promise<UpdateCheckResult>;
  /**
   * 下载最近一次检查到的新版安装包（main 只信自己缓存的检查结果，
   * renderer 不传 URL）。下载完成 main 已做 sha256 校验，失败会删文件报错。
   */
  updateDownload(): Promise<UpdateDownloadResult>;
  /** 取消进行中的下载（无任务时安全空操作）。 */
  updateCancel(): Promise<void>;
  /** 打开已校验的安装包（win 拉起 NSIS / mac 打开 dmg），message 给下一步指引。 */
  updateInstall(): Promise<UpdateInstallResult>;
  /** 订阅下载进度（main 节流推送），返回取消订阅函数。 */
  onUpdateProgress(handler: (progress: UpdateProgressInfo) => void): () => void;
}

// ── 退避参数 ──
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;

let ws: WebSocket | undefined;
let currentEndpoint: ServerEndpoint | null = null;
/** 是否处于「期望连接」状态：true 时断线自动重连；disconnect() 置 false。 */
let wantConnected = false;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

const frameHandlers = new Set<FrameHandler>();
const connectionHandlers = new Set<ConnectionHandler>();
/** 连接前积压的出站帧，连上后按序 flush。 */
const sendQueue: ClientToServer[] = [];

function notifyConnection(connected: boolean): void {
  for (const h of connectionHandlers) {
    try {
      h(connected);
    } catch {
      // 单个 handler 抛错不影响其余。
    }
  }
}

function dispatchFrame(frame: ServerToClient): void {
  for (const h of frameHandlers) {
    try {
      h(frame);
    } catch {
      // 单个 handler 抛错不影响其余。
    }
  }
}

async function getEndpoint(): Promise<ServerEndpoint | null> {
  return (await ipcRenderer.invoke(IPC.getEndpoint)) as ServerEndpoint | null;
}

/** flush 连接前积压的帧。 */
function flushQueue(): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  while (sendQueue.length > 0) {
    const frame = sendQueue.shift()!;
    ws.send(JSON.stringify(frame));
  }
}

/** 安排一次退避重连（仅在 wantConnected 时）。 */
function scheduleReconnect(): void {
  if (!wantConnected || reconnectTimer) return;
  const wait = Math.min(
    RECONNECT_BASE_MS * 2 ** reconnectAttempt,
    RECONNECT_MAX_MS,
  );
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    void openSocket();
  }, wait);
}

/** 实际建立 WS 连接（解析端点 → new WebSocket → 绑事件）。 */
function openSocket(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    void (async () => {
      const ep = currentEndpoint ?? (await getEndpoint());
      currentEndpoint = ep;
      if (!ep) {
        // 没端点，安排重试（端点变更会即时触发，不必密集轮询）。
        scheduleReconnect();
        resolve(false);
        return;
      }
      try {
        const socket = new WebSocket(`ws://${ep.host}:${ep.port}/ws`);
        ws = socket;

        socket.addEventListener('open', () => {
          reconnectAttempt = 0;
          // 握手帧（welcome 由 server 回）。
          socket.send(
            JSON.stringify({
              type: 'hello',
              payload: {
                protocolVersion: ep.protocolVersion,
                clientKind: 'desktop',
              },
            } satisfies ClientToServer),
          );
          flushQueue();
          notifyConnection(true);
          resolve(true);
        });

        socket.addEventListener('message', (e: MessageEvent) => {
          let frame: ServerToClient;
          try {
            frame = JSON.parse(String(e.data)) as ServerToClient;
          } catch {
            return;
          }
          dispatchFrame(frame);
        });

        socket.addEventListener('close', () => {
          if (ws === socket) ws = undefined;
          notifyConnection(false);
          scheduleReconnect();
        });

        socket.addEventListener('error', () => {
          // error 后通常紧跟 close；resolve(false) 表示本次未连上。
          resolve(false);
        });
      } catch {
        scheduleReconnect();
        resolve(false);
      }
    })();
  });
}

const bridge: OttoBridge = {
  async connect(): Promise<boolean> {
    wantConnected = true;
    if (ws && ws.readyState === WebSocket.OPEN) return true;
    return openSocket();
  },

  disconnect(): void {
    wantConnected = false;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    if (ws) {
      try {
        ws.close();
      } catch {
        // 忽略关闭异常。
      }
      ws = undefined;
    }
    notifyConnection(false);
  },

  send(frame: ClientToServer): void {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(frame));
    } else {
      // 连接前（或重连中）排队，open 后 flush —— 对齐 webview
      // multiSessionMessageService 的 ready 前排队行为。
      sendQueue.push(frame);
    }
  },

  onFrame(handler: FrameHandler): () => void {
    frameHandlers.add(handler);
    return () => frameHandlers.delete(handler);
  },

  onConnectionChange(handler: ConnectionHandler): () => void {
    connectionHandlers.add(handler);
    // 立即以当前状态回调一次，便于 UI 初始化。
    try {
      handler(bridge.isConnected());
    } catch {
      // 忽略初始回调异常。
    }
    return () => connectionHandlers.delete(handler);
  },

  isConnected(): boolean {
    return !!ws && ws.readyState === WebSocket.OPEN;
  },

  onMenu(handler: MenuHandler): () => void {
    // 仿 endpointChanged 订阅：_e 由 Electron 推断（IpcRendererEvent），action 显式为 string。
    const listener = (_e: Electron.IpcRendererEvent, action: string): void =>
      handler(action);
    ipcRenderer.on(IPC.menu, listener);
    return () => {
      ipcRenderer.removeListener(IPC.menu, listener);
    };
  },

  openExternal(url: string): Promise<void> {
    return ipcRenderer.invoke(IPC.openExternal, url) as Promise<void>;
  },

  openPath(path: string): Promise<void> {
    return ipcRenderer.invoke(IPC.openPath, path) as Promise<void>;
  },

  saveTextFile(suggestedFileName: string, content: string): Promise<string | null> {
    return ipcRenderer.invoke(
      IPC.saveTextFile,
      suggestedFileName,
      content,
    ) as Promise<string | null>;
  },
  feishuStart(): Promise<{ text: string; pid?: number }> {
    return ipcRenderer.invoke('otto:feishu-start') as Promise<{ text: string; pid?: number }>;
  },
  feishuStop(): Promise<{ text: string }> {
    return ipcRenderer.invoke('otto:feishu-stop') as Promise<{ text: string }>;
  },
  feishuStatus(): Promise<{
    text: string;
    running: boolean;
    feishu?: FeishuStatusDetail;
  }> {
    return ipcRenderer.invoke('otto:feishu-status') as Promise<{
      text: string;
      running: boolean;
      feishu?: FeishuStatusDetail;
    }>;
  },
  feishuGetConfig(): Promise<FeishuConfigResult> {
    return ipcRenderer.invoke('otto:feishu-get-config') as Promise<FeishuConfigResult>;
  },
  feishuSaveConfig(body: FeishuConfigSaveRequest): Promise<FeishuConfigResult> {
    return ipcRenderer.invoke('otto:feishu-save-config', body) as Promise<FeishuConfigResult>;
  },
  feishuClearConfig(): Promise<FeishuConfigResult> {
    return ipcRenderer.invoke('otto:feishu-clear-config') as Promise<FeishuConfigResult>;
  },
  setLocalTestUrl(url: string): Promise<void> {
    return ipcRenderer.invoke(IPC.setLocalTestUrl, url) as Promise<void>;
  },
  appVersion(): Promise<string> {
    return ipcRenderer.invoke(IPC.appVersion) as Promise<string>;
  },
  updateCheck(): Promise<UpdateCheckResult> {
    return ipcRenderer.invoke(IPC.updateCheck) as Promise<UpdateCheckResult>;
  },
  updateDownload(): Promise<UpdateDownloadResult> {
    return ipcRenderer.invoke(IPC.updateDownload) as Promise<UpdateDownloadResult>;
  },
  updateCancel(): Promise<void> {
    return ipcRenderer.invoke(IPC.updateCancel) as Promise<void>;
  },
  updateInstall(): Promise<UpdateInstallResult> {
    return ipcRenderer.invoke(IPC.updateInstall) as Promise<UpdateInstallResult>;
  },
  onUpdateProgress(handler: (progress: UpdateProgressInfo) => void): () => void {
    // 仿 onMenu 订阅：进度帧由 main 的 UpdateService 节流推送。
    const listener = (
      _e: Electron.IpcRendererEvent,
      progress: UpdateProgressInfo,
    ): void => handler(progress);
    ipcRenderer.on(IPC.updateProgress, listener);
    return () => {
      ipcRenderer.removeListener(IPC.updateProgress, listener);
    };
  },
};

// 端点变更（main 在发现/拉起 server 后推送）：更新缓存，若期望连接则重连到新端点。
ipcRenderer.on(IPC.endpointChanged, (_e, ep: ServerEndpoint | null) => {
  const changed =
    ep?.host !== currentEndpoint?.host || ep?.port !== currentEndpoint?.port;
  currentEndpoint = ep;
  if (wantConnected && changed) {
    // 重连到新端点：关旧连接，立即重连（清退避计数）。
    reconnectAttempt = 0;
    if (ws) {
      try {
        ws.close();
      } catch {
        /* 忽略 */
      }
      ws = undefined;
    }
    void openSocket();
  }
});

contextBridge.exposeInMainWorld('otto', bridge);
