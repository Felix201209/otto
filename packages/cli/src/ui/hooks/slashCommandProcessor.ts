/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useMemo, useEffect, useState } from 'react';
import { type PartListUnion } from '@google/genai';
import process from 'node:process';
import { UseHistoryManagerReturn } from './useHistoryManager.js';
import { useStateAndRef } from './useStateAndRef.js';
import { Config, GitService, Logger } from 'otto-core';
import { useSessionStats } from '../contexts/SessionContext.js';
import { t } from '../utils/i18n.js';
import {
  Message,
  MessageType,
  HistoryItemWithoutId,
  HistoryItem,
  SlashCommandProcessorResult,
  ConsoleMessageItem,
} from '../types.js';
import { TokenUsageInfo } from '../components/TokenUsageDisplay.js';
import { LoadedSettings } from '../../config/settings.js';
import { runExitCleanup } from '../../utils/cleanup.js';
import { setQuitting, getIsQuitting } from '../../utils/quitState.js';
import { getCreditsService } from '../../services/creditsService.js';
import { isCustomModel } from 'otto-core';
import { type CommandContext, type SlashCommand } from '../commands/types.js';
import { CommandService } from '../../services/CommandService.js';
import { BuiltinCommandLoader } from '../../services/BuiltinCommandLoader.js';
import { ExtensionCommandLoader } from '../../services/ExtensionCommandLoader.js';
import { FileCommandLoader } from '../../services/FileCommandLoader.js';
import { InlineCommandLoader } from '../../services/InlineCommandLoader.js';
import { McpPromptLoader } from '../../services/McpPromptLoader.js';
import { PluginCommandLoader } from '../../services/skill/loaders/plugin-command-loader.js';
import { SettingsManager, MarketplaceManager, SkillLoader } from 'otto-core';

/**
 * Hook to define and process slash commands (e.g., /help, /clear).
 */
export const useSlashCommandProcessor = (
  config: Config | null,
  settings: LoadedSettings,
  addItem: UseHistoryManagerReturn['addItem'],
  clearItems: UseHistoryManagerReturn['clearItems'],
  loadHistory: UseHistoryManagerReturn['loadHistory'],
  refreshStatic: (clearScrollback?: boolean) => void,
  onDebugMessage: (message: string) => void,
  openThemeDialog: () => void,
  openModelDialog: () => void,
  openCustomModelWizard: () => void,
  openAuthDialog: () => void,
  openLoginDialog: () => void,
  openEditorDialog: () => void,
  toggleCorgiMode: () => void,
  setQuittingMessages: (message: HistoryItem[]) => void,
  openPrivacyNotice: () => void,
  toggleVimEnabled: () => Promise<boolean>,
  cumulativeCredits: number, // 🆕 接收 cumulativeCredits
  totalSessionCredits: number, // 🆕 接收 totalSessionCredits
  consoleMessages: ConsoleMessageItem[], // 🆕 接收 consoleMessages
  lastTokenUsage?: TokenUsageInfo | null, // 🆕 接收 lastTokenUsage
  openSettingsMenuDialog?: () => void, // 🆕 接收 openSettingsMenuDialog
  openInitChoiceDialog?: (metadata: {
    filePath: string;
    fileSize: number;
    lineCount: number;
  }) => void, // 🆕 接收 openInitChoiceDialog
  openPluginInstallDialog?: () => void, // 🆕 接收 openPluginInstallDialog
  openDebateWizard?: () => void, // 🎭 接收 openDebateWizard
  resumeDebate?: () => void, // 🎭 接收 resumeDebate (由 /debate continue 触发)
  openGoalWizard?: () => void, // 🎯 接收 openGoalWizard (由 /goal 触发)
  openWorkflowPanel?: () => void, // ⚡ 接收 openWorkflowPanel (由 /workflow 触发)
) => {
  const session = useSessionStats();
  const [commands, setCommands] = useState<readonly SlashCommand[]>([]);
  const [gitService, setGitService] = useState<GitService | undefined>();

  useEffect(() => {
    if (!config?.getProjectRoot() || !config.getCheckpointingEnabled()) {
      setGitService(undefined);
      return;
    }
    // Use the GitService instance from config to ensure singleton behavior
    config.getGitService().then(setGitService).catch(() => {
      setGitService(undefined);
    });
  }, [config]);

  const logger = useMemo(() => {
    const l = new Logger(config?.getSessionId() || '');
    // The logger's initialize is async, but we can create the instance
    // synchronously. Commands that use it will await its initialization.
    return l;
  }, [config]);

  const [pendingCompressionItemRef, setPendingCompressionItem] =
    useStateAndRef<HistoryItemWithoutId | null>(null);

  const pendingHistoryItems = useMemo(() => {
    const items: HistoryItemWithoutId[] = [];
    if (pendingCompressionItemRef.current != null) {
      items.push(pendingCompressionItemRef.current);
    }
    return items;
  }, [pendingCompressionItemRef]);

  const addMessage = useCallback(
    (message: Message) => {
      // Convert Message to HistoryItemWithoutId
      let historyItemContent: HistoryItemWithoutId;
      if (message.type === MessageType.ABOUT) {
        historyItemContent = {
          type: 'about',
          cliVersion: message.cliVersion,
          osVersion: message.osVersion,
          sandboxEnv: message.sandboxEnv,
          modelVersion: message.modelVersion,
          selectedAuthType: message.selectedAuthType,
          gcpProject: message.gcpProject,
        };
      } else if (message.type === MessageType.STATS) {
        historyItemContent = {
          type: 'stats',
          duration: message.duration,
        };
      } else if (message.type === MessageType.MODEL_STATS) {
        historyItemContent = {
          type: 'model_stats',
        };
      } else if (message.type === MessageType.TOOL_STATS) {
        historyItemContent = {
          type: 'tool_stats',
        };
      } else if (message.type === MessageType.QUIT) {
        historyItemContent = {
          type: 'quit',
          duration: message.duration,
        };
      } else if (message.type === MessageType.COMPRESSION) {
        historyItemContent = {
          type: 'compression',
          compression: message.compression,
        };
      } else {
        historyItemContent = {
          type: message.type,
          text: message.content,
        };
      }
      addItem(historyItemContent, message.timestamp.getTime());
    },
    [addItem],
  );

  const commandContext = useMemo(
    (): CommandContext => ({
      services: {
        config,
        settings,
        git: gitService,
        logger,
      },
      ui: {
        addItem,
        clear: () => {
          clearItems();
          refreshStatic(true);
        },
        loadHistory,
        setDebugMessage: onDebugMessage,
        pendingItem: pendingCompressionItemRef.current,
        setPendingItem: setPendingCompressionItem,
        toggleCorgiMode,
        toggleVimEnabled,
        debugMessages: consoleMessages,
      },
      session: {
        stats: session.stats,
        cumulativeCredits, // 🆕 传递 cumulativeCredits
        totalSessionCredits, // 🆕 传递 totalSessionCredits
      },
    }),
    [
      config,
      settings,
      gitService,
      logger,
      loadHistory,
      addItem,
      clearItems,
      refreshStatic,
      session.stats,
      cumulativeCredits, // 🆕 添加依赖
      totalSessionCredits, // 🆕 添加依赖
      onDebugMessage,
      pendingCompressionItemRef,
      setPendingCompressionItem,
      toggleCorgiMode,
      toggleVimEnabled,
    ],
  );

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      // 初始化 Skill 系统组件
      const settingsManager = new SettingsManager();
      const marketplaceManager = new MarketplaceManager(settingsManager);
      const skillLoader = new SkillLoader(settingsManager, marketplaceManager);

      const loaders = [
        new McpPromptLoader(config),
        new BuiltinCommandLoader(config),
        new InlineCommandLoader(config),
        new ExtensionCommandLoader(config),
        new FileCommandLoader(config),
        new PluginCommandLoader(skillLoader, settingsManager),
      ];
      const commandService = await CommandService.create(
        loaders,
        controller.signal,
      );
      setCommands(commandService.getCommands());
    };

    load();

    return () => {
      controller.abort();
    };
  }, [config]);

  // BUG修复: 避免文件路径被误判为斜杠命令
  // 修复策略: 动态获取已加载的命令，只有真正的命令才会被处理
  // 影响范围: packages/cli/src/ui/hooks/slashCommandProcessor.ts
  const isValidSlashCommand = useCallback((input: string, commandList: readonly SlashCommand[]): boolean => {
    // 🔧 修复：如果命令列表尚未加载完成（空数组），则先假定是有效命令
    // 让后续的命令查找逻辑处理，避免在加载期间拒绝所有命令
    if (commandList.length === 0) {
      return true; // 命令列表未加载时，允许通过验证
    }

    // 提取第一个词（命令名）
    const firstWord = input.substring(1).trim().split(/\s+/)[0];

    if (!firstWord) {
      return false; // 空命令不是有效命令
    }

    // 动态检查：遍历实际加载的命令列表（包括主命令名和别名）
    return commandList.some(cmd =>
      cmd.name === firstWord || cmd.altNames?.includes(firstWord)
    );
  }, []);

  const handleSlashCommand = useCallback(
    async (
      rawQuery: PartListUnion,
    ): Promise<SlashCommandProcessorResult | false> => {
      if (typeof rawQuery !== 'string') {
        return false;
      }

      const trimmed = rawQuery.trim();
      if (!trimmed.startsWith('/') && !trimmed.startsWith('?')) {
        return false;
      }

      // 🆕 新增：智能命令验证
      // 只有在已知命令列表中的才认为是有效命令，避免文件路径被误判
      if (!isValidSlashCommand(trimmed, commands)) {
        return false; // 不是有效命令，让其作为普通文本处理
      }

      // 只有验证通过的命令才添加到历史记录
      const userMessageTimestamp = Date.now();
      addItem({ type: MessageType.USER, text: trimmed }, userMessageTimestamp);

      const parts = trimmed.substring(1).trim().split(/\s+/);
      const commandPath = parts.filter((p) => p); // The parts of the command, e.g., ['memory', 'add']

      let currentCommands = commands;
      let commandToExecute: SlashCommand | undefined;
      let pathIndex = 0;

      for (const part of commandPath) {
        // TODO: For better performance and architectural clarity, this two-pass
        // search could be replaced. A more optimal approach would be to
        // pre-compute a single lookup map in `CommandService.ts` that resolves
        // all name and alias conflicts during the initial loading phase. The
        // processor would then perform a single, fast lookup on that map.

        // First pass: check for an exact match on the primary command name.
        let foundCommand = currentCommands.find((cmd) => cmd.name === part);

        // Second pass: if no primary name matches, check for an alias.
        if (!foundCommand) {
          foundCommand = currentCommands.find((cmd) =>
            cmd.altNames?.includes(part),
          );
        }

        if (foundCommand) {
          commandToExecute = foundCommand;
          pathIndex++;
          if (foundCommand.subCommands) {
            currentCommands = foundCommand.subCommands;
          } else {
            break;
          }
        } else {
          break;
        }
      }

      if (commandToExecute) {
        const args = parts.slice(pathIndex).join(' ');

        if (commandToExecute.action) {
          const fullCommandContext: CommandContext = {
            ...commandContext,
            invocation: {
              raw: trimmed,
              name: commandToExecute.name,
              args,
            },
          };
          try {
            const result = await commandToExecute.action(
              fullCommandContext,
              args,
            );

            if (result) {
              switch (result.type) {
                case 'tool':
                  // 执行其他命令时关闭帮助面板
                  return {
                    type: 'schedule_tool',
                    toolName: result.toolName,
                    toolArgs: result.toolArgs,
                  };
                case 'message':
                  // 执行其他命令时关闭帮助面板
                  addItem(
                    {
                      type:
                        result.messageType === 'error'
                          ? MessageType.ERROR
                          : MessageType.INFO,
                      text: result.content,
                    },
                    Date.now(),
                  );
                  return { type: 'handled' };
                case 'dialog':
                  switch (result.dialog) {
                    case 'help':
                      addItem({ type: 'help', commands } as Omit<HistoryItem, 'id'>, Date.now());
                      return { type: 'handled' };
                    case 'auth':
                      openAuthDialog();
                      return { type: 'handled' };
                    case 'login':
                      openLoginDialog();
                      return { type: 'handled' };
                    case 'theme':
                      openThemeDialog();
                      return { type: 'handled' };
                    case 'model':
                      openModelDialog();
                      return { type: 'handled' };
                    case 'customModelWizard':
                      openCustomModelWizard();
                      return { type: 'handled' };
                    case 'editor':
                      openEditorDialog();
                      return { type: 'handled' };
                    case 'privacy':
                      openPrivacyNotice();
                      return { type: 'handled' };
                    case 'settings-menu':
                      if (openSettingsMenuDialog) {
                        openSettingsMenuDialog();
                      }
                      return { type: 'handled' };
                    case 'init-choice':
                      if (result.metadata && openInitChoiceDialog) {
                        openInitChoiceDialog(result.metadata as any);
                      }
                      return { type: 'handled' };
                    case 'plugin-install':
                      if (openPluginInstallDialog) {
                        openPluginInstallDialog();
                      }
                      return { type: 'handled' };
                    case 'debate-wizard':
                      if (openDebateWizard) {
                        openDebateWizard();
                      }
                      return { type: 'handled' };
                    case 'debate-resume':
                      if (resumeDebate) {
                        resumeDebate();
                      }
                      return { type: 'handled' };
                    case 'goal-wizard':
                      if (openGoalWizard) {
                        openGoalWizard();
                      }
                      return { type: 'handled' };
                    case 'workflow-panel':
                      if (openWorkflowPanel) {
                        openWorkflowPanel();
                      }
                      return { type: 'handled' };
                    default: {
                      const unhandled: never = result.dialog;
                      throw new Error(
                        `Unhandled slash command result: ${unhandled}`,
                      );
                    }
                  }
                case 'load_history': {
                  await config
                    ?.getGeminiClient()
                    ?.setHistory(result.clientHistory);
                  fullCommandContext.ui.clear();
                  result.history.forEach((item, index) => {
                    fullCommandContext.ui.addItem(item, index);
                  });
                  // Linus fix: 会话恢复后触发Static刷新，确保UI显示恢复的内容
                  refreshStatic();
                  console.log('🔄 Static refreshed after chat resume');
                  return { type: 'handled' };
                }
                case 'switch_session': {
                  // 更新全局sessionId
                  if (config && result.sessionId) {
                    config.setSessionId(result.sessionId);
                    console.log(`🔄 Switched to session: ${result.sessionId}`);
                  }

                  // 重置统计数据到新session的状态
                  session.resetStats();
                  console.log(`📊 Stats reset for new session: ${result.sessionId}`);

                  // 设置客户端历史记录
                  await config
                    ?.getGeminiClient()
                    ?.setHistory(result.clientHistory);

                  // 清除UI并加载新历史记录
                  fullCommandContext.ui.clear();
                  result.history.forEach((item, index) => {
                    fullCommandContext.ui.addItem(item, index);
                  });

                  // 触发Static刷新
                  refreshStatic();
                  console.log(`🔄 Session switched and static refreshed: ${result.sessionId}`);
                  return { type: 'handled' };
                }
                case 'quit':
                  // 🎯 优化：防抖处理
                  // 如果已经在退出中，直接忽略重复的退出指令
                  if (getIsQuitting()) {
                    return { type: 'handled' };
                  }

                  // 🎯 macOS Ctrl+C OOM 修复：立即设置退出标志位
                  // 这会告诉信号处理器禁用 JS 清理逻辑，快速 Ctrl+C 直接 exit
                  setQuitting(true);

                  // 🆕 立即显示"正在退出"提示，让用户立刻看到反馈
                  addItem(
                    {
                      type: MessageType.INFO,
                      text: t('command.quit.exiting'),
                    },
                    Date.now(),
                  );
                  // 在下一个事件循环显示退出消息，确保UI已更新
                  setImmediate(() => {
                    setQuittingMessages(result.messages);

                    // 🎯 优化：智能退出逻辑
                    // 1. 给 UI 一点时间渲染 SessionSummaryDisplay (至少 500ms)
                    // 2. 同时等待积分接口返回（如果还在加载中）
                    // 3. 总等待时间不超过 1700ms
                    // 4. 如果使用了自定义模型，跳过积分获取（不会有结果）
                    const startTime = Date.now();
                    const MIN_WAIT = 500;
                    const MAX_WAIT = 1700;
                    let exited = false;

                    const performExit = () => {
                      if (exited) return;
                      exited = true;

                      const elapsed = Date.now() - startTime;
                      const remaining = Math.max(0, MIN_WAIT - elapsed);

                      setTimeout(() => {
                        // Fire and forget cleanup to prevent hanging
                        runExitCleanup().catch(() => {});
                        process.exit(0);
                      }, remaining);
                    };

                    // 检查是否使用了自定义模型
                    const currentModel = config?.getModel() || '';
                    const isUsingCustomModel = isCustomModel(currentModel);

                    if (isUsingCustomModel) {
                      // 自定义模型无法获取积分信息，直接按最少等待时间退出
                      performExit();
                    } else {
                      // 尝试等待积分加载完成，然后尽快退出
                      getCreditsService()
                        .getCreditsInfo()
                        .finally(() => {
                          performExit();
                        });

                      // 安全网：无论积分接口如何，1.2秒内必须退出
                      setTimeout(performExit, MAX_WAIT);
                    }
                  });

                  return { type: 'handled' };

                case 'submit_prompt':
                  return {
                    type: 'submit_prompt',
                    content: result.content,
                    silent: result.silent, // 🎯 传递静默模式
                  };
                case 'select_session':
                  // 透传 select_session action
                  return {
                    type: 'select_session',
                    sessions: result.sessions,
                  } as any; // Temporary cast, need to update SlashCommandProcessorResult type
                case 'refine_result':
                  return {
                    type: 'refine_result',
                    original: result.original,
                    refined: result.refined,
                    options: result.options,
                  };
                default: {
                  const unhandled: never = result;
                  throw new Error(
                    `Unhandled slash command result: ${unhandled}`,
                  );
                }
              }
            }
          } catch (e) {
            // 执行命令出错时也要关闭帮助面板
            addItem(
              {
                type: MessageType.ERROR,
                text: e instanceof Error ? e.message : String(e),
              },
              Date.now(),
            );
            return { type: 'handled' };
          }

          // 命令执行完成但没有返回 result 时，也要关闭帮助面板
          return { type: 'handled' };
        } else if (commandToExecute.subCommands) {
          // 命令需要子命令时，关闭帮助面板
          const helpText = `Command '/${commandToExecute.name}' requires a subcommand. Available:\n${commandToExecute.subCommands
            .map((sc) => `  - ${sc.name}: ${sc.description || ''}`)
            .join('\n')}`;
          addMessage({
            type: MessageType.INFO,
            content: helpText,
            timestamp: new Date(),
          });
          return { type: 'handled' };
        }
      }

      // 未知命令时也要关闭帮助面板
      addMessage({
        type: MessageType.ERROR,
        content: `Unknown command: ${trimmed}`,
        timestamp: new Date(),
      });
      return { type: 'handled' };
    },
      [
    config,
    addItem,
    openAuthDialog,
    openLoginDialog,
    commands,
    commandContext,
    addMessage,
    openThemeDialog,
    openModelDialog,
    openPrivacyNotice,
    openEditorDialog,
    setQuittingMessages,
    isValidSlashCommand, // 🆕 添加新的验证函数依赖
  ],
  );

  return {
    handleSlashCommand,
    slashCommands: commands,
    pendingHistoryItems,
    commandContext,
  };
};
