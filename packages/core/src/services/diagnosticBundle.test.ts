import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import JSZip from 'jszip';
import { createDiagnosticBundle, redactDiagnosticText } from './diagnosticBundle.js';
import type { DoctorReport } from './doctor.js';

const EMPTY_DOCTOR_REPORT: DoctorReport = {
  platform: process.platform,
  checks: [],
  presentCount: 0,
  missingCount: 0,
  affectedCapabilities: [],
};

describe('diagnostic bundle', () => {
  it('脱敏模型 key、token 和常见密钥格式', () => {
    const text = '{"apiKey":"sk-secret-value","token":"abc","url":"ok"} ghp_123456789012 Authorization: Bearer hidden-token https://x.test?a=1&access_token=query-secret';
    const redacted = redactDiagnosticText(text);
    expect(redacted).not.toContain('sk-secret-value');
    expect(redacted).not.toContain('ghp_123456789012');
    expect(redacted).not.toContain('hidden-token');
    expect(redacted).not.toContain('query-secret');
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
    const result = await createDiagnosticBundle({
      homeDir: home,
      outputDir: output,
      models: [{ modelId: 'demo', hasApiKey: true }],
      doctorReport: EMPTY_DOCTOR_REPORT,
    });
    expect(result.ok).toBe(true);
    const zip = await JSZip.loadAsync(await readFile(result.path));
    expect(zip.file('otto-user/logs/server.log')).not.toBeNull();
    expect(zip.file(/secrets/)).toHaveLength(0);
    expect(await zip.file('otto-user/logs/server.log')!.async('string')).toContain('[REDACTED]');
  });

  it('脱敏模型 baseUrl 中的 URL 凭证和查询密钥', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'otto-diagnostic-model-url-'));
    const output = path.join(root, 'out');
    const result = await createDiagnosticBundle({
      homeDir: path.join(root, 'home'),
      outputDir: output,
      models: [{
        modelId: 'demo',
        baseUrl: 'https://alice:plain-password@example.test/v1?api_key=query-secret',
        hasApiKey: true,
      }],
      doctorReport: EMPTY_DOCTOR_REPORT,
    });

    const zip = await JSZip.loadAsync(await readFile(result.path));
    const modelConfig = await zip.file('model-config.json')!.async('string');
    expect(modelConfig).not.toContain('plain-password');
    expect(modelConfig).not.toContain('query-secret');
    expect(modelConfig).toContain('[REDACTED]');
  });

  it('跳过符号链接日志，防止诊断包越界读取', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'otto-diagnostic-link-'));
    const home = path.join(root, 'home');
    const output = path.join(root, 'out');
    const outside = path.join(root, 'outside.log');
    const { mkdir, writeFile, symlink } = await import('node:fs/promises');
    await mkdir(path.join(home, '.otto-user', 'logs'), { recursive: true });
    await writeFile(outside, 'password=outside-secret');
    await symlink(outside, path.join(home, '.otto-user', 'logs', 'linked.log'));

    const result = await createDiagnosticBundle({
      homeDir: home,
      outputDir: output,
      models: [],
      doctorReport: EMPTY_DOCTOR_REPORT,
    });
    const zip = await JSZip.loadAsync(await readFile(result.path));
    expect(zip.file('otto-user/logs/linked.log')).toBeNull();
  });
});
