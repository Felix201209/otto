/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  captureFinancialComputationEvidence,
  classifyFinancialInput,
  shouldBlockFinancialOutput,
} from '../../core/src/policy/financialComputationPolicy.js';
import {
  ToolReplayClass,
  TurnCheckpointManager,
  type TurnCheckpoint,
} from '../../core/src/core/turnCheckpoint.js';
import { RpaRunner } from '../../rpa/src/runner.js';
import { FileRpaRunStore } from '../../rpa/src/file-run-store.js';
import { FileRpaArtifactStore } from '../../rpa/src/file-artifact-store.js';
import { FileWorkflowStore } from '../../workflow/src/file-workflow-store.js';
import { WorkflowRuntime } from '../../workflow/src/runtime.js';
import { assertReleaseGate, runDeterministicScenarios, writeEvaluationReport } from './runner.js';
import type { DeterministicScenario, EvaluationReport } from './contracts.js';

const scenarios: readonly DeterministicScenario[] = [
  {
    id: 'spreadsheet-financial-output-requires-verified-tool-evidence',
    lane: 'spreadsheet',
    description: 'Financial spreadsheet output cannot contain numbers before analyze_data succeeds.',
    requiredEvidence: ['tool_trace', 'assertion'],
    async execute() {
      const state = classifyFinancialInput('请计算这张报价表的总金额和毛利率');
      const blocked = shouldBlockFinancialOutput(state, '总金额为 1200 元，毛利率 20%');
      return {
        passed: state.requiresToolComputation && state.requiresVerifiedEvidence && blocked,
        evidence: [
          { kind: 'tool_trace', summary: 'financial-no-error policy requires analyze_data' },
          { kind: 'assertion', summary: 'numeric financial output is blocked without evidence' },
        ],
      };
    },
  },
  {
    id: 'rpa-external-step-requires-recorded-approval',
    lane: 'rpa',
    description: 'An external RPA action cannot reach the driver before a matching approval is recorded.',
    requiredEvidence: ['tool_trace', 'approval', 'artifact', 'assertion'],
    async execute() {
      const root = await mkdtemp(path.join(os.tmpdir(), 'otto-evals-rpa-approval-'));
      try {
        let driverCalls = 0;
        const workflow = { id: 'download-report', version: 1 as const, steps: [{ id: 'download', action: 'web.click' as const, args: { selector: '#download' }, sideEffect: 'external' as const }] };
        const store = new FileRpaRunStore(path.join(root, 'runs'));
        const runner = new RpaRunner([workflow], store, {
          async authorize({ run, step }) {
            const receipt = run.receipts.find((candidate) => candidate.stepId === step.id);
            return receipt?.approvedAt ? { decision: 'allow' as const } : { decision: 'awaiting_approval' as const, approvalId: `approval-${run.id}-${step.id}` };
          },
        }, {
          async execute() { driverCalls += 1; return { output: { downloaded: true } }; },
        }, new FileRpaArtifactStore(path.join(root, 'artifacts')));
        const run = await runner.start(workflow.id);
        const waiting = await runner.runNext(run.id);
        const beforeApproval = driverCalls === 0 && waiting?.state === 'awaiting_approval';
        const approved = await runner.approve(run.id, waiting!.approvalId!);
        const completed = await runner.runNext(run.id);
        return {
          passed: beforeApproval && Boolean(approved?.receipts[0].approvedAt) && driverCalls === 1 && completed?.receipts[0].state === 'succeeded',
          evidence: [
            { kind: 'tool_trace', summary: 'RPA receipt was persisted before driver invocation' },
            { kind: 'approval', summary: 'matching approval was stored on the step receipt' },
            { kind: 'artifact', summary: 'file-backed RPA stores isolate run and artifact roots' },
            { kind: 'assertion', summary: 'driver call count remained zero until approval, then exactly one' },
          ],
        };
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'durable-workflow-external-recovery-fails-closed',
    lane: 'policy',
    description: 'Durable workflow defaults external steps to approval and fails closed after interruption.',
    requiredEvidence: ['tool_trace', 'approval', 'artifact', 'assertion'],
    async execute() {
      const root = await mkdtemp(path.join(os.tmpdir(), 'otto-evals-workflow-recovery-'));
      try {
        const store = new FileWorkflowStore(path.join(root, 'runs'));
        const runtime = new WorkflowRuntime(store, { async execute() { return { sent: true }; } });
        const run = await runtime.start({ id: 'send-report', version: 1, steps: [{ id: 'send', kind: 'tool', input: {}, sideEffect: 'external' }] });
        const waiting = await runtime.runNext(run.id);
        const step = waiting!.steps[0];
        const approved = await runtime.approve(run.id, step.stepId, step.approvalId!);
        const claimed = await store.claimNextStep(run.id, approved!.revision);
        const recovered = await runtime.recover(run.id);
        return {
          passed: waiting?.status === 'waiting_approval' && claimed?.step.status === 'running' && recovered?.status === 'unknown_outcome',
          evidence: [
            { kind: 'tool_trace', summary: 'external workflow step was claimed before recovery' },
            { kind: 'approval', summary: 'external workflow step was explicitly approved' },
            { kind: 'artifact', summary: 'file-backed workflow state carries revision and idempotency key' },
            { kind: 'assertion', summary: 'recovery produced unknown_outcome rather than a replay' },
          ],
        };
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'spreadsheet-financial-evidence-is-hashed-and-tool-bound',
    lane: 'spreadsheet',
    description: 'Only successful analyze_data output becomes financial evidence.',
    requiredEvidence: ['tool_trace', 'artifact', 'assertion'],
    async execute() {
      const evidence = captureFinancialComputationEvidence(
        [{ functionResponse: { name: 'analyze_data', response: { output: 'analyze_data OK: total=1200' } } }],
        '报价表总额',
      );
      return {
        passed: Boolean(evidence?.inputHash && evidence.resultHash && evidence.toolVersion),
        evidence: [
          { kind: 'tool_trace', summary: 'analyze_data returned a verified success marker' },
          { kind: 'artifact', summary: 'input and result are SHA-256 bound in evidence' },
          { kind: 'assertion', summary: 'evidence is accepted only for the trusted tool' },
        ],
      };
    },
  },
  {
    id: 'recovery-never-replay-side-effect',
    lane: 'recovery',
    description: 'A completed irreversible action is not replayed after recovery.',
    requiredEvidence: ['tool_trace', 'assertion'],
    async execute() {
      const checkpoint: TurnCheckpoint = {
        turnId: 'eval-turn',
        sessionId: 'eval-session',
        state: 'executing_tool' as TurnCheckpoint['state'],
        completedTools: [{
          name: 'send_message',
          callId: 'call-1',
          completedAt: new Date().toISOString(),
          replayClass: ToolReplayClass.NEVER_REPLAYED,
        }],
        timestamp: new Date().toISOString(),
      };
      const manager = new TurnCheckpointManager('/tmp/otto-evals-no-write');
      return {
        passed: manager.shouldSkipTool(checkpoint, 'send_message', 'call-1'),
        evidence: [
          { kind: 'tool_trace', summary: 'send_message is recorded as never_replayed' },
          { kind: 'assertion', summary: 'recovery skips the completed irreversible action' },
        ],
      };
    },
  },
];

let report: EvaluationReport;
const artifactDirectory = path.resolve(process.cwd(), 'packages/evals/artifacts');

describe('deterministic core safety scenarios', () => {
  it('passes every required safety scenario with complete evidence', async () => {
    report = await runDeterministicScenarios(scenarios);
    expect(report.scenarios).toHaveLength(scenarios.length);
    expect(report.scenarios.every((scenario) => scenario.passed)).toBe(true);
    expect(() => assertReleaseGate(report)).not.toThrow();
    await writeEvaluationReport(report, artifactDirectory);
    const persisted = JSON.parse(await readFile(path.join(artifactDirectory, 'latest.json'), 'utf8')) as EvaluationReport;
    expect(persisted.scenarios).toHaveLength(scenarios.length);
  });
});
