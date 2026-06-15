/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMultipleChoiceState } from './use-multiple-choice-state';

describe('useMultipleChoiceState', () => {
  it('starts at question 0 with empty answers', () => {
    const { result } = renderHook(() => useMultipleChoiceState());
    expect(result.current.currentQuestionIndex).toBe(0);
    expect(result.current.answers).toEqual({});
    expect(result.current.questionStates).toEqual({});
    expect(result.current.isInTextInput).toBe(false);
  });

  it('advances with nextQuestion and rewinds with prevQuestion (clamped at 0)', () => {
    const { result } = renderHook(() => useMultipleChoiceState());
    act(() => {
      result.current.nextQuestion();
      result.current.nextQuestion();
    });
    expect(result.current.currentQuestionIndex).toBe(2);
    act(() => {
      result.current.prevQuestion();
      result.current.prevQuestion();
      result.current.prevQuestion(); // clamped at 0
    });
    expect(result.current.currentQuestionIndex).toBe(0);
  });

  it('gotoQuestion jumps to any index (clamped to >= 0)', () => {
    const { result } = renderHook(() => useMultipleChoiceState());
    act(() => result.current.gotoQuestion(3));
    expect(result.current.currentQuestionIndex).toBe(3);
    act(() => result.current.gotoQuestion(-2));
    expect(result.current.currentQuestionIndex).toBe(0);
  });

  it('setAnswer records the answer and auto-advances by default', () => {
    const { result } = renderHook(() => useMultipleChoiceState());
    act(() => result.current.setAnswer('Q1?', 'OAuth'));
    expect(result.current.answers['Q1?']).toBe('OAuth');
    expect(result.current.currentQuestionIndex).toBe(1);
  });

  it('setAnswer with shouldAdvance=false keeps the index', () => {
    const { result } = renderHook(() => useMultipleChoiceState());
    act(() => result.current.setAnswer('Q1?', 'API Key', false));
    expect(result.current.answers['Q1?']).toBe('API Key');
    expect(result.current.currentQuestionIndex).toBe(0);
  });

  it('updateQuestionState merges selectedValue and textInputValue', () => {
    const { result } = renderHook(() => useMultipleChoiceState());
    act(() =>
      result.current.updateQuestionState(
        'Q1?',
        { selectedValue: 'OAuth' },
        false,
      ),
    );
    expect(result.current.questionStates['Q1?']).toEqual({
      selectedValue: 'OAuth',
      textInputValue: '',
    });
    act(() =>
      result.current.updateQuestionState(
        'Q1?',
        { textInputValue: 'with PKCE' },
        false,
      ),
    );
    expect(result.current.questionStates['Q1?']).toEqual({
      selectedValue: 'OAuth',
      textInputValue: 'with PKCE',
    });
  });

  it('updateQuestionState initializes an empty array for multi-select questions', () => {
    const { result } = renderHook(() => useMultipleChoiceState());
    act(() =>
      result.current.updateQuestionState('Q?', {}, /* isMultiSelect */ true),
    );
    expect(result.current.questionStates['Q?']).toEqual({
      selectedValue: [],
      textInputValue: '',
    });
  });

  it('setTextInputMode toggles isInTextInput', () => {
    const { result } = renderHook(() => useMultipleChoiceState());
    act(() => result.current.setTextInputMode(true));
    expect(result.current.isInTextInput).toBe(true);
    act(() => result.current.setTextInputMode(false));
    expect(result.current.isInTextInput).toBe(false);
  });

  it('navigating with next-question clears isInTextInput', () => {
    const { result } = renderHook(() => useMultipleChoiceState());
    act(() => {
      result.current.setTextInputMode(true);
      result.current.nextQuestion();
    });
    expect(result.current.isInTextInput).toBe(false);
  });
});
