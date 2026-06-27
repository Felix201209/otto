/**
 * Tests for the model reconciliation logic added to SessionManager.
 *
 * Covers:
 * 1. `updateSessionModelConfig` defensive validation (reject empty/non-string modelName)
 * 2. `ensureAIServiceInitialized` runtime model reconciliation when initialized AIService
 *    has drifted from session.modelConfig.modelName
 *
 * These tests use stub injection into the SessionManager's internal Maps to avoid
 * the full session lifecycle (which requires AI services, persistence, communication).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// 🎯 Mock vscode module (sessionManager imports it at module load)
vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: undefined,
    rootPath: undefined,
    getConfiguration: vi.fn(() => ({
      get: vi.fn((_key: string, defaultValue: unknown) => defaultValue),
      update: vi.fn(),
    })),
  },
  window: {
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    showWarningMessage: vi.fn(),
  },
  Uri: {
    file: (p: string) => ({ fsPath: p }),
    joinPath: (uri: any, ...paths: string[]) => ({
      fsPath: uri.fsPath + '/' + paths.join('/'),
    }),
  },
  EventEmitter: class EventEmitter {
    fire() {}
    dispose() {}
  },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  env: { appRoot: '/test/app/root' },
}));

// 🎯 Mock otto-core (used by AIService transitively)
vi.mock('otto-core', () => ({
  getAllMCPServerToolCounts: vi.fn(() => ({})),
  getAllMCPServerToolNames: vi.fn(() => ({})),
  MCPServerStatus: {},
}));

// 🎯 Mock the AIService and SessionPersistenceService modules to avoid pulling in
// their (heavy) transitive dependencies at module-load time.
vi.mock('./aiService', () => ({
  AIService: class FakeAIService {},
}));

vi.mock('./sessionPersistence', () => ({
  SessionPersistenceService: class FakePersistence {
    initialize = vi.fn();
    saveSession = vi.fn();
    loadAllSessions = vi.fn(() => Promise.resolve([]));
    deleteSession = vi.fn();
  },
}));

vi.mock('./multiSessionCommunicationService', () => ({
  MultiSessionCommunicationService: class FakeComm {
    on = vi.fn();
  },
}));

import { SessionManager } from './sessionManager';

// ----- Test fixtures -----

function createFakeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function createFakeExtensionContext() {
  return {
    extensionPath: '/test/ext',
    globalState: {
      get: vi.fn(),
      update: vi.fn(),
    },
    subscriptions: [],
  } as any;
}

function createFakeCommunicationService() {
  return {
    on: vi.fn(),
    off: vi.fn(),
  } as any;
}

/**
 * Build a minimal valid SessionState to inject directly into SessionManager's Map,
 * bypassing the createSession flow.
 */
function buildSessionState(id: string, modelName: string | undefined) {
  return {
    info: {
      id,
      name: 'test',
      type: 'chat',
      createdAt: Date.now(),
      lastActivity: Date.now(),
    },
    modelConfig: modelName !== undefined ? { modelName } : {},
    context: {},
    settings: {},
    messages: [],
  } as any;
}

/**
 * Build a fake AIService with controllable initialized state and runtime model.
 */
function buildFakeAIService(opts: {
  initialized: boolean;
  runtimeModel?: string;
  switchModelImpl?: (model: string) => Promise<{ success: boolean; error?: string }>;
}) {
  const switchModelMock = vi.fn(
    opts.switchModelImpl ?? (async () => ({ success: true }))
  );

  const setModelMock = vi.fn();

  const fakeGeminiClient = { switchModel: switchModelMock };

  const fakeConfig = {
    getModel: () => opts.runtimeModel,
    getOttoClient: () => fakeGeminiClient,
    setModel: setModelMock,
  };

  return {
    isServiceInitialized: opts.initialized,
    getConfig: () => (opts.initialized ? fakeConfig : undefined),
    getOttoClient: () => (opts.initialized ? fakeGeminiClient : undefined),
    initialize: vi.fn(async () => {
      /* not used in initialized=true path */
    }),
    _mocks: { switchModelMock, setModelMock },
  } as any;
}

// ----- Tests -----

describe('SessionManager.updateSessionModelConfig — defensive validation', () => {
  let manager: SessionManager;
  let logger: ReturnType<typeof createFakeLogger>;

  beforeEach(() => {
    logger = createFakeLogger();
    manager = new SessionManager(
      logger as any,
      createFakeCommunicationService(),
      createFakeExtensionContext()
    );
    // Inject session directly into private map
    const session = buildSessionState('s1', 'modelA');
    (manager as any).sessions.set('s1', session);
  });

  it('accepts a valid non-empty modelName', async () => {
    await manager.updateSessionModelConfig('s1', { modelName: 'modelB' });
    const stored = (manager as any).sessions.get('s1');
    expect(stored.modelConfig.modelName).toBe('modelB');
  });

  it('rejects empty string modelName and warns', async () => {
    await manager.updateSessionModelConfig('s1', { modelName: '' });
    const stored = (manager as any).sessions.get('s1');
    // Should remain unchanged
    expect(stored.modelConfig.modelName).toBe('modelA');
    expect(logger.warn).toHaveBeenCalled();
  });

  it('rejects whitespace-only modelName', async () => {
    await manager.updateSessionModelConfig('s1', { modelName: '   ' });
    const stored = (manager as any).sessions.get('s1');
    expect(stored.modelConfig.modelName).toBe('modelA');
  });

  it('rejects non-string modelName (number)', async () => {
    await manager.updateSessionModelConfig('s1', { modelName: 123 as any });
    const stored = (manager as any).sessions.get('s1');
    expect(stored.modelConfig.modelName).toBe('modelA');
  });

  it('rejects non-string modelName (null)', async () => {
    await manager.updateSessionModelConfig('s1', { modelName: null as any });
    const stored = (manager as any).sessions.get('s1');
    expect(stored.modelConfig.modelName).toBe('modelA');
  });

  it('allows update when modelName is omitted (other fields update untouched)', async () => {
    // modelName undefined should not trigger the rejection path
    await manager.updateSessionModelConfig('s1', {} as any);
    const stored = (manager as any).sessions.get('s1');
    expect(stored.modelConfig.modelName).toBe('modelA');
  });
});

describe('SessionManager.ensureAIServiceInitialized — runtime reconciliation', () => {
  let manager: SessionManager;
  let logger: ReturnType<typeof createFakeLogger>;

  beforeEach(() => {
    logger = createFakeLogger();
    manager = new SessionManager(
      logger as any,
      createFakeCommunicationService(),
      createFakeExtensionContext()
    );
  });

  /**
   * Helper: invoke the private method via index access.
   */
  async function callEnsure(sessionId: string): Promise<any> {
    return (manager as any).ensureAIServiceInitialized(sessionId);
  }

  it('when runtime model matches modelConfig, does NOT call switchModel', async () => {
    const session = buildSessionState('s1', 'modelA');
    (manager as any).sessions.set('s1', session);

    const fakeAI = buildFakeAIService({
      initialized: true,
      runtimeModel: 'modelA',
    });
    (manager as any).aiServices.set('s1', fakeAI);

    const result = await callEnsure('s1');
    expect(result).toBe(fakeAI);
    expect(fakeAI._mocks.switchModelMock).not.toHaveBeenCalled();
  });

  it('when runtime drifted, calls switchModel with desired model and succeeds', async () => {
    const session = buildSessionState('s1', 'modelB');
    (manager as any).sessions.set('s1', session);

    const fakeAI = buildFakeAIService({
      initialized: true,
      runtimeModel: 'modelA', // drifted
    });
    (manager as any).aiServices.set('s1', fakeAI);

    await callEnsure('s1');

    expect(fakeAI._mocks.switchModelMock).toHaveBeenCalledTimes(1);
    expect(fakeAI._mocks.switchModelMock.mock.calls[0][0]).toBe('modelB');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Model drift detected')
    );
  });

  it('when desired model is "auto", does NOT force reconciliation', async () => {
    const session = buildSessionState('s1', 'auto');
    (manager as any).sessions.set('s1', session);

    const fakeAI = buildFakeAIService({
      initialized: true,
      runtimeModel: 'modelA',
    });
    (manager as any).aiServices.set('s1', fakeAI);

    await callEnsure('s1');
    expect(fakeAI._mocks.switchModelMock).not.toHaveBeenCalled();
  });

  it('when runtime model is undefined, skips reconciliation', async () => {
    const session = buildSessionState('s1', 'modelB');
    (manager as any).sessions.set('s1', session);

    const fakeAI = buildFakeAIService({
      initialized: true,
      runtimeModel: undefined,
    });
    (manager as any).aiServices.set('s1', fakeAI);

    await callEnsure('s1');
    expect(fakeAI._mocks.switchModelMock).not.toHaveBeenCalled();
  });

  it('when modelConfig.modelName is undefined, skips reconciliation', async () => {
    const session = buildSessionState('s1', undefined);
    (manager as any).sessions.set('s1', session);

    const fakeAI = buildFakeAIService({
      initialized: true,
      runtimeModel: 'modelA',
    });
    (manager as any).aiServices.set('s1', fakeAI);

    await callEnsure('s1');
    expect(fakeAI._mocks.switchModelMock).not.toHaveBeenCalled();
  });

  it('when switchModel fails, throws AND keeps modelConfig unchanged (preserves user intent)', async () => {
    const session = buildSessionState('s1', 'modelB');
    (manager as any).sessions.set('s1', session);

    const fakeAI = buildFakeAIService({
      initialized: true,
      runtimeModel: 'modelA',
      switchModelImpl: async () => ({ success: false, error: 'context too large' }),
    });
    (manager as any).aiServices.set('s1', fakeAI);

    await expect(callEnsure('s1')).rejects.toThrow(/Failed to switch to model modelB/);

    // 🔒 Critical: modelConfig must be preserved (user's last intent is sacred)
    const stored = (manager as any).sessions.get('s1');
    expect(stored.modelConfig.modelName).toBe('modelB');
  });

  it('throws when AIService not found for session', async () => {
    await expect(callEnsure('nonexistent')).rejects.toThrow(/AIService not found/);
  });
});
