import type { SessionSummary } from 'otto-server';

import type { UiModePreferenceScope } from './uiModePreference.js';

export type SessionListMode = 'time' | 'workspace';

export interface SidebarSessionGroup {
  key: string;
  label: string;
  fullPath?: string;
  collapsible: boolean;
  sessions: SessionSummary[];
}

export interface SessionListPreference {
  version: 1;
  mode: SessionListMode;
  collapsedWorkspaceKeys: string[];
}

export const DEFAULT_SESSION_LIST_PREFERENCE: SessionListPreference = {
  version: 1,
  mode: 'time',
  collapsedWorkspaceKeys: [],
};

const STORAGE_PREFIX = 'otto.session-list.v1';
const DEFAULT_WORKSPACE_KEY = 'workspace:default';

function normalizeServerUrl(value: string | null | undefined): string {
  const normalized = value?.trim().replace(/\/+$/, '').toLowerCase();
  return normalized || 'local';
}

export function sessionListPreferenceStorageKey(scope: UiModePreferenceScope): string {
  return [
    STORAGE_PREFIX,
    normalizeServerUrl(scope.serverUrl),
    scope.organizationId.trim() || 'personal',
    scope.accountId.trim() || 'anonymous',
  ].map(encodeURIComponent).join(':');
}

function normalizePreference(value: unknown): SessionListPreference {
  if (!value || typeof value !== 'object') return DEFAULT_SESSION_LIST_PREFERENCE;
  const candidate = value as Partial<SessionListPreference>;
  if (candidate.version !== 1 || (candidate.mode !== 'time' && candidate.mode !== 'workspace')) {
    return DEFAULT_SESSION_LIST_PREFERENCE;
  }
  const collapsedWorkspaceKeys = Array.isArray(candidate.collapsedWorkspaceKeys)
    ? [...new Set(candidate.collapsedWorkspaceKeys.filter(
      (key): key is string => typeof key === 'string' && key.trim().length > 0,
    ))]
    : [];
  return { version: 1, mode: candidate.mode, collapsedWorkspaceKeys };
}

export function readSessionListPreference(
  scope: UiModePreferenceScope,
  storage: Pick<Storage, 'getItem'> = window.localStorage,
): SessionListPreference {
  try {
    const serialized = storage.getItem(sessionListPreferenceStorageKey(scope));
    if (!serialized) return DEFAULT_SESSION_LIST_PREFERENCE;
    return normalizePreference(JSON.parse(serialized));
  } catch {
    return DEFAULT_SESSION_LIST_PREFERENCE;
  }
}

export function writeSessionListPreference(
  scope: UiModePreferenceScope,
  preference: SessionListPreference,
  storage: Pick<Storage, 'setItem'> = window.localStorage,
): boolean {
  try {
    storage.setItem(
      sessionListPreferenceStorageKey(scope),
      JSON.stringify(normalizePreference(preference)),
    );
    return true;
  } catch {
    return false;
  }
}

/** 按用户本地自然日计算相对日期，避免跨时区或夏令时把“昨天”算成同一天。 */
function formatRelativeDay(timestamp: number, now: number): string {
  const current = new Date(now);
  const target = new Date(timestamp);
  const currentDay = Date.UTC(current.getFullYear(), current.getMonth(), current.getDate());
  const targetDay = Date.UTC(target.getFullYear(), target.getMonth(), target.getDate());
  const days = Math.max(0, Math.round((currentDay - targetDay) / 86_400_000));
  if (days === 0) return '今天';
  if (days === 1) return '昨天';
  return `${days}天前`;
}

function workspaceKey(workspacePath: string | undefined): string {
  const value = workspacePath?.trim();
  return value ? `workspace:${value}` : DEFAULT_WORKSPACE_KEY;
}

function pathParts(workspacePath: string): string[] {
  return workspacePath.split(/[\\/]+/).filter(Boolean);
}

function workspaceBaseLabel(workspacePath: string | undefined): string {
  const value = workspacePath?.trim();
  if (!value) return '默认工作目录';
  if (/^[\\/]+$/.test(value) || /^[A-Za-z]:[\\/]?$/.test(value)) return value;
  const parts = pathParts(value);
  return parts.at(-1) ?? value;
}

function workspaceAncestorLabel(workspacePath: string | undefined, depth: number): string | undefined {
  const value = workspacePath?.trim();
  if (!value) return undefined;
  const parts = pathParts(value);
  const ancestors = parts.slice(0, -1);
  return ancestors.slice(-depth).join('/') || undefined;
}

function sortSessions(sessions: readonly SessionSummary[]): SessionSummary[] {
  return [...sessions].sort((left, right) => right.updatedAt - left.updatedAt);
}

function groupByTime(sessions: readonly SessionSummary[], now: number): SidebarSessionGroup[] {
  const groups: SidebarSessionGroup[] = [];
  const byLabel = new Map<string, SidebarSessionGroup>();
  for (const session of sortSessions(sessions)) {
    const label = formatRelativeDay(session.updatedAt, now);
    const existing = byLabel.get(label);
    if (existing) existing.sessions.push(session);
    else {
      const group = { key: `time:${label}`, label, collapsible: false, sessions: [session] };
      byLabel.set(label, group);
      groups.push(group);
    }
  }
  return groups;
}

function groupByWorkspace(sessions: readonly SessionSummary[]): SidebarSessionGroup[] {
  const byKey = new Map<string, SidebarSessionGroup>();
  for (const session of sortSessions(sessions)) {
    const key = workspaceKey(session.workspacePath);
    const existing = byKey.get(key);
    if (existing) existing.sessions.push(session);
    else {
      byKey.set(key, {
        key,
        label: workspaceBaseLabel(session.workspacePath),
        fullPath: session.workspacePath?.trim() || undefined,
        collapsible: true,
        sessions: [session],
      });
    }
  }

  const groups = [...byKey.values()];
  const groupsByBaseLabel = new Map<string, SidebarSessionGroup[]>();
  for (const group of groups) {
    const matches = groupsByBaseLabel.get(group.label);
    if (matches) matches.push(group);
    else groupsByBaseLabel.set(group.label, [group]);
  }
  for (const [baseLabel, matches] of groupsByBaseLabel) {
    if (matches.length < 2) continue;
    const maxDepth = Math.max(...matches.map((group) => pathParts(group.fullPath ?? '').length));
    let assigned = false;
    for (let depth = 1; depth <= maxDepth; depth += 1) {
      const labels = matches.map((group) => {
        const ancestor = workspaceAncestorLabel(group.fullPath, depth);
        return ancestor ? `${baseLabel} — ${ancestor}` : group.fullPath ?? baseLabel;
      });
      if (new Set(labels).size !== matches.length) continue;
      matches.forEach((group, index) => { group.label = labels[index]; });
      assigned = true;
      break;
    }
    if (!assigned) {
      matches.forEach((group) => { group.label = group.fullPath ?? baseLabel; });
    }
  }
  return groups;
}

export function groupSessionsForSidebar(
  sessions: readonly SessionSummary[],
  mode: SessionListMode,
  now = Date.now(),
): SidebarSessionGroup[] {
  return mode === 'workspace' ? groupByWorkspace(sessions) : groupByTime(sessions, now);
}
