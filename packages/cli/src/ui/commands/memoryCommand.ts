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
  getAutoMemoryEngine,
  getKnowledgeCapturePipeline,
  formatKnowledgeCaptureStatus,
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
  action: 'project_create' | 'project_list' | 'project_add' | 'project_archive' | 'project_code_config' | 'project_code_status' | 'project_code_index' | 'project_code_arch' | 'project_code_search',
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
    query: action === 'project_code_search' ? parsed.query || parsed._ : undefined,
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

/**
 * 新版自动记忆维护命令。
 *
 * 这些能力是对原 `/memory show|add|project|refresh` 的扩展，不能替换旧命令；
 * 企业用户和既有脚本仍依赖原子命令名。集中在这里追加可以让两套入口共存。
 */
async function knowledgeCaptureStatusAction(): Promise<SlashCommandActionReturn> {
  try {
    const status = await getKnowledgeCapturePipeline().getStatus();
    return {
      type: 'message',
      messageType: status.lastError ? 'error' : 'info',
      content: formatKnowledgeCaptureStatus(status),
    };
  } catch (error) {
    return {
      type: 'message',
      messageType: 'error',
      content: `获取自动知识沉淀状态失败: ${getErrorMessage(error)}`,
    };
  }
}

const autoMemoryCommands: SlashCommand[] = [
  {
    name: 'status',
    description: '查看自动知识沉淀运行状态',
    kind: CommandKind.BUILT_IN,
    action: knowledgeCaptureStatusAction,
  },
  {
    name: 'capture-status',
    description: '查看自动知识沉淀运行状态',
    kind: CommandKind.BUILT_IN,
    action: knowledgeCaptureStatusAction,
  },
  {
    name: 'stats',
    description: '查看记忆引擎统计信息',
    kind: CommandKind.BUILT_IN,
    action: async (): Promise<SlashCommandActionReturn> => {
      try {
        const engine = getAutoMemoryEngine();
        await engine.initialize();
        const stats = engine.getStats();
        const scopes = Object.entries(stats.byScope)
          .map(([scope, count]) => `  - ${scope}: ${count}`)
          .join('\n');
        return {
          type: 'message',
          messageType: 'info',
          content:
            `记忆引擎统计\n\n总条目数: ${stats.totalEntries}\n` +
            `按作用域:\n${scopes || '  无'}\n` +
            `估算 Token: ${stats.totalEstimatedTokens.toLocaleString()}\n` +
            `压缩率: ${(stats.compressionRatio * 100).toFixed(1)}%`,
        };
      } catch (error) {
        return {
          type: 'message',
          messageType: 'error',
          content: `获取记忆统计失败: ${getErrorMessage(error)}`,
        };
      }
    },
  },
  {
    name: 'merge',
    description: '检测并执行记忆合并',
    kind: CommandKind.BUILT_IN,
    action: async (): Promise<SlashCommandActionReturn> => {
      try {
        const engine = getAutoMemoryEngine();
        await engine.initialize();
        const candidates = await engine.detectMergeCandidates();
        let merged = 0;
        for (const candidate of candidates.slice(0, 10)) {
          if (await engine.applyMerge(candidate)) merged += 1;
        }
        return {
          type: 'message',
          messageType: 'info',
          content:
            candidates.length === 0
              ? '未检测到可合并的记忆条目。'
              : `记忆合并完成：检测到 ${candidates.length} 组，已合并 ${merged} 组。`,
        };
      } catch (error) {
        return { type: 'message', messageType: 'error', content: `合并失败: ${getErrorMessage(error)}` };
      }
    },
  },
  {
    name: 'split',
    description: '检测并执行记忆分割',
    kind: CommandKind.BUILT_IN,
    action: async (): Promise<SlashCommandActionReturn> => {
      try {
        const engine = getAutoMemoryEngine();
        await engine.initialize();
        const candidates = await engine.detectSplitCandidates();
        let split = 0;
        for (const candidate of candidates.slice(0, 5)) {
          if ((await engine.applySplit(candidate)).length > 0) split += 1;
        }
        return {
          type: 'message',
          messageType: 'info',
          content:
            candidates.length === 0
              ? '未检测到需要分割的记忆条目。'
              : `记忆分割完成：检测到 ${candidates.length} 条，已分割 ${split} 条。`,
        };
      } catch (error) {
        return { type: 'message', messageType: 'error', content: `分割失败: ${getErrorMessage(error)}` };
      }
    },
  },
  {
    name: 'compress',
    description: '压缩老旧记忆条目',
    kind: CommandKind.BUILT_IN,
    action: async (): Promise<SlashCommandActionReturn> => {
      try {
        const engine = getAutoMemoryEngine();
        await engine.initialize();
        const results = await engine.compressOldMemories();
        return {
          type: 'message',
          messageType: 'info',
          content: results.length === 0 ? '当前没有需要压缩的记忆。' : `已压缩 ${results.length} 组老旧记忆。`,
        };
      } catch (error) {
        return { type: 'message', messageType: 'error', content: `压缩失败: ${getErrorMessage(error)}` };
      }
    },
  },
  {
    name: 'maintain',
    description: '执行完整记忆维护周期',
    kind: CommandKind.BUILT_IN,
    action: async (): Promise<SlashCommandActionReturn> => {
      try {
        const engine = getAutoMemoryEngine();
        await engine.initialize();
        const result = await engine.runMaintenanceCycle();
        return {
          type: 'message',
          messageType: 'info',
          content: `记忆维护完成：合并 ${result.merges}，分割 ${result.splits}，压缩 ${result.compressions}，清理 ${result.cleanups}。`,
        };
      } catch (error) {
        return { type: 'message', messageType: 'error', content: `维护失败: ${getErrorMessage(error)}` };
      }
    },
  },
  {
    name: 'list',
    description: '列出自动记忆条目',
    kind: CommandKind.BUILT_IN,
    action: async (_context, args): Promise<SlashCommandActionReturn> => {
      try {
        const engine = getAutoMemoryEngine();
        await engine.initialize();
        const parts = args.trim().split(/\s+/).filter(Boolean);
        const requestedScope = parts.find((part) => ['global', 'project', 'session'].includes(part));
        const scope = requestedScope as 'global' | 'project' | 'session' | undefined;
        const limitIndex = parts.indexOf('--limit');
        const limit = limitIndex >= 0 ? Number.parseInt(parts[limitIndex + 1] ?? '', 10) || 20 : 20;
        const entries = engine.queryEntries({ scope, limit });
        const content = entries.length
          ? entries
              .map((entry) => {
                const preview = entry.text.length > 80 ? `${entry.text.slice(0, 80)}...` : entry.text;
                return `- ${entry.id.slice(0, 16)} | ${entry.topics.join(', ') || '无主题'}\n  ${preview}`;
              })
              .join('\n')
          : '没有找到自动记忆条目。';
        return { type: 'message', messageType: 'info', content };
      } catch (error) {
        return { type: 'message', messageType: 'error', content: `列出失败: ${getErrorMessage(error)}` };
      }
    },
  },
  {
    name: 'clean',
    description: '清理过期自动记忆条目',
    kind: CommandKind.BUILT_IN,
    action: async (): Promise<SlashCommandActionReturn> => {
      try {
        const engine = getAutoMemoryEngine();
        await engine.initialize();
        const count = await engine.cleanExpiredMemories();
        return { type: 'message', messageType: 'info', content: `已清理 ${count} 条过期记忆。` };
      } catch (error) {
        return { type: 'message', messageType: 'error', content: `清理失败: ${getErrorMessage(error)}` };
      }
    },
  },
];

export const memoryCommand: SlashCommand = {
  name: 'memory',
  description: t('command.memory.description'),
  kind: CommandKind.BUILT_IN,
  subCommands: [
    ...autoMemoryCommands,
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
        },
        {
          name: 'code-index',
          description: 'Index project repo with codebase-memory-mcp',
          kind: CommandKind.BUILT_IN,
          action: async (context, args) => runProjectMemoryAction(context, 'project_code_index', args),
        },
        {
          name: 'code-arch',
          description: 'Query project architecture from codebase-memory-mcp',
          kind: CommandKind.BUILT_IN,
          action: async (context, args) => runProjectMemoryAction(context, 'project_code_arch', args),
        },
        {
          name: 'code-search',
          description: 'Search project code graph with codebase-memory-mcp',
          kind: CommandKind.BUILT_IN,
          action: async (context, args) => runProjectMemoryAction(context, 'project_code_search', args),
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
