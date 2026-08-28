import type { UiModePreferenceScope } from './uiModePreference.js';

const STORAGE_PREFIX = 'otto.right-panel.v1';

function normalizeServerUrl(value: string | null | undefined): string {
  const normalized = value?.trim().replace(/\/+$/, '').toLowerCase();
  return normalized || 'local';
}

export function rightPanelStorageKey(scope: UiModePreferenceScope): string {
  return [
    STORAGE_PREFIX,
    normalizeServerUrl(scope.serverUrl),
    scope.organizationId.trim() || 'personal',
    scope.accountId.trim() || 'anonymous',
  ].map(encodeURIComponent).join(':');
}

export function readRightPanelCollapsed(
  scope: UiModePreferenceScope,
  storage: Pick<Storage, 'getItem'> = window.localStorage,
): boolean {
  try {
    return storage.getItem(rightPanelStorageKey(scope)) === 'collapsed';
  } catch {
    return false;
  }
}

export function writeRightPanelCollapsed(
  scope: UiModePreferenceScope,
  collapsed: boolean,
  storage: Pick<Storage, 'setItem'> = window.localStorage,
): boolean {
  try {
    storage.setItem(
      rightPanelStorageKey(scope),
      collapsed ? 'collapsed' : 'expanded',
    );
    return true;
  } catch {
    return false;
  }
}
