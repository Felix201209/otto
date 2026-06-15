/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { Colors } from '../colors.js';
import { getActiveDebate, ActiveDebate } from '../utils/debateState.js';
import { getDebateI18nTexts } from '../utils/debateI18n.js';
import { detectUILanguage } from '../utils/debateLanguageUtils.js';

// 闪烁持续时间（ms）和间隔（ms）
const BLINK_INTERVAL_MS = 150;
const BLINK_DURATION_MS = 1200; // 共闪烁约 8 次

/**
 * 🎭 辩论模式指示器
 *
 * 常驻在输入框上方，显示当前发言模型 + 总进度。
 *
 * 为什么需要这个组件：
 * 之前在切换模型时通过 addItem 往历史里打 "✓ 已切换到 xxx"，但在 React 18 的
 * 自动批处理 + Ink 的增量渲染下，这条提示会有概率被紧接着的流式响应覆盖/吞掉。
 *
 * 解决方案：把 "当前谁在发言" 提升为一个**常驻 UI 状态**，而不是 "瞬时消息"。
 * 用户任何时候抬头都能看到当前发言方，不依赖某一条 addItem 是否被成功渲染。
 *
 * 实现细节：
 * - debateState 是模块级单例，不走 React，所以需要用 setInterval 轮询同步到
 *   组件 state 里触发重渲染。200ms 的刷新间隔对终端 UI 完全够用，开销可忽略。
 * - 非辩论状态 / 辩论已结束 时返回 null，不占用任何空间。
 * - 模型或轮数变化时，对模型名称和进度数字触发短暂闪烁（约 1200ms），
 *   通过交替显示/隐藏文字实现视觉提示。
 */
export const DebateIndicator: React.FC = () => {
  const [debate, setDebate] = useState<ActiveDebate | null>(getActiveDebate());

  // 闪烁可见性状态：true = 显示文字，false = 隐藏（空白占位）
  const [blinkVisible, setBlinkVisible] = useState(true);

  // 追踪上一次的 cursor，用于检测变化
  const prevCursorRef = useRef<{ modelIdx: number; round: number } | null>(null);

  // 闪烁定时器 ref
  const blinkIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const blinkEndRef = useRef<NodeJS.Timeout | null>(null);

  // 触发一次短暂闪烁
  const triggerBlink = () => {
    // 清理旧定时器
    if (blinkIntervalRef.current) clearInterval(blinkIntervalRef.current);
    if (blinkEndRef.current) clearTimeout(blinkEndRef.current);

    setBlinkVisible(false);
    blinkIntervalRef.current = setInterval(() => {
      setBlinkVisible(prev => !prev);
    }, BLINK_INTERVAL_MS);

    blinkEndRef.current = setTimeout(() => {
      if (blinkIntervalRef.current) clearInterval(blinkIntervalRef.current);
      blinkIntervalRef.current = null;
      blinkEndRef.current = null;
      setBlinkVisible(true); // 闪烁结束，恢复显示
    }, BLINK_DURATION_MS);
  };

  // 轮询 debateState，检测 cursor 变化并触发闪烁
  useEffect(() => {
    const timer = setInterval(() => {
      const current = getActiveDebate();
      setDebate((prev) => {
        if (!prev && !current) return prev;
        if (!prev || !current) return current;
        if (
          prev.status === current.status &&
          prev.cursor.round === current.cursor.round &&
          prev.cursor.modelIdx === current.cursor.modelIdx
        ) {
          return prev;
        }
        return { ...current };
      });
    }, 200);
    return () => clearInterval(timer);
  }, []);

  // 检测 cursor 变化，触发闪烁
  useEffect(() => {
    if (!debate) return;
    const { modelIdx, round } = debate.cursor;
    const prev = prevCursorRef.current;

    if (prev !== null && (prev.modelIdx !== modelIdx || prev.round !== round)) {
      triggerBlink();
    }
    prevCursorRef.current = { modelIdx, round };
  }, [debate?.cursor.modelIdx, debate?.cursor.round]);

  // 组件卸载时清理闪烁定时器
  useEffect(() => {
    return () => {
      if (blinkIntervalRef.current) clearInterval(blinkIntervalRef.current);
      if (blinkEndRef.current) clearTimeout(blinkEndRef.current);
    };
  }, []);

  if (!debate || debate.status === 'done') return null;

  const texts = getDebateI18nTexts(detectUILanguage(debate.language));
  const currentModel = debate.models[debate.cursor.modelIdx] ?? '(unknown)';
  const totalTurns = debate.models.length * debate.rounds;
  const doneTurns =
    debate.cursor.round * debate.models.length + debate.cursor.modelIdx + 1;

  const statusColor =
    debate.status === 'paused' ? Colors.AccentYellow : Colors.AccentCyan;
  const statusLabel =
    debate.status === 'paused' ? texts.indicatorPaused : texts.indicatorRunning;

  // 闪烁时外框颜色在原有颜色和明亮对比色之间切换
  // running (Cyan) -> 对冲 Yellow; paused (Yellow) -> 对冲 Cyan
  const contrastColor = debate.status === 'paused' ? Colors.AccentCyan : Colors.AccentYellow;
  const borderColor = blinkVisible ? statusColor : contrastColor;

  // 闪烁时用空白占位，保持布局宽度稳定
  const modelDisplay = blinkVisible ? currentModel : ' '.repeat(currentModel.length);
  const progressDisplay = blinkVisible
    ? `${doneTurns}/${totalTurns}`
    : ' '.repeat(`${doneTurns}/${totalTurns}`.length);

  return (
    <Box
      borderStyle="round"
      borderColor={borderColor}
      paddingX={1}
      marginBottom={0}
    >
      <Text color={statusColor} bold>
        🎭 {statusLabel}
      </Text>
      <Text color={Colors.Gray}> │ </Text>
      <Text>{texts.indicatorSpeaking}：</Text>
      <Text color={Colors.AccentYellow} bold>
        {modelDisplay}
      </Text>
      <Text color={Colors.Gray}> │ </Text>
      <Text>{texts.indicatorProgress}：</Text>
      <Text color={Colors.AccentGreen} bold>
        {progressDisplay}
      </Text>
      <Text color={Colors.Gray}> {texts.presetRounds}</Text>
    </Box>
  );
};
