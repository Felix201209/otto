import { describe, expect, it, vi } from 'vitest';
import {
  readUiModePreference,
  uiModeStorageKey,
  writeUiModePreference,
} from './uiModePreference.js';

const scope = {
  serverUrl: 'HTTPS://example.com/',
  organizationId: 'org-1',
  accountId: 'account-1',
};

describe('UI mode preference', () => {
  it('isolates the preference by server, organization and account', () => {
    expect(uiModeStorageKey(scope)).not.toBe(uiModeStorageKey({
      ...scope,
      accountId: 'account-2',
    }));
    expect(uiModeStorageKey(scope)).toContain('https%3A%2F%2Fexample.com');
  });

  it('accepts only supported modes', () => {
    expect(readUiModePreference(scope, { getItem: () => 'work' })).toBe('work');
    expect(readUiModePreference(scope, { getItem: () => 'legacy' })).toBeNull();
  });

  it('does not break startup when local storage is unavailable', () => {
    expect(readUiModePreference(scope, { getItem: () => { throw new Error('blocked'); } })).toBeNull();
    expect(writeUiModePreference(scope, 'conversational', {
      setItem: () => { throw new Error('blocked'); },
    })).toBe(false);
  });

  it('persists a valid selection', () => {
    const setItem = vi.fn();
    expect(writeUiModePreference(scope, 'work', { setItem })).toBe(true);
    expect(setItem).toHaveBeenCalledWith(uiModeStorageKey(scope), 'work');
  });
});
