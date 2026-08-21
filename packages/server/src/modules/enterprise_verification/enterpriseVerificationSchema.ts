/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { DatabaseSchemaContributor } from '../data_platform/index.js';

export const ENTERPRISE_VERIFICATION_SCHEMA_CONTRIBUTOR: DatabaseSchemaContributor =
  {
    id: 'enterprise_verification',
    apply(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS enterprise_verification_applications (
          id TEXT PRIMARY KEY,
          applicant_account_id TEXT NOT NULL,
          source_organization_id TEXT NOT NULL,
          enterprise_name TEXT NOT NULL,
          unified_social_credit_code TEXT NOT NULL COLLATE NOCASE,
          applicant_identity TEXT NOT NULL
            CHECK(applicant_identity IN ('legal_representative', 'authorized_agent')),

          legal_representative_name_ciphertext TEXT NOT NULL,
          legal_representative_name_iv TEXT NOT NULL,
          legal_representative_name_auth_tag TEXT NOT NULL,
          legal_representative_name_key_version INTEGER NOT NULL,

          business_license_reference_ciphertext TEXT NOT NULL,
          business_license_reference_iv TEXT NOT NULL,
          business_license_reference_auth_tag TEXT NOT NULL,
          business_license_reference_key_version INTEGER NOT NULL,
          business_license_sha256 TEXT NOT NULL,

          authorization_letter_reference_ciphertext TEXT,
          authorization_letter_reference_iv TEXT,
          authorization_letter_reference_auth_tag TEXT,
          authorization_letter_reference_key_version INTEGER,
          authorization_letter_sha256 TEXT,

          status TEXT NOT NULL
            CHECK(status IN ('manual_review', 'approved', 'rejected', 'cancelled')),
          submitted_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL,
          cancelled_at_ms INTEGER,
          reviewer_id TEXT,
          review_note TEXT,
          decided_at_ms INTEGER,

          CHECK(
            (
              authorization_letter_reference_ciphertext IS NULL AND
              authorization_letter_reference_iv IS NULL AND
              authorization_letter_reference_auth_tag IS NULL AND
              authorization_letter_reference_key_version IS NULL AND
              authorization_letter_sha256 IS NULL
            ) OR (
              authorization_letter_reference_ciphertext IS NOT NULL AND
              authorization_letter_reference_iv IS NOT NULL AND
              authorization_letter_reference_auth_tag IS NOT NULL AND
              authorization_letter_reference_key_version IS NOT NULL AND
              authorization_letter_sha256 IS NOT NULL
            )
          ),
          CHECK(
            applicant_identity = 'legal_representative' OR
            authorization_letter_reference_ciphertext IS NOT NULL
          ),
          CHECK(
            (status IN ('approved', 'rejected') AND reviewer_id IS NOT NULL AND
             review_note IS NOT NULL AND decided_at_ms IS NOT NULL) OR
            (status IN ('manual_review', 'cancelled') AND reviewer_id IS NULL AND
             review_note IS NULL AND decided_at_ms IS NULL)
          ),
          CHECK(
            (status = 'cancelled' AND cancelled_at_ms IS NOT NULL) OR
            (status <> 'cancelled' AND cancelled_at_ms IS NULL)
          ),

          FOREIGN KEY (applicant_account_id) REFERENCES accounts(id),
          FOREIGN KEY (source_organization_id) REFERENCES organizations(id)
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_enterprise_verification_pending_applicant
          ON enterprise_verification_applications(applicant_account_id)
          WHERE status = 'manual_review';
        CREATE UNIQUE INDEX IF NOT EXISTS idx_enterprise_verification_approved_credit_code
          ON enterprise_verification_applications(unified_social_credit_code)
          WHERE status = 'approved';
        CREATE INDEX IF NOT EXISTS idx_enterprise_verification_review_queue
          ON enterprise_verification_applications(status, submitted_at_ms DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_enterprise_verification_applicant_history
          ON enterprise_verification_applications(applicant_account_id, submitted_at_ms DESC);

        CREATE TABLE IF NOT EXISTS enterprise_verification_evidence (
          id TEXT PRIMARY KEY,
          applicant_account_id TEXT NOT NULL,
          source_organization_id TEXT NOT NULL,
          purpose TEXT NOT NULL
            CHECK(purpose IN ('business_license', 'authorization_letter')),
          storage_key_ciphertext TEXT NOT NULL,
          storage_key_iv TEXT NOT NULL,
          storage_key_auth_tag TEXT NOT NULL,
          storage_key_key_version INTEGER NOT NULL,
          file_name TEXT NOT NULL,
          content_type TEXT NOT NULL
            CHECK(content_type IN ('application/pdf', 'image/png', 'image/jpeg')),
          sha256 TEXT NOT NULL,
          size_bytes INTEGER NOT NULL CHECK(size_bytes > 0 AND size_bytes <= 8388608),
          application_id TEXT,
          created_at_ms INTEGER NOT NULL,
          deleted_at_ms INTEGER,
          FOREIGN KEY (applicant_account_id) REFERENCES accounts(id),
          FOREIGN KEY (source_organization_id) REFERENCES organizations(id),
          FOREIGN KEY (application_id)
            REFERENCES enterprise_verification_applications(id)
        );

        CREATE INDEX IF NOT EXISTS idx_enterprise_verification_evidence_owner
          ON enterprise_verification_evidence(
            applicant_account_id, source_organization_id, purpose, application_id
          );
        CREATE INDEX IF NOT EXISTS idx_enterprise_verification_evidence_application
          ON enterprise_verification_evidence(application_id)
          WHERE application_id IS NOT NULL;
      `);
    },
  };
