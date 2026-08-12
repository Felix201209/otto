/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

export const FEDERATION_PROTOCOL_VERSION = 1 as const;

export const FEDERATION_MESSAGE_TYPES = [
  'chat.message',
  'chat.receipt',
  'a2a.request',
  'a2a.response',
] as const;

export type FederationMessageType =
  (typeof FEDERATION_MESSAGE_TYPES)[number];

export interface FederationRoutingMetadata {
  conversationId: string;
  senderPrincipalId: string;
  recipientPrincipalId: string;
  inReplyTo?: string;
  a2aGrantId?: string;
  a2aScope?: string;
}

export interface FederationEnvelope {
  version: typeof FEDERATION_PROTOCOL_VERSION;
  messageId: string;
  type: FederationMessageType;
  senderDeploymentId: string;
  recipientDeploymentId: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  contentType: 'application/otto-e2ee+json';
  ciphertext: string;
  routing: FederationRoutingMetadata;
}

export interface SignedFederationEnvelope {
  envelope: FederationEnvelope;
  signingKeyId: string;
  signature: string;
}

export interface FederationSignedRequest<T extends Record<string, unknown>> {
  request: T & {
    version: typeof FEDERATION_PROTOCOL_VERSION;
    deploymentId: string;
    issuedAt: string;
    expiresAt: string;
    nonce: string;
  };
  signingKeyId: string;
  signature: string;
}

export interface FederationDirectoryEntry {
  id: string;
  displayName: string;
  origin: string;
  status: 'active';
  capabilities: string[];
  maxPendingMessages: number;
  maxPendingBytes: number;
  maxRequestsPerMinute: number;
  createdAt: string;
  updatedAt: string;
}

export interface FederationDirectoryKey {
  deploymentId: string;
  keyId: string;
  publicKeyPem: string;
  notBefore: string;
  expiresAt: string | null;
}

export interface ClaimedFederationEnvelope {
  signed: SignedFederationEnvelope;
  claimToken: string;
}

export interface FederationQueueInput {
  recipientDeploymentId: string;
  type: FederationMessageType;
  ciphertext: string;
  routing: FederationRoutingMetadata;
  messageId?: string;
  expiresInMs?: number;
}

export interface FederationInboxMessageView {
  cursor: number;
  messageId: string;
  type: FederationMessageType;
  senderDeploymentId: string;
  issuedAt: string;
  expiresAt: string;
  ciphertext: string;
  routing: FederationRoutingMetadata;
  signingKeyId: string;
  signature: string;
  gatewayAcknowledged: boolean;
  consumedAt: string | null;
  receivedAt: string;
}

export interface FederationProvisioningManifest {
  deployment: {
    id: string;
    displayName: string;
    origin: string;
    capabilities: string[];
  };
  signingKey: {
    keyId: string;
    publicKeyPem: string;
  };
}

export interface FederationChatContactView {
  id: string;
  identity: string;
  remoteDeploymentId: string;
  remotePrincipalId: string;
  displayName: string;
  deploymentDisplayName: string;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
  unreadCount: number;
}

export interface FederationChatMessageView extends FederationInboxMessageView {
  contactId: string;
  direction: 'inbound' | 'outbound';
  deliveryStatus: 'queued' | 'sent' | 'failed' | 'expired' | 'received';
  readAt: string | null;
}
