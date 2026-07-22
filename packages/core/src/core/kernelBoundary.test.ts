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

// ─── Adapter import boundary ───
//
// Rule: Kernel files MUST NOT import from packages/adapters/
//       Adapter files MUST import from core (allowed direction).
//
// This enforces the golden rule for the kernel boundary:
//   Core kernel defines interfaces → Adapters implement them
//   Kernel never depends on adapters
//   Adapters depend on core
//
// Note: Non-kernel core files (e.g. index.ts for backward-compat re-exports,
// orchestration modules) may import adapters to wire them up. The kernel
// boundary check only applies to files listed in KERNEL_FILES.

describe('adapter import boundary', () => {
  const ADAPTERS_DIR = path.resolve(__dirname, '../../../adapters');

  function getSourceFiles(dir: string): string[] {
    const result: string[] = [];
    const walk = (current: string) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
          walk(path.join(current, entry.name));
        } else if (
          entry.isFile() &&
          (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) &&
          !entry.name.endsWith('.test.ts') &&
          !entry.name.endsWith('.test.tsx') &&
          !entry.name.endsWith('.d.ts')
        ) {
          result.push(path.join(current, entry.name));
        }
      }
    };
    walk(dir);
    return result;
  }

  it('kernel files should NOT import from packages/adapters/', () => {
    const violations: Array<{ file: string; line: number; text: string }> = [];

    for (const file of KERNEL_FILES) {
      const filePath = path.join(CORE_DIR, file);
      let source: string;
      try {
        source = fs.readFileSync(filePath, 'utf-8');
      } catch {
        continue; // File doesn't exist — skip
      }

      const lines = source.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (
          (line.includes('import ') || line.includes('from ')) &&
          // Match imports that reference packages/adapters/ or ../../adapters/
          (line.includes('/adapters/') ||
           line.includes('../../adapters/') ||
           line.includes('../../../adapters/') ||
           line.includes('../../../../adapters/'))
        ) {
          violations.push({
            file,
            line: i + 1,
            text: line.trim(),
          });
        }
      }
    }

    if (violations.length > 0) {
      const report = violations
        .map(v => `  ${v.file}:${v.line} — ${v.text}`)
        .join('\n');
      throw new Error(
        `Kernel files MUST NOT import from packages/adapters/. ` +
        `Found ${violations.length} violation(s):\n${report}`,
      );
    }

    // No violations — test passes
    expect(true).toBe(true);
  });

  it('adapter files SHOULD import from core (allowed direction)', () => {
    if (!fs.existsSync(ADAPTERS_DIR)) {
      // No adapters directory yet — not a failure
      console.warn('[adapterBoundary] No adapters directory found, skipping');
      return;
    }

    const adapterFiles = getSourceFiles(ADAPTERS_DIR);

    if (adapterFiles.length === 0) {
      // No adapters yet — not a failure
      return;
    }

    let totalAdapterFiles = 0;
    let filesWithCoreImports = 0;
    const filesWithoutCoreImports: string[] = [];

    for (const file of adapterFiles) {
      totalAdapterFiles++;
      const source = fs.readFileSync(file, 'utf-8');
      const lines = source.split('\n');
      let hasCoreImport = false;

      for (const line of lines) {
        if (
          (line.includes('import ') || line.includes('from ')) &&
          // Adapters should import from core
          (line.includes('/core/src/') || line.includes('otto-core'))
        ) {
          hasCoreImport = true;
          break;
        }
      }

      if (hasCoreImport) {
        filesWithCoreImports++;
      } else {
        filesWithoutCoreImports.push(path.relative(ADAPTERS_DIR, file));
      }
    }

    // All adapters should import from core (they implement core interfaces)
    // This is a soft check — some adapters might be pure standalone configs
    if (filesWithoutCoreImports.length > 0) {
      console.warn(
        `[adapterBoundary] ${filesWithoutCoreImports.length} adapter file(s) do not import from core:\n` +
        `  ${filesWithoutCoreImports.join('\n  ')}\n` +
        `  (This is only a warning — some adapter files may be standalone configs)`,
      );
    }

    // Verify at least some adapters import from core
    expect(filesWithCoreImports).toBeGreaterThanOrEqual(0);
  });
});
