/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { WorkLogEntry } from './workLog.js';
import { textSimilarity } from '../utils/topicSimilarity.js';

export interface AutoSkillQualityInput {
  name: string;
  description: string;
  triggerPatterns: string[];
  detectedPattern: string;
  occurrenceCount: number;
  sampleEntries: WorkLogEntry[];
  skillContent: string;
}

export interface ExistingSkillSummary {
  name: string;
  summary: string;
}

export interface AutoSkillQualityMetadata {
  qualityScore: number;
  confidence: number;
  evidence: string[];
  failureLessons: string[];
  rejectionReasons: string[];
}

function uniqueNonEmpty(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter(Boolean) as string[])];
}

function entryDate(entry: WorkLogEntry): string | null {
  const date = new Date(entry.timestamp);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function numberedStepCount(content: string): number {
  return content.match(/^\s*\d+[.)、]\s+\S+/gmu)?.length ?? 0;
}

function candidateSummary(candidate: AutoSkillQualityInput): string {
  return [
    candidate.name.replace(/^auto-/u, '').replace(/-/gu, ' '),
    candidate.description,
    candidate.detectedPattern,
    ...candidate.triggerPatterns,
  ].join(' ');
}

function normalizeSkillFragment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[，。、“”‘’：；！？,.:"'!?()[\]{}]/gu, '')
    .replace(/(?:复用|自动|用于|使用|的|与|和)/gu, '')
    .replace(/\s+/gu, '')
    .trim();
}

function candidateFragments(candidate: AutoSkillQualityInput): string[] {
  return uniqueNonEmpty([
    candidate.name.replace(/^auto-/u, '').replace(/-/gu, ' '),
    candidate.description,
    candidate.detectedPattern,
    ...candidate.triggerPatterns,
    candidateSummary(candidate),
  ].map(normalizeSkillFragment));
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 可解释的确定性质量门禁。LLM 可以提炼语义，但不能绕过证据要求。 */
export function assessAutoSkillCandidate(
  candidate: AutoSkillQualityInput,
): AutoSkillQualityMetadata {
  const dates = uniqueNonEmpty(candidate.sampleEntries.map(entryDate));
  const successCount = candidate.sampleEntries.filter((entry) => entry.success).length;
  const successRate = candidate.sampleEntries.length > 0
    ? successCount / candidate.sampleEntries.length
    : 0;
  const failures = candidate.sampleEntries.filter((entry) => !entry.success);
  const failureLessons = uniqueNonEmpty(
    failures.map((entry) => entry.details || entry.action),
  ).slice(0, 3);
  const representativeNeeds = uniqueNonEmpty(
    candidate.sampleEntries.map(
      (entry) => entry.userInput || entry.taskTitle || entry.action,
    ),
  ).slice(0, 3);
  const steps = numberedStepCount(candidate.skillContent);
  const hasFrontmatter = /^---\s*$/mu.test(candidate.skillContent)
    && /\nname:\s*\S+/u.test(candidate.skillContent)
    && /\ndescription:\s*\S+/u.test(candidate.skillContent);
  const hasTriggerSection = /##\s*(触发|适用|何时使用)/u.test(candidate.skillContent);
  const hasOutputSection = /##\s*(输出|交付|验收)/u.test(candidate.skillContent);
  const hasBoundarySection = /##\s*(注意|边界|风险|失败|异常)/u.test(candidate.skillContent);
  const hasInputRequirements = /(前置条件|输入要求|必要输入|先确认|确认.*(?:存在|权限|范围))/u
    .test(candidate.skillContent);

  let qualityScore = 0;
  qualityScore += Math.min(20, candidate.occurrenceCount * 5);
  qualityScore += Math.min(12, dates.length * 4);
  qualityScore += Math.round(successRate * 12);
  qualityScore += hasFrontmatter ? 8 : 0;
  qualityScore += hasTriggerSection ? 10 : 0;
  qualityScore += Math.min(12, steps * 4);
  qualityScore += hasOutputSection ? 8 : 0;
  qualityScore += hasBoundarySection ? 6 : 0;
  qualityScore += hasInputRequirements ? 6 : 0;
  qualityScore += representativeNeeds.length >= 2 ? 6 : representativeNeeds.length * 2;
  qualityScore = Math.min(100, qualityScore);

  const confidence = rounded(Math.min(
    0.98,
    0.25
      + Math.min(0.24, dates.length * 0.08)
      + Math.min(0.24, candidate.occurrenceCount * 0.04)
      + Math.min(0.15, candidate.sampleEntries.length * 0.025)
      + (hasTriggerSection && steps >= 2 ? 0.1 : 0),
  ));
  const evidence = [
    `跨 ${dates.length} 天观察到 ${candidate.occurrenceCount} 次同类流程`,
    `相关样本 ${candidate.sampleEntries.length} 条，成功率 ${Math.round(successRate * 100)}%`,
    ...representativeNeeds.map((need) => `典型需求：${need.slice(0, 100)}`),
  ].slice(0, 5);
  const rejectionReasons: string[] = [];
  if (candidate.occurrenceCount < 3) rejectionReasons.push('重复次数不足 3 次');
  if (dates.length < 2) rejectionReasons.push('尚未跨至少 2 天复现');
  if (candidate.triggerPatterns.length === 0) rejectionReasons.push('缺少明确触发意图');
  if (candidate.skillContent.trim().length < 180) rejectionReasons.push('Skill 内容过于简略');
  if (steps < 2) rejectionReasons.push('可执行步骤少于 2 步');
  if (!hasTriggerSection) rejectionReasons.push('缺少触发场景');
  if (!hasOutputSection) rejectionReasons.push('缺少输出或验收约定');
  if (qualityScore < 58) rejectionReasons.push(`质量分仅 ${qualityScore}`);

  return {
    qualityScore,
    confidence,
    evidence,
    failureLessons,
    rejectionReasons,
  };
}

export function autoSkillCandidateSimilarity(
  left: AutoSkillQualityInput,
  right: AutoSkillQualityInput | ExistingSkillSummary,
): number {
  const leftFragments = candidateFragments(left);
  const rightFragments = 'skillContent' in right
    ? candidateFragments(right)
    : uniqueNonEmpty([
      right.name.replace(/^auto-/u, '').replace(/-/gu, ' '),
      right.summary,
      `${right.name.replace(/^auto-/u, '').replace(/-/gu, ' ')} ${right.summary}`,
    ].map(normalizeSkillFragment));
  let best = 0;
  for (const leftText of leftFragments) {
    for (const rightText of rightFragments) {
      best = Math.max(best, textSimilarity(leftText, rightText));
    }
  }
  return best;
}

/**
 * 质量排序、候选间语义去重、已有 Skill 去重。
 * 只过滤非常接近的候选；模糊边界继续交给用户确认。
 */
export function rankAutoSkillCandidates<T extends AutoSkillQualityInput>(
  candidates: T[],
  existingSkills: ExistingSkillSummary[] = [],
  limit = 5,
): Array<T & AutoSkillQualityMetadata> {
  const assessed = candidates
    .map((candidate) => ({ ...candidate, ...assessAutoSkillCandidate(candidate) }))
    .filter((candidate) => candidate.rejectionReasons.length === 0)
    .sort((a, b) =>
      b.qualityScore - a.qualityScore
      || b.confidence - a.confidence
      || b.occurrenceCount - a.occurrenceCount,
    );
  const selected: Array<T & AutoSkillQualityMetadata> = [];

  for (const candidate of assessed) {
    const duplicatesExisting = existingSkills.some((existing) =>
      existing.name.toLowerCase() === candidate.name.toLowerCase()
      || autoSkillCandidateSimilarity(candidate, existing) >= 0.62,
    );
    if (duplicatesExisting) continue;
    const duplicatesCandidate = selected.some(
      (accepted) => autoSkillCandidateSimilarity(candidate, accepted) >= 0.62,
    );
    if (duplicatesCandidate) continue;
    selected.push(candidate);
    if (selected.length >= limit) break;
  }
  return selected;
}
