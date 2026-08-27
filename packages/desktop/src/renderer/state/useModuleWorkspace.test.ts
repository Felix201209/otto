import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createDefaultModuleWorkspace,
  getModuleWorkspaceStorageKey,
  type ModuleWorkspaceCapabilities,
  type ModuleWorkspaceStorageScope,
} from '../moduleWorkspace.js';
import { useModuleWorkspace } from './useModuleWorkspace.js';

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

const accountA: ModuleWorkspaceStorageScope = {
  serverUrl: 'https://example.com',
  edition: 'enterprise',
  organizationId: 'org-a',
  accountId: 'account-a',
};

interface HookProps {
  scope: ModuleWorkspaceStorageScope;
  capabilities: ModuleWorkspaceCapabilities;
  visibleModuleIds?: readonly string[];
  ready?: boolean;
}

beforeEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('useModuleWorkspace', () => {
  it('does not create or persist a layout before capabilities are ready', () => {
    const write = vi.spyOn(Storage.prototype, 'setItem');
    const view = renderHook(
      (props: HookProps) => useModuleWorkspace(props),
      {
        initialProps: {
          scope: accountA,
          capabilities: enterpriseCapabilities,
          ready: false,
        },
      },
    );

    expect(view.result.current.ready).toBe(false);
    expect(view.result.current.layout.groups).toEqual([]);
    act(() => view.result.current.setLayout(createDefaultModuleWorkspace(enterpriseCapabilities)));
    act(() => view.result.current.restoreDefaults());
    expect(write).not.toHaveBeenCalled();

    view.rerender({
      scope: accountA,
      capabilities: enterpriseCapabilities,
      ready: true,
    });
    expect(view.result.current.ready).toBe(true);
    expect(view.result.current.layout).toEqual(createDefaultModuleWorkspace(enterpriseCapabilities));
    expect(write).not.toHaveBeenCalled();
  });

  it('returns capability defaults when storage is missing without writing them', () => {
    const write = vi.spyOn(Storage.prototype, 'setItem');
    const view = renderHook(
      (props: HookProps) => useModuleWorkspace(props),
      { initialProps: { scope: accountA, capabilities: enterpriseCapabilities } },
    );

    expect(view.result.current.layout).toEqual(
      createDefaultModuleWorkspace(enterpriseCapabilities),
    );
    expect(write).not.toHaveBeenCalled();
  });

  it('falls back from corrupt storage without overwriting until the user commits a change', () => {
    const key = getModuleWorkspaceStorageKey(accountA);
    window.localStorage.setItem(key, '{bad json');
    const write = vi.spyOn(Storage.prototype, 'setItem');
    const view = renderHook(
      (props: HookProps) => useModuleWorkspace(props),
      { initialProps: { scope: accountA, capabilities: enterpriseCapabilities } },
    );

    expect(view.result.current.layout).toEqual(
      createDefaultModuleWorkspace(enterpriseCapabilities),
    );
    expect(write).not.toHaveBeenCalled();

    const next = {
      ...view.result.current.layout,
      groups: view.result.current.layout.groups.map((group) => ({ ...group })),
    };
    act(() => view.result.current.setLayout(next));

    expect(write).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(key)).toBe(JSON.stringify(next));
  });

  it('separates server, account, organization, and edition scopes', async () => {
    const scopeB: ModuleWorkspaceStorageScope = {
      ...accountA,
      serverUrl: 'https://other.example.com',
      organizationId: 'org-b',
      accountId: 'account-b',
      edition: 'personal',
    };
    const storedA = createDefaultModuleWorkspace(enterpriseCapabilities);
    storedA.groups[0].name = 'A 的园区';
    window.localStorage.setItem(getModuleWorkspaceStorageKey(accountA), JSON.stringify(storedA));

    const view = renderHook(
      (props: HookProps) => useModuleWorkspace(props),
      { initialProps: { scope: accountA, capabilities: enterpriseCapabilities } },
    );
    expect(view.result.current.layout.groups[0].name).toBe('A 的园区');

    view.rerender({ scope: scopeB, capabilities: personalCapabilities });
    await waitFor(() => {
      expect(view.result.current.layout).toEqual(createDefaultModuleWorkspace(personalCapabilities));
    });
    expect(view.result.current.layout.groups[0].name).not.toBe('A 的园区');
  });

  it('treats equivalent normalized server URLs as the same scope', () => {
    const stored = createDefaultModuleWorkspace(enterpriseCapabilities);
    stored.groups[0].name = '共享布局';
    window.localStorage.setItem(getModuleWorkspaceStorageKey(accountA), JSON.stringify(stored));

    const view = renderHook(
      (props: HookProps) => useModuleWorkspace(props),
      {
        initialProps: {
          scope: { ...accountA, serverUrl: ' HTTPS://EXAMPLE.COM/// ' },
          capabilities: enterpriseCapabilities,
        },
      },
    );

    expect(view.result.current.layout.groups[0].name).toBe('共享布局');
  });

  it('discards transient layout state when identity scope changes', async () => {
    const scopeB = { ...accountA, accountId: 'account-b' };
    const view = renderHook(
      (props: HookProps) => useModuleWorkspace(props),
      { initialProps: { scope: accountA, capabilities: enterpriseCapabilities } },
    );
    const edited = createDefaultModuleWorkspace(enterpriseCapabilities);
    edited.groups[0].name = '尚未属于 B 的布局';
    act(() => view.result.current.setLayout(edited));

    view.rerender({ scope: scopeB, capabilities: enterpriseCapabilities });
    await waitFor(() => {
      expect(view.result.current.layout.groups[0].name).toBe('园区服务');
    });
    expect(window.localStorage.getItem(getModuleWorkspaceStorageKey(scopeB))).toBeNull();
  });

  it('keeps hidden modules in stored layout while filtering the visible view model', () => {
    const stored = createDefaultModuleWorkspace(enterpriseCapabilities);
    stored.groups[1].moduleIds.push('future-hidden-module');
    window.localStorage.setItem(getModuleWorkspaceStorageKey(accountA), JSON.stringify(stored));

    const visibleModuleIds = enterpriseCapabilities.availableModuleIds.filter(
      (moduleId) => moduleId !== 'enterprise-memory',
    );
    const view = renderHook(
      (props: HookProps) => useModuleWorkspace(props),
      {
        initialProps: {
          scope: accountA,
          capabilities: enterpriseCapabilities,
          visibleModuleIds,
        },
      },
    );

    expect(view.result.current.layout.groups[1].moduleIds).toContain('enterprise-memory');
    expect(view.result.current.layout.groups[1].moduleIds).toContain('future-hidden-module');
    expect(view.result.current.visibleLayout.groups[1].moduleIds).not.toContain('enterprise-memory');
    expect(view.result.current.visibleLayout.groups[1].moduleIds).not.toContain('future-hidden-module');
  });

  it('merges visible layout edits without deleting temporarily hidden module ids', () => {
    const stored = createDefaultModuleWorkspace(enterpriseCapabilities);
    stored.groups[1].moduleIds.splice(1, 0, 'future-hidden-module');
    window.localStorage.setItem(getModuleWorkspaceStorageKey(accountA), JSON.stringify(stored));
    const visibleModuleIds = enterpriseCapabilities.availableModuleIds;
    const view = renderHook(
      (props: HookProps) => useModuleWorkspace(props),
      { initialProps: {
        scope: accountA,
        capabilities: enterpriseCapabilities,
        visibleModuleIds,
      } },
    );
    const editedVisible = {
      ...view.result.current.visibleLayout,
      groups: view.result.current.visibleLayout.groups.map((group) => group.id === 'daily-office'
        ? { ...group, moduleIds: ['agent-ppt', 'agent-enterprise-work', 'agent-meeting'] }
        : group),
    };

    act(() => view.result.current.setVisibleLayout(editedVisible));

    const saved = JSON.parse(window.localStorage.getItem(getModuleWorkspaceStorageKey(accountA))!);
    expect(saved.groups[1].moduleIds).toContain('future-hidden-module');
    expect(saved.groups[1].moduleIds).toEqual([
      'agent-ppt',
      'future-hidden-module',
      'agent-enterprise-work',
      'agent-meeting',
    ]);
  });

  it('restores and persists defaults for the current capability snapshot once', () => {
    const write = vi.spyOn(Storage.prototype, 'setItem');
    const view = renderHook(
      (props: HookProps) => useModuleWorkspace(props),
      { initialProps: { scope: accountA, capabilities: enterpriseCapabilities } },
    );
    const edited = createDefaultModuleWorkspace(enterpriseCapabilities);
    edited.groups[0].name = '自定义园区';
    act(() => view.result.current.setLayout(edited));
    write.mockClear();

    act(() => view.result.current.restoreDefaults());

    expect(view.result.current.layout).toEqual(createDefaultModuleWorkspace(enterpriseCapabilities));
    expect(write).toHaveBeenCalledTimes(1);
  });
});
