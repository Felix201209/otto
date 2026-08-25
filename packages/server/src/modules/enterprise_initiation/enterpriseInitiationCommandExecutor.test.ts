/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { DeploymentLicenseView } from '../commercial_control/index.js';
import {
  payloadDigest,
  type ControlCommandEnvelope,
} from '../control_commands/index.js';
import { createEnterpriseInitiationCommandExecutor } from './enterpriseInitiationCommandExecutor.js';

const payload = {
  organization: { id: 'org_acme', name: 'Acme', slug: 'acme' },
  ceo: { username: 'ceo', name: 'CEO', phone: '13800138000' },
  defaultDepartmentName: '管理层',
  modules: ['enterprise', 'knowledge'],
};

function license(
  overrides: Partial<DeploymentLicenseView> = {},
): DeploymentLicenseView {
  return {
    id: 'lic_test',
    revision: 1,
    deploymentId: 'dep_test',
    organizationId: 'org_acme',
    machineFingerprint: 'a'.repeat(64),
    customerName: 'Acme',
    plan: 'enterprise',
    expiresAt: '2027-01-01T00:00:00.000Z',
    seatLimit: 100,
    gracePeriodMs: 0,
    seatEnforcement: 'enforce',
    billingEnforcement: 'disabled',
    activeSeatCount: 0,
    seatLimitExceeded: false,
    modules: ['enterprise', 'knowledge'],
    offline: false,
    telemetryAllowed: true,
    signatureAlgorithm: 'ed25519',
    signingKeyId: 'key_test',
    lease: {
      required: false,
      status: 'not_required',
      endpoint: null,
      expiresAt: null,
      lastRefreshAt: null,
      lastError: null,
      activeSeatCount: null,
      seatStatus: null,
      graceReasons: [],
      graceExpiresAt: null,
    },
    status: 'active',
    enforce: true,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function command(
  overrides: Partial<ControlCommandEnvelope> = {},
): ControlCommandEnvelope {
  return {
    commandId: 'cmd_test',
    deploymentId: 'dep_test',
    type: 'enterprise.initiate',
    schemaVersion: 1,
    sequence: 1,
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2027-01-01T00:00:00.000Z',
    idempotencyKey: 'bootstrap-enterprise:enroll_test',
    payloadDigest: payloadDigest(payload),
    payload,
    signature: 'ed25519:test',
    ...overrides,
  };
}

describe('enterprise.initiate command executor', () => {
  it('provisions only after the current License and payload agree', () => {
    const provision = vi.fn(() => ({
      deploymentId: 'dep_test',
      commandId: 'cmd_test',
      idempotencyKey: 'bootstrap-enterprise:enroll_test',
      organizationId: 'org_acme',
      ceoAccountId: 'acc_ceo',
      defaultDepartmentId: 'dept_management',
      ceoPositionId: 'pos_ceo',
      replayed: false,
    }));
    const execute = createEnterpriseInitiationCommandExecutor({
      getDeploymentLicense: () => license(),
      provision,
    });

    expect(execute(command())).toEqual({
      status: 'succeeded',
      resultSummary: 'enterprise provisioned',
      resourceId: 'org_acme',
    });
    expect(provision).toHaveBeenCalledWith(
      expect.objectContaining({
        deploymentId: 'dep_test',
        organization: expect.objectContaining({ id: 'org_acme' }),
        ceo: expect.objectContaining({ phone: '+8613800138000' }),
      }),
    );
  });

  it.each([
    ['missing_idempotency_key', command({ idempotencyKey: undefined })],
    ['invalid_payload', command({ payload: { ...payload, injected: true } })],
  ])('rejects %s before provisioning', (category, envelope) => {
    const provision = vi.fn();
    const execute = createEnterpriseInitiationCommandExecutor({
      getDeploymentLicense: () => license(),
      provision,
    });
    expect(execute(envelope)).toMatchObject({
      status: 'failed',
      errorCategory: category,
    });
    expect(provision).not.toHaveBeenCalled();
  });

  it.each([
    ['license_deployment_mismatch', license({ deploymentId: 'dep_other' })],
    ['license_organization_mismatch', license({ organizationId: 'org_other' })],
    ['module_not_licensed', license({ modules: ['enterprise'] })],
    ['license_unavailable', license({ status: 'expired' })],
  ])('fails closed with %s when runtime License changed', (category, view) => {
    const provision = vi.fn();
    const execute = createEnterpriseInitiationCommandExecutor({
      getDeploymentLicense: () => view,
      provision,
    });
    expect(execute(command())).toMatchObject({
      status: 'failed',
      errorCategory: category,
    });
    expect(provision).not.toHaveBeenCalled();
  });

  it('redacts repository failures from the signed receipt', () => {
    const execute = createEnterpriseInitiationCommandExecutor({
      getDeploymentLicense: () => license(),
      provision: () => {
        throw new Error(
          'UNIQUE constraint failed: accounts.phone +8613800138000',
        );
      },
    });
    expect(execute(command())).toEqual({
      status: 'failed',
      errorCategory: 'provisioning_failed',
      resultSummary: 'enterprise provisioning failed',
    });
  });
});
