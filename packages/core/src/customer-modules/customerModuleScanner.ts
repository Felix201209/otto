import { createHash } from 'node:crypto';

const ALLOWED_HOST_IMPORTS = new Set([
  'read_input',
  'emit_progress',
  'emit_result',
  'storage_read',
  'storage_write',
  'file_read_selected',
  'file_write_selected',
  'http_request',
  'model_invoke',
  'is_cancelled',
  'read_response',
]);

export interface CustomerModuleWasmScan {
  imports: string[];
  exports: string[];
}

const MAX_WASM_MEMORY_PAGES = 1_024;

function readUleb(bytes: Uint8Array, cursor: { value: number }, end = bytes.length): number {
  let result = 0; let shift = 0;
  while (cursor.value < end && shift < 35) {
    const byte = bytes[cursor.value++]!;
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return result >>> 0;
    shift += 7;
  }
  throw new Error('customer module has malformed WASM limits');
}

function validateMemoryLimits(bytes: Uint8Array): void {
  const cursor = { value: 8 };
  while (cursor.value < bytes.length) {
    const sectionId = bytes[cursor.value++]!;
    const size = readUleb(bytes, cursor);
    const end = cursor.value + size;
    if (end > bytes.length) throw new Error('customer module has malformed WASM section');
    if (sectionId === 5) {
      const count = readUleb(bytes, cursor, end);
      if (count > 1) throw new Error('customer module may declare at most one linear memory');
      for (let index = 0; index < count; index += 1) {
        const flags = readUleb(bytes, cursor, end);
        const minimum = readUleb(bytes, cursor, end);
        if ((flags & 1) === 0) throw new Error('customer module linear memory must declare a maximum');
        const maximum = readUleb(bytes, cursor, end);
        if (minimum > maximum || maximum > MAX_WASM_MEMORY_PAGES) throw new Error('customer module linear memory exceeds the 64 MiB limit');
      }
    }
    cursor.value = end;
  }
}

export async function verifyCustomerModuleFileHashes(
  declared: Readonly<Record<string, string>>,
  files: ReadonlyMap<string, Uint8Array>,
): Promise<void> {
  for (const path of files.keys()) {
    if (!(path in declared)) throw new Error(`customer module contains undeclared file: ${path}`);
  }
  for (const [path, digest] of Object.entries(declared)) {
    const body = files.get(path);
    if (!body) throw new Error(`customer module is missing file: ${path}`);
    const actual = createHash('sha256').update(body).digest('hex');
    if (actual !== digest) throw new Error(`customer module file hash mismatch: ${path}`);
  }
}

export async function scanCustomerModuleWasm(bytes: Uint8Array): Promise<CustomerModuleWasmScan> {
  let module: WebAssembly.Module;
  try {
    module = await WebAssembly.compile(Uint8Array.from(bytes).buffer);
  } catch {
    throw new Error('customer module entrypoint is not valid WASM');
  }
  validateMemoryLimits(bytes);
  const imports = WebAssembly.Module.imports(module);
  for (const item of imports) {
    if (item.module !== 'otto' || item.kind !== 'function' || !ALLOWED_HOST_IMPORTS.has(item.name)) {
      throw new Error(`customer module uses forbidden WASM import: ${item.module}.${item.name}`);
    }
  }
  const exports = WebAssembly.Module.exports(module);
  if (!exports.some((item) => item.kind === 'function' && item.name === 'otto_run')) {
    throw new Error('customer module must export otto_run');
  }
  if (imports.length > 0 && !exports.some((item) => item.kind === 'memory' && item.name === 'memory')) {
    throw new Error('customer module using Host ABI must export memory');
  }
  for (const item of exports) {
    if (item.kind === 'memory' && item.name !== 'memory') {
      throw new Error(`customer module exports unexpected memory: ${item.name}`);
    }
  }
  return {
    imports: imports.map((item) => `${item.module}.${item.name}`),
    exports: exports.map((item) => item.name),
  };
}
