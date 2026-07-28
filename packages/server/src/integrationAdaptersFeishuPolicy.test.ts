/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createFeishuAutoReplyFacade,
  type FeishuAutoReplyPolicyDependencies,
} from './modules/integration_adapters/index.js';

function binding(
  organizationId: string,
  accountActive = true,
  organizationActive = true,
) {
  return { organizationId, accountActive, organizationActive };
}

function createPolicy(
  overrides: Partial<FeishuAutoReplyPolicyDependencies> = {},
) {
  return createFeishuAutoReplyFacade({
    listAccountBindings: () => [],
    isOrganizationFeatureEnabled: () => true,
    ...overrides,
  });
}

describe('integration_adapters Feishu auto-reply policy', () => {
  it('rejects an empty identity and keeps never-bound legacy allowlist users compatible', () => {
    const policy = createPolicy();

    expect(policy.isFeishuAutoReplyEnabledForOpenId('   ')).toBe(false);
    expect(policy.isFeishuAutoReplyEnabledForOpenId('ou_legacy')).toBe(true);
  });

  it('requires every linked account and organization to remain active', () => {
    expect(
      createPolicy({
        listAccountBindings: () => [binding('org-a', false, true)],
      }).isFeishuAutoReplyEnabledForOpenId('ou_disabled_account'),
    ).toBe(false);
    expect(
      createPolicy({
        listAccountBindings: () => [binding('org-a', true, false)],
      }).isFeishuAutoReplyEnabledForOpenId('ou_disabled_org'),
    ).toBe(false);
  });

  it('requires effective authorization from every linked organization', () => {
    const featureCheck = vi.fn(
      (organizationId: string) => organizationId === 'org-a',
    );
    const policy = createPolicy({
      listAccountBindings: () => [binding('org-a'), binding('org-b')],
      isOrganizationFeatureEnabled: featureCheck,
    });

    expect(policy.isFeishuAutoReplyEnabledForOpenId('ou_shared')).toBe(false);
    expect(featureCheck).toHaveBeenCalledWith('org-a');
    expect(featureCheck).toHaveBeenCalledWith('org-b');
  });

  it('checks one organization only once when several accounts share an open_id', () => {
    const featureCheck = vi.fn(() => true);
    const policy = createPolicy({
      listAccountBindings: () => [binding('org-a'), binding('org-a')],
      isOrganizationFeatureEnabled: featureCheck,
    });

    expect(policy.isFeishuAutoReplyEnabledForOpenId(' ou_shared ')).toBe(true);
    expect(featureCheck).toHaveBeenCalledTimes(1);
  });

  it('fails closed when identity lookup or authorization evaluation throws', () => {
    expect(
      createPolicy({
        listAccountBindings: () => {
          throw new Error('database unavailable');
        },
      }).isFeishuAutoReplyEnabledForOpenId('ou_failure'),
    ).toBe(false);
    expect(
      createPolicy({
        listAccountBindings: () => [binding('org-a')],
        isOrganizationFeatureEnabled: () => {
          throw new Error('license unavailable');
        },
      }).isFeishuAutoReplyEnabledForOpenId('ou_failure'),
    ).toBe(false);
  });
});
