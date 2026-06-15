/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Colors } from '../colors.js';

/** Lifecycle state of a side-question UI panel. */
export type SideQuestionStatus =
  | 'pending'   // submitted, waiting for first model chunk
  | 'streaming' // model is actively streaming text
  | 'done'      // streaming complete, user can read and dismiss
  | 'failed'    // model errored
  | 'cancelled'; // user pressed Esc mid-stream

export interface SideQuestionState {
  question: string;
  answer: string;
  status: SideQuestionStatus;
  error?: string;
  /** Snapshot of how cache fared this turn (display-only, optional). */
  cacheNote?: string;
}

export interface SideQuestionPanelProps {
  state: SideQuestionState | null;
  /** Total terminal height in rows. Panel caps at 40% of this. */
  terminalHeight: number;
  /** Total terminal width in columns. Used for soft text wrapping budget. */
  terminalWidth: number;
}

/**
 * Renders the `/btw` side-question result as a bordered box directly below
 * the input prompt. Pushes the input/footer up if needed, capped at 40% of
 * terminal height. Beyond that, the latest content stays visible (we render
 * the full text; terminal naturally scrolls the buffer if the user pushes
 * past it).
 *
 * Returns null when there is no active side-question, so it imposes zero
 * layout cost at rest.
 *
 * Keybinding hints are shown inline in the panel header/footer per the
 * product spec.
 */
export const SideQuestionPanel: React.FC<SideQuestionPanelProps> = ({
  state,
  terminalHeight,
}) => {
  if (!state) return null;

  // Cap panel height at 40% of terminal — Ink truncates rather than
  // scrolls, but the user can scroll terminal buffer to read overflow.
  // Minimum 5 rows so we always have room for header + 1 line + hint.
  const maxHeight = Math.max(5, Math.floor(terminalHeight * 0.4));
  const isActive = state.status === 'pending' || state.status === 'streaming';
  const isDone = state.status === 'done';
  const isFailed = state.status === 'failed' || state.status === 'cancelled';

  const borderColor = isFailed
    ? Colors.AccentRed
    : isDone
    ? Colors.AccentGreen
    : Colors.AccentCyan;

  const statusLabel: Record<SideQuestionStatus, string> = {
    pending: '⏳ asking…',
    streaming: '⌛ streaming',
    done: '✅ done',
    failed: '❌ failed',
    cancelled: '⏹️ cancelled',
  };

  // Keybinding hints — explicit per spec.
  const keyHint = isActive
    ? 'Esc to cancel · this side fork does not affect the main agent'
    : 'Esc to close';

  // Question preview (single line, truncated).
  const qPreview = state.question.replace(/\s+/g, ' ').slice(0, 100);
  const qTail = state.question.length > 100 ? '…' : '';

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={borderColor}
      paddingX={1}
      marginLeft={2}
      marginTop={1}
      // 40% of terminal height cap; content overflowing is truncated by Ink
      // — the user can scroll the terminal buffer to see the rest.
      height={maxHeight}
    >
      <Box>
        <Text color={Colors.AccentCyan} bold>
          [/btw]{' '}
        </Text>
        <Text color={Colors.Foreground}>{qPreview}{qTail}</Text>
        <Text color={Colors.Gray}>  {statusLabel[state.status]}</Text>
      </Box>

      <Box flexDirection="column" marginTop={1} flexGrow={1}>
        {state.answer ? (
          <Text>{state.answer}</Text>
        ) : isActive ? (
          <Text color={Colors.Gray} italic>
            {state.status === 'pending'
              ? 'Forking a lightweight agent…'
              : 'Waiting for first token…'}
          </Text>
        ) : null}

        {state.error && (
          <Box marginTop={1}>
            <Text color={Colors.AccentRed}>error: {state.error}</Text>
          </Box>
        )}

        {state.cacheNote && (
          <Box marginTop={1}>
            <Text color={Colors.Gray} italic>
              {state.cacheNote}
            </Text>
          </Box>
        )}
      </Box>

      <Box marginTop={1}>
        <Text color={Colors.Gray} dimColor>
          {keyHint}
        </Text>
      </Box>
    </Box>
  );
};
