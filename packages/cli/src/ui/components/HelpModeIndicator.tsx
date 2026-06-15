/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */


import React from 'react';
import { Box, Text } from 'ink';
import { Colors } from '../colors.js';

export const HelpModeIndicator: React.FC = () => (
  <Box>
    <Text color={Colors.AccentCyan}>
      💡 AI help assistant active
      <Text color={Colors.Gray}> (esc to exit • uses tokens)</Text>
    </Text>
  </Box>
);
