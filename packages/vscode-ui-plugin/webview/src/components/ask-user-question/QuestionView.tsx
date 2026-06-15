/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * QuestionView — single-question renderer (non-preview variant).
 * Web version of CLI's QuestionView.tsx.
 *
 * Layout:
 *   ┌ question text
 *   │
 *   │ ○ Option 1   description
 *   │ ● Option 2   description   ← focused/selected
 *   │ ○ Other      [text input]
 *   │
 *   │ ── divider ──
 *   │ ▶ Chat about this
 *   │   Skip interview and plan immediately   (plan mode only)
 *   │
 *   └ help line
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { AskUserQuestion } from '../../types';
import { QuestionNavigationBar } from './QuestionNavigationBar';
import type { QuestionState } from './use-multiple-choice-state';

export interface QuestionViewProps {
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
  onSubmit: () => void;
  onJumpToQuestion?: (index: number) => void;
  onRespondToClaude: () => void;
  onFinishPlanInterview: () => void;
}

const OTHER_SENTINEL = '__other__';

export const QuestionView: React.FC<QuestionViewProps> = ({
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
  onSubmit,
  onJumpToQuestion,
  onRespondToClaude,
  onFinishPlanInterview,
}) => {
  const questionText = question.question;
  const questionState = questionStates[questionText];
  const isMulti = !!question.multiSelect;

  const otherText = questionState?.textInputValue ?? '';
  const selected = questionState?.selectedValue;
  const selectedLabel = typeof selected === 'string' ? selected : undefined;
  const selectedSet = Array.isArray(selected) ? new Set(selected) : new Set<string>();

  const [isOtherFocused, setIsOtherFocused] = useState(false);
  const otherInputRef = useRef<HTMLInputElement>(null);

  // Notify parent of Other-input focus changes so it can suspend list key handlers.
  useEffect(() => {
    onTextInputFocus(isOtherFocused);
  }, [isOtherFocused, onTextInputFocus]);

  // -----------------------
  // Single-select handlers
  // -----------------------
  const pickOption = useCallback(
    (label: string) => {
      onUpdateQuestionState(
        questionText,
        { selectedValue: label },
        false,
      );
      onAnswer(questionText, label, undefined, true);
    },
    [questionText, onUpdateQuestionState, onAnswer],
  );

  const submitOther = useCallback(() => {
    const trimmed = otherText.trim();
    if (!trimmed) return;
    onUpdateQuestionState(
      questionText,
      { selectedValue: OTHER_SENTINEL, textInputValue: trimmed },
      false,
    );
    onAnswer(questionText, OTHER_SENTINEL, trimmed, true);
  }, [otherText, questionText, onUpdateQuestionState, onAnswer]);

  // -----------------------
  // Multi-select handlers
  // -----------------------
  const toggleMulti = useCallback(
    (label: string) => {
      const next = new Set(selectedSet);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      const values = Array.from(next);
      onUpdateQuestionState(questionText, { selectedValue: values }, true);
      const resolved = values.map((v) =>
        v === OTHER_SENTINEL ? otherText.trim() || null : v,
      ).filter((v): v is string => !!v);
      onAnswer(questionText, resolved, undefined, false);
    },
    [selectedSet, questionText, otherText, onUpdateQuestionState, onAnswer],
  );

  const submitMulti = useCallback(() => {
    const values = Array.from(selectedSet);
    const resolved = values.map((v) =>
      v === OTHER_SENTINEL ? otherText.trim() || null : v,
    ).filter((v): v is string => !!v);
    onAnswer(questionText, resolved, undefined, true);
    onSubmit();
  }, [selectedSet, questionText, otherText, onAnswer, onSubmit]);

  // -----------------------
  // Render
  // -----------------------
  return (
    <div className="auq-question-view">
      <QuestionNavigationBar
        questions={questions}
        currentQuestionIndex={currentQuestionIndex}
        answers={answers}
        hideSubmitTab={hideSubmitTab}
        onJumpToQuestion={onJumpToQuestion}
      />

      <div className="auq-question-text">{question.question}</div>

      <div className={`auq-options ${isMulti ? 'auq-options-multi' : 'auq-options-single'}`}>
        {question.options.map((opt, idx) => {
          const isChecked = isMulti
            ? selectedSet.has(opt.label)
            : selectedLabel === opt.label;
          return (
            <label
              key={opt.label}
              className={`auq-option ${isChecked ? 'auq-option-selected' : ''}`}
            >
              <input
                type={isMulti ? 'checkbox' : 'radio'}
                name={`auq-${questionText}`}
                checked={isChecked}
                onChange={() => {
                  if (isMulti) toggleMulti(opt.label);
                  else pickOption(opt.label);
                }}
              />
              <span className="auq-option-index">{idx + 1}.</span>
              <span className="auq-option-label">{opt.label}</span>
              {opt.description && (
                <span className="auq-option-description">— {opt.description}</span>
              )}
            </label>
          );
        })}

        {/* "Other" row (always present) */}
        <label
          className={`auq-option auq-option-other ${
            (isMulti ? selectedSet.has(OTHER_SENTINEL) : selectedLabel === OTHER_SENTINEL)
              ? 'auq-option-selected'
              : ''
          }`}
        >
          <input
            type={isMulti ? 'checkbox' : 'radio'}
            name={`auq-${questionText}`}
            checked={
              isMulti
                ? selectedSet.has(OTHER_SENTINEL)
                : selectedLabel === OTHER_SENTINEL
            }
            onChange={() => {
              if (isMulti) toggleMulti(OTHER_SENTINEL);
              else {
                // focus the input and mark Other as the tentative pick
                onUpdateQuestionState(
                  questionText,
                  { selectedValue: OTHER_SENTINEL },
                  false,
                );
                setTimeout(() => otherInputRef.current?.focus(), 0);
              }
            }}
          />
          <span className="auq-option-index">{question.options.length + 1}.</span>
          <span className="auq-option-label">Other</span>
          <input
            ref={otherInputRef}
            type="text"
            className="auq-other-input"
            placeholder="Type something…"
            value={otherText}
            onChange={(e) => {
              onUpdateQuestionState(
                questionText,
                { textInputValue: e.target.value },
                isMulti,
              );
            }}
            onFocus={() => setIsOtherFocused(true)}
            onBlur={() => setIsOtherFocused(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (isMulti) {
                  // Ensure Other is toggled on if there's text
                  if (!selectedSet.has(OTHER_SENTINEL) && otherText.trim()) {
                    toggleMulti(OTHER_SENTINEL);
                  }
                  submitMulti();
                } else {
                  submitOther();
                }
              } else if (e.key === 'Escape') {
                e.preventDefault();
                (e.target as HTMLInputElement).blur();
                onCancel();
              }
            }}
          />
        </label>
      </div>

      {/* Submit button for multi-select (single-select auto-submits on pick). */}
      {isMulti && (
        <div className="auq-submit-row">
          <button
            type="button"
            className="auq-btn auq-btn-primary"
            onClick={submitMulti}
          >
            {currentQuestionIndex === questions.length - 1 ? 'Submit' : 'Next'}
          </button>
        </div>
      )}

      {/* Footer actions */}
      <div className="auq-footer">
        <button
          type="button"
          className="auq-footer-btn"
          onClick={onRespondToClaude}
        >
          Chat about this
        </button>
        {isInPlanMode && (
          <button
            type="button"
            className="auq-footer-btn"
            onClick={onFinishPlanInterview}
          >
            Skip interview and plan immediately
          </button>
        )}
      </div>

      <div className="auq-help-line">
        Click to select
        {isMulti ? ' · multiple allowed · press Submit when done' : ' · auto-advances on pick'}
        {' '}· Esc to cancel
      </div>
    </div>
  );
};
