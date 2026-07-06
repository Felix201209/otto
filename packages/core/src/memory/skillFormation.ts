import type { OrgMemoryRecord, ProjectRecord, SkillRecord, UsageRecord } from './orgMemoryTypes.js';

export interface SkillCandidateInput {
  project: ProjectRecord;
  memories: OrgMemoryRecord[];
  usage: UsageRecord[];
  now?: string;
  createdBy: string;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function acceptedRate(usage: UsageRecord[]): number {
  if (usage.length === 0) return 0;
  const accepted = usage.filter((record) => record.outputAccepted === true).length;
  return accepted / usage.length;
}

export function shouldCreateSkillCandidate(usage: UsageRecord[]): boolean {
  if (usage.length < 5) return false;
  if (acceptedRate(usage) < 0.7) return false;
  if (2 < average(usage.map((record) => record.revisionCount))) return false;
  return true;
}

export function createProjectArchiveSummary(project: ProjectRecord, memories: OrgMemoryRecord[]): string {
  const decisions = memories.filter((memory) => memory.type === 'decision').map((memory) => '- ' + memory.title + ': ' + memory.content);
  const lessons = memories.filter((memory) => memory.type === 'lesson' || memory.type === 'workflow').map((memory) => '- ' + memory.title + ': ' + memory.content);
  return [
    '# Project Archive: ' + project.name,
    '',
    '## Goal',
    project.goal,
    '',
    '## Key Decisions',
    decisions.length ? decisions.join('\n') : '- None recorded',
    '',
    '## Reusable Knowledge',
    lessons.length ? lessons.join('\n') : '- None recorded',
  ].join('\n');
}

export function createSkillCandidate(input: SkillCandidateInput): SkillRecord | null {
  if (!shouldCreateSkillCandidate(input.usage)) return null;
  const now = input.now || new Date().toISOString();
  const workflowMemories = input.memories.filter((memory) => memory.type === 'workflow' || memory.type === 'lesson');
  return {
    id: 'skill_' + input.project.id,
    companyId: input.project.companyId,
    teamId: input.project.teamId,
    name: input.project.name + ' Skill',
    description: 'Candidate skill generated from project: ' + input.project.name,
    scope: 'team',
    status: 'candidate',
    triggerPatterns: [input.project.name, input.project.type, input.project.goal].filter(Boolean),
    requiredInputs: ['goal', 'context', 'expected output'],
    workflowSteps: workflowMemories.length ? workflowMemories.map((memory) => memory.content) : ['Review project goal', 'Collect context', 'Produce output', 'Validate result'],
    outputSchema: 'Markdown summary with decisions, workflow, risks, and next actions',
    examples: [],
    sourceProjectIds: [input.project.id],
    sourceTaskIds: input.usage.map((record) => record.id),
    usageCount: input.usage.length,
    successRate: acceptedRate(input.usage),
    avgTokenCost: average(input.usage.map((record) => record.totalTokens)),
    avgRevisionCount: average(input.usage.map((record) => record.revisionCount)),
    avgTimeSavedMinutes: average(input.usage.map((record) => record.estimatedTimeSavedMinutes || 0)),
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  };
}
