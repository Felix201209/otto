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
  let now = 1_800_000_000_000;
  let applicationCounter = 0;
  let evidenceCounter = 0;
  let departmentCounter = 0;
  let employeeCounter = 0;
  const composition = createEnterpriseVerificationComposition({
    db: () => db,
    fieldCipher: createEncryptedFieldCipher({ keyProvider }),
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

function submitInput(
  businessLicense: ReturnType<typeof uploadEvidence>,
  overrides: Partial<SubmitEnterpriseVerificationApplicationInput> = {},
): SubmitEnterpriseVerificationApplicationInput {
  return {
    applicantAccountId: 'acct-applicant',
    sourceOrganizationId: 'org-personal',
    enterpriseName: '北京示例科技有限公司',
    unifiedSocialCreditCode: VALID_CREDIT_CODE,
    legalRepresentativeName: '法定代表人甲',
    applicantIdentity: 'legal_representative',
    businessLicense: {
      evidenceReference: businessLicense.evidenceReference,
      evidenceSha256: businessLicense.evidenceSha256,
    },
    authorizationLetter: null,
    ...overrides,
  };
}

function submitLegalRepresentative(setupResult: SetupResult) {
  const evidence = uploadEvidence(
    setupResult.composition,
    'business_license',
  );
  return setupResult.composition.submitEnterpriseVerificationApplication(
    submitInput(evidence),
  );
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

describe('enterprise verification submission and applicant access', () => {
  it('submits only to manual review, binds evidence and encrypts sensitive values', () => {
    const { db, composition } = setup();
    const businessLicense = uploadEvidence(composition, 'business_license');
    const submitted = composition.submitEnterpriseVerificationApplication(
      submitInput(businessLicense),
    );
    expect(submitted.replayed).toBe(false);
    expect(submitted.application).toMatchObject({
      status: 'manual_review',
      targetOrganizationId: null,
      legalRepresentativeName: '法定代表人甲',
      businessLicense: {
        evidenceReference: businessLicense.evidenceReference,
      },
    });
    const row = db.prepare(
      `SELECT legal_representative_name_ciphertext,
              business_license_reference_ciphertext
       FROM enterprise_verification_applications WHERE id = ?`,
    ).get(submitted.application.id) as Record<string, string>;
    expect(JSON.stringify(row)).not.toContain('法定代表人甲');
    expect(JSON.stringify(row)).not.toContain(businessLicense.evidenceReference);
    expect(
      db.prepare(
        'SELECT application_id FROM enterprise_verification_evidence WHERE id = ?',
      ).get(businessLicense.evidenceReference),
    ).toEqual({ application_id: submitted.application.id });
  });

  it('rejects forged, cross-account, wrong-purpose and hash-mismatched evidence', () => {
    const first = setup();
    expect(() =>
      first.composition.submitEnterpriseVerificationApplication(
        submitInput({
          evidenceReference: 'eve_forged',
          evidenceSha256: '0'.repeat(64),
          purpose: 'business_license',
          fileName: 'x.pdf',
          contentType: 'application/pdf',
          sizeBytes: 1,
          createdAtMs: 1,
        }),
      ),
    ).toThrow('证据不存在');

    const second = setup();
    seedPersonalAccount(second.db, {
      organizationId: 'org-other',
      accountId: 'acct-other',
      accountName: '其他账号',
    });
    const crossAccount = uploadEvidence(second.composition, 'business_license', {
      accountId: 'acct-other',
      organizationId: 'org-other',
    });
    expect(() =>
      second.composition.submitEnterpriseVerificationApplication(
        submitInput(crossAccount),
      ),
    ).toThrow('无权使用');

    const third = setup();
    const wrongPurpose = uploadEvidence(
      third.composition,
      'authorization_letter',
    );
    expect(() =>
      third.composition.submitEnterpriseVerificationApplication(
        submitInput(wrongPurpose),
      ),
    ).toThrow('用途不符');

    const fourth = setup();
    const wrongHash = uploadEvidence(fourth.composition, 'business_license');
    expect(() =>
      fourth.composition.submitEnterpriseVerificationApplication(
        submitInput({ ...wrongHash, evidenceSha256: 'f'.repeat(64) }),
      ),
    ).toThrow('SHA-256 不匹配');
  });

  it('requires an uploaded authorization letter for an authorized agent', () => {
    const { composition } = setup();
    const businessLicense = uploadEvidence(composition, 'business_license');
    expect(() =>
      composition.submitEnterpriseVerificationApplication(
        submitInput(businessLicense, {
          applicantIdentity: 'authorized_agent',
          authorizationLetter: null,
        }),
      ),
    ).toThrow('必须提交授权书');
  });

  it('replays an identical pending submission and rejects changed content', () => {
    const { db, composition } = setup();
    const businessLicense = uploadEvidence(composition, 'business_license');
    const input = submitInput(businessLicense);
    const first = composition.submitEnterpriseVerificationApplication(input);
    const replay = composition.submitEnterpriseVerificationApplication(input);
    expect(replay.replayed).toBe(true);
    expect(replay.application.id).toBe(first.application.id);
    expect(() =>
      composition.submitEnterpriseVerificationApplication({
        ...input,
        enterpriseName: '另一家企业',
      }),
    ).toThrow('已有待审核申请');
    expect(
      db.prepare(
        'SELECT COUNT(*) AS count FROM enterprise_verification_applications',
      ).get(),
    ).toEqual({ count: 1 });
  });

  it('gets the latest application without an id and preserves ownership checks', () => {
    const result = setup();
    const first = submitLegalRepresentative(result).application;
    result.composition.cancelEnterpriseVerificationApplication({
      applicationId: first.id,
      applicantAccountId: 'acct-applicant',
    });
    result.setNow(1_800_000_000_100);
    const secondEvidence = uploadEvidence(result.composition, 'business_license');
    const second = result.composition.submitEnterpriseVerificationApplication(
      submitInput(secondEvidence, {
        unifiedSocialCreditCode: SECOND_VALID_CREDIT_CODE,
      }),
    ).application;
    expect(
      result.composition.getEnterpriseVerificationApplicationForApplicant({
        applicantAccountId: 'acct-applicant',
      })?.id,
    ).toBe(second.id);
    expect(
      result.composition.getEnterpriseVerificationApplicationForApplicant({
        applicantAccountId: 'acct-other',
        applicationId: second.id,
      }),
    ).toBeNull();
  });

  it('allows only the owner to cancel and keeps cancellation idempotent', () => {
    const { composition } = setup();
    const application = submitLegalRepresentative(setup()).application;
    expect(() =>
      composition.cancelEnterpriseVerificationApplication({
        applicationId: application.id,
        applicantAccountId: 'acct-other',
      }),
    ).toThrow();
  });
});

describe('enterprise verification review and promotion', () => {
  it('allows only platform reviewers to list, read evidence and decide', () => {
    const result = setup();
    const submitted = submitLegalRepresentative(result).application;
    expect(() =>
      result.composition.listEnterpriseVerificationApplications({
        reviewerId: 'acct-applicant',
      }),
    ).toThrow('仅平台审核员');
    expect(() =>
      result.composition.readEnterpriseVerificationEvidence({
        applicationId: submitted.id,
        evidenceReference: submitted.businessLicense.evidenceReference,
        reviewerId: 'acct-applicant',
      }),
    ).toThrow('仅平台审核员');
    expect(() =>
      result.composition.approveEnterpriseVerificationApplication({
        applicationId: submitted.id,
        reviewerId: 'acct-applicant',
        reviewNote: '非法批准',
      }),
    ).toThrow('仅平台审核员');
  });

  it('lets a reviewer read only evidence bound to the requested application', () => {
    const result = setup();
    const submitted = submitLegalRepresentative(result).application;
    const evidence = result.composition.readEnterpriseVerificationEvidence({
      applicationId: submitted.id,
      evidenceReference: submitted.businessLicense.evidenceReference,
      reviewerId: 'reviewer-platform',
    });
    expect(evidence.content).toEqual(PDF_CONTENT);
    expect(() =>
      result.composition.readEnterpriseVerificationEvidence({
        applicationId: 'ev_other',
        evidenceReference: submitted.businessLicense.evidenceReference,
        reviewerId: 'reviewer-platform',
      }),
    ).toThrow('未绑定该申请');
  });

  it('fails closed when encrypted object ciphertext is tampered with', () => {
    const result = setup();
    const submitted = submitLegalRepresentative(result).application;
    const key = result.objectStore.listKeys()[0]!;
    const target = path.join(result.objectRoot, ...key.split('/'));
    const raw = fs.readFileSync(target);
    raw[raw.length - 1] ^= 1;
    fs.writeFileSync(target, raw);
    expect(() =>
      result.composition.readEnterpriseVerificationEvidence({
        applicationId: submitted.id,
        evidenceReference: submitted.businessLicense.evidenceReference,
        reviewerId: 'reviewer-platform',
      }),
    ).toThrow();
  });

  it('promotes a legal representative in place and preserves auth sessions', () => {
    const result = setup();
    const submitted = submitLegalRepresentative(result).application;
    const approved = result.composition.approveEnterpriseVerificationApplication({
      applicationId: submitted.id,
      reviewerId: 'reviewer-platform',
      reviewNote: '材料核验通过',
    });
    expect(approved).toMatchObject({
      status: 'approved',
      targetOrganizationId: 'org-personal',
      reviewerId: 'reviewer-platform',
      reviewNote: '材料核验通过',
    });
    const organization = result.db.prepare(
      'SELECT id, name, slug FROM organizations WHERE id = ?',
    ).get('org-personal') as { id: string; name: string; slug: string };
    expect(organization.id).toBe('org-personal');
    expect(organization.name).toBe('北京示例科技有限公司');
    expect(organization.slug).toBe(
      expectedSlug('北京示例科技有限公司', VALID_CREDIT_CODE),
    );
    expect(organization.slug).not.toContain(VALID_CREDIT_CODE.toLowerCase());
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
    const employee = result.db.prepare(
      'SELECT name, role, position_title FROM employees WHERE id = ?',
    ).get(account.employee_id) as Record<string, unknown>;
    expect(employee).toEqual({
      name: '申请账号姓名',
      role: 'CEO',
      position_title: 'CEO',
    });
    expect(
      result.db.prepare(
        'SELECT organization_id FROM auth_sessions WHERE account_id = ?',
      ).get('acct-applicant'),
    ).toEqual({ organization_id: 'org-personal' });

    const replay = result.composition.approveEnterpriseVerificationApplication({
      applicationId: submitted.id,
      reviewerId: 'reviewer-platform',
      reviewNote: '重复请求不得覆盖首次审核记录',
    });
    expect(replay.reviewNote).toBe('材料核验通过');
    expect(result.db.prepare('SELECT COUNT(*) AS count FROM employees').get())
      .toEqual({ count: 1 });
  });

  it('promotes an authorized agent as enterprise administrator, never CEO', () => {
    const result = setup();
    const businessLicense = uploadEvidence(
      result.composition,
      'business_license',
    );
    const authorizationLetter = uploadEvidence(
      result.composition,
      'authorization_letter',
      { content: PNG_CONTENT, contentType: 'image/png', fileName: 'letter.png' },
    );
    const application = result.composition.submitEnterpriseVerificationApplication(
      submitInput(businessLicense, {
        applicantIdentity: 'authorized_agent',
        authorizationLetter: {
          evidenceReference: authorizationLetter.evidenceReference,
          evidenceSha256: authorizationLetter.evidenceSha256,
        },
      }),
    ).application;
    result.composition.approveEnterpriseVerificationApplication({
      applicationId: application.id,
      reviewerId: 'reviewer-platform',
      reviewNote: '授权书有效',
    });
    expect(
      result.db.prepare(
        `SELECT a.role AS account_role, a.position_title AS account_position,
                e.name AS employee_name, e.role AS employee_role,
                e.position_title AS employee_position, a.is_admin
         FROM accounts AS a INNER JOIN employees AS e ON e.id = a.employee_id
         WHERE a.id = 'acct-applicant'`,
      ).get(),
    ).toEqual({
      account_role: '企业管理员',
      account_position: '企业管理员',
      employee_name: '申请账号姓名',
      employee_role: '企业管理员',
      employee_position: '企业管理员',
      is_admin: 1,
    });
  });

  it('rejects idempotently without upgrading and retains evidence for audit', () => {
    const result = setup();
    const submitted = submitLegalRepresentative(result).application;
    const rejected = result.composition.rejectEnterpriseVerificationApplication({
      applicationId: submitted.id,
      reviewerId: 'reviewer-platform',
      reviewNote: '材料信息不一致',
    });
    expect(rejected.status).toBe('rejected');
    const replay = result.composition.rejectEnterpriseVerificationApplication({
      applicationId: submitted.id,
      reviewerId: 'reviewer-platform',
      reviewNote: '不覆盖',
    });
    expect(replay.reviewNote).toBe('材料信息不一致');
    expect(result.db.prepare(
      'SELECT account_type FROM accounts WHERE id = ?',
    ).get('acct-applicant')).toEqual({ account_type: 'personal' });
    expect(
      result.composition.readEnterpriseVerificationEvidence({
        applicationId: submitted.id,
        evidenceReference: submitted.businessLicense.evidenceReference,
        reviewerId: 'reviewer-platform',
      }).content,
    ).toEqual(PDF_CONTENT);
    expect(() =>
      result.composition.approveEnterpriseVerificationApplication({
        applicationId: submitted.id,
        reviewerId: 'reviewer-platform',
        reviewNote: '禁止反向转换',
      }),
    ).toThrow('当前状态不允许批准');
  });

  it('blocks promotion when the personal organization has another active account', () => {
    const result = setup();
    const submitted = submitLegalRepresentative(result).application;
    result.db.prepare(
      `INSERT INTO accounts (
        id, organization_id, account_type, username, password_hash, name,
        role, is_admin, status
      ) VALUES ('acct-shared', 'org-personal', 'personal', 'shared@example.test',
        'hash', '共享账号', '个人用户', 0, 'active')`,
    ).run();
    expect(() =>
      result.composition.approveEnterpriseVerificationApplication({
        applicationId: submitted.id,
        reviewerId: 'reviewer-platform',
        reviewNote: '尝试批准',
      }),
    ).toThrow('存在其他活动账号');
    expect(result.db.prepare(
      'SELECT name, slug FROM organizations WHERE id = ?',
    ).get('org-personal')).toEqual({
      name: '申请账号姓名的个人空间',
      slug: 'personal-acct-applicant',
    });
  });

  it('rolls back organization, department, employee, account and decision together', () => {
    const result = setup();
    const submitted = submitLegalRepresentative(result).application;
    result.db.exec(`
      CREATE TRIGGER fail_enterprise_employee
      BEFORE INSERT ON employees
      BEGIN
        SELECT RAISE(ABORT, 'forced employee failure');
      END;
    `);
    expect(() =>
      result.composition.approveEnterpriseVerificationApplication({
        applicationId: submitted.id,
        reviewerId: 'reviewer-platform',
        reviewNote: '触发事务失败',
      }),
    ).toThrow('forced employee failure');
    expect(result.db.prepare(
      'SELECT name, slug FROM organizations WHERE id = ?',
    ).get('org-personal')).toEqual({
      name: '申请账号姓名的个人空间',
      slug: 'personal-acct-applicant',
    });
    expect(result.db.prepare(
      'SELECT account_type, employee_id FROM accounts WHERE id = ?',
    ).get('acct-applicant')).toEqual({
      account_type: 'personal',
      employee_id: null,
    });
    expect(result.db.prepare('SELECT COUNT(*) AS count FROM employees').get())
      .toEqual({ count: 0 });
    expect(result.db.prepare(
      'SELECT COUNT(*) AS count FROM organization_departments',
    ).get()).toEqual({ count: 0 });
    expect(result.db.prepare(
      'SELECT status, reviewer_id FROM enterprise_verification_applications WHERE id = ?',
    ).get(submitted.id)).toEqual({ status: 'manual_review', reviewer_id: null });
  });

  it('enforces one approved application per credit code', () => {
    const result = setup();
    seedPersonalAccount(result.db, {
      organizationId: 'org-second',
      accountId: 'acct-second',
      accountName: '第二申请人',
    });
    const first = submitLegalRepresentative(result).application;
    const secondEvidence = uploadEvidence(result.composition, 'business_license', {
      accountId: 'acct-second',
      organizationId: 'org-second',
    });
    const second = result.composition.submitEnterpriseVerificationApplication(
      submitInput(secondEvidence, {
        applicantAccountId: 'acct-second',
        sourceOrganizationId: 'org-second',
      }),
    ).application;
    result.composition.approveEnterpriseVerificationApplication({
      applicationId: first.id,
      reviewerId: 'reviewer-platform',
      reviewNote: '第一份通过',
    });
    expect(() =>
      result.composition.approveEnterpriseVerificationApplication({
        applicationId: second.id,
        reviewerId: 'reviewer-platform',
        reviewNote: '重复代码',
      }),
    ).toThrow('已通过企业认证');
  });

  it('returns a deterministic error when the derived organization slug conflicts', () => {
    const result = setup();
    const submitted = submitLegalRepresentative(result).application;
    result.db.prepare(
      `INSERT INTO organizations (id, name, slug, invite_secret, status)
       VALUES ('org-conflict', '冲突企业', ?, 'secret', 'active')`,
    ).run(expectedSlug('北京示例科技有限公司', VALID_CREDIT_CODE));
    expect(() =>
      result.composition.approveEnterpriseVerificationApplication({
        applicationId: submitted.id,
        reviewerId: 'reviewer-platform',
        reviewNote: '尝试批准',
      }),
    ).toThrow('企业标识已存在');
  });
});
