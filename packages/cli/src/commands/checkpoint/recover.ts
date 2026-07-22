/**
 * @license
 * Copyright 2026 Otto
 * SPDX-License-Identifier: Apache-2.0
 *
 * otto checkpoint recover — list and resume interrupted turns.
 */

import type { CommandModule } from 'yargs';
import {
  TurnCheckpointManager,
  TurnCheckpoint,
} from 'otto-core';

export const recoverCommand: CommandModule = {
  command: 'recover',
  describe: 'List incomplete turn checkpoints and offer to resume',
  builder: (yargs) =>
    yargs
      .option('json', {
        type: 'boolean',
        description: 'Output as JSON',
        default: false,
      })
      .option('session', {
        alias: 's',
        type: 'string',
        description: 'Filter by session ID (partial match)',
      }),
  handler: async (argv) => {
    try {
      const manager = new TurnCheckpointManager();
      const jsonOutput = argv.json as boolean;
      const sessionFilter = argv.session as string | undefined;

      const incomplete = await manager.listIncomplete();

      // Apply session filter
      const filtered = sessionFilter
        ? incomplete.filter((cp) => cp.sessionId.includes(sessionFilter))
        : incomplete;

      if (filtered.length === 0) {
        if (jsonOutput) {
          console.log(JSON.stringify({ incomplete: [], message: 'No incomplete turns found' }, null, 2));
        } else {
          console.log('✅ No incomplete turns found. All turns completed successfully.');
        }
        process.exit(0);
      }

      if (jsonOutput) {
        console.log(
          JSON.stringify(
            {
              incomplete: filtered.map((cp) => ({
                turnId: cp.turnId,
                sessionId: cp.sessionId,
                state: cp.state,
                timestamp: cp.timestamp,
                completedTools: cp.completedTools.length,
                lastTool: cp.lastToolResult?.slice(0, 200) ?? null,
              })),
              total: filtered.length,
            },
            null,
            2,
          ),
        );
      } else {
        console.log(`\n⚠️  Found ${filtered.length} incomplete turn(s):\n`);
        for (const cp of filtered) {
          console.log(TurnCheckpointManager.formatForRecovery(cp));
          console.log('');
        }

        console.log('─'.repeat(60));
        console.log('To resume a turn, restart Otto and it will detect the checkpoint.');
        console.log('The agent will skip already-executed irreversible tools (e.g., send_message).');
        console.log('─'.repeat(60));
      }

      process.exit(0);
    } catch (error) {
      console.error(
        `Checkpoint recover error: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  },
};
