/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  EnterpriseVerificationError,
  type EnterpriseVerificationApplicantIdentity,
  type EnterpriseVerificationApplicationView,
  type EnterpriseVerificationEvidenceInput,
  type EnterpriseVerificationEvidencePurpose,
  type EnterpriseVerificationStatus,
} from '../modules/enterprise_verification/index.js';
import * as db from './db.js';

const EVIDENCE_UPLOAD_BODY_LIMIT = 12 * 1024 * 1024;
const MAX_EVIDENCE_BASE64_LENGTH = 11_200_000;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{8,256}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const REVIEW_STATUSES = new Set<EnterpriseVerificationStatus>([
  'manual_review',
  'approved',
  'rejected',
  'cancelled',
]);
const EVIDENCE_CONTENT_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
]);

export type EnterpriseVerificationPrincipal =
  | { kind: 'system'; organizationId: string }
  | { kind: 'account'; organizationId: string; account: db.AccountView };

interface EnterpriseVerificationRouteDeps {
  path: string;
  method: string;
  url: URL;
  req: IncomingMessage;
  res: ServerResponse;
  memberAccount: db.AccountView | null;
  adminPrincipal: EnterpriseVerificationPrincipal | null;
  readBody(
    req: IncomingMessage,
    maxLength?: number,
  ): Promise<Record<string, unknown>>;
  sendJSON(res: ServerResponse, status: number, data: unknown): void;
}

function text(value: unknown, maxLength = 500): string {
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  return normalized.length <= maxLength ? normalized : '';
}

function opaqueId(value: unknown): string | null {
  const normalized = text(value, 256);
  return OPAQUE_ID_PATTERN.test(normalized) ? normalized : null;
}

function evidence(value: unknown): EnterpriseVerificationEvidenceInput | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const evidenceReference = opaqueId(
    record.evidenceReference ?? record.reference,
  );
  const evidenceSha256 = text(
    record.evidenceSha256 ?? record.sha256,
    64,
  ).toLowerCase();
  if (!evidenceReference || !SHA256_PATTERN.test(evidenceSha256)) return null;
  return { evidenceReference, evidenceSha256 };
}

function applicantIdentity(
  value: unknown,
): EnterpriseVerificationApplicantIdentity | null {
  return value === 'legal_representative' || value === 'authorized_agent'
    ? value
    : null;
}

function evidencePurpose(
  value: unknown,
): EnterpriseVerificationEvidencePurpose | null {
  return value === 'business_license' || value === 'authorization_letter'
    ? value
    : null;
}

function decodeBase64(value: unknown): Buffer | null {
  if (typeof value !== 'string') return null;
  const encoded = value.trim();
  if (
    !encoded ||
    encoded.length > MAX_EVIDENCE_BASE64_LENGTH ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
  ) {
    return null;
  }
  const content = Buffer.from(encoded, 'base64');
  return content.toString('base64') === encoded ? content : null;
}

function positiveInteger(
  value: string | null,
  fallback: number,
): number | null {
  if (value === null || value === '') return fallback;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function decodeOpaquePathPart(value: string): string | null {
  try {
    return opaqueId(decodeURIComponent(value));
  } catch {
    return null;
  }
}

function applicationIdFromReviewPath(path: string): {
  applicationId: string;
  action: 'approve' | 'reject';
} | null {
  const match =
    /^\/enterprise\/platform\/verifications\/([^/]+)\/(approve|reject)$/.exec(
      path,
    );
  if (!match) return null;
  const applicationId = decodeOpaquePathPart(match[1]!);
  return applicationId
    ? {
        applicationId,
        action: match[2] as 'approve' | 'reject',
      }
    : null;
}

function evidenceDownloadFromPath(path: string): {
  applicationId: string;
  evidenceReference: string;
} | null {
  const match =
    /^\/enterprise\/platform\/verifications\/([^/]+)\/evidence\/([^/]+)$/.exec(
      path,
    );
  if (!match) return null;
  const applicationId = decodeOpaquePathPart(match[1]!);
  const evidenceReference = decodeOpaquePathPart(match[2]!);
  return applicationId && evidenceReference
    ? { applicationId, evidenceReference }
    : null;
}

function safeContentType(value: string): string {
  const normalized = value.trim().toLowerCase();
  return EVIDENCE_CONTENT_TYPES.has(normalized)
    ? normalized
    : 'application/octet-stream';
}

function safeFileName(value: string): string {
  const withoutControlCharacters = Array.from(value)
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 0x1f && codePoint !== 0x7f;
    })
    .join('');
  const normalized = withoutControlCharacters
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim()
    .slice(0, 180);
  return normalized && normalized !== '.' && normalized !== '..'
    ? normalized
    : 'enterprise-verification-evidence.bin';
}

function contentDisposition(fileName: string): string {
  const safeName = safeFileName(fileName);
  const asciiName = safeName.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '_');
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`;
}

function sendVerificationError(
  res: ServerResponse,
  sendJSON: EnterpriseVerificationRouteDeps['sendJSON'],
  error: unknown,
  fallback: string,
): boolean {
  if (!(error instanceof EnterpriseVerificationError)) return false;
  const responses: Record<
    EnterpriseVerificationError['code'],
    { status: number; error: string }
  > = {
    invalid_input: { status: 400, error: '企业认证请求参数不正确' },
    invalid_credit_code: { status: 400, error: '统一社会信用代码无效' },
    invalid_evidence: {
      status: 400,
      error: '认证材料无效、已过期或不属于当前账号',
    },
    applicant_not_eligible: {
      status: 409,
      error: '当前账号不符合企业认证或升级条件',
    },
    application_conflict: {
      status: 409,
      error: '已有企业认证申请正在处理',
    },
    application_not_found: { status: 404, error: '企业认证申请不存在' },
    evidence_not_found: { status: 404, error: '认证材料不存在' },
    forbidden: { status: 403, error: '无权执行企业认证操作' },
    invalid_status_transition: {
      status: 409,
      error: '当前申请状态不允许执行该操作',
    },
    credit_code_already_approved: {
      status: 409,
      error: '该统一社会信用代码已经通过认证',
    },
    organization_not_isolated: {
      status: 409,
      error: '当前个人空间不能安全升级为企业',
    },
    organization_slug_conflict: {
      status: 409,
      error: '企业标识冲突，请联系平台管理员',
    },
  };
  const response = responses[error.code] ?? { status: 400, error: fallback };
  sendJSON(res, response.status, { error: response.error });
  return true;
}

function toWireEvidence(evidence: EnterpriseVerificationEvidenceInput | null) {
  return evidence
    ? {
        reference: evidence.evidenceReference,
        sha256: evidence.evidenceSha256,
      }
    : null;
}

function toWireApplication(application: EnterpriseVerificationApplicationView) {
  const submittedAt = new Date(application.submittedAtMs).toISOString();
  return {
    id: application.id,
    legalName: application.enterpriseName,
    unifiedSocialCreditCode: application.unifiedSocialCreditCode,
    legalRepresentativeName: application.legalRepresentativeName,
    applicantAuthority: application.applicantIdentity,
    businessLicenseEvidence: toWireEvidence(application.businessLicense),
    authorizationEvidence: toWireEvidence(application.authorizationLetter),
    status: application.status,
    reviewNote: application.reviewNote,
    reviewedBy: application.reviewerId,
    reviewedAt:
      application.decidedAtMs === null
        ? null
        : new Date(application.decidedAtMs).toISOString(),
    provisionedOrganizationId:
      application.status === 'approved'
        ? application.sourceOrganizationId
        : null,
    submittedAt,
    createdAt: submittedAt,
    updatedAt: new Date(application.updatedAtMs).toISOString(),
  };
}

function logVerificationAudit(
  event: string,
  organizationId: string,
  detail: {
    applicationId?: string;
    evidenceReference?: string;
    status?: string;
  },
): void {
  try {
    db.logAudit(event, null, JSON.stringify(detail), organizationId);
  } catch {
    console.error('[Otto Enterprise] enterprise verification audit failed', {
      event,
      applicationId: detail.applicationId,
    });
  }
}

function sourceOrganizationIdForApplication(
  applicationId: string,
): string | null {
  let offset = 0;
  for (;;) {
    const page = db.listEnterpriseVerificationApplications({
      reviewerId: 'platform-system',
      limit: 200,
      offset,
    });
    const application = page.applications.find(
      (item) => item.id === applicationId,
    );
    if (application) return application.sourceOrganizationId;
    offset += page.applications.length;
    if (page.applications.length === 0 || offset >= page.total) return null;
  }
}

/**
 * 企业主体认证的 HTTP 边界。
 *
 * 申请人只能操作自己的申请；审批与原始材料读取只接受平台 system
 * principal。企业管理员账号即使拥有本企业管理权限，也不能审核法律主体。
 */
export async function handleEnterpriseVerificationRoute({
  path,
  method,
  url,
  req,
  res,
  memberAccount,
  adminPrincipal,
  readBody,
  sendJSON,
}: EnterpriseVerificationRouteDeps): Promise<boolean> {
  if (path === '/enterprise/verification/evidence') {
    if (!memberAccount) {
      sendJSON(res, 401, { error: '登录已失效，请重新登录' });
      return true;
    }
    if (method !== 'POST') return false;
    if (memberAccount.accountType !== 'personal') {
      sendJSON(res, 409, { error: '当前账号已经属于企业' });
      return true;
    }

    const body = await readBody(req, EVIDENCE_UPLOAD_BODY_LIMIT);
    const purpose = evidencePurpose(body.purpose ?? body.evidencePurpose);
    const fileName = text(body.fileName, 180);
    const contentType = text(body.contentType, 100).toLowerCase();
    const content = decodeBase64(body.contentBase64);
    if (!purpose || !fileName || !contentType || !content) {
      sendJSON(res, 400, { error: '认证材料上传参数不正确' });
      return true;
    }
    try {
      const uploaded = db.uploadEnterpriseVerificationEvidence({
        applicantAccountId: memberAccount.id,
        sourceOrganizationId: memberAccount.organizationId,
        purpose,
        fileName,
        contentType,
        content,
      });
      logVerificationAudit(
        'enterprise_verification_evidence_uploaded',
        memberAccount.organizationId,
        { evidenceReference: uploaded.evidenceReference },
      );
      sendJSON(res, 201, {
        evidence: {
          reference: uploaded.evidenceReference,
          sha256: uploaded.evidenceSha256,
          fileName: uploaded.fileName,
          contentType: uploaded.contentType,
          sizeBytes: uploaded.sizeBytes,
        },
      });
    } catch (error) {
      if (
        !sendVerificationError(res, sendJSON, error, '企业认证材料上传失败')
      ) {
        sendJSON(res, 500, { error: '企业认证材料上传失败' });
      }
    }
    return true;
  }

  if (path === '/enterprise/verification/application') {
    if (!memberAccount) {
      sendJSON(res, 401, { error: '登录已失效，请重新登录' });
      return true;
    }

    if (method === 'GET') {
      const rawApplicationId = url.searchParams.get('applicationId');
      const applicationId = rawApplicationId
        ? opaqueId(rawApplicationId)
        : undefined;
      if (rawApplicationId && !applicationId) {
        sendJSON(res, 400, { error: '申请 ID 格式不正确' });
        return true;
      }
      const application = db.getEnterpriseVerificationApplicationForApplicant({
        applicantAccountId: memberAccount.id,
        ...(applicationId ? { applicationId } : {}),
      });
      sendJSON(res, 200, {
        application: application ? toWireApplication(application) : null,
      });
      return true;
    }

    if (method === 'POST') {
      if (memberAccount.accountType !== 'personal') {
        sendJSON(res, 409, { error: '当前账号已经属于企业' });
        return true;
      }
      if (!memberAccount.phone) {
        sendJSON(res, 400, { error: '请先绑定并验证手机号，再申请企业认证' });
        return true;
      }
      const body = await readBody(req);
      const businessLicense = evidence(
        body.businessLicense ?? body.businessLicenseEvidence,
      );
      const authorizationLetterValue =
        body.authorizationLetter ?? body.authorizationEvidence;
      const authorizationLetter =
        authorizationLetterValue == null
          ? null
          : evidence(authorizationLetterValue);
      const identity = applicantIdentity(
        body.applicantIdentity ?? body.applicantAuthority,
      );
      if (
        !businessLicense ||
        !identity ||
        (authorizationLetterValue != null && !authorizationLetter)
      ) {
        sendJSON(res, 400, { error: '企业认证申请参数不正确' });
        return true;
      }
      try {
        const result = db.submitEnterpriseVerificationApplication({
          applicantAccountId: memberAccount.id,
          sourceOrganizationId: memberAccount.organizationId,
          enterpriseName: text(body.enterpriseName ?? body.legalName, 200),
          unifiedSocialCreditCode: text(body.unifiedSocialCreditCode, 18),
          legalRepresentativeName: text(body.legalRepresentativeName, 100),
          applicantIdentity: identity,
          businessLicense,
          authorizationLetter,
        });
        logVerificationAudit(
          'enterprise_verification_submitted',
          result.application.sourceOrganizationId,
          {
            applicationId: result.application.id,
            status: result.application.status,
          },
        );
        sendJSON(res, result.replayed ? 200 : 201, {
          application: toWireApplication(result.application),
          replayed: result.replayed,
        });
      } catch (error) {
        if (!sendVerificationError(res, sendJSON, error, '企业认证申请失败')) {
          sendJSON(res, 500, { error: '企业认证申请失败' });
        }
      }
      return true;
    }

    if (method === 'DELETE') {
      const rawApplicationId = url.searchParams.get('applicationId');
      const applicationId = rawApplicationId
        ? opaqueId(rawApplicationId)
        : undefined;
      if (rawApplicationId && !applicationId) {
        sendJSON(res, 400, { error: '申请 ID 格式不正确' });
        return true;
      }
      const current = db.getEnterpriseVerificationApplicationForApplicant({
        applicantAccountId: memberAccount.id,
        ...(applicationId ? { applicationId } : {}),
      });
      if (!current) {
        sendJSON(res, 404, { error: '没有可取消的企业认证申请' });
        return true;
      }
      try {
        const application = db.cancelEnterpriseVerificationApplication({
          applicationId: current.id,
          applicantAccountId: memberAccount.id,
        });
        logVerificationAudit(
          'enterprise_verification_cancelled',
          application.sourceOrganizationId,
          { applicationId: application.id, status: application.status },
        );
        sendJSON(res, 200, { application: toWireApplication(application) });
      } catch (error) {
        if (!sendVerificationError(res, sendJSON, error, '取消认证申请失败')) {
          sendJSON(res, 500, { error: '取消认证申请失败' });
        }
      }
      return true;
    }

    return false;
  }

  if (path === '/enterprise/platform/verifications' && method === 'GET') {
    if (adminPrincipal?.kind !== 'system') {
      sendJSON(res, 403, { error: 'forbidden: platform admin token required' });
      return true;
    }
    const rawStatus = url.searchParams.get('status');
    if (
      rawStatus &&
      !REVIEW_STATUSES.has(rawStatus as EnterpriseVerificationStatus)
    ) {
      sendJSON(res, 400, { error: '企业认证状态筛选值不正确' });
      return true;
    }
    const limit = positiveInteger(url.searchParams.get('limit'), 50);
    const offset = positiveInteger(url.searchParams.get('offset'), 0);
    if (limit === null || limit < 1 || limit > 200 || offset === null) {
      sendJSON(res, 400, { error: '分页参数不正确' });
      return true;
    }
    try {
      const result = db.listEnterpriseVerificationApplications({
        reviewerId: 'platform-system',
        ...(rawStatus
          ? { status: rawStatus as EnterpriseVerificationStatus }
          : {}),
        limit,
        offset,
      });
      sendJSON(res, 200, {
        applications: result.applications.map(toWireApplication),
        total: result.total,
      });
    } catch (error) {
      if (
        !sendVerificationError(res, sendJSON, error, '企业认证列表读取失败')
      ) {
        sendJSON(res, 500, { error: '企业认证列表读取失败' });
      }
    }
    return true;
  }

  const evidenceDownload = evidenceDownloadFromPath(path);
  if (evidenceDownload && method === 'GET') {
    if (adminPrincipal?.kind !== 'system') {
      sendJSON(res, 403, { error: 'forbidden: platform admin token required' });
      return true;
    }
    try {
      const downloaded = db.readEnterpriseVerificationEvidence({
        ...evidenceDownload,
        reviewerId: 'platform-system',
      });
      const sourceOrganizationId = sourceOrganizationIdForApplication(
        evidenceDownload.applicationId,
      );
      if (sourceOrganizationId) {
        logVerificationAudit(
          'enterprise_verification_evidence_viewed',
          sourceOrganizationId,
          {
            applicationId: evidenceDownload.applicationId,
            evidenceReference: evidenceDownload.evidenceReference,
          },
        );
      }
      res.writeHead(200, {
        'Cache-Control': 'private, no-store',
        'Content-Disposition': contentDisposition(downloaded.fileName),
        'Content-Length': String(downloaded.content.byteLength),
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Content-Type': safeContentType(downloaded.contentType),
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(downloaded.content);
    } catch (error) {
      if (!sendVerificationError(res, sendJSON, error, '认证材料读取失败')) {
        sendJSON(res, 500, { error: '认证材料读取失败' });
      }
    }
    return true;
  }

  const review = applicationIdFromReviewPath(path);
  if (review && method === 'POST') {
    if (adminPrincipal?.kind !== 'system') {
      sendJSON(res, 403, { error: 'forbidden: platform admin token required' });
      return true;
    }
    const body = await readBody(req);
    const reviewNote = text(body.reviewNote, 1000);
    if (!reviewNote) {
      sendJSON(res, 400, { error: '请填写审核意见' });
      return true;
    }
    try {
      const application =
        review.action === 'approve'
          ? db.approveEnterpriseVerificationApplication({
              applicationId: review.applicationId,
              reviewerId: 'platform-system',
              reviewNote,
            })
          : db.rejectEnterpriseVerificationApplication({
              applicationId: review.applicationId,
              reviewerId: 'platform-system',
              reviewNote,
            });
      logVerificationAudit(
        review.action === 'approve'
          ? 'enterprise_verification_approved'
          : 'enterprise_verification_rejected',
        application.sourceOrganizationId,
        { applicationId: application.id, status: application.status },
      );
      sendJSON(res, 200, { application: toWireApplication(application) });
    } catch (error) {
      if (!sendVerificationError(res, sendJSON, error, '企业认证审核失败')) {
        sendJSON(res, 500, { error: '企业认证审核失败' });
      }
    }
    return true;
  }

  return false;
}
