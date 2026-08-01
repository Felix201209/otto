/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DeterministicScenario, EvaluationReport } from './contracts.js';

export async function runDeterministicScenarios(
  scenarios: readonly DeterministicScenario[],
): Promise<EvaluationReport> {
  const records = await Promise.all(scenarios.map(async (scenario) => {
    const verdict = await scenario.execute();
    const evidenceKinds = new Set(verdict.evidence.map((evidence) => evidence.kind));
    const missing = scenario.requiredEvidence.filter((kind) => !evidenceKinds.has(kind));
    return {
      id: scenario.id,
      lane: scenario.lane,
      passed: verdict.passed && missing.length === 0,
      evidence: verdict.evidence,
      failure: verdict.failure ?? (missing.length > 0 ? `Missing evidence: ${missing.join(', ')}` : undefined),
    };
  }));

  return { version: 1, generatedAt: new Date().toISOString(), scenarios: records };
}

export async function writeEvaluationReport(report: EvaluationReport, artifactDir: string): Promise<void> {
  await mkdir(artifactDir, { recursive: true });
  const target = path.join(artifactDir, 'latest.json');
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await rename(temporary, target);
}
