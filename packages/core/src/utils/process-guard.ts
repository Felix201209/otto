/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * Process execution guard for Otto tools.
 * Adds mandatory timeouts, graceful SIGTERM -> SIGKILL escalation.
 */

import { exec } from 'child_process';
import { ToolError, ToolErrorCode } from './tool-error.js';

export interface ExecOptions {
  command: string;
  maxBuffer?: number;       // default 50MB
  timeoutMs?: number;       // default 30_000
  killSignalAfterMs?: number; // how long after SIGTERM before SIGKILL (default 3000)
}

export class ProcessGuard {
  /**
   * Execute a command with timeout and graceful kill escalation.
   *
   * After `timeoutMs`, sends SIGTERM.
   * If process hasn't exited after `killSignalAfterMs` more, sends SIGKILL.
   */
  static exec(opts: ExecOptions): Promise<{ stdout: string; stderr: string }> {
    const timeout = opts.timeoutMs ?? 30_000;
    const killDelay = opts.killSignalAfterMs ?? 3_000;
    const maxBuffer = opts.maxBuffer ?? 50 * 1024 * 1024;

    return new Promise((resolve, reject) => {
      const child = exec(opts.command, {
        maxBuffer,
        timeout: 0, // We manage timeout ourselves for graceful kill
      });

      let stdout = '';
      let stderr = '';
      let killed = false;
      let finished = false;

      const timeoutId = setTimeout(() => {
        if (finished) return;
        killed = true;

        // Send SIGTERM first
        if (child.pid) {
          try { process.kill(-child.pid, 'SIGTERM'); } catch {}
        }

        // After killDelay, force SIGKILL
        setTimeout(() => {
          if (finished) return;
          if (child.pid) {
            try { process.kill(-child.pid, 'SIGKILL'); } catch {}
          }
          child.kill('SIGKILL');
        }, killDelay);
      }, timeout);

      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

      child.on('error', (err) => {
        finished = true;
        clearTimeout(timeoutId);
        reject(new ToolError(ToolErrorCode.EXECUTION_FAILED, err.message, {
          fixHint: 'Check if the command is installed and accessible',
          cause: err.message,
        }));
      });

      child.on('close', (code, signal) => {
        finished = true;
        clearTimeout(timeoutId);

        if (killed) {
          reject(new ToolError(ToolErrorCode.PROCESS_TIMEOUT, `Command timed out after ${timeout}ms`, {
            fixHint: 'The operation took too long. Try with smaller input or check system resources.',
          }));
          return;
        }

        if (code !== 0) {
          reject(new ToolError(ToolErrorCode.EXECUTION_FAILED, `Process exited with code ${code}${signal ? ' (signal: '+signal+')' : ''}`, {
            llmContext: `stderr: ${stderr.substring(0, 500)}`,
            cause: stderr || `exit code ${code}`,
          }));
          return;
        }

        resolve({ stdout, stderr });
      });
    });
  }

  /**
   * Quick check if a command exists on PATH.
   * Returns true/false, does NOT throw.
   */
  static async commandExists(cmd: string): Promise<boolean> {
    const check = process.platform === 'win32'
      ? `where ${cmd} 2>nul`
      : `which ${cmd} 2>/dev/null`;
    try {
      await ProcessGuard.exec({ command: check, timeoutMs: 2000 });
      return true;
    } catch {
      return false;
    }
  }
}
