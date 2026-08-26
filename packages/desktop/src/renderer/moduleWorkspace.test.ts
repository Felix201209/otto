import { describe, expect, it } from 'vitest';

import {
  addOrMoveModules,
  createDefaultModuleWorkspace,
  deleteModuleGroup,
  getModuleWorkspaceStorageKey,
  normalizeModuleWorkspace,
  parseModuleWorkspace,
  removeModuleFromGroup,
  renameModuleGroup,
  reorderModuleGroups,
  reorderModulesInGroup,
  restoreDefaultModuleWorkspace,
  updateModuleGroupRows,
  type ModuleWorkspaceCapabilities,
  type ModuleWorkspaceLayout,
} from './moduleWorkspace.js';

const enterpriseCapabilities: ModuleWorkspaceCapabilities = {
  edition: 'enterprise',
  availableModuleIds: [
    'park-announcement',
    'park-satisfaction',
    'park-renovation',
    'park-parking',
    'park-network-phone',
    'park-meeting-room',
    'agent-enterprise-work',
    'agent-ppt',
    'agent-meeting',
    'agent-word',
    'agent-excel',
    'enterprise-memory',
  ],
};

const personalCapabilities: ModuleWorkspaceCapabilities = {
  edition: 'personal',
  availableModuleIds: ['agent-personal-otto', 'auto-skill'],
};

const sampleLayout = (): ModuleWorkspaceLayout => ({
  version: 1,
  groups: [
    {
      id: 'park-services',
      name: '园区服务',
      rows: 2,
      moduleIds: ['park-announcement', 'park-satisfaction'],
    },
    {
      id: 'daily-office',
      name: '日常办公',
      rows: 2,
      moduleIds: ['agent-ppt', 'agent-word'],
    },
  ],
});

describe('module workspace defaults', () => {
  it('creates the enterprise two-group 2x3 defaults', () => {
    expect(createDefaultModuleWorkspace(enterpriseCapabilities)).toEqual({
      version: 1,
      groups: [
        {
          id: 'park-services',
          name: '园区服务',
          rows: 2,
          moduleIds: [
            'park-announcement',
            'park-satisfaction',
            'park-renovation',
            'park-parking',
            'park-network-phone',
            'park-meeting-room',
          ],
        },
        {
          id: 'daily-office',
          name: '日常办公',
          rows: 2,
          moduleIds: [
            'agent-enterprise-work',
            'agent-ppt',
            'agent-meeting',
            'agent-word',
            'agent-excel',
            'enterprise-memory',
          ],
        },
      ],
    });
  });

  it('does not synthesize enterprise or park modules for personal edition', () => {
    const layout = createDefaultModuleWorkspace(personalCapabilities);
    const moduleIds = layout.groups.flatMap((group) => group.moduleIds);

    expect(layout.groups).toHaveLength(1);
    expect(moduleIds).toEqual(['agent-personal-otto', 'auto-skill']);
    expect(moduleIds.some((id) => id.startsWith('park-'))).toBe(false);
    expect(moduleIds).not.toContain('enterprise-memory');
    expect(moduleIds).not.toContain('agent-enterprise-work');
  });

  it('recomputes restored defaults from the current capability snapshot', () => {
    const restored = restoreDefaultModuleWorkspace(sampleLayout(), personalCapabilities);

    expect(restored).toEqual(createDefaultModuleWorkspace(personalCapabilities));
  });
});

describe('module workspace parsing and normalization', () => {
  it('falls back for corrupt or unsupported records', () => {
    const defaults = createDefaultModuleWorkspace(enterpriseCapabilities);

    expect(parseModuleWorkspace('{bad json', enterpriseCapabilities)).toEqual(defaults);
    expect(parseModuleWorkspace(JSON.stringify({ version: 99 }), enterpriseCapabilities)).toEqual(defaults);
  });

  it('deduplicates module IDs globally, repairs group IDs, clamps rows, and keeps unknown modules', () => {
    const normalized = normalizeModuleWorkspace({
      version: 1,
      groups: [
        {
          id: 'same',
          name: '  园区服务  ',
          rows: 99,
          moduleIds: ['park-announcement', 'future-module', 'park-announcement'],
        },
        {
          id: 'same',
          name: '日常办公',
          rows: 3,
          moduleIds: ['future-module', 'agent-ppt'],
        },
      ],
    });

    expect(normalized.groups[0]).toMatchObject({
      id: 'same',
      name: '园区服务',
      rows: 2,
      moduleIds: ['park-announcement', 'future-module'],
    });
    expect(normalized.groups[1]).toMatchObject({
      id: 'same-2',
      rows: 3,
      moduleIds: ['agent-ppt'],
    });
  });

  it('truncates long names and supplies a safe name for blank groups', () => {
    const normalized = normalizeModuleWorkspace({
      version: 1,
      groups: [
        { id: 'blank', name: '   ', rows: 2, moduleIds: [] },
        { id: 'long', name: '很'.repeat(80), rows: 2, moduleIds: [] },
      ],
    });

    expect(normalized.groups[0].name).toBe('未命名功能组');
    expect(normalized.groups[1].name).toHaveLength(40);
  });
});

describe('module workspace layout operations', () => {
  it('moves modules between groups without duplicates', () => {
    const next = addOrMoveModules(sampleLayout(), 'park-services', ['agent-ppt', 'agent-excel']);

    expect(next.groups[0].moduleIds).toEqual([
      'park-announcement',
      'park-satisfaction',
      'agent-ppt',
      'agent-excel',
    ]);
    expect(next.groups[1].moduleIds).toEqual(['agent-word']);
  });

  it('removes only the requested module from layout', () => {
    const next = removeModuleFromGroup(sampleLayout(), 'daily-office', 'agent-ppt');

    expect(next.groups[1].moduleIds).toEqual(['agent-word']);
  });

  it('protects the last group but allows deleting another group', () => {
    const oneGroup = { version: 1 as const, groups: [sampleLayout().groups[0]] };
    expect(deleteModuleGroup(oneGroup, 'park-services')).toEqual(oneGroup);

    const next = deleteModuleGroup(sampleLayout(), 'park-services');
    expect(next.groups.map((group) => group.id)).toEqual(['daily-office']);
  });

  it('renames, updates row count, and reorders groups and modules', () => {
    const renamed = renameModuleGroup(sampleLayout(), 'daily-office', '  我的办公  ');
    const resized = updateModuleGroupRows(renamed, 'daily-office', 3);
    const groupsReordered = reorderModuleGroups(resized, ['daily-office', 'park-services']);
    const modulesReordered = reorderModulesInGroup(
      groupsReordered,
      'daily-office',
      ['agent-word', 'agent-ppt'],
    );

    expect(modulesReordered.groups[0]).toMatchObject({
      id: 'daily-office',
      name: '我的办公',
      rows: 3,
      moduleIds: ['agent-word', 'agent-ppt'],
    });
  });
});

describe('module workspace storage scope', () => {
  it('normalizes server URL and separates edition, organization, and account', () => {
    const first = getModuleWorkspaceStorageKey({
      serverUrl: ' HTTPS://EXAMPLE.COM/// ',
      edition: 'enterprise',
      organizationId: 'org-a',
      accountId: 'user-a',
    });
    const same = getModuleWorkspaceStorageKey({
      serverUrl: 'https://example.com',
      edition: 'enterprise',
      organizationId: 'org-a',
      accountId: 'user-a',
    });
    const personal = getModuleWorkspaceStorageKey({
      serverUrl: 'https://example.com',
      edition: 'personal',
      accountId: 'user-a',
    });

    expect(first).toBe(same);
    expect(first).not.toBe(personal);
    expect(first).toContain('https%3A%2F%2Fexample.com');
  });
});
