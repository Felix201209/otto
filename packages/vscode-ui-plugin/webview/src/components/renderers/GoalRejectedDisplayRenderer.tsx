/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import './GoalRejectedDisplayRenderer.css';

interface GoalRejectedDisplay {
  type: 'goal_rejected_display';
  feedback: string;
}

interface GoalRejectedDisplayRendererProps {
  data: GoalRejectedDisplay;
}

const GoalRejectedIcon: React.FC = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill="none"
    aria-hidden="true"
    className="goal-rejected-header-icon"
  >
    <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
    <path
      d="M5 5L11 11M11 5L5 11"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const GoalRejectedDisplayRenderer: React.FC<GoalRejectedDisplayRendererProps> = React.memo(
  ({ data }) => {
    const feedback = data.feedback ?? '';

    return (
      <div className="goal-rejected-card">
        <div className="goal-rejected-header">
          <GoalRejectedIcon />
          <span className="goal-rejected-title">Goal Completion Rejected</span>
        </div>
        <div className="goal-rejected-body">
          <pre className="goal-rejected-feedback">{feedback}</pre>
        </div>
      </div>
    );
  },
);

GoalRejectedDisplayRenderer.displayName = 'GoalRejectedDisplayRenderer';
