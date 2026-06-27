/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Colors } from '../../colors.js';
import type { GoalRejectedDisplay } from 'otto-core';

/**
 * GoalRejectedDisplayRenderer — readable rendering for a rejected
 * goal_achieved tool call (from independent supervisor).
 */
export const GoalRejectedDisplayRenderer: React.FC<{
  data: GoalRejectedDisplay;
}> = ({ data }) => {
  const lines = (data.feedback ?? '').split(/\r?\n/);

  return (
    <Box flexDirection="column">
      {/* Header — Red, bold, with the ✗ glyph */}
      <Box>
        <Text color={Colors.AccentRed} bold>
          ✗ Goal Completion Rejected by Supervisor
        </Text>
      </Box>

      {/* Feedback body */}
      <Box flexDirection="column" marginTop={1}>
        {lines.map((line, idx) => (
          <Text key={idx} wrap="wrap" color={Colors.AccentOrange}>
            {line.length === 0 ? ' ' : line}
          </Text>
        ))}
      </Box>
    </Box>
  );
};
