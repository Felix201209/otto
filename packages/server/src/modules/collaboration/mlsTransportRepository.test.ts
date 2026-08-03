/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  applyDatabaseSchemaContributors,
  Database,
} from '../data_platform/index.js';
import { COLLABORATION_SCHEMA_CONTRIBUTOR } from './collaborationSchema.js';
import {
  createMlsTransportFacade,
  parseMlsMemberAddCommitEnvelope,
} from './mlsTransportRepository.js';
import type { MlsResourceGovernancePolicy } from './mlsTransportRepository.js';

const MLS_SUITE = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519' as const;

function opaque(value: string): string {
  return Buffer.from(value.repeat(24), 'utf8').toString('base64');
}

function createHarness(
  options: {
    policy?: Partial<MlsResourceGovernancePolicy>;
    nowMs?: number;
  } = {},
) {
  let nowMs = options.nowMs ?? Date.now();
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
  const addDevice = (
    accountId: string,
    deviceId: string,
    state = 'approved',
  ) => {
    database
      .prepare(
        `INSERT INTO e2ee_devices
          (organization_id, account_id, device_id, device_name,
           identity_signing_public_key, device_exchange_public_key,
           key_fingerprint, approval_state, approved_by_device_id, approved_at)
         VALUES ('org-a', ?, ?, ?, 'signing-key', 'exchange-key', ?, ?, ?, datetime('now'))`,
      )
      .run(
        accountId,
        deviceId,
        `${accountId} device`,
        deviceId.padEnd(64, '0').slice(0, 64),
        state,
        state === 'approved' ? deviceId : null,
      );
  };
  addDevice('alice', 'alice-1');
  addDevice('bob', 'bob-1');
  addDevice('bob', 'bob-2');
  addDevice('bob', 'bob-pending', 'pending');
  addDevice('carol', 'carol-1');

  const facade = createMlsTransportFacade({
    db: () => database,
    now: () => nowMs,
    mlsResourcePolicy: options.policy,
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
  return {
    database,
    facade,
    advanceTime(milliseconds: number) {
      nowMs += milliseconds;
    },
  };
}

describe('MLS ciphertext transport repository', () => {
  it('publishes packages only for approved devices and recovers an unfinished claim', () => {
    const { database, facade } = createHarness();
    try {
      const published = facade.publishMlsKeyPackage({
        organizationId: 'org-a',
        accountId: 'bob',
        deviceId: 'bob-1',
        ciphersuite: MLS_SUITE,
        reference: 'c'.repeat(64),
        keyPackage: opaque('key-package'),
      });
      expect(published).toMatchObject({
        accountId: 'bob',
        deviceId: 'bob-1',
        ciphersuite: MLS_SUITE,
        claimedAt: null,
      });
      expect(published.reference).toBe('c'.repeat(64));

      expect(() =>
        facade.publishMlsKeyPackage({
          organizationId: 'org-a',
          accountId: 'bob',
          deviceId: 'bob-pending',
          ciphersuite: MLS_SUITE,
          keyPackage: opaque('pending-package'),
        }),
      ).toThrow(/active and approved/i);

      expect(
        facade.claimMlsKeyPackage({
          organizationId: 'org-a',
          requesterAccountId: 'alice',
          requesterDeviceId: 'alice-1',
          recipientAccountId: 'bob',
        }),
      ).toMatchObject({ reference: published.reference, accountId: 'bob' });
      expect(
        facade.claimMlsKeyPackage({
          organizationId: 'org-a',
          requesterAccountId: 'alice',
          requesterDeviceId: 'alice-1',
          recipientAccountId: 'bob',
        }),
      ).toMatchObject({
        reference: published.reference,
        accountId: 'bob',
        claimedAt: expect.any(String),
      });
    } finally {
      database.close();
    }
  });

  it('lists only unclaimed unexpired KeyPackages for the exact approved device', () => {
    const { database, facade, advanceTime } = createHarness({
      nowMs: Date.parse('2026-08-03T00:00:00.000Z'),
    });
    const publish = (deviceId: string, reference: string) =>
      facade.publishMlsKeyPackage({
        organizationId: 'org-a',
        accountId: 'bob',
        deviceId,
        ciphersuite: MLS_SUITE,
        reference,
        keyPackage: opaque(`key-package-${reference[0]}`),
      });
    try {
      publish('bob-1', 'a'.repeat(64));
      publish('bob-1', 'b'.repeat(64));
      publish('bob-2', 'c'.repeat(64));
      facade.claimMlsKeyPackage({
        organizationId: 'org-a',
        requesterAccountId: 'alice',
        requesterDeviceId: 'alice-1',
        recipientAccountId: 'bob',
      });

      expect(
        facade.listMlsKeyPackageInventory({
          organizationId: 'org-a',
          accountId: 'bob',
          deviceId: 'bob-1',
        }),
      ).toEqual([
        {
          reference: 'b'.repeat(64),
          expiresAt: '2026-08-10T00:00:00.000Z',
        },
      ]);
      expect(
        facade.retireMlsKeyPackage({
          organizationId: 'org-a',
          accountId: 'bob',
          deviceId: 'bob-1',
          reference: 'b'.repeat(64),
        }),
      ).toBe(true);
      expect(
        facade.retireMlsKeyPackage({
          organizationId: 'org-a',
          accountId: 'bob',
          deviceId: 'bob-1',
          reference: 'b'.repeat(64),
        }),
      ).toBe(true);
      expect(
        facade.retireMlsKeyPackage({
          organizationId: 'org-a',
          accountId: 'bob',
          deviceId: 'bob-1',
          reference: 'a'.repeat(64),
        }),
      ).toBe(false);
      expect(
        facade.listMlsKeyPackageInventory({
          organizationId: 'org-a',
          accountId: 'bob',
          deviceId: 'bob-1',
        }),
      ).toEqual([]);
      expect(
        facade.listMlsKeyPackageInventory({
          organizationId: 'org-a',
          accountId: 'bob',
          deviceId: 'bob-2',
        }),
      ).toEqual([
        {
          reference: 'c'.repeat(64),
          expiresAt: '2026-08-10T00:00:00.000Z',
        },
      ]);
      expect(() =>
        facade.listMlsKeyPackageInventory({
          organizationId: 'org-a',
          accountId: 'bob',
          deviceId: 'bob-pending',
        }),
      ).toThrow(/active and approved/i);
      expect(
        (
          database
            .prepare('PRAGMA index_list(mls_key_packages)')
            .all() as Array<{ name: string }>
        ).map((index) => index.name),
      ).toContain('idx_mls_key_packages_device_inventory');

      advanceTime(8 * 24 * 60 * 60 * 1_000);
      expect(
        facade.listMlsKeyPackageInventory({
          organizationId: 'org-a',
          accountId: 'bob',
          deviceId: 'bob-1',
        }),
      ).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('binds Welcome to the claimed device and stores only opaque bytes', () => {
    const { database, facade } = createHarness();
    try {
      const published = facade.publishMlsKeyPackage({
        organizationId: 'org-a',
        accountId: 'bob',
        deviceId: 'bob-1',
        ciphersuite: MLS_SUITE,
        keyPackage: opaque('key-package'),
      });
      facade.claimMlsKeyPackage({
        organizationId: 'org-a',
        requesterAccountId: 'alice',
        requesterDeviceId: 'alice-1',
        recipientAccountId: 'bob',
      });
      const groupId = opaque('group');
      const commit = facade.appendMlsTransportEvent({
        organizationId: 'org-a',
        senderAccountId: 'alice',
        peerAccountId: 'bob',
        senderDeviceId: 'alice-1',
        eventId: 'commit-1',
        eventType: 'commit',
        epoch: 1,
        groupId,
        payload: opaque('commit'),
        recipientDeviceId: 'bob-1',
        keyPackageReference: published.reference,
      });
      expect(commit).toMatchObject({
        eventType: 'commit',
        recipientAccountId: null,
        recipientDeviceId: null,
        keyPackageReference: null,
      });
      expect(parseMlsMemberAddCommitEnvelope(commit.payload)).toEqual({
        commit: opaque('commit'),
        recipientDeviceId: 'bob-1',
        keyPackageReference: published.reference,
      });
      const welcome = facade.appendMlsTransportEvent({
        organizationId: 'org-a',
        senderAccountId: 'alice',
        peerAccountId: 'bob',
        senderDeviceId: 'alice-1',
        recipientDeviceId: 'bob-1',
        keyPackageReference: published.reference,
        eventId: 'welcome-1',
        eventType: 'welcome',
        epoch: 1,
        groupId,
        payload: opaque('welcome'),
      });
      expect(welcome).toMatchObject({
        eventType: 'welcome',
        recipientAccountId: 'bob',
        recipientDeviceId: 'bob-1',
        keyPackageReference: published.reference,
      });
      const columns = database
        .prepare('PRAGMA table_info(mls_transport_events)')
        .all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).not.toContain('plaintext');
      expect(
        database
          .prepare('SELECT payload FROM mls_transport_events WHERE id = ?')
          .get('welcome-1'),
      ).toEqual({ payload: opaque('welcome') });
    } finally {
      database.close();
    }
  });

  it('discovers only active unexpired Welcome peers for the exact approved device', () => {
    const { database, facade, advanceTime } = createHarness({
      nowMs: Date.parse('2026-08-03T00:00:00.000Z'),
    });
    const appendWelcome = (
      senderAccountId: 'alice' | 'carol',
      senderDeviceId: 'alice-1' | 'carol-1',
      suffix: string,
    ) => {
      const published = facade.publishMlsKeyPackage({
        organizationId: 'org-a',
        accountId: 'bob',
        deviceId: 'bob-1',
        ciphersuite: MLS_SUITE,
        reference: suffix.repeat(64),
        keyPackage: opaque(`key-package-${suffix}`),
      });
      facade.claimMlsKeyPackage({
        organizationId: 'org-a',
        requesterAccountId: senderAccountId,
        requesterDeviceId: senderDeviceId,
        recipientAccountId: 'bob',
      });
      const groupId = opaque(`group-${suffix}`);
      facade.appendMlsTransportEvent({
        organizationId: 'org-a',
        senderAccountId,
        peerAccountId: 'bob',
        senderDeviceId,
        eventId: `commit-${suffix}`,
        eventType: 'commit',
        epoch: 1,
        groupId,
        payload: opaque(`commit-${suffix}`),
        recipientDeviceId: 'bob-1',
        keyPackageReference: published.reference,
      });
      facade.appendMlsTransportEvent({
        organizationId: 'org-a',
        senderAccountId,
        peerAccountId: 'bob',
        senderDeviceId,
        recipientDeviceId: 'bob-1',
        keyPackageReference: published.reference,
        eventId: `welcome-${suffix}`,
        eventType: 'welcome',
        epoch: 1,
        groupId,
        payload: opaque(`welcome-${suffix}`),
      });
    };
    try {
      appendWelcome('carol', 'carol-1', 'c');
      appendWelcome('alice', 'alice-1', 'a');

      expect(
        facade.listMlsInboundConversationPeers({
          organizationId: 'org-a',
          accountId: 'bob',
          deviceId: 'bob-1',
        }),
      ).toEqual(['alice', 'carol']);
      expect(
        (
          database
            .prepare('PRAGMA index_list(mls_transport_events)')
            .all() as Array<{ name: string }>
        ).map((index) => index.name),
      ).toContain('idx_mls_transport_events_inbound_welcome');
      expect(
        facade.listMlsInboundConversationPeers({
          organizationId: 'org-a',
          accountId: 'bob',
          deviceId: 'bob-1',
          limit: 1,
        }),
      ).toEqual(['alice']);
      expect(
        facade.listMlsInboundConversationPeers({
          organizationId: 'org-a',
          accountId: 'bob',
          deviceId: 'bob-1',
          afterPeerAccountId: 'alice',
        }),
      ).toEqual(['carol']);
      expect(
        facade.listMlsInboundConversationPeers({
          organizationId: 'org-a',
          accountId: 'bob',
          deviceId: 'bob-2',
        }),
      ).toEqual([]);
      expect(() =>
        facade.listMlsInboundConversationPeers({
          organizationId: 'org-a',
          accountId: 'bob',
          deviceId: 'bob-pending',
        }),
      ).toThrow(/active and approved/i);

      database
        .prepare(
          `UPDATE mls_conversations SET active_generation = 2
           WHERE organization_id = 'org-a'
             AND 'alice' IN (
               participant_a_account_id,
               participant_b_account_id
             )`,
        )
        .run();
      expect(
        facade.listMlsInboundConversationPeers({
          organizationId: 'org-a',
          accountId: 'bob',
          deviceId: 'bob-1',
        }),
      ).toEqual(['carol']);

      advanceTime(91 * 24 * 60 * 60 * 1_000);
      expect(
        facade.listMlsInboundConversationPeers({
          organizationId: 'org-a',
          accountId: 'bob',
          deviceId: 'bob-1',
        }),
      ).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('enforces epoch ordering and idempotent event identifiers', () => {
    const { database, facade } = createHarness();
    try {
      const base = {
        organizationId: 'org-a',
        senderAccountId: 'alice',
        peerAccountId: 'bob',
        senderDeviceId: 'alice-1',
        groupId: opaque('group'),
      } as const;
      const first = facade.appendMlsTransportEvent({
        ...base,
        eventId: 'commit-1',
        eventType: 'commit',
        epoch: 1,
        payload: opaque('commit-1'),
      });
      expect(
        facade.appendMlsTransportEvent({
          ...base,
          eventId: 'commit-1',
          eventType: 'commit',
          epoch: 1,
          payload: opaque('commit-1'),
        }),
      ).toEqual(first);
      expect(() =>
        facade.appendMlsTransportEvent({
          ...base,
          eventId: 'commit-1',
          eventType: 'commit',
          epoch: 1,
          payload: opaque('different'),
        }),
      ).toThrow(/idempotency conflict/i);
      expect(() =>
        facade.appendMlsTransportEvent({
          ...base,
          eventId: 'commit-3',
          eventType: 'commit',
          epoch: 3,
          payload: opaque('commit-3'),
        }),
      ).toThrow(/next epoch/i);
      facade.appendMlsTransportEvent({
        ...base,
        eventId: 'commit-2',
        eventType: 'commit',
        epoch: 2,
        payload: opaque('commit-2'),
      });
      expect(() =>
        facade.appendMlsTransportEvent({
          ...base,
          eventId: 'message-stale',
          eventType: 'application',
          epoch: 1,
          payload: opaque('message'),
        }),
      ).toThrow(/current epoch/i);
    } finally {
      database.close();
    }
  });

  it('atomically resets to a new group while retaining prior session history', () => {
    const { database, facade, advanceTime } = createHarness({
      policy: { transportEventTtlMs: 1_000 },
    });
    try {
      const previousGroupId = opaque('old');
      const nextGroupId = opaque('new');
      const base = {
        organizationId: 'org-a',
        senderAccountId: 'alice',
        peerAccountId: 'bob',
        senderDeviceId: 'alice-1',
      } as const;
      facade.appendMlsTransportEvent({
        ...base,
        eventId: 'previous-commit-1',
        eventType: 'commit',
        epoch: 1,
        groupId: previousGroupId,
        payload: opaque('previous-commit'),
      });
      facade.appendMlsTransportEvent({
        ...base,
        eventId: 'previous-message-1',
        eventType: 'application',
        epoch: 1,
        groupId: previousGroupId,
        payload: opaque('previous-message'),
      });

      expect(() =>
        facade.appendMlsTransportEvent({
          ...base,
          eventId: 'implicit-reset',
          eventType: 'commit',
          epoch: 1,
          groupId: nextGroupId,
          payload: opaque('implicit-reset'),
        }),
      ).toThrow(/explicit MLS session reset/i);

      const reset = facade.appendMlsTransportEvent({
        ...base,
        eventId: 'reset-commit-1',
        eventType: 'commit',
        epoch: 1,
        groupId: nextGroupId,
        resetFromGroupId: previousGroupId,
        payload: opaque('reset-commit'),
      });
      expect(reset).toMatchObject({
        eventId: 'reset-commit-1',
        groupId: nextGroupId,
        sessionGeneration: 2,
      });
      expect(
        facade.appendMlsTransportEvent({
          ...base,
          eventId: 'reset-commit-1',
          eventType: 'commit',
          epoch: 1,
          groupId: nextGroupId,
          resetFromGroupId: previousGroupId,
          payload: opaque('reset-commit'),
        }),
      ).toEqual(reset);

      const sessions = database
        .prepare(
          `SELECT generation, group_id, status, reset_event_id
           FROM mls_group_sessions ORDER BY generation`,
        )
        .all();
      expect(sessions).toEqual([
        {
          generation: 1,
          group_id: previousGroupId,
          status: 'retired',
          reset_event_id: null,
        },
        {
          generation: 2,
          group_id: nextGroupId,
          status: 'active',
          reset_event_id: 'reset-commit-1',
        },
      ]);
      expect(
        facade
          .listMlsTransportEvents({
            organizationId: 'org-a',
            accountId: 'alice',
            peerAccountId: 'bob',
          })
          .map((event) => [event.eventId, event.sessionGeneration]),
      ).toEqual([
        ['previous-commit-1', 1],
        ['previous-message-1', 1],
        ['reset-commit-1', 2],
      ]);

      expect(() =>
        facade.appendMlsTransportEvent({
          ...base,
          eventId: 'stale-reset',
          eventType: 'commit',
          epoch: 1,
          groupId: opaque('stale'),
          resetFromGroupId: previousGroupId,
          payload: opaque('stale-reset'),
        }),
      ).toThrow(/reset source group is no longer active/i);

      advanceTime(1_001);
      expect(facade.cleanupExpiredMlsResources({ limit: 20 })).toMatchObject({
        eventsDeleted: 3,
        groupSessionsDeleted: 1,
      });
      expect(
        database
          .prepare(
            `SELECT generation, status FROM mls_group_sessions
             ORDER BY generation`,
          )
          .all(),
      ).toEqual([{ generation: 2, status: 'active' }]);
    } finally {
      database.close();
    }
  });

  it('rejects revoked senders and cross-tenant participants', () => {
    const { database, facade } = createHarness();
    try {
      database
        .prepare(
          `UPDATE e2ee_devices SET revoked_at = datetime('now')
           WHERE account_id = 'alice' AND device_id = 'alice-1'`,
        )
        .run();
      expect(() =>
        facade.appendMlsTransportEvent({
          organizationId: 'org-a',
          senderAccountId: 'alice',
          peerAccountId: 'bob',
          senderDeviceId: 'alice-1',
          eventId: 'commit-1',
          eventType: 'commit',
          epoch: 1,
          groupId: opaque('group'),
          payload: opaque('commit'),
        }),
      ).toThrow(/active and approved/i);
      expect(() =>
        facade.claimMlsKeyPackage({
          organizationId: 'org-a',
          requesterAccountId: 'alice',
          requesterDeviceId: 'alice-1',
          recipientAccountId: 'mallory',
        }),
      ).toThrow(/active in organization/i);
    } finally {
      database.close();
    }
  });

  it('lists only participant-visible events in sequence order', () => {
    const { database, facade } = createHarness();
    try {
      const groupId = opaque('group');
      facade.appendMlsTransportEvent({
        organizationId: 'org-a',
        senderAccountId: 'alice',
        peerAccountId: 'bob',
        senderDeviceId: 'alice-1',
        eventId: 'commit-1',
        eventType: 'commit',
        epoch: 1,
        groupId,
        payload: opaque('commit'),
      });
      facade.appendMlsTransportEvent({
        organizationId: 'org-a',
        senderAccountId: 'alice',
        peerAccountId: 'bob',
        senderDeviceId: 'alice-1',
        eventId: 'message-1',
        eventType: 'application',
        epoch: 1,
        groupId,
        payload: opaque('message'),
      });
      const events = facade.listMlsTransportEvents({
        organizationId: 'org-a',
        accountId: 'bob',
        peerAccountId: 'alice',
        afterSequence: 0,
      });
      expect(events.map((event) => event.eventId)).toEqual([
        'commit-1',
        'message-1',
      ]);
      expect(
        facade.listMlsTransportEvents({
          organizationId: 'org-a',
          accountId: 'carol',
          peerAccountId: 'alice',
        }),
      ).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('bounds KeyPackage inventory and does not charge idempotent retries', () => {
    const { database, facade, advanceTime } = createHarness({
      policy: {
        maxUnclaimedKeyPackagesPerDevice: 2,
        maxUnclaimedKeyPackagesPerOrganization: 2,
        keyPackagePublishesPerMinute: 3,
        keyPackageTtlMs: 60_000,
      },
    });
    try {
      const firstInput = {
        organizationId: 'org-a',
        accountId: 'bob',
        deviceId: 'bob-1',
        ciphersuite: MLS_SUITE,
        keyPackage: opaque('quota-package-1'),
      } as const;
      const first = facade.publishMlsKeyPackage(firstInput);
      expect(facade.publishMlsKeyPackage(firstInput)).toEqual(first);
      facade.publishMlsKeyPackage({
        ...firstInput,
        keyPackage: opaque('quota-package-2'),
      });
      expect(() =>
        facade.publishMlsKeyPackage({
          ...firstInput,
          keyPackage: opaque('quota-package-3'),
        }),
      ).toThrow(/inventory quota/i);
      expect(
        database
          .prepare(
            `SELECT request_count FROM mls_resource_rate_buckets
             WHERE action = 'key_package_publish'`,
          )
          .get(),
      ).toEqual({ request_count: 2 });

      advanceTime(60_001);
      const cleanup = facade.cleanupExpiredMlsResources({ limit: 10 });
      expect(cleanup.keyPackagesDeleted).toBe(2);
      expect(
        facade.publishMlsKeyPackage({
          ...firstInput,
          keyPackage: opaque('quota-package-3'),
        }),
      ).toMatchObject({ accountId: 'bob', deviceId: 'bob-1' });
    } finally {
      database.close();
    }
  });

  it('rate-limits new transport events per device and permits a new window', () => {
    const { database, facade, advanceTime } = createHarness({
      policy: { transportEventsPerMinute: 2 },
    });
    try {
      const base = {
        organizationId: 'org-a',
        senderAccountId: 'alice',
        peerAccountId: 'bob',
        senderDeviceId: 'alice-1',
        groupId: opaque('rate-group'),
      } as const;
      facade.appendMlsTransportEvent({
        ...base,
        eventId: 'rate-commit-1',
        eventType: 'commit',
        epoch: 1,
        payload: opaque('rate-commit'),
      });
      const application = facade.appendMlsTransportEvent({
        ...base,
        eventId: 'rate-application-1',
        eventType: 'application',
        epoch: 1,
        payload: opaque('rate-application'),
      });
      expect(
        facade.appendMlsTransportEvent({
          ...base,
          eventId: 'rate-application-1',
          eventType: 'application',
          epoch: 1,
          payload: opaque('rate-application'),
        }),
      ).toEqual(application);
      expect(() =>
        facade.appendMlsTransportEvent({
          ...base,
          eventId: 'rate-application-2',
          eventType: 'application',
          epoch: 1,
          payload: opaque('rate-application-2'),
        }),
      ).toThrow(/rate limit/i);

      advanceTime(60_000);
      expect(
        facade.appendMlsTransportEvent({
          ...base,
          eventId: 'rate-application-2',
          eventType: 'application',
          epoch: 1,
          payload: opaque('rate-application-2'),
        }),
      ).toMatchObject({ eventId: 'rate-application-2' });
    } finally {
      database.close();
    }
  });

  it('enforces hard event inventory counts independently of the rate window', () => {
    const { database, facade } = createHarness({
      policy: {
        transportEventsPerMinute: 10,
        maxTransportEventsPerConversation: 2,
        maxTransportEventsPerOrganization: 2,
      },
    });
    try {
      const base = {
        organizationId: 'org-a',
        senderAccountId: 'alice',
        peerAccountId: 'bob',
        senderDeviceId: 'alice-1',
        groupId: opaque('quota'),
      } as const;
      facade.appendMlsTransportEvent({
        ...base,
        eventId: 'quota-commit-1',
        eventType: 'commit',
        epoch: 1,
        payload: opaque('quota-commit'),
      });
      facade.appendMlsTransportEvent({
        ...base,
        eventId: 'quota-application-1',
        eventType: 'application',
        epoch: 1,
        payload: opaque('quota-application'),
      });
      expect(() =>
        facade.appendMlsTransportEvent({
          ...base,
          eventId: 'quota-application-2',
          eventType: 'application',
          epoch: 1,
          payload: opaque('quota-application-2'),
        }),
      ).toThrow(/event inventory quota/i);
      expect(
        database
          .prepare('SELECT count(*) AS count FROM mls_transport_events')
          .get(),
      ).toEqual({ count: 2 });
    } finally {
      database.close();
    }
  });

  it('records a retention floor before deleting expired events', () => {
    const { database, facade, advanceTime } = createHarness({
      policy: { transportEventTtlMs: 1_000 },
    });
    try {
      const base = {
        organizationId: 'org-a',
        senderAccountId: 'alice',
        peerAccountId: 'bob',
        senderDeviceId: 'alice-1',
        groupId: opaque('ret'),
      } as const;
      facade.appendMlsTransportEvent({
        ...base,
        eventId: 'retention-commit-1',
        eventType: 'commit',
        epoch: 1,
        payload: opaque('retention-commit'),
      });
      const last = facade.appendMlsTransportEvent({
        ...base,
        eventId: 'retention-application-1',
        eventType: 'application',
        epoch: 1,
        payload: opaque('retention-application'),
      });
      advanceTime(1_001);

      expect(() =>
        facade.listMlsTransportEvents({
          organizationId: 'org-a',
          accountId: 'alice',
          peerAccountId: 'bob',
          afterSequence: 0,
        }),
      ).toThrow(/secure session reset required/i);
      expect(facade.cleanupExpiredMlsResources({ limit: 10 })).toMatchObject({
        eventsDeleted: 2,
        conversationsAdvanced: 1,
      });
      expect(
        database
          .prepare(
            `SELECT retention_floor_sequence FROM mls_conversations
             WHERE organization_id = 'org-a'`,
          )
          .get(),
      ).toEqual({ retention_floor_sequence: last.sequence });
      expect(
        facade.listMlsTransportEvents({
          organizationId: 'org-a',
          accountId: 'alice',
          peerAccountId: 'bob',
          afterSequence: last.sequence,
        }),
      ).toEqual([]);
    } finally {
      database.close();
    }
  });
});
