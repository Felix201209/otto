import { describe, expect, it, vi } from 'vitest';
import {
  readRightPanelCollapsed,
  rightPanelStorageKey,
  writeRightPanelCollapsed,
} from './rightPanelPreference.js';

const scope = {
  serverUrl: 'HTTPS://example.com/',
  organizationId: 'org-1',
  accountId: 'account-1',
};

describe('right panel preference', () => {
  it('isolates the preference by server, organization and account', () => {
    expect(rightPanelStorageKey(scope)).not.toBe(rightPanelStorageKey({
      ...scope,
      accountId: 'account-2',
    }));
    expect(rightPanelStorageKey(scope)).toContain('https%3A%2F%2Fexample.com');
  });

  it('uses stable fallbacks for an incomplete personal scope', () => {
    expect(rightPanelStorageKey({
      serverUrl: '   ',
      organizationId: '   ',
      accountId: '   ',
    })).toBe('otto.right-panel.v1:local:personal:anonymous');
  });

  it('defaults to expanded for missing or invalid values', () => {
    expect(readRightPanelCollapsed(scope, { getItem: () => null })).toBe(false);
    expect(readRightPanelCollapsed(scope, { getItem: () => 'legacy' })).toBe(false);
    expect(readRightPanelCollapsed(scope, { getItem: () => 'expanded' })).toBe(false);
    expect(readRightPanelCollapsed(scope, { getItem: () => 'collapsed' })).toBe(true);
  });

  it('does not break startup when local storage is unavailable', () => {
    expect(readRightPanelCollapsed(scope, {
      getItem: () => { throw new Error('blocked'); },
    })).toBe(false);
    expect(writeRightPanelCollapsed(scope, true, {
      setItem: () => { throw new Error('blocked'); },
    })).toBe(false);
  });

  it('persists both collapsed and expanded states', () => {
    const setItem = vi.fn();
    expect(writeRightPanelCollapsed(scope, true, { setItem })).toBe(true);
    expect(writeRightPanelCollapsed(scope, false, { setItem })).toBe(true);
    expect(setItem).toHaveBeenNthCalledWith(1, rightPanelStorageKey(scope), 'collapsed');
    expect(setItem).toHaveBeenNthCalledWith(2, rightPanelStorageKey(scope), 'expanded');
  });
});
