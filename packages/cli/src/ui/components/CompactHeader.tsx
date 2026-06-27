/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */


import { Box,Text } from 'ink';
import React from 'react';
import { Colors } from '../colors.js';
import { useSmallWindowOptimization,WindowSizeLevel } from '../hooks/useSmallWindowOptimization.js';

interface CompactHeaderProps {
  version: string;
  currentModel: string;
  shellModeActive?: boolean;
  ideConnectionStatus?: string;
}

/**
 * 针对小窗口优化的紧凑Header组件
 * 根据窗口大小自动调整显示内容和布局
 */
export const CompactHeader: React.FC<CompactHeaderProps> = ({
  version,
  currentModel,
  shellModeActive = false,
  ideConnectionStatus: _ideConnectionStatus,
}) => {
  const smallWindowConfig = useSmallWindowOptimization();

  // 在极小窗口下完全隐藏Header
  if (smallWindowConfig.sizeLevel === WindowSizeLevel.TINY) {
    return null;
  }

  // 小窗口下的简化显示
  if (smallWindowConfig.sizeLevel === WindowSizeLevel.SMALL) {
    return (
      <Box marginBottom={1}>
        <Text color={Colors.AccentCyan}>
          Otto {version} | {currentModel}
          {shellModeActive ? <Text color={Colors.AccentYellow}> [SHELL]</Text> : null}
        </Text>
      </Box>
    );
  }

  // 正常窗口返回null，让原Header组件处理
  return null;
};