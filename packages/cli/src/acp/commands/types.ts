/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from 'otto-core';
import type { LoadedSettings } from '../../config/settings.js';

/**
 * Execution context handed to every ACP slash-command.
 *
 * gemini-cli uses a richer `AgentLoopContext`; DeepCode's ACP layer only
 * needs the current `Config` and `LoadedSettings`, plus a `sendMessage`
 * callback that forwards text back to the IDE via `session/update`.
 */
export interface CommandContext {
  readonly config: Config;
  readonly settings: LoadedSettings;
  readonly sendMessage: (text: string) => Promise<void>;
}

export interface CommandArgument {
  readonly name: string;
  readonly description: string;
  readonly isRequired?: boolean;
}

export interface Command {
  readonly name: string;
  readonly aliases?: string[];
  readonly description: string;
  readonly arguments?: CommandArgument[];
  readonly subCommands?: Command[];
  readonly requiresWorkspace?: boolean;

  execute(
    context: CommandContext,
    args: string[],
  ): Promise<CommandExecutionResponse>;
}

export interface CommandExecutionResponse {
  readonly name: string;
  readonly data: unknown;
}
