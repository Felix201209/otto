/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/EasyCode
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure helpers for the Feishu "explicit dispatch" track: deciding when an
 * incoming message should be forcibly delegated to an external agent
 * (Claude Code or Codex), and building the directive that forces Otto's
 * agent loop to call the `delegate_to_agent` tool with the right
 * `agent` argument.
 *
 * Kept free of any Feishu/runtime dependencies so it can be unit-tested in
 * isolation (the surrounding feishuCommand module is too large to exercise).
 */

/** External agents that a Feishu chat can be routed to. `self` means Otto. */
export type FeishuAgentTarget = 'self' | 'claude-code' | 'codex';

/** Subset of agents that map to the ACP delegate path. */
export type FeishuDelegateAgent = Exclude<FeishuAgentTarget, 'self'>;

/**
 * Leading prefixes that force per-message delegation. The matched `target`
 * group selects which external agent to route to. Both groups are mutually
 * exclusive — exactly one of them captures.
 */
const DELEGATE_PREFIX_RE =
  /^[@/](?:(?<cc>cc|claudecode|claude-code)|(?<cdx>codex|cdx))(?=$|[\s:：])[\s:：]*/i;

const AGENT_LABELS: Record<FeishuDelegateAgent, string> = {
  'claude-code': '本机 Claude Code',
  'codex': '本机 Codex',
};

const SELF_LABEL = 'Otto 自己';

/** Stable identifiers for the agents accepted by `--agent` / `-a`. */
const BIND_AGENT_ALIASES: Record<string, FeishuAgentTarget> = {
  self: 'self',
  'claude-code': 'claude-code',
  claudecode: 'claude-code',
  cc: 'claude-code',
  codex: 'codex',
  cdx: 'codex',
};

export interface DelegationDecision {
  /** Whether this message should be delegated to an external agent. */
  delegate: boolean;
  /** Target agent when delegating. */
  agent: FeishuDelegateAgent;
  /** The task text to hand off (prefix stripped). */
  task: string;
  /** Why we decided to delegate ('prefix' | 'route' | 'none'). */
  reason: 'prefix' | 'route' | 'none';
  /**
   * Native session id to resume, when the message used the
   * `resume <sessionId> <task>` sub-syntax (e.g. `@cc:resume abc123 继续`).
   */
  resumeSessionId?: string;
}

/**
 * Sub-syntax for resuming a session: `resume <sessionId> <rest of task>`.
 * Applied AFTER the delegation prefix is stripped. The session id is the first
 * whitespace-delimited token; everything after it is the task.
 */
const RESUME_RE = /^resume\s+(\S+)\s*([\s\S]*)$/i;

/**
 * Split a `resume <id> <task>` task string into its parts. Returns the resume
 * session id (if present) and the remaining task text.
 */
export function parseResumeTask(task: string): {
  resumeSessionId?: string;
  task: string;
} {
  const m = (task ?? '').match(RESUME_RE);
  if (!m) return { task: (task ?? '').trim() };
  return { resumeSessionId: m[1], task: (m[2] ?? '').trim() };
}

export interface DelegatePrefixMatch {
  /** True iff a delegation prefix matched at the start of the input. */
  matched: boolean;
  /** Which agent the prefix selected. Only meaningful when matched=true. */
  agent: FeishuDelegateAgent;
  /** The remaining task text with the prefix stripped. */
  task: string;
}

/**
 * Strip a leading `@cc` / `@codex` (and aliases) delegation prefix.
 * Returns whether it matched, which agent it selected, and the remaining
 * task text.
 */
export function parseDelegatePrefix(text: string): DelegatePrefixMatch {
  const raw = text ?? '';
  const m = raw.match(DELEGATE_PREFIX_RE);
  if (!m) return { matched: false, agent: 'claude-code', task: raw.trim() };
  const agent: FeishuDelegateAgent = m.groups?.cdx ? 'codex' : 'claude-code';
  return { matched: true, agent, task: raw.slice(m[0].length).trim() };
}

/** Max age (ms) for an auto-resume: sessions older than this start fresh. */
export const SESSION_RESUME_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Decide whether to delegate, combining the per-message prefix (highest
 * priority) with the chat's default agent route.
 *
 * When routing via the chat's default agent, `lastSessionId` is only
 * auto-injected when the session is recent (within SESSION_RESUME_WINDOW_MS),
 * so the external agent retains conversation context in a continuous chat
 * without getting stuck on stale sessions. Explicit `resume <id>` always
 * takes precedence over the auto-resume.
 */
export function resolveDelegation(
  text: string,
  defaultAgent?: FeishuAgentTarget,
  lastSessionId?: string,
  lastSessionAt?: number,
): DelegationDecision {
  const prefix = parseDelegatePrefix(text);
  if (prefix.matched) {
    const { resumeSessionId, task } = parseResumeTask(prefix.task);
    return {
      delegate: true,
      agent: prefix.agent,
      task,
      reason: 'prefix',
      resumeSessionId,
    };
  }
  if (defaultAgent === 'claude-code' || defaultAgent === 'codex') {
    const { resumeSessionId, task } = parseResumeTask((text ?? '').trim());
    // Only auto-resume if the session is recent (within the time window).
    // Explicit resume (user typed "resume <id>") always wins.
    const shouldAutoResume =
      lastSessionId &&
      lastSessionAt &&
      (Date.now() - lastSessionAt < SESSION_RESUME_WINDOW_MS);
    return {
      delegate: true,
      agent: defaultAgent,
      task,
      reason: 'route',
      resumeSessionId: resumeSessionId || (shouldAutoResume ? lastSessionId : undefined),
    };
  }
  return {
    delegate: false,
    agent: 'claude-code',
    task: (text ?? '').trim(),
    reason: 'none',
  };
}

/** Execution mode forwarded to the delegate tool's `mode` parameter. */
export type DelegateDirectiveMode = 'stream' | 'background';

/**
 * Build the message handed to Otto's agent loop so it is forced to
 * delegate via the `delegate_to_agent` tool with the correct `agent`
 * and `mode` arguments. The tool's streaming output then flows to the Feishu
 * card unchanged.
 *
 * Default mode is `'stream'` — explicit `@cc` / `@codex` prefix and
 * `/bind --agent` route triggers indicate the user wants to watch the agent
 * work in real time, not fire-and-forget. Background dispatch is reserved
 * for the AI's own judgement on natural-language requests.
 */
export function buildDelegateDirective(
  task: string,
  agent: FeishuDelegateAgent = 'claude-code',
  mode: DelegateDirectiveMode = 'stream',
  resumeSessionId?: string,
): string {
  const label = agent === 'codex' ? 'Codex' : 'Claude Code';
  const modeHint =
    mode === 'stream'
      ? '同步流式执行（用户要看到全过程）'
      : '后台异步执行（完成后通知用户）';
  const resumeArg = resumeSessionId
    ? `，resumeSessionId="${resumeSessionId}"（续接已有会话）`
    : '';
  const resumeNote = resumeSessionId
    ? `本次为续接历史会话（sessionId=${resumeSessionId}），${label} 会先恢复该会话的完整上下文再执行。`
    : '';
  return [
    `【强制派发指令】用户要求将以下任务交给本机的 ${label} 执行（${modeHint}）。`,
    resumeNote,
    `你必须立即调用 delegate_to_agent 工具，参数：agent="${agent}"，mode="${mode}"${resumeArg}，task 填写下面的完整原文。`,
    '不要自己动手处理这个任务，也不要追问，直接派发：',
    '',
    task,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Parse the optional `--agent <self|claude-code|codex>` flag (or `-a`,
 * `--agent=value`) out of a `/bind` command argument string. Returns the
 * recognized agent (if any) and the remaining tokens with the flag removed
 * (so the path argument can still be parsed). Unknown values are silently
 * ignored (the value token is still consumed, so it can't leak into the
 * path).
 */
export function parseBindAgentFlag(argString: string): {
  agent?: FeishuAgentTarget;
  rest: string;
} {
  const tokens = (argString ?? '').split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let agent: FeishuAgentTarget | undefined;

  const recognize = (raw: string | undefined): FeishuAgentTarget | undefined => {
    const v = (raw ?? '').toLowerCase();
    return BIND_AGENT_ALIASES[v];
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--agent' || t === '-a') {
      const matched = recognize(tokens[i + 1]);
      i++; // always consume the value token, even if invalid
      if (matched) agent = matched;
      continue;
    }
    const inline = t.match(/^--agent=(\S+)$/i);
    if (inline) {
      const matched = recognize(inline[1]);
      if (matched) agent = matched;
      continue;
    }
    out.push(t);
  }
  return { agent, rest: out.join(' ') };
}

/** Human-readable label for a chat's default-agent setting. */
export function agentDisplayLabel(agent: FeishuAgentTarget | undefined): string {
  if (agent && agent !== 'self') return AGENT_LABELS[agent];
  return SELF_LABEL;
}
