export interface CodebaseMemoryConfig {
  repoPath: string;
  mcpServerName: string;
  indexedProjectId?: string;
  graphArtifactPath?: string;
  lastIndexedAt?: string;
  indexStatus: 'not_indexed' | 'indexing' | 'ready' | 'failed';
  error?: string;
}

export interface CodebaseMemoryToolResult {
  ok: boolean;
  message: string;
  data?: unknown;
}

export const DEFAULT_CODEBASE_MEMORY_SERVER = 'codebase-memory';
