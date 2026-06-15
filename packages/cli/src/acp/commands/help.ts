/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Command,
  CommandContext,
  CommandExecutionResponse,
} from './types.js';
import type { CommandRegistry } from './commandRegistry.js';

export class HelpCommand implements Command {
  readonly name = 'help';
  readonly description = 'Show available commands';

  constructor(private readonly registry: CommandRegistry) {}

  async execute(
    _context: CommandContext,
    _args: string[] = [],
  ): Promise<CommandExecutionResponse> {
    const commands = this.registry
      .getAllCommands()
      .sort((a, b) => a.name.localeCompare(b.name));

    const lines = [
      'Otto Help:',
      '',
      '### Basics',
      '- **Add context**: Use `@` to reference files (e.g. `@src/myFile.ts`).',
      '',
      '### Commands',
    ];
    for (const cmd of commands) {
      if (cmd.description) {
        lines.push(`- **/${cmd.name}** — ${cmd.description}`);
      }
    }
    return { name: this.name, data: lines.join('\n') };
  }
}
