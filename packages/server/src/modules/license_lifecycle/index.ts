/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * CONTROL-11 License 生命周期与信任轮换导出。
 */

export {
  LICENSE_STATES,
  isCapacityReduced,
  isLegitimateUpgrade,
  offlineDecision,
  realizeDowngrade,
  revocationPolicy,
  licenseCanTransition,
  type LicenseState,
  type LicenseEntitlementSnapshot,
} from './licenseLifecycleMachine.js';
export {
  isKeyIdTrusted,
  checkRollbackSequence,
  verifyKeylineage,
  deriveKeyId,
  type TrustedSigningKey,
  type LicenseRollbackGuard,
} from './licenseSigningKeyRotation.js';
export {
  decideLicenseChange,
  decideOffline,
  revokeNow,
  licenseAccessPolicy,
  validateSignedLicenseTrust,
  buildLicenseAuditDetail,
  type LicenseChangeOutcome,
} from './licenseLifecycleComposition.js';
