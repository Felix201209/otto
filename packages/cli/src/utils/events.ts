/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'events';

export enum AppEvent {
  OpenDebugConsole = 'open-debug-console',
  LogError = 'log-error',
  FeishuServerStarted = 'feishu-server-started',
  FeishuServerStopped = 'feishu-server-stopped',
  FeishuBotStarted = 'feishu-bot-started',
  FeishuBotStopped = 'feishu-bot-stopped',
  FeishuBotProcessingStart = 'feishu-bot-processing-start',
  FeishuBotProcessingEnd = 'feishu-bot-processing-end',
  /** 飞书仪表板：指定群（chatId）开始处理消息 */
  FeishuGroupProcessingStart = 'feishu-group-processing-start',
  /** 飞书仪表板：指定群（chatId）处理完毕 */
  FeishuGroupProcessingEnd = 'feishu-group-processing-end',
  /** 飞书仪表板：实时消息日志（用于滚动窗口） */
  FeishuMessageLog = 'feishu-message-log',
  /** 飞书仪表板：项目路由表已更新 */
  FeishuProjectRoutesUpdated = 'feishu-project-routes-updated',
  /** 飞书仪表板：群名称解析完成（chatId → 群名），用于在 Dashboard 中用群名替代 chatId 展示 */
  FeishuChatNamesResolved = 'feishu-chat-names-resolved',
  /** 飞书仪表板：p2p 单聊（与 Bot 的私聊）解析完成（chatId 列表），用于展示「与机器人 X 的私聊」 */
  FeishuP2pChatsResolved = 'feishu-p2p-chats-resolved',
  AuthenticationSuccessful = 'authentication-successful',
  AuthenticationFailed = 'authentication-failed',
  AuthenticationRequired = 'authentication-required',
  UserLoggedOut = 'user-logged-out',
  TokensUpdated = 'tokens-updated',
  TokensCleared = 'tokens-cleared',
  ModelChanged = 'model-changed',
  CreditsConsumed = 'credits-consumed',
  ImagePollingStart = 'image-polling-start',
  ImagePollingProgress = 'image-polling-progress',
  ImagePollingEnd = 'image-polling-end',
  SelectionWarning = 'selection-warning',
  PasteTimeout = 'paste-timeout',
  Flicker = 'flicker',
  // Stream recovery events
  StreamRecoveryStart = 'stream-recovery-start',
  StreamRecoveryCountdown = 'stream-recovery-countdown',
  StreamRecoveryEnd = 'stream-recovery-end',
}

export const appEvents = new EventEmitter();
