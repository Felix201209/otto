/**
 * @license
 * Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';

import { assembleLayeredMemory, type MemoryProvider, type MemoryScope } from './memoryProvider.js';

export interface MemoryRecallQuery {
  readonly terms?: readonly string[];
  readonly projectRoot?: string;
  readonly sessionId?: string;
  readonly scope?: MemoryScope;
  readonly scopes?: readonly MemoryScope[];
  readonly maxSections?: number;
  readonly maxItemsPerSection?: number;
  readonly maxChars?: number;
}

interface RecallLine {
  readonly line: string;
  readonly score: number;
  readonly index: number;
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'to',
  'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'about',
  'like', 'through', 'after', 'over', 'between', 'out', 'against', 'during',
  'without', 'before', 'under', 'around', 'among', 'and', 'but', 'or', 'nor',
  'not', 'so', 'yet', 'both', 'either', 'neither', 'each', 'every', 'all',
  'any', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'only', 'own',
  'same', 'than', 'too', 'very', 'just', 'because', 'then', 'now', 'also',
  'here', 'there', 'when', 'where', 'why', 'how', 'who', 'whom', 'which',
  'what', 'this', 'that', 'these', 'those', 'it', 'its', 'i', 'you', 'we',
  'they', 'them', 'my', 'your', 'our', 'their', 'project', 'session', 'memory',
]);

const SECTION_RE = /---\s+([^-\n]+?)\s+---\n([\s\S]*?)(?=\n\n---\s+[^-\n]+?\s+---|\s*$)/g;

function normalizeTerms(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const cleaned = value
      .toLowerCase()
      .replace(/[^a-z0-9\u00c0-\u024f\u4e00-\u9fff@/._-]+/giu, ' ');
    for (const token of cleaned.split(/[\s,，、;；:：]+/)) {
      const term = token.trim().replace(/^[-_.]+|[-_.]+$/g, '');
      if (term.length < 2 || STOP_WORDS.has(term) || seen.has(term)) {
        continue;
      }
      seen.add(term);
      result.push(term);
      if (result.length >= 16) {
        return result;
      }
    }
  }
  return result;
}

function queryTerms(query: MemoryRecallQuery): string[] {
  const terms: string[] = [...(query.terms ?? [])];
  if (query.projectRoot) {
    terms.push(path.basename(query.projectRoot), query.projectRoot);
  }
  if (query.sessionId) {
    terms.push(query.sessionId);
  }
  return normalizeTerms(terms);
}

function scoreLine(line: string, terms: readonly string[], sectionTitle: string, query: MemoryRecallQuery): number {
  const lowered = line.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (!term) {
      continue;
    }
    if (lowered.includes(term)) {
      score += Math.max(2, Math.min(8, term.length));
    }
  }
  if (score === 0) {
    return 0;
  }
  if (line.startsWith('- ')) {
    score += 1.5;
  } else if (line.startsWith('#')) {
    score += 1;
  }
  const scopeHint = String(query.scope ?? '').toLowerCase();
  if (scopeHint && sectionTitle.toLowerCase().includes(scopeHint)) {
    score += 2;
  }
  if (sectionTitle.toLowerCase().includes('session') && query.sessionId) {
    score += 1;
  }
  if (sectionTitle.toLowerCase().includes('project') && query.projectRoot) {
    score += 1;
  }
  return score;
}

function selectRelevantLines(
  body: string,
  terms: readonly string[],
  sectionTitle: string,
  query: MemoryRecallQuery,
  maxItems: number,
): string[] {
  const candidates: RecallLine[] = [];
  const lines = body.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line === '(empty)') {
      continue;
    }
    const score = scoreLine(line, terms, sectionTitle, query);
    if (score > 0) {
      candidates.push({ line, score, index });
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.index - b.index || a.line.length - b.line.length);
  return candidates.slice(0, maxItems).map(item => item.line.startsWith('- ') ? item.line : `- ${item.line}`);
}

export function buildRecallFromLayeredMemory(
  layeredMemory: string,
  query: MemoryRecallQuery = {},
): string {
  const terms = queryTerms(query);
  if (terms.length === 0) {
    return '';
  }

  const maxSections = Math.max(1, query.maxSections ?? 4);
  const maxItemsPerSection = Math.max(1, query.maxItemsPerSection ?? 3);
  const maxChars = Math.max(200, query.maxChars ?? 1200);
  const blocks: string[] = [];
  let budget = 0;

  for (const match of layeredMemory.matchAll(SECTION_RE)) {
    const sectionTitle = (match[1] ?? '').trim();
    const body = (match[2] ?? '').trim();
    if (!sectionTitle || !body) {
      continue;
    }
    const lines = selectRelevantLines(body, terms, sectionTitle, query, maxItemsPerSection);
    if (lines.length === 0) {
      continue;
    }
    const block = `--- ${sectionTitle} ---\n${lines.join('\n')}`;
    if (budget + block.length > maxChars) {
      break;
    }
    blocks.push(block);
    budget += block.length;
    if (blocks.length >= maxSections) {
      break;
    }
  }

  return blocks.join('\n\n');
}

export async function assembleRelevantLayeredMemory(
  provider: MemoryProvider,
  query: MemoryRecallQuery = {},
): Promise<string> {
  const layeredMemory = await assembleLayeredMemory(provider, {
    scopes: query.scopes,
  });
  return buildRecallFromLayeredMemory(layeredMemory, query);
}
