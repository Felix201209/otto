/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 *
 * PreviewBox — a bordered monospace box for rendering an option's preview
 * content. Markdown support is best-effort: we use the existing
 * InlineMarkdownRenderer for inline formatting, or fall back to a plain
 * code-like display. Height is capped by maxLines; excess is collapsed.
 */

import React from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import { Colors } from '../../../colors.js';

export interface PreviewBoxProps {
  content: string;
  /** Max lines before truncation. Defaults to 20. */
  maxLines?: number;
  /** Min width for the box. */
  minWidth?: number;
  /** Max width available (usually container width). */
  maxWidth?: number;
}

const BOX = {
  topLeft: '┌',
  topRight: '┐',
  bottomLeft: '└',
  bottomRight: '┘',
  horizontal: '─',
  vertical: '│',
  teeLeft: '├',
  teeRight: '┤',
};

export function PreviewBox({
  content,
  maxLines = 20,
  minWidth = 40,
  maxWidth,
}: PreviewBoxProps): React.JSX.Element {
  const lines = (content ?? '').split('\n');
  const truncated = lines.length > maxLines;
  const visible = truncated ? lines.slice(0, maxLines) : lines;

  const contentWidth = Math.max(
    minWidth,
    ...visible.map((l) => stringWidth(l)),
  );
  const boxWidth = maxWidth
    ? Math.min(contentWidth + 4, maxWidth)
    : contentWidth + 4;
  const innerWidth = Math.max(1, boxWidth - 4);

  const topBorder = `${BOX.topLeft}${BOX.horizontal.repeat(boxWidth - 2)}${BOX.topRight}`;
  const bottomBorder = `${BOX.bottomLeft}${BOX.horizontal.repeat(boxWidth - 2)}${BOX.bottomRight}`;
  const truncationBar = truncated
    ? (() => {
        const hidden = lines.length - maxLines;
        const label = `${BOX.horizontal.repeat(3)} ✂ ${BOX.horizontal.repeat(3)} ${hidden} lines hidden `;
        const fill = Math.max(0, boxWidth - 2 - stringWidth(label));
        return `${BOX.teeLeft}${label}${BOX.horizontal.repeat(fill)}${BOX.teeRight}`;
      })()
    : null;

  return (
    <Box flexDirection="column">
      <Text color={Colors.Gray} dimColor>
        {topBorder}
      </Text>
      {visible.map((line, idx) => {
        const w = stringWidth(line);
        // Hard-clip: if line wider than innerWidth, slice naively.
        // (ANSI-safe slicing is a larger feature — for preview we accept raw truncation.)
        const display = w > innerWidth ? line.slice(0, innerWidth) : line;
        const padLen = Math.max(0, innerWidth - stringWidth(display));
        return (
          <Box key={idx} flexDirection="row">
            <Text color={Colors.Gray} dimColor>
              {BOX.vertical}{' '}
            </Text>
            <Text>{display}</Text>
            <Text color={Colors.Gray} dimColor>
              {' '.repeat(padLen)} {BOX.vertical}
            </Text>
          </Box>
        );
      })}
      {truncationBar && <Text color={Colors.AccentYellow}>{truncationBar}</Text>}
      <Text color={Colors.Gray} dimColor>
        {bottomBorder}
      </Text>
    </Box>
  );
}
