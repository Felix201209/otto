import { describe, expect, it } from 'vitest';
import { MessageFactory, MessageType } from './remoteProtocol.js';

describe('remoteProtocol get models messages', () => {
  it('should create GET_MODELS_REQUEST message', () => {
    const message = MessageFactory.createGetModelsRequest();

    expect(message.type).toBe(MessageType.GET_MODELS_REQUEST);
    expect(message.payload).toEqual({});
    expect(typeof message.id).toBe('string');
    expect(typeof message.timestamp).toBe('number');
  });

  it('should create GET_MODELS_RESPONSE message with models list', () => {
    const models = [
      { id: 'auto', name: 'Auto (Recommended)', current: true },
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', current: false },
      { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', current: false },
    ];

    const message = MessageFactory.createGetModelsResponse(models);

    expect(message.type).toBe(MessageType.GET_MODELS_RESPONSE);
    expect(message.payload.models).toHaveLength(3);
    expect(message.payload.models[0]).toEqual({
      id: 'auto',
      name: 'Auto (Recommended)',
      current: true,
    });
    expect(message.payload.models[1].current).toBe(false);
    expect(typeof message.id).toBe('string');
    expect(typeof message.timestamp).toBe('number');
  });

  it('should mark the current model correctly', () => {
    const models = [
      { id: 'auto', name: 'Auto', current: false },
      { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', current: true },
    ];

    const message = MessageFactory.createGetModelsResponse(models);

    const currentModels = message.payload.models.filter(m => m.current);
    expect(currentModels).toHaveLength(1);
    expect(currentModels[0].id).toBe('claude-sonnet-4');
  });
});
