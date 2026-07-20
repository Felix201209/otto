/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  ToolConfirmationOutcome,
  type ToolConfirmationPayload,
  type ToolExecuteConfirmationDetails,
} from './tools.js';
import {
  EnterpriseCollaborationTool,
  type EnterpriseCollaborationParams,
} from './enterprise-collaboration.js';

type RelayConfirmation = ToolExecuteConfirmationDetails & {
  onConfirm(
    outcome: ToolConfirmationOutcome,
    payload?: ToolConfirmationPayload,
  ): Promise<void>;
};

const signal = (): AbortSignal => new AbortController().signal;

async function confirmationFor(
  tool: EnterpriseCollaborationTool,
  params: EnterpriseCollaborationParams,
): Promise<RelayConfirmation> {
  const confirmation = await tool.shouldConfirmExecute(params, signal());
  expect(confirmation).not.toBe(false);
  return confirmation as RelayConfirmation;
}

describe('EnterpriseCollaborationTool', () => {
  it('暴露企业树通讯 action，并明确要求先查成员再用真实账号 ID 通讯', () => {
    const tool = new EnterpriseCollaborationTool();
    const actionSchema = tool.schema.parameters?.properties?.action;

    expect(tool.name).toBe('enterprise_collaboration');
    expect(tool.allowSubAgentUse).toBe(false);
    expect(actionSchema?.enum).toEqual([
      'list_members',
      'list_messages',
      'send_message',
      'ask_peer_otto',
      'consult_peer_otto',
    ]);
    expect(tool.description).toContain('list_members');
    expect(tool.description).toContain('enterprise tree');
    expect(tool.description).toContain('permission');
    expect(tool.description).toContain('Never invent');
    expect(tool.description).toContain('current direct chat');
    expect(tool.description).toContain('enterprise knowledge');
    expect(tool.description).toContain('work logs');
    expect(tool.description).toContain('schedules');
    expect(tool.description).toContain('does not include files, API keys, or other chats');
    expect(tool.description).not.toContain('allow full access');
  });

  it.each([
    { action: 'list_members' },
    { action: 'list_messages', recipientAccountId: 'acc_peer-1' },
    {
      action: 'send_message',
      recipientAccountId: 'acc_peer-1',
      content: '项目状态更新',
    },
    {
      action: 'ask_peer_otto',
      recipientAccountId: 'acc_peer-1',
      question: '这周有哪些可共享的项目风险？',
    },
    {
      action: 'consult_peer_otto',
      recipientAccountId: 'acc_peer-1',
      question: '请协商双方下周都可行的会议时间。',
    },
  ] as EnterpriseCollaborationParams[])(
    '每个合法 action 都必须经过带 warning 的客户端执行中继：$action',
    async (params) => {
      const tool = new EnterpriseCollaborationTool();
      const confirmation = await confirmationFor(tool, params);

      expect(confirmation.type).toBe('exec');
      expect(confirmation.title).toContain(params.action);
      expect(confirmation.warning).toContain('客户端');
      expect(confirmation.rootCommand).toBe('enterprise_collaboration');
      expect(confirmation.command).toBe(
        `enterprise_collaboration ${JSON.stringify(params)}`,
      );
    },
  );

  it('只返回 renderer 在确认回调中提交的真实 JSON 结果，并在读取后销毁', async () => {
    const tool = new EnterpriseCollaborationTool();
    const params: EnterpriseCollaborationParams = { action: 'list_members' };
    const confirmation = await confirmationFor(tool, params);
    const rendererResult = JSON.stringify({
      members: [{ id: 'acc_peer-1', name: 'Alice' }],
    });

    await confirmation.onConfirm(ToolConfirmationOutcome.ProceedOnce, {
      newContent: rendererResult,
    });

    await expect(tool.execute(params, signal())).resolves.toEqual({
      llmContent: rendererResult,
      returnDisplay: rendererResult,
    });
    await expect(tool.execute(params, signal())).rejects.toThrow(
      '尚未通过客户端确认',
    );
  });

  it('未确认、取消、缺少结果、非 JSON 和 JSON primitive 都会 fail-loud', async () => {
    const unconfirmedTool = new EnterpriseCollaborationTool();
    await expect(
      unconfirmedTool.execute({ action: 'list_members' }, signal()),
    ).rejects.toThrow('尚未通过客户端确认');

    const cancelledTool = new EnterpriseCollaborationTool();
    const cancelledParams: EnterpriseCollaborationParams = {
      action: 'list_members',
    };
    const cancelled = await confirmationFor(cancelledTool, cancelledParams);
    await cancelled.onConfirm(ToolConfirmationOutcome.Cancel);
    await expect(
      cancelledTool.execute(cancelledParams, signal()),
    ).rejects.toThrow('已取消');

    const missingTool = new EnterpriseCollaborationTool();
    const missingParams: EnterpriseCollaborationParams = {
      action: 'list_members',
    };
    const missing = await confirmationFor(missingTool, missingParams);
    await missing.onConfirm(ToolConfirmationOutcome.ProceedOnce);
    await expect(missingTool.execute(missingParams, signal())).rejects.toThrow(
      '没有返回 JSON',
    );

    const invalidJsonTool = new EnterpriseCollaborationTool();
    const invalidJsonParams: EnterpriseCollaborationParams = {
      action: 'list_members',
    };
    const invalidJson = await confirmationFor(
      invalidJsonTool,
      invalidJsonParams,
    );
    await invalidJson.onConfirm(ToolConfirmationOutcome.ProceedOnce, {
      newContent: 'not-json',
    });
    await expect(
      invalidJsonTool.execute(invalidJsonParams, signal()),
    ).rejects.toThrow('不是有效 JSON');

    const primitiveTool = new EnterpriseCollaborationTool();
    const primitiveParams: EnterpriseCollaborationParams = {
      action: 'list_members',
    };
    const primitive = await confirmationFor(primitiveTool, primitiveParams);
    await primitive.onConfirm(ToolConfirmationOutcome.ProceedOnce, {
      newContent: '"not-structured"',
    });
    await expect(
      primitiveTool.execute(primitiveParams, signal()),
    ).rejects.toThrow('必须是 JSON 对象或数组');
  });

  it.each([
    [{ action: 'unknown' }, 'action'],
    [{ action: 'list_messages' }, 'recipientAccountId'],
    [
      { action: 'send_message', recipientAccountId: 'bad id', content: 'hi' },
      'recipientAccountId',
    ],
    [
      {
        action: 'send_message',
        recipientAccountId: 'acc_peer-1',
        content: '   ',
      },
      'content',
    ],
    [
      {
        action: 'send_message',
        recipientAccountId: 'acc_peer-1',
        content: 'x'.repeat(4001),
      },
      'content',
    ],
    [{ action: 'ask_peer_otto', recipientAccountId: 'acc_peer-1' }, 'question'],
    [
      {
        action: 'consult_peer_otto',
        recipientAccountId: 'acc_peer-1',
        question: 'x'.repeat(4001),
      },
      'question',
    ],
    [
      {
        action: 'list_members',
        recipientAccountId: 'acc_peer-1',
      },
      '不接受 recipientAccountId',
    ],
    [
      {
        action: 'ask_peer_otto',
        recipientAccountId: 'acc_peer-1',
        question: '可以共享的时间？',
        content: '不应混用',
      },
      '不接受 content',
    ],
  ])('严格拒绝非法或 action 不匹配的参数 %#', async (raw, message) => {
    const tool = new EnterpriseCollaborationTool();
    const params = raw as EnterpriseCollaborationParams;

    expect(tool.validateToolParams(params)).toContain(message);
    await expect(tool.shouldConfirmExecute(params, signal())).resolves.toBe(
      false,
    );
    await expect(tool.execute(params, signal())).rejects.toThrow(message);
  });
});
