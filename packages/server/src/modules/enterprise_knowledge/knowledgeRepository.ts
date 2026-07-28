/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { Database } from '../data_platform/index.js';

export const ENTERPRISE_KNOWLEDGE_MAX_DEPARTMENT_LENGTH = 120;
export const ENTERPRISE_KNOWLEDGE_MAX_CATEGORY_LENGTH = 120;
export const ENTERPRISE_KNOWLEDGE_MAX_CONTENT_LENGTH = 200_000;
export const ENTERPRISE_KNOWLEDGE_MAX_CONTRIBUTOR_LENGTH = 160;
export const ENTERPRISE_KNOWLEDGE_MAX_SOURCE_ID_LENGTH = 200;
export const ENTERPRISE_KNOWLEDGE_MAX_QUERY_LENGTH = 500;

export interface EnterpriseKnowledgeEntryView {
  id: number;
  organization_id: string;
  source_id: string | null;
  department: string | null;
  category: string;
  content: string;
  contributor: string | null;
  confidence: number;
  created_at: string;
  updated_at: string;
}

export interface EnterpriseKnowledgeRepositoryStore {
  db(): Database;
  defaultOrganizationId: string;
  organizationExists(organizationId: string): boolean;
}

export interface AddEnterpriseKnowledgeInput {
  department?: string;
  category: string;
  content: string;
  contributor?: string;
  confidence?: number;
  organizationId?: string;
  sourceId?: string;
}

function requireOrganization(
  store: EnterpriseKnowledgeRepositoryStore,
  value?: string,
): string {
  const organizationId = value?.trim() || store.defaultOrganizationId;
  if (!organizationId || !store.organizationExists(organizationId)) {
    throw new Error('Organization not found');
  }
  return organizationId;
}

function normalizeRequiredText(
  value: unknown,
  maximum: number,
  field: string,
): string {
  if (typeof value !== 'string') throw new Error(`${field} is required`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required`);
  if (normalized.length > maximum) throw new Error(`${field} is too long`);
  return normalized;
}

function normalizeOptionalText(
  value: unknown,
  maximum: number,
  field: string,
): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') throw new Error(`${field} is invalid`);
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maximum) throw new Error(`${field} is too long`);
  return normalized;
}

function normalizeConfidence(value: number | undefined): number {
  if (value === undefined) return 0.5;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('knowledge confidence must be between 0 and 1');
  }
  return value;
}

function escapeLikeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

export function addEnterpriseKnowledgeInRepository(
  store: EnterpriseKnowledgeRepositoryStore,
  input: AddEnterpriseKnowledgeInput,
): boolean {
  const organizationId = requireOrganization(store, input.organizationId);
  const department = normalizeOptionalText(
    input.department,
    ENTERPRISE_KNOWLEDGE_MAX_DEPARTMENT_LENGTH,
    'knowledge department',
  );
  const category = normalizeRequiredText(
    input.category,
    ENTERPRISE_KNOWLEDGE_MAX_CATEGORY_LENGTH,
    'knowledge category',
  );
  const content = normalizeRequiredText(
    input.content,
    ENTERPRISE_KNOWLEDGE_MAX_CONTENT_LENGTH,
    'knowledge content',
  );
  const contributor = normalizeOptionalText(
    input.contributor,
    ENTERPRISE_KNOWLEDGE_MAX_CONTRIBUTOR_LENGTH,
    'knowledge contributor',
  );
  const sourceId = normalizeOptionalText(
    input.sourceId,
    ENTERPRISE_KNOWLEDGE_MAX_SOURCE_ID_LENGTH,
    'knowledge source id',
  );
  const result = store
    .db()
    .prepare(
      `INSERT INTO knowledge
       (organization_id, source_id, department, category, content, contributor, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(organization_id, source_id) WHERE source_id IS NOT NULL DO NOTHING`,
    )
    .run(
      organizationId,
      sourceId,
      department,
      category,
      content,
      contributor,
      normalizeConfidence(input.confidence),
    ) as { changes?: number | bigint };
  return Number(result.changes ?? 0) > 0;
}

export function listEnterpriseKnowledgeFromRepository(
  store: EnterpriseKnowledgeRepositoryStore,
  department?: string,
  category?: string,
  organizationId?: string,
): EnterpriseKnowledgeEntryView[] {
  const normalizedOrganizationId = requireOrganization(store, organizationId);
  const normalizedDepartment = normalizeOptionalText(
    department,
    ENTERPRISE_KNOWLEDGE_MAX_DEPARTMENT_LENGTH,
    'knowledge department',
  );
  const normalizedCategory = normalizeOptionalText(
    category,
    ENTERPRISE_KNOWLEDGE_MAX_CATEGORY_LENGTH,
    'knowledge category',
  );
  let sql = 'SELECT * FROM knowledge WHERE organization_id = ?';
  const params: string[] = [normalizedOrganizationId];
  if (normalizedDepartment) {
    sql += ' AND department = ?';
    params.push(normalizedDepartment);
  }
  if (normalizedCategory) {
    sql += ' AND category = ?';
    params.push(normalizedCategory);
  }
  sql += ' ORDER BY created_at DESC, id DESC';
  return store
    .db()
    .prepare(sql)
    .all(...params) as EnterpriseKnowledgeEntryView[];
}

export function searchEnterpriseKnowledgeInRepository(
  store: EnterpriseKnowledgeRepositoryStore,
  query: string,
  department?: string,
  organizationId?: string,
): EnterpriseKnowledgeEntryView[] {
  const normalizedOrganizationId = requireOrganization(store, organizationId);
  const normalizedDepartment = normalizeOptionalText(
    department,
    ENTERPRISE_KNOWLEDGE_MAX_DEPARTMENT_LENGTH,
    'knowledge department',
  );
  const normalizedQuery = normalizeOptionalText(
    query,
    ENTERPRISE_KNOWLEDGE_MAX_QUERY_LENGTH,
    'knowledge query',
  );
  const pattern = `%${escapeLikeLiteral(normalizedQuery ?? '')}%`;
  let sql = `SELECT * FROM knowledge
    WHERE organization_id = ?
      AND (content LIKE ? ESCAPE '\\' OR category LIKE ? ESCAPE '\\')`;
  const params: Array<string | number> = [
    normalizedOrganizationId,
    pattern,
    pattern,
  ];
  if (normalizedDepartment) {
    sql += ' AND department = ?';
    params.push(normalizedDepartment);
  }
  sql += ' ORDER BY confidence DESC, created_at DESC, id DESC LIMIT 20';
  return store
    .db()
    .prepare(sql)
    .all(...params) as EnterpriseKnowledgeEntryView[];
}

export function listMemberEnterpriseKnowledgeFromRepository(
  store: EnterpriseKnowledgeRepositoryStore,
  memberDepartment: string | null | undefined,
  query = '',
  organizationId?: string,
): EnterpriseKnowledgeEntryView[] {
  const normalizedOrganizationId = requireOrganization(store, organizationId);
  const department = normalizeOptionalText(
    memberDepartment,
    ENTERPRISE_KNOWLEDGE_MAX_DEPARTMENT_LENGTH,
    'member department',
  );
  const normalizedQuery = normalizeOptionalText(
    query,
    ENTERPRISE_KNOWLEDGE_MAX_QUERY_LENGTH,
    'knowledge query',
  );
  let sql = 'SELECT * FROM knowledge WHERE organization_id = ?';
  const params: Array<string | number> = [normalizedOrganizationId];
  if (department) {
    sql += ' AND (department IS NULL OR department = ?)';
    params.push(department);
  } else {
    sql += ' AND department IS NULL';
  }
  if (normalizedQuery) {
    const pattern = `%${escapeLikeLiteral(normalizedQuery)}%`;
    sql += ` AND (content LIKE ? ESCAPE '\\' OR category LIKE ? ESCAPE '\\')`;
    params.push(pattern, pattern);
    sql += ' ORDER BY confidence DESC, created_at DESC, id DESC LIMIT 20';
  } else {
    sql += ' ORDER BY created_at DESC, id DESC';
  }
  return store
    .db()
    .prepare(sql)
    .all(...params) as EnterpriseKnowledgeEntryView[];
}
