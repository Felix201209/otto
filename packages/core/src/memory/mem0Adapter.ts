/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Mem0Adapter — Mem0 结构化记忆适配层。
 *
 * 在 codebase-memory-mcp（代码图谱）之上叠加人的记忆层：
 * - 自动从对话/任务中提取实体和关系
 * - 支持用户级隔离（每个员工独立记忆实例）
 * - 内置遗忘机制（过时信息自动衰减）
 * - 原生支持 MCP 协议
 *
 * 与既有 FileMemoryProvider 互补：
 * - FileMemoryProvider: 扁平文本记忆（向后兼容，OTTO.md / global.md / session.md）
 * - Mem0Adapter: 结构化记忆图谱（实体/关系/偏好/岗位画像）
 *
 * 当 Mem0 不可用时（依赖未安装/网络问题），自动降级到 FileMemoryProvider。
 */

import type { Config } from '../config/config.js';
import { FileMemoryProvider, type MemoryProvider, type MemoryScope } from './memoryProvider.js';
import os from 'os';

/** Mem0 记忆条目 */
export interface Mem0Memory {
  id: string;
  memory: string;
  userId?: string;
  agentId?: string;
  runId?: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

/** Mem0 搜索结果 */
export interface Mem0SearchResult {
  id: string;
  memory: string;
  score: number;
  userId?: string;
  metadata?: Record<string, unknown>;
}

/** Mem0 配置选项 */
export interface Mem0Config {
  /** Mem0 API Key（如使用云端版） */
  apiKey?: string;
  /** 本地 Mem0 实例地址（如使用自托管版） */
  baseUrl?: string;
  /** LLM 提供商配置（用于 Mem0 内部的实体提取） */
  llm?: {
    provider: string;
    model: string;
    apiKey?: string;
    baseUrl?: string;
  };
  /** 嵌入模型配置 */
  embedder?: {
    provider: string;
    model: string;
    apiKey?: string;
  };
  /** 向量存储配置 */
  vectorStore?: {
    provider: string;
    config?: Record<string, unknown>;
  };
}

/**
 * Mem0 适配器 — 实现 MemoryProvider 接口。
 *
 * 写入时：调用 Mem0 的 add() API，自动提取实体/关系/偏好。
 * 读取时：调用 Mem0 的 search()API，按语义相关性检索。
 * 降级时：委托 FileMemoryProvider，保证向后兼容。
 */
export class Mem0Adapter implements MemoryProvider {
  readonly name = 'mem0';

  private mem0Client: any | null = null;
  private fileFallback: FileMemoryProvider;
  private initialized = false;
  private initError: string | null = null;

  constructor(
    private readonly config: Config,
    private readonly mem0Config: Mem0Config,
    fallbackCtx: { projectRoot: string; sessionId?: string },
  ) {
    this.fileFallback = new FileMemoryProvider(fallbackCtx);
  }

  /** 惰性初始化 Mem0 客户端 */
  private async ensureInitialized(): Promise<boolean> {
    if (this.initialized) {
      return this.mem0Client !== null;
    }
    this.initialized = true;

    try {
      // 动态 import，避免 mem0ai 未安装时整个模块崩溃
      const mem0Module = await import(/* @vite-ignore */ 'mem0ai').catch(() => null);
      if (!mem0Module) {
        throw new Error('mem0ai module not installed');
      }
      const Mem0 = (mem0Module as any).default || (mem0Module as any).Mem0 || mem0Module;

      const options: Record<string, unknown> = {};

      if (this.mem0Config.apiKey) {
        options.apiKey = this.mem0Config.apiKey;
      }

      // 配置 LLM（复用 Otto 当前的模型配置）
      if (this.mem0Config.llm) {
        options.llm = {
          provider: this.mem0Config.llm.provider,
          config: {
            model: this.mem0Config.llm.model,
            apiKey: this.mem0Config.llm.apiKey,
            baseURL: this.mem0Config.llm.baseUrl,
          },
        };
      }

      // 配置嵌入模型
      if (this.mem0Config.embedder) {
        options.embedder = {
          provider: this.mem0Config.embedder.provider,
          config: {
            model: this.mem0Config.embedder.model,
            apiKey: this.mem0Config.embedder.apiKey,
          },
        };
      }

      // 配置向量存储（默认本地 SQLite）
      if (this.mem0Config.vectorStore) {
        options.vectorStore = {
          provider: this.mem0Config.vectorStore.provider,
          config: this.mem0Config.vectorStore.config || {},
        };
      }

      this.mem0Client = new Mem0(options);
      console.log('[Mem0Adapter] Initialized successfully');
      return true;
    } catch (error) {
      this.initError = error instanceof Error ? error.message : String(error);
      console.warn(`[Mem0Adapter] Failed to initialize, falling back to file memory: ${this.initError}`);
      this.mem0Client = null;
      return false;
    }
  }

  /** 获取当前用户 ID（用于用户级隔离） */
  private getUserId(): string {
    // 优先用 config 中的用户标识，回退到 OS 用户名
    const feishuUser = (this.config as any).getFeishuUser?.();
    if (feishuUser) {
      return feishuUser;
    }
    try {
      return os.userInfo().username;
    } catch {
      return 'default-user';
    }
  }

  /** 获取 Agent ID（区分不同 Otto 实例） */
  private getAgentId(): string {
    return this.config.getSessionId?.() || 'otto-main';
  }

  async load(scope: MemoryScope): Promise<string> {
    // Mem0 不按 scope 分层，而是按 user/agent 隔离
    // 对于 global/project scope，用语义检索获取最相关的记忆
    // 对于 session scope，降级到文件（会话级短期记忆仍用文件）

    if (scope === 'session') {
      // 会话级短期记忆仍用文件，不走 Mem0
      return this.fileFallback.load(scope);
    }

    const ok = await this.ensureInitialized();
    if (!ok || !this.mem0Client) {
      // 降级到文件
      return this.fileFallback.load(scope);
    }

    try {
      const userId = this.getUserId();
      const agentId = this.getAgentId();

      // 搜索该用户的所有记忆
      const results = await this.mem0Client.search('', {
        userId,
        agentId,
        limit: 50,
      });

      if (!Array.isArray(results) || results.length === 0) {
        return '';
      }

      // 格式化为 prompt 可用的文本
      const memories = results.map((r: Mem0SearchResult) => {
        const tags = r.metadata?.tags
          ? ` [${Array.isArray(r.metadata.tags) ? r.metadata.tags.join(', ') : r.metadata.tags}]`
          : '';
        return `- ${r.memory}${tags}`;
      });

      return memories.join('\n');
    } catch (error) {
      console.warn(`[Mem0Adapter] load failed, falling back: ${error instanceof Error ? error.message : String(error)}`);
      return this.fileFallback.load(scope);
    }
  }

  async save(scope: MemoryScope, fact: string): Promise<void> {
    const trimmed = (fact ?? '').trim();
    if (trimmed.length === 0) {
      return;
    }

    // session 层仍用文件
    if (scope === 'session') {
      await this.fileFallback.save(scope, trimmed);
      return;
    }

    // 同时写 Mem0 和文件（双写保证一致性）
    // 文件写入保证向后兼容，Mem0 写入提供结构化记忆
    await this.fileFallback.save(scope, trimmed);

    const ok = await this.ensureInitialized();
    if (!ok || !this.mem0Client) {
      // Mem0 不可用时，文件已经写了，足够
      return;
    }

    try {
      const userId = this.getUserId();
      const agentId = this.getAgentId();

      // Mem0 的 add() 会自动提取实体/关系/偏好
      await this.mem0Client.add(
        [{ role: 'user', content: trimmed }],
        {
          userId,
          agentId,
          metadata: {
            scope,
            source: 'otto-memory-tool',
            timestamp: new Date().toISOString(),
          },
        },
      );

      console.log(`[Mem0Adapter] Saved memory for user=${userId}: ${trimmed.substring(0, 80)}...`);
    } catch (error) {
      console.warn(`[Mem0Adapter] save failed (file already written): ${error instanceof Error ? error.message : String(error)}`);
      // 不抛错——文件已经写成功，Mem0 失败不影响主流程
    }
  }

  /**
   * 语义搜索记忆（Mem0 独有能力，文件记忆做不到）。
   * 按相关性检索，返回最匹配的记忆条目。
   */
  async search(query: string, limit: number = 10): Promise<Mem0SearchResult[]> {
    const ok = await this.ensureInitialized();
    if (!ok || !this.mem0Client) {
      return [];
    }

    try {
      const userId = this.getUserId();
      const agentId = this.getAgentId();

      const results = await this.mem0Client.search(query, {
        userId,
        agentId,
        limit,
      });

      return Array.isArray(results) ? results : [];
    } catch (error) {
      console.warn(`[Mem0Adapter] search failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  /**
   * 导出用户记忆（用于离职交接/岗位传承）。
   * 返回所有记忆条目，可序列化为 JSON 传递给新员工。
   */
  async exportMemories(): Promise<Mem0Memory[]> {
    const ok = await this.ensureInitialized();
    if (!ok || !this.mem0Client) {
      return [];
    }

    try {
      const userId = this.getUserId();
      const agentId = this.getAgentId();

      // Mem0 的 getAll() 返回所有记忆
      const all = await this.mem0Client.getAll({
        userId,
        agentId,
      });

      return Array.isArray(all) ? all : [];
    } catch (error) {
      console.warn(`[Mem0Adapter] export failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  /**
   * 导入记忆（用于新员工入职时继承岗位知识）。
   * 批量写入记忆条目，自动建立实体关系。
   */
  async importMemories(memories: Mem0Memory[], newUserId: string): Promise<number> {
    const ok = await this.ensureInitialized();
    if (!ok || !this.mem0Client) {
      return 0;
    }

    try {
      const agentId = this.getAgentId();
      let count = 0;

      for (const mem of memories) {
        await this.mem0Client.add(
          [{ role: 'user', content: mem.memory }],
          {
            userId: newUserId,
            agentId,
            metadata: {
              ...mem.metadata,
              imported: true,
              originalUserId: mem.userId,
              importTimestamp: new Date().toISOString(),
            },
          },
        );
        count++;
      }

      console.log(`[Mem0Adapter] Imported ${count} memories for user=${newUserId}`);
      return count;
    } catch (error) {
      console.warn(`[Mem0Adapter] import failed: ${error instanceof Error ? error.message : String(error)}`);
      return 0;
    }
  }

  /** 删除指定记忆（遗忘机制） */
  async deleteMemory(memoryId: string): Promise<boolean> {
    const ok = await this.ensureInitialized();
    if (!ok || !this.mem0Client) {
      return false;
    }

    try {
      await this.mem0Client.delete(memoryId);
      return true;
    } catch (error) {
      console.warn(`[Mem0Adapter] delete failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }
}

/**
 * 从 Otto 的 Config 构建 Mem0 配置。
 * 复用 Otto 已有的模型配置（DeepSeek/GLM/Codex），不引入新的 API Key。
 */
export function buildMem0Config(config: Config): Mem0Config {
  const customModels = config.getCustomModels?.();
  const firstModel = customModels?.[0];

  // 复用 Otto 的第一个自定义模型作为 Mem0 的 LLM
  const llm = firstModel
    ? {
        provider: firstModel.provider === 'anthropic' ? 'anthropic' : 'openai',
        model: firstModel.modelId,
        apiKey: firstModel.apiKey,
        baseUrl: firstModel.baseUrl,
      }
    : undefined;

  return {
    llm,
    // 嵌入模型：优先用 LLM 同厂商的嵌入模型
    embedder: llm
      ? {
          provider: llm.provider,
          model: 'text-embedding-3-small', // 默认嵌入模型，可按需调整
          apiKey: llm.apiKey,
        }
      : undefined,
    // 向量存储：默认本地 SQLite（和 codebase-memory-mcp 同栈）
    vectorStore: {
      provider: 'sqlite',
      config: {
        dbPath: '~/.otto-user/memory/mem0.sqlite',
      },
    },
  };
}

/**
 * 创建 Mem0 适配器，带自动降级。
 * 如果 Mem0 依赖不可用，返回纯 FileMemoryProvider。
 */
export function createMem0Adapter(
  config: Config,
  ctx: { projectRoot: string; sessionId?: string },
): MemoryProvider {
  try {
    const mem0Config = buildMem0Config(config);
    return new Mem0Adapter(config, mem0Config, ctx);
  } catch (error) {
    console.warn(`[Mem0Adapter] Failed to create adapter, using file fallback: ${error instanceof Error ? error.message : String(error)}`);
    return new FileMemoryProvider(ctx);
  }
}
