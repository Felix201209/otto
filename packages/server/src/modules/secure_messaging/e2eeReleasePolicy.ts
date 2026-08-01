/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  OTTO_E2EE_PROTOCOL_ID,
  type E2eeCapabilityStatus,
} from './secureMessagingContracts.js';

/**
 * The trust directory is production code, but message encryption stays dark
 * until an MLS engine, interoperability suite and external audit are complete.
 */
export const E2EE_CAPABILITY_STATUS: E2eeCapabilityStatus = Object.freeze({
  protocolId: OTTO_E2EE_PROTOCOL_ID,
  releaseState: 'foundation-only',
  enabled: false,
  externalAuditCompleted: false,
  mlsEngineReady: false,
  reason:
    'E2EE v2 device trust is under construction; encrypted messaging is not released',
});

export function assertE2eeMessagingReleased(): void {
  if (!E2EE_CAPABILITY_STATUS.enabled) {
    throw new Error(E2EE_CAPABILITY_STATUS.reason);
  }
}
