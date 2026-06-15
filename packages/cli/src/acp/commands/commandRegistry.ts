/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Command } from './types.js';

/**
 * Flat registry of slash commands.
 *
 * `Command.name` can contain spaces (e.g. `"memory show"`), which lets nested
 * commands live inside a single map without building a tree. Sub-commands
 * are registered recursively so every name is directly lookup-able.
 */
export class CommandRegistry {
  private readonly commands = new Map<string, Command>();

  register(command: Command): void {
    if (this.commands.has(command.name)) return;
    this.commands.set(command.name, command);
    for (const sub of command.subCommands ?? []) {
      this.register(sub);
    }
  }

  get(commandName: string): Command | undefined {
    return this.commands.get(commandName);
  }

  getAllCommands(): Command[] {
    return [...this.commands.values()];
  }
}
