/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { ToolCallStatus } from '../../types.js';
import type { ToolResultDisplay } from 'otto-core';

/**
 * Read/search/listing tools whose completed output is just a confirmation
 * (line counts, file lists, match counts). The title line already names the
 * action + target, so the body is redundant once finished — collapse it to a
 * single line, Claude-Code style. Diffs/edits and structured displays are
 * intentionally excluded so their content stays fully visible.
 */
const COLLAPSIBLE_TOOL_IDS = new Set<string>([
  'read_file',
  'read_many_files',
  'list_directory',
  'glob',
  'search_file_content',
  'web_fetch',
  'web_search',
]);

export interface CollapseInput {
  toolId?: string;
  status: ToolCallStatus;
  resultDisplay?: ToolResultDisplay | string;
}

/**
 * Decide whether a completed tool's result body should be hidden, leaving only
 * the title line as a one-line summary.
 *
 * Only collapses when ALL hold:
 * - the tool is in the read/search/listing family,
 * - it finished successfully (errors stay visible),
 * - the result is a plain string (object displays like diffs are kept).
 */
export function shouldCollapseToolResult(input: CollapseInput): boolean {
  if (input.status !== ToolCallStatus.Success) return false;
  if (!input.toolId || !COLLAPSIBLE_TOOL_IDS.has(input.toolId)) return false;
  if (typeof input.resultDisplay !== 'string') return false;
  if (input.resultDisplay.length === 0) return false;
  return true;
}
