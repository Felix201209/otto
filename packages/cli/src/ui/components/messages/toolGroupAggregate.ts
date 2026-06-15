/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

import { IndividualToolCallDisplay, ToolCallStatus } from '../../types.js';

/**
 * Read-only tools that are safe to aggregate into a single compact
 * "Reading N files…" style block when several of the same kind appear,
 * back-to-back, inside ONE tool_group (i.e. the model issued them in the
 * same response / batch).
 *
 * We deliberately restrict this to file-reading tools whose title line is
 * just "<Tool> <path>" — aggregating them loses nothing because each child
 * row still shows its own path. Edits, shell, diffs, confirmations, etc. are
 * never aggregated so their full content stays visible.
 */
const AGGREGATABLE_TOOL_IDS = new Set<string>(['read_file']);

/** Minimum number of identical calls before we bother collapsing. */
const MIN_AGGREGATE_COUNT = 2;

export interface AggregatedToolGroup {
  /** The shared original tool id, e.g. 'read_file'. */
  toolId: string;
  /** Per-call short descriptions (e.g. relative file paths), in order. */
  items: string[];
}

/**
 * A single call is aggregatable only when it is a plain, finished, read-only
 * call with no confirmation prompt and no nested/sub/batch structure. Anything
 * that needs richer rendering disqualifies the whole group.
 */
function isAggregatableCall(tool: IndividualToolCallDisplay): boolean {
  if (!AGGREGATABLE_TOOL_IDS.has(tool.toolId)) return false;
  if (tool.status !== ToolCallStatus.Success) return false;
  if (tool.confirmationDetails) return false;
  if (tool.subToolCalls && tool.subToolCalls.length > 0) return false;
  if (tool.batchSubTools && tool.batchSubTools.length > 0) return false;
  return true;
}

/**
 * Decide whether a whole tool_group should be rendered as a single compact
 * aggregated block.
 *
 * Returns the aggregation payload when ALL tools in the group:
 * - are the SAME aggregatable read-only tool (e.g. every one is read_file),
 * - finished successfully,
 * - carry no confirmation / sub-tool / batch structure,
 * and there are at least {@link MIN_AGGREGATE_COUNT} of them.
 *
 * Otherwise returns null and the caller renders the group normally.
 */
export function selectAggregatedToolGroup(
  tools: IndividualToolCallDisplay[],
): AggregatedToolGroup | null {
  if (!tools || tools.length < MIN_AGGREGATE_COUNT) return null;

  const firstToolId = tools[0].toolId;
  if (!AGGREGATABLE_TOOL_IDS.has(firstToolId)) return null;

  for (const tool of tools) {
    if (tool.toolId !== firstToolId) return null;
    if (!isAggregatableCall(tool)) return null;
  }

  return {
    toolId: firstToolId,
    items: tools.map((t) => t.description),
  };
}
