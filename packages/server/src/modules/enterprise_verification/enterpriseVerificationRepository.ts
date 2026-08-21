/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';

import type {
  Database,
  EncryptedFieldCipher,
  EncryptedFieldValue,
  EncryptedObjectStore,
} from '../data_platform/index.js';
import {
  EnterpriseVerificationError,
  type ApproveEnterpriseVerificationApplicationInput,
  type CancelEnterpriseVerificationApplicationInput,
  type EnterpriseVerificationApplicantIdentity,
  type EnterpriseVerificationApplicationView,
  type EnterpriseVerificationEvidenceInput,
  type EnterpriseVerificationEvidencePurpose,
  type EnterpriseVerificationErrorCode,
  type EnterpriseVerificationStatus,
  type GetEnterpriseVerificationApplicationForApplicantInput,
  type ListEnterpriseVerificationApplicationsInput,
  type ListEnterpriseVerificationApplicationsResult,
  type ReadEnterpriseVerificationEvidenceInput,
  type ReadEnterpriseVerificationEvidenceResult,
  type RejectEnterpriseVerificationApplicationInput,
  type SubmitEnterpriseVerificationApplicationInput,
  type SubmitEnterpriseVerificationApplicationResult,
  type UploadEnterpriseVerificationEvidenceInput,
  type UploadEnterpriseVerificationEvidenceResult,
} from './enterpriseVerificationTypes.js';

const CREDIT_CODE_CHARSET = '0123456789ABCDEFGHJKLMNPQRTUWXY';
const CREDIT_CODE_WEIGHTS = [
  1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28,
] as const;
const SHA256_PATTERN = /^[a-f0-9]{64}$/iu;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;
const EVIDENCE_CONTENT_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
]);
const VERIFICATION_STATUSES = new Set<EnterpriseVerificationStatus>([
  'manual_review',
  'approved',
  'rejected',
  'cancelled',
]);

interface EnterpriseVerificationRow {
  id: string;
  applicant_account_id: string;
  source_organization_id: string;
  enterprise_name: string;
  unified_social_credit_code: string;
  applicant_identity: EnterpriseVerificationApplicantIdentity;
  legal_representative_name_ciphertext: string;
  legal_representative_name_iv: string;
  legal_representative_name_auth_tag: string;
  legal_representative_name_key_version: number;
  business_license_reference_ciphertext: string;
  business_license_reference_iv: string;
  business_license_reference_auth_tag: string;
  business_license_reference_key_version: number;
  business_license_sha256: string;
  authorization_letter_reference_ciphertext: string | null;
  authorization_letter_reference_iv: string | null;
  authorization_letter_reference_auth_tag: string | null;
  authorization_letter_reference_key_version: number | null;
  authorization_letter_sha256: string | null;
  status: EnterpriseVerificationStatus;
  submitted_at_ms: number;
  updated_at_ms: number;
  cancelled_at_ms: number | null;
  reviewer_id: string | null;
  review_note: string | null;
  decided_at_ms: number | null;
}

interface EnterpriseVerificationEvidenceRow {
  id: string;
  applicant_account_id: string;
  source_organization_id: string;
  purpose: EnterpriseVerificationEvidencePurpose;
  storage_key_ciphertext: string;
  storage_key_iv: string;
  storage_key_auth_tag: string;
  storage_key_key_version: number;
  file_name: string;
  content_type: string;
  sha256: string;
  size_bytes: number;
  application_id: string | null;
  created_at_ms: number;
  deleted_at_ms: number | null;
}

export interface EnterpriseVerificationRepositoryStore {
  db(): Database;
  fieldCipher: EncryptedFieldCipher;
  objectStore: EncryptedObjectStore;
  now(): number;
  createApplicationId(): string;
  createDepartmentId(): string;
  createEmployeeId(): string;
  createEvidenceId(): string;
  isPlatformReviewer(reviewerId: string): boolean;
}

interface NormalizedSubmission {
  applicantAccountId: string;
  sourceOrganizationId: string;
  enterpriseName: string;
  unifiedSocialCreditCode: string;
  legalRepresentativeName: string;
  applicantIdentity: EnterpriseVerificationApplicantIdentity;
  businessLicense: EnterpriseVerificationEvidenceInput;
  authorizationLetter: EnterpriseVerificationEvidenceInput | null;
}

function verificationError(
  code: EnterpriseVerificationErrorCode,
  message: string,
): EnterpriseVerificationError {
  return new EnterpriseVerificationError(code, message);
}

function normalizeRequiredText(
  value: string,
  label: string,
  maxLength: number,
): string {
  const normalized = value.trim();
  if (!normalized) {
    throw verificationError('invalid_input', `${label}不能为空`);
  }
  if (normalized.length > maxLength) {
    throw verificationError(
      'invalid_input',
      `${label}不能超过 ${maxLength} 个字符`,
    );
  }
  return normalized;
}

function normalizeId(value: string, label: string): string {
  const normalized = value.trim();
  if (!SAFE_ID_PATTERN.test(normalized)) {
    throw verificationError('invalid_input', `${label}格式不正确`);
  }
  return normalized;
}

function normalizeEvidence(
  evidence: EnterpriseVerificationEvidenceInput,
  label: string,
): EnterpriseVerificationEvidenceInput {
  if (!evidence || typeof evidence !== 'object') {
    throw verificationError('invalid_input', `${label}不能为空`);
  }
  const evidenceReference = normalizeRequiredText(
    evidence.evidenceReference,
    `${label}引用`,
    160,
  );
  const evidenceSha256 = evidence.evidenceSha256
    .trim()
    .toLocaleLowerCase('en-US');
  if (!SHA256_PATTERN.test(evidenceSha256)) {
    throw verificationError('invalid_input', `${label} SHA-256 格式不正确`);
  }
  return { evidenceReference, evidenceSha256 };
}

/** Uses the official 31-character set and 17-position weighting algorithm. */
export function normalizeAndValidateUnifiedSocialCreditCode(value: string): string {
  const normalized = value.trim().toLocaleUpperCase('en-US');
  if (normalized.length !== 18) {
    throw verificationError('invalid_credit_code', '统一社会信用代码必须为 18 位');
  }
  let weightedSum = 0;
  for (let index = 0; index < 17; index += 1) {
    const characterValue = CREDIT_CODE_CHARSET.indexOf(normalized[index]!);
    if (characterValue < 0) {
      throw verificationError(
        'invalid_credit_code',
        '统一社会信用代码包含无效字符',
      );
    }
    weightedSum += characterValue * CREDIT_CODE_WEIGHTS[index]!;
  }
  const expected = CREDIT_CODE_CHARSET[(31 - (weightedSum % 31)) % 31]!;
  if (normalized[17] !== expected) {
    throw verificationError('invalid_credit_code', '统一社会信用代码校验位错误');
  }
  return normalized;
}

function normalizeSubmission(
  input: SubmitEnterpriseVerificationApplicationInput,
): NormalizedSubmission {
  if (
    input.applicantIdentity !== 'legal_representative' &&
    input.applicantIdentity !== 'authorized_agent'
  ) {
    throw verificationError('invalid_input', '申请人身份不正确');
  }
  const authorizationLetter = input.authorizationLetter
    ? normalizeEvidence(input.authorizationLetter, '授权书')
    : null;
  if (input.applicantIdentity === 'authorized_agent' && !authorizationLetter) {
    throw verificationError('invalid_input', '受托申请人必须提交授权书');
  }
  return {
    applicantAccountId: normalizeId(input.applicantAccountId, '申请账号 ID'),
    sourceOrganizationId: normalizeId(input.sourceOrganizationId, '来源组织 ID'),
    enterpriseName: normalizeRequiredText(input.enterpriseName, '企业名称', 80),
    unifiedSocialCreditCode: normalizeAndValidateUnifiedSocialCreditCode(
      input.unifiedSocialCreditCode,
    ),
    legalRepresentativeName: normalizeRequiredText(
      input.legalRepresentativeName,
      '法定代表人姓名',
      80,
    ),
    applicantIdentity: input.applicantIdentity,
    businessLicense: normalizeEvidence(input.businessLicense, '营业执照'),
    authorizationLetter,
  };
}

function encryptionContext(applicationId: string, field: string): string {
  return `enterprise_verification:${applicationId}:${field}`;
}

function encryptedValueFromRow(
  row: EnterpriseVerificationRow,
  prefix:
    | 'legal_representative_name'
    | 'business_license_reference'
    | 'authorization_letter_reference',
): EncryptedFieldValue | null {
  const ciphertext = row[`${prefix}_ciphertext`];
  const iv = row[`${prefix}_iv`];
  const authTag = row[`${prefix}_auth_tag`];
  const keyVersion = row[`${prefix}_key_version`];
  if (
    ciphertext === null ||
    iv === null ||
    authTag === null ||
    keyVersion === null
  ) {
    return null;
  }
  return { ciphertext, iv, authTag, keyVersion };
}

function decryptRequiredField(
  store: EnterpriseVerificationRepositoryStore,
  row: EnterpriseVerificationRow,
  prefix: 'legal_representative_name' | 'business_license_reference',
): string {
  const encrypted = encryptedValueFromRow(row, prefix);
  if (!encrypted) throw new Error(`企业认证敏感字段 ${prefix} 缺失`);
  return store.fieldCipher.decryptText(
    encrypted,
    encryptionContext(row.id, prefix),
  );
}

function rowToView(
  store: EnterpriseVerificationRepositoryStore,
  row: EnterpriseVerificationRow,
): EnterpriseVerificationApplicationView {
  const authorizationLetter = encryptedValueFromRow(
    row,
    'authorization_letter_reference',
  );
  return {
    id: row.id,
    applicantAccountId: row.applicant_account_id,
    sourceOrganizationId: row.source_organization_id,
    targetOrganizationId:
      row.status === 'approved' ? row.source_organization_id : null,
    enterpriseName: row.enterprise_name,
    unifiedSocialCreditCode: row.unified_social_credit_code,
    legalRepresentativeName: decryptRequiredField(
      store,
      row,
      'legal_representative_name',
    ),
    applicantIdentity: row.applicant_identity,
    businessLicense: {
      evidenceReference: decryptRequiredField(
        store,
        row,
        'business_license_reference',
      ),
      evidenceSha256: row.business_license_sha256,
    },
    authorizationLetter: authorizationLetter
      ? {
          evidenceReference: store.fieldCipher.decryptText(
            authorizationLetter,
            encryptionContext(row.id, 'authorization_letter_reference'),
          ),
          evidenceSha256: row.authorization_letter_sha256!,
        }
      : null,
    status: row.status,
    submittedAtMs: Number(row.submitted_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
    cancelledAtMs:
      row.cancelled_at_ms === null ? null : Number(row.cancelled_at_ms),
    reviewerId: row.reviewer_id,
    reviewNote: row.review_note,
    decidedAtMs: row.decided_at_ms === null ? null : Number(row.decided_at_ms),
  };
}

function getRowById(
  database: Database,
  applicationId: string,
): EnterpriseVerificationRow | null {
  return (
    (database
      .prepare('SELECT * FROM enterprise_verification_applications WHERE id = ?')
      .get(applicationId) as EnterpriseVerificationRow | undefined) ?? null
  );
}

function assertPlatformReviewer(
  store: EnterpriseVerificationRepositoryStore,
  reviewerId: string,
): string {
  const normalized = normalizeId(reviewerId, '审核人 ID');
  if (!store.isPlatformReviewer(normalized)) {
    throw verificationError('forbidden', '仅平台审核员可以执行此操作');
  }
  return normalized;
}

function assertApplicantEligible(
  database: Database,
  applicantAccountId: string,
  sourceOrganizationId: string,
): void {
  const account = database
    .prepare(
      `SELECT a.id
       FROM accounts AS a
       INNER JOIN organizations AS o ON o.id = a.organization_id
       WHERE a.id = ? AND a.organization_id = ?
         AND a.account_type = 'personal'
         AND a.status = 'active' AND a.deleted_at IS NULL
         AND o.status = 'active'`,
    )
    .get(applicantAccountId, sourceOrganizationId);
  if (!account) {
    throw verificationError(
      'applicant_not_eligible',
      '申请账号不是该个人组织中的有效 personal account',
    );
  }
}

function sameSubmission(
  view: EnterpriseVerificationApplicationView,
  input: NormalizedSubmission,
): boolean {
  return (
    view.sourceOrganizationId === input.sourceOrganizationId &&
    view.enterpriseName === input.enterpriseName &&
    view.unifiedSocialCreditCode === input.unifiedSocialCreditCode &&
    view.legalRepresentativeName === input.legalRepresentativeName &&
    view.applicantIdentity === input.applicantIdentity &&
    view.businessLicense.evidenceReference ===
      input.businessLicense.evidenceReference &&
    view.businessLicense.evidenceSha256 === input.businessLicense.evidenceSha256 &&
    view.authorizationLetter?.evidenceReference ===
      input.authorizationLetter?.evidenceReference &&
    view.authorizationLetter?.evidenceSha256 ===
      input.authorizationLetter?.evidenceSha256
  );
}

function rollbackIfNeeded(database: Database): void {
  if (database.inTransaction) database.exec('ROLLBACK');
}

function normalizeEvidencePurpose(
  purpose: EnterpriseVerificationEvidencePurpose,
): EnterpriseVerificationEvidencePurpose {
  if (purpose !== 'business_license' && purpose !== 'authorization_letter') {
    throw verificationError('invalid_evidence', '证据用途不正确');
  }
  return purpose;
}

function normalizeEvidenceFileName(value: string): string {
  const fileName = normalizeRequiredText(value, '证据文件名', 255);
  const hasUnsafeCharacter = [...fileName].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      character === '/' ||
      character === '\\' ||
      codePoint <= 0x1f ||
      codePoint === 0x7f
    );
  });
  if (hasUnsafeCharacter) {
    throw verificationError('invalid_evidence', '证据文件名包含非法字符');
  }
  return fileName;
}

function assertEvidenceContentMatchesType(
  contentType: string,
  content: Buffer,
): void {
  const isPdf =
    content.length >= 5 && content.subarray(0, 5).equals(Buffer.from('%PDF-'));
  const isPng =
    content.length >= 8 &&
    content.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  const isJpeg =
    content.length >= 3 &&
    content[0] === 0xff &&
    content[1] === 0xd8 &&
    content[2] === 0xff;
  const valid =
    (contentType === 'application/pdf' && isPdf) ||
    (contentType === 'image/png' && isPng) ||
    (contentType === 'image/jpeg' && isJpeg);
  if (!valid) {
    throw verificationError('invalid_evidence', '证据文件内容与类型不匹配');
  }
}

function evidenceStorageContext(evidenceId: string): string {
  return `enterprise_verification_evidence:${evidenceId}:storage_key`;
}

function evidenceNamespace(
  organizationId: string,
  accountId: string,
): string {
  return `enterprise-verification:${organizationId}:${accountId}`;
}

function evidenceStorageKeyFromRow(
  row: EnterpriseVerificationEvidenceRow,
): EncryptedFieldValue {
  return {
    ciphertext: row.storage_key_ciphertext,
    iv: row.storage_key_iv,
    authTag: row.storage_key_auth_tag,
    keyVersion: row.storage_key_key_version,
  };
}

function findEvidenceForSubmission(
  database: Database,
  input: {
    evidenceReference: string;
    evidenceSha256: string;
    applicantAccountId: string;
    sourceOrganizationId: string;
    purpose: EnterpriseVerificationEvidencePurpose;
  },
): EnterpriseVerificationEvidenceRow {
  const evidenceReference = normalizeId(input.evidenceReference, '证据引用');
  const row = database
    .prepare(
      `SELECT * FROM enterprise_verification_evidence
       WHERE id = ? AND applicant_account_id = ? AND source_organization_id = ?
         AND purpose = ? AND application_id IS NULL AND deleted_at_ms IS NULL`,
    )
    .get(
      evidenceReference,
      input.applicantAccountId,
      input.sourceOrganizationId,
      input.purpose,
    ) as EnterpriseVerificationEvidenceRow | undefined;
  if (!row) {
    throw verificationError(
      'invalid_evidence',
      '证据不存在、无权使用、用途不符或已绑定其他申请',
    );
  }
  if (row.sha256 !== input.evidenceSha256) {
    throw verificationError('invalid_evidence', '证据 SHA-256 不匹配');
  }
  return row;
}

function bindEvidenceToApplication(
  database: Database,
  evidenceId: string,
  applicationId: string,
): void {
  const bound = database
    .prepare(
      `UPDATE enterprise_verification_evidence
       SET application_id = ?
       WHERE id = ? AND application_id IS NULL AND deleted_at_ms IS NULL`,
    )
    .run(applicationId, evidenceId);
  if (Number(bound.changes) !== 1) {
    throw verificationError('invalid_evidence', '证据已被其他申请占用');
  }
}

export function uploadEnterpriseVerificationEvidence(
  store: EnterpriseVerificationRepositoryStore,
  input: UploadEnterpriseVerificationEvidenceInput,
): UploadEnterpriseVerificationEvidenceResult {
  const applicantAccountId = normalizeId(input.applicantAccountId, '申请账号 ID');
  const sourceOrganizationId = normalizeId(
    input.sourceOrganizationId,
    '来源组织 ID',
  );
  const purpose = normalizeEvidencePurpose(input.purpose);
  const fileName = normalizeEvidenceFileName(input.fileName);
  const contentType = input.contentType.trim().toLocaleLowerCase('en-US');
  if (!EVIDENCE_CONTENT_TYPES.has(contentType)) {
    throw verificationError(
      'invalid_evidence',
      '证据文件仅支持 PDF、PNG 或 JPEG',
    );
  }
  if (!Buffer.isBuffer(input.content) || input.content.length === 0) {
    throw verificationError('invalid_evidence', '证据文件不能为空');
  }
  if (input.content.length > MAX_EVIDENCE_BYTES) {
    throw verificationError('invalid_evidence', '证据文件不能超过 8MB');
  }
  assertEvidenceContentMatchesType(contentType, input.content);

  const evidenceId = store.createEvidenceId();
  const sha256 = createHash('sha256').update(input.content).digest('hex');
  const now = store.now();
  const database = store.db();
  let storageKey: string | null = null;
  database.exec('BEGIN IMMEDIATE');
  try {
    assertApplicantEligible(database, applicantAccountId, sourceOrganizationId);
    const stored = store.objectStore.put({
      namespace: evidenceNamespace(sourceOrganizationId, applicantAccountId),
      objectId: evidenceId,
      content: input.content,
    });
    storageKey = stored.key;
    const encryptedStorageKey = store.fieldCipher.encryptText(
      stored.key,
      evidenceStorageContext(evidenceId),
    );
    database
      .prepare(
        `INSERT INTO enterprise_verification_evidence (
          id, applicant_account_id, source_organization_id, purpose,
          storage_key_ciphertext, storage_key_iv, storage_key_auth_tag,
          storage_key_key_version, file_name, content_type, sha256, size_bytes,
          application_id, created_at_ms, deleted_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
      )
      .run(
        evidenceId,
        applicantAccountId,
        sourceOrganizationId,
        purpose,
        encryptedStorageKey.ciphertext,
        encryptedStorageKey.iv,
        encryptedStorageKey.authTag,
        encryptedStorageKey.keyVersion,
        fileName,
        contentType,
        sha256,
        input.content.length,
        now,
      );
    database.exec('COMMIT');
    return {
      evidenceReference: evidenceId,
      evidenceSha256: sha256,
      purpose,
      fileName,
      contentType,
      sizeBytes: input.content.length,
      createdAtMs: now,
    };
  } catch (error) {
    rollbackIfNeeded(database);
    if (storageKey) {
      try {
        store.objectStore.delete(storageKey);
      } catch {
        // Preserve the original error; maintenance can retry orphan cleanup.
      }
    }
    throw error;
  }
}

export function readEnterpriseVerificationEvidence(
  store: EnterpriseVerificationRepositoryStore,
  input: ReadEnterpriseVerificationEvidenceInput,
): ReadEnterpriseVerificationEvidenceResult {
  assertPlatformReviewer(store, input.reviewerId);
  const applicationId = normalizeId(input.applicationId, '申请 ID');
  const evidenceReference = normalizeId(input.evidenceReference, '证据引用');
  const row = store
    .db()
    .prepare(
      `SELECT * FROM enterprise_verification_evidence
       WHERE id = ? AND application_id = ? AND deleted_at_ms IS NULL`,
    )
    .get(evidenceReference, applicationId) as
    | EnterpriseVerificationEvidenceRow
    | undefined;
  if (!row) {
    throw verificationError(
      'evidence_not_found',
      '证据不存在、未绑定该申请或无权访问',
    );
  }
  const storageKey = store.fieldCipher.decryptText(
    evidenceStorageKeyFromRow(row),
    evidenceStorageContext(row.id),
  );
  const content = store.objectStore.read(storageKey);
  const sha256 = createHash('sha256').update(content).digest('hex');
  if (sha256 !== row.sha256 || content.length !== Number(row.size_bytes)) {
    throw verificationError('invalid_evidence', '证据对象完整性校验失败');
  }
  return {
    content,
    evidenceReference: row.id,
    evidenceSha256: row.sha256,
    purpose: row.purpose,
    fileName: row.file_name,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes),
    createdAtMs: Number(row.created_at_ms),
  };
}

export function submitEnterpriseVerificationApplication(
  store: EnterpriseVerificationRepositoryStore,
  input: SubmitEnterpriseVerificationApplicationInput,
): SubmitEnterpriseVerificationApplicationResult {
  const normalized = normalizeSubmission(input);
  const database = store.db();
  const applicationId = store.createApplicationId();
  const now = store.now();
  database.exec('BEGIN IMMEDIATE');
  try {
    assertApplicantEligible(
      database,
      normalized.applicantAccountId,
      normalized.sourceOrganizationId,
    );
    const existingRow = database
      .prepare(
        `SELECT * FROM enterprise_verification_applications
         WHERE applicant_account_id = ? AND status = 'manual_review'`,
      )
      .get(normalized.applicantAccountId) as
      | EnterpriseVerificationRow
      | undefined;
    if (existingRow) {
      const existing = rowToView(store, existingRow);
      if (!sameSubmission(existing, normalized)) {
        throw verificationError(
          'application_conflict',
          '该账号已有待审核申请，请先取消原申请',
        );
      }
      database.exec('COMMIT');
      return { application: existing, replayed: true };
    }

    const businessLicenseEvidence = findEvidenceForSubmission(database, {
      evidenceReference: normalized.businessLicense.evidenceReference,
      evidenceSha256: normalized.businessLicense.evidenceSha256,
      applicantAccountId: normalized.applicantAccountId,
      sourceOrganizationId: normalized.sourceOrganizationId,
      purpose: 'business_license',
    });
    const authorizationLetterEvidence = normalized.authorizationLetter
      ? findEvidenceForSubmission(database, {
          evidenceReference: normalized.authorizationLetter.evidenceReference,
          evidenceSha256: normalized.authorizationLetter.evidenceSha256,
          applicantAccountId: normalized.applicantAccountId,
          sourceOrganizationId: normalized.sourceOrganizationId,
          purpose: 'authorization_letter',
        })
      : null;

    const legalRepresentative = store.fieldCipher.encryptText(
      normalized.legalRepresentativeName,
      encryptionContext(applicationId, 'legal_representative_name'),
    );
    const businessLicenseReference = store.fieldCipher.encryptText(
      businessLicenseEvidence.id,
      encryptionContext(applicationId, 'business_license_reference'),
    );
    const authorizationLetterReference = authorizationLetterEvidence
      ? store.fieldCipher.encryptText(
          authorizationLetterEvidence.id,
          encryptionContext(applicationId, 'authorization_letter_reference'),
        )
      : null;

    database
      .prepare(
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
      )
      .run(
        applicationId,
        normalized.applicantAccountId,
        normalized.sourceOrganizationId,
        normalized.enterpriseName,
        normalized.unifiedSocialCreditCode,
        normalized.applicantIdentity,
        legalRepresentative.ciphertext,
        legalRepresentative.iv,
        legalRepresentative.authTag,
        legalRepresentative.keyVersion,
        businessLicenseReference.ciphertext,
        businessLicenseReference.iv,
        businessLicenseReference.authTag,
        businessLicenseReference.keyVersion,
        businessLicenseEvidence.sha256,
        authorizationLetterReference?.ciphertext ?? null,
        authorizationLetterReference?.iv ?? null,
        authorizationLetterReference?.authTag ?? null,
        authorizationLetterReference?.keyVersion ?? null,
        authorizationLetterEvidence?.sha256 ?? null,
        now,
        now,
      );
    bindEvidenceToApplication(database, businessLicenseEvidence.id, applicationId);
    if (authorizationLetterEvidence) {
      bindEvidenceToApplication(
        database,
        authorizationLetterEvidence.id,
        applicationId,
      );
    }
    const application = rowToView(store, getRowById(database, applicationId)!);
    database.exec('COMMIT');
    return { application, replayed: false };
  } catch (error) {
    rollbackIfNeeded(database);
    throw error;
  }
}

export function getEnterpriseVerificationApplicationForApplicant(
  store: EnterpriseVerificationRepositoryStore,
  input: GetEnterpriseVerificationApplicationForApplicantInput,
): EnterpriseVerificationApplicationView | null {
  const applicantAccountId = normalizeId(input.applicantAccountId, '申请账号 ID');
  const database = store.db();
  const row = input.applicationId
    ? (database
        .prepare(
          `SELECT * FROM enterprise_verification_applications
           WHERE id = ? AND applicant_account_id = ?`,
        )
        .get(
          normalizeId(input.applicationId, '申请 ID'),
          applicantAccountId,
        ) as EnterpriseVerificationRow | undefined)
    : (database
        .prepare(
          `SELECT * FROM enterprise_verification_applications
           WHERE applicant_account_id = ?
           ORDER BY submitted_at_ms DESC, id DESC LIMIT 1`,
        )
        .get(applicantAccountId) as EnterpriseVerificationRow | undefined);
  return row ? rowToView(store, row) : null;
}

export function listEnterpriseVerificationApplications(
  store: EnterpriseVerificationRepositoryStore,
  input: ListEnterpriseVerificationApplicationsInput,
): ListEnterpriseVerificationApplicationsResult {
  assertPlatformReviewer(store, input.reviewerId);
  if (input.status && !VERIFICATION_STATUSES.has(input.status)) {
    throw verificationError('invalid_input', '企业认证状态不正确');
  }
  const limit = input.limit ?? 50;
  const offset = input.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw verificationError('invalid_input', '列表 limit 必须是 1 到 200 的整数');
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw verificationError('invalid_input', '列表 offset 必须是非负整数');
  }
  const database = store.db();
  const where = input.status ? 'WHERE status = ?' : '';
  const parameters = input.status ? [input.status] : [];
  const rows = database
    .prepare(
      `SELECT * FROM enterprise_verification_applications
       ${where}
       ORDER BY submitted_at_ms DESC, id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...parameters, limit, offset) as EnterpriseVerificationRow[];
  const totalRow = database
    .prepare(
      `SELECT COUNT(*) AS count FROM enterprise_verification_applications ${where}`,
    )
    .get(...parameters) as { count: number };
  return {
    applications: rows.map((row) => rowToView(store, row)),
    total: Number(totalRow.count),
  };
}

export function cancelEnterpriseVerificationApplication(
  store: EnterpriseVerificationRepositoryStore,
  input: CancelEnterpriseVerificationApplicationInput,
): EnterpriseVerificationApplicationView {
  const applicationId = normalizeId(input.applicationId, '申请 ID');
  const applicantAccountId = normalizeId(input.applicantAccountId, '申请账号 ID');
  const database = store.db();
  database.exec('BEGIN IMMEDIATE');
  try {
    const row = getRowById(database, applicationId);
    if (!row || row.applicant_account_id !== applicantAccountId) {
      throw verificationError(
        'application_not_found',
        '企业认证申请不存在或无权访问',
      );
    }
    if (row.status === 'cancelled') {
      database.exec('COMMIT');
      return rowToView(store, row);
    }
    if (row.status !== 'manual_review') {
      throw verificationError(
        'invalid_status_transition',
        '当前状态不允许取消申请',
      );
    }
    const now = store.now();
    database
      .prepare(
        `UPDATE enterprise_verification_applications
         SET status = 'cancelled', cancelled_at_ms = ?, updated_at_ms = ?
         WHERE id = ? AND applicant_account_id = ? AND status = 'manual_review'`,
      )
      .run(now, now, applicationId, applicantAccountId);
    const cancelled = getRowById(database, applicationId)!;
    database.exec('COMMIT');
    return rowToView(store, cancelled);
  } catch (error) {
    rollbackIfNeeded(database);
    throw error;
  }
}

function normalizeReviewNote(value: string): string {
  return normalizeRequiredText(value, '审核意见', 1000);
}

function organizationSlug(
  enterpriseName: string,
  creditCode: string,
): string {
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

function isOrganizationSlugConstraint(error: unknown): boolean {
  return (
    error instanceof Error &&
    /UNIQUE constraint failed: organizations\.slug/iu.test(error.message)
  );
}

function isApprovedCreditCodeConstraint(error: unknown): boolean {
  return (
    error instanceof Error &&
    /enterprise_verification_applications\.unified_social_credit_code/iu.test(
      error.message,
    )
  );
}

export function approveEnterpriseVerificationApplication(
  store: EnterpriseVerificationRepositoryStore,
  input: ApproveEnterpriseVerificationApplicationInput,
): EnterpriseVerificationApplicationView {
  const applicationId = normalizeId(input.applicationId, '申请 ID');
  const reviewerId = assertPlatformReviewer(store, input.reviewerId);
  const reviewNote = normalizeReviewNote(input.reviewNote);
  const database = store.db();
  database.exec('BEGIN IMMEDIATE');
  try {
    const row = getRowById(database, applicationId);
    if (!row) {
      throw verificationError('application_not_found', '企业认证申请不存在');
    }
    if (row.status === 'approved') {
      database.exec('COMMIT');
      return rowToView(store, row);
    }
    if (row.status !== 'manual_review') {
      throw verificationError(
        'invalid_status_transition',
        '当前状态不允许批准申请',
      );
    }

    const duplicateApproved = database
      .prepare(
        `SELECT id FROM enterprise_verification_applications
         WHERE unified_social_credit_code = ? AND status = 'approved' AND id <> ?`,
      )
      .get(row.unified_social_credit_code, row.id);
    if (duplicateApproved) {
      throw verificationError(
        'credit_code_already_approved',
        '该统一社会信用代码已通过企业认证',
      );
    }

    const account = database
      .prepare(
        `SELECT id, name, employee_id
         FROM accounts
         WHERE id = ? AND organization_id = ? AND account_type = 'personal'
           AND status = 'active' AND deleted_at IS NULL`,
      )
      .get(row.applicant_account_id, row.source_organization_id) as
      | { id: string; name: string; employee_id: string | null }
      | undefined;
    if (!account || account.employee_id !== null) {
      throw verificationError(
        'applicant_not_eligible',
        '申请账号已不再是可升级的 personal account',
      );
    }
    const activeOrganization = database
      .prepare('SELECT id FROM organizations WHERE id = ? AND status = \'active\'')
      .get(row.source_organization_id);
    if (!activeOrganization) {
      throw verificationError('applicant_not_eligible', '个人组织不存在或已停用');
    }
    const activeAccounts = database
      .prepare(
        `SELECT COUNT(*) AS count FROM accounts
         WHERE organization_id = ? AND status = 'active' AND deleted_at IS NULL`,
      )
      .get(row.source_organization_id) as { count: number };
    if (Number(activeAccounts.count) !== 1) {
      throw verificationError(
        'organization_not_isolated',
        '个人组织存在其他活动账号，不能原地升级为企业',
      );
    }

    const slug = organizationSlug(row.enterprise_name, row.unified_social_credit_code);
    const slugConflict = database
      .prepare(
        'SELECT id FROM organizations WHERE slug = ? COLLATE NOCASE AND id <> ?',
      )
      .get(slug, row.source_organization_id);
    if (slugConflict) {
      throw verificationError(
        'organization_slug_conflict',
        '企业标识已存在，无法完成认证',
      );
    }

    const role =
      row.applicant_identity === 'legal_representative' ? 'CEO' : '企业管理员';
    const departmentId = store.createDepartmentId();
    const employeeId = store.createEmployeeId();
    const now = store.now();
    const updatedOrganization = database
      .prepare(
        `UPDATE organizations
         SET name = ?, slug = ?, updated_at = datetime('now')
         WHERE id = ? AND status = 'active'`,
      )
      .run(row.enterprise_name, slug, row.source_organization_id);
    if (Number(updatedOrganization.changes) !== 1) {
      throw verificationError('applicant_not_eligible', '个人组织升级失败');
    }
    database
      .prepare(
        `INSERT INTO organization_departments
         (id, organization_id, name, parent_department_id)
         VALUES (?, ?, '管理层', NULL)`,
      )
      .run(departmentId, row.source_organization_id);
    database
      .prepare(
        `INSERT INTO employees
         (id, organization_id, name, role, department, department_id,
          position_title, status)
         VALUES (?, ?, ?, ?, '管理层', ?, ?, 'active')`,
      )
      .run(
        employeeId,
        row.source_organization_id,
        account.name,
        role,
        departmentId,
        role,
      );
    const updatedAccount = database
      .prepare(
        `UPDATE accounts
         SET account_type = 'enterprise', employee_id = ?, role = ?,
             department = '管理层', department_id = ?, position_id = NULL,
             position_title = ?, is_admin = 1,
             updated_at = datetime('now')
         WHERE id = ? AND organization_id = ? AND account_type = 'personal'
           AND status = 'active' AND deleted_at IS NULL`,
      )
      .run(
        employeeId,
        role,
        departmentId,
        role,
        row.applicant_account_id,
        row.source_organization_id,
      );
    if (Number(updatedAccount.changes) !== 1) {
      throw verificationError('applicant_not_eligible', '个人账号升级失败');
    }
    database
      .prepare(
        `UPDATE enterprise_verification_applications
         SET status = 'approved', reviewer_id = ?, review_note = ?,
             decided_at_ms = ?, updated_at_ms = ?
         WHERE id = ? AND status = 'manual_review'`,
      )
      .run(reviewerId, reviewNote, now, now, applicationId);

    const approved = getRowById(database, applicationId)!;
    database.exec('COMMIT');
    return rowToView(store, approved);
  } catch (error) {
    rollbackIfNeeded(database);
    if (isOrganizationSlugConstraint(error)) {
      throw verificationError(
        'organization_slug_conflict',
        '企业标识已存在，无法完成认证',
      );
    }
    if (isApprovedCreditCodeConstraint(error)) {
      throw verificationError(
        'credit_code_already_approved',
        '该统一社会信用代码已通过企业认证',
      );
    }
    throw error;
  }
}

export function rejectEnterpriseVerificationApplication(
  store: EnterpriseVerificationRepositoryStore,
  input: RejectEnterpriseVerificationApplicationInput,
): EnterpriseVerificationApplicationView {
  const applicationId = normalizeId(input.applicationId, '申请 ID');
  const reviewerId = assertPlatformReviewer(store, input.reviewerId);
  const reviewNote = normalizeReviewNote(input.reviewNote);
  const database = store.db();
  database.exec('BEGIN IMMEDIATE');
  try {
    const row = getRowById(database, applicationId);
    if (!row) {
      throw verificationError('application_not_found', '企业认证申请不存在');
    }
    if (row.status === 'rejected') {
      database.exec('COMMIT');
      return rowToView(store, row);
    }
    if (row.status !== 'manual_review') {
      throw verificationError(
        'invalid_status_transition',
        '当前状态不允许驳回申请',
      );
    }
    const now = store.now();
    database
      .prepare(
        `UPDATE enterprise_verification_applications
         SET status = 'rejected', reviewer_id = ?, review_note = ?,
             decided_at_ms = ?, updated_at_ms = ?
         WHERE id = ? AND status = 'manual_review'`,
      )
      .run(reviewerId, reviewNote, now, now, applicationId);
    const rejected = getRowById(database, applicationId)!;
    database.exec('COMMIT');
    return rowToView(store, rejected);
  } catch (error) {
    rollbackIfNeeded(database);
    throw error;
  }
}
