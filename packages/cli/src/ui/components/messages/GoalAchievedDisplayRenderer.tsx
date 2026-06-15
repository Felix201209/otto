/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Colors } from '../../colors.js';
import type { GoalAchievedDisplay } from 'otto-core';

/**
 * GoalAchievedDisplayRenderer — readable rendering for a successful
 * goal_achieved tool call.
 *
 * Why this needs custom rendering (not the default tool-result row):
 *   - The default row is a single dim line ("ReadFolder Listed 3 items"
 *     style) — fine for routine ops, useless for the once-per-task moment
 *     where the model formally declares the long-running /goal complete.
 *   - The model is told to "逐条说明 each criterion" in `reason`, so the
 *     text often spans many lines. Folding that into one dim line
 *     destroys exactly the audit trail this tool exists to produce.
 *
 * Layout history note (DON'T re-add a `borderStyle` here):
 *   An earlier draft used `<Box borderStyle="round" borderColor={AccentGreen}>`
 *   for visual emphasis. That triggered a runtime crash — React error
 *   #300 ("Too many re-renders"). The cause is Ink's flex layout: when a
 *   bordered child sits inside `<Box flexGrow={1}>` (the wrapper that
 *   ToolMessage uses for every special-render slot) WITHOUT an explicit
 *   `width` prop, Ink's measurement loop can fail to converge and React
 *   bails out as a renderer-loop guard.
 *
 *   Other components in this codebase that DO use `borderStyle` inside
 *   the tool-message tree always pass an explicit width (e.g.
 *   AskUserQuestionMessage uses `width={terminalWidth - 2}`,
 *   DiffRenderer takes `terminalWidth` as a prop). We don't have a clean
 *   way to plumb terminalWidth down here, and the audit-trail value of
 *   the card comes from the structured layout — header line + indented
 *   body — not the border itself. So the renderer stays borderless and
 *   uses color + glyph for "this is the completion moment" emphasis.
 *
 * Design choices (current, borderless):
 *   - Header line: bold green "✓ Goal Achieved" — the ✓ glyph + AccentGreen
 *     color carry the same "success" semantic that the border was after.
 *   - Reason body: each line as its own `<Text>` so the model's paragraph
 *     breaks (it's told to "逐条说明" each criterion) survive Ink's wrap
 *     behavior. Empty lines render as spacer rows.
 *   - One leading blank row between header and body, so the structure is
 *     scannable without a hard separator.
 */
export const GoalAchievedDisplayRenderer: React.FC<{
  data: GoalAchievedDisplay;
}> = ({ data }) => {
  // Defensive: split on any flavor of newline. The model's reason is
  // free-form text, so accept "\r\n" and "\n" alike.
  const lines = (data.reason ?? '').split(/\r?\n/);

  return (
    <Box flexDirection="column">
      {/* Header — green, bold, with the ✓ glyph */}
      <Box>
        <Text color={Colors.AccentGreen} bold>
          ✓ Goal Achieved
        </Text>
      </Box>

      {/* Reason body — each line as its own Text so paragraph breaks
          survive Ink's wrap behavior; empty lines render as spacer rows.
          The leading marginTop={1} gives the body a small breathing
          room from the header without a hard divider. */}
      <Box flexDirection="column" marginTop={1}>
        {lines.map((line, idx) => (
          // Empty lines: render a single space so the row has height but
          // no visible content. Without this, Ink may collapse the row.
          <Text key={idx} wrap="wrap">
            {line.length === 0 ? ' ' : line}
          </Text>
        ))}
      </Box>
    </Box>
  );
};
