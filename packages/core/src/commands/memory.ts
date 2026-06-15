/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import type {
  CommandActionReturn,
  MessageActionReturn,
  ToolActionReturn,
} from './types.js';

/** `/memory show` */
export function showMemory(config: Config): MessageActionReturn {
  const memoryContent = config.getUserMemory() ?? '';
  const fileCount = config.getGeminiMdFileCount?.() ?? 0;
  const content =
    memoryContent.length > 0
      ? `Current memory content from ${fileCount} file(s):\n\n---\n${memoryContent}\n---`
      : 'Memory is currently empty.';
  return { type: 'message', messageType: 'info', content };
}

/**
 * `/memory add <text>` — delegates to the `save_memory` tool so downstream
 * hook checks and persistence happen through the normal tool pipeline.
 */
export function addMemory(
  args?: string,
): MessageActionReturn | ToolActionReturn {
  if (!args || args.trim() === '') {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Usage: /memory add <text to remember>',
    };
  }
  return {
    type: 'tool',
    toolName: 'save_memory',
    toolArgs: { fact: args.trim() },
  };
}

/**
 * `/memory refresh` — DeepCode does not currently expose a synchronous
 * refresh entry-point in the way gemini-cli does. We surface a best-effort
 * informational response; when the runtime ships a `refreshMemory()` method
 * on `Config`, wire it up here.
 */
export async function refreshMemory(
  config: Config,
): Promise<MessageActionReturn> {
  const maybe = config as unknown as {
    refreshMemory?: () => Promise<unknown>;
  };
  if (typeof maybe.refreshMemory === 'function') {
    try {
      await maybe.refreshMemory();
    } catch (err) {
      return {
        type: 'message',
        messageType: 'error',
        content: `Failed to refresh memory: ${(err as Error).message}`,
      };
    }
  }
  const memoryContent = config.getUserMemory() ?? '';
  const fileCount = config.getGeminiMdFileCount?.() ?? 0;
  const content =
    memoryContent.length > 0
      ? `Memory reloaded. Loaded ${memoryContent.length} characters from ${fileCount} file(s).`
      : 'Memory reloaded. No memory content found.';
  return { type: 'message', messageType: 'info', content };
}

/** `/memory list` — list the discovered memory files. */
export function listMemoryFiles(config: Config): MessageActionReturn {
  const filePaths = config.getGeminiMdFilePaths?.() ?? [];
  const fileCount = filePaths.length;
  const content =
    fileCount > 0
      ? `There are ${fileCount} memory file(s) in use:\n\n${filePaths.join('\n')}`
      : 'No memory files in use.';
  return { type: 'message', messageType: 'info', content };
}

/**
 * Inbox APIs for extracted skills / memory patches are part of the
 * gemini-cli extraction workflow that DeepCode has not adopted yet. The
 * helpers below return "not supported" stubs so ACP callers can remain
 * gemini-cli compatible without pulling in the extraction subsystem.
 */
export interface InboxSkill {
  dirName: string;
  name: string;
  description: string;
  content: string;
  extractedAt?: string;
}

export async function listInboxSkills(_config: Config): Promise<InboxSkill[]> {
  return [];
}

export async function moveInboxSkill(
  _config: Config,
  _dirName: string,
  _destination: 'global' | 'project',
): Promise<CommandActionReturn> {
  return {
    type: 'message',
    messageType: 'error',
    content: 'Skill inbox is not supported on this build.',
  };
}

export async function dismissInboxSkill(
  _config: Config,
  _dirName: string,
): Promise<CommandActionReturn> {
  return {
    type: 'message',
    messageType: 'error',
    content: 'Skill inbox is not supported on this build.',
  };
}
