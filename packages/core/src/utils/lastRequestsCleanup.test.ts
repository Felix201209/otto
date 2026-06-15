/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  cleanupLastRequestsDir,
  getLastRequestsDir,
  _resetLastRequestsCleanupLatch,
} from './lastRequestsCleanup.js';

/**
 * The cleanup module short-circuits under vitest by design (so dev
 * inspections aren't trashed). To exercise the actual sweep we set
 * NODE_ENV=production for the duration of the test, then restore.
 *
 * We also reroute HOME so the sweep can't touch the developer's real
 * `~/.deepv/last-requests/` directory.
 */
describe('cleanupLastRequestsDir', () => {
  let prevHome: string | undefined;
  let prevHomedrive: string | undefined;
  let prevUserprofile: string | undefined;
  let prevNodeEnv: string | undefined;
  let prevVitest: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'deepv-cleanup-test-'));
    prevHome = process.env.HOME;
    prevHomedrive = process.env.HOMEDRIVE;
    prevUserprofile = process.env.USERPROFILE;
    prevNodeEnv = process.env.NODE_ENV;
    prevVitest = process.env.VITEST;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    delete process.env.HOMEDRIVE;
    process.env.NODE_ENV = 'production';
    delete process.env.VITEST;
    _resetLastRequestsCleanupLatch();
  });

  afterEach(() => {
    if (prevHome !== undefined) process.env.HOME = prevHome;
    else delete process.env.HOME;
    if (prevUserprofile !== undefined) process.env.USERPROFILE = prevUserprofile;
    else delete process.env.USERPROFILE;
    if (prevHomedrive !== undefined) process.env.HOMEDRIVE = prevHomedrive;
    if (prevNodeEnv !== undefined) process.env.NODE_ENV = prevNodeEnv;
    else delete process.env.NODE_ENV;
    if (prevVitest !== undefined) process.env.VITEST = prevVitest;
    fs.rmSync(tmpHome, { recursive: true, force: true });
    _resetLastRequestsCleanupLatch();
  });

  function makeFile(name: string, ageMs: number): string {
    const dir = getLastRequestsDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(file, '{"x":1}', 'utf8');
    const now = Date.now();
    fs.utimesSync(file, new Date(now - ageMs), new Date(now - ageMs));
    return file;
  }

  it('returns 0 when the dump dir does not exist (first ever run)', async () => {
    const removed = await cleanupLastRequestsDir();
    expect(removed).toBe(0);
  });

  it('deletes only json/tmp files older than the retention window', async () => {
    const fresh = makeFile('2026-05-25_gemini-stream_kept.json', 0);
    const stale = makeFile('2026-05-20_gemini-stream_old.json', 5 * 86_400_000);
    const staleTmp = makeFile('2026-05-20_gemini-stream_old.json.tmp', 5 * 86_400_000);
    const unrelated = makeFile('readme.txt', 5 * 86_400_000); // not json/tmp → kept

    const removed = await cleanupLastRequestsDir(Date.now(), 3 * 86_400_000);

    expect(removed).toBe(2); // json + tmp
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(staleTmp)).toBe(false);
    expect(fs.existsSync(unrelated)).toBe(true); // we don't touch non-json/tmp
  });

  it('honours the once-per-process latch', async () => {
    makeFile('2026-05-20_gemini-stream_a.json', 5 * 86_400_000);
    makeFile('2026-05-20_gemini-stream_b.json', 5 * 86_400_000);

    const first = await cleanupLastRequestsDir();
    expect(first).toBe(2);

    // Recreate stale files; second invocation must NOT clean them
    // because the latch is set for this process.
    makeFile('2026-05-21_gemini-stream_c.json', 5 * 86_400_000);
    const second = await cleanupLastRequestsDir();
    expect(second).toBe(0);
  });

  it('respects custom retentionMs (1 hour)', async () => {
    makeFile('2026-05-20_gemini-stream_2h.json', 2 * 60 * 60 * 1000);
    makeFile('2026-05-25_gemini-stream_30m.json', 30 * 60 * 1000);

    const removed = await cleanupLastRequestsDir(Date.now(), 60 * 60 * 1000);
    expect(removed).toBe(1);
  });

  it('skips entirely under VITEST env (defensive — caller already guarded)', async () => {
    // Re-enable the test-mode short-circuit and make sure we don't sweep.
    process.env.VITEST = '1';
    _resetLastRequestsCleanupLatch();
    makeFile('2026-05-20_gemini-stream_x.json', 30 * 86_400_000);

    const removed = await cleanupLastRequestsDir();
    expect(removed).toBe(0);
  });
});
