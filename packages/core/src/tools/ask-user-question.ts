/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

import { Type } from '@google/genai';
import {
  AskUserQuestion,
  BaseTool,
  Icon,
  ToolCallConfirmationDetails,
  ToolConfirmationOutcome,
  ToolConfirmationPayload,
  ToolQuestionConfirmationDetails,
  ToolResult,
} from './tools.js';
import { Config } from '../config/config.js';
import { SchemaValidator } from '../utils/schemaValidator.js';

/**
 * Params the LLM passes when calling AskUserQuestion.
 *
 * The `answers` / `annotations` / `feedback` fields are NOT set by the LLM —
 * they are captured by the permission dialog and passed back through the
 * ToolConfirmationPayload. They are retained on the params object only so
 * the tool's `execute()` can format them for the tool_result.
 */
export interface AskUserQuestionParams {
  questions: AskUserQuestion[];
  metadata?: {
    source?: string;
  };
  /** Internal: filled in by the permission dialog. */
  answers?: Record<string, string>;
  /** Internal: filled in by the permission dialog. */
  annotations?: Record<string, { preview?: string; notes?: string }>;
  /** Internal: filled in when the user chooses "Chat about this" etc. */
  feedback?: string;
}

// Short one-liner shown to the model as the tool's "description" field
// (mirrors claude-code's DESCRIPTION verbatim).
const TOOL_DESCRIPTION =
  'Asks the user multiple choice questions to gather information, clarify ambiguity, understand preferences, make decisions or offer them choices.';

// Extended usage guidance appended to the description. Mirrors claude-code's
// ASK_USER_QUESTION_TOOL_PROMPT + PREVIEW_FEATURE_PROMPT.markdown as closely
// as possible. Keep this tight — claude-code's experience is that a lean
// prompt beats a verbose one for tool-selection behavior.
const TOOL_PROMPT = `Use this tool when you need to ask the user questions during execution. This allows you to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take.

Usage notes:
- Users will always be able to select "Other" to provide custom text input
- Use multiSelect: true to allow multiple answers to be selected for a question
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label

Preview feature:
Use the optional \`preview\` field on options when presenting concrete artifacts that users need to visually compare:
- ASCII mockups of UI layouts or components
- Code snippets showing different implementations
- Diagram variations
- Configuration examples

Preview content is rendered as markdown in a monospace box. Multi-line text with newlines is supported. When any option has a preview, the UI switches to a side-by-side layout with a vertical option list on the left and preview on the right. Do not use previews for simple preference questions where labels and descriptions suffice. Note: previews are only supported for single-select questions (not multiSelect).`;

const FULL_DESCRIPTION = `${TOOL_DESCRIPTION}\n\n${TOOL_PROMPT}`;

/**
 * AskUserQuestion — pauses the agent loop, shows the user a multi-choice
 * dialog, resumes with the user's answers injected into the tool_result.
 *
 * Control-flow (identical to claude-code):
 *   LLM calls AskUserQuestion({questions})
 *     -> shouldConfirmExecute() returns 'question' confirmation details
 *     -> ToolExecutionEngine sets status = 'awaiting_approval' (PAUSE)
 *     -> UI renders AskUserQuestionMessage, collects answers
 *     -> user submits -> onConfirm(ProceedOnce, {answers, annotations})
 *     -> handleConfirmationResponse transitions to 'scheduled' (RESUME)
 *     -> execute() formats "User answered: ..." for the LLM
 *
 * The AskUserQuestionTool itself has almost no logic — it is a shell around
 * the permission-dialog pause/resume mechanism. This mirrors claude-code's
 * design exactly.
 */
export class AskUserQuestionTool extends BaseTool<
  AskUserQuestionParams,
  ToolResult
> {
  static readonly Name = 'ask_user_question';

  /**
   * Answers captured from the permission dialog, keyed by callId-equivalent
   * (here we use a fingerprint of the questions array since the tool layer
   * doesn't expose callId to execute()). The permission dialog sets the
   * entry; execute() reads + deletes it.
   */
  private pendingAnswers = new Map<
    string,
    {
      answers: Record<string, string>;
      annotations?: Record<string, { preview?: string; notes?: string }>;
      feedback?: string;
      cancelled?: boolean;
    }
  >();

  constructor(private readonly config: Config) {
    super(
      AskUserQuestionTool.Name,
      'AskUserQuestion',
      FULL_DESCRIPTION,
      Icon.Question,
      {
        type: Type.OBJECT,
        properties: {
          questions: {
            type: Type.ARRAY,
            description:
              'Questions to ask the user (1-4 questions in a single dialog).',
            items: {
              type: Type.OBJECT,
              properties: {
                question: {
                  type: Type.STRING,
                  description:
                    'The complete question to ask the user. Should be clear, specific, and end with a question mark. Example: "Which library should we use for date formatting?"',
                },
                header: {
                  type: Type.STRING,
                  description:
                    'Very short label displayed as a chip/tag (max 12 chars). Examples: "Auth method", "Library", "Approach".',
                },
                options: {
                  type: Type.ARRAY,
                  description:
                    'Available choices (2-4 options). Must be distinct. Do not include "Other" — it is auto-appended by the UI.',
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      label: {
                        type: Type.STRING,
                        description:
                          'The display text for this option. Should be concise (1-5 words).',
                      },
                      description: {
                        type: Type.STRING,
                        description:
                          'Explanation of what this option means or implies.',
                      },
                      preview: {
                        type: Type.STRING,
                        description:
                          'Optional preview content (markdown) rendered side-by-side when this option is focused. Single-select only.',
                      },
                    },
                    required: ['label'],
                  },
                },
                multiSelect: {
                  type: Type.BOOLEAN,
                  description:
                    'Set to true to allow selecting multiple options. Defaults to false.',
                },
              },
              required: ['question', 'options'],
            },
          },
          metadata: {
            type: Type.OBJECT,
            description:
              'Optional metadata for tracking/analytics. Not displayed to user.',
            properties: {
              source: {
                type: Type.STRING,
                description:
                  'Optional identifier for the source of this question (e.g., "remember").',
              },
            },
          },
        },
        required: ['questions'],
      },
      true, // isOutputMarkdown
      false, // forceMarkdown
      false, // canUpdateOutput
      false, // allowSubAgentUse — sub-agents have no TTY user to answer
    );
  }

  override validateToolParams(params: AskUserQuestionParams): string | null {
    // 🚀 防御性数据自愈与容错：静默修复小的不合规（如缺失 header、超长 header、省略 description、传入 options 为字符串数组等）
    if (params && Array.isArray(params.questions)) {
      params.questions = params.questions.map((q) => {
        if (!q || typeof q !== 'object') return q;

        // 1. 修复 header 缺失
        let header = q.header;
        if (!header || typeof header !== 'string' || !header.trim()) {
          header = 'Question';
        }
        // 2. 修复 header 超长（自动截断到 12 字符内）
        if (header.length > 12) {
          header = header.substring(0, 12);
        }

        // 3. 修复 options 的各种不规范情况
        let options = q.options;
        if (Array.isArray(options)) {
          options = options.map((opt) => {
            if (typeof opt === 'string') {
              return { label: opt, description: '' };
            }
            if (opt && typeof opt === 'object') {
              // 容错：如果把选项写成只有 label/value 或无 description 的情况
              const rawLabel = (opt as any).label || (opt as any).value || 'Option';
              const label = String(rawLabel).trim() || 'Option';
              const description = opt.description ? String(opt.description).trim() : '';
              return {
                ...opt,
                label,
                description,
              };
            }
            return { label: 'Option', description: '' };
          });
        }

        return {
          ...q,
          header,
          options,
        };
      });
    }

    const errors = SchemaValidator.validate(
      this.schema.parameters,
      params,
      AskUserQuestionTool.Name,
    );
    if (errors) return errors;
    if (!params.questions || params.questions.length === 0) {
      return 'At least one question is required.';
    }
    if (params.questions.length > 4) {
      return 'At most 4 questions may be asked in a single call.';
    }
    const questionTexts = new Set<string>();
    for (const q of params.questions) {
      if (!q.question || !q.question.trim()) {
        return 'Every question must have non-empty `question` text.';
      }
      if (questionTexts.has(q.question)) {
        return `Duplicate question text: "${q.question}". Question texts must be unique within one call.`;
      }
      questionTexts.add(q.question);

      if (!q.header || q.header.length > 12) {
        return `Question header must be 1-12 characters (got "${q.header}").`;
      }
      if (!q.options || q.options.length < 2 || q.options.length > 4) {
        return `Each question must have 2-4 options (got ${q.options?.length ?? 0} for "${q.question}").`;
      }
      const labels = new Set<string>();
      for (const opt of q.options) {
        if (!opt.label || !opt.label.trim()) {
          return `Every option must have a non-empty label.`;
        }
        if (labels.has(opt.label)) {
          return `Duplicate option label "${opt.label}" in question "${q.question}".`;
        }
        labels.add(opt.label);
        if (
          opt.label.trim().toLowerCase() === 'other' ||
          opt.label.trim().toLowerCase() === 'others'
        ) {
          return `Do not include an "Other" option — it is auto-appended by the UI.`;
        }
        if (opt.preview && q.multiSelect) {
          return `Preview is not supported on multiSelect questions (option "${opt.label}" in "${q.question}").`;
        }
      }
    }
    return null;
  }

  override getDescription(params: AskUserQuestionParams): string {
    const count = params.questions?.length ?? 0;
    if (count === 0) return 'Ask user a question';
    if (count === 1) return `Ask: "${params.questions[0].question}"`;
    return `Ask ${count} questions`;
  }

  /**
   * A stable fingerprint of the questions array. Used as the Map key so
   * `execute()` can pick up the answers that `onConfirm` stored. Each
   * AskUserQuestion call presents a unique set of question texts by schema
   * contract, so collisions between concurrent calls are extremely unlikely.
   */
  private fingerprint(params: AskUserQuestionParams): string {
    return (
      params.questions?.map((q) => q.question).join('\u0001') ?? ''
    );
  }

  override async shouldConfirmExecute(
    params: AskUserQuestionParams,
    _abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails | false> {
    const validationError = this.validateToolParams(params);
    if (validationError) {
      // Invalid params — let execute() produce a proper error response.
      return false;
    }

    const key = this.fingerprint(params);

    const details: ToolQuestionConfirmationDetails = {
      type: 'question',
      title: 'Questions for you',
      questions: params.questions,
      metadata: params.metadata,
      onConfirm: async (
        outcome: ToolConfirmationOutcome,
        payload?: ToolConfirmationPayload,
      ) => {
        if (outcome === ToolConfirmationOutcome.Cancel) {
          this.pendingAnswers.set(key, {
            answers: {},
            cancelled: true,
          });
          return;
        }
        this.pendingAnswers.set(key, {
          answers: payload?.answers ?? {},
          annotations: payload?.annotations,
          feedback: payload?.feedback,
        });
      },
    };

    return details;
  }

  override async execute(
    params: AskUserQuestionParams,
    _signal: AbortSignal,
  ): Promise<ToolResult> {
    const validationError = this.validateToolParams(params);
    if (validationError) {
      return {
        llmContent: `AskUserQuestion failed: ${validationError}`,
        returnDisplay: `**AskUserQuestion input error:** ${validationError}`,
      };
    }

    const key = this.fingerprint(params);
    const captured = this.pendingAnswers.get(key);
    this.pendingAnswers.delete(key);

    // If the user cancelled outright.
    if (!captured || captured.cancelled) {
      const msg = 'User declined to answer questions.';
      return {
        llmContent: msg,
        returnDisplay: msg,
        summary: msg,
      };
    }

    // If user chose "Chat about this" / "Skip interview" — feedback overrides.
    if (captured.feedback) {
      return {
        llmContent: captured.feedback,
        returnDisplay: 'User requested to chat about the questions.',
        summary: 'User chose to chat',
      };
    }

    const answers = captured.answers;
    const annotations = captured.annotations;

    // Format the result string the LLM sees. Mirrors claude-code's format so
    // model behavior stays consistent.
    const parts = Object.entries(answers).map(([questionText, answer]) => {
      const annotation = annotations?.[questionText];
      const chunks = [`"${questionText}"="${answer}"`];
      if (annotation?.preview) {
        chunks.push(`selected preview:\n${annotation.preview}`);
      }
      if (annotation?.notes) {
        chunks.push(`user notes: ${annotation.notes}`);
      }
      return chunks.join(' ');
    });
    const answersText = parts.join(', ');
    const llmContent = answersText
      ? `User has answered your questions: ${answersText}. You can now continue with the user's answers in mind.`
      : 'User has answered your questions (no answers provided).';

    const bulletLines = Object.entries(answers)
      .map(([q, a]) => `- **${q}** → ${a}`)
      .join('\n');
    const returnDisplay = bulletLines
      ? `**User answered:**\n${bulletLines}`
      : 'User answered your questions.';

    return {
      llmContent,
      returnDisplay,
      summary:
        Object.keys(answers).length > 0
          ? `Collected ${Object.keys(answers).length} answer(s)`
          : 'No answers',
    };
  }
}
