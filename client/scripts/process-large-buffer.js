#!/usr/bin/env node

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { homedir } from 'os';
import https from 'https';

const CLAUDE_DIR = path.join(homedir(), '.claude');
const BUFFER_FILE = path.join(CLAUDE_DIR, 'stats-state.buffer.json');
const CONFIG_FILE = path.join(CLAUDE_DIR, 'stats-config.json');

const BATCH_SIZE = 50; // 每批处理50条记录
const DELAY_BETWEEN_BATCHES = 1000; // 批次间延迟1秒

async function sendBatch(config, batch) {
  return new Promise((resolve) => {
    const url = new URL(config.serverUrl + '/api/usage/submit');
    const postData = JSON.stringify({
      username: config.username,
      usage: batch
    });

    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 10000
    };

    const req = https.request(options, (res) => {
      let responseData = '';
      res.on('data', chunk => responseData += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const result = JSON.parse(responseData);
            resolve({ success: true, inserted: result.inserted || batch.length });
          } catch {
            resolve({ success: true, inserted: batch.length });
          }
        } else {
          console.error(`批次发送失败: HTTP ${res.statusCode} - ${responseData}`);
          resolve({ success: false, error: `HTTP ${res.statusCode}` });
        }
      });
    });

    req.on('error', (e) => {
      console.error('网络错误:', e.message);
      resolve({ success: false, error: e.message });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ success: false, error: 'Timeout' });
    });

    req.write(postData);
    req.end();
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function processLargeBuffer() {
  try {
    // 检查文件是否存在
    if (!existsSync(BUFFER_FILE)) {
      console.log('✓ 没有待处理的缓冲数据');
      return;
    }

    if (!existsSync(CONFIG_FILE)) {
      console.error('❌ 配置文件不存在');
      return;
    }

    // 读取配置和缓冲数据
    console.log('📖 读取配置和缓冲数据...');
    const config = JSON.parse(await readFile(CONFIG_FILE, 'utf-8'));
    const bufferData = JSON.parse(await readFile(BUFFER_FILE, 'utf-8'));

    const entries = bufferData.pendingEntries || [];
    if (entries.length === 0) {
      console.log('✓ 缓冲文件为空');
      return;
    }

    console.log(`📊 发现 ${entries.length} 条待处理记录`);
    console.log(`📦 将分 ${Math.ceil(entries.length / BATCH_SIZE)} 批处理`);

    let processedCount = 0;
    let successCount = 0;
    let batchNumber = 0;

    // 分批处理
    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      batchNumber++;
      const batch = entries.slice(i, i + BATCH_SIZE);
      
      console.log(`🔄 处理第 ${batchNumber}/${Math.ceil(entries.length / BATCH_SIZE)} 批 (${batch.length} 条记录)...`);
      
      const result = await sendBatch(config, batch);
      
      if (result.success) {
        successCount += result.inserted || batch.length;
        console.log(`✅ 批次 ${batchNumber} 成功发送 ${result.inserted || batch.length} 条记录`);
      } else {
        console.log(`❌ 批次 ${batchNumber} 发送失败: ${result.error}`);
      }

      processedCount += batch.length;
      
      // 进度显示
      const progress = ((processedCount / entries.length) * 100).toFixed(1);
      console.log(`📈 进度: ${progress}% (${processedCount}/${entries.length})`);

      // 批次间延迟，避免服务器压力
      if (i + BATCH_SIZE < entries.length) {
        await delay(DELAY_BETWEEN_BATCHES);
      }
    }

    console.log('\\n📊 处理完成统计:');
    console.log(`  总记录数: ${entries.length}`);
    console.log(`  成功发送: ${successCount}`);
    console.log(`  失败数量: ${entries.length - successCount}`);

    // 如果全部成功，清理缓冲文件
    if (successCount === entries.length) {
      await writeFile(BUFFER_FILE, JSON.stringify({ 
        pendingEntries: [], 
        lastProcessed: new Date().toISOString(),
        retryCount: 0 
      }, null, 2));
      console.log('✅ 所有数据发送成功，缓冲文件已清理');
    } else {
      // 保留失败的记录
      const remainingEntries = entries.slice(successCount);
      await writeFile(BUFFER_FILE, JSON.stringify({
        pendingEntries: remainingEntries,
        lastProcessed: new Date().toISOString(),
        retryCount: (bufferData.retryCount || 0) + 1
      }, null, 2));
      console.log(`⚠️  保留了 ${remainingEntries.length} 条失败记录，可稍后重试`);
    }

  } catch (error) {
    console.error('❌ 处理过程中发生错误:', error.message);
    process.exit(1);
  }
}

// 如果直接运行此脚本
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('🚀 开始处理大量缓冲数据...');
  processLargeBuffer()
    .then(() => {
      console.log('✅ 处理完成');
      process.exit(0);
    })
    .catch((error) => {
      console.error('❌ 处理失败:', error);
      process.exit(1);
    });
}