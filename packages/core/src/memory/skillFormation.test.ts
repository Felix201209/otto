import { describe, expect, it } from 'vitest';
import { createProjectArchiveSummary, createSkillCandidate, shouldCreateSkillCandidate } from './skillFormation.js';
import type { OrgMemoryRecord, ProjectRecord, UsageRecord } from './orgMemoryTypes.js';

const project: ProjectRecord = {
  id: 'project-1',
  companyId: 'company-1',
  teamId: 'team-1',
  name: 'Campaign Review',
  type: 'marketing',
  status: 'completed',
  goal: 'Generate repeatable campaign review reports',
  ownerUserId: 'user-1',
  memberUserIds: ['user-1'],
  linkedSessionIds: ['session-1'],
  assetRefs: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
};

function usage(id: string, accepted = true, revisions = 1): UsageRecord {
  return {
    id,
    companyId: 'company-1',
    teamId: 'team-1',
    projectId: 'project-1',
    userId: 'user-1',
    taskType: 'campaign_review',
    model: 'test-model',
    inputTokens: 100,
    outputTokens: 200,
    totalTokens: 300,
    estimatedCost: 0.01,
    outputAccepted: accepted,
    revisionCount: revisions,
    estimatedTimeSavedMinutes: 20,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

const memories: OrgMemoryRecord[] = [
  {
    id: 'memory-1',
    scope: 'project',
    companyId: 'company-1',
    teamId: 'team-1',
    projectId: 'project-1',
    type: 'decision',
    title: 'Use executive summary',
    content: 'Every review starts with an executive summary.',
    tags: ['review'],
    visibility: 'project_members',
    source: 'manual',
    confidence: 1,
    createdBy: 'user-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'memory-2',
    scope: 'project',
    companyId: 'company-1',
    teamId: 'team-1',
    projectId: 'project-1',
    type: 'workflow',
    title: 'Review flow',
    content: 'Collect metrics, compare goal, summarize lessons.',
    tags: ['workflow'],
    visibility: 'team_visible',
    source: 'manual',
    confidence: 1,
    createdBy: 'user-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

describe('skillFormation', () => {
  it('requires repeated accepted low-revision usage before forming a skill', () => {
    expect(shouldCreateSkillCandidate([usage('1'), usage('2')])).toBe(false);
    expect(shouldCreateSkillCandidate([usage('1'), usage('2'), usage('3'), usage('4'), usage('5', false)])).toBe(true);
    expect(shouldCreateSkillCandidate([usage('1', true, 4), usage('2', true, 4), usage('3', true, 4), usage('4', true, 4), usage('5', true, 4)])).toBe(false);
  });

  it('creates project archive summaries from decisions and reusable knowledge', () => {
    const summary = createProjectArchiveSummary(project, memories);
    expect(summary).toContain('Campaign Review');
    expect(summary).toContain('Use executive summary');
    expect(summary).toContain('Collect metrics');
  });

  it('creates a candidate team skill from project usage and memories', () => {
    const candidate = createSkillCandidate({
      project,
      memories,
      usage: [usage('1'), usage('2'), usage('3'), usage('4'), usage('5')],
      now: '2026-01-03T00:00:00.000Z',
      createdBy: 'user-1',
    });
    expect(candidate?.status).toBe('candidate');
    expect(candidate?.scope).toBe('team');
    expect(candidate?.workflowSteps).toContain('Collect metrics, compare goal, summarize lessons.');
    expect(candidate?.usageCount).toBe(5);
  });
});
