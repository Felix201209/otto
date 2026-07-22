/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { REQUIRED_NATIVE_HOT_PATH_METHODS } from './nativeHotPaths.js';

export type NativeCoreMode = 'off' | 'auto' | 'required';

export interface NativeCoreRuntimeOptions {
  mode?: NativeCoreMode;
  binaryPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
}

export interface NativeCoreRuntimeSelection {
  mode: NativeCoreMode;
  enabled: boolean;
  required: boolean;
  binaryPath?: string;
  hotPathMethods: readonly string[];
}

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 5000;
const BINARY_BASENAME = process.platform === 'win32' ? 'otto-native.exe' : 'otto-native';

export function resolveNativeCoreMode(env: NodeJS.ProcessEnv = process.env): NativeCoreMode {
  const raw = String(env.OTTO_NATIVE_CORE ?? 'auto').toLowerCase();
  if (raw === 'off' || raw === 'auto' || raw === 'required') return raw;
  return 'auto';
}

export function getNativeCoreBinaryCandidates(options: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
} = {}): string[] {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const platform = options.platform ?? process.platform;
  const executableName = platform === 'win32' ? 'otto-native.exe' : 'otto-native';
  const candidates = [
    env.OTTO_NATIVE_CORE_BINARY,
    path.join(cwd, 'otto-native', 'bin', executableName),
    path.join(cwd, 'otto-native', 'target', 'release', executableName),
    path.join(cwd, 'otto-native', 'target', 'x86_64-pc-windows-gnu', 'release', 'otto-native.exe'),
    path.join(cwd, 'otto-native', 'target', 'x86_64-unknown-linux-gnu', 'release', 'otto-native'),
    path.join(cwd, 'otto-native', 'target', 'x86_64-apple-darwin', 'release', 'otto-native'),
  ];

  return candidates.filter((candidate): candidate is string => Boolean(candidate));
}

export function findNativeCoreBinary(options: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
} = {}): string | undefined {
  return getNativeCoreBinaryCandidates(options).find((candidate) => existsSync(candidate));
}

export function resolveNativeCoreRuntime(options: NativeCoreRuntimeOptions = {}): NativeCoreRuntimeSelection {
  const env = options.env ?? process.env;
  const mode = options.mode ?? resolveNativeCoreMode(env);
  const binaryPath = options.binaryPath ?? findNativeCoreBinary({ cwd: options.cwd, env });

  if (mode === 'off') {
    return {
      mode,
      enabled: false,
      required: false,
      hotPathMethods: REQUIRED_NATIVE_HOT_PATH_METHODS,
    };
  }

  if (!binaryPath && mode === 'required') {
    throw new Error(
      `OTTO_NATIVE_CORE=required but no ${BINARY_BASENAME} binary was found. ` +
        'Build otto-native or set OTTO_NATIVE_CORE_BINARY.',
    );
  }

  return {
    mode,
    enabled: Boolean(binaryPath),
    required: mode === 'required',
    binaryPath,
    hotPathMethods: REQUIRED_NATIVE_HOT_PATH_METHODS,
  };
}

export class NativeCoreBridge {
  private child?: ChildProcessWithoutNullStreams;
  private requestId = 0;
  private stdoutBuffer = '';
  private pending = new Map<number, PendingRequest>();

  constructor(private readonly options: NativeCoreRuntimeOptions = {}) {}

  get selection(): NativeCoreRuntimeSelection {
    return resolveNativeCoreRuntime(this.options);
  }

  async available(): Promise<boolean> {
    const selection = this.selection;
    if (!selection.enabled) return false;
    try {
      await this.call('ping');
      return true;
    } catch {
      return false;
    }
  }

  async call(method: string, params?: Record<string, unknown>): Promise<unknown> {
    await this.start();
    const id = ++this.requestId;
    const request = { id, method, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`native core request timed out: ${method}`));
      }, this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });
      this.child?.stdin.write(`${JSON.stringify(request)}\n`);
    });
  }

  async close(): Promise<void> {
    if (!this.child) return;
    this.child.stdin.end();
    this.child.kill();
    this.child = undefined;
    this.rejectPending(new Error('native core bridge closed'));
  }

  private async start(): Promise<void> {
    if (this.child) return;

    const selection = this.selection;
    if (!selection.enabled || !selection.binaryPath) {
      throw new Error('native core is not available; use JS fallback or set OTTO_NATIVE_CORE=required to fail fast');
    }

    this.child = spawn(selection.binaryPath, [], {
      cwd: this.options.cwd,
      stdio: 'pipe',
    });

    this.child.stdout.on('data', (chunk: Buffer) => this.consumeStdout(chunk.toString('utf8')));
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.rejectPending(new Error(chunk.toString('utf8').trim() || 'native core stderr'));
    });
    this.child.on('error', (error) => {
      this.child = undefined;
      this.rejectPending(error);
    });
    this.child.on('exit', (code) => {
      this.child = undefined;
      this.rejectPending(new Error(`native core exited with code ${code ?? 'unknown'}`));
    });
  }

  private consumeStdout(text: string): void {
    this.stdoutBuffer += text;
    const lines = this.stdoutBuffer.split('\n');
    this.stdoutBuffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let response: JsonRpcResponse;
      try {
        response = JSON.parse(trimmed) as JsonRpcResponse;
      } catch {
        continue;
      }
      if (response.id === undefined) continue;
      const pending = this.pending.get(response.id);
      if (!pending) continue;
      this.pending.delete(response.id);
      clearTimeout(pending.timer);
      if (response.error) pending.reject(new Error(response.error));
      else pending.resolve(response.result);
    }
  }

  private rejectPending(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

