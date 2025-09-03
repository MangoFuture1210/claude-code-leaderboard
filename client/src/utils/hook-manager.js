import { readFile, writeFile, chmod, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CLAUDE_DIR = path.join(homedir(), '.claude');
const HOOK_SCRIPT_PATH = path.join(CLAUDE_DIR, 'claude_stats_hook.js');
const SETTINGS_JSON_PATH = path.join(CLAUDE_DIR, 'settings.json');

// 安装 Hook
export async function installHook(config) {
  // 1. 复制 Hook 脚本
  await installHookScript(config);
  
  // 2. 更新 settings.json
  await updateSettings();
  
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
async function installHookScript(config) {
  // 读取模板 Hook 脚本
  const templatePath = path.join(__dirname, '..', '..', 'hooks', 'count_tokens.js');
  let hookContent = await readFile(templatePath, 'utf-8');
  
  // 注入配置
  const configSection = `
// 自动生成的配置
const STATS_CONFIG = ${JSON.stringify({
    username: config.username,
    serverUrl: config.serverUrl,
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