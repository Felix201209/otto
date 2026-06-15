import { describe, expect, it } from 'vitest';
import { MessageFactory } from './remoteProtocol.js';

describe('remoteServer feishu image command conversion', () => {
  it('should build command with text and @absolutePath', () => {
    const absolutePath = 'C:\\project\\.deepvcode\\clipboard\\image.png';
    const message = MessageFactory.createFeishuImageMessage({
      imageUrl: 'https://storage.googleapis.com/example/test.png',
      fileName: 'image.png',
      text: '请分析这张图',
      mimeType: 'image/png',
    });

    const command = `${message.payload.text}\n@${absolutePath}`;

    expect(command).toBe(`请分析这张图\n@${absolutePath}`);
  });

  it('should build command with only @absolutePath when text is empty', () => {
    const absolutePath = 'C:\\project\\.deepvcode\\clipboard\\image.png';
    const message = MessageFactory.createFeishuImageMessage({
      imageUrl: 'https://storage.googleapis.com/example/test.png',
      fileName: 'image.png',
      text: '',
      mimeType: 'image/png',
    });

    const command = message.payload.text ? `${message.payload.text}\n@${absolutePath}` : `@${absolutePath}`;

    expect(command).toBe(`@${absolutePath}`);
  });
});
