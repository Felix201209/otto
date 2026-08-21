/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { platformAdminHTML } from './platformAdminPage.js';

describe('platformAdminHTML enterprise verification queue', () => {
  it('exposes an organization-independent review entry and required API paths', () => {
    const html = platformAdminHTML();

    expect(html).toContain('id="verificationQueueButton"');
    expect(html).toContain('id="verificationCount"');
    expect(html).toContain('id="verificationPanel"');
    expect(html).toContain(
      "api('/enterprise/platform/verifications?status=manual_review')",
    );
    expect(html).toContain("+'/'+action,{method:'POST'");
    expect(html).toContain("action==='approve'?'通过':'驳回'");
  });

  it('requires a review note and a second confirmation while blocking duplicates', () => {
    const html = platformAdminHTML();

    expect(html).toContain("if(!reviewNote){setReviewStatus(status,'请先填写审核意见'");
    expect(html).toContain("button.dataset.confirmReview!=='true'");
    expect(html).toContain("button.disabled=true;otherButton.disabled=true");
    expect(html).toContain('body:JSON.stringify({reviewNote})');
  });

  it('encodes opaque evidence identifiers and reuses the platform bearer token', () => {
    const html = platformAdminHTML();

    expect(html).toContain(
      "encodeURIComponent(String(applicationId||''))+'/evidence/'+encodeURIComponent(String(reference||''))",
    );
    expect(html).toContain("headers:{authorization:'Bearer '+token}");
    expect(html).not.toContain('dataset.evidenceReference');
    expect(html).not.toContain('dataset.authorizationEvidence');
    expect(html).not.toContain('href="/enterprise/platform/verifications/');
  });

  it('keeps the embedded page script syntactically valid', () => {
    const html = platformAdminHTML();
    const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];

    expect(script).toBeTruthy();
    expect(() => new Function(script!)).not.toThrow();
  });
});
