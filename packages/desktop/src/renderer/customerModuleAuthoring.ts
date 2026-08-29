export interface CustomerModuleAuthoringDraft {
  id: string;
  name: string;
  version: string;
  description: string;
  releaseNotes: string;
  minimumOttoVersion: string;
  permissions: Array<Record<string, unknown>>;
  inputSchema: { type: 'object'; properties: Record<string, unknown> };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[character] ?? character);
}

export async function buildCustomerModuleSubmission(input: {
  draft: CustomerModuleAuthoringDraft;
  publisher: { id: string; name: string };
  wasm: Uint8Array;
}): Promise<{ manifest: Record<string, unknown>; files: Record<string, string> }> {
  const icon = new TextEncoder().encode(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#111827"/><text x="32" y="42" text-anchor="middle" font-size="30" fill="white">${escapeXml(Array.from(input.draft.name.trim())[0] ?? 'M')}</text></svg>`,
  );
  const moduleHash = await sha256(input.wasm);
  const iconHash = await sha256(icon);
  return {
    manifest: {
      schemaVersion: 1,
      ...input.draft,
      publisher: input.publisher,
      icon: 'icon.svg',
      entrypoint: 'module.wasm',
      hostApi: 'otto.customer-module.v1',
      outputs: ['text', 'json'],
      files: { 'module.wasm': moduleHash, 'icon.svg': iconHash },
    },
    files: { 'module.wasm': base64(input.wasm), 'icon.svg': base64(icon) },
  };
}

export async function locallyValidateCustomerModuleWasm(wasm: Uint8Array): Promise<string[]> {
  const module = await WebAssembly.compile(Uint8Array.from(wasm).buffer);
  const imports = WebAssembly.Module.imports(module);
  const allowed = new Set([
    'read_input', 'read_response', 'emit_progress', 'emit_result', 'storage_read',
    'storage_write', 'file_read_selected', 'file_write_selected', 'http_request',
    'model_invoke', 'is_cancelled',
  ]);
  for (const item of imports) {
    if (item.module !== 'otto' || item.kind !== 'function' || !allowed.has(item.name)) {
      throw new Error(`不允许的 WASM import：${item.module}.${item.name}`);
    }
  }
  const exports = WebAssembly.Module.exports(module);
  if (!exports.some((item) => item.kind === 'function' && item.name === 'otto_run')) {
    throw new Error('WASM 必须导出 otto_run');
  }
  return imports.map((item) => `${item.module}.${item.name}`);
}
