import { describe, expect, it } from 'vitest';

import { buildRecallFromLayeredMemory, type MemoryRecallQuery } from './memoryRecall.js';

const layeredMemory = [
  '--- Global Memory ---',
  '- user prefers short answers',
  '- prefers markdown bullets',
  '',
  '--- Project Memory ---',
  '- project name: otto',
  '- memory recall should be concise',
  '- plugin interfaces should be keyed by plugin name',
  '',
  '--- Session Memory ---',
  '- current issue: memory recall token budget',
  '- focus on project memory summarization',
].join('\n');

describe('buildRecallFromLayeredMemory', () => {
  it('selects the most relevant lines for the provided query terms', () => {
    const query: MemoryRecallQuery = {
      terms: ['otto', 'token', 'budget', 'recall', 'plugin'],
      projectRoot: '/Users/king/Desktop/otto',
      sessionId: 'session-123',
      scope: 'project',
      maxSections: 3,
      maxItemsPerSection: 3,
      maxChars: 800,
    };

    const result = buildRecallFromLayeredMemory(layeredMemory, query);

    expect(result).toContain('--- Project Memory ---');
    expect(result).toContain('project name: otto');
    expect(result).toContain('plugin interfaces should be keyed by plugin name');
    expect(result).toContain('--- Session Memory ---');
    expect(result).not.toContain('user prefers short answers');
  });

  it('returns an empty string when there are no query terms', () => {
    const result = buildRecallFromLayeredMemory(layeredMemory, {});
    expect(result).toBe('');
  });
});
