/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { platformAdminHTML } from './platformAdminPage.js';

describe('platformAdminHTML legacy enterprise onboarding queue', () => {
  it('keeps an organization-independent compatibility queue for old requests', () => {
    const html = platformAdminHTML();

    expect(html).toContain('id="verificationQueueButton"');
    expect(html).toContain('id="verificationCount"');
    expect(html).toContain('id="verificationPanel"');
    expect(html).toContain('历史开通申请');
    expect(html).toContain('新企业开通不需要在这里人工审核');
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

  it('shows only the enterprise name and submitted time without old evidence details', () => {
    const html = platformAdminHTML();

    expect(html).toContain(
      "name.textContent=String(application.legalName||'未命名企业')",
    );
    expect(html).toContain(
      "appendVerificationDetail(details,'提交时间',formatSubmittedAt(application.submittedAt))",
    );
    expect(html).not.toContain('统一社会信用代码');
    expect(html).not.toContain('法定代表人');
    expect(html).not.toContain('申请人身份');
    expect(html).not.toContain('营业执照');
    expect(html).not.toContain('授权书');
    expect(html).not.toContain("+'/evidence/'");
    expect(html).not.toContain('fetchVerificationEvidence');
  });

  it('keeps the embedded page script syntactically valid', () => {
    const html = platformAdminHTML();
    const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];

    expect(script).toBeTruthy();
    expect(() => new Function(script!)).not.toThrow();
  });
});
