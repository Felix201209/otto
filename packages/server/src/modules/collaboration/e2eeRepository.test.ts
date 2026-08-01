/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  E2EE_TRUST_FORMAT,
  e2eeDeviceCertificateApprovalPayload,
  e2eeDeviceCertificateRequestPayload,
  type E2eeDeviceCertificateApprovalV2,
  type E2eeDeviceCertificateRequestV2,
} from 'otto-core';

import {
  applyDatabaseSchemaContributors,
  Database,
} from '../data_platform/index.js';
import { COLLABORATION_SCHEMA_CONTRIBUTOR } from './collaborationSchema.js';
import {
  E2EE_PROTOCOL_VERSION,
  createE2eeFacade,
  e2eeMessageSignaturePayload,
  type E2eeMessageEnvelope,
  type SendE2eeDirectMessageInput,
} from './e2eeRepository.js';

function publicPem(
  key: ReturnType<typeof generateKeyPairSync>['publicKey'],
): string {
  return key.export({ type: 'spki', format: 'pem' }).toString();
}

function signedCertificateRequest(input: {
  accountId: string;
  deviceId: string;
  deviceName: string;
  deploymentId?: string;
  signing: ReturnType<typeof generateKeyPairSync>;
  exchange: ReturnType<typeof generateKeyPairSync>;
}): E2eeDeviceCertificateRequestV2 {
  const unsigned: E2eeDeviceCertificateRequestV2 = {
    format: E2EE_TRUST_FORMAT,
    deploymentId: input.deploymentId ?? 'deployment-test',
    organizationId: 'org-a',
    accountId: input.accountId,
    deviceId: input.deviceId,
    certificateSerial: `certificate-${input.deviceId}`,
    deviceName: input.deviceName,
    credentialSigningPublicKey: publicPem(input.signing.publicKey),
    deviceExchangePublicKey: publicPem(input.exchange.publicKey),
    predecessorCertificateHash: null,
    proofOfPossession: '',
  };
  return {
    ...unsigned,
    proofOfPossession: sign(
      null,
      e2eeDeviceCertificateRequestPayload(unsigned),
      input.signing.privateKey,
    ).toString('base64'),
  };
}

function createDatabase(): Database {
  const database = new Database(':memory:');
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE organizations (id TEXT PRIMARY KEY);
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      FOREIGN KEY (organization_id) REFERENCES organizations(id)
    );
    INSERT INTO organizations (id) VALUES ('org-a'), ('org-b');
    INSERT INTO accounts (id, organization_id, name, status) VALUES
      ('alice', 'org-a', 'Alice', 'active'),
      ('bob', 'org-a', 'Bob', 'active'),
      ('carol', 'org-a', 'Carol', 'active'),
      ('mallory', 'org-b', 'Mallory', 'active');
  `);
  applyDatabaseSchemaContributors(database, [COLLABORATION_SCHEMA_CONTRIBUTOR]);
  return database;
}

function createHarness() {
  const database = createDatabase();
  const facade = createE2eeFacade({
    db: () => database,
    getDeploymentId: () => 'deployment-test',
    getActiveAccountInOrganization(accountId, organizationId) {
      return (
        (database
          .prepare(
            `SELECT id, name FROM accounts
         WHERE id = ? AND organization_id = ? AND status = 'active'`,
          )
          .get(accountId, organizationId) as
          { id: string; name: string } | undefined) ?? null
      );
    },
  });
  const devices = new Map<string, ReturnType<typeof generateKeyPairSync>>();
  const register = (accountId: string, deviceId: string) => {
    const signing = generateKeyPairSync('ed25519');
    const exchange = generateKeyPairSync('x25519');
    devices.set(`${accountId}:${deviceId}:signing`, signing);
    const deviceName = `${accountId} laptop`;
    const certificateRequest = signedCertificateRequest({
      accountId,
      deviceId,
      deviceName,
      signing,
      exchange,
    });
    const view = facade.registerE2eeDevice({
      organizationId: 'org-a',
      accountId,
      deviceId,
      deviceName,
      identitySigningPublicKey: publicPem(signing.publicKey),
      deviceExchangePublicKey: publicPem(exchange.publicKey),
      certificateRequest,
    });
    return { signing, exchange, view };
  };
  const envelope = (
    accountId: string,
    deviceId: string,
  ): E2eeMessageEnvelope => ({
    accountId,
    deviceId,
    ephemeralPublicKey: publicPem(generateKeyPairSync('x25519').publicKey),
    wrappedKey: Buffer.alloc(48, deviceId.charCodeAt(0)).toString('base64'),
    nonce: Buffer.alloc(12, accountId.charCodeAt(0)).toString('base64'),
  });
  const approve = (
    accountId: string,
    approverDeviceId: string,
    targetDeviceId: string,
    signerDeviceId = approverDeviceId,
  ) => {
    const target = facade
      .listE2eeDevices({
        organizationId: 'org-a',
        requesterAccountId: accountId,
        accountIds: [accountId],
        includePending: true,
      })
      .find((device) => device.deviceId === targetDeviceId);
    const signing = devices.get(`${accountId}:${signerDeviceId}:signing`);
    if (!target || !signing) throw new Error('test approval device is missing');
    const approver = facade
      .listE2eeDevices({
        organizationId: 'org-a',
        requesterAccountId: accountId,
        accountIds: [accountId],
        includePending: true,
      })
      .find((device) => device.deviceId === approverDeviceId);
    if (!approver?.certificateHash || !target.certificateRequest) {
      throw new Error('test certificate device is missing');
    }
    const { proofOfPossession: _proof, ...request } = target.certificateRequest;
    const unsigned: E2eeDeviceCertificateApprovalV2 = {
      format: E2EE_TRUST_FORMAT,
      request,
      approverDeviceId,
      approverCertificateHash: approver.certificateHash,
      approvedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      approvalSignature: '',
    };
    return facade.approveE2eeDevice({
      organizationId: 'org-a',
      accountId,
      approval: {
        ...unsigned,
        approvalSignature: sign(
        null,
        e2eeDeviceCertificateApprovalPayload(unsigned),
        signing.privateKey,
      ).toString('base64'),
      },
    });
  };
  const signedMessage = (
    overrides: Partial<SendE2eeDirectMessageInput> = {},
  ) => {
    const unsigned: Omit<SendE2eeDirectMessageInput, 'signature'> = {
      organizationId: 'org-a',
      senderAccountId: 'alice',
      recipientAccountId: 'bob',
      messageId: 'message-1',
      senderDeviceId: 'alice-device-1',
      protocolVersion: E2EE_PROTOCOL_VERSION,
      contentType: 'message',
      inReplyToMessageId: null,
      ciphertext: Buffer.from('ciphertext-plus-auth-tag-value').toString(
        'base64',
      ),
      nonce: Buffer.alloc(12, 7).toString('base64'),
      envelopes: [
        envelope('alice', 'alice-device-1'),
        envelope('bob', 'bob-device-1'),
        ...(devices.has('bob:bob-device-2:signing')
          ? [envelope('bob', 'bob-device-2')]
          : []),
      ],
      attachments: [],
      ...overrides,
    };
    const signing = devices.get(
      `${unsigned.senderAccountId}:${unsigned.senderDeviceId}:signing`,
    );
    if (!signing) throw new Error('test signing device is missing');
    return {
      ...unsigned,
      signature: sign(
        null,
        e2eeMessageSignaturePayload(unsigned),
        signing.privateKey,
      ).toString('base64'),
    } satisfies SendE2eeDirectMessageInput;
  };
  return { database, facade, register, approve, signedMessage };
}

describe('server-side E2EE repository', () => {
  it('rejects a valid device certificate copied from another deployment', () => {
    const harness = createHarness();
    try {
      const signing = generateKeyPairSync('ed25519');
      const exchange = generateKeyPairSync('x25519');
      const certificateRequest = signedCertificateRequest({
        accountId: 'alice',
        deviceId: 'foreign-device',
        deviceName: 'foreign laptop',
        deploymentId: 'deployment-foreign',
        signing,
        exchange,
      });
      expect(() =>
        harness.facade.registerE2eeDevice({
          organizationId: 'org-a',
          accountId: 'alice',
          deviceId: 'foreign-device',
          deviceName: 'foreign laptop',
          identitySigningPublicKey: publicPem(signing.publicKey),
          deviceExchangePublicKey: publicPem(exchange.publicKey),
          certificateRequest,
        }),
      ).toThrow('does not match registration');
    } finally {
      harness.database.close();
    }
  });

  it('fails closed when certificate rows or transparency records are modified in the database', () => {
    const harness = createHarness();
    try {
      harness.register('alice', 'alice-device-1');
      harness.database
        .prepare(
          `UPDATE e2ee_devices SET certificate_request_hash = ?
           WHERE organization_id = 'org-a' AND account_id = 'alice'`,
        )
        .run('f'.repeat(64));
      expect(() =>
        harness.facade.listE2eeDevices({
          organizationId: 'org-a',
          requesterAccountId: 'alice',
          accountIds: ['alice'],
        }),
      ).toThrow('tampered');

      harness.database
        .prepare(
          `UPDATE e2ee_key_transparency_log SET certificate_hash = ?
           WHERE organization_id = 'org-a' AND account_id = 'alice'`,
        )
        .run('e'.repeat(64));
      expect(() =>
        harness.facade.listE2eeKeyTransparency({
          organizationId: 'org-a',
          requesterAccountId: 'alice',
          accountId: 'alice',
        }),
      ).toThrow('integrity');
    } finally {
      harness.database.close();
    }
  });

  it('accepts an intact legacy transparency entry during a v2 upgrade', () => {
    const harness = createHarness();
    try {
      harness.register('alice', 'alice-device-1');
      const row = harness.database
        .prepare(
          `SELECT sequence, account_id, device_id, event, key_fingerprint,
                  actor_device_id, previous_hash, created_at
           FROM e2ee_key_transparency_log
           WHERE organization_id = 'org-a' AND account_id = 'alice'`,
        )
        .get() as {
        sequence: number;
        account_id: string;
        device_id: string;
        event: string;
        key_fingerprint: string;
        actor_device_id: string | null;
        previous_hash: string;
        created_at: string;
      };
      const legacyEntryHash = createHash('sha256')
        .update('otto:e2ee-key-transparency:v1\n')
        .update(
          JSON.stringify({
            sequence: Number(row.sequence),
            organizationId: 'org-a',
            accountId: row.account_id,
            deviceId: row.device_id,
            event: row.event,
            keyFingerprint: row.key_fingerprint,
            actorDeviceId: row.actor_device_id,
            previousHash: row.previous_hash,
            createdAt: row.created_at,
          }),
        )
        .digest('hex');
      harness.database
        .prepare(
          `UPDATE e2ee_key_transparency_log
           SET certificate_hash = key_fingerprint, entry_hash = ?
           WHERE organization_id = 'org-a' AND account_id = 'alice'`,
        )
        .run(legacyEntryHash);

      const transparency = harness.facade.listE2eeKeyTransparency({
        organizationId: 'org-a',
        requesterAccountId: 'alice',
        accountId: 'alice',
      });
      expect(transparency.treeSize).toBe(1);
      expect(transparency.headHash).toBe(legacyEntryHash);
      expect(transparency.entries[0]?.certificateHash).toBe(
        row.key_fingerprint,
      );
    } finally {
      harness.database.close();
    }
  });

  it('requires an approved existing device for new-device activation and records a verifiable hash chain', () => {
    const harness = createHarness();
    try {
      const first = harness.register('alice', 'alice-device-1');
      const second = harness.register('alice', 'alice-device-2');
      expect(first.view.approvalState).toBe('approved');
      expect(second.view.approvalState).toBe('pending');
      expect(
        harness.facade.listE2eeDevices({
          organizationId: 'org-a',
          requesterAccountId: 'alice',
          accountIds: ['alice'],
        }),
      ).toHaveLength(1);
      expect(
        harness.facade.listE2eeDevices({
          organizationId: 'org-a',
          requesterAccountId: 'alice',
          accountIds: ['alice'],
          includePending: true,
        }),
      ).toHaveLength(2);

      expect(() =>
        harness.approve(
          'alice',
          first.view.deviceId,
          second.view.deviceId,
          second.view.deviceId,
        ),
      ).toThrow(/signature is invalid/i);

      expect(
        harness.approve(
          'alice',
          first.view.deviceId,
          second.view.deviceId,
        ),
      ).toMatchObject({
        deviceId: 'alice-device-2',
        approvalState: 'approved',
        approvedByDeviceId: 'alice-device-1',
      });

      const transparency = harness.facade.listE2eeKeyTransparency({
        organizationId: 'org-a',
        requesterAccountId: 'alice',
        accountId: 'alice',
      });
      expect(transparency.entries.map((entry) => entry.event)).toEqual([
        'bootstrap_approved',
        'registered_pending',
        'approved',
      ]);
      expect(transparency.entries[0]?.previousHash).toBe('0'.repeat(64));
      expect(transparency.entries[1]?.previousHash).toBe(
        transparency.entries[0]?.entryHash,
      );
      expect(transparency.headHash).toBe(transparency.entries[2]?.entryHash);
      expect(transparency.treeSize).toBe(3);
      expect(transparency.merkleRoot).toMatch(/^[0-9a-f]{64}$/u);
      expect(transparency.inclusionProofs).toHaveLength(3);
    } finally {
      harness.database.close();
    }
  });

  it('registers immutable device keys and supports self-revocation', () => {
    const harness = createHarness();
    try {
      const first = harness.register('alice', 'alice-device-1');
      expect(
        harness.facade.listE2eeDevices({
          organizationId: 'org-a',
          requesterAccountId: 'alice',
          accountIds: ['alice'],
        }),
      ).toMatchObject([
        { accountId: 'alice', deviceId: 'alice-device-1', revokedAt: null },
      ]);

      const replacement = generateKeyPairSync('ed25519');
      const replacementRequest = signedCertificateRequest({
        accountId: 'alice',
        deviceId: 'alice-device-1',
        deviceName: 'stolen id',
        signing: replacement,
        exchange: first.exchange,
      });
      expect(() =>
        harness.facade.registerE2eeDevice({
          organizationId: 'org-a',
          accountId: 'alice',
          deviceId: 'alice-device-1',
          deviceName: 'stolen id',
          identitySigningPublicKey: publicPem(replacement.publicKey),
          deviceExchangePublicKey: publicPem(first.exchange.publicKey),
          certificateRequest: replacementRequest,
        }),
      ).toThrow('cannot be rebound');

      expect(
        harness.facade.revokeE2eeDevice({
          organizationId: 'org-a',
          accountId: 'alice',
          deviceId: 'alice-device-1',
        }),
      ).toBe(true);
      expect(
        harness.facade.listE2eeDevices({
          organizationId: 'org-a',
          requesterAccountId: 'alice',
          accountIds: ['alice'],
        }),
      ).toEqual([]);
      expect(
        harness.facade.listE2eeDevices({
          organizationId: 'org-a',
          requesterAccountId: 'alice',
          accountIds: ['alice'],
          includeRevoked: true,
        })[0]?.revokedAt,
      ).toBeTruthy();
    } finally {
      harness.database.close();
    }
  });

  it('stores only signed ciphertext and requires envelopes for every active device', () => {
    const harness = createHarness();
    try {
      harness.register('alice', 'alice-device-1');
      harness.register('bob', 'bob-device-1');
      harness.register('bob', 'bob-device-2');
      harness.approve('bob', 'bob-device-1', 'bob-device-2');

      const missingDevice = harness.signedMessage({
        envelopes: [
          {
            accountId: 'alice',
            deviceId: 'alice-device-1',
            ephemeralPublicKey: publicPem(
              generateKeyPairSync('x25519').publicKey,
            ),
            wrappedKey: Buffer.alloc(48, 1).toString('base64'),
            nonce: Buffer.alloc(12, 2).toString('base64'),
          },
          {
            accountId: 'bob',
            deviceId: 'bob-device-1',
            ephemeralPublicKey: publicPem(
              generateKeyPairSync('x25519').publicKey,
            ),
            wrappedKey: Buffer.alloc(48, 3).toString('base64'),
            nonce: Buffer.alloc(12, 4).toString('base64'),
          },
        ],
      });
      expect(() => harness.facade.sendE2eeDirectMessage(missingDevice)).toThrow(
        'every active participant device',
      );

      const message = harness.signedMessage({
        ciphertext: Buffer.from(
          'the plaintext is never sent here plus tag',
        ).toString('base64'),
        attachments: [
          {
            id: 'attachment-1',
            ciphertext: Buffer.from(
              'encrypted attachment plus auth tag',
            ).toString('base64'),
            nonce: Buffer.alloc(12, 9).toString('base64'),
          },
        ],
      });
      const sent = harness.facade.sendE2eeDirectMessage(message);
      expect(sent).toMatchObject({
        id: 'message-1',
        protocolVersion: 1,
        senderDeviceId: 'alice-device-1',
      });
      const storedMessage = harness.database
        .prepare(
          `SELECT content, content_ciphertext, e2ee_ciphertext
         FROM direct_messages WHERE id = 'message-1'`,
        )
        .get();
      expect(storedMessage).toEqual({
        content: '[e2ee:v1]',
        content_ciphertext: null,
        e2ee_ciphertext: message.ciphertext,
      });
      const storedAttachment = harness.database
        .prepare(
          `SELECT file_name, mime_type, content
         FROM direct_message_attachments WHERE id = 'attachment-1'`,
        )
        .get() as { file_name: string; mime_type: string; content: Uint8Array };
      expect(storedAttachment.file_name).toBe('[e2ee]');
      expect(storedAttachment.mime_type).toBe('application/octet-stream');
      expect(
        Buffer.from(storedAttachment.content).toString('utf8'),
      ).not.toContain('attachment body');
    } finally {
      harness.database.close();
    }
  });

  it('rejects tampering and excludes revoked devices from future envelope coverage', () => {
    const harness = createHarness();
    try {
      harness.register('alice', 'alice-device-1');
      harness.register('bob', 'bob-device-1');
      harness.register('bob', 'bob-device-2');
      harness.approve('bob', 'bob-device-1', 'bob-device-2');
      const valid = harness.signedMessage();
      expect(() =>
        harness.facade.sendE2eeDirectMessage({
          ...valid,
          ciphertext: Buffer.from('tampered ciphertext plus tag').toString(
            'base64',
          ),
        }),
      ).toThrow('signature is invalid');

      harness.facade.revokeE2eeDevice({
        organizationId: 'org-a',
        accountId: 'bob',
        deviceId: 'bob-device-2',
      });
      const afterRevocation = harness.signedMessage({
        envelopes: valid.envelopes.filter(
          (item) => item.deviceId !== 'bob-device-2',
        ),
      });
      expect(harness.facade.sendE2eeDirectMessage(afterRevocation).id).toBe(
        'message-1',
      );
    } finally {
      harness.database.close();
    }
  });

  it('tracks encrypted A2A request/response linkage without reading their bodies', () => {
    const harness = createHarness();
    try {
      harness.register('alice', 'alice-device-1');
      harness.register('bob', 'bob-device-1');
      const request = harness.signedMessage({ contentType: 'atoa_request' });
      harness.facade.sendE2eeDirectMessage(request);
      expect(
        harness.facade.listPendingE2eeAtoaRequests({
          organizationId: 'org-a',
          accountId: 'bob',
        }),
      ).toMatchObject([{ id: 'message-1', peerAccountId: 'alice' }]);

      const responseUnsigned = harness.signedMessage({
        messageId: 'message-2',
        senderAccountId: 'bob',
        recipientAccountId: 'alice',
        senderDeviceId: 'bob-device-1',
        contentType: 'atoa_response',
        inReplyToMessageId: 'message-1',
      });
      harness.facade.sendE2eeDirectMessage(responseUnsigned);
      expect(
        harness.facade.listPendingE2eeAtoaRequests({
          organizationId: 'org-a',
          accountId: 'bob',
        }),
      ).toEqual([]);
    } finally {
      harness.database.close();
    }
  });
});
