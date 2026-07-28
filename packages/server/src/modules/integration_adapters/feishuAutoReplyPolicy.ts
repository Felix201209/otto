/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { FeishuAccountBinding } from '../identity_organization/index.js';

export interface FeishuAutoReplyPolicyDependencies {
  listAccountBindings(openId: string): readonly FeishuAccountBinding[];
  isOrganizationFeatureEnabled(organizationId: string): boolean;
}

/**
 * Legacy allowlisted senders may have no enterprise binding. Once a binding
 * exists, every linked account, tenant and effective feature grant must remain
 * active so one permissive tenant cannot bypass another tenant's shutdown.
 */
export function isFeishuAutoReplyEnabledForOpenIdInPolicy(
  dependencies: FeishuAutoReplyPolicyDependencies,
  openId: string,
): boolean {
  const normalized = openId.trim();
  if (!normalized) return false;

  try {
    const bindings = dependencies.listAccountBindings(normalized);
    if (bindings.length === 0) return true;

    const checkedOrganizations = new Map<string, boolean>();
    return bindings.every((binding) => {
      if (!binding.accountActive || !binding.organizationActive) return false;
      let enabled = checkedOrganizations.get(binding.organizationId);
      if (enabled === undefined) {
        enabled =
          dependencies.isOrganizationFeatureEnabled(binding.organizationId) ===
          true;
        checkedOrganizations.set(binding.organizationId, enabled);
      }
      return enabled;
    });
  } catch {
    return false;
  }
}
