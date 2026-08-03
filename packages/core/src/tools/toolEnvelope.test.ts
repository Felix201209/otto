/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createToolExecutionEnvelope,
  ToolExecutionEnvelope,
  ToolEnvelopeEntry,
} from './toolEnvelope.js';
import { Tool, ToolResult, BaseTool, Icon } from './tools.js';
import { Config } from '../config/config.js';
import { ApprovalMode } from '../config/config.js';
import { Schema } from '@google/genai';

// ---------------------------------------------------------------------------
// Test helpers — minimal Tool implementations
// ---------------------------------------------------------------------------

function createTestTool(
  name: string,
  opts: {
    schemaParams?: Record<string, unknown>;
    shouldFail?: boolean;
    resultData?: string;
    delayMs?: number;
    validateError?: string | null;
  } = {},
): Tool {
  const {
    schemaParams,
    shouldFail = false,
    resultData = 'ok',
    delayMs = 0,
    validateError = null,
  } = opts;

  return new (class extends BaseTool<Record<string, unknown>, ToolResult> {
    constructor() {
      super(
        name,
        name,
        `Test tool ${name}`,
        Icon.Hammer,
        { type: 'object', properties: schemaParams ?? {} } as Schema,
      );
    }

    override validateToolParams(): string | null {
      return validateError;
    }

    async execute(): Promise<ToolResult> {
      if (delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
      if (shouldFail) {
        throw new Error(`Tool ${name} failed intentionally`);
      }
      return {
        llmContent: resultData,
        returnDisplay: resultData,
        summary: `${name} completed`,
      };
    }
  })();
}

function createEntry(
  tool: Tool,
  overrides: Partial<Omit<ToolEnvelopeEntry, 'tool'>> = {},
): ToolEnvelopeEntry {
  return {
    tool,
    sideEffect: 'read',
    auditCategory: 'test',
    ...overrides,
  };
}

function createTestConfig(approvalMode: ApprovalMode = ApprovalMode.DEFAULT): Config {
  return {
    getApprovalMode: () => approvalMode,
    setApprovalMode: () => {},
    getModel: () => 'test-model',
    getSessionId: () => 'test-session',
  } as unknown as Config;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ToolExecutionEnvelope', () => {
  let config: Config;
  let envelope: ToolExecutionEnvelope;
  let entries: Map<string, ToolEnvelopeEntry>;
  let knownTool: Tool;

  beforeEach(() => {
    config = createTestConfig();
    knownTool = createTestTool('safe_read');
    entries = new Map([
      ['safe_read', createEntry(knownTool, { sideEffect: 'read' })],
      [
        'mutating_tool',
        createEntry(createTestTool('mutating_tool'), { sideEffect: 'mutate' }),
      ],
      [
        'send_tool',
        createEntry(createTestTool('send_tool'), { sideEffect: 'send' }),
      ],
      [
        'delete_tool',
        createEntry(createTestTool('delete_tool'), { sideEffect: 'delete' }),
      ],
    ]);
    envelope = createToolExecutionEnvelope(config, entries, {
      approvalMode: ApprovalMode.DEFAULT,
    });
  });

  // ------------------------------------------------------------------
  // validateInput
  // ------------------------------------------------------------------

  describe('validateInput', () => {
    it('should return valid for known tool without schema', () => {
      const result = envelope.validateInput(knownTool, {});
      expect(result.valid).toBe(true);
    });

    it('should return valid for known tool with matching schema params', () => {
      const tool = createTestTool('with_schema');
      const localEntries = new Map([
        ['with_schema', createEntry(tool, {})],
      ]);
      const localEnv = createToolExecutionEnvelope(config, localEntries);
      const result = localEnv.validateInput(tool, {});
      expect(result.valid).toBe(true);
    });

    it('should return invalid when tool validateToolParams returns error', () => {
      const tool = createTestTool('bad_args', { validateError: 'Missing required field' });
      const localEntries = new Map([
        ['bad_args', createEntry(tool)],
      ]);
      const localEnv = createToolExecutionEnvelope(config, localEntries);
      const result = localEnv.validateInput(tool, {});
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Missing required field');
    });
  });

  // ------------------------------------------------------------------
  // checkPermission
  // ------------------------------------------------------------------

  describe('checkPermission', () => {
    it('should deny unknown tool', () => {
      const unknown = createTestTool('ghost_tool');
      const result = envelope.checkPermission(unknown);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('ghost_tool');
      expect(result.reason).toContain('not registered');
    });

    it('should allow read-class tool in DEFAULT mode', () => {
      const result = envelope.checkPermission(knownTool);
      expect(result.allowed).toBe(true);
    });

    it('should deny mutate-class tool in DEFAULT mode', () => {
      const tool = entries.get('mutating_tool')!.tool;
      const result = envelope.checkPermission(tool);
      expect(result.allowed).toBe(false);
      expect(result.requiredPermission).toBe('mutate');
    });

    it('should deny send-class tool even in YOLO mode', () => {
      const yoloConfig = createTestConfig(ApprovalMode.YOLO);
      const yoloEnv = createToolExecutionEnvelope(yoloConfig, entries, {
        approvalMode: ApprovalMode.YOLO,
      });
      const tool = entries.get('send_tool')!.tool;
      const result = yoloEnv.checkPermission(tool);
      expect(result.allowed).toBe(false);
      expect(result.requiredPermission).toBe('send');
    });

    it('should allow mutate-class tool in YOLO mode', () => {
      const yoloConfig = createTestConfig(ApprovalMode.YOLO);
      const yoloEnv = createToolExecutionEnvelope(yoloConfig, entries, {
        approvalMode: ApprovalMode.YOLO,
      });
      const tool = entries.get('mutating_tool')!.tool;
      const result = yoloEnv.checkPermission(tool);
      expect(result.allowed).toBe(true);
    });
  });

  // ------------------------------------------------------------------
  // wrapExecute — fail closed paths
  // ------------------------------------------------------------------

  describe('wrapExecute', () => {
    it('should fail closed for unknown tool', async () => {
      const unknown = createTestTool('phantom');
      const result = await envelope.wrapExecute(
        unknown,
        {},
        new AbortController().signal,
      );
      expect(result.llmContent).toContain('ENVELOPE_ERROR');
      expect(result.llmContent).toContain('phantom');
    });

    it('should fail closed for invalid args', async () => {
      const tool = createTestTool('strict', { validateError: 'Bad input' });
      const localEntries = new Map([['strict', createEntry(tool)]]);
      const localEnv = createToolExecutionEnvelope(config, localEntries);
      const result = await localEnv.wrapExecute(
        tool,
        { bad: 'data' },
        new AbortController().signal,
      );
      expect(result.llmContent).toContain('ENVELOPE_ERROR');
      expect(result.llmContent).toContain('Bad input');
    });

    it('should fail closed when permission denied', async () => {
      const tool = entries.get('mutating_tool')!.tool;
      const result = await envelope.wrapExecute(
        tool,
        {},
        new AbortController().signal,
      );
      expect(result.llmContent).toContain('ENVELOPE_ERROR');
      expect(result.llmContent).toContain('Permission denied');
    });

    it('should succeed with valid tool and valid args in DEFAULT mode', async () => {
      const result = await envelope.wrapExecute(
        knownTool,
        {},
        new AbortController().signal,
      );
      expect(result.llmContent).toBe('ok');
      expect(result.summary).toContain('completed');
    });

    it('should normalize execution errors', async () => {
      const failingTool = createTestTool('crasher', { shouldFail: true });
      const localEntries = new Map([
        ['crasher', createEntry(failingTool, { sideEffect: 'read' })],
      ]);
      const localEnv = createToolExecutionEnvelope(config, localEntries);
      const result = await localEnv.wrapExecute(
        failingTool,
        {},
        new AbortController().signal,
      );
      expect(result.llmContent).toContain('ENVELOPE_ERROR');
      expect(result.llmContent).toContain('failed intentionally');
    });
  });

  // ------------------------------------------------------------------
  // Timeout handling
  // ------------------------------------------------------------------

  describe('timeout', () => {
    it('should fail closed on timeout', async () => {
      const slowTool = createTestTool('slowpoke', { delayMs: 500 });
      const localEntries = new Map([
        ['slowpoke', createEntry(slowTool, {
          sideEffect: 'read',
          defaultTimeoutMs: 50,
        })],
      ]);
      const localEnv = createToolExecutionEnvelope(config, localEntries, {
        defaultTimeoutMs: 30_000,
      });

      const result = await localEnv.wrapExecute(
        slowTool,
        {},
        new AbortController().signal,
      );
      expect(result.llmContent).toContain('ENVELOPE_ERROR');
      expect(result.llmContent).toContain('timed out');
    });

    it('should use envelope default timeout when tool entry has none', async () => {
      const slowTool = createTestTool('nospec_timeout', { delayMs: 200 });
      const localEntries = new Map([
        ['nospec_timeout', createEntry(slowTool, { sideEffect: 'read' })],
      ]);
      const localEnv = createToolExecutionEnvelope(config, localEntries, {
        defaultTimeoutMs: 50,
      });

      const result = await localEnv.wrapExecute(
        slowTool,
        {},
        new AbortController().signal,
      );
      expect(result.llmContent).toContain('ENVELOPE_ERROR');
      expect(result.llmContent).toContain('timed out');
    });
  });

  // ------------------------------------------------------------------
  // Side-effect classification coverage
  // ------------------------------------------------------------------

  describe('sideEffect classification', () => {
    it.each([
      ['read', true] as const,
      ['mutate', false] as const,
      ['send', false] as const,
      ['delete', false] as const,
    ])('should allow "%s" in DEFAULT mode: %s', (cls, expected) => {
      const tool = createTestTool(`se_${cls}`);
      const localEntries = new Map([
        [`se_${cls}`, createEntry(tool, { sideEffect: cls })],
      ]);
      const localEnv = createToolExecutionEnvelope(config, localEntries);
      const result = localEnv.checkPermission(tool);
      expect(result.allowed).toBe(expected);
    });

    it.each([
      ['read', true] as const,
      ['mutate', true] as const,
      ['send', false] as const,
      ['delete', false] as const,
    ])('should allow "%s" in YOLO mode: %s', (cls, expected) => {
      const yoloConfig = createTestConfig(ApprovalMode.YOLO);
      const tool = createTestTool(`yolo_${cls}`);
      const localEntries = new Map([
        [`yolo_${cls}`, createEntry(tool, { sideEffect: cls })],
      ]);
      const localEnv = createToolExecutionEnvelope(yoloConfig, localEntries, {
        approvalMode: ApprovalMode.YOLO,
      });
      const result = localEnv.checkPermission(tool);
      expect(result.allowed).toBe(expected);
    });
  });
});
