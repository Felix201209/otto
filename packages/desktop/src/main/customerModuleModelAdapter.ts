import { AuthType, SceneType, type CustomerModuleHostAdapterResult } from 'otto-core';

interface ModelRuntimeConfig {
  initialize(): Promise<void>;
  refreshAuth(authType: AuthType): Promise<void>;
  getModel(): string;
  getCustomModelConfig(model: string): { provider?: string } | undefined;
  getOttoClient(): {
    createTemporaryChat(
      scene: SceneType,
      model: string | undefined,
      agent: { type: 'sub'; agentId: string },
      options: { emptySystemPrompt: true },
    ): Promise<{
      sendMessage(input: unknown, promptId: string, scene: SceneType): Promise<{
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      }>;
    }>;
  };
}

export function createCustomerModuleModelInvoke(options: {
  loadConfig?: () => Promise<ModelRuntimeConfig>;
} = {}) {
  let configPromise: Promise<ModelRuntimeConfig> | null = null;
  const loadConfig = options.loadConfig ?? (async () => {
    const { createCoreConfig } = await import('otto-server');
    const config = createCoreConfig({
      sessionId: 'customer-module-foreground-model',
      disableMcpDiscovery: true,
      disableEnvironmentContext: true,
      disableTools: true,
      userRules: 'Respond only to the explicit customer-module request. Do not call tools or access ambient context.',
    });
    await config.initialize();
    await config.refreshAuth(AuthType.USE_PROXY_AUTH);
    return config as unknown as ModelRuntimeConfig;
  });

  return async (payload: unknown, signal?: AbortSignal): Promise<CustomerModuleHostAdapterResult> => {
    const body = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt || prompt.length > 100_000) throw new Error('客户模块模型提示词不能为空且不得超过 100000 字符');
    const maxOutputTokens = typeof body.maxOutputTokens === 'number' && Number.isInteger(body.maxOutputTokens)
      ? Math.min(Math.max(body.maxOutputTokens, 1), 4_096) : 1_024;
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    configPromise ??= loadConfig().catch((error) => { configPromise = null; throw error; });
    const config = await configPromise;
    const model = config.getModel();
    const chat = await config.getOttoClient().createTemporaryChat(
      SceneType.CHAT_CONVERSATION,
      model,
      { type: 'sub', agentId: 'CustomerModuleForegroundModel' },
      { emptySystemPrompt: true },
    );
    const response = await chat.sendMessage({
      message: prompt,
      config: { maxOutputTokens, temperature: 0.2, abortSignal: signal },
    }, `customer-module-${Date.now()}`, SceneType.CHAT_CONVERSATION);
    const text = response.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') ?? '';
    const inputTokens = response.usageMetadata?.promptTokenCount ?? 0;
    const outputTokens = response.usageMetadata?.candidatesTokenCount ?? 0;
    return {
      data: { text },
      provider: config.getCustomModelConfig(model)?.provider ?? model,
      inputTokens,
      outputTokens,
      retryCount: 0,
      estimatedCostUsd: 0,
      costEstimateAvailable: false,
    };
  };
}
