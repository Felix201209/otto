/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 浏览器端 Otto Bridge —— 替代 Electron preload，直接从浏览器连 otto-server WS。
 *
 * otto-server 已经跑在 http://127.0.0.1:7637；页面 URL 必须通过
 * `#clientToken=...` 提供端点文件里的低权限 WS 令牌。fragment 不会发给
 * preview 静态服务器或进入 referrer。本文件把受保护的 WS
 * 包成 window.otto（与 preload 暴露的 API 形状一致），让 renderer（App.tsx）
 * 不用 Electron 也能在普通浏览器里跑。
 *
 * Electron 专属功能（openExternal / saveTextFile / 飞书守护 / 更新等）全部 stub。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { serverWebSocketUrl } from '../src/preload/server-endpoint.js';

// ── preload 类型平替（不依赖 electron / otto-server 包）──────────────────
type Envelope<T extends string, P> = { type: T; payload: P };
type ClientToServer = Envelope<string, any>;
type ServerToClient = Envelope<string, any>;

type FrameHandler = (frame: ServerToClient) => void;
type ConnectionHandler = (connected: boolean) => void;
type MenuHandler = (action: string) => void;

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;

const SERVER_HOST = '127.0.0.1';
const SERVER_PORT = 7637;
const CLIENT_TOKEN = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  .get('clientToken') ?? '';

let ws: WebSocket | undefined;
let wantConnected = false;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

const frameHandlers = new Set<FrameHandler>();
const connectionHandlers = new Set<ConnectionHandler>();
const sendQueue: ClientToServer[] = [];

// 从 server /health 拿协议版本（优先） → 回退硬编码
let protocolVersion = '1';

async function fetchProtocolVersion(): Promise<string> {
  try {
    const res = await fetch(`http://${SERVER_HOST}:${SERVER_PORT}/health`);
    const json = await res.json();
    return json?.data?.protocolVersion ?? '1';
  } catch {
    return '1';
  }
}

function notifyConnection(connected: boolean): void {
  for (const h of connectionHandlers) {
    try { h(connected); } catch { /* 忽略 */ }
  }
}

function dispatchFrame(frame: ServerToClient): void {
  for (const h of frameHandlers) {
    try { h(frame); } catch { /* 忽略 */ }
  }
}

function flushQueue(): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  while (sendQueue.length > 0) {
    const frame = sendQueue.shift()!;
    ws.send(JSON.stringify(frame));
  }
}

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

function openSocket(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    void (async () => {
      try {
        const socket = new WebSocket(serverWebSocketUrl({
          host: SERVER_HOST,
          port: SERVER_PORT,
          clientToken: CLIENT_TOKEN,
        }));
        ws = socket;

        socket.addEventListener('open', () => {
          reconnectAttempt = 0;
          socket.send(JSON.stringify({
            type: 'hello',
            payload: { protocolVersion, clientKind: 'desktop' },
          }));
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
          resolve(false);
        });
      } catch {
        scheduleReconnect();
        resolve(false);
      }
    })();
  });
}

const bridge = {
  async connect(): Promise<boolean> {
    wantConnected = true;
    if (ws && ws.readyState === WebSocket.OPEN) return true;
    protocolVersion = await fetchProtocolVersion();
    return openSocket();
  },

  disconnect(): void {
    wantConnected = false;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = undefined; }
    if (ws) {
      try { ws.close(); } catch { /* ignore */ }
      ws = undefined;
    }
    notifyConnection(false);
  },

  send(frame: ClientToServer): void {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(frame));
    } else {
      sendQueue.push(frame);
    }
  },

  onFrame(handler: FrameHandler): () => void {
    frameHandlers.add(handler);
    return () => frameHandlers.delete(handler);
  },

  onConnectionChange(handler: ConnectionHandler): () => void {
    connectionHandlers.add(handler);
    try { handler(bridge.isConnected()); } catch { /* ignore */ }
    return () => connectionHandlers.delete(handler);
  },

  isConnected(): boolean {
    return !!ws && ws.readyState === WebSocket.OPEN;
  },

  // ── 以下为 Electron 专属功能 stub ──
  onMenu(_handler: MenuHandler): () => void { return () => {}; },
  openExternal(_url: string): Promise<void> { return Promise.resolve(); },
  openPath(_path: string): Promise<void> { return Promise.resolve(); },
  async writeClipboard(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback: create temporary textarea
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        return true;
      } catch {
        return false;
      }
    }
  },
  saveTextFile(): Promise<string | null> { return Promise.resolve(null); },
  feishuStart(): Promise<{ text: string; pid?: number }> { return Promise.resolve({ text: '浏览器模式不支持飞书守护' }); },
  feishuStop(): Promise<{ text: string }> { return Promise.resolve({ text: '浏览器模式不支持飞书守护' }); },
  feishuStatus(): Promise<{ text: string; running: boolean }> { return Promise.resolve({ text: '浏览器模式', running: false }); },
  feishuGetConfig(): Promise<any> { return Promise.resolve({ ok: false, config: null, error: '浏览器模式不支持' }); },
  feishuSaveConfig(): Promise<any> { return Promise.resolve({ ok: false, config: null, error: '浏览器模式不支持' }); },
  feishuClearConfig(): Promise<any> { return Promise.resolve({ ok: false, config: null, error: '浏览器模式不支持' }); },
  parkConfig(): Promise<any> { return Promise.resolve(null); },
  themeGet(): Promise<string> { return Promise.resolve('dark'); },
  themeSet(): Promise<string> { return Promise.resolve('dark'); },
  skillLeaderboard(): Promise<any> { return Promise.resolve({ leaderboard: '{}', starBoard: '{}', tabs: [] }); },
  workLogToday(): Promise<any> { return Promise.resolve({ summary: '', date: '', totalActions: 0, workResults: 0 }); },
  workLogRecent(): Promise<any> { return Promise.resolve([]); },
  workLogReport(): Promise<any> { return Promise.resolve({ ok: false, message: '浏览器模式不支持' }); },
  skillShareList(): Promise<any> { return Promise.resolve({ text: '' }); },
  skillMarketplace(): Promise<any> { return Promise.resolve({ text: '' }); },
  setLocalTestUrl(): Promise<void> { return Promise.resolve(); },
  appVersion(): Promise<string> { return Promise.resolve('1.8.8-browser'); },
  updateCheck(): Promise<any> { return Promise.resolve({ status: 'up-to-date', currentVersion: '1.8.8', latestVersion: null }); },
  updateDownload(): Promise<any> { return Promise.resolve({ ok: false, error: '浏览器模式不支持更新' }); },
  updateCancel(): Promise<void> { return Promise.resolve(); },
  updateInstall(): Promise<any> { return Promise.resolve({ ok: false, message: '浏览器模式不支持' }); },
  onUpdateProgress(): () => void { return () => {}; },
  voiceGetConfig(): Promise<any> { return Promise.resolve({ enabled: false, asrProvider: 'openai', asrEndpoint: '', asrModel: '', volcResourceId: '', polishEnabled: false, polishEndpoint: '', polishModel: '', polishPrompt: '', hasAsrApiKey: false, hasVolcCredentials: false, hasPolishApiKey: false }); },
  voiceSaveConfig(): Promise<any> { return Promise.resolve({}); },
  voiceTranscribe(): Promise<any> { return Promise.resolve({ text: '', rawText: '', polished: false }); },
  autoGeneratedAgentProfiles(): Promise<any[]> { return Promise.resolve([]); },
  // 浏览器模式保留 IPC 形状；App 的内部测试门禁不会读取这里的会话。
  enterpriseSession(): Promise<any> {
    return Promise.resolve({
      serverUrl: 'http://127.0.0.1:7637',
      account: {
        id: 'browser-dev',
        organizationId: 'local',
        organizationName: '本地开发',
        employeeId: null,
        username: 'dev',
        phone: null,
        name: '开发者',
        role: null,
        department: null,
        isAdmin: false,
        status: 'active' as const,
        tags: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    });
  },
  enterprisePasswordLogin(): Promise<any> { return Promise.resolve({ serverUrl: 'http://127.0.0.1:7637', account: { id: 'browser-dev', organizationId: 'local', organizationName: '本地开发', employeeId: null, username: 'dev', phone: null, name: '开发者', role: null, department: null, isAdmin: false, status: 'active', tags: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, expiresAt: new Date(Date.now() + 86400000).toISOString() }); },
  enterpriseRegistrationRequest(): Promise<any> { return Promise.resolve({}); },
  enterpriseRegistrationIntent(): Promise<any> { return Promise.resolve(null); },
  onEnterpriseRegistrationIntent(): () => void { return () => {}; },
  onEnterpriseSessionInvalidated(): () => void { return () => {}; },
  enterpriseRegister(): Promise<any> { return Promise.resolve({}); },
  enterpriseLogout(): Promise<void> { return Promise.resolve(); },
  enterpriseAccounts(): Promise<any> { return Promise.resolve([{ id: 'browser-dev', organizationId: 'local', organizationName: '本地开发', employeeId: null, username: 'dev', phone: null, name: '开发者', role: null, department: null, isAdmin: false, status: 'active', tags: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }]); },
  enterpriseAccountCreate(): Promise<any> { return Promise.resolve({}); },
  enterpriseAccountUpdate(): Promise<any> { return Promise.resolve({}); },
  enterpriseUsageRecord(): Promise<any> { return Promise.resolve({ recorded: false, source: 'client_reported' }); },
  enterpriseKnowledgeRecord(): Promise<any> { return Promise.resolve({ status: 'added', added: true }); },
  enterpriseOrganizationView(): Promise<any> {
    return Promise.resolve({
      organization: {
        id: 'local',
        name: '本地开发',
        status: 'active',
        createdAt: new Date().toISOString(),
      },
      members: [{
        id: 'browser-dev',
        username: 'dev',
        name: '开发者',
        role: '成员',
        department: '本地调试',
        isAdmin: false,
        status: 'active',
      }],
      employeeCount: 1,
    });
  },
  enterpriseOrganizationInviteGet(): Promise<any> {
    return Promise.resolve({
      organization: { id: 'local', name: '本地开发' },
      invite: {
        id: 'invite-local',
        organizationId: 'local',
        code: 'ECP4-XZTU',
        link: 'http://127.0.0.1:7777/enterprise/join/ECP4-XZTU',
        status: 'active',
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 604800000).toISOString(),
        validHours: 168,
      },
    });
  },
  enterpriseOrganizationInviteIssue(): Promise<any> { return Promise.resolve({}); },
  enterpriseTicketInbox(): Promise<any> { return Promise.resolve([]); },
  enterpriseTicketSubmit(): Promise<any> { return Promise.resolve({}); },
};

// 注入 window.otto（与 preload contextBridge.exposeInMainWorld 对齐）
(window as any).otto = bridge;
