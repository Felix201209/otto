/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import vm from 'node:vm';
import { WorkflowAgentAPI } from './workflowAgentBridge.js';

/**
 * Structured metadata parsed from `export const meta = { ... }` at the top of a workflow script.
 */
export interface WorkflowMeta {
  name?: string;
  description?: string;
  phases?: Array<{ title: string; detail?: string }>;
}

/**
 * Result returned after the orchestration script finishes.
 */
export interface WorkflowRunResult {
  success: boolean;
  /** Final value returned by the script's default export function. */
  output: string;
  error?: string;
  /** Accumulated token usage across all sub-agents. */
  totalTokenUsage: { inputTokens: number; outputTokens: number; totalTokens: number };
}

/**
 * Parse `export const meta = { ... }` from the script source without executing it.
 * Returns an empty object if no meta is found or parsing fails.
 */
export function extractMeta(script: string): WorkflowMeta {
  // Extract `export const meta = { ... }` by counting brace depth instead of
  // relying on lazy regex, which breaks on nested objects or `};` inside strings.
  const startMatch = script.match(/export\s+const\s+meta\s*=\s*\{/);
  if (!startMatch) return {};
  const startIdx = startMatch.index! + startMatch[0].length - 1; // index of opening '{'
  let depth = 0;
  let inString: string | null = null; // tracks whether we're inside a string literal
  let escaped = false;
  for (let i = startIdx; i < script.length; i++) {
    const ch = script[i]!;
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (inString) {
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue; }
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) {
        // Found the closing brace
        const objectLiteral = script.substring(startIdx, i + 1);
        try {
          const sandbox = { result: undefined as unknown };
          const evalScript = new vm.Script(`result = (${objectLiteral})`);
          evalScript.runInNewContext(sandbox);
          const val = sandbox.result;
          if (val && typeof val === 'object') return val as WorkflowMeta;
        } catch {
          // ignore parse errors
        }
        return {};
      }
    }
  }
  return {};
}

/**
 * Execute a workflow orchestration script inside a Node.js vm sandbox.
 *
 * Script contract:
 * - Declare metadata at the top:
 *     export const meta = { name, description, phases: [{title, detail}] };
 * - Call `phase('name')` to advance the UI phase tracker.
 * - Call `await agent(prompt, { label, schema?, model? })` for serial execution.
 * - Call `await Promise.all([agent(...), agent(...)])` for parallel execution.
 * - Return a string (or JSON-serializable value) as the final workflow output.
 */
export async function runWorkflowScript(
  script: string,
  agentAPI: WorkflowAgentAPI,
  abortSignal: AbortSignal,
): Promise<WorkflowRunResult> {
  const tokenAccumulator = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

  // ── phase() top-level function ────────────────────────────────────────────
  // Maps phase title → index by consulting the meta we already parsed, with fallback counter.
  const meta = extractMeta(script);
  const phaseTitles = (meta.phases ?? []).map(p => p.title);
  let currentPhaseIdx = 0;

  const phaseFunc = (title: string) => {
    // Find by title first, fall back to sequential increment
    const idx = phaseTitles.indexOf(title);
    currentPhaseIdx = idx >= 0 ? idx : currentPhaseIdx + 1;
    agentAPI.setCurrentPhaseIndex(currentPhaseIdx);
  };

  // ── agent() / agent.run() / agent.runParallel() ───────────────────────────
  // Support both the flat `agent(prompt, opts)` call style AND the nested
  // `agent.run({...})` / `agent.runParallel([...])` style for backwards compat.
  const runOne = async (
    promptOrOpts: string | Parameters<WorkflowAgentAPI['run']>[0],
    opts?: { label?: string; schema?: Record<string, unknown>; model?: string; context?: unknown; max_turns?: number },
  ) => {
    const options: Parameters<WorkflowAgentAPI['run']>[0] =
      typeof promptOrOpts === 'string'
        ? { prompt: promptOrOpts, label: opts?.label, schema: opts?.schema, model: opts?.model, context: opts?.context, max_turns: opts?.max_turns }
        : promptOrOpts;

    const result = await agentAPI.run(options);
    if (result.tokenUsage) {
      tokenAccumulator.inputTokens += result.tokenUsage.inputTokens;
      tokenAccumulator.outputTokens += result.tokenUsage.outputTokens;
      tokenAccumulator.totalTokens += result.tokenUsage.totalTokens;
    }
    return result;
  };

  const runParallel = async (tasks: Parameters<WorkflowAgentAPI['runParallel']>[0]) => {
    const results = await agentAPI.runParallel(tasks);
    for (const r of results) {
      if (r.tokenUsage) {
        tokenAccumulator.inputTokens += r.tokenUsage.inputTokens;
        tokenAccumulator.outputTokens += r.tokenUsage.outputTokens;
        tokenAccumulator.totalTokens += r.tokenUsage.totalTokens;
      }
    }
    return results;
  };

  // The callable `agent` function — supports both call styles
  const agentFn = Object.assign(
    async (
      promptOrOpts: string | Parameters<WorkflowAgentAPI['run']>[0],
      opts?: { label?: string; schema?: Record<string, unknown>; model?: string; context?: unknown; max_turns?: number },
    ) => runOne(promptOrOpts, opts),
    {
      run: runOne,
      runParallel,
      setPhase: (index: number) => {
        currentPhaseIdx = index;
        agentAPI.setCurrentPhaseIndex(index);
      },
    },
  );

  // Transpile ES module syntax to CommonJS for vm context
  const transpiled = transpileScript(script);

  const capturedLogs: string[] = [];
  const safeConsole = {
    log: (...args: unknown[]) =>
      capturedLogs.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')),
    error: (...args: unknown[]) =>
      capturedLogs.push('[error] ' + args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')),
  };

  const sandbox: Record<string, unknown> = {
    agent: agentFn,
    phase: phaseFunc,          // top-level phase() function
    console: safeConsole,
    JSON,
    Promise,
    module: { exports: {} as Record<string, unknown> },
    exports: {} as Record<string, unknown>,
  };

  try {
    const vmScript = new vm.Script(transpiled, { filename: 'workflow.js' });
    const context = vm.createContext(sandbox);
    vmScript.runInContext(context);

    const exports = sandbox['module'] as { exports: Record<string, unknown> };
    const mainFn = exports.exports['default'];
    if (typeof mainFn !== 'function') {
      throw new Error(
        'Workflow script must export a default async function: `export default async function(agent) { ... }`',
      );
    }

    const rawOutput = await (mainFn as (agent: typeof agentFn) => Promise<unknown>)(agentFn);

    const output =
      typeof rawOutput === 'string'
        ? rawOutput
        : rawOutput !== undefined && rawOutput !== null
          ? JSON.stringify(rawOutput, null, 2)
          : '(workflow completed with no return value)';

    return { success: true, output, totalTokenUsage: tokenAccumulator };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    if (abortSignal.aborted || (err instanceof Error && err.name === 'AbortError')) {
      throw err;
    }
    // The orchestrator script itself threw — but sub-agents may have already produced
    // useful output. Collect whatever was logged and surface it alongside the error,
    // so the caller (and the model) can see the partial results instead of just an error.
    const partialOutput = capturedLogs.length > 0
      ? `Partial output before error:\n${capturedLogs.join('\n')}`
      : '';
    return {
      success: false,
      output: partialOutput,
      error: `${errorMessage}${partialOutput ? '\n\n' + partialOutput : ''}`,
      totalTokenUsage: tokenAccumulator,
    };
  }
}

/**
 * Transpile ES module syntax to CommonJS for vm.Script.
 * Also strips `export const meta = {...}` (it's only used by extractMeta).
 *
 * Uses a state machine to skip over string literals and comments so that
 * ES module syntax inside strings/comments is not incorrectly transformed.
 */
function transpileScript(script: string): string {
  // Phase 1: Strip "export const meta = { ... };" using brace-depth counting
  // (same approach as extractMeta to handle nested objects correctly)
  let result = script;
  const metaStart = result.match(/export\s+const\s+meta\s*=\s*\{/);
  if (metaStart) {
    const startIdx = metaStart.index! + metaStart[0].length - 1;
    let depth = 0;
    let inString: string | null = null;
    let escaped = false;
    let endIdx = -1;
    for (let i = startIdx; i < result.length; i++) {
      const ch = result[i]!;
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (inString) {
        if (ch === inString) inString = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue; }
      if (ch === '{') depth++;
      if (ch === '}') {
        depth--;
        if (depth === 0) { endIdx = i; break; }
      }
    }
    if (endIdx >= 0) {
      // Remove from 'export' start to the closing brace + optional semicolon + newline
      const exportStart = metaStart.index!;
      let cutEnd = endIdx + 1;
      if (result[cutEnd] === ';') cutEnd++;
      if (result[cutEnd] === '\n') cutEnd++;
      result = result.substring(0, exportStart) + result.substring(cutEnd);
    }
  }

  // Phase 2: Replace export default patterns, but only outside strings and comments
  result = replaceOutsideStringsAndComments(result, [
    // "export default async function [name]?(" → "module.exports.default = async function("
    {
      pattern: /export\s+default\s+async\s+function\s*\w*\s*\(/g,
      replacement: 'module.exports.default = async function(',
    },
    // "export default function [name]?(" → "module.exports.default = function("
    {
      pattern: /export\s+default\s+function\s*\w*\s*\(/g,
      replacement: 'module.exports.default = function(',
    },
    // "export default async (" or "export default (" — arrow function form
    {
      pattern: /export\s+default\s+(async\s*)?\(/g,
      replacement: 'module.exports.default = $1(',
    },
  ]);

  return result;
}

/**
 * Apply regex replacements only to code portions outside of string literals
 * and comments. This prevents accidental transformation of ES module syntax
 * that appears inside template strings or comments.
 */
function replaceOutsideStringsAndComments(
  code: string,
  rules: Array<{ pattern: RegExp; replacement: string }>,
): string {
  // Split code into tokens: code vs string/comment regions
  const segments: Array<{ text: string; isCode: boolean }> = [];
  let i = 0;
  let inString: string | null = null;
  let inComment: 'line' | 'block' | null = null;
  let escaped = false;
  let segStart = 0;

  while (i < code.length) {
    const ch = code[i]!;
    const next = code[i + 1];

    if (escaped) {
      escaped = false;
      i++;
      continue;
    }

    // Inside a string literal
    if (inString) {
      if (ch === '\\') { escaped = true; i++; continue; }
      if (ch === inString) {
        // End of string — emit segment
        segments.push({ text: code.substring(segStart, i + 1), isCode: false });
        inString = null;
        segStart = i + 1;
      }
      i++;
      continue;
    }

    // Inside a block comment
    if (inComment === 'block') {
      if (ch === '*' && next === '/') {
        segments.push({ text: code.substring(segStart, i + 2), isCode: false });
        inComment = null;
        segStart = i + 2;
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    // Inside a line comment
    if (inComment === 'line') {
      if (ch === '\n') {
        segments.push({ text: code.substring(segStart, i), isCode: false });
        inComment = null;
        segStart = i;
      }
      i++;
      continue;
    }

    // Not inside string or comment — detect start of one
    if (ch === '"' || ch === "'" || ch === '`') {
      // Emit preceding code segment
      if (i > segStart) {
        segments.push({ text: code.substring(segStart, i), isCode: true });
      }
      inString = ch;
      segStart = i;
      i++;
      continue;
    }

    if (ch === '/' && next === '/') {
      if (i > segStart) {
        segments.push({ text: code.substring(segStart, i), isCode: true });
      }
      inComment = 'line';
      segStart = i;
      i++;
      continue;
    }

    if (ch === '/' && next === '*') {
      if (i > segStart) {
        segments.push({ text: code.substring(segStart, i), isCode: true });
      }
      inComment = 'block';
      segStart = i;
      i++;
      continue;
    }

    i++;
  }

  // Emit remaining segment
  if (segStart < code.length) {
    segments.push({ text: code.substring(segStart), isCode: !inString && !inComment });
  }

  // Apply replacements only to code segments
  for (const rule of rules) {
    for (const seg of segments) {
      if (seg.isCode) {
        seg.text = seg.text.replace(rule.pattern, rule.replacement);
      }
    }
  }

  return segments.map(s => s.text).join('');
}
