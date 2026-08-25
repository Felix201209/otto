/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { Database } from '../data_platform/index.js';
import type {
  AccountLifecycleView,
  CreateAccountInput,
} from './accountLifecycleRepository.js';
import type {
  CreateOrganizationInput,
  OrganizationProvisioningOrganizationView,
} from './organizationProvisioningRepository.js';
import {
  normalizeAssignmentName,
  stableAssignmentId,
} from './organizationStructureRepository.js';

const CEO_POSITION_TITLE = 'CEO';

export interface BootstrapEnterpriseProvisioningInput {
  deploymentId: string;
  commandId: string;
  idempotencyKey: string;
  payloadDigest: string;
  organization: {
    id: string;
    name: string;
    slug?: string;
  };
  ceo: {
    username: string;
    name: string;
    phone: string;
  };
  defaultDepartmentName: string;
}

export interface BootstrapEnterpriseProvisioningResult {
  deploymentId: string;
  commandId: string;
  idempotencyKey: string;
  organizationId: string;
  ceoAccountId: string;
  defaultDepartmentId: string;
  ceoPositionId: string;
  replayed: boolean;
}

interface BootstrapProvisioningRow {
  deployment_id: string;
  command_id: string;
  idempotency_key: string;
  payload_digest: string;
  organization_id: string;
  ceo_account_id: string;
  default_department_id: string;
  ceo_position_id: string;
}

export interface OrganizationBootstrapProvisioningStore<
  TOrganizationView extends OrganizationProvisioningOrganizationView,
  TAccountView extends AccountLifecycleView,
  TInviteView,
> {
  db(): Database;
  createOrganization(input: CreateOrganizationInput): TOrganizationView;
  createAccount(input: CreateAccountInput): TAccountView;
  issueOrganizationInvite(
    organizationId: string,
    now: number,
    createdByAccountId: string,
  ): TInviteView;
  createUnknownPassword(): string;
  now(): number;
}

function toResult(
  row: BootstrapProvisioningRow,
  replayed: boolean,
): BootstrapEnterpriseProvisioningResult {
  return {
    deploymentId: row.deployment_id,
    commandId: row.command_id,
    idempotencyKey: row.idempotency_key,
    organizationId: row.organization_id,
    ceoAccountId: row.ceo_account_id,
    defaultDepartmentId: row.default_department_id,
    ceoPositionId: row.ceo_position_id,
    replayed,
  };
}

function assertProvisionedResourcesExist(
  database: Database,
  row: BootstrapProvisioningRow,
): void {
  const resources = database
    .prepare(
      `SELECT
         EXISTS(SELECT 1 FROM organizations WHERE id = ?) AS organization_exists,
         EXISTS(SELECT 1 FROM accounts WHERE id = ? AND organization_id = ?
           AND deleted_at IS NULL) AS account_exists,
         EXISTS(SELECT 1 FROM organization_departments WHERE id = ?
           AND organization_id = ?) AS department_exists,
         EXISTS(SELECT 1 FROM organization_positions WHERE id = ?
           AND organization_id = ?) AS position_exists`,
    )
    .get(
      row.organization_id,
      row.ceo_account_id,
      row.organization_id,
      row.default_department_id,
      row.organization_id,
      row.ceo_position_id,
      row.organization_id,
    ) as {
    organization_exists: number;
    account_exists: number;
    department_exists: number;
    position_exists: number;
  };
  if (
    resources.organization_exists !== 1 ||
    resources.account_exists !== 1 ||
    resources.department_exists !== 1 ||
    resources.position_exists !== 1
  ) {
    throw new Error('existing enterprise provisioning result is incomplete');
  }
}

/**
 * Atomically creates the tenant identity root used by the real organization
 * tree. No password, invite code, or other reusable secret is returned.
 */
export function provisionBootstrapEnterpriseInRepository<
  TOrganizationView extends OrganizationProvisioningOrganizationView,
  TAccountView extends AccountLifecycleView,
  TInviteView,
>(
  store: OrganizationBootstrapProvisioningStore<
    TOrganizationView,
    TAccountView,
    TInviteView
  >,
  input: BootstrapEnterpriseProvisioningInput,
): BootstrapEnterpriseProvisioningResult {
  const database = store.db();
  database.exec('BEGIN IMMEDIATE');
  try {
    const existing = database
      .prepare(
        `SELECT deployment_id, command_id, idempotency_key, payload_digest,
                organization_id, ceo_account_id, default_department_id,
                ceo_position_id
         FROM organization_bootstrap_provisioning
         WHERE deployment_id = ? AND idempotency_key = ?`,
      )
      .get(input.deploymentId, input.idempotencyKey) as
      BootstrapProvisioningRow | undefined;
    if (existing) {
      if (existing.payload_digest !== input.payloadDigest) {
        throw new Error('idempotency key was reused with a different payload');
      }
      assertProvisionedResourcesExist(database, existing);
      database.exec('COMMIT');
      return toResult(existing, true);
    }

    const organization = store.createOrganization({
      id: input.organization.id,
      name: input.organization.name,
      slug: input.organization.slug,
    });
    const departmentName = input.defaultDepartmentName.trim();
    if (!departmentName || departmentName.length > 80) {
      throw new Error('默认部门名称不能为空且不能超过 80 个字符');
    }
    const normalizedDepartment = normalizeAssignmentName(departmentName);
    const departmentId = stableAssignmentId(
      'dept',
      organization.id,
      normalizedDepartment,
    );
    const ceoPositionId = stableAssignmentId(
      'pos',
      organization.id,
      departmentId,
      normalizeAssignmentName(CEO_POSITION_TITLE),
    );
    database
      .prepare(
        `INSERT INTO organization_departments
          (id, organization_id, name, parent_department_id)
         VALUES (?, ?, ?, NULL)`,
      )
      .run(departmentId, organization.id, departmentName);
    database
      .prepare(
        `INSERT INTO organization_positions
          (id, organization_id, department_id, title, role_mapping)
         VALUES (?, ?, ?, ?, 'enterprise_admin')`,
      )
      .run(ceoPositionId, organization.id, departmentId, CEO_POSITION_TITLE);

    const ceo = store.createAccount({
      organizationId: organization.id,
      username: input.ceo.username,
      password: store.createUnknownPassword(),
      name: input.ceo.name,
      phone: input.ceo.phone,
      department: departmentName,
      departmentId,
      positionId: ceoPositionId,
      positionTitle: CEO_POSITION_TITLE,
      role: '企业管理员',
      tags: ['CEO', '企业管理员'],
      isAdmin: true,
    });
    store.issueOrganizationInvite(organization.id, store.now(), ceo.id);

    database
      .prepare(
        `INSERT INTO organization_bootstrap_provisioning
          (deployment_id, idempotency_key, command_id, payload_digest,
           organization_id, ceo_account_id, default_department_id,
           ceo_position_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.deploymentId,
        input.idempotencyKey,
        input.commandId,
        input.payloadDigest,
        organization.id,
        ceo.id,
        departmentId,
        ceoPositionId,
      );

    database.exec('COMMIT');
    return {
      deploymentId: input.deploymentId,
      commandId: input.commandId,
      idempotencyKey: input.idempotencyKey,
      organizationId: organization.id,
      ceoAccountId: ceo.id,
      defaultDepartmentId: departmentId,
      ceoPositionId,
      replayed: false,
    };
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
/** True only when a Control-provisioned non-default tenant and CEO still exist. */
export function hasBootstrapEnterpriseIdentityInRepository(
  database: Database,
  deploymentId: string,
  organizationId?: string | null,
): boolean {
  const row = database
    .prepare(
      `SELECT 1 AS ready
       FROM organization_bootstrap_provisioning provisioning
       JOIN organizations organization
         ON organization.id = provisioning.organization_id
        AND organization.status = 'active'
       JOIN accounts account
         ON account.id = provisioning.ceo_account_id
        AND account.organization_id = provisioning.organization_id
        AND account.deleted_at IS NULL
        AND account.status = 'active'
        AND account.is_admin = 1
       JOIN organization_departments department
         ON department.id = provisioning.default_department_id
        AND department.organization_id = provisioning.organization_id
       JOIN organization_positions position
         ON position.id = provisioning.ceo_position_id
        AND position.organization_id = provisioning.organization_id
        AND position.role_mapping = 'enterprise_admin'
       WHERE provisioning.deployment_id = ?
         AND (? IS NULL OR provisioning.organization_id = ?)
       LIMIT 1`,
    )
    .get(deploymentId, organizationId ?? null, organizationId ?? null) as
    { ready: number } | undefined;
  return row?.ready === 1;
}
