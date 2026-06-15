/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Config } from '../config/config.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import { GeminiClient } from './client.js';
import { SubAgent } from './subAgent.js';
import { getBuiltInAgentDefinition, resolveAgentTools } from '../agents/agentDefinition.js';
import { WorkflowRegistry } from './workflowRegistry.js';

/**
 * Options passed to agent.run() inside a workflow script.
 * Designed for AI readability: every field has a clear machine-interpretable purpose.
 */
export interface WorkflowAgentRunOptions {
  /** Full task description for the sub-agent. Include all needed instructions inline. */
  prompt: string;
  /** Short label shown in the /workflow panel (e.g. "运行测试套件"). */
  label?: string;
  /**
   * Structured context from previous steps. Will be serialized and appended to the
   * sub-agent prompt so the sub-agent can consume prior results without extra turns.
   */
  context?: unknown;
  /** Agent specialization. Defaults to 'code-analysis'. */
  agent_type?: string;
  /** Max conversation turns. Defaults to 15. */
  max_turns?: number;
  /**
   * Optional model override for this specific sub-agent.
   * Examples: 'gemini-2.0-flash', 'claude-opus-4-5'
   */
  model?: string;
  /**
   * JSON Schema for structured output. When provided, the sub-agent is instructed
   * to return ONLY a JSON object matching this schema. The result is automatically
   * parsed and available as `result.data`.
   *
   * Example:
   *   schema: { type: 'object', properties: { files: { type: 'array', items: { type: 'string' } } }, required: ['files'] }
   */
  schema?: Record<string, unknown>;
}

export interface WorkflowAgentRunResult {
  success: boolean;
  /** Text summary produced by the sub-agent. */
  result: string;
  /** Structured data if the sub-agent returned parseable JSON in its final response. */
  data?: unknown;
  /** Token usage for this sub-agent run. */
  tokenUsage?: { inputTokens: number; outputTokens: number; totalTokens: number };
}

/**
 * The `agent` object injected into the workflow sandbox.
 * This is the only API available to the orchestration script.
 */
export interface WorkflowAgentAPI {
  /**
   * Run a single sub-agent and await its result.
   * Blocks until the sub-agent finishes or the abort signal fires.
   */
  run(options: WorkflowAgentRunOptions): Promise<WorkflowAgentRunResult>;

  /**
   * Run multiple sub-agents in parallel.
   * Respects maxConcurrency. Results are returned in the same order as input tasks.
   * If any sub-agent throws, the error propagates and remaining tasks are cancelled.
   */
  runParallel(tasks: WorkflowAgentRunOptions[]): Promise<WorkflowAgentRunResult[]>;

  /**
   * Update the current phase index. Called by the workflow script's `phase()` function
   * to track which phase is currently executing.
   */
  setCurrentPhaseIndex(index: number): void;
}

const DEFAULT_MAX_TURNS = 15;
const DEFAULT_MAX_CONCURRENCY = 6;
const DEFAULT_MAX_AGENTS = 1000;
/** Per-agent hard deadline: 30 minutes. Prevents a single hung agent from blocking the workflow forever. */
const DEFAULT_AGENT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Implements WorkflowAgentAPI. Each call to run() spins up a fresh SubAgent instance.
 * Context is serialized and appended to the prompt so the sub-agent can consume it
 * without needing a separate context-passing mechanism.
 */
export class WorkflowAgentBridge implements WorkflowAgentAPI {
  private readonly maxConcurrency: number;
  private readonly maxAgents: number;
  /** Cumulative total of agents spawned in this workflow (lifetime limit). */
  private totalAgentCount: number = 0;
  /** Current phase index. The workflow script should update this before each phase. */
  public currentPhaseIndex: number = 0;

  setCurrentPhaseIndex(index: number): void {
    this.currentPhaseIndex = index;
  }

  constructor(
    private readonly config: Config,
    private readonly toolRegistry: ToolRegistry,
    private readonly geminiClient: GeminiClient,
    private readonly abortSignal: AbortSignal,
    /** Optional callback for forwarding sub-agent output events upstream. */
    private readonly onUpdate?: (agentId: string, output: string) => void,
    maxConcurrency: number = DEFAULT_MAX_CONCURRENCY,
    /** Workflow ID for registry tracking. */
    private readonly workflowId?: string,
    maxAgents: number = DEFAULT_MAX_AGENTS,
  ) {
    this.maxConcurrency = maxConcurrency;
    this.maxAgents = maxAgents;
  }

  async run(options: WorkflowAgentRunOptions): Promise<WorkflowAgentRunResult> {
    // Hard limit: prevent runaway workflows from spinning up unlimited agents
    // This is a cumulative lifetime limit — once exceeded, no more agents can spawn
    // in this workflow, even if earlier agents have finished.
    this.totalAgentCount++;
    if (this.totalAgentCount > this.maxAgents) {
      throw new Error(
        `Workflow agent limit reached (max ${this.maxAgents}, used ${this.totalAgentCount}). ` +
        `Reduce the number of agent() calls or increase max_agents.`,
      );
    }

    const prompt = this.buildPrompt(options);
    const agentType = options.agent_type ?? 'code-analysis';
    const maxTurns = options.max_turns ?? DEFAULT_MAX_TURNS;

    const agentDefinition = this.resolveAgentDefinition(agentType, maxTurns);
    const filteredRegistry = this.buildFilteredRegistry(agentDefinition);

    const agentId = `wf-agent-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const label = options.prompt.slice(0, 60) + (options.prompt.length > 60 ? '…' : '');

    // Register agent start
    if (this.workflowId) {
      WorkflowRegistry.startAgent(this.workflowId, agentId, label, options.prompt, options.model, this.currentPhaseIndex);
    }

    const subAgent = new SubAgent(
      this.config,
      filteredRegistry,
      this.geminiClient,
      (output: string) => this.onUpdate?.(agentId, output),
      this.abortSignal,
      // Track tool calls in real-time for the /workflow panel
      this.workflowId
        ? ({ tool, args }) => {
            const summary = `${tool.name}(${JSON.stringify(args).slice(0, 60)})`;
            WorkflowRegistry.updateAgentToolCall(this.workflowId!, agentId, summary);
          }
        : undefined,
      agentDefinition,
      options.model,
      // Real-time token update for the /workflow panel
      this.workflowId
        ? (tok) => {
            WorkflowRegistry.updateAgentTokens(this.workflowId!, agentId, tok);
            // Token update means AI just finished a turn → now thinking/deciding next step
            WorkflowRegistry.updateAgentPhase(this.workflowId!, agentId, 'thinking');
          }
        : undefined,
    );

    // Soft deadline: log a warning after 30min but do NOT abort the agent.
    // Complex tasks (large codebase analysis, long migrations) legitimately take longer.
    // Hard abort is left to the user via the global AbortSignal.
    const warningTimer = setTimeout(() => {
      console.warn(
        `[WorkflowAgentBridge] Agent "${label}" has been running for ${DEFAULT_AGENT_TIMEOUT_MS / 60000}min. ` +
        `It is still alive — this is a warning only. Use Ctrl+C to abort if needed.`
      );
    }, DEFAULT_AGENT_TIMEOUT_MS);

    let result: Awaited<ReturnType<typeof subAgent.executeTask>>;
    try {
      result = await subAgent.executeTask(prompt, maxTurns);
    } finally {
      clearTimeout(warningTimer);
    }

    // Parse structured data from the summary.
    // When schema was provided, attempt strict JSON parse of the entire summary first;
    // otherwise fall back to extracting a JSON block from prose output.
    // If all parsing fails, wrap the raw text so callers never get data === undefined.
    let data: unknown = undefined;
    if (options.schema) {
      // Schema mode: the sub-agent should have returned raw JSON
      const cleaned = result.summary.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      try { data = JSON.parse(cleaned); } catch { /* will try prose extraction below */ }
    }
    if (data === undefined) {
      const jsonMatch =
        result.summary.match(/```(?:json)?\s*([\s\S]*?)```/) ||
        result.summary.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
      if (jsonMatch) {
        try { data = JSON.parse(jsonMatch[1] ?? jsonMatch[0]); } catch { /* not JSON */ }
      }
    }
    // Final fallback: ensure data is never undefined so scripts using result.data.xxx
    // get a meaningful error rather than a silent "Cannot read property of undefined".
    if (data === undefined) {
      data = { text: result.summary, _parse_failed: true };
    }

    const agentStatus = result.success ? 'completed' : 'failed';
    const outcome = result.success ? result.summary : (result.error ?? 'failed');

    // Register agent end
    if (this.workflowId) {
      WorkflowRegistry.endAgent(this.workflowId, agentId, agentStatus, outcome, result.tokenUsage);
    }

    return {
      success: result.success,
      result: result.summary,
      data,
      tokenUsage: result.tokenUsage,
    };
  }

  async runParallel(tasks: WorkflowAgentRunOptions[]): Promise<WorkflowAgentRunResult[]> {
    if (tasks.length === 0) return [];

    // Local AbortController so we can cancel remaining tasks on first failure
    const localAbort = new AbortController();
    // Propagate parent abort to local
    if (this.abortSignal.aborted) { localAbort.abort(); }
    else { this.abortSignal.addEventListener('abort', () => localAbort.abort(), { once: true }); }

    const results: WorkflowAgentRunResult[] = new Array(tasks.length);
    const queue = tasks.map((task, index) => ({ task, index }));
    let active = 0;
    let queueIndex = 0;
    let failed = false;

    // Use a wrapped run() that respects localAbort. When localAbort fires,
    // we skip spawning new tasks but allow in-flight tasks to finish naturally
    // (they are bound to the parent abortSignal and will stop when it fires).
    const runWithLocalAbort = (task: WorkflowAgentRunOptions): Promise<WorkflowAgentRunResult> => {
      if (localAbort.signal.aborted) return Promise.reject(new Error('AbortError'));
      return this.run(task);
    };

    await new Promise<void>((resolve, reject) => {
      const tryNext = () => {
        // Skip scheduling new tasks if we've been aborted
        while (!failed && !localAbort.signal.aborted && active < this.maxConcurrency && queueIndex < queue.length) {
          const { task, index } = queue[queueIndex++]!;
          active++;

          runWithLocalAbort(task)
            .then(result => {
              if (!failed) results[index] = result;
            })
            .catch(err => {
              if (!failed) {
                failed = true;
                localAbort.abort();  // cancel remaining in-flight tasks
                reject(err);
              }
            })
            .finally(() => {
              active--;
              if (active === 0 && (queueIndex >= queue.length || failed)) {
                if (!failed) resolve();
              } else if (!failed && !localAbort.signal.aborted) {
                tryNext();
              }
            });
        }
        if (queue.length === 0) resolve();
      };
      tryNext();
    });

    // Fill any never-started slots with error placeholders so callers don't hit undefined
    for (let i = 0; i < results.length; i++) {
      if (results[i] === undefined) {
        results[i] = { success: false, result: 'Cancelled: workflow abort', tokenUsage: undefined };
      }
    }

    return results;
  }

  /**
   * Build the final prompt for a sub-agent, appending structured context and schema
   * requirements if provided. When `schema` is set, the sub-agent is instructed to
   * respond ONLY with a JSON object matching the schema — no prose, no markdown fences.
   *
   * Context size is capped at MAX_CONTEXT_CHARS to prevent prompt explosion when
   * upstream agents return raw file contents instead of distilled summaries.
   * Claude Code's own guidance: sub-agents should return 1k-2k token summaries, not raw data.
   */
  private buildPrompt(options: WorkflowAgentRunOptions): string {
    // ~20k chars ≈ 5k tokens — enough for rich structured summaries, hard cap against raw-content blowup
    const MAX_CONTEXT_CHARS = 20000;

    let prompt = options.prompt;

    // Append structured context from previous steps
    if (options.context !== undefined && options.context !== null) {
      let contextJson = JSON.stringify(options.context, null, 2);
      if (contextJson.length > MAX_CONTEXT_CHARS) {
        const originalLen = contextJson.length;
        contextJson = contextJson.slice(0, MAX_CONTEXT_CHARS);
        // Trim to last complete line to avoid broken JSON mid-string
        const lastNewline = contextJson.lastIndexOf('\n');
        if (lastNewline > MAX_CONTEXT_CHARS * 0.8) {
          contextJson = contextJson.slice(0, lastNewline);
        }
        contextJson += `\n... [context truncated: ${originalLen} chars → ${MAX_CONTEXT_CHARS} chars max. Sub-agents should return distilled JSON summaries, not raw file contents.]`;
        console.warn(`[WorkflowAgentBridge] context truncated from ${originalLen} to ${MAX_CONTEXT_CHARS} chars for agent: "${options.label ?? options.prompt.slice(0, 60)}"`);
      }
      prompt += `\n\n<workflow_context>\n${contextJson}\n</workflow_context>`;
    }

    // Append schema constraint — force structured JSON output
    if (options.schema) {
      const schemaJson = JSON.stringify(options.schema, null, 2);
      prompt += `\n\n<output_schema>\nYou MUST respond with ONLY a valid JSON object matching this schema. No prose, no markdown fences, no explanation — raw JSON only:\n${schemaJson}\n</output_schema>`;
    }

    return prompt;
  }

  private resolveAgentDefinition(agentType: string, maxTurns: number) {
    const allTools = this.toolRegistry.getAllTools();
    const def = getBuiltInAgentDefinition(agentType, [], maxTurns);
    if (!def) {
      throw new Error(`Unknown agent_type: "${agentType}"`);
    }
    const availableToolNames = resolveAgentTools(def, allTools).resolvedTools.map(t => t.name);
    return getBuiltInAgentDefinition(agentType, availableToolNames, maxTurns)!;
  }

  private buildFilteredRegistry(agentDefinition: ReturnType<typeof getBuiltInAgentDefinition>) {
    const filteredRegistry = new ToolRegistry(this.config);
    const allTools = this.toolRegistry.getAllTools();
    const resolved = resolveAgentTools(agentDefinition!, allTools);
    resolved.resolvedTools.forEach(tool => filteredRegistry.registerTool(tool));
    return filteredRegistry;
  }
}
