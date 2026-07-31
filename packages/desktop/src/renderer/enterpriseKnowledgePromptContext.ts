/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { EnterpriseKnowledgeItem } from '../preload/index.js';

function compact(value: string | null | undefined, maximum: number): string {
  const normalized = (value ?? '').replace(/\s+/g, ' ').trim();
  return normalized.length > maximum ? `${normalized.slice(0, maximum - 1)}…` : normalized;
}

/** Formats only published records returned by the authenticated enterprise server. */
export function buildEnterpriseKnowledgePromptContext(
  items: readonly EnterpriseKnowledgeItem[],
): string {
  return items
    .filter((item) => !item.status || item.status === 'active')
    .slice(0, 8)
    .map((item) => {
      const citation = `[企业知识#${compact(item.id, 40)} v${item.version || 1}]`;
      const scope = compact(item.department, 80) || '全组织';
      const source = compact(item.sourceLabel || item.sourceId, 140);
      return [
        `${citation} ${compact(item.title, 180) || compact(item.category, 100)}`,
        `范围：${scope}；分类：${compact(item.category, 100)}${source ? `；来源：${source}` : ''}`,
        compact(item.content, 900),
      ].join('\n');
    })
    .join('\n\n')
    .slice(0, 8_000);
}

