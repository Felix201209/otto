import { describe, expect, it } from 'vitest';
import { MessageFactory, MessageType } from './remoteProtocol.js';

describe('remoteProtocol feishu image message', () => {
  it('should create feishu image message with payload', () => {
    const message = MessageFactory.createFeishuImageMessage({
      imageUrl: 'https://storage.googleapis.com/example/test.png',
      fileName: 'test.png',
      text: '请分析这张图',
      mimeType: 'image/png',
    });

    expect(message.type).toBe(MessageType.FEISHU_IMAGE_MESSAGE);
    expect(message.payload).toEqual({
      imageUrl: 'https://storage.googleapis.com/example/test.png',
      fileName: 'test.png',
      text: '请分析这张图',
      mimeType: 'image/png',
    });
    expect(typeof message.id).toBe('string');
    expect(typeof message.timestamp).toBe('number');
  });
});
