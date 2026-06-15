/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * AskUserQuestionMessage — top-level permission dialog shell for the
 * VSCode webview. Mirrors the CLI's AskUserQuestionMessage + the claude-code
 * AskUserQuestionPermissionRequest.
 *
 * Responsibilities:
 *   - Own the multi-question state machine (useMultipleChoiceState).
 *   - Dispatch to QuestionView / PreviewQuestionView / SubmitQuestionsView.
 *   - Translate user interactions into a single
 *     onConfirm({confirmed, outcome, answers, annotations, feedback}) call
 *     that flows up to ToolCallList → MultiSessionApp → extension host.
 */

import React, { useCallback } from 'react';
import type { AskUserQuestion, ToolCallConfirmationDetails } from '../types';
import { useMultipleChoiceState } from './ask-user-question/use-multiple-choice-state';
import { QuestionView } from './ask-user-question/QuestionView';
import { PreviewQuestionView } from './ask-user-question/PreviewQuestionView';
import { SubmitQuestionsView } from './ask-user-question/SubmitQuestionsView';
import './AskUserQuestionMessage.css';

export interface AskUserQuestionConfirmPayload {
  confirmed: boolean;
  outcome?: string;
  answers?: Record<string, string>;
  annotations?: Record<string, { preview?: string; notes?: string }>;
  feedback?: string;
}

export interface AskUserQuestionMessageProps {
  confirmationDetails: ToolCallConfirmationDetails;
  isInPlanMode?: boolean;
  onConfirm: (payload: AskUserQuestionConfirmPayload) => void;
}

export const AskUserQuestionMessage: React.FC<AskUserQuestionMessageProps> = ({
  confirmationDetails,
  isInPlanMode = false,
  onConfirm,
}) => {
  const questions: AskUserQuestion[] = confirmationDetails.questions ?? [];
  const title = confirmationDetails.title ?? 'Questions for you';

  const state = useMultipleChoiceState();
  const {
    currentQuestionIndex,
    answers,
    questionStates,
    nextQuestion,
    prevQuestion,
    gotoQuestion,
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
  const hideSubmitTab = totalQuestions === 1 && !questions[0]?.multiSelect;

  /** Finalize: build payload + notify parent. */
  const submit = useCallback(
    (finalAnswers: Record<string, string>) => {
      // Build annotations from preview / notes per question.
      const annotations: Record<string, { preview?: string; notes?: string }> = {};
      for (const q of questions) {
        const ans = finalAnswers[q.question];
        const notes = questionStates[q.question]?.textInputValue?.trim();
        const selectedOpt = ans
          ? q.options.find((o) => o.label === ans)
          : undefined;
        const preview = selectedOpt?.preview;
        if (preview || notes) {
          annotations[q.question] = {
            ...(preview && { preview }),
            ...(notes && { notes }),
          };
        }
      }
      onConfirm({
        confirmed: true,
        outcome: 'proceed_once',
        answers: finalAnswers,
        ...(Object.keys(annotations).length > 0 && { annotations }),
      });
    },
    [onConfirm, questions, questionStates],
  );

  const handleCancel = useCallback(() => {
    onConfirm({ confirmed: false, outcome: 'cancel' });
  }, [onConfirm]);

  const handleRespondToClaude = useCallback(() => {
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
    onConfirm({
      confirmed: true,
      outcome: 'proceed_once',
      answers: {},
      feedback,
    });
  }, [onConfirm, questions, answers]);

  const handleFinishPlanInterview = useCallback(() => {
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
    onConfirm({
      confirmed: true,
      outcome: 'proceed_once',
      answers: {},
      feedback,
    });
  }, [onConfirm, questions, answers]);

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
      // Single single-select question → short-circuit directly to submit.
      if (!isMulti && isSingleQuestion && shouldAdvance) {
        submit({ ...answers, [questionText]: answer });
        return;
      }
      setAnswer(questionText, answer, shouldAdvance);
    },
    [answers, totalQuestions, setAnswer, submit],
  );

  const handleFinalResponse = useCallback(
    (value: 'submit' | 'cancel') => {
      if (value === 'cancel') handleCancel();
      else submit(answers);
    },
    [answers, handleCancel, submit],
  );

  const hasAnyPreview =
    currentQuestion &&
    !currentQuestion.multiSelect &&
    currentQuestion.options.some((o) => o.preview);

  if (questions.length === 0) {
    return (
      <div className="auq-root">
        <div className="auq-error">AskUserQuestion: no questions provided.</div>
      </div>
    );
  }

  return (
    <div className="auq-root">
      <div className="auq-title">❓ {title}</div>

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
            onUpdateQuestionState={updateQuestionState}
            onAnswer={handleQuestionAnswer}
            onTextInputFocus={setTextInputMode}
            onCancel={handleCancel}
            onJumpToQuestion={gotoQuestion}
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
            onUpdateQuestionState={updateQuestionState}
            onAnswer={handleQuestionAnswer}
            onTextInputFocus={setTextInputMode}
            onCancel={handleCancel}
            onSubmit={nextQuestion}
            onJumpToQuestion={gotoQuestion}
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
          onJumpToQuestion={gotoQuestion}
        />
      )}
    </div>
  );
};
