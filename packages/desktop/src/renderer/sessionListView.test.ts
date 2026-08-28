import { describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from 'otto-server';

import {
  DEFAULT_SESSION_LIST_PREFERENCE,
  groupSessionsForSidebar,
  readSessionListPreference,
  sessionListPreferenceStorageKey,
  writeSessionListPreference,
} from './sessionListView.js';

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: 'session-1',
    source: 'local',
    title: '新会话',
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    ...overrides,
  };
}

const scope = {
  serverUrl: 'https://example.com/',
  organizationId: 'org-a',
  accountId: 'account-a',
};

describe('session list view grouping', () => {
  it('keeps the existing relative-time ordering', () => {
    const now = new Date('2026-08-26T12:00:00+08:00').getTime();
    const sessions = [
      makeSession({ sessionId: 'old', updatedAt: new Date('2026-08-23T20:00:00+08:00').getTime() }),
      makeSession({ sessionId: 'today', updatedAt: new Date('2026-08-26T09:00:00+08:00').getTime() }),
      makeSession({ sessionId: 'yesterday', updatedAt: new Date('2026-08-25T23:00:00+08:00').getTime() }),
    ];

    const groups = groupSessionsForSidebar(sessions, 'time', now);

    expect(groups.map((group) => group.label)).toEqual(['今天', '昨天', '3天前']);
    expect(groups.flatMap((group) => group.sessions.map((session) => session.sessionId)))
      .toEqual(['today', 'yesterday', 'old']);
    expect(groups.every((group) => !group.collapsible)).toBe(true);
  });

  it('groups by the real workspace path and sorts groups and sessions by recent activity', () => {
    const sessions = [
      makeSession({ sessionId: 'desktop-old', workspacePath: '/Users/yang/Desktop', updatedAt: 10 }),
      makeSession({ sessionId: 'project-new', workspacePath: '/Users/yang/project', updatedAt: 40 }),
      makeSession({ sessionId: 'desktop-new', workspacePath: '/Users/yang/Desktop', updatedAt: 30 }),
    ];

    const groups = groupSessionsForSidebar(sessions, 'workspace');

    expect(groups.map((group) => group.key)).toEqual([
      'workspace:/Users/yang/project',
      'workspace:/Users/yang/Desktop',
    ]);
    expect(groups[1].sessions.map((session) => session.sessionId))
      .toEqual(['desktop-new', 'desktop-old']);
    expect(groups.every((group) => group.collapsible)).toBe(true);
  });

  it('disambiguates duplicate folder names and handles missing and Windows workspaces', () => {
    const sessions = [
      makeSession({ sessionId: 'desktop-app', workspacePath: '/Users/yang/Desktop/app', updatedAt: 50 }),
      makeSession({ sessionId: 'documents-app', workspacePath: '/Users/yang/Documents/app', updatedAt: 40 }),
      makeSession({ sessionId: 'windows', workspacePath: 'C:\\Users\\yang\\work', updatedAt: 30 }),
      makeSession({ sessionId: 'missing', workspacePath: undefined, updatedAt: 20 }),
    ];

    const groups = groupSessionsForSidebar(sessions, 'workspace');

    expect(groups.map((group) => group.label)).toEqual([
      'app — Desktop',
      'app — Documents',
      'work',
      '默认工作目录',
    ]);
    expect(groups.at(-1)?.key).toBe('workspace:default');
  });

  it('extends duplicate parent paths until every workspace label is unique', () => {
    const sessions = [
      makeSession({ sessionId: 'alice', workspacePath: '/Users/alice/work/app', updatedAt: 30 }),
      makeSession({ sessionId: 'team', workspacePath: '/Volumes/team/work/app', updatedAt: 20 }),
      makeSession({ sessionId: 'windows', workspacePath: 'D:\\work\\app', updatedAt: 10 }),
    ];

    const groups = groupSessionsForSidebar(sessions, 'workspace');

    expect(groups.map((group) => group.label)).toEqual([
      'app — alice/work',
      'app — team/work',
      'app — D:/work',
    ]);
  });
});

describe('session list view preference', () => {
  it('is scoped by server, organization, and account', () => {
    expect(sessionListPreferenceStorageKey(scope)).not.toBe(
      sessionListPreferenceStorageKey({ ...scope, accountId: 'account-b' }),
    );
    expect(sessionListPreferenceStorageKey(scope)).toBe(
      sessionListPreferenceStorageKey({ ...scope, serverUrl: ' HTTPS://EXAMPLE.COM/// ' }),
    );
  });

  it('falls back safely when storage is missing, corrupt, or from an unknown version', () => {
    expect(readSessionListPreference(scope, { getItem: () => null }))
      .toEqual(DEFAULT_SESSION_LIST_PREFERENCE);
    expect(readSessionListPreference(scope, { getItem: () => '{bad json' }))
      .toEqual(DEFAULT_SESSION_LIST_PREFERENCE);
    expect(readSessionListPreference(scope, {
      getItem: () => JSON.stringify({ version: 99, mode: 'workspace' }),
    })).toEqual(DEFAULT_SESSION_LIST_PREFERENCE);
  });

  it('falls back safely when browser storage access is disabled', () => {
    expect(readSessionListPreference(scope, {
      getItem: () => { throw new Error('storage disabled'); },
    })).toEqual(DEFAULT_SESSION_LIST_PREFERENCE);
    expect(writeSessionListPreference(scope, DEFAULT_SESSION_LIST_PREFERENCE, {
      setItem: () => { throw new Error('storage disabled'); },
    })).toBe(false);
  });

  it('normalizes and persists the selected mode and collapsed workspace keys', () => {
    const setItem = vi.fn();
    expect(writeSessionListPreference(scope, {
      version: 1,
      mode: 'workspace',
      collapsedWorkspaceKeys: ['workspace:/a', 'workspace:/a', '', 'workspace:/b'],
    }, { setItem })).toBe(true);

    expect(setItem).toHaveBeenCalledWith(
      sessionListPreferenceStorageKey(scope),
      JSON.stringify({
        version: 1,
        mode: 'workspace',
        collapsedWorkspaceKeys: ['workspace:/a', 'workspace:/b'],
      }),
    );
  });
});
