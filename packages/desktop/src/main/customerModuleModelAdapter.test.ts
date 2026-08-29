import { describe, expect, it, vi } from 'vitest';
import { createCustomerModuleModelInvoke } from './customerModuleModelAdapter.js';

describe('customer module foreground model adapter', () => {
  it('uses a tool-free temporary chat and returns provider/token attribution', async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      candidates: [{ content: { parts: [{ text: 'answer' }] } }],
      usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 },
    });
    const createTemporaryChat = vi.fn().mockResolvedValue({ sendMessage });
    const loadConfig = vi.fn().mockResolvedValue({
      initialize: vi.fn(), refreshAuth: vi.fn(), getModel: () => 'custom:test',
      getCustomModelConfig: () => ({ provider: 'openai' }),
      getOttoClient: () => ({ createTemporaryChat }),
    });
    const invoke = createCustomerModuleModelInvoke({ loadConfig });
    await expect(invoke({ prompt: 'hello', maxOutputTokens: 99999 })).resolves.toMatchObject({
      data: { text: 'answer' }, provider: 'openai', inputTokens: 7, outputTokens: 3,
    });
    expect(createTemporaryChat).toHaveBeenCalledWith(expect.anything(), 'custom:test', expect.anything(), { emptySystemPrompt: true });
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ maxOutputTokens: 4096 }) }), expect.any(String), expect.anything());
  });

  it('rejects empty prompts and cancellation before any paid call', async () => {
    const loadConfig = vi.fn();
    const invoke = createCustomerModuleModelInvoke({ loadConfig });
    await expect(invoke({ prompt: '' })).rejects.toThrow(/不能为空/);
    const controller = new AbortController(); controller.abort();
    await expect(invoke({ prompt: 'hello' }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(loadConfig).not.toHaveBeenCalled();
  });
});
