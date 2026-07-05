/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 仅用于「无 Electron 环境」下的可视化自检：mock 一个假的 window.otto 桥，
 * 回放样例 server 帧，把填充版界面真渲染出来截图。不参与交付构建。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../src/renderer/App.js';

type Frame = any;
const handlers = new Set<(f: Frame) => void>();
const emit = (f: Frame): void => {
  for (const h of handlers) h(f);
};

// —— 样例时间（浏览器运行，可用 Date）——
const today = new Date();
today.setHours(0, 0, 0, 0);
const t = (h: number, m: number): number => today.getTime() + h * 3600000 + m * 60000;
const yest = today.getTime() - 86400000;
const ty = (h: number, m: number): number => yest + h * 3600000 + m * 60000;

const SESSIONS = [
  { sessionId: 's1', source: 'feishu', title: '优化用户登录流程', status: 'idle', createdAt: t(11, 0), updatedAt: t(11, 24), lastMessagePreview: '我来帮你优化登录流程的代码…', messageCount: 3 },
  { sessionId: 's2', source: 'local', title: '修复数据导出问题', status: 'idle', createdAt: t(10, 0), updatedAt: t(10, 48), lastMessagePreview: '已定位到导出时的字段映射问…', messageCount: 5 },
  { sessionId: 's3', source: 'feishu', title: '实现定时任务', status: 'idle', createdAt: t(9, 0), updatedAt: t(9, 15), lastMessagePreview: '定时任务功能已实现，包含…', messageCount: 4 },
  { sessionId: 's4', source: 'local', title: '接口性能优化建议', status: 'idle', createdAt: ty(18, 0), updatedAt: ty(18, 30), lastMessagePreview: '基于你的接口日志，我发现…', messageCount: 6 },
  { sessionId: 's5', source: 'feishu', title: '增加登录设备管理', status: 'idle', createdAt: ty(16, 0), updatedAt: ty(16, 20), lastMessagePreview: '我来帮你实现设备管理功能…', messageCount: 7 },
  { sessionId: 's6', source: 'local', title: '前端页面加载慢', status: 'idle', createdAt: ty(14, 0), updatedAt: ty(14, 5), lastMessagePreview: '我分析了加载性能，主要问题…', messageCount: 3 },
];

const DIFF = `@@ -45,15 +45,10 @@ async function login(credentials: LoginRequest) {
   // 验证用户输入
-  if (!credentials.email) {
-    throw new Error('邮箱不能为空')
-  }
-  if (!credentials.password) {
-    throw new Error('密码不能为空')
-  }
+  validateLoginInput(credentials)

   // 验证用户
   const user = await findUserByEmail(credentials.email)`;

const HISTORY: Record<string, Frame[]> = {
  s1: [
    {
      id: 'u1', sessionId: 's1', role: 'user', source: 'feishu', timestamp: t(11, 24),
      content: [{ type: 'text', value: '帮我优化一下登录流程的代码，减少重复验证逻辑' }],
    },
    {
      id: 'a1', sessionId: 's1', role: 'assistant', source: 'feishu', timestamp: t(11, 24),
      toolsCompleted: true,
      content: [
        { type: 'text', value: '我来帮你优化登录流程的代码，减少重复验证逻辑。我会分析当前代码，找出重复的验证逻辑，然后提取为公共方法。' },
        { type: 'text', value: '登录流程已优化完成！我将重复的输入验证逻辑提取到了 `validateLoginInput` 方法中，并通过单元测试确保功能正常。' },
      ],
      associatedToolCalls: [
        { callId: 't1', toolName: 'edit_file', displayName: '编辑文件', status: 'success', parameters: {}, confirmationDetails: { type: 'edit', filePath: 'src/services/auth/login.ts', fileDiff: DIFF } },
        { callId: 't2', toolName: 'run_shell_command', displayName: '终端运行', status: 'success', parameters: {}, confirmationDetails: { type: 'exec', command: 'npm run lint' } },
      ],
    },
  ],
};

const MODELS: Frame[] = [
  { id: 'claude-opus-4', displayName: 'claude-opus-4' },
  { id: 'claude-sonnet-4', displayName: 'claude-sonnet-4' },
];

const mockBridge = {
  async connect(): Promise<boolean> {
    return true;
  },
  disconnect(): void {},
  send(frame: Frame): void {
    if (frame.type === 'list_sessions') emit({ type: 'sessions_list', payload: { sessions: SESSIONS } });
    else if (frame.type === 'get_models') emit({ type: 'models_list', payload: { models: MODELS, current: 'claude-opus-4' } });
    else if (frame.type === 'get_history') emit({ type: 'history', payload: { sessionId: frame.payload.sessionId, messages: HISTORY[frame.payload.sessionId] ?? [] } });
    // 智能体启动自检：create_session → 回一份新会话摘要（store 据此关联并选中，再发开场消息）。
    else if (frame.type === 'create_session') {
      const sid = `sx-${Date.now()}`;
      const summary = { sessionId: sid, source: 'local', title: frame.payload?.title || '新对话', status: 'idle', createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 };
      SESSIONS.unshift(summary as Frame);
      emit({ type: 'session_upsert', payload: { session: summary } });
    }
    // 收到用户消息 → 短暂延时后回一条助手消息（演示专家开场后的回应）。
    else if (frame.type === 'send_user_message') {
      const sid = frame.payload.sessionId;
      const aid = `a-${Date.now()}`;
      window.setTimeout(() => {
        emit({ type: 'message_start', payload: { message: { id: aid, sessionId: sid, role: 'assistant', source: 'local', timestamp: Date.now(), content: [] } } });
        emit({ type: 'chat_chunk', payload: { sessionId: sid, messageId: aid, delta: '好的！我已按角色就位，并会用 use_skill 加载对应技能。先跟我说说这次的具体需求吧——主题、受众和目标，我们就开始。' } });
        emit({ type: 'chat_complete', payload: { sessionId: sid, messageId: aid } });
      }, 300);
    }
    // setup 落盘闭环自检：modelId 含 "fail" → 模拟 save_failed；否则追加模型并广播 models_list。
    else if (frame.type === 'save_custom_model') {
      const p = frame.payload;
      window.setTimeout(() => {
        if (String(p.modelId).includes('fail')) {
          emit({ type: 'error', payload: { code: 'save_failed', message: '写入 ~/.otto-user/custom-models.json 失败：权限被拒' } });
          return;
        }
        MODELS.push({ id: `custom:${p.provider}:${p.modelId}`, displayName: p.displayName || p.modelId, provider: p.provider });
        emit({ type: 'models_list', payload: { models: MODELS, current: 'claude-opus-4' } });
      }, 600);
    }
  },
  onFrame(h: (f: Frame) => void): () => void {
    handlers.add(h);
    return () => handlers.delete(h);
  },
  onConnectionChange(h: (c: boolean) => void): () => void {
    h(true);
    return () => {};
  },
  isConnected(): boolean {
    return true;
  },
  async openExternal(): Promise<void> {},
  async openPath(): Promise<void> {},
};

(window as any).otto = mockBridge;
// 自检钩子：让截图脚本能注入任意 server 帧（仅 preview，不参与交付）。
(window as any).__emitTestFrame = (f: Frame): void => emit(f);

// setup 自检：默认带 MODELS（不自动弹 setup）。要演示「首启无模型自动弹引导」时，
// 在 URL 加 ?empty 让 get_models 回空列表。
if (new URLSearchParams(location.search).has('empty')) MODELS.length = 0;

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
