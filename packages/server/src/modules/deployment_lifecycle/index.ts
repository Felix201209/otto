/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * CONTROL-10 部署完整生命周期与身份轮换导出。
 */

export {
  DEPLOYMENT_STATES,
  isDeploymentUsable,
  isRegisteredOrLater,
  deploymentCanTransition,
  checkTransition,
  stateFromAuditEvent,
  DEPLOYMENT_AUDIT_EVENTS,
  type DeploymentState,
  type DeploymentTransition,
} from './deploymentLifecycleMachine.js';
export {
  rootIdentity,
  rotateIdentity,
  lineageFingerprint,
  isDescendantOf,
  buildRotationAudit,
  assertFingerprintMatches,
  type DeploymentKeyIdentity,
  type RotationAuditRecord,
} from './deploymentIdentityRotation.js';
export {
  buildBootstrapTokenPayload,
  signBootstrapToken,
  verifyBootstrapToken,
  validateNonceStrength,
  type BootstrapTokenBundled,
  type BootstrapTokenSigner,
  type BootstrapTokenVerdict,
  type BootstrapRejectReason,
} from './deploymentBootstrapToken.js';
export * from './privateDeploymentBootstrap.js';
