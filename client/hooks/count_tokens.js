#!/usr/bin/env node

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { homedir } from 'node:os';
import https from 'node:https';
import http from 'node:http';
import crypto from 'node:crypto';

// 获取用户主目录和 Claude 配置目录
const USER_HOME_DIR = homedir();
const XDG_CONFIG_DIR = process.env.XDG_CONFIG_HOME ?? `${USER_HOME_DIR}/.config`;
const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';
const CLAUDE_PROJECTS_DIR = 'projects';

// 获取 Claude 配置路径
function getClaudePaths() {
  const envPaths = process.env[CLAUDE_CONFIG_DIR_ENV];
  const paths = envPaths 
    ? envPaths.split(',')
    : [`${XDG_CONFIG_DIR}/claude`, `${USER_HOME_DIR}/.claude`];
  
  return paths.filter(p => existsSync(path.join(p, CLAUDE_PROJECTS_DIR)));
}

// 解析使用数据
function parseUsageFromLine(line) {
  try {
    const data = JSON.parse(line.trim());
    
    // 验证必需字段
    if (!data?.timestamp || !data?.message?.usage) return null;
    
    const usage = data.message.usage;
    if (typeof usage.input_tokens !== 'number' || 
        typeof usage.output_tokens !== 'number') return null;
    
    // 生成交互哈希用于去重
    const hashInput = `${data.timestamp}${data.message?.id || ''}${data.requestId || ''}`;
    const interactionHash = crypto.createHash('sha256').update(hashInput).digest('hex');
    
    return {
      timestamp: data.timestamp,
      tokens: {
        input: usage.input_tokens,
        output: usage.output_tokens,
        cache_creation: usage.cache_creation_input_tokens || 0,
        cache_read: usage.cache_read_input_tokens || 0
      },
      model: data.message.model || 'unknown',
      session_id: data.sessionId || null,
      interaction_hash: interactionHash
    };
  } catch {
    return null;
  }
}

// 获取最新的使用记录
async function getLatestUsageEntry() {
  const claudePaths = getClaudePaths();
  if (claudePaths.length === 0) return null;
  
  let latestEntry = null;
  let latestTime = 0;
  
  for (const claudePath of claudePaths) {
    const projectsDir = path.join(claudePath, CLAUDE_PROJECTS_DIR);
    
    try {
      // 查找所有 JSONL 文件
      const files = await findJsonlFiles(projectsDir);
      
      for (const file of files) {
        const content = await readFile(file, 'utf-8');
        const lines = content.trim().split('\n').filter(line => line.length > 0);
        
        // 检查最后一行（最新的）
        if (lines.length > 0) {
          const entry = parseUsageFromLine(lines[lines.length - 1]);
          if (entry) {
            const entryTime = new Date(entry.timestamp).getTime();
            if (entryTime > latestTime) {
              latestTime = entryTime;
              latestEntry = entry;
            }
          }
        }
      }
    } catch {
      // 静默忽略错误
    }
  }
  
  return latestEntry;
}

// 递归查找 JSONL 文件
async function findJsonlFiles(dir) {
  const files = [];
  
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      
      if (entry.isDirectory()) {
        files.push(...await findJsonlFiles(fullPath));
      } else if (entry.name.endsWith('.jsonl')) {
        files.push(fullPath);
      }
    }
  } catch {
    // 静默忽略错误
  }
  
  return files;
}

// 发送数据到服务器
async function sendToServer(config, usage) {
  return new Promise((resolve, reject) => {
    // 确保 serverUrl 末尾没有斜杠
    const baseUrl = config.serverUrl.replace(/\/$/, '');
    const url = new URL(baseUrl + '/api/usage/submit');
    const data = JSON.stringify({
      username: config.username,
      usage: usage
    });
    
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      },
      timeout: 5000 // 5秒超时
    };
    
    const lib = url.protocol === 'https:' ? https : http;
    
    const req = lib.request(options, (res) => {
      let responseData = '';
      res.on('data', chunk => responseData += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ success: true });
        } else {
          resolve({ success: false, status: res.statusCode });
        }
      });
    });
    
    req.on('error', () => resolve({ success: false }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ success: false });
    });
    
    req.write(data);
    req.end();
  });
}

// 主函数
async function main() {
  try {
    // 检查是否启用（STATS_CONFIG 会在安装时注入）
    if (typeof STATS_CONFIG === 'undefined') {
      // 如果没有配置，尝试从配置文件读取
      const configPath = path.join(USER_HOME_DIR, '.claude', 'stats-config.json');
      if (!existsSync(configPath)) {
        process.exit(0);
      }
      
      const configContent = await readFile(configPath, 'utf-8');
      const config = JSON.parse(configContent);
      
      if (!config.enabled || !config.serverUrl) {
        process.exit(0);
      }
      
      // 获取最新使用记录
      const usage = await getLatestUsageEntry();
      if (!usage) {
        process.exit(0);
      }
      
      // 发送到服务器
      await sendToServer(config, usage);
    } else {
      // 使用注入的配置
      if (!STATS_CONFIG.enabled || !STATS_CONFIG.serverUrl) {
        process.exit(0);
      }
      
      // 获取最新使用记录
      const usage = await getLatestUsageEntry();
      if (!usage) {
        process.exit(0);
      }
      
      // 发送到服务器
      await sendToServer(STATS_CONFIG, usage);
    }
    
    process.exit(0);
  } catch (error) {
    // 静默失败，不影响 Claude Code
    process.exit(0);
  }
}

main();