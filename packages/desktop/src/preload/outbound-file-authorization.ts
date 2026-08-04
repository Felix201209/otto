/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * preload 是 renderer 与本地 server 之间的信任边界。renderer 可以构造任意
 * ClientToServer 对象，所以 file_reference/folder_reference 不能直接进 WS；必须先交给 main
 * 进程内的授权账本复核，再用 main 返回的 realpath 重建帧。
 */

import type { ClientToServer } from 'otto-server';

export interface OutboundPathReference {
  path: string;
  kind: 'file' | 'directory';
}
export type AuthorizePathReferences = (
  references: OutboundPathReference[],
) => Promise<string[]>;
export type SendAuthorizedFrame = (frame: ClientToServer) => void;

/** renderer 可构造任意帧；所有会让 server 读取本机路径的内容都算路径引用。 */
export function hasOutboundPathReference(frame: ClientToServer): boolean {
  return frame.type === 'send_user_message'
    && frame.payload.content.some(
      (part) => part.type === 'file_reference' || part.type === 'folder_reference',
    );
}

/**
 * 文件与目录授权只对当前连接有效。授权 IPC 返回后若 WS 已断开，禁止把含 realpath 的
 * 帧放进通用重连队列；让 renderer 明确重试，才能在新会话/新账号下重新授权。
 */
export function sendAuthorizedFileFrame(
  frame: ClientToServer,
  transportOpen: boolean,
  send: SendAuthorizedFrame,
): void {
  if (!transportOpen) {
    throw new Error('连接已断开，附件授权已失效，请重新发送');
  }
  send(frame);
}

export async function authorizeOutboundFileReferences<T extends ClientToServer>(
  frame: T,
  authorize: AuthorizePathReferences,
): Promise<T> {
  if (frame.type !== 'send_user_message') return frame;
  const pathParts = frame.payload.content.filter(
    (part) => part.type === 'file_reference' || part.type === 'folder_reference',
  );
  if (pathParts.length === 0) return frame;

  const resolved = await authorize(
    pathParts.map((part) => part.type === 'file_reference'
      ? { path: part.value.filePath, kind: 'file' as const }
      : { path: part.value.folderPath, kind: 'directory' as const }),
  );
  if (
    resolved.length !== pathParts.length ||
    resolved.some((filePath) => typeof filePath !== 'string' || !filePath)
  ) {
    throw new Error('附件授权回包无效，消息未发送');
  }

  let pathIndex = 0;
  return {
    ...frame,
    payload: {
      ...frame.payload,
      content: frame.payload.content.map((part) => {
        if (part.type === 'file_reference') {
          const filePath = resolved[pathIndex++];
          return { ...part, value: { ...part.value, filePath } };
        }
        if (part.type === 'folder_reference') {
          const folderPath = resolved[pathIndex++];
          return { ...part, value: { ...part.value, folderPath } };
        }
        return part;
      }),
    },
  } as T;
}
