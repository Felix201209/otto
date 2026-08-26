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
  visibleModuleIds?: readonly string[];
  storage?: ModuleWorkspaceStorage;
}

export interface UseModuleWorkspaceResult {
  layout: ModuleWorkspaceLayout;
  visibleLayout: ModuleWorkspaceLayout;
  setLayout(next: ModuleWorkspaceLayout): void;
  restoreDefaults(): void;
}

interface ScopedLayoutState {
  storageKey: string;
  capabilitySignature: string;
  layout: ModuleWorkspaceLayout;
}

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
    () => readLayout(storage, storageKey, stableCapabilities),
    [stableCapabilities, storage, storageKey],
  );
  const [state, setState] = useState<ScopedLayoutState>(() => ({
    storageKey,
    capabilitySignature,
    layout: loadedLayout,
  }));
  const scopeMatches = state.storageKey === storageKey
    && state.capabilitySignature === capabilitySignature;
  const layout = scopeMatches ? state.layout : loadedLayout;

  useEffect(() => {
    if (scopeMatches) return;
    setState({ storageKey, capabilitySignature, layout: loadedLayout });
  }, [capabilitySignature, loadedLayout, scopeMatches, storageKey]);

  const commitLayout = useCallback((next: ModuleWorkspaceLayout): void => {
    const normalized = normalizeModuleWorkspace(next);
    setState({ storageKey, capabilitySignature, layout: normalized });
    writeLayout(storage, storageKey, normalized);
  }, [capabilitySignature, storage, storageKey]);

  const restoreDefaults = useCallback((): void => {
    const defaults = createDefaultModuleWorkspace(stableCapabilities);
    setState({ storageKey, capabilitySignature, layout: defaults });
    writeLayout(storage, storageKey, defaults);
  }, [capabilitySignature, stableCapabilities, storage, storageKey]);

  const visible = new Set(visibleModuleIds);
  const visibleLayout = {
    ...layout,
    groups: layout.groups.map((group) => ({
      ...group,
      moduleIds: group.moduleIds.filter((moduleId) => visible.has(moduleId)),
    })),
  };

  return {
    layout,
    visibleLayout,
    setLayout: commitLayout,
    restoreDefaults,
  };
}
