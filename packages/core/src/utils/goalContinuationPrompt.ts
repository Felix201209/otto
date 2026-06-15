/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Goal-mode context restoration after auto-compression.
 *
 * Background:
 *   /goal mode submits a long contract prompt as a regular user message.
 *   Auto-compression (tryCompressChat) replaces the bulk of conversation
 *   history with an LLM-generated summary, which often loses or weakens
 *   the goal contract — minimum-hours floor, no-stop discipline, T0
 *   timestamp, safety rails — exactly the things /goal exists to enforce.
 *
 *   Symptom: after compression, the agent says "let me continue" and
 *   then halts after a couple of trivial tool calls, because it no
 *   longer "sees" the contract.
 *
 * Fix:
 *   GeminiClient holds an in-memory `activeGoalContext` set when /goal
 *   is launched. After every compression cycle, if a goal is active,
 *   we re-inject the original prompt verbatim plus a meta header that:
 *     1. tells the model it just went through compression,
 *     2. anchors it to the precise T0 we recorded server-side,
 *     3. requires it to immediately call local_time and decide whether
 *        to continue based on elapsed vs the contract.
 *
 * This module is pure / dependency-free so it can be imported from any
 * surface (core compression path, future hooks, tests).
 */

/**
 * Goal context retained in GeminiClient memory for the lifetime of a
 * /goal session.
 *
 * NOT persisted to disk — process exit clears it intentionally; a fresh
 * process has no continuous "elapsed since T0" semantics anyway.
 */
export interface GoalContext {
  /**
   * The full prompt originally produced by `buildGoalPrompt(...)` and
   * submitted to the model when /goal launched. Re-injected verbatim
   * after each compression so the contract never decays.
   */
  originalPrompt: string;

  /**
   * T0 — `Date.now()` captured when the user clicked "start" in the
   * goal wizard. Authoritative source of truth for elapsed-time checks
   * (the model is told to compute `now - T0` via the `local_time` tool).
   */
  startedAt: number;

  /**
   * Minimum continuous-work hours from the wizard. Echoed back in the
   * continuation prompt so the model can re-check the floor immediately.
   */
  hours: number;

  /**
   * Short task label for logging / future UI surfacing. Not currently
   * embedded in the continuation prompt itself (the original prompt
   * already carries the full task description).
   */
  task: string;

  /**
   * Objective completion criteria from the wizard.
   */
  criteria?: string;

  /**
   * Forbidden/sensitive actions from the wizard.
   */
  forbidden?: string;
}

/**
 * Loop context retained in GeminiClient memory for the lifetime of a
 * /loop session.
 */
export interface LoopContext {
  /**
   * The raw prompt or slash command to be executed at each interval.
   */
  prompt: string;

  /**
   * The time interval in milliseconds between runs.
   */
  intervalMs: number;

  /**
   * The expiration timestamp (Date.now() + duration), after which the loop ceases.
   */
  expiresAt: number;

  /**
   * The creation timestamp of this loop task.
   */
  startedAt: number;

  /**
   * The timestamp when this loop last started execution.
   */
  lastRunAt: number;

  /**
   * Whether there is a pending run waiting for the model to become idle.
   */
  isPendingRun: boolean;
}

/**
 * Format a millisecond epoch as a dual-locale anchor string for prompt
 * injection: ISO-8601 UTC + a local-time rendering. Both are included
 * because models occasionally mishandle timezone math; giving them both
 * forms removes ambiguity.
 *
 * Example output:
 *   "2026-05-22T10:30:00.000Z  (local: 2026-05-22 18:30:00 +08:00)"
 */
function formatT0(epochMs: number): string {
  const d = new Date(epochMs);
  const iso = d.toISOString();

  // Local-side rendering, padded to 2 digits.
  const pad = (n: number) => String(n).padStart(2, '0');
  const local = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

  // Timezone offset like "+08:00" / "-05:00".
  const tzOffsetMin = -d.getTimezoneOffset(); // getTimezoneOffset returns minutes WEST of UTC
  const tzSign = tzOffsetMin >= 0 ? '+' : '-';
  const tzAbs = Math.abs(tzOffsetMin);
  const tzStr = `${tzSign}${pad(Math.floor(tzAbs / 60))}:${pad(tzAbs % 60)}`;

  return `${iso}  (local: ${local} ${tzStr})`;
}

/**
 * Build the user message re-injected after compression. Returns the
 * raw text (caller wraps in a `{ role: 'user', parts: [{ text }] }`).
 *
 * Structure:
 *   1. Header — explains the compression event and why we're re-sending.
 *   2. The verbatim original goal prompt, fenced.
 *   3. Time anchor block — precise T0 + hours floor.
 *   4. Immediate-action checklist — forces a local_time call instead of
 *      a vague "let me continue" reply.
 */
export function buildGoalContinuationMessage(ctx: GoalContext): string {
  const t0Display = formatT0(ctx.startedAt);

  return `[Goal Mode Context Restoration — Post-Compression]

你刚刚经历了一次自动上下文压缩。压缩可能让你丢失了 /goal 模式的契约细节，
现在重新向你完整展示最初的 goal 描述。请严格按照该契约继续推进任务，
不要因为"对话被截断"或"summary 看起来已经收尾"而误判任务结束。
压缩只是工程层的历史裁剪，与任务进度无关。

────────────────────────────────────────────────────────
【原始 Goal Prompt（完整重发，逐字保留）】
────────────────────────────────────────────────────────
${ctx.originalPrompt}
────────────────────────────────────────────────────────

【关键时间锚点（由系统精确记录，不要再"估算"）】
- 本次 goal 任务的起始时间 T0：${t0Display}
- 最低工作时长下限：${ctx.hours} 小时

【你现在必须立即执行（不要先输出"让我继续"之类的客套话）】
1. 调用 local_time 工具拿到当前时间 now。
2. 计算 elapsed = now - T0，明确告诉用户已工作多少分钟/小时。
3. 对照原始 prompt 中的"达标特征"，判断收尾条件：
   - 收尾条件 A（提前完成）：所有达标特征都已客观满足 → 调用 goal_achieved 工具（reason 逐条说明达标证据），不要只是用文字宣布完成。
   - 收尾条件 B（达标 + 达时）：所有达标特征都已客观满足 且 elapsed ≥ ${ctx.hours} 小时 → 同样调用 goal_achieved。
   - 都不满足：立即继续推进任务清单（先用 todo_write 查看当前进度），不要停。
4. 不要把"压缩刚发生"当作收尾理由。压缩不会让任务自动完成，也不会缩短最低工时。

现在开始：先调 local_time，再继续干活。`;
}

/**
 * Build the user message injected when the user manually runs `/goal clear`.
 *
 * Purpose:
 *   /goal contract has a hard "no-stop until criteria met OR floor reached"
 *   discipline. If the user wants to abort the goal (e.g. priorities change,
 *   they're satisfied with intermediate results), they need a way to tell
 *   the model "stand down" — otherwise the model will keep pushing per
 *   contract, ignoring the user's casual "ok let's stop" because the
 *   contract explicitly tells it not to trust such phrasing.
 *
 * Contract semantics:
 *   - The minimum-hours floor and the no-stop discipline are CANCELLED.
 *   - System safety rails (no rm -rf, no PowerShell, etc.) STAY ON — those
 *     are independent of goal mode and should never be relaxed.
 *   - The model should NOT silently swap into an unrelated topic or
 *     pre-emptively summarize prior work; it just stops pushing the
 *     goal-driven agenda and waits for the user's next instruction.
 *
 * Caller must pair this with `GeminiClient.clearGoalContext()` so that
 * subsequent compressions don't re-inject the original goal prompt.
 */
export function buildGoalClearMessage(): string {
  return `[Goal Mode Cleared by User]

用户刚刚执行了 /goal clear 命令，主动结束了本次目标驱动模式。从此刻起：

1. 最低工作时长下限作废：你不再受"必须工作到 elapsed ≥ N 小时"约束。
2. "no-stop 纪律"作废：你不再被原契约要求继续深挖、加固、扩展。
3. "达标特征"未满足也无需继续推进——用户已主动终止，不视为任务失败。
4. 系统硬红线（禁止 rm -rf、禁止 PowerShell、禁止批量杀 node 进程等）继续生效，
   与本次清理无关；任何后续工作都仍要遵守。
5. 不要做"收尾汇总"之类未被请求的工作，也不要切换到无关话题。
   只需简短确认收到清理指令，然后等待用户下一步指令即可。

请用一句话确认你已切回普通对话模式，然后停下等待用户后续输入。`;
}
