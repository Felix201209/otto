/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getErrorMessage,
  loadServerHierarchicalMemory,
  MemoryTool,
  MemoryManagerTool,
  getCoreSystemPrompt,
} from 'otto-core';
import { getEncoding } from 'js-tiktoken';
import { MessageType } from '../types.js';
import {
  CommandKind,
  SlashCommand,
  SlashCommandActionReturn,
} from './types.js';
import { t, tp } from '../utils/i18n.js';

interface OttoClientWithMutableChat {
  chat?: {
    generationConfig?: {
      systemInstruction?: string;
    };
  };
}

function updateSystemInstruction(
  geminiClient: unknown,
  systemInstruction: string,
): void {
  const chat = (geminiClient as OttoClientWithMutableChat | null)?.chat;
  if (chat?.generationConfig) {
    chat.generationConfig.systemInstruction = systemInstruction;
  }
}


function parseProjectArgs(args = ''): Record<string, string> {
  const result: Record<string, string> = {};
  const parts = args.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  const positional: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index].replace(/^"|"$/g, '');
    if (part.startsWith('--')) {
      const key = part.slice(2);
      const value = parts[index + 1]?.replace(/^"|"$/g, '') || '';
      result[key] = value;
      index += 1;
    } else {
      positional.push(part);
    }
  }
  result._ = positional.join(' ');
  return result;
}

async function runProjectMemoryAction(
  context: Parameters<NonNullable<SlashCommand['action']>>[0],
  action: 'project_create' | 'project_list' | 'project_add' | 'project_archive' | 'project_code_config' | 'project_code_status',
  args?: string,
): Promise<void> {
  const config = await context.services.config;
  if (!config) {
    context.ui.addItem({ type: MessageType.ERROR, text: 'Config not loaded.' }, Date.now());
    return;
  }
  const parsed = parseProjectArgs(args || '');
  const tool = new MemoryManagerTool(config);
  const params = {
    action,
    project_id: parsed.id || parsed.project || (action !== 'project_create' && action !== 'project_code_config' ? parsed._ : undefined),
    project_name: parsed.name || (action === 'project_create' ? parsed._ : undefined),
    project_goal: parsed.goal,
    project_type: parsed.type,
    team_id: parsed.team,
    company_id: parsed.company,
    user_id: parsed.user,
    memory_title: parsed.title,
    content: action === 'project_add' ? parsed.content || parsed._ : undefined,
    repo_path: parsed.repo || parsed.path || (action === 'project_code_config' ? parsed._ : undefined),
    mcp_server: parsed.server,
  };
  const result = await tool.execute(
    params as never,
    new AbortController().signal,
  );
  context.ui.addItem(
    {
      type: String(result.llmContent).startsWith('memory FAIL') ? MessageType.ERROR : MessageType.INFO,
      text: typeof result.returnDisplay === 'string' ? result.returnDisplay : JSON.stringify(result.returnDisplay),
    },
    Date.now(),
  );
}

export const memoryCommand: SlashCommand = {
  name: 'memory',
  description: t('command.memory.description'),
  kind: CommandKind.BUILT_IN,
  subCommands: [
    {
      name: 'paths',
      description: 'Show memory file paths',
      kind: CommandKind.BUILT_IN,
      action: async (context) => {
        const filePaths = context.services.config?.getOttoMdFilePaths() || [];

        if (filePaths.length === 0) {
          context.ui.addItem(
            {
              type: MessageType.INFO,
              text: 'No memory files currently loaded.',
            },
            Date.now(),
          );
          return;
        }

        const pathsText = `Memory files (${filePaths.length}):\n${filePaths.map(f => `  - ${f}`).join('\n')}`;
        context.ui.addItem(
          {
            type: MessageType.INFO,
            text: pathsText,
          },
          Date.now(),
        );
      },
    },
    {
      name: 'show',
      description: t('command.memory.show.description'),
      kind: CommandKind.BUILT_IN,
      action: async (context) => {
        const memoryContent = context.services.config?.getUserMemory() || '';
        const fileCount = context.services.config?.getOttoMdFileCount() || 0;

        const messageContent =
          memoryContent.length > 0
            ? `${tp('memory.show.content', { fileCount })}\n\n---\n${memoryContent}\n---`
            : t('memory.show.empty');

        context.ui.addItem(
          {
            type: MessageType.INFO,
            text: messageContent,
          },
          Date.now(),
        );
      },
    },
    {
      name: 'add',
      description: t('command.memory.add.description'),
      kind: CommandKind.BUILT_IN,
      action: async (context, args): Promise<SlashCommandActionReturn | void> => {
        if (!args || args.trim() === '') {
          return {
            type: 'message',
            messageType: 'error',
            content: '用法: /memory add <要记住的文本>',
          };
        }

        context.ui.addItem(
          {
            type: MessageType.INFO,
            text: `${t('memory.add.trying')}: "${args.trim()}"`,
          },
          Date.now(),
        );

        try {
          // 直接调用save_memory工具，而不是返回工具调用请求
          const config = await context.services.config;
          if (config) {
            const memoryTool = new MemoryTool(config);
            const result = await memoryTool.execute(
              { fact: args.trim() },
              new AbortController().signal
            );

            // 显示执行结果
            const displayText = typeof result.returnDisplay === 'string'
              ? result.returnDisplay
              : JSON.stringify(result.returnDisplay);
            context.ui.addItem(
              {
                type: MessageType.INFO,
                text: displayText,
              },
              Date.now(),
            );

            // 自动刷新记忆以重载更新后的文件
            try {
              const { memoryContent, fileCount, filePaths } =
                await loadServerHierarchicalMemory(
                  config.getWorkingDir(),
                  config.getDebugMode(),
                  config.getFileService(),
                  config.getExtensionContextFilePaths(),
                  config.getFileFilteringOptions(),
                  context.services.settings.merged.memoryDiscoveryMaxDirs,
                );
              config.setUserMemory(memoryContent);
              config.setOttoMdFileCount(fileCount);
              config.setOttoMdFilePaths(filePaths);

              // 计算并更新 memory token
              try {
                const enc = getEncoding('cl100k_base');
                const memoryTokenCount = enc.encode(memoryContent).length;
                config.setMemoryTokenCount(memoryTokenCount);
              } catch {
                config.setMemoryTokenCount(0);
              }

              // 🔥 关键修复：更新当前模型实例的系统指令
              try {
                const geminiClient = await config.getOttoClient();
                if (geminiClient) {
                  const isVSCode = config.getVsCodePluginMode();
                  const agentStyle = config.getAgentStyle();
                  const updatedSystemInstruction = getCoreSystemPrompt(
      memoryContent,
      isVSCode,
      undefined,
      agentStyle,
      undefined,
      context.services.config?.getPreferredLanguage()
    );
                  updateSystemInstruction(geminiClient, updatedSystemInstruction);
                }
              } catch (updateError) {
                console.warn('更新模型系统指令失败:', updateError);
              }

              // 显示刷新成功信息
              let refreshMessage = `${t('memory.add.refreshSuccess')} ${t('memory.refreshed').replace('{fileCount}', fileCount.toString()).replace('{charCount}', memoryContent.length.toString())}`;
              if (fileCount > 0 && filePaths.length > 0) {
                refreshMessage += `\nMemory files:\n${filePaths.map(f => `  - ${f}`).join('\n')}`;
              }
              context.ui.addItem(
                {
                  type: MessageType.INFO,
                  text: refreshMessage,
                },
                Date.now(),
              );
            } catch (refreshError) {
              // 显示刷新失败信息
              const errorMessage = refreshError instanceof Error ? refreshError.message : String(refreshError);
              context.ui.addItem(
                {
                  type: MessageType.ERROR,
                  text: `${t('memory.add.refreshError')}: ${errorMessage}`,
                },
                Date.now(),
              );
            }
          } else {
            context.ui.addItem(
              {
                type: MessageType.ERROR,
                text: t('memory.add.configNotLoaded'),
              },
              Date.now(),
            );
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          context.ui.addItem(
            {
              type: MessageType.ERROR,
              text: `${t('memory.add.saveError')}: ${errorMessage}`,
            },
            Date.now(),
          );
        }
      },
    },
    {
      name: 'project',
      description: 'Manage organization project memory',
      kind: CommandKind.BUILT_IN,
      subCommands: [
        {
          name: 'create',
          description: 'Create a project memory container',
          kind: CommandKind.BUILT_IN,
          action: async (context, args) => runProjectMemoryAction(context, 'project_create', args),
        },
        {
          name: 'list',
          description: 'List project memory containers',
          kind: CommandKind.BUILT_IN,
          action: async (context, args) => runProjectMemoryAction(context, 'project_list', args),
        },
        {
          name: 'add',
          description: 'Add memory to a project',
          kind: CommandKind.BUILT_IN,
          action: async (context, args) => runProjectMemoryAction(context, 'project_add', args),
        },
        {
          name: 'archive',
          description: 'Archive project and generate candidate skill',
          kind: CommandKind.BUILT_IN,
          action: async (context, args) => runProjectMemoryAction(context, 'project_archive', args),
        },
        {
          name: 'code-config',
          description: 'Attach codebase-memory-mcp config to a project',
          kind: CommandKind.BUILT_IN,
          action: async (context, args) => runProjectMemoryAction(context, 'project_code_config', args),
        },
        {
          name: 'code-status',
          description: 'Show codebase-memory-mcp status for a project',
          kind: CommandKind.BUILT_IN,
          action: async (context, args) => runProjectMemoryAction(context, 'project_code_status', args),
        }
      ],
    },
    {
      name: 'refresh',
      description: t('command.memory.refresh.description'),
      kind: CommandKind.BUILT_IN,
      action: async (context) => {
        context.ui.addItem(
          {
            type: MessageType.INFO,
            text: t('memory.refresh.refreshing'),
          },
          Date.now(),
        );

        try {
          const config = await context.services.config;
          if (config) {
            const { memoryContent, fileCount, filePaths } =
              await loadServerHierarchicalMemory(
                config.getWorkingDir(),
                config.getDebugMode(),
                config.getFileService(),
                config.getExtensionContextFilePaths(),
                config.getFileFilteringOptions(),
                context.services.settings.merged.memoryDiscoveryMaxDirs,
              );
            config.setUserMemory(memoryContent);
            config.setOttoMdFileCount(fileCount);
            config.setOttoMdFilePaths(filePaths);

            // 计算并更新 memory token
            try {
              const enc = getEncoding('cl100k_base');
              const memoryTokenCount = enc.encode(memoryContent).length;
              config.setMemoryTokenCount(memoryTokenCount);
            } catch {
              config.setMemoryTokenCount(0);
            }

            // 🔥 关键修复：更新当前模型实例的系统指令
            try {
              const geminiClient = await config.getOttoClient();
              if (geminiClient) {
                const isVSCode = config.getVsCodePluginMode();
                const agentStyle = config.getAgentStyle();
                const updatedSystemInstruction = getCoreSystemPrompt(
      memoryContent,
      isVSCode,
      undefined,
      agentStyle,
      undefined,
      context.services.config?.getPreferredLanguage()
    );
                updateSystemInstruction(geminiClient, updatedSystemInstruction);
              }
            } catch (updateError) {
              console.warn('更新模型系统指令失败:', updateError);
            }

            let successMessage =
              memoryContent.length > 0
                ? `${t('memory.refresh.success')} ${t('memory.refreshed').replace('{fileCount}', fileCount.toString()).replace('{charCount}', memoryContent.length.toString())}`
                : t('memory.refresh.noContent');

            // Add file paths to the success message
            if (fileCount > 0 && filePaths.length > 0) {
              successMessage += `\nMemory files:\n${filePaths.map(f => `  - ${f}`).join('\n')}`;
            }

            context.ui.addItem(
              {
                type: MessageType.INFO,
                text: successMessage,
              },
              Date.now(),
            );
          }
        } catch (error) {
          const errorMessage = getErrorMessage(error);
          context.ui.addItem(
            {
              type: MessageType.ERROR,
              text: `Error refreshing memory: ${errorMessage}`,
            },
            Date.now(),
          );
        }
      },
    },
  ],
};
