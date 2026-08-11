export type UiMode = 'conversational' | 'work';

export const DEFAULT_UI_MODE: UiMode = 'conversational';

export interface UiModePreferenceScope {
  serverUrl?: string | null;
  organizationId: string;
  accountId: string;
}

const STORAGE_PREFIX = 'otto.ui-mode.v1';

function normalizeServerUrl(value: string | null | undefined): string {
  const normalized = value?.trim().replace(/\/+$/, '').toLowerCase();
  return normalized || 'local';
}

export function uiModeStorageKey(scope: UiModePreferenceScope): string {
  return [
    STORAGE_PREFIX,
    normalizeServerUrl(scope.serverUrl),
    scope.organizationId.trim() || 'personal',
    scope.accountId.trim() || 'anonymous',
  ].map(encodeURIComponent).join(':');
}

export function readUiModePreference(
  scope: UiModePreferenceScope,
  storage: Pick<Storage, 'getItem'> = window.localStorage,
): UiMode | null {
  try {
    const value = storage.getItem(uiModeStorageKey(scope));
    return value === 'conversational' || value === 'work' ? value : null;
  } catch {
    return null;
  }
}

export function writeUiModePreference(
  scope: UiModePreferenceScope,
  value: UiMode,
  storage: Pick<Storage, 'setItem'> = window.localStorage,
): boolean {
  try {
    storage.setItem(uiModeStorageKey(scope), value);
    return true;
  } catch {
    return false;
  }
}
