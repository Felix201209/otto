/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { memo } from 'react';
import type { HistoryItem } from '../types.js';
import { UserMessage } from './messages/UserMessage.js';
import { UserShellMessage } from './messages/UserShellMessage.js';
import { GeminiMessage } from './messages/GeminiMessage.js';
import { InfoMessage } from './messages/InfoMessage.js';
import { ErrorMessage } from './messages/ErrorMessage.js';
import { ToolGroupMessage } from './messages/ToolGroupMessage.js';
import { GeminiMessageContent } from './messages/GeminiMessageContent.js';
import { CompressionMessage } from './messages/CompressionMessage.js';
import { Help } from './Help.js';
import { Box } from 'ink';
import { AboutBox } from './AboutBox.js';
import { StatsDisplay } from './StatsDisplay.js';
import { ModelStatsDisplay } from './ModelStatsDisplay.js';
import { ToolStatsDisplay } from './ToolStatsDisplay.js';
import { TokenBreakdownDisplay } from './TokenBreakdownDisplay.js';
import { ContextBreakdownDisplay } from './ContextBreakdownDisplay.js';
import { SessionSummaryDisplay } from './SessionSummaryDisplay.js';
import { Config } from 'otto-core';

interface HistoryItemDisplayProps {
  item: HistoryItem;
  availableTerminalHeight?: number;
  terminalWidth: number;
  isPending: boolean;
  config?: Config;
  isFocused?: boolean;
}

/**
 * 这些类型的子组件自己已经在顶部留出了一行间距（UserMessage 用 marginY，
 * InfoMessage 用 marginTop）。dispatcher 再叠加顶部间距会造成双倍空行，
 * 所以对它们不再额外加间距——其余所有块统一由 dispatcher 补一行呼吸空间，
 * 让整段对话维持 Claude Code 那种均匀、克制的垂直节奏（每个回合/区块之间
 * 恰好一行空白），而不是各组件各行其是、间距忽大忽小。
 */
const SELF_SPACED_TYPES = new Set<HistoryItem['type']>(['user', 'info']);

export const HistoryItemDisplay = memo(({
  item,
  availableTerminalHeight,
  terminalWidth,
  isPending,
  config,
  isFocused = true,
}: HistoryItemDisplayProps) => (
  <Box
    flexDirection="column"
    key={item.id}
    width={terminalWidth}
    // 统一垂直节奏：除自带顶部间距的块外，每个区块上方留一行呼吸空间。
    marginTop={SELF_SPACED_TYPES.has(item.type) ? 0 : 1}
  >
    {/* 对话回合：用户 / Shell / 助手 */}
    {item.type === 'user' ? <UserMessage text={item.text} terminalWidth={terminalWidth} /> : null}
    {item.type === 'user_shell' ? <UserShellMessage text={item.text} terminalWidth={terminalWidth} /> : null}
    {item.type === 'gemini' ? (
      <GeminiMessage
        text={item.text}
        isPending={isPending}
        availableTerminalHeight={availableTerminalHeight}
        terminalWidth={terminalWidth}
      />
    ) : null}
    {item.type === 'gemini_content' ? (
      <GeminiMessageContent
        text={item.text}
        isPending={isPending}
        availableTerminalHeight={availableTerminalHeight}
        terminalWidth={terminalWidth}
      />
    ) : null}
    {/* 系统/通知块：info / error */}
    {item.type === 'info' ? <InfoMessage text={item.text} /> : null}
    {item.type === 'error' ? <ErrorMessage text={item.text} /> : null}
    {/* 元信息块：about / 各类统计 / 上下文占用 / 退出总结 */}
    {item.type === 'about' ? (
      <AboutBox
        cliVersion={item.cliVersion}
        osVersion={item.osVersion}
        sandboxEnv={item.sandboxEnv}
        modelVersion={item.modelVersion}
        selectedAuthType={item.selectedAuthType}
        gcpProject={item.gcpProject}
      />
    ) : null}
    {item.type === 'stats' ? <StatsDisplay duration={item.duration} config={config} /> : null}
    {item.type === 'model_stats' ? <ModelStatsDisplay /> : null}
    {item.type === 'tool_stats' ? <ToolStatsDisplay /> : null}
    {item.type === 'token_breakdown' ? (
      <TokenBreakdownDisplay
        systemPromptTokens={item.systemPromptTokens}
        userMessageTokens={item.userMessageTokens}
        memoryContextTokens={item.memoryContextTokens}
        toolsTokens={item.toolsTokens}
        totalInputTokens={item.totalInputTokens}
        maxTokens={item.maxTokens}
      />
    ) : null}
    {item.type === 'context_breakdown' ? (
      <ContextBreakdownDisplay
        systemPromptTokens={item.systemPromptTokens}
        systemToolsTokens={item.systemToolsTokens}
        memoryFilesTokens={item.memoryFilesTokens}
        messagesTokens={item.messagesTokens}
        reservedTokens={item.reservedTokens}
        totalInputTokens={item.totalInputTokens}
        freeSpaceTokens={item.freeSpaceTokens}
        maxTokens={item.maxTokens}
      />
    ) : null}
    {item.type === 'quit' ? <SessionSummaryDisplay duration={item.duration} credits={item.credits} config={config} /> : null}
    {item.type === 'tool_group' ? (() => {
      const filteredTools = item.tools.filter((t) => t.toolId !== 'todo_write');
      if (filteredTools.length === 0) return null;
      return (
        <ToolGroupMessage
          toolCalls={filteredTools}
          groupId={item.id}
          availableTerminalHeight={availableTerminalHeight}
          terminalWidth={terminalWidth}
          config={config}
          isFocused={isFocused}
        />
      );
    })() : null}
    {item.type === 'compression' ? (
      <CompressionMessage compression={item.compression} />
    ) : null}
    {item.type === 'help' ? (
      <Help commands={item.commands ?? []} />
    ) : null}
  </Box>
), (prev, next) => {
  // 自定义比较逻辑，提高性能
  // 🔧 修复: 对于 tool_group 类型，需要检查工具状态和输出变化
  if (prev.item.type === 'tool_group' && next.item.type === 'tool_group') {
    // 检查工具数量是否变化
    if (prev.item.tools.length !== next.item.tools.length) return false;
    // 检查每个工具的状态和输出是否变化
    for (let i = 0; i < prev.item.tools.length; i++) {
      const prevTool = prev.item.tools[i];
      const nextTool = next.item.tools[i];
      if (prevTool.status !== nextTool.status) return false;
      if (prevTool.callId !== nextTool.callId) return false;
      // 🔧 关键修复: 检查 resultDisplay 变化，这对于实时输出至关重要
      if (prevTool.resultDisplay !== nextTool.resultDisplay) return false;
    }
  }

  return prev.item.id === next.item.id &&
         prev.item.text === next.item.text &&
         prev.isPending === next.isPending &&
         prev.terminalWidth === next.terminalWidth &&
         prev.isFocused === next.isFocused;
});