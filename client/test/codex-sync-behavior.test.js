#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  acquireCodexSyncLock,
  isCodexHookOutputMode,
  limitCodexSyncEntries,
  parsePositiveInteger
} from '../src/commands/index.js';

assert.equal(parsePositiveInteger('50'), 50);
assert.equal(parsePositiveInteger('0', 100), 100);
assert.equal(parsePositiveInteger('abc', 100), 100);
assert.deepEqual(limitCodexSyncEntries([1, 2, 3], '2'), [1, 2]);
assert.deepEqual(limitCodexSyncEntries([1, 2, 3], undefined), [1, 2, 3]);
assert.equal(isCodexHookOutputMode({ quiet: true, hookOutputJson: true }), true);
assert.equal(isCodexHookOutputMode({ quiet: false, hookOutputJson: true }), false);

const tempDir = await mkdtemp(path.join(tmpdir(), 'codex-sync-lock-'));
try {
  const lockPath = path.join(tempDir, 'codex-sync.lock');

  const release = await acquireCodexSyncLock(lockPath);
  assert.equal(typeof release, 'function');
  assert.equal(existsSync(lockPath), true);

  const blocked = await acquireCodexSyncLock(lockPath);
  assert.equal(blocked, null);

  await release();
  assert.equal(existsSync(lockPath), false);

  await writeFile(lockPath, JSON.stringify({
    pid: 123,
    timestamp: new Date(Date.now() - 31 * 60 * 1000).toISOString()
  }));

  const releaseStale = await acquireCodexSyncLock(lockPath);
  assert.equal(typeof releaseStale, 'function');
  await releaseStale();
  assert.equal(existsSync(lockPath), false);

  await writeFile(lockPath, 'not json');
  const releaseCorrupt = await acquireCodexSyncLock(lockPath);
  assert.equal(typeof releaseCorrupt, 'function');
  const lockContent = JSON.parse(await readFile(lockPath, 'utf-8'));
  assert.equal(lockContent.pid, process.pid);
  await releaseCorrupt();

  console.log('codex-sync behavior tests passed');
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
