/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Generated from security/e2ee-release-status.json. Production MLS must stay
 * disabled until the external audit and two-role signed approval pass the
 * repository release gate.
 */

export const E2EE_PRODUCTION_RELEASE_POLICY = Object.freeze({
  enabled: false,
  protocolId: "mls10-openmls-0.8-candidate",
  approvalDigest: null,
});

export function e2eeProductionCapabilities(): string[] {
  return E2EE_PRODUCTION_RELEASE_POLICY.enabled ? ['e2ee_mls_v1'] : [];
}
