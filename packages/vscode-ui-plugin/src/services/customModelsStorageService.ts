/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Custom Models Storage Service (extension host)
 * --------------------------------------------------------------------------
 * Mirrors `packages/cli/src/config/customModelsStorage.ts` so the VSCode UI
 * plugin reads/writes the SAME `~/.otto/custom-models.json` file as the
 * CLI. A user who configures a model in the CLI sees it immediately in the
 * extension and vice-versa.
 *
 * Atomic write semantics (write to .tmp, rename) match the CLI; this avoids
 * corrupting the file if the editor crashes mid-write.
 *
 * Notes for the VSCode port:
 * - `console.*` is replaced with `Logger` so messages flow into the extension's
 *   output channel rather than the developer console.
 * - `strip-json-comments` is *not* available as a workspace dependency for the
 *   extension host bundle. We tolerate JSON-with-comments by stripping `//` and
 *   `/* *\/` ourselves; the format is permissive enough for hand edits.
 */

import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { CustomModelConfig, validateCustomModelConfig } from 'otto-core';
import { Logger } from '../utils/logger';

const SETTINGS_DIRECTORY_NAME = '.otto-user';
const CUSTOM_MODELS_FILE = 'custom-models.json';

/** Absolute path to `~/.otto/custom-models.json` (shared with CLI). */
export function getCustomModelsFilePath(): string {
  return path.join(homedir(), SETTINGS_DIRECTORY_NAME, CUSTOM_MODELS_FILE);
}

/** Lightweight JSON-with-comments stripper. Tolerates `// line` and `/* block *\/`. */
function stripJsonComments(input: string): string {
  // Remove block comments first, then line comments. This is intentionally
  // simple — we only support hand-edited config files, not arbitrary JS.
  return input
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function ensureDirectoryExists(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Singleton-style helper around custom model persistence. Stateless on disk;
 * the only state we keep is a Logger reference for diagnostic messages.
 */
export class CustomModelsStorageService {
  private static instance: CustomModelsStorageService | null = null;
  private logger: Logger;

  private constructor(logger: Logger) {
    this.logger = logger;
  }

  static getInstance(logger: Logger): CustomModelsStorageService {
    if (!CustomModelsStorageService.instance) {
      CustomModelsStorageService.instance = new CustomModelsStorageService(logger);
    }
    return CustomModelsStorageService.instance;
  }

  /**
   * Load all valid custom models from disk. Invalid entries are logged and
   * skipped so a single malformed model doesn't break the whole list.
   */
  loadCustomModels(): CustomModelConfig[] {
    const filePath = getCustomModelsFilePath();
    try {
      if (!fs.existsSync(filePath)) {
        return [];
      }

      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(stripJsonComments(content));

      if (!Array.isArray(parsed.models)) {
        this.logger.warn('[CustomModels] Invalid format in custom-models.json, expected { models: [...] }');
        return [];
      }

      const validModels: CustomModelConfig[] = [];
      for (const model of parsed.models) {
        const errors = validateCustomModelConfig(model);
        if (errors.length === 0) {
          validModels.push(model);
        } else {
          this.logger.warn(
            `[CustomModels] Skipping invalid model "${model.displayName}": ${errors.join(', ')}`,
          );
        }
      }

      return validModels;
    } catch (error) {
      this.logger.error(
        '[CustomModels] Failed to load custom models',
        error instanceof Error ? error : new Error(String(error)),
      );
      return [];
    }
  }

  /**
   * Persist models to disk. Validates every entry first; if any model fails
   * validation we throw without touching the file.
   *
   * Uses an atomic rename so an in-flight crash never leaves a half-written
   * config behind.
   */
  saveCustomModels(models: CustomModelConfig[]): void {
    const filePath = getCustomModelsFilePath();
    const dirPath = path.dirname(filePath);

    ensureDirectoryExists(dirPath);

    for (const model of models) {
      const errors = validateCustomModelConfig(model);
      if (errors.length > 0) {
        throw new Error(
          `Invalid model configuration for "${model.displayName}": ${errors.join(', ')}`,
        );
      }
    }

    const data = {
      models,
      _metadata: {
        version: '1.0',
        lastModified: new Date().toISOString(),
      },
    };
    const jsonContent = JSON.stringify(data, null, 2);

    const tempFilePath = filePath + '.tmp';
    fs.writeFileSync(tempFilePath, jsonContent, 'utf-8');
    fs.renameSync(tempFilePath, filePath);

    this.logger.info(
      `[CustomModels] Saved ${models.length} custom model(s) to ${filePath}`,
    );
  }

  /**
   * Add a new model or update an existing one (matched by displayName, which
   * is also the implicit identifier — same semantics as CLI).
   */
  addOrUpdateCustomModel(model: CustomModelConfig): void {
    const models = this.loadCustomModels();
    const idx = models.findIndex((m) => m.displayName === model.displayName);
    if (idx >= 0) {
      models[idx] = model;
    } else {
      models.push(model);
    }
    this.saveCustomModels(models);
  }

  /**
   * Bulk add/update — for the EasyRouter flow which produces N configs at once.
   * Returns the merged list so callers can broadcast it for hot-reload.
   */
  addOrUpdateMany(newModels: CustomModelConfig[]): CustomModelConfig[] {
    const existing = this.loadCustomModels();
    const merged = [...existing];
    for (const model of newModels) {
      const idx = merged.findIndex((m) => m.displayName === model.displayName);
      if (idx >= 0) {
        merged[idx] = model;
      } else {
        merged.push(model);
      }
    }
    this.saveCustomModels(merged);
    return merged;
  }

  /**
   * Delete by `custom:{displayName}` id (the same canonical id ContentGenerator
   * dispatch uses). Returns true if anything was actually removed.
   */
  deleteCustomModel(modelId: string): boolean {
    const models = this.loadCustomModels();
    const displayName = modelId.replace(/^custom:/, '');
    const filtered = models.filter((m) => m.displayName !== displayName);
    if (filtered.length === models.length) {
      return false;
    }
    this.saveCustomModels(filtered);
    return true;
  }
}
