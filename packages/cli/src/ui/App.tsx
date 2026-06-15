/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import {
  Box,
  DOMElement,
  measureElement,
  Static,
  Text,
  useStdin,
  useStdout,
  useInput,
  type Key as InkKeyType,
} from 'ink';
import { StreamingState, type HistoryItem, MessageType, ToolCallStatus, type IndividualToolCallDisplay } from './types.js';
import type { PartListUnion } from '@google/genai';
import { useTerminalSize } from './hooks/useTerminalSize.js';
import { useGeminiStream } from './hooks/useGeminiStream.js';
import { computeMidTurnDrain } from './state/midTurnDrain.js';
import { runSideQuestion } from 'otto-core';
import { SideQuestionPanel, type SideQuestionState } from './components/SideQuestionPanel.js';
import { useAnimatedTitleIcon } from './hooks/useAnimatedTitleIcon.js';
import { t, tp } from './utils/i18n.js';
import { useLoadingIndicator } from './hooks/useLoadingIndicator.js';
import { useTaskCompletionSummary } from './hooks/useTaskCompletionSummary.js';
import { TaskCompletionSummary } from './components/TaskCompletionSummary.js';
import { useThemeCommand } from './hooks/useThemeCommand.js';
import { useModelCommand } from './hooks/useModelCommand.js';
import { useCustomModelWizard } from './hooks/useCustomModelWizard.js';
import { useDebateWizard } from './hooks/useDebateWizard.js';
import { useGoalWizard } from './hooks/useGoalWizard.js';
import { useAuthCommand } from './hooks/useAuthCommand.js';
import { useLoginCommand } from './hooks/useLoginCommand.js';
import { useEditorSettings } from './hooks/useEditorSettings.js';
import { useInitChoice } from './hooks/useInitChoice.js';
import { useSettingsMenu } from './hooks/useSettingsMenu.js';
import { usePluginInstallCommand } from './hooks/usePluginInstallCommand.js';
import { useSlashCommandProcessor } from './hooks/slashCommandProcessor.js';
import { useAutoAcceptIndicator } from './hooks/useAutoAcceptIndicator.js';
import { useGoalActive } from './hooks/useGoalActive.js';
import { useConsoleMessages } from './hooks/useConsoleMessages.js';
import { useBackgroundTaskNotifications, formatBackgroundTaskResult } from './hooks/useBackgroundTaskNotifications.js';
import { formatClaudeCodeTaskResult, isAcpDelegateTask } from 'otto-core';
import { BackgroundTaskPanel } from './components/BackgroundTaskPanel.js';
import { BackgroundTaskHint } from './components/BackgroundTaskHint.js';
import { Header } from './components/Header.js';
import { WelcomeScreen } from './components/WelcomeScreen.js';
import { LoadingIndicator } from './components/LoadingIndicator.js';
import { AutoAcceptIndicator } from './components/AutoAcceptIndicator.js';
import { GoalActiveIndicator } from './components/GoalActiveIndicator.js';
import { WorkflowActiveIndicator } from './components/WorkflowActiveIndicator.js';
import { WorkflowPanel } from './components/WorkflowPanel.js';
import { ShellModeIndicator } from './components/ShellModeIndicator.js';
import { HelpModeIndicator } from './components/HelpModeIndicator.js';
import { PlanModeIndicator } from './components/PlanModeIndicator.js';
import { InputPrompt } from './components/InputPrompt.js';
import { Footer } from './components/Footer.js';
import { truncateText, getDefaultMaxRows } from './utils/textTruncator.js';
import { ThemeDialog } from './components/ThemeDialog.js';
import { ModelDialog } from './components/ModelDialog.js';
import { PluginInstallDialog } from './components/PluginInstallDialog.js';
import { CustomModelWizard } from './components/CustomModelWizard.js';
import { DebateWizard } from './components/DebateWizard.js';
import { GoalWizard } from './components/GoalWizard.js';
import { DebateIndicator } from './components/DebateIndicator.js';
import { TodoPanel } from './components/TodoPanel.js';
import { useTodos } from './hooks/useTodos.js';
import { endDebate } from './utils/debateState.js';
import { AuthDialog } from './components/AuthDialog.js';
import { LoginDialog } from './components/LoginDialog.js';
import { AuthInProgress } from './components/AuthInProgress.js';
import { EditorSettingsDialog } from './components/EditorSettingsDialog.js';
import { InitChoiceDialog } from './components/InitChoiceDialog.js';
import { SessionSelectDialog } from './components/SessionSelectDialog.js';
import { SettingsMenuDialog } from './components/SettingsMenuDialog.js';
import { Colors } from './colors.js';
import { Help } from './components/Help.js';
import { loadHierarchicalGeminiMemory } from '../config/config.js';
import { updateWindowTitleIcon } from '../gemini.js';
import { LoadedSettings } from '../config/settings.js';
import { Tips } from './components/Tips.js';
import { ConsolePatcher } from './utils/ConsolePatcher.js';
import { registerCleanup } from '../utils/cleanup.js';
import { DetailedMessagesDisplay } from './components/DetailedMessagesDisplay.js';
import { TokenUsageDisplay, type TokenUsageInfo } from './components/TokenUsageDisplay.js';
import { tokenUsageEventManager, IDEConnectionStatus, type BackgroundTask, getBackgroundTaskManager, todoStore } from 'otto-core';
import { HistoryItemDisplay } from './components/HistoryItemDisplay.js';
import { ImagePollingSpinner } from './components/ImagePollingSpinner.js';
import { StreamRecoverySpinner } from './components/StreamRecoverySpinner.js';
import { appEvents, AppEvent } from '../utils/events.js';
import {
  getCreditsService,
  UserCreditsInfo,
} from '../services/creditsService.js';
import { getIsQuitting } from '../utils/quitState.js';
import { formatCreditsWithColor } from './utils/creditsFormatter.js';
import { ContextSummaryDisplay } from './components/ContextSummaryDisplay.js';
import { IDEContextDetailDisplay } from './components/IDEContextDetailDisplay.js';
import { ReasoningDisplay } from './components/ReasoningDisplay.js';
import { HealthyUseReminder } from './components/HealthyUseReminder.js';
import { FeishuStatusDashboard, type FeishuProjectRoute, type FeishuMessageLogEntry } from './components/FeishuStatusDashboard.js';
import { useHistoryCleanup } from './hooks/useHistoryCleanup.js';
import { HistoryCleanupDialog } from './components/HistoryCleanupDialog.js';
import { useHistory } from './hooks/useHistoryManager.js';
import { useSessionRestore, useSessionAutoSave } from './hooks/useSessionRestore.js';
import process from 'node:process';
import {
  getErrorMessage,
  type Config,
  getAllGeminiMdFilenames,
  ApprovalMode,
  isEditorAvailable,
  EditorType,
  FlashFallbackEvent,
  logFlashFallback,
  AuthType,
  type OpenFiles,
  ideContext,
  addMCPStatusChangeListener,
  removeMCPStatusChangeListener,
  ProxyAuthManager,
  HealthyUseReminderState,
} from 'otto-core';
import { validateAuthMethod } from '../config/auth.js';
import { useLogger } from './hooks/useLogger.js';
import { StreamingContext } from './contexts/StreamingContext.js';
import {
  SessionStatsProvider,
  useSessionStats,
} from './contexts/SessionContext.js';
import { useGitBranchName } from './hooks/useGitBranchName.js';
import { useFocus } from './hooks/useFocus.js';
import { useBracketedPaste } from './hooks/useBracketedPaste.js';
import { useTextBuffer } from './components/shared/text-buffer.js';
import { useVimMode, VimModeProvider } from './contexts/VimModeContext.js';
import { KeypressProvider } from './contexts/KeypressContext.js';
import { BackgroundModeProvider } from './contexts/BackgroundModeContext.js';
import { BackgroundModeBridge } from './components/BackgroundModeBridge.js';
import { useVim } from './hooks/vim.js';
import { useSmallWindowOptimization } from './hooks/useSmallWindowOptimization.js';
import { useFlickerDetector } from './hooks/useFlickerDetector.js';
import * as fs from 'fs';
import { UpdateNotification } from './components/UpdateNotification.js';
import {
  isProQuotaExceededError,
  isGenericQuotaExceededError,
  isDeepXQuotaError,
  getDeepXQuotaErrorMessage,
  UserTierId,
  isCustomModel,
} from 'otto-core';
import { checkForUpdates } from './utils/updateCheck.js';
import ansiEscapes from 'ansi-escapes';
import { OverflowProvider } from './contexts/OverflowContext.js';
import { ShowMoreLines } from './components/ShowMoreLines.js';
import { PaginatedDebugConsole } from './components/PaginatedDebugConsole.js';
import { ScrollingDebugConsole } from './components/ScrollingDebugConsole.js';
import { PrivacyNotice } from './privacy/PrivacyNotice.js';
import { AudioNotification } from '../utils/audioNotification.js';
import { SessionOption } from './commands/types.js';


const CTRL_EXIT_PROMPT_DURATION_MS = 1000;

// 🎯 后台任务输出截断配置（防止 token 爆炸）
const MAX_BACKGROUND_TASK_OUTPUT_LINES = 100; // 超过此行数则截断

/**
 * 截断后台任务输出，防止 token 消耗过大
 * 策略：< 100 行完整显示，≥ 100 行保留头 50 行 + 尾 50 行
 */
function truncateBackgroundTaskOutput(output: string | undefined): string {
  if (!output) return '';

  const lines = output.split('\n');
  const totalLines = lines.length;

  // 小于 100 行，直接返回完整输出
  if (totalLines < MAX_BACKGROUND_TASK_OUTPUT_LINES) {
    return output;
  }

  // 超过 100 行，采用头尾保留策略（各 50 行）
  const headLines = 50;
  const tailLines = 50;
  const omittedCount = totalLines - headLines - tailLines;

  const head = lines.slice(0, headLines).join('\n');
  const tail = lines.slice(-tailLines).join('\n');

  return `${head}\n... (${omittedCount} lines omitted) ...\n${tail}`;
}

/**
 * 检测是否是IDEA/IntelliJ环境
 */
const detectIDEAEnvironment = (): boolean => {
  return !!(
    process.env.TERMINAL_EMULATOR && (
      process.env.TERMINAL_EMULATOR.includes('JetBrains') ||
      process.env.TERMINAL_EMULATOR.includes('IntelliJ') ||
      process.env.TERMINAL_EMULATOR.includes('IDEA')
    ) ||
    // 检测IDEA相关的环境变量
    process.env.IDEA_INITIAL_DIRECTORY ||
    process.env.JETBRAINS_IDE ||
    // 检测通过特定的Terminal设置
    (process.env.TERM_PROGRAM && process.env.TERM_PROGRAM.includes('jetbrains'))
  );
};

/**
 * Cross-platform visible-screen clear for automatic UI redraws.
 *
 * This deliberately does not clear terminal scrollback. Automatic redraws can be
 * triggered by terminal resize/layout changes, and clearing scrollback there can
 * make the terminal viewport appear to jump back to the top while the user is
 * typing or pasting.
 */
const clearVisibleScreen = (stdout: NodeJS.WriteStream) => {
  stdout.write(ansiEscapes.clearScreen);
  stdout.write(ansiEscapes.cursorTo(0, 0));
};

/**
 * Cross-platform explicit clear screen function that also clears scrollback.
 * 特别优化了IDEA环境下的兼容性
 */
const clearScreenWithScrollBuffer = (stdout: NodeJS.WriteStream) => {
  const isIDEAEnv = detectIDEAEnvironment();

  if (isIDEAEnv) {
    // IDEA环境特殊处理：使用更温和的清屏方式，避免光标位置错乱
    clearVisibleScreen(stdout);
    // 不使用滚动缓冲区清理，避免IDEA终端的兼容性问题
  } else if (process.platform === 'win32') {
    // On Windows, use full reset to properly clear screen and scroll buffer
    stdout.write('\x1Bc'); // Full reset
    clearVisibleScreen(stdout);
  } else {
    // On Unix-like systems, clear screen + scroll buffer + move cursor to top
    stdout.write('\x1B[2J\x1B[3J\x1B[H');
  }
};

interface AppProps {
  config: Config;
  settings: LoadedSettings;
  startupWarnings?: string[];
  version: string;
  promptExtensions?: any[]; // PromptExtension[] - imported from prompt-extensions
  customProxyUrl?: string;
}

export const AppWrapper = (props: AppProps) => {
  // 初始化音频通知设置
  AudioNotification.initializeFromSettings(props.settings.merged);

  return (
    <SessionStatsProvider>
      <VimModeProvider settings={props.settings}>
        <BackgroundModeProvider>
          <KeypressProvider
            config={props.config}
          >
            <BackgroundModeBridge>
              <App {...props} />
            </BackgroundModeBridge>
          </KeypressProvider>
        </BackgroundModeProvider>
      </VimModeProvider>
    </SessionStatsProvider>
  );
};

const App = ({ config, settings, startupWarnings = [], version, promptExtensions = [], customProxyUrl }: AppProps) => {
  const isFocused = useFocus();
  useBracketedPaste();

  // 🚀 History cleanup check (non-blocking, runs in background after 2s)
  const {
    state: historyCleanupState,
    performCleanup: performHistoryCleanup,
    dismissCleanup: dismissHistoryCleanup,
  } = useHistoryCleanup(settings);

  // Token usage tracking
  const [lastTokenUsage, setLastTokenUsage] = useState<TokenUsageInfo | null>(null);
  const [estimatedInputTokens, setEstimatedInputTokens] = useState<number | undefined>(undefined);

  // Credits accumulation tracking for current turn/session
  const [cumulativeCredits, setCumulativeCredits] = useState<number>(0);
  // 🆕 Credits accumulation tracking for the entire session (not reset per turn)
  const [totalSessionCredits, setTotalSessionCredits] = useState<number>(0);

  // Callback to update token usage from API responses
  const handleTokenUsageUpdate = useCallback((tokenUsage: any) => {
    if (tokenUsage) {
      const currentCredits = tokenUsage.credits_usage || 0;

      // 累加credits到当前回合总计
      setCumulativeCredits(prev => prev + currentCredits);
      // 🆕 累加到会话总计
      setTotalSessionCredits(prev => prev + currentCredits);

      setLastTokenUsage({
        cache_creation_input_tokens: tokenUsage.cache_creation_input_tokens || 0,
        cache_read_input_tokens: tokenUsage.cache_read_input_tokens || 0,
        input_tokens: tokenUsage.input_token_count || tokenUsage.input_tokens || 0,
        output_tokens: tokenUsage.output_token_count || tokenUsage.output_tokens || 0,
        credits_usage: currentCredits, // 单次请求的credits
        model: config.getModel(),
        timestamp: Date.now(),
      });
    }
  }, [config]);

  // 监听token使用事件
  useEffect(() => {
    const handleTokenUpdate = (tokenData: any) => {
      handleTokenUsageUpdate(tokenData);
    };

    tokenUsageEventManager.onTokenUsage(handleTokenUpdate);

    return () => {
      tokenUsageEventManager.offTokenUsage(handleTokenUpdate);
    };
  }, [handleTokenUsageUpdate]);

  const [updateMessage, setUpdateMessage] = useState<string | null>(null);
  const { stdout } = useStdout();
  const nightly = version.includes('nightly');

  // 飞书服务器端口状态
  const [feishuServerPort, setFeishuServerPort] = useState<number | undefined>(undefined);

  // 飞书消息处理状态
  const [isFeishuProcessing, setIsFeishuProcessing] = useState(false);
  const [isFeishuBotRunning, setIsFeishuBotRunning] = useState(false);

  // 飞书仪表板状态
  const [feishuRoutes, setFeishuRoutes] = useState<Record<string, FeishuProjectRoute>>({});
  // 「当前正在干活（Agent 仍在处理）」的群集合，可同时多个。
  const [feishuActiveGroupChatIds, setFeishuActiveGroupChatIds] = useState<Set<string>>(new Set());
  const [feishuGroupLogs, setFeishuGroupLogs] = useState<Record<string, FeishuMessageLogEntry[]>>({});
  const [feishuBotName, setFeishuBotName] = useState<string>('');
  const [feishuPlatform, setFeishuPlatform] = useState<string>('feishu');
  const [feishuChatNames, setFeishuChatNames] = useState<Record<string, string>>({});
  const [feishuP2pChatIds, setFeishuP2pChatIds] = useState<Set<string>>(new Set());

  // 监听飞书消息处理与Bot运行状态事件
  useEffect(() => {
    const handleFeishuProcessingStart = () => {
      setIsFeishuProcessing(true);
    };

    const handleFeishuProcessingEnd = () => {
      setIsFeishuProcessing(false);
    };

    const handleFeishuBotStarted = (payload?: { botName?: string; platform?: string }) => {
      setIsFeishuBotRunning(true);
      if (payload?.botName !== undefined) {
        setFeishuBotName(payload.botName);
      }
      if (payload?.platform !== undefined) {
        setFeishuPlatform(payload.platform);
      }
    };

    const handleFeishuBotStopped = () => {
      setIsFeishuBotRunning(false);
    };

    // 仪表板事件：群处理开始 —— 加入「正在干活」集合（可同时多个群）
    const handleFeishuGroupProcessingStart = (chatId: string) => {
      setFeishuActiveGroupChatIds(prev => {
        if (prev.has(chatId)) return prev;
        const next = new Set(prev);
        next.add(chatId);
        return next;
      });
    };

    // 仪表板事件：群处理结束 —— 从「正在干活」集合移除
    const handleFeishuGroupProcessingEnd = (chatId: string) => {
      setFeishuActiveGroupChatIds(prev => {
        if (!prev.has(chatId)) return prev;
        const next = new Set(prev);
        next.delete(chatId);
        return next;
      });
    };

    // 仪表板事件：消息日志
    const handleFeishuMessageLog = (chatId: string, text: string, direction: 'in' | 'out' | 'tool', timestamp: number) => {
      setFeishuGroupLogs(prev => {
        const existing = prev[chatId] ?? [];
        const entry: FeishuMessageLogEntry = { chatId, text, direction, timestamp };
        // 最多保留 50 条日志
        const updated = [...existing, entry].slice(-50);
        return { ...prev, [chatId]: updated };
      });
    };

    // 仪表板事件：路由更新
    const handleFeishuProjectRoutesUpdated = (routes: Record<string, FeishuProjectRoute>) => {
      setFeishuRoutes(routes);
    };

    // 仪表板事件：群名解析完成（chatId → 群名）。合并进已有映射，避免覆盖。
    const handleFeishuChatNamesResolved = (chatNames: Record<string, string>) => {
      setFeishuChatNames(prev => ({ ...prev, ...chatNames }));
    };

    // 仪表板事件：p2p 单聊（与 Bot 的私聊）解析完成。合并进已有集合。
    const handleFeishuP2pChatsResolved = (p2pChatIds: string[]) => {
      setFeishuP2pChatIds(prev => new Set([...prev, ...p2pChatIds]));
    };

    appEvents.on(AppEvent.FeishuBotProcessingStart, handleFeishuProcessingStart);
    appEvents.on(AppEvent.FeishuBotProcessingEnd, handleFeishuProcessingEnd);
    appEvents.on(AppEvent.FeishuBotStarted, handleFeishuBotStarted);
    appEvents.on(AppEvent.FeishuBotStopped, handleFeishuBotStopped);
    appEvents.on(AppEvent.FeishuGroupProcessingStart, handleFeishuGroupProcessingStart);
    appEvents.on(AppEvent.FeishuGroupProcessingEnd, handleFeishuGroupProcessingEnd);
    appEvents.on(AppEvent.FeishuMessageLog, handleFeishuMessageLog);
    appEvents.on(AppEvent.FeishuProjectRoutesUpdated, handleFeishuProjectRoutesUpdated);
    appEvents.on(AppEvent.FeishuChatNamesResolved, handleFeishuChatNamesResolved);
    appEvents.on(AppEvent.FeishuP2pChatsResolved, handleFeishuP2pChatsResolved);

    return () => {
      appEvents.off(AppEvent.FeishuBotProcessingStart, handleFeishuProcessingStart);
      appEvents.off(AppEvent.FeishuBotProcessingEnd, handleFeishuProcessingEnd);
      appEvents.off(AppEvent.FeishuBotStarted, handleFeishuBotStarted);
      appEvents.off(AppEvent.FeishuBotStopped, handleFeishuBotStopped);
      appEvents.off(AppEvent.FeishuGroupProcessingStart, handleFeishuGroupProcessingStart);
      appEvents.off(AppEvent.FeishuGroupProcessingEnd, handleFeishuGroupProcessingEnd);
      appEvents.off(AppEvent.FeishuMessageLog, handleFeishuMessageLog);
      appEvents.off(AppEvent.FeishuProjectRoutesUpdated, handleFeishuProjectRoutesUpdated);
      appEvents.off(AppEvent.FeishuChatNamesResolved, handleFeishuChatNamesResolved);
      appEvents.off(AppEvent.FeishuP2pChatsResolved, handleFeishuP2pChatsResolved);
    };
  }, []);

  // 监听飞书服务器事件
  useEffect(() => {
    const handleFeishuServerStarted = (port: number) => {
      setFeishuServerPort(port);
    };

    const handleFeishuServerStopped = () => {
      setFeishuServerPort(undefined);
    };

    appEvents.on(AppEvent.FeishuServerStarted, handleFeishuServerStarted);
    appEvents.on(AppEvent.FeishuServerStopped, handleFeishuServerStopped);

    return () => {
      appEvents.off(AppEvent.FeishuServerStarted, handleFeishuServerStarted);
      appEvents.off(AppEvent.FeishuServerStopped, handleFeishuServerStopped);
    };
  }, []);

  // 监听模型变化事件
  useEffect(() => {
    const handleModelChanged = (newModel: string) => {
      if (config.getDebugMode()) {
        console.log(`[App] ModelChanged event received: '${newModel}'`);
      }
      setCurrentModel(newModel);
    };

    appEvents.on(AppEvent.ModelChanged, handleModelChanged);

    return () => {
      appEvents.off(AppEvent.ModelChanged, handleModelChanged);
    };
  }, [config]);

  // 监听额外的积分消耗事件（如图片生成）
  useEffect(() => {
    const handleCreditsConsumed = (credits: number) => {
      if (credits > 0) {
        setCumulativeCredits(prev => prev + credits);
        // 🆕 累加到会话总计
        setTotalSessionCredits(prev => prev + credits);
        // 🆕 Update persistent usage stats
        ProxyAuthManager.getInstance().updateUsageStats(credits);
      }
    };

    appEvents.on(AppEvent.CreditsConsumed, handleCreditsConsumed);

    return () => {
      appEvents.off(AppEvent.CreditsConsumed, handleCreditsConsumed);
    };
  }, []);

  // MCP服务器状态变化时强制重新渲染
  const [mcpStatusUpdateTrigger, setMcpStatusUpdateTrigger] = useState(0);

  useEffect(() => {
    const handleMCPStatusChange = () => {
      // 触发重新渲染以更新MCP服务器计数
      setMcpStatusUpdateTrigger(prev => prev + 1);
    };

    addMCPStatusChangeListener(handleMCPStatusChange);

    return () => {
      removeMCPStatusChangeListener(handleMCPStatusChange);
    };
  }, []);

  // MCP tools are now discovered during Config.initialize() via setImmediate()
  // We removed the duplicate discovery call here to avoid redundant initialization
  // The tools will be available shortly after app startup
  // Monitor status changes to detect when tools become available
  useEffect(() => {
    // This effect just monitors MCP status changes, actual discovery happens in Config
    if (config.getDebugMode()) {
      console.log('[MCP] Config initialized, MCP tools discovery in progress');
    }
  }, [config]);

  useEffect(() => {
    // 🚀 启动优化：将更新检查推迟到界面渲染稳定后
    const timer = setTimeout(() => {
      checkForUpdates().then(setUpdateMessage);
    }, 1500);
    return () => clearTimeout(timer);
  }, []);

  // 🆕 在启动时异步更新云端模型列表
  useEffect(() => {
    (async () => {
      // 🚀 启动优化：推迟模型列表刷新，避免抢占启动带宽
      await new Promise(resolve => setTimeout(resolve, 2000));
      try {
        const { refreshModelsInBackground } = await import('../ui/commands/modelCommand.js');
        if (config.getDebugMode()) {
          console.log('[Startup] Starting async cloud model list update...');
        }
        // 异步更新模型列表，不阻塞UI
        refreshModelsInBackground(settings, config).catch(error => {
          if (config.getDebugMode()) {
            console.log('[Startup] Cloud model list update failed:', error);
          }
        });
      } catch (error) {
        if (config.getDebugMode()) {
          console.log('[Startup] Failed to import refreshModelsInBackground:', error);
        }
      }
    })();
  }, [config, settings]);

  const { history, addItem, clearItems, loadHistory } = useHistory();
  const {
    consoleMessages,
    handleNewMessage,
    clearConsoleMessages: clearConsoleMessagesState,
  } = useConsoleMessages();

  // Session restoration
  useSessionRestore({ config, loadHistory });

  // Display memory files info on initialization
  useEffect(() => {
    const consolePatcher = new ConsolePatcher({
      onNewMessage: handleNewMessage,
      debugMode: config.getDebugMode(),
    });
    consolePatcher.patch();
    registerCleanup(consolePatcher.cleanup);

  }, [handleNewMessage, config]);

  const { stats: sessionStats } = useSessionStats();
  const [staticNeedsRefresh, setStaticNeedsRefresh] = useState(false);
  const [staticKey, setStaticKey] = useState(0);

  // 🎯 小窗口优化 - 根据窗口大小调整渲染策略
  const smallWindowConfig = useSmallWindowOptimization();

  const refreshStatic = useCallback((clearScrollback = false) => {
    // 🎯 小窗口优化 - 在极小窗口下减少清屏操作
    if (smallWindowConfig.sizeLevel !== 'tiny') {
      if (clearScrollback) {
        clearScreenWithScrollBuffer(stdout);
      } else {
        clearVisibleScreen(stdout);
      }
    }
    setStaticKey((prev) => prev + 1);
  }, [setStaticKey, stdout, smallWindowConfig.sizeLevel]);

  // 🚀 防抖优化：避免频繁的 refreshStatic 调用导致重复渲染
  const debouncedRefreshStatic = useCallback(() => {
    const timeoutId = setTimeout(() => {
      refreshStatic();
    }, 150); // 🚀 优化：增加延迟到 150ms，减少启动时的剧烈重绘
    return () => clearTimeout(timeoutId);
  }, [refreshStatic]);

  const [geminiMdFileCount, setGeminiMdFileCount] = useState<number>(0);
  const [debugMessage, setDebugMessage] = useState<string>('');
  const [showBackgroundTaskPanel, setShowBackgroundTaskPanelState] = useState<boolean>(false);

  // 🎯 后台任务通知队列 - AI 忙时先缓存，等 AI 空闲后再注入历史
  const [pendingBackgroundNotifications, setPendingBackgroundNotifications] = useState<string[]>([]);

  // 🎯 包装 setter 来同步全局状态（用于 useGeminiStream 检查）
  const setShowBackgroundTaskPanel = useCallback((value: boolean | ((prev: boolean) => boolean)) => {
    setShowBackgroundTaskPanelState(prev => {
      const newValue = typeof value === 'function' ? value(prev) : value;
      // 同步到全局状态
      import('./utils/modalState.js').then(m => m.setBackgroundTaskPanelOpen(newValue));
      return newValue;
    });
  }, []);

  const [themeError, setThemeError] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [footerHeight, setFooterHeight] = useState<number>(0);
  const [corgiMode, setCorgiMode] = useState(false);
  const [currentModel, setCurrentModel] = useState(config.getModel());
  const [shellModeActive, setShellModeActive] = useState(false);
  const [helpModeActive, setHelpModeActive] = useState(false);
  const [planModeActive, setPlanModeActive] = useState(config.getPlanModeActive());
  const [showErrorDetails, setShowErrorDetails] = useState<boolean>(false);
  const [debugPanelExpanded, setDebugPanelExpanded] = useState<boolean>(false);
  const [debugConsoleErrorOnly, setDebugConsoleErrorOnly] = useState<boolean>(false);
  const [showToolDescriptions, setShowToolDescriptions] =
    useState<boolean>(false);
  const [showIDEContextDetail, setShowIDEContextDetail] =
    useState<boolean>(false);
  const [ctrlCPressedOnce, setCtrlCPressedOnce] = useState(false);
  const [quittingMessages, setQuittingMessages] = useState<
    HistoryItem[] | null
  >(null);
  const ctrlCTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [ctrlDPressedOnce, setCtrlDPressedOnce] = useState(false);
  const ctrlDTimerRef = useRef<NodeJS.Timeout | null>(null);

  const [ideConnectionStatus, setIdeConnectionStatus] = useState<IDEConnectionStatus>(
    IDEConnectionStatus.Disconnected
  );
  const [showPrivacyNotice, setShowPrivacyNotice] = useState<boolean>(false);
  const [modelSwitchedFromQuotaError, setModelSwitchedFromQuotaError] =
    useState<boolean>(false);
  const [userTier, setUserTier] = useState<UserTierId | undefined>(undefined);
  const [showHealthyUseReminder, setShowHealthyUseReminder] = useState<boolean>(false);
  const reminderStateRef = useRef<HealthyUseReminderState | null>(null);

  // 初始化健康使用提醒状态管理
  useEffect(() => {
    if (!reminderStateRef.current) {
      reminderStateRef.current = new HealthyUseReminderState(config.getTargetDir());
    }
  }, [config]);

  // 健康使用提醒逻辑
  useEffect(() => {
    if (!config.getHealthyUseEnabled() || !reminderStateRef.current) {
      setShowHealthyUseReminder(false);
      return;
    }

    const checkHealthyUse = () => {
      if (!reminderStateRef.current) return;

      // 禁用:企业级产品不强制"深夜该休息"等待提醒(钉死 false,永不弹出)
      const shouldShow = false;

      if (shouldShow && !showHealthyUseReminder) {
        // 需要显示提醒，且当前未显示
        setShowHealthyUseReminder(true);
        // 注意：不在这里记录时间戳，而是在用户点击"稍后提醒"时记录
        // 这样用户才有机会看到提醒
      } else if (!shouldShow && showHealthyUseReminder) {
        // 不需要显示（比如退出防沉迷时段），且当前正在显示
        setShowHealthyUseReminder(false);
      }
    };

    const intervalId = setInterval(checkHealthyUse, 1000 * 60); // 每分钟检查一次
    checkHealthyUse(); // 初始检查

    return () => clearInterval(intervalId);
  }, [config, showHealthyUseReminder]);

  const [openFiles, setOpenFiles] = useState<OpenFiles | undefined>();
  const [logoShows, setLogoShows] = useState<boolean>(true);
  const [refineResult, setRefineResult] = useState<{
    original: string; // 完整原文（用于再次润色）
    refined: string; // 完整润色结果（用于发送给 AI）
    displayOriginal: string; // 显示用原文（可能被截断）
    displayRefined: string; // 显示用润色结果（可能被截断）
    omittedPlaceholder?: string; // 省略提示的占位符
    omittedLines?: number; // 省略的行数
    showFullText?: boolean; // 是否显示全文
    options: Record<string, any>;
  } | null>(null);
  const [refineLoading, setRefineLoading] = useState<boolean>(false);
  const [queuedPrompts, setQueuedPrompts] = useState<string[]>([]);
  const [queuePaused, setQueuePaused] = useState<boolean>(false); // 队列暂停标志
  const [queueEditMode, setQueueEditMode] = useState<boolean>(false); // 队列编辑模式
  const [queueEditIndex, setQueueEditIndex] = useState<number>(0); // 当前编辑的队列索引
  const [imagePolling, setImagePolling] = useState<{ isVisible: boolean; elapsed: number; estimated: number }>({
    isVisible: false,
    elapsed: 0,
    estimated: 30,
  });
  const [streamRecovery, setStreamRecovery] = useState<{ isVisible: boolean; remaining: number }>({
    isVisible: false,
    remaining: 10,
  });

  // 调试：监听 refineResult 变化
  useEffect(() => {
    console.log('[App] refineResult 状态变化:', refineResult ? '有值' : 'null', refineResult ? { originalLength: refineResult.original.length, refinedLength: refineResult.refined.length } : null);
  }, [refineResult]);

  // 🆕 预加载用户积分信息和内存文件路径，初始化时显示
  // 注意：火发即忘(fire-and-forget)模式，5秒超时，不会阻塞 UI 启动
  useEffect(() => {
    const fetchCredits = async () => {
      try {
        const creditsService = getCreditsService();
        // 异步获取积分，不等待
        const info = await creditsService.getCreditsInfo();

        // 如果有积分信息，显示它
        if (info) {
          const creditsText = formatCreditsWithColor(info.totalCredits, info.usedCredits, info.usagePercentage);
          if (creditsText) {
            addItem(
              {
                type: MessageType.INFO,
                text: creditsText,
              },
              Date.now(),
            );
          }
        }
      } catch (error) {
        // 静默处理错误，不影响 UI
      }
    };

    // 立即触发异步加载，但不等待
    fetchCredits();

    // 同步处理内存文件路径（快速，不阻塞）
    const memoryFilePaths = config.getGeminiMdFilePaths();
    if (memoryFilePaths.length > 0) {
      const pathsText = `Memory files (${memoryFilePaths.length}):\n${memoryFilePaths.map(f => `  - ${f}`).join('\n')}`;
      addItem(
        {
          type: MessageType.INFO,
          text: pathsText,
        },
        Date.now(),
      );
    }
  }, []);

  /**
   * 渲染带有黄色省略提示的文本
   * 只有省略提示部分显示为黄色，其他文字保持原色
   */
  const renderTextWithHighlightedOmission = (text: string, placeholder?: string, omittedLines?: number) => {
    if (!placeholder || !text.includes(placeholder)) {
      // 没有省略提示，直接渲染原文
      return <Text wrap="wrap" italic>{text}</Text>;
    }

    // 分割文本，将占位符替换为实际的省略提示
    const parts = text.split(placeholder);
    const omittedNotice = tp('command.refine.omitted_lines', {
      count: omittedLines || 0,
    });

    return (
      <Text wrap="wrap" italic>
        {parts[0]}
        <Text color={Colors.AccentYellow}>{omittedNotice}</Text>
        {parts[1]}
      </Text>
    );
  };

  // 监听Plan模式变化
  useEffect(() => {
    const intervalId = setInterval(() => {
      const currentPlanMode = config.getPlanModeActive();
      if (currentPlanMode !== planModeActive) {
        setPlanModeActive(currentPlanMode);
      }
    }, 100); // 每100ms检查一次

    return () => clearInterval(intervalId);
  }, [config, planModeActive]);

  useEffect(() => {
    const unsubscribe = ideContext.subscribeToOpenFiles(setOpenFiles);
    // Set the initial value
    setOpenFiles(ideContext.getOpenFilesContext());
    return unsubscribe;
  }, []);

  useEffect(() => {
    const openDebugConsole = () => {
      setShowErrorDetails(true);
      setDebugPanelExpanded(true);
    };
    appEvents.on(AppEvent.OpenDebugConsole, openDebugConsole);

    const logErrorHandler = (errorMessage: unknown) => {
      handleNewMessage({
        type: 'error',
        content: String(errorMessage),
        count: 1,
      });
    };
    appEvents.on(AppEvent.LogError, logErrorHandler);

    // Handle image polling events
    const handlePollingStart = (data: { taskId: string; estimatedTime: number }) => {
      setImagePolling({
        isVisible: true,
        elapsed: 0,
        estimated: data.estimatedTime,
      });
    };

    const handlePollingProgress = (data: { elapsed: number; estimated: number }) => {
      setImagePolling(prev => ({
        ...prev,
        elapsed: data.elapsed,
        estimated: data.estimated,
      }));
    };

    const handlePollingEnd = () => {
      setImagePolling(prev => ({
        ...prev,
        isVisible: false,
      }));
    };

    // Handle stream recovery events
    const handleStreamRecoveryStart = (data: { total: number }) => {
      setStreamRecovery({
        isVisible: true,
        remaining: data.total,
      });
    };

    const handleStreamRecoveryCountdown = (data: { remaining: number }) => {
      setStreamRecovery(prev => ({
        ...prev,
        remaining: data.remaining,
      }));
    };

    const handleStreamRecoveryEnd = () => {
      setStreamRecovery(prev => ({
        ...prev,
        isVisible: false,
      }));
    };

    appEvents.on(AppEvent.ImagePollingStart, handlePollingStart);
    appEvents.on(AppEvent.ImagePollingProgress, handlePollingProgress);
    appEvents.on(AppEvent.ImagePollingEnd, handlePollingEnd);
    appEvents.on(AppEvent.StreamRecoveryStart, handleStreamRecoveryStart);
    appEvents.on(AppEvent.StreamRecoveryCountdown, handleStreamRecoveryCountdown);
    appEvents.on(AppEvent.StreamRecoveryEnd, handleStreamRecoveryEnd);

    return () => {
      appEvents.off(AppEvent.OpenDebugConsole, openDebugConsole);
      appEvents.off(AppEvent.LogError, logErrorHandler);
      appEvents.off(AppEvent.ImagePollingStart, handlePollingStart);
      appEvents.off(AppEvent.ImagePollingProgress, handlePollingProgress);
      appEvents.off(AppEvent.ImagePollingEnd, handlePollingEnd);
      appEvents.off(AppEvent.StreamRecoveryStart, handleStreamRecoveryStart);
      appEvents.off(AppEvent.StreamRecoveryCountdown, handleStreamRecoveryCountdown);
      appEvents.off(AppEvent.StreamRecoveryEnd, handleStreamRecoveryEnd);
    };
  }, [handleNewMessage]);

  const openPrivacyNotice = useCallback(() => {
    setShowPrivacyNotice(true);
  }, []);

  const initialPromptSubmitted = useRef(false);
  const feishuAutoStartTriggered = useRef(false);

  const errorCount = useMemo(
    () =>
      consoleMessages
        .filter((msg) => msg.type === 'error')
        .reduce((total, msg) => total + msg.count, 0),
    [consoleMessages],
  );

  const {
    isThemeDialogOpen,
    openThemeDialog,
    handleThemeSelect,
    handleThemeHighlight,
  } = useThemeCommand(settings, setThemeError, addItem);

  const {
    isModelDialogOpen,
    openModelDialog,
    handleModelSelect,
    handleModelHighlight,
  } = useModelCommand(settings, config, setModelError, addItem, lastTokenUsage);

  const {
    isCustomModelWizardOpen,
    openCustomModelWizard,
    handleWizardComplete,
    handleWizardCancel,
  } = useCustomModelWizard(settings, addItem, config);

  // 🎭 辩论向导。useDebateWizard 在 wizard 完成时需要 submitQuery 提交开场白，
  // 但 submitQuery 是 useGeminiStream 返回的、定义在下面。用 ref 中转解决前后依赖。
  // 同时共享一个 AbortController ref 给 useGeminiStream 和 useDebateWizard，
  // 让首启 switchModel 和自动推进的 switchModel 用同一个可中止句柄。
  type DebateSubmitQuery = (
    query: PartListUnion,
    options?: { isContinuation?: boolean; silent?: boolean },
  ) => void;
  const submitQueryForDebateRef = useRef<DebateSubmitQuery | null>(null);
  const debateAdvanceAbortRef = useRef<AbortController | null>(null);
  const {
    isDebateWizardOpen,
    debateWizardModels,
    debateWizardPresets,
    debatePreferredLanguage,
    openDebateWizard,
    handleDebateWizardComplete,
    handleDebateWizardCancel,
    handleDebateLanguageSelected,
    handleResumeDebate,
  } = useDebateWizard({
    settings,
    config,
    addItem,
    submitQuery: (q, o) => {
      const impl = submitQueryForDebateRef.current;
      if (impl) {
        impl(q, o);
        return;
      }
      // submitQuery 尚未挂上。实践中这种 race 窗口非常窄（只发生在首次
      // App mount 后立即打开 wizard 并 confirm）。轮询重试最多 ~1s，
      // 超时后补一条 ERROR 提示，避免静默丢消息。
      const deadline = Date.now() + 1000;
      const tick = () => {
        const impl2 = submitQueryForDebateRef.current;
        if (impl2) {
          impl2(q, o);
          return;
        }
        if (Date.now() > deadline) {
          addItem(
            {
              type: MessageType.ERROR,
              text: '❌ 辩论启动失败：submitQuery 未就绪（超时 1s）。请再次执行 /debate。',
            },
            Date.now(),
          );
          endDebate();
          return;
        }
        setTimeout(tick, 50);
      };
      setTimeout(tick, 50);
    },
    advanceAbortRef: debateAdvanceAbortRef,
  });

  // 🎯 目标驱动模式向导。和 debate 一样，submitQuery 在下面才被定义，
  // 走同一个 ref 中转。
  const submitQueryForGoalRef = useRef<DebateSubmitQuery | null>(null);

  // ⚡ Workflow panel state
  const [isWorkflowPanelOpen, setIsWorkflowPanelOpen] = useState(false);
  const openWorkflowPanel = useCallback(() => setIsWorkflowPanelOpen(true), []);
  const closeWorkflowPanel = useCallback(() => {
    setIsWorkflowPanelOpen(false);
    // Force a static refresh so buffered history items appear immediately after closing
    refreshStatic();
  }, [refreshStatic]);

  const {
    isGoalWizardOpen,
    openGoalWizard,
    handleGoalWizardComplete,
    handleGoalWizardCancel,
  } = useGoalWizard({
    config,
    addItem,
    submitQuery: (q, o) => {
      const impl = submitQueryForGoalRef.current;
      if (impl) {
        impl(q, o);
        return;
      }
      // submitQuery 尚未挂上：与 debate 同样的 race window，轮询重试 1s。
      const deadline = Date.now() + 1000;
      const tick = () => {
        const impl2 = submitQueryForGoalRef.current;
        if (impl2) {
          impl2(q, o);
          return;
        }
        if (Date.now() > deadline) {
          addItem(
            {
              type: MessageType.ERROR,
              text: t('goalWizard.submit_not_ready'),
            },
            Date.now(),
          );
          return;
        }
        setTimeout(tick, 50);
      };
      setTimeout(tick, 50);
    },
  });

  const {
    isSettingsMenuDialogOpen,
    openSettingsMenuDialog,
    closeSettingsMenuDialog,
  } = useSettingsMenu();

  const {
    isAuthDialogOpen,
    openAuthDialog,
    handleAuthSelect,
    isAuthenticating,
    isPreparingEnvironment,
    cancelAuthentication,
    // 自定义模型专用模式
    handleUseCustomModel,
    isCustomModelOnlyMode,
    resetCustomModelOnlyMode,
  } = useAuthCommand(settings, setAuthError, config, setCurrentModel, customProxyUrl);

  const {
    isLoginDialogOpen,
    openLoginDialog,
    handleLoginSelect,
    isAuthenticating: isLoginAuthenticating,
    cancelAuthentication: cancelLoginAuthentication,
  } = useLoginCommand(settings, setLoginError, config, setCurrentModel, customProxyUrl);

  // Listen for authentication required events (e.g., from model dialog when not logged in)
  useEffect(() => {
    const handleAuthRequired = () => {
      openAuthDialog();
    };
    appEvents.on(AppEvent.AuthenticationRequired, handleAuthRequired);
    return () => {
      appEvents.off(AppEvent.AuthenticationRequired, handleAuthRequired);
    };
  }, [openAuthDialog]);

  // 当用户选择"使用自定义模型"时，自动打开模型选择对话框
  useEffect(() => {
    if (isCustomModelOnlyMode) {
      openModelDialog();
    }
  }, [isCustomModelOnlyMode, openModelDialog]);

  // BUG修复: 避免在初始化时显示认证错误，只在用户主动选择后验证
  // 修复策略: 移除自动验证逻辑，让用户在选择时才进行验证
  // 影响范围: packages/cli/src/ui/App.tsx:230-238
  // 修复日期: 2025-01-08
  // 注释掉自动验证逻辑，避免在应用启动时显示"Invalid auth method selected"错误
  // useEffect(() => {
  //   if (settings.merged.selectedAuthType) {
  //     const error = validateAuthMethod(settings.merged.selectedAuthType);
  //     if (error) {
  //       setAuthError(error);
  //       openAuthDialog();
  //     }
  //   }
  // }, [settings.merged.selectedAuthType, openAuthDialog, setAuthError]);

  // Sync user tier from config when authentication changes
  useEffect(() => {
    // Only sync when not currently authenticating
    if (!isAuthenticating) {
      setUserTier(config.getGeminiClient()?.getUserTier());
    }
  }, [config, isAuthenticating]);

  // Monitor IDE connection status
  useEffect(() => {
    const updateIdeStatus = () => {
      const ideClient = config.getIdeClient();
      if (ideClient) {
        const connectionInfo = ideClient.getConnectionStatus();
        setIdeConnectionStatus(connectionInfo.status);
      } else {
        setIdeConnectionStatus(IDEConnectionStatus.Disconnected);
      }
    };

    // Initial status check
    updateIdeStatus();

    // Set up polling to check IDE connection status
    const intervalId = setInterval(updateIdeStatus, 5000); // Check every 5 seconds

    return () => clearInterval(intervalId);
  }, [config]);

  const {
    isEditorDialogOpen,
    openEditorDialog,
    handleEditorSelect,
    exitEditorDialog,
  } = useEditorSettings(settings, setEditorError, addItem);

  const {
    isInitChoiceDialogOpen,
    initChoiceMetadata,
    openInitChoiceDialog,
    handleInitChoice,
    exitInitChoiceDialog,
  } = useInitChoice(addItem);

  const {
    isPluginInstallDialogOpen,
    openPluginInstallDialog,
    handlePluginInstallClose,
  } = usePluginInstallCommand(addItem);

  const [sessionSelectData, setSessionSelectData] = useState<SessionOption[] | null>(null);

  const toggleCorgiMode = useCallback(() => {
    setCorgiMode((prev) => !prev);
  }, []);

  const performMemoryRefresh = useCallback(async () => {
    addItem(
      {
        type: MessageType.INFO,
        text: t('memory.refreshing'),
      },
      Date.now(),
    );
    try {
      const { memoryContent, fileCount, filePaths } = await loadHierarchicalGeminiMemory(
        process.cwd(),
        config.getDebugMode(),
        config.getFileService(),
        settings.merged,
        config.getExtensionContextFilePaths(),
        config.getFileFilteringOptions(),
      );

      config.setUserMemory(memoryContent);
      config.setGeminiMdFileCount(fileCount);
      setGeminiMdFileCount(fileCount);

      let successMessage = memoryContent.length > 0 ? tp('memory.refresh_success_loaded', { characters: memoryContent.length, count: fileCount }) : t('memory.refresh_success_no_content');      if (fileCount > 0 && filePaths.length > 0) {
        successMessage += tp('memory.files_list', { files: filePaths.map(f => `  - ${f}`).join('\n') });
      }

      addItem(
        {
          type: MessageType.INFO,
          text: successMessage,
        },
        Date.now(),
      );
      if (config.getDebugMode()) {
        console.log(
          `[DEBUG] Refreshed memory content in config: ${memoryContent.substring(0, 200)}...`,
        );
        filePaths.forEach((filePath) => {
          console.log(`[DEBUG] Memory file: ${filePath}`);
        });
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      addItem(
        {
          type: MessageType.ERROR,
          text: tp('memory.refresh_error', { errorMessage }),
        },
        Date.now(),
      );
      console.error('Error refreshing memory:', error);
    }
  }, [config, addItem, settings.merged]);

  // Watch for model changes (e.g., from Flash fallback)
  // Model state is now updated via ModelChanged events
  // Initial model setup on component mount
  useEffect(() => {
    const initialModel = config.getModel();
    if (initialModel !== currentModel) {
      setCurrentModel(initialModel);
    }
  }, []); // Only run once on mount

  // Set up Flash fallback handler
  useEffect(() => {
    const flashFallbackHandler = async (
      currentModel: string,
      fallbackModel: string,
      error?: unknown,
    ): Promise<boolean> => {
      // 🆕 自定义模型：跳过所有 quota/region 相关的错误处理和模型切换
      // 这些错误对于自定义模型来说是预期行为，不应该显示友好提示或切换模型
      if (isCustomModel(currentModel)) {
        console.warn('[FlashFallback] Custom model detected, skipping fallback handling');
        return true; // 继续当前请求，不切换模型
      }

      let message: string;

      if (
        config.getContentGeneratorConfig().authType ===
        AuthType.USE_PROXY_AUTH
      ) {
        // Use actual user tier if available; otherwise, default to FREE tier behavior (safe default)
        const isPaidTier =
          userTier === UserTierId.LEGACY || userTier === UserTierId.STANDARD;

        // 🆕 优先检查DeepX服务端的配额错误
        if (error && isDeepXQuotaError(error)) {
          const deepxMessage = getDeepXQuotaErrorMessage(error);
          message = deepxMessage || `🚫 服务不可用
💡 请联系管理员检查账户配置`;
        // Check if this is a Pro quota exceeded error
        } else if (error && isProQuotaExceededError(error)) {
          if (isPaidTier) {
            message = `⚡ You have reached your daily ${currentModel} quota limit.
⚡ Automatically switching from ${currentModel} to ${fallbackModel} for the remainder of this session.
⚡ To continue accessing the ${currentModel} model today, consider using /auth to switch to using a paid API key from AI Studio at https://aistudio.google.com/apikey`;
          } else {
            message = `⚡ You have reached your daily ${currentModel} quota limit.
⚡ Automatically switching from ${currentModel} to ${fallbackModel} for the remainder of this session.
⚡ To increase your limits, upgrade to a Gemini Code Assist Standard or Enterprise plan with higher limits at https://goo.gle/set-up-gemini-code-assist
⚡ Or you can utilize a Gemini API Key. See: https://goo.gle/gemini-cli-docs-auth#gemini-api-key
⚡ You can switch authentication methods by typing /auth`;
          }
        } else if (error && isGenericQuotaExceededError(error)) {
          if (isPaidTier) {
            message = `⚡ You have reached your daily quota limit.
⚡ Automatically switching from ${currentModel} to ${fallbackModel} for the remainder of this session.
⚡ To continue accessing the ${currentModel} model today, consider using /auth to switch to using a paid API key from AI Studio at https://aistudio.google.com/apikey`;
          } else {
            message = `⚡ You have reached your daily quota limit.
⚡ Automatically switching from ${currentModel} to ${fallbackModel} for the remainder of this session.
⚡ To increase your limits, upgrade to a Gemini Code Assist Standard or Enterprise plan with higher limits at https://goo.gle/set-up-gemini-code-assist
⚡ Or you can utilize a Gemini API Key. See: https://goo.gle/gemini-cli-docs-auth#gemini-api-key
⚡ You can switch authentication methods by typing /auth`;
          }
        } else {
          if (isPaidTier) {
            // Default fallback message for other cases (like consecutive 429s)
            message = `⚡ Automatically switching from ${currentModel} to ${fallbackModel} for faster responses for the remainder of this session.
⚡ Possible reasons for this are that you have received multiple consecutive capacity errors or you have reached your daily ${currentModel} quota limit
⚡ To continue accessing the ${currentModel} model today, consider using /auth to switch to using a paid API key from AI Studio at https://aistudio.google.com/apikey`;
          } else {
            // Default fallback message for other cases (like consecutive 429s)
            message = `⚡ Automatically switching from ${currentModel} to ${fallbackModel} for faster responses for the remainder of this session.
⚡ Possible reasons for this are that you have received multiple consecutive capacity errors or you have reached your daily ${currentModel} quota limit
⚡ To increase your limits, upgrade to a Gemini Code Assist Standard or Enterprise plan with higher limits at https://goo.gle/set-up-gemini-code-assist
⚡ Or you can utilize a Gemini API Key. See: https://goo.gle/gemini-cli-docs-auth#gemini-api-key
⚡ You can switch authentication methods by typing /auth`;
          }
        }

        // Add message to UI history
        addItem(
          {
            type: MessageType.INFO,
            text: message,
          },
          Date.now(),
        );

        // Set the flag to prevent tool continuation
        setModelSwitchedFromQuotaError(true);
        // Set global quota error flag to prevent Flash model calls
        config.setQuotaErrorOccurred(true);
      }

      // Switch model for future use but return false to stop current retry
      config.setModel(fallbackModel);
      logFlashFallback(
        config,
        new FlashFallbackEvent(config.getContentGeneratorConfig().authType!),
      );
      return false; // Don't continue with current prompt
    };

    config.setFlashFallbackHandler(flashFallbackHandler);
  }, [config, addItem, userTier]);

  // Terminal and UI setup
  const { rows: terminalHeight, columns: terminalWidth } = useTerminalSize();
  const { stdin, setRawMode } = useStdin();
  const isInitialMount = useRef(true);
  const completionSummaryCounterRef = useRef(0);

  // 智能主区域和输入框宽度计算：
  // 为了让输入框、边线和历史消息在宽终端下能够绝对顶头、完美撑满屏幕：
  // - 宽终端（≥ 80）：
  //   主区域直接占满全宽并仅在左右预留各 1 字符的边距（即 terminalWidth - 2）。
  //   输入框内容分配至最宽限度：terminalWidth - 4（扣除 2 字符 Box Padding 和 2 字符前缀符号）。
  //   这样在 InputPrompt 中，`inputWidth + 2` 的边线字符长度恰好为 `terminalWidth - 2`。
  //   加上 1 字符左 Padding 和 1 字符右 Padding，边线和内容将完美顶格在 column 1 和 column terminalWidth - 1 上，
  //   与右上角的 "YOLO mode" 提示符在视觉上达到完美的顶头对齐！
  // - 窄终端（< 80）：使用 95% 比例。
  const mainAreaWidth = useMemo(() => {
    return Math.max(
      20,
      terminalWidth >= 80
        ? terminalWidth - 2
        : Math.floor(terminalWidth * 0.95)
    );
  }, [terminalWidth]);

  const inputWidth = useMemo(() => {
    return Math.max(
      20,
      terminalWidth >= 80
        ? terminalWidth - 4
        : mainAreaWidth - 3
    );
  }, [terminalWidth, mainAreaWidth]);

  const inputViewportHeight = useMemo(() => {
    return Math.max(
      1,
      Math.min(15, Math.floor(inputWidth / 10)),
    );
  }, [inputWidth]);

  const suggestionsWidth = useMemo(() => {
    return Math.max(60, Math.floor(mainAreaWidth * 0.9));
  }, [mainAreaWidth]);

  // Utility callbacks
  const isValidPath = useCallback((filePath: string): boolean => {
    try {
      return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
    } catch (_e) {
      return false;
    }
  }, []);

  const getPreferredEditor = useCallback(() => {
    const editorType = settings.merged.preferredEditor;
    const isValidEditor = isEditorAvailable(editorType);
    if (!isValidEditor) {
      openEditorDialog();
      return;
    }
    return editorType as EditorType;
  }, [settings, openEditorDialog]);

  const onAuthError = useCallback(() => {
    // 如果配置了自定义代理URL，跳过认证错误处理
    if (customProxyUrl) {
      console.log('[AuthError] Custom proxy URL configured, ignoring authentication error');
      return;
    }
    setAuthError('reauth required');
    openAuthDialog();
  }, [openAuthDialog, setAuthError, customProxyUrl]);

  // Core hooks and processors
  const {
    vimEnabled: vimModeEnabled,
    vimMode,
    toggleVimEnabled,
  } = useVimMode();

  const {
    handleSlashCommand,
    slashCommands,
    pendingHistoryItems: pendingSlashCommandHistoryItems,
    commandContext,
  } = useSlashCommandProcessor(
    config,
    settings,
    addItem,
    clearItems,
    loadHistory,
    refreshStatic,
    setDebugMessage,
    openThemeDialog,
    openModelDialog,
    openCustomModelWizard,
    openAuthDialog,
    openLoginDialog,
    openEditorDialog,
    toggleCorgiMode,
    setQuittingMessages,
    openPrivacyNotice,
    toggleVimEnabled,
    cumulativeCredits, // 🆕 传递 cumulativeCredits
    totalSessionCredits, // 🆕 传递 totalSessionCredits
    consoleMessages,
    lastTokenUsage,
    openSettingsMenuDialog, // 🆕 传递 openSettingsMenuDialog
    openInitChoiceDialog, // 🆕 传递 openInitChoiceDialog
    openPluginInstallDialog, // 🆕 传递 openPluginInstallDialog
    openDebateWizard, // 🎭 传递 openDebateWizard
    handleResumeDebate, // 🎭 传递 /debate continue 的恢复 handler
    openGoalWizard, // 🎯 传递 openGoalWizard
    openWorkflowPanel, // ⚡ 传递 openWorkflowPanel
  );

  // 🎯 Mid-turn injection: 在 useGeminiStream 调用前先准备好 drain callback。
  // useGeminiStream 在 tool-call 间隙调用它，原子取走 queuedPrompts 里所有
  // 待注入项作为附加 user text 跟随下一次 continuation 一起送给模型。
  // paused / editMode / 空队列 时返回空数组（不消耗），留给 useEffect 在
  // Idle 时按既有 between-turn 方式处理。
  //
  // 用 ref 引用最新 state，避免每次 queuedPrompts 变化都让下游 useCallback
  // 重建，从而触发不必要的重渲染。
  const queuedPromptsRef = useRef(queuedPrompts);
  const queuePausedRef = useRef(queuePaused);
  const queueEditModeRef = useRef(queueEditMode);
  useEffect(() => { queuedPromptsRef.current = queuedPrompts; }, [queuedPrompts]);
  useEffect(() => { queuePausedRef.current = queuePaused; }, [queuePaused]);
  useEffect(() => { queueEditModeRef.current = queueEditMode; }, [queueEditMode]);

  const drainQueuedPromptsForInjection = useCallback((): string[] => {
    const { drained, nextQueue } = computeMidTurnDrain(
      queuedPromptsRef.current,
      queuePausedRef.current,
      queueEditModeRef.current,
    );
    if (drained.length > 0) {
      setQueuedPrompts(nextQueue);
    }
    return drained;
  }, []);

  const {
    streamingState,
    submitQuery,
    initError,
    pendingHistoryItems: pendingGeminiHistoryItems,
    thought,
    reasoning, // 🆕 接收 reasoning 状态
    hasContentStarted, // 🆕 接收内容开始标志
    isCreatingCheckpoint, // 🎯 接收checkpoint创建状态
    isExecutingTools, // 🎯 接收工具执行状态
  } = useGeminiStream(
    config.getGeminiClient(),
    history,
    addItem,
    config,
    setDebugMessage,
    handleSlashCommand,
    shellModeActive,
    helpModeActive,
    getPreferredEditor,
    onAuthError,
    performMemoryRefresh,
    modelSwitchedFromQuotaError,
    setModelSwitchedFromQuotaError,
    setEstimatedInputTokens, // 传递预估token设置函数
    settings, // 传递设置对象以支持异步模型配置更新
    customProxyUrl,
    debateAdvanceAbortRef, // 🎭 共享的辩论推进 AbortController ref
    drainQueuedPromptsForInjection, // 🎯 mid-turn 注入：tool 间隙原子取走排队消息
  );

  // 🎭 把真正的 submitQuery 绑到 ref 上，让 useDebateWizard 能在开始辩论时用它
  // 发开场白（提交给首个模型）。effect 每次 submitQuery 引用变化时更新。
  useEffect(() => {
    submitQueryForDebateRef.current = submitQuery;
    submitQueryForGoalRef.current = submitQuery;
  }, [submitQuery]);

  // 当进入响应状态（工作中时），重置 token 使用状态，避免在刚开始时显示旧的数据
  useEffect(() => {
    if (streamingState === StreamingState.Responding) {
      setLastTokenUsage(null);
    }
  }, [streamingState]);

  // 🎯 动画标题图标 - AI繁忙时循环显示 ✱ ✻ ✳️，空闲时显示 🚀
  const currentTitleIcon = useAnimatedTitleIcon(streamingState);
  useEffect(() => {
    if (!isFeishuBotRunning) {
      updateWindowTitleIcon(currentTitleIcon);
    } else {
      process.stdout.write(`\x1b]2;Feishu Gateway Mode |  Otto\x07`);
    }
  }, [currentTitleIcon, isFeishuBotRunning]);

  // 🎯 监听后台任务完成事件
  useBackgroundTaskNotifications({
    onTaskCompleted: useCallback((task: BackgroundTask) => {
      console.log('[App] Background task completed, adding to history:', task.id);

      const isAcpDelegate = isAcpDelegateTask(task);
      const agentLabel = task.kind === 'codex' ? 'Codex' : 'Claude Code';

      // 🎯 使用 tool_group 格式显示任务输出（仿 Claude Code 风格）
      const shortId = task.id;
      const truncatedOutput = truncateBackgroundTaskOutput(task.output);
      const toolGroupItem: IndividualToolCallDisplay = {
        callId: `bg-${task.id}`,
        name: isAcpDelegate ? agentLabel : t('background.task.output'),
        toolId: isAcpDelegate ? 'claude_code_task_output' : 'background_task_output',
        description: `${shortId} ${task.command}`,
        resultDisplay: isAcpDelegate
          ? (task.answer || truncatedOutput || 'Task completed')
          : (truncatedOutput || `Exit code: ${task.exitCode ?? 'unknown'}`),
        status: isAcpDelegate ? ToolCallStatus.Success : (task.exitCode === 0 ? ToolCallStatus.Success : ToolCallStatus.Error),
        confirmationDetails: undefined,
      };
      addItem(
        { type: 'tool_group', tools: [toolGroupItem] } as any,
        Date.now(),
      );

      // 🎯 构建通知消息（包含完整的任务信息，供 AI 理解）
      const resultText = isAcpDelegate
        ? formatClaudeCodeTaskResult(task)
        : formatBackgroundTaskResult(task);
      const notificationText = isAcpDelegate
        ? `[Otto - SYSTEM NOTIFICATION] ${agentLabel} task completed (Task ID: ${task.id}).\n\n${resultText}`
        : `[Otto - SYSTEM NOTIFICATION] Background task completed (Task ID: ${task.id}). Exit code: ${task.exitCode ?? 'unknown'}. Output:\n${task.output?.substring(0, 1000) || '(no output)'}`;

      // 🎯 如果 AI 当前空闲，自动触发 AI 继续处理（静默模式，不显示用户消息）
      if (streamingState === StreamingState.Idle) {
        console.log('[App] AI is idle, auto-triggering continuation for background task:', task.id);
        submitQuery(notificationText, { silent: true });
      } else {
        console.log('[App] AI is busy, queuing background task notification:', task.id);
        setPendingBackgroundNotifications(prev => [...prev, notificationText]);
      }
    }, [addItem, streamingState, submitQuery]),
    onTaskFailed: useCallback((task: BackgroundTask) => {
      console.log('[App] Background task failed:', task.id);
      const isAcpDelegate = isAcpDelegateTask(task);
      const agentLabel = task.kind === 'codex' ? 'Codex' : 'Claude Code';
      const shortId = task.id;
      const truncatedOutput = truncateBackgroundTaskOutput(task.error || task.output);
      const toolGroupItem: IndividualToolCallDisplay = {
        callId: `bg-${task.id}`,
        name: isAcpDelegate ? agentLabel : t('background.task.output'),
        toolId: isAcpDelegate ? 'claude_code_task_output' : 'background_task_output',
        description: `${shortId} ${task.command}`,
        resultDisplay: truncatedOutput || 'Unknown error',
        status: ToolCallStatus.Error,
        confirmationDetails: undefined,
      };
      addItem(
        { type: 'tool_group', tools: [toolGroupItem] } as any,
        Date.now(),
      );

      // 🎯 构建通知消息（包含完整的任务信息，供 AI 理解）
      const notificationText = isAcpDelegate
        ? `[Otto - SYSTEM NOTIFICATION] ${agentLabel} task failed (Task ID: ${task.id}).\n\n${formatClaudeCodeTaskResult(task)}`
        : `[System] Background task failed (Task ID: ${task.id}). Command: ${task.command}. Error: ${task.error || 'Unknown error'}. Output:\n${task.output?.substring(0, 1000) || '(no output)'}`;

      // 🎯 如果 AI 当前空闲，自动触发 AI 继续处理（静默模式，不显示用户消息）
      if (streamingState === StreamingState.Idle) {
        console.log('[App] AI is idle, auto-triggering continuation for failed task:', task.id);
        // 直接发送包含完整信息的消息，让 AI 能看到结果
        submitQuery(notificationText, { silent: true });
      } else {
        // AI 正忙，加入队列等待
        console.log('[App] AI is busy, queuing background task failure notification:', task.id);
        setPendingBackgroundNotifications(prev => [...prev, notificationText]);
      }
    }, [addItem, streamingState, submitQuery]),
    onTaskKilled: useCallback((task: BackgroundTask) => {
      console.log('[App] Background task killed by user:', task.id);
      // 🎯 使用 tool_group 格式显示任务被终止
      // 🔧 截断大型输出，防止 CLI 界面压力过大
      const shortId = task.id;
      const truncatedOutput = truncateBackgroundTaskOutput(task.output);
      const toolGroupItem: IndividualToolCallDisplay = {
        callId: `bg-${task.id}`,
        name: t('background.task.output'),
        toolId: 'background_task_output',
        description: `${shortId} ${task.command}`,
        resultDisplay: truncatedOutput || 'Killed by user',
        status: ToolCallStatus.Canceled,
        confirmationDetails: undefined,
      };
      addItem(
        { type: 'tool_group', tools: [toolGroupItem] } as any,
        Date.now(),
      );

      // 🎯 构建通知消息（包含完整的任务信息，供 AI 理解）
      const notificationText = `[System] Background task killed by user (Task ID: ${task.id}). Command: ${task.command}. Output before kill:\n${task.output?.substring(0, 1000) || '(no output)'}`;

      // 🎯 如果 AI 当前空闲，自动触发 AI 继续处理（静默模式，不显示用户消息）
      if (streamingState === StreamingState.Idle) {
        console.log('[App] AI is idle, auto-triggering continuation for killed task:', task.id);
        // 直接发送包含完整信息的消息，让 AI 能看到结果
        submitQuery(notificationText, { silent: true });
      } else {
        // AI 正忙，加入队列等待
        console.log('[App] AI is busy, queuing background task kill notification:', task.id);
        setPendingBackgroundNotifications(prev => [...prev, notificationText]);
      }
    }, [addItem, streamingState, submitQuery]),
  });

  // 🎯 当 AI 变为空闲时，处理队列中的后台任务通知
  useEffect(() => {
    if (streamingState === StreamingState.Idle && pendingBackgroundNotifications.length > 0) {
      console.log('[App] AI is now idle, processing pending background notifications:', pendingBackgroundNotifications.length);

      // 将所有待处理的通知注入到 AI 历史中
      try {
        const geminiClient = config.getGeminiClient();
        for (const notification of pendingBackgroundNotifications) {
          geminiClient.addHistory({
            role: 'user',
            parts: [{ text: notification }],
          });
        }
        console.log('[App] Injected pending notifications into AI history');

        // 清空队列
        setPendingBackgroundNotifications([]);

        // 自动触发 AI 继续处理（静默模式，不显示用户消息）
        submitQuery('[Otto - SYSTEM NOTIFICATION] Background tasks have completed while you were busy. Please review the results above if necessary, and continue.', { silent: true });
      } catch (e) {
        console.error('[App] Failed to process pending background notifications:', e);
      }
    }
  }, [streamingState, pendingBackgroundNotifications, config, submitQuery]);

  const sendPromptImmediately = useCallback(
    (promptText: string, pauseQueueUntilResponse = false, silent = false) => {
      if (logoShows) {
        clearScreenWithScrollBuffer(stdout);
        setLogoShows(false);
      }
      setCumulativeCredits(0);
      setLastTokenUsage(null);

      // 如果需要暂停队列直到响应开始
      if (pauseQueueUntilResponse) {
        setQueuePaused(true);
      }

      submitQuery(promptText, silent ? { silent: true } : undefined);
    },
    [logoShows, stdout, submitQuery],
  );

  // 🎯 /btw side-question state. Lives outside the chat transcript: the
  // forked agent runs in parallel with the main turn, and its answer
  // appears in a bordered box below the input prompt. Closing it (Esc)
  // wipes the state without touching chat history.
  // (Declared BEFORE queuePrompt because queuePrompt's defensive intercept
  // calls startSideQuestion — moving it later would create a TDZ violation.)
  const [sideQuestion, setSideQuestion] = useState<SideQuestionState | null>(null);
  const sideQuestionAbortRef = useRef<AbortController | null>(null);

  const closeSideQuestion = useCallback(() => {
    // Abort any in-flight fork; safe to call when already done.
    sideQuestionAbortRef.current?.abort();
    sideQuestionAbortRef.current = null;
    setSideQuestion(null);
    import('./utils/modalState.js').then(m => m.setSideQuestionPanelOpen(false));
  }, []);

  const startSideQuestion = useCallback(
    (question: string) => {
      const trimmed = question.trim();
      if (!trimmed) return;

      // If a previous /btw is still streaming or shown, cancel & replace.
      sideQuestionAbortRef.current?.abort();
      const ctrl = new AbortController();
      sideQuestionAbortRef.current = ctrl;

      setSideQuestion({
        question: trimmed,
        answer: '',
        status: 'pending',
      });
      import('./utils/modalState.js').then(m => m.setSideQuestionPanelOpen(true));

      const geminiClient = config?.getGeminiClient();
      if (!geminiClient) {
        setSideQuestion({
          question: trimmed,
          answer: '',
          status: 'failed',
          error: 'GeminiClient not initialized yet.',
        });
        return;
      }

      let contentGenerator;
      try {
        contentGenerator = geminiClient.getContentGenerator();
      } catch (e: unknown) {
        setSideQuestion({
          question: trimmed,
          answer: '',
          status: 'failed',
          error: e instanceof Error ? e.message : String(e),
        });
        return;
      }

      // Cache-safe snapshot is best-effort; fall back to null (cold start).
      let snapshot = null;
      try {
        snapshot = geminiClient.getChat().cacheSafeParams.get();
      } catch {
        // No chat yet — that's fine, cold start will work too.
      }

      const model = config.getModel();
      const cacheNote = snapshot
        ? `↻ Reusing main chat's prompt cache prefix (${snapshot.contents.length} messages).`
        : 'ℹ️ Cold start (no main turn completed yet) — no cache hit possible.';

      // Promote pending → streaming on first chunk; accumulate text.
      void (async () => {
        const result = await runSideQuestion({
          contentGenerator,
          model,
          question: trimmed,
          cacheSafeSnapshot: snapshot,
          signal: ctrl.signal,
          onChunk: (delta) => {
            setSideQuestion((prev) => {
              if (!prev) return prev;
              if (prev.status === 'pending' || prev.status === 'streaming') {
                return {
                  ...prev,
                  status: 'streaming',
                  answer: prev.answer + delta,
                  cacheNote,
                };
              }
              return prev;
            });
          },
        });

        setSideQuestion((prev) => {
          if (!prev) return prev;
          // Don't clobber a state that was already cleared by a newer /btw.
          if (sideQuestionAbortRef.current !== ctrl) return prev;
          return {
            ...prev,
            answer: result.text || prev.answer,
            status:
              result.status === 'success'
                ? 'done'
                : result.status === 'cancelled'
                ? 'cancelled'
                : 'failed',
            error: result.error,
            cacheNote,
          };
        });
      })();
    },
    [config],
  );

  // 🎯 Defense in depth: a `/btw …` prompt must NEVER enter the queue,
  // regardless of which call path landed here. If a /btw slipped past the
  // upstream intercepts (handleFinalSubmit / handlePromptOrQueue), we
  // catch it here and fork the side question on the spot. This guards
  // against any future call site that might forward user text directly
  // into the queue.
  const queuePrompt = useCallback((promptText: string) => {
    const trimmedQueueText = promptText.trim();
    if (/^\/btw(\s|$)/i.test(trimmedQueueText)) {
      const q = trimmedQueueText.replace(/^\/btw\s*/i, '').trim();
      if (q) {
        startSideQuestion(q);
        return;
      }
      // Bare `/btw` with no args — still don't queue it; drop silently.
      return;
    }
    setQueuedPrompts((prev) => [...prev, promptText]);
  }, [startSideQuestion]);

  const updateQueueItem = useCallback((index: number, newContent: string) => {
    const trimmed = newContent.trim();
    if (trimmed === '') {
      // 空内容 = 删除该项
      setQueuedPrompts((prev) => prev.filter((_, i) => i !== index));
      addItem(
        {
          type: MessageType.INFO,
          text: tp('input.queue.item.deleted', { position: index + 1 }),
        },
        Date.now(),
      );
      // 如果删除后队列为空，退出编辑模式
      setQueuedPrompts((prev) => {
        if (prev.length === 0) {
          setQueueEditMode(false);
          setQueuePaused(false);
        }
        return prev;
      });
    } else {
      // 更新内容
      setQueuedPrompts((prev) =>
        prev.map((item, i) => (i === index ? trimmed : item)),
      );
      addItem(
        {
          type: MessageType.INFO,
          text: tp('input.queue.item.updated', { position: index + 1 }),
        },
        Date.now(),
      );
    }
  }, [addItem, tp]);

  const handlePromptOrQueue = useCallback(
    (promptText: string, pauseQueueUntilResponse = false, silent = false) => {
      const sanitizedPrompt = promptText.trim();
      if (!sanitizedPrompt) {
        return;
      }

      // 🎯 /btw side-question bypass: runs immediately (even mid-turn),
      // does NOT go into the prompt queue, does NOT write to transcript.
      // Matches the SlashCommand `immediate: true` flag on btwCommand.
      if (/^\/btw(\s|$)/i.test(sanitizedPrompt)) {
        const question = sanitizedPrompt.replace(/^\/btw\s*/i, '');
        if (!question) {
          // Empty /btw — show usage hint via the standard slash-command path.
          sendPromptImmediately(sanitizedPrompt, pauseQueueUntilResponse, silent);
          return;
        }
        startSideQuestion(question);
        return;
      }

      if (streamingState !== StreamingState.Idle) {
        queuePrompt(sanitizedPrompt);
        // 不再显示 "ℹ️Queued #X:" 的 INFO 消息，队列在输入框上方显示
        return;
      }

      sendPromptImmediately(sanitizedPrompt, pauseQueueUntilResponse, silent);
    },
    [addItem, queuePrompt, queuedPrompts.length, sendPromptImmediately, streamingState, startSideQuestion],
  );

  // Session自动保存 - 监听streaming状态变化
  useSessionAutoSave(config, history, streamingState);

  // 队列自动执行逻辑
  useEffect(() => {
    if (
      streamingState !== StreamingState.Idle ||
      queuedPrompts.length === 0 ||
      refineResult ||
      queuePaused || // 队列暂停时不执行
      queueEditMode // 编辑模式下不执行
    ) {
      return;
    }

    const [nextPrompt] = queuedPrompts;
    if (!nextPrompt) {
      return;
    }

    setQueuedPrompts((prev) => prev.slice(1));
    sendPromptImmediately(nextPrompt);
  }, [queuedPrompts, refineResult, sendPromptImmediately, streamingState, queuePaused, queueEditMode]);

  // 当 AI 开始响应时，解除队列暂停
  useEffect(() => {
    if (queuePaused && streamingState !== StreamingState.Idle) {
      setQueuePaused(false);
    }
  }, [queuePaused, streamingState]);



  // Input handling
  const handleFinalSubmit = useCallback(
    async (submittedValue: string) => {
      const trimmedValue = submittedValue.trim();
      if (trimmedValue.length > 0) {
        // 更新最后用户交互时间（goal 看门狗用）
        lastUserInteractionRef.current = Date.now();
        // Clear screen once when user first submits message after logo is shown
        if (logoShows) {
          clearScreenWithScrollBuffer(stdout);
          setLogoShows(false);
        }

        // 首先检查是否是slash命令
        if (trimmedValue.startsWith('/')) {
          // 🎯 /btw 旁路 — MUST come BEFORE handleSlashCommand below.
          // Otherwise the registered btwCommand action fires first and
          // only returns the "Usage:" hint, swallowing the actual question.
          // The bypass forks a side-question agent and renders the answer
          // in the SideQuestionPanel below the input, never entering the
          // chat transcript or the prompt queue.
          if (/^\/btw(\s|$)/i.test(trimmedValue)) {
            const question = trimmedValue.replace(/^\/btw\s*/i, '').trim();
            if (question) {
              startSideQuestion(question);
              return;
            }
            // Empty `/btw` — fall through so the standard processor shows
            // the usage hint via btwCommand.action.
          }

          // 特殊处理：/queue clear 命令
          if (trimmedValue === '/queue clear') {
            if (queuedPrompts.length > 0) {
              const clearedCount = queuedPrompts.length;
              setQueuedPrompts([]);
              addItem(
                {
                  type: MessageType.INFO,
                  text: tp('input.queue.cleared', { count: clearedCount }),
                },
                Date.now(),
              );
            } else {
              addItem(
                {
                  type: MessageType.INFO,
                  text: t('input.queue.empty'),
                },
                Date.now(),
              );
            }
            return;
          }

          // 如果是润色命令，显示 loading 状态
          const isRefineCommand = trimmedValue.startsWith('/refine');
          if (isRefineCommand) {
            setRefineLoading(true);
          }

          try {
            const slashCommandResult = await handleSlashCommand(trimmedValue);
            if (slashCommandResult !== false) {
              // 检查是否是 /help-ask 命令，激活 help 模式
              if (trimmedValue.trim() === '/help-ask') {
                setHelpModeActive(true);
                return;
              }

            if (slashCommandResult.type === 'handled') {
              // Slash命令已处理，不需要继续
              return;
            } else if (slashCommandResult.type === 'submit_prompt') {
              // Slash命令返回需要提交的内容
              handlePromptOrQueue(slashCommandResult.content, false, slashCommandResult.silent);
              return;
            } else if (slashCommandResult.type === 'schedule_tool') {
              // Slash命令要求执行工具，这里可以扩展处理
              return;
            } else if (slashCommandResult.type === 'select_session') {
              // 开启 Session 选择对话框
              setSessionSelectData(slashCommandResult.sessions);
              return;
            } else if (slashCommandResult.type === 'refine_result') {
              // 润色结果，显示确认界面
              console.log('[App] 收到 refine_result，设置 refineResult 状态');

              // 计算截断阈值
              const maxRowsSent = getDefaultMaxRows('sent', terminalHeight);
              const maxRowsRefined = getDefaultMaxRows('refined', terminalHeight);

              // 截断原文（发送场景：更严格）
              const truncatedOriginal = truncateText(slashCommandResult.original, {
                maxRows: maxRowsSent,
                terminalWidth: terminalWidth,
              });

              // 截断润色结果（Refine 场景：更宽松）
              const truncatedRefined = truncateText(slashCommandResult.refined, {
                maxRows: maxRowsRefined,
                terminalWidth: terminalWidth,
              });

              setRefineResult({
                original: slashCommandResult.original, // 完整原文
                refined: slashCommandResult.refined, // 完整润色结果
                displayOriginal: truncatedOriginal.displayText, // 显示用原文
                displayRefined: truncatedRefined.displayText, // 显示用润色结果
                omittedPlaceholder: truncatedRefined.omittedPlaceholder, // 省略提示占位符
                omittedLines: truncatedRefined.omittedLines, // 省略的行数
                options: slashCommandResult.options,
              });
              return;
            }
            }
          } finally {
            // 润色完成，隐藏 loading 状态
            if (isRefineCommand) {
              setRefineLoading(false);
            }
          }
          // 如果slashCommandResult为false，说明不是有效的slash命令，继续正常处理
        }

        handlePromptOrQueue(trimmedValue);
      }
    },
    [handlePromptOrQueue, logoShows, stdout, handleSlashCommand],
  );

  const buffer = useTextBuffer({
    initialText: '',
    viewport: { height: inputViewportHeight, width: inputWidth },
    stdin,
    setRawMode,
    isValidPath,
    shellModeActive,
  });

  const { handleInput: vimHandleInput } = useVim(buffer, handleFinalSubmit);
  const pendingHistoryItems = [...pendingSlashCommandHistoryItems];
  pendingHistoryItems.push(...pendingGeminiHistoryItems);

  // 🔧 菜单焦点管理修复: 追踪工具确认菜单状态
  // 问题: 当工具批准菜单显示时, InputPrompt 仍然捕获键盘输入，导致无法通过 Enter 确认
  // 解决: 检测是否有工具处于确认状态，将菜单状态传给 InputPrompt
  // 关键: 需要同时检查 history 和 pendingHistoryItems，因为正在等待审批的工具在 pendingHistoryItems 中
  const isToolConfirmationMenuOpen = useMemo(() => {
    // 递归检查工具及其子工具调用
    const hasConfirmingTool = (tools: IndividualToolCallDisplay[]): boolean => {
      return tools.some((tool) =>
        tool.status === ToolCallStatus.Confirming ||
        (tool.subToolCalls && hasConfirmingTool(tool.subToolCalls))
      );
    };

    // 检查 history 中的工具
    const inHistory = history.some((item) => {
      if (item.type === 'tool_group') {
        return hasConfirmingTool(item.tools);
      }
      return false;
    });

    // 检查 pendingHistoryItems 中的工具（正在处理中的）
    const inPending = pendingHistoryItems.some((item) => {
      if (item.type === 'tool_group') {
        return hasConfirmingTool(item.tools);
      }
      return false;
    });

    return inHistory || inPending;
  }, [history, pendingHistoryItems]);

  const { elapsedTime, currentLoadingPhrase, estimatedInputTokens: loadingEstimatedTokens } =
    useLoadingIndicator(streamingState, estimatedInputTokens);

  // 🎯 当前待办列表（响应式）：用于在输入框上方原地渲染固定的任务面板，
  //    避免 todo_write 每次更新都在滚动区重复出现一整块列表。
  const todos = useTodos();

  // When transitioning from Responding to Idle, capture the elapsed time for printing
  const lastElapsedTimeBeforeIdleRef = useRef<number>(0);
  useEffect(() => {
    if (streamingState === StreamingState.Responding) {
      lastElapsedTimeBeforeIdleRef.current = elapsedTime;
    }
  }, [elapsedTime, streamingState]);

  // 🎯 /goal 模式心跳：每秒探测 GeminiClient.activeGoalContext，让底部状态栏
  // 在 goal 启动 / clear 后 1s 内切换显示。详见 useGoalActive 注释。
  const isGoalActive = useGoalActive(config);

  // workflow 工具执行期间显示状态栏指示器
  // 扫描 pendingHistoryItems（实时工具状态）中是否有 workflow 工具正在执行
  const isWorkflowActive = useMemo(() => {
    const isWorkflowRunning = (tools: IndividualToolCallDisplay[]): boolean =>
      tools.some(t =>
        (t.toolId === 'workflow') &&
        (t.status === ToolCallStatus.Executing || t.status === ToolCallStatus.SubAgentRunning),
      );
    return pendingHistoryItems.some(item =>
      item.type === 'tool_group' && isWorkflowRunning(item.tools),
    );
  }, [pendingHistoryItems]);

  const showAutoAcceptIndicator = useAutoAcceptIndicator({ config });

  // ──── Goal 模式 Idle 看门狗 ────
  // 问题：某些 AI 模型在 /goal 模式下会"发呆"——既不继续工作，也不调用
  // goal_achieved。表现为 streamingState=Idle 但 goal 契约未释放。
  // 解决：跟踪上次用户交互时间；如果 goal active + idle + 60s 无交互，
  // 自动 silent-submit 一条提示消息让 AI 继续。
  const GOAL_IDLE_TIMEOUT_MS = 60_000;
  const lastUserInteractionRef = useRef<number>(Date.now());
  const goalIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 追踪用户交互：任何提交输入、slash命令等都会更新此时间戳
  // 我们在 handleFinalSubmit 中手动更新，避免闭包依赖问题

  useEffect(() => {
    // 卫语句：只有在 goal 活跃、当前空闲、且非退出状态时，才需要开启看门狗
    const isWatchdogNeeded = isGoalActive && streamingState === StreamingState.Idle && !getIsQuitting();
    if (!isWatchdogNeeded) {
      return;
    }

    const elapsed = Date.now() - lastUserInteractionRef.current;
    const remainingTime = Math.max(0, GOAL_IDLE_TIMEOUT_MS - elapsed);

    goalIdleTimerRef.current = setTimeout(() => {
      goalIdleTimerRef.current = null;

      // 触发时二次确认条件仍然满足
      const isStillEligible = isGoalActive && streamingState === StreamingState.Idle && !getIsQuitting();
      if (!isStillEligible) {
        return;
      }

      // 发送前更新时间戳，避免消息发出后立即又触发（防抖）
      lastUserInteractionRef.current = Date.now();

      const goalContinuePrompt =
        '[Otto ⏰ GOAL WATCHDOG]\n\n' +
        '⚠️ 系统检测到你在 /goal 模式下已经超过 1 分钟没有进行任何操作（没有调用工具也没有输出），' +
        '但目标尚未完成，你也未调用 goal_achieved 工具。\n\n' +
        '请立即执行以下检查：\n' +
        '1. 调用 local_time 确认当前时间和你的工作时长\n' +
        '2. 对照目标契约检查完成情况——哪些达标、哪些还差\n' +
        '3. 如果全部达标 → 调用 goal_achieved 声明完成\n' +
        '4. 如果未达标 → 继续执行剩余工作（调用工具、写代码、运行测试等）\n\n' +
        '目标契约仍在生效中，请继续工作。';

      submitQuery(goalContinuePrompt, { silent: true });
    }, remainingTime);

    return () => {
      if (goalIdleTimerRef.current) {
        clearTimeout(goalIdleTimerRef.current);
        goalIdleTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isGoalActive, streamingState, getIsQuitting]);

  // ──── Loop 模式 Watchdog 轮询 ────
  useEffect(() => {
    const loopInterval = setInterval(() => {
      try {
        const client = config.getGeminiClient();
        if (!client) return;

        const loopCtx = client.getLoopContext();
        if (!loopCtx) return;

        const now = Date.now();

        // 1. 检查是否过期
        if (now > loopCtx.expiresAt) {
          client.clearLoopContext();
          addItem(
            {
              type: MessageType.INFO,
              text: '🔄 /loop Watchdog loop has reached its expiration limit (3 days) and has stopped.',
            },
            Date.now(),
          );
          return;
        }

        const timeForNextRun = now - loopCtx.lastRunAt >= loopCtx.intervalMs;

        // 2. 如果到时间了，或者有挂起的待执行任务
        if (timeForNextRun || loopCtx.isPendingRun) {
          const isIdle = streamingState === StreamingState.Idle && !getIsQuitting();

          if (isIdle) {
            // 标志位更新：置为已执行
            loopCtx.lastRunAt = now;
            loopCtx.isPendingRun = false;

            addItem(
              {
                type: MessageType.INFO,
                text: `🔄 [Loop Run] Executing scheduled watchdog prompt: "${loopCtx.prompt}"`,
              },
              Date.now(),
            );

            // 触发执行
            submitQuery(loopCtx.prompt);
          } else {
            // 模型当前处于 Busy 状态，将标志位置为挂起，等空闲下来立即补执行
            loopCtx.isPendingRun = true;
          }
        }
      } catch (err) {
        // Prevent any loop execution error from crashing the CLI
        void err;
      }
    }, 1000); // 1秒高精度轮询

    return () => {
      clearInterval(loopInterval);
    };
  }, [config, streamingState, addItem, submitQuery]);

  const { shouldShowSummary, completionElapsedTime } = useTaskCompletionSummary(
    streamingState,
    lastElapsedTimeBeforeIdleRef.current
  );

  // Track completion summary counter for unique keys
  useEffect(() => {
    if (shouldShowSummary) {
      completionSummaryCounterRef.current += 1;
    }
  }, [shouldShowSummary]);

  const handleExit = useCallback(
    (
      pressedOnce: boolean,
      setPressedOnce: (value: boolean) => void,
      timerRef: React.MutableRefObject<NodeJS.Timeout | null>,
    ) => {
      // 🎯 优化：如果已经处于退出状态（正在显示 Goodbye），
      // 此时再按 Ctrl+C 直接强制退出进程，不再走任何 React 逻辑
      if (getIsQuitting()) {
        process.exit(0);
      }

      if (pressedOnce) {
        if (timerRef.current) {
          clearTimeout(timerRef.current);
        }
        // 精简:退出直接干净退出,不显示"Thanks for using / Performance / Wall Time"总结屏。
        process.exit(0);
      } else {
        setPressedOnce(true);

        // 🎯 优化：第一次按下 Ctrl+C 时，预加载积分信息
        // 这样在 /quit 命令执行并显示 SessionSummaryDisplay 时，积分信息可能已经缓存好了
        getCreditsService().getCreditsInfo().catch(() => {});

        timerRef.current = setTimeout(() => {
          setPressedOnce(false);
          timerRef.current = null;
        }, CTRL_EXIT_PROMPT_DURATION_MS);
      }
    },
    [handleSlashCommand],
  );

  useInput((input: string, key: InkKeyType) => {
    // 🔍 App级别按键调试（仅在DEBUG模式下启用）
    // if (key.ctrl || input === '\r' || input === '\n') {
    //   console.log('🌍 [App级别] 按键拦截:', {
    //     input: JSON.stringify(input),
    //     ctrl: key.ctrl,
    //     shift: key.shift,
    //     meta: key.meta
    //   });
    // }

    // ⚡ Workflow 面板按键拦截（Esc 只关闭面板，不触发 abort）
    if (isWorkflowPanelOpen && key.escape) {
      closeWorkflowPanel();
      return;
    }

    // 🎯 后台任务面板按键处理（最高优先级）
    if (showBackgroundTaskPanel) {
      if (key.escape || input.toLowerCase() === 'q') {
        // 只关闭面板，不做其他事情
        setShowBackgroundTaskPanel(false);
        return;
      }
      // 面板内的其他按键（↑↓K）由 BackgroundTaskPanel 组件自己的 useInput 处理
      // 这里只需要拦截 Esc/Q，其他按键让它继续传递给面板
      if (key.upArrow || key.downArrow || input.toLowerCase() === 'k') {
        // 这些按键由面板处理，不要继续传递
        return;
      }
    }

    // 检测IDEA环境下的替代取消键
    const isIDEATerminal = detectIDEAEnvironment();
    const isCancelKey = key.escape ||
                       (isIDEATerminal && key.ctrl && input === 'q') ||
                       (process.platform === 'darwin' && key.meta && input === 'q');

    // 🎯 /btw side-question panel takes top priority for Esc — while it's
    // visible, Esc closes it (and aborts an in-flight fork). Main agent's
    // streaming is unaffected either way.
    if (sideQuestion && isCancelKey) {
      closeSideQuestion();
      return;
    }

    // 处理队列编辑模式
    if (queueEditMode) {
      if (key.return) {
        // Enter: 保存编辑
        const newContent = buffer.text;
        updateQueueItem(queueEditIndex, newContent);
        setQueueEditMode(false);
        setQueuePaused(false);
        buffer.setText('');
        return;
      } else if (isCancelKey) {
        // Esc: 取消编辑
        setQueueEditMode(false);
        setQueuePaused(false);
        buffer.setText('');
        return;
      } else if (key.ctrl && key.upArrow) {
        // Ctrl+↑: 保存当前并切换到下一条
        const currentContent = buffer.text;
        const originalContent = queuedPrompts[queueEditIndex];

        // 只有内容改变时才更新
        if (currentContent.trim() !== originalContent) {
          updateQueueItem(queueEditIndex, currentContent);
        }

        // 切换到下一条（需要在更新后重新获取队列长度）
        setQueuedPrompts((currentQueue) => {
          if (currentQueue.length === 0) {
            // 队列已空，退出编辑模式
            setQueueEditMode(false);
            setQueuePaused(false);
            buffer.setText('');
            return currentQueue;
          }

          const nextIndex = (queueEditIndex + 1) % currentQueue.length;
          setQueueEditIndex(nextIndex);
          buffer.setText(currentQueue[nextIndex] || '');
          return currentQueue;
        });
        return;
      }
      // 其他按键继续正常的输入处理
    } else {
      // 非编辑模式下，Ctrl+↑ 进入队列编辑模式
      if (key.ctrl && key.upArrow && queuedPrompts.length > 0) {
        setQueueEditMode(true);
        setQueuePaused(true); // 暂停队列执行
        setQueueEditIndex(0);
        buffer.setText(queuedPrompts[0]);
        return;
      }

      // 🎯 ↓ 键打开后台任务面板（仅当有正在运行的后台任务时）
      if (key.downArrow && !key.ctrl && !key.shift && !key.meta) {
        const taskManager = getBackgroundTaskManager();
        const tasks = taskManager.getAllTasks();
        const runningTasks = tasks.filter(t => t.status === 'running');
        if (runningTasks.length > 0) {
          setShowBackgroundTaskPanel(true);
          return;
        }
      }
    }

    // 处理润色结果的确认
    if (refineResult) {
      console.log('[App useInput] refineResult存在，处理按键:', { input, return: key.return });
      if (key.return) {
        // 回车：发送润色后的文本给 AI
        console.log('[App useInput] 按回车，发送润色后的文本给 AI');
        const refinedText = refineResult.refined;
        setRefineResult(null);
        buffer.setText('');
        // 润色发送后暂停队列，直到 AI 开始响应
        handlePromptOrQueue(refinedText, true);
        return;
      } else if (input.toLowerCase() === 'r') {
        // R：再次润色
        const originalText = refineResult.original;
        setRefineResult(null);
        buffer.setText('');
        setRefineLoading(true);

        // 异步处理润色命令
        (async () => {
          try {
            const slashCommandResult = await handleSlashCommand(`/refine ${originalText}`);
            if (slashCommandResult !== false && slashCommandResult.type === 'refine_result') {
              // 计算截断阈值
              const maxRowsSent = getDefaultMaxRows('sent', terminalHeight);
              const maxRowsRefined = getDefaultMaxRows('refined', terminalHeight);

              // 截断原文（发送场景：更严格）
              const truncatedOriginal = truncateText(slashCommandResult.original, {
                maxRows: maxRowsSent,
                terminalWidth: terminalWidth,
              });

              // 截断润色结果（Refine 场景：更宽松）
              const truncatedRefined = truncateText(slashCommandResult.refined, {
                maxRows: maxRowsRefined,
                terminalWidth: terminalWidth,
              });

              setRefineResult({
                original: slashCommandResult.original, // 完整原文
                refined: slashCommandResult.refined, // 完整润色结果
                displayOriginal: truncatedOriginal.displayText, // 显示用原文
                displayRefined: truncatedRefined.displayText, // 显示用润色结果
                omittedPlaceholder: truncatedRefined.omittedPlaceholder, // 省略提示占位符
                omittedLines: truncatedRefined.omittedLines, // 省略的行数
                options: slashCommandResult.options,
              });
            }
          } catch (_error) {
            // 错误已经由 handleSlashCommand 处理
          } finally {
            setRefineLoading(false);
          }
        })();
        return;
      } else if (input.toLowerCase() === 'f') {
        // F：查看全文
        if (refineResult.omittedLines) {
          setRefineResult({
            ...refineResult,
            showFullText: true,
          });
        }
        return;
      } else if (isCancelKey) {
        // Esc：取消润色
        setRefineResult(null);
        buffer.setText('');
        return;
      }
    }

    // 处理取消键（主要用于非流响应状态下的取消操作）
    if (isCancelKey) {
      // 这里可以添加其他需要取消的操作，比如退出确认对话框等
      // 流响应的取消由useGeminiStream处理
    }

    if (key.ctrl && input === 'o') {
      // 3-state cycle: Closed -> Open (All) -> Open (Errors Only) -> Closed
      if (!showErrorDetails) {
        // State 1 -> State 2: Open with all logs
        setShowErrorDetails(true);
        setDebugConsoleErrorOnly(false);
      } else if (!debugConsoleErrorOnly) {
        // State 2 -> State 3: Filter to errors only
        setDebugConsoleErrorOnly(true);
      } else {
        // State 3 -> State 1: Close console
        setShowErrorDetails(false);
        setDebugConsoleErrorOnly(false);
        setDebugPanelExpanded(false);
      }
    } else if (key.ctrl && input === 's') {
      // Toggle between small and expanded debug console (only when open)
      if (showErrorDetails) {
        setDebugPanelExpanded((prev) => !prev);
      }
    } else if (key.ctrl && input === 't') {
      const newValue = !showToolDescriptions;
      setShowToolDescriptions(newValue);

      const mcpServers = config.getMcpServers();
      if (Object.keys(mcpServers || {}).length > 0) {
        handleSlashCommand(newValue ? '/mcp desc' : '/mcp nodesc');
      }
    } else if (key.ctrl && input === 'e' && ideContext) {
      setShowIDEContextDetail((prev) => !prev);
    } else if (key.ctrl && (input === 'c' || input === 'C')) {
      handleExit(ctrlCPressedOnce, setCtrlCPressedOnce, ctrlCTimerRef);
    } else if (key.ctrl && (input === 'd' || input === 'D')) {
      if (buffer.text.length > 0) {
        // Do nothing if there is text in the input.
        return;
      }
      handleExit(ctrlDPressedOnce, setCtrlDPressedOnce, ctrlDTimerRef);
    }
  });

  useEffect(() => {
    if (config) {
      setGeminiMdFileCount(config.getGeminiMdFileCount());
    }
  }, [config]);

  const logger = useLogger();
  const [userMessages, setUserMessages] = useState<string[]>([]);

  useEffect(() => {
    const fetchUserMessages = async () => {
      const pastMessagesRaw = (await logger?.getPreviousUserMessages()) || []; // Newest first

      const currentSessionUserMessages = history
        .filter(
          (item): item is HistoryItem & { type: 'user'; text: string } =>
            item.type === 'user' &&
            typeof item.text === 'string' &&
            item.text.trim() !== '',
        )
        .map((item) => item.text)
        .reverse(); // Newest first, to match pastMessagesRaw sorting

      // Combine, with current session messages being more recent
      const combinedMessages = [
        ...currentSessionUserMessages,
        ...pastMessagesRaw,
      ];

      // Deduplicate consecutive identical messages from the combined list (still newest first)
      const deduplicatedMessages: string[] = [];
      if (combinedMessages.length > 0) {
        deduplicatedMessages.push(combinedMessages[0]); // Add the newest one unconditionally
        for (let i = 1; i < combinedMessages.length; i++) {
          if (combinedMessages[i] !== combinedMessages[i - 1]) {
            deduplicatedMessages.push(combinedMessages[i]);
          }
        }
      }
      // Reverse to oldest first for useInputHistory
      setUserMessages(deduplicatedMessages.reverse());
    };
    fetchUserMessages();
  }, [history, logger]);

  const shouldRenderInputPrompt = !refineResult && !initError && !isFeishuProcessing;

  const handleClearScreen = useCallback(() => {
    clearItems();
    clearConsoleMessagesState();
    todoStore.clear(); // 同步清空固定任务面板
    refreshStatic(true);
  }, [clearItems, clearConsoleMessagesState, refreshStatic]);

  const mainControlsRef = useRef<DOMElement>(null);
  const pendingHistoryItemRef = useRef<DOMElement>(null);
  const rootUiRef = useRef<DOMElement>(null);
  const measureTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    // 🔧 关键优化：延迟测量并去抖动
    // 防止频繁的高度变化导致过多的 measureElement 调用
    // 这样即使 Debug Console 频繁展开/折叠，也只会每 300ms 测量一次
    if (measureTimeoutRef.current) {
      clearTimeout(measureTimeoutRef.current);
    }

    measureTimeoutRef.current = setTimeout(() => {
      if (mainControlsRef.current) {
        const fullFooterMeasurement = measureElement(mainControlsRef.current);
        setFooterHeight(fullFooterMeasurement.height);
      }
      measureTimeoutRef.current = null;
    }, 300);

    return () => {
      if (measureTimeoutRef.current) {
        clearTimeout(measureTimeoutRef.current);
      }
    };
  }, [terminalHeight, terminalWidth, showErrorDetails, debugPanelExpanded]);

  // Detect UI flickering (renders taller than terminal)
  // Debug console expansion no longer relies on unconstrained overflow.
  useFlickerDetector(rootUiRef, terminalHeight, config, true);

  const staticExtraHeight = /* margins and padding */ 3;
  const availableTerminalHeight = useMemo(
    () => terminalHeight - footerHeight - staticExtraHeight,
    [terminalHeight, footerHeight],
  );

  // mainAreaWidth 已在组件顶层定义为基于终端宽度的智能响应式 useMemo，此处无需重复定义。

  // 🔧 优化：根据终端大小智能调整最大高度
  // - 小窗口（≤30 行）：使用 60% 可用高度，避免撑破布局
  // - 中窗口（31-50 行）：使用 80% 可用高度
  // - 大窗口（>50 行）：使用 terminalHeight * 4（保持原逻辑）
  const staticAreaMaxItemHeight = useMemo(() => {
    if (terminalHeight <= 30) {
      // 小窗口：保守策略，使用 60% 可用高度
      return Math.max(Math.floor(availableTerminalHeight * 0.6), 10);
    } else if (terminalHeight <= 50) {
      // 中窗口：适度策略，使用 80% 可用高度
      return Math.max(Math.floor(availableTerminalHeight * 0.8), 20);
    } else {
      // 大窗口：保持原逻辑，允许更多内容
      return Math.max(terminalHeight * 4, 100);
    }
  }, [terminalHeight, availableTerminalHeight]);

  // Linus fix: 将useMemo移到组件顶层，避免在JSX属性中使用hooks导致的"fewer hooks"错误
  const staticItems = useMemo(() => {
    const items = [
      <Box flexDirection="column" key="header">
        {!settings.merged.hideBanner && logoShows && (
          <WelcomeScreen
            config={config}
            version={version}
            customProxyUrl={customProxyUrl}
          />
        )}
      </Box>
    ];

    // 注：积分信息现在通过初始化消息显示，而不是在这里
    // 这样可以避免与其他组件的布局竞争

    // Linus fix: 显示完整历史，移除虚拟化复杂性
    // 现代终端和计算机完全可以处理几百条消息的渲染

    // 添加所有历史项，使用staticKey确保/chat resume后强制重新渲染
    items.push(...history.map((h) => (
      <HistoryItemDisplay
        terminalWidth={mainAreaWidth}
        availableTerminalHeight={staticAreaMaxItemHeight}
        key={`${staticKey}-${h.id}`} // 使用 staticKey 和 item ID 确保稳定的组件复用
        item={h}
        isPending={false}
        config={config}
      />
    )));

    // Add task completion summary to static area when it should be shown
    // The hook manages the display duration to prevent overlap with queued prompts
    if (shouldShowSummary && completionElapsedTime > 0) {
      items.push(
        <TaskCompletionSummary
          key={`completion-${completionSummaryCounterRef.current}`}
          elapsedTime={completionElapsedTime}
          isVisible={true}
        />
      );
    }

    return items;
  }, [history, mainAreaWidth, staticAreaMaxItemHeight, staticKey, terminalWidth, settings.merged.hideBanner, settings.merged.hideTips, config, shouldShowSummary, completionElapsedTime, completionSummaryCounterRef]); // 🚀 保留关键依赖：terminalWidth 对响应式布局重要

  useEffect(() => {
    // skip refreshing Static during first mount
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }

    // 🎯 小窗口优化 - 使用自适应防抖延迟
    const debounceMs = smallWindowConfig.refreshDebounceMs;
    const handler = setTimeout(() => {
      setStaticNeedsRefresh(false);
      refreshStatic();
    }, debounceMs);

    return () => {
      clearTimeout(handler);
    };
  }, [terminalWidth, terminalHeight, refreshStatic, smallWindowConfig.refreshDebounceMs]);

  useEffect(() => {
    if (streamingState === StreamingState.Idle && staticNeedsRefresh) {
      setStaticNeedsRefresh(false);
      // 🚀 使用防抖版本避免频繁刷新
      const cleanup = debouncedRefreshStatic();
      return cleanup;
    }
  }, [streamingState, debouncedRefreshStatic, staticNeedsRefresh]);

  // Linus fix: 移除频繁刷新，Ink的Static组件会自动处理新内容
  // 原问题：用户消息不立即显示
  // 错误方案：每次新消息都清空终端重绘
  // 正确方案：让Ink自然处理，只在staticKey变化时重绘

  const filteredConsoleMessages = useMemo(() => {
    let messages = consoleMessages;

    // Filter out debug messages if debug mode is off
    if (!config.getDebugMode()) {
      messages = messages.filter((msg) => msg.type !== 'debug');
    }

    // Filter to errors only if in error-only mode
    if (debugConsoleErrorOnly) {
      messages = messages.filter((msg) => {
        // Include actual error type messages
        if (msg.type === 'error') return true;

        // Include messages with error-related keywords
        const content = msg.content.toLowerCase();
        if (content.includes('error') ||
            content.includes('exception') ||
            content.includes('traceback') ||
            content.includes('failed')) {
          return true;
        }

        // Include stack trace patterns
        if (/^\s+at\s+/.test(msg.content)) {
          return true;
        }

        // Include error name patterns (e.g., "ReferenceError:", "TypeError:")
        if (/^[A-Z]\w*Error:/m.test(msg.content)) {
          return true;
        }

        return false;
      });
    }

    return messages;
  }, [consoleMessages, config, debugConsoleErrorOnly]);

  const branchName = useGitBranchName(config.getTargetDir());

  const contextFileNames = useMemo(() => {
    const fromSettings = settings.merged.contextFileName;
    if (fromSettings) {
      return Array.isArray(fromSettings) ? fromSettings : [fromSettings];
    }
    return getAllGeminiMdFilenames();
  }, [settings.merged.contextFileName]);

  const initialPrompt = useMemo(() => config.getQuestion(), [config]);
  const geminiClient = config.getGeminiClient();
  const queuedPromptPreview = useMemo(() => {
    if (queuedPrompts.length === 0) {
      return '';
    }
    const normalized = queuedPrompts[0].replace(/\s+/g, ' ').trim();
    if (!normalized) {
      return '';
    }
    return normalized.length > 80 ? `${normalized.slice(0, 80)}...` : normalized;
  }, [queuedPrompts]);

  useEffect(() => {
    if (
      initialPrompt &&
      !initialPromptSubmitted.current &&
      !isAuthenticating &&
      !isPreparingEnvironment &&
      !isAuthDialogOpen &&
      !isLoginDialogOpen &&
      !isThemeDialogOpen &&
      !isModelDialogOpen &&
      !isEditorDialogOpen &&
      !showPrivacyNotice &&
      geminiClient?.isInitialized?.()
    ) {
      sendPromptImmediately(initialPrompt);
      initialPromptSubmitted.current = true;
    }
  }, [
    initialPrompt,
    isAuthenticating,
    isPreparingEnvironment,
    isAuthDialogOpen,
    isLoginDialogOpen,
    isThemeDialogOpen,
    isModelDialogOpen,
    isEditorDialogOpen,
    showPrivacyNotice,
    geminiClient,
    sendPromptImmediately,
  ]);

  // 🚀 --feishu 自启：启动就绪后自动执行 `/feishu start`，进入飞书常驻模式。
  //    用于 self_update 自更新重启后无人值守地恢复飞书机器人。
  //    用 handleSlashCommand（真正执行斜杠命令），不是 sendPromptImmediately（那会当成 AI prompt）。
  useEffect(() => {
    if (
      config.getFeishuAutoStart?.() &&
      !feishuAutoStartTriggered.current &&
      !isAuthenticating &&
      !isPreparingEnvironment &&
      !isAuthDialogOpen &&
      !isLoginDialogOpen &&
      !isThemeDialogOpen &&
      !isModelDialogOpen &&
      !isEditorDialogOpen &&
      !showPrivacyNotice &&
      geminiClient?.isInitialized?.()
    ) {
      feishuAutoStartTriggered.current = true;
      // 🔄 自更新重启后的启动延迟：新进程先 sleep，给飞书服务端充足时间
      // 完成老进程的 WebSocket 关闭确认和消息投递结算，避免消息重推。
      const startupDelay = parseInt(process.env.EASYCODE_STARTUP_DELAY_MS || '0', 10);
      if (startupDelay > 0) {
        setTimeout(() => void handleSlashCommand('/feishu start'), startupDelay);
      } else {
        void handleSlashCommand('/feishu start');
      }
    }
  }, [
    config,
    isAuthenticating,
    isPreparingEnvironment,
    isAuthDialogOpen,
    isLoginDialogOpen,
    isThemeDialogOpen,
    isModelDialogOpen,
    isEditorDialogOpen,
    showPrivacyNotice,
    geminiClient,
    handleSlashCommand,
  ]);

  // 🔄 --feishu 自启兜底（重启场景专用）：
  //    detached 进程无 TTY 时，Ink 降级渲染可能导致 useEffect 依赖不更新，
  //    `/feishu start` 永远不触发。此轮询在重启场景下作为兜底，确保一定启动。
  useEffect(() => {
    if (!config.getFeishuAutoStart?.() || feishuAutoStartTriggered.current) return;
    // 仅在重启场景（外挂设置了 EASYCODE_STARTUP_DELAY_MS）启用
    if (!process.env.EASYCODE_STARTUP_DELAY_MS) return;

    const startupDelay = parseInt(process.env.EASYCODE_STARTUP_DELAY_MS || '0', 10);
    const timer = setInterval(() => {
      if (feishuAutoStartTriggered.current) {
        clearInterval(timer);
        return;
      }
      if (geminiClient?.isInitialized?.()) {
        feishuAutoStartTriggered.current = true;
        clearInterval(timer);
        void handleSlashCommand('/feishu start');
      }
    }, 500);

    // 安全兜底：最多等 30s，即使 geminiClient 未初始化也强制触发
    const deadline = setTimeout(() => {
      clearInterval(timer);
      if (!feishuAutoStartTriggered.current) {
        feishuAutoStartTriggered.current = true;
        void handleSlashCommand('/feishu start');
      }
    }, startupDelay + 30000);

    return () => {
      clearInterval(timer);
      clearTimeout(deadline);
    };
  }, [config, geminiClient, handleSlashCommand]);

  // Store quitting render content but don't return early to avoid hooks order issues
  const quittingRender = quittingMessages ? (
    <Box flexDirection="column" marginBottom={1}>
      {quittingMessages.map((item) => (
        <HistoryItemDisplay
          key={item.id}
          availableTerminalHeight={availableTerminalHeight}
          terminalWidth={terminalWidth}
          item={item}
          isPending={false}
          config={config}
        />
      ))}
    </Box>
  ) : null;
  const debugConsoleMaxHeight = Math.floor(Math.max(terminalHeight * 0.2, 5));
  const debugPanelPageSize = Math.floor(Math.max(terminalHeight * 0.6, 10)); // 60% of terminal height
  const debugPanelHeight = debugPanelExpanded ? debugPanelPageSize : debugConsoleMaxHeight;
  const placeholder = planModeActive
    ? "  计划模式：可读取代码分析，禁止修改 (/plan off 退出)"
    : vimModeEnabled
      ? "  按 'i' 进入插入模式，按 'Esc' 进入普通模式。"
      : '  输入您的消息或 @文件路径';



  // Helper function to render debug panel with scrolling display
  const renderDebugPanel = () => {
    if (!showErrorDetails) {
      return null;
    }
    return (
      <Box flexDirection="column">
        <ScrollingDebugConsole
          messages={filteredConsoleMessages}
          height={debugPanelHeight}
          width={inputWidth}
          errorOnly={debugConsoleErrorOnly}
        />
      </Box>
    );
  };

  // If quitting, render the quitting messages instead of the full UI
  if (quittingRender) {
    return quittingRender;
  }

  return (
    <StreamingContext.Provider value={streamingState}>
      <Box flexDirection="column" width="100%" ref={rootUiRef}>
        {/* Move UpdateNotification outside Static so it can re-render when updateMessage changes */}
        {updateMessage ? <UpdateNotification message={updateMessage} /> : null}

        {/*
         * The Static component is an Ink intrinsic in which there can only be 1 per application.
         * Because of this restriction we're hacking it slightly by having a 'header' item here to
         * ensure that it's statically rendered.
         *
         * Background on the Static Item: Anything in the Static component is written a single time
         * to the console. Think of it like doing a logger.debug and then never using ANSI codes to
         * clear that content ever again. Effectively it has a moving frame that every time new static
         * content is set it'll flush content to the terminal and move the area which it's "clearing"
         * down a notch. Without Static the area which gets erased and redrawn continuously grows.
         */}
        <Static
          key={staticKey}
          items={staticItems}
        >
          {(item) => item}
        </Static>
        <OverflowProvider>
          <Box ref={pendingHistoryItemRef} flexDirection="column">
            {/* Suppress intermediate tool output while WorkflowPanel is open to prevent flicker.
                Items are buffered in pendingHistoryItems and will appear in history when the panel closes. */}
            {!isWorkflowPanelOpen && pendingHistoryItems.map((item, i) => (
              <HistoryItemDisplay
                key={i}
                availableTerminalHeight={availableTerminalHeight}
                terminalWidth={mainAreaWidth}
                // TODO(taehykim): It seems like references to ids aren't necessary in
                // HistoryItemDisplay. Refactor later. Use a fake id for now.
                item={{ ...item, id: 0 }}
                isPending={true}
                config={config}
                isFocused={!isEditorDialogOpen}
              />
            ))}
            {isWorkflowPanelOpen && pendingHistoryItems.length > 0 && (
              <Box paddingX={1}>
                <Text dimColor>{pendingHistoryItems.length} update{pendingHistoryItems.length !== 1 ? 's' : ''} pending (will show when panel closes)</Text>
              </Box>
            )}
            <ShowMoreLines />
          </Box>
        </OverflowProvider>

        {/* 显示思考过程框：reasoning 存在就显示。
            正文开始 / 流式结束 / 用户取消 / 新一轮提问 时由
            useGeminiStream 立即置 null 隐藏。 */}

        {reasoning ? (
          <ReasoningDisplay
            reasoning={reasoning}
            terminalHeight={terminalHeight}
            terminalWidth={terminalWidth}
          />
        ) : null}

        <Box
          flexDirection="column"
          ref={mainControlsRef}
        >
          {startupWarnings.length > 0 ? (
            <Box
              borderStyle="round"
              borderColor={Colors.AccentYellow}
              paddingX={1}
              marginY={1}
              flexDirection="column"
            >
              {startupWarnings.map((warning, index) => (
                <Text key={index} color={Colors.AccentYellow}>
                  {warning}
                </Text>
              ))}
            </Box>
          ) : null}

          {isThemeDialogOpen ? (
            <Box flexDirection="column">
              {themeError ? (
                <Box marginBottom={1}>
                  <Text color={Colors.AccentRed}>{themeError}</Text>
                </Box>
              ) : null}
              <ThemeDialog
                onSelect={handleThemeSelect}
                onHighlight={handleThemeHighlight}
                settings={settings}
                availableTerminalHeight={terminalHeight - staticExtraHeight}
                terminalWidth={mainAreaWidth}
              />
            </Box>
          ) : isModelDialogOpen ? (
            <Box flexDirection="column">
              {modelError ? (
                <Box marginBottom={1}>
                  <Text color={Colors.AccentRed}>{modelError}</Text>
                </Box>
              ) : null}
              <ModelDialog
                onSelect={(modelName) => {
                  handleModelSelect(modelName);
                  // 模型选择后重置自定义模型专用模式
                  if (isCustomModelOnlyMode) {
                    resetCustomModelOnlyMode();
                  }
                }}
                onHighlight={handleModelHighlight}
                settings={settings}
                config={config}
                availableTerminalHeight={terminalHeight - staticExtraHeight}
                terminalWidth={mainAreaWidth}
                customModelOnlyMode={isCustomModelOnlyMode}
              />
            </Box>
          ) : isCustomModelWizardOpen ? (
            <Box flexDirection="column">
              <CustomModelWizard
                onComplete={handleWizardComplete}
                onCancel={handleWizardCancel}
              />
            </Box>
          ) : isDebateWizardOpen ? (
            <Box flexDirection="column">
              <DebateWizard
                availableModels={debateWizardModels}
                presets={debateWizardPresets}
                preferredLanguage={debatePreferredLanguage}
                onComplete={handleDebateWizardComplete}
                onCancel={handleDebateWizardCancel}
                onLanguageSelected={handleDebateLanguageSelected}
              />
            </Box>
          ) : isGoalWizardOpen ? (
            <Box flexDirection="column">
              <GoalWizard
                onComplete={handleGoalWizardComplete}
                onCancel={handleGoalWizardCancel}
              />
            </Box>
          ) : isWorkflowPanelOpen ? (
            <Box flexDirection="column">
              <WorkflowPanel
                isVisible={isWorkflowPanelOpen}
                onClose={closeWorkflowPanel}
                terminalWidth={mainAreaWidth}
                terminalHeight={terminalHeight}
              />
            </Box>
          ) : isPluginInstallDialogOpen ? (
            <Box flexDirection="column">
              <PluginInstallDialog
                onClose={handlePluginInstallClose}
                terminalWidth={mainAreaWidth}
                availableTerminalHeight={terminalHeight - staticExtraHeight}
              />
            </Box>
          ) : isAuthenticating ? (
            <>
              <AuthInProgress
                stage="auth"
                onTimeout={() => {
                  setAuthError('Authentication timed out. Please try again.');
                  cancelAuthentication();
                  openAuthDialog();
                }}
              />
            </>
          ) : isPreparingEnvironment ? (
            <>
              <AuthInProgress
                stage="environment"
                onTimeout={() => {
                  setAuthError('Environment preparation timed out. Please try again.');
                  cancelAuthentication();
                  openAuthDialog();
                }}
              />
            </>
          ) : isAuthDialogOpen ? (
            <Box flexDirection="column">
              <AuthDialog
                onSelect={handleAuthSelect}
                settings={settings}
                initialErrorMessage={authError}
                onUseCustomModel={handleUseCustomModel}
              />
            </Box>
          ) : isLoginDialogOpen ? (
            <Box flexDirection="column">
              <LoginDialog
                onSelect={handleLoginSelect}
                settings={settings}
                initialErrorMessage={loginError}
              />
            </Box>
          ) : isEditorDialogOpen ? (
            <Box flexDirection="column">
              {editorError ? (
                <Box marginBottom={1}>
                  <Text color={Colors.AccentRed}>{editorError}</Text>
                </Box>
              ) : null}
              <EditorSettingsDialog
                onSelect={handleEditorSelect}
                settings={settings}
                onExit={exitEditorDialog}
              />
            </Box>
          ) : isInitChoiceDialogOpen && initChoiceMetadata ? (
            <Box flexDirection="column">
              <InitChoiceDialog
                fileSize={initChoiceMetadata.fileSize}
                lineCount={initChoiceMetadata.lineCount}
                onChoice={(choice) => {
                  const result = handleInitChoice(choice);
                  exitInitChoiceDialog();
                  if (result.action === 'message') {
                    addItem(
                      {
                        type: result.messageType === 'error'
                          ? MessageType.ERROR
                          : MessageType.INFO,
                        text: result.content!,
                      },
                      Date.now(),
                    );
                  } else if (result.action === 'submit_prompt' && result.content) {
                    handlePromptOrQueue(result.content);
                  }
                }}
              />
            </Box>
          ) : isSettingsMenuDialogOpen ? (
            <Box flexDirection="column">
              <SettingsMenuDialog
                onClose={closeSettingsMenuDialog}
                settings={settings}
                config={config!}
                terminalWidth={mainAreaWidth}
                availableTerminalHeight={terminalHeight - staticExtraHeight}
                onOpenTheme={openThemeDialog}
                onOpenEditor={openEditorDialog}
                onOpenModel={openModelDialog}
                onReloadMemory={performMemoryRefresh}
              />
            </Box>
          ) : sessionSelectData ? (
            <Box flexDirection="column">
              <SessionSelectDialog
                sessions={sessionSelectData}
                onSelect={(sessionId) => {
                  setSessionSelectData(null);
                  if (sessionId) {
                    // 使用 select 命令选择
                    handleSlashCommand(`/session select ${sessionId}`);
                  }
                }}
              />
            </Box>
          ) : showPrivacyNotice ? (
            <PrivacyNotice
              onExit={() => setShowPrivacyNotice(false)}
              config={config}
            />
          ) : showHealthyUseReminder ? (
            <HealthyUseReminder
              onDismiss={() => {
                // 用户点击"稍后提醒"时，记录时间戳
                // 这样下次提醒需要等待 1 小时
                if (reminderStateRef.current) {
                  reminderStateRef.current.markReminderShown();
                }
                setShowHealthyUseReminder(false);
              }}
            />
          ) : historyCleanupState.needsCleanup ? (
            <HistoryCleanupDialog
              sizeFormatted={historyCleanupState.historySizeFormatted}
              onConfirm={performHistoryCleanup}
              onDismiss={dismissHistoryCleanup}
            />
          ) : (
            <>
              {/* 🎯 Checkpoint创建中提示 */}
              {isCreatingCheckpoint ? (
                <Box marginBottom={1}>
                  <Text color={Colors.AccentBlue}>🔄 {t('checkpoint.creating')}</Text>
                </Box>
              ) : null}

              <LoadingIndicator
                thought={
                  streamingState === StreamingState.WaitingForConfirmation ||
                  config.getAccessibility()?.disableLoadingPhrases
                    ? undefined
                    : thought
                }
                currentLoadingPhrase={
                  streamingState === StreamingState.WaitingForConfirmation ||
                  config.getAccessibility()?.disableLoadingPhrases
                    ? undefined
                    : currentLoadingPhrase
                }
                elapsedTime={elapsedTime}
                lastTokenUsage={lastTokenUsage}
              />



              {/* 飞书 Bot 运行中 → 显示状态仪表板 */}
              {isFeishuBotRunning ? (
                <FeishuStatusDashboard
                  routes={feishuRoutes}
                  activeGroupChatIds={feishuActiveGroupChatIds}
                  groupLogs={feishuGroupLogs}
                  botName={feishuBotName}
                  platform={feishuPlatform}
                  isConnected={true}
                  terminalWidth={terminalWidth}
                  chatNames={feishuChatNames}
                  p2pChatIds={feishuP2pChatIds}
                />
              ) : (
                <React.Fragment>
                  {/* 正常模式下的内容区域 */}
                  <Box
                    marginTop={1}
                    marginBottom={1}
                    display="flex"
                    justifyContent="space-between"
                    width="100%"
                  >
                <Box>
                  {process.env.GEMINI_SYSTEM_MD ? (
                    <Text color={Colors.AccentRed}>|⌐■_■| </Text>
                  ) : null}
                  {ctrlCPressedOnce ? (
                    <Text color={Colors.AccentYellow}>
                      {t('exit.confirm.ctrl.c')}
                    </Text>
                  ) : ctrlDPressedOnce ? (
                    <Text color={Colors.AccentYellow}>
                      {t('exit.confirm.ctrl.d')}
                    </Text>
                  ) : (
                    /* 精简:隐藏"Using: N memory files / MCP servers"状态行(交互主要在飞书) */
                    false && <ContextSummaryDisplay
                      openFiles={openFiles}
                      geminiMdFileCount={geminiMdFileCount}
                      contextFileNames={contextFileNames}
                      mcpServers={config.getMcpServers()}
                      blockedMcpServers={config.getBlockedMcpServers()}
                      showToolDescriptions={showToolDescriptions}
                    />
                  )}
                </Box>
                <Box>
                  {planModeActive ? <PlanModeIndicator /> : null}
                  {/* 🎯 状态栏优先级：plan > goal > YOLO/AUTO_EDIT。
                      goal 模式下强制启用 YOLO，再显示 "YOLO mode (ctrl+y)"
                      就只是噪音；用 goal 指示器替代它，告诉用户"长时任务在跑、
                      已运行多久"，更有信息量。/goal clear 后 isGoalActive 变 false，
                      立即恢复原有 YOLO/AUTO_EDIT 显示。 */}
                  {!planModeActive && isGoalActive && !shellModeActive && !helpModeActive ? (
                    <GoalActiveIndicator config={config} />
                  ) : null}
                  {!planModeActive && !isGoalActive && isWorkflowActive && !shellModeActive && !helpModeActive ? (
                    <WorkflowActiveIndicator />
                  ) : null}
                  {showAutoAcceptIndicator !== ApprovalMode.DEFAULT &&
                    !shellModeActive && !helpModeActive && !planModeActive && !isGoalActive && !isWorkflowActive ? (
                      <AutoAcceptIndicator
                        approvalMode={showAutoAcceptIndicator}
                      />
                    ) : null}
                  {shellModeActive ? <ShellModeIndicator /> : null}
                  {helpModeActive ? <HelpModeIndicator /> : null}
                </Box>
              </Box>
              {showIDEContextDetail ? (
                <IDEContextDetailDisplay openFiles={openFiles} />
              ) : null}

              {/* 图片生成轮询动画 */}
              {imagePolling.isVisible ? (
                <Box marginY={0} marginBottom={1}>
                  <ImagePollingSpinner
                    isVisible={imagePolling.isVisible}
                    elapsed={imagePolling.elapsed}
                    estimated={imagePolling.estimated}
                  />
                </Box>
              ) : null}

              {/* 流中断恢复倒计时动画 */}
              {streamRecovery.isVisible ? (
                <Box marginY={0} marginBottom={1}>
                  <StreamRecoverySpinner
                    isVisible={streamRecovery.isVisible}
                    remaining={streamRecovery.remaining}
                  />
                </Box>
              ) : null}

              {/* 精简:隐藏 Token Usage 面板(交互主要在飞书,CLI 不展示 token 统计) */}
              {false && lastTokenUsage && streamingState !== StreamingState.Responding ? (
                <TokenUsageDisplay
                  tokenUsage={lastTokenUsage}
                  inputWidth={inputWidth}
                  cumulativeCredits={cumulativeCredits}
                />
              ) : null}
            </React.Fragment>
          )}

              {/* 队列消息显示 - 简洁模式（无Queued标签） */}
              {queuedPrompts.length > 0 && !initError ? (
                <Box marginY={1} flexDirection="column" gap={0}>
                  {queuedPrompts.map((prompt, index) => {
                    const preview = prompt.length > 60 ? `${prompt.slice(0, 60)}...` : prompt;
                    return (
                      <Text key={index} dimColor>
                        {index === 0 ? '↓' : ' '} {preview}
                      </Text>
                    );
                  })}
                  {queuedPrompts.length > 0 ? (
                    <Text dimColor>
                      {t('input.queue.edit.hint')}
                    </Text>
                  ) : null}
                </Box>
              ) : null}

              {/* 队列编辑模式界面 */}
              {queueEditMode ? (
                <Box marginY={1}>
                  <Text color={Colors.AccentBlue}>
                    🔄 {tp('input.queue.edit.mode', {
                      current: queueEditIndex + 1,
                      total: queuedPrompts.length
                    })} • {t('input.queue.edit.actions')}
                  </Text>
                </Box>
              ) : null}

              {/* 润色 Loading 界面 */}
              {refineLoading ? (
                <Box
                  flexDirection="column"
                  borderStyle="round"
                  borderColor={Colors.AccentBlue}
                  paddingX={1}
                  paddingY={1}
                  marginY={1}
                >
                  <Box>
                    <Text bold color={Colors.AccentBlue}>✨ {t('command.refine.loading.title')}</Text>
                  </Box>
                  <Box marginTop={1}>
                    <Text color={Colors.Gray}>{t('command.refine.loading.message')}</Text>
                  </Box>
                </Box>
              ) : null}

              {/* 润色结果确认界面 */}
              {refineResult && !refineLoading ? (
                <Box
                  flexDirection="column"
                  borderStyle="round"
                  borderColor={Colors.AccentGreen}
                  paddingX={1}
                  paddingY={1}
                  marginY={1}
                >
                  <Box marginBottom={1}>
                    <Text bold color={Colors.AccentGreen}>{t('command.refine.confirm.title')}</Text>
                  </Box>
                  <Box marginBottom={1}>
                    {refineResult.showFullText
                      ? <Text wrap="wrap" italic>{refineResult.refined}</Text>
                      : renderTextWithHighlightedOmission(refineResult.displayRefined, refineResult.omittedPlaceholder, refineResult.omittedLines)
                    }
                  </Box>
                  <Box>
                    <Text color={Colors.Gray}>{'─'.repeat(50)}</Text>
                  </Box>
                  <Box marginTop={1}>
                    <Box marginRight={2}>
                      <Text bold color={Colors.AccentGreen}>{t('command.refine.confirm.hint.send')}</Text>
                    </Box>
                    <Box marginRight={2}>
                      <Text color={Colors.Gray}>|</Text>
                    </Box>
                    <Box marginRight={2}>
                      <Text bold color={Colors.AccentYellow}>{t('command.refine.confirm.hint.refine-again')}</Text>
                    </Box>
                    {refineResult.omittedLines && !refineResult.showFullText ? (
                      <>
                        <Box marginRight={2}>
                          <Text color={Colors.Gray}>|</Text>
                        </Box>
                        <Box marginRight={2}>
                          <Text bold color={Colors.AccentBlue}>{t('command.refine.confirm.hint.view-full')}</Text>
                        </Box>
                      </>
                    ) : null}
                    <Box marginRight={2}>
                      <Text color={Colors.Gray}>|</Text>
                    </Box>
                    <Box>
                      <Text bold color={Colors.AccentRed}>{t('command.refine.confirm.hint.cancel')}</Text>
                    </Box>
                  </Box>
                </Box>
              ) : null}

              {/* 📋 固定任务面板：常驻输入框上方，随 todo_write 原地更新，
                   空列表或全部完成时自动隐藏（见 TodoPanel 内部逻辑）。 */}
              <TodoPanel todos={todos} isActive={streamingState !== StreamingState.Idle} />

              {/* 🎭 辩论模式指示器：常驻输入框上方，显示当前发言模型+总进度。
                   相比历史消息里的"已切换到 xxx"提示，这个常驻指示器不会被
                   React 18 批处理或流式响应覆盖，任何时候都能看清当前状态。 */}
              <DebateIndicator />

              {shouldRenderInputPrompt ? (
                <InputPrompt
                  buffer={buffer}
                  inputWidth={inputWidth}
                  suggestionsWidth={suggestionsWidth}
                  onSubmit={handleFinalSubmit}
                  userMessages={userMessages}
                  onClearScreen={handleClearScreen}
                  openModelDialog={openModelDialog}
                  config={config}
                  slashCommands={slashCommands}
                  commandContext={commandContext}
                  shellModeActive={shellModeActive}
                  setShellModeActive={setShellModeActive}
                  helpModeActive={helpModeActive}
                  setHelpModeActive={setHelpModeActive}
                  focus={isFocused}
                  vimHandleInput={vimHandleInput}
                  placeholder={placeholder}
                  isModalOpen={isModelDialogOpen || isCustomModelWizardOpen || isDebateWizardOpen || isGoalWizardOpen || isWorkflowPanelOpen || isAuthDialogOpen || isThemeDialogOpen || isEditorDialogOpen || isInitChoiceDialogOpen || isPluginInstallDialogOpen || isToolConfirmationMenuOpen || showBackgroundTaskPanel}
                  isExecutingTools={isExecutingTools}
                  isBusy={streamingState !== StreamingState.Idle || queuedPrompts.length > 0}
                  isInSpecialMode={!!refineResult || queueEditMode}
                />
              ) : null}

              {!shouldRenderInputPrompt && isFeishuProcessing ? (
                <Box borderStyle="round" borderColor={Colors.AccentYellow} paddingX={1} marginBottom={1}>
                  <Text color={Colors.AccentYellow} bold>
                    {t('feishu.tui.agent_working')}
                  </Text>
                </Box>
              ) : null}

              {/* 🎯 后台任务提示 - 显示在输入框下方 */}
              <BackgroundTaskHint />

              {/* 🎯 /btw 旁路问答面板 - 显示在输入框下方，最高占终端 40% */}
              <SideQuestionPanel
                state={sideQuestion}
                terminalHeight={terminalHeight}
                terminalWidth={terminalWidth}
              />
            </>
          )}

          {initError && streamingState !== StreamingState.Responding ? (
            <Box
              borderStyle="round"
              borderColor={Colors.AccentRed}
              paddingX={1}
              marginBottom={1}
            >
              {history.find(
                (item) =>
                  item.type === 'error' && item.text?.includes(initError),
              )?.text ? (
                <Text color={Colors.AccentRed}>
                  {
                    history.find(
                      (item) =>
                        item.type === 'error' && item.text?.includes(initError),
                    )?.text
                  }
                </Text>
              ) : (
                <>
                  <Text color={Colors.AccentRed}>
                    初始化错误：{initError}
                  </Text>
                  <Text color={Colors.AccentRed}>
                    {' '}
                    请检查 API 密钥和配置。
                  </Text>
                </>
              )}
            </Box>
          ) : null}
          {/* Debug Console - Fixed at bottom before Footer */}
          {renderDebugPanel()}

          {/* 🎯 后台任务管理面板 (Ctrl+↓ 打开) */}
          <BackgroundTaskPanel
            isVisible={showBackgroundTaskPanel}
            onClose={() => setShowBackgroundTaskPanel(false)}
            terminalWidth={terminalWidth}
          />

          <Footer
            model={currentModel}
            targetDir={config.getTargetDir()}
            debugMode={config.getDebugMode()}
            branchName={branchName}
            debugMessage={debugMessage}
            corgiMode={corgiMode}
            errorCount={errorCount}
            showErrorDetails={showErrorDetails}
            showMemoryUsage={
              config.getDebugMode() || config.getShowMemoryUsage()
            }
            promptTokenCount={sessionStats.lastPromptTokenCount}
            nightly={nightly}
            vimMode={vimModeEnabled ? vimMode : undefined}
            version={version}
            ideConnectionStatus={ideConnectionStatus}
            config={config}
            terminalWidth={terminalWidth}
            isFeishuProcessing={isFeishuProcessing}
          />
        </Box>
      </Box>
    </StreamingContext.Provider>
  );
};
