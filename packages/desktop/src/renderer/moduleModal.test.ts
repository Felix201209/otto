import { describe, expect, it } from 'vitest';

import {
  closeModuleModal,
  openModuleModal,
  resetModuleModalForScopeChange,
  type ModuleModalState,
} from './moduleModal.js';

describe('module modal coordinator', () => {
  it('keeps at most one business surface active', () => {
    const marketplace: ModuleModalState = { kind: 'marketplace', groupId: 'daily-office' };
    const memory: ModuleModalState = { kind: 'enterprise-memory' };

    expect(openModuleModal(null, marketplace)).toEqual(marketplace);
    expect(openModuleModal(marketplace, memory)).toEqual(memory);
    expect(closeModuleModal(memory)).toBeNull();
  });

  it('resets transient modal state when account, server, or organization scope changes', () => {
    expect(resetModuleModalForScopeChange({ kind: 'auto-skill' })).toBeNull();
    expect(resetModuleModalForScopeChange({
      kind: 'park',
      target: 'announcement',
    })).toBeNull();
  });
});
