/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/EasyCode
 * SPDX-License-Identifier: Apache-2.0
 */

import { Type } from '@google/genai';
import { BaseTool, Icon, type ToolResult } from './tools.js';
import { type Config } from '../config/config.js';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { runDelegatedTask } from '../acp-client/acpAgentClient.js';
import {
  EXTERNAL_AGENT_TYPES,
  isExternalAgentType,
  resolveExternalAgentSpec,
  type ExternalAgentType,
} from '../acp-client/externalAgentRegistry.js';
import {
  getBackgroundTaskManager,
  type BackgroundTask,
} from '../services/backgroundTaskManager.js';

/** Default external agent when the caller doesn't pick one. */
const DEFAULT_AGENT: ExternalAgentType = 'claude-code';

/** Execution modes for a delegated task. */
export type DelegateMode = 'stream' | 'background';
const DELEGATE_MODES: readonly DelegateMode[] = ['stream', 'background'] as const;

/** Default mode when the caller doesn't pick one. */
const DEFAULT_MODE: DelegateMode = 'background';

/** Parameters for {@link DelegateToAgentTool}. */
export interface DelegateToAgentParams {
  /** The full task/instruction handed to the external agent. */
  task: string;
  /**
   * Absolute working directory for the delegated task. Defaults to the current
   * project root. In Feishu mode this is the chat's bound project.
   */
  cwd?: string;
  /**
   * Which external agent to delegate to. Defaults to 'claude-code' for
   * backward compatibility. Both agents run locally on the user's machine
   * via stdio ACP bridges and reuse the user's own pre-existing login.
   */
  agent?: ExternalAgentType;
  /**
   * How to run the delegated task:
   *   - 'stream' (synchronous): the tool awaits completion, streaming live
   *     progress to the calling UI (the Feishu card / CLI tool-call display).
   *     The main agent's turn blocks until the delegated agent finishes.
   *     Use when the user wants to watch the work happen (`@codex X`,
   *     `/bind --agent codex`, "立刻 / 现在 / 看看").
   *   - 'background' (default, fire-and-forget): the tool returns immediately
   *     with a Task ID and the delegated work runs in the background. The
   *     main agent can continue other work; a system notification fires when
   *     the task completes. Use for batch / "go do this while I do other
   *     stuff" semantics.
   */
  mode?: DelegateMode;
  /**
   * Resume an existing native session of the external agent instead of
   * starting fresh. Pass a `sessionId` discovered via session listing (the
   * Feishu `/acp-session` card). The external agent reloads that conversation's
   * full history before running `task`, so follow-ups keep prior context.
   */
  resumeSessionId?: string;
}

/** Result shape for {@link DelegateToAgentTool}. */
export interface DelegateToAgentResult extends ToolResult {
  status: 'success' | 'failed' | 'cancelled' | 'timed_out';
}

/**
 * Delegates a coding task to the user's local Claude Code, with Otto acting
 * as the ACP orchestrator. Claude Code runs asynchronously in the bound project —
 * the main agent is free to continue other work while the delegated task runs.
 * Completion is reported through the BackgroundTaskManager event system.
 */
export class DelegateToAgentTool extends BaseTool<
  DelegateToAgentParams,
  DelegateToAgentResult
> {
  static readonly Name: string = 'delegate_to_agent';

  constructor(private readonly config: Config) {
    super(
      DelegateToAgentTool.Name,
      'DelegateToAgent',
      [
        "Delegate a coding task to one of the user's local coding agents (Claude Code or Codex).",
        '',
        'WHEN TO USE THIS TOOL (delegate) vs. doing it yourself:',
        '- Delegate when the task is a substantial, self-contained coding job best handled by another agent: implementing a feature, refactoring across files, fixing a bug end-to-end, writing tests, etc.',
        '- Delegate to `claude-code` (default) when the user explicitly asks for Claude Code (e.g. "让 claude code 来做", "用 cc 改"), or when no preference is stated.',
        '- Delegate to `codex` when the user explicitly asks for Codex / OpenAI Codex CLI / GPT.',
        '- Do it YOURSELF for quick reads, questions, explanations, small edits, or anything where spinning up an external agent is overkill.',
        '',
        'TWO EXECUTION MODES (param `mode`):',
        '- `stream` (synchronous, blocks until done, shows live progress):',
        '    * Use when the user explicitly invoked the agent and wants to watch it work — e.g. `@codex …`, `@cc …`, "立刻"/"现在"/"看看"/"watch", or when a chat is bound via `/bind --agent codex|claude-code` (every message in that chat).',
        '    * The user sees every tool call and edit in real time via the active UI (Feishu card / CLI).',
        '    * Your turn pauses until the delegated agent finishes; you cannot do anything else in the meantime.',
        '- `background` (default, fire-and-forget):',
        '    * Use when the user says "后台"/"一会儿告诉我"/"go do this while …" or implies they want you to continue with other work.',
        '    * This tool returns immediately with a Task ID; a system notification fires later with the result.',
        '    * Use `delegate_status` to poll progress if needed; otherwise just continue your work.',
        '- If the user\'s intent is ambiguous, ASK them ONE short clarifying question before calling this tool ("要看着它做，还是后台跑稍后告诉你？").',
        '',
        'COMMON BEHAVIOR (both modes):',
        '- The agent runs locally in the bound project directory and CAN modify files (permissions are auto-approved).',
        '- It uses the machine\'s own pre-existing login (e.g. `claude login` / `codex login`); no extra credentials are passed.',
        '- Provide a complete, self-contained instruction in `task` — the delegated agent does not see this conversation.',
      ].join('\n'),
      Icon.Hammer,
      {
        type: Type.OBJECT,
        properties: {
          task: {
            type: Type.STRING,
            description:
              'The complete, self-contained instruction for the delegated agent. Include all context it needs, since it does not see the current conversation.',
          },
          cwd: {
            type: Type.STRING,
            description:
              'Optional absolute working directory. Defaults to the current project root.',
          },
          agent: {
            type: Type.STRING,
            enum: [...EXTERNAL_AGENT_TYPES],
            description:
              'Which external agent to delegate to. Defaults to "claude-code". Use "codex" only when the user explicitly asks for OpenAI Codex / GPT.',
          },
          mode: {
            type: Type.STRING,
            enum: [...DELEGATE_MODES],
            description:
              'Execution mode. "stream" = synchronous + live progress (use for `@codex`/`@cc` prefix, `/bind` routes, or "立刻/现在/看着做" intent). "background" = fire-and-forget with later system notification (use for batch / "后台/一会儿告诉我" intent). Defaults to "background".',
          },
          resumeSessionId: {
            type: Type.STRING,
            description:
              'Optional. Resume an existing native session of the external agent (a sessionId from the /acp-session list) instead of starting fresh. The agent reloads that conversation before running the task.',
          },
        },
        required: ['task'],
      },
      true, // isOutputMarkdown
      false, // forceMarkdown
      true, // canUpdateOutput — stream Claude Code's live progress
      false, // allowSubAgentUse — this IS a dispatcher; do not let sub-agents recurse
    );
  }

  validateToolParams(params: DelegateToAgentParams): string | null {
    const errors = SchemaValidator.validate(
      this.schema.parameters,
      params,
      DelegateToAgentTool.Name,
    );
    if (errors) {
      return errors;
    }
    if (
      !params.task ||
      typeof params.task !== 'string' ||
      params.task.trim() === ''
    ) {
      return 'Parameter "task" must be a non-empty string.';
    }
    if (params.cwd !== undefined && typeof params.cwd !== 'string') {
      return 'Parameter "cwd" must be a string.';
    }
    if (params.agent !== undefined && !isExternalAgentType(params.agent)) {
      return `Parameter "agent" must be one of: ${EXTERNAL_AGENT_TYPES.join(', ')}.`;
    }
    if (params.mode !== undefined && !DELEGATE_MODES.includes(params.mode)) {
      return `Parameter "mode" must be one of: ${DELEGATE_MODES.join(', ')}.`;
    }
    return null;
  }

  getDescription(params: DelegateToAgentParams): string {
    const agent = params.agent ?? DEFAULT_AGENT;
    const mode = params.mode ?? DEFAULT_MODE;
    const label = resolveExternalAgentSpec(agent).label;
    const modeSuffix = mode === 'stream' ? ' (live)' : ' (background)';
    const preview = params.task.replace(/\s+/g, ' ').slice(0, 80);
    return `Delegating to ${label}${modeSuffix}: "${preview}${params.task.length > 80 ? '…' : ''}"`;
  }

  async execute(
    params: DelegateToAgentParams,
    signal: AbortSignal,
    updateOutput?: (output: string) => void,
  ): Promise<DelegateToAgentResult> {
    const validationError = this.validateToolParams(params);
    if (validationError) {
      return {
        status: 'failed',
        llmContent: JSON.stringify({ status: 'failed', error: validationError }),
        returnDisplay: `Parameter validation failed: ${validationError}`,
        summary: 'Failed',
      };
    }

    const cwd = params.cwd ?? this.config.getTargetDir();
    const agent: ExternalAgentType = params.agent ?? DEFAULT_AGENT;
    const mode: DelegateMode = params.mode ?? DEFAULT_MODE;
    const label = resolveExternalAgentSpec(agent).label;

    if (mode === 'stream') {
      return this.runStream(params, agent, label, cwd, signal, updateOutput);
    }

    const taskManager = getBackgroundTaskManager();
    const bgTask = taskManager.createTask(
      `[${label}] ${params.task.replace(/\s+/g, ' ').slice(0, 120)}`,
      cwd,
      agent,
    );

    // Fire-and-forget: run the ACP session in the background and update
    // the BackgroundTaskManager on completion.
    this.runAsync(params, agent, cwd, bgTask.id, signal, updateOutput).catch(() => {
      // Should never happen — errors are handled inside runAsync.
    });

    // Return immediately so the main agent can continue working.
    return {
      status: 'success',
      llmContent: JSON.stringify({
        status: 'running',
        taskId: bgTask.id,
        agent,
        mode,
        task: params.task,
        message: `${label} task started in the background. You will be notified when it completes.`,
      }),
      returnDisplay:
        `🚀 ${label} 任务已启动 (Task ID: ${bgTask.id})\n\n` +
        `你可以在等待期间继续执行其他任务。任务完成后系统会自动通知你。`,
      summary: `${label} started (Task ID: ${bgTask.id})`,
    };
  }

  /**
   * Synchronous + streaming execution path. Awaits the delegated agent to
   * completion, surfacing every session update through `updateOutput` (which
   * the Feishu card / CLI tool-call display pipes into the live UI). Does
   * NOT register the task with BackgroundTaskManager — streamed tasks are
   * foreground by definition, with no post-hoc status to poll.
   */
  private async runStream(
    params: DelegateToAgentParams,
    agent: ExternalAgentType,
    label: string,
    cwd: string,
    signal: AbortSignal,
    updateOutput?: (output: string) => void,
  ): Promise<DelegateToAgentResult> {
    const startTime = Date.now();
    try {
      const result = await runDelegatedTask({
        agentType: agent,
        task: params.task,
        cwd,
        signal,
        onUpdate: updateOutput,
        autoApprove: true,
        timeoutMs: DelegateToAgentTool.DEFAULT_TIMEOUT_MS,
        resumeSessionId: params.resumeSessionId,
      });

      const duration = Math.round((Date.now() - startTime) / 1000);
      const status = result.status;
      const answer = (result.answer || result.transcript || '').trim();

      const llmPayload: Record<string, unknown> = {
        status,
        agent,
        mode: 'stream',
        durationSeconds: duration,
      };
      if (result.sessionId) llmPayload.sessionId = result.sessionId;
      if (answer) llmPayload.answer = answer.length > 4000 ? answer.slice(0, 4000) + '…' : answer;
      if (result.stopReason) llmPayload.stopReason = result.stopReason;
      if (result.error) llmPayload.error = result.error;

      const icon =
        status === 'success' ? '✅' :
        status === 'cancelled' ? '⏹️' :
        status === 'timed_out' ? '⏱️' : '❌';
      const banner = `${icon} ${label} ${status} (${duration}s)`;
      const body = answer
        ? `\n\n${answer.length > 2000 ? answer.slice(0, 2000) + '…' : answer}`
        : (result.error ? `\n\n${result.error}` : '');

      return {
        status,
        llmContent: JSON.stringify(llmPayload),
        returnDisplay: banner + body,
        summary: `${label} ${status} (${duration}s)`,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return {
        status: 'failed',
        llmContent: JSON.stringify({
          status: 'failed',
          agent,
          mode: 'stream',
          error: errorMessage,
        }),
        returnDisplay: `❌ ${label} failed: ${errorMessage}`,
        summary: `${label} failed`,
      };
    }
  }

  /**
   * Default timeout for delegated tasks. Claude Code coding tasks can
   * legitimately run for many minutes (large refactors, running test suites,
   * etc.), so we default to 60 minutes. Override with the environment
   * variable EASYCODE_CC_TIMEOUT_MINUTES.
   */
  static readonly DEFAULT_TIMEOUT_MS = (() => {
    const env = process.env.EASYCODE_CC_TIMEOUT_MINUTES;
    if (env) {
      const mins = parseInt(env, 10);
      if (mins > 0) return mins * 60 * 1000;
    }
    return 60 * 60 * 1000; // 60 minutes
  })();

  /**
   * Runs the delegated ACP task in the background, updating the
   * BackgroundTaskManager with streaming output and final result.
   */
  private async runAsync(
    params: DelegateToAgentParams,
    agent: ExternalAgentType,
    cwd: string,
    taskId: string,
    signal: AbortSignal,
    updateOutput?: (output: string) => void,
  ): Promise<void> {
    const taskManager = getBackgroundTaskManager();

    // Forward streaming output to both the updateOutput callback (for
    // live UI) and the BackgroundTaskManager (for state tracking).
    const onStreamUpdate = (output: string) => {
      taskManager.appendOutput(taskId, output);
      updateOutput?.(output);
    };

    try {
      const result = await runDelegatedTask({
        agentType: agent,
        task: params.task,
        cwd,
        signal,
        onUpdate: onStreamUpdate,
        // Structured progress → persisted task record (drives the /acp-session card).
        onProgress: (progress) => taskManager.updateProgress(taskId, progress),
        autoApprove: true,
        timeoutMs: DelegateToAgentTool.DEFAULT_TIMEOUT_MS,
        resumeSessionId: params.resumeSessionId,
      });

      // Write the final answer + native session id into the task record.
      const task = taskManager.getTask(taskId);
      if (task) {
        task.answer = result.answer || result.transcript;
        if (result.sessionId) task.sessionId = result.sessionId;
        if (result.progress) taskManager.updateProgress(taskId, result.progress);
      }

      if (result.status === 'success') {
        taskManager.completeTask(taskId, { exitCode: 0 });
      } else if (result.status === 'cancelled') {
        taskManager.cancelTask(taskId);
      } else {
        taskManager.failTask(taskId, result.error || `${result.label} ${result.status}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      taskManager.failTask(taskId, msg);
    }
  }
}

/**
 * Whether a background task originated from the ACP delegate path
 * (i.e. should be formatted via {@link formatClaudeCodeTaskResult}
 * rather than the generic shell formatter).
 */
export function isAcpDelegateTask(task: BackgroundTask): boolean {
  return task.kind === 'claude-code' || task.kind === 'codex';
}

/**
 * Format a completed ACP-delegated background task result (Claude Code or
 * Codex) for AI consumption. Called from the UI layer (App.tsx) when
 * building the system notification.
 *
 * IMPORTANT: This text is injected into the main agent's context window.
 * Keep it concise — only the answer and a short summary, never the full
 * transcript.  Long-running tasks can produce tens of thousands of
 * characters of tool output; dumping all of that into the LLM context
 * would blow up token usage and degrade response quality.
 *
 * The function name retains the historical "ClaudeCode" wording for export
 * compatibility; semantically it now handles any ACP delegate task and
 * labels by `task.kind`.
 */
export function formatClaudeCodeTaskResult(task: BackgroundTask): string {
  const duration = task.endTime ? Math.round((task.endTime - task.startTime) / 1000) : 0;
  const label = task.kind === 'codex' ? 'Codex' : 'Claude Code';

  let result = `${label} task completed:\n`;
  result += `- Task ID: ${task.id}\n`;
  result += `- Duration: ${duration} seconds\n`;
  result += `- Status: ${task.status}\n`;

  if (task.answer?.trim()) {
    // The concise answer from Claude Code — typically a summary paragraph.
    const trimmed = task.answer.length > 2000
      ? task.answer.slice(0, 2000) + '…'
      : task.answer;
    result += `\n--- Answer ---\n${trimmed}\n`;
  } else if (task.output?.trim()) {
    // Fallback: extract just the tool call titles and final text, not the
    // verbose transcript.  Keep under 1500 chars to protect context window.
    const summary = extractCompactSummary(task.output, 1500);
    result += `\n--- Summary ---\n${summary}\n`;
  }

  if (task.error) {
    result += `\n--- Error ---\n${task.error.slice(0, 500)}\n`;
  }

  return result;
}

/**
 * Extract a compact summary from a verbose transcript: keep tool call
 * titles (lines starting with emoji markers) and the last few lines of
 * text output, discarding verbose file contents and diffs.
 */
export function extractCompactSummary(transcript: string, maxLen: number): string {
  const lines = transcript.split('\n');
  const kept: string[] = [];
  let len = 0;

  // Walk backwards so we keep the most recent content.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    // Keep: tool call markers, status lines, short text lines
    const isToolMarker = /^[📖✏️🗑️📦🔍⚡💭🌐🔄🔧✅⚠️📋📊💡🚀⏳⏹️⏱️❌]/u.test(line);
    const isShort = line.length <= 200;
    const candidate = isToolMarker || isShort ? line : line.slice(0, 100) + '…';

    if (len + candidate.length + 1 > maxLen) break;
    kept.unshift(candidate);
    len += candidate.length + 1;
  }

  return kept.join('\n');
}
