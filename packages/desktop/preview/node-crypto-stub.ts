/**
 * Browser live-preview placeholder for server-only crypto helpers.
 *
 * The renderer imports a few shared constants from otto-server modules. Those
 * modules also contain Node-only invite signing helpers, so webpack sees
 * `node:crypto` even though the browser preview does not exercise those paths.
 */

export class KeyObject {}

export function createPublicKey(): KeyObject {
  throw new Error('node:crypto is not available in the browser preview');
}

export function randomUUID(): string {
  return globalThis.crypto?.randomUUID?.() ?? `preview-${Date.now()}`;
}

export function sign(): Uint8Array {
  throw new Error('node:crypto signing is not available in the browser preview');
}

export function verify(): boolean {
  throw new Error('node:crypto verification is not available in the browser preview');
}
