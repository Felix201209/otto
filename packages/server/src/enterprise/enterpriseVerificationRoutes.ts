/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  EnterpriseVerificationError,
  type EnterpriseVerificationApplicationView,
  type EnterpriseVerificationStatus,
} from '../modules/enterprise_verification/index.js';
import * as db from './db.js';

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{8,256}$/;
const REVIEW_STATUSES = new Set<EnterpriseVerificationStatus>([
  'manual_review',
  'approved',
  'rejected',
  'cancelled',
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
    invalid_input: { status: 400, error: '企业申请请求参数不正确' },
    invalid_credit_code: { status: 400, error: '统一社会信用代码无效' },
    invalid_evidence: {
      status: 400,
      error: '认证材料无效、已过期或不属于当前账号',
    },
    applicant_not_eligible: {
      status: 409,
      error: '当前账号不是可创建企业的有效个人账号，或手机号未绑定',
    },
    application_conflict: {
      status: 409,
      error: '当前账号已经创建企业，不能重复创建',
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
      error: '个人空间中存在其他活动账号，不能直接创建企业',
    },
    organization_slug_conflict: {
      status: 409,
      error: '企业标识冲突，请更换企业名称或联系平台管理员',
    },
  };
  const response = responses[error.code] ?? { status: 400, error: fallback };
  sendJSON(res, response.status, { error: response.error });
  return true;
}

function toWireApplication(application: EnterpriseVerificationApplicationView) {
  const submittedAt = new Date(application.submittedAtMs).toISOString();
  return {
    id: application.id,
    legalName: application.enterpriseName,
    unifiedSocialCreditCode: null,
    legalRepresentativeName: null,
    applicantAuthority: null,
    businessLicenseEvidence: null,
    authorizationEvidence: null,
    authoritativeBusinessVerification: false,
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


/**
 * 企业自助创建的 HTTP 边界。
 *
 * 新申请只使用会话账号、已验证手机号和企业名称，并立即升级个人组织。
 * 这不是权威工商主体认证。旧申请只保留数据库迁移与审核兼容，
 * 公网 API 不再接受或下载认证材料。
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
      if (!memberAccount.phone) {
        sendJSON(res, 400, {
          error: '请先绑定并验证手机号，再申请创建企业',
        });
        return true;
      }
      const body = await readBody(req);
      const enterpriseName = text(
        body.enterpriseName ?? body.legalName,
        80,
      );
      if (!enterpriseName) {
        sendJSON(res, 400, { error: '请填写企业名称' });
        return true;
      }
      try {
        const result = db.submitEnterpriseVerificationApplication({
          applicantAccountId: memberAccount.id,
          sourceOrganizationId: memberAccount.organizationId,
          enterpriseName,
        });
        logVerificationAudit(
          result.replayed
            ? 'enterprise_self_service_creation_replayed'
            : 'enterprise_self_service_created',
          result.application.sourceOrganizationId,
          {
            applicationId: result.application.id,
            status: result.application.status,
          },
        );
        sendJSON(res, result.replayed ? 200 : 201, {
          application: toWireApplication(result.application),
          replayed: result.replayed,
          authoritativeBusinessVerification: false,
        });
      } catch (error) {
        if (!sendVerificationError(res, sendJSON, error, '创建企业失败')) {
          sendJSON(res, 500, { error: '创建企业失败' });
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
