/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 *
 * AskUserQuestionMessage — the top-level permission dialog for the
 * AskUserQuestion tool. Mirrors claude-code's
 * AskUserQuestionPermissionRequest.
 *
 * Responsibilities:
 *   - Own the multiple-choice state machine (useMultipleChoiceState).
 *   - Dispatch to QuestionView / PreviewQuestionView / SubmitQuestionsView.
 *   - Translate user interactions into onConfirm(outcome, payload) calls.
 */

import React, { useCallback } from 'react';
import { Box, Text } from 'ink';
import { Colors } from '../../colors.js';
import {
  ToolQuestionConfirmationDetails,
  ToolConfirmationOutcome,
  ToolConfirmationPayload,
} from 'otto-core';
import { useMultipleChoiceState } from './ask-user-question/use-multiple-choice-state.js';
import { QuestionView } from './ask-user-question/QuestionView.js';
import { PreviewQuestionView } from './ask-user-question/PreviewQuestionView.js';
import { SubmitQuestionsView } from './ask-user-question/SubmitQuestionsView.js';

export interface AskUserQuestionMessageProps {
  details: ToolQuestionConfirmationDetails;
  isFocused?: boolean;
  isInPlanMode?: boolean;
  terminalWidth: number;
}

export function AskUserQuestionMessage({
  details,
  isFocused = true,
  isInPlanMode = false,
  terminalWidth,
}: AskUserQuestionMessageProps): React.JSX.Element {
  const { questions } = details;
  const state = useMultipleChoiceState();
  const {
    currentQuestionIndex,
    answers,
    questionStates,
    nextQuestion,
    prevQuestion,
    updateQuestionState,
    setAnswer,
    setTextInputMode,
  } = state;

  const totalQuestions = questions.length;
  const isInSubmitView = currentQuestionIndex >= totalQuestions;
  const currentQuestion = questions[currentQuestionIndex];
  const allQuestionsAnswered = questions.every(
    (q) => q?.question && !!answers[q.question],
  );
  // Hide submit tab for trivial single-question single-select flows.
  const hideSubmitTab =
    totalQuestions === 1 && !questions[0]?.multiSelect;

  /**
   * Build the {answers, annotations} payload and submit to the tool.
   */
  const submit = useCallback(
    async (finalAnswers: Record<string, string>) => {
      const annotations: Record<string, { preview?: string; notes?: string }> =
        {};
      for (const q of questions) {
        const answer = finalAnswers[q.question];
        const notes = questionStates[q.question]?.textInputValue?.trim();
        const selectedOpt = answer
          ? q.options.find((o) => o.label === answer)
          : undefined;
        const preview = selectedOpt?.preview;
        if (preview || notes) {
          annotations[q.question] = {
            ...(preview && { preview }),
            ...(notes && { notes }),
          };
        }
      }
      const payload: ToolConfirmationPayload = {
        answers: finalAnswers,
        ...(Object.keys(annotations).length > 0 && { annotations }),
      };
      await details.onConfirm(ToolConfirmationOutcome.ProceedOnce, payload);
    },
    [details, questions, questionStates],
  );

  const handleCancel = useCallback(() => {
    details.onConfirm(ToolConfirmationOutcome.Cancel);
  }, [details]);

  const handleRespondToClaude = useCallback(async () => {
    const lines = questions
      .map((q) => {
        const a = answers[q.question];
        return a
          ? `- "${q.question}"\n  Answer: ${a}`
          : `- "${q.question}"\n  (No answer provided)`;
      })
      .join('\n');
    const feedback = `The user wants to clarify these questions.
They may have additional information, context or questions for you.
Take their response into account and then reformulate the questions if appropriate.
Start by asking them what they would like to clarify.

Questions asked:
${lines}`;
    await details.onConfirm(ToolConfirmationOutcome.ProceedOnce, {
      answers: {},
      feedback,
    });
  }, [details, questions, answers]);

  const handleFinishPlanInterview = useCallback(async () => {
    const lines = questions
      .map((q) => {
        const a = answers[q.question];
        return a
          ? `- "${q.question}"\n  Answer: ${a}`
          : `- "${q.question}"\n  (No answer provided)`;
      })
      .join('\n');
    const feedback = `The user has indicated they have provided enough answers for the plan interview.
Stop asking clarifying questions and proceed to finish the plan with the information you have.

Questions asked and answers provided:
${lines}`;
    await details.onConfirm(ToolConfirmationOutcome.ProceedOnce, {
      answers: {},
      feedback,
    });
  }, [details, questions, answers]);

  /**
   * Record an answer into the state machine. Mirrors claude-code's answer
   * dispatch: for a single single-select question, answering triggers an
   * immediate submit (short-circuit); otherwise we advance through the nav.
   */
  const handleQuestionAnswer = useCallback(
    (
      questionText: string,
      label: string | string[],
      textInput?: string,
      shouldAdvance = true,
    ) => {
      let answer: string;
      const isMulti = Array.isArray(label);
      if (isMulti) {
        answer = (label as string[]).join(', ');
      } else if (textInput) {
        answer = textInput;
      } else if (label === '__other__') {
        answer = 'Other';
      } else {
        answer = label as string;
      }
      const isSingleQuestion = totalQuestions === 1;
      if (!isMulti && isSingleQuestion && shouldAdvance) {
        const updated = { ...answers, [questionText]: answer };
        submit(updated).catch(() => {
          /* swallow — surfaced by tool error path */
        });
        return;
      }
      setAnswer(questionText, answer, shouldAdvance);
    },
    [answers, totalQuestions, setAnswer, submit],
  );

  const handleFinalResponse = useCallback(
    (value: 'submit' | 'cancel') => {
      if (value === 'cancel') handleCancel();
      else submit(answers).catch(() => {});
    },
    [answers, handleCancel, submit],
  );

  const hasAnyPreview =
    currentQuestion &&
    !currentQuestion.multiSelect &&
    currentQuestion.options.some((o) => o.preview);

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={Colors.Gray}
      borderDimColor
      padding={1}
      width={terminalWidth - 2}
    >
      <Box marginBottom={1}>
        <Text bold color={Colors.AccentCyan}>
          ❓ {details.title}
        </Text>
      </Box>

      {!isInSubmitView && currentQuestion ? (
        hasAnyPreview ? (
          <PreviewQuestionView
            question={currentQuestion}
            questions={questions}
            currentQuestionIndex={currentQuestionIndex}
            answers={answers}
            questionStates={questionStates}
            hideSubmitTab={hideSubmitTab}
            isInPlanMode={isInPlanMode}
            isFocused={isFocused}
            onUpdateQuestionState={updateQuestionState}
            onAnswer={handleQuestionAnswer}
            onTextInputFocus={setTextInputMode}
            onCancel={handleCancel}
            onTabPrev={prevQuestion}
            onTabNext={nextQuestion}
            onRespondToClaude={handleRespondToClaude}
            onFinishPlanInterview={handleFinishPlanInterview}
          />
        ) : (
          <QuestionView
            question={currentQuestion}
            questions={questions}
            currentQuestionIndex={currentQuestionIndex}
            answers={answers}
            questionStates={questionStates}
            hideSubmitTab={hideSubmitTab}
            isInPlanMode={isInPlanMode}
            isFocused={isFocused}
            onUpdateQuestionState={updateQuestionState}
            onAnswer={handleQuestionAnswer}
            onTextInputFocus={setTextInputMode}
            onCancel={handleCancel}
            onSubmit={nextQuestion}
            onTabPrev={prevQuestion}
            onTabNext={nextQuestion}
            onRespondToClaude={handleRespondToClaude}
            onFinishPlanInterview={handleFinishPlanInterview}
          />
        )
      ) : (
        <SubmitQuestionsView
          questions={questions}
          currentQuestionIndex={currentQuestionIndex}
          answers={answers}
          allQuestionsAnswered={allQuestionsAnswered}
          onFinalResponse={handleFinalResponse}
          isFocused={isFocused}
        />
      )}
    </Box>
  );
}
