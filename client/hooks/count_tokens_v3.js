#!/usr/bin/env node

// Hook v3 - 优化版本，解决大数据量处理问题
// 主要改进：
// 1. 动态批次大小
// 2. 超时保护
// 3. 进度报告
// 4. 更好的错误恢复

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

// 配置常量 - V3优化
const CHUNK_SIZES = {
  NORMAL: 100,      // 正常模式：100条/批
  LARGE: 500,       // 大缓冲区：500条/批
  HUGE: 1000,       // 超大缓冲区：1000条/批
};

const THRESHOLDS = {
  LARGE_BUFFER_SIZE: 2 * 1024 * 1024,     // 2MB
  LARGE_BUFFER_ENTRIES: 5000,             // 5000条
  HUGE_BUFFER_ENTRIES: 10000,             // 10000条
  CRITICAL_BUFFER_ENTRIES: 20000,         // 20000条（需要特殊处理）
};

const TIMEOUTS = {
  BATCH: 30000,      // 每批30秒
  TOTAL: 300000,     // 总共5分钟
  REQUEST: 10000,    // 单个请求10秒
};

const MAX_RETRIES = 3;
const LOCK_TIMEOUT = 5000;
const LOCK_STALE_TIME = 10000;
const RETENTION_DAYS = 30;
const MAX_LOG_SIZE = 10 * 1024 * 1024;

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
        // 检查是否有过期的锁
        if (existsSync(this.lockFile)) {
          const lockContent = await readFile(this.lockFile, 'utf-8');
          const lockData = JSON.parse(lockContent);
          const lockAge = Date.now() - new Date(lockData.timestamp).getTime();
          
          if (lockAge > LOCK_STALE_TIME) {
            // 锁已过期，删除它
            await unlink(this.lockFile);
          } else {
            // 锁还有效，等待后重试
            await new Promise(r => setTimeout(r, 100));
            continue;
          }
        }
        
        // 尝试创建锁文件
        const fd = await open(this.lockFile, 'wx');
        const lockData = JSON.stringify({
          pid: process.pid,
          timestamp: new Date().toISOString()
        });
        await writeFile(this.lockFile, lockData);
        await fd.close();
        
        this.acquired = true;
        return true;
      } catch (error) {
        if (error.code === 'EEXIST') {
          // 锁已存在，等待后重试
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
        // 文件可能已被删除
      }
    }
  }
}

// ============ 核心功能 ============

async function atomicWriteJson(filePath, data) {
  const tempPath = `${filePath}.tmp`;
  await writeFile(tempPath, JSON.stringify(data, null, 2));
  await rename(tempPath, filePath);
}

async function loadStateWithValidation() {
  try {
    if (!existsSync(STATE_FILE)) {
      return { recentHashes: {}, lastCleanup: new Date().toISOString() };
    }
    
    const content = await readFile(STATE_FILE, 'utf-8');
    const state = JSON.parse(content);
    
    // 验证状态结构
    if (!state.recentHashes || typeof state.recentHashes !== 'object') {
      state.recentHashes = {};
    }
    
    return state;
  } catch (error) {
    // 状态文件损坏，创建新的
    return { recentHashes: {}, lastCleanup: new Date().toISOString() };
  }
}

async function loadBuffer() {
  try {
    const content = await readFile(BUFFER_FILE, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

async function saveToBuffer(entries) {
  const bufferData = {
    pendingEntries: entries,
    retryCount: 0,
    lastAttempt: new Date().toISOString()
  };
  
  await atomicWriteJson(BUFFER_FILE, bufferData);
}

async function clearBuffer() {
  try {
    await unlink(BUFFER_FILE);
  } catch {
    // 文件不存在也没关系
  }
}

// 检查缓冲区大小和选择处理策略
async function analyzeBuffer() {
  try {
    if (!existsSync(BUFFER_FILE)) {
      return { 
        exists: false, 
        size: 0, 
        entries: 0,
        strategy: 'normal'
      };
    }
    
    const stats = await stat(BUFFER_FILE);
    const buffer = await loadBuffer();
    const entriesCount = buffer?.pendingEntries?.length || 0;
    
    let strategy = 'normal';
    let chunkSize = CHUNK_SIZES.NORMAL;
    
    if (entriesCount > THRESHOLDS.CRITICAL_BUFFER_ENTRIES) {
      strategy = 'critical';
      chunkSize = CHUNK_SIZES.HUGE;
    } else if (entriesCount > THRESHOLDS.HUGE_BUFFER_ENTRIES) {
      strategy = 'huge';
      chunkSize = CHUNK_SIZES.HUGE;
    } else if (entriesCount > THRESHOLDS.LARGE_BUFFER_ENTRIES || 
               stats.size > THRESHOLDS.LARGE_BUFFER_SIZE) {
      strategy = 'large';
      chunkSize = CHUNK_SIZES.LARGE;
    }
    
    return {
      exists: true,
      size: stats.size,
      entries: entriesCount,
      strategy,
      chunkSize,
      estimatedBatches: Math.ceil(entriesCount / chunkSize),
      estimatedTime: Math.ceil(entriesCount / chunkSize) * 2 // 估计每批2秒
    };
  } catch {
    return { 
      exists: false, 
      size: 0, 
      entries: 0,
      strategy: 'normal'
    };
  }
}

// 优化的发送函数
async function sendToServerOptimized(config, entries, timeout = TIMEOUTS.REQUEST) {
  const url = new URL(config.serverUrl);
  const isHttps = url.protocol === 'https:';
  const httpModule = isHttps ? https : http;
  
  const options = {
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: '/api/usage/submit',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    timeout
  };
  
  const payload = JSON.stringify({
    username: config.username,
    usage: entries
  });
  
  return new Promise((resolve) => {
    const req = httpModule.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          resolve({ 
            success: res.statusCode === 200, 
            statusCode: res.statusCode,
            result 
          });
        } catch {
          resolve({ 
            success: false, 
            statusCode: res.statusCode,
            error: 'Invalid response' 
          });
        }
      });
    });
    
    req.on('error', (error) => {
      resolve({ success: false, error: error.message });
    });
    
    req.on('timeout', () => {
      req.destroy();
      resolve({ success: false, error: 'Request timeout' });
    });
    
    req.write(payload);
    req.end();
  });
}

// V3 批量发送 - 优化版本
async function sendBatchOptimized(config, entries, options = {}) {
  const {
    chunkSize = CHUNK_SIZES.NORMAL,
    logger = null,
    maxRetries = MAX_RETRIES,
    showProgress = true
  } = options;
  
  const startTime = Date.now();
  const chunks = [];
  
  // 分批
  for (let i = 0; i < entries.length; i += chunkSize) {
    chunks.push({
      data: entries.slice(i, Math.min(i + chunkSize, entries.length)),
      startIndex: i,
      endIndex: Math.min(i + chunkSize, entries.length)
    });
  }
  
  if (logger && showProgress) {
    await logger.log('info', 'Starting batch processing', {
      totalEntries: entries.length,
      chunkSize,
      totalChunks: chunks.length,
      estimatedTime: `${(chunks.length * 2).toFixed(0)}s`
    });
  }
  
  const results = [];
  const successfulIndices = new Set();
  let totalSent = 0;
  let lastProgressReport = Date.now();
  
  for (let i = 0; i < chunks.length; i++) {
    // 检查总体超时
    if (Date.now() - startTime > TIMEOUTS.TOTAL) {
      if (logger) {
        await logger.log('warn', 'Total timeout reached', {
          processed: i,
          total: chunks.length,
          sent: totalSent
        });
      }
      break;
    }
    
    const chunk = chunks[i];
    
    // 进度报告（每5秒或每10批）
    if (showProgress && logger && 
        (Date.now() - lastProgressReport > 5000 || i % 10 === 0)) {
      await logger.log('info', 'Progress update', {
        current: i + 1,
        total: chunks.length,
        percentage: `${((i / chunks.length) * 100).toFixed(1)}%`,
        sent: totalSent,
        elapsed: `${((Date.now() - startTime) / 1000).toFixed(1)}s`,
        rate: `${(totalSent / ((Date.now() - startTime) / 1000)).toFixed(0)} rec/s`
      });
      lastProgressReport = Date.now();
    }
    
    let retries = 0;
    let success = false;
    
    while (retries < maxRetries && !success) {
      const result = await sendToServerOptimized(config, chunk.data);
      
      if (result.success) {
        success = true;
        totalSent += chunk.data.length;
        
        // 记录成功的索引
        for (let j = chunk.startIndex; j < chunk.endIndex; j++) {
          successfulIndices.add(j);
        }
        
        results.push({
          chunkIndex: i,
          success: true,
          size: chunk.data.length
        });
      } else {
        retries++;
        if (retries < maxRetries) {
          // 指数退避，最多等5秒
          const delay = Math.min(1000 * Math.pow(2, retries - 1), 5000);
          if (logger) {
            await logger.log('debug', 'Retry after failure', {
              chunk: i,
              attempt: retries,
              delay,
              error: result.error
            });
          }
          await new Promise(r => setTimeout(r, delay));
        } else {
          results.push({
            chunkIndex: i,
            success: false,
            size: chunk.data.length,
            error: result.error
          });
        }
      }
    }
    
    // 大批次间添加延迟
    if (chunkSize >= CHUNK_SIZES.LARGE && success) {
      await new Promise(r => setTimeout(r, 200));
    }
  }
  
  // 构建失败的记录
  const failedEntries = entries.filter((_, index) => !successfulIndices.has(index));
  
  const duration = Date.now() - startTime;
  const finalStats = {
    success: failedEntries.length === 0,
    totalEntries: entries.length,
    totalSent,
    failedCount: failedEntries.length,
    failedEntries,
    duration: `${(duration / 1000).toFixed(1)}s`,
    throughput: totalSent > 0 ? `${(totalSent / (duration / 1000)).toFixed(0)} rec/s` : '0 rec/s'
  };
  
  if (logger) {
    await logger.log('info', 'Batch processing completed', finalStats);
  }
  
  return finalStats;
}

// 处理大缓冲区
async function processLargeBuffer(config, logger) {
  const analysis = await analyzeBuffer();
  
  if (!analysis.exists || analysis.entries === 0) {
    return { processed: 0, remaining: 0, success: true };
  }
  
  const buffer = await loadBuffer();
  const entries = buffer.pendingEntries;
  
  await logger.log('info', `Processing buffer with ${analysis.strategy} strategy`, {
    entries: analysis.entries,
    chunkSize: analysis.chunkSize,
    estimatedBatches: analysis.estimatedBatches,
    estimatedTime: `${analysis.estimatedTime}s`
  });
  
  const result = await sendBatchOptimized(config, entries, {
    chunkSize: analysis.chunkSize,
    logger,
    showProgress: true
  });
  
  // 处理结果
  if (result.success) {
    await clearBuffer();
    await logger.log('info', 'Buffer cleared successfully');
  } else if (result.totalSent > 0) {
    // 部分成功，保存失败的记录
    const updatedBuffer = {
      pendingEntries: result.failedEntries,
      retryCount: (buffer.retryCount || 0) + 1,
      lastProcessed: new Date().toISOString(),
      lastSuccess: result.totalSent
    };
    await atomicWriteJson(BUFFER_FILE, updatedBuffer);
    await logger.log('info', 'Updated buffer with failed entries', {
      remaining: result.failedCount
    });
  } else {
    // 全部失败
    buffer.retryCount = (buffer.retryCount || 0) + 1;
    buffer.lastAttempt = new Date().toISOString();
    await atomicWriteJson(BUFFER_FILE, buffer);
    await logger.log('warn', 'All entries failed, buffer retained');
  }
  
  return {
    processed: result.totalSent,
    remaining: result.failedCount,
    success: result.failedCount === 0
  };
}

// ============ 主流程 ============

async function main() {
  const logger = new StatsLogger();
  const lock = new FileLock(LOCK_FILE);
  
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
    
    // 获取锁
    if (!await lock.acquire()) {
      await logger.log('info', 'Another instance is running, skipping');
      process.exit(0);
    }
    
    await logger.log('info', 'Hook v3 started');
    
    // 分析缓冲区
    const analysis = await analyzeBuffer();
    
    if (analysis.strategy !== 'normal') {
      // 处理大缓冲区
      await processLargeBuffer(config, logger);
    } else {
      // 正常流程（这里简化了，实际需要收集新数据）
      await logger.log('info', 'Normal processing mode');
      // TODO: 实现正常的数据收集流程
    }
    
    process.exit(0);
  } catch (error) {
    await logger.log('error', 'Fatal error', { 
      error: error.message,
      stack: error.stack 
    });
    process.exit(0);
  } finally {
    await lock.release();
  }
}

// 如果作为独立脚本运行
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { 
  sendBatchOptimized,
  processLargeBuffer,
  analyzeBuffer
};