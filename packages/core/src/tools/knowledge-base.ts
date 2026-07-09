/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * knowledge_base 工具：个人本地知识库（增/查/列/删）。
 *
 * 与企业 KB（server 包，需企业鉴权）完全无关：存储落在
 * ~/.otto-user/knowledge/entries.jsonl，纯本地文件，离线可用。
 * 与 save_memory（OTTO.md 追加式记忆）也互补：这里是结构化条目
 * （分类 + 标签 + 关键词检索），适合沉淀可反复检索的知识片段。
 */

import { BaseTool, Icon, ToolResult, ToolCallConfirmationDetails } from './tools.js';
import { Type } from '@google/genai';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { Config } from '../config/config.js';
import {
  LocalKnowledgeStore,
  KnowledgeEntry,
  getKnowledgeDir,
} from '../knowledge/localKnowledgeStore.js';

export interface KnowledgeBaseToolParams {
  action: 'add' | 'search' | 'list' | 'remove';
  /** search：检索关键词 */
  query?: string;
  /** add：知识内容 */
  content?: string;
  /** add：分类（默认 general）；search：可选分类过滤 */
  category?: string;
  /** add：标签 */
  tags?: string[];
  /** remove：条目 id */
  id?: string;
  /** list：条数上限（默认 20） */
  limit?: number;
}

/** 单条内容在输出里的截断长度，防止长条目撑爆上下文 */
const ENTRY_DISPLAY_MAX_CHARS = 500;

function formatEntry(entry: KnowledgeEntry, index: number): string {
  const content =
    entry.content.length > ENTRY_DISPLAY_MAX_CHARS
      ? entry.content.slice(0, ENTRY_DISPLAY_MAX_CHARS) + '…'
      : entry.content;
  const tags = entry.tags.length > 0 ? ` tags: ${entry.tags.join(', ')}` : '';
  const date = entry.createdAt ? entry.createdAt.slice(0, 10) : 'unknown';
  return `${index + 1}. [${entry.category}] ${content}\n   (id: ${entry.id}, ${date}${tags})`;
}

export class KnowledgeBaseTool extends BaseTool<
  KnowledgeBaseToolParams,
  ToolResult
> {
  static readonly Name: string = 'knowledge_base';

  // registerCoreTool 统一以 (config) 形参实例化；本工具纯本地，不需要 config
  constructor(_config?: Config) {
    super(
      KnowledgeBaseTool.Name,
      'KnowledgeBase',
      `Personal local knowledge base (stored under ~/.otto-user/knowledge, fully offline, no account or enterprise license required).

ACTIONS:
  add:    Save a piece of knowledge. {action:"add", content:"...", category:"dev", tags:["react"]}
  search: Keyword search, returns top matches ranked by relevance then recency.
          {action:"search", query:"react hooks", category:"dev"} (category optional)
  list:   Show most recent entries. {action:"list", limit:20}
  remove: Delete an entry by id. {action:"remove", id:"kb_..."}

Use this to persist reusable knowledge across sessions: project conventions, troubleshooting notes, user preferences, research findings.`,
      Icon.LightBulb,
      {
        type: Type.OBJECT,
        properties: {
          action: {
            type: Type.STRING,
            description: 'Knowledge base operation',
            enum: ['add', 'search', 'list', 'remove'],
          },
          query: {
            type: Type.STRING,
            description: 'Search keywords (for search)',
          },
          content: {
            type: Type.STRING,
            description: 'Knowledge content to save (for add)',
          },
          category: {
            type: Type.STRING,
            description:
              'Category, e.g. dev / research / preference. Default: general. For search, acts as an optional filter.',
          },
          tags: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: 'Optional tags (for add)',
          },
          id: {
            type: Type.STRING,
            description: 'Entry id (for remove)',
          },
          limit: {
            type: Type.NUMBER,
            description: 'Max entries to return (for list). Default: 20',
          },
        },
        required: ['action'],
      },
    );
  }

  validateToolParams(params: KnowledgeBaseToolParams): string | null {
    const errors = SchemaValidator.validate(
      this.schema.parameters!,
      params,
      KnowledgeBaseTool.Name,
    );
    if (errors) return errors;
    if (params.action === 'add' && !(params.content ?? '').trim()) {
      return 'knowledge_base/add: content required';
    }
    if (params.action === 'search' && !(params.query ?? '').trim()) {
      return 'knowledge_base/search: query required';
    }
    if (params.action === 'remove' && !(params.id ?? '').trim()) {
      return 'knowledge_base/remove: id required';
    }
    return null;
  }

  getDescription(params: KnowledgeBaseToolParams): string {
    switch (params.action) {
      case 'add':
        return `kb add [${params.category || 'general'}]`;
      case 'search':
        return `kb search "${params.query ?? ''}"`;
      case 'remove':
        return `kb remove ${params.id ?? ''}`;
      default:
        return 'kb list';
    }
  }

  // 纯本地读写自己的知识文件，安全，无需确认弹窗
  async shouldConfirmExecute(
    _params: KnowledgeBaseToolParams,
    _signal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails | false> {
    return false;
  }

  async execute(
    params: KnowledgeBaseToolParams,
    _signal: AbortSignal,
  ): Promise<ToolResult> {
    const validationError = this.validateToolParams(params);
    if (validationError) {
      return { llmContent: `Error: ${validationError}`, returnDisplay: validationError };
    }

    // 每次执行现建 store：让 OTTO_USER_DIR 的变化（测试/沙箱）即时生效
    const store = new LocalKnowledgeStore();

    try {
      switch (params.action) {
        case 'add': {
          const entry = await store.add(
            params.category ?? 'general',
            params.content!,
            params.tags ?? [],
          );
          const message = `Saved knowledge entry ${entry.id} [${entry.category}]${entry.tags.length > 0 ? ` tags: ${entry.tags.join(', ')}` : ''}`;
          return { llmContent: message, returnDisplay: message };
        }
        case 'search': {
          const results = await store.search(params.query!, params.category);
          if (results.length === 0) {
            const message = `No knowledge entries matched "${params.query}"${params.category ? ` in category "${params.category}"` : ''}.`;
            return { llmContent: message, returnDisplay: message };
          }
          const body = results
            .map((entry, index) => formatEntry(entry, index))
            .join('\n');
          const message = `Found ${results.length} knowledge entr${results.length === 1 ? 'y' : 'ies'} for "${params.query}":\n${body}`;
          return {
            llmContent: message,
            returnDisplay: `Found ${results.length} knowledge entries`,
          };
        }
        case 'list': {
          const entries = await store.list(params.limit ?? 20);
          if (entries.length === 0) {
            const message = `Knowledge base is empty (${getKnowledgeDir()}).`;
            return { llmContent: message, returnDisplay: message };
          }
          const body = entries
            .map((entry, index) => formatEntry(entry, index))
            .join('\n');
          const message = `Knowledge base (${entries.length} most recent):\n${body}`;
          return {
            llmContent: message,
            returnDisplay: `Listed ${entries.length} knowledge entries`,
          };
        }
        case 'remove': {
          const removed = await store.remove(params.id!);
          const message = removed
            ? `Removed knowledge entry ${params.id}.`
            : `Knowledge entry ${params.id} not found. Nothing removed.`;
          return { llmContent: message, returnDisplay: message };
        }
        default: {
          const message = `Error: unknown knowledge_base action "${params.action}"`;
          return { llmContent: message, returnDisplay: message };
        }
      }
    } catch (error) {
      const message = `knowledge_base ${params.action} failed: ${error instanceof Error ? error.message : String(error)}`;
      console.error(`[KnowledgeBaseTool] ${message}`);
      return { llmContent: `Error: ${message}`, returnDisplay: message };
    }
  }
}
