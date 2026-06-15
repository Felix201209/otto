/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/EasyCode
 * SPDX-License-Identifier: Apache-2.0
 */

import { Type } from '@google/genai';
import { BaseTool, Icon, type ToolResult } from './tools.js';
import { type Config } from '../config/config.js';
import { getBackgroundTaskManager } from '../services/backgroundTaskManager.js';
import { extractCompactSummary, isAcpDelegateTask } from './delegate-agent.js';

/** Parameters for {@link CheckDelegateStatusTool}. */
export interface CheckDelegateStatusParams {
  /** The Task ID returned by delegate_to_agent. */
  taskId: string;
}

/** Result shape for {@link CheckDelegateStatusTool}. */
export interface CheckDelegateStatusResult extends ToolResult {
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'not_found';
}

/**
 * Query the status and progress of a background Claude Code task.
 * Use this when you need to check on a delegated task that is still running.
 */
export class CheckDelegateStatusTool extends BaseTool<
  CheckDelegateStatusParams,
  CheckDelegateStatusResult
> {
  static readonly Name: string = 'check_delegate_status';

  constructor(private readonly config: Config) {
    super(
      CheckDelegateStatusTool.Name,
      'CheckDelegateStatus',
      [
        "Query the current status and progress of a background Claude Code task.",
        '',
        'Use this to check on a task you previously delegated with delegate_to_agent.',
        'You do NOT need to check repeatedly — the system will notify you when the task completes.',
        'Only use this if you specifically need to know the current progress before continuing your work.',
        '',
        'Returns: task status (running/completed/failed/cancelled) + recent activity summary.',
      ].join('\n'),
      Icon.Info,
      {
        type: Type.OBJECT,
        properties: {
          taskId: {
            type: Type.STRING,
            description:
              'The Task ID returned by the delegate_to_agent tool.',
          },
        },
        required: ['taskId'],
      },
      true, // isOutputMarkdown
      false, // forceMarkdown
      false, // canUpdateOutput
      false, // allowSubAgentUse
    );
  }

  validateToolParams(params: CheckDelegateStatusParams): string | null {
    if (!params.taskId || typeof params.taskId !== 'string' || params.taskId.trim() === '') {
      return 'Parameter "taskId" must be a non-empty string.';
    }
    return null;
  }

  getDescription(params: CheckDelegateStatusParams): string {
    return `Checking status of delegate task ${params.taskId}`;
  }

  async execute(
    params: CheckDelegateStatusParams,
    _signal: AbortSignal,
  ): Promise<CheckDelegateStatusResult> {
    const validationError = this.validateToolParams(params);
    if (validationError) {
      return {
        status: 'not_found',
        llmContent: JSON.stringify({ status: 'not_found', error: validationError }),
        returnDisplay: `Validation failed: ${validationError}`,
        summary: 'Failed',
      };
    }

    const taskManager = getBackgroundTaskManager();
    const task = taskManager.getTask(params.taskId);

    if (!task || !isAcpDelegateTask(task)) {
      return {
        status: 'not_found',
        llmContent: JSON.stringify({
          status: 'not_found',
          taskId: params.taskId,
          error: 'No delegated agent task found with this ID.',
        }),
        returnDisplay: `No delegated agent task found with ID: ${params.taskId}`,
        summary: 'Not found',
      };
    }

    const duration = Math.round((Date.now() - task.startTime) / 1000);
    const isFinished = task.status !== 'running';

    let progressText = '';
    if (isFinished) {
      // Task is done — return the final result.
      if (task.answer?.trim()) {
        const trimmed = task.answer.length > 2000
          ? task.answer.slice(0, 2000) + '…'
          : task.answer;
        progressText = trimmed;
      } else if (task.output?.trim()) {
        progressText = extractCompactSummary(task.output, 1500);
      }
      if (task.error) {
        progressText += `\n\n⚠️ Error: ${task.error.slice(0, 500)}`;
      }
    } else {
      // Task is still running — give a progress snapshot.
      progressText = formatProgressSnapshot(task.output, duration);
    }

    const icon = isFinished
      ? task.status === 'completed' ? '✅'
        : task.status === 'failed' ? '❌'
        : '⏹️'
      : '⏳';

    return {
      status: task.status,
      llmContent: JSON.stringify({
        status: task.status,
        taskId: task.id,
        duration,
        answer: isFinished ? task.answer : undefined,
        error: task.error,
      }),
      returnDisplay:
        `${icon} Claude Code Task ${task.id} — ${task.status} (${duration}s)\n\n${progressText || '(no output yet)'}`,
      summary: `Task ${task.id}: ${task.status} (${duration}s)`,
    };
  }
}

/**
 * Build a compact progress snapshot from the task's accumulated output.
 * Shows recent tool calls and the tail of the transcript.
 */
function formatProgressSnapshot(output: string, durationSec: number): string {
  if (!output.trim()) {
    return `Task has been running for ${durationSec}s. No output yet — likely still starting up.`;
  }

  const lines = output.split('\n');
  const recentLines: string[] = [];
  let len = 0;
  const maxLen = 1500;

  // Take the last N lines (most recent activity).
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (len + line.length + 1 > maxLen) break;
    recentLines.unshift(line);
    len += line.length + 1;
  }

  // Count tool calls for a quick progress indicator.
  const toolCallCount = (output.match(/^[📖✏️🗑️📦🔍⚡💭🌐🔄🔧✅⚠️]/gu) || []).length;

  return `Running for ${durationSec}s | ${toolCallCount} tool calls so far\n\n--- Recent activity ---\n${recentLines.join('\n')}`;
}
