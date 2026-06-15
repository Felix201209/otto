/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { AcpCommands } from 'otto-core';
import type {
  Command,
  CommandContext,
  CommandExecutionResponse,
} from './types.js';

class RestoreListSubCommand implements Command {
  readonly name = 'restore list';
  readonly description = 'List available restore checkpoints';

  async execute(context: CommandContext): Promise<CommandExecutionResponse> {
    const list = await AcpCommands.getCheckpointInfoList(context.config);
    if (list.length === 0) {
      return { name: this.name, data: 'No checkpoints found.' };
    }
    const lines = list.map(
      (cp, i) =>
        `  ${i + 1}. ${cp.id}${cp.toolName ? ` — ${cp.toolName}` : ''} (${cp.createdAt})`,
    );
    return { name: this.name, data: ['Checkpoints:', ...lines].join('\n') };
  }
}

export class RestoreCommand implements Command {
  readonly name = 'restore';
  readonly description = 'Restore a checkpoint';
  readonly subCommands = [new RestoreListSubCommand()];

  async execute(
    context: CommandContext,
    args: string[] = [],
  ): Promise<CommandExecutionResponse> {
    const result = await AcpCommands.performRestore(context.config, args[0]);
    return { name: this.name, data: result.content };
  }
}
