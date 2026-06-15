import { describe, expect, it } from 'vitest';
import { MessageFactory, MessageType } from './remoteProtocol.js';

describe('remoteProtocol get status messages', () => {
  it('should create GET_STATUS_REQUEST message', () => {
    const message = MessageFactory.createGetStatusRequest();

    expect(message.type).toBe(MessageType.GET_STATUS_REQUEST);
    expect(message.payload).toEqual({});
    expect(typeof message.id).toBe('string');
    expect(typeof message.timestamp).toBe('number');
  });

  it('should create GET_STATUS_RESPONSE message with full status', () => {
    const payload = {
      version: '1.0.320',
      model: 'gemini-2.5-flash',
      contextTokens: 45000,
      contextMaxTokens: 200000,
      sessionId: 'abc-123',
      workingDir: 'D:\\projects\\test',
      gitBranch: 'main',
    };

    const message = MessageFactory.createGetStatusResponse(payload);

    expect(message.type).toBe(MessageType.GET_STATUS_RESPONSE);
    expect(message.payload.version).toBe('1.0.320');
    expect(message.payload.model).toBe('gemini-2.5-flash');
    expect(message.payload.contextTokens).toBe(45000);
    expect(message.payload.contextMaxTokens).toBe(200000);
    expect(message.payload.sessionId).toBe('abc-123');
    expect(message.payload.workingDir).toBe('D:\\projects\\test');
    expect(message.payload.gitBranch).toBe('main');
    expect(typeof message.id).toBe('string');
    expect(typeof message.timestamp).toBe('number');
  });

  it('should handle empty git branch', () => {
    const payload = {
      version: '1.0.320',
      model: 'auto',
      contextTokens: 0,
      contextMaxTokens: 200000,
      sessionId: 'xyz-789',
      workingDir: '/home/user',
      gitBranch: '',
    };

    const message = MessageFactory.createGetStatusResponse(payload);

    expect(message.payload.gitBranch).toBe('');
    expect(message.payload.contextTokens).toBe(0);
  });
});
