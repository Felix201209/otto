#!/usr/bin/env node

import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';

const [sourcePath, targetPath] = process.argv.slice(2);

function fail(message) {
  process.stderr.write('[Otto Deploy] ' + message + '\n');
  process.exitCode = 3;
}

if (!sourcePath || !targetPath) {
  fail('deployment enrollment secret requires source and target file paths');
} else {
  let sourceFd;
  let targetFd;
  let targetCreated = false;

  try {
    const noFollow = constants.O_NOFOLLOW ?? 0;
    sourceFd = openSync(sourcePath, constants.O_RDONLY | noFollow);
    const sourceStat = fstatSync(sourceFd);
    if (!sourceStat.isFile()) {
      throw new Error('source must be a regular file');
    }
    if (process.platform !== 'win32' && (sourceStat.mode & 0o077) !== 0) {
      throw new Error('source must not be readable or writable by group/others');
    }
    if (sourceStat.size < 32 || sourceStat.size > 513) {
      throw new Error('source size is outside the accepted range');
    }

    const raw = readFileSync(sourceFd, 'utf8');
    const secret = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
    if (!/^[A-Za-z0-9_-]{32,512}$/.test(secret)) {
      throw new Error('source must contain one base64url token');
    }

    targetFd = openSync(
      targetPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        noFollow,
      0o600,
    );
    targetCreated = true;
    writeFileSync(targetFd, secret + '\n', 'utf8');
  } catch (error) {
    if (targetFd !== undefined) {
      closeSync(targetFd);
      targetFd = undefined;
    }
    if (targetCreated) {
      try {
        unlinkSync(targetPath);
      } catch {
        // Preserve the original, non-secret-bearing validation error.
      }
    }
    fail(error instanceof Error ? error.message : 'secret staging failed');
  } finally {
    if (targetFd !== undefined) closeSync(targetFd);
    if (sourceFd !== undefined) closeSync(sourceFd);
  }
}
