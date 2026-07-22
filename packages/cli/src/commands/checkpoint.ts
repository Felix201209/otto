/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */


import type { CommandModule } from 'yargs';
import { cleanCommand } from './checkpoint/clean.js';
import { recoverCommand } from './checkpoint/recover.js';
import { t } from '../ui/utils/i18n.js';

export const checkpointCommand: CommandModule = {
  command: 'checkpoint',
  aliases: ['cp'],
  describe: t('checkpoint.command.description'),
  builder: (yargs) =>
    yargs
      .command(cleanCommand)
      .command(recoverCommand)
      .demandCommand(1, t('checkpoint.command.require.subcommand'))
      .version(false)
      .help(),
  handler: () => {
    // This handler is not called when a subcommand is provided.
    // Yargs will show the help menu.
  },
};
