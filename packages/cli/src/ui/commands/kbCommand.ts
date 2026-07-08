/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * /kb 命令：个人本地知识库（~/.otto-user/knowledge）的 CLI 入口。
 * 与 knowledge_base 工具共用同一个 LocalKnowledgeStore（经工具 execute 包装），
 * 完全本地，不依赖 server / 企业鉴权。用法：
 *   /kb add [--category dev] [--tags a,b] <内容>
 *   /kb search [--category dev] <关键词>
 *   /kb list [条数]
 *   /kb remove <id>
 */

import { KnowledgeBaseTool } from 'otto-core';
import { MessageType } from '../types.js';
import { CommandKind, SlashCommand } from './types.js';

/** 解析 `--key value` 风格参数，其余拼成 result._（与 memoryCommand 的做法一致） */
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

/** 统一执行 knowledge_base 工具并把结果打到 UI */
async function runKbAction(
  context: Parameters<NonNullable<SlashCommand['action']>>[0],
  params: {
    action: 'add' | 'search' | 'list' | 'remove';
    query?: string;
    content?: string;
    category?: string;
    tags?: string[];
    id?: string;
    limit?: number;
  },
): Promise<void> {
  const tool = new KnowledgeBaseTool();
  const result = await tool.execute(params, new AbortController().signal);
  const text =
    typeof result.llmContent === 'string'
      ? result.llmContent
      : JSON.stringify(result.llmContent);
  context.ui.addItem(
    {
      type: text.startsWith('Error') ? MessageType.ERROR : MessageType.INFO,
      text,
    },
    Date.now(),
  );
}

export const kbCommand: SlashCommand = {
  name: 'kb',
  description: 'Personal local knowledge base (add/search/list/remove)',
  kind: CommandKind.BUILT_IN,
  subCommands: [
    {
      name: 'add',
      description: 'Save knowledge: /kb add [--category dev] [--tags a,b] <content>',
      kind: CommandKind.BUILT_IN,
      action: async (context, args) => {
        const parsed = parseKbArgs(args || '');
        if (!parsed._) {
          context.ui.addItem(
            {
              type: MessageType.ERROR,
              text: '用法: /kb add [--category 分类] [--tags a,b] <要保存的内容>',
            },
            Date.now(),
          );
          return;
        }
        await runKbAction(context, {
          action: 'add',
          content: parsed._,
          category: parsed.category,
          tags: parsed.tags
            ? parsed.tags.split(',').map((tag) => tag.trim()).filter(Boolean)
            : undefined,
        });
      },
    },
    {
      name: 'search',
      description: 'Search knowledge: /kb search [--category dev] <keywords>',
      kind: CommandKind.BUILT_IN,
      action: async (context, args) => {
        const parsed = parseKbArgs(args || '');
        if (!parsed._) {
          context.ui.addItem(
            {
              type: MessageType.ERROR,
              text: '用法: /kb search [--category 分类] <关键词>',
            },
            Date.now(),
          );
          return;
        }
        await runKbAction(context, {
          action: 'search',
          query: parsed._,
          category: parsed.category,
        });
      },
    },
    {
      name: 'list',
      description: 'List recent knowledge entries: /kb list [limit]',
      kind: CommandKind.BUILT_IN,
      action: async (context, args) => {
        const parsed = parseKbArgs(args || '');
        const limit = Number.parseInt(parsed._, 10);
        await runKbAction(context, {
          action: 'list',
          limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
        });
      },
    },
    {
      name: 'remove',
      description: 'Remove an entry by id: /kb remove <id>',
      kind: CommandKind.BUILT_IN,
      action: async (context, args) => {
        const parsed = parseKbArgs(args || '');
        if (!parsed._) {
          context.ui.addItem(
            {
              type: MessageType.ERROR,
              text: '用法: /kb remove <条目id>（id 可用 /kb list 查看）',
            },
            Date.now(),
          );
          return;
        }
        await runKbAction(context, { action: 'remove', id: parsed._ });
      },
    },
  ],
};
