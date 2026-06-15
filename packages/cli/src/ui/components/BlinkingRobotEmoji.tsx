/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */


import React, { useState, useEffect, useRef } from 'react';
import { Text } from 'ink';
import { Colors } from '../colors.js';
import { useSmallWindowOptimization, shouldSkipAnimation } from '../hooks/useSmallWindowOptimization.js';

/**
 * 闪烁的机器人 emoji 组件
 * 用于 SubAgent 运行时的状态指示
 */
export const BlinkingRobotEmoji: React.FC = () => {
  const smallWindowConfig = useSmallWindowOptimization();
  const [isVisible, setIsVisible] = useState(true);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    // 清理之前的定时器
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    // 检查是否应该跳过动画
    const skipAnimation = shouldSkipAnimation(smallWindowConfig, 'spinner');

    if (!skipAnimation) {
      // 每 500ms 切换一次可见性，产生闪烁效果
      intervalRef.current = setInterval(() => {
        setIsVisible(prev => !prev);
      }, 500);
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [smallWindowConfig]);

  // 如果应该跳过动画，直接显示静态 emoji
  if (shouldSkipAnimation(smallWindowConfig, 'spinner')) {
    return <Text color={Colors.AccentBlue}>🤖</Text>;
  }

  // 闪烁效果：可见时显示机器人 emoji，不可见时显示空白（保持宽度）
  return (
    <Text color={Colors.AccentBlue}>
      {isVisible ? '🤖' : '  '}
    </Text>
  );
};
