/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 *
 * checkpoint status — 查看会话检查点状态
 */

import type { CommandModule } from 'yargs';
import { getCheckpointService } from 'otto-core';

export const statusCommand: CommandModule = {
  command: 'status',
  describe: 'Show checkpoint status and pending tasks',
  builder: (yargs) =>
    yargs
      .option('json', {
        type: 'boolean',
        description: 'Output as JSON',
        default: false,
      }),
  handler: async (argv) => {
    try {
      const cpService = getCheckpointService();
      const jsonOutput = argv.json as boolean;

      if (jsonOutput) {
        const status = await cpService.status();
        console.log(JSON.stringify(status, null, 2));
      } else {
        const formatted = await cpService.formatStatus();
        console.log(formatted);
      }
      process.exit(0);
    } catch (error) {
      console.error(
        `Checkpoint status error: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  },
};
