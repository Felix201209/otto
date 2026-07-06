import * as path from 'path';
import type { MCPServerConfig } from '../config/config.js';
import type { CodebaseMemoryConfig, CodebaseMemoryToolResult } from './codebaseMemoryTypes.js';
import { DEFAULT_CODEBASE_MEMORY_SERVER } from './codebaseMemoryTypes.js';

export interface CodebaseMemoryConfigHost {
  getMcpServers(): Record<string, MCPServerConfig> | undefined;
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
      message: 'codebase-memory-mcp is not configured. Add an MCP server named  + serverName +  before indexing or querying codebase graph memory.',
    };
  }

  getSuggestedMcpServerName(): string {
    const servers = this.host.getMcpServers() || {};
    if (servers[DEFAULT_CODEBASE_MEMORY_SERVER]) return DEFAULT_CODEBASE_MEMORY_SERVER;
    const match = Object.keys(servers).find((name) => name.includes('codebase') || name.includes('memory'));
    return match || DEFAULT_CODEBASE_MEMORY_SERVER;
  }
}
