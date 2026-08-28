import { describe, expect, it } from 'vitest';

import { CustomerModuleRunner } from './customerModuleRunner.js';

const RETURN_ZERO_WASM = Uint8Array.from([
  0,97,115,109,1,0,0,0, 1,5,1,96,0,1,127, 3,2,1,0,
  7,12,1,8,111,116,116,111,95,114,117,110,0,0, 10,6,1,4,0,65,0,11,
]);
const LOOP_WASM = Uint8Array.from([
  0,97,115,109,1,0,0,0, 1,5,1,96,0,1,127, 3,2,1,0,
  7,12,1,8,111,116,116,111,95,114,117,110,0,0,
  10,11,1,9,0,3,64,12,0,11,65,0,11,
]);
const MODEL_REQUEST_WASM = Uint8Array.from([
  0,97,115,109,1,0,0,0,
  1,11,2,96,2,127,127,1,127,96,0,1,127,
  2,21,1,4,111,116,116,111,12,109,111,100,101,108,95,105,110,118,111,107,101,0,0,
  3,2,1,1, 5,4,1,1,1,16,
  7,21,2,6,109,101,109,111,114,121,2,0,8,111,116,116,111,95,114,117,110,0,1,
  10,10,1,8,0,65,0,65,2,16,0,11,
  11,8,1,0,65,0,11,2,123,125,
]);

describe('CustomerModuleRunner', () => {
  it('runs a WASM module in an isolated worker and emits audited lifecycle events', async () => {
    const events: string[] = [];
    const runner = new CustomerModuleRunner({ onAudit: (event) => events.push(event.type) });
    const result = await runner.run({
      moduleId: 'com.acme.report', version: '1.0.0', wasm: RETURN_ZERO_WASM,
      input: {}, approvedCapabilities: [], limits: { timeoutMs: 500, maxOutputBytes: 1024 },
    });
    expect(result).toMatchObject({ status: 'completed', exitCode: 0 });
    expect(events).toEqual(['customer_module.started', 'customer_module.completed']);
  });

  it('terminates infinite modules at the deadline', async () => {
    const runner = new CustomerModuleRunner();
    const result = await runner.run({
      moduleId: 'com.acme.loop', version: '1.0.0', wasm: LOOP_WASM,
      input: {}, approvedCapabilities: [], limits: { timeoutMs: 30, maxOutputBytes: 1024 },
    });
    expect(result.status).toBe('timed_out');
  });

  it('cancels a running module through AbortSignal', async () => {
    const controller = new AbortController();
    const runner = new CustomerModuleRunner();
    setTimeout(() => controller.abort(), 10);
    const result = await runner.run({
      moduleId: 'com.acme.loop', version: '1.0.0', wasm: LOOP_WASM,
      input: {}, approvedCapabilities: [], limits: { timeoutMs: 500, maxOutputBytes: 1024 },
      signal: controller.signal,
    });
    expect(result.status).toBe('cancelled');
  });

  it('rejects worker fan-out beyond the process concurrency ceiling', async () => {
    const runner = new CustomerModuleRunner();
    const request = { moduleId: 'com.acme.loop', version: '1.0.0', wasm: LOOP_WASM, input: {}, approvedCapabilities: [], limits: { timeoutMs: 50, maxOutputBytes: 1024 } };
    const active = Array.from({ length: 4 }, () => runner.run(request));
    await expect(runner.run(request)).rejects.toThrow(/concurrency limit/);
    await Promise.all(active);
  });

  it('reports a crash when the required entrypoint is missing', async () => {
    const runner = new CustomerModuleRunner();
    const result = await runner.run({
      moduleId: 'com.acme.empty', version: '1.0.0', wasm: Uint8Array.from([0,97,115,109,1,0,0,0]),
      input: {}, approvedCapabilities: [], limits: { timeoutMs: 500, maxOutputBytes: 1024 },
    });
    expect(result.status).toBe('crashed');
    expect(result.error).toMatch(/otto_run/);
  });

  it('bridges approved Host ABI requests and rejects the same call without approval', async () => {
    const calls: unknown[] = [];
    const runner = new CustomerModuleRunner({
      host: {
        request: async (input) => {
          calls.push(input);
          if (!input.approvedCapabilities.includes(input.capability)) throw new Error('not approved');
          return { data: { text: 'ok' } };
        },
      },
    });
    const approved = await runner.run({
      moduleId: 'com.acme.model', version: '1.0.0', wasm: MODEL_REQUEST_WASM,
      input: {}, approvedCapabilities: ['model'], limits: { timeoutMs: 500, maxOutputBytes: 1024 },
    });
    expect(approved.error).toBeUndefined();
    expect(approved.status).toBe('completed');
    expect(approved.exitCode).toBeGreaterThan(0);
    expect(calls).toHaveLength(1);

    const denied = await runner.run({
      moduleId: 'com.acme.model', version: '1.0.0', wasm: MODEL_REQUEST_WASM,
      input: {}, approvedCapabilities: [], limits: { timeoutMs: 500, maxOutputBytes: 1024 },
    });
    expect(denied.status).toBe('completed');
    expect(denied.exitCode).toBe(-2);
  });
});
