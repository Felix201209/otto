/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import type { MessageActionReturn } from './types.js';

/**
 * `/restore` — checkpoint restore in gemini-cli rewinds to a specific
 * snapshot captured before a file-mutating tool call. DeepCode's
 * `SessionManager` persists checkpoints, but the ACP-facing helper is
 * stubbed here until the UI flow is ported.
 */
export async function performRestore(
  _config: Config,
  _checkpointId?: string,
): Promise<MessageActionReturn> {
  return {
    type: 'message',
    messageType: 'warning',
    content:
      '/restore is not yet wired up in the ACP layer. Use the TUI checkpoint browser for now.',
  };
}

/** Placeholder shape matching gemini-cli's `getCheckpointInfoList` return. */
export interface CheckpointInfo {
  id: string;
  toolName?: string;
  createdAt: string;
}

export async function getCheckpointInfoList(
  _config: Config,
): Promise<CheckpointInfo[]> {
  return [];
}
