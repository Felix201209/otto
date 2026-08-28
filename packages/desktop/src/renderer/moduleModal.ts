/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { ParkModuleTarget } from './moduleCatalog.js';

export type ModuleModalState =
  | { kind: 'marketplace'; groupId: string }
  | { kind: 'park'; target: ParkModuleTarget }
  | { kind: 'enterprise-memory' }
  | { kind: 'auto-skill' }
  | { kind: 'custom-expert'; expertId?: string }
  | null;

export function openModuleModal(
  _current: ModuleModalState,
  next: Exclude<ModuleModalState, null>,
): ModuleModalState {
  return next;
}

export function closeModuleModal(_current: ModuleModalState): ModuleModalState {
  return null;
}

export function resetModuleModalForScopeChange(
  _current: ModuleModalState,
): ModuleModalState {
  return null;
}
