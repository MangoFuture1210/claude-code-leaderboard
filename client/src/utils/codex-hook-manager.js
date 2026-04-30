import { mkdir, readFile, writeFile, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { homedir } from 'os';

const CODEX_HOME_ENV = 'CODEX_HOME';
const HOOK_LABEL = 'claude-stats-codex-sync';

export function getCodexDir() {
  return process.env[CODEX_HOME_ENV] || path.join(homedir(), '.codex');
}

export function getCodexConfigPath(codexDir = getCodexDir()) {
  return path.join(codexDir, 'config.toml');
}

export function getCodexHooksPath(codexDir = getCodexDir()) {
  return path.join(codexDir, 'hooks.json');
}

export function isCodexHooksFeatureEnabled(content) {
  const lines = content.split(/\r?\n/);
  let inFeatures = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (/^\[.+\]$/.test(trimmed)) {
      inFeatures = trimmed === '[features]';
      continue;
    }

    if (inFeatures && /^codex_hooks\s*=\s*true\b/.test(trimmed)) {
      return true;
    }

    if (inFeatures && /^codex_hooks\s*=\s*false\b/.test(trimmed)) {
      return false;
    }
  }

  return false;
}

export function setCodexHooksFeature(content, enabled = true) {
  const value = enabled ? 'true' : 'false';
  const lines = content.split(/\r?\n/);
  let featuresStart = -1;
  let featuresEnd = lines.length;

  for (let index = 0; index < lines.length; index++) {
    if (lines[index].trim() === '[features]') {
      featuresStart = index;
      break;
    }
  }

  if (featuresStart === -1) {
    const prefix = content.trimEnd();
    return `${prefix}${prefix ? '\n\n' : ''}[features]\ncodex_hooks = ${value}\n`;
  }

  for (let index = featuresStart + 1; index < lines.length; index++) {
    if (/^\[.+\]$/.test(lines[index].trim())) {
      featuresEnd = index;
      break;
    }
  }

  for (let index = featuresStart + 1; index < featuresEnd; index++) {
    if (/^\s*codex_hooks\s*=/.test(lines[index])) {
      lines[index] = lines[index].replace(/codex_hooks\s*=\s*(true|false)/, `codex_hooks = ${value}`);
      return `${lines.join('\n')}${content.endsWith('\n') ? '\n' : ''}`.replace(/\n{2}$/, '\n');
    }
  }

  lines.splice(featuresStart + 1, 0, `codex_hooks = ${value}`);
  return `${lines.join('\n')}${content.endsWith('\n') ? '\n' : ''}`.replace(/\n{2}$/, '\n');
}

export async function ensureCodexHooksFeature(configPath = getCodexConfigPath()) {
  const codexDir = path.dirname(configPath);
  if (!existsSync(codexDir)) {
    await mkdir(codexDir, { recursive: true });
  }

  let content = '';
  if (existsSync(configPath)) {
    content = await readFile(configPath, 'utf-8');
  }

  const nextContent = setCodexHooksFeature(content, true);
  if (nextContent !== content) {
    await writeFile(configPath, nextContent, 'utf-8');
  }

  return true;
}

export async function disableCodexHooksFeature(configPath = getCodexConfigPath()) {
  if (!existsSync(configPath)) return false;

  const content = await readFile(configPath, 'utf-8');
  const nextContent = setCodexHooksFeature(content, false);
  if (nextContent !== content) {
    await writeFile(configPath, nextContent, 'utf-8');
  }

  return true;
}

export function buildManagedCodexHookCommand(cliPath) {
  return `node "${cliPath}" codex sync --batch-size 50 --quiet --hook-output-json --max-records 100`;
}

export function isManagedCodexHookCommand(command = '') {
  return /codex\s+sync/.test(command) &&
    (command.includes('claude-stats') || command.includes('bin/cli.js'));
}

export function buildManagedCodexStopHook(cliPath) {
  return {
    hooks: [{
      type: 'command',
      command: buildManagedCodexHookCommand(cliPath),
      timeout: 45,
      statusMessage: 'Syncing Codex usage'
    }]
  };
}

function normalizeHooksConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return { hooks: {} };
  }

  if (!config.hooks || typeof config.hooks !== 'object' || Array.isArray(config.hooks)) {
    config.hooks = {};
  }

  return config;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

export function mergeManagedCodexHookConfig(existingConfig, managedHook) {
  const config = normalizeHooksConfig(cloneJson(existingConfig));
  const stopHooks = Array.isArray(config.hooks.Stop) ? config.hooks.Stop : [];

  config.hooks.Stop = removeManagedCodexHookConfig({ hooks: { Stop: stopHooks } }).hooks.Stop || [];
  config.hooks.Stop.push(managedHook);

  return config;
}

export function removeManagedCodexHookConfig(existingConfig) {
  const config = normalizeHooksConfig(cloneJson(existingConfig));
  const stopHooks = Array.isArray(config.hooks.Stop) ? config.hooks.Stop : [];

  config.hooks.Stop = stopHooks
    .map(entry => {
      if (!entry || typeof entry !== 'object' || !Array.isArray(entry.hooks)) {
        return entry;
      }

      return {
        ...entry,
        hooks: entry.hooks.filter(hook => !isManagedCodexHookCommand(hook?.command || ''))
      };
    })
    .filter(entry => !Array.isArray(entry?.hooks) || entry.hooks.length > 0);

  if (config.hooks.Stop.length === 0) {
    delete config.hooks.Stop;
  }

  return config;
}

async function readHooksConfig(hooksPath) {
  if (!existsSync(hooksPath)) {
    return { hooks: {} };
  }

  const content = await readFile(hooksPath, 'utf-8');
  if (!content.trim()) {
    return { hooks: {} };
  }

  return normalizeHooksConfig(JSON.parse(content));
}

export async function installCodexStopHook({ cliPath, codexDir = getCodexDir() }) {
  const hooksPath = getCodexHooksPath(codexDir);
  await mkdir(path.dirname(hooksPath), { recursive: true });
  await ensureCodexHooksFeature(getCodexConfigPath(codexDir));

  const existingConfig = await readHooksConfig(hooksPath);
  const nextConfig = mergeManagedCodexHookConfig(
    existingConfig,
    buildManagedCodexStopHook(cliPath)
  );

  await writeFile(hooksPath, `${JSON.stringify(nextConfig, null, 2)}\n`, 'utf-8');

  return {
    hooksPath,
    configPath: getCodexConfigPath(codexDir),
    command: buildManagedCodexHookCommand(cliPath)
  };
}

export async function uninstallCodexStopHook({ codexDir = getCodexDir(), disableFeature = false } = {}) {
  const hooksPath = getCodexHooksPath(codexDir);
  let removed = false;

  if (existsSync(hooksPath)) {
    const existingConfig = await readHooksConfig(hooksPath);
    const before = JSON.stringify(existingConfig);
    const nextConfig = removeManagedCodexHookConfig(existingConfig);
    removed = JSON.stringify(nextConfig) !== before;

    if (Object.keys(nextConfig.hooks || {}).length === 0) {
      await unlink(hooksPath);
    } else {
      await writeFile(hooksPath, `${JSON.stringify(nextConfig, null, 2)}\n`, 'utf-8');
    }
  }

  if (disableFeature) {
    await disableCodexHooksFeature(getCodexConfigPath(codexDir));
  }

  return {
    hooksPath,
    configPath: getCodexConfigPath(codexDir),
    removed,
    featureDisabled: disableFeature
  };
}

export async function getCodexHookStatus({ cliPath, codexDir = getCodexDir() } = {}) {
  const configPath = getCodexConfigPath(codexDir);
  const hooksPath = getCodexHooksPath(codexDir);
  const configContent = existsSync(configPath) ? await readFile(configPath, 'utf-8') : '';
  const hooksConfig = existsSync(hooksPath) ? await readHooksConfig(hooksPath) : { hooks: {} };
  const stopHooks = Array.isArray(hooksConfig.hooks?.Stop) ? hooksConfig.hooks.Stop : [];

  let managedHook = null;
  for (const entry of stopHooks) {
    const hook = entry?.hooks?.find(candidate => isManagedCodexHookCommand(candidate?.command || ''));
    if (hook) {
      managedHook = hook;
      break;
    }
  }

  return {
    configPath,
    hooksPath,
    featureEnabled: isCodexHooksFeatureEnabled(configContent),
    hookInstalled: Boolean(managedHook),
    command: managedHook?.command || (cliPath ? buildManagedCodexHookCommand(cliPath) : null),
    timeout: managedHook?.timeout || null,
    statusMessage: managedHook?.statusMessage || null
  };
}
