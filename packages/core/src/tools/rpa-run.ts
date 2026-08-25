/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import os from 'node:os';
import path from 'node:path';
import { Type } from '@google/genai';
import { Config } from '../config/config.js';
import {
  BaseTool,
  Icon,
  type ToolCallConfirmationDetails,
  type ToolResult,
} from './tools.js';

const ACTIONS = [
  'web.navigate',
  'web.fill',
  'web.click',
  'web.extract',
  'web.screenshot',
  'web.wait',
  'checkpoint',
] as const;
const OPERATIONS = ['start', 'run_next', 'recover', 'approve', 'take_over', 'status'] as const;
type RpaAction = (typeof ACTIONS)[number];
type RpaOperation = (typeof OPERATIONS)[number];

interface RpaStepInput {
  id: string;
  action: RpaAction;
  args: Record<string, unknown>;
  sideEffect: 'none' | 'external';
  requiresApproval?: boolean;
}

interface RpaWorkflowInput {
  id: string;
  version: 1;
  steps: RpaStepInput[];
}

export interface RpaRunToolParams {
  action: RpaOperation;
  workflow?: RpaWorkflowInput;
  run_id?: string;
  approval_id?: string;
  takeover_note?: string;
}

interface RpaReceipt {
  stepId: string;
  attempt: number;
  state: string;
  artifactIds: string[];
  approvalId?: string;
  error?: string;
}

interface RpaRunSummarySource {
  id: string;
  workflowId: string;
  workflowVersion: number;
  state: string;
  currentStepId: string | null;
  approvalId?: string;
  takeoverNote?: string;
  receipts: RpaReceipt[];
}

interface RpaRunnerPort {
  start(workflowId: string, version?: number): Promise<RpaRunSummarySource>;
  runNext(runId: string): Promise<RpaRunSummarySource | null>;
  recover(runId: string): Promise<RpaRunSummarySource | null>;
  approve(runId: string, approvalId: string): Promise<RpaRunSummarySource | null>;
  takeOver(runId: string, note: string): Promise<RpaRunSummarySource | null>;
}

interface RpaRuntimeModule {
  FileRpaRunStore: new (directory: string) => unknown;
  FileRpaArtifactStore: new (directory: string) => unknown;
  RpaRunner: new (
    workflows: readonly RpaWorkflowInput[],
    store: unknown,
    policy: { authorize(input: { run: RpaRunSummarySource; step: RpaStepInput }): Promise<unknown> },
    driver: unknown,
    artifacts: unknown,
  ) => RpaRunnerPort;
  RunScopedWebDriver: new (factory: unknown) => unknown;
  PlaywrightWebSessionFactory: new () => unknown;
}

interface RpaRuntime {
  module: RpaRuntimeModule;
  store: unknown;
  artifacts: unknown;
  driver: {
    closeRun?(runId: string): Promise<void>;
  };
}

function containsSecret(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSecret);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, nested]) =>
    /password|secret|token|api[_-]?key/i.test(key) || containsSecret(nested),
  );
}

function runDirectory(): string {
  return path.join(process.env['OTTO_USER_DIR']?.trim() || path.join(os.homedir(), '.otto-user'), 'rpa');
}

function summarize(run: RpaRunSummarySource | null): Record<string, unknown> {
  if (!run) return { found: false };
  return {
    id: run.id,
    workflowId: run.workflowId,
    workflowVersion: run.workflowVersion,
    state: run.state,
    currentStepId: run.currentStepId,
    approvalId: run.approvalId,
    takeoverNote: run.takeoverNote,
    receipts: run.receipts.map((receipt) => ({
      stepId: receipt.stepId,
      attempt: receipt.attempt,
      state: receipt.state,
      artifactIds: receipt.artifactIds,
      error: receipt.error,
    })),
  };
}

/**
 * Thin Core adapter for the optional RPA package. It exposes only a bounded web
 * action vocabulary and never accepts raw secrets, shell commands, or mouse coordinates.
 */
export class RpaRunTool extends BaseTool<RpaRunToolParams, ToolResult> {
  static readonly Name = 'rpa_run';
  private runtimePromise: Promise<RpaRuntime> | undefined;

  constructor(_config: Config) {
    void _config;
    super(
      RpaRunTool.Name,
      'RPA Run',
      'Run an auditable, durable browser workflow. Every state-changing operation requires confirmation; external steps require a separate recorded approval.',
      Icon.Globe,
      {
        type: Type.OBJECT,
        properties: {
          action: { type: Type.STRING, enum: [...OPERATIONS], description: 'RPA operation' },
          workflow: { type: Type.OBJECT, description: 'Workflow definition, required only to start a run' },
          run_id: { type: Type.STRING, description: 'Persistent RPA run identifier' },
          approval_id: { type: Type.STRING, description: 'Approval identifier returned by run_next' },
          takeover_note: { type: Type.STRING, description: 'Human reconciliation note for an unknown external outcome' },
        },
        required: ['action'],
      },
      true,
      false,
      false,
      false,
    );
  }

  validateToolParams(params: RpaRunToolParams): string | null {
    if (!OPERATIONS.includes(params.action)) return 'rpa_run: unsupported action.';
    if (params.action === 'start') {
      const workflow = params.workflow;
      if (!workflow || !workflow.id || workflow.version !== 1 || !Array.isArray(workflow.steps) || workflow.steps.length === 0) {
        return 'rpa_run/start: workflow with id, version 1, and at least one step is required.';
      }
      if (containsSecret(workflow)) return 'rpa_run/start: secrets must not be embedded in workflow arguments.';
      for (const step of workflow.steps) {
        if (!step.id || !ACTIONS.includes(step.action) || !step.args || !['none', 'external'].includes(step.sideEffect)) {
          return 'rpa_run/start: each step requires id, supported action, args, and sideEffect.';
        }
      }
    } else if (!params.run_id?.trim()) {
      return `rpa_run/${params.action}: run_id is required.`;
    }
    if (params.action === 'approve' && !params.approval_id?.trim()) return 'rpa_run/approve: approval_id is required.';
    if (params.action === 'take_over' && !params.takeover_note?.trim()) return 'rpa_run/take_over: takeover_note is required.';
    return null;
  }

  getDescription(params: RpaRunToolParams): string {
    return `RPA ${params.action}${params.run_id ? ` (${params.run_id})` : ''}`;
  }

  async shouldConfirmExecute(params: RpaRunToolParams, _signal: AbortSignal): Promise<ToolCallConfirmationDetails | false> {
    if (this.validateToolParams(params) || params.action === 'status') return false;
    return {
      type: 'exec',
      title: `[WARN] Confirm: ${this.getDescription(params)}`,
      command: `rpa_run(${params.action})`,
      rootCommand: 'rpa_run',
      onConfirm: async () => {},
    };
  }

  async execute(params: RpaRunToolParams, signal: AbortSignal): Promise<ToolResult> {
    const error = this.validateToolParams(params);
    if (error) return { llmContent: error, returnDisplay: error };
    if (signal.aborted) return this.cancelledResult();
    let abortListener: (() => void) | undefined;
    try {
      const runner = await this.runner(params.action === 'start' ? [params.workflow!] : []);
      signal.throwIfAborted();
      if (params.run_id) {
        abortListener = () => {
          void this.closeActiveRun(params.run_id!).catch(() => undefined);
        };
        signal.addEventListener('abort', abortListener, { once: true });
        if (signal.aborted) {
          abortListener();
          signal.throwIfAborted();
        }
      }
      let run: RpaRunSummarySource | null;
      switch (params.action) {
        case 'start':
          run = await runner.start(params.workflow!.id, params.workflow!.version);
          break;
        case 'run_next':
          run = await runner.runNext(params.run_id!);
          break;
        case 'recover':
          run = await runner.recover(params.run_id!);
          break;
        case 'approve':
          run = await runner.approve(params.run_id!, params.approval_id!);
          break;
        case 'take_over':
          run = await runner.takeOver(params.run_id!, params.takeover_note!);
          break;
        case 'status':
          run = await this.status(params.run_id!);
          break;
        default:
          throw new Error(`Unsupported RPA operation: ${params.action}`);
      }
      // A late driver result must not be presented as success after the desktop
      // has hidden/exited and revoked the owning runtime.
      signal.throwIfAborted();
      const output = JSON.stringify(summarize(run));
      return { llmContent: `rpa_run OK: ${output}`, returnDisplay: `rpa_run OK: ${output}` };
    } catch (caught) {
      if (signal.aborted || (caught instanceof Error && caught.name === 'AbortError')) {
        return this.cancelledResult();
      }
      const message = caught instanceof Error ? caught.message : String(caught);
      return { llmContent: `rpa_run FAIL: ${message}`, returnDisplay: `rpa_run FAIL: ${message}` };
    } finally {
      if (abortListener) signal.removeEventListener('abort', abortListener);
    }
  }

  private cancelledResult(): ToolResult {
    return {
      llmContent: 'rpa_run CANCELLED: desktop task authorization was revoked.',
      returnDisplay: 'RPA 已取消：桌面任务授权已撤销。',
    };
  }

  private async closeActiveRun(runId: string): Promise<void> {
    const runtime = await this.runtime();
    await runtime.driver.closeRun?.(runId);
  }

  private async status(runId: string): Promise<RpaRunSummarySource | null> {
    const runtime = await this.runtime();
    return (runtime.store as { get(id: string): Promise<RpaRunSummarySource | null> }).get(runId);
  }

  private async runner(workflows: readonly RpaWorkflowInput[]): Promise<RpaRunnerPort> {
    const runtime = await this.runtime();
    const policy = {
      authorize: async ({ run, step }: { run: RpaRunSummarySource; step: RpaStepInput }) => {
        const receipt = run.receipts.find((candidate) => candidate.stepId === step.id);
        if (step.sideEffect === 'external' && !receipt?.approvalId) {
          return { decision: 'awaiting_approval' as const, approvalId: `approval-${run.id}-${step.id}-${(receipt?.attempt ?? 0) + 1}` };
        }
        return { decision: 'allow' as const };
      },
    };
    return new runtime.module.RpaRunner(workflows, runtime.store, policy, runtime.driver, runtime.artifacts);
  }

  private runtime(): Promise<RpaRuntime> {
    this.runtimePromise ??= this.loadRuntime();
    return this.runtimePromise;
  }

  private async loadRuntime(): Promise<RpaRuntime> {
    let module: RpaRuntimeModule;
    try {
      module = (await import('otto-rpa')) as unknown as RpaRuntimeModule;
    } catch (caught) {
      const detail = caught instanceof Error ? caught.message : String(caught);
      throw new Error(`RPA runtime is unavailable (${detail}). Build/install the optional otto-rpa package before running RPA.`);
    }
    const directory = runDirectory();
    return {
      module,
      store: new module.FileRpaRunStore(path.join(directory, 'runs')),
      artifacts: new module.FileRpaArtifactStore(path.join(directory, 'artifacts')),
      driver: new module.RunScopedWebDriver(
        new module.PlaywrightWebSessionFactory(),
      ) as RpaRuntime['driver'],
    };
  }
}
