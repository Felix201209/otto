/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Database } from '../data_platform/index.js';
import {
  OTTO_E2EE_PROTOCOL_ID,
  OTTO_E2EE_TRUST_VERSION,
  type E2eeAccountRootRegistration,
  type E2eeDeviceApprovalProof,
  type E2eeDeviceRegistration,
  type E2eeDeviceRevocationProof,
} from './secureMessagingContracts.js';
import {
  ED25519_SIGNATURE_PREFIX,
  accountRootSigningPayload,
  canonicalE2eeJson,
  deviceCredentialHash,
  deviceProofSigningPayload,
  deviceRegistrationSigningPayload,
  verifyE2eeMerkleInclusion,
} from './secureMessagingCrypto.js';
import { createSecureMessagingFacade } from './secureMessagingFacade.js';
import { SECURE_MESSAGING_SCHEMA_CONTRIBUTOR } from './secureMessagingSchema.js';
import { verifyE2eeDeviceDirectorySnapshot } from './secureMessagingVerification.js';

const NOW = Date.parse('2026-08-01T08:00:00.000Z');

function keyPair(): { publicKey: string; privateKey: KeyObject } {
  const pair = generateKeyPairSync('ed25519');
  return {
    publicKey: pair.publicKey
      .export({ format: 'der', type: 'spki' })
      .toString('base64'),
    privateKey: pair.privateKey,
  };
}

function signature(payload: unknown, privateKey: KeyObject): string {
  return `${ED25519_SIGNATURE_PREFIX}${sign(
    null,
    Buffer.from(canonicalE2eeJson(payload)),
    privateKey,
  ).toString('base64url')}`;
}

function createDatabase(): Database {
  const database = new Database(':memory:');
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE organizations (id TEXT PRIMARY KEY);
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      status TEXT NOT NULL
    );
    INSERT INTO organizations (id) VALUES ('org-a'), ('org-b');
    INSERT INTO accounts (id, organization_id, status)
      VALUES ('alice', 'org-a', 'active'),
             ('bob', 'org-a', 'active'),
             ('disabled', 'org-a', 'disabled');
  `);
  SECURE_MESSAGING_SCHEMA_CONTRIBUTOR.apply(database);
  return database;
}

function testContext() {
  const database = createDatabase();
  const facade = createSecureMessagingFacade({
    db: () => database,
    now: () => NOW,
    isActiveAccountInOrganization(accountId, organizationId) {
      return Boolean(
        database
          .prepare(
            `SELECT 1 FROM accounts
             WHERE id = ? AND organization_id = ? AND status = 'active'`,
          )
          .get(accountId, organizationId),
      );
    },
  });
  return { database, facade };
}

function rootRegistration(
  root: ReturnType<typeof keyPair>,
  recovery: ReturnType<typeof keyPair>,
  accountId = 'alice',
  organizationId = 'org-a',
): E2eeAccountRootRegistration {
  const unsigned = {
    protocolId: OTTO_E2EE_PROTOCOL_ID,
    trustVersion: OTTO_E2EE_TRUST_VERSION,
    organizationId,
    accountId,
    rootSigningPublicKey: root.publicKey,
    recoveryPublicKey: recovery.publicKey,
    issuedAt: new Date(NOW).toISOString(),
    nonce: randomBytes(24).toString('base64url'),
  };
  return {
    ...unsigned,
    signature: signature(accountRootSigningPayload(unsigned), root.privateKey),
    recoverySignature: signature(
      accountRootSigningPayload(unsigned),
      recovery.privateKey,
    ),
  };
}

function unsignedDevice(
  deviceId: string,
  publicKey: string,
): Omit<E2eeDeviceRegistration, 'signature' | 'bootstrap'> {
  return {
    protocolId: OTTO_E2EE_PROTOCOL_ID,
    trustVersion: OTTO_E2EE_TRUST_VERSION,
    organizationId: 'org-a',
    accountId: 'alice',
    deviceId,
    deviceName: `Otto ${deviceId}`,
    signingPublicKey: publicKey,
    mlsKeyPackage: randomBytes(96).toString('base64url'),
    issuedAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 365 * 24 * 60 * 60 * 1000).toISOString(),
    nonce: randomBytes(24).toString('base64url'),
  };
}

function deviceRegistration(
  deviceId: string,
  deviceKey: ReturnType<typeof keyPair>,
  rootKey?: ReturnType<typeof keyPair>,
): E2eeDeviceRegistration {
  const unsigned = unsignedDevice(deviceId, deviceKey.publicKey);
  const registration: E2eeDeviceRegistration = {
    ...unsigned,
    signature: signature(
      deviceRegistrationSigningPayload(unsigned),
      deviceKey.privateKey,
    ),
  };
  if (rootKey) {
    const proof = {
      type: 'bootstrap' as const,
      organizationId: unsigned.organizationId,
      accountId: unsigned.accountId,
      targetDeviceId: unsigned.deviceId,
      targetCredentialHash: deviceCredentialHash(unsigned),
      issuedAt: new Date(NOW).toISOString(),
      nonce: randomBytes(24).toString('base64url'),
      signature: '',
    };
    registration.bootstrap = {
      ...proof,
      signature: signature(
        deviceProofSigningPayload(proof),
        rootKey.privateKey,
      ),
    };
  }
  return registration;
}

function approveProof(
  actorDeviceId: string,
  actorKey: ReturnType<typeof keyPair>,
  target: E2eeDeviceRegistration,
): E2eeDeviceApprovalProof {
  const { signature: _signature, bootstrap: _bootstrap, ...unsignedTarget } =
    target;
  const proof = {
    type: 'approval' as const,
    organizationId: target.organizationId,
    accountId: target.accountId,
    actorDeviceId,
    targetDeviceId: target.deviceId,
    targetCredentialHash: deviceCredentialHash(unsignedTarget),
    issuedAt: new Date(NOW).toISOString(),
    nonce: randomBytes(24).toString('base64url'),
    signature: '',
  };
  return {
    ...proof,
    signature: signature(
      deviceProofSigningPayload(proof),
      actorKey.privateKey,
    ),
  };
}

describe('secure messaging device trust repository', () => {
  it('derives approval only from root and device signatures', () => {
    const { database, facade } = testContext();
    try {
      const root = keyPair();
      facade.registerE2eeAccountRoot(rootRegistration(root, keyPair()));
      const firstKey = keyPair();
      facade.registerE2eeDevice(
        deviceRegistration('device-a', firstKey, root),
      );
      const secondKey = keyPair();
      const second = deviceRegistration('device-b', secondKey);
      let directory = facade.registerE2eeDevice(second);
      expect(directory.devices.map(({ deviceId, state }) => ({ deviceId, state })))
        .toEqual([
          { deviceId: 'device-a', state: 'approved' },
          { deviceId: 'device-b', state: 'pending' },
        ]);

      directory = facade.approveE2eeDevice(
        approveProof('device-a', firstKey, second),
      );
      expect(directory.devices.find((item) => item.deviceId === 'device-b')?.state)
        .toBe('approved');
      expect(
        (database.prepare('PRAGMA table_info(e2ee_devices)').all() as Array<{ name: string }>)
          .map((column) => column.name),
      ).not.toContain('approval_state');
      expect(() => verifyE2eeDeviceDirectorySnapshot(directory, { nowMs: NOW }))
        .not.toThrow();
    } finally {
      database.close();
    }
  });

  it('rejects forged approvals and revoked approvers', () => {
    const { database, facade } = testContext();
    try {
      const root = keyPair();
      facade.registerE2eeAccountRoot(rootRegistration(root, keyPair()));
      const firstKey = keyPair();
      const first = deviceRegistration('device-a', firstKey, root);
      facade.registerE2eeDevice(first);
      const secondKey = keyPair();
      const second = deviceRegistration('device-b', secondKey);
      facade.registerE2eeDevice(second);
      const forged = approveProof('device-a', firstKey, second);
      forged.targetCredentialHash = '0'.repeat(64);
      expect(() => facade.approveE2eeDevice(forged)).toThrow(
        /target credential does not match/i,
      );

      const {
        signature: _firstSignature,
        bootstrap: _firstBootstrap,
        ...unsignedFirst
      } = first;
      const revocation: E2eeDeviceRevocationProof = {
        type: 'revocation',
        organizationId: 'org-a',
        accountId: 'alice',
        actorDeviceId: 'device-a',
        targetDeviceId: 'device-a',
        targetCredentialHash: deviceCredentialHash(unsignedFirst),
        issuedAt: new Date(NOW).toISOString(),
        nonce: randomBytes(24).toString('base64url'),
        signature: '',
      };
      revocation.signature = signature(
        deviceProofSigningPayload(revocation),
        firstKey.privateKey,
      );
      facade.revokeE2eeDevice(revocation);
      expect(() =>
        facade.approveE2eeDevice(approveProof('device-a', firstKey, second)),
      ).toThrow(/actor is not approved/i);
    } finally {
      database.close();
    }
  });

  it('detects transparency tampering, rollback and verifies inclusion proofs', () => {
    const { database, facade } = testContext();
    try {
      const root = keyPair();
      facade.registerE2eeAccountRoot(rootRegistration(root, keyPair()));
      facade.registerE2eeDevice(
        deviceRegistration('device-a', keyPair(), root),
      );
      const directory = facade.getE2eeDeviceDirectory('org-a', 'alice');
      const inclusion = facade.getE2eeTransparencyInclusionProof(
        'org-a',
        'alice',
        1,
      );
      expect(
        verifyE2eeMerkleInclusion({
          leafHash: directory.transparency.leaves[0].leafHash,
          accountSequence: 1,
          nodes: inclusion.nodes,
          checkpoint: inclusion.checkpoint,
        }),
      ).toBe(true);
      expect(
        verifyE2eeMerkleInclusion({
          leafHash: directory.transparency.leaves[0].leafHash,
          accountSequence: 2,
          nodes: inclusion.nodes,
          checkpoint: inclusion.checkpoint,
        }),
      ).toBe(false);

      const tampered = structuredClone(directory);
      tampered.transparency.leaves[0].payload = { changed: true };
      expect(() =>
        verifyE2eeDeviceDirectorySnapshot(tampered, { nowMs: NOW }),
      ).toThrow(/transparency event/i);
      expect(() =>
        verifyE2eeDeviceDirectorySnapshot(directory, {
          nowMs: NOW,
          previousCheckpoint: {
            size: directory.transparency.checkpoint.size + 1,
            rootHash: directory.transparency.checkpoint.rootHash,
          },
        }),
      ).toThrow(/rollback/i);

      database
        .prepare(
          `UPDATE e2ee_device_proofs SET signature = ?
           WHERE organization_id = ? AND account_id = ?`,
        )
        .run(
          `${ED25519_SIGNATURE_PREFIX}${Buffer.alloc(64).toString('base64url')}`,
          'org-a',
          'alice',
        );
      expect(() => facade.getE2eeDeviceDirectory('org-a', 'alice')).toThrow(
        /bootstrap proof signature is invalid/i,
      );
    } finally {
      database.close();
    }
  });

  it('fails closed for disabled accounts and cross-organization scope', () => {
    const { database, facade } = testContext();
    try {
      const root = keyPair();
      const disabled = rootRegistration(root, keyPair(), 'disabled');
      expect(() => facade.registerE2eeAccountRoot(disabled)).toThrow(
        /not active/i,
      );
      const wrongTenant = rootRegistration(root, keyPair(), 'alice', 'org-b');
      expect(() => facade.registerE2eeAccountRoot(wrongTenant)).toThrow(
        /not active/i,
      );
    } finally {
      database.close();
    }
  });

  it('keeps encrypted messaging disabled until the MLS audit gate passes', () => {
    const { database } = testContext();
    try {
      const columns = database
        .prepare('PRAGMA table_info(e2ee_devices)')
        .all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toContain('mls_key_package');
    } finally {
      database.close();
    }
  });
});
