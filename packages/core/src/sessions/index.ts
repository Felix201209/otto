/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 *
 * Session 模块入口。
 * 导出 SessionManager 及关键类型。
 */

export { OttoSessionManager, getSessionManager } from './sessionManager.js';

export type {
  SessionMeta,
  SessionStatus,
  SplitStrategy,
  MergeStrategy,
  SessionRoutingRule,
  ContextBridge,
  SessionManagerConfig,
} from './sessionManager.js';
