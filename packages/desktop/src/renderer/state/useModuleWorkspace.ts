/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  createDefaultModuleWorkspace,
  getModuleWorkspaceStorageKey,
  normalizeModuleWorkspace,
  parseModuleWorkspace,
  type ModuleWorkspaceCapabilities,
  type ModuleWorkspaceLayout,
  type ModuleWorkspaceStorageScope,
} from '../moduleWorkspace.js';

type ModuleWorkspaceStorage = Pick<Storage, 'getItem' | 'setItem'>;

export interface UseModuleWorkspaceInput {
  scope: ModuleWorkspaceStorageScope;
  capabilities: ModuleWorkspaceCapabilities;
  ready?: boolean;
  visibleModuleIds?: readonly string[];
  storage?: ModuleWorkspaceStorage;
}

export interface UseModuleWorkspaceResult {
  ready: boolean;
  layout: ModuleWorkspaceLayout;
  visibleLayout: ModuleWorkspaceLayout;
  setLayout(next: ModuleWorkspaceLayout): void;
  setVisibleLayout(next: ModuleWorkspaceLayout): void;
  restoreDefaults(): void;
}

interface ScopedLayoutState {
  storageKey: string;
  capabilitySignature: string;
  ready: boolean;
  layout: ModuleWorkspaceLayout;
}

const EMPTY_LAYOUT: ModuleWorkspaceLayout = { version: 1, groups: [] };

function capabilitiesSignature(capabilities: ModuleWorkspaceCapabilities): string {
  return JSON.stringify([capabilities.edition, capabilities.availableModuleIds]);
}

function capabilitiesFromSignature(signature: string): ModuleWorkspaceCapabilities {
  const [edition, availableModuleIds] = JSON.parse(signature) as [
    ModuleWorkspaceCapabilities['edition'],
    string[],
  ];
  return { edition, availableModuleIds };
}

function readLayout(
  storage: ModuleWorkspaceStorage,
  storageKey: string,
  capabilities: ModuleWorkspaceCapabilities,
): ModuleWorkspaceLayout {
  try {
    return parseModuleWorkspace(storage.getItem(storageKey), capabilities);
  } catch {
    return createDefaultModuleWorkspace(capabilities);
  }
}

function writeLayout(
  storage: ModuleWorkspaceStorage,
  storageKey: string,
  layout: ModuleWorkspaceLayout,
): void {
  try {
    storage.setItem(storageKey, JSON.stringify(layout));
  } catch {
    // A blocked preference store must not make the workspace unusable.
  }
}

export function useModuleWorkspace({
  scope,
  capabilities,
  ready = true,
  visibleModuleIds = capabilities.availableModuleIds,
  storage = window.localStorage,
}: UseModuleWorkspaceInput): UseModuleWorkspaceResult {
  const storageKey = getModuleWorkspaceStorageKey(scope);
  const capabilitySignature = capabilitiesSignature(capabilities);
  const stableCapabilities = useMemo(
    () => capabilitiesFromSignature(capabilitySignature),
    [capabilitySignature],
  );
  const loadedLayout = useMemo(
    () => ready ? readLayout(storage, storageKey, stableCapabilities) : EMPTY_LAYOUT,
    [ready, stableCapabilities, storage, storageKey],
  );
  const [state, setState] = useState<ScopedLayoutState>(() => ({
    storageKey,
    capabilitySignature,
    ready,
    layout: loadedLayout,
  }));
  const scopeMatches = state.storageKey === storageKey
    && state.capabilitySignature === capabilitySignature
    && state.ready === ready;
  const layout = scopeMatches ? state.layout : loadedLayout;

  useEffect(() => {
    if (scopeMatches) return;
    setState({ storageKey, capabilitySignature, ready, layout: loadedLayout });
  }, [capabilitySignature, loadedLayout, ready, scopeMatches, storageKey]);

  const commitLayout = useCallback((next: ModuleWorkspaceLayout): void => {
    if (!ready) return;
    const normalized = normalizeModuleWorkspace(next);
    setState({ storageKey, capabilitySignature, ready, layout: normalized });
    writeLayout(storage, storageKey, normalized);
  }, [capabilitySignature, ready, storage, storageKey]);

  const visibleModuleIdSet = useMemo(
    () => new Set(visibleModuleIds),
    [visibleModuleIds],
  );
  const commitVisibleLayout = useCallback((next: ModuleWorkspaceLayout): void => {
    const rawGroupsById = new Map(layout.groups.map((group) => [group.id, group]));
    const retainedHiddenIds: string[] = [];
    for (const group of layout.groups) {
      if (next.groups.some((candidate) => candidate.id === group.id)) continue;
      retainedHiddenIds.push(...group.moduleIds.filter((moduleId) => !visibleModuleIdSet.has(moduleId)));
    }
    const groups = next.groups.map((group, groupIndex) => {
      const rawGroup = rawGroupsById.get(group.id);
      if (!rawGroup) {
        return groupIndex === 0 && retainedHiddenIds.length > 0
          ? { ...group, moduleIds: [...group.moduleIds, ...retainedHiddenIds] }
          : group;
      }
      let visibleIndex = 0;
      const moduleIds = rawGroup.moduleIds.flatMap((moduleId) => {
        if (!visibleModuleIdSet.has(moduleId)) return [moduleId];
        const replacement = group.moduleIds[visibleIndex++];
        return replacement ? [replacement] : [];
      });
      moduleIds.push(...group.moduleIds.slice(visibleIndex));
      if (groupIndex === 0) moduleIds.push(...retainedHiddenIds);
      return { ...group, moduleIds };
    });
    commitLayout({ ...next, groups });
  }, [commitLayout, layout.groups, visibleModuleIdSet]);

  const restoreDefaults = useCallback((): void => {
    if (!ready) return;
    const defaults = createDefaultModuleWorkspace(stableCapabilities);
    setState({ storageKey, capabilitySignature, ready, layout: defaults });
    writeLayout(storage, storageKey, defaults);
  }, [capabilitySignature, ready, stableCapabilities, storage, storageKey]);

  const visibleLayout = {
    ...layout,
    groups: layout.groups.map((group) => ({
      ...group,
      moduleIds: group.moduleIds.filter((moduleId) => visibleModuleIdSet.has(moduleId)),
    })),
  };

  return {
    ready,
    layout,
    visibleLayout,
    setLayout: commitLayout,
    setVisibleLayout: commitVisibleLayout,
    restoreDefaults,
  };
}
