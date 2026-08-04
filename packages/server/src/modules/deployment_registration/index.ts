/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * CONTROL-10 部署一次性安全注册模块导出。
 */

export * from './deploymentRegistrationTypes.js';
export {
  deriveInstanceFingerprint,
  buildBootstrapPayload,
  isBootstrapExpired,
  verifyExpectedMeta,
  verifyRegistration,
  canTransition,
  buildRegistrationRecord,
  describeStateMachine,
} from './deploymentRegistration.js';
export {
  isDeploymentRegistered,
  isNonceConsumed,
  getRegistration,
  getRegistrationIdentity,
  persistRegistration,
  type RegistrationStore,
  type StoredRegistration,
} from './deploymentRegistrationRepository.js';
export {
  generateInstanceIdentity,
  createInMemorySigning,
  identitySignMessage,
} from './deploymentRegistrationSigning.js';
export {
  createDeploymentRegistrar,
  type RegistrationDeps,
  type RegisterOutcome,
} from './deploymentRegistrationComposition.js';
