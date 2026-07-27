/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { Database } from '../data_platform/index.js';
import type {
  AccountLifecycleView,
  CreateAccountInput,
} from './accountLifecycleRepository.js';

export interface OrganizationProvisioningOrganizationView {
  id: string;
  name: string;
  slug: string;
  status: 'active' | 'disabled';
}

export interface CreateOrganizationInput {
  name: string;
  slug?: string;
  now?: number;
}

export interface ProvisionOrganizationInput {
  name: string;
  slug?: string;
  admin: {
    username: string;
    password: string;
    name: string;
    phone?: string | null;
  };
  now?: number;
}

export interface ProvisionedOrganization<
  TOrganizationView extends OrganizationProvisioningOrganizationView,
  TAccountView extends AccountLifecycleView,
  TInviteView,
> {
  organization: TOrganizationView;
  admin: TAccountView;
  invite: TInviteView;
}

export interface OrganizationProvisioningRepositoryStore<
  TOrganizationView extends OrganizationProvisioningOrganizationView,
  TAccountView extends AccountLifecycleView,
  TInviteView,
> {
  db(): Database;
  now(): number;
  createOrganizationId(): string;
  createInviteSecret(): string;
  createDefaultSlugSuffix(): string;
  getOrganization(id: string): TOrganizationView | null;
  createAccount(input: CreateAccountInput): TAccountView;
  issueOrganizationInvite(
    organizationId: string,
    now: number,
    createdByAccountId: string,
  ): TInviteView;
  logAudit(
    action: string,
    employeeId: string | null,
    detail: string,
    organizationId: string,
  ): void;
}

export function normalizeOrganizationSlug(input: string): string {
  const slug = input
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug || slug.length > 48) {
    throw new Error('企业标识只能使用字母、数字和连字符');
  }
  return slug;
}

export function createOrganizationInRepository<
  TOrganizationView extends OrganizationProvisioningOrganizationView,
  TAccountView extends AccountLifecycleView,
  TInviteView,
>(
  store: OrganizationProvisioningRepositoryStore<
    TOrganizationView,
    TAccountView,
    TInviteView
  >,
  input: CreateOrganizationInput,
): TOrganizationView {
  const name = input.name.trim();
  if (!name || name.length > 80) {
    throw new Error('企业名称不能为空且不能超过 80 个字符');
  }
  const slug = normalizeOrganizationSlug(
    input.slug || `company-${store.createDefaultSlugSuffix()}`,
  );
  const id = store.createOrganizationId();
  const database = store.db();
  database.exec('SAVEPOINT create_organization');
  try {
    database
      .prepare(
        `INSERT INTO organizations (id, name, slug, invite_secret)
         VALUES (?, ?, ?, ?)`,
      )
      .run(id, name, slug, store.createInviteSecret());
    store.logAudit(
      'organization_create',
      null,
      `Organization ${slug} created`,
      id,
    );
    const organization = store.getOrganization(id);
    if (!organization) throw new Error('企业创建失败');
    database.exec('RELEASE SAVEPOINT create_organization');
    return organization;
  } catch (error) {
    database.exec('ROLLBACK TO SAVEPOINT create_organization');
    database.exec('RELEASE SAVEPOINT create_organization');
    throw error;
  }
}

export function provisionOrganizationInRepository<
  TOrganizationView extends OrganizationProvisioningOrganizationView,
  TAccountView extends AccountLifecycleView,
  TInviteView,
>(
  store: OrganizationProvisioningRepositoryStore<
    TOrganizationView,
    TAccountView,
    TInviteView
  >,
  input: ProvisionOrganizationInput,
): ProvisionedOrganization<TOrganizationView, TAccountView, TInviteView> {
  const database = store.db();
  database.exec('BEGIN IMMEDIATE');
  try {
    const organization = createOrganizationInRepository(store, input);
    const admin = store.createAccount({
      organizationId: organization.id,
      username: input.admin.username,
      password: input.admin.password,
      name: input.admin.name,
      phone: input.admin.phone,
      role: '企业管理员',
      tags: ['企业管理员'],
      isAdmin: true,
    });
    const invite = store.issueOrganizationInvite(
      organization.id,
      input.now ?? store.now(),
      admin.id,
    );
    database.exec('COMMIT');
    return { organization, admin, invite };
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
