/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PostCompactRestorationService } from './postCompactRestorationService.js';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('fs', () => ({
  statSync: vi.fn(),
  readFileSync: vi.fn(),
}));

describe('PostCompactRestorationService', () => {
  let service: PostCompactRestorationService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new PostCompactRestorationService({
      maxFilesToRestore: 3,
      maxCharsPerFile: 100,
      totalCharBudget: 500,
    });
  });

  describe('trackFileRead', () => {
    it('should track file reads', () => {
      service.trackFileRead('/path/to/file.ts');
      expect(service.getTrackedFileCount()).toBe(1);
    });

    it('should deduplicate by path', () => {
      service.trackFileRead('/path/to/file.ts');
      service.trackFileRead('/path/to/file.ts');
      expect(service.getTrackedFileCount()).toBe(1);
    });

    it('should track multiple files', () => {
      service.trackFileRead('/path/to/a.ts');
      service.trackFileRead('/path/to/b.ts');
      service.trackFileRead('/path/to/c.ts');
      expect(service.getTrackedFileCount()).toBe(3);
    });
  });

  describe('getRecentlyReadFiles', () => {
    it('should return files sorted by recency', async () => {
      service.trackFileRead('/path/to/old.ts');
      // Small delay to ensure different timestamps
      await new Promise(r => setTimeout(r, 10));
      service.trackFileRead('/path/to/new.ts');

      const files = service.getRecentlyReadFiles();
      expect(files.length).toBe(2);
      // Most recent should be first
      expect(files[0].filePath).toContain('new.ts');
    });

    it('should respect limit', () => {
      service.trackFileRead('/a.ts');
      service.trackFileRead('/b.ts');
      service.trackFileRead('/c.ts');
      service.trackFileRead('/d.ts');

      const files = service.getRecentlyReadFiles(2);
      expect(files.length).toBe(2);
    });
  });

  describe('generateRestorationContent', () => {
    it('should return null when no files tracked', async () => {
      const result = await service.generateRestorationContent();
      expect(result).toBeNull();
    });

    it('should generate restoration content for tracked files', async () => {
      const filePath = path.resolve('/path/to/file.ts');
      service.trackFileRead('/path/to/file.ts');

      vi.mocked(fs.statSync).mockReturnValue({
        isFile: () => true,
        size: 50,
      } as any);
      vi.mocked(fs.readFileSync).mockReturnValue('const x = 1;');

      const result = await service.generateRestorationContent();
      expect(result).not.toBeNull();
      expect(result).toContain('Post-compression context restoration');
      expect(result).toContain('const x = 1;');
    });

    it('should truncate large files', async () => {
      const filePath = path.resolve('/path/to/large.ts');
      service.trackFileRead('/path/to/large.ts');

      vi.mocked(fs.statSync).mockReturnValue({
        isFile: () => true,
        size: 200,
      } as any);
      vi.mocked(fs.readFileSync).mockReturnValue('x'.repeat(200));

      const result = await service.generateRestorationContent();
      expect(result).not.toBeNull();
      expect(result).toContain('[truncated]');
    });

    it('should skip files that no longer exist', async () => {
      service.trackFileRead('/path/to/deleted.ts');

      vi.mocked(fs.statSync).mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const result = await service.generateRestorationContent();
      expect(result).toBeNull();
    });

    it('should skip files larger than 1MB', async () => {
      service.trackFileRead('/path/to/huge.ts');

      vi.mocked(fs.statSync).mockReturnValue({
        isFile: () => true,
        size: 2 * 1024 * 1024, // 2MB
      } as any);

      const result = await service.generateRestorationContent();
      expect(result).toBeNull();
    });

    it('should respect maxFilesToRestore', async () => {
      for (let i = 0; i < 5; i++) {
        service.trackFileRead(`/path/file${i}.ts`);
        await new Promise(r => setTimeout(r, 5));
      }

      vi.mocked(fs.statSync).mockReturnValue({
        isFile: () => true,
        size: 20,
      } as any);
      vi.mocked(fs.readFileSync).mockReturnValue('content');

      const result = await service.generateRestorationContent();
      expect(result).not.toBeNull();
      // maxFilesToRestore = 3, so at most 3 files
      const fileMatches = result!.match(/--- .+ ---/g);
      expect(fileMatches!.length).toBeLessThanOrEqual(3);
    });
  });

  describe('clear', () => {
    it('should clear all tracked files', () => {
      service.trackFileRead('/a.ts');
      service.trackFileRead('/b.ts');
      expect(service.getTrackedFileCount()).toBe(2);

      service.clear();
      expect(service.getTrackedFileCount()).toBe(0);
    });
  });
});
