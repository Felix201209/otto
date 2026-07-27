/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { Database } from './modules/data_platform/index.js';
import {
  assertAccountPassword,
  createSmsChallengeFacade,
  hashIdentitySecret,
  identitySecretMatches,
  isAcceptableAccountPassword,
  SMS_CHALLENGE_TTL_MS,
  type SmsChallengeAccountView,
  type SmsChallengeRepositoryStore,
} from './modules/identity_organization/index.js';

interface TestAccount extends SmsChallengeAccountView {
  name: string;
}

function createDatabase(): Database {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE organizations (id TEXT PRIMARY KEY);
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      employee_id TEXT,
      phone TEXT,
      name TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE sms_login_challenges (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      attempts_remaining INTEGER NOT NULL,
      consumed_at_ms INTEGER,
      created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE sms_registration_challenges (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      phone TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      attempts_remaining INTEGER NOT NULL,
      organization_invite_id TEXT,
      department TEXT,
      department_id TEXT,
      position_id TEXT,
      position_title TEXT,
      role TEXT,
      consumed_at_ms INTEGER,
      created_at_ms INTEGER NOT NULL
    );
  `);
  return database;
}

function createStore(
  database: Database,
  audit = vi.fn(),
): SmsChallengeRepositoryStore<TestAccount> {
  let sequence = 0;
  return {
    db: () => database,
    defaultOrganizationId: 'org-default',
    getAccount(accountId) {
      const row = database
        .prepare('SELECT * FROM accounts WHERE id = ?')
        .get(accountId) as
        | {
            id: string;
            organization_id: string;
            employee_id: string | null;
            phone: string | null;
            name: string;
            status: 'active' | 'disabled';
          }
        | undefined;
      return row
        ? {
            id: row.id,
            organizationId: row.organization_id,
            employeeId: row.employee_id,
            phone: row.phone,
            name: row.name,
            status: row.status,
          }
        : null;
    },
    organizationExists: (organizationId) =>
      Boolean(
        database
          .prepare('SELECT 1 FROM organizations WHERE id = ?')
          .get(organizationId),
      ),
    normalizePhone(phone) {
      const digits = phone.replace(/\D/g, '');
      if (!/^1\d{10}$/.test(digits)) throw new Error('手机号格式不正确');
      return `+86${digits}`;
    },
    hashSecret: hashIdentitySecret,
    secretMatches: identitySecretMatches,
    createChallengeId(kind) {
      sequence += 1;
      return `${kind === 'login' ? 'sms' : 'smsreg'}_${sequence}`;
    },
    audit,
  };
}

function seedIdentity(database: Database): void {
  database
    .prepare('INSERT INTO organizations (id) VALUES (?), (?)')
    .run('org-default', 'org-a');
  database
    .prepare(
      `INSERT INTO accounts (id, organization_id, employee_id, phone, name, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'account-a',
      'org-a',
      'employee-a',
      '+8613800138000',
      'Alice',
      'active',
    );
}

describe('identity credential security kernel', () => {
  it('keeps password policy and scrypt verification behind one public contract', () => {
    expect(isAcceptableAccountPassword('Otto-2026')).toBe(true);
    expect(isAcceptableAccountPassword('short')).toBe(false);
    expect(isAcceptableAccountPassword('12345678')).toBe(false);
    expect(isAcceptableAccountPassword('abcdefgh')).toBe(false);
    expect(isAcceptableAccountPassword('aaaaaaaa')).toBe(false);
    expect(() => assertAccountPassword('密码-password-1')).toThrow(
      '登录密码不能包含控制字符或不可见字符',
    );

    const first = hashIdentitySecret('Otto-2026');
    const second = hashIdentitySecret('Otto-2026');
    expect(first).not.toBe(second);
    expect(identitySecretMatches('Otto-2026', first)).toBe(true);
    expect(identitySecretMatches('wrong-password', first)).toBe(false);
    expect(identitySecretMatches('Otto-2026', 'malformed')).toBe(false);
  });
});

describe('identity SMS challenge kernel', () => {
  it('issues tenant-bound login challenges and enforces cooldown and hourly quota', () => {
    const database = createDatabase();
    seedIdentity(database);
    const audit = vi.fn();
    const sms = createSmsChallengeFacade(createStore(database, audit));
    const start = Date.UTC(2026, 0, 1);

    try {
      const first = sms.createSmsLoginChallenge('account-a', '123456', {
        now: start,
      });
      expect(first).toMatchObject({ ok: true, retryAfterSeconds: 60 });
      expect(
        sms.createSmsLoginChallenge('account-a', '123456', {
          now: start + 30_000,
        }),
      ).toEqual({ ok: false, reason: 'cooldown', retryAfterSeconds: 30 });
      for (let index = 1; index < 5; index += 1) {
        expect(
          sms.createSmsLoginChallenge('account-a', '123456', {
            now: start + index * 60_000,
          }).ok,
        ).toBe(true);
      }
      expect(
        sms.createSmsLoginChallenge('account-a', '123456', {
          now: start + 5 * 60_000,
        }),
      ).toMatchObject({ ok: false, reason: 'hourly_limit' });
      expect(audit).toHaveBeenCalledWith(
        'sms_login_code_requested',
        'employee-a',
        'SMS login code requested',
        'org-a',
      );
    } finally {
      database.close();
    }
  });

  it('locks wrong login codes, consumes successful codes and fails closed for disabled accounts', () => {
    const database = createDatabase();
    seedIdentity(database);
    const sms = createSmsChallengeFacade(createStore(database));
    const start = Date.UTC(2026, 0, 1);

    try {
      const issued = sms.createSmsLoginChallenge('account-a', '123456', {
        now: start,
      });
      if (!issued.ok) throw new Error('challenge should be issued');
      expect(
        sms.verifySmsLoginChallenge(issued.challengeId, '000000', start + 1),
      ).toEqual({ ok: false, reason: 'invalid', attemptsRemaining: 4 });
      expect(
        sms.verifySmsLoginChallenge(issued.challengeId, '123456', start + 2),
      ).toMatchObject({ ok: true, account: { id: 'account-a' } });
      expect(
        sms.verifySmsLoginChallenge(issued.challengeId, '123456', start + 3),
      ).toEqual({ ok: false, reason: 'used', attemptsRemaining: 4 });

      const disabled = sms.createSmsLoginChallenge('account-a', '654321', {
        now: start + 60_000,
      });
      if (!disabled.ok) throw new Error('challenge should be issued');
      database
        .prepare("UPDATE accounts SET status = 'disabled' WHERE id = ?")
        .run('account-a');
      expect(
        sms.verifySmsLoginChallenge(
          disabled.challengeId,
          '654321',
          start + 60_001,
        ),
      ).toEqual({ ok: false, reason: 'used', attemptsRemaining: 0 });
    } finally {
      database.close();
    }
  });

  it('expires login challenges and lets a failed SMS provider discard quota usage', () => {
    const database = createDatabase();
    seedIdentity(database);
    const sms = createSmsChallengeFacade(createStore(database));
    const start = Date.UTC(2026, 0, 1);

    try {
      const discarded = sms.createSmsLoginChallenge('account-a', '123456', {
        now: start,
      });
      if (!discarded.ok) throw new Error('challenge should be issued');
      sms.discardSmsLoginChallenge(discarded.challengeId);
      expect(
        sms.createSmsLoginChallenge('account-a', '123456', { now: start }).ok,
      ).toBe(true);

      const expiring = sms.createSmsLoginChallenge('account-a', '654321', {
        now: start + 60_000,
      });
      if (!expiring.ok) throw new Error('challenge should be issued');
      expect(
        sms.verifySmsLoginChallenge(
          expiring.challengeId,
          '654321',
          start + 60_000 + SMS_CHALLENGE_TTL_MS + 1,
        ),
      ).toEqual({ ok: false, reason: 'expired', attemptsRemaining: 5 });
    } finally {
      database.close();
    }
  });

  it('round-trips registration context without crossing organizations', () => {
    const database = createDatabase();
    seedIdentity(database);
    const audit = vi.fn();
    const sms = createSmsChallengeFacade(createStore(database, audit));
    const start = Date.UTC(2026, 0, 1);

    try {
      const issued = sms.createSmsRegistrationChallenge(
        '13800138001',
        '123456',
        'org-a',
        {
          now: start,
          organizationInviteId: 'invite-a',
          department: ' 研发部 ',
          departmentId: 'department-a',
          positionId: 'position-a',
          positionTitle: ' 工程师 ',
          role: ' member ',
        },
      );
      if (!issued.ok) throw new Error('challenge should be issued');
      expect(
        sms.verifySmsRegistrationChallenge(
          issued.challengeId,
          '123456',
          start + 1,
        ),
      ).toEqual({
        ok: true,
        phone: '+8613800138001',
        organizationId: 'org-a',
        organizationInviteId: 'invite-a',
        department: '研发部',
        departmentId: 'department-a',
        positionId: 'position-a',
        positionTitle: '工程师',
        role: 'member',
      });
      expect(audit).toHaveBeenLastCalledWith(
        'sms_registration_verified',
        null,
        'SMS registration verified',
        'org-a',
      );
      expect(() =>
        sms.createSmsRegistrationChallenge(
          '13800138002',
          '123456',
          'missing-org',
          { now: start },
        ),
      ).toThrow('Organization not found');
    } finally {
      database.close();
    }
  });

  it('locks registration challenges after five failed attempts', () => {
    const database = createDatabase();
    seedIdentity(database);
    const sms = createSmsChallengeFacade(createStore(database));
    const start = Date.UTC(2026, 0, 1);

    try {
      const issued = sms.createSmsRegistrationChallenge(
        '13800138003',
        '123456',
        'org-a',
        { now: start },
      );
      if (!issued.ok) throw new Error('challenge should be issued');
      for (let attempt = 4; attempt > 0; attempt -= 1) {
        expect(
          sms.verifySmsRegistrationChallenge(
            issued.challengeId,
            '000000',
            start + (5 - attempt),
          ),
        ).toEqual({
          ok: false,
          reason: 'invalid',
          attemptsRemaining: attempt,
        });
      }
      expect(
        sms.verifySmsRegistrationChallenge(
          issued.challengeId,
          '000000',
          start + 5,
        ),
      ).toEqual({ ok: false, reason: 'locked', attemptsRemaining: 0 });
      expect(
        sms.verifySmsRegistrationChallenge(
          issued.challengeId,
          '123456',
          start + 6,
        ),
      ).toEqual({ ok: false, reason: 'locked', attemptsRemaining: 0 });
    } finally {
      database.close();
    }
  });
});
