/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { ClientToServer } from 'otto-server';
import {
  authorizeOutboundFileReferences,
  hasOutboundPathReference,
  sendAuthorizedFileFrame,
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
  it('发 WS 前交给 main 授权账本复核，且只发规范路径', async () => {
    const authorize = vi.fn(async () => ['/Volumes/Portable/real/report.pdf']);
    const frame = await authorizeOutboundFileReferences(
      fileMessage('/Volumes/Portable/alias/report.pdf'),
      authorize,
    );

    expect(authorize).toHaveBeenCalledWith(['/Volumes/Portable/alias/report.pdf']);
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

  it('目录引用在目录选择与授权账本实现前 fail closed', async () => {
    const authorize = vi.fn(async () => ['/tmp/workspace']);

    expect(hasOutboundPathReference(folderMessage('/etc'))).toBe(true);
    await expect(
      authorizeOutboundFileReferences(folderMessage('/etc'), authorize),
    ).rejects.toThrow('目录附件暂不支持');
    expect(authorize).not.toHaveBeenCalled();
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
