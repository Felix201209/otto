/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * GoalAchievedDisplayRenderer (webview) — VSCode UI plugin equivalent of
 * the CLI Ink renderer with the same name. Renders a bordered "completion
 * card" when the model calls the `goal_achieved` tool.
 *
 * Why this needs custom rendering (not the default tool-result row):
 *   The default tool-call expand-panel shows result.data as a compact
 *   <pre> JSON dump — fine for routine ops, useless for a "long task is
 *   formally complete, here is my reasoning" moment that the user
 *   actually wants to read. The model is told to "逐条说明 each
 *   criterion" in `reason`, so the text is often multi-paragraph.
 *
 * Design choices:
 *   - Green-accent left border + soft green background, matching VSCode
 *     theme tokens (`--vscode-charts-green`, `--vscode-textBlockQuote-*`).
 *   - "✓ Goal Achieved" header, bold.
 *   - `reason` rendered with `white-space: pre-wrap` inside a <pre>-like
 *     block so paragraph breaks survive verbatim. We don't run it through
 *     a markdown component because (a) the model's reason is plain prose,
 *     not formatted markdown, and (b) using a markdown renderer here
 *     would couple this card to whatever quirks (heading sizes, code
 *     blocks) the markdown component has.
 *   - Mirrors `TodoDisplayRenderer.tsx` layout conventions but with
 *     "card" semantics (single-shot announcement) instead of "list".
 */

import React from 'react';
import './GoalAchievedDisplayRenderer.css';

interface GoalAchievedDisplay {
  type: 'goal_achieved_display';
  reason: string;
}

interface GoalAchievedDisplayRendererProps {
  data: GoalAchievedDisplay;
}

const GoalAchievedIcon: React.FC = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill="none"
    aria-hidden="true"
    className="goal-achieved-header-icon"
  >
    <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
    <path
      d="M5 8.5L7 10.5L11 6"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const GoalAchievedDisplayRenderer: React.FC<GoalAchievedDisplayRendererProps> = React.memo(
  ({ data }) => {
    const reason = data.reason ?? '';

    return (
      <div className="goal-achieved-card">
        <div className="goal-achieved-header">
          <GoalAchievedIcon />
          <span className="goal-achieved-title">Goal Achieved</span>
        </div>
        <div className="goal-achieved-body">
          {/* <pre> + pre-wrap preserves the model's paragraph structure
              verbatim while still wrapping long lines that exceed the
              card width. Don't replace this with markdown rendering —
              the field is plain prose by design. */}
          <pre className="goal-achieved-reason">{reason}</pre>
        </div>
      </div>
    );
  },
);

GoalAchievedDisplayRenderer.displayName = 'GoalAchievedDisplayRenderer';
