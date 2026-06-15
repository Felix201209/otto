/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { getVersion } from 'otto-core';
import type {
  Command,
  CommandContext,
  CommandExecutionResponse,
} from './types.js';

export class AboutCommand implements Command {
  readonly name = 'about';
  readonly description = 'Show version and environment info';

  async execute(
    context: CommandContext,
    _args: string[] = [],
  ): Promise<CommandExecutionResponse> {
    const cliVersion = await getVersion().catch(() => 'unknown');
    const model =
      (context.config as unknown as { getModel?: () => string | undefined })
        .getModel?.() ?? 'auto';
    const selectedAuthType =
      (context.settings.merged as { selectedAuthType?: string } | undefined)
        ?.selectedAuthType ?? 'proxy-auth';

    const lines = [
      'Otto Info:',
      `- Version: ${cliVersion}`,
      `- OS: ${process.platform}`,
      `- Node: ${process.version}`,
      `- Model: ${model}`,
      `- Auth Type: ${selectedAuthType}`,
    ];
    return { name: this.name, data: lines.join('\n') };
  }
}
