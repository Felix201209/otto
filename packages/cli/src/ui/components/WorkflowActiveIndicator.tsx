/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Text } from 'ink';
import { Colors } from '../colors.js';

/**
 * Status-bar indicator shown while a dynamic workflow is executing.
 * Mirrors the visual weight of GoalActiveIndicator / PlanModeIndicator.
 */
export const WorkflowActiveIndicator: React.FC = () => (
  <Text color={Colors.AccentCyan} dimColor>
    {'⚡ workflow running'}
  </Text>
);
