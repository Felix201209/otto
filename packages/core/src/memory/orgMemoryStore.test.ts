import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OrgMemoryStore } from './orgMemoryStore.js';
import type { OrgMemoryRecord, ProjectRecord } from './orgMemoryTypes.js';

describe('OrgMemoryStore', () => {
  let dir: string;
  let store: OrgMemoryStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-org-memory-'));
    store = new OrgMemoryStore(dir);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('loads an empty store when no file exists', async () => {
    const data = await store.load();
    expect(data.projects).toEqual([]);
    expect(data.memories).toEqual([]);
  });

  it('persists project memory records locally', async () => {
    const project: ProjectRecord = {
      id: 'project-1',
      companyId: 'company-1',
      teamId: 'team-1',
      name: 'Memory MVP',
      type: 'code',
      status: 'active',
      goal: 'Build MVP',
      ownerUserId: 'user-1',
      memberUserIds: ['user-1'],
      linkedSessionIds: [],
      assetRefs: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const memory: OrgMemoryRecord = {
      id: 'memory-1',
      scope: 'project',
      companyId: 'company-1',
      teamId: 'team-1',
      projectId: 'project-1',
      type: 'decision',
      title: 'Project is central',
      content: 'All staged goals can be projects.',
      tags: ['mvp'],
      visibility: 'project_members',
      source: 'manual',
      confidence: 1,
      createdBy: 'user-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    await store.upsertProject(project);
    await store.addMemory(memory);

    const reloaded = new OrgMemoryStore(dir);
    expect((await reloaded.load()).projects).toHaveLength(1);
    expect(await reloaded.listProjectMemories('project-1')).toEqual([memory]);
  });
});
