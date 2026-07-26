/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import { DEFAULT_ORGANIZATION_ID, getDB, getOrganization } from './db.js';

export function addKnowledge(k: {
  department?: string;
  category: string;
  content: string;
  contributor?: string;
  confidence?: number;
  organizationId?: string;
  sourceId?: string;
}): boolean {
  const organizationId = k.organizationId || DEFAULT_ORGANIZATION_ID;
  if (!getOrganization(organizationId))
    throw new Error('Organization not found');
  const result = getDB()
    .prepare(
      `INSERT INTO knowledge
       (organization_id, source_id, department, category, content, contributor, confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(organization_id, source_id) WHERE source_id IS NOT NULL DO NOTHING`,
    )
    .run(
      organizationId,
      k.sourceId || null,
      k.department || null,
      k.category,
      k.content,
      k.contributor || null,
      k.confidence ?? 0.5,
    ) as { changes?: number | bigint };
  return Number(result.changes ?? 0) > 0;
}

export function getKnowledge(
  department?: string,
  category?: string,
  organizationId = DEFAULT_ORGANIZATION_ID,
): any[] {
  let sql = 'SELECT * FROM knowledge WHERE organization_id = ?';
  const params: any[] = [organizationId];
  if (department) {
    sql += ' AND department = ?';
    params.push(department);
  }
  if (category) {
    sql += ' AND category = ?';
    params.push(category);
  }
  sql += ' ORDER BY created_at DESC';
  return getDB()
    .prepare(sql)
    .all(...params);
}

export function searchKnowledge(
  query: string,
  department?: string,
  organizationId = DEFAULT_ORGANIZATION_ID,
): any[] {
  // Match category too: task_type is often stored as category and would not
  // surface when the Chinese content lacks the literal task_type.
  let sql =
    'SELECT * FROM knowledge WHERE organization_id = ? AND (content LIKE ? OR category LIKE ?)';
  const params: any[] = [organizationId, `%${query}%`, `%${query}%`];
  if (department) {
    sql += ' AND department = ?';
    params.push(department);
  }
  sql += ' ORDER BY confidence DESC LIMIT 20';
  return getDB()
    .prepare(sql)
    .all(...params);
}

export function getMemberKnowledge(
  memberDepartment: string | null | undefined,
  query = '',
  organizationId = DEFAULT_ORGANIZATION_ID,
): any[] {
  const department = memberDepartment?.trim() || null;
  const cleanQuery = query.trim();
  let sql = 'SELECT * FROM knowledge WHERE organization_id = ?';
  const params: any[] = [organizationId];
  if (department) {
    sql += ' AND (department IS NULL OR department = ?)';
    params.push(department);
  } else {
    sql += ' AND department IS NULL';
  }
  if (cleanQuery) {
    sql += ' AND (content LIKE ? OR category LIKE ?)';
    params.push(`%${cleanQuery}%`, `%${cleanQuery}%`);
    sql += ' ORDER BY confidence DESC LIMIT 20';
  } else {
    sql += ' ORDER BY created_at DESC';
  }
  return getDB()
    .prepare(sql)
    .all(...params);
}
