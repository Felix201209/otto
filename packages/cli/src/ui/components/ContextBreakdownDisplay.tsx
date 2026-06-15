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

interface ContextBreakdownDisplayProps {
  systemPromptTokens: number;
  systemToolsTokens: number;
  memoryFilesTokens: number;
  messagesTokens: number;
  reservedTokens: number;
  totalInputTokens: number;
  freeSpaceTokens: number;
  maxTokens: number;
}

/**
 * 显示上下文占用的详细分析
 * 模仿参考产品的设计：进度条可视化 + 分类统计
 */
export const ContextBreakdownDisplay: React.FC<ContextBreakdownDisplayProps> = ({
  systemPromptTokens,
  systemToolsTokens,
  memoryFilesTokens,
  messagesTokens,
  reservedTokens,
  totalInputTokens,
  freeSpaceTokens,
  maxTokens,
}) => {
  // 计算百分比
  const usagePercent = ((totalInputTokens / maxTokens) * 100).toFixed(1);
  const systemPromptPercent = ((systemPromptTokens / maxTokens) * 100).toFixed(1);
  const systemToolsPercent = ((systemToolsTokens / maxTokens) * 100).toFixed(1);
  const memoryFilesPercent = ((memoryFilesTokens / maxTokens) * 100).toFixed(1);
  const messagesPercent = ((messagesTokens / maxTokens) * 100).toFixed(1);
  const reservedPercent = ((reservedTokens / maxTokens) * 100).toFixed(1);
  const freeSpacePercent = ((freeSpaceTokens / maxTokens) * 100).toFixed(1);

  // 创建进度条（类似参考设计）
  const createProgressBar = (percentage: number): string => {
    const barWidth = 20;
    const filledWidth = Math.round((percentage / 100) * barWidth);
    const emptyWidth = barWidth - filledWidth;

    let bar = '';
    for (let i = 0; i < filledWidth; i++) {
      bar += '█';
    }
    for (let i = 0; i < emptyWidth; i++) {
      bar += '░';
    }
    return bar;
  };

  const formatNumber = (num: number) => (num / 1000).toFixed(1);

  const usagePercentNum = parseFloat(usagePercent);
  const progressBar = createProgressBar(usagePercentNum);

  // 颜色判断
  const getUsageColor = (percent: number): string => {
    if (percent >= 80) return Colors.AccentRed;
    if (percent >= 60) return Colors.AccentYellow;
    return Colors.AccentGreen;
  };

  const usageColor = getUsageColor(usagePercentNum);

  return (
    <Box flexDirection="column" marginY={1}>
      {/* 标题和总览 */}
      <Box>
        <Text color={Colors.Gray}>💾 </Text>
        <Text bold>Context Usage</Text>
        <Text color={Colors.Gray}> {formatNumber(totalInputTokens)}k/</Text>
        <Text color={Colors.Gray}>{formatNumber(maxTokens)}k tokens (</Text>
        <Text color={usageColor} bold>{usagePercent}%</Text>
        <Text color={Colors.Gray}>)</Text>
      </Box>

      {/* 进度条 */}
      <Box marginY={0} marginTop={0}>
        <Text color={usageColor}>{progressBar}</Text>
      </Box>

      {/* 详细分类 */}
      <Box flexDirection="column" marginTop={1}>
        {/* System prompt */}
        <Box marginY={0}>
          <Text color={Colors.Comment}>├─ </Text>
          <Text color={Colors.Gray}>System prompt: </Text>
          <Text color={Colors.AccentBlue}>{formatNumber(systemPromptTokens)}k tokens</Text>
          <Text color={Colors.Gray}> ({systemPromptPercent}%)</Text>
        </Box>

        {/* System tools */}
        <Box marginY={0}>
          <Text color={Colors.Comment}>├─ </Text>
          <Text color={Colors.Gray}>System tools: </Text>
          <Text color={Colors.AccentYellow}>{formatNumber(systemToolsTokens)}k tokens</Text>
          <Text color={Colors.Gray}> ({systemToolsPercent}%)</Text>
        </Box>

        {/* Memory files */}
        <Box marginY={0}>
          <Text color={Colors.Comment}>├─ </Text>
          <Text color={Colors.Gray}>Memory files: </Text>
          <Text color={Colors.AccentCyan}>{formatNumber(memoryFilesTokens)}k tokens</Text>
          <Text color={Colors.Gray}> ({memoryFilesPercent}%)</Text>
        </Box>

        {/* Messages */}
        <Box marginY={0}>
          <Text color={Colors.Comment}>├─ </Text>
          <Text color={Colors.Gray}>Messages: </Text>
          <Text color={Colors.AccentPurple}>{formatNumber(messagesTokens)}k tokens</Text>
          <Text color={Colors.Gray}> ({messagesPercent}%)</Text>
        </Box>

        {/* Free space */}
        <Box marginY={0}>
          <Text color={Colors.Comment}>└─ </Text>
          <Text color={Colors.Gray}>Free space: </Text>
          <Text color={Colors.AccentGreen}>{formatNumber(freeSpaceTokens)}k tokens</Text>
          <Text color={Colors.Gray}> ({freeSpacePercent}%)</Text>
        </Box>
      </Box>

      {/* 警告信息 */}
      {usagePercentNum > 80 && (
        <Box marginTop={1} flexDirection="column">
          <Text color={Colors.AccentRed}>
            ⚠️  High context usage detected. Use /session new to start a fresh conversation or /compress to compact current context.
          </Text>
        </Box>
      )}
    </Box>
  );
};
