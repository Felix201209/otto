/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */


import { useState, useEffect, useRef } from 'react';
import { analyzeTextForHighlight, calculateHighlightableLength } from '../utils/emoji-utils.js';

interface HighlightedChar {
  char: string;
  isHighlighted: boolean;
  highlightIntensity: number; // 0=暗色，1=中等，2=最亮
  index: number;
}

interface LEDMarqueeOptions {
  /** 是否激活LED效果 */
  isActive: boolean;
  /** 刷新间隔（毫秒），默认80ms */
  interval?: number;
  /** 高亮字符数量，如果未指定则动态计算为文本长度的30% */
  highlightLength?: number;
  /** 每次移动的步长，默认1个字符 */
  stepSize?: number;
  /** 高亮区域占文本总长度的比例，默认0.3 (30%) */
  highlightRatio?: number;
}

/**
 * LED跑马灯效果Hook
 * 让文本中的字符从左到右依次高亮，形成跑马灯效果
 * 
 * @param text 要显示LED效果的文本
 * @param options 配置选项
 * @returns 返回带有颜色标记的字符数组用于渲染
 */
export const useLEDMarquee = (
  text: string,
  options: LEDMarqueeOptions
) => {
  const {
    isActive,
    interval = 80, // 默认80ms，平衡的流畅LED效果
    highlightLength,
    stepSize = 1,
    highlightRatio = 0.3 // 默认30%的文本长度
  } = options;

  // 分析文本，获取可高亮的字符信息
  const analyzedText = analyzeTextForHighlight(text);
  const highlightableLength = calculateHighlightableLength(text);

  // 动态计算高亮长度：如果指定了highlightLength则使用，否则根据可高亮字符长度和比例计算
  const calculateHighlightLength = (availableLength: number): number => {
    if (highlightLength !== undefined) {
      return highlightLength;
    }
    
    // 根据可高亮字符长度动态计算，但设置合理的最小和最大值
    const dynamicLength = Math.round(availableLength * highlightRatio);
    return Math.max(2, Math.min(dynamicLength, Math.floor(availableLength / 2))); // 最小2字符，最大不超过可高亮长度的一半
  };

  const actualHighlightLength = calculateHighlightLength(highlightableLength);
  
  const [currentPosition, setCurrentPosition] = useState(0);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  
  // 🎯 简化：直接使用传入的interval，不再在hook内部做小窗口判断
  // 所有的控制逻辑都由外部组件通过isActive参数来管理
  const actualInterval = interval;

  useEffect(() => {
    // 清理之前的定时器
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    // 如果不激活，重置位置并直接返回
    if (!isActive) {
      setCurrentPosition(0);
      return;
    }

    // 如果文本为空，不启动动画
    if (!text || text.length === 0) {
      setCurrentPosition(0);
      return;
    }

    // 启动LED动画
    intervalRef.current = setInterval(() => {
      setCurrentPosition((prevPosition) => {
        // 计算下一个位置，当到达末尾时重新开始
        const nextPosition = prevPosition + stepSize;
        // 🎯 优化：让高亮区域收尾衔接，当高亮区域开始离开文本时就重新开始
        // 这样可以实现无缝循环，更流畅的视觉效果
        const maxPosition = highlightableLength;
        return nextPosition >= maxPosition ? 0 : nextPosition;
      });
    }, actualInterval);

    // 清理函数
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [isActive, text, actualInterval, actualHighlightLength, stepSize, highlightableLength]);

  // 生成带有高亮标记的字符数组
  const generateHighlightedText = () => {
    if (!text || !isActive) {
      // 不激活时返回普通文本
      return analyzedText.map((item, index) => ({
        char: item.char,
        isHighlighted: false,
        index
      }));
    }

    // 计算当前高亮区域内有多少个可高亮的字符
    let highlightableCount = 0;
    let highlightedCount = 0;
    
    // 创建一个更大的渐变窗口，包含暗色区域
    const gradientWindowSize = actualHighlightLength + 4; // 前后各加2个暗色位置
    const gradientStart = currentPosition - 2; // 窗口开始位置提前2个位置
    
    return analyzedText.map((item, index) => {
      let shouldHighlight = false;
      let highlightIntensity = 0; // 0=暗色，1=中等，2=最亮
      
      // 只有可高亮的字符才参与位置计算
      if (item.shouldHighlight) {
        // 检查当前可高亮字符是否在渐变窗口内
        if (highlightableCount >= gradientStart && highlightableCount < gradientStart + gradientWindowSize) {
          const positionInGradientWindow = highlightableCount - gradientStart; // 在渐变窗口中的位置
          
          // 计算渐变强度
          if (positionInGradientWindow < 2) {
            // 前2个位置：暗色
            highlightIntensity = 0;
          } else if (positionInGradientWindow < 2 + Math.floor(actualHighlightLength * 0.3)) {
            // 渐变上升：中等
            highlightIntensity = 1;
          } else if (positionInGradientWindow < 2 + Math.floor(actualHighlightLength * 0.7)) {
            // 中心：最亮
            highlightIntensity = 2;
          } else if (positionInGradientWindow < 2 + actualHighlightLength) {
            // 渐变下降：中等
            highlightIntensity = 1;
          } else {
            // 最后2个位置：暗色
            highlightIntensity = 0;
          }
          
          // 只有非暗色的才标记为高亮
          shouldHighlight = highlightIntensity > 0;
        }
        highlightableCount++;
      }

      return {
        char: item.char,
        isHighlighted: shouldHighlight,
        highlightIntensity, // 渐变强度
        index
      };
    });
  };

  return {
    highlightedChars: generateHighlightedText(),
    currentPosition,
    isAnimating: isActive && text.length > 0
  } as {
    highlightedChars: HighlightedChar[];
    currentPosition: number;
    isAnimating: boolean;
  };
};