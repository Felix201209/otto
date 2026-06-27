/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { CommandKind, CommandContext, OpenDialogActionReturn, SlashCommand } from './types.js';

export const addModelCommand: SlashCommand = {
  name: 'add-model',
  description: 'Launch wizard to add a custom model configuration',
  kind: CommandKind.BUILT_IN,
  action: (_context: CommandContext): OpenDialogActionReturn => ({
      type: 'dialog',
      dialog: 'customModelWizard',
    }),
};
