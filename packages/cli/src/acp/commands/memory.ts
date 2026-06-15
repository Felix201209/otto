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

function toResponse(
  name: string,
  result: ReturnType<typeof AcpCommands.showMemory>,
): CommandExecutionResponse {
  return { name, data: result.content };
}

class MemoryShowSubCommand implements Command {
  readonly name = 'memory show';
  readonly description = 'Show current memory content';

  async execute(context: CommandContext): Promise<CommandExecutionResponse> {
    return toResponse(this.name, AcpCommands.showMemory(context.config));
  }
}

class MemoryRefreshSubCommand implements Command {
  readonly name = 'memory refresh';
  readonly description = 'Reload memory from disk';

  async execute(context: CommandContext): Promise<CommandExecutionResponse> {
    const result = await AcpCommands.refreshMemory(context.config);
    return { name: this.name, data: result.content };
  }
}

class MemoryListSubCommand implements Command {
  readonly name = 'memory list';
  readonly description = 'List loaded memory files';

  async execute(context: CommandContext): Promise<CommandExecutionResponse> {
    return toResponse(this.name, AcpCommands.listMemoryFiles(context.config));
  }
}

class MemoryAddSubCommand implements Command {
  readonly name = 'memory add';
  readonly description = 'Save a fact to long-term memory';

  async execute(
    _context: CommandContext,
    args: string[] = [],
  ): Promise<CommandExecutionResponse> {
    const result = AcpCommands.addMemory(args.join(' '));
    if (result.type === 'tool') {
      // The ACP command channel doesn't execute tools on our behalf — tell the
      // user to pass the fact back through the normal prompt surface.
      return {
        name: this.name,
        data: `To save "${String((result.toolArgs as { fact?: unknown }).fact ?? '')}" to memory, include it in a regular prompt and use the save_memory tool.`,
      };
    }
    return { name: this.name, data: result.content };
  }
}

export class MemoryCommand implements Command {
  readonly name = 'memory';
  readonly description = 'Manage Otto memory';
  readonly subCommands: Command[] = [
    new MemoryShowSubCommand(),
    new MemoryRefreshSubCommand(),
    new MemoryListSubCommand(),
    new MemoryAddSubCommand(),
  ];

  async execute(
    _context: CommandContext,
    _args: string[] = [],
  ): Promise<CommandExecutionResponse> {
    return {
      name: this.name,
      data: 'Usage: /memory <show|refresh|list|add>',
    };
  }
}
