/**
 * 浏览器静态预览桥。
 *
 * Electron 会由 preload 注入 window.otto；只有普通浏览器缺少该对象时才启用这里的
 * 纯本地模拟实现。它不访问园区服务器，所有会话、模型和回复均为演示数据。
 */

type PreviewFrame = { type: string; payload: Record<string, unknown> };
type PreviewWindow = Window & { otto?: Record<string, unknown> };

const previewWindow = window as PreviewWindow;

if (!previewWindow.otto) {
  const frameHandlers = new Set<(frame: PreviewFrame) => void>();
  const connectionHandlers = new Set<(connected: boolean) => void>();
  const modelStorageKey = 'otto:browser-preview-models';
  let connected = false;
  let currentModel: string | null = 'preview-model';
  let sessions = [makeSession('preview-session', '园区服务本地演示')];
  let models = readModels();

  function makeSession(sessionId: string, title: string): Record<string, unknown> {
    return { sessionId, title, model: currentModel, status: 'idle', messageCount: 0, createdAt: Date.now(), updatedAt: Date.now() };
  }
  function readModels(): Array<Record<string, unknown>> {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(modelStorageKey) ?? '[]');
      if (Array.isArray(stored) && stored.length > 0) return stored as Array<Record<string, unknown>>;
    } catch { /* 隐私模式或损坏数据时使用默认模型 */ }
    return [{ id: 'preview-model', displayName: 'gpt-5.1（本地预览）', provider: 'openai', enabled: true }];
  }
  function persistModels(): void {
    try { localStorage.setItem(modelStorageKey, JSON.stringify(models)); } catch { /* 不可持久化时仍可在当前页使用 */ }
  }
  function emit(type: string, payload: Record<string, unknown>): void {
    const frame = { type, payload };
    frameHandlers.forEach((handler) => { try { handler(frame); } catch { /* 单个监听器不阻断 */ } });
  }
  function emitModels(): void { emit('models_list', { models, current: currentModel }); }
  function id(prefix: string): string { return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`; }

  const bridge: Record<string, unknown> = {
    connect: () => {
      connected = true;
      connectionHandlers.forEach((handler) => { try { handler(true); } catch { /* 忽略 */ } });
      window.setTimeout(() => { emit('sessions_list', { sessions }); emitModels(); }, 40);
      return Promise.resolve(true);
    },
    disconnect: () => {
      connected = false;
      connectionHandlers.forEach((handler) => { try { handler(false); } catch { /* 忽略 */ } });
    },
    isConnected: () => connected,
    onFrame: (handler: (frame: PreviewFrame) => void) => { frameHandlers.add(handler); return () => frameHandlers.delete(handler); },
    onConnectionChange: (handler: (state: boolean) => void) => {
      connectionHandlers.add(handler);
      try { handler(connected); } catch { /* 忽略 */ }
      return () => connectionHandlers.delete(handler);
    },
    send: (frame: { type?: string; payload?: Record<string, unknown> }) => {
      const payload = frame.payload ?? {};
      if (frame.type === 'list_sessions') emit('sessions_list', { sessions });
      if (frame.type === 'get_models' || frame.type === 'list_models') emitModels();
      if (frame.type === 'get_history') emit('history', { sessionId: payload.sessionId, messages: [] });
      if (frame.type === 'create_session') {
        const session = makeSession(id('preview-session'), String(payload.title ?? '新对话'));
        sessions = [session, ...sessions];
        emit('session_created', { session, clientRequestId: payload.clientRequestId });
      }
      if (frame.type === 'set_model') {
        currentModel = String(payload.model ?? currentModel);
        sessions = sessions.map((session) => session.sessionId === payload.sessionId ? { ...session, model: currentModel, updatedAt: Date.now() } : session);
        emitModels();
      }
      if (frame.type === 'save_custom_model') {
        const provider = String(payload.provider ?? 'openai');
        const modelId = String(payload.modelId ?? 'gpt-5.1');
        const model = { id: String(payload.replaceId ?? `custom:${provider}:${modelId}:${Date.now()}`), displayName: String(payload.displayName ?? modelId), provider, baseUrl: String(payload.baseUrl ?? ''), enabled: true, isCustom: true };
        models = [...models.filter((item) => item.id !== model.id), model];
        currentModel = model.id;
        persistModels();
        window.setTimeout(emitModels, 50);
      }
      if (frame.type === 'delete_custom_model') {
        models = models.filter((item) => item.id !== payload.id);
        if (!models.some((item) => item.id === currentModel)) currentModel = String(models[0]?.id ?? '');
        persistModels();
        window.setTimeout(emitModels, 50);
      }
      if (frame.type === 'send_user_message') {
        const sessionId = String(payload.sessionId ?? 'preview-session');
        const messageId = id('assistant');
        emit('message_start', { message: { id: messageId, sessionId, role: 'assistant', content: [{ type: 'text', value: '' }], timestamp: Date.now(), source: 'local', isStreaming: true } });
        window.setTimeout(() => {
          const text = '这是浏览器本地预览。园区服务的完整模拟流程可在右侧「园区服务」中演示。';
          emit('chat_chunk', { sessionId, messageId, delta: text });
          emit('chat_complete', { sessionId, messageId, text, finishReason: 'stop' });
        }, 160);
      }
    },
    parkConfig: () => Promise.resolve(null),
    onMenu: () => () => {}, onUpdateProgress: () => () => {},
    appVersion: () => Promise.resolve('1.8.5-browser-preview'),
    openExternal: () => Promise.resolve(), openPath: () => Promise.resolve(), saveTextFile: () => Promise.resolve(null),
    updateCheck: () => Promise.resolve({ status: 'up-to-date', currentVersion: '1.8.5', latestVersion: null }),
    updateDownload: () => Promise.resolve({ ok: false, error: '浏览器预览不支持更新' }), updateCancel: () => Promise.resolve(), updateInstall: () => Promise.resolve({ ok: false, message: '浏览器预览不支持安装' }),
    themeGet: () => Promise.resolve('dark'), themeSet: () => Promise.resolve('dark'),
    enterpriseSession: () => Promise.resolve(null), enterpriseLogout: () => Promise.resolve(),
    enterpriseUsageRecord: () => Promise.resolve({ recorded: false }), enterpriseKnowledgeRecord: () => Promise.resolve({ added: false }),
  };

  previewWindow.otto = new Proxy(bridge, {
    get(target, key) { return key in target ? target[key as string] : () => Promise.resolve(null); },
  });
}
