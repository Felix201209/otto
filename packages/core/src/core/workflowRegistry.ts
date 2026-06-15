/**
 * WorkflowRegistry — in-memory store for all workflow runs in the current session.
 * Singleton so WorkflowTool, WorkflowAgentBridge, and the /workflow panel all share state.
 */

export type WorkflowStatus = 'running' | 'completed' | 'failed';
export type AgentStatus = 'running' | 'completed' | 'failed';

export interface WorkflowAgentRecord {
  agentId: string;
  /** Short label shown in the UI, e.g. "代码质量审查 (retry 5)" */
  label: string;
  prompt: string;
  model?: string;
  status: AgentStatus;
  startTime: number;
  endTime?: number;
  tokenUsage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  toolCallCount: number;
  /** Last N tool calls for the Activity section */
  recentToolCalls: string[];
  /** Current activity phase: waiting for AI response vs executing tools */
  currentPhase?: 'thinking' | 'executing_tools';
  /** Final output / error message */
  outcome?: string;
}

export interface WorkflowPhaseRecord {
  /** Phase index (0-based) */
  index: number;
  name: string;
  description: string;
  agents: WorkflowAgentRecord[];
}

export interface WorkflowRecord {
  id: string;
  /** Short slug derived from description, e.g. "test-coverage-audit" */
  slug: string;
  description: string;
  status: WorkflowStatus;
  startTime: number;
  endTime?: number;
  totalTokenUsage: { inputTokens: number; outputTokens: number; totalTokens: number };
  phases: WorkflowPhaseRecord[];
  /** Fallback flat agent list when no phase info is available */
  agents: WorkflowAgentRecord[];
}

// ─── Singleton store ──────────────────────────────────────────────────────────

const records: WorkflowRecord[] = [];
let listeners: Array<() => void> = [];

// Debounced notify: high-frequency updates (token/tool-call) are batched to max once per 150ms
let _notifyTimer: ReturnType<typeof setTimeout> | null = null;

function notify(immediate = false) {
  if (immediate) {
    if (_notifyTimer) { clearTimeout(_notifyTimer); _notifyTimer = null; }
    listeners.forEach(fn => fn());
    return;
  }
  if (!_notifyTimer) {
    _notifyTimer = setTimeout(() => {
      _notifyTimer = null;
      listeners.forEach(fn => fn());
    }, 150);
  }
}

export const WorkflowRegistry = {
  // ── Read ────────────────────────────────────────────────────────────────────

  getAll(): WorkflowRecord[] {
    return records;
  },

  getById(id: string): WorkflowRecord | undefined {
    return records.find(r => r.id === id);
  },

  // ── Write ───────────────────────────────────────────────────────────────────

  startWorkflow(id: string, description: string, phases: Array<{ name: string; description: string }>): void {
    const slug = description
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);

    records.push({
      id,
      slug,
      description,
      status: 'running',
      startTime: Date.now(),
      totalTokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      phases: phases.map((p, i) => ({ index: i, name: p.name, description: p.description, agents: [] })),
      agents: [],
    });
    // Keep at most 50 records to prevent unbounded memory growth in long sessions
    if (records.length > 50) records.splice(0, records.length - 50);
    notify(true);  // immediate: workflow started
  },

  endWorkflow(
    id: string,
    status: 'completed' | 'failed',
    tokenUsage?: { inputTokens: number; outputTokens: number; totalTokens: number },
  ): void {
    const r = records.find(r => r.id === id);
    if (!r) return;
    r.status = status;
    r.endTime = Date.now();
    if (tokenUsage) {
      r.totalTokenUsage = tokenUsage;
    }
    // Trim stored data for completed/failed workflows to prevent memory accumulation.
    // Keep only metadata (agentId, label, status, times, token counts, tool call counts).
    // Truncate prompt and outcome text to 500 chars, and clear recentToolCalls.
    trimAgentData(r);
    notify(true);  // immediate: workflow ended
  },

  startAgent(workflowId: string, agentId: string, label: string, prompt: string, model?: string, phaseIndex?: number): void {
    const r = records.find(r => r.id === workflowId);
    if (!r) return;

    const agent: WorkflowAgentRecord = {
      agentId,
      label,
      prompt,
      model,
      status: 'running',
      startTime: Date.now(),
      tokenUsage: undefined,
      toolCallCount: 0,
      recentToolCalls: [],
    };

    // If explicit phaseIndex provided, use it directly
    if (phaseIndex !== undefined && r.phases[phaseIndex]) {
      r.phases[phaseIndex]!.agents.push(agent);
    } else if (r.phases.length > 0) {
      // Fallback: first phase with no agents yet, then last phase
      const target = r.phases.find(p => p.agents.length === 0) ?? r.phases[r.phases.length - 1]!;
      target.agents.push(agent);
    } else {
      r.agents.push(agent);
    }
    notify(true);  // immediate: new agent appeared
  },

  updateAgentTokens(
    workflowId: string,
    agentId: string,
    tokenUsage: { inputTokens: number; outputTokens: number; totalTokens: number },
  ): void {
    const agent = findAgent(workflowId, agentId);
    if (!agent) return;
    agent.tokenUsage = tokenUsage;
    notify();  // debounced: high-frequency token updates
  },

  updateAgentToolCall(workflowId: string, agentId: string, toolCallSummary: string): void {
    const agent = findAgent(workflowId, agentId);
    if (!agent) return;
    agent.toolCallCount++;
    agent.recentToolCalls.push(toolCallSummary);
    if (agent.recentToolCalls.length > 5) agent.recentToolCalls.shift();
    agent.currentPhase = 'executing_tools';
    notify();  // debounced: high-frequency tool-call updates
  },

  updateAgentPhase(workflowId: string, agentId: string, phase: 'thinking' | 'executing_tools'): void {
    const agent = findAgent(workflowId, agentId);
    if (!agent) return;
    agent.currentPhase = phase;
    notify();
  },

  endAgent(
    workflowId: string,
    agentId: string,
    status: AgentStatus,
    outcome?: string,
    tokenUsage?: { inputTokens: number; outputTokens: number; totalTokens: number },
  ): void {
    const agent = findAgent(workflowId, agentId);
    if (!agent) return;
    agent.status = status;
    agent.endTime = Date.now();
    agent.outcome = outcome;
    agent.tokenUsage = tokenUsage;

    // Accumulate tokens into workflow total
    const r = records.find(r => r.id === workflowId);
    if (r && tokenUsage) {
      r.totalTokenUsage.inputTokens += tokenUsage.inputTokens;
      r.totalTokenUsage.outputTokens += tokenUsage.outputTokens;
      r.totalTokenUsage.totalTokens += tokenUsage.totalTokens;
    }
    notify(true);  // immediate: agent ended
  },

  clear(): void {
    records.length = 0;
    notify(true);
  },

  // ── Reactivity ──────────────────────────────────────────────────────────────

  subscribe(fn: () => void): () => void {
    listeners.push(fn);
    return () => { listeners = listeners.filter(l => l !== fn); };
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function findAgent(workflowId: string, agentId: string): WorkflowAgentRecord | undefined {
  const r = records.find(r => r.id === workflowId);
  if (!r) return undefined;
  for (const phase of r.phases) {
    const a = phase.agents.find(a => a.agentId === agentId);
    if (a) return a;
  }
  return r.agents.find(a => a.agentId === agentId);
}

/**
 * Trim stored agent data for a completed/failed workflow to prevent memory
 * accumulation in long-running sessions. Truncates prompt and outcome text
 * to a reasonable length and clears detailed tool call logs.
 */
const MAX_TRIMMED_TEXT_LENGTH = 500;

function trimAgentData(record: WorkflowRecord): void {
  const allAgents = record.phases.length
    ? record.phases.flatMap(p => p.agents)
    : record.agents;

  for (const agent of allAgents) {
    if (agent.prompt && agent.prompt.length > MAX_TRIMMED_TEXT_LENGTH) {
      agent.prompt = agent.prompt.slice(0, MAX_TRIMMED_TEXT_LENGTH) + '…[trimmed]';
    }
    if (agent.outcome && agent.outcome.length > MAX_TRIMMED_TEXT_LENGTH) {
      agent.outcome = agent.outcome.slice(0, MAX_TRIMMED_TEXT_LENGTH) + '…[trimmed]';
    }
    agent.recentToolCalls = []; // Clear once workflow is done — no longer needed
  }
}
