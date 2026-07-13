/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 *
 * Insertion Engine 模块入口。
 */

export { InsertionEngine, getInsertionEngine } from './insertionEngine.js';

export type {
  InsertionRequest,
  InsertionPriority,
  InsertionStrategy,
  InsertionStatus,
  InsertionDecision,
  InsertionEventHandlers,
  CurrentTaskContext,
  InsertionEngineConfig,
} from './insertionEngine.js';
