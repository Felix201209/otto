/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { IndividualToolCallDisplay, ToolCallStatus } from '../../types.js';
import { ToolMessage } from './ToolMessage.js';
import { ToolConfirmationMessage } from './ToolConfirmationMessage.js';
import { Config } from 'otto-core';
import { SHELL_COMMAND_NAME } from '../../constants.js';
import { tp, getLocalizedToolName } from '../../utils/i18n.js';
import { Colors } from '../../colors.js';
import { selectAggregatedToolGroup } from './toolGroupAggregate.js';

interface ToolGroupMessageProps {
  groupId: number;
  toolCalls: IndividualToolCallDisplay[];
  availableTerminalHeight?: number;
  terminalWidth: number;
  config?: Config;
  isFocused?: boolean;
}

/**
 * 🎨 隐形边框：所有边框字符都是空格。
 *
 * 之所以不直接 borderStyle={undefined}（即彻底去掉边框），是为了保持原有的
 * 区域占位逻辑完全不变 —— boxWidth / innerWidth / staticHeight 等计算都依赖
 * “有边框时左右各占 1 列、上下各占 1 行”这一前提。改用全空格的自定义 BoxStyle
 * 后，布局尺寸和对齐一字不差，只是边框在视觉上隐形了。
 */
const INVISIBLE_BORDER = {
  topLeft: ' ',
  top: ' ',
  topRight: ' ',
  right: ' ',
  bottomRight: ' ',
  bottom: ' ',
  bottomLeft: ' ',
  left: ' ',
} as const;

// Main component renders the border and maps the tools using ToolMessage
export const ToolGroupMessage: React.FC<ToolGroupMessageProps> = ({
  toolCalls,
  availableTerminalHeight,
  terminalWidth,
  config,
  isFocused = true,
}) => {
  const hasPending = !toolCalls.every(
    (t) => t.status === ToolCallStatus.Success,
  );
  const isShellCommand = toolCalls.some((t) => t.name === SHELL_COMMAND_NAME);

  // 🎯 检查是否有 Shell 命令正在执行或等待执行
  const isShellExecuting = toolCalls.some(
    (t) => t.name === SHELL_COMMAND_NAME &&
           (t.status === ToolCallStatus.Executing || t.status === ToolCallStatus.Pending)
  );

  // 🔧 移除隐形边框和左边距，使工具调用与普通文字的圆点完美对齐
  const staticHeight = 1; // 仅占位高度计算使用
  const boxWidth = terminalWidth;
  const innerWidth = terminalWidth;

  // 🎯 递归查找需要确认的工具（包括嵌套的subToolCalls）
  const findConfirmingTool = (tools: typeof toolCalls): typeof toolCalls[0] | undefined => {
    for (const tool of tools) {
      if (tool.status === ToolCallStatus.Confirming) {
        return tool;
      }
      // 递归查找子工具调用
      if (tool.subToolCalls && tool.subToolCalls.length > 0) {
        const foundInSub = findConfirmingTool(tool.subToolCalls);
        if (foundInSub) return foundInSub;
      }
    }
    return undefined;
  };

  const toolAwaitingApproval = useMemo(
    () => findConfirmingTool(toolCalls),
    [toolCalls],
  );

  // 🎯 连续同批读文件聚合：当一个 tool_group 里全是已成功、无确认/无子工具的
  //    read_file 时，折叠成一个紧凑的「Reading N files…」块，每个文件作为子行，
  //    而不是为每个文件各画一个独立的工具块。纯渲染层处理，不改 history 数据。
  const aggregated = useMemo(
    () => selectAggregatedToolGroup(toolCalls),
    [toolCalls],
  );

  let countToolCallsWithResults = 0;
  for (const tool of toolCalls) {
    if (tool.resultDisplay !== undefined && tool.resultDisplay !== '') {
      countToolCallsWithResults++;
    }
  }
  const countOneLineToolCalls = toolCalls.length - countToolCallsWithResults;

  // 🔧 优化：智能分配每个工具消息的高度
  const availableTerminalHeightPerToolMessage = availableTerminalHeight
    ? (() => {
        // 计算可分配的高度
        const allocatableHeight = availableTerminalHeight - staticHeight - countOneLineToolCalls;

        // 平均分配
        const averageHeight = Math.floor(allocatableHeight / Math.max(1, countToolCallsWithResults));

        // 🔧 关键优化：为 Shell 命令设置更合理的高度上限
        // - Shell 命令通常是单个工具调用，避免分配过多高度导致内容稀疏
        // - 限制最大高度为 20 行（对于大部分 shell 输出足够）
        const maxHeightForSingleTool = isShellCommand ? 20 : Math.floor(availableTerminalHeight * 0.8);

        // 返回最终高度：至少 1 行，最多 maxHeightForSingleTool
        return Math.max(Math.min(averageHeight, maxHeightForSingleTool), 1);
      })()
    : undefined;

  return (
    <Box
      flexDirection="column"
      /*
        🔧 移除隐形边框和左边距，使工具调用与普通文字的圆点完美对齐，去除了之前那一圈隐形边框的占位。
      */
      width={boxWidth}
    >
      {aggregated ? (
        /* 🎯 聚合形式：Reading N files… + 每个文件一行（带 ⎿/缩进），紧凑展示 */
        <Box flexDirection="column">
          <Text>
            <Text color={Colors.Foreground} bold>
              {getLocalizedToolName('ReadFile')}
            </Text>
            <Text color={Colors.Gray}>
              {'  '}
              {tp('tool.aggregate.reading_files', {
                count: aggregated.items.length,
              })}
            </Text>
          </Text>
          {aggregated.items.map((item, i) => (
            <Box key={`${item}-${i}`} flexDirection="row">
              <Text color={Colors.Gray} dimColor>{i === 0 ? '  └ ' : '    '}</Text>
              <Text color={Colors.Gray} dimColor>{item}</Text>
            </Box>
          ))}
        </Box>
      ) : (
        toolCalls.map((tool, index) => {
        const isCurrentToolAwaitingApproval = toolAwaitingApproval?.callId === tool.callId;
        return (
          <Box key={tool.callId} flexDirection="column" minHeight={1} marginTop={index > 0 ? 1 : 0}>
            <Box flexDirection="row" alignItems="center">
              <ToolMessage
                callId={tool.callId}
                name={tool.name}
                toolId={tool.toolId}
                description={tool.description}
                resultDisplay={tool.resultDisplay}
                status={tool.status}
                confirmationDetails={tool.confirmationDetails}
                availableTerminalHeight={availableTerminalHeightPerToolMessage}
                terminalWidth={innerWidth}
                emphasis={
                  isCurrentToolAwaitingApproval
                    ? 'high'
                    : toolAwaitingApproval
                      ? 'low'
                      : 'medium'
                }
                renderOutputAsMarkdown={tool.renderOutputAsMarkdown}
                forceMarkdown={tool.forceMarkdown}
                batchSubTools={tool.batchSubTools}
              />
            </Box>
          </Box>
        );
        })
      )}

      {/* 🎯 全局确认框 - 显示在底部，处理任意层级的确认 */}
      {toolAwaitingApproval && toolAwaitingApproval.confirmationDetails && (
        <Box marginTop={1}>
          <ToolConfirmationMessage
            confirmationDetails={toolAwaitingApproval.confirmationDetails}
            config={config}
            isFocused={true}
            availableTerminalHeight={availableTerminalHeightPerToolMessage}
            terminalWidth={innerWidth}
            showTitle={
              // 🎯 判断是否为子Agent工具：检查是否在某个工具的subToolCalls中
              toolCalls.some(tool =>
                tool.subToolCalls?.some(subTool =>
                  subTool.callId === toolAwaitingApproval.callId
                )
              )
            }
          />
        </Box>
      )}
    </Box>
  );
};
