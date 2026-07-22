/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

export type UserVisibleToolStatus =
  | 'pending'
  | 'executing'
  | 'running'
  | 'background_running'
  | 'subagent_running'
  | 'confirming'
  | 'success'
  | 'error'
  | 'cancelled'
  | 'canceled';

export interface UserVisibleToolSummaryInput {
  toolId: string;
  name: string;
  description: string;
  status: UserVisibleToolStatus | string;
  resultText?: string;
  summary?: string;
}

export interface UserVisibleToolGroupSummaryInput {
  toolId: string;
  status: UserVisibleToolStatus | string;
}

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
  return value.replace(/[.。]$/u, '');
}

function describeTarget(description: string): string {
  const target = cleanText(description);
  return target || 'the requested target';
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

function normalizeStatus(status: UserVisibleToolStatus | string): UserVisibleToolStatus | string {
  return status.toLowerCase();
}

export function summarizeUserVisibleTool(input: UserVisibleToolSummaryInput): string {
  const providedSummary = input.summary ? cleanText(input.summary) : '';
  if (providedSummary) return truncateSummary(stripTrailingPeriod(providedSummary));

  const target = describeTarget(input.description);
  const output = input.resultText ?? '';
  const status = normalizeStatus(input.status);

  if (status === 'error') {
    const errorText = output ? ` — ${truncateSummary(output)}` : '';
    return `Needs attention: ${target} failed${errorText}`;
  }

  if (status === 'cancelled' || status === 'canceled') {
    return `Canceled: ${target}`;
  }

  if (status === 'confirming') {
    return `Needs permission: ${target}`;
  }

  if (
    status === 'pending' ||
    status === 'executing' ||
    status === 'running' ||
    status === 'subagent_running'
  ) {
    return `Working on: ${target}`;
  }

  if (status === 'background_running') {
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

export function summarizeUserVisibleToolGroup(
  tools: UserVisibleToolGroupSummaryInput[],
): string | null {
  if (tools.length < 2) return null;

  const failed = tools.filter((tool) => normalizeStatus(tool.status) === 'error');
  if (failed.length > 0) {
    return `Needs attention: ${failed.length} of ${tools.length} actions failed`;
  }

  const waiting = tools.filter((tool) => normalizeStatus(tool.status) === 'confirming');
  if (waiting.length > 0) {
    return `Needs permission: ${waiting.length} action${waiting.length === 1 ? '' : 's'} waiting`;
  }

  const unfinished = tools.filter((tool) => {
    const status = normalizeStatus(tool.status);
    return (
      status === 'pending' ||
      status === 'executing' ||
      status === 'running' ||
      status === 'subagent_running' ||
      status === 'background_running'
    );
  });
  if (unfinished.length > 0) {
    return `Working through ${tools.length} actions`;
  }

  const readFiles = tools.filter((tool) => tool.toolId === 'read_file');
  if (readFiles.length === tools.length) {
    return `Read ${tools.length} files`;
  }

  return `Finished ${tools.length} actions`;
}
