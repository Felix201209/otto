/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import os from 'node:os';
import path from 'node:path';
import { Type } from '@google/genai';
import { Config } from '../config/config.js';
import { ToolRegistry } from './tool-registry.js';
import { BaseTool, Icon, type ToolCallConfirmationDetails, type ToolResult } from './tools.js';

const OPERATIONS = ['start', 'run_next', 'recover', 'approve', 'take_over', 'status'] as const;
const KINDS = ['condition', 'approval', 'tool'] as const;
type Operation = (typeof OPERATIONS)[number];
type StepKind = (typeof KINDS)[number];

interface StepInput {
  id: string;
  kind: StepKind;
  input: Record<string, unknown>;
  sideEffect: 'none' | 'idempotent' | 'external';
  requiresApproval?: boolean;
}

interface DefinitionInput {
  id: string;
  version: 1;
  steps: StepInput[];
}

export interface DurableWorkflowToolParams {
  action: Operation;
  definition?: DefinitionInput;
  run_id?: string;
  step_id?: string;
  approval_id?: string;
  takeover_note?: string;
}

interface StepSummary {
  stepId: string;
  kind: string;
  attempt: number;
  status: string;
  approvalId?: string;
  approvedAt?: string;
  error?: string;
}

interface RunSummarySource {
  id: string;
  definitionId: string;
  definitionVersion: number;
  status: string;
  steps: StepSummary[];
}

interface RuntimePort {
  start(definition: DefinitionInput): Promise<RunSummarySource>;
  runNext(runId: string): Promise<RunSummarySource | null>;
  recover(runId: string): Promise<RunSummarySource | null>;
  approve(runId: string, stepId: string, approvalId: string): Promise<RunSummarySource | null>;
  takeOver(runId: string, note: string): Promise<RunSummarySource | null>;
}

interface WorkflowModule {
  FileWorkflowStore: new (directory: string) => unknown;
  FileWorkflowTraceSink: new (directory: string) => unknown;
  WorkflowRuntime: new (store: unknown, executor: unknown, trace: unknown) => RuntimePort;
}

interface WorkflowPersistence {
  module: WorkflowModule;
  store: { getRun(id: string): Promise<RunSummarySource | null> };
  trace: unknown;
}

function workflowDirectory(): string {
  return path.join(process.env['OTTO_USER_DIR']?.trim() || path.join(os.homedir(), '.otto-user'), 'durable-workflows');
}

function summarize(run: RunSummarySource | null): Record<string, unknown> {
  if (!run) return { found: false };
  return {
    id: run.id,
    definitionId: run.definitionId,
    definitionVersion: run.definitionVersion,
    status: run.status,
    steps: run.steps.map(({ stepId, kind, attempt, status, approvalId, approvedAt, error }) => ({
      stepId,
      kind,
      attempt,
      status,
      approvalId,
      approvedAt,
      error,
    })),
  };
}

/**
 * Declarative durable workflow entrypoint. It intentionally rejects arbitrary
 * script and agent steps: those remain the legacy exploratory workflow tool.
 */
export class DurableWorkflowTool extends BaseTool<DurableWorkflowToolParams, ToolResult> {
  static readonly Name = 'durable_workflow';
  private persistencePromise: Promise<WorkflowPersistence> | undefined;

  constructor(_config: Config, private readonly registry: ToolRegistry) {
    void _config;
    super(
      DurableWorkflowTool.Name,
      'Durable Workflow',
      'Create and advance a restart-safe declarative workflow. Only deterministic conditions, approval gates, and the verified analyze_data tool are supported; arbitrary scripts and agents are intentionally rejected.',
      Icon.Tasks,
      {
        type: Type.OBJECT,
        properties: {
          action: { type: Type.STRING, enum: [...OPERATIONS], description: 'Durable workflow operation' },
          definition: { type: Type.OBJECT, description: 'Versioned declarative definition, required for start' },
          run_id: { type: Type.STRING, description: 'Workflow run identifier' },
          step_id: { type: Type.STRING, description: 'Waiting approval step identifier' },
          approval_id: { type: Type.STRING, description: 'Approval identifier returned by run_next' },
          takeover_note: { type: Type.STRING, description: 'Human reconciliation note for unknown external outcome' },
        },
        required: ['action'],
      },
      true,
      false,
      false,
      false,
    );
  }

  validateToolParams(params: DurableWorkflowToolParams): string | null {
    if (!OPERATIONS.includes(params.action)) return 'durable_workflow: unsupported action.';
    if (params.action === 'start') return this.validateDefinition(params.definition);
    if (!params.run_id?.trim()) return `durable_workflow/${params.action}: run_id is required.`;
    if (params.action === 'approve' && (!params.step_id?.trim() || !params.approval_id?.trim())) {
      return 'durable_workflow/approve: step_id and approval_id are required.';
    }
    if (params.action === 'take_over' && !params.takeover_note?.trim()) return 'durable_workflow/take_over: takeover_note is required.';
    return null;
  }

  getDescription(params: DurableWorkflowToolParams): string {
    return `durable workflow ${params.action}${params.run_id ? ` (${params.run_id})` : ''}`;
  }

  async shouldConfirmExecute(params: DurableWorkflowToolParams, _signal: AbortSignal): Promise<ToolCallConfirmationDetails | false> {
    if (this.validateToolParams(params) || params.action === 'status') return false;
    return { type: 'exec', title: `[WARN] Confirm: ${this.getDescription(params)}`, command: `durable_workflow(${params.action})`, rootCommand: 'durable_workflow', onConfirm: async () => {} };
  }

  async execute(params: DurableWorkflowToolParams, signal: AbortSignal): Promise<ToolResult> {
    const error = this.validateToolParams(params);
    if (error) return { llmContent: error, returnDisplay: error };
    try {
      const persistence = await this.persistence();
      const runtime = new persistence.module.WorkflowRuntime(
        persistence.store,
        { execute: (input: { step: StepInput }) => this.executeStep(input.step, signal) },
        persistence.trace,
      );
      let run: RunSummarySource | null;
      switch (params.action) {
        case 'start': run = await runtime.start(params.definition!); break;
        case 'run_next': run = await runtime.runNext(params.run_id!); break;
        case 'recover': run = await runtime.recover(params.run_id!); break;
        case 'approve': run = await runtime.approve(params.run_id!, params.step_id!, params.approval_id!); break;
        case 'take_over': run = await runtime.takeOver(params.run_id!, params.takeover_note!); break;
        case 'status': run = await persistence.store.getRun(params.run_id!); break;
        default: throw new Error(`Unsupported workflow operation: ${params.action}`);
      }
      const output = JSON.stringify(summarize(run));
      return { llmContent: `durable_workflow OK: ${output}`, returnDisplay: `durable_workflow OK: ${output}` };
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      return { llmContent: `durable_workflow FAIL: ${message}`, returnDisplay: `durable_workflow FAIL: ${message}` };
    }
  }

  private validateDefinition(definition: DefinitionInput | undefined): string | null {
    if (!definition || !definition.id || definition.version !== 1 || !Array.isArray(definition.steps) || definition.steps.length === 0) {
      return 'durable_workflow/start: definition with id, version 1, and steps is required.';
    }
    const ids = new Set<string>();
    for (const step of definition.steps) {
      if (!step.id || ids.has(step.id) || !KINDS.includes(step.kind) || !step.input || !['none', 'idempotent', 'external'].includes(step.sideEffect)) {
        return 'durable_workflow/start: steps require unique id, supported kind, input, and sideEffect.';
      }
      ids.add(step.id);
      if (step.sideEffect === 'external') {
        return 'durable_workflow/start: external steps belong in rpa_run or a future scheduler-integrated executor, not this safe workflow path.';
      }
      if (step.kind === 'tool' && step.input['tool'] !== 'analyze_data') {
        return 'durable_workflow/start: tool steps may only call analyze_data.';
      }
      if (step.kind === 'condition' && !['equals', 'exists'].includes(String(step.input['operator']))) {
        return 'durable_workflow/start: condition steps require operator equals or exists.';
      }
      if (step.kind === 'approval' && (step.sideEffect !== 'none' || step.requiresApproval !== true)) {
        return 'durable_workflow/start: approval steps require requiresApproval true and no side effects.';
      }
    }
    return null;
  }

  private async executeStep(step: StepInput, signal: AbortSignal): Promise<unknown> {
    if (step.kind === 'approval') return { approvedGate: true };
    if (step.kind === 'condition') {
      const exists = step.input['value'] !== undefined && step.input['value'] !== null;
      const passes = step.input['operator'] === 'exists' ? exists : Object.is(step.input['value'], step.input['expected']);
      if (!passes) throw new Error(`Condition failed: ${String(step.input['operator'])}`);
      return { condition: step.input['operator'], passed: true };
    }
    const tool = this.registry.getTool('analyze_data');
    if (!tool) throw new Error('Verified analyze_data tool is unavailable.');
    const params = step.input['params'];
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('analyze_data requires an object params value.');
    const result = await tool.execute(params, signal);
    return { tool: 'analyze_data', summary: String(result.summary ?? result.returnDisplay).slice(0, 1000) };
  }

  private persistence(): Promise<WorkflowPersistence> {
    this.persistencePromise ??= this.loadPersistence();
    return this.persistencePromise;
  }

  private async loadPersistence(): Promise<WorkflowPersistence> {
    let module: WorkflowModule;
    try {
      module = (await import('otto-workflow')) as unknown as WorkflowModule;
    } catch (caught) {
      const detail = caught instanceof Error ? caught.message : String(caught);
      throw new Error(`Durable workflow runtime is unavailable (${detail}). Build/install otto-workflow first.`);
    }
    const directory = workflowDirectory();
    return {
      module,
      store: new module.FileWorkflowStore(path.join(directory, 'runs')) as WorkflowPersistence['store'],
      trace: new module.FileWorkflowTraceSink(path.join(directory, 'traces')),
    };
  }
}
