/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Command,
  CommandContext,
  CommandExecutionResponse,
} from './commands/types.js';
import { CommandRegistry } from './commands/commandRegistry.js';
import { MemoryCommand } from './commands/memory.js';
import { InitCommand } from './commands/init.js';
import { AboutCommand } from './commands/about.js';
import { HelpCommand } from './commands/help.js';
import { ExtensionsCommand } from './commands/extensions.js';

/**
 * Handles slash-command interception and dispatch for ACP prompts.
 *
 * Mirrors gemini-cli's command handler, but registers the (smaller) set of
 * commands DeepCode ships today. Additional commands can be added simply by
 * pushing them into {@link CommandHandler.createRegistry}.
 *
 * NOTE: `/restore` is intentionally not registered here. Checkpoint
 * restoration in DeepCode is still a stub at the core layer (see
 * `core/src/commands/restore.ts`), and exposing the slash command would
 * surface a non-functional button to ACP clients. The user-facing "rewind
 * conversation" gesture is handled by the `_otto/session/rewind`
 * extension RPC instead — IDEs trigger it directly from their UI.
 */
export class CommandHandler {
  private readonly registry: CommandRegistry;

  constructor() {
    this.registry = CommandHandler.createRegistry();
  }

  private static createRegistry(): CommandRegistry {
    const registry = new CommandRegistry();
    registry.register(new MemoryCommand());
    registry.register(new ExtensionsCommand());
    registry.register(new InitCommand());
    registry.register(new AboutCommand());
    registry.register(new HelpCommand(registry));
    return registry;
  }

  getAvailableCommands(): Array<{ name: string; description: string }> {
    return this.registry
      .getAllCommands()
      .map((c) => ({ name: c.name, description: c.description }));
  }

  /**
   * Parse and execute a slash-command. Returns `true` if a command was
   * handled (so the caller can skip the LLM round trip), `false` otherwise.
   */
  async handleCommand(
    commandText: string,
    context: CommandContext,
  ): Promise<boolean> {
    const parsed = this.parseSlashCommand(commandText);
    if (!parsed.commandToExecute) return false;
    await this.runCommand(parsed.commandToExecute, parsed.args, context);
    return true;
  }

  private async runCommand(
    command: Command,
    args: string,
    context: CommandContext,
  ): Promise<void> {
    try {
      const result: CommandExecutionResponse = await command.execute(
        context,
        args ? args.split(/\s+/) : [],
      );

      let message = '';
      if (typeof result.data === 'string') {
        message = result.data;
      } else if (
        typeof result.data === 'object' &&
        result.data !== null &&
        'content' in result.data
      ) {
        message = String(
          (result.data as { content: unknown }).content ?? '',
        );
      } else {
        message = JSON.stringify(result.data, null, 2);
      }
      await context.sendMessage(message);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await context.sendMessage(`Error: ${msg}`);
    }
  }

  /**
   * Parse a raw `/foo bar baz arg1 arg2` query into a `{command, args}` pair.
   * Walks the registry prefix-first so multi-word names (`"memory show"`)
   * are matched as deeply as possible.
   */
  private parseSlashCommand(query: string): {
    commandToExecute: Command | undefined;
    args: string;
  } {
    const trimmed = query.trim();
    // Tolerate both `/` and `$` prompts as command entries.
    const stripped = trimmed.startsWith('/') || trimmed.startsWith('$')
      ? trimmed.slice(1).trim()
      : trimmed;
    const parts = stripped.split(/\s+/).filter(Boolean);

    let currentCommands = this.registry.getAllCommands();
    let commandToExecute: Command | undefined;
    let pathIndex = 0;

    for (const part of parts) {
      const expected = parts.slice(0, pathIndex + 1).join(' ');
      const found = currentCommands.find(
        (cmd) =>
          cmd.name === part ||
          cmd.name === expected ||
          cmd.aliases?.includes(part) ||
          cmd.aliases?.includes(expected),
      );
      if (!found) break;
      commandToExecute = found;
      pathIndex++;
      if (found.subCommands) currentCommands = found.subCommands;
      else break;
    }

    const args = parts.slice(pathIndex).join(' ');
    return { commandToExecute, args };
  }
}
