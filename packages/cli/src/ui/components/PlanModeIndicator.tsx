/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */


import React from 'react';
import { Box, Text } from 'ink';
import { Colors } from '../colors.js';
import { t } from '../utils/i18n.js';

/**
 * Plan模式指示器组件
 * 在启用Plan模式时显示，提醒用户当前处于需求讨论模式
 */
export const PlanModeIndicator: React.FC = () => (
  <Box borderStyle="round" borderColor={Colors.AccentGreen} paddingX={1}>
    <Text color={Colors.AccentGreen}>
      📋 {t('plan.mode.indicator')}
    </Text>
  </Box>
);