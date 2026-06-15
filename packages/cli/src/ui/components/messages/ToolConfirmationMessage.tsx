/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { DiffRenderer } from './DiffRenderer.js';
import { Colors } from '../../colors.js';
import {
  ToolCallConfirmationDetails,
  ToolConfirmationOutcome,
  ToolExecuteConfirmationDetails,
  ToolMcpConfirmationDetails,
  ToolQuestionConfirmationDetails,
  ToolWorkflowConfirmationDetails,
  Config,
} from 'otto-core';
import {
  RadioButtonSelect,
  RadioSelectItem,
} from '../shared/RadioButtonSelect.js';
import { MaxSizedBox } from '../shared/MaxSizedBox.js';
import { AskUserQuestionMessage } from './AskUserQuestionMessage.js';
import { t, tp, getCancelConfirmationText } from '../../utils/i18n.js';
import { useSmallWindowOptimization, WindowSizeLevel } from '../../hooks/useSmallWindowOptimization.js';
import { AudioNotification, NotificationSound } from '../../../utils/audioNotification.js';

export interface ToolConfirmationMessageProps {
  confirmationDetails: ToolCallConfirmationDetails;
  config?: Config;
  isFocused?: boolean;
  availableTerminalHeight?: number;
  terminalWidth: number;
  showTitle?: boolean;
}

export const ToolConfirmationMessage: React.FC<
  ToolConfirmationMessageProps
> = ({
  confirmationDetails,
  config,
  isFocused = true,
  availableTerminalHeight,
  terminalWidth,
  showTitle = false,
}) => {
  const { onConfirm } = confirmationDetails;
  const childWidth = terminalWidth - 2; // 2 for padding
  const smallWindowConfig = useSmallWindowOptimization();

  // Workflow script preview toggle
  const [showWorkflowScript, setShowWorkflowScript] = useState(false);

  // 🎵 播放确认提示音
  useEffect(() => {
    if (isFocused) {
      AudioNotification.play(NotificationSound.CONFIRMATION_REQUIRED).catch(err => {
        console.debug('[AudioNotification] Failed to play confirmation required sound:', err);
      });
    }
  }, [isFocused]);

  // 判断是否使用横向布局：在极小窗口或可用高度不足时切换到横向
  const shouldUseHorizontalLayout = smallWindowConfig.sizeLevel === WindowSizeLevel.TINY ||
    (availableTerminalHeight !== undefined && availableTerminalHeight <= 8);

  useInput((_, key) => {
    if (!isFocused) return;
    if (key.escape) {
      onConfirm(ToolConfirmationOutcome.Cancel);
    }
  });

  // 🎯 AskUserQuestion 走独立的对话渲染 — 完整对齐 claude-code 的 "Ask User" 体验。
  // 这个分支必须在通用 switch 之前，因为它的选项/布局与其他确认类型不同。
  if (confirmationDetails.type === 'question') {
    return (
      <AskUserQuestionMessage
        details={confirmationDetails as ToolQuestionConfirmationDetails}
        isFocused={isFocused}
        isInPlanMode={!!config?.getPlanModeActive?.()}
        terminalWidth={terminalWidth}
      />
    );
  }

  const handleSelect = (item: ToolConfirmationOutcome) => {
    // Intercept "InspectScript" for workflow confirmation — toggle script preview
    if (item === ToolConfirmationOutcome.InspectScript) {
      setShowWorkflowScript(true);
      return;
    }

    // 🔧 调试日志
    console.log('[ToolConfirmationMessage] handleSelect called with:', item);

    // 🎵 播放选择完成提示音
    AudioNotification.play(NotificationSound.SELECTION_MADE).catch(err => {
      console.debug('[AudioNotification] Failed to play selection made sound:', err);
    });

    console.log('[ToolConfirmationMessage] Calling onConfirm...');
    onConfirm(item);
    console.log('[ToolConfirmationMessage] onConfirm returned');
  };

  let bodyContent: React.ReactNode | null = null; // Removed contextDisplay here
  let question: string;

  const options: Array<RadioSelectItem<ToolConfirmationOutcome>> = new Array<
    RadioSelectItem<ToolConfirmationOutcome>
  >();

  // Body content is now the DiffRenderer, passing filename to it
  // The bordered box is removed from here and handled within DiffRenderer

  function availableBodyContentHeight() {
    if (options.length === 0) {
      // This should not happen in practice as options are always added before this is called.
      throw new Error('Options not provided for confirmation message');
    }

    if (availableTerminalHeight === undefined) {
      return undefined;
    }

    // Calculate the vertical space (in lines) consumed by UI elements
    // surrounding the main body content.
    const PADDING_OUTER_Y = 2; // Main container has `padding={1}` (top & bottom).
    const MARGIN_BODY_BOTTOM = 1; // margin on the body container.
    const HEIGHT_QUESTION = 1; // The question text is one line.
    const MARGIN_QUESTION_BOTTOM = 1; // Margin on the question container.
    // 横向布局时选项只占用1行，垂直布局时占用options.length行
    const HEIGHT_OPTIONS = shouldUseHorizontalLayout ? 1 : options.length;

    const surroundingElementsHeight =
      PADDING_OUTER_Y +
      MARGIN_BODY_BOTTOM +
      HEIGHT_QUESTION +
      MARGIN_QUESTION_BOTTOM +
      HEIGHT_OPTIONS;
    return Math.max(availableTerminalHeight - surroundingElementsHeight, 1);
  }
  if (confirmationDetails.type === 'edit') {
    if (confirmationDetails.isModifying) {
      return (
        <Box
          minWidth="90%"
          borderStyle="single"
          borderColor={Colors.Gray}
          borderDimColor={true}
          justifyContent="space-around"
          padding={1}
          overflow="hidden"
        >
          <Text>{t('tool.confirmation.modifying')}</Text>
          <Text color={Colors.AccentGreen}>
            {t('tool.confirmation.save.editor')}
          </Text>
        </Box>
      );
    }

    question = t('tool.confirmation.apply.changes');

    // 统一提供完整选项，只在标签上做紧凑优化
    if (shouldUseHorizontalLayout || smallWindowConfig.sizeLevel === WindowSizeLevel.TINY) {
      // 横向布局或极小窗口：使用超级简化标签但保持完整功能
      options.push(
        {
          label: 'Once',
          value: ToolConfirmationOutcome.ProceedOnce,
        },
        {
          label: 'Always',
          value: ToolConfirmationOutcome.ProceedAlways,
        },
        {
          label: 'Project',
          value: ToolConfirmationOutcome.ProceedAlwaysProject,
        },
        {
          label: 'Edit',
          value: ToolConfirmationOutcome.ModifyWithEditor,
        },
        {
          label: 'Cancel',
          value: ToolConfirmationOutcome.Cancel
        },
      );
    } else {
      // 垂直布局：使用完整的本地化标签
      options.push(
        {
          label: t('tool.confirmation.once'),
          value: ToolConfirmationOutcome.ProceedOnce,
        },
        {
          label: t('tool.confirmation.type.always'),
          value: ToolConfirmationOutcome.ProceedAlways,
        },
        {
          label: t('tool.confirmation.project.always'),
          value: ToolConfirmationOutcome.ProceedAlwaysProject,
        },
        {
          label: t('tool.confirmation.modify.editor'),
          value: ToolConfirmationOutcome.ModifyWithEditor,
        },
        { label: getCancelConfirmationText(), value: ToolConfirmationOutcome.Cancel },
      );
    }

    // 小窗口下简化diff显示
    if (smallWindowConfig.sizeLevel === WindowSizeLevel.TINY || smallWindowConfig.sizeLevel === WindowSizeLevel.SMALL) {
      // 简化显示：只显示文件名和变更概要
      const fileName = confirmationDetails.fileName || 'Unknown file';
      bodyContent = (
        <Box paddingX={1} marginLeft={1}>
          <Text color={Colors.AccentCyan}>📝 {fileName}</Text>
        </Box>
      );
    } else {
      bodyContent = (
        <DiffRenderer
          diffContent={confirmationDetails.fileDiff}
          filename={confirmationDetails.fileName}
          availableTerminalHeight={availableBodyContentHeight()}
          terminalWidth={childWidth}
        />
      );
    }
  } else if (confirmationDetails.type === 'exec') {
    const executionProps =
      confirmationDetails as ToolExecuteConfirmationDetails;

    question = tp('tool.confirmation.execute', { command: executionProps.rootCommand });

    // 统一提供完整选项，只在标签上做紧凑优化
    if (shouldUseHorizontalLayout || smallWindowConfig.sizeLevel === WindowSizeLevel.TINY) {
      // 横向布局或极小窗口：使用简化标签但保持完整功能
      options.push(
        {
          label: 'Once',
          value: ToolConfirmationOutcome.ProceedOnce,
        },
        {
          label: 'Always',
          value: ToolConfirmationOutcome.ProceedAlways,
        },
        {
          label: 'Project',
          value: ToolConfirmationOutcome.ProceedAlwaysProject,
        },
        {
          label: 'Cancel',
          value: ToolConfirmationOutcome.Cancel
        },
      );
    } else {
      // 垂直布局：使用完整的本地化标签
      options.push(
        {
          label: t('tool.confirmation.once'),
          value: ToolConfirmationOutcome.ProceedOnce,
        },
        {
          label: t('tool.confirmation.type.always.exec'),
          value: ToolConfirmationOutcome.ProceedAlways,
        },
        {
          label: t('tool.confirmation.project.always'),
          value: ToolConfirmationOutcome.ProceedAlwaysProject,
        },
        { label: getCancelConfirmationText(), value: ToolConfirmationOutcome.Cancel },
      );
    }

    let bodyContentHeight = availableBodyContentHeight();
    if (bodyContentHeight !== undefined) {
      bodyContentHeight -= 2; // Account for padding;
    }
    bodyContent = (
      <Box flexDirection="column">
        <Box paddingX={1} marginLeft={1}>
          <MaxSizedBox
            maxHeight={bodyContentHeight}
            maxWidth={Math.max(childWidth - 4, 1)}
          >
            <Box>
              <Text color={Colors.AccentCyan}>{executionProps.command}</Text>
            </Box>
          </MaxSizedBox>
        </Box>
      </Box>
    );
  } else if (confirmationDetails.type === 'delete') {
    const deleteProps = confirmationDetails;

    question = t('tool.confirmation.delete.file');

    // 统一提供完整选项，只在标签上做紧凑优化
    if (shouldUseHorizontalLayout || smallWindowConfig.sizeLevel === WindowSizeLevel.TINY) {
      // 横向布局或极小窗口：使用简化标签但保持完整功能
      options.push(
        {
          label: 'Once',
          value: ToolConfirmationOutcome.ProceedOnce,
        },
        {
          label: 'Always',
          value: ToolConfirmationOutcome.ProceedAlways,
        },
        {
          label: 'Project',
          value: ToolConfirmationOutcome.ProceedAlwaysProject,
        },
        {
          label: 'Cancel',
          value: ToolConfirmationOutcome.Cancel
        },
      );
    } else {
      // 垂直布局：使用完整的本地化标签
      options.push(
        {
          label: t('tool.confirmation.once'),
          value: ToolConfirmationOutcome.ProceedOnce,
        },
        {
          label: t('tool.confirmation.type.always'),
          value: ToolConfirmationOutcome.ProceedAlways,
        },
        {
          label: t('tool.confirmation.project.always'),
          value: ToolConfirmationOutcome.ProceedAlwaysProject,
        },
        { label: getCancelConfirmationText(), value: ToolConfirmationOutcome.Cancel },
      );
    }

    // 显示删除文件的信息
    let bodyContentHeight = availableBodyContentHeight();
    if (bodyContentHeight !== undefined) {
      bodyContentHeight -= 2; // Account for padding;
    }

    bodyContent = (
      <Box flexDirection="column" paddingX={1} marginLeft={1}>
        <Text color={Colors.AccentRed}>🗑️ {deleteProps.fileName}</Text>
        <Text color={Colors.Gray}>Size: {(deleteProps.fileSize / 1024).toFixed(1)} KB</Text>
        {deleteProps.reason && (
          <Text color={Colors.AccentCyan}>Reason: {deleteProps.reason}</Text>
        )}
        {/* 显示文件内容预览 */}
        <Box marginTop={1}>
          <MaxSizedBox
            maxHeight={bodyContentHeight ? Math.max(bodyContentHeight - 4, 1) : undefined}
            maxWidth={Math.max(childWidth - 4, 1)}
          >
            <Box flexDirection="column">
              <Text color={Colors.Gray} dimColor>File content preview:</Text>
              <Text>{deleteProps.fileContent.slice(0, 200)}{deleteProps.fileContent.length > 200 ? '...' : ''}</Text>
            </Box>
          </MaxSizedBox>
        </Box>
      </Box>
    );
  } else if (confirmationDetails.type === 'info') {
    const infoProps = confirmationDetails;
    const displayUrls =
      infoProps.urls &&
      !(infoProps.urls.length === 1 && infoProps.urls[0] === infoProps.prompt);

    question = t('tool.confirmation.continue');
    options.push(
      {
        label: t('tool.confirmation.once'),
        value: ToolConfirmationOutcome.ProceedOnce,
      },
      {
        label: t('tool.confirmation.type.always'),
        value: ToolConfirmationOutcome.ProceedAlways,
      },
      {
        label: t('tool.confirmation.project.always'),
        value: ToolConfirmationOutcome.ProceedAlwaysProject,
      },
      { label: getCancelConfirmationText(), value: ToolConfirmationOutcome.Cancel },
    );

    bodyContent = (
      <Box flexDirection="column" paddingX={1} marginLeft={1}>
        <Text color={Colors.AccentCyan}>{infoProps.prompt}</Text>
        {displayUrls && infoProps.urls && infoProps.urls.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text>{t('tool.confirmation.urls.label')}</Text>
            {infoProps.urls.map((url) => (
              <Text key={url}> - {url}</Text>
            ))}
          </Box>
        )}
      </Box>
    );
  } else if (confirmationDetails.type === 'workflow') {
    const wfProps = confirmationDetails as ToolWorkflowConfirmationDetails;
    question = wfProps.title;

    if (showWorkflowScript) {
      // Script preview mode — show full script, then run or cancel
      options.push(
        { label: '1. Yes, run it', value: ToolConfirmationOutcome.ProceedOnce },
        { label: '2. No', value: ToolConfirmationOutcome.Cancel },
      );

      const scriptLines = (wfProps.rawScript ?? '').split('\n');
      bodyContent = (
        <Box flexDirection="column" paddingX={1} marginLeft={1}>
          <Box marginBottom={1}>
            <Text color={Colors.AccentCyan} bold>{wfProps.description}</Text>
            <Text dimColor>  (script preview)</Text>
          </Box>
          <Box flexDirection="column" marginBottom={1} borderStyle="round" borderColor={Colors.Gray} paddingX={1}>
            {scriptLines.map((line, i) => (
              <Text key={i}>
                <Text dimColor>{String(i + 1).padStart(3, ' ')}  </Text>
                <Text color={Colors.AccentGreen}>{line}</Text>
              </Text>
            ))}
          </Box>
          <Box marginTop={1}>
            <Text color={Colors.AccentYellow} dimColor>
              {'  ⚠ Dynamic workflows can use a lot of tokens quickly by running many subagents in parallel.'}
            </Text>
          </Box>
        </Box>
      );
    } else {
      // Default mode — phases summary + option to inspect script
      options.push(
        { label: '1. Yes, run it', value: ToolConfirmationOutcome.ProceedOnce },
        { label: '2. Inspect script', value: ToolConfirmationOutcome.InspectScript },
        { label: '3. No', value: ToolConfirmationOutcome.Cancel },
      );

      bodyContent = (
        <Box flexDirection="column" paddingX={1} marginLeft={1}>
          <Box marginBottom={1}>
            <Text color={Colors.AccentCyan} bold>{wfProps.description}</Text>
          </Box>

          {wfProps.phases.length > 0 && (
            <Box flexDirection="column" marginBottom={1}>
              <Text dimColor>{'  This dynamic workflow will spin up multiple subagents across the following phases:'}</Text>
              {wfProps.phases.map((phase, i) => (
                <Box key={i} flexDirection="column" marginLeft={2} marginTop={i === 0 ? 1 : 0}>
                  <Text>
                    <Text color={Colors.AccentYellow} bold>{`${i + 1}. ${phase.name}`}</Text>
                    {phase.description ? <Text dimColor>{` — ${phase.description}`}</Text> : null}
                  </Text>
                  {phase.agentPreviews && phase.agentPreviews.length > 0 && phase.agentPreviews.map((preview, j) => (
                    <Text key={j} dimColor>{`     · "${preview}"`}</Text>
                  ))}
                </Box>
              ))}
            </Box>
          )}

          <Box marginTop={1}>
            <Text color={Colors.AccentYellow} dimColor>
              {'  ⚠ Dynamic workflows can use a lot of tokens quickly by running many subagents in parallel.'}
            </Text>
          </Box>
        </Box>
      );
    }

    // Intercept "Inspect script" selection to toggle preview instead of calling onSelect
    // This is handled via onWorkflowSelect below at the RadioButtonSelect call site
  } else {
    // mcp tool confirmation
    const mcpProps = confirmationDetails as ToolMcpConfirmationDetails;

    bodyContent = (
      <Box flexDirection="column" paddingX={1} marginLeft={1}>
        <Text color={Colors.AccentCyan}>{t('tool.confirmation.mcp.server')}{mcpProps.serverName}</Text>
        <Text color={Colors.AccentCyan}>{t('tool.confirmation.mcp.tool')}{mcpProps.toolName}</Text>
      </Box>
    );

    question = tp('tool.confirmation.mcp.execute', { toolName: mcpProps.toolName, serverName: mcpProps.serverName });
    options.push(
      {
        label: t('tool.confirmation.once'),
        value: ToolConfirmationOutcome.ProceedOnce,
      },
      {
        label: tp('tool.confirmation.mcp.tool.always', { toolName: mcpProps.toolName, serverName: mcpProps.serverName }),
        value: ToolConfirmationOutcome.ProceedAlwaysTool, // Cast until types are updated
      },
      {
        label: tp('tool.confirmation.mcp.server.always', { serverName: mcpProps.serverName }),
        value: ToolConfirmationOutcome.ProceedAlwaysServer,
      },
      {
        label: t('tool.confirmation.project.always'),
        value: ToolConfirmationOutcome.ProceedAlwaysProject,
      },
      { label: getCancelConfirmationText(), value: ToolConfirmationOutcome.Cancel },
    );
  }

  // 紧凑型布局优化：矮终端下移除边框和多余间距
  const isCompactLayout = smallWindowConfig.sizeLevel === WindowSizeLevel.TINY ||
    smallWindowConfig.sizeLevel === WindowSizeLevel.SMALL ||
    (availableTerminalHeight !== undefined && availableTerminalHeight <= 12);

  // 根据布局模式调整间距
  const containerPadding = isCompactLayout ? 0 : 1;
  const itemMargin = isCompactLayout ? 0 : 1;

  // 矮终端下的紧凑布局 - 参考竞品设计，无边框，紧凑间距
  if (isCompactLayout) {
    // 将问题和选项放在同一行，节省垂直空间
    const compactQuestion = smallWindowConfig.sizeLevel === WindowSizeLevel.TINY
      ? (confirmationDetails.type === 'edit' ? '📝 Apply changes?' :
         confirmationDetails.type === 'exec' ? '▶ Run command?' :
         confirmationDetails.type === 'delete' ? '🗑️ Delete file?' :
         confirmationDetails.type === 'workflow' ? '⚡ Run workflow?' : question)
      : question;

    return (
      <Box flexDirection="column" width={childWidth}>
        {/* 紧凑型文件信息显示 - 仅在需要时显示 */}
        {bodyContent && (confirmationDetails.type === 'edit' || confirmationDetails.type === 'delete') && (
          <Box>
            {bodyContent}
          </Box>
        )}

        {/* 问题和选项在同一行或紧密排列 */}
        <Box flexDirection={shouldUseHorizontalLayout ? "row" : "column"} alignItems={shouldUseHorizontalLayout ? "center" : "flex-start"}>
          <Box flexShrink={0} marginRight={shouldUseHorizontalLayout ? 2 : 0}>
            <Text wrap="truncate">{compactQuestion}</Text>
          </Box>

          <Box flexShrink={0}>
            <RadioButtonSelect
              items={options}
              onSelect={handleSelect}
              isFocused={isFocused}
              showNumbers={false} // 紧凑布局下不显示数字，节省空间
              layout={shouldUseHorizontalLayout ? 'horizontal' : 'vertical'}
              horizontalSpacing={1}
            />
          </Box>
        </Box>
      </Box>
    );
  }

  // 标准布局 - 保持原有设计和边框
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={Colors.Gray}
      borderDimColor={true}
      padding={containerPadding}
      width={childWidth}
    >
      {/* 🎯 只在子Agent确认时显示标题，小窗口下隐藏 */}
      {showTitle && confirmationDetails.title && (
        <Box marginBottom={itemMargin} flexShrink={0}>
          <Text bold color={Colors.AccentCyan}>
            {confirmationDetails.title}
          </Text>
        </Box>
      )}

      {/* Body Content (Diff Renderer or Command Info) */}
      {bodyContent && (
        <Box flexGrow={1} flexShrink={1} overflow="hidden" marginBottom={itemMargin}>
          {bodyContent}
        </Box>
      )}

      {/* Confirmation Question */}
      <Box marginBottom={itemMargin} flexShrink={0}>
        <Text wrap="truncate">{question}</Text>
      </Box>

      {/* Select Input for Options */}
      <Box flexShrink={0}>
        <RadioButtonSelect
          items={options}
          onSelect={handleSelect}
          isFocused={isFocused}
          showNumbers={!shouldUseHorizontalLayout} // 横向布局下隐藏数字
          layout={shouldUseHorizontalLayout ? 'horizontal' : 'vertical'}
          horizontalSpacing={1}
        />
      </Box>
    </Box>
  );
};
