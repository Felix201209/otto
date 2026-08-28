/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { ClientToServer } from 'otto-server';
import {
  authorizeOutboundFileReferences,
  authorizeOutboundWorkspaceFrame,
  hasOutboundPathReference,
  sendAuthorizedFileFrame,
  sendAuthorizedWorkspaceFrame,
} from './outbound-file-authorization.js';

function fileMessage(filePath: string): Extract<ClientToServer, { type: 'send_user_message' }> {
  return {
    type: 'send_user_message',
    payload: {
      sessionId: 's1',
      source: 'local',
      content: [{
        type: 'file_reference',
        value: { fileName: 'report.pdf', filePath },
      }],
    },
  };
}

function folderMessage(folderPath: string): Extract<ClientToServer, { type: 'send_user_message' }> {
  return {
    type: 'send_user_message',
    payload: {
      sessionId: 's1',
      source: 'local',
      content: [{
        type: 'folder_reference',
        value: { folderName: 'workspace', folderPath },
      }],
    },
  };
}

describe('preload 真实模型附件授权闸', () => {
  it('工作目录只使用 main 授权后返回的规范路径', async () => {
    const authorize = vi.fn(async () => '/Volumes/Data/real-project');
    const frame: Extract<ClientToServer, { type: 'set_session_workspace' }> = {
      type: 'set_session_workspace',
      payload: { sessionId: 's1', workspacePath: '/Volumes/Data/project-link' },
    };

    await expect(authorizeOutboundWorkspaceFrame(frame, authorize)).resolves.toEqual({
      type: 'set_session_workspace',
      payload: { sessionId: 's1', workspacePath: '/Volumes/Data/real-project' },
    });
    expect(authorize).toHaveBeenCalledWith('/Volumes/Data/project-link');
  });

  it('工作目录未授权时不产生可发往 server 的帧', async () => {
    const frame: Extract<ClientToServer, { type: 'set_session_workspace' }> = {
      type: 'set_session_workspace',
      payload: { sessionId: 's1', workspacePath: '/private/project' },
    };
    await expect(authorizeOutboundWorkspaceFrame(frame, async () => {
      throw new Error('工作目录未授权');
    })).rejects.toThrow('未授权');
  });

  it('工作目录 bridge 分支把成功帧交给当前发送或断线排队策略', async () => {
    const sendOrQueue = vi.fn();
    const denied = vi.fn();
    const frame: Extract<ClientToServer, { type: 'set_session_workspace' }> = {
      type: 'set_session_workspace',
      payload: { sessionId: 's1', workspacePath: '/alias/project' },
    };

    await sendAuthorizedWorkspaceFrame(frame, async () => '/real/project', sendOrQueue, denied);

    expect(sendOrQueue).toHaveBeenCalledWith({
      type: 'set_session_workspace',
      payload: { sessionId: 's1', workspacePath: '/real/project' },
    });
    expect(denied).not.toHaveBeenCalled();
  });

  it('工作目录 bridge 分支拒绝授权时派发错误且不发送或排队', async () => {
    const sendOrQueue = vi.fn();
    const denied = vi.fn();
    const error = new Error('该目录未授权');
    const frame: Extract<ClientToServer, { type: 'set_session_workspace' }> = {
      type: 'set_session_workspace',
      payload: { sessionId: 's1', workspacePath: '/private/project' },
    };

    await sendAuthorizedWorkspaceFrame(
      frame,
      async () => { throw error; },
      sendOrQueue,
      denied,
    );

    expect(sendOrQueue).not.toHaveBeenCalled();
    expect(denied).toHaveBeenCalledWith(error);
  });

  it('发 WS 前交给 main 授权账本复核，且只发规范路径', async () => {
    const authorize = vi.fn(async () => ['/Volumes/Portable/real/report.pdf']);
    const frame = await authorizeOutboundFileReferences(
      fileMessage('/Volumes/Portable/alias/report.pdf'),
      authorize,
    );

    expect(authorize).toHaveBeenCalledWith([{
      path: '/Volumes/Portable/alias/report.pdf',
      kind: 'file',
    }]);
    expect(frame.payload.content).toEqual([{
      type: 'file_reference',
      value: {
        fileName: 'report.pdf',
        filePath: '/Volumes/Portable/real/report.pdf',
      },
    }]);
  });

  it('main 拒绝未授权路径时不生成可发往 server 的帧', async () => {
    const authorize = vi.fn(async () => {
      throw new Error('该文件未由你选择授权');
    });

    await expect(
      authorizeOutboundFileReferences(fileMessage('/etc/passwd'), authorize),
    ).rejects.toThrow('未由你选择授权');
  });

  it('目录引用走同一授权边界并只发送 main 返回的规范路径', async () => {
    const authorize = vi.fn(async () => ['/Volumes/Portable/real/workspace']);

    expect(hasOutboundPathReference(folderMessage('/Volumes/Portable/alias/workspace'))).toBe(true);
    const frame = await authorizeOutboundFileReferences(
      folderMessage('/Volumes/Portable/alias/workspace'), authorize,
    );
    expect(authorize).toHaveBeenCalledWith([{
      path: '/Volumes/Portable/alias/workspace',
      kind: 'directory',
    }]);
    expect(frame.payload.content).toEqual([{
      type: 'folder_reference',
      value: {
        folderName: 'workspace',
        folderPath: '/Volumes/Portable/real/workspace',
      },
    }]);
  });

  it('附件授权返回后若连接已断开则不入队也不发送', () => {
    const send = vi.fn();
    expect(() => sendAuthorizedFileFrame(fileMessage('/real/report.pdf'), false, send))
      .toThrow('连接已断开');
    expect(send).not.toHaveBeenCalled();

    sendAuthorizedFileFrame(fileMessage('/real/report.pdf'), true, send);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('无 file_reference 的普通帧不走附件 IPC', async () => {
    const authorize = vi.fn(async () => []);
    const frame: ClientToServer = {
      type: 'send_user_message',
      payload: {
        sessionId: 's1',
        source: 'local',
        content: [{ type: 'text', value: 'hello' }],
      },
    };
    expect(await authorizeOutboundFileReferences(frame, authorize)).toBe(frame);
    expect(hasOutboundPathReference(frame)).toBe(false);
    expect(authorize).not.toHaveBeenCalled();
  });
});
