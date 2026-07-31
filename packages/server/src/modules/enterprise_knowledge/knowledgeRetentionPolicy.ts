/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

export type EnterpriseKnowledgeRetentionReason =
  | 'incubating'
  | 'long_term_recurrence'
  | 'cross_member_corroboration'
  | 'high_impact_verified';

export interface EnterpriseKnowledgeObservationSignals {
  category: string;
  content: string;
  confidence: number;
  verified: boolean;
  clientImpactScore?: number;
  clientSignals?: string[];
}

export interface EnterpriseKnowledgeEvidenceSummary {
  evidenceCount: number;
  distinctSessionCount: number;
  distinctContributorCount: number;
  spanDays: number;
  averageConfidence: number;
  maximumImpactScore: number;
  hasVerifiedEvidence: boolean;
}

export interface EnterpriseKnowledgeRetentionDecision {
  promote: boolean;
  reason: EnterpriseKnowledgeRetentionReason;
  impactScore: number;
  reasons: string[];
}

const FINAL_DECISION = /(?:最终决定|正式采用|正式确定|拍板|统一规定|公司规定|制度要求|必须|禁止|不得|标准流程)/iu;
const VERIFIED_RESULT = /(?:已修复|已解决|验证通过|测试通过|验收通过|确认有效|已恢复|已上线|已经生效|fixed|resolved|verified|tests? passed)/iu;
const HIGH_IMPACT = /(?:重大|宕机|事故|数据丢失|安全|合规|法律|合同|客户投诉|金额|成本|收入|损失|生产环境|sla)/iu;
const SPECULATIVE = /(?:可能|也许|或许|猜测|不确定|暂时认为|尚未验证|待确认|maybe|perhaps|unverified)/iu;
const TRANSCRIPT_NOISE = /^(?:用户|助手|assistant|user|system)\s*[:：]/iu;

function cleanSegment(segment: string): string {
  return segment
    .replace(TRANSCRIPT_NOISE, '')
    .replace(/^\s*[#>*-]+\s*/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * Convert a possible answer transcript into one reusable knowledge atom.
 * It intentionally preserves conclusions, conditions and validation while
 * dropping speaker turns, large code blocks and explanatory repetition.
 */
export function normalizeEnterpriseKnowledgeAtom(content: string): string {
  const withoutCode = String(content ?? '').replace(/```[\s\S]*?```/gu, ' [代码细节已省略] ');
  const segments = withoutCode
    .split(/\r?\n+|(?<=[。！？!?；;])/u)
    .map(cleanSegment)
    .filter((segment) => segment.length >= 8);
  const priorities = [FINAL_DECISION, /(?:根因|原因|问题在于|由于)/iu, /(?:解决|修复|改为|流程|方案)/iu, VERIFIED_RESULT, /(?:适用|前提|条件|仅当|除非)/iu];
  const selected: string[] = [];
  for (const priority of priorities) {
    const match = segments.find((segment) => priority.test(segment));
    if (match && !selected.includes(match)) selected.push(match);
    if (selected.length >= 3) break;
  }
  for (const segment of segments) {
    if (selected.length >= 3) break;
    if (!selected.includes(segment)) selected.push(segment);
  }
  return selected.join('\n').slice(0, 900).trim();
}

function tokenSet(value: string): Set<string> {
  const normalized = value
    .toLowerCase()
    .replace(/\bkey\b/gu, '键')
    .replace(/租户/gu, '企业')
    .replace(/增加|添加/gu, '加入')
    .replace(/[^\p{L}\p{N}]+/gu, '');
  const result = new Set<string>();
  for (const match of value.toLowerCase().matchAll(/[a-z0-9][a-z0-9_-]{1,}/gu)) {
    result.add(match[0]);
  }
  for (let index = 0; index < normalized.length - 1; index += 1) {
    result.add(normalized.slice(index, index + 2));
  }
  return result;
}

/** Similarity for clustering paraphrased observations within one category. */
export function enterpriseKnowledgeObservationSimilarity(left: string, right: string): number {
  const a = tokenSet(left);
  const b = tokenSet(right);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  const jaccard = intersection / (a.size + b.size - intersection);
  const containment = intersection / Math.min(a.size, b.size);
  return (jaccard * 0.35) + (containment * 0.65);
}

export function scoreEnterpriseKnowledgeImpact(
  input: EnterpriseKnowledgeObservationSignals,
): { score: number; reasons: string[] } {
  const atom = normalizeEnterpriseKnowledgeAtom(input.content);
  const reasons: string[] = [];
  let score = 0.25 + Math.min(0.25, Math.max(0, input.confidence) * 0.25);
  if (FINAL_DECISION.test(atom)) {
    score += 0.25;
    reasons.push('明确制度或最终决策');
  }
  if (VERIFIED_RESULT.test(atom) || input.verified) {
    score += 0.2;
    reasons.push('存在已验证结果');
  }
  if (HIGH_IMPACT.test(atom)) {
    score += 0.2;
    reasons.push('涉及高影响业务');
  }
  if (SPECULATIVE.test(atom)) {
    score -= 0.35;
    reasons.push('包含未确认表述');
  }
  if (input.category === 'preference') {
    score = Math.min(score, 0.45);
    reasons.push('个人偏好不直接上升为企业事实');
  }
  const clientScore = Number.isFinite(input.clientImpactScore)
    ? Math.min(1, Math.max(0, input.clientImpactScore ?? 0))
    : 0;
  if (clientScore >= 0.8 && (input.clientSignals?.length ?? 0) > 0) {
    score += 0.05;
  }
  return { score: Math.min(1, Math.max(0, score)), reasons };
}

export function decideEnterpriseKnowledgeRetention(
  current: EnterpriseKnowledgeObservationSignals,
  summary: EnterpriseKnowledgeEvidenceSummary,
): EnterpriseKnowledgeRetentionDecision {
  const impact = scoreEnterpriseKnowledgeImpact(current);
  const eligibleCategory = current.category === 'decision'
    || current.category === 'solution'
    || current.category === 'convention';
  const hasExplainableValidation = VERIFIED_RESULT.test(current.content)
    || FINAL_DECISION.test(current.content);
  if (
    eligibleCategory
    && impact.score >= 0.82
    && current.confidence >= 0.82
    && hasExplainableValidation
  ) {
    return {
      promote: true,
      reason: 'high_impact_verified',
      impactScore: impact.score,
      reasons: impact.reasons,
    };
  }
  if (
    current.category !== 'preference'
    && summary.evidenceCount >= 3
    && summary.distinctSessionCount >= 3
    && summary.spanDays >= 7
    && summary.averageConfidence >= 0.72
  ) {
    return {
      promote: true,
      reason: 'long_term_recurrence',
      impactScore: Math.max(impact.score, summary.maximumImpactScore),
      reasons: ['跨时间反复出现', ...impact.reasons],
    };
  }
  if (
    current.category !== 'preference'
    && summary.evidenceCount >= 3
    && summary.distinctSessionCount >= 3
    && summary.distinctContributorCount >= 2
    && summary.averageConfidence >= 0.75
  ) {
    return {
      promote: true,
      reason: 'cross_member_corroboration',
      impactScore: Math.max(impact.score, summary.maximumImpactScore),
      reasons: ['多名员工独立印证', ...impact.reasons],
    };
  }
  return {
    promote: false,
    reason: 'incubating',
    impactScore: impact.score,
    reasons: impact.reasons,
  };
}

export function enterpriseKnowledgeRetentionReasonLabel(
  reason: EnterpriseKnowledgeRetentionReason,
): string {
  if (reason === 'high_impact_verified') return '单次高影响且已有验证';
  if (reason === 'long_term_recurrence') return '跨时间反复出现';
  if (reason === 'cross_member_corroboration') return '多名员工独立印证';
  return '证据积累中';
}
