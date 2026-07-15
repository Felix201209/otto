import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KnowledgeCapture, type KnowledgeCandidate } from './knowledgeCapture.js';
import { LocalKnowledgeStore } from './localKnowledgeStore.js';

describe('KnowledgeCapture ingest result', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-knowledge-capture-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('returns the exact sanitized entries newly written for downstream organization sync', async () => {
    const capture = new KnowledgeCapture(new LocalKnowledgeStore(root));
    const candidate: KnowledgeCandidate = {
      category: 'solution',
      content: '部署结论：使用蓝绿发布。password=super-secret-password',
      tags: ['deploy'],
      sourceSessionId: 'session-1',
      sourceMessageIds: [],
      confidence: 0.9,
      fingerprint: 'ignored-before-sanitize',
    };

    const result = await capture.ingestCandidates([candidate]);

    expect(result.written).toBe(1);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ category: 'solution', tags: ['deploy'] });
    expect(result.entries[0].confidence).toBe(0.9);
    expect(result.entries[0].content).toContain('部署结论：使用蓝绿发布');
    expect(result.entries[0].content).not.toContain('super-secret-password');
  });

  it('captures a one-turn work conclusion when a real tool succeeded', () => {
    const capture = new KnowledgeCapture(new LocalKnowledgeStore(root));
    const messages = [
      { role: 'user' as const, text: '请修复企业部署完成后没有健康检查的问题。' },
      { role: 'tool' as const, text: 'Updated deployment workflow and test passed', toolSuccess: true },
      {
        role: 'assistant' as const,
        text: '问题原因是部署流程缺少健康端点校验，现已修复：部署完成后先请求 /health，失败就停止发布。',
      },
    ];

    expect(capture.shouldCapture(messages)).toBe(true);
    const candidates = capture.extractCandidates(messages, 'session-1');
    expect(candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'solution', confidence: expect.any(Number) }),
    ]));
    expect(candidates.find((candidate) => candidate.category === 'solution')?.confidence)
      .toBeGreaterThanOrEqual(0.8);
  });
});
