/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { createIntegrationAdaptersComposition } from './integrationAdaptersComposition.js';

describe('integration adapters composition', () => {
  it('binds Feishu auto-reply to the effective enterprise feature grant', () => {
    const featureCheck = vi.fn(() => true);
    const integrations = createIntegrationAdaptersComposition({
      listFeishuAccountBindings: () => [
        {
          organizationId: 'org-a',
          accountActive: true,
          organizationActive: true,
        },
      ],
      isLicenseUsableForOrganizationFeature: () => true,
      isOrganizationFeatureEnabled: featureCheck,
    });

    expect(integrations.isFeishuAutoReplyEnabledForOpenId('ou_member')).toBe(
      true,
    );
    expect(featureCheck).toHaveBeenCalledWith('org-a', 'feishu_auto_reply');
  });

  it('rejects Feishu auto-reply when the signed License omits the module', () => {
    const featureCheck = vi.fn(() => true);
    const integrations = createIntegrationAdaptersComposition({
      listFeishuAccountBindings: () => [
        {
          organizationId: 'org-a',
          accountActive: true,
          organizationActive: true,
        },
      ],
      isLicenseUsableForOrganizationFeature: () => false,
      isOrganizationFeatureEnabled: featureCheck,
    });

    expect(integrations.isFeishuAutoReplyEnabledForOpenId('ou_member')).toBe(
      false,
    );
    expect(featureCheck).not.toHaveBeenCalled();
  });

  it('keeps integration access fail-closed when authorization fails', () => {
    const integrations = createIntegrationAdaptersComposition({
      listFeishuAccountBindings: () => [
        {
          organizationId: 'org-a',
          accountActive: true,
          organizationActive: true,
        },
      ],
      isLicenseUsableForOrganizationFeature: () => true,
      isOrganizationFeatureEnabled: () => {
        throw new Error('authorization unavailable');
      },
    });

    expect(integrations.isFeishuAutoReplyEnabledForOpenId('ou_member')).toBe(
      false,
    );
  });
});
