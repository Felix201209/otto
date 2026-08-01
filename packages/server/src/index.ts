/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * otto-server 包入口（barrel）。
 *
 * desktop 端经 `from 'otto-server'` 复用协议类型与服务类。
 */

export * from './protocol.js';
export * from './sessions.js';
export * from './sessions-persistent.js';
export { OttoServer } from './server.js';
export type { OttoServerOptions, RuntimeFactory } from './server.js';
export {
  createEnterpriseServer,
  startEnterpriseServer,
} from './enterprise/server.js';
export type { EnterpriseServerOptions } from './enterprise/server.js';
export { startConfiguredEnterpriseServer } from './enterprise/configuredServer.js';
export {
  bootstrapClusteredEnterpriseAdmin,
  createClusteredEnterpriseServer,
  startClusteredEnterpriseServer,
} from './enterprise/clusteredServer.js';
export type { ClusteredEnterpriseServerOptions } from './enterprise/clusteredServer.js';
export { createCoreConfig } from './coreConfig.js';
export type { CreateCoreConfigOptions } from './coreConfig.js';
export {
  createCoreSessionRuntime,
  CoreSessionRuntime,
} from './runtime.js';
export {
  loadCustomModels,
  listModelInfos,
  customModelsFilePath,
} from './customModels.js';
export * from './modelCatalog.js';
export * from './modules/commercial_control/index.js';
export * from './modules/data_platform/index.js';
export * from './modules/authorization/index.js';
export * from './modules/identity_organization/index.js';
export * from './modules/data_governance/index.js';
export * from './productModules.js';
export * from './productWorkspace.js';
export * from './productWorkspaceStore.js';
export * from './agentProfiles.js';
export type {
  FeishuRegistration,
  FeishuRegisterDeps,
} from './feishu/register.js';
export {
  canonicalE2eeBytes,
  E2EE_TRUST_FORMAT,
  E2EE_ATOA_GRANT_FORMAT,
  E2EE_ATOA_GRANT_MAX_LIFETIME_MS,
  E2eeAtoaGrantLedger,
  e2eeAtoaGrantDigest,
  e2eeAtoaGrantPayload,
  e2eeAtoaRequestDigest,
  e2eeDeviceCertificateApprovalPayload,
  e2eeDeviceCertificateHash,
  e2eeDeviceCertificateRequestHash,
  e2eeDeviceCertificateRequestPayload,
  e2eeMerkleInclusionProof,
  e2eeMerkleRoot,
  verifyE2eeAtoaOneTimeGrant,
  verifyE2eeDeviceCertificateApproval,
  verifyE2eeDeviceCertificateRequest,
  verifyE2eeMerkleAppendOnlySnapshot,
  verifyE2eeMerkleInclusion,
  type AtoaContextSource,
  type E2eeAtoaGrantExpectation,
  type E2eeAtoaOneTimeGrant,
  type E2eeDeviceCertificateApprovalV2,
  type E2eeDeviceCertificateRequestV2,
  type E2eeMerkleInclusionProof,
} from 'otto-core';
export { registerFeishu } from './feishu/register.js';
export {
  endpointFilePath,
  readEndpoint,
  readEndpointRecord,
  writeEndpoint,
  clearEndpoint,
} from './endpoint.js';
export type { ServerEndpointRecord } from './endpoint.js';
