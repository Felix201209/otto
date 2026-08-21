/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

export type EnterpriseVerificationStatus =
  | 'manual_review'
  | 'approved'
  | 'rejected'
  | 'cancelled';

export type EnterpriseVerificationApplicantIdentity =
  | 'legal_representative'
  | 'authorized_agent';

export type EnterpriseVerificationEvidencePurpose =
  | 'business_license'
  | 'authorization_letter';

export interface EnterpriseVerificationEvidenceInput {
  evidenceReference: string;
  evidenceSha256: string;
}

export interface SubmitEnterpriseVerificationApplicationInput {
  applicantAccountId: string;
  sourceOrganizationId: string;
  enterpriseName: string;
  unifiedSocialCreditCode: string;
  legalRepresentativeName: string;
  applicantIdentity: EnterpriseVerificationApplicantIdentity;
  businessLicense: EnterpriseVerificationEvidenceInput;
  authorizationLetter?: EnterpriseVerificationEvidenceInput | null;
}

export interface GetEnterpriseVerificationApplicationForApplicantInput {
  applicantAccountId: string;
  applicationId?: string;
}

export interface ListEnterpriseVerificationApplicationsInput {
  reviewerId: string;
  status?: EnterpriseVerificationStatus;
  limit?: number;
  offset?: number;
}

export interface CancelEnterpriseVerificationApplicationInput {
  applicationId: string;
  applicantAccountId: string;
}

export interface ApproveEnterpriseVerificationApplicationInput {
  applicationId: string;
  reviewerId: string;
  reviewNote: string;
}

export interface RejectEnterpriseVerificationApplicationInput {
  applicationId: string;
  reviewerId: string;
  reviewNote: string;
}

export interface UploadEnterpriseVerificationEvidenceInput {
  applicantAccountId: string;
  sourceOrganizationId: string;
  purpose: EnterpriseVerificationEvidencePurpose;
  fileName: string;
  contentType: string;
  content: Buffer;
}

export interface UploadEnterpriseVerificationEvidenceResult {
  evidenceReference: string;
  evidenceSha256: string;
  purpose: EnterpriseVerificationEvidencePurpose;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  createdAtMs: number;
}

export interface ReadEnterpriseVerificationEvidenceInput {
  applicationId: string;
  evidenceReference: string;
  reviewerId: string;
}

export interface ReadEnterpriseVerificationEvidenceResult {
  content: Buffer;
  evidenceReference: string;
  evidenceSha256: string;
  purpose: EnterpriseVerificationEvidencePurpose;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  createdAtMs: number;
}

export interface EnterpriseVerificationEvidenceView {
  evidenceReference: string;
  evidenceSha256: string;
}

export interface EnterpriseVerificationApplicationView {
  id: string;
  applicantAccountId: string;
  sourceOrganizationId: string;
  targetOrganizationId: string | null;
  enterpriseName: string;
  unifiedSocialCreditCode: string;
  legalRepresentativeName: string;
  applicantIdentity: EnterpriseVerificationApplicantIdentity;
  businessLicense: EnterpriseVerificationEvidenceView;
  authorizationLetter: EnterpriseVerificationEvidenceView | null;
  status: EnterpriseVerificationStatus;
  submittedAtMs: number;
  updatedAtMs: number;
  cancelledAtMs: number | null;
  reviewerId: string | null;
  reviewNote: string | null;
  decidedAtMs: number | null;
}

export interface SubmitEnterpriseVerificationApplicationResult {
  application: EnterpriseVerificationApplicationView;
  replayed: boolean;
}

export interface ListEnterpriseVerificationApplicationsResult {
  applications: EnterpriseVerificationApplicationView[];
  total: number;
}

export type EnterpriseVerificationErrorCode =
  | 'invalid_input'
  | 'invalid_credit_code'
  | 'invalid_evidence'
  | 'applicant_not_eligible'
  | 'application_conflict'
  | 'application_not_found'
  | 'evidence_not_found'
  | 'forbidden'
  | 'invalid_status_transition'
  | 'credit_code_already_approved'
  | 'organization_not_isolated'
  | 'organization_slug_conflict';

export class EnterpriseVerificationError extends Error {
  readonly code: EnterpriseVerificationErrorCode;

  constructor(code: EnterpriseVerificationErrorCode, message: string) {
    super(message);
    this.name = 'EnterpriseVerificationError';
    this.code = code;
  }
}
