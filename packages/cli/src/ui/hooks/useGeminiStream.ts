/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useInput } from 'ink';
import { t, tp, isChineseLocale } from '../utils/i18n.js';
import { isBackgroundTaskPanelOpen, isSideQuestionPanelOpen, isWorkflowPanelOpen } from '../utils/modalState.js';
import {
  Config,
  GeminiClient,
  GeminiEventType as ServerGeminiEventType,
  ServerGeminiStreamEvent as GeminiEvent,
  ServerGeminiContentEvent as ContentEvent,
  ServerGeminiErrorEvent as ErrorEvent,
  ServerGeminiChatCompressedEvent,
  ServerGeminiFinishedEvent,
  getErrorMessage,
  isNodeError,
  MessageSenderType,
  ToolCallRequestInfo,
  Tool,
  logUserPrompt,
  GitService,
  EditorType,
  ThoughtSummary,
  ReasoningSummary,
  UnauthorizedError,
  UserPromptEvent,
  DEFAULT_GEMINI_FLASH_MODEL,
  SessionManager,
  type SessionData,
  MESSAGE_ROLES,
  isCustomModel,
} from 'otto-core';
import { updateWindowTitleWithSummary } from '../../gemini.js';
import { type Part, type PartListUnion, FinishReason } from '@google/genai';
import {
  StreamingState,
  HistoryItem,
  HistoryItemWithoutId,
  HistoryItemToolGroup,
  HistoryItemCompression,
  MessageType,
  SlashCommandProcessorResult,
  ToolCallStatus,
} from '../types.js';
import { isAtCommand } from '../utils/commandUtils.js';
import { parseAndFormatApiError } from '../utils/errorParsing.js';
import { useShellCommandProcessor } from './shellCommandProcessor.js';
import { handleAtCommand } from './atCommandProcessor.js';
import { HelpSubagent } from '../../services/HelpSubagent.js';
import { findLastSafeSplitPoint } from '../utils/markdownUtilities.js';
import { detectPlanModeChange, isPlanModeExitMarker } from '../utils/planModeDetector.js';
import { refreshModelsInBackground } from '../commands/modelCommand.js';
import { LoadedSettings } from '../../config/settings.js';
import { useStateAndRef } from './useStateAndRef.js';
import { UseHistoryManagerReturn } from './useHistoryManager.js';
import { useLogger } from './useLogger.js';
import { promises as fs } from 'fs';
import path from 'path';
import { AudioNotification, NotificationSound } from '../../utils/audioNotification.js';
import {
  getActiveDebate,
  advanceCursor,
  pauseDebate,
  endDebate,
  isLastTurn,
} from '../utils/debateState.js';
import { pickFollowup, buildSummaryPrompt, DEBATE_SUMMARY_MODEL, DEBATE_SUMMARY_FALLBACK_MODEL } from '../utils/debatePhrases.js';
import { getDebateI18nTexts } from '../utils/debateI18n.js';
import { detectUILanguage } from '../utils/debateLanguageUtils.js';
import {
  useReactToolScheduler,
  mapToDisplay as mapTrackedToolCallsToDisplay,
  TrackedToolCall,
  TrackedCompletedToolCall,
  TrackedCancelledToolCall,
} from './useReactToolScheduler.js';
import { useSessionStats } from '../contexts/SessionContext.js';
import { SceneType } from 'otto-core';
import { appEvents, AppEvent } from '../../utils/events.js';
// TaskStateManager 已移除，直接基于现有状态判断

/**
 * 格式化工具调用信息为可读文本
 * @param toolCalls 工具调用数组
 * @returns 格式化后的文本
 */
function formatToolCallsForSummary(toolCalls: TrackedToolCall[]): string {
  const successCalls = toolCalls.filter(tc => tc.status === 'success');

  if (successCalls.length === 0) {
    return '执行了代码编辑操作';
  }

  // 按操作类型分组
  const replaces: string[] = [];
  const creates: string[] = [];
  const deletes: string[] = [];
  const others: string[] = [];

  for (const call of successCalls) {
    const toolName = call.request?.name || ('tool' in call ? call.tool?.name : '') || '未知工具';
    const args = call.request?.args || {};
    const filePath = args.file_path as string || '';
    const fileName = filePath.split(/[/\\]/).pop() || '';

    // 根据工具类型分类
    if (toolName === 'replace') {
      replaces.push(fileName);
    } else if (toolName === 'write_file') {
      creates.push(fileName);
    } else if (toolName === 'delete_file') {
      deletes.push(fileName);
    } else {
      others.push(toolName);
    }
  }

  // 获取文件类型描述
  const getFileType = (name: string): string => {
    const ext = name.split('.').pop()?.toLowerCase() || '';
    const typeMap: Record<string, string> = {
      'ts': 'TS', 'tsx': 'TSX', 'js': 'JS', 'jsx': 'JSX',
      'py': 'Python', 'java': 'Java', 'cpp': 'C++', 'c': 'C',
      'go': 'Go', 'rs': 'Rust', 'md': 'MD', 'json': 'JSON',
      'yaml': 'YAML', 'yml': 'YAML', 'html': 'HTML',
      'css': 'CSS', 'scss': 'SCSS', 'sql': 'SQL',
    };
    return typeMap[ext] || ext.toUpperCase();
  };

  const parts: string[] = [];

  // 修改文件
  if (replaces.length > 0) {
    if (replaces.length === 1) {
      parts.push(`修改${getFileType(replaces[0])}文件${replaces[0]}`);
    } else {
      const fileList = replaces.map(n => `${n}`).join(',');
      parts.push(`修改${replaces.length}个文件(${fileList})`);
    }
  }

  // 创建文件
  if (creates.length > 0) {
    if (creates.length === 1) {
      parts.push(`创建${getFileType(creates[0])}文件${creates[0]}`);
    } else {
      const fileList = creates.map(n => `${n}`).join(',');
      parts.push(`创建${creates.length}个文件(${fileList})`);
    }
  }

  // 删除文件
  if (deletes.length > 0) {
    if (deletes.length === 1) {
      parts.push(`删除${deletes[0]}`);
    } else {
      parts.push(`删除${deletes.length}个文件(${deletes.join(',')})`);
    }
  }

  // 其他操作
  if (others.length > 0) {
    parts.push(`执行${others.join(',')}`);
  }

  return parts.join('，');
}

/**
 * 生成 Checkpoint / 会话摘要。
 *
 * 设计原则（决定写死 deepseek-v4-flash）：
 * - 摘要是非关键、纯文本到短文本的映射，无需上下文、无需系统提示词、无需思考。
 * - deepseek-v4-flash 单价远低于 gemini-2.5-flash-lite，且本身就是非思考版本。
 * - 走 OttoServerAdapter，所有模型都被统一代理，不依赖客户端任何额外路由。
 *
 * 实施：
 * - emptySystemPrompt: 完全不带 system，避免任何风格污染。
 * - 历史为空，单轮请求。
 * - 短超时 fail-open，失败返回 ''，调用方自行决定是否回退到原文。
 *
 * @param geminiClient GeminiClient 实例
 * @param summarySource AI 文本回复或用户原文
 * @param _currentModel 已废弃；保留参数以兼容旧调用点
 * @param abortSignal 可选取消信号；用户开始新一轮 query 时取消上一个未完成的摘要请求，避免浪费配额与产生 race 条件
 * @returns 摘要文本，失败时返回空字符串
 */
async function generateCheckpointSummary(
  geminiClient: GeminiClient,
  summarySource: string,
  _currentModel?: string,
  abortSignal?: AbortSignal
): Promise<string> {
  const SUMMARY_MODEL = 'deepseek-v4-flash';
  // 10s timeout：标题生成是 fire-and-forget 的后台任务，
  // 不阻塞主 AI 请求；回来多晚都行，回来才设标题，回不来就维持原标题。
  const SUMMARY_TIMEOUT_MS = 10000;

  // 已被取消，直接返回，不发起请求
  if (abortSignal?.aborted) {
    return '';
  }

  const targetLanguage = isChineseLocale() ? 'Chinese' : 'English';
  const lengthLimit = isChineseLocale() ? '8 Chinese characters' : '3 English words';

  const summaryPrompt = `Extract the core task in "Verb + Noun" format.
Must include the specific project/feature name.
Length limit: Max ${lengthLimit}.
CRITICAL: Use the most concise expression and the shortest possible words.
Avoid articles (a, an, the) and unnecessary adjectives.

Examples:
- Create Game
- Optimize Login
- Fix Auth Bug
- Refactor Payment

Now summarize:
"${summarySource}"

Output must be in ${targetLanguage}.
Return only the summary text.`;

  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Summary generation timeout')), SUMMARY_TIMEOUT_MS);
      // 被外部取消时立刻清掉定时器并 reject，让上层尽早走 catch
      abortSignal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('Summary generation aborted'));
      }, { once: true });
    });

    const summaryPromise = (async () => {
      const chat = await geminiClient.createTemporaryChat(
        SceneType.CONTENT_SUMMARY,
        SUMMARY_MODEL,
        { type: 'sub', agentId: 'CheckpointSummarizer' },
        { emptySystemPrompt: true }
      );

      const response = await chat.sendMessage(
        {
          message: summaryPrompt,
          // 透传给 OttoServerAdapter.generateContent → executeUnifiedChatAPICall，
          // 由后者监听 abort 事件中止 fetch
          config: { abortSignal } as never,
        },
        `checkpoint-summary-${Date.now()}`,
        SceneType.CONTENT_SUMMARY
      );

      // 从 response 中提取文本（兼容 .text 与 candidates 两种返回形态）
      let summaryText = '';
      if (response.text) {
        summaryText = response.text;
      } else if (response.candidates && response.candidates[0]?.content?.parts?.[0]?.text) {
        summaryText = response.candidates[0].content.parts[0].text;
      }
      return summaryText.trim();
    })();

    const summary = await Promise.race([summaryPromise, timeoutPromise]);

    if (summary && summary.length > 0) {
      return summary;
    }
    return '';
  } catch (error) {
    // Best-effort. warn 级别，避免红色 ✖ 面板。
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[Summary] ${SUMMARY_MODEL} skipped (non-critical):`, msg);
    return '';
  }
}

export function mergePartListUnions(list: PartListUnion[]): PartListUnion {
  const resultParts: PartListUnion = [];
  for (const item of list) {
    if (Array.isArray(item)) {
      resultParts.push(...item);
    } else {
      resultParts.push(item);
    }
  }
  return resultParts;
}

enum StreamProcessingStatus {
  Completed,
  UserCancelled,
  Error,
}

/**
 * Manages the Gemini stream, including user input, command processing,
 * API interaction, and tool call lifecycle.
 */
export const useGeminiStream = (
  geminiClient: GeminiClient,
  history: HistoryItem[],
  addItem: UseHistoryManagerReturn['addItem'],
  config: Config,
  onDebugMessage: (message: string) => void,
  handleSlashCommand: (
    cmd: PartListUnion,
  ) => Promise<SlashCommandProcessorResult | false>,
  shellModeActive: boolean,
  helpModeActive: boolean,
  getPreferredEditor: () => EditorType | undefined,
  onAuthError: () => void,
  performMemoryRefresh: () => Promise<void>,
  modelSwitchedFromQuotaError: boolean,
  setModelSwitchedFromQuotaError: React.Dispatch<React.SetStateAction<boolean>>,
  setEstimatedInputTokens?: React.Dispatch<React.SetStateAction<number | undefined>>,
  settings?: LoadedSettings,
  customProxyUrl?: string,
  // 🎭 辩论推进的 AbortController ref。由 App.tsx 持有并共享给 useDebateWizard，
  // 让首启 switchModel 和自动推进的 switchModel 用同一个可中止句柄。
  debateAdvanceAbortRef?: React.MutableRefObject<AbortController | null>,
  // 🎯 Mid-turn 注入：在 tool-call 间隙原子取走所有可注入的排队消息，
  // 让它们作为附加 user text 跟随下一次 continuation 一起送给模型。
  // 调用者负责保证 atomic（被这里取走的项会被从 UI 队列中移除），
  // 在 paused / editMode / 空队列 时应返回空数组。
  drainQueuedPromptsForInjection?: () => string[],
) => {
  const [initError, setInitError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const turnCancelledRef = useRef(false);
  const processingRef = useRef(false); // 同步标志位，防止重入
  const [isResponding, setIsResponding] = useState<boolean>(false);
  const [thought, setThought] = useState<ThoughtSummary | null>(null);
  const [reasoning, setReasoning] = useState<ReasoningSummary | null>(null);
  const [hasContentStarted, setHasContentStarted] = useState<boolean>(false); // 🆕 追踪是否已开始发送内容

  // 清除预估token的helper函数
  const clearEstimatedTokens = useCallback(() => {
    if (setEstimatedInputTokens) {
      setEstimatedInputTokens(undefined);
    }
  }, [setEstimatedInputTokens]);
  const [pendingHistoryItemRef, setPendingHistoryItem] =
    useStateAndRef<HistoryItemWithoutId | null>(null);
  const processedMemoryToolsRef = useRef<Set<string>>(new Set());
  // 用于避免同一次对话创建多个checkpoint
  const conversationCheckpointCreated = useRef(false);
  // 用于显示checkpoint创建状态
  const [isCreatingCheckpoint, setIsCreatingCheckpoint] = useState(false);
  // 用于跟踪 checkpoint 创建失败，避免重复尝试
  const checkpointCreationFailed = useRef(false);
  // 🎯 用于跟踪当前创建的 checkpoint ID，以便后续更新摘要
  const currentCheckpointIdRef = useRef<string | null>(null);
  // 🎯 用于保存当前用户输入，供 checkpoint 创建时使用
  const currentUserQueryRef = useRef<string>('');
  // 🎯 用于保存 AI 在调用工具前的文本回复，供 checkpoint 摘要使用
  const aiTextBeforeToolsRef = useRef<string>('');
  // 🎯 用于保存当前会话的摘要，避免重复生成
  const currentSessionSummaryRef = useRef<string | null>(null);
  // 🎯 用于取消上一次未完成的标题摘要请求。
  // 与 abortControllerRef（主请求）独立，因为：
  // 1. 主请求可能因用户 Esc 中断，但摘要仍需完成（用户其实没换话题）；
  // 2. 用户连发新 query 时，旧 summary 必须被取消，否则会出现 race（旧的晚到覆盖新的）。
  const summaryAbortControllerRef = useRef<AbortController | null>(null);
  const { startNewPrompt, getPromptCount } = useSessionStats();
  const logger = useLogger();
  const [gitService, setGitService] = useState<GitService | undefined>();

  useEffect(() => {
    if (!config.getProjectRoot()) {
      setGitService(undefined);
      return;
    }
    // Use the GitService instance from config to ensure singleton behavior
    config.getGitService().then(setGitService).catch(() => {
      setGitService(undefined);
    });
  }, [config]);

  const sessionManager = useMemo(() => {
    if (!config.getProjectRoot()) {
      return;
    }
    return new SessionManager(config.getProjectRoot());
  }, [config]);

  // 简化：直接基于现有状态判断，无需中央状态管理

  /**
   * 🎯 在工具执行前创建初始 Checkpoint
   */
  const createInitialCheckpoint = useCallback(async (requests: ToolCallRequestInfo[]) => {
    if (!sessionManager || !gitService) return;

    // 检查是否有文件修改工具（包括嵌套在 batch 或 multiedit 中的）
    const fileModifyingToolNames = [
      'replace',
      'write_file',
      'delete_file',
      'patch',
      'multiedit'
    ];

    /**
     * 🎯 判断 Shell 命令是否包含修改操作的简单启发式检查
     */
    const isModifyingShellCommand = (command: string): boolean => {
      if (!command) return false;
      const cmd = command.trim();

      // 1. 检查重定向 (写入文件)
      if (cmd.includes('>') || cmd.includes('>>')) return true;

      // 2. 检查具有修改性质的常用命令
      const modifyingCmds = [
        'rm', 'mv', 'cp', 'mkdir', 'touch', 'sed', 'chmod', 'chown', 'truncate',
        'npm', 'yarn', 'pnpm', 'pip', 'apt', 'brew' // 包管理通常涉及文件变化
      ];

      // 匹配命令起始位置或管道符/分号后的起始位置
      const cmdRegex = new RegExp(`(^|[|&;])\\s*(${modifyingCmds.join('|')})\\b`, 'i');
      return cmdRegex.test(cmd);
    };

    /**
     * 🎯 递归检查工具调用中是否包含文件修改类工具
     */
    const checkHasFileModifyingTools = (calls: any[]): boolean => {
      return calls.some(req => {
        // req 可能来自 ToolCallRequestInfo (有 name)
        // 也可能来自 batch 工具的参数 (有 tool)
        const toolName = req.name || req.tool || '';
        const args = req.args || req.parameters;

        // 1. 直接匹配已知的文件修改工具
        if (fileModifyingToolNames.includes(toolName)) {
          return true;
        }

        // 2. 针对 run_shell_command 进行细化检查
        if (toolName === 'run_shell_command' && args?.command) {
          return isModifyingShellCommand(args.command);
        }

        // 3. 处理 batch 工具中的嵌套调用
        if (toolName === 'batch' && args?.tool_calls && Array.isArray(args.tool_calls)) {
          return checkHasFileModifyingTools(args.tool_calls);
        }

        return false;
      });
    };

    const hasFileModifyingTools = checkHasFileModifyingTools(requests);

    if (!hasFileModifyingTools) {
      return; // 没有文件修改工具，不创建 Checkpoint
    }

    // 避免同一次对话创建多个 Checkpoint
    if (conversationCheckpointCreated.current || checkpointCreationFailed.current) {
      return;
    }

    try {
      // Check if Git service is available and not disabled
      if (gitService.isGitDisabled()) {
        console.log(`跳过 auto checkpoint: Git 服务不可用${gitService.getDisabledReason ? ` (${gitService.getDisabledReason()})` : ''}`);
        return;
      }

      // 标记本次对话已创建 Checkpoint
      conversationCheckpointCreated.current = true;
      setIsCreatingCheckpoint(true);
      onDebugMessage(t('checkpoint.creating'));

      const now = Date.now();

      // 创建 Git 快照 (编辑前快照)
      const createCommitWithTimeout = async () => {
        return new Promise<string>(async (resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('Git commit 操作超时 (15秒)'));
          }, 15000);

          try {
            const result = await gitService.createFileSnapshot(
              `Pre-edit Checkpoint ${new Date(now).toLocaleString()} for session ${config.getSessionId()}`,
            );
            clearTimeout(timeout);
            resolve(result as string);
          } catch (error) {
            clearTimeout(timeout);
            reject(error);
          }
        });
      };

      let commitHash = await createCommitWithTimeout();

      if (!commitHash) {
        commitHash = await gitService.getCurrentCommitHash();
      }

      if (!commitHash) return;

      // 获取用户最后一句话（保留用于显示）
      let lastUserMessage = '初始会话';
      if (currentUserQueryRef.current && currentUserQueryRef.current.trim().length > 0) {
        lastUserMessage = currentUserQueryRef.current.trim();
      } else if (history && history.length > 0) {
        const recentUserMessage = [...history].reverse().find(msg =>
          msg.type === 'user' && msg.text && msg.text.trim().length > 0
        );
        if (recentUserMessage && recentUserMessage.text) {
          lastUserMessage = recentUserMessage.text.trim();
        }
      }

      const checkpointId = `checkpoint-${now}`;
      const checkpointData = {
        id: checkpointId,
        timestamp: now,
        timeString: new Date(now).toLocaleString('zh-CN', {
          year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', second: '2-digit'
        }),
        lastUserMessage,
        summary: '正在生成摘要...', // 初始占位符
        commitHash,
        sessionId: config.getSessionId(),
      };

      await sessionManager.saveSessionCheckpoint(config.getSessionId(), checkpointData);
      currentCheckpointIdRef.current = checkpointId;

      // 打印 Checkpoint 成功消息
      addItem(
        {
          type: MessageType.INFO,
          text: `\x1b[32m • ${tp('checkpoint.created.success', { checkpointId: checkpointData.id })}\x1b[0m`,
        },
        Date.now(),
      );

      onDebugMessage(
        `✅ 初始 Checkpoint 已创建: ${checkpointData.timeString}`,
      );
    } catch (error) {
      checkpointCreationFailed.current = true;
      onDebugMessage(`❌ ${tp('checkpoint.created.failed', { error: getErrorMessage(error) })}`);
      onDebugMessage(t('checkpoint.creation.skipped'));
    } finally {
      setIsCreatingCheckpoint(false);
    }
  }, [sessionManager, gitService, config, currentUserQueryRef, history, addItem, onDebugMessage]);

  /**
   * 🎯 在工具完成后异步更新 Checkpoint 摘要
   */
  const updateCheckpointSummary = useCallback(async (completedToolCalls: TrackedToolCall[]) => {
    if (!sessionManager || !currentCheckpointIdRef.current) return;

    try {
      // 设计：摘要现在仅在用户提交 query 时生成一次（见 submitQuery 内的 immediate
      // summary 块），结果存在 currentSessionSummaryRef 里。这里只复用这个 ref，
      // 不再触发任何额外的 LLM 调用。
      // 如果 ref 为空（例如：纯指令式短输入根本没走 summarize 分支，或者上次
      // immediate summary 失败），则使用本地工具调用降级文本作为兜底，仍然不调用 LLM。
      let summary = currentSessionSummaryRef.current;

      if (!summary) {
        // 本地降级：从工具调用生成可读摘要（纯字符串拼接，0 LLM 调用）
        summary = formatToolCallsForSummary(completedToolCalls);
      }

      if (summary) {
        // 更新 SessionManager 中的摘要
        await sessionManager.updateSessionCheckpoint(config.getSessionId(), currentCheckpointIdRef.current, { summary });

        // 🎯 同步更新窗口标题（包含工作目录名）
        if (settings) {
          const workspaceName = path.basename(config.getProjectRoot());
          updateWindowTitleWithSummary(summary, settings, workspaceName);
        }

        onDebugMessage(`✅ Checkpoint 摘要已更新: "${summary}"`);
      }
    } catch (error) {
      // Checkpoint summary is non-critical (best-effort). Use warn so it doesn't
      // surface as a red ✖ panel — the user's checkpoint itself was already saved
      // upstream; only the summary label failed to update.
      const msg = error instanceof Error ? error.message : String(error);
      console.warn('[Checkpoint] Summary update skipped (non-critical):', msg);
    }
  }, [sessionManager, config, settings, onDebugMessage]);

  /**
   * 🎯 工具执行前的预处理 (用于 Git Checkpoint)
   * 这个回调会被传递给调度器，在每个工具（包括 batch 中的子工具）执行前触发
   */
  const onPreToolExecution = useCallback(async (toolCall: { callId: string, tool: any, args: any }) => {
    // 包装成数组，以便复用已有的 createInitialCheckpoint 逻辑
    // 注意：createInitialCheckpoint 内部现在支持递归检查，
    // 这意味着即使是嵌套的工具调用也能正确触发 checkpoint
    const request: ToolCallRequestInfo = {
      name: toolCall.tool.name,
      args: toolCall.args,
      callId: toolCall.callId,
      isClientInitiated: false,
      prompt_id: config.getSessionId()
    };
    await createInitialCheckpoint([request]);
  }, [createInitialCheckpoint]);

  const [toolCalls, originalScheduleToolCalls, markToolsAsSubmitted, handleConfirmationResponse] =
    useReactToolScheduler(
      async (completedToolCallsFromScheduler) => {
        // This onComplete is called when ALL scheduled tools for a given batch are done.
        if (completedToolCallsFromScheduler.length > 0) {
          // Add the final state of these tools to the history for display.
          addItem(
            mapTrackedToolCallsToDisplay(
              completedToolCallsFromScheduler as TrackedToolCall[],
            ),
            Date.now(),
          );

          // Handle tool response submission immediately when tools complete
          await handleCompletedTools(
            completedToolCallsFromScheduler as TrackedToolCall[],
          );

          // 🎯 在工具完成后异步更新 Checkpoint 摘要
          await updateCheckpointSummary(completedToolCallsFromScheduler as TrackedToolCall[]);
        }
      },
      config,
      setPendingHistoryItem,
      getPreferredEditor,
      onPreToolExecution,
    );

  // Use the original scheduleToolCalls but wrap it to create initial checkpoint
  const scheduleToolCalls = useCallback(
    async (request: ToolCallRequestInfo | ToolCallRequestInfo[], signal: AbortSignal) => {
      const requests = Array.isArray(request) ? request : [request];
      // 🎯 在调度工具前尝试创建 Checkpoint（等待创建完成以确保 Git 快照准确）
      // 虽然 onPreToolExecution 也会触发，但在调度前触发可以更早显示提示
      await createInitialCheckpoint(requests).catch(err => {
        // 对于自定义模型，checkpoint 创建失败是可接受的
        const currentModel = config.getModel();
        if (currentModel && isCustomModel(currentModel)) {
          console.warn('[Checkpoint] Custom model: initial creation skipped (non-critical)');
        } else {
          console.error('[Checkpoint] Initial creation failed:', err);
        }
      });
      return originalScheduleToolCalls(request, signal);
    },
    [originalScheduleToolCalls, createInitialCheckpoint, config]
  );



  const pendingToolCallGroupDisplay = useMemo(
    () =>
      toolCalls.length ? mapTrackedToolCallsToDisplay(toolCalls) : undefined,
    [toolCalls],
  );

  const loopDetectedRef = useRef(false);
  const loopTypeRef = useRef<string | undefined>(undefined);

  const onExec = useCallback(async (done: Promise<void>) => {
    processingRef.current = true; // 🛡️ 设置同步标志位
    setIsResponding(true);
    try {
      await done;
    } finally {
      // 🛡️ 重置同步标志位
      processingRef.current = false;
      setIsResponding(false);
      clearEstimatedTokens(); // 清除预估token

      // Linus fix: Shell command执行完成后也要进行内存清理
      if (typeof global !== 'undefined' && global.gc) {
        try {
          // 立即清理
          global.gc();
          console.log('🗑️ Shell command completion - Immediate forced GC cleanup');

          // 1秒后备份清理，确保彻底
          setTimeout(() => {
            if (typeof global !== 'undefined' && global.gc) {
              global.gc();
              console.log('🗑️ Shell command completion - Backup GC cleanup (1s later)');
            }
          }, 1000);
        } catch (e) {
          // GC not available, ignore
        }
      }
    }
  }, []);
  const { handleShellCommand } = useShellCommandProcessor(
    addItem,
    setPendingHistoryItem,
    onExec,
    onDebugMessage,
    config,
    geminiClient,
  );

  // 🎯 简化的状态管理：直接基于现有状态判断
  const streamingState = useMemo(() => {
    // 首先检查是否有等待确认的工具调用
    const hasAwaitingApprovalCalls = toolCalls.some((tc) => {
      // 过滤掉runtime confirmation虚拟工具调用
      const isRuntimeConfirmation = tc.request.isRuntimeConfirmation === true;
      if (isRuntimeConfirmation) {
        return false;
      }
      return tc.status === 'awaiting_approval';
    });

    if (hasAwaitingApprovalCalls) {
      console.debug('[useGeminiStream] → WaitingForConfirmation (工具等待确认)');
      return StreamingState.WaitingForConfirmation;
    }

    // 检查是否正在响应或有活跃的工具调用
    if (isResponding) {
      console.debug('[useGeminiStream] → Responding (正在响应)');
      return StreamingState.Responding;
    }

    // 检查是否有其他活跃的工具调用
    const hasActiveToolCalls = toolCalls.some((tc) => {
      // 过滤掉runtime confirmation虚拟工具调用
      const isRuntimeConfirmation = tc.request.isRuntimeConfirmation === true;
      if (isRuntimeConfirmation) {
        return false;
      }

      const isActive = (
        tc.status === 'executing' ||
        tc.status === 'scheduled' ||
        tc.status === 'validating' ||
        // 已完成但还未提交给Gemini的工具调用
        ((tc.status === 'success' || tc.status === 'error' || tc.status === 'cancelled') &&
         !(tc as TrackedCompletedToolCall | TrackedCancelledToolCall).responseSubmittedToGemini)
      );

      return isActive;
    });

    if (hasActiveToolCalls) {
      console.debug('[useGeminiStream] → Responding (活跃工具调用)');
      return StreamingState.Responding;
    }

    return StreamingState.Idle;
  }, [isResponding, toolCalls]);

  useInput((input, key) => {
    // 检测IDEA环境下的替代取消键
    const isIDEATerminal = !!(
      process.env.TERMINAL_EMULATOR && (
        process.env.TERMINAL_EMULATOR.includes('JetBrains') ||
        process.env.TERMINAL_EMULATOR.includes('IntelliJ') ||
        process.env.TERMINAL_EMULATOR.includes('IDEA')
      ) ||
      process.env.IDEA_INITIAL_DIRECTORY ||
      process.env.JETBRAINS_IDE ||
      (process.env.TERM_PROGRAM && process.env.TERM_PROGRAM.includes('jetbrains'))
    );

    const isCancelKey = key.escape ||
                       (isIDEATerminal && key.ctrl && input === 'q') ||
                       (process.platform === 'darwin' && key.meta && input === 'q');

    // 🎯 如果后台任务面板或 workflow 面板打开，不处理 ESC（由 App.tsx 统一处理）
    if (isCancelKey && (isBackgroundTaskPanelOpen() || isWorkflowPanelOpen() || isSideQuestionPanelOpen())) {
      return;
    }

    if (streamingState === StreamingState.Responding && isCancelKey) {
      if (turnCancelledRef.current) {
        return;
      }
      turnCancelledRef.current = true;

      // 🎯 只需要调用abort()，信号会自动传播到所有子任务
      console.debug('[useGeminiStream] 用户取消操作 - 发送AbortSignal');
      abortControllerRef.current?.abort();

      if (pendingHistoryItemRef.current) {
        addItem(pendingHistoryItemRef.current, Date.now());
      }

      addItem(
        {
          type: MessageType.INFO,
          text: 'Request cancelled.',
        },
        Date.now(),
      );
      setPendingHistoryItem(null);
      // 🛡️ 重置同步标志位
      processingRef.current = false;
      setIsResponding(false);
      clearEstimatedTokens(); // 清除预估token

      // 🎭 辩论模式：ESC 必须立即暂停辩论，否则紧随其后的 Idle 事件会继续
      //    推进到下一个模型，造成"按 ESC 反而触发下一轮"的现象。
      //    handleUserCancelledEvent 路径已有同样处理；此处是 useInput 直接
      //    拦截 ESC 时走的独立路径，必须也加上。
      if (getActiveDebate()) {
        debateAbortRef.current?.abort();
        debateAbortRef.current = null;
        pauseDebate();
        addItem(
          {
            type: MessageType.INFO,
            text: '🎭 辩论已暂停。使用 /debate continue 继续，或 /debate end 结束。',
          },
          Date.now(),
        );
      }

      // Linus fix: ESC取消时也要执行内存清理，防止内存泄漏
      if (typeof global !== 'undefined' && global.gc) {
        try {
          // 立即清理
          global.gc();
          console.log('🗑️ ESC cancellation - Immediate forced GC cleanup');

          // 1秒后备份清理，确保彻底
          setTimeout(() => {
            if (typeof global !== 'undefined' && global.gc) {
              global.gc();
              console.log('🗑️ ESC cancellation - Backup GC cleanup (1s later)');
            }
          }, 1000);
        } catch (e) {
          // GC not available, ignore
        }
      }
    }
  });

  const prepareQueryForGemini = useCallback(
    async (
      query: PartListUnion,
      userMessageTimestamp: number,
      abortSignal: AbortSignal,
      prompt_id: string,
      originalQuery?: PartListUnion, // 可选的原始查询，用于历史记录
      silent?: boolean, // 🎯 静默模式：不在 UI 上显示用户消息
    ): Promise<{
      queryToSend: PartListUnion | null;
      shouldProceed: boolean;
      silent?: boolean; // 🎯 传递静默模式标志
    }> => {
      if (turnCancelledRef.current) {
        return { queryToSend: null, shouldProceed: false };
      }
      if (typeof query === 'string' && query.trim().length === 0) {
        return { queryToSend: null, shouldProceed: false };
      }

      let localQueryToSendToGemini: PartListUnion | null = null;

      if (typeof query === 'string') {
        const trimmedQuery = query.trim();
        // 使用原始查询记录日志，避免记录Plan模式的修改内容
        const queryForLogging = typeof originalQuery === 'string' ? originalQuery.trim() : trimmedQuery;

        logUserPrompt(
          config,
          new UserPromptEvent(
            queryForLogging.length,
            prompt_id,
            config.getContentGeneratorConfig()?.authType,
            queryForLogging,
          ),
        );
        onDebugMessage(`User query: '${queryForLogging}'`);
        await logger?.logMessage(MessageSenderType.USER, queryForLogging);

        // Handle UI-only commands first - 使用原始查询处理slash命令
        const slashCommandResult = await handleSlashCommand(queryForLogging);

        if (slashCommandResult) {
          switch (slashCommandResult.type) {
            case 'schedule_tool': {
              const { toolName, toolArgs } = slashCommandResult;
              const toolCallRequest: ToolCallRequestInfo = {
                callId: `${toolName}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
                name: toolName,
                args: toolArgs,
                isClientInitiated: true,
                prompt_id,
              };
              await scheduleToolCalls([toolCallRequest], abortSignal);
              return { queryToSend: null, shouldProceed: false };
            }
            case 'submit_prompt': {
              localQueryToSendToGemini = slashCommandResult.content;

              return {
                queryToSend: localQueryToSendToGemini,
                shouldProceed: true,
                silent: slashCommandResult.silent, // 🎯 传递静默模式
              };
            }
            case 'handled': {
              return { queryToSend: null, shouldProceed: false };
            }
            case 'refine_result': {
              // 润色结果已经返回到 UI 层等待用户确认
              // 不立即发送给 AI，等待用户操作（回车发送/R再润色/Esc取消）
              return { queryToSend: null, shouldProceed: false };
            }
            case 'select_session': {
              return { queryToSend: null, shouldProceed: false };
            }
            default: {
              const unreachable: never = slashCommandResult;
              throw new Error(
                `Unhandled slash command result type: ${unreachable}`,
              );
            }
          }
        }

        if (shellModeActive && handleShellCommand(queryForLogging, abortSignal)) {
          return { queryToSend: null, shouldProceed: false };
        }

        // Handle help mode
        if (helpModeActive) {
          // Add user question to history
          addItem(
            { type: 'user', text: queryForLogging },
            userMessageTimestamp,
          );

          try {
            // Query the help system
            const answer = await HelpSubagent.answerQuestion(queryForLogging, config);

            // Add AI answer to history (使用 gemini 类型)
            addItem(
              { type: 'gemini', text: answer },
              Date.now(),
            );
          } catch (error) {
            // 使用与普通模式相同的错误格式化逻辑
            addItem(
              {
                type: MessageType.ERROR,
                text: parseAndFormatApiError(
                  error,
                  config.getContentGeneratorConfig()?.authType,
                  undefined,
                  config.getModel(),
                  DEFAULT_GEMINI_FLASH_MODEL,
                ),
              },
              Date.now(),
            );
          }

          return { queryToSend: null, shouldProceed: false };
        }

        // Handle @-commands (which might involve tool calls)
        if (isAtCommand(queryForLogging)) {
          const atCommandResult = await handleAtCommand({
            query: queryForLogging,
            config,
            addItem,
            onDebugMessage,
            messageId: userMessageTimestamp,
            signal: abortSignal,
          });
          if (!atCommandResult.shouldProceed) {
            return { queryToSend: null, shouldProceed: false };
          }
          localQueryToSendToGemini = atCommandResult.processedQuery;
        } else {
          // Normal query for Gemini - 添加用户消息到历史记录（用于AI上下文）
          // 🎯 静默模式下不在 UI 显示用户消息（如后台任务通知）
          if (!silent) {
            addItem(
              { type: MessageType.USER, text: queryForLogging },
              userMessageTimestamp,
            );
          }
          localQueryToSendToGemini = trimmedQuery; // 但仍使用修改后的查询发送给AI
        }
      } else {
        // It's a function response (PartListUnion that isn't a string)
        localQueryToSendToGemini = query;
      }

      if (localQueryToSendToGemini === null) {
        onDebugMessage(
          'Query processing resulted in null, not sending to Gemini.',
        );
        return { queryToSend: null, shouldProceed: false };
      }
      return { queryToSend: localQueryToSendToGemini, shouldProceed: true };
    },
    [
      config,
      addItem,
      onDebugMessage,
      handleShellCommand,
      handleSlashCommand,
      logger,
      shellModeActive,
      scheduleToolCalls,
    ],
  );

  // --- Stream Event Handlers ---

  const handleContentEvent = useCallback(
    (
      eventValue: ContentEvent['value'],
      currentGeminiMessageBuffer: string,
      userMessageTimestamp: number,
    ): string => {
      if (turnCancelledRef.current) {
        // Prevents additional output after a user initiated cancel.
        return '';
      }

      // 🆕 标记内容已开始；思考框随之立即消失
      if (!hasContentStarted) {
        setHasContentStarted(true);
        setReasoning(null);
      }

      // 🎯 累积 AI 的文本回复，用于 Checkpoint 摘要
      aiTextBeforeToolsRef.current += eventValue;

      let newGeminiMessageBuffer = currentGeminiMessageBuffer + eventValue;
      if (
        pendingHistoryItemRef.current?.type !== 'gemini' &&
        pendingHistoryItemRef.current?.type !== 'gemini_content'
      ) {
        if (pendingHistoryItemRef.current) {
          addItem(pendingHistoryItemRef.current, userMessageTimestamp);
        }
        setPendingHistoryItem({ type: 'gemini', text: '' });
        newGeminiMessageBuffer = eventValue;
      }
      // Split large messages for better rendering performance. Ideally,
      // we should maximize the amount of output sent to <Static />.
      const splitPoint = findLastSafeSplitPoint(newGeminiMessageBuffer);
      if (splitPoint === newGeminiMessageBuffer.length) {
        // Update the existing message with accumulated content
        setPendingHistoryItem((item) => ({
          type: item?.type as 'gemini' | 'gemini_content',
          text: newGeminiMessageBuffer,
        }));
      } else {
        // This indicates that we need to split up this Gemini Message.
        // Splitting a message is primarily a performance consideration. There is a
        // <Static> component at the root of App.tsx which takes care of rendering
        // content statically or dynamically. Everything but the last message is
        // treated as static in order to prevent re-rendering an entire message history
        // multiple times per-second (as streaming occurs). Prior to this change you'd
        // see heavy flickering of the terminal. This ensures that larger messages get
        // broken up so that there are more "statically" rendered.
        const beforeText = newGeminiMessageBuffer.substring(0, splitPoint);
        const afterText = newGeminiMessageBuffer.substring(splitPoint);
        addItem(
          {
            type: pendingHistoryItemRef.current?.type as
              | 'gemini'
              | 'gemini_content',
            text: beforeText,
          },
          userMessageTimestamp,
        );
        setPendingHistoryItem({ type: 'gemini_content', text: afterText });
        newGeminiMessageBuffer = afterText;
      }
      return newGeminiMessageBuffer;
    },
    [addItem, pendingHistoryItemRef, setPendingHistoryItem, setHasContentStarted],
  );

  const handleUserCancelledEvent = useCallback(
    (userMessageTimestamp: number) => {
      if (turnCancelledRef.current) {
        return;
      }
      if (pendingHistoryItemRef.current) {
        if (pendingHistoryItemRef.current.type === 'tool_group') {
          const updatedTools = pendingHistoryItemRef.current.tools.map(
            (tool) =>
              tool.status === ToolCallStatus.Pending ||
              tool.status === ToolCallStatus.Confirming ||
              tool.status === ToolCallStatus.Executing
                ? { ...tool, status: ToolCallStatus.Canceled }
                : tool,
          );
          const pendingItem: HistoryItemToolGroup = {
            ...pendingHistoryItemRef.current,
            tools: updatedTools,
          };
          addItem(pendingItem, userMessageTimestamp);
        } else {
          addItem(pendingHistoryItemRef.current, userMessageTimestamp);
        }
        setPendingHistoryItem(null);
      }
      addItem(
        { type: MessageType.INFO, text: 'User cancelled the request.' },
        userMessageTimestamp,
      );
      // 🎭 若当前在辩论中，中止正在进行的模型切换，并标记为暂停
      if (getActiveDebate()) {
        debateAbortRef.current?.abort();
        debateAbortRef.current = null;
        pauseDebate();
        addItem(
          {
            type: MessageType.INFO,
            text: '🎭 辩论已暂停。使用 /debate continue 继续，或 /debate end 结束。',
          },
          userMessageTimestamp,
        );
      }
      // 🛡️ 重置同步标志位
      processingRef.current = false;
      setIsResponding(false);
      // 用户取消：隐藏思考框
      setReasoning(null);
      clearEstimatedTokens(); // 清除预估token

      // Linus fix: 用户取消时也要执行内存清理，防止内存泄漏
      if (typeof global !== 'undefined' && global.gc) {
        try {
          // 立即清理
          global.gc();
          console.log('🗑️ User cancellation - Immediate forced GC cleanup');

          // 1秒后备份清理，确保彻底
          setTimeout(() => {
            if (typeof global !== 'undefined' && global.gc) {
              global.gc();
              console.log('🗑️ User cancellation - Backup GC cleanup (1s later)');
            }
          }, 1000);
        } catch (e) {
          // GC not available, ignore
        }
      }
    },
    [addItem, pendingHistoryItemRef, setPendingHistoryItem],
  );

  const handleErrorEvent = useCallback(
    (eventValue: ErrorEvent['value'], userMessageTimestamp: number) => {
      if (pendingHistoryItemRef.current) {
        addItem(pendingHistoryItemRef.current, userMessageTimestamp);
        setPendingHistoryItem(null);
      }

      // 🆕 自定义模型：跳过 451 地区限制错误的特殊处理
      // 自定义模型的 API 端点不受官方地区限制，这些错误应该被忽略
      const currentModel = config.getModel();
      const usingCustomModel = currentModel && isCustomModel(currentModel);

      const errorString = String(eventValue.error);
      const errorMessage = typeof eventValue.error === 'object' && eventValue.error !== null && 'message' in eventValue.error
        ? String((eventValue.error as any).message)
        : errorString;

      // 🆕 流中断错误特殊处理 - 抛出特殊异常让外层处理自动重试
      const isStreamInterruptError =
        errorMessage.includes('Stream interrupted') ||
        errorMessage.includes('terminated mid-stream') ||
        errorMessage.includes('Connection was terminated');

      if (isStreamInterruptError) {
        // 抛出带标记的异常，让外层 catch 处理自动重试
        const streamInterruptError = new Error(errorMessage);
        (streamInterruptError as any).isStreamInterrupt = true;
        throw streamInterruptError;
      }

      // 451错误特殊处理 - 直接结束会话（仅对非自定义模型生效）
      const is451Error = errorString.includes('451') ||
                          (eventValue.error && typeof eventValue.error === 'object' &&
                           'status' in eventValue.error && eventValue.error.status === 451);

      if (is451Error && !usingCustomModel) {
        addItem(
          {
            type: MessageType.ERROR,
            text: parseAndFormatApiError(
              eventValue.error,
              config.getContentGeneratorConfig()?.authType,
              undefined,
              config.getModel(),
              DEFAULT_GEMINI_FLASH_MODEL,
            ),
          },
          userMessageTimestamp,
        );

        // 完全复制ESC取消的逻辑 - 立即终止会话
        turnCancelledRef.current = true;
        abortControllerRef.current?.abort();
        setPendingHistoryItem(null);
        processingRef.current = false;
        setIsResponding(false);
        clearEstimatedTokens();

        // 抛出特殊异常立即中断事件循环
        throw new Error('REGION_BLOCKED_SESSION_TERMINATED');
      }

      addItem(
        {
          type: MessageType.ERROR,
          text: parseAndFormatApiError(
            eventValue.error,
            config.getContentGeneratorConfig()?.authType,
            undefined,
            config.getModel(),
            DEFAULT_GEMINI_FLASH_MODEL,
          ),
        },
        userMessageTimestamp,
      );
    },
    [addItem, pendingHistoryItemRef, setPendingHistoryItem, config, processingRef, abortControllerRef, setIsResponding, turnCancelledRef, clearEstimatedTokens],
  );

  const handleFinishedEvent = useCallback(
    (event: ServerGeminiFinishedEvent, userMessageTimestamp: number) => {
      const finishReason = event.value;

      const finishReasonMessages: Record<FinishReason, string | undefined> = {
        [FinishReason.FINISH_REASON_UNSPECIFIED]: undefined,
        [FinishReason.STOP]: undefined,
        [FinishReason.MAX_TOKENS]: 'Response truncated due to token limits.',
        [FinishReason.SAFETY]: 'Response stopped due to safety reasons.',
        [FinishReason.RECITATION]: 'Response stopped due to recitation policy.',
        [FinishReason.LANGUAGE]:
          'Response stopped due to unsupported language.',
        [FinishReason.BLOCKLIST]: 'Response stopped due to forbidden terms.',
        [FinishReason.PROHIBITED_CONTENT]:
          'Response stopped due to prohibited content.',
        [FinishReason.SPII]:
          'Response stopped due to sensitive personally identifiable information.',
        [FinishReason.OTHER]: 'Response stopped for other reasons.',
        [FinishReason.MALFORMED_FUNCTION_CALL]:
          'Response stopped due to malformed function call.',
        [FinishReason.IMAGE_SAFETY]:
          'Response stopped due to image safety violations.',
        [FinishReason.IMAGE_PROHIBITED_CONTENT]:
          'Response stopped due to prohibited image content.',
        [FinishReason.NO_IMAGE]:
          'Response stopped due to missing image.',
        [FinishReason.IMAGE_RECITATION]:
          'Response stopped due to image recitation policy.',
        [FinishReason.IMAGE_OTHER]:
          'Response stopped due to other image-related reasons.',
        [FinishReason.UNEXPECTED_TOOL_CALL]:
          'Response stopped due to unexpected tool call.',
      };

      let message = finishReasonMessages[finishReason];

      // For MALFORMED_FUNCTION_CALL, append detailed error information
      if (finishReason === FinishReason.MALFORMED_FUNCTION_CALL && event.errorDetails) {
        message = `${message}\n\nDetails: ${event.errorDetails}\n\nPlease ensure all function call parameters are valid JSON objects with correct structure.`;
      }

      if (message) {
        addItem(
          {
            type: 'info',
            text: `⚠️  ${message}`,
          },
          userMessageTimestamp,
        );
      }
    },
    [addItem],
  );

  const handleChatCompressionEvent = useCallback(
    (eventValue: ServerGeminiChatCompressedEvent['value']) => {
      // 兼容旧格式：value 可能是 null（异常情况）
      if (!eventValue) {
        addItem(
          {
            type: MessageType.ERROR,
            text: t('conversation.compress.failed.unknown'),
          },
          Date.now(),
        );
        return;
      }

      // 成功：分两种情况显示
      if (eventValue.success) {
        if (eventValue.degraded) {
          // 降级模式：全量压缩失败，MicroCompact 兜底瘦身成功
          // 用 INFO（而非 COMPRESSION）提示用户"以精简模式继续"，并告知兜底原因
          addItem(
            {
              type: MessageType.INFO,
              text: tp('conversation.compress.degraded', {
                clearedCount: eventValue.clearedCount ?? 0,
              }),
            },
            Date.now(),
          );
          return;
        }

        // 常规成功：使用与 /compress 命令一致的 COMPRESSION 消息类型
        addItem(
          {
            type: MessageType.COMPRESSION,
            compression: {
              isPending: false,
              originalTokenCount: eventValue.info?.originalTokenCount ?? null,
              newTokenCount: eventValue.info?.newTokenCount ?? null,
            },
          } as HistoryItemCompression,
          Date.now(),
        );
        return;
      }

      // 失败/熔断：明确告知用户，并建议手动 /compress 或 /session new
      const reason = eventValue.reason ?? 'unknown';
      const isCircuitBreaker = reason.startsWith('circuit_breaker');
      const failureKey = isCircuitBreaker
        ? 'conversation.compress.failed.circuit_breaker'
        : 'conversation.compress.failed.generic';
      addItem(
        {
          type: MessageType.ERROR,
          text: tp(failureKey, { reason }),
        },
        Date.now(),
      );
    },
    [addItem],
  );

  const handleMaxSessionTurnsEvent = useCallback(
    () =>
      addItem(
        {
          type: 'info',
          text:
            `The session has reached the maximum number of turns: ${config.getMaxSessionTurns()}. ` +
            `Please update this limit in your setting.json file.`,
        },
        Date.now(),
      ),
    [addItem, config],
  );

  const handleLoopDetectedEvent = useCallback((loopType?: string) => {
    let title = '';
    let description = '';
    let action = '';

    // Get localized messages based on loop type
    const locale = isChineseLocale() ? 'zh' : 'en';

    switch (loopType) {
      case 'consecutive_identical_tool_calls':
        title = t('loop.consecutive.tool.calls.title');
        description = t('loop.consecutive.tool.calls.description');
        action = t('loop.consecutive.tool.calls.action');
        break;
      case 'chanting_identical_sentences':
        title = t('loop.chanting.identical.sentences.title');
        description = t('loop.chanting.identical.sentences.description');
        action = t('loop.chanting.identical.sentences.action');
        break;
      case 'llm_detected_loop':
        title = t('loop.llm.detected.title');
        description = t('loop.llm.detected.description');
        action = t('loop.llm.detected.action');
        break;
      default:
        // Fallback for unknown or missing loop type
        title = '🔄 Loop Detected';
        description = 'The AI model may be stuck in a repetitive pattern.';
        action = 'Please try:\n• Refining your request\n• Providing additional context\n• Starting a new session with /session new';
    }

    const messageText = `${title}\n${description}\n\n${action}`;

    addItem(
      {
        type: 'info',
        text: messageText,
      },
      Date.now(),
    );
  }, [addItem]);

  const processGeminiStreamEvents = useCallback(
    async (
      stream: AsyncIterable<GeminiEvent>,
      userMessageTimestamp: number,
      signal: AbortSignal,
    ): Promise<StreamProcessingStatus> => {
      let geminiMessageBuffer = '';
      let reasoningBuffer = ''; // 🆕 累积 reasoning 内容
      const toolCallRequests: ToolCallRequestInfo[] = [];
      for await (const event of stream) {
        // 检查abort信号，立即退出
        if (signal.aborted) {
          return StreamProcessingStatus.UserCancelled;
        }

        switch (event.type) {
          case ServerGeminiEventType.Thought:
            setThought(event.value);
            break;
          case ServerGeminiEventType.Reasoning:
            // 🆕 累积 reasoning 内容
            reasoningBuffer += event.value.text;
            console.log(
              `[REASONING-TRACE][useGeminiStream] +${event.value.text.length}B → bufferLen=${reasoningBuffer.length}`,
            );
            setReasoning({ text: reasoningBuffer });
            break;
          case ServerGeminiEventType.Content:
            geminiMessageBuffer = handleContentEvent(
              event.value,
              geminiMessageBuffer,
              userMessageTimestamp,
            );
            break;
          case ServerGeminiEventType.ToolCallRequest:
            toolCallRequests.push(event.value);
            break;
          case ServerGeminiEventType.UserCancelled:
            handleUserCancelledEvent(userMessageTimestamp);
            break;
          case ServerGeminiEventType.Error:
            try {
              handleErrorEvent(event.value, userMessageTimestamp);
            } catch (error: any) {
              if (error.message === 'REGION_BLOCKED_SESSION_TERMINATED') {
                return StreamProcessingStatus.UserCancelled; // 立即退出循环
              }
              throw error; // 重新抛出其他错误
            }
            break;
          case ServerGeminiEventType.ChatCompressed:
            handleChatCompressionEvent(event.value);
            break;
          case ServerGeminiEventType.ToolCallConfirmation:
          case ServerGeminiEventType.ToolCallResponse:
            // do nothing
            break;
          case ServerGeminiEventType.MaxSessionTurns:
            handleMaxSessionTurnsEvent();
            break;
          case ServerGeminiEventType.Finished:
            handleFinishedEvent(
              event as ServerGeminiFinishedEvent,
              userMessageTimestamp,
            );
            break;
          case ServerGeminiEventType.LoopDetected:
            // handle later because we want to move pending history to history
            // before we add loop detected message to history
            loopDetectedRef.current = true;
            loopTypeRef.current = (event as any).value;
            break;
          case ServerGeminiEventType.TokenUsage:
            // Token usage events are handled at the client level for compression decisions
            // UI doesn't need to do anything specific with these events currently
            break;
          default: {
            // enforces exhaustive switch-case
            const unreachable: never = event;
            return unreachable;
          }
        }
      }
      // 流式传输完成：清空 reasoning 状态（思考过程仅在流式传输中显示）
      setReasoning(null);
      if (toolCallRequests.length > 0) {
        await scheduleToolCalls(toolCallRequests, signal);
      }
      return StreamProcessingStatus.Completed;
    },
    [
      handleContentEvent,
      handleUserCancelledEvent,
      handleErrorEvent,
      scheduleToolCalls,
      handleChatCompressionEvent,
      handleFinishedEvent,
      handleMaxSessionTurnsEvent,
    ],
  );

  const submitQuery = useCallback(
    async (
      query: PartListUnion,
      options?: { isContinuation?: boolean; silent?: boolean },
      prompt_id?: string,
    ) => {
      // 🛡️ 同步检查和设置标志位，防止重入
      if (processingRef.current && !options?.isContinuation) {
        return; // 立即阻止重入
      }

      if (
        (streamingState === StreamingState.Responding ||
          streamingState === StreamingState.WaitingForConfirmation) &&
        !options?.isContinuation
      )
        return;

      // 保存原始查询用于历史记录
      const originalQuery = query;

      // Plan模式特殊处理 - 只修改发送给AI的内容，不影响历史记录
      let modifiedQuery = query;
      // 🎯 检测来自 VS Code 的 Plan 模式标记消息
      const queryStr = typeof query === 'string' ? query : JSON.stringify(query);
      const planModeDetection = detectPlanModeChange(queryStr);

      // 🎯 如果检测到 Plan 模式退出标记，自动同步后端状态
      if (planModeDetection.modeChanged && !planModeDetection.newMode) {
        console.log('[Plan Mode] Detected plan mode exit marker from VS Code, syncing state...');
        config.setPlanModeActive(false);
        // 不注入Plan模式提示，因为用户已经明确退出
      } else if (config.getPlanModeActive() && !options?.isContinuation) {
        const planPrompt = `[PLAN MODE ACTIVE]
The user is currently in Plan mode, focusing on requirements discussion and solution design. Please:
1. You may use analytical tools: read_file, read_many_files, list_directory, grep, glob, web_fetch, task, etc.
2. Do NOT use modification tools: write_file, edit, shell, lint_fix, etc.
3. Focus on understanding requirements, discussing solutions, and designing architecture
4. Provide detailed planning and recommendations, but do not perform modification operations
5. If modification operations are needed, remind the user to first use /plan off to exit Plan mode

User question: ${queryStr}`;

        modifiedQuery = planPrompt;
      }

      // 🛡️ 立即设置同步标志位
      processingRef.current = true;
      // 🎯 立即开始显示加载状态
      setIsResponding(true);
      // 🆕 重置内容开始标志
      setHasContentStarted(false);
      // 新一轮请求开始：清掉上一轮残留的思考框
      setReasoning(null);

      const userMessageTimestamp = Date.now();

      // 🔄 异步更新模型配置（仅在新对话时，不在继续对话时）
      if (!options?.isContinuation && settings && config) {
        refreshModelsInBackground(settings, config).catch(() => {
          // 静默处理刷新失败，不影响当前请求
        });
      }

      // Reset quota error flag when starting a new query (not a continuation)
      if (!options?.isContinuation) {
        setModelSwitchedFromQuotaError(false);
        config.setQuotaErrorOccurred(false);

        // 🔄 重置checkpoint创建标志 - 新对话开始
        conversationCheckpointCreated.current = false;
        // 🔄 重置checkpoint创建失败标志 - 新对话开始
        checkpointCreationFailed.current = false;
        // 🔄 清除上一次的用户输入记录
        currentUserQueryRef.current = '';
        // 🔄 清除上一次的 AI 文本回复记录
        aiTextBeforeToolsRef.current = '';
        // 🔄 清除上一次的摘要记录
        currentSessionSummaryRef.current = null;
      }

      abortControllerRef.current = new AbortController();
      const abortSignal = abortControllerRef.current.signal;
      turnCancelledRef.current = false;

      if (!prompt_id) {
        prompt_id = config.getSessionId() + '########' + getPromptCount();
      }

      // 🎯 保存当前用户输入供 checkpoint 创建时使用
      if (typeof query === 'string' && !options?.isContinuation) {
        currentUserQueryRef.current = query.trim();

        // 🎯 立即生成会话摘要并更新窗口标题（基于用户消息）
        // 取消上一次未完成的摘要请求：
        // - 节省后端配额（旧的 LLM 调用没必要再跑完）
        // - 防止 race：旧 summary 晚到时不应再覆盖新标题
        if (summaryAbortControllerRef.current) {
          summaryAbortControllerRef.current.abort();
        }
        const summaryController = new AbortController();
        summaryAbortControllerRef.current = summaryController;
        const summarySignal = summaryController.signal;

        (async () => {
           try {
             const trimmedQuery = query.trim();
             // 限制输入长度，避免过长
             const summarySource = trimmedQuery.substring(0, 500);

             if (summarySource.length > 0) {
                let summary: string | undefined;

                // 智能阈值判断：
                // 1. 如果是中文，超过 10 个字触发摘要
                // 2. 如果是英文，超过 5 个单词触发摘要
                // 否则直接使用原文，节省 AI 调用
                const hasChinese = /[\u4e00-\u9fa5]/.test(summarySource);
                const wordCount = summarySource.split(/\s+/).length;

                const shouldSummarize = hasChinese
                    ? summarySource.length > 10
                    : wordCount > 5;

                if (!shouldSummarize) {
                   // 直接使用原文，但去除换行符以适应标题显示
                   summary = summarySource.replace(/[\r\n]+/g, ' ');
                } else {
                   summary = await generateCheckpointSummary(geminiClient, summarySource, config.getModel(), summarySignal);
                }

                // race 防护：如果在此期间用户已经发起新一轮 query，
                // 当前 controller 已经不是最新的（或已被 abort），
                // 那么本次摘要的结果作废，不写 ref 也不更新标题。
                if (summarySignal.aborted || summaryAbortControllerRef.current !== summaryController) {
                  return;
                }

                if (summary) {
                  currentSessionSummaryRef.current = summary;
                  if (settings) {
                    const workspaceName = path.basename(config.getProjectRoot());
                    updateWindowTitleWithSummary(summary, settings, workspaceName);
                  }
                }
             }
           } catch (e) {
             // Non-critical: summary is just used for the window title.
             // 用户连发新 query 导致主动 abort 是预期行为，不打 warn。
             if (summarySignal.aborted) {
               return;
             }
             const msg = e instanceof Error ? e.message : String(e);
             console.warn('[Summary] Immediate summary skipped (non-critical):', msg);
           }
        })();
      }

      const { queryToSend, shouldProceed, silent: resultSilent } = await prepareQueryForGemini(
        modifiedQuery,
        userMessageTimestamp,
        abortSignal,
        prompt_id!,
        originalQuery, // 传递原始查询用于历史记录
        options?.silent, // 🎯 静默模式（从调用者传入）
      );

      // 🎯 合并静默模式：来自调用者或来自命令返回
      const effectiveSilent = options?.silent || resultSilent;

      if (!shouldProceed || queryToSend === null) {
        // 🛡️ 重置同步标志位
        processingRef.current = false;
        // 🎯 立即开始显示加载状态
        setIsResponding(false);
        return;
      }

      if (!options?.isContinuation) {
        startNewPrompt();
      }


      setInitError(null);

      // 🎯 异步获取预估输入token数量 - 不阻塞UI显示
      if (setEstimatedInputTokens && !options?.isContinuation) {
        // 立即设置一个初始值，表示正在加载
        setEstimatedInputTokens(0);

        // 异步获取真实的预估值
        (async () => {
          try {
            // 等待 GeminiChat 初始化完成（带重试机制）
            const chat = await geminiClient.waitForChatInitialized();

            // 获取完整的对话历史（使用 curated 版本确保格式正确）
            const existingHistory = chat.getHistory(true);

            // 构建完整的请求内容：历史记录 + 当前用户输入
            const contents: any[] = [...existingHistory];

            // 添加当前用户输入
            if (typeof queryToSend === 'string') {
              contents.push({ parts: [{ text: queryToSend }], role: MESSAGE_ROLES.USER });
            } else if (Array.isArray(queryToSend)) {
              // 处理PartListUnion[]类型
              const textParts = queryToSend.filter(part =>
                typeof part === 'object' && part !== null && 'text' in part
              ) as any[];
              if (textParts.length > 0) {
                contents.push({
                  parts: textParts.map(part => ({ text: part.text })),
                  role: MESSAGE_ROLES.USER
                });
              }
            }

            if (contents.length > 0) {
              // 通过config获取ContentGenerator
              const contentGenerator = config.getGeminiClient().getContentGenerator();
              if (contentGenerator && 'countTokens' in contentGenerator) {
                // 获取系统指令和工具声明
                const systemInstruction = chat.getSystemInstruction();
                const tools = chat.getTools();

                // 构建 config 对象（仅包含有效值）
                const countConfig: { systemInstruction?: typeof systemInstruction; tools?: typeof tools } = {};
                if (systemInstruction) {
                  countConfig.systemInstruction = systemInstruction;
                }
                if (tools && tools.length > 0) {
                  countConfig.tools = tools;
                }

                const tokenResponse = await contentGenerator.countTokens({
                  contents,
                  model: config.getModel(),
                  // 传递系统指令和工具声明（如果有）
                  config: Object.keys(countConfig).length > 0 ? countConfig : undefined
                });
                // 更新预估token显示
                setEstimatedInputTokens(tokenResponse.totalTokens || 0);
                console.log(`[Token Estimation] Estimated input tokens: ${tokenResponse.totalTokens || 0} (history: ${existingHistory.length} messages, hasSystemInstruction: ${!!systemInstruction}, hasTools: ${!!(tools && tools.length > 0)})`);
              }
            }
          } catch (error) {
            console.warn('[Token Estimation] Failed to estimate tokens:', error);
            // 保持显示0而不是undefined，这样用户知道在尝试获取
            setEstimatedInputTokens(0);
          }
        })();
      }

      // Linus fix: 请求开始前清理 - 确保干净起点
      if (typeof global !== 'undefined' && global.gc) {
        try {
          global.gc();
          console.log('🧹 Pre-request memory cleanup');
        } catch (e) {
          // GC not available, ignore
        }
      }

      // 简化：无需注册主查询任务到中央状态管理器

      try {
        // 🔄 确保Chat已初始化（带重试机制）- 修复启动时立即发送消息导致的错误
        await geminiClient.waitForChatInitialized();

        const stream = geminiClient.sendMessageStream(
          queryToSend,
          abortSignal,
          prompt_id!,
        );
        const processingStatus = await processGeminiStreamEvents(
          stream,
          userMessageTimestamp,
          abortSignal,
        );

        // 🎯 修复：即使是用户取消，也要保存已经收到的部分内容（如已触发的 functionCall）到历史记录
        // 这样可以确保后续产生的工具执行结果有对应的调用记录可匹配。
        if (pendingHistoryItemRef.current) {
          addItem(pendingHistoryItemRef.current, userMessageTimestamp);
          setPendingHistoryItem(null);
        }

        if (processingStatus === StreamProcessingStatus.UserCancelled) {
          return;
        }
        if (loopDetectedRef.current) {
          loopDetectedRef.current = false;
          handleLoopDetectedEvent(loopTypeRef.current);
          loopTypeRef.current = undefined;
        }
      } catch (error: unknown) {
        // 🆕 TCP 流中断错误特殊处理 - 等待后自动继续
        // 当服务器重启或网络异常导致流式传输中途断开时，自动恢复
        // 检测方式：1. isStreamInterrupt 属性标记  2. 错误消息包含特定文本
        const isStreamInterruptError = error instanceof Error && (
          (error as any).isStreamInterrupt ||
          error.message.includes('Stream interrupted') ||
          error.message.includes('terminated mid-stream')
        );

        if (isStreamInterruptError) {
          const bytesReceived = (error as any).bytesReceived || 0;
          console.log(`⚠️  ${t('stream.interrupted')} (${bytesReceived} bytes received)`);

          // 保存已收到的部分内容到历史
          if (pendingHistoryItemRef.current) {
            addItem(pendingHistoryItemRef.current, userMessageTimestamp);
            setPendingHistoryItem(null);
          }

          // 倒计时 10 秒，通过事件系统在 UI 组件中显示
          const countdownTotal = 10;
          appEvents.emit(AppEvent.StreamRecoveryStart, { total: countdownTotal });

          for (let remaining = countdownTotal; remaining > 0; remaining--) {
            appEvents.emit(AppEvent.StreamRecoveryCountdown, { remaining });
            await new Promise(resolve => setTimeout(resolve, 1000));
          }

          appEvents.emit(AppEvent.StreamRecoveryEnd);

          // 重置状态以便重新发送
          processingRef.current = false;
          setIsResponding(false);

          // 自动发送继续消息（静默模式，用户不可见）
          const continueMessage = t('stream.continue.prompt');
          console.log(`🔄 ${t('stream.autoRetry')}: "${continueMessage}"`);

          // 递归调用 submitQuery 发送继续消息
          // 使用 setTimeout 确保状态已更新，silent: true 让用户看不到这条消息
          setTimeout(() => {
            submitQuery(continueMessage, { silent: true });
          }, 100);
          return;
        }

        // 🆕 自定义模型：跳过 451 地区限制错误的特殊处理
        const currentModel = config.getModel();
        const usingCustomModel = currentModel && isCustomModel(currentModel);

        // 451错误特殊处理 - 直接模拟ESC键终止会话（仅对非自定义模型生效）
        const errorString = String(error);
        if ((errorString.includes('REGION_BLOCKED_451') || errorString.includes('451')) && !usingCustomModel) {
          // 完全模拟ESC键的处理逻辑
          if (!turnCancelledRef.current) {
            turnCancelledRef.current = true;
            abortControllerRef.current?.abort();
            if (pendingHistoryItemRef.current) {
              addItem(pendingHistoryItemRef.current, userMessageTimestamp);
            }
            addItem(
              {
                type: MessageType.ERROR,
                text: parseAndFormatApiError(
                  error,
                  config.getContentGeneratorConfig()?.authType,
                  undefined,
                  config.getModel(),
                  DEFAULT_GEMINI_FLASH_MODEL,
                ),
              },
              userMessageTimestamp,
            );
            setPendingHistoryItem(null);
            processingRef.current = false;
            setIsResponding(false);
            clearEstimatedTokens();
          }
          return; // 立即返回，不继续处理
        }

        if (error instanceof UnauthorizedError) {
          // 如果配置了自定义代理URL，跳过认证错误处理
          if (customProxyUrl) {
            console.log('[useGeminiStream] Custom proxy URL configured, ignoring UnauthorizedError');
          } else {
            onAuthError();
          }
        } else if (!isNodeError(error) || error.name !== 'AbortError') {
          // BUG修复: 用户取消请求时不显示错误堆栈
          // 修复策略: 检查错误消息是否包含用户取消相关内容，如果是则不显示错误
          // 影响范围: packages/cli/src/ui/hooks/useGeminiStream.ts:684-701
          // 修复日期: 2025-08-09
          const errorMessage = getErrorMessage(error) || 'Unknown error';
          const isUserCancellation = errorMessage.includes('cancelled by user') ||
                                   errorMessage.includes('Request cancelled') ||
                                   error instanceof Error && error.name === 'AbortError';

          if (!isUserCancellation) {
            addItem(
              {
                type: MessageType.ERROR,
                text: parseAndFormatApiError(
                  errorMessage,
                  config.getContentGeneratorConfig()?.authType,
                  undefined,
                  config.getModel(),
                  DEFAULT_GEMINI_FLASH_MODEL,
                ),
              },
              userMessageTimestamp,
            );
          }
        }
      } finally {
        // 🛡️ 重置同步标志位
        processingRef.current = false;
        setIsResponding(false);
        clearEstimatedTokens(); // 清除预估token

        // Linus fix: 简单有效的双重清理策略
        if (typeof global !== 'undefined' && global.gc) {
          try {
            // 立即清理
            global.gc();
            console.log('🗑️ Immediate forced GC after request completion');

            // 1秒后备份清理，确保彻底
            setTimeout(() => {
              if (typeof global !== 'undefined' && global.gc) {
                global.gc();
                console.log('🗑️ Backup GC cleanup (1s later)');
              }
            }, 1000);
          } catch (e) {
            // GC not available, ignore
          }
        }

        // 简化：无需完成主查询任务
      }
    },
    [
      streamingState,
      setModelSwitchedFromQuotaError,
      prepareQueryForGemini,
      processGeminiStreamEvents,
      pendingHistoryItemRef,
      addItem,
      setPendingHistoryItem,
      setInitError,
      geminiClient,
      onAuthError,
      config,
      startNewPrompt,
      getPromptCount,
      handleLoopDetectedEvent,
      // TaskStateManager 已移除
    ],
  );

  const handleCompletedTools = useCallback(
    async (completedToolCallsFromScheduler: TrackedToolCall[]) => {
      if (isResponding) {
        return;
      }

      const completedAndReadyToSubmitTools =
        completedToolCallsFromScheduler.filter(
          (
            tc: TrackedToolCall,
          ): tc is TrackedCompletedToolCall | TrackedCancelledToolCall => {
            const isTerminalState =
              tc.status === 'success' ||
              tc.status === 'error' ||
              tc.status === 'cancelled';

            if (isTerminalState) {
              const completedOrCancelledCall = tc as
                | TrackedCompletedToolCall
                | TrackedCancelledToolCall;
              return (
                completedOrCancelledCall.response?.responseParts !== undefined
              );
            }
            return false;
          },
        );

      // Finalize any client-initiated tools as soon as they are done.
      const clientTools = completedAndReadyToSubmitTools.filter(
        (t) => t.request.isClientInitiated,
      );
      if (clientTools.length > 0) {
        markToolsAsSubmitted(clientTools.map((t) => t.request.callId));
      }

      // Identify new, successful save_memory calls that we haven't processed yet.
      const newSuccessfulMemorySaves = completedAndReadyToSubmitTools.filter(
        (t) =>
          t.request.name === 'save_memory' &&
          t.status === 'success' &&
          !processedMemoryToolsRef.current.has(t.request.callId),
      );

      if (newSuccessfulMemorySaves.length > 0) {
        // Perform the refresh only if there are new ones.
        void performMemoryRefresh();
        // Mark them as processed so we don't do this again on the next render.
        newSuccessfulMemorySaves.forEach((t) =>
          processedMemoryToolsRef.current.add(t.request.callId),
        );
      }

      const geminiTools = completedAndReadyToSubmitTools.filter(
        (t) => !t.request.isClientInitiated,
      );

      if (geminiTools.length === 0) {
        return;
      }

      // If all the tools were cancelled, don't submit a response to Gemini.
      const allToolsCancelled = geminiTools.every(
        (tc) => tc.status === 'cancelled',
      );

      if (allToolsCancelled) {
        if (geminiClient) {
          // We need to manually add the function responses to the history
          // so the model knows the tools were cancelled.
          const responsesToAdd = geminiTools.flatMap(
            (toolCall) => toolCall.response.responseParts,
          );
          const combinedParts: Part[] = [];
          for (const response of responsesToAdd) {
            if (Array.isArray(response)) {
              combinedParts.push(...response);
            } else if (typeof response === 'string') {
              combinedParts.push({ text: response });
            } else {
              combinedParts.push(response);
            }
          }
          geminiClient.addHistory({
            role: MESSAGE_ROLES.USER,
            parts: combinedParts,
          });
        }

        const callIdsToMarkAsSubmitted = geminiTools.map(
          (toolCall) => toolCall.request.callId,
        );
        markToolsAsSubmitted(callIdsToMarkAsSubmitted);
        return;
      }

      const responsesToSend: PartListUnion[] = geminiTools.map(
        (toolCall) => toolCall.response.responseParts,
      );
      const callIdsToMarkAsSubmitted = geminiTools.map(
        (toolCall) => toolCall.request.callId,
      );

      const prompt_ids = geminiTools.map(
        (toolCall) => toolCall.request.prompt_id,
      );

      markToolsAsSubmitted(callIdsToMarkAsSubmitted);

      // 🎯 Mid-turn injection: drain queued user prompts at this tool-call
      // boundary so they ride along with the tool results in the same
      // continuation request. The model sees them in the SAME conversation
      // turn — no need to wait for streamingState to fully return to Idle.
      const injectedPrompts = drainQueuedPromptsForInjection?.() ?? [];
      if (injectedPrompts.length > 0) {
        const header =
          injectedPrompts.length === 1
            ? '[Otto - USER MID-TURN MESSAGE] The user sent the following instruction while you were executing tools. Factor it in for the remainder of this turn.'
            : `[Otto - USER MID-TURN MESSAGES] The user sent ${injectedPrompts.length} additional instructions while you were executing tools. Factor them in for the remainder of this turn.`;
        const body = injectedPrompts
          .map((m, i) => (injectedPrompts.length > 1 ? `${i + 1}. ${m}` : m))
          .join('\n');
        responsesToSend.push({ text: `${header}\n\n${body}` });
      }

      // Don't continue if model was switched due to quota error
      if (modelSwitchedFromQuotaError) {
        return;
      }

      submitQuery(
        mergePartListUnions(responsesToSend),
        {
          isContinuation: true,
        },
        prompt_ids[0],
      );
    },
    [
      isResponding,
      submitQuery,
      markToolsAsSubmitted,
      geminiClient,
      performMemoryRefresh,
      modelSwitchedFromQuotaError,
      drainQueuedPromptsForInjection,
    ],
  );

  const pendingHistoryItems = [
    pendingHistoryItemRef.current,
    pendingToolCallGroupDisplay,
  ].filter((i) => i !== undefined && i !== null);

  // 🎯 记住在当前响应周期中是否有过工具调用
  const [hadToolsInCurrentResponse, setHadToolsInCurrentResponse] = useState(false);

  // 🎭 辩论推进的 AbortController ref（可能由外部传入共享）。
  //    落到一个内部 fallback ref 上，保证在未传入时也能工作。
  const internalDebateAdvanceAbortRef = useRef<AbortController | null>(null);
  const debateAbortRef = debateAdvanceAbortRef ?? internalDebateAdvanceAbortRef;

  // 🎯 记住上一次的流状态，用于检测状态变化
  const previousStreamingStateRef = useRef<StreamingState>(StreamingState.Idle);

  useEffect(() => {
    const previousState = previousStreamingStateRef.current;
    const currentState = streamingState;

    if (streamingState === StreamingState.Responding && toolCalls.length > 0) {
      // 响应过程中发现工具调用，记住这个状态
      setHadToolsInCurrentResponse(true);
    } else if (streamingState === StreamingState.Idle) {
      // 检测从 Responding 到 Idle 的状态变化，表示响应完成
      if (previousState === StreamingState.Responding) {
        // 播放响应完成提示音
        AudioNotification.play(NotificationSound.RESPONSE_COMPLETE).catch(err => {
          console.debug('[AudioNotification] Failed to play response complete sound:', err);
        });

        // 🎭 辩论模式：一轮响应完成后，切到下一个模型并喂中介话
        //
        // Cursor 语义（CURRENT speaker）：
        //   debate.cursor 指向**刚刚说完话的那个人**。Wizard 完成发开场白时
        //   cursor=(0,0)，模型 0 说完后本块触发，我们计算"下一位是谁"，切模型，
        //   成功后再 advanceCursor 把 cursor 推到新说话的人。
        //   当"下一位"越过最后一轮 → 辩论结束。
        //
        // 关键约束：
        // 1. 只有 status === 'running' 才推进。
        //    注意：不需要再检查"本轮是否有工具调用"——streamingState 的 useMemo
        //    实现里已经把"有未 submitted 给模型的已完成工具"也算作 Responding，
        //    所以 Idle 状态意味着"模型真的停了 + 所有工具回填完毕"，正是推进时机。
        //    之前用 toolCalls.length>0 的判断有 bug：toolCalls 数组是整个会话累积
        //    的，never cleared，会让会话里曾有工具调用后辩论永远无法推进。
        // 2. switchModel 不 throw，只返回 { success, error } —— 必须显式检查，
        //    否则中介话会被发到错的模型上
        // 3. advanceCursor() 必须在 switchModel 成功后才调用，否则 cursor 和
        //    currentModel 会错位
        // 4. switchModel 使用共享的 debateAbortRef，暂停/结束时能打断
        const debate = getActiveDebate();
        if (debate && debate.status === 'running') {
          // 计算下一位说话人的 (round, modelIdx)。若越过最后一轮末位，就是结束。
          let nextModelIdx = debate.cursor.modelIdx + 1;
          let nextRound = debate.cursor.round;
          if (nextModelIdx >= debate.models.length) {
            nextModelIdx = 0;
            nextRound += 1;
          }
          const isDebateFinished = nextRound >= debate.rounds;
          const nextModel = isDebateFinished ? null : debate.models[nextModelIdx]!;

          // 用共享 ref 存 AbortController，让 pauseDebate/endDebate/ESC 能打断 switchModel
          const abortController = new AbortController();
          debateAbortRef.current = abortController;

          (async () => {
            try {
              // 让当前帧 UI commit 完成后再开始切换
              await new Promise<void>(resolve => setTimeout(resolve, 0));

              // 切换前检查：如果已被暂停/结束则放弃
              if (getActiveDebate()?.status !== 'running') return;

              if (isDebateFinished || !nextModel) {
                // 最后一位刚说完 → 辩论自然结束
                const finishedDebate = getActiveDebate()!;
                advanceCursor(); // 推到 done 状态（仅为了 status 一致）
                endDebate();
                const summaryTexts = getDebateI18nTexts(
                  detectUILanguage(finishedDebate.language),
                );
                addItem(
                  { type: MessageType.INFO, text: summaryTexts.summaryGenerating },
                  Date.now(),
                );

                // 使用大上下文模型进行总结，如果失败则回退到 auto
                let summaryModel = DEBATE_SUMMARY_MODEL;
                let switchResult = await geminiClient.switchModel(
                  summaryModel,
                  abortController.signal,
                );

                if (abortController.signal.aborted) return;

                if (!switchResult.success) {
                  await geminiClient.switchModel(
                    DEBATE_SUMMARY_FALLBACK_MODEL,
                    abortController.signal,
                  );
                }

                if (abortController.signal.aborted) return;

                // 即使 auto 也失败了，不阻塞报告生成，继续用当前模型尝试（此时可能报错超长）

                // 提交总结 Prompt
                setTimeout(() => {
                  submitQuery(
                    buildSummaryPrompt(
                      finishedDebate.topic,
                      finishedDebate.models,
                      finishedDebate.language,
                    ),
                  );
                  // 总结请求发出后，异步执行模型还原
                  if (finishedDebate.originalModel) {
                    const originalModel = finishedDebate.originalModel;
                    setTimeout(async () => {
                      try {
                        await geminiClient.switchModel(
                          originalModel,
                          new AbortController().signal, // 还原模型不应受当前辩论 abort 影响
                        );
                        appEvents.emit(AppEvent.ModelChanged, originalModel);
                      } catch (err) {
                        console.warn(`[Debate] Failed to restore original model ${originalModel}:`, err);
                      }
                    }, 100);
                  }
                }, 0);
                return;
              }

              // 切到下一个模型。switchModel 失败时返回 { success:false }，必须检查，
              // 否则中介话会发到错的模型上。
              // 不再打"🎭 切换到 X..."瞬时提示——DebateIndicator 常驻显示当前
              // 发言模型，不受 React 18 批处理/Ink 渲染吞帧影响。

              const switchResult = await geminiClient.switchModel(
                nextModel,
                abortController.signal,
              );

              // switchModel 期间可能被中止或暂停
              if (abortController.signal.aborted || getActiveDebate()?.status !== 'running') return;

              if (!switchResult.success) {
                pauseDebate();
                addItem(
                  {
                    type: MessageType.ERROR,
                    text: `⚠️ 辩论推进失败：切换到 ${nextModel} 失败（${switchResult.error ?? '未知错误'}）。使用 /debate continue 恢复。`,
                  },
                  Date.now(),
                );
                return;
              }

              // 切换成功 → emit ModelChanged → 推进 cursor → 发 followup。
              // 压缩信息（若有）打一条 INFO（一次性的有价值信息）。
              // 不再打"✓ 已切换到 X"——DebateIndicator 会在下次 poll 时
              // 自动反映新的 cursor，用户任何时候抬头都能看见当前发言方。
              appEvents.emit(AppEvent.ModelChanged, nextModel);
              if (switchResult.compressionInfo) {
                addItem(
                  {
                    type: MessageType.INFO,
                    text: `📦 上下文压缩：${switchResult.compressionInfo.originalTokenCount} → ${switchResult.compressionInfo.newTokenCount} tokens`,
                  },
                  Date.now(),
                );
              }

              // 推进 cursor 到新发言人。DebateIndicator 下次 poll（最多 200ms）
              // 会反映这个变化。submitQuery 用 0ms setTimeout 让出一帧，给
              // Ink 刷新 DebateIndicator 的机会，保证新模型开口前指示器已更新。
              advanceCursor();
              const advancedDebate = getActiveDebate();
              setTimeout(() => {
                if (getActiveDebate()?.status !== 'running') return;
                submitQuery(
                  pickFollowup(
                    advancedDebate?.language || 'en',
                    isLastTurn(advancedDebate),
                  ),
                );
              }, 0);
            } catch (err) {
              if (abortController.signal.aborted) {
                // 被主动中止（用户暂停/结束），不报错
                return;
              }
              console.warn(`[debate] advance failed: ${err instanceof Error ? err.message : String(err)}`);
              pauseDebate();
              addItem(
                {
                  type: MessageType.ERROR,
                  text: `⚠️ 辩论推进失败：切换到 ${nextModel ?? '(unknown)'} 时出错。使用 /debate continue 恢复。`,
                },
                Date.now(),
              );
            } finally {
              if (debateAbortRef.current === abortController) {
                debateAbortRef.current = null;
              }
            }
          })();
        }
      }

      // 响应结束，重置状态
      setHadToolsInCurrentResponse(false);
    }

    // 更新上一次状态
    previousStreamingStateRef.current = currentState;
  }, [
    streamingState,
    toolCalls.length,
    addItem,
    submitQuery,
    geminiClient,
    config,
  ]);

  // 🎯 计算是否有工具正在执行（用于Token指示器显示）
  const isExecutingTools = useMemo(() => {
    // 🎯 关键修复：在流式响应过程中，如果本轮响应中有过工具调用，继续显示工具状态
    const hasActiveTools = toolCalls.some(tc =>
      tc.status === 'executing' ||
      tc.status === 'scheduled' ||
      tc.status === 'validating' ||
      tc.status === 'awaiting_approval'
    );

    // 🎯 新逻辑：如果正在响应且本轮有过工具调用，认为是工具执行状态
    const isStreamingWithToolHistory = (
      streamingState === StreamingState.Responding &&
      hadToolsInCurrentResponse
    );

    const result = hasActiveTools || isStreamingWithToolHistory;



    return result;
  }, [toolCalls, streamingState, hadToolsInCurrentResponse]);

  return {
    streamingState,
    submitQuery,
    initError,
    pendingHistoryItems,
    thought,
    reasoning, // 🆕 导出 reasoning 状态
    hasContentStarted, // 🆕 导出内容开始标志
    isCreatingCheckpoint, // 🎯 导出checkpoint创建状态
    isExecutingTools, // 🎯 导出工具执行状态
  };
};
