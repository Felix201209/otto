/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box,Text } from 'ink';
import { ThoughtSummary } from 'otto-core';
import React from 'react';
import { Colors } from '../colors.js';
import { useStreamingContext } from '../contexts/StreamingContext.js';
import { useLEDMarquee } from '../hooks/useLEDMarquee.js';
import { useRealTimeToken } from '../hooks/useRealTimeToken.js';
import { shouldSkipAnimation,useSmallWindowOptimization } from '../hooks/useSmallWindowOptimization.js';
import { themeManager } from '../themes/theme-manager.js';
import { StreamingState } from '../types.js';
import { createGradientColorSet } from '../utils/color-brightness.js';
import { formatDuration } from '../utils/formatters.js';
import { getInputCancelHint,isChineseLocale } from '../utils/i18n.js';
import { OttoRespondingSpinner } from './OttoRespondingSpinner.js';
import { TokenUsageInfo } from './TokenUsageDisplay.js';

interface LoadingIndicatorProps {
  currentLoadingPhrase?: string;
  elapsedTime: number;
  rightContent?: React.ReactNode;
  thought?: ThoughtSummary | null;
  estimatedInputTokens?: number;
  isExecutingTools?: boolean; // 🎯 新增：是否正在执行工具
  lastTokenUsage?: TokenUsageInfo | null; // 🎯 新增：最新token使用情况
}

// 精简格式化token数字，大于1000时用k单位显示，保留两位小数
const formatTokenCompact = (count: number | undefined): string => {
  if (count === undefined || count === null) return '0';
  if (count >= 1000) {
    return `${(count / 1000).toFixed(2)}k`;
  }
  return count.toString();
};

export const LoadingIndicator: React.FC<LoadingIndicatorProps> = ({
  currentLoadingPhrase,
  elapsedTime,
  rightContent,
  thought,
  estimatedInputTokens,
  isExecutingTools = false, // 🎯 新增参数
  lastTokenUsage, // 🎯 新增：最新token使用情况
}) => {
  const streamingState = useStreamingContext();
  const realTimeToken = useRealTimeToken();
  const smallWindowConfig = useSmallWindowOptimization();

  // 🎯 修复：直接使用传入的工具执行状态，而不是基于文本猜测
  const _isCallingTools = isExecutingTools;

  // 🎯 重要：所有hooks必须在任何条件判断之前调用
  // 预计算主要文本用于LED效果
  const textForLED = streamingState === StreamingState.WaitingForConfirmation
    ? (isChineseLocale() ? '等待用户确认...' : 'Waiting for user confirmation...')
    : thought?.subject || currentLoadingPhrase || '';

  // 🎯 关键优化：在矮终端下直接禁用LED动画
  const shouldUseLED = streamingState === StreamingState.Responding && !shouldSkipAnimation(smallWindowConfig, 'loading');

  // LED跑马灯效果用于主要文本
  const { highlightedChars: textLED } = useLEDMarquee(textForLED, {
    isActive: shouldUseLED, // 矮终端下直接不激活
    interval: 80, // 与spinner同步的80ms间隔，平衡的流畅效果
    highlightRatio: 0.3, // 动态计算高亮长度为文本长度的30%
    stepSize: 1
  });

  // 根据主题类型选择渐变颜色
  const activeTheme = themeManager.getActiveTheme();
  const isDarkTheme = activeTheme.colors.type === 'dark';
  const gradientBaseColor = isDarkTheme ? Colors.Foreground : Colors.AccentBlue; // 深色模式用前景白，浅色模式用强调蓝
  const gradientColors = createGradientColorSet(gradientBaseColor);

  if (streamingState === StreamingState.Idle) {
    return null;
  }

  const primaryText = streamingState === StreamingState.WaitingForConfirmation
    ? (isChineseLocale() ? '等待用户确认...' : 'Waiting for user confirmation...')
    : thought?.subject || currentLoadingPhrase;

  // 获取token数量
  const _tokenCount = realTimeToken?.inputTokens || estimatedInputTokens;
  const _isRealTime = !!realTimeToken?.inputTokens;

  // 预计算是否应该显示LED效果（与shouldUseLED保持一致）
  const shouldShowLEDEffect = shouldUseLED;

  return (
    <Box marginTop={1} paddingLeft={0} flexDirection="column">
      {/* Main loading line */}
      <Box width="100%">
        <Box marginRight={1}>
          {/* 🎯 关键修复：在等待确认时完全不渲染OttoRespondingSpinner，
              使用静态Text组件代替，确保没有任何动画效果 */}
          {streamingState === StreamingState.WaitingForConfirmation ? (
            <Text key="static-indicator">⠏</Text>
          ) : (
            <OttoRespondingSpinner key="dynamic-spinner" />
          )}
        </Box>
        <Box flexShrink={1}>
          <Text wrap="wrap" color={Colors.AccentOrange}>
            {primaryText ? (
              shouldShowLEDEffect ? (
                // LED跑马灯效果的文本 - 使用渐变色效果
                <Text>
                  {textLED.map(({ char, highlightIntensity, index }) => {
                    // 根据强度选择颜色：0=暗色，1=中等，2=最亮
                    let color;
                    switch (highlightIntensity) {
                      case 2:
                        color = gradientColors.bright; // 最亮
                        break;
                      case 1:
                        color = gradientColors.medium; // 中等亮度
                        break;
                      default:
                        color = gradientColors.dim; // 暗色
                        break;
                    }

                    return (
                      <Text key={index} color={color}>
                        {char}
                      </Text>
                    );
                  })}
                </Text>
              ) : (
                // 静态文本（等待确认状态、小窗口优化或矮终端）- 保持原始颜色
                <Text color={Colors.AccentOrange}>{primaryText}</Text>
              )
            ) : null}
            <Text color={Colors.Gray}>
              {streamingState === StreamingState.WaitingForConfirmation
                ? ''
                : (() => {
                    const cancelText = `${getInputCancelHint()}, ${elapsedTime < 60 ? `${elapsedTime}s` : formatDuration(elapsedTime * 1000)}`;
                    if (lastTokenUsage && (lastTokenUsage.input_tokens > 0 || lastTokenUsage.output_tokens > 0)) {
                      const inputStr = formatTokenCompact(lastTokenUsage.input_tokens);
                      const outputStr = formatTokenCompact(lastTokenUsage.output_tokens);
                      return ` (${cancelText} | ↑ ${inputStr} ↓ ${outputStr})`;
                    }
                    return ` (${cancelText})`;
                  })()}
              {/* Token 计数已隐藏 - 不再显示 ↑ 和 🪓 符号 */}
            </Text>
          </Text>
        </Box>
        <Box flexGrow={1}>{/* Spacer */}</Box>
        {rightContent ? <Box>{rightContent}</Box> : null}
      </Box>
    </Box>
  );
};
