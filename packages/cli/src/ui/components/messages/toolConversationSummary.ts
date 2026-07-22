/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolResultDisplay } from 'otto-core';
import {
  summarizeUserVisibleTool,
  summarizeUserVisibleToolGroup,
  type UserVisibleToolStatus,
} from 'otto-core';
import { IndividualToolCallDisplay, ToolCallStatus } from '../../types.js';

export interface ToolConversationSummaryInput {
  toolId: string;
  name: string;
  description: string;
  status: ToolCallStatus;
  resultDisplay?: ToolResultDisplay;
  summary?: string;
}

function resultText(resultDisplay: ToolResultDisplay | undefined): string {
  return typeof resultDisplay === 'string' ? resultDisplay : '';
}

function toUserVisibleStatus(status: ToolCallStatus): UserVisibleToolStatus {
  switch (status) {
    case ToolCallStatus.Pending:
      return 'pending';
    case ToolCallStatus.Executing:
      return 'executing';
    case ToolCallStatus.BackgroundRunning:
      return 'background_running';
    case ToolCallStatus.SubAgentRunning:
      return 'subagent_running';
    case ToolCallStatus.Confirming:
      return 'confirming';
    case ToolCallStatus.Success:
      return 'success';
    case ToolCallStatus.Error:
      return 'error';
    case ToolCallStatus.Canceled:
      return 'canceled';
    default:
      return 'running';
  }
}

export function summarizeToolConversation(
  input: ToolConversationSummaryInput,
): string {
  return summarizeUserVisibleTool({
    toolId: input.toolId,
    name: input.name,
    description: input.description,
    status: toUserVisibleStatus(input.status),
    resultText: resultText(input.resultDisplay),
    summary: input.summary,
  });
}

export function summarizeToolGroupConversation(
  tools: IndividualToolCallDisplay[],
): string | null {
  return summarizeUserVisibleToolGroup(
    tools.map((tool) => ({
      toolId: tool.toolId,
      status: toUserVisibleStatus(tool.status),
    })),
  );
}
