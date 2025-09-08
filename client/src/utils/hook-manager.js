import { readFile, writeFile, chmod, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { normalizeServerUrl } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CLAUDE_DIR = path.join(homedir(), '.claude');
const HOOK_SCRIPT_PATH = path.join(CLAUDE_DIR, 'claude_stats_hook.js');
const SETTINGS_JSON_PATH = path.join(CLAUDE_DIR, 'settings.json');
const HOOK_VERSION_FILE = path.join(CLAUDE_DIR, 'stats-hook-version.json');

// 安装 Hook
export async function installHook(config, version = 'v3') {
  // 1. 复制 Hook 脚本
  await installHookScript(config, version);
  
  // 2. 更新 settings.json
  await updateSettings();
  
  // 3. 记录版本信息
  await saveHookVersion(version);
  
  return true;
}

// 卸载 Hook
export async function uninstallHook() {
  // 1. 移除 Hook 脚本
  if (existsSync(HOOK_SCRIPT_PATH)) {
    await unlink(HOOK_SCRIPT_PATH);
  }
  
  // 2. 从 settings.json 中移除
  await removeFromSettings();
  
  return true;
}

// 安装 Hook 脚本
async function installHookScript(config, version = 'v3') {
  // 选择对应版本的 Hook 文件
  let hookFile;
  switch(version) {
    case 'v3':
      hookFile = 'count_tokens_v3.js';
      break;
    case 'v2':
      hookFile = 'count_tokens_v2.js';
      break;
    default:
      hookFile = 'count_tokens_v3.js'; // 默认使用 v3
  }
  
  const templatePath = path.join(__dirname, '..', '..', 'hooks', hookFile);
  let hookContent = await readFile(templatePath, 'utf-8');
  
  // 注入配置
  const configSection = `
// 自动生成的配置
const STATS_CONFIG = ${JSON.stringify({
    username: config.username,
    serverUrl: normalizeServerUrl(config.serverUrl),
    enabled: config.enabled
  }, null, 2)};
`;
  
  // 在文件开头添加配置
  hookContent = hookContent.replace(
    '#!/usr/bin/env node',
    `#!/usr/bin/env node\n${configSection}`
  );
  
  // 写入 Hook 文件
  await writeFile(HOOK_SCRIPT_PATH, hookContent, 'utf-8');
  
  // 设置可执行权限
  await chmod(HOOK_SCRIPT_PATH, 0o755);
}

// 更新 settings.json
async function updateSettings() {
  let settings = {};
  
  // 读取现有设置
  if (existsSync(SETTINGS_JSON_PATH)) {
    try {
      const content = await readFile(SETTINGS_JSON_PATH, 'utf-8');
      settings = JSON.parse(content);
    } catch (error) {
      console.warn('Warning: Could not parse settings.json');
    }
  }
  
  // 确保 hooks 结构存在
  if (!settings.hooks) {
    settings.hooks = {};
  }
  if (!settings.hooks.Stop) {
    settings.hooks.Stop = [];
  }
  
  // 检查是否已存在
  const hookExists = settings.hooks.Stop.some(stopHook =>
    stopHook.hooks?.some(hook =>
      hook.type === 'command' &&
      hook.command === HOOK_SCRIPT_PATH
    )
  );
  
  if (!hookExists) {
    // 添加 Hook
    settings.hooks.Stop.push({
      matcher: '.*',
      hooks: [{
        type: 'command',
        command: HOOK_SCRIPT_PATH
      }]
    });
    
    // 保存设置
    await writeFile(SETTINGS_JSON_PATH, JSON.stringify(settings, null, 2), 'utf-8');
  }
}

// 从 settings.json 中移除
async function removeFromSettings() {
  if (!existsSync(SETTINGS_JSON_PATH)) {
    return;
  }
  
  try {
    const content = await readFile(SETTINGS_JSON_PATH, 'utf-8');
    const settings = JSON.parse(content);
    
    if (settings.hooks?.Stop) {
      // 过滤掉我们的 Hook
      settings.hooks.Stop = settings.hooks.Stop.filter(stopHook => {
        if (stopHook.hooks) {
          stopHook.hooks = stopHook.hooks.filter(hook =>
            !(hook.type === 'command' && hook.command === HOOK_SCRIPT_PATH)
          );
        }
        return stopHook.hooks && stopHook.hooks.length > 0;
      });
      
      // 如果 Stop 为空，删除它
      if (settings.hooks.Stop.length === 0) {
        delete settings.hooks.Stop;
      }
      
      // 如果 hooks 为空，删除它
      if (Object.keys(settings.hooks).length === 0) {
        delete settings.hooks;
      }
      
      // 保存更新后的设置
      await writeFile(SETTINGS_JSON_PATH, JSON.stringify(settings, null, 2), 'utf-8');
    }
  } catch (error) {
    console.warn('Warning: Could not update settings.json');
  }
}

// 保存 Hook 版本信息
async function saveHookVersion(version) {
  const versionData = {
    version,
    installedAt: new Date().toISOString(),
    features: version === 'v3' ? [
      'state-management',
      'batch-collection', 
      'retry-logic',
      'atomic-writes',
      'file-locking',
      'dynamic-chunk-size',
      'timeout-protection',
      'progress-reporting',
      'optimized-throughput'
    ] : version === 'v2' ? [
      'state-management',
      'batch-collection', 
      'retry-logic',
      'atomic-writes',
      'file-locking'
    ] : ['basic-collection']
  };
  
  await writeFile(HOOK_VERSION_FILE, JSON.stringify(versionData, null, 2), 'utf-8');
}

// 获取当前 Hook 版本
export async function getCurrentHookVersion() {
  if (!existsSync(HOOK_VERSION_FILE)) {
    // 如果版本文件不存在，检查是否有旧版 hook
    if (existsSync(HOOK_SCRIPT_PATH)) {
      return { version: 'v1', installedAt: 'unknown' };
    }
    return null;
  }
  
  try {
    const content = await readFile(HOOK_VERSION_FILE, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

// 清理状态文件（用于调试或重置）
export async function cleanupStateFiles() {
  const stateFiles = [
    path.join(CLAUDE_DIR, 'stats-state.json'),
    path.join(CLAUDE_DIR, 'stats-state.json.backup'),
    path.join(CLAUDE_DIR, 'stats-state.buffer.json'),
    path.join(CLAUDE_DIR, 'stats.lock'),
    path.join(CLAUDE_DIR, 'stats-debug.log'),
    path.join(CLAUDE_DIR, 'stats-debug.log.old')
  ];
  
  let cleaned = 0;
  for (const file of stateFiles) {
    if (existsSync(file)) {
      try {
        await unlink(file);
        cleaned++;
      } catch {
        // 忽略删除失败
      }
    }
  }
  
  return cleaned;
}