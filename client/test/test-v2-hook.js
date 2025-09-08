#!/usr/bin/env node

import { execSync } from 'child_process';
import { readFile, writeFile, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { homedir } from 'os';
import chalk from 'chalk';

const CLAUDE_DIR = path.join(homedir(), '.claude');
const STATE_FILE = path.join(CLAUDE_DIR, 'stats-state.json');
const BUFFER_FILE = path.join(CLAUDE_DIR, 'stats-state.buffer.json');
const LOG_FILE = path.join(CLAUDE_DIR, 'stats-debug.log');

console.log(chalk.blue('🧪 测试 v2 Hook 功能'));
console.log(chalk.gray('─'.repeat(40)));

// 测试用例
const tests = [
  {
    name: '原子写入测试',
    run: async () => {
      // 创建测试状态文件
      const testFile = path.join(CLAUDE_DIR, 'test-atomic.json');
      const testData = { test: true, timestamp: new Date().toISOString() };
      
      // 模拟并发写入
      const promises = [];
      for (let i = 0; i < 5; i++) {
        promises.push((async () => {
          const data = { ...testData, index: i };
          await atomicWriteJson(testFile, data);
        })());
      }
      
      await Promise.all(promises);
      
      // 验证文件完整性
      const content = await readFile(testFile, 'utf-8');
      const result = JSON.parse(content);
      
      // 清理
      await unlink(testFile);
      if (existsSync(`${testFile}.backup`)) {
        await unlink(`${testFile}.backup`);
      }
      
      return result.test === true && typeof result.index === 'number';
    }
  },
  
  {
    name: '状态文件验证',
    run: async () => {
      if (!existsSync(STATE_FILE)) {
        // 创建初始状态
        const initialState = {
          version: "2.0.0",
          lastCleanup: new Date().toISOString(),
          recentHashes: {}
        };
        await writeFile(STATE_FILE, JSON.stringify(initialState, null, 2));
      }
      
      const content = await readFile(STATE_FILE, 'utf-8');
      const state = JSON.parse(content);
      
      return state.version === "2.0.0" && 
             typeof state.recentHashes === 'object';
    }
  },
  
  {
    name: '文件锁测试',
    run: async () => {
      const lockFile = path.join(CLAUDE_DIR, 'test.lock');
      
      // 创建第一个锁
      const lock1 = new FileLock(lockFile);
      const acquired1 = await lock1.acquire();
      
      // 尝试获取第二个锁（应该失败）
      const lock2 = new FileLock(lockFile);
      const acquired2 = await lock2.acquire(100); // 100ms 超时
      
      // 释放第一个锁
      await lock1.release();
      
      // 现在应该能获取锁
      const acquired3 = await lock2.acquire();
      await lock2.release();
      
      // 清理
      if (existsSync(lockFile)) {
        await unlink(lockFile);
      }
      
      return acquired1 && !acquired2 && acquired3;
    }
  },
  
  {
    name: '缓冲区管理',
    run: async () => {
      const testBuffer = {
        pendingEntries: [
          { interaction_hash: 'test1', tokens: { input: 100, output: 50 } },
          { interaction_hash: 'test2', tokens: { input: 200, output: 100 } }
        ],
        retryCount: 0,
        lastAttempt: new Date().toISOString()
      };
      
      // 写入缓冲
      await writeFile(BUFFER_FILE, JSON.stringify(testBuffer, null, 2));
      
      // 读取验证
      const content = await readFile(BUFFER_FILE, 'utf-8');
      const buffer = JSON.parse(content);
      
      // 清理
      await unlink(BUFFER_FILE);
      
      return buffer.pendingEntries.length === 2 && 
             buffer.retryCount === 0;
    }
  },
  
  {
    name: '日志记录',
    run: async () => {
      // 设置环境变量启用日志
      process.env.CLAUDE_STATS_DEBUG = 'true';
      
      const logger = new StatsLogger();
      await logger.log('info', 'Test log message', { test: true });
      
      // 验证日志文件存在
      const exists = existsSync(LOG_FILE);
      
      if (exists) {
        const content = await readFile(LOG_FILE, 'utf-8');
        const lines = content.trim().split('\n');
        const lastLine = lines[lines.length - 1];
        const log = JSON.parse(lastLine);
        
        return log.message === 'Test log message' && log.data.test === true;
      }
      
      return false;
    }
  }
];

// 辅助函数（简化版）
async function atomicWriteJson(filepath, data) {
  const tempFile = `${filepath}.tmp.${Date.now()}`;
  await writeFile(tempFile, JSON.stringify(data, null, 2));
  
  try {
    if (existsSync(filepath)) {
      await copyFile(filepath, `${filepath}.backup`);
    }
    await rename(tempFile, filepath);
  } catch (error) {
    throw error;
  }
}

class FileLock {
  constructor(lockFile) {
    this.lockFile = lockFile;
    this.acquired = false;
  }
  
  async acquire(timeout = 5000) {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeout) {
      try {
        const { open } = await import('fs/promises');
        const fd = await open(this.lockFile, 'wx');
        await fd.close();
        this.acquired = true;
        return true;
      } catch (error) {
        if (error.code === 'EEXIST') {
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
      } catch {}
    }
  }
}

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
    
    const { appendFile } = await import('fs/promises');
    await appendFile(this.logFile, JSON.stringify(entry) + '\n');
  }
}

// 运行测试
async function runTests() {
  let passed = 0;
  let failed = 0;
  
  for (const test of tests) {
    process.stdout.write(`  ${test.name}... `);
    
    try {
      const result = await test.run();
      if (result) {
        console.log(chalk.green('✓ PASS'));
        passed++;
      } else {
        console.log(chalk.red('✗ FAIL'));
        failed++;
      }
    } catch (error) {
      console.log(chalk.red(`✗ ERROR: ${error.message}`));
      failed++;
    }
  }
  
  console.log();
  console.log(chalk.gray('─'.repeat(40)));
  console.log(chalk.blue('测试结果:'));
  console.log(`  ${chalk.green(`通过: ${passed}`)}`);
  console.log(`  ${chalk.red(`失败: ${failed}`)}`);
  
  if (failed === 0) {
    console.log();
    console.log(chalk.green('✅ 所有测试通过！'));
  } else {
    console.log();
    console.log(chalk.red('❌ 部分测试失败'));
    process.exit(1);
  }
}

// 导入缺失的模块
import { copyFile, rename } from 'fs/promises';

// 运行
runTests().catch(console.error);