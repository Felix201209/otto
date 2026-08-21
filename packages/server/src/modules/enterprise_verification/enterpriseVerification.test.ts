/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createEncryptedFieldCipher,
  createEncryptedObjectStore,
  Database,
} from '../data_platform/index.js';
import {
  createEnterpriseVerificationComposition,
  ENTERPRISE_VERIFICATION_SCHEMA_CONTRIBUTOR,
  normalizeAndValidateUnifiedSocialCreditCode,
  type EnterpriseVerificationComposition,
  type EnterpriseVerificationEvidencePurpose,
  type SubmitEnterpriseVerificationApplicationInput,
} from './index.js';

const VALID_CREDIT_CODE = '91330100799655058B';
const SECOND_VALID_CREDIT_CODE = '91440300708461136T';
const PDF_CONTENT = Buffer.from('%PDF-1.7\nprivate enterprise evidence');
const PNG_CONTENT = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('private png evidence'),
]);

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

interface SetupResult {
  db: Database;
  composition: EnterpriseVerificationComposition;
  objectRoot: string;
  objectStore: ReturnType<typeof createEncryptedObjectStore>;
  fieldCipher: ReturnType<typeof createEncryptedFieldCipher>;
  setNow(value: number): void;
}

function createBaseSchema(db: Database): void {
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL COLLATE NOCASE UNIQUE,
      invite_secret TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE employees (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT,
      department TEXT,
      department_id TEXT,
      position_id TEXT,
      position_title TEXT,
      invite_code TEXT,
      status TEXT DEFAULT 'active',
      personality TEXT,
      onboarded_at TEXT DEFAULT (datetime('now')),
      offboarded_at TEXT
    );
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      account_type TEXT NOT NULL,
      employee_id TEXT UNIQUE,
      username TEXT NOT NULL UNIQUE,
      phone TEXT,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT,
      department TEXT,
      department_id TEXT,
      position_id TEXT,
      position_title TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      deleted_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE auth_sessions (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT
    );
    CREATE TABLE organization_departments (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      name TEXT NOT NULL COLLATE NOCASE,
      parent_department_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(organization_id, name)
    );
  `);
  ENTERPRISE_VERIFICATION_SCHEMA_CONTRIBUTOR.apply(db);
}

function seedPersonalAccount(
  db: Database,
  input: {
    organizationId?: string;
    accountId?: string;
    accountName?: string;
    slug?: string;
  } = {},
): { organizationId: string; accountId: string; accountName: string } {
  const organizationId = input.organizationId ?? 'org-personal';
  const accountId = input.accountId ?? 'acct-applicant';
  const accountName = input.accountName ?? '申请账号姓名';
  const slug = input.slug ?? `personal-${accountId}`;
  db.prepare(
    `INSERT INTO organizations (id, name, slug, invite_secret, status)
     VALUES (?, ?, ?, ?, 'active')`,
  ).run(organizationId, `${accountName}的个人空间`, slug, `secret-${accountId}`);
  db.prepare(
    `INSERT INTO accounts (
      id, organization_id, account_type, employee_id, username, password_hash,
      name, phone, role, is_admin, status, deleted_at
    ) VALUES (?, ?, 'personal', NULL, ?, 'hash', ?, ?, '个人用户', 0, 'active', NULL)`,
  ).run(
    accountId,
    organizationId,
    `${accountId}@example.test`,
    accountName,
    `+86138${accountId.replace(/\D/gu, '').padStart(8, '0').slice(-8)}`,
  );
  db.prepare(
    `INSERT INTO auth_sessions
     (id, organization_id, account_id, token_hash, expires_at)
     VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z')`,
  ).run(
    `session-${accountId}`,
    organizationId,
    accountId,
    `token-${accountId}`,
  );
  return { organizationId, accountId, accountName };
}

function setup(): SetupResult {
  const db = new Database(':memory:');
  createBaseSchema(db);
  seedPersonalAccount(db);
  const objectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-enterprise-evidence-'));
  temporaryDirectories.push(objectRoot);
  const keyProvider = {
    getKey: () => Buffer.alloc(32, 23),
    clear() {},
  };
  const objectStore = createEncryptedObjectStore({ root: objectRoot, keyProvider });
  const fieldCipher = createEncryptedFieldCipher({ keyProvider });
  let now = 1_800_000_000_000;
  let applicationCounter = 0;
  let evidenceCounter = 0;
  let departmentCounter = 0;
  let employeeCounter = 0;
  const composition = createEnterpriseVerificationComposition({
    db: () => db,
    fieldCipher,
    objectStore,
    isPlatformReviewer: (reviewerId) => reviewerId === 'reviewer-platform',
    now: () => now,
    createApplicationId: () => `ev_${++applicationCounter}`,
    createEvidenceId: () => `eve_${++evidenceCounter}`,
    createDepartmentId: () => `dept_${++departmentCounter}`,
    createEmployeeId: () => `emp_${++employeeCounter}`,
  });
  return {
    db,
    composition,
    objectRoot,
    objectStore,
    fieldCipher,
    setNow(value) {
      now = value;
    },
  };
}

function uploadEvidence(
  composition: EnterpriseVerificationComposition,
  purpose: EnterpriseVerificationEvidencePurpose,
  input: {
    accountId?: string;
    organizationId?: string;
    content?: Buffer;
    contentType?: string;
    fileName?: string;
  } = {},
) {
  const content = input.content ?? PDF_CONTENT;
  return composition.uploadEnterpriseVerificationEvidence({
    applicantAccountId: input.accountId ?? 'acct-applicant',
    sourceOrganizationId: input.organizationId ?? 'org-personal',
    purpose,
    fileName: input.fileName ?? `${purpose}.pdf`,
    contentType: input.contentType ?? 'application/pdf',
    content,
  });
}

function selfServiceInput(
  overrides: Partial<SubmitEnterpriseVerificationApplicationInput> = {},
): SubmitEnterpriseVerificationApplicationInput {
  return {
    applicantAccountId: 'acct-applicant',
    sourceOrganizationId: 'org-personal',
    enterpriseName: '北京示例科技有限公司',
    ...overrides,
  };
}

function insertLegacyManualReview(
  result: SetupResult,
  input: {
    applicantAccountId?: string;
    sourceOrganizationId?: string;
    enterpriseName?: string;
    creditCode?: string;
    legalRepresentativeName?: string;
    applicantIdentity?: 'legal_representative' | 'authorized_agent';
  } = {},
) {
  const applicantAccountId = input.applicantAccountId ?? 'acct-applicant';
  const sourceOrganizationId = input.sourceOrganizationId ?? 'org-personal';
  const applicantIdentity = input.applicantIdentity ?? 'legal_representative';
  const businessLicense = uploadEvidence(result.composition, 'business_license', {
    accountId: applicantAccountId,
    organizationId: sourceOrganizationId,
  });
  const authorizationLetter =
    applicantIdentity === 'authorized_agent'
      ? uploadEvidence(result.composition, 'authorization_letter', {
          accountId: applicantAccountId,
          organizationId: sourceOrganizationId,
          content: PNG_CONTENT,
          contentType: 'image/png',
          fileName: 'authorization.png',
        })
      : null;
  const applicationCount = result.db.prepare(
    'SELECT COUNT(*) AS count FROM enterprise_verification_applications',
  ).get() as { count: number };
  const applicationId = `legacy_${applicationCount.count + 1}`;
  const context = (field: string) =>
    `enterprise_verification:${applicationId}:${field}`;
  const legalRepresentative = result.fieldCipher.encryptText(
    input.legalRepresentativeName ?? '法定代表人甲',
    context('legal_representative_name'),
  );
  const businessLicenseReference = result.fieldCipher.encryptText(
    businessLicense.evidenceReference,
    context('business_license_reference'),
  );
  const authorizationReference = authorizationLetter
    ? result.fieldCipher.encryptText(
        authorizationLetter.evidenceReference,
        context('authorization_letter_reference'),
      )
    : null;
  const submittedAtMs = 1_700_000_000_000 + applicationCount.count;
  result.db.prepare(
    `INSERT INTO enterprise_verification_applications (
      id, applicant_account_id, source_organization_id, enterprise_name,
      unified_social_credit_code, applicant_identity,
      legal_representative_name_ciphertext, legal_representative_name_iv,
      legal_representative_name_auth_tag, legal_representative_name_key_version,
      business_license_reference_ciphertext, business_license_reference_iv,
      business_license_reference_auth_tag, business_license_reference_key_version,
      business_license_sha256,
      authorization_letter_reference_ciphertext,
      authorization_letter_reference_iv,
      authorization_letter_reference_auth_tag,
      authorization_letter_reference_key_version,
      authorization_letter_sha256,
      status, submitted_at_ms, updated_at_ms
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      'manual_review', ?, ?
    )`,
  ).run(
    applicationId,
    applicantAccountId,
    sourceOrganizationId,
    input.enterpriseName ?? '北京示例科技有限公司',
    input.creditCode ?? VALID_CREDIT_CODE,
    applicantIdentity,
    legalRepresentative.ciphertext,
    legalRepresentative.iv,
    legalRepresentative.authTag,
    legalRepresentative.keyVersion,
    businessLicenseReference.ciphertext,
    businessLicenseReference.iv,
    businessLicenseReference.authTag,
    businessLicenseReference.keyVersion,
    businessLicense.evidenceSha256,
    authorizationReference?.ciphertext ?? null,
    authorizationReference?.iv ?? null,
    authorizationReference?.authTag ?? null,
    authorizationReference?.keyVersion ?? null,
    authorizationLetter?.evidenceSha256 ?? null,
    submittedAtMs,
    submittedAtMs,
  );
  result.db.prepare(
    `UPDATE enterprise_verification_evidence
     SET application_id = ? WHERE id = ?`,
  ).run(applicationId, businessLicense.evidenceReference);
  if (authorizationLetter) {
    result.db.prepare(
      `UPDATE enterprise_verification_evidence
       SET application_id = ? WHERE id = ?`,
    ).run(applicationId, authorizationLetter.evidenceReference);
  }
  const application =
    result.composition.getEnterpriseVerificationApplicationForApplicant({
      applicantAccountId,
      applicationId,
    });
  if (!application) throw new Error('legacy verification fixture missing');
  return { application, businessLicense, authorizationLetter };
}

function expectedSlug(enterpriseName: string, creditCode: string): string {
  const prefix = enterpriseName
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/\s+/gu, '-')
    .replace(/[^\p{Letter}\p{Number}-]+/gu, '')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, 24) || 'enterprise';
  const digest = createHash('sha256').update(creditCode).digest('hex').slice(0, 12);
  return `${prefix}-${digest}`.slice(0, 48);
}

describe('enterprise verification credit code validation', () => {
  it('accepts official-character-set codes with a valid check digit', () => {
    expect(normalizeAndValidateUnifiedSocialCreditCode(VALID_CREDIT_CODE))
      .toBe(VALID_CREDIT_CODE);
    expect(normalizeAndValidateUnifiedSocialCreditCode(' 91440300708461136t '))
      .toBe(SECOND_VALID_CREDIT_CODE);
  });

  it('rejects a valid-looking code with the wrong check digit', () => {
    expect(() =>
      normalizeAndValidateUnifiedSocialCreditCode('91330100799655058A'),
    ).toThrow('统一社会信用代码校验位错误');
  });

  it('rejects invalid characters and lengths', () => {
    expect(() =>
      normalizeAndValidateUnifiedSocialCreditCode('91330100799655O58B'),
    ).toThrow('包含无效字符');
    expect(() => normalizeAndValidateUnifiedSocialCreditCode('123'))
      .toThrow('必须为 18 位');
  });
});

describe('enterprise verification evidence', () => {
  it('uploads encrypted evidence, computes SHA-256 and never exposes storage keys', () => {
    const { db, composition, objectRoot, objectStore } = setup();
    const uploaded = uploadEvidence(composition, 'business_license');
    expect(uploaded).toMatchObject({
      evidenceReference: 'eve_1',
      evidenceSha256: createHash('sha256').update(PDF_CONTENT).digest('hex'),
      contentType: 'application/pdf',
      sizeBytes: PDF_CONTENT.length,
    });
    expect(uploaded).not.toHaveProperty('storageKey');

    const row = db.prepare(
      `SELECT storage_key_ciphertext, file_name, sha256
       FROM enterprise_verification_evidence WHERE id = ?`,
    ).get(uploaded.evidenceReference) as Record<string, string>;
    const storageKey = objectStore.listKeys()[0]!;
    expect(row.storage_key_ciphertext).not.toContain(storageKey);
    expect(JSON.stringify(row)).not.toContain(storageKey);
    const raw = fs.readFileSync(path.join(objectRoot, ...storageKey.split('/')));
    expect(raw.includes(PDF_CONTENT)).toBe(false);
  });

  it('rejects unsupported, spoofed, empty and oversized evidence', () => {
    const { composition } = setup();
    expect(() =>
      uploadEvidence(composition, 'business_license', {
        contentType: 'text/plain',
      }),
    ).toThrow('仅支持 PDF、PNG 或 JPEG');
    expect(() =>
      uploadEvidence(composition, 'business_license', {
        contentType: 'image/png',
        fileName: 'fake.png',
      }),
    ).toThrow('内容与类型不匹配');
    expect(() =>
      uploadEvidence(composition, 'business_license', {
        content: Buffer.alloc(0),
      }),
    ).toThrow('不能为空');
    const tooLarge = Buffer.alloc(8 * 1024 * 1024 + 1);
    tooLarge.write('%PDF-');
    expect(() =>
      uploadEvidence(composition, 'business_license', { content: tooLarge }),
    ).toThrow('不能超过 8MB');
  });

  it('accepts PNG and JPEG signatures', () => {
    const { composition } = setup();
    expect(
      uploadEvidence(composition, 'business_license', {
        content: PNG_CONTENT,
        contentType: 'image/png',
        fileName: 'license.png',
      }).contentType,
    ).toBe('image/png');
    expect(
      uploadEvidence(composition, 'authorization_letter', {
        content: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01]),
        contentType: 'image/jpeg',
        fileName: 'authorization.jpg',
      }).contentType,
    ).toBe('image/jpeg');
  });

  it('rejects upload from an account outside the source personal organization', () => {
    const { composition } = setup();
    expect(() =>
      uploadEvidence(composition, 'business_license', {
        accountId: 'acct-other',
      }),
    ).toThrow('不是该个人组织中的有效 personal account');
  });
});

describe('enterprise self-service creation', () => {
  it('immediately approves and atomically provisions the current account as CEO admin', () => {
    const result = setup();
    const created = result.composition.submitEnterpriseVerificationApplication(
      selfServiceInput(),
    );

    expect(created).toMatchObject({
      replayed: false,
      application: {
        status: 'approved',
        targetOrganizationId: 'org-personal',
        enterpriseName: '北京示例科技有限公司',
        unifiedSocialCreditCode: null,
        legalRepresentativeName: null,
        businessLicense: null,
        authorizationLetter: null,
        reviewerId: 'self-service',
      },
    });
    expect(created.application.reviewNote).toContain('未进行权威工商主体认证');

    const stored = result.db.prepare(
      `SELECT status, unified_social_credit_code, reviewer_id
       FROM enterprise_verification_applications WHERE id = ?`,
    ).get(created.application.id) as Record<string, unknown>;
    expect(stored).toMatchObject({
      status: 'approved',
      reviewer_id: 'self-service',
    });
    expect(String(stored.unified_social_credit_code)).toMatch(
      /^OTTO-SELF-SERVICE:/,
    );

    const organization = result.db.prepare(
      'SELECT id, name, slug FROM organizations WHERE id = ?',
    ).get('org-personal') as { id: string; name: string; slug: string };
    expect(organization).toEqual({
      id: 'org-personal',
      name: '北京示例科技有限公司',
      slug: expectedSlug(
        '北京示例科技有限公司',
        `OTTO-SELF-SERVICE:${created.application.id}`,
      ),
    });
    const account = result.db.prepare(
      `SELECT account_type, employee_id, role, department, department_id,
              position_title, is_admin
       FROM accounts WHERE id = 'acct-applicant'`,
    ).get() as Record<string, unknown>;
    expect(account).toMatchObject({
      account_type: 'enterprise',
      role: 'CEO',
      department: '管理层',
      position_title: 'CEO',
      is_admin: 1,
    });
    expect(result.db.prepare(
      'SELECT name, role, position_title FROM employees WHERE id = ?',
    ).get(account.employee_id)).toEqual({
      name: '申请账号姓名',
      role: 'CEO',
      position_title: 'CEO',
    });
    expect(result.db.prepare(
      'SELECT name FROM organization_departments WHERE id = ?',
    ).get(account.department_id)).toEqual({ name: '管理层' });
    expect(result.db.prepare(
      'SELECT organization_id FROM auth_sessions WHERE account_id = ?',
    ).get('acct-applicant')).toEqual({ organization_id: 'org-personal' });
  });

  it('requires a non-empty enterprise name of at most 80 characters', () => {
    const result = setup();
    expect(() =>
      result.composition.submitEnterpriseVerificationApplication(
        selfServiceInput({ enterpriseName: '   ' }),
      ),
    ).toThrow('企业名称不能为空');
    expect(() =>
      result.composition.submitEnterpriseVerificationApplication(
        selfServiceInput({ enterpriseName: '企'.repeat(81) }),
      ),
    ).toThrow('不能超过 80 个字符');
  });

  it('requires an active personal account with a non-empty verified phone', () => {
    const missingPhone = setup();
    missingPhone.db.prepare(
      'UPDATE accounts SET phone = NULL WHERE id = ?',
    ).run('acct-applicant');
    expect(() =>
      missingPhone.composition.submitEnterpriseVerificationApplication(
        selfServiceInput(),
      ),
    ).toThrow('请先绑定并验证手机号');

    const enterpriseAccount = setup();
    enterpriseAccount.db.prepare(
      "UPDATE accounts SET account_type = 'enterprise' WHERE id = ?",
    ).run('acct-applicant');
    expect(() =>
      enterpriseAccount.composition.submitEnterpriseVerificationApplication(
        selfServiceInput(),
      ),
    ).toThrow('有效 personal account');

    const disabledAccount = setup();
    disabledAccount.db.prepare(
      "UPDATE accounts SET status = 'disabled' WHERE id = ?",
    ).run('acct-applicant');
    expect(() =>
      disabledAccount.composition.submitEnterpriseVerificationApplication(
        selfServiceInput(),
      ),
    ).toThrow('有效 personal account');
  });

  it('requires the personal organization to have exactly one active account', () => {
    const result = setup();
    result.db.prepare(
      `INSERT INTO accounts (
        id, organization_id, account_type, username, password_hash, name,
        role, is_admin, status
      ) VALUES ('acct-shared', 'org-personal', 'personal', 'shared@example.test',
        'hash', '共享账号', '个人用户', 0, 'active')`,
    ).run();

    expect(() =>
      result.composition.submitEnterpriseVerificationApplication(
        selfServiceInput(),
      ),
    ).toThrow('存在其他活动账号');
    expect(result.db.prepare(
      'SELECT COUNT(*) AS count FROM enterprise_verification_applications',
    ).get()).toEqual({ count: 0 });
    expect(result.db.prepare(
      'SELECT name, slug FROM organizations WHERE id = ?',
    ).get('org-personal')).toEqual({
      name: '申请账号姓名的个人空间',
      slug: 'personal-acct-applicant',
    });
  });

  it('replays the same creation and rejects a different enterprise name', () => {
    const result = setup();
    const first = result.composition.submitEnterpriseVerificationApplication(
      selfServiceInput(),
    );
    const replay = result.composition.submitEnterpriseVerificationApplication(
      selfServiceInput(),
    );
    expect(replay.replayed).toBe(true);
    expect(replay.application.id).toBe(first.application.id);
    expect(() =>
      result.composition.submitEnterpriseVerificationApplication(
        selfServiceInput({ enterpriseName: '另一家企业' }),
      ),
    ).toThrow('已经创建企业');
    expect(result.db.prepare(
      'SELECT COUNT(*) AS count FROM enterprise_verification_applications',
    ).get()).toEqual({ count: 1 });
    expect(result.db.prepare('SELECT COUNT(*) AS count FROM employees').get())
      .toEqual({ count: 1 });
  });

  it('cancels a legacy manual-review application and preserves its evidence', () => {
    const result = setup();
    const legacy = insertLegacyManualReview(result);
    const created = result.composition.submitEnterpriseVerificationApplication(
      selfServiceInput({ enterpriseName: '自助创建企业' }),
    );

    expect(created.application.status).toBe('approved');
    expect(result.db.prepare(
      `SELECT status, cancelled_at_ms, reviewer_id
       FROM enterprise_verification_applications WHERE id = ?`,
    ).get(legacy.application.id)).toEqual({
      status: 'cancelled',
      cancelled_at_ms: 1_800_000_000_000,
      reviewer_id: null,
    });
    expect(result.composition.readEnterpriseVerificationEvidence({
      applicationId: legacy.application.id,
      evidenceReference: legacy.businessLicense.evidenceReference,
      reviewerId: 'reviewer-platform',
    }).content).toEqual(PDF_CONTENT);
  });

  it('rolls back the record, legacy cancellation and organization upgrade together', () => {
    const result = setup();
    const legacy = insertLegacyManualReview(result);
    result.db.exec(`
      CREATE TRIGGER fail_enterprise_employee
      BEFORE INSERT ON employees
      BEGIN
        SELECT RAISE(ABORT, 'forced employee failure');
      END;
    `);

    expect(() =>
      result.composition.submitEnterpriseVerificationApplication(
        selfServiceInput({ enterpriseName: '事务回滚企业' }),
      ),
    ).toThrow('forced employee failure');
    expect(result.db.prepare(
      `SELECT status, cancelled_at_ms FROM enterprise_verification_applications
       WHERE id = ?`,
    ).get(legacy.application.id)).toEqual({
      status: 'manual_review',
      cancelled_at_ms: null,
    });
    expect(result.db.prepare(
      'SELECT COUNT(*) AS count FROM enterprise_verification_applications',
    ).get()).toEqual({ count: 1 });
    expect(result.db.prepare(
      'SELECT account_type, employee_id, is_admin FROM accounts WHERE id = ?',
    ).get('acct-applicant')).toEqual({
      account_type: 'personal',
      employee_id: null,
      is_admin: 0,
    });
    expect(result.db.prepare('SELECT COUNT(*) AS count FROM employees').get())
      .toEqual({ count: 0 });
    expect(result.db.prepare(
      'SELECT COUNT(*) AS count FROM organization_departments',
    ).get()).toEqual({ count: 0 });
  });

  it('returns the approved self-service record only to its owner and cannot cancel it', () => {
    const result = setup();
    const created = result.composition.submitEnterpriseVerificationApplication(
      selfServiceInput(),
    ).application;
    expect(result.composition.getEnterpriseVerificationApplicationForApplicant({
      applicantAccountId: 'acct-applicant',
    })?.id).toBe(created.id);
    expect(result.composition.getEnterpriseVerificationApplicationForApplicant({
      applicantAccountId: 'acct-other',
      applicationId: created.id,
    })).toBeNull();
    expect(() =>
      result.composition.cancelEnterpriseVerificationApplication({
        applicationId: created.id,
        applicantAccountId: 'acct-applicant',
      }),
    ).toThrow('当前状态不允许取消');
  });
});

describe('legacy enterprise verification review compatibility', () => {
  it('keeps legacy evidence and review operations restricted to platform reviewers', () => {
    const result = setup();
    const legacy = insertLegacyManualReview(result);
    expect(() =>
      result.composition.listEnterpriseVerificationApplications({
        reviewerId: 'acct-applicant',
      }),
    ).toThrow('仅平台审核员');
    expect(() =>
      result.composition.readEnterpriseVerificationEvidence({
        applicationId: legacy.application.id,
        evidenceReference: legacy.businessLicense.evidenceReference,
        reviewerId: 'acct-applicant',
      }),
    ).toThrow('仅平台审核员');
    expect(result.composition.readEnterpriseVerificationEvidence({
      applicationId: legacy.application.id,
      evidenceReference: legacy.businessLicense.evidenceReference,
      reviewerId: 'reviewer-platform',
    }).content).toEqual(PDF_CONTENT);
    expect(() =>
      result.composition.readEnterpriseVerificationEvidence({
        applicationId: 'legacy_other',
        evidenceReference: legacy.businessLicense.evidenceReference,
        reviewerId: 'reviewer-platform',
      }),
    ).toThrow('未绑定该申请');
    expect(() =>
      result.composition.approveEnterpriseVerificationApplication({
        applicationId: legacy.application.id,
        reviewerId: 'acct-applicant',
        reviewNote: '非法批准',
      }),
    ).toThrow('仅平台审核员');
  });

  it('approves a legacy legal representative as CEO and remains idempotent', () => {
    const result = setup();
    const legacy = insertLegacyManualReview(result);
    const approved = result.composition.approveEnterpriseVerificationApplication({
      applicationId: legacy.application.id,
      reviewerId: 'reviewer-platform',
      reviewNote: '材料核验通过',
    });
    expect(approved).toMatchObject({
      status: 'approved',
      targetOrganizationId: 'org-personal',
      reviewerId: 'reviewer-platform',
      reviewNote: '材料核验通过',
    });
    expect(result.db.prepare(
      `SELECT account_type, role, position_title, is_admin
       FROM accounts WHERE id = 'acct-applicant'`,
    ).get()).toEqual({
      account_type: 'enterprise',
      role: 'CEO',
      position_title: 'CEO',
      is_admin: 1,
    });
    const replay = result.composition.approveEnterpriseVerificationApplication({
      applicationId: legacy.application.id,
      reviewerId: 'reviewer-platform',
      reviewNote: '不得覆盖首次决定',
    });
    expect(replay.reviewNote).toBe('材料核验通过');
    expect(result.db.prepare('SELECT COUNT(*) AS count FROM employees').get())
      .toEqual({ count: 1 });
  });

  it('approves a legacy authorized agent as enterprise administrator', () => {
    const result = setup();
    const legacy = insertLegacyManualReview(result, {
      applicantIdentity: 'authorized_agent',
    });
    result.composition.approveEnterpriseVerificationApplication({
      applicationId: legacy.application.id,
      reviewerId: 'reviewer-platform',
      reviewNote: '授权书有效',
    });
    expect(result.db.prepare(
      `SELECT a.role AS account_role, a.position_title AS account_position,
              e.role AS employee_role, e.position_title AS employee_position,
              a.is_admin
       FROM accounts AS a INNER JOIN employees AS e ON e.id = a.employee_id
       WHERE a.id = 'acct-applicant'`,
    ).get()).toEqual({
      account_role: '企业管理员',
      account_position: '企业管理员',
      employee_role: '企业管理员',
      employee_position: '企业管理员',
      is_admin: 1,
    });
  });

  it('rejects a legacy application idempotently and retains evidence', () => {
    const result = setup();
    const legacy = insertLegacyManualReview(result);
    const rejected = result.composition.rejectEnterpriseVerificationApplication({
      applicationId: legacy.application.id,
      reviewerId: 'reviewer-platform',
      reviewNote: '材料信息不一致',
    });
    expect(rejected.status).toBe('rejected');
    const replay = result.composition.rejectEnterpriseVerificationApplication({
      applicationId: legacy.application.id,
      reviewerId: 'reviewer-platform',
      reviewNote: '不得覆盖',
    });
    expect(replay.reviewNote).toBe('材料信息不一致');
    expect(result.db.prepare(
      'SELECT account_type, is_admin FROM accounts WHERE id = ?',
    ).get('acct-applicant')).toEqual({ account_type: 'personal', is_admin: 0 });
    expect(result.composition.readEnterpriseVerificationEvidence({
      applicationId: legacy.application.id,
      evidenceReference: legacy.businessLicense.evidenceReference,
      reviewerId: 'reviewer-platform',
    }).content).toEqual(PDF_CONTENT);
  });

  it('keeps legacy credit-code uniqueness and slug-conflict protection', () => {
    const duplicate = setup();
    seedPersonalAccount(duplicate.db, {
      organizationId: 'org-second',
      accountId: 'acct-second',
      accountName: '第二申请人',
    });
    const first = insertLegacyManualReview(duplicate);
    const second = insertLegacyManualReview(duplicate, {
      applicantAccountId: 'acct-second',
      sourceOrganizationId: 'org-second',
    });
    duplicate.composition.approveEnterpriseVerificationApplication({
      applicationId: first.application.id,
      reviewerId: 'reviewer-platform',
      reviewNote: '第一份通过',
    });
    expect(() =>
      duplicate.composition.approveEnterpriseVerificationApplication({
        applicationId: second.application.id,
        reviewerId: 'reviewer-platform',
        reviewNote: '重复代码',
      }),
    ).toThrow('已通过企业认证');

    const slugConflict = setup();
    const legacy = insertLegacyManualReview(slugConflict);
    slugConflict.db.prepare(
      `INSERT INTO organizations (id, name, slug, invite_secret, status)
       VALUES ('org-conflict', '冲突企业', ?, 'secret', 'active')`,
    ).run(expectedSlug('北京示例科技有限公司', VALID_CREDIT_CODE));
    expect(() =>
      slugConflict.composition.approveEnterpriseVerificationApplication({
        applicationId: legacy.application.id,
        reviewerId: 'reviewer-platform',
        reviewNote: '尝试批准',
      }),
    ).toThrow('企业标识已存在');
  });
});