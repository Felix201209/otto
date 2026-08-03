/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { Database } from '../data_platform/index.js';

export interface OrganizationDirectoryView {
  id: string;
  name: string;
  slug: string;
  parkId: string | null;
  parkAddress?: string | null;
  parkRoomNumber?: string | null;
  industry?: string | null;
  status: 'active' | 'disabled';
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationDirectoryRow {
  id: string;
  name: string;
  slug: string;
  invite_secret: string;
  park_id?: string | null;
  industry?: string | null;
  park_address?: string | null;
  park_room_number?: string | null;
  status: 'active' | 'disabled';
  created_at: string;
  updated_at: string;
}

export interface OrganizationDirectoryRepositoryStore {
  db(): Database;
}

export function toOrganizationDirectoryView(
  row: OrganizationDirectoryRow,
): OrganizationDirectoryView {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    parkId: row.park_id ?? null,
    parkAddress: row.park_address ?? null,
    parkRoomNumber: row.park_room_number ?? null,
    industry: row.industry ?? null,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getOrganizationFromDirectory(
  store: OrganizationDirectoryRepositoryStore,
  id: string,
): OrganizationDirectoryView | null {
  const row = store
    .db()
    .prepare('SELECT * FROM organizations WHERE id = ?')
    .get(id) as OrganizationDirectoryRow | undefined;
  return row ? toOrganizationDirectoryView(row) : null;
}

export function listOrganizationsFromDirectory(
  store: OrganizationDirectoryRepositoryStore,
): OrganizationDirectoryView[] {
  return (
    store
      .db()
      .prepare('SELECT * FROM organizations ORDER BY name, slug')
      .all() as OrganizationDirectoryRow[]
  ).map(toOrganizationDirectoryView);
}

export function getEnterpriseOrganizationFromDirectory(
  store: OrganizationDirectoryRepositoryStore,
  id: string,
): OrganizationDirectoryView | null {
  const row = store
    .db()
    .prepare(
      `SELECT o.*
       FROM organizations o
       WHERE o.id = ?
         AND EXISTS (
           SELECT 1
           FROM accounts a
           WHERE a.organization_id = o.id
             AND a.account_type = 'enterprise'
             AND a.deleted_at IS NULL
         )
       LIMIT 1`,
    )
    .get(id) as OrganizationDirectoryRow | undefined;
  return row ? toOrganizationDirectoryView(row) : null;
}

export function listEnterpriseOrganizationsFromDirectory(
  store: OrganizationDirectoryRepositoryStore,
): OrganizationDirectoryView[] {
  return (
    store
      .db()
      .prepare(
        `SELECT o.*
         FROM organizations o
         WHERE EXISTS (
           SELECT 1
           FROM accounts a
           WHERE a.organization_id = o.id
             AND a.account_type = 'enterprise'
             AND a.deleted_at IS NULL
         )
         ORDER BY o.name, o.slug`,
      )
      .all() as OrganizationDirectoryRow[]
  ).map(toOrganizationDirectoryView);
}
