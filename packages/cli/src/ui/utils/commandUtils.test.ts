/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterEach, Mock } from 'vitest';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import {
  isAtCommand,
  isSlashCommand,
  copyToClipboard,
} from './commandUtils.js';

// Mock child_process：spawn 用于 darwin/linux，exec 用于 win32/WSL（源码经 promisify(exec) 调用）。
// 完整工厂 mock（含 default 导出）——这样 promisify(exec) 会绑定到下面的 exec spy，
// 且该 spy 没有 util.promisify.custom 符号，promisify 会走标准 (cmd, callback) 协议。
vi.mock('child_process', () => {
  const spawn = vi.fn();
  const exec = vi.fn(
    (
      _cmd: string,
      callback?: (
        err: Error | null,
        result: { stdout: string; stderr: string },
      ) => void,
    ) => {
      callback?.(null, { stdout: '', stderr: '' });
    },
  );
  return { spawn, exec, default: { spawn, exec } };
});

// Store original platform
const originalPlatform = process.platform;

// Helper to mock platform
function mockPlatform(platform: string) {
  Object.defineProperty(process, 'platform', {
    value: platform,
    writable: true,
    configurable: true,
  });
}

// Helper to restore platform
function restorePlatform() {
  Object.defineProperty(process, 'platform', {
    value: originalPlatform,
    writable: true,
    configurable: true,
  });
}

interface MockChildProcess extends EventEmitter {
  stdin: EventEmitter & {
    write: Mock;
    end: Mock;
  };
  stderr: EventEmitter;
}

describe('commandUtils', () => {
  let mockSpawn: Mock;
  let mockChild: MockChildProcess;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Clear WSL environment variables to ensure platform-specific logic is tested correctly
    delete process.env.WSL_DISTRO_NAME;
    delete process.env.WSL_INTEROP;
    delete process.env.WSLENV;

    // Dynamically import and set up spawn mock
    const { spawn } = await import('child_process');
    mockSpawn = spawn as Mock;

    // Create mock child process with stdout/stderr emitters
    mockChild = Object.assign(new EventEmitter(), {
      stdin: Object.assign(new EventEmitter(), {
        write: vi.fn(),
        end: vi.fn(),
      }),
      stderr: new EventEmitter(),
    }) as MockChildProcess;

    mockSpawn.mockReturnValue(mockChild as unknown as ReturnType<typeof spawn>);
  });

  afterEach(() => {
    restorePlatform();
  });

  describe('isAtCommand', () => {
    it('should return true when query starts with @', () => {
      expect(isAtCommand('@file')).toBe(true);
      expect(isAtCommand('@path/to/file')).toBe(true);
      expect(isAtCommand('@')).toBe(true);
    });

    it('should return true when query contains @ preceded by whitespace', () => {
      expect(isAtCommand('hello @file')).toBe(true);
      expect(isAtCommand('some text @path/to/file')).toBe(true);
      expect(isAtCommand('   @file')).toBe(true);
    });

    it('should return false when query does not start with @ and has no spaced @', () => {
      expect(isAtCommand('file')).toBe(false);
      expect(isAtCommand('hello')).toBe(false);
      expect(isAtCommand('')).toBe(false);
      expect(isAtCommand('email@domain.com')).toBe(false);
      expect(isAtCommand('user@host')).toBe(false);
    });

    it('should return false when @ is not preceded by whitespace', () => {
      expect(isAtCommand('hello@file')).toBe(false);
      expect(isAtCommand('text@path')).toBe(false);
    });
  });

  describe('isSlashCommand', () => {
    it('should return true when query starts with /', () => {
      expect(isSlashCommand('/help')).toBe(true);
      expect(isSlashCommand('/memory show')).toBe(true);
      expect(isSlashCommand('/clear')).toBe(true);
      expect(isSlashCommand('/')).toBe(true);
    });

    it('should return false when query does not start with /', () => {
      expect(isSlashCommand('help')).toBe(false);
      expect(isSlashCommand('memory show')).toBe(false);
      expect(isSlashCommand('')).toBe(false);
      expect(isSlashCommand('path/to/file')).toBe(false);
      expect(isSlashCommand(' /help')).toBe(false);
    });
  });

  describe('copyToClipboard', () => {
    describe('on macOS (darwin)', () => {
      beforeEach(() => {
        mockPlatform('darwin');
      });

      it('should successfully copy text to clipboard using pbcopy', async () => {
        const testText = 'Hello, world!';

        // Simulate successful execution
        setTimeout(() => {
          mockChild.emit('close', 0);
        }, 0);

        await copyToClipboard(testText);

        expect(mockSpawn).toHaveBeenCalledWith('pbcopy', []);
        expect(mockChild.stdin.write).toHaveBeenCalledWith(testText);
        expect(mockChild.stdin.end).toHaveBeenCalled();
      });

      it('should handle pbcopy command failure', async () => {
        const testText = 'Hello, world!';

        // Simulate command failure
        setTimeout(() => {
          mockChild.stderr.emit('data', 'Command not found');
          mockChild.emit('close', 1);
        }, 0);

        await expect(copyToClipboard(testText)).rejects.toThrow(
          "'pbcopy' exited with code 1: Command not found",
        );
      });

      it('should handle spawn error', async () => {
        const testText = 'Hello, world!';

        setTimeout(() => {
          mockChild.emit('error', new Error('spawn error'));
        }, 0);

        await expect(copyToClipboard(testText)).rejects.toThrow('spawn error');
      });

      it('should handle stdin write error', async () => {
        const testText = 'Hello, world!';

        setTimeout(() => {
          mockChild.stdin.emit('error', new Error('stdin error'));
        }, 0);

        await expect(copyToClipboard(testText)).rejects.toThrow('stdin error');
      });
    });

    describe('on Windows (win32)', () => {
      let mockExec: Mock;

      beforeEach(async () => {
        mockPlatform('win32');
        const { exec } = await import('child_process');
        mockExec = exec as unknown as Mock;
        // 外层 beforeEach 调用了 vi.clearAllMocks()，会清掉 exec 的实现，
        // 这里重新设置：遵守 (cmd, callback) 协议以便 promisify(exec) 正常 resolve
        mockExec.mockImplementation(
          (
            _cmd: string,
            callback?: (
              err: Error | null,
              result: { stdout: string; stderr: string },
            ) => void,
          ) => {
            callback?.(null, { stdout: '', stderr: '' });
          },
        );
      });

      // Windows 走 copyToClipboardWindows，内部使用 promisify(exec) 执行 PowerShell
      // （而非 spawn），因此这里断言 exec 被调用且命令为 powershell.exe -EncodedCommand

      it('should use PowerShell for copying text on Windows', async () => {
        const testText = 'Hello, world!';

        await copyToClipboard(testText);

        expect(mockExec).toHaveBeenCalledTimes(1);
        const calledCommand = mockExec.mock.calls[0][0] as string;
        expect(calledCommand).toMatch(/powershell\.exe/i);
        expect(calledCommand).toContain('-EncodedCommand');
        // 不应回退到 clip.exe
        expect(calledCommand).not.toContain('clip.exe');
      });

      it('should encode Chinese text as Base64 for PowerShell', async () => {
        const testText = '你好，世界！';

        await copyToClipboard(testText);

        expect(mockExec).toHaveBeenCalledTimes(1);
        const calledCommand = mockExec.mock.calls[0][0] as string;
        expect(calledCommand).toMatch(/powershell\.exe/i);
        expect(calledCommand).toContain('-EncodedCommand');

        // 验证编码后的脚本解码回来确实包含原始中文文本的 Base64（Unicode 正确处理）
        const encodedMatch = calledCommand.match(/-EncodedCommand\s+(\S+)/);
        expect(encodedMatch).not.toBeNull();
        const decodedScript = Buffer.from(encodedMatch![1], 'base64').toString('utf16le');
        const expectedTextBase64 = Buffer.from(testText, 'utf8').toString('base64');
        expect(decodedScript).toContain(expectedTextBase64);
        expect(decodedScript).toContain('Set-Clipboard');
      });
    });

    describe('on Linux', () => {
      beforeEach(() => {
        mockPlatform('linux');
      });

      it('should successfully copy text to clipboard using xclip', async () => {
        const testText = 'Hello, world!';

        setTimeout(() => {
          mockChild.emit('close', 0);
        }, 0);

        await copyToClipboard(testText);

        expect(mockSpawn).toHaveBeenCalledWith('xclip', [
          '-selection',
          'clipboard',
        ]);
        expect(mockChild.stdin.write).toHaveBeenCalledWith(testText);
        expect(mockChild.stdin.end).toHaveBeenCalled();
      });

      it('should fall back to xsel when xclip fails', async () => {
        const testText = 'Hello, world!';
        let callCount = 0;

        mockSpawn.mockImplementation(() => {
          const child = Object.assign(new EventEmitter(), {
            stdin: Object.assign(new EventEmitter(), {
              write: vi.fn(),
              end: vi.fn(),
            }),
            stderr: new EventEmitter(),
          }) as MockChildProcess;

          setTimeout(() => {
            if (callCount === 0) {
              // First call (xclip) fails
              child.stderr.emit('data', 'xclip not found');
              child.emit('close', 1);
              callCount++;
            } else {
              // Second call (xsel) succeeds
              child.emit('close', 0);
            }
          }, 0);

          return child as unknown as ReturnType<typeof spawn>;
        });

        await copyToClipboard(testText);

        expect(mockSpawn).toHaveBeenCalledTimes(2);
        expect(mockSpawn).toHaveBeenNthCalledWith(1, 'xclip', [
          '-selection',
          'clipboard',
        ]);
        expect(mockSpawn).toHaveBeenNthCalledWith(2, 'xsel', [
          '--clipboard',
          '--input',
        ]);
      });

      it('should throw error when both xclip and xsel fail', async () => {
        const testText = 'Hello, world!';
        let callCount = 0;

        mockSpawn.mockImplementation(() => {
          const child = Object.assign(new EventEmitter(), {
            stdin: Object.assign(new EventEmitter(), {
              write: vi.fn(),
              end: vi.fn(),
            }),
            stderr: new EventEmitter(),
          });

          setTimeout(() => {
            if (callCount === 0) {
              // First call (xclip) fails
              child.stderr.emit('data', 'xclip command not found');
              child.emit('close', 1);
              callCount++;
            } else {
              // Second call (xsel) fails
              child.stderr.emit('data', 'xsel command not found');
              child.emit('close', 1);
            }
          }, 0);

          return child as unknown as ReturnType<typeof spawn>;
        });

        await expect(copyToClipboard(testText)).rejects.toThrow(
          /All copy commands failed/,
        );

        expect(mockSpawn).toHaveBeenCalledTimes(2);
      });
    });

    describe('on unsupported platform', () => {
      beforeEach(() => {
        mockPlatform('unsupported');
      });

      it('should throw error for unsupported platform', async () => {
        await expect(copyToClipboard('test')).rejects.toThrow(
          'Unsupported platform: unsupported',
        );
      });
    });

    describe('error handling', () => {
      beforeEach(() => {
        mockPlatform('darwin');
      });

      it('should handle command exit without stderr', async () => {
        const testText = 'Hello, world!';

        setTimeout(() => {
          mockChild.emit('close', 1);
        }, 0);

        await expect(copyToClipboard(testText)).rejects.toThrow(
          "'pbcopy' exited with code 1",
        );
      });

      it('should handle empty text', async () => {
        setTimeout(() => {
          mockChild.emit('close', 0);
        }, 0);

        await copyToClipboard('');

        expect(mockChild.stdin.write).toHaveBeenCalledWith('');
      });

      it('should handle multiline text', async () => {
        const multilineText = 'Line 1\nLine 2\nLine 3';

        setTimeout(() => {
          mockChild.emit('close', 0);
        }, 0);

        await copyToClipboard(multilineText);

        expect(mockChild.stdin.write).toHaveBeenCalledWith(multilineText);
      });

      it('should handle special characters', async () => {
        const specialText = 'Special chars: !@#$%^&*()_+-=[]{}|;:,.<>?';

        setTimeout(() => {
          mockChild.emit('close', 0);
        }, 0);

        await copyToClipboard(specialText);

        expect(mockChild.stdin.write).toHaveBeenCalledWith(specialText);
      });
    });
  });
});
