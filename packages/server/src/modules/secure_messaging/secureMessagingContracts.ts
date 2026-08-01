/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

export const OTTO_E2EE_PROTOCOL_ID = 'otto-mls-v1' as const;
export const OTTO_E2EE_TRUST_VERSION = 2 as const;

export type E2eeDeviceState =
  | 'pending'
  | 'approved'
  | 'revoked'
  | 'expired';

export interface E2eeAccountRootRegistration {
  protocolId: typeof OTTO_E2EE_PROTOCOL_ID;
  trustVersion: typeof OTTO_E2EE_TRUST_VERSION;
  organizationId: string;
  accountId: string;
  rootSigningPublicKey: string;
  recoveryPublicKey: string;
  issuedAt: string;
  nonce: string;
  signature: string;
  recoverySignature: string;
}

export interface E2eeDeviceRegistration {
  protocolId: typeof OTTO_E2EE_PROTOCOL_ID;
  trustVersion: typeof OTTO_E2EE_TRUST_VERSION;
  organizationId: string;
  accountId: string;
  deviceId: string;
  deviceName: string;
  signingPublicKey: string;
  mlsKeyPackage: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  signature: string;
  bootstrap?: E2eeBootstrapProof;
}

export interface E2eeBootstrapProof {
  type: 'bootstrap';
  organizationId: string;
  accountId: string;
  targetDeviceId: string;
  targetCredentialHash: string;
  issuedAt: string;
  nonce: string;
  signature: string;
}

export interface E2eeDeviceApprovalProof {
  type: 'approval';
  organizationId: string;
  accountId: string;
  actorDeviceId: string;
  targetDeviceId: string;
  targetCredentialHash: string;
  issuedAt: string;
  nonce: string;
  signature: string;
}

export interface E2eeDeviceRevocationProof {
  type: 'revocation';
  organizationId: string;
  accountId: string;
  actorDeviceId: string;
  targetDeviceId: string;
  targetCredentialHash: string;
  issuedAt: string;
  nonce: string;
  signature: string;
}

export type E2eeDeviceProof =
  | E2eeBootstrapProof
  | E2eeDeviceApprovalProof
  | E2eeDeviceRevocationProof;

export interface E2eeAccountRootView
  extends E2eeAccountRootRegistration {
  rootKeyId: string;
  transparencySequence: number;
}

export interface E2eeDeviceView extends E2eeDeviceRegistration {
  bootstrap?: undefined;
  credentialHash: string;
  state: E2eeDeviceState;
  transparencySequence: number;
}

export interface E2eeDeviceProofView {
  proofId: string;
  proof: E2eeDeviceProof;
  transparencySequence: number;
}

export type E2eeTransparencyEventKind =
  | 'account_root_registered'
  | 'device_registered'
  | 'device_bootstrapped'
  | 'device_approved'
  | 'device_revoked';

export interface E2eeTransparencyLeaf {
  accountSequence: number;
  kind: E2eeTransparencyEventKind;
  payload: unknown;
  leafHash: string;
}

export interface E2eeTransparencyCheckpoint {
  size: number;
  rootHash: string;
}

export interface E2eeTransparencyProofNode {
  position: 'left' | 'right';
  hash: string;
}

export interface E2eeTransparencyInclusionProof {
  accountSequence: number;
  checkpoint: E2eeTransparencyCheckpoint;
  nodes: E2eeTransparencyProofNode[];
}

export interface E2eeDeviceDirectorySnapshot {
  protocolId: typeof OTTO_E2EE_PROTOCOL_ID;
  trustVersion: typeof OTTO_E2EE_TRUST_VERSION;
  organizationId: string;
  accountId: string;
  root: E2eeAccountRootView;
  devices: E2eeDeviceView[];
  proofs: E2eeDeviceProofView[];
  transparency: {
    checkpoint: E2eeTransparencyCheckpoint;
    leaves: E2eeTransparencyLeaf[];
  };
}

export interface E2eeCapabilityStatus {
  protocolId: typeof OTTO_E2EE_PROTOCOL_ID;
  releaseState: 'foundation-only' | 'audited-disabled' | 'enabled';
  enabled: boolean;
  externalAuditCompleted: boolean;
  mlsEngineReady: boolean;
  reason: string;
}
