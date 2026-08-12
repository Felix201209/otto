/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createEncryptedFieldCipher,
  Database,
} from '../data_platform/index.js';
import { FederationGatewayClient } from './federationClient.js';
import { createFederationComposition } from './federationComposition.js';
import type {
  FederationSignedRequest,
  SignedFederationEnvelope,
} from './federationContracts.js';
import {
  LocalFederationSigner,
  verifyFederationEnvelopeSignature,
} from './federationCrypto.js';
import { FEDERATION_GATEWAY_SCHEMA_CONTRIBUTOR } from './federationSchema.js';

interface GatewayDeployment {
  signer: LocalFederationSigner;
  revoked: boolean;
}

interface GatewayMessage extends SignedFederationEnvelope {
  delivered: boolean;
}

class FakeFederationGateway {
  readonly deployments = new Map<string, GatewayDeployment>();
  readonly messages = new Map<string, GatewayMessage>();
  readonly grants = new Map<string, {
    ownerDeploymentId: string;
    requesterDeploymentId: string;
    ownerPrincipalId: string;
    requesterPrincipalId: string;
    scopes: string[];
    expiresAt: string;
    used: boolean;
    revoked: boolean;
  }>();
  offline = false;
  failNextAcknowledgement = false;

  register(deploymentId: string, signer: LocalFederationSigner): void {
    this.deployments.set(deploymentId, { signer, revoked: false });
  }

  fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    if (this.offline) throw new Error('network offline');
    const url = new URL(
      typeof input === 'string' || input instanceof URL ? input : input.url,
    );
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    const json = (status: number, payload: unknown) => new Response(
      JSON.stringify(payload),
      { status, headers: { 'content-type': 'application/json' } },
    );

    const keyMatch = /^\/v1\/federation\/directory\/([^/]+)\/keys\/([^/]+)$/u
      .exec(url.pathname);
    if (method === 'GET' && keyMatch) {
      const deploymentId = decodeURIComponent(keyMatch[1]!);
      const keyId = decodeURIComponent(keyMatch[2]!);
      const deployment = this.deployments.get(deploymentId);
      if (!deployment || deployment.revoked || deployment.signer.keyId !== keyId) {
        return json(404, { error: { message: 'key not found' } });
      }
      return json(200, {
        deploymentId,
        keyId,
        publicKeyPem: deployment.signer.publicKeyPem,
        notBefore: '2026-01-01T00:00:00.000Z',
        expiresAt: null,
      });
    }
    const directoryMatch = /^\/v1\/federation\/directory\/([^/]+)$/u
      .exec(url.pathname);
    if (method === 'GET' && directoryMatch) {
      const id = decodeURIComponent(directoryMatch[1]!);
      const deployment = this.deployments.get(id);
      if (!deployment || deployment.revoked) {
        return json(404, { error: { message: 'deployment not found' } });
      }
      return json(200, {
        id,
        displayName: id,
        origin: `https://${id}.example.com`,
        status: 'active',
        capabilities: ['federation.v1', 'chat.e2ee', 'a2a.e2ee'],
        maxPendingMessages: 10_000,
        maxPendingBytes: 1024 ** 3,
        maxRequestsPerMinute: 1_200,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
    }
    if (method === 'GET' && url.pathname === '/v1/federation/status') {
      return json(200, {
        protocolVersion: 1,
        privacy: { payloadStorage: 'ciphertext-only' },
      });
    }
    if (method === 'POST' && url.pathname === '/v1/federation/envelopes') {
      const signed = body as SignedFederationEnvelope;
      const sender = this.deployments.get(signed.envelope.senderDeploymentId);
      const recipient = this.deployments.get(signed.envelope.recipientDeploymentId);
      if (!sender || sender.revoked || !recipient || recipient.revoked) {
        return json(403, {
          error: { code: 'FORBIDDEN', message: 'deployment disabled' },
        });
      }
      try {
        verifyFederationEnvelopeSignature({
          payload: signed.envelope,
          signature: signed.signature,
          publicKeyPem: sender.signer.publicKeyPem,
        });
      } catch (error) {
        return json(401, { error: { message: String(error) } });
      }
      if (signed.envelope.type === 'a2a.request') {
        const grant = this.grants.get(signed.envelope.routing.a2aGrantId || '');
        if (
          !grant || grant.revoked || grant.used ||
          grant.ownerDeploymentId !== signed.envelope.recipientDeploymentId ||
          grant.requesterDeploymentId !== signed.envelope.senderDeploymentId ||
          grant.ownerPrincipalId !== signed.envelope.routing.recipientPrincipalId ||
          grant.requesterPrincipalId !== signed.envelope.routing.senderPrincipalId ||
          !grant.scopes.includes(signed.envelope.routing.a2aScope || '')
        ) {
          return json(403, {
            error: { code: 'FORBIDDEN', message: 'A2A grant rejected' },
          });
        }
        grant.used = true;
      }
      const duplicate = this.messages.has(signed.envelope.messageId);
      if (!duplicate) {
        this.messages.set(signed.envelope.messageId, {
          ...signed,
          delivered: false,
        });
      }
      return json(202, {
        accepted: true,
        duplicate,
        messageId: signed.envelope.messageId,
        status: 'pending',
      });
    }
    if (method === 'POST' && url.pathname === '/v1/federation/inbox/claim') {
      const signed = body as FederationSignedRequest<Record<string, unknown>>;
      if (!this.verifyRequest(signed)) {
        return json(401, { error: { message: 'request signature invalid' } });
      }
      const messages = [...this.messages.values()]
        .filter((message) =>
          !message.delivered &&
          message.envelope.recipientDeploymentId === signed.request.deploymentId,
        )
        .slice(0, Number(signed.request.limit || 20))
        .map((message) => ({
          envelope: message.envelope,
          signingKeyId: message.signingKeyId,
          signature: message.signature,
          claimToken: `claim_${message.envelope.messageId}`,
        }));
      return json(200, { messages });
    }
    if (method === 'POST' && url.pathname === '/v1/federation/inbox/ack') {
      if (this.failNextAcknowledgement) {
        this.failNextAcknowledgement = false;
        return json(503, { error: { message: 'temporary ack failure' } });
      }
      const signed = body as FederationSignedRequest<Record<string, unknown>>;
      if (!this.verifyRequest(signed)) {
        return json(401, { error: { message: 'request signature invalid' } });
      }
      const message = this.messages.get(String(signed.request.messageId));
      if (
        !message || message.delivered ||
        signed.request.claimToken !== `claim_${message.envelope.messageId}`
      ) {
        return json(409, { error: { message: 'claim expired' } });
      }
      message.delivered = true;
      return json(200, { delivered: true });
    }
    if (method === 'POST' && url.pathname === '/v1/federation/a2a/grants') {
      const signed = body as FederationSignedRequest<Record<string, unknown>>;
      if (!this.verifyRequest(signed)) {
        return json(401, { error: { message: 'request signature invalid' } });
      }
      const id = String(signed.request.grantId || `fgrant_${this.grants.size + 1}`);
      const grant = {
        ownerDeploymentId: signed.request.deploymentId,
        requesterDeploymentId: String(signed.request.requesterDeploymentId),
        ownerPrincipalId: String(signed.request.ownerPrincipalId),
        requesterPrincipalId: String(signed.request.requesterPrincipalId),
        scopes: signed.request.scopes as string[],
        expiresAt: String(signed.request.grantExpiresAt),
        used: false,
        revoked: false,
      };
      this.grants.set(id, grant);
      return json(201, {
        id,
        expiresAt: grant.expiresAt,
        maxUses: 1,
        usedCount: 0,
      });
    }
    if (
      method === 'POST' &&
      url.pathname === '/v1/federation/a2a/grants/revoke'
    ) {
      const signed = body as FederationSignedRequest<Record<string, unknown>>;
      const grant = this.grants.get(String(signed.request.grantId));
      if (!this.verifyRequest(signed) || !grant) {
        return json(404, { error: { message: 'grant not found' } });
      }
      grant.revoked = true;
      return json(200, { revoked: true });
    }
    return json(404, { error: { message: 'not found' } });
  };

  private verifyRequest(
    signed: FederationSignedRequest<Record<string, unknown>>,
  ): boolean {
    const deployment = this.deployments.get(signed.request.deploymentId);
    if (!deployment || deployment.revoked) return false;
    try {
      verifyFederationEnvelopeSignature({
        payload: signed.request,
        signature: signed.signature,
        publicKeyPem: deployment.signer.publicKeyPem,
      });
      return signed.signingKeyId === deployment.signer.keyId;
    } catch {
      return false;
    }
  }
}

function signer(): LocalFederationSigner {
  const { privateKey } = generateKeyPairSync('ed25519');
  return new LocalFederationSigner(
    privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  );
}

function database(): Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'active',
      deleted_at TEXT
    );
  `);
  FEDERATION_GATEWAY_SCHEMA_CONTRIBUTOR.apply(db);
  return db;
}

function cipher() {
  return createEncryptedFieldCipher({
    keyProvider: {
      getKey: () => Buffer.alloc(32, 7),
      clear: () => undefined,
    },
  });
}

describe('federation composition', () => {
  const databases: Database[] = [];
  afterEach(() => {
    databases.splice(0).forEach((db) => db.close());
  });

  function deployment(
    id: string,
    gateway: FakeFederationGateway,
    deploymentSigner: LocalFederationSigner,
    clock: { now: number } = {
      now: Date.parse('2026-08-03T00:00:00.000Z'),
    },
  ) {
    const db = database();
    databases.push(db);
    gateway.register(id, deploymentSigner);
    return {
      db,
      service: createFederationComposition({
        db: () => db,
        fieldCipher: cipher(),
        deploymentId: () => id,
        dataDirectory: '.',
        enabled: () => true,
        gatewayUrl: () => 'http://127.0.0.1:7790',
        publicOrigin: () => `https://${id}.example.com`,
        displayName: () => id,
        fetch: gateway.fetch as typeof fetch,
        signer: deploymentSigner,
        allowInsecureLoopback: true,
        now: () => clock.now,
      }),
    };
  }

  function account(db: Database, id: string): void {
    db.prepare('INSERT INTO accounts (id) VALUES (?)').run(id);
  }

  it('delivers opaque E2EE messages and attachments exactly once after an ack retry', async () => {
    const gateway = new FakeFederationGateway();
    const alice = deployment('deployment_alice', gateway, signer());
    const bob = deployment('deployment_bob', gateway, signer());
    account(alice.db, 'account_alice');
    account(bob.db, 'account_bob');
    const ciphertext = Buffer.from(JSON.stringify({
      message: 'encrypted-message-bytes',
      attachments: ['encrypted-word-document', 'encrypted-image'],
    })).toString('base64url');

    await alice.service.queueFederationMessage({
      recipientDeploymentId: 'deployment_bob',
      type: 'chat.message',
      ciphertext,
      routing: {
        conversationId: 'conversation_federated',
        senderPrincipalId: 'account_alice',
        recipientPrincipalId: 'account_bob',
      },
    });
    await expect(alice.service.runFederationCycle()).resolves.toMatchObject({
      sent: 1,
    });

    gateway.failNextAcknowledgement = true;
    await expect(bob.service.runFederationCycle()).resolves.toMatchObject({
      received: 1,
      acknowledgementFailed: 1,
    });
    const firstInbox = bob.service.listFederationInbox({
      recipientPrincipalId: 'account_bob',
    });
    expect(firstInbox).toHaveLength(1);
    expect(firstInbox[0]?.ciphertext).toBe(ciphertext);
    const rawClaim = bob.db.prepare(
      `SELECT claim_token_ciphertext FROM federation_inbox`,
    ).get() as { claim_token_ciphertext: string };
    expect(rawClaim.claim_token_ciphertext).not.toContain('claim_');

    await expect(bob.service.runFederationCycle()).resolves.toMatchObject({
      received: 0,
      acknowledged: 1,
    });
    expect(bob.service.listFederationInbox({
      recipientPrincipalId: 'account_bob',
    })).toHaveLength(1);
    expect(gateway.messages.values().next().value?.delivered).toBe(true);
    expect(bob.service.listFederationChatContacts('account_bob')).toEqual([
      expect.objectContaining({
        identity: 'deployment_alice:account_alice',
        unreadCount: 1,
      }),
    ]);
  });

  it('keeps ciphertext durable while offline and delivers it once after reconnect', async () => {
    const gateway = new FakeFederationGateway();
    const clock = { now: Date.parse('2026-08-03T00:00:00.000Z') };
    const alice = deployment('deployment_alice', gateway, signer(), clock);
    const bob = deployment('deployment_bob', gateway, signer(), clock);
    account(alice.db, 'account_alice');
    account(bob.db, 'account_bob');
    await alice.service.queueFederationMessage({
      messageId: 'fmsg_offline_recovery',
      recipientDeploymentId: 'deployment_bob',
      type: 'chat.message',
      ciphertext: 'ZW5jcnlwdGVkLW9mZmxpbmU',
      routing: {
        conversationId: 'conversation_offline_recovery',
        senderPrincipalId: 'account_alice',
        recipientPrincipalId: 'account_bob',
      },
    });

    gateway.offline = true;
    await expect(alice.service.runFederationCycle()).resolves.toMatchObject({
      sendFailed: 1,
    });
    expect(alice.service.getFederationStatus()).toMatchObject({
      queue: { outboxQueued: 1, outboxFailed: 0 },
    });
    expect(bob.service.listFederationInbox({
      recipientPrincipalId: 'account_bob',
    })).toEqual([]);

    gateway.offline = false;
    clock.now += 60_000;
    await expect(alice.service.runFederationCycle()).resolves.toMatchObject({ sent: 1 });
    await expect(bob.service.runFederationCycle()).resolves.toMatchObject({ received: 1 });
    await expect(bob.service.runFederationCycle()).resolves.toMatchObject({ received: 0 });
    expect(bob.service.listFederationInbox({
      recipientPrincipalId: 'account_bob',
    })).toEqual([
      expect.objectContaining({ messageId: 'fmsg_offline_recovery' }),
    ]);
  });

  it('projects outbound chat through an account-owned contact without mixing local ids', async () => {
    const gateway = new FakeFederationGateway();
    const alice = deployment('deployment_alice', gateway, signer());
    deployment('deployment_bob', gateway, signer());
    account(alice.db, 'account_alice');
    const contact = await alice.service.saveFederationChatContact({
      ownerAccountId: 'account_alice',
      remoteDeploymentId: 'deployment_bob',
      remotePrincipalId: 'account_bob',
      displayName: 'Bob',
    });
    await alice.service.queueFederationChatMessage({
      ownerAccountId: 'account_alice',
      contactId: contact.id,
      ciphertext: 'ZW5jcnlwdGVkLWNoYXQ',
      messageId: 'fmessage_chat_one',
    });
    expect(alice.service.listFederationChatMessages({
      ownerAccountId: 'account_alice',
      contactId: contact.id,
    })).toEqual([
      expect.objectContaining({
        messageId: 'fmessage_chat_one',
        direction: 'outbound',
        deliveryStatus: 'queued',
        routing: expect.objectContaining({
          senderPrincipalId: 'account_alice',
          recipientPrincipalId: 'account_bob',
        }),
      }),
    ]);
    expect(() => alice.service.listFederationChatMessages({
      ownerAccountId: 'account_other',
      contactId: contact.id,
    })).toThrow('contact was not found');
  });

  it('fails closed after deployment revocation and does not retry permanent denials', async () => {
    const gateway = new FakeFederationGateway();
    const alice = deployment('deployment_alice', gateway, signer());
    deployment('deployment_bob', gateway, signer());
    gateway.deployments.get('deployment_alice')!.revoked = true;
    await alice.service.queueFederationMessage({
      recipientDeploymentId: 'deployment_bob',
      type: 'chat.message',
      ciphertext: 'ZW5jcnlwdGVk',
      routing: {
        conversationId: 'conversation_revoked',
        senderPrincipalId: 'account_alice',
        recipientPrincipalId: 'account_bob',
      },
    });
    await expect(alice.service.runFederationCycle()).resolves.toMatchObject({
      sendFailed: 1,
    });
    await expect(alice.service.runFederationCycle()).resolves.toMatchObject({
      sent: 0,
      sendFailed: 0,
    });
    expect(alice.service.getFederationStatus()).toMatchObject({
      queue: {
        outboxQueued: 0,
        outboxFailed: 1,
      },
    });
  });

  it('enforces one-time scoped A2A grants at the gateway and recipient store', async () => {
    const gateway = new FakeFederationGateway();
    const alice = deployment('deployment_alice', gateway, signer());
    const bob = deployment('deployment_bob', gateway, signer());
    const grant = await bob.service.createFederationA2aGrant({
      requesterDeploymentId: 'deployment_alice',
      ownerPrincipalId: 'account_bob',
      requesterPrincipalId: 'account_alice',
      scopes: ['worklog.read'],
    });

    for (const messageId of ['fmsg_atoa_first', 'fmsg_atoa_replay']) {
      await alice.service.queueFederationMessage({
        messageId,
        recipientDeploymentId: 'deployment_bob',
        type: 'a2a.request',
        ciphertext: 'ZW5jcnlwdGVkLWEyYS1yZXF1ZXN0',
        routing: {
          conversationId: 'conversation_atoa',
          senderPrincipalId: 'account_alice',
          recipientPrincipalId: 'account_bob',
          a2aGrantId: grant.id,
          a2aScope: 'worklog.read',
        },
      });
    }
    await expect(alice.service.runFederationCycle()).resolves.toMatchObject({
      sent: 1,
      sendFailed: 1,
    });
    await expect(bob.service.runFederationCycle()).resolves.toMatchObject({
      received: 1,
    });
    expect(bob.service.listFederationInbox({
      recipientPrincipalId: 'account_bob',
    })).toHaveLength(1);
  });

  it('durably discards and acknowledges messages from a locally blocked deployment', async () => {
    const gateway = new FakeFederationGateway();
    const alice = deployment('deployment_alice', gateway, signer());
    const bob = deployment('deployment_bob', gateway, signer());
    bob.service.blockFederationDeployment({
      deploymentId: 'deployment_alice',
      reason: 'security incident',
    });
    await alice.service.queueFederationMessage({
      recipientDeploymentId: 'deployment_bob',
      type: 'chat.message',
      ciphertext: 'ZW5jcnlwdGVkLWJsb2NrZWQ',
      routing: {
        conversationId: 'conversation_blocked',
        senderPrincipalId: 'account_alice',
        recipientPrincipalId: 'account_bob',
      },
    });
    await alice.service.runFederationCycle();
    await expect(bob.service.runFederationCycle()).resolves.toMatchObject({
      discarded: 1,
      acknowledged: 1,
    });
    expect(bob.service.listFederationInbox({
      recipientPrincipalId: 'account_bob',
    })).toEqual([]);
  });

  it('discards an invalid A2A request without poisoning later inbox claims', async () => {
    const gateway = new FakeFederationGateway();
    const aliceSigner = signer();
    const bob = deployment('deployment_bob', gateway, signer());
    gateway.register('deployment_alice', aliceSigner);
    const signed = await new FederationGatewayClient({
        baseUrl: 'http://127.0.0.1:7790',
        deploymentId: 'deployment_alice',
        signer: aliceSigner,
        fetch: gateway.fetch as typeof fetch,
        allowInsecureLoopback: true,
        now: () => Date.parse('2026-08-03T00:00:00.000Z'),
      }).createSignedEnvelope({
        messageId: 'fmsg_invalid_a2a',
        recipientDeploymentId: 'deployment_bob',
        type: 'a2a.request',
        ciphertext: 'ZW5jcnlwdGVkLWludmFsaWQtYTJh',
        routing: {
          conversationId: 'conversation_invalid_a2a',
          senderPrincipalId: 'account_alice',
          recipientPrincipalId: 'account_bob',
          a2aGrantId: 'fgrant_missing',
          a2aScope: 'worklog.read',
        },
      });
    gateway.messages.set(signed.envelope.messageId, {
      ...signed,
      delivered: false,
    });

    await expect(bob.service.runFederationCycle()).resolves.toMatchObject({
      discarded: 1,
      acknowledged: 1,
    });
    expect(gateway.messages.get('fmsg_invalid_a2a')?.delivered).toBe(true);
    expect(bob.service.listFederationInbox({
      recipientPrincipalId: 'account_bob',
    })).toEqual([]);
  });

  it('fails closed when a gateway returns a signed envelope outside the protocol', async () => {
    const gateway = new FakeFederationGateway();
    const aliceSigner = signer();
    const bob = deployment('deployment_bob', gateway, signer());
    gateway.register('deployment_alice', aliceSigner);
    const client = new FederationGatewayClient({
      baseUrl: 'http://127.0.0.1:7790',
      deploymentId: 'deployment_alice',
      signer: aliceSigner,
      fetch: gateway.fetch as typeof fetch,
      allowInsecureLoopback: true,
      now: () => Date.parse('2026-08-03T00:00:00.000Z'),
    });
    const signed = await client.createSignedEnvelope({
      messageId: 'fmsg_invalid_protocol',
      recipientDeploymentId: 'deployment_bob',
      type: 'chat.message',
      ciphertext: 'ZW5jcnlwdGVkLW1lc3NhZ2U',
      routing: {
        conversationId: 'conversation_invalid_protocol',
        senderPrincipalId: 'account_alice',
        recipientPrincipalId: 'account_bob',
      },
    });
    const invalidEnvelope = {
      ...signed.envelope,
      contentType: 'text/plain',
    } as typeof signed.envelope;
    gateway.messages.set(signed.envelope.messageId, {
      envelope: invalidEnvelope,
      signingKeyId: aliceSigner.keyId,
      signature: await aliceSigner.sign(invalidEnvelope),
      delivered: false,
    });

    await expect(bob.service.runFederationCycle()).resolves.toMatchObject({
      received: 0,
      acknowledged: 0,
    });
    expect(bob.service.listFederationInbox({
      recipientPrincipalId: 'account_bob',
    })).toEqual([]);
    expect(bob.service.getFederationStatus()).toMatchObject({
      lastError: {
        operation: 'claim',
        message: expect.stringContaining('content type'),
      },
    });
    expect(gateway.messages.get('fmsg_invalid_protocol')?.delivered).toBe(false);
  });
});
