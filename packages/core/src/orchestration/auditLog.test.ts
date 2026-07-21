/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { AuditLogger, redactAuditText } from './auditLog.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe('AuditLogger security', () => {
  it('redacts JSON, bearer, URL and common provider credentials', () => {
    const raw = [
      'apiKey=sk-secret-value',
      'Authorization: Bearer bearer-secret',
      'https://api.test/path?access_token=url-secret',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature',
    ].join('\n');
    const redacted = redactAuditText(raw);
    expect(redacted).not.toContain('sk-secret-value');
    expect(redacted).not.toContain('bearer-secret');
    expect(redacted).not.toContain('url-secret');
    expect(redacted).not.toContain('eyJhbGci');
  });

  it('sanitizes before writing and creates private audit files', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-audit-'));
    roots.push(root);
    const logger = new AuditLogger(
      root,
      () => new Date('2026-07-21T09:00:00.000Z'),
    );
    await logger.log({
      sessionId: 's1',
      userId: 'felix',
      toolName: 'run_shell',
      action: '执行命令',
      category: 'shell',
      success: true,
      inputSummary: 'password=KingSecret',
      outputSummary: 'Authorization: Bearer hidden',
      source: 'terminal',
    });

    const filePath = path.join(root, 'audit-2026-07-21.jsonl');
    const entry = JSON.parse(await fs.readFile(filePath, 'utf8'));
    expect(entry.inputSummary).toContain('[REDACTED]');
    expect(entry.outputSummary).toContain('[REDACTED]');
    expect(entry.riskLevel).toBe('high');
    if (process.platform !== 'win32') {
      expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
    }
  });
});
