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
    expect(result.observations).toEqual([
      expect.objectContaining({
        category: 'solution',
        sourceSessionId: 'session-1',
        confidence: 0.9,
      }),
    ]);
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

  it('extracts a concise knowledge atom instead of retaining the whole answer transcript', () => {
    const capture = new KnowledgeCapture(new LocalKnowledgeStore(root));
    const repeatedExplanation = '这是背景说明，不属于以后需要反复引用的结论。'.repeat(20);
    const messages = [
      { role: 'user' as const, text: '请排查企业之间缓存串数据的问题。' },
      { role: 'tool' as const, text: 'tenant isolation tests passed', toolSuccess: true },
      {
        role: 'assistant' as const,
        text: `${repeatedExplanation}\n根因是缓存键没有企业编号。\n修复方案是把 organizationId 加入缓存键。\n验证通过：跨企业缓存隔离测试已经通过。`,
      },
    ];

    const candidate = capture.extractCandidates(messages, 'session-atom')[0];
    expect(candidate.content).toContain('根因是缓存键没有企业编号');
    expect(candidate.content).toContain('organizationId 加入缓存键');
    expect(candidate.content).toContain('跨企业缓存隔离测试已经通过');
    expect(candidate.content.length).toBeLessThan(400);
    expect(candidate.verified).toBe(true);
    expect(candidate.impactScore).toBeGreaterThanOrEqual(0.6);
  });

  it('captures a short but verified high-impact conclusion without requiring a tool call', () => {
    const capture = new KnowledgeCapture(new LocalKnowledgeStore(root));
    const messages = [
      { role: 'user' as const, text: '生产环境发生重大数据隔离事故，结论是什么？' },
      {
        role: 'assistant' as const,
        text: '重大事故的根因是缓存键缺少企业编号，加入 organizationId 后隔离测试验证通过。',
      },
    ];

    expect(capture.shouldCapture(messages)).toBe(true);
    expect(capture.extractCandidates(messages, 'short-critical'))
      .toEqual(expect.arrayContaining([expect.objectContaining({ category: 'solution' })]));
  });

  it('emits duplicate observations for long-term evidence without duplicating the personal store', async () => {
    const capture = new KnowledgeCapture(new LocalKnowledgeStore(root));
    const candidate: KnowledgeCandidate = {
      category: 'solution',
      content: '根因是缓存键缺少企业编号，加入 organizationId 后隔离测试通过。',
      tags: ['cache'],
      sourceSessionId: 'session-a',
      sourceMessageIds: [],
      confidence: 0.9,
      fingerprint: 'ignored',
      verified: true,
      impactScore: 0.85,
    };

    const first = await capture.ingestCandidates([candidate]);
    const second = await capture.ingestCandidates([{ ...candidate, sourceSessionId: 'session-b' }]);

    expect(first.written).toBe(1);
    expect(second.written).toBe(0);
    expect(second.skippedDuplicate).toBe(1);
    expect(second.observations).toEqual([
      expect.objectContaining({ sourceSessionId: 'session-b', verified: true }),
    ]);
  });
});
