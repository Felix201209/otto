/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * PreviewQuestionView — side-by-side layout for questions whose options
 * carry a `preview` field. Left = options list, Right = PreviewBox + Notes.
 * Single-select only (by schema contract in core).
 */

import React, { useCallback, useEffect, useState } from 'react';
import type { AskUserQuestion } from '../../types';
import { QuestionNavigationBar } from './QuestionNavigationBar';
import { PreviewBox } from './PreviewBox';
import type { QuestionState } from './use-multiple-choice-state';

export interface PreviewQuestionViewProps {
  question: AskUserQuestion;
  questions: AskUserQuestion[];
  currentQuestionIndex: number;
  answers: Record<string, string>;
  questionStates: Record<string, QuestionState>;
  hideSubmitTab?: boolean;
  isInPlanMode?: boolean;
  onUpdateQuestionState: (
    questionText: string,
    updates: Partial<QuestionState>,
    isMultiSelect: boolean,
  ) => void;
  onAnswer: (
    questionText: string,
    label: string | string[],
    textInput?: string,
    shouldAdvance?: boolean,
  ) => void;
  onTextInputFocus: (isInInput: boolean) => void;
  onCancel: () => void;
  onJumpToQuestion?: (index: number) => void;
  onRespondToClaude: () => void;
  onFinishPlanInterview: () => void;
}

export const PreviewQuestionView: React.FC<PreviewQuestionViewProps> = ({
  question,
  questions,
  currentQuestionIndex,
  answers,
  questionStates,
  hideSubmitTab = false,
  isInPlanMode = false,
  onUpdateQuestionState,
  onAnswer,
  onTextInputFocus,
  onCancel,
  onJumpToQuestion,
  onRespondToClaude,
  onFinishPlanInterview,
}) => {
  const questionText = question.question;
  const questionState = questionStates[questionText];
  const selected = questionState?.selectedValue as string | undefined;
  const notesValue = questionState?.textInputValue ?? '';

  const [focusedIndex, setFocusedIndex] = useState(() => {
    const idx = selected
      ? question.options.findIndex((o) => o.label === selected)
      : -1;
    return idx >= 0 ? idx : 0;
  });
  const [isInNotes, setIsInNotes] = useState(false);

  // Reset focusedIndex whenever the visible question changes.
  useEffect(() => {
    const idx = selected
      ? question.options.findIndex((o) => o.label === selected)
      : -1;
    setFocusedIndex(idx >= 0 ? idx : 0);
    setIsInNotes(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [question.question]);

  useEffect(() => {
    onTextInputFocus(isInNotes);
  }, [isInNotes, onTextInputFocus]);

  const focusedOption = question.options[focusedIndex];

  const pickOption = useCallback(
    (label: string) => {
      onUpdateQuestionState(questionText, { selectedValue: label }, false);
      onAnswer(questionText, label, undefined, true);
    },
    [questionText, onUpdateQuestionState, onAnswer],
  );

  return (
    <div className="auq-question-view auq-question-preview">
      <QuestionNavigationBar
        questions={questions}
        currentQuestionIndex={currentQuestionIndex}
        answers={answers}
        hideSubmitTab={hideSubmitTab}
        onJumpToQuestion={onJumpToQuestion}
      />

      <div className="auq-question-text">{question.question}</div>

      <div className="auq-preview-layout">
        {/* Left: options list */}
        <div className="auq-preview-options">
          {question.options.map((opt, idx) => {
            const isFocusedRow = idx === focusedIndex;
            const isSelected = selected === opt.label;
            return (
              <button
                key={opt.label}
                type="button"
                className={`auq-preview-option ${isFocusedRow ? 'auq-preview-option-focused' : ''} ${isSelected ? 'auq-preview-option-selected' : ''}`}
                onMouseEnter={() => setFocusedIndex(idx)}
                onClick={() => pickOption(opt.label)}
              >
                <span className="auq-option-index">{idx + 1}.</span>
                <span className="auq-option-label">{opt.label}</span>
                {isSelected && <span className="auq-preview-tick">✓</span>}
              </button>
            );
          })}
        </div>

        {/* Right: preview + notes */}
        <div className="auq-preview-right">
          <PreviewBox
            content={focusedOption?.preview || 'No preview available'}
          />
          <div className="auq-preview-notes">
            <span className="auq-preview-notes-label">Notes:</span>
            <input
              type="text"
              className="auq-preview-notes-input"
              value={notesValue}
              placeholder="Add notes on this design…"
              onChange={(e) =>
                onUpdateQuestionState(
                  questionText,
                  { textInputValue: e.target.value },
                  false,
                )
              }
              onFocus={() => setIsInNotes(true)}
              onBlur={() => setIsInNotes(false)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  (e.target as HTMLInputElement).blur();
                  onCancel();
                }
              }}
            />
          </div>
        </div>
      </div>

      <div className="auq-footer">
        <button type="button" className="auq-footer-btn" onClick={onRespondToClaude}>
          Chat about this
        </button>
        {isInPlanMode && (
          <button type="button" className="auq-footer-btn" onClick={onFinishPlanInterview}>
            Skip interview and plan immediately
          </button>
        )}
      </div>

      <div className="auq-help-line">
        Click an option to preview · Click again to select · Esc to cancel
      </div>
    </div>
  );
};
