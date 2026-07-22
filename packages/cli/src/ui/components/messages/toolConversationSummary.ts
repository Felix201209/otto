/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolResultDisplay } from 'otto-core';
import { IndividualToolCallDisplay, ToolCallStatus } from '../../types.js';

const MAX_SUMMARY_LENGTH = 140;

function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncateSummary(value: string): string {
  const cleaned = cleanText(value);
  if (cleaned.length <= MAX_SUMMARY_LENGTH) return cleaned;
  return `${cleaned.slice(0, MAX_SUMMARY_LENGTH - 1).trimEnd()}…`;
}

function stripTrailingPeriod(value: string): string {
  return value.replace(/[。.]$/u, '');
}

function describeTarget(description: string): string {
  const target = cleanText(description);
  return target || 'the requested target';
}

function resultText(resultDisplay: ToolResultDisplay | undefined): string {
  return typeof resultDisplay === 'string' ? resultDisplay : '';
}

function extractReadLineCount(output: string): number | null {
  const linesMatch = output.match(/\b(\d+)\s+lines\b/i);
  if (linesMatch) return Number.parseInt(linesMatch[1], 10);

  const rangeMatch = output.match(/read\s+lines:\s*(\d+)-(\d+)/i);
  if (rangeMatch) {
    const start = Number.parseInt(rangeMatch[1], 10);
    const end = Number.parseInt(rangeMatch[2], 10);
    return Math.max(0, end - start + 1);
  }

  if (output.length > 0) return output.split('\n').length;
  return null;
}

function extractFirstNumber(output: string, patterns: RegExp[]): number | null {
  for (const pattern of patterns) {
    const match = output.match(pattern);
    if (match) return Number.parseInt(match[1], 10);
  }
  return null;
}

export interface ToolConversationSummaryInput {
  toolId: string;
  name: string;
  description: string;
  status: ToolCallStatus;
  resultDisplay?: ToolResultDisplay;
  summary?: string;
}

/**
 * Build a short, user-facing update for one tool call.
 *
 * The model/tool-provided summary wins when present; otherwise we fall back to
 * deterministic rules based on status, tool kind, target, and result text.
 */
export function summarizeToolConversation(
  input: ToolConversationSummaryInput,
): string {
  const providedSummary = input.summary ? cleanText(input.summary) : '';
  if (providedSummary) return truncateSummary(stripTrailingPeriod(providedSummary));

  const target = describeTarget(input.description);
  const output = resultText(input.resultDisplay);

  if (input.status === ToolCallStatus.Error) {
    const errorText = output ? ` — ${truncateSummary(output)}` : '';
    return `Needs attention: ${target} failed${errorText}`;
  }

  if (input.status === ToolCallStatus.Canceled) {
    return `Canceled: ${target}`;
  }

  if (input.status === ToolCallStatus.Confirming) {
    return `Needs permission: ${target}`;
  }

  if (
    input.status === ToolCallStatus.Pending ||
    input.status === ToolCallStatus.Executing ||
    input.status === ToolCallStatus.SubAgentRunning
  ) {
    return `Working on: ${target}`;
  }

  if (input.status === ToolCallStatus.BackgroundRunning) {
    return `Running in background: ${target}`;
  }

  switch (input.toolId) {
    case 'read_file': {
      const count = extractReadLineCount(output);
      return count === null
        ? `Read ${target}`
        : `Read ${target} (${count} lines)`;
    }
    case 'read_many_files': {
      const count = extractFirstNumber(output, [
        /content from \*\*(\d+)\s+file/i,
        /content from \*\*(\d+)\*\*\s+file/i,
        /Successfully read and concatenated content from \*\*(\d+)\s+file/i,
        /(\d+)\s+file\(s\)/i,
      ]);
      return count === null ? `Read files for ${target}` : `Read ${count} files`;
    }
    case 'search_file_content': {
      const count = extractFirstNumber(output, [/Found\s+(\d+)\s+matches/i]);
      if (/No matches found/i.test(output)) return `Searched ${target}; no matches found`;
      return count === null
        ? `Searched ${target}`
        : `Searched ${target}; found ${count} matches`;
    }
    case 'glob': {
      const count = extractFirstNumber(output, [/Found\s+(\d+)\s+matching/i]);
      return count === null
        ? `Checked files matching ${target}`
        : `Found ${count} files matching ${target}`;
    }
    case 'list_directory': {
      const count = extractFirstNumber(output, [/Listed\s+(\d+)\s+item/i]);
      return count === null ? `Listed ${target}` : `Listed ${count} items in ${target}`;
    }
    case 'web_fetch':
      return `Fetched ${target}`;
    case 'web_search':
      return `Searched the web for ${target}`;
    case 'run_shell_command':
      return `Command finished: ${target}`;
    default:
      return `${input.name || 'Tool'} finished: ${target}`;
  }
}

export function summarizeToolGroupConversation(
  tools: IndividualToolCallDisplay[],
): string | null {
  if (tools.length < 2) return null;

  const failed = tools.filter((tool) => tool.status === ToolCallStatus.Error);
  if (failed.length > 0) {
    return `Needs attention: ${failed.length} of ${tools.length} actions failed`;
  }

  const waiting = tools.filter((tool) => tool.status === ToolCallStatus.Confirming);
  if (waiting.length > 0) {
    return `Needs permission: ${waiting.length} action${waiting.length === 1 ? '' : 's'} waiting`;
  }

  const unfinished = tools.filter(
    (tool) =>
      tool.status === ToolCallStatus.Pending ||
      tool.status === ToolCallStatus.Executing ||
      tool.status === ToolCallStatus.SubAgentRunning ||
      tool.status === ToolCallStatus.BackgroundRunning,
  );
  if (unfinished.length > 0) {
    return `Working through ${tools.length} actions`;
  }

  const readFiles = tools.filter((tool) => tool.toolId === 'read_file');
  if (readFiles.length === tools.length) {
    return `Read ${tools.length} files`;
  }

  return `Finished ${tools.length} actions`;
}
