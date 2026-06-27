/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';
import type { Config } from 'otto-core';

/**
 * useGoalActive — whether the current session has an active /goal context.
 *
 * Why a hook (vs. a plain getter):
 *   OttoClient.activeGoalContext is plain in-memory state, not React
 *   state. Setting / clearing it (via useGoalWizard or the /goal clear
 *   command) does NOT trigger App.tsx to re-render. We need the bottom
 *   status bar to flip between the GoalActiveIndicator and the
 *   YOLO/AUTO_EDIT indicator within a second of the user's action — so
 *   we install a 1-Hz heartbeat that polls the client.
 *
 *   1Hz is plenty: goal start/clear are coarse events, and any
 *   sub-second flicker would be noise. Same cadence as
 *   GoalActiveIndicator's elapsed-counter heartbeat — they don't share
 *   the timer to keep concerns isolated and to avoid one being torn
 *   down before the other.
 *
 * Returns boolean only; if you need the goal context object itself,
 * read it directly from `config.getOttoClient().getGoalContext()`
 * inside the consuming component (also re-evaluated each render).
 */
export function useGoalActive(config: Config | null): boolean {
  const [active, setActive] = useState<boolean>(() => readGoalActive(config));

  useEffect(() => {
    // Re-read immediately on mount/config-change so we don't wait a full
    // second to display the indicator after a fresh /goal launch.
    setActive(readGoalActive(config));
    const id = setInterval(() => {
      setActive(readGoalActive(config));
    }, 1000);
    return () => clearInterval(id);
  }, [config]);

  return active;
}

function readGoalActive(config: Config | null): boolean {
  if (!config) return false;
  try {
    return !!config.getOttoClient()?.getGoalContext();
  } catch {
    return false;
  }
}
