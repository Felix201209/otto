/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 *
 * otto knowledge — 个人知识库管理命令
 *
 * 子命令：
 *   status  — 查看知识库状态
 */

import type { CommandModule } from 'yargs';
import { getKnowledgeCapturePipeline } from 'otto-core';

async function handleStatus(argv: { json?: boolean }): Promise<void> {
  try {
    const pipeline = getKnowledgeCapturePipeline();
    const jsonOutput = argv.json as boolean;

    if (jsonOutput) {
      const s = await pipeline.status();
      console.log(JSON.stringify(s, null, 2));
    } else {
      const formatted = await pipeline.formatStatus();
      console.log(formatted);
    }
    process.exit(0);
  } catch (error) {
    console.error(
      `Knowledge status error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

export const knowledgeCommand: CommandModule = {
  command: 'knowledge',
  aliases: ['kn'],
  describe: 'Manage personal knowledge base',
  builder: (yargs) =>
    yargs
      .command(
        'status',
        'Show knowledge base status',
        (y) =>
          y.option('json', {
            type: 'boolean',
            description: 'Output as JSON',
            default: false,
          }),
        (argv) => handleStatus(argv),
      )
      .demandCommand(1, 'Please specify a subcommand: status')
      .version(false)
      .help(),
  handler: () => {
    // Help menu shown by yargs
  },
};
