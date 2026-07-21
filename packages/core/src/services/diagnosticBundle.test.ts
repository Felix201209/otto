import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import JSZip from 'jszip';
import { createDiagnosticBundle, redactDiagnosticText } from './diagnosticBundle.js';

describe('diagnostic bundle', () => {
  it('脱敏模型 key、token 和常见密钥格式', () => {
    const text = '{"apiKey":"sk-secret-value","token":"abc","url":"ok"} ghp_123456789012';
    const redacted = redactDiagnosticText(text);
    expect(redacted).not.toContain('sk-secret-value');
    expect(redacted).not.toContain('ghp_123456789012');
    expect(redacted).toContain('[REDACTED]');
  });

  it('生成 zip 且不包含 secrets 目录', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'otto-diagnostic-'));
    const home = path.join(root, 'home');
    const output = path.join(root, 'out');
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(path.join(home, '.otto-user', 'logs'), { recursive: true });
    await mkdir(path.join(home, '.otto-user', 'secrets'), { recursive: true });
    await writeFile(path.join(home, '.otto-user', 'logs', 'server.log'), 'apiKey=sk-hidden');
    await writeFile(path.join(home, '.otto-user', 'secrets', 'model'), 'sk-hidden');
    const result = await createDiagnosticBundle({ homeDir: home, outputDir: output, models: [{ modelId: 'demo', hasApiKey: true }] });
    expect(result.ok).toBe(true);
    const zip = await JSZip.loadAsync(await readFile(result.path));
    expect(zip.file('otto-user/logs/server.log')).not.toBeNull();
    expect(zip.file(/secrets/)).toHaveLength(0);
    expect(await zip.file('otto-user/logs/server.log')!.async('string')).toContain('[REDACTED]');
  });
});
