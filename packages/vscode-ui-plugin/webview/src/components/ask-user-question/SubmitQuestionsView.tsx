/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * SubmitQuestionsView — review/submit screen for multi-question flows.
 */

import React from 'react';
import type { AskUserQuestion } from '../../types';
import { QuestionNavigationBar } from './QuestionNavigationBar';

export interface SubmitQuestionsViewProps {
  questions: AskUserQuestion[];
  currentQuestionIndex: number;
  answers: Record<string, string>;
  allQuestionsAnswered: boolean;
  onFinalResponse: (value: 'submit' | 'cancel') => void;
  onJumpToQuestion?: (index: number) => void;
}

export const SubmitQuestionsView: React.FC<SubmitQuestionsViewProps> = ({
  questions,
  currentQuestionIndex,
  answers,
  allQuestionsAnswered,
  onFinalResponse,
  onJumpToQuestion,
}) => {
  return (
    <div className="auq-submit-view">
      <QuestionNavigationBar
        questions={questions}
        currentQuestionIndex={currentQuestionIndex}
        answers={answers}
        onJumpToQuestion={onJumpToQuestion}
      />

      <div className="auq-submit-title">Review your answers</div>

      {!allQuestionsAnswered && (
        <div className="auq-submit-warning">
          ⚠ You have not answered all questions
        </div>
      )}

      {Object.keys(answers).length > 0 && (
        <div className="auq-submit-answers">
          {questions
            .filter((q) => q?.question && answers[q.question])
            .map((q) => (
              <div key={q.question} className="auq-submit-answer-item">
                <div className="auq-submit-question-text">• {q.question}</div>
                <div className="auq-submit-answer-text">→ {answers[q.question]}</div>
              </div>
            ))}
        </div>
      )}

      <div className="auq-submit-prompt">Ready to submit your answers?</div>

      <div className="auq-submit-actions">
        <button
          type="button"
          className="auq-btn auq-btn-primary"
          onClick={() => onFinalResponse('submit')}
          autoFocus
        >
          Submit answers
        </button>
        <button
          type="button"
          className="auq-btn auq-btn-secondary"
          onClick={() => onFinalResponse('cancel')}
        >
          Cancel
        </button>
      </div>
    </div>
  );
};
