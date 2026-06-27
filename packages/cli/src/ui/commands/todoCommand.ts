/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { todoStore } from 'otto-core';
import { CommandKind, SlashCommand } from './types.js';
import { t } from '../utils/i18n.js';

export const todoCommand: SlashCommand = {
  name: 'todo',
  description: t('command.todo.description'),
  kind: CommandKind.BUILT_IN,
  action: async (context, args) => {
    const arg = (args || '').trim().toLowerCase();

    if (!arg || arg === 'clear' || arg === 'hide' || arg === 'reset' || arg === 'close' || arg === 'done') {
      todoStore.clear();
      context.ui.setDebugMessage(t('command.todo.cleared'));
    } else {
      context.ui.setDebugMessage(t('command.todo.unknown'));
    }
  },
};
