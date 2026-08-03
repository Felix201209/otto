/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';

import type {
  Database,
  EncryptedFieldCipher,
} from '../data_platform/index.js';
import {
  FederationGatewayClient,
  type FederationClientOptions,
} from './federationClient.js';
import type {
  FederationProvisioningManifest,
  FederationQueueInput,
} from './federationContracts.js';
import {
  loadOrCreateFederationSigner,
  type FederationPayloadSigner,
} from './federationCrypto.js';
import {
  blockFederationDeploymentInRepository,
  clearFederationClaimInRepository,
  consumeFederationInboxInRepository,
  getFederationQueueSummaryInRepository,
  getFederationRuntimeStateInRepository,
  listDueFederationOutboxInRepository,
  listFederationAcknowledgementsInRepository,
  listFederationBlocksInRepository,
  listFederationInboxInRepository,
  markFederationAcknowledgedInRepository,
  markFederationOutboxFailedInRepository,
  markFederationOutboxSentInRepository,
  queueFederationEnvelopeInRepository,
  revokeFederationA2aGrantInRepository,
  saveFederationA2aGrantInRepository,
  setFederationRuntimeStateInRepository,
  storeClaimedFederationEnvelopeInRepository,
  unblockFederationDeploymentInRepository,
  type FederationRepositoryStore,
} from './federationRepository.js';
import {
  runFederationCycle,
  startFederationRuntime,
} from './federationRuntime.js';

export interface FederationCompositionOptions {
  db(): Database;
  fieldCipher: EncryptedFieldCipher;
  deploymentId(): string;
  dataDirectory: string;
  enabled(): boolean;
  gatewayUrl(): string | null;
  publicOrigin(): string | null;
  displayName(): string;
  signingKeyPath?(): string | null;
  pollIntervalMs?(): number;
  fetch?: typeof fetch;
  now?(): number;
  signer?: FederationPayloadSigner;
  allowInsecureLoopback?: boolean;
}

function activeConfiguration(options: FederationCompositionOptions): {
  client: FederationGatewayClient;
  signer: FederationPayloadSigner;
} {
  if (!options.enabled()) throw new Error('federation gateway is disabled');
  const gatewayUrl = options.gatewayUrl();
  if (!gatewayUrl) throw new Error('federation gateway URL is not configured');
  const configuredKeyPath = options.signingKeyPath?.() || null;
  const signer = options.signer ?? loadOrCreateFederationSigner({
    keyPath: configuredKeyPath || path.join(
      options.dataDirectory,
      'federation-signing-key.pem',
    ),
    createIfMissing: configuredKeyPath === null,
  });
  const clientOptions: FederationClientOptions = {
    baseUrl: gatewayUrl,
    deploymentId: options.deploymentId(),
    signer,
    fetch: options.fetch,
    now: options.now,
    allowInsecureLoopback: options.allowInsecureLoopback,
  };
  return { signer, client: new FederationGatewayClient(clientOptions) };
}

export function createFederationComposition(
  options: FederationCompositionOptions,
) {
  const now = options.now ?? Date.now;
  const store: FederationRepositoryStore = {
    db: options.db,
    fieldCipher: options.fieldCipher,
    deploymentId: options.deploymentId,
    now,
  };
  let active: ReturnType<typeof activeConfiguration> | null = null;
  const getActive = () => {
    active ??= activeConfiguration(options);
    return active;
  };
  const runtimeServices = () => {
    const { client } = getActive();
    return {
      listDueOutbox: (limit?: number) =>
        listDueFederationOutboxInRepository(store, limit),
      sendSignedEnvelope: client.sendSignedEnvelope.bind(client),
      markOutboxSent: (messageId: string) =>
        markFederationOutboxSentInRepository(store, messageId),
      markOutboxFailed: (
        input: Parameters<typeof markFederationOutboxFailedInRepository>[1],
      ) => markFederationOutboxFailedInRepository(store, input),
      listAcknowledgements: (limit?: number) =>
        listFederationAcknowledgementsInRepository(store, limit),
      acknowledge: client.acknowledge.bind(client),
      markAcknowledged: (messageId: string) =>
        markFederationAcknowledgedInRepository(store, messageId),
      clearClaim: (messageId: string) =>
        clearFederationClaimInRepository(store, messageId),
      claim: client.claim.bind(client),
      storeClaimed: (
        claimed: Parameters<typeof storeClaimedFederationEnvelopeInRepository>[1],
      ) => storeClaimedFederationEnvelopeInRepository(store, claimed),
      setRuntimeState: (key: string, value: unknown) =>
        setFederationRuntimeStateInRepository(store, key, value),
    };
  };

  return {
    getFederationStatus() {
      const enabled = options.enabled();
      let configured = false;
      let keyId: string | null = null;
      let error: string | null = null;
      if (enabled) {
        try {
          const resolved = getActive();
          configured = true;
          keyId = resolved.signer.keyId;
        } catch (cause) {
          error = cause instanceof Error ? cause.message : String(cause);
        }
      }
      return {
        enabled,
        configured,
        deploymentId: options.deploymentId(),
        gatewayOrigin: configured ? getActive().client.gatewayOrigin : null,
        signingKeyId: keyId,
        queue: getFederationQueueSummaryInRepository(store),
        lastCycle: getFederationRuntimeStateInRepository(store, 'last_cycle'),
        lastError: error ?? getFederationRuntimeStateInRepository(store, 'last_error'),
        privacy: {
          gatewayPayload: 'e2ee-ciphertext-only',
          privateKeyLocation: 'customer-server-only',
        },
      };
    },
    getFederationProvisioningManifest(): FederationProvisioningManifest {
      const { client, signer } = getActive();
      const origin = options.publicOrigin();
      if (!origin) {
        throw new Error('enterprise public HTTPS origin is not configured');
      }
      const url = new URL(origin);
      if (
        url.protocol !== 'https:' || url.username || url.password ||
        url.search || url.hash || url.pathname !== '/'
      ) {
        throw new Error('enterprise public origin must be an HTTPS origin');
      }
      return {
        deployment: {
          id: options.deploymentId(),
          displayName: options.displayName(),
          origin: url.origin,
          capabilities: [...client.capabilities],
        },
        signingKey: {
          keyId: signer.keyId,
          publicKeyPem: signer.publicKeyPem,
        },
      };
    },
    async lookupFederationDeployment(deploymentId: string) {
      return getActive().client.directoryEntry(deploymentId);
    },
    async queueFederationMessage(input: FederationQueueInput) {
      const signed = await getActive().client.createSignedEnvelope(input);
      return queueFederationEnvelopeInRepository(store, signed);
    },
    listFederationInbox: (
      input: Parameters<typeof listFederationInboxInRepository>[1],
    ) => listFederationInboxInRepository(store, input),
    consumeFederationInbox: (
      input: Parameters<typeof consumeFederationInboxInRepository>[1],
    ) => consumeFederationInboxInRepository(store, input),
    async createFederationA2aGrant(input: {
      requesterDeploymentId: string;
      ownerPrincipalId: string;
      requesterPrincipalId: string;
      scopes: string[];
      expiresInMs?: number;
    }) {
      const grant = await getActive().client.createA2aGrant(input);
      saveFederationA2aGrantInRepository(store, {
        grantId: grant.id,
        requesterDeploymentId: input.requesterDeploymentId,
        ownerPrincipalId: input.ownerPrincipalId,
        requesterPrincipalId: input.requesterPrincipalId,
        scopes: input.scopes,
        expiresAt: grant.expiresAt,
      });
      return grant;
    },
    async revokeFederationA2aGrant(grantId: string) {
      await getActive().client.revokeA2aGrant(grantId);
      revokeFederationA2aGrantInRepository(store, grantId);
    },
    blockFederationDeployment: (
      input: Parameters<typeof blockFederationDeploymentInRepository>[1],
    ) => blockFederationDeploymentInRepository(store, input),
    unblockFederationDeployment: (deploymentId: string) =>
      unblockFederationDeploymentInRepository(store, deploymentId),
    listFederationBlocks: () => listFederationBlocksInRepository(store),
    runFederationCycle: () => runFederationCycle(runtimeServices()),
    startFederationRuntime() {
      if (!options.enabled()) return () => undefined;
      return startFederationRuntime(runtimeServices(), {
        intervalMs: options.pollIntervalMs?.(),
      });
    },
  };
}
