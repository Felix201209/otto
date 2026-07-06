import { describe, expect, it } from 'vitest';
import { canAssignLicense, canReadMemory, hasPermission } from './permissionChecker.js';
import type { AccessContext } from './permissionChecker.js';
import type { LicenseRecord, OrgMemoryRecord } from './orgMemoryTypes.js';

const license: LicenseRecord = {
  id: 'license-1',
  companyId: 'company-1',
  issuerUserId: 'manager-1',
  assigneeUserId: 'user-1',
  scope: 'team',
  teamId: 'team-1',
  role: 'employee',
  permissions: ['memory:team:read', 'skill:team:read'],
  tokenQuota: { monthlyLimit: 1000, usedThisMonth: 0, hardLimit: true },
  allowedModels: ['test-model'],
  allowedSkillIds: [],
  allowedKnowledgeScopes: ['team', 'project'],
  features: ['desktop'],
  startsAt: '2026-01-01T00:00:00.000Z',
};

function ctx(overrides: Partial<AccessContext> = {}): AccessContext {
  return {
    userId: 'user-1',
    companyId: 'company-1',
    teamIds: ['team-1'],
    managedTeamIds: [],
    projectIds: ['project-1'],
    licenses: [license],
    ...overrides,
  };
}

function memory(scope: OrgMemoryRecord['scope'], extra: Partial<OrgMemoryRecord> = {}): OrgMemoryRecord {
  return {
    id: 'memory-1',
    scope,
    companyId: 'company-1',
    type: 'fact',
    title: 'Fact',
    content: 'Content',
    tags: [],
    visibility: 'team_visible',
    source: 'manual',
    confidence: 1,
    createdBy: 'user-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

describe('permissionChecker', () => {
  it('checks active license permissions', () => {
    expect(hasPermission(ctx(), 'memory:team:read')).toBe(true);
    expect(hasPermission(ctx(), 'memory:company:read')).toBe(false);
  });

  it('allows project members to read project memory', () => {
    expect(canReadMemory(ctx(), memory('project', { projectId: 'project-1' }))).toBe(true);
    expect(canReadMemory(ctx(), memory('project', { projectId: 'project-2' }))).toBe(false);
  });

  it('allows managers to assign licenses only inside managed teams', () => {
    const manager = ctx({ managedTeamIds: ['team-1'], licenses: [{ ...license, permissions: ['license:assign'], assigneeUserId: 'user-1' }] });
    expect(canAssignLicense(manager, 'team-1')).toBe(true);
    expect(canAssignLicense(manager, 'team-2')).toBe(false);
  });

  it('allows owner to read company memory', () => {
    expect(canReadMemory(ctx({ isOwner: true }), memory('company'))).toBe(true);
  });
});
