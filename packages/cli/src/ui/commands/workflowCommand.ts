/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { type CommandContext, type SlashCommand, CommandKind } from './types.js';

export const workflowCommand: SlashCommand = {
  name: 'workflow',
  altNames: ['wf', 'workflows'],
  description: 'Open the workflow management panel to view running and completed workflows.',
  kind: CommandKind.BUILT_IN,
  action: (_context: CommandContext, _args?: string) => {
    // Delegate to the panel — return a dialog open action
    return { type: 'dialog', dialog: 'workflow-panel' } as const;
  },
};
