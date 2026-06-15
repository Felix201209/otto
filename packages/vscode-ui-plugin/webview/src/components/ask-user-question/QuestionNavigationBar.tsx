/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * QuestionNavigationBar — tab-style question progress bar.
 * Shows each question as a chip with its `header`, an answered checkmark,
 * and an optional "✓ Submit" tab at the end for multi-question flows.
 */

import React from 'react';
import type { AskUserQuestion } from '../../types';

export interface QuestionNavigationBarProps {
  questions: AskUserQuestion[];
  currentQuestionIndex: number;
  answers: Record<string, string>;
  /** Hide the "✓ Submit" tab — used for trivial single-question single-select flows. */
  hideSubmitTab?: boolean;
  onJumpToQuestion?: (index: number) => void;
}

export const QuestionNavigationBar: React.FC<QuestionNavigationBarProps> = ({
  questions,
  currentQuestionIndex,
  answers,
  hideSubmitTab = false,
  onJumpToQuestion,
}) => {
  // Hide entirely for the trivial 1-question single-select case.
  if (questions.length === 1 && hideSubmitTab) return null;

  return (
    <div className="auq-nav-bar">
      <span
        className={`auq-nav-arrow ${currentQuestionIndex === 0 ? 'auq-nav-arrow-disabled' : ''}`}
        aria-hidden
      >
        ←
      </span>
      {questions.map((q, idx) => {
        const isCurrent = idx === currentQuestionIndex;
        const isAnswered = !!(q?.question && answers[q.question]);
        const header = q?.header || `Q${idx + 1}`;
        return (
          <button
            key={q.question || idx}
            type="button"
            className={`auq-nav-tab ${isCurrent ? 'auq-nav-tab-current' : ''} ${isAnswered ? 'auq-nav-tab-answered' : ''}`}
            onClick={() => onJumpToQuestion?.(idx)}
          >
            <span className="auq-nav-check">{isAnswered ? '☑' : '☐'}</span>
            <span className="auq-nav-header-text">{header}</span>
          </button>
        );
      })}
      {!hideSubmitTab && (
        <button
          type="button"
          className={`auq-nav-tab auq-nav-submit-tab ${currentQuestionIndex === questions.length ? 'auq-nav-tab-current' : ''}`}
          onClick={() => onJumpToQuestion?.(questions.length)}
        >
          ✓ Submit
        </button>
      )}
      <span
        className={`auq-nav-arrow ${
          currentQuestionIndex === questions.length ||
          (questions.length === 1 && hideSubmitTab)
            ? 'auq-nav-arrow-disabled'
            : ''
        }`}
        aria-hidden
      >
        →
      </span>
    </div>
  );
};
