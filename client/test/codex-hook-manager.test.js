#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildManagedCodexStopHook,
  ensureCodexHooksFeature,
  getCodexConfigPath,
  getCodexHookStatus,
  getCodexHooksPath,
  installCodexStopHook,
  isCodexHooksFeatureEnabled,
  mergeManagedCodexHookConfig,
  removeManagedCodexHookConfig,
  setCodexHooksFeature,
  uninstallCodexStopHook
} from '../src/utils/codex-hook-manager.js';

assert.equal(
  setCodexHooksFeature('model = "gpt-5.5"\n', true),
  'model = "gpt-5.5"\n\n[features]\ncodex_hooks = true\n'
);

assert.equal(
  setCodexHooksFeature('[features]\nfoo = true\n', true),
  '[features]\ncodex_hooks = true\nfoo = true\n'
);

assert.equal(
  setCodexHooksFeature('[features]\ncodex_hooks = false\nfoo = true\n', true),
  '[features]\ncodex_hooks = true\nfoo = true\n'
);

const preserved = setCodexHooksFeature('model = "gpt-5.5"\n\n[features]\nfoo = true\n\n[plugins.x]\nenabled = true\n', true);
assert.match(preserved, /model = "gpt-5\.5"/);
assert.match(preserved, /\[plugins\.x\]\nenabled = true/);
assert.equal(isCodexHooksFeatureEnabled(preserved), true);

const managedHook = buildManagedCodexStopHook('/tmp/project/client/bin/cli.js');
const merged = mergeManagedCodexHookConfig({
  hooks: {
    Stop: [{
      hooks: [{
        type: 'command',
        command: 'echo unrelated'
      }]
    }]
  }
}, managedHook);

assert.equal(merged.hooks.Stop.length, 2);
assert.equal(merged.hooks.Stop[0].hooks[0].command, 'echo unrelated');
assert.match(merged.hooks.Stop[1].hooks[0].command, /codex sync --batch-size 50 --quiet --max-records 100/);

const replaced = mergeManagedCodexHookConfig(merged, buildManagedCodexStopHook('/tmp/other/client/bin/cli.js'));
assert.equal(replaced.hooks.Stop.length, 2);
assert.equal(
  replaced.hooks.Stop.filter(entry => /codex sync/.test(entry.hooks?.[0]?.command || '')).length,
  1
);
assert.match(replaced.hooks.Stop[1].hooks[0].command, /\/tmp\/other\/client\/bin\/cli\.js/);

const removed = removeManagedCodexHookConfig(replaced);
assert.equal(removed.hooks.Stop.length, 1);
assert.equal(removed.hooks.Stop[0].hooks[0].command, 'echo unrelated');

const tempDir = await mkdtemp(path.join(tmpdir(), 'codex-hook-manager-'));
try {
  const configPath = getCodexConfigPath(tempDir);
  const hooksPath = getCodexHooksPath(tempDir);

  await ensureCodexHooksFeature(configPath);
  assert.equal(isCodexHooksFeatureEnabled(await readFile(configPath, 'utf-8')), true);

  await installCodexStopHook({
    cliPath: '/tmp/project/client/bin/cli.js',
    codexDir: tempDir
  });
  const status = await getCodexHookStatus({
    cliPath: '/tmp/project/client/bin/cli.js',
    codexDir: tempDir
  });
  assert.equal(status.featureEnabled, true);
  assert.equal(status.hookInstalled, true);
  assert.equal(status.timeout, 45);
  assert.equal(status.statusMessage, 'Syncing Codex usage');

  await writeFile(hooksPath, JSON.stringify(mergeManagedCodexHookConfig({
    hooks: {
      Stop: [{
        hooks: [{
          type: 'command',
          command: 'echo unrelated'
        }]
      }]
    }
  }, managedHook), null, 2));

  await uninstallCodexStopHook({ codexDir: tempDir });
  const afterUninstall = JSON.parse(await readFile(hooksPath, 'utf-8'));
  assert.equal(afterUninstall.hooks.Stop.length, 1);
  assert.equal(afterUninstall.hooks.Stop[0].hooks[0].command, 'echo unrelated');

  await uninstallCodexStopHook({ codexDir: tempDir });
  assert.equal(existsSync(hooksPath), true);

  console.log('codex-hook-manager tests passed');
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
