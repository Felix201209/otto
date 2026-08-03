/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { escapeLegalHtml } from './dataGovernanceRoutes.js';
import {
  CURRENT_LEGAL_DOCUMENTS,
  currentLegalDocumentReferences,
  dataGovernanceConfiguration,
  legalDocumentHash,
  requireCurrentLegalDocumentReferences,
} from './legalDocuments.js';

describe('versioned legal documents', () => {
  it('escapes deployment-controlled values before rendering legal HTML', () => {
    expect(escapeLegalHtml('<script>alert("x")</script>')).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
    );
  });

  it('publishes complete structured terms and privacy bodies', () => {
    expect(CURRENT_LEGAL_DOCUMENTS.map((document) => document.id)).toEqual([
      'terms',
      'privacy',
    ]);
    for (const document of CURRENT_LEGAL_DOCUMENTS) {
      expect(document.sections.length).toBeGreaterThanOrEqual(10);
      expect(
        document.sections.every(
          (section) =>
            section.paragraphs.length > 0 || (section.items?.length ?? 0) > 0,
        ),
      ).toBe(true);
    }
  });

  it('changes the published hash when any body paragraph changes', () => {
    const original = CURRENT_LEGAL_DOCUMENTS[0];
    const changed = {
      ...original,
      sections: original.sections.map((section, index) =>
        index === 0
          ? {
              ...section,
              paragraphs: [...section.paragraphs, '新增条款。'],
            }
          : section,
      ),
    };

    expect(legalDocumentHash(changed)).not.toBe(legalDocumentHash(original));
  });

  it('requires the exact current id, version and hash set', () => {
    const current = currentLegalDocumentReferences();
    expect(requireCurrentLegalDocumentReferences(current)).toEqual(current);

    expect(() =>
      requireCurrentLegalDocumentReferences(current.slice(0, 1)),
    ).toThrow(/协议或隐私规则已更新/u);
    expect(() =>
      requireCurrentLegalDocumentReferences([
        { ...current[0]!, hash: '0'.repeat(64) },
        current[1]!,
      ]),
    ).toThrow(/协议或隐私规则已更新/u);
    expect(() =>
      requireCurrentLegalDocumentReferences([...current, current[0]!]),
    ).toThrow(/协议或隐私规则已更新/u);
  });

  it('keeps legal delivery fail-closed until the deployment approves the text', () => {
    const previous = {
      controller: process.env.OTTO_DATA_CONTROLLER_NAME,
      contact: process.env.OTTO_PRIVACY_CONTACT,
      storage: process.env.OTTO_STORAGE_VOLUME_ENCRYPTED,
      approved: process.env.OTTO_LEGAL_DOCUMENTS_APPROVED,
    };
    try {
      process.env.OTTO_DATA_CONTROLLER_NAME = '测试企业';
      process.env.OTTO_PRIVACY_CONTACT = 'privacy@example.test';
      process.env.OTTO_STORAGE_VOLUME_ENCRYPTED = 'true';
      process.env.OTTO_LEGAL_DOCUMENTS_APPROVED = 'false';
      expect(dataGovernanceConfiguration().readiness).toMatchObject({
        configured: false,
        legalDocumentsApproved: false,
      });

      process.env.OTTO_LEGAL_DOCUMENTS_APPROVED = 'true';
      expect(dataGovernanceConfiguration().readiness).toMatchObject({
        configured: true,
        legalDocumentsApproved: true,
      });
    } finally {
      const restore = (key: string, value: string | undefined): void => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      };
      restore('OTTO_DATA_CONTROLLER_NAME', previous.controller);
      restore('OTTO_PRIVACY_CONTACT', previous.contact);
      restore('OTTO_STORAGE_VOLUME_ENCRYPTED', previous.storage);
      restore('OTTO_LEGAL_DOCUMENTS_APPROVED', previous.approved);
    }
  });
});
