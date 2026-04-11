#!/usr/bin/env node

// Hook v4 - 增量扫描 + 预算制发送
// 主要改进（相比 v3）：
// 1. 增量扫描：基于 byte offset 只读新增内容，避免全量扫描
// 2. Set 去重：O(1) 哈希查找，替代 Array.includes O(n)
// 3. 节流机制：30 秒内重复触发直接退出
// 4. 预算制发送：总共最多 10 秒，无重试，超时立即停止
// 5. 快速失败锁：1 秒锁超时（v3 为 5 秒）

import { readFile, writeFile, rename, unlink, open, stat, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { homedir } from 'node:os';
import https from 'node:https';
import http from 'node:http';
import { collectNewUsageDataIncremental } from './shared/data-collector.js';

// 获取用户主目录和 Claude 配置目录
const USER_HOME_DIR = homedir();

// 文件路径
const STATE_FILE = path.join(USER_HOME_DIR, '.claude', 'stats-state.json');
const BUFFER_FILE = path.join(USER_HOME_DIR, '.claude', 'stats-state.buffer.json');
const LOCK_FILE = path.join(USER_HOME_DIR, '.claude', 'stats.lock');
const LOG_FILE = path.join(USER_HOME_DIR, '.claude', 'stats-debug.log');

// V4 配置常量
const THROTTLE_INTERVAL = 30_000;       // 30 秒节流
const SEND_BUDGET_MS = 10_000;          // 发送阶段总预算 10 秒
const BATCH_SIZE = 200;                 // 每批 200 条
const REQUEST_TIMEOUT = 5_000;          // 单请求超时 5 秒
const LOCK_TIMEOUT = 1_000;             // 锁超时 1 秒（快速失败）
const LOCK_STALE_TIME = 10_000;         // 锁过期时间
const RETENTION_DAYS = 30;
const MAX_LOG_SIZE = 10 * 1024 * 1024;  // 10MB

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
        if (existsSync(this.lockFile)) {
          let shouldDelete = false;
          try {
            const lockContent = await readFile(this.lockFile, 'utf-8');
            const lockData = JSON.parse(lockContent);
            const lockAge = Date.now() - new Date(lockData.timestamp).getTime();
            // NaN（时间戳无效）或超时均视为过期
            shouldDelete = !Number.isFinite(lockAge) || lockAge > LOCK_STALE_TIME;
          } catch {
            // 文件已删除（ENOENT）或内容损坏（SyntaxError）→ 视为过期
            shouldDelete = true;
          }

          if (shouldDelete) {
            await unlink(this.lockFile).catch(() => {});
          } else {
            await new Promise(r => setTimeout(r, 50));
            continue;
          }
        }

        const fd = await open(this.lockFile, 'wx');
        try {
          const lockData = JSON.stringify({
            pid: process.pid,
            timestamp: new Date().toISOString()
          });
          await fd.writeFile(lockData);
        } finally {
          await fd.close();
        }

        this.acquired = true;
        return true;
      } catch (error) {
        if (error.code === 'EEXIST' || error.code === 'ENOENT') {
          await new Promise(r => setTimeout(r, 50));
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

// 加载并迁移 state（v3 → v4 自动迁移）
async function loadState() {
  try {
    if (!existsSync(STATE_FILE)) {
      return createDefaultState();
    }

    const content = await readFile(STATE_FILE, 'utf-8');
    const state = JSON.parse(content);

    // v3 → v4 迁移（数值比较主版本号，避免字典序 '10.0.0' < '4.0.0' 误判）
    const major = parseInt(state.version?.split('.')[0] || '0', 10);
    if (!state.version || major < 4) {
      state.version = '4.0.0';
      if (!state.fileOffsets) state.fileOffsets = {};
      if (!state.lastRunTimestamp) state.lastRunTimestamp = 0;
      if (!state.recentHashes) state.recentHashes = {};
      if (!state.lastCleanup) state.lastCleanup = new Date().toISOString();
    }

    return state;
  } catch {
    return createDefaultState();
  }
}

function createDefaultState() {
  return {
    version: '4.0.0',
    lastCleanup: new Date().toISOString(),
    lastRunTimestamp: 0,
    recentHashes: {},
    fileOffsets: {}
  };
}

// ============ Buffer 管理 ============

async function loadBuffer() {
  try {
    const content = await readFile(BUFFER_FILE, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

async function clearBuffer() {
  try { await unlink(BUFFER_FILE); } catch { /* noop */ }
}

// ============ 网络发送 ============

function sendRequest(config, entries, timeout = REQUEST_TIMEOUT) {
  const url = new URL(config.serverUrl);
  const isHttps = url.protocol === 'https:';
  const httpModule = isHttps ? https : http;

  const basePath = url.pathname.replace(/\/+$/, '');
  const options = {
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: `${basePath}/api/usage/submit`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'claude-stats-hook/4.0'
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
        resolve({ success: res.statusCode === 200, statusCode: res.statusCode });
      });
    });

    req.on('error', (error) => {
      resolve({ success: false, error: error.message });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ success: false, error: 'timeout' });
    });

    req.write(payload);
    req.end();
  });
}

// 预算制发送：硬性 10 秒上限，每批 200 条，不重试
async function sendWithBudget(config, entries, logger) {
  const startTime = Date.now();
  let totalSent = 0;
  let batchIndex = 0;

  while (batchIndex * BATCH_SIZE < entries.length) {
    // 检查预算
    if (Date.now() - startTime >= SEND_BUDGET_MS) {
      if (logger) {
        await logger.log('info', 'Send budget exhausted', {
          sent: totalSent,
          remaining: entries.length - totalSent,
          elapsed: `${((Date.now() - startTime) / 1000).toFixed(1)}s`
        });
      }
      break;
    }

    const start = batchIndex * BATCH_SIZE;
    const batch = entries.slice(start, start + BATCH_SIZE);

    const result = await sendRequest(config, batch);

    if (result.success) {
      totalSent += batch.length;
    } else {
      // 不重试，直接跳出
      if (logger) {
        await logger.log('warn', 'Batch failed, stopping send', {
          batch: batchIndex,
          error: result.error || `HTTP ${result.statusCode}`
        });
      }
      break;
    }

    batchIndex++;
  }

  // 未发完的部分
  const unsent = entries.slice(totalSent);

  if (logger) {
    await logger.log('info', 'Send phase completed', {
      totalSent,
      unsent: unsent.length,
      duration: `${((Date.now() - startTime) / 1000).toFixed(1)}s`
    });
  }

  return { totalSent, unsent };
}

// ============ 状态管理 ============

function updateStateHashes(state, entries) {
  for (const entry of entries) {
    const dayKey = entry.timestamp.split('T')[0];
    if (!state.recentHashes[dayKey]) {
      state.recentHashes[dayKey] = [];
    }
    state.recentHashes[dayKey].push(entry.interaction_hash);
  }

  // 清理过期哈希
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
  const cutoffKey = cutoff.toISOString().split('T')[0];

  for (const dayKey in state.recentHashes) {
    if (dayKey < cutoffKey) {
      delete state.recentHashes[dayKey];
    }
  }

  state.lastCleanup = new Date().toISOString();
}

// ============ 主流程 ============

async function main() {
  const logger = new StatsLogger();
  const lock = new FileLock(LOCK_FILE);

  try {
    // 读取配置
    const configPath = path.join(USER_HOME_DIR, '.claude', 'stats-config.json');
    if (!existsSync(configPath)) {
      return;
    }

    const configContent = await readFile(configPath, 'utf-8');
    const config = JSON.parse(configContent);

    if (!config.enabled || !config.serverUrl) {
      return;
    }

    // 加载 state（自动迁移 v3 → v4）
    const state = await loadState();

    // 节流检查：30 秒内重复触发直接退出
    const now = Date.now();
    if (now - state.lastRunTimestamp < THROTTLE_INTERVAL) {
      await logger.log('info', 'Throttled, skipping', {
        lastRun: new Date(state.lastRunTimestamp).toISOString(),
        elapsed: `${((now - state.lastRunTimestamp) / 1000).toFixed(0)}s`
      });
      return;
    }

    // 获取锁（1 秒快速失败）
    if (!await lock.acquire()) {
      await logger.log('info', 'Lock not acquired, skipping');
      return;
    }

    await logger.log('info', 'Hook v4 started');

    // Phase 1: 增量收集
    const collectStart = Date.now();
    const newEntries = await collectNewUsageDataIncremental(state, logger);

    // 更新 state 中的哈希
    if (newEntries.length > 0) {
      updateStateHashes(state, newEntries);
    }

    await logger.log('info', 'Phase 1 (collect) done', {
      entries: newEntries.length,
      duration: `${((Date.now() - collectStart) / 1000).toFixed(1)}s`
    });

    // 合并 buffer 中的待发送数据
    const buffer = await loadBuffer();
    const bufferedEntries = buffer?.pendingEntries || [];
    const allEntries = [...bufferedEntries, ...newEntries];

    if (allEntries.length === 0) {
      state.lastRunTimestamp = now;
      await atomicWriteJson(STATE_FILE, state);
      await logger.log('info', 'No data to send, done');
      return;
    }

    // 先持久化 state（含 fileOffsets 和 recentHashes），避免崩溃后重复收集
    state.lastRunTimestamp = now;
    await atomicWriteJson(STATE_FILE, state);

    // Phase 2: 预算制发送
    const { totalSent, unsent } = await sendWithBudget(config, allEntries, logger);

    // 发送完成后再清理 buffer，未发完的覆盖写入
    if (unsent.length > 0) {
      await atomicWriteJson(BUFFER_FILE, {
        pendingEntries: unsent,
        lastAttempt: new Date().toISOString()
      });
    } else {
      await clearBuffer();
    }

    await logger.log('info', 'Hook v4 completed', {
      collected: newEntries.length,
      sent: totalSent,
      buffered: unsent.length
    });
  } catch (error) {
    await logger.log('error', 'Fatal error', {
      error: error.message,
      stack: error.stack
    });
  } finally {
    await lock.release();
  }
}

// 如果作为独立脚本运行
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(() => {}).finally(() => process.exit(0));
}

export { sendWithBudget };
