/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * Structured enterprise collaboration relay.
 *
 * This Core tool deliberately owns no HTTP, IPC, filesystem, or A2A protocol
 * implementation. The renderer executes the requested operation after the
 * mandatory confirmation gate and returns its real JSON result through the
 * confirmation payload.
 */

import { Type } from '@google/genai';
import {
  BaseTool,
  Icon,
  type ToolCallConfirmationDetails,
  ToolConfirmationOutcome,
  type ToolConfirmationPayload,
  type ToolExecuteConfirmationDetails,
  type ToolResult,
} from './tools.js';

export type EnterpriseCollaborationAction =
  | 'list_members'
  | 'list_messages'
  | 'send_message'
  | 'ask_peer_otto'
  | 'consult_peer_otto'
  | 'assign_member_position';

export interface EnterpriseCollaborationParams {
  action: EnterpriseCollaborationAction;
  recipientAccountId?: string;
  content?: string;
  question?: string;
  department?: string;
  positionTitle?: string;
  role?: string;
}

interface RelayState {
  status: 'pending' | 'result' | 'cancelled' | 'error';
  result?: string;
  error?: string;
}

const ACTIONS: readonly EnterpriseCollaborationAction[] = [
  'list_members',
  'list_messages',
  'send_message',
  'ask_peer_otto',
  'consult_peer_otto',
  'assign_member_position',
];

const RECIPIENT_ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MAX_TEXT_LENGTH = 4000;

const DESCRIPTION = `Communicate with coworkers under the authenticated enterprise tree through the Otto desktop client.

Required workflow:
1. Call list_members first and use the returned account ID. Never invent, guess, or reuse an ID from another organization.
2. Call list_messages with recipientAccountId to read the real direct-message thread.
3. Call send_message with recipientAccountId and content for an ordinary employee-to-employee message.
4. Call ask_peer_otto with recipientAccountId and question only when the user asks another employee's Otto. The recipient controls permission and may allow all four permitted categories (current direct chat, enterprise knowledge, work logs, and schedules), allow only selected categories, or deny the request. This scope does not include files, API keys, or other chats. Respect the returned scope; never bypass it.
5. Call consult_peer_otto with recipientAccountId and question only for the lower-frequency two-Otto negotiation flow, such as comparing schedules, agreeing on a meeting time, or producing a cooperation plan. The client performs the real negotiation.
6. If and only if the authenticated user is an enterprise administrator, call assign_member_position with a list_members recipientAccountId, department, positionTitle, and optional role to make a real organization assignment. The client rechecks the administrator identity and same-organization member immediately before updating the account. Never claim success unless the client returns the updated member.

When answering about the current user's own information, answer normally instead of calling ask_peer_otto. This tool is a structured confirmation relay: it does not access the network or filesystem and does not invent or hand-build A2A protocol messages. Every action must be executed by the client confirmation UI, and only the client's real JSON result may be treated as the outcome.`;

export class EnterpriseCollaborationTool extends BaseTool<
  EnterpriseCollaborationParams,
  ToolResult
> {
  static readonly Name = 'enterprise_collaboration';

  private readonly relayStates = new WeakMap<object, RelayState>();

  constructor() {
    super(
      EnterpriseCollaborationTool.Name,
      'EnterpriseCollaboration',
      DESCRIPTION,
      Icon.Info,
      {
        type: Type.OBJECT,
        properties: {
          action: {
            type: Type.STRING,
            enum: [...ACTIONS],
            description:
              'Structured enterprise-tree operation. Start with list_members before targeting a coworker.',
          },
          recipientAccountId: {
            type: Type.STRING,
            description:
              'Exact same-organization account ID returned by list_members. Required for every action except list_members.',
          },
          content: {
            type: Type.STRING,
            description:
              'Ordinary direct-message body (1-4000 characters). Used only by send_message.',
          },
          question: {
            type: Type.STRING,
            description:
              'Question or negotiation goal (1-4000 characters). Used only by ask_peer_otto and consult_peer_otto.',
          },
          department: {
            type: Type.STRING,
            description:
              'Department name (1-160 characters). Used only by assign_member_position.',
          },
          positionTitle: {
            type: Type.STRING,
            description:
              'Position title (1-160 characters). Used only by assign_member_position.',
          },
          role: {
            type: Type.STRING,
            description:
              'Optional organization role label (1-160 characters). Used only by assign_member_position.',
          },
        },
        required: ['action'],
      },
      true,
      false,
      false,
      false,
    );
  }

  override validateToolParams(
    params: EnterpriseCollaborationParams,
  ): string | null {
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      return 'enterprise_collaboration params 必须是对象';
    }

    const raw = params as unknown as Record<string, unknown>;
    if (
      typeof raw.action !== 'string' ||
      !ACTIONS.includes(raw.action as EnterpriseCollaborationAction)
    ) {
      return `action 必须是以下值之一：${ACTIONS.join(', ')}`;
    }

    const unknownFields = Object.keys(raw).filter(
      (key) =>
        ![
          'action',
          'recipientAccountId',
          'content',
          'question',
          'department',
          'positionTitle',
          'role',
        ].includes(key),
    );
    if (unknownFields.length > 0) {
      return `不接受未知参数：${unknownFields.join(', ')}`;
    }

    const action = raw.action as EnterpriseCollaborationAction;
    const needsRecipient = action !== 'list_members';
    if (needsRecipient) {
      if (
        typeof raw.recipientAccountId !== 'string' ||
        !RECIPIENT_ACCOUNT_ID.test(raw.recipientAccountId)
      ) {
        return 'recipientAccountId 必须是 list_members 返回的 1 到 128 位账号 ID，只能包含字母、数字、下划线和连字符';
      }
    } else if (raw.recipientAccountId !== undefined) {
      return 'list_members 不接受 recipientAccountId';
    }

    if (action === 'send_message') {
      const contentError = this.validateText(raw.content, 'content');
      if (contentError) return contentError;
    } else if (raw.content !== undefined) {
      return `${action} 不接受 content`;
    }

    if (action === 'ask_peer_otto' || action === 'consult_peer_otto') {
      const questionError = this.validateText(raw.question, 'question');
      if (questionError) return questionError;
    } else if (raw.question !== undefined) {
      return `${action} 不接受 question`;
    }

    if (action === 'assign_member_position') {
      const departmentError = this.validateAssignmentText(
        raw.department,
        'department',
      );
      if (departmentError) return departmentError;
      const positionError = this.validateAssignmentText(
        raw.positionTitle,
        'positionTitle',
      );
      if (positionError) return positionError;
      if (raw.role !== undefined) {
        const roleError = this.validateAssignmentText(raw.role, 'role');
        if (roleError) return roleError;
      }
    } else {
      for (const field of ['department', 'positionTitle', 'role'] as const) {
        if (raw[field] !== undefined) return `${action} 不接受 ${field}`;
      }
    }

    return null;
  }

  override getDescription(params: EnterpriseCollaborationParams): string {
    const recipient = params.recipientAccountId
      ? ` for ${params.recipientAccountId}`
      : '';
    return `Run enterprise collaboration action ${params.action}${recipient} through the Otto client`;
  }

  override async shouldConfirmExecute(
    params: EnterpriseCollaborationParams,
    abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails | false> {
    const validationError = this.validateToolParams(params);
    if (validationError) return false;
    if (abortSignal.aborted) {
      throw new Error('enterprise_collaboration 确认已取消');
    }

    const relayState: RelayState = { status: 'pending' };
    this.relayStates.set(params, relayState);

    const details: ToolExecuteConfirmationDetails = {
      type: 'exec',
      title: `企业协作：${params.action}`,
      command: `enterprise_collaboration ${JSON.stringify(params)}`,
      rootCommand: EnterpriseCollaborationTool.Name,
      warning:
        '此操作必须由 Otto 客户端在当前企业身份下执行；Core 不会访问网络，也不会伪造企业成员、消息或 A2A 结果。',
      onConfirm: async (
        outcome: ToolConfirmationOutcome,
        payload?: ToolConfirmationPayload,
      ) => {
        if (this.relayStates.get(params) !== relayState) {
          throw new Error('enterprise_collaboration 确认结果已过期');
        }
        if (outcome === ToolConfirmationOutcome.Cancel) {
          relayState.status = 'cancelled';
          return;
        }

        const rawResult = payload?.newContent;
        if (typeof rawResult !== 'string' || !rawResult.trim()) {
          relayState.status = 'error';
          relayState.error = '客户端没有返回 JSON 执行结果';
          return;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(rawResult);
        } catch {
          relayState.status = 'error';
          relayState.error = '客户端返回的执行结果不是有效 JSON';
          return;
        }
        if (parsed === null || typeof parsed !== 'object') {
          relayState.status = 'error';
          relayState.error = '客户端执行结果必须是 JSON 对象或数组';
          return;
        }

        relayState.status = 'result';
        relayState.result = JSON.stringify(parsed);
      },
    };

    return details;
  }

  override async execute(
    params: EnterpriseCollaborationParams,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const validationError = this.validateToolParams(params);
    if (validationError) {
      throw new Error(`enterprise_collaboration 参数错误：${validationError}`);
    }
    if (signal.aborted) {
      throw new Error('enterprise_collaboration 执行已取消');
    }

    const relayState = this.relayStates.get(params);
    if (!relayState || relayState.status === 'pending') {
      throw new Error('enterprise_collaboration 尚未通过客户端确认并执行');
    }
    this.relayStates.delete(params);

    if (relayState.status === 'cancelled') {
      throw new Error('enterprise_collaboration 已取消');
    }
    if (relayState.status === 'error') {
      throw new Error(`enterprise_collaboration 失败：${relayState.error}`);
    }
    if (!relayState.result) {
      throw new Error('enterprise_collaboration 客户端没有返回 JSON 执行结果');
    }

    return {
      llmContent: relayState.result,
      returnDisplay: relayState.result,
    };
  }

  private validateText(
    value: unknown,
    field: 'content' | 'question',
  ): string | null {
    if (
      typeof value !== 'string' ||
      value.trim().length < 1 ||
      value.length > MAX_TEXT_LENGTH
    ) {
      return `${field} 长度必须为 1 到 ${MAX_TEXT_LENGTH} 个字符`;
    }
    return null;
  }

  private validateAssignmentText(
    value: unknown,
    field: 'department' | 'positionTitle' | 'role',
  ): string | null {
    if (
      typeof value !== 'string'
      || value.trim().length < 1
      || value.trim().length > 160
    ) {
      return `${field} 长度必须为 1 到 160 个字符`;
    }
    return null;
  }
}
