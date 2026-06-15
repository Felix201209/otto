/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import type { ApprovalMode } from '../config/config.js';

/**
 * Events emitted by `coreEvents`.
 *
 * ACP code listens for `ApprovalModeChanged` to forward mode updates to the
 * editor UI. Add more members here as new cross-cutting events surface.
 */
export enum CoreEvent {
  ApprovalModeChanged = 'approval_mode_changed',
}

export interface ApprovalModeChangedPayload {
  sessionId?: string;
  mode: ApprovalMode;
}

export type CoreEventPayloadMap = {
  [CoreEvent.ApprovalModeChanged]: ApprovalModeChangedPayload;
};

/**
 * Typed wrapper around a shared EventEmitter for cross-cutting core events.
 * Typing keeps ACP callers honest about payload shapes.
 */
class TypedCoreEvents {
  private readonly emitter = new EventEmitter();

  on<E extends CoreEvent>(
    event: E,
    listener: (payload: CoreEventPayloadMap[E]) => void,
  ): () => void {
    this.emitter.on(event, listener);
    return () => this.emitter.off(event, listener);
  }

  off<E extends CoreEvent>(
    event: E,
    listener: (payload: CoreEventPayloadMap[E]) => void,
  ): void {
    this.emitter.off(event, listener);
  }

  emit<E extends CoreEvent>(event: E, payload: CoreEventPayloadMap[E]): void {
    this.emitter.emit(event, payload);
  }

  /** Primarily for tests. */
  removeAllListeners(event?: CoreEvent): void {
    if (event) this.emitter.removeAllListeners(event);
    else this.emitter.removeAllListeners();
  }
}

/**
 * Global singleton for cross-cutting core events. ACP modules and
 * approval-mode UI both import this to stay in sync.
 */
export const coreEvents = new TypedCoreEvents();
