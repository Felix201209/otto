/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 知识/记忆类命令：/kb /memory /todo。
 *   - /kb：直接执行 core 的 KnowledgeBaseTool（与 CLI /kb、knowledge_base 工具
 *     共用 ~/.otto-user/knowledge 的同一份 LocalKnowledgeStore），真实读写。
 *   - /memory：show/list 优先复用 core AcpCommands（有会话 Config 时），否则
 *     直接读层级记忆文件兜底；add 走 MemoryTool 的真实写盘（与 add_memory 帧同落点）。
 *   - /todo：进程级 todoStore 的真实读取/清空（对齐 CLI /todo 的 clear 语义并补 list）。
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import {
  AcpCommands,
  DEFAULT_CONTEXT_FILENAME,
  KnowledgeBaseTool,
  MemoryTool,
  OTTO_CONFIG_DIR,
  todoStore,
} from 'otto-core';
import {
  md,
  fail,
  type CommandContext,
  type ServerSlashCommand,
  type SlashOutcome,
} from './types.js';

// ── /kb ────────────────────────────────────────────────────────────────────

/**
 * 解析 `--key value` 风格参数，其余拼进 result._。
 * 与 CLI kbCommand 的 parseKbArgs 同逻辑（CLI 包不在 server 依赖里，无法直接
 * import，这里保持算法一致；变更需两处同步）。
 */
function parseKbArgs(args = ''): Record<string, string> {
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

/** 统一执行 knowledge_base 工具并把 llmContent 转成 markdown 结果。 */
async function runKb(params: {
  action: 'add' | 'search' | 'list' | 'remove';
  query?: string;
  content?: string;
  category?: string;
  tags?: string[];
  id?: string;
  limit?: number;
}): Promise<SlashOutcome> {
  const tool = new KnowledgeBaseTool();
  const result = await tool.execute(params, new AbortController().signal);
  const text =
    typeof result.llmContent === 'string'
      ? result.llmContent
      : JSON.stringify(result.llmContent);
  // 工具约定：失败信息以 'Error' 开头（见 KnowledgeBaseTool.execute）。
  return text.startsWith('Error') ? fail(text) : md(text);
}

export const kbCommand: ServerSlashCommand = {
  name: 'kb',
  description: '个人本地知识库（add/search/list/remove）',
  usage: 'kb add|search|list|remove …',
  subCommands: [
    {
      name: 'add',
      description: '保存知识：/kb add [--category 分类] [--tags a,b] <内容>',
      action: (_ctx, args) => {
        const parsed = parseKbArgs(args);
        if (!parsed._) {
          return fail('用法：`/kb add [--category 分类] [--tags a,b] <要保存的内容>`');
        }
        return runKb({
          action: 'add',
          content: parsed._,
          category: parsed['category'],
          tags: parsed['tags']
            ? parsed['tags'].split(',').map((t) => t.trim()).filter(Boolean)
            : undefined,
        });
      },
    },
    {
      name: 'search',
      description: '检索知识：/kb search [--category 分类] <关键词>',
      action: (_ctx, args) => {
        const parsed = parseKbArgs(args);
        if (!parsed._) {
          return fail('用法：`/kb search [--category 分类] <关键词>`');
        }
        return runKb({
          action: 'search',
          query: parsed._,
          category: parsed['category'],
        });
      },
    },
    {
      name: 'list',
      description: '列出最近条目：/kb list [条数]',
      action: (_ctx, args) => {
        const limit = Number.parseInt(parseKbArgs(args)._, 10);
        return runKb({
          action: 'list',
          limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
        });
      },
    },
    {
      name: 'remove',
      description: '按 id 删除条目：/kb remove <id>',
      action: (_ctx, args) => {
        const parsed = parseKbArgs(args);
        if (!parsed._) {
          return fail('用法：`/kb remove <条目id>`（id 可用 `/kb list` 查看）');
        }
        return runKb({ action: 'remove', id: parsed._ });
      },
    },
  ],
};

// ── /memory ────────────────────────────────────────────────────────────────

/** 层级记忆文件的两处落点（与 get_memory 帧 handler 同一约定）。 */
function memoryFilePaths(cwd: string): { project: string; global: string } {
  return {
    project: path.join(cwd, 'OTTO.md'),
    global: path.join(homedir(), OTTO_CONFIG_DIR, 'memory', DEFAULT_CONTEXT_FILENAME),
  };
}

/** 会话 runtime 未构建时的兜底：直接读记忆文件，照样给真实内容。 */
async function showMemoryFromFiles(ctx: CommandContext): Promise<SlashOutcome> {
  const paths = memoryFilePaths(ctx.host.cwd(ctx.sessionId));
  const sections: string[] = [];
  for (const [label, filePath] of [
    ['项目记忆（OTTO.md）', paths.project],
    ['全局记忆', paths.global],
  ] as const) {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      sections.push(`**${label}** — \`${filePath}\`\n\n---\n${content}\n---`);
    } catch {
      sections.push(`**${label}** — \`${filePath}\`（不存在）`);
    }
  }
  return md(sections.join('\n\n'));
}

export const memoryCommand: ServerSlashCommand = {
  name: 'memory',
  description: '层级记忆（show/add/refresh/list）',
  usage: 'memory show|add|refresh|list …',
  subCommands: [
    {
      name: 'show',
      description: '查看当前记忆内容',
      action: (ctx) => {
        const cfg = ctx.host.getConfig(ctx.sessionId);
        // 有会话 Config 时复用 core 命令层（含文件计数），否则读文件兜底。
        if (cfg) return md(AcpCommands.showMemory(cfg).content);
        return showMemoryFromFiles(ctx);
      },
    },
    {
      name: 'add',
      description: '追加一条记忆事实：/memory add <内容>',
      action: async (ctx, args) => {
        const fact = args.trim();
        if (!fact) return fail('用法：`/memory add <要记住的内容>`');
        // 与 add_memory 帧同落点：项目级 OTTO.md（core MemoryTool 的真实写盘）。
        const target = memoryFilePaths(ctx.host.cwd(ctx.sessionId)).project;
        await MemoryTool.performAddMemoryEntry(fact, target, {
          readFile: fs.readFile,
          writeFile: fs.writeFile,
          mkdir: fs.mkdir,
        });
        return md(`已写入 \`${target}\`：\n\n> ${fact}`);
      },
    },
    {
      name: 'refresh',
      description: '重新加载记忆文件到当前会话',
      action: async (ctx) => {
        const cfg = ctx.host.getConfig(ctx.sessionId);
        if (!cfg) {
          // 诚实说明语义：记忆随 runtime 构建加载，未构建时无可刷新对象。
          return md(
            '会话运行时尚未初始化——无需刷新：下一轮对话会自动读取最新记忆文件。',
          );
        }
        const result = await AcpCommands.refreshMemory(cfg);
        return result.messageType === 'error'
          ? fail(result.content)
          : md(result.content);
      },
    },
    {
      name: 'list',
      description: '列出生效中的记忆文件路径',
      action: async (ctx) => {
        const cfg = ctx.host.getConfig(ctx.sessionId);
        if (cfg) return md(AcpCommands.listMemoryFiles(cfg).content);
        // 兜底：列出层级约定的两处路径并标注是否存在。
        const paths = memoryFilePaths(ctx.host.cwd(ctx.sessionId));
        const lines: string[] = ['记忆文件（层级约定落点）：', ''];
        for (const [label, filePath] of [
          ['项目', paths.project],
          ['全局', paths.global],
        ] as const) {
          const exists = await fs
            .access(filePath)
            .then(() => true)
            .catch(() => false);
          lines.push(`- ${label}：\`${filePath}\`${exists ? '' : '（不存在）'}`);
        }
        return md(lines.join('\n'));
      },
    },
  ],
};

// ── /todo ──────────────────────────────────────────────────────────────────

const TODO_STATUS_ICON: Record<string, string> = {
  pending: '⬜',
  in_progress: '🔄',
  completed: '✅',
};

export const todoCommand: ServerSlashCommand = {
  name: 'todo',
  description: '查看当前任务清单（/todo clear 清空）',
  usage: 'todo [clear]',
  action: (_ctx, args) => {
    const arg = args.trim().toLowerCase();
    // 对齐 CLI /todo 的清空语义（含同义词），并补上桌面端更常用的 list 展示。
    if (['clear', 'hide', 'reset', 'close', 'done'].includes(arg)) {
      todoStore.clear();
      return md('已清空任务清单。');
    }
    if (arg && arg !== 'list') {
      return fail('用法：`/todo`（查看）或 `/todo clear`（清空）');
    }
    const todos = todoStore.getTodos();
    if (todos.length === 0) {
      return md('当前没有任务清单（agent 跑多步任务时会在这里列出进度）。');
    }
    const lines = [
      `### 任务清单（${todos.length}）`,
      '',
      ...todos.map(
        (t) => `- ${TODO_STATUS_ICON[t.status] ?? '⬜'} ${t.content}`,
      ),
    ];
    return md(lines.join('\n'));
  },
};

export const knowledgeCommands: ServerSlashCommand[] = [
  kbCommand,
  memoryCommand,
  todoCommand,
];
