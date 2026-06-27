/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 *
 * Per-project persistence for debate presets.
 *
 * Stored at `<projectRoot>/.otto/debate-history.json` — same directory
 * as the project-level settings file, so users already expect this folder.
 *
 * Rules:
 * - Max 3 presets kept; when saving a 4th distinct preset the oldest is dropped.
 * - Deduplication by (topic, models-as-sorted-set, rounds) triple: saving an
 *   identical preset just bumps `savedAt` to "now" and re-sorts to front.
 * - Sort order returned by loadPresets(): newest first (by savedAt desc).
 * - Failures to read/write are swallowed with a warning — debate should work
 *   even if the history file is corrupted; it just won't remember presets.
 */

import * as fs from 'fs';
import * as path from 'path';
import stripJsonComments from 'strip-json-comments';

const STORAGE_DIR = '.otto';
const STORAGE_FILE = 'debate-history.json';
const MAX_PRESETS = 3;

export interface DebatePreset {
  topic: string;
  models: string[];
  rounds: number;
  /** ISO timestamp string. Newer = more recently used. */
  savedAt: string;
}

interface DebateHistoryFile {
  presets: DebatePreset[];
}

function getStoragePath(projectRoot: string): string {
  return path.join(projectRoot, STORAGE_DIR, STORAGE_FILE);
}

function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Canonical key for dedup. Speaking order matters in a debate (who reads the
 * code first vs who rebuts later is a different conversation), so models are
 * NOT sorted here — `[opus, haiku]` and `[haiku, opus]` are distinct presets.
 */
function presetKey(p: Pick<DebatePreset, 'topic' | 'models' | 'rounds'>): string {
  return `${p.rounds}|${p.models.join(',')}|${p.topic}`;
}

/**
 * Load presets for the given project, newest first. Returns empty array on
 * any failure (file missing, parse error, etc.) — never throws.
 */
export function loadPresets(projectRoot: string): DebatePreset[] {
  const filePath = getStoragePath(projectRoot);
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(stripJsonComments(raw)) as DebateHistoryFile;
    if (!parsed || !Array.isArray(parsed.presets)) return [];

    // Validate + filter + sort newest-first, slice to MAX.
    const valid = parsed.presets.filter(isValidPreset);
    valid.sort(
      (a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime(),
    );
    return valid.slice(0, MAX_PRESETS);
  } catch (err) {
    console.warn(
      `[debateStorage] Failed to load presets from ${filePath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return [];
  }
}

function isValidPreset(p: unknown): p is DebatePreset {
  if (!p || typeof p !== 'object') return false;
  const o = p as Record<string, unknown>;
  return (
    typeof o.topic === 'string' &&
    o.topic.length > 0 &&
    Array.isArray(o.models) &&
    o.models.length >= 2 &&
    o.models.length <= 4 &&
    o.models.every(
      (m: unknown) => typeof m === 'string' && m.length > 0,
    ) &&
    typeof o.rounds === 'number' &&
    o.rounds >= 1 &&
    typeof o.savedAt === 'string'
  );
}

/**
 * Save a preset. If an equivalent one exists, its savedAt is bumped;
 * otherwise a new entry is added and the oldest is evicted if we exceed MAX.
 *
 * Failures are swallowed with a warning.
 */
export function savePreset(
  projectRoot: string,
  preset: Omit<DebatePreset, 'savedAt'>,
): void {
  const filePath = getStoragePath(projectRoot);
  try {
    const existing = loadPresets(projectRoot);
    const key = presetKey(preset);

    // Drop any existing entry with the same key, then unshift the fresh one.
    const filtered = existing.filter((p) => presetKey(p) !== key);
    const next: DebatePreset = {
      topic: preset.topic,
      models: [...preset.models],
      rounds: preset.rounds,
      savedAt: new Date().toISOString(),
    };
    const merged = [next, ...filtered].slice(0, MAX_PRESETS);

    ensureDir(filePath);
    fs.writeFileSync(
      filePath,
      JSON.stringify({ presets: merged } satisfies DebateHistoryFile, null, 2),
      'utf-8',
    );
  } catch (err) {
    console.warn(
      `[debateStorage] Failed to save preset to ${filePath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
