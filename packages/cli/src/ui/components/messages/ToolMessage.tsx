/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box,Text } from 'ink';
import type {
  FileDiff,
  GoalAchievedDisplay,
  GoalRejectedDisplay,
  McpThinkingDisplay,
  SubAgentDisplay,
  TodoDisplay,
  VisualDisplay,
} from 'otto-core';
import React from 'react';
import { Colors } from '../../colors.js';
import { useSmallWindowOptimization,WindowSizeLevel } from '../../hooks/useSmallWindowOptimization.js';
import { IndividualToolCallDisplay,ToolCallStatus } from '../../types.js';
import { getLocalizedToolName,isChineseLocale,t } from '../../utils/i18n.js';
import { truncateText } from '../../utils/textTruncator.js';
import { OttoRespondingSpinner } from '../OttoRespondingSpinner.js';
import { MaxSizedBox } from '../shared/MaxSizedBox.js';
import { DiffRenderer } from './DiffRenderer.js';
import { GoalAchievedDisplayRenderer } from './GoalAchievedDisplayRenderer.js';
import { GoalRejectedDisplayRenderer } from './GoalRejectedDisplayRenderer.js';
import { McpThinkingDisplayRenderer } from './McpThinkingDisplayRenderer.js';
import { SubAgentDisplayRenderer } from './SubAgentDisplayRenderer.js';
import { TodoSummaryLine } from './TodoDisplayRenderer.js';
import { summarizeToolConversation } from './toolConversationSummary.js';
import { shouldCollapseToolResult } from './toolResultCollapse.js';

const STATIC_HEIGHT = 1;
const RESERVED_LINE_COUNT = 5; // for tool name, status, padding etc.
const STATUS_INDICATOR_WIDTH = 3;
// 树形子项缩进 2 列，让 '└ ' 的 '└' 正落在状态 bullet '•' 之下，对齐成一条隐形竖线
const RESULT_DISPLAY_INDENT = 2;
const MIN_LINES_SHOWN = 2; // show at least this many lines

// Large threshold to ensure we don't cause performance issues for very large
// outputs that will get truncated further MaxSizedBox anyway.
const MAXIMUM_RESULT_DISPLAY_CHARACTERS = 1000000;

type SubAgentUpdateDisplay = Extract<VisualDisplay, { type: 'subagent_update' }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFileDiffDisplay(value: unknown): value is FileDiff {
  return isRecord(value) && typeof value.fileDiff === 'string';
}

function isTodoDisplay(value: unknown): value is TodoDisplay {
  return isRecord(value) && value.type === 'todo_display';
}

function isSubAgentDisplay(value: unknown): value is SubAgentDisplay {
  return isRecord(value) && value.type === 'subagent_display';
}

function isSubAgentUpdateDisplay(value: unknown): value is SubAgentUpdateDisplay {
  return isRecord(value) && value.type === 'subagent_update' && isSubAgentDisplay(value.data);
}

function isGoalAchievedDisplay(value: unknown): value is GoalAchievedDisplay {
  return isRecord(value) && value.type === 'goal_achieved_display';
}

function isGoalRejectedDisplay(value: unknown): value is GoalRejectedDisplay {
  return isRecord(value) && value.type === 'goal_rejected_display';
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * 分析diff内容，提取统计信息
 */
interface DiffStats {
  linesAdded: number;
  linesRemoved: number;
  linesChanged: number;
  isNewFile: boolean;
  isDeletedFile: boolean;
}

function analyzeDiffStats(diffContent: string): DiffStats {
  const lines = diffContent.split('\n');
  let linesAdded = 0;
  let linesRemoved = 0;
  let isNewFile = false;
  let isDeletedFile = false;

  // 检查文件状态
  if (diffContent.includes('new file mode')) {
    isNewFile = true;
  } else if (diffContent.includes('deleted file mode') ||
    (diffContent.includes('--- a/') && diffContent.includes('+++ /dev/null'))) {
    isDeletedFile = true;
  }

  // 统计增删行数
  for (const line of lines) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      linesAdded++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      linesRemoved++;
    }
  }

  // 计算修改行数（取增删中的较小值作为修改，剩余的作为纯增/删）
  const linesChanged = Math.min(linesAdded, linesRemoved);

  return {
    linesAdded: linesAdded - linesChanged,
    linesRemoved: linesRemoved - linesChanged,
    linesChanged,
    isNewFile,
    isDeletedFile
  };
}

/**
 * 生成简化的diff统计显示
 */
function renderSimplifiedDiffStats(stats: DiffStats, fileName: string): React.ReactNode {
  // git 风格：A/D 字母状态 + 文件名 dim + +N（绿）/-N（红），零 emoji
  if (stats.isNewFile) {
    return (
      <Box>
        <Text color={Colors.AccentGreen} bold>A</Text>
        <Text color={Colors.Gray} dimColor> {fileName}</Text>
        {stats.linesAdded > 0 && (
          <Text color={Colors.AccentGreen}> +{stats.linesAdded}</Text>
        )}
      </Box>
    );
  }

  if (stats.isDeletedFile) {
    return (
      <Box>
        <Text color={Colors.AccentRed} bold>D</Text>
        <Text color={Colors.Gray} dimColor> {fileName}</Text>
        {stats.linesRemoved > 0 && (
          <Text color={Colors.AccentRed}> -{stats.linesRemoved}</Text>
        )}
      </Box>
    );
  }

  const parts: React.ReactNode[] = [
    <Text key="file" color={Colors.Gray} dimColor>{fileName}</Text>
  ];

  if (stats.linesAdded > 0) {
    parts.push(
      <Text key="added" color={Colors.AccentGreen}> +{stats.linesAdded}</Text>
    );
  }

  if (stats.linesRemoved > 0) {
    parts.push(
      <Text key="removed" color={Colors.AccentRed}> -{stats.linesRemoved}</Text>
    );
  }

  if (stats.linesChanged > 0) {
    parts.push(
      <Text key="changed" color={Colors.AccentGreen}> ~{stats.linesChanged}</Text>
    );
  }

  if (stats.linesAdded === 0 && stats.linesRemoved === 0 && stats.linesChanged === 0) {
    parts.push(
      <Text key="no-change" color={Colors.Gray} dimColor> (无变更)</Text>
    );
  }

  return <Box>{parts}</Box>;
}
export type TextEmphasis = 'high' | 'medium' | 'low';

export interface ToolMessageProps extends IndividualToolCallDisplay {
  availableTerminalHeight?: number;
  terminalWidth: number;
  emphasis?: TextEmphasis;
  renderOutputAsMarkdown?: boolean;
  forceMarkdown?: boolean;
}

export const ToolMessage: React.FC<ToolMessageProps> = ({
  name,
  toolId,
  description,
  summary,
  resultDisplay,
  status,
  confirmationDetails: _confirmationDetails,
  availableTerminalHeight,
  terminalWidth,
  emphasis = 'medium',
  renderOutputAsMarkdown = true,
  forceMarkdown = false,
  batchSubTools,
}) => {
  const smallWindowConfig = useSmallWindowOptimization();
  // 🎯 Shell 命令正在执行或等待时显示 Ctrl+B 提示
  const isShellRunning = toolId === 'run_shell_command' &&
    (status === ToolCallStatus.Executing || status === ToolCallStatus.Pending);
  const shouldSimplifyDiff = smallWindowConfig.sizeLevel === WindowSizeLevel.SMALL ||
    smallWindowConfig.sizeLevel === WindowSizeLevel.TINY;
  const conversationSummary = summarizeToolConversation({
    toolId,
    name,
    description,
    status,
    resultDisplay,
    summary,
  });

  // 🎯 已完成的读取/搜索/列目录类工具：标题行已说明动作+目标，
  //    结果体（行数、文件清单等）是冗余确认，完成后收起，只保留标题一行。
  const collapseResult = shouldCollapseToolResult({ toolId, status, resultDisplay });

  // 🎯 为折叠成功的工具提取精简结果，优化用户界面展示
  let compactResultText = '';
  if (collapseResult && status === ToolCallStatus.Success && resultDisplay) {
    const isZh = isChineseLocale();
    if (toolId === 'read_file') {
      let lineCount = 0;
      if (typeof resultDisplay === 'string') {
        const linesMatch = resultDisplay.match(/\b(\d+)\s+lines\b/i);
        const rangeMatch = resultDisplay.match(/read\s+lines:\s*(\d+)-(\d+)/i);
        if (linesMatch) {
          lineCount = parseInt(linesMatch[1], 10);
        } else if (rangeMatch) {
          const start = parseInt(rangeMatch[1], 10);
          const end = parseInt(rangeMatch[2], 10);
          lineCount = Math.max(0, end - start + 1);
        } else {
          lineCount = resultDisplay.split('\n').length;
        }
      }
      compactResultText = isZh ? `(读了 ${lineCount} 行)` : `(${lineCount} lines read)`;
    } else if (toolId === 'search_file_content') {
      if (typeof resultDisplay === 'string') {
        const match = resultDisplay.match(/Found (\d+) matches/i);
        if (match) {
          const count = match[1];
          compactResultText = isZh ? `(匹配到 ${count} 个)` : `(${count} matches found)`;
        } else if (resultDisplay.includes('No matches found')) {
          compactResultText = isZh ? `(未找到匹配)` : `(No matches found)`;
        } else {
          compactResultText = `(${resultDisplay})`;
        }
      }
    } else if (toolId === 'read_many_files') {
      if (typeof resultDisplay === 'string') {
        const match = resultDisplay.match(/content from \*\*(\d+) file/i) ||
                      resultDisplay.match(/content from \*\*(\d+)\*\* file/i) ||
                      resultDisplay.match(/Successfully read and concatenated content from \*\*(\d+) file/i) ||
                      resultDisplay.match(/(\d+) file\(s\)/i);
        if (match) {
          const count = match[1];
          compactResultText = isZh ? `(读取了 ${count} 个文件)` : `(${count} files read)`;
        } else {
          compactResultText = isZh ? `(多文件读取完成)` : `(Files read completed)`;
        }
      }
    } else if (toolId === 'glob') {
      if (typeof resultDisplay === 'string') {
        const match = resultDisplay.match(/Found (\d+) matching/i);
        if (match) {
          const count = match[1];
          compactResultText = isZh ? `(找到 ${count} 个匹配文件)` : `(${count} matching files found)`;
        } else {
          compactResultText = `(${resultDisplay})`;
        }
      }
    } else if (toolId === 'list_directory') {
      if (typeof resultDisplay === 'string') {
        const match = resultDisplay.match(/Listed (\d+) item/i);
        if (match) {
          const count = match[1];
          compactResultText = isZh ? `(列出 ${count} 个子项)` : `(${count} items listed)`;
        } else {
          compactResultText = `(${resultDisplay})`;
        }
      }
    } else if (toolId === 'web_search' || toolId === 'web_fetch') {
      if (typeof resultDisplay === 'string') {
        compactResultText = `(${resultDisplay})`;
      }
    }
  }

  const availableHeight = availableTerminalHeight
    ? Math.max(
      availableTerminalHeight - STATIC_HEIGHT - RESERVED_LINE_COUNT,
      MIN_LINES_SHOWN + 1, // enforce minimum lines shown
    )
    : undefined;

  // Long tool call response in MarkdownDisplay doesn't respect availableTerminalHeight properly,
  // we're forcing it to not render as markdown when the response is too long, it will fallback
  // to render as plain text, which is contained within the terminal using MaxSizedBox
  // However, if forceMarkdown is true, we skip this override
  if (availableHeight && !forceMarkdown) {
    renderOutputAsMarkdown = false;
  }

  const childWidth = terminalWidth - 2; // account for right padding and safety.

  // Special handling for Sequential thinking - convert to mcp_thinking_display
  const normalizedToolName = name?.toLowerCase().replace(/[_-]/g, '');
  let thinkingDisplayData: McpThinkingDisplay | null = null;

  if (normalizedToolName?.includes('sequentialthinking')) {
    // Try to parse thinking data from description
    try {
      const parsedDescription: unknown = JSON.parse(description);
      if (isRecord(parsedDescription) && parsedDescription.thought !== undefined) {
        thinkingDisplayData = {
          type: 'mcp_thinking_display',
          thought: String(parsedDescription.thought || ''),
          thoughtNumber: optionalNumber(parsedDescription.thoughtNumber),
          totalThoughts: optionalNumber(parsedDescription.totalThoughts),
          nextThoughtNeeded: optionalBoolean(parsedDescription.nextThoughtNeeded),
          isRevision: optionalBoolean(parsedDescription.isRevision),
          revisesThought: optionalNumber(parsedDescription.revisesThought),
          branchFromThought: optionalNumber(parsedDescription.branchFromThought),
          branchId: typeof parsedDescription.branchId === 'string' ? parsedDescription.branchId : undefined,
          needsMoreThoughts: optionalBoolean(parsedDescription.needsMoreThoughts),
          branches: Array.isArray(parsedDescription.branches) ? parsedDescription.branches : undefined,
          thoughtHistoryLength: optionalNumber(parsedDescription.thoughtHistoryLength),
        };
      }
    } catch {
      // Not JSON, ignore
    }
  }

  if (typeof resultDisplay === 'string') {
    if (resultDisplay.length > MAXIMUM_RESULT_DISPLAY_CHARACTERS) {
      // Truncate the result display to fit within the available width.
      resultDisplay =
        '...' + resultDisplay.slice(-MAXIMUM_RESULT_DISPLAY_CHARACTERS);
    }
  }
  const structuredResult: VisualDisplay | FileDiff | null =
    typeof resultDisplay === 'object' && resultDisplay !== null
      ? resultDisplay as VisualDisplay | FileDiff
      : null;
  return (
    <Box paddingLeft={0} paddingRight={1} paddingY={0} flexDirection="column" width={terminalWidth}>
      <Box minHeight={1} width="100%">
        <ToolStatusIndicator status={status} />
        <ToolInfo
          name={name}
          status={status}
          description={description}
          conversationSummary={conversationSummary}
          emphasis={emphasis}
          terminalWidth={terminalWidth - 1} // 减去 paddingRight={1} 的一列
          compactResultText={conversationSummary ? undefined : compactResultText} // 🎯 传递精简结果
        />
        {emphasis === 'high' ? <TrailingIndicator /> : null}
      </Box>
      {/* 🎯 Show Ctrl+B prompt for shell commands when executing - below title */}
      {isShellRunning ? (
        <Box paddingLeft={RESULT_DISPLAY_INDENT}>
          <Text color={Colors.Gray}>{t('shell.background.hint')}</Text>
        </Box>
      ) : null}
      {/* 🎯 Batch 工具：显示子工具调用列表 */}
      {batchSubTools && batchSubTools.length > 0 ? (
        <Box paddingLeft={RESULT_DISPLAY_INDENT} flexDirection="column">
          {batchSubTools.map((subTool, index) => (
            <Box key={index} flexDirection="row">
              <Text color={Colors.Gray} dimColor>{'└ '}</Text>
              <Text color={Colors.Foreground}>
                {getLocalizedToolName(subTool.displayName)}
              </Text>
              {subTool.summary ? (
                <Text color={Colors.Gray} dimColor> {subTool.summary}</Text>
              ) : null}
            </Box>
          ))}
        </Box>
      ) : null}
      {/* Show thinking display if available */}
      {thinkingDisplayData ? (
        <Box paddingLeft={RESULT_DISPLAY_INDENT} width="100%">
          <Box flexDirection="column">
            <Box flexDirection="row">
              <Text color={Colors.Gray}>└ </Text>
              <Box flexGrow={1}>
                <McpThinkingDisplayRenderer data={thinkingDisplayData} />
              </Box>
            </Box>
          </Box>
        </Box>
      ) : null}
      {/* 🎯 后台运行状态专用显示（仿 Claude Code 风格）- 不显示 resultDisplay */}
      {!thinkingDisplayData && status === ToolCallStatus.BackgroundRunning ? (
        <Box paddingLeft={RESULT_DISPLAY_INDENT} width="100%">
          <Text wrap="wrap" color={Colors.Gray}>
            <Text color={Colors.Gray}>└ </Text>
            {t('background.task.running.hint')}
          </Text>
        </Box>
      ) : null}
      {/* Show regular resultDisplay if no thinking display and NOT background running */}
      {!thinkingDisplayData && resultDisplay && status !== ToolCallStatus.BackgroundRunning && !collapseResult ? (
        <Box paddingLeft={RESULT_DISPLAY_INDENT} width="100%">
          <Box flexDirection="column">
            {typeof resultDisplay === 'string' && renderOutputAsMarkdown ? (
              <Text wrap="wrap">
                <Text color={Colors.Gray}>└ </Text>
                {resultDisplay}
              </Text>
            ) : null}
            {typeof resultDisplay === 'string' && !renderOutputAsMarkdown ? (
              (() => {
                // 🔧 修复闪屏：执行中限制高度，完成后扩大限制（兼容Windows）
                // Windows平台对大文本写入更敏感，需要保留MaxSizedBox但放宽限制
                const maxRows = availableHeight !== undefined
                  ? (status === ToolCallStatus.Executing ? availableHeight : availableHeight * 3)
                  : 20;

                const truncated = truncateText(resultDisplay, {
                  maxRows,
                  terminalWidth: childWidth,
                });

                if (truncated.isTruncated) {
                  const parts = truncated.displayText.split(truncated.omittedPlaceholder || '');
                  return (
                    <Box flexDirection="column">
                      <Text wrap="wrap" color={Colors.Gray}>
                        <Text color={Colors.Gray}>└ </Text>
                        {parts[0]}
                      </Text>
                      <Text color={Colors.Gray} wrap="truncate">
                        ... omitted {truncated.omittedLines} lines ...
                      </Text>
                      {parts[1] ? <Text wrap="wrap" color={Colors.Gray}>{parts[1]}</Text> : null}
                    </Box>
                  );
                }

                return (
                  availableHeight !== undefined ? (
                    <MaxSizedBox maxWidth={childWidth} maxHeight={maxRows} overflowDirection="top">
                      <Box>
                        <Text wrap="wrap" color={Colors.Gray}>
                          <Text color={Colors.Gray}>└ </Text>
                          {resultDisplay}
                        </Text>
                      </Box>
                    </MaxSizedBox>
                  ) : (
                    <Text wrap="wrap" color={Colors.Gray}>
                      <Text color={Colors.Gray}>└ </Text>
                      {resultDisplay}
                    </Text>
                  )
                );
              })()
            ) : null}
            {isFileDiffDisplay(structuredResult) ? (
              <Box flexDirection="row">
                <Text color={Colors.Gray}>└ </Text>
                <Box flexGrow={1}>
                  {shouldSimplifyDiff ? (
                    renderSimplifiedDiffStats(
                      analyzeDiffStats(structuredResult.fileDiff),
                      structuredResult.fileName || '未知文件'
                    )
                  ) : (
                    <DiffRenderer
                      diffContent={structuredResult.fileDiff}
                      filename={structuredResult.fileName}
                      availableTerminalHeight={availableHeight}
                      terminalWidth={childWidth - 2}
                    />
                  )}
                </Box>
              </Box>
            ) : null}

            {isTodoDisplay(structuredResult) ? (
              <Box flexDirection="row">
                <Text color={Colors.Gray}>└ </Text>
                <Box flexGrow={1}>
                  <TodoSummaryLine data={structuredResult} />
                </Box>
              </Box>
            ) : null}
            {isSubAgentDisplay(structuredResult) ? (
              <Box flexDirection="row">
                <Text color={Colors.Gray}>└ </Text>
                <Box flexGrow={1}>
                  <SubAgentDisplayRenderer data={structuredResult} />
                </Box>
              </Box>
            ) : null}
            {isSubAgentUpdateDisplay(structuredResult) ? (
              <Box flexDirection="row">
                <Text color={Colors.Gray}>└ </Text>
                <Box flexGrow={1}>
                  <SubAgentDisplayRenderer data={structuredResult.data} />
                </Box>
              </Box>
            ) : null}
            {isGoalAchievedDisplay(structuredResult) ? (
              <Box flexDirection="row">
                <Text color={Colors.Gray}>└ </Text>
                <Box flexGrow={1}>
                  <GoalAchievedDisplayRenderer data={structuredResult} />
                </Box>
              </Box>
            ) : null}
            {isGoalRejectedDisplay(structuredResult) ? (
              <Box flexDirection="row">
                <Text color={Colors.Gray}>└ </Text>
                <Box flexGrow={1}>
                  <GoalRejectedDisplayRenderer data={structuredResult} />
                </Box>
              </Box>
            ) : null}
          </Box>
        </Box>
      ) : null}
    </Box>
  );
};

type ToolStatusIndicatorProps = {
  status: ToolCallStatus;
};

const ToolStatusIndicator: React.FC<ToolStatusIndicatorProps> = ({
  status,
}) => (
  <Box minWidth={STATUS_INDICATOR_WIDTH}>
    {/* 统一字形 •，状态靠颜色编码：success 绿 / error 红 bold / pending dim /
        canceled dim+删除线 / subagent 青 / executing spinner（静止态也是 •） */}
    {status === ToolCallStatus.Pending ? (
      <Text color={Colors.Gray} dimColor>•</Text>
    ) : null}
    {status === ToolCallStatus.Executing ? (
      <OttoRespondingSpinner
        nonRespondingDisplay={'•'}
      />
    ) : null}
    {status === ToolCallStatus.SubAgentRunning ? (
      <Text color={Colors.AccentCyan}>•</Text>
    ) : null}
    {status === ToolCallStatus.BackgroundRunning ? (
      <Text color={Colors.AccentCyan}>•</Text>
    ) : null}
    {status === ToolCallStatus.Success ? (
      <Text color={Colors.AccentGreen}>•</Text>
    ) : null}
    {status === ToolCallStatus.Confirming ? (
      <Text color={Colors.AccentCyan}>•</Text>
    ) : null}
    {status === ToolCallStatus.Canceled ? (
      <Text color={Colors.Gray} dimColor strikethrough>
        •
      </Text>
    ) : null}
    {status === ToolCallStatus.Error ? (
      <Text color={Colors.AccentRed} bold>
        •
      </Text>
    ) : null}
  </Box>
);

type ToolInfoProps = {
  name: string;
  description: string;
  conversationSummary: string;
  status: ToolCallStatus;
  emphasis: TextEmphasis;
  terminalWidth: number;
  compactResultText?: string; // 🎯 新增：精简结果文本
};
const ToolInfo: React.FC<ToolInfoProps> = ({
  name,
  description,
  conversationSummary,
  status,
  emphasis,
  terminalWidth,
  compactResultText, // 🎯 新增：接收精简结果文本
}) => {
  // Special handling for Sequential thinking tool - show summary instead of full thought
  let displayDescription = conversationSummary || description;
  const normalizedToolName = name?.toLowerCase().replace(/[_-]/g, '');
  if (normalizedToolName?.includes('sequentialthinking') && description?.includes('thought')) {
    try {
      const parsed = JSON.parse(description);
      if (parsed.thoughtNumber && parsed.totalThoughts) {
        // Show a summary like "Step 1/5" or "步骤 1/5"
        const stepText = isChineseLocale() ? '步骤' : 'Step';
        displayDescription = `${stepText} ${parsed.thoughtNumber}/${parsed.totalThoughts}`;
      }
    } catch {
      // If parsing fails, use original description
    }
  }

  const nameColor = React.useMemo<string>(() => {
    switch (emphasis) {
      case 'high':
        return Colors.Foreground;
      case 'medium':
        return Colors.Foreground;
      case 'low':
        return Colors.Gray;
      default: {
        const exhaustiveCheck: never = emphasis;
        return exhaustiveCheck;
      }
    }
  }, [emphasis]);
  if (normalizedToolName?.includes('sequentialthinking')) {
    console.log('🖼️ [ToolInfo] RENDERING with displayDescription:', displayDescription.substring(0, 100));
  }

  // 计算文本区域的可用宽度：
  // terminalWidth 是 ToolMessage 接收到的宽度 (由 ToolGroupMessage 计算给出)
  // 减去左边状态指示器的宽度 STATUS_INDICATOR_WIDTH(3)
  // 减去右边 TrailingIndicator(←) 的宽度 (如果存在且 emphasis === 'high'，约占2列)
  const textWidth = terminalWidth - STATUS_INDICATOR_WIDTH - (emphasis === 'high' ? 2 : 0);

  return (
    <Box width={textWidth}>
      <Text
        wrap="wrap"
        color={Colors.Gray}
        strikethrough={status === ToolCallStatus.Canceled}
      >
        <Text color={nameColor} bold>
          {getLocalizedToolName(name)}
        </Text>{' '}
        {displayDescription}
        {compactResultText ? (
          <Text color={Colors.Gray} bold={false}>
            {' '}{compactResultText}
          </Text>
        ) : null}
      </Text>
    </Box>
  );
};

const TrailingIndicator: React.FC = () => (
  <Text color={Colors.Foreground} wrap="truncate">
    {' '}
    ←
  </Text>
);
