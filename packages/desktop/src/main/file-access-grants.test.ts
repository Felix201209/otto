/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { FileAccessGrantStore } from './file-access-grants.js';

describe('FileAccessGrantStore', () => {
  it('允许读取用户从原生对话框明确选择的外部卷文件', () => {
    const realpath = vi.fn((value: string) => value.replace('/link/', '/real/'));
    const stat = vi.fn(() => ({ isFile: () => true, size: 1024 }));
    const grants = new FileAccessGrantStore({ realpath, stat });

    expect(grants.grant(['/Volumes/Portable/link/report.pdf'])).toEqual([
      '/Volumes/Portable/real/report.pdf',
    ]);
    expect(grants.resolve('/Volumes/Portable/link/report.pdf', 50 * 1024 * 1024)).toEqual({
      filePath: '/Volumes/Portable/real/report.pdf',
      size: 1024,
    });
  });

  it('拒绝 renderer 随意传入、未经过用户选择授权的路径', () => {
    const grants = new FileAccessGrantStore({
      realpath: (value) => value,
      stat: () => ({ isFile: () => true, size: 1 }),
    });

    expect(() => grants.resolve('/etc/passwd', 1024)).toThrow('未由你选择授权');
  });

  it('真实模型附件链路批量复核授权并返回规范真实路径', () => {
    const grants = new FileAccessGrantStore({
      realpath: (value) => value.replace('/alias/', '/real/'),
      stat: () => ({ isFile: () => true, size: 128 }),
    });
    grants.grant([
      '/Volumes/Portable/alias/report.pdf',
      '/mnt/share/alias/data.xlsx',
    ]);

    expect(grants.resolveAll([
      '/Volumes/Portable/alias/report.pdf',
      '/mnt/share/alias/data.xlsx',
    ], 1024)).toEqual([
      '/Volumes/Portable/real/report.pdf',
      '/mnt/share/real/data.xlsx',
    ]);
    expect(() => grants.resolveAll([
      '/Volumes/Portable/alias/report.pdf',
      '/etc/passwd',
    ], 1024)).toThrow('未由你选择授权');
  });

  it('拒绝目录和超过体积上限的文件', () => {
    const stat = vi
      .fn()
      .mockReturnValueOnce({ isFile: () => false, size: 0 })
      .mockReturnValue({ isFile: () => true, size: 2049 });
    const grants = new FileAccessGrantStore({ realpath: (value) => value, stat });

    expect(grants.grant(['/Volumes/dir'])).toEqual([]);
    expect(grants.grant(['/Volumes/large.bin'])).toEqual(['/Volumes/large.bin']);
    expect(() => grants.resolve('/Volumes/large.bin', 2048)).toThrow('文件过大');
  });
});
