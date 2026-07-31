/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import {
  saveEnterpriseKnowledgeInRepository,
  type EnterpriseKnowledgeEntryView,
  type EnterpriseKnowledgeRepositoryStore,
} from './knowledgeRepository.js';
import {
  decideEnterpriseKnowledgeRetention,
  enterpriseKnowledgeObservationSimilarity,
  enterpriseKnowledgeRetentionReasonLabel,
  normalizeEnterpriseKnowledgeAtom,
  scoreEnterpriseKnowledgeImpact,
  type EnterpriseKnowledgeRetentionReason,
} from './knowledgeRetentionPolicy.js';

export interface ObserveEnterpriseKnowledgeInput {
  organizationId: string;
  department?: string | null;
  category: string;
  content: string;
  tags?: string[];
  contributor?: string;
  contributorAccountId: string;
  sourceId: string;
  sourceSessionId: string;
  sourceFingerprint?: string;
  confidence: number;
  verified?: boolean;
  impactScore?: number;
  significanceSignals?: string[];
  observedAt?: string;
}

export interface ObserveEnterpriseKnowledgeResult {
  outcome: 'observed' | 'duplicate' | 'promoted';
  promoted: boolean;
  reason: EnterpriseKnowledgeRetentionReason;
  evidenceCount: number;
  distinctSessionCount: number;
  distinctContributorCount: number;
  spanDays: number;
  impactScore: number;
  knowledge: EnterpriseKnowledgeEntryView | null;
}

interface EvidenceRow {
  topic_id: string;
  content: string;
  source_fingerprint: string;
}

interface EvidenceAggregateRow {
  evidence_count: number;
  distinct_session_count: number;
  distinct_contributor_count: number;
  span_days: number;
  average_confidence: number;
  maximum_impact_score: number;
  has_verified_evidence: number;
  promoted_knowledge_id: number | null;
}

interface RepresentativeRow {
  content: string;
  contributor: string | null;
  contributor_account_id: string;
  confidence: number;
}

const MAX_ATOM_LENGTH = 900;
const MAX_SOURCE_LENGTH = 200;
const MAX_CATEGORY_LENGTH = 120;
const MAX_DEPARTMENT_LENGTH = 120;

function required(value: unknown, maximum: number, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  const normalized = value.trim();
  if (normalized.length > maximum) throw new Error(`${label} is too long`);
  return normalized;
}

function optional(value: unknown, maximum: number, label: string): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw new Error(`${label} is invalid`);
  const normalized = value.trim();
  if (normalized.length > maximum) throw new Error(`${label} is too long`);
  return normalized || null;
}

function safeJsonStrings(value: unknown, maximumItems: number, maximumLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().slice(0, maximumLength))
    .filter(Boolean)
    .slice(0, maximumItems);
}

function digest(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex');
}

function runTransaction<T>(store: EnterpriseKnowledgeRepositoryStore, operation: () => T): T {
  const database = store.db();
  const owns = !database.inTransaction;
  if (owns) database.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    if (owns) database.exec('COMMIT');
    return result;
  } catch (error) {
    if (owns && database.inTransaction) database.exec('ROLLBACK');
    throw error;
  }
}

function retentionTitle(content: string, category: string): string {
  return (content.split(/\r?\n|(?<=[。！？!?])/u).find((item) => item.trim()) || category)
    .trim()
    .slice(0, 160);
}

export function observeEnterpriseKnowledgeInRepository(
  store: EnterpriseKnowledgeRepositoryStore,
  input: ObserveEnterpriseKnowledgeInput,
): ObserveEnterpriseKnowledgeResult {
  const organizationId = required(input.organizationId, 160, 'organization id');
  if (!store.organizationExists(organizationId)) throw new Error('Organization not found');
  const department = optional(input.department, MAX_DEPARTMENT_LENGTH, 'knowledge department');
  const category = required(input.category, MAX_CATEGORY_LENGTH, 'knowledge category');
  const atom = normalizeEnterpriseKnowledgeAtom(
    required(input.content, 20_000, 'knowledge observation content'),
  ).slice(0, MAX_ATOM_LENGTH);
  if (atom.length < 12) throw new Error('knowledge observation is too short');
  const contributorAccountId = required(input.contributorAccountId, 200, 'contributor account id');
  const contributor = optional(input.contributor, 160, 'knowledge contributor');
  const sourceId = required(input.sourceId, MAX_SOURCE_LENGTH, 'knowledge source id');
  const sourceSessionId = required(input.sourceSessionId, MAX_SOURCE_LENGTH, 'knowledge source session id');
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    throw new Error('knowledge confidence must be between 0 and 1');
  }
  const tags = safeJsonStrings(input.tags, 8, 40);
  const clientSignals = safeJsonStrings(input.significanceSignals, 8, 80);
  const sourceFingerprint = optional(
    input.sourceFingerprint,
    128,
    'knowledge source fingerprint',
  ) ?? digest(atom).slice(0, 32);
  const observedDate = input.observedAt ? new Date(input.observedAt) : new Date();
  const observedAt = Number.isFinite(observedDate.getTime())
    ? observedDate.toISOString()
    : new Date().toISOString();
  const verified = input.verified === true;
  const impact = scoreEnterpriseKnowledgeImpact({
    category,
    content: atom,
    confidence: input.confidence,
    verified,
    clientImpactScore: input.impactScore,
    clientSignals,
  });
  const database = store.db();

  return runTransaction(store, () => {
    database.prepare(
      `DELETE FROM knowledge_retention_evidence
       WHERE promoted_knowledge_id IS NULL
         AND datetime(created_at) < datetime('now', '-180 days')`,
    ).run();
    const candidates = database.prepare(
      `SELECT topic_id, content, source_fingerprint
       FROM knowledge_retention_evidence
       WHERE organization_id = ? AND category = ?
         AND COALESCE(department, '') = COALESCE(?, '')
         AND datetime(created_at) >= datetime('now', '-180 days')
       ORDER BY datetime(created_at) DESC LIMIT 300`,
    ).all(organizationId, category, department) as EvidenceRow[];
    let topicId = '';
    let bestSimilarity = 0;
    for (const candidate of candidates) {
      const similarity = candidate.source_fingerprint === sourceFingerprint
        ? 1
        : enterpriseKnowledgeObservationSimilarity(atom, candidate.content);
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        topicId = candidate.topic_id;
      }
    }
    if (!topicId || bestSimilarity < 0.46) {
      topicId = `topic_${digest(organizationId, department ?? '', category, atom).slice(0, 24)}`;
    }
    const evidenceKey = digest(
      organizationId,
      contributorAccountId,
      sourceSessionId,
      sourceFingerprint,
    );
    const inserted = database.prepare(
      `INSERT OR IGNORE INTO knowledge_retention_evidence
       (organization_id, topic_id, evidence_key, source_id, source_session_id,
        source_fingerprint, department, category, content, tags_json, contributor,
        contributor_account_id, confidence, verified, impact_score,
        impact_reasons_json, observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      organizationId,
      topicId,
      evidenceKey,
      sourceId,
      sourceSessionId,
      sourceFingerprint,
      department,
      category,
      atom,
      JSON.stringify(tags),
      contributor,
      contributorAccountId,
      input.confidence,
      verified ? 1 : 0,
      impact.score,
      JSON.stringify(impact.reasons),
      observedAt,
    );
    const aggregate = database.prepare(
      `SELECT COUNT(*) AS evidence_count,
          COUNT(DISTINCT contributor_account_id || ':' || source_session_id) AS distinct_session_count,
          COUNT(DISTINCT contributor_account_id) AS distinct_contributor_count,
          COALESCE(julianday(MAX(created_at)) - julianday(MIN(created_at)), 0) AS span_days,
          AVG(confidence) AS average_confidence,
          MAX(impact_score) AS maximum_impact_score,
          MAX(verified) AS has_verified_evidence,
          MAX(promoted_knowledge_id) AS promoted_knowledge_id
       FROM knowledge_retention_evidence
       WHERE organization_id = ? AND topic_id = ?`,
    ).get(organizationId, topicId) as EvidenceAggregateRow;
    const summary = {
      evidenceCount: Number(aggregate.evidence_count || 0),
      distinctSessionCount: Number(aggregate.distinct_session_count || 0),
      distinctContributorCount: Number(aggregate.distinct_contributor_count || 0),
      spanDays: Number(aggregate.span_days || 0),
      averageConfidence: Number(aggregate.average_confidence || 0),
      maximumImpactScore: Number(aggregate.maximum_impact_score || 0),
      hasVerifiedEvidence: Number(aggregate.has_verified_evidence || 0) === 1,
    };
    const decision = decideEnterpriseKnowledgeRetention({
      category,
      content: atom,
      confidence: input.confidence,
      verified,
      clientImpactScore: input.impactScore,
      clientSignals,
    }, summary);
    if (!decision.promote || aggregate.promoted_knowledge_id) {
      return {
        outcome: Number(inserted.changes) > 0 ? 'observed' : 'duplicate',
        promoted: Boolean(aggregate.promoted_knowledge_id),
        reason: aggregate.promoted_knowledge_id ? decision.reason : 'incubating',
        ...summary,
        impactScore: decision.impactScore,
        knowledge: aggregate.promoted_knowledge_id
          ? database.prepare('SELECT * FROM knowledge WHERE id = ? AND organization_id = ?')
            .get(aggregate.promoted_knowledge_id, organizationId) as EnterpriseKnowledgeEntryView
          : null,
      };
    }
    const representative = database.prepare(
      `SELECT content, contributor, contributor_account_id, confidence
       FROM knowledge_retention_evidence
       WHERE organization_id = ? AND topic_id = ?
       ORDER BY impact_score DESC, confidence DESC, datetime(created_at) DESC LIMIT 1`,
    ).get(organizationId, topicId) as RepresentativeRow;
    const reasonLabel = enterpriseKnowledgeRetentionReasonLabel(decision.reason);
    const saved = saveEnterpriseKnowledgeInRepository(store, {
      organizationId,
      sourceId: `retention:${topicId}`.slice(0, MAX_SOURCE_LENGTH),
      department: department ?? undefined,
      title: retentionTitle(representative.content, category),
      category,
      content: representative.content,
      contributor: representative.contributor ?? contributor ?? undefined,
      contributorAccountId: representative.contributor_account_id,
      confidence: Math.max(representative.confidence, summary.averageConfidence),
      sourceType: 'auto_capture',
      sourceLabel: `${reasonLabel}；${summary.evidenceCount} 条证据，${summary.distinctSessionCount} 个独立会话，${summary.distinctContributorCount} 名贡献者`,
      status: 'pending_review',
    });
    database.prepare(
      `UPDATE knowledge_retention_evidence SET promoted_knowledge_id = ?
       WHERE organization_id = ? AND topic_id = ?`,
    ).run(saved.entry.id, organizationId, topicId);
    return {
      outcome: 'promoted',
      promoted: true,
      reason: decision.reason,
      ...summary,
      impactScore: decision.impactScore,
      knowledge: saved.entry,
    };
  });
}
