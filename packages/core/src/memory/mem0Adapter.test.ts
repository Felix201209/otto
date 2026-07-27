import { describe, expect, it, vi } from 'vitest';

import { Mem0Adapter } from './mem0Adapter.js';

function createAdapter(fileMemory: string, results: unknown[]) {
  const adapter = new Mem0Adapter(
    { getSessionId: () => 'test-session' } as never,
    {},
    { projectRoot: 'C:/test-project' },
  );
  const internals = adapter as unknown as {
    initialized: boolean;
    mem0Client: { search: ReturnType<typeof vi.fn> };
    fileFallback: { load: ReturnType<typeof vi.fn> };
  };
  internals.initialized = true;
  internals.mem0Client = { search: vi.fn().mockResolvedValue(results) };
  internals.fileFallback = { load: vi.fn().mockResolvedValue(fileMemory) };
  return { adapter, internals };
}

describe('Mem0Adapter portable recovery', () => {
  it('keeps restored file memory when the local Mem0 database is empty', async () => {
    const { adapter } = createAdapter('## Otto Added Memories\n- Prefers concise replies', []);

    await expect(adapter.load('global')).resolves.toContain('Prefers concise replies');
  });

  it('merges unique Mem0 facts without duplicating restored file facts', async () => {
    const { adapter } = createAdapter('## Otto Added Memories\n- Prefers concise replies', [
      {
        id: 'duplicate',
        memory: 'Prefers concise replies',
        score: 1,
        metadata: { tags: ['preference'] },
      },
      {
        id: 'unique',
        memory: 'Works in product operations',
        score: 0.9,
      },
    ]);

    const memory = await adapter.load('global');

    expect(memory).toContain('Prefers concise replies');
    expect(memory).toContain('Works in product operations');
    expect(memory.match(/Prefers concise replies/g)).toHaveLength(1);
  });
});
