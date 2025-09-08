import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { homedir } from 'os';

// 配置文件路径
export const CONFIG_DIR = path.join(homedir(), '.claude');
export const CONFIG_PATH = path.join(CONFIG_DIR, 'stats-config.json');

// 标准化服务器URL，确保末尾没有斜杠
export function normalizeServerUrl(url) {
  if (!url || typeof url !== 'string') {
    return url;
  }
  return url.replace(/\/+$/, '');
}

// 加载配置
export async function loadConfig() {
  try {
    if (!existsSync(CONFIG_PATH)) {
      return null;
    }
    
    const content = await readFile(CONFIG_PATH, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    console.error('Failed to load config:', error.message);
    return null;
  }
}

// 保存配置
export async function saveConfig(config) {
  try {
    // 确保目录存在
    if (!existsSync(CONFIG_DIR)) {
      await mkdir(CONFIG_DIR, { recursive: true });
    }
    
    // 写入配置文件
    await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
    return true;
  } catch (error) {
    console.error('Failed to save config:', error.message);
    throw error;
  }
}

// 检查配置
export async function checkConfig() {
  const config = await loadConfig();
  
  if (!config) {
    return null;
  }
  
  // 验证必需字段
  if (!config.username || !config.serverUrl) {
    return null;
  }
  
  return config;
}