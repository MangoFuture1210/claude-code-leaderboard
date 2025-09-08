#!/usr/bin/env node

// 自动生成的配置
const STATS_CONFIG = {
  "username": "javenfang",
  "serverUrl": "https://claude-code-leaderboard.violymuse.com/",
  "enabled": true
};


import { readFile, readdir, writeFile, copyFile, rename, unlink, open, stat, appendFile } from 'node:fs/promises';
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

// 状态文件路径
const STATE_FILE = path.join(USER_HOME_DIR, '.claude', 'stats-state.json');
const BUFFER_FILE = path.join(USER_HOME_DIR, '.claude', 'stats-state.buffer.json');
const LOCK_FILE = path.join(USER_HOME_DIR, '.claude', 'stats.lock');
const LOG_FILE = path.join(USER_HOME_DIR, '.claude', 'stats-debug.log');

// 配置常量
const CHUNK_SIZE = 100; // 每批发送的记录数
const MAX_RETRIES = 3; // 最大重试次数
const LOCK_TIMEOUT = 5000; // 锁超时时间（毫秒）
const LOCK_STALE_TIME = 10000; // 锁过期时间（毫秒）
const RETENTION_DAYS = 30; // 保留天数
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 日志文件最大大小（10MB）
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 单个 JSONL 文件最大大小（20MB）

// 大文件处理配置 - 针对Bug导致的异常积压
const MAX_BUFFER_SIZE = 2 * 1024 * 1024; // 缓冲文件最大大小（2MB，更早触发）
const MAX_BUFFER_ENTRIES = 5000; // 缓冲文件最大记录数（5000条，更早触发）
const PROGRESSIVE_CHUNK_SIZE = 50; // 保留，但现在不使用渐进处理

// ============ 工具类 ============

class StatsLogger {
  constructor() {
    this.logFile = LOG_FILE;
    this.enabled = process.env.CLAUDE_STATS_DEBUG === 'true';
  }
  
  async log(level, message, data = {}) {
    if (!this.enabled) return;
    
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      data,
      pid: process.pid
    };
    
    try {
      await this.appendWithRotation(JSON.stringify(entry) + '\n');
    } catch {
      // 日志失败不影响主流程
    }
  }
  
  async appendWithRotation(content) {
    try {
      const statResult = await stat(this.logFile);
      if (statResult.size > MAX_LOG_SIZE) {
        await rename(this.logFile, `${this.logFile}.old`);
      }
    } catch {
      // 文件不存在，正常
    }
    
    await appendFile(this.logFile, content);
  }
}

class FileLock {
  constructor(lockFile) {
    this.lockFile = lockFile;
    this.acquired = false;
  }
  
  async acquire(timeout = LOCK_TIMEOUT) {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeout) {
      try {
        // 使用独占标志创建锁文件
        const fd = await open(this.lockFile, 'wx');
        const lockData = JSON.stringify({
          pid: process.pid,
          timestamp: new Date().toISOString()
        });
        await fd.write(lockData);
        await fd.close();
        this.acquired = true;
        return true;
      } catch (error) {
        if (error.code === 'EEXIST') {
          // 检查锁是否过期
          if (await this.isLockStale()) {
            try {
              await unlink(this.lockFile);
            } catch {
              // 忽略删除错误
            }
            continue;
          }
          // 等待后重试
          await new Promise(r => setTimeout(r, 100));
        } else {
          throw error;
        }
      }
    }
    return false;
  }
  
  async release() {
    if (this.acquired) {
      try {
        await unlink(this.lockFile);
        this.acquired = false;
      } catch {
        // 忽略删除错误
      }
    }
  }
  
  async isLockStale() {
    try {
      const statResult = await stat(this.lockFile);
      return Date.now() - statResult.mtimeMs > LOCK_STALE_TIME;
    } catch {
      return true; // 如果读取失败，认为是过期锁
    }
  }
}

// ============ 状态管理 ============

async function atomicWriteJson(filepath, data) {
  const tempFile = `${filepath}.tmp.${Date.now()}`;
  const backupFile = `${filepath}.backup`;
  
  try {
    // 1. 写入临时文件
    await writeFile(tempFile, JSON.stringify(data, null, 2));
    
    // 2. 创建备份（如果原文件存在）
    if (existsSync(filepath)) {
      await copyFile(filepath, backupFile);
    }
    
    // 3. 原子替换
    await rename(tempFile, filepath);
    
  } catch (error) {
    // 简化的恢复逻辑：只在备份存在且原文件损坏时恢复
    try {
      if (existsSync(backupFile) && !existsSync(filepath)) {
        await copyFile(backupFile, filepath);
      }
    } catch {
      // 恢复失败也不抛出错误，保留原始错误
    }
    throw error;
  } finally {
    // 清理临时文件
    if (existsSync(tempFile)) {
      try {
        await unlink(tempFile);
      } catch {
        // 忽略清理错误
      }
    }
  }
}

function createEmptyState() {
  return {
    version: "2.0.0",
    lastCleanup: new Date().toISOString(),
    recentHashes: {}
  };
}

function isValidState(state) {
  return state 
    && state.version 
    && typeof state.recentHashes === 'object';
}

async function loadStateWithValidation() {
  const backupFile = `${STATE_FILE}.backup`;
  
  try {
    // 1. 尝试读取主文件
    const content = await readFile(STATE_FILE, 'utf-8');
    const state = JSON.parse(content);
    
    // 2. 验证状态结构
    if (!isValidState(state)) {
      throw new Error('Invalid state structure');
    }
    
    return state;
    
  } catch (error) {
    // 3. 尝试从备份恢复
    if (existsSync(backupFile)) {
      try {
        const backup = JSON.parse(await readFile(backupFile, 'utf-8'));
        if (isValidState(backup)) {
          // 恢复备份
          await copyFile(backupFile, STATE_FILE);
          return backup;
        }
      } catch {
        // 备份也无效
      }
    }
    
    // 4. 创建新状态
    return createEmptyState();
  }
}

async function maintainState(state) {
  const now = new Date();
  const retentionDate = new Date(now - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  
  // 1. 清理过期的 hash
  const cleanedHashes = {};
  for (const [date, hashes] of Object.entries(state.recentHashes)) {
    if (new Date(date) > retentionDate) {
      cleanedHashes[date] = hashes;
    }
  }
  
  // 2. 压缩当天的 hash（去重）
  const today = now.toISOString().split('T')[0];
  if (cleanedHashes[today]) {
    cleanedHashes[today] = [...new Set(cleanedHashes[today])];
  }
  
  return {
    ...state,
    recentHashes: cleanedHashes,
    lastCleanup: now.toISOString()
  };
}

async function updateProcessedState(state, entries) {
  const today = new Date().toISOString().split('T')[0];
  
  // 添加新处理的 hash
  if (!state.recentHashes[today]) {
    state.recentHashes[today] = [];
  }
  
  const newHashes = entries.map(e => e.interaction_hash);
  state.recentHashes[today].push(...newHashes);
  
  // 维护状态（清理过期数据）
  const maintainedState = await maintainState(state);
  
  // 原子写入
  await atomicWriteJson(STATE_FILE, maintainedState);
  
  return maintainedState;
}

// ============ 缓冲区管理 ============

async function saveToBuffer(entries) {
  const bufferData = {
    pendingEntries: entries,
    retryCount: 0,
    lastAttempt: new Date().toISOString()
  };
  
  await atomicWriteJson(BUFFER_FILE, bufferData);
}

async function loadBuffer() {
  try {
    const content = await readFile(BUFFER_FILE, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

// 检查缓冲文件是否过大，需要渐进处理
async function checkBufferSize() {
  try {
    if (!existsSync(BUFFER_FILE)) return { isLarge: false, size: 0, entries: 0 };
    
    const stats = await stat(BUFFER_FILE);
    const buffer = await loadBuffer();
    const entriesCount = buffer?.pendingEntries?.length || 0;
    
    return {
      isLarge: stats.size > MAX_BUFFER_SIZE || entriesCount > MAX_BUFFER_ENTRIES,
      size: stats.size,
      entries: entriesCount
    };
  } catch {
    return { isLarge: false, size: 0, entries: 0 };
  }
}

async function clearBuffer() {
  try {
    await unlink(BUFFER_FILE);
  } catch {
    // 文件不存在也没关系
  }
}

// 一次性处理大缓冲文件 - 针对Bug导致的异常积压
async function processLargeBufferAggressively(config, logger) {
  const buffer = await loadBuffer();
  if (!buffer || !buffer.pendingEntries || buffer.pendingEntries.length === 0) {
    return { processed: 0, remaining: 0, success: true };
  }

  const entries = buffer.pendingEntries;
  
  await logger.log('info', 'Processing large buffer aggressively (one-time cleanup)', {
    totalEntries: entries.length,
    strategy: 'complete_processing'
  });

  try {
    // 使用现有的sendBatchWithRetry函数一次性处理所有数据
    // 它内部已经有分批逻辑（每批100条）和重试机制
    const result = await sendBatchWithRetry(config, entries);
    
    await logger.log('info', 'Large buffer processing completed', {
      success: result.success,
      totalSent: result.totalSent,
      totalEntries: result.totalEntries,
      hasAnySent: result.hasAnySent
    });

    // 使用与正常流程相同的部分成功处理逻辑
    if (result.success) {
      // 全部成功：清理缓冲区
      await clearBuffer();
      await logger.log('info', 'Large buffer completely cleared');
      return { processed: result.totalSent, remaining: 0, success: true };
      
    } else if (result.hasAnySent && result.failedEntries && result.failedEntries.length > 0) {
      // 部分成功：只保留失败的记录
      await logger.log('info', 'Large buffer partial success', {
        successful: result.successfulCount,
        failed: result.failedEntries.length
      });
      
      const failedBuffer = {
        pendingEntries: result.failedEntries,
        lastProcessed: new Date().toISOString(),
        retryCount: (buffer?.retryCount || 0) + 1
      };
      await atomicWriteJson(BUFFER_FILE, failedBuffer);
      
      return { 
        processed: result.successfulCount, 
        remaining: result.failedEntries.length, 
        success: true 
      };
      
    } else {
      // 全部失败：更新重试计数
      await updateBufferRetryCount();
      await logger.log('warn', 'Large buffer processing failed completely');
      return { processed: 0, remaining: entries.length, success: false };
    }
    
  } catch (error) {
    await logger.log('error', 'Error in aggressive large buffer processing', {
      error: error.message,
      totalEntries: entries.length
    });
    return { processed: 0, remaining: entries.length, success: false };
  }
}

async function updateBufferRetryCount() {
  const buffer = await loadBuffer();
  if (buffer) {
    buffer.retryCount += 1;
    buffer.lastAttempt = new Date().toISOString();
    await atomicWriteJson(BUFFER_FILE, buffer);
  }
}

// ============ Claude 路径处理 ============

function getClaudePaths() {
  const envPaths = process.env[CLAUDE_CONFIG_DIR_ENV];
  const paths = envPaths 
    ? envPaths.split(',')
    : [`${XDG_CONFIG_DIR}/claude`, `${USER_HOME_DIR}/.claude`];
  
  return paths.filter(p => existsSync(path.join(p, CLAUDE_PROJECTS_DIR)));
}

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

// ============ 数据解析 ============

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

async function collectUnprocessedEntries(state, logger) {
  const claudePaths = getClaudePaths();
  if (claudePaths.length === 0) return [];
  
  // 收集所有已处理的 hash
  const processedHashes = new Set();
  for (const hashes of Object.values(state.recentHashes)) {
    hashes.forEach(h => processedHashes.add(h));
  }
  
  const unprocessedEntries = [];
  
  for (const claudePath of claudePaths) {
    const projectsDir = path.join(claudePath, CLAUDE_PROJECTS_DIR);
    
    try {
      // 查找所有 JSONL 文件
      const files = await findJsonlFiles(projectsDir);
      
      for (const file of files) {
        try {
          // 检查文件大小
          const fileStats = await stat(file);
          if (fileStats.size > MAX_FILE_SIZE) {
            await logger.log('warn', 'Skipping large file', { 
              file: path.basename(file), 
              size: fileStats.size 
            });
            continue;
          }
          
          const content = await readFile(file, 'utf-8');
          const lines = content.trim().split('\n').filter(line => line.length > 0);
          
          // 处理所有行
          for (const line of lines) {
            const entry = parseUsageFromLine(line);
            if (entry && !processedHashes.has(entry.interaction_hash)) {
              unprocessedEntries.push(entry);
            }
          }
        } catch (error) {
          // 单个文件处理失败不影响其他文件
          await logger.log('warn', 'Failed to process file', { 
            file: path.basename(file), 
            error: error.message 
          });
        }
      }
    } catch {
      // 静默忽略错误
    }
  }
  
  return unprocessedEntries;
}

// ============ 网络请求 ============

async function sendToServer(config, usage) {
  return new Promise((resolve) => {
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
      timeout: 5000
    };
    
    const lib = url.protocol === 'https:' ? https : http;
    
    const req = lib.request(options, (res) => {
      let responseData = '';
      res.on('data', chunk => responseData += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const result = JSON.parse(responseData);
            resolve({ success: true, data: result });
          } catch {
            resolve({ success: true });
          }
        } else {
          resolve({ success: false, status: res.statusCode });
        }
      });
    });
    
    req.on('error', (error) => {
      resolve({ success: false, error: error.message });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ success: false, error: 'timeout' });
    });
    
    req.write(data);
    req.end();
  });
}

async function sendBatchWithRetry(config, entries, maxRetries = MAX_RETRIES) {
  const chunks = [];
  const chunkIndexMapping = []; // 记录每个chunk对应的原始entries索引
  
  // 分批并记录索引映射
  for (let i = 0; i < entries.length; i += CHUNK_SIZE) {
    const chunk = entries.slice(i, i + CHUNK_SIZE);
    chunks.push(chunk);
    chunkIndexMapping.push({ startIndex: i, endIndex: Math.min(i + CHUNK_SIZE, entries.length) });
  }
  
  const results = [];
  const successfulIndices = new Set(); // 记录成功发送的记录索引
  let totalSent = 0;
  
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    const chunk = chunks[chunkIndex];
    const mapping = chunkIndexMapping[chunkIndex];
    let retries = 0;
    let success = false;
    
    while (retries < maxRetries && !success) {
      try {
        const result = await sendToServer(config, chunk);
        if (result.success) {
          success = true;
          totalSent += chunk.length;
          // 记录成功的索引
          for (let i = mapping.startIndex; i < mapping.endIndex; i++) {
            successfulIndices.add(i);
          }
          results.push({ 
            chunkIndex, 
            chunk: chunk.length, 
            success: true, 
            startIndex: mapping.startIndex,
            endIndex: mapping.endIndex 
          });
        } else {
          retries++;
          if (retries < maxRetries) {
            // 简单指数退避
            await new Promise(r => setTimeout(r, 1000 * retries));
          }
        }
      } catch (error) {
        retries++;
        if (retries >= maxRetries) {
          results.push({ 
            chunkIndex, 
            chunk: chunk.length, 
            success: false, 
            error: error.message,
            startIndex: mapping.startIndex,
            endIndex: mapping.endIndex
          });
        } else {
          // 重试前等待
          await new Promise(r => setTimeout(r, 1000 * retries));
        }
      }
    }
  }
  
  // 构建失败的记录
  const failedEntries = entries.filter((_, index) => !successfulIndices.has(index));
  
  // 返回整体结果
  const allSuccess = results.every(r => r.success);
  const hasAnySent = totalSent > 0;
  
  return {
    success: allSuccess,
    results,
    totalSent,
    totalEntries: entries.length,
    hasAnySent,
    failedEntries,  // 新增：失败的具体记录
    successfulCount: successfulIndices.size
  };
}

// ============ 主流程 ============

async function collectAndSendUsage(config, logger) {
  const lock = new FileLock(LOCK_FILE);
  
  try {
    // 1. 获取锁
    if (!await lock.acquire()) {
      await logger.log('info', 'Another instance is running, skipping');
      return;
    }
    
    await logger.log('info', 'Starting usage collection');
    
    // 2. 检查缓冲文件大小，决定处理策略
    const bufferSizeCheck = await checkBufferSize();
    
    if (bufferSizeCheck.isLarge) {
      await logger.log('info', 'Large buffer detected, using progressive processing', {
        size: bufferSizeCheck.size,
        entries: bufferSizeCheck.entries
      });
      
      // 对大文件采用一次性激进处理
      const aggressiveResult = await processLargeBufferAggressively(config, logger);
      await logger.log('info', 'Aggressive processing completed', aggressiveResult);
      
      // 不再继续处理新数据，避免文件进一步增大
      return;
    }
    
    // 3. 检查是否有待重试的缓冲数据（小文件正常处理）
    const buffer = await loadBuffer();
    let entriesToSend = [];
    
    if (buffer && buffer.retryCount < MAX_RETRIES) {
      await logger.log('info', 'Found buffered entries', { 
        count: buffer.pendingEntries.length,
        retryCount: buffer.retryCount 
      });
      entriesToSend = buffer.pendingEntries;
    } else {
      // 4. 加载状态
      const state = await loadStateWithValidation();
      await logger.log('debug', 'Loaded state', { 
        hashCount: Object.values(state.recentHashes).flat().length 
      });
      
      // 5. 收集未处理的记录
      entriesToSend = await collectUnprocessedEntries(state, logger);
      await logger.log('info', 'Collected unprocessed entries', { 
        count: entriesToSend.length 
      });
      
      if (entriesToSend.length === 0) {
        await logger.log('info', 'No new entries to send');
        await clearBuffer();
        return;
      }
      
      // 5. 保存到缓冲区
      await saveToBuffer(entriesToSend);
    }
    
    // 6. 批量发送
    const result = await sendBatchWithRetry(config, entriesToSend);
    await logger.log('info', 'Batch send completed', result);
    
    // 7. 更新状态 - 修复：支持精确的部分成功处理
    if (result.success) {
      // 全部成功：清理缓冲区
      if (!buffer) {
        const state = await loadStateWithValidation();
        await updateProcessedState(state, entriesToSend);
      }
      await clearBuffer();
      await logger.log('info', 'All entries sent successfully, buffer cleared');
    } else if (result.hasAnySent && result.failedEntries.length > 0) {
      // 部分成功：只保留失败的记录
      await logger.log('info', 'Partial success - preserving failed entries', {
        successful: result.successfulCount,
        failed: result.failedEntries.length,
        total: result.totalEntries
      });
      
      // 保存失败的记录到缓冲区
      const failedBuffer = {
        pendingEntries: result.failedEntries,
        lastProcessed: new Date().toISOString(),
        retryCount: (buffer?.retryCount || 0) + 1
      };
      await atomicWriteJson(BUFFER_FILE, failedBuffer);
      
      // 如果有新收集的数据且部分成功，更新状态（标记成功的部分为已处理）
      if (!buffer && result.successfulCount > 0) {
        const state = await loadStateWithValidation();
        // 只更新成功发送的记录状态（这需要更精细的状态管理）
        await updateProcessedState(state, entriesToSend.slice(0, result.successfulCount));
      }
      
      await logger.log('info', 'Failed entries preserved for retry');
    } else {
      // 全部失败：更新重试计数
      await updateBufferRetryCount();
      await logger.log('warn', 'No entries sent successfully, all saved for retry');
    }
    
  } catch (error) {
    await logger.log('error', 'Error in collectAndSendUsage', { 
      error: error.message,
      stack: error.stack 
    });
  } finally {
    await lock.release();
  }
}

// ============ 入口点 ============

async function main() {
  const logger = new StatsLogger();
  
  try {
    // 读取配置
    const configPath = path.join(USER_HOME_DIR, '.claude', 'stats-config.json');
    if (!existsSync(configPath)) {
      process.exit(0);
    }
    
    const configContent = await readFile(configPath, 'utf-8');
    const config = JSON.parse(configContent);
    
    if (!config.enabled || !config.serverUrl) {
      process.exit(0);
    }
    
    // 执行主流程
    await collectAndSendUsage(config, logger);
    
    process.exit(0);
  } catch (error) {
    await logger.log('error', 'Fatal error in main', { 
      error: error.message 
    });
    process.exit(0);
  }
}

main();