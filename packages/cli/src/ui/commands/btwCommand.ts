/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { CommandKind, type SlashCommand } from './types.js';

/**
 * `/btw <question>` — by-the-way side question.
 *
 * Forks a lightweight tool-less single-turn agent to answer a quick
 * question without disturbing the main agent's running turn. The fork:
 *   - shares the main chat's prompt-cache prefix (when available)
 *   - has zero tools available (text-only answer)
 *   - runs in parallel with the main agent (does not interrupt it)
 *   - does NOT write to chat transcript
 *
 * Marked `immediate: true` so the prompt-queue layer in App.tsx bypasses
 * the normal "queue when busy" path and routes the input directly to the
 * side-question runner. The action below is therefore intentionally a
 * no-op — App.tsx intercepts the `/btw ` prefix BEFORE the slash-command
 * processor ever sees it. This command entry exists so that:
 *   1. `/btw` appears in autocomplete / `/help`
 *   2. The `immediate` flag is discoverable for future generalization
 *   3. Users who type `/btw` with no args get a friendly hint via the
 *      App.tsx interception (which falls through to here if needed).
 */
export const btwCommand: SlashCommand = {
  name: 'btw',
  description:
    'Side question: ask a quick question without interrupting the main agent. Usage: `/btw <question>`',
  kind: CommandKind.BUILT_IN,
  immediate: true,
  action: async () => ({
    type: 'message',
    messageType: 'info',
    content:
      'Usage: `/btw <question>` — forks a side agent to answer without disturbing the main task.',
  }),
};
