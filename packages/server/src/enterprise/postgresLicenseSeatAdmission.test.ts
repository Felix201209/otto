/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { canonicalJson } from '../modules/commercial_control/signedEnvelope.js';
import type { PostgresClientLike } from '../modules/data_platform/postgresDatabaseLifecycle.js';
import {
  enforcePostgresEnterpriseSeatAdmission,
  PostgresEnterpriseLicenseAdmissionError,
  PostgresEnterpriseSeatLimitError,
  type PostgresLicenseSeatAdmission,
} from './postgresLicenseSeatAdmission.js';

const claims = {
  organizationId: 'org-1',
  seatLimit: 2,
  expiresAt: '2099-08-14T00:00:00.000Z',
};
const admission: PostgresLicenseSeatAdmission = {
  recordVersion: 3,
  signature: 'ed25519:signed-license',
  claimsSha256: createHash('sha256')
    .update(canonicalJson(claims))
    .digest('hex'),
  seatLimit: 2,
};

function client(input: {
  activeSeats?: number;
  version?: number;
  storedClaims?: Record<string, unknown>;
  signature?: string;
}) {
  const calls: string[] = [];
  const database: PostgresClientLike = {
    query: vi.fn(async (sql: string) => {
      calls.push(sql);
      if (sql.includes('FROM enterprise_business_records')) {
        return {
          rows: [
            {
              version: input.version ?? 3,
              payload: {
                signedEnvelope: {
                  payload: input.storedClaims ?? claims,
                  signature: input.signature ?? admission.signature,
                },
              },
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes('count(*)::integer AS count')) {
        return {
          rows: [{ count: input.activeSeats ?? 1 }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: null };
    }),
    release: vi.fn(),
  };
  return { database, calls };
}

describe('PostgreSQL signed License seat admission', () => {
  it('serializes, pins the signed record, and admits a remaining seat', async () => {
    const { database, calls } = client({ activeSeats: 1 });
    await expect(
      enforcePostgresEnterpriseSeatAdmission(
        database,
        'org-1',
        admission,
        Date.parse('2026-08-14T00:00:00.000Z'),
      ),
    ).resolves.toBeUndefined();
    expect(calls[0]).toContain('pg_advisory_xact_lock');
    expect(calls[1]).toContain('FROM enterprise_business_records');
    expect(calls[2]).toContain("account_type = 'enterprise'");
  });

  it('rejects a full tenant', async () => {
    const { database } = client({ activeSeats: 2 });
    await expect(
      enforcePostgresEnterpriseSeatAdmission(database, 'org-1', admission),
    ).rejects.toBeInstanceOf(PostgresEnterpriseSeatLimitError);
  });

  it.each([
    ['version changed', { version: 4 }],
    ['signature changed', { signature: 'ed25519:replacement' }],
    ['claims changed', { storedClaims: { ...claims, seatLimit: 99 } }],
    [
      'license expired',
      { storedClaims: { ...claims, expiresAt: '2020-01-01T00:00:00.000Z' } },
    ],
  ] as const)('rejects when the %s', async (_name, change) => {
    const { database } = client(change);
    await expect(
      enforcePostgresEnterpriseSeatAdmission(database, 'org-1', admission),
    ).rejects.toBeInstanceOf(PostgresEnterpriseLicenseAdmissionError);
  });
});
