/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { WorkflowTraceEvent } from './contracts.js';

export interface WorkflowTraceSink {
  append(event: Omit<WorkflowTraceEvent, 'eventId' | 'timestamp'>): Promise<void>;
}

/** Append-only local trace sink. Payloads stay redacted summaries, never raw tool output. */
export class FileWorkflowTraceSink implements WorkflowTraceSink {
  constructor(private readonly rootDir: string) {}

  async append(event: Omit<WorkflowTraceEvent, 'eventId' | 'timestamp'>): Promise<void> {
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    const record: WorkflowTraceEvent = {
      ...event,
      eventId: randomUUID(),
      timestamp: new Date().toISOString(),
    };
    await appendFile(path.join(this.rootDir, `${record.runId}.jsonl`), `${JSON.stringify(record)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  }
}
