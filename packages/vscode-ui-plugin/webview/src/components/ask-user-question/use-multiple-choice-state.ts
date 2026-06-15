/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Webview port of the CLI's use-multiple-choice-state.ts —
 * pure React reducer, no Ink / no DOM specifics.
 */

import { useCallback, useReducer } from 'react';

export type AnswerValue = string;

export type QuestionState = {
  /** For single-select: selected option label; for multi-select: array of labels. */
  selectedValue?: string | string[];
  /** Text entered into the auto-appended "Other" input, or into the notes box. */
  textInputValue: string;
};

type State = {
  currentQuestionIndex: number;
  answers: Record<string, AnswerValue>;
  questionStates: Record<string, QuestionState>;
  isInTextInput: boolean;
};

type Action =
  | { type: 'next-question' }
  | { type: 'prev-question' }
  | { type: 'goto-question'; index: number }
  | {
      type: 'update-question-state';
      questionText: string;
      updates: Partial<QuestionState>;
      isMultiSelect: boolean;
    }
  | {
      type: 'set-answer';
      questionText: string;
      answer: string;
      shouldAdvance: boolean;
    }
  | { type: 'set-text-input-mode'; isInInput: boolean };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'next-question':
      return {
        ...state,
        currentQuestionIndex: state.currentQuestionIndex + 1,
        isInTextInput: false,
      };
    case 'prev-question':
      return {
        ...state,
        currentQuestionIndex: Math.max(0, state.currentQuestionIndex - 1),
        isInTextInput: false,
      };
    case 'goto-question':
      return {
        ...state,
        currentQuestionIndex: Math.max(0, action.index),
        isInTextInput: false,
      };
    case 'update-question-state': {
      const existing = state.questionStates[action.questionText];
      const newState: QuestionState = {
        selectedValue:
          action.updates.selectedValue ??
          existing?.selectedValue ??
          (action.isMultiSelect ? [] : undefined),
        textInputValue:
          action.updates.textInputValue ?? existing?.textInputValue ?? '',
      };
      return {
        ...state,
        questionStates: {
          ...state.questionStates,
          [action.questionText]: newState,
        },
      };
    }
    case 'set-answer': {
      const next = {
        ...state,
        answers: {
          ...state.answers,
          [action.questionText]: action.answer,
        },
      };
      if (action.shouldAdvance) {
        return {
          ...next,
          currentQuestionIndex: next.currentQuestionIndex + 1,
          isInTextInput: false,
        };
      }
      return next;
    }
    case 'set-text-input-mode':
      return { ...state, isInTextInput: action.isInInput };
    default:
      return state;
  }
}

const INITIAL_STATE: State = {
  currentQuestionIndex: 0,
  answers: {},
  questionStates: {},
  isInTextInput: false,
};

export function useMultipleChoiceState() {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);

  const nextQuestion = useCallback(() => dispatch({ type: 'next-question' }), []);
  const prevQuestion = useCallback(() => dispatch({ type: 'prev-question' }), []);
  const gotoQuestion = useCallback(
    (index: number) => dispatch({ type: 'goto-question', index }),
    [],
  );
  const updateQuestionState = useCallback(
    (
      questionText: string,
      updates: Partial<QuestionState>,
      isMultiSelect: boolean,
    ) => {
      dispatch({
        type: 'update-question-state',
        questionText,
        updates,
        isMultiSelect,
      });
    },
    [],
  );
  const setAnswer = useCallback(
    (questionText: string, answer: string, shouldAdvance = true) => {
      dispatch({ type: 'set-answer', questionText, answer, shouldAdvance });
    },
    [],
  );
  const setTextInputMode = useCallback((isInInput: boolean) => {
    dispatch({ type: 'set-text-input-mode', isInInput });
  }, []);

  return {
    ...state,
    nextQuestion,
    prevQuestion,
    gotoQuestion,
    updateQuestionState,
    setAnswer,
    setTextInputMode,
  };
}
