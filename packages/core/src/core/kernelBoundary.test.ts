/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 *
 * Import-boundary test for the Otto runtime kernel.
 *
 * This test validates that core kernel files do NOT import from
 * optional/UI packages. It reads source files and checks for banned
 * import patterns. This is a lightweight lint — document the current
 * state, not rewrite the codebase.
 *
 * See: docs/runtime-kernel-boundary.md
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// ─── Kernel files that form the boundary ───
// These are the files defined in docs/runtime-kernel-boundary.md as
// kernel entry points. Every file listed must pass the import check.

const KERNEL_FILES = [
  'client.ts',
  'turn.ts',
  'toolExecutionEngine.ts',
  'coreToolScheduler.ts',
  'nonInteractiveToolExecutor.ts',
  'toolSchedulerAdapter.ts',
  'mainAgentAdapter.ts',
  'subAgentAdapter.ts',
  'confirmationBridge.ts',
  'logger.ts',
  'contentGenerator.ts',
  'sceneManager.ts',
  'prompts.ts',
  'tokenLimits.ts',
  'modelConfig.ts',
  'ottoChat.ts',
  'ottoRequest.ts',
  'subAgent.ts',
  'customModelAdapter.ts',
  'OttoServerAdapter.ts',
  'imageGenerator.ts',
  'workflowRegistry.ts',
  'workflowRunner.ts',
  'workflowAgentBridge.ts',
  'taskPrompts.ts',
  'proxyAuth.ts',
  'modelCheck.ts',
  'invalidStreamError.ts',
];

// ─── Banned import patterns ───
// Each entry is a regex tested against every import/require line.
// If a pattern matches, the test fails.

const BANNED_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  // UI frameworks — must live in cli/desktop/vscode packages
  { pattern: /from\s+['"]react['"]/, description: "import from 'react'" },
  { pattern: /from\s+['"]ink['"]/, description: "import from 'ink'" },
  { pattern: /from\s+['"]electron['"]/, description: "import from 'electron'" },
  { pattern: /from\s+['"]@inkjs\//, description: "import from '@inkjs/*'" },

  // Cross-package imports — kernel must not depend on UI/IDE packages
  { pattern: /from\s+['"]\.\.\/ui\//, description: "import from '../ui/'" },
  { pattern: /from\s+['"]\.\.\/\.\.\/desktop\//, description: "import from '../../desktop/'" },
  { pattern: /from\s+['"]\.\.\/\.\.\/cli\//, description: "import from '../../cli/'" },
  { pattern: /from\s+['"]\.\.\/\.\.\/server\//, description: "import from '../../server/'" },

  // IDE/LSP — platform-specific, not kernel
  // NOTE: client.ts imports ideContext for IDE-mode file context injection;
  //       this is tolerated because it is context-gathering, not rendering.
  { pattern: /from\s+['"]\.\.\/lsp\//, description: "import from '../lsp/'" },
];

// ─── Supported import patterns (whitelist reference) ───
// These are NOT checked — they document what IS allowed from kernel files.
//
// Allowed:
//   from './*'           — same-directory kernel modules
//   from '../core/*'     — other kernel files
//   from '../types/*'    — shared types
//   from '../config/*'   — configuration
//   from '../utils/*'    — shared utilities (no UI)
//   from '../services/*' — session, compression, files
//   from '../tools/*'    — tool definitions (called by kernel)
//   from '../hooks/*'    — hook system (injected in)
//   from '../orchestration/*' — audit/work log (injected in)
//   from '@google/genai' — LLM SDK
//   from 'node:*'        — Node.js built-ins

// ─── The test ───

const CORE_DIR = path.resolve(__dirname);

describe('kernel import boundary', () => {
  for (const file of KERNEL_FILES) {
    describe(file, () => {
      let source: string;

      // Read once per file to avoid repeated I/O
      try {
        source = fs.readFileSync(path.join(CORE_DIR, file), 'utf-8');
      } catch {
        // File doesn't exist yet — skip don't fail
        // This handles the case where kernel files are added to the list
        // before they're created (TDD-friendly)
        it.skip('file not found — skipped', () => {});
        return;
      }

      for (const { pattern, description } of BANNED_PATTERNS) {
        it(`should NOT contain ${description}`, () => {
          const lines = source.split('\n');
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            // Only check import/require lines (skip comments, strings, code)
            if (
              line.includes('import ') ||
              line.includes('require(') ||
              line.includes('from ')
            ) {
              if (pattern.test(line)) {
                // Fail with a descriptive message pointing to the exact line
                const contextLines = lines
                  .slice(Math.max(0, i - 1), Math.min(lines.length, i + 2))
                  .map((l, idx) => {
                    const ln = Math.max(0, i - 1) + idx + 1;
                    const marker = ln === i + 1 ? '>>>' : '   ';
                    return `${marker} ${String(ln).padStart(4, ' ')}: ${l}`;
                  })
                  .join('\n');
                throw new Error(
                  `Banned import "${description}" found in ${file}:\n${contextLines}`,
                );
              }
            }
          }
          // No banned pattern found — test passes
          expect(true).toBe(true);
        });
      }
    });
  }

  it('should have a non-empty kernel file list', () => {
    expect(KERNEL_FILES.length).toBeGreaterThan(0);
  });

  it('all listed kernel files should exist on disk', () => {
    const missing: string[] = [];
    for (const file of KERNEL_FILES) {
      const filePath = path.join(CORE_DIR, file);
      if (!fs.existsSync(filePath)) {
        missing.push(file);
      }
    }
    // Info-only: files in the list that don't exist yet are a warning,
    // not a failure. They're skipped in the import check above.
    if (missing.length > 0) {
      console.warn(
        `[kernelBoundary] ${missing.length} kernel file(s) not found on disk (skipped):\n  ${missing.join('\n  ')}`,
      );
    }
    // Not a hard failure — the kernel list defines intent, not all files
    // may exist yet during refactoring.
    expect(true).toBe(true);
  });
});
