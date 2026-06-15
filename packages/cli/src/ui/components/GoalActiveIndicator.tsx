/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import type { Config } from 'otto-core';
import { Colors } from '../colors.js';
import { useStreamingContext } from '../contexts/StreamingContext.js';
import { StreamingState } from '../types.js';

/**
 * GoalActiveIndicator — bottom-status-bar indicator shown while /goal mode
 * is active.
 *
 * Replaces the YOLO/AUTO_EDIT indicator while goal is running, because
 * /goal force-enables YOLO mode anyway — showing "YOLO mode (ctrl+y)" in
 * that state would be redundant and would hide the more important fact
 * that an autonomous long-running task is in progress.
 *
 * ## Pause-on-idle behavior
 *
 * The elapsed counter is intentionally paused while the agent is idle
 * (i.e. `streamingState === Idle`):
 *
 *   - When idle, we DO NOT install the 1-Hz heartbeat — no setInterval,
 *     no re-render, no Date.now() reads. The displayed elapsed value
 *     freezes at whatever was shown the moment idle started.
 *   - When the user sends a new message and the agent resumes
 *     (Responding / WaitingForConfirmation), the heartbeat restarts and
 *     the counter jumps to "now − T0" — which naturally accounts for the
 *     wall-clock time that passed during idle. We are NOT trying to show
 *     "active time only"; we just stop redrawing while there's no agent
 *     activity to reflect.
 *
 * Why not "active time only" semantics?
 *   The /goal contract gives the model a wall-clock elapsed = now − T0
 *   (the model verifies via local_time). Changing the indicator to show
 *   accumulated-active time would desync the user-visible counter from
 *   what the model itself computes. Pausing redraws (without changing
 *   the math) keeps both views consistent: when the agent next computes
 *   elapsed, the indicator immediately catches up.
 *
 * Why pause redraws at all?
 *   Idle is normally just "waiting for user input" — re-rendering this
 *   tiny element once a second is cheap, but Ink redraws the full
 *   bottom-bar row, which causes terminal flicker on slow connections
 *   and wastes cycles. Stopping the heartbeat eliminates that.
 *
 * Heartbeat (when active):
 *   The goal context lives inside GeminiClient as a plain in-memory field
 *   (GeminiClient.activeGoalContext) — not React state — so React has no
 *   way to know when its `startedAt` advances into a new "elapsed = N
 *   seconds" tick. We force a re-render once per second via a local
 *   `tick` state. Same pattern LoadingIndicator uses for its elapsed
 *   counter.
 */

interface GoalActiveIndicatorProps {
  config: Config | null;
}

export const GoalActiveIndicator: React.FC<GoalActiveIndicatorProps> = ({
  config,
}) => {
  // ⚠️ HOOK ORDER RULE — all hooks (useState, useEffect, useRef, useContext)
  // MUST be called unconditionally at the top of this function, BEFORE any
  // conditional return. React tracks hooks by call order; if an early
  // `return null` skips a later `useRef`/`useState`, on the next render
  // when the early-return condition flips, React sees a different number
  // of hooks and throws "Rendered fewer hooks than expected" — crashing
  // the whole CLI. (We hit this once already on 2026-05-22; please don't
  // refactor any hook below the `if (!ctx)` guard.)
  const streamingState = useStreamingContext();
  const isAgentActive = streamingState !== StreamingState.Idle;

  // Heartbeat — bumped once per second to refresh the elapsed counter,
  // ONLY while the agent is active. Switching to idle tears down the
  // interval (cleanup of the previous useEffect run) and freezes the
  // display at whatever was last rendered.
  //
  // `useEffect`'s dependency on `isAgentActive` is what gives us the
  // start/stop behavior for free: when the boolean flips, React runs
  // cleanup → re-runs effect → either installs or skips the interval.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!isAgentActive) return;
    const id = setInterval(() => setTick((n) => (n + 1) % 1_000_000), 1000);
    return () => clearInterval(id);
  }, [isAgentActive]);

  // Cache for the last rendered elapsed value. Used to FREEZE the display
  // while the agent is idle (no heartbeat → no Date.now() refresh), so
  // that an unrelated sibling re-render doesn't make the counter visibly
  // jump forward during idle. Must be declared at the top alongside the
  // other hooks (see HOOK ORDER RULE above).
  const cachedElapsedRef = useRef<number | null>(null);

  // Read goal context every render. If unavailable (client not ready, or
  // the user just /goal clear'd), render nothing — App.tsx handles the
  // fallback to the YOLO/AUTO_EDIT indicator via useGoalActive().
  // This conditional read DOES NOT use any hook, so it's safe here.
  let ctx: { startedAt: number; hours: number } | null = null;
  try {
    ctx = config?.getGeminiClient()?.getGoalContext() ?? null;
  } catch {
    ctx = null;
  }

  // ⚠️ This early return MUST come AFTER all hook calls above. Adding any
  // hook below this line will crash the CLI as soon as goal mode toggles.
  if (!ctx) return null;

  // Compute the elapsed value. While idle, we want the LAST active value
  // (frozen). The heartbeat won't fire — but Date.now() would still tick
  // forward across normal re-renders triggered by sibling state changes,
  // which would defeat the freeze. So we cache the value in a ref:
  //
  //   - while active: recompute every tick, refresh the cache
  //   - while idle:   ignore Date.now(), reuse the cached value
  //
  // First-render edge case: if the component mounts already in idle
  // (rare — would mean goal got registered without an active turn),
  // there's no cached value yet. Fall back to the live elapsed for that
  // single render so we don't display nothing or garbage; subsequent
  // renders will have the cache populated.
  let elapsedMs: number;
  if (isAgentActive) {
    elapsedMs = Date.now() - ctx.startedAt;
    cachedElapsedRef.current = elapsedMs;
  } else if (cachedElapsedRef.current != null) {
    elapsedMs = cachedElapsedRef.current;
  } else {
    elapsedMs = Date.now() - ctx.startedAt;
    cachedElapsedRef.current = elapsedMs;
  }

  const label = formatElapsed(elapsedMs);

  return (
    <Box>
      <Text color={Colors.AccentPurple} dimColor>
        ◎ /goal active
      </Text>
      <Text color={Colors.Gray}>{` (${label})`}</Text>
    </Box>
  );
};

/**
 * Format an elapsed-milliseconds value into a compact bottom-bar label.
 *
 *   < 60s   →  "45s"
 *   < 60m   →  "12m 34s"
 *   ≥ 60m   →  "2h 13m"
 *
 * Negative values (clock skew, system time set backwards) clamp to "0s"
 * so the display never shows nonsense like "-3s".
 */
export function formatElapsed(elapsedMs: number): string {
  const totalSec = Math.max(0, Math.floor(elapsedMs / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) {
    const sec = totalSec % 60;
    return `${totalMin}m ${sec}s`;
  }
  const hours = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return `${hours}h ${min}m`;
}
