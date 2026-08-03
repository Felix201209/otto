/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { FeishuAccountBinding } from '../identity_organization/index.js';
import { createFeishuAutoReplyFacade } from './feishuAutoReplyFacade.js';

export interface IntegrationAdaptersCompositionOptions {
  listFeishuAccountBindings(openId: string): readonly FeishuAccountBinding[];
  isLicenseUsableForOrganizationFeature(feature: 'feishu_auto_reply'): boolean;
  isOrganizationFeatureEnabled(
    organizationId: string,
    feature: 'feishu_auto_reply',
  ): boolean;
}

/** Builds external integration policies around effective enterprise access. */
export function createIntegrationAdaptersComposition(
  options: IntegrationAdaptersCompositionOptions,
) {
  return createFeishuAutoReplyFacade({
    listAccountBindings: options.listFeishuAccountBindings,
    isOrganizationFeatureEnabled: (organizationId) =>
      options.isLicenseUsableForOrganizationFeature('feishu_auto_reply') &&
      options.isOrganizationFeatureEnabled(organizationId, 'feishu_auto_reply'),
  });
}
