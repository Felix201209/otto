/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type {
  ExternalInboundNotificationMsg,
  ServerToClient,
  SessionSummary,
} from './protocol.js';

/** 把真实外部 user message_start 规整为桌面通知；本地/助手帧不产生通知。 */
export function externalInboundNotificationFromFrame(
  frame: ServerToClient,
  session?: SessionSummary,
): ExternalInboundNotificationMsg | null {
  if (frame.type !== 'message_start') return null;
  const message = frame.payload.message;
  if (
    message.role !== 'user' ||
    message.source === 'local' ||
    message.source === 'tui'
  ) {
    return null;
  }
  const preview = message.content
    .map((part) => {
      switch (part.type) {
        case 'text': return part.value;
        case 'file_reference': return '[文件]';
        case 'folder_reference': return '[文件夹]';
        case 'image_reference': return '[图片]';
        case 'code_reference': return '[代码]';
        case 'text_file_content': return `[文件 ${part.value.fileName}]`;
        default: return '';
      }
    })
    .join(' ')
    .trim()
    .slice(0, 200) || '(非文本消息)';
  return {
    type: 'external_inbound_notification',
    payload: {
      messageId: message.id,
      sessionId: message.sessionId,
      source: message.source,
      ...(session?.title ? { sender: session.title } : {}),
      preview,
    },
  };
}
