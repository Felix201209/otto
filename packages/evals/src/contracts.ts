/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

export type EvaluationLane = 'coding' | 'policy' | 'recovery' | 'rpa' | 'spreadsheet';

export interface EvaluationEvidence {
  kind: 'tool_trace' | 'approval' | 'artifact' | 'assertion';
  summary: string;
}

export interface EvaluationVerdict {
  passed: boolean;
  evidence: EvaluationEvidence[];
  failure?: string;
}

export interface DeterministicScenario {
  id: string;
  lane: EvaluationLane;
  description: string;
  requiredEvidence: ReadonlyArray<EvaluationEvidence['kind']>;
  execute(): Promise<EvaluationVerdict>;
}

export interface EvaluationReport {
  version: 1;
  generatedAt: string;
  scenarios: Array<{
    id: string;
    lane: EvaluationLane;
    passed: boolean;
    evidence: EvaluationEvidence[];
    failure?: string;
  }>;
}
