/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { afterAll, describe, expect, it } from 'vitest';
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
import { runDeterministicScenarios, writeEvaluationReport } from './runner.js';
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

describe('deterministic core safety scenarios', () => {
  it('passes every required safety scenario with complete evidence', async () => {
    report = await runDeterministicScenarios(scenarios);
    expect(report.scenarios).toHaveLength(scenarios.length);
    expect(report.scenarios.every((scenario) => scenario.passed)).toBe(true);
  });
});

afterAll(async () => {
  await writeEvaluationReport(report, new URL('../artifacts', import.meta.url).pathname);
});
