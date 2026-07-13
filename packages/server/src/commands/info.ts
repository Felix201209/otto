/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 信息类命令：/about /context /tools /mcp /extensions。
 * 全部只读、无副作用；数据源与既有能力帧（mcp_list / get_tools /
 * get_extensions / get_context_breakdown）完全同源——报真实数据，没有的字段不编造。
 */

import {
  AcpCommands,
  getCoreSystemPrompt,
  tokenLimit,
  uiTelemetryService,
} from 'otto-core';
import { md, fail, type ServerSlashCommand } from './types.js';

/** `/about`：core 版本环境 banner（复用 core AcpCommands.getAboutInfo）+ server 侧信息。 */
export const aboutCommand: ServerSlashCommand = {
  name: 'about',
  description: '版本与运行环境信息',
  action: async ({ host }) => {
    const about = await AcpCommands.getAboutInfo();
    const uptimeMin = Math.floor(host.uptimeMs() / 60_000);
    const lines = [
      '### 关于 Otto',
      '',
      ...about.content.split('\n').map((l) => `- ${l}`),
      `- Otto Server: ${host.serverVersion}（协议 v${host.protocolVersion}）`,
      `- 运行时长: ${uptimeMin} 分钟 · 会话数: ${host.store.listSessions().length}`,
    ];
    return md(lines.join('\n'));
  },
};

/**
 * `/context`：当前会话 context 用量分解。
 * 口径对齐 server 的 get_context_breakdown 帧 handler（那是 OttoServer 私有方法，
 * 受「server.ts 只改帧路由区」约束不便抽出，这里按同一套 core API 独立重算；
 * 两处算式若要变更需同步——见 handleGetContextBreakdown）。
 */
export const contextCommand: ServerSlashCommand = {
  name: 'context',
  description: '当前会话的上下文 token 用量分解',
  action: ({ host, sessionId }) => {
    const session = host.store.getSession(sessionId);
    const cfg = host.getConfig(sessionId);
    const modelId =
      cfg?.getModel?.() ?? session?.model ?? host.currentModel() ?? 'auto';
    const maxTokens = tokenLimit(modelId, cfg);
    const memoryFilesTokens = cfg?.getMemoryTokenCount?.() ?? 0;
    let systemPromptTokens = 0;
    try {
      const fullPrompt = getCoreSystemPrompt(
        cfg?.getUserMemory?.() ?? '',
        false,
        undefined,
        cfg?.getAgentStyle?.() ?? 'default',
        undefined,
        cfg?.getPreferredLanguage?.(),
      );
      const totalSystemTokens = Math.ceil(fullPrompt.length / 4);
      systemPromptTokens =
        memoryFilesTokens > 0 && totalSystemTokens > memoryFilesTokens
          ? totalSystemTokens - memoryFilesTokens
          : totalSystemTokens;
    } catch {
      systemPromptTokens = 0;
    }
    const modelMetrics = uiTelemetryService.getMetrics().models[modelId];
    const systemToolsTokens = modelMetrics?.tokens.tool ?? 0;
    const actualPromptTokens = uiTelemetryService.getLastPromptTokenCount();
    const messagesTokens =
      actualPromptTokens > 0
        ? Math.max(
            0,
            actualPromptTokens -
              systemPromptTokens -
              memoryFilesTokens -
              systemToolsTokens,
          )
        : 0;
    const totalInputTokens =
      actualPromptTokens > 0
        ? actualPromptTokens
        : systemPromptTokens + memoryFilesTokens + systemToolsTokens;
    const freeSpaceTokens = Math.max(0, maxTokens - totalInputTokens);
    const displayName =
      host.modelInfos().find((m) => m.id === modelId)?.displayName ?? modelId;
    const fmt = (n: number): string => n.toLocaleString();
    return md(
      [
        `### 上下文用量 — ${displayName}`,
        '',
        '| 项 | tokens |',
        '| --- | ---: |',
        `| 系统提示词 | ${fmt(systemPromptTokens)} |`,
        `| 记忆文件 | ${fmt(memoryFilesTokens)} |`,
        `| 工具定义 | ${fmt(systemToolsTokens)} |`,
        `| 对话消息 | ${fmt(messagesTokens)} |`,
        `| **合计输入** | **${fmt(totalInputTokens)}** |`,
        `| 剩余空间 | ${fmt(freeSpaceTokens)} |`,
        '',
        `模型上限：${fmt(maxTokens)} tokens`,
      ].join('\n'),
    );
  },
};

/** 单行截断：工具描述可能很长，取首行 + 上限，防撑爆气泡。 */
function firstLine(text: string, max = 90): string {
  const line = (text ?? '').split('\n')[0].trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** `/tools`：当前会话可用工具清单（内置 + MCP，与 get_tools 帧同源）。 */
export const toolsCommand: ServerSlashCommand = {
  name: 'tools',
  description: '列出当前会话可用的工具（内置 + MCP）',
  action: async ({ host, sessionId }) => {
    const cfg = host.getConfig(sessionId);
    if (!cfg) {
      // 懒构建：runtime 随首条消息初始化。诚实告知而非空列表冒充「无工具」。
      return fail(
        '会话运行时尚未初始化（工具注册表随首条消息构建）。先发一条消息，再运行 `/tools`。',
      );
    }
    const registry = await cfg.getToolRegistry();
    const tools = registry.getAllTools();
    const builtin = tools.filter(
      (t) => !(t as { serverName?: string }).serverName,
    );
    const byServer = new Map<string, typeof tools>();
    for (const t of tools) {
      const server = (t as { serverName?: string }).serverName;
      if (!server) continue;
      const list = byServer.get(server) ?? [];
      list.push(t);
      byServer.set(server, list);
    }
    const lines: string[] = [`### 可用工具（${tools.length}）`, ''];
    lines.push(`**内置工具（${builtin.length}）**`, '');
    for (const t of builtin) {
      lines.push(`- \`${t.name}\` — ${firstLine(t.description)}`);
    }
    for (const [server, list] of byServer) {
      lines.push('', `**MCP · ${server}（${list.length}）**`, '');
      for (const t of list) {
        lines.push(`- \`${t.name}\` — ${firstLine(t.description)}`);
      }
    }
    return md(lines.join('\n'));
  },
};

/** `/mcp`：MCP 服务器清单 + 连接状态（与 mcp_list 帧同源）。 */
export const mcpCommand: ServerSlashCommand = {
  name: 'mcp',
  description: 'MCP 服务器清单与连接状态',
  action: ({ host }) => {
    const servers = host.mcpServerInfos();
    if (servers.length === 0) {
      return md(
        '未配置 MCP 服务器。可在「设置与诊断中心 → MCP」面板添加（或编辑 ~/.otto-user/settings.json 的 mcpServers）。',
      );
    }
    const statusLabel: Record<string, string> = {
      connected: '🟢 已连接',
      connecting: '🟡 连接中',
      disconnected: '⚪ 未连接',
    };
    const lines: string[] = [`### MCP 服务器（${servers.length}）`, ''];
    for (const s of servers) {
      const target = s.command ?? s.url ?? s.httpUrl ?? '';
      lines.push(
        `- **${s.name}** ${statusLabel[s.status] ?? s.status}${target ? ` — \`${target}\`` : ''}${s.description ? `：${s.description}` : ''}`,
      );
    }
    lines.push('', '管理（添加/移除）请用「设置与诊断中心 → MCP」面板。');
    return md(lines.join('\n'));
  },
};

/** `/extensions`：已安装扩展列表（项目级 + 全局，与 get_extensions 帧同源）。 */
export const extensionsCommand: ServerSlashCommand = {
  name: 'extensions',
  description: '列出已安装的扩展',
  action: async ({ host }) => {
    const extensions = await host.extensionSummaries();
    if (extensions.length === 0) {
      return md(
        '未安装扩展（项目级 .otto-user/extensions 与全局 ~/.otto-user/extensions 均为空）。',
      );
    }
    const lines = [
      `### 已安装扩展（${extensions.length}）`,
      '',
      ...extensions.map((e) => `- **${e.name}** v${e.version} — \`${e.path}\``),
    ];
    return md(lines.join('\n'));
  },
};

export const infoCommands: ServerSlashCommand[] = [
  aboutCommand,
  contextCommand,
  toolsCommand,
  mcpCommand,
  extensionsCommand,
];
