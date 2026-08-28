import { Worker } from 'node:worker_threads';
import type { CustomerModuleHostV1 } from './customerModuleHost.js';

export type CustomerModuleCapability = 'storage' | 'file' | 'http' | 'model' | 'background';

export interface CustomerModuleAuditEvent {
  type: 'customer_module.started' | 'customer_module.completed' | 'customer_module.failed' | 'customer_module.progress';
  moduleId: string;
  version: string;
  status: CustomerModuleRunResult['status'] | 'running';
  durationMs: number;
  approvedCapabilities: CustomerModuleCapability[];
  estimatedCostUsd: number;
  error?: string;
}

export interface CustomerModuleRunRequest {
  moduleId: string;
  version: string;
  wasm: Uint8Array;
  input: Record<string, unknown>;
  approvedCapabilities: CustomerModuleCapability[];
  limits: { timeoutMs: number; maxOutputBytes: number };
  signal?: AbortSignal;
}

export interface CustomerModuleRunResult {
  status: 'completed' | 'timed_out' | 'crashed' | 'cancelled';
  exitCode: number | null;
  output: string;
  error?: string;
}

const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  try {
    const module = await WebAssembly.compile(workerData.wasm);
    let instance;
    let lastResponse = new Uint8Array();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const control = new Int32Array(workerData.bridge, 0, 4);
    const bridgeBytes = new Uint8Array(workerData.bridge, 16);
    const memory = () => {
      const value = instance?.exports?.memory;
      if (!(value instanceof WebAssembly.Memory)) throw new Error('customer module must export memory for Host ABI calls');
      return new Uint8Array(value.buffer);
    };
    const read = (ptr, len) => {
      if (!Number.isInteger(ptr) || !Number.isInteger(len) || ptr < 0 || len < 0 || ptr + len > memory().length) throw new Error('Host ABI memory read is out of bounds');
      return decoder.decode(memory().subarray(ptr, ptr + len));
    };
    const write = (ptr, maxLen, body) => {
      const encoded = encoder.encode(body);
      if (!Number.isInteger(ptr) || !Number.isInteger(maxLen) || ptr < 0 || maxLen < encoded.length || ptr + encoded.length > memory().length) return -1;
      memory().set(encoded, ptr); return encoded.length;
    };
    const requestHost = (capability, ptr, len) => {
      const payload = JSON.parse(read(ptr, len));
      Atomics.store(control, 0, 0); Atomics.store(control, 1, 0);
      parentPort.postMessage({ type: 'host_request', capability, payload });
      const wait = Atomics.wait(control, 0, 0, workerData.hostCallTimeoutMs);
      if (wait === 'timed-out') throw new Error('Host ABI request timed out');
      const state = Atomics.load(control, 0); const size = Atomics.load(control, 1);
      if (size < 0 || size > bridgeBytes.length) throw new Error('Host ABI response is invalid');
      lastResponse = Uint8Array.from(bridgeBytes.subarray(0, size));
      return state === 1 ? size : -2;
    };
    const imports = { otto: {
      read_input: (ptr, maxLen) => write(ptr, maxLen, JSON.stringify(workerData.input)),
      read_response: (ptr, maxLen) => write(ptr, maxLen, decoder.decode(lastResponse)),
      emit_progress: (ptr, len) => { parentPort.postMessage({ type: 'progress', message: read(ptr, len) }); return 0; },
      emit_result: (ptr, len) => { parentPort.postMessage({ type: 'result', output: read(ptr, len) }); return 0; },
      storage_read: (ptr, len) => requestHost('storage', ptr, len),
      storage_write: (ptr, len) => requestHost('storage', ptr, len),
      file_read_selected: (ptr, len) => requestHost('file', ptr, len),
      file_write_selected: (ptr, len) => requestHost('file', ptr, len),
      http_request: (ptr, len) => requestHost('http', ptr, len),
      model_invoke: (ptr, len) => requestHost('model', ptr, len),
      is_cancelled: () => 0,
    } };
    instance = await WebAssembly.instantiate(module, imports);
    const run = instance.exports.otto_run;
    if (typeof run !== 'function') throw new Error('customer module must export otto_run');
    const exitCode = Number(run());
    parentPort.postMessage({ type: 'completed', exitCode });
  } catch (error) {
    parentPort.postMessage({ type: 'crashed', error: error instanceof Error ? error.message : String(error) });
  }
})();`;

const CUSTOMER_MODULE_MAX_CONCURRENT_RUNS = 4;
let activeCustomerModuleRuns = 0;

export class CustomerModuleRunner {
  constructor(private readonly options: {
    host?: CustomerModuleHostV1;
    onAudit?(event: CustomerModuleAuditEvent): void;
  } = {}) {}

  async run(request: CustomerModuleRunRequest): Promise<CustomerModuleRunResult> {
    if (activeCustomerModuleRuns >= CUSTOMER_MODULE_MAX_CONCURRENT_RUNS) {
      throw new Error('customer module concurrency limit exceeded');
    }
    if (!Number.isInteger(request.limits.timeoutMs) || request.limits.timeoutMs < 10 || request.limits.timeoutMs > 60_000) {
      throw new Error('customer module timeout must be between 10 and 60000 ms');
    }
    if (!Number.isInteger(request.limits.maxOutputBytes) || request.limits.maxOutputBytes < 1 || request.limits.maxOutputBytes > 4 * 1024 * 1024) {
      throw new Error('customer module output limit is invalid');
    }
    const startedAt = Date.now();
    this.audit(request, 'customer_module.started', 'running', startedAt);
    activeCustomerModuleRuns += 1;
    try {
      const bridge = new SharedArrayBuffer(16 + Math.min(request.limits.maxOutputBytes, 1024 * 1024));
      const worker = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: {
          wasm: Uint8Array.from(request.wasm), input: request.input, bridge,
          hostCallTimeoutMs: Math.min(request.limits.timeoutMs, 30_000),
        },
        resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 },
      });
      return await new Promise((resolve) => {
      let settled = false;
      const cancel = (): void => finish({ status: 'cancelled', exitCode: null, output: '', error: 'execution cancelled' });
      const finish = (result: CustomerModuleRunResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        request.signal?.removeEventListener('abort', cancel);
        void worker.terminate();
        this.audit(
          request,
          result.status === 'completed' ? 'customer_module.completed' : 'customer_module.failed',
          result.status,
          startedAt,
          result.error,
        );
        resolve(result);
      };
      const timer = setTimeout(() => finish({ status: 'timed_out', exitCode: null, output: '', error: 'execution timed out' }), request.limits.timeoutMs);
      request.signal?.addEventListener('abort', cancel, { once: true });
      if (request.signal?.aborted) cancel();
      let output = '';
      let emittedOutputBytes = 0;
      let hostCallCount = 0;
      let progressEventCount = 0;
      worker.on('message', (message: {
        type: string;
        exitCode?: number;
        output?: string;
        error?: string;
        message?: string;
        capability?: Exclude<CustomerModuleCapability, 'background'>;
        payload?: unknown;
      }) => {
        if (message.type === 'host_request' && message.capability) {
          hostCallCount += 1;
          if (hostCallCount > 100) { finish({ status: 'crashed', exitCode: null, output: '', error: 'Host ABI call limit exceeded' }); return; }
          void this.handleHostRequest(request, bridge, message.capability, message.payload);
          return;
        }
        if (message.type === 'progress') {
          progressEventCount += 1;
          if (progressEventCount > 1_000) { finish({ status: 'crashed', exitCode: null, output: '', error: 'progress event limit exceeded' }); return; }
          this.audit(request, 'customer_module.progress', 'running', startedAt);
          return;
        }
        if (message.type === 'result') {
          output = message.output ?? '';
          emittedOutputBytes += Buffer.byteLength(output);
          if (emittedOutputBytes > request.limits.maxOutputBytes) {
            finish({ status: 'crashed', exitCode: null, output: '', error: 'output limit exceeded' });
          }
          return;
        }
        if (message.type === 'completed') {
          if (Buffer.byteLength(output) > request.limits.maxOutputBytes) {
            finish({ status: 'crashed', exitCode: null, output: '', error: 'output limit exceeded' });
          } else finish({ status: 'completed', exitCode: message.exitCode ?? 0, output });
        } else finish({ status: 'crashed', exitCode: null, output: '', error: message.error ?? 'worker crashed' });
      });
      worker.once('error', (error) => finish({ status: 'crashed', exitCode: null, output: '', error: error.message }));
      worker.once('exit', (code) => {
        if (!settled && code !== 0) finish({ status: 'crashed', exitCode: code, output: '', error: `worker exited with code ${code}` });
      });
      });
    } finally {
      activeCustomerModuleRuns -= 1;
    }
  }

  private async handleHostRequest(
    request: CustomerModuleRunRequest,
    bridge: SharedArrayBuffer,
    capability: Exclude<CustomerModuleCapability, 'background'>,
    payload: unknown,
  ): Promise<void> {
    const control = new Int32Array(bridge, 0, 4);
    const bytes = new Uint8Array(bridge, 16);
    try {
      if (!this.options.host) throw new Error('customer module Host ABI is unavailable');
      const envelope = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
      const result = await this.options.host.request({
        moduleId: request.moduleId,
        version: request.version,
        capability,
        approvedCapabilities: request.approvedCapabilities,
        payload: envelope.data,
        externalWrite: envelope.externalWrite === true,
        ...(typeof envelope.idempotencyKey === 'string' ? { idempotencyKey: envelope.idempotencyKey } : {}),
      });
      this.completeBridge(control, bytes, 1, JSON.stringify(result.data));
    } catch (error) {
      this.completeBridge(control, bytes, 2, JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  }

  private completeBridge(control: Int32Array, target: Uint8Array, state: 1 | 2, body: string): void {
    let encoded = new TextEncoder().encode(body);
    let nextState = state;
    if (encoded.length > target.length) {
      encoded = new TextEncoder().encode(JSON.stringify({ error: 'Host ABI response exceeds output limit' }));
      nextState = 2;
    }
    const size = Math.min(encoded.length, target.length);
    target.set(encoded.subarray(0, size));
    Atomics.store(control, 1, size);
    Atomics.store(control, 0, nextState);
    Atomics.notify(control, 0);
  }

  private audit(
    request: CustomerModuleRunRequest,
    type: CustomerModuleAuditEvent['type'],
    status: CustomerModuleAuditEvent['status'],
    startedAt: number,
    error?: string,
  ): void {
    this.options.onAudit?.({
      type, moduleId: request.moduleId, version: request.version, status,
      durationMs: Date.now() - startedAt,
      approvedCapabilities: [...request.approvedCapabilities],
      estimatedCostUsd: 0,
      ...(error ? { error } : {}),
    });
  }
}
