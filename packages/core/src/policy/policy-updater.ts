/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  MessageBus,
  MessageBusType,
  type BusMessage,
} from '../confirmation-bus/message-bus.js';
import type { PolicyEngine } from './policy-engine.js';

/**
 * Subset of `UpdatePolicy` messages understood by {@link createPolicyUpdater}.
 * Matches gemini-cli's payload shape so we can accept its wire format.
 */
export interface UpdatePolicyPayload {
  toolName: string;
  /** `'always'` makes the allow decision sticky for the session. */
  scope?: 'once' | 'always';
}

/**
 * Minimal persistence storage interface. Concrete implementations may write
 * to TOML, project settings, etc. The returned updater ignores persistence
 * when storage is omitted.
 */
export interface PolicyUpdaterStorage {
  persist(toolName: string): Promise<void> | void;
}

/**
 * Wire a {@link MessageBus} so that `UpdatePolicy` messages are applied to
 * the given {@link PolicyEngine} and optionally persisted.
 *
 * Returns an `unsubscribe` function for cleanup on session dispose.
 */
export function createPolicyUpdater(
  engine: PolicyEngine,
  bus: MessageBus,
  storage?: PolicyUpdaterStorage,
): () => void {
  return bus.subscribe<UpdatePolicyPayload>(
    MessageBusType.UpdatePolicy,
    (msg: BusMessage<UpdatePolicyPayload>) => {
      const { toolName, scope } = msg.payload;
      if (!toolName) return;
      if (scope === 'always') {
        engine.allowAlways(toolName);
        if (storage) {
          void Promise.resolve(storage.persist(toolName)).catch(() => {
            /* swallow persistence errors; session is still usable */
          });
        }
      }
    },
  );
}

/**
 * Imperative helper for callers that don't want to go through the bus.
 * Equivalent to publishing an `UpdatePolicy` message.
 */
export async function updatePolicy(
  engine: PolicyEngine,
  payload: UpdatePolicyPayload,
  storage?: PolicyUpdaterStorage,
): Promise<void> {
  if (payload.scope === 'always') {
    engine.allowAlways(payload.toolName);
    if (storage) {
      await storage.persist(payload.toolName);
    }
  }
}
