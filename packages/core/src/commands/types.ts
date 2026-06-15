/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Return shapes for slash-command helpers consumed by the ACP command layer.
 * Kept intentionally simple — the ACP dispatcher translates these into
 * `sessionUpdate` notifications or tool calls.
 */

export interface MessageActionReturn {
  type: 'message';
  messageType: 'info' | 'error' | 'warning';
  content: string;
}

export interface ToolActionReturn {
  type: 'tool';
  toolName: string;
  toolArgs: Record<string, unknown>;
}

export interface SubmitPromptActionReturn {
  type: 'submit_prompt';
  content: string;
}

export type CommandActionReturn =
  | MessageActionReturn
  | ToolActionReturn
  | SubmitPromptActionReturn;
