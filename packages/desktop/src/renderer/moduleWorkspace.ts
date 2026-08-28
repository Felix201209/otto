/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

export const MODULE_WORKSPACE_SCHEMA_VERSION = 1 as const;
export const MODULE_GROUP_NAME_MAX_LENGTH = 40;

export type ModuleWorkspaceEdition = 'personal' | 'enterprise';

export interface ModuleWorkspaceCapabilities {
  edition: ModuleWorkspaceEdition;
  availableModuleIds: readonly string[];
}

export interface ModuleGroupLayout {
  id: string;
  name: string;
  rows: 2 | 3;
  moduleIds: string[];
}

export interface ModuleWorkspaceLayout {
  version: typeof MODULE_WORKSPACE_SCHEMA_VERSION;
  groups: ModuleGroupLayout[];
}

export interface ModuleWorkspaceStorageScope {
  serverUrl: string;
  edition: ModuleWorkspaceEdition;
  organizationId?: string;
  accountId: string;
}

const ENTERPRISE_DEFAULT_GROUPS: readonly ModuleGroupLayout[] = [
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
] as const;

const PERSONAL_DEFAULT_GROUP: ModuleGroupLayout = {
  id: 'daily-office',
  name: '日常办公',
  rows: 2,
  moduleIds: [],
};

function cloneGroup(group: ModuleGroupLayout): ModuleGroupLayout {
  return { ...group, moduleIds: [...group.moduleIds] };
}

function normalizeGroupName(value: unknown): string {
  if (typeof value !== 'string') return '未命名功能组';
  const normalized = value.trim();
  return normalized
    ? Array.from(normalized).slice(0, MODULE_GROUP_NAME_MAX_LENGTH).join('')
    : '未命名功能组';
}

function normalizeGroupId(value: unknown, index: number): string {
  if (typeof value !== 'string') return `group-${index + 1}`;
  const normalized = value.trim();
  return normalized || `group-${index + 1}`;
}

function uniqueGroupId(candidate: string, used: Set<string>): string {
  if (!used.has(candidate)) return candidate;
  let suffix = 2;
  while (used.has(`${candidate}-${suffix}`)) suffix += 1;
  return `${candidate}-${suffix}`;
}

function normalizeModuleIds(value: unknown, seen: Set<string>): string[] {
  if (!Array.isArray(value)) return [];
  const moduleIds: string[] = [];
  for (const rawId of value) {
    if (typeof rawId !== 'string') continue;
    const moduleId = rawId.trim();
    if (!moduleId || seen.has(moduleId)) continue;
    seen.add(moduleId);
    moduleIds.push(moduleId);
  }
  return moduleIds;
}

export function createDefaultModuleWorkspace(
  capabilities: ModuleWorkspaceCapabilities,
): ModuleWorkspaceLayout {
  const available = new Set(capabilities.availableModuleIds);
  if (capabilities.edition === 'personal') {
    return {
      version: MODULE_WORKSPACE_SCHEMA_VERSION,
      groups: [{
        ...PERSONAL_DEFAULT_GROUP,
        moduleIds: capabilities.availableModuleIds.filter((moduleId) => available.has(moduleId)),
      }],
    };
  }

  return {
    version: MODULE_WORKSPACE_SCHEMA_VERSION,
    groups: ENTERPRISE_DEFAULT_GROUPS.map((group) => ({
      ...cloneGroup(group),
      moduleIds: group.moduleIds.filter((moduleId) => available.has(moduleId)),
    })),
  };
}

export function normalizeModuleWorkspace(value: unknown): ModuleWorkspaceLayout {
  const record = value && typeof value === 'object'
    ? value as { groups?: unknown }
    : {};
  const rawGroups = Array.isArray(record.groups) ? record.groups : [];
  const usedGroupIds = new Set<string>();
  const seenModuleIds = new Set<string>();
  const groups: ModuleGroupLayout[] = [];

  rawGroups.forEach((rawGroup, index) => {
    if (!rawGroup || typeof rawGroup !== 'object') return;
    const group = rawGroup as {
      id?: unknown;
      name?: unknown;
      rows?: unknown;
      moduleIds?: unknown;
    };
    const id = uniqueGroupId(normalizeGroupId(group.id, index), usedGroupIds);
    usedGroupIds.add(id);
    groups.push({
      id,
      name: normalizeGroupName(group.name),
      rows: group.rows === 3 ? 3 : 2,
      moduleIds: normalizeModuleIds(group.moduleIds, seenModuleIds),
    });
  });

  return { version: MODULE_WORKSPACE_SCHEMA_VERSION, groups };
}

export function parseModuleWorkspace(
  serialized: string | null | undefined,
  capabilities: ModuleWorkspaceCapabilities,
): ModuleWorkspaceLayout {
  if (!serialized) return createDefaultModuleWorkspace(capabilities);
  try {
    const parsed = JSON.parse(serialized) as { version?: unknown; groups?: unknown };
    if (parsed?.version !== MODULE_WORKSPACE_SCHEMA_VERSION || !Array.isArray(parsed.groups)) {
      return createDefaultModuleWorkspace(capabilities);
    }
    const normalized = normalizeModuleWorkspace(parsed);
    return normalized.groups.length > 0
      ? normalized
      : createDefaultModuleWorkspace(capabilities);
  } catch {
    return createDefaultModuleWorkspace(capabilities);
  }
}

export function normalizeServerUrlForStorage(value: string): string {
  return value.trim().replace(/\/+$/, '').toLowerCase() || 'local';
}

export function getModuleWorkspaceStorageKey(scope: ModuleWorkspaceStorageScope): string {
  return [
    'otto.module-workspace.v1',
    normalizeServerUrlForStorage(scope.serverUrl),
    scope.edition,
    scope.organizationId?.trim() || 'personal',
    scope.accountId.trim() || 'anonymous',
  ].map(encodeURIComponent).join(':');
}

export function addOrMoveModules(
  layout: ModuleWorkspaceLayout,
  targetGroupId: string,
  moduleIds: readonly string[],
): ModuleWorkspaceLayout {
  const moving = [...new Set(moduleIds.map((moduleId) => moduleId.trim()).filter(Boolean))];
  const movingSet = new Set(moving);
  if (!layout.groups.some((group) => group.id === targetGroupId) || moving.length === 0) {
    return layout;
  }
  return {
    ...layout,
    groups: layout.groups.map((group) => {
      const retained = group.moduleIds.filter((moduleId) => !movingSet.has(moduleId));
      return group.id === targetGroupId
        ? { ...group, moduleIds: [...retained, ...moving] }
        : { ...group, moduleIds: retained };
    }),
  };
}

function nextUniqueLabel(base: string, existing: Set<string>): string {
  if (!existing.has(base)) return base;
  let suffix = 2;
  while (existing.has(`${base} ${suffix}`)) suffix += 1;
  return `${base} ${suffix}`;
}

export function createModuleGroup(layout: ModuleWorkspaceLayout): ModuleWorkspaceLayout {
  const names = new Set(layout.groups.map((group) => group.name));
  const ids = new Set(layout.groups.map((group) => group.id));
  const name = nextUniqueLabel('新功能组', names);
  let id = 'custom-group';
  let suffix = 2;
  while (ids.has(id)) {
    id = `custom-group-${suffix}`;
    suffix += 1;
  }
  return {
    ...layout,
    groups: [...layout.groups.map(cloneGroup), { id, name, rows: 2, moduleIds: [] }],
  };
}

export function validateModuleGroupName(
  layout: ModuleWorkspaceLayout,
  groupId: string,
  name: string,
): string | null {
  const normalized = name.trim();
  if (!normalized) return '功能组名称不能为空';
  if (Array.from(normalized).length > MODULE_GROUP_NAME_MAX_LENGTH) {
    return `功能组名称不能超过 ${MODULE_GROUP_NAME_MAX_LENGTH} 个字符`;
  }
  if (layout.groups.some((group) => group.id !== groupId && group.name === normalized)) {
    return '功能组名称不能重复';
  }
  return null;
}

export function removeModuleFromGroup(
  layout: ModuleWorkspaceLayout,
  groupId: string,
  moduleId: string,
): ModuleWorkspaceLayout {
  return {
    ...layout,
    groups: layout.groups.map((group) => group.id === groupId
      ? { ...group, moduleIds: group.moduleIds.filter((id) => id !== moduleId) }
      : cloneGroup(group)),
  };
}

export function deleteModuleGroup(
  layout: ModuleWorkspaceLayout,
  groupId: string,
): ModuleWorkspaceLayout {
  if (layout.groups.length <= 1 || !layout.groups.some((group) => group.id === groupId)) {
    return layout;
  }
  return { ...layout, groups: layout.groups.filter((group) => group.id !== groupId).map(cloneGroup) };
}

export function renameModuleGroup(
  layout: ModuleWorkspaceLayout,
  groupId: string,
  name: string,
): ModuleWorkspaceLayout {
  const normalizedName = normalizeGroupName(name);
  if (layout.groups.some((group) => group.id !== groupId && group.name === normalizedName)) {
    return layout;
  }
  return {
    ...layout,
    groups: layout.groups.map((group) => group.id === groupId
      ? { ...group, name: normalizedName, moduleIds: [...group.moduleIds] }
      : cloneGroup(group)),
  };
}

export function updateModuleGroupRows(
  layout: ModuleWorkspaceLayout,
  groupId: string,
  rows: 2 | 3,
): ModuleWorkspaceLayout {
  return {
    ...layout,
    groups: layout.groups.map((group) => group.id === groupId
      ? { ...group, rows, moduleIds: [...group.moduleIds] }
      : cloneGroup(group)),
  };
}

function orderedUniqueIds(order: readonly string[], existing: readonly string[]): string[] {
  const existingSet = new Set(existing);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of order) {
    if (!existingSet.has(id) || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  for (const id of existing) {
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

export function reorderModuleGroups(
  layout: ModuleWorkspaceLayout,
  orderedGroupIds: readonly string[],
): ModuleWorkspaceLayout {
  const order = orderedUniqueIds(orderedGroupIds, layout.groups.map((group) => group.id));
  const byId = new Map(layout.groups.map((group) => [group.id, group]));
  return {
    ...layout,
    groups: order.map((id) => cloneGroup(byId.get(id)!)),
  };
}

export function reorderModulesInGroup(
  layout: ModuleWorkspaceLayout,
  groupId: string,
  orderedModuleIds: readonly string[],
): ModuleWorkspaceLayout {
  return {
    ...layout,
    groups: layout.groups.map((group) => group.id === groupId
      ? {
        ...group,
        moduleIds: orderedUniqueIds(orderedModuleIds, group.moduleIds),
      }
      : cloneGroup(group)),
  };
}

export function restoreDefaultModuleWorkspace(
  _layout: ModuleWorkspaceLayout,
  capabilities: ModuleWorkspaceCapabilities,
): ModuleWorkspaceLayout {
  return createDefaultModuleWorkspace(capabilities);
}
