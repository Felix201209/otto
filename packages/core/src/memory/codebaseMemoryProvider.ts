import * as path from 'path';
import type { MCPServerConfig } from '../config/config.js';
import type { CodebaseMemoryConfig, CodebaseMemoryToolResult } from './codebaseMemoryTypes.js';
import { DEFAULT_CODEBASE_MEMORY_SERVER } from './codebaseMemoryTypes.js';

export interface CodebaseMemoryConfigHost {
  getMcpServers(): Record<string, MCPServerConfig> | undefined;
  getToolRegistry?(): Promise<{ getTool(name: string): { execute(params: Record<string, unknown>, signal: AbortSignal): Promise<unknown> } | undefined }>;
}

export class CodebaseMemoryProvider {
  constructor(private readonly host: CodebaseMemoryConfigHost) {}

  isConfigured(serverName = DEFAULT_CODEBASE_MEMORY_SERVER): boolean {
    return Boolean(this.host.getMcpServers()?.[serverName]);
  }

  createConfig(repoPath: string, serverName = DEFAULT_CODEBASE_MEMORY_SERVER): CodebaseMemoryConfig {
    return {
      repoPath: path.resolve(repoPath),
      mcpServerName: serverName,
      indexStatus: this.isConfigured(serverName) ? 'not_indexed' : 'failed',
      error: this.isConfigured(serverName) ? undefined : 'codebase-memory-mcp server is not configured',
    };
  }

  requireConfigured(serverName = DEFAULT_CODEBASE_MEMORY_SERVER): CodebaseMemoryToolResult {
    if (this.isConfigured(serverName)) {
      return { ok: true, message: 'codebase-memory-mcp configured: ' + serverName };
    }
    return {
      ok: false,
      message: 'codebase-memory-mcp is not configured. Add an MCP server named ' + serverName + ' before indexing or querying codebase graph memory.',
    };
  }


  async invokeTool(serverName: string, toolName: string, params: Record<string, unknown>): Promise<CodebaseMemoryToolResult> {
    const configured = this.requireConfigured(serverName);
    if (!configured.ok) return configured;
    if (!this.host.getToolRegistry) {
      return { ok: false, message: 'Tool registry is not available for codebase-memory-mcp invocation.' };
    }
    const registry = await this.host.getToolRegistry();
    const tool = registry.getTool(serverName + '__' + toolName) || registry.getTool(toolName);
    if (!tool) {
      return { ok: false, message: 'MCP tool not discovered: ' + serverName + '__' + toolName };
    }
    const result = await tool.execute(params, new AbortController().signal);
    return { ok: true, message: 'MCP tool executed: ' + toolName, data: result };
  }

  indexRepository(config: CodebaseMemoryConfig): Promise<CodebaseMemoryToolResult> {
    return this.invokeTool(config.mcpServerName, 'index_repository', { repo_path: config.repoPath });
  }

  getArchitecture(config: CodebaseMemoryConfig): Promise<CodebaseMemoryToolResult> {
    return this.invokeTool(config.mcpServerName, 'get_architecture', { repo_path: config.repoPath });
  }

  searchGraph(config: CodebaseMemoryConfig, query: string): Promise<CodebaseMemoryToolResult> {
    return this.invokeTool(config.mcpServerName, 'search_graph', { repo_path: config.repoPath, name_pattern: query });
  }

  getSuggestedMcpServerName(): string {
    const servers = this.host.getMcpServers() || {};
    if (servers[DEFAULT_CODEBASE_MEMORY_SERVER]) return DEFAULT_CODEBASE_MEMORY_SERVER;
    const match = Object.keys(servers).find((name) => name.includes('codebase') || name.includes('memory'));
    return match || DEFAULT_CODEBASE_MEMORY_SERVER;
  }
}
