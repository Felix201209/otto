import { describe, expect, it } from 'vitest';
import { MCPServerConfig } from '../config/config.js';
import { CodebaseMemoryProvider } from './codebaseMemoryProvider.js';

describe('CodebaseMemoryProvider', () => {
  it('reports missing codebase-memory-mcp configuration', () => {
    const provider = new CodebaseMemoryProvider({ getMcpServers: () => undefined });
    expect(provider.isConfigured()).toBe(false);
    expect(provider.createConfig('/tmp/repo').indexStatus).toBe('failed');
    expect(provider.requireConfigured().ok).toBe(false);
  });

  it('detects configured server and suggests matching names', () => {
    const provider = new CodebaseMemoryProvider({
      getMcpServers: () => ({ 'codebase-memory': new MCPServerConfig('codebase-memory-mcp', []) }),
    });
    expect(provider.isConfigured()).toBe(true);
    expect(provider.getSuggestedMcpServerName()).toBe('codebase-memory');
    expect(provider.createConfig('/tmp/repo').indexStatus).toBe('not_indexed');
  });


  it('invokes discovered MCP tools through the registry', async () => {
    const execute = async (params: Record<string, unknown>) => ({ returnDisplay: params });
    const provider = new CodebaseMemoryProvider({
      getMcpServers: () => ({ 'codebase-memory': new MCPServerConfig('codebase-memory-mcp', []) }),
      getToolRegistry: async () => ({
        getTool: (name: string) => name === 'codebase-memory__get_architecture' ? { execute } : undefined,
      }),
    });
    const config = provider.createConfig('/tmp/repo');
    const result = await provider.getArchitecture(config);
    expect(result.ok).toBe(true);
    expect(result.message).toContain('get_architecture');
  });
});
