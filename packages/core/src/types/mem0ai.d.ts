/**
 * mem0ai 类型声明（当 mem0ai 未安装时使用）。
 * 安装 mem0ai 后此文件可删除。
 */

declare module 'mem0ai' {
  export interface Mem0Memory {
    id: string;
    memory: string;
    userId?: string;
    agentId?: string;
    metadata?: Record<string, unknown>;
    createdAt?: string;
    updatedAt?: string;
  }

  export interface Mem0SearchResult {
    id: string;
    memory: string;
    score: number;
    userId?: string;
    metadata?: Record<string, unknown>;
  }

  export interface Mem0AddOptions {
    userId?: string;
    agentId?: string;
    runId?: string;
    metadata?: Record<string, unknown>;
  }

  export interface Mem0SearchOptions {
    userId?: string;
    agentId?: string;
    limit?: number;
  }

  export interface Mem0Config {
    apiKey?: string;
    llm?: {
      provider: string;
      config: {
        model: string;
        apiKey?: string;
        baseURL?: string;
      };
    };
    embedder?: {
      provider: string;
      config: {
        model: string;
        apiKey?: string;
      };
    };
    vectorStore?: {
      provider: string;
      config?: Record<string, unknown>;
    };
  }

  export default class Mem0 {
    constructor(config?: Mem0Config);
    add(messages: Array<{ role: string; content: string }>, options?: Mem0AddOptions): Promise<void>;
    search(query: string, options?: Mem0SearchOptions): Promise<Mem0SearchResult[]>;
    getAll(options?: Mem0SearchOptions): Promise<Mem0Memory[]>;
    delete(memoryId: string): Promise<void>;
  }
}
