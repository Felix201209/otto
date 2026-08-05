import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, '../..');
const contractPath = path.join(root, 'deployment/aliyun/otto-compute-nest-contract.json');
const validator = path.join(root, 'scripts/validate-aliyun-deployment-contract.mjs');

async function validate(contract) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'otto-aliyun-contract-'));
  const file = path.join(directory, 'contract.json');
  await writeFile(file, JSON.stringify(contract));
  return run(process.execPath, [validator, file]);
}

describe('Aliyun deployment contract', () => {
  it('validates the local contract without cloud credentials', async () => {
    const { stdout } = await run(process.execPath, [validator, contractPath]);
    expect(stdout).toContain('realDeploymentEnabled=false');
  });
  it('rejects a public database or plaintext secret output', async () => {
    const contract = JSON.parse(await readFile(contractPath, 'utf8'));
    contract.plans.standard.postgres.public = true;
    await expect(validate(contract)).rejects.toThrow(/must be private/);
    contract.plans.standard.postgres.public = false;
    contract.outputs.allowed.push('password');
    await expect(validate(contract)).rejects.toThrow(/secret-like field/);
  });
  it('rejects a contract that enables real cloud deployment locally', async () => {
    const contract = JSON.parse(await readFile(contractPath, 'utf8'));
    contract.realDeploymentEnabled = true;
    await expect(validate(contract)).rejects.toThrow(/must not enable real cloud/);
  });
  it('rejects HTTP-only public entry or replay resource creation', async () => {
    const contract = JSON.parse(await readFile(contractPath, 'utf8'));
    contract.network.tls.httpsRequired = false;
    await expect(validate(contract)).rejects.toThrow(/TLS/);
    contract.network.tls.httpsRequired = true;
    contract.idempotency.replayMustNotCreateResources = false;
    await expect(validate(contract)).rejects.toThrow(/replays/);
  });
});
