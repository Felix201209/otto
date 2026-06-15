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

/**
 * Extensions management is not yet exposed through the ACP layer in DeepCode.
 * gemini-cli ships `/extensions list|enable|disable|install|link|uninstall|restart|update`;
 * once the corresponding {@link ExtensionManager} surface is wired in we can
 * expand this stub.
 */
export class ExtensionsCommand implements Command {
  readonly name = 'extensions';
  readonly description = 'Manage Otto extensions';

  async execute(
    _context: CommandContext,
    _args: string[] = [],
  ): Promise<CommandExecutionResponse> {
    return {
      name: this.name,
      data: 'Extension management over ACP is not yet available in Otto. Use the interactive TUI for now.',
    };
  }
}
