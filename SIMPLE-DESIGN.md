# 简化版 Claude Stats 设计方案

## 概述

简化架构，移除认证系统，使用 SQLite 数据库，部署到 Render 的单团队统计方案。

## 系统架构

```
┌───────────────────────────────────────────────────┐
│                用户环境 (多个)                      │
│  ┌─────────────┐      ┌──────────────────┐       │
│  │ Claude Code │─────▶│ Stop Hook        │       │
│  └─────────────┘      │(count_tokens.js) │       │
│                       └────────┬──────────┘       │
│                                │                   │
│  ┌──────────────────────────────▼────────────┐    │
│  │          CLI Client (claude-stats)        │    │
│  │  • 数据收集  • 用户标识  • 直接上传        │    │
│  └──────────────────────────────┬────────────┘    │
└─────────────────────────────────┼─────────────────┘
                                  │ HTTPS (无认证)
                    ┌─────────────▼──────────────┐
                    │    Render Server           │
                    │  (Node.js + Express)       │
                    ├────────────────────────────┤
                    │  • 接收数据 (无验证)        │
                    │  • 数据存储                │
                    │  • 统计分析                │
                    │  • Web Dashboard           │
                    └─────────────┬──────────────┘
                                  │
                    ┌─────────────▼──────────────┐
                    │    SQLite Database         │
                    │  /data/stats.db (Disk)     │
                    └────────────────────────────┘
```

## 1. 数据库设计 (SQLite)

### 1.1 简化的数据表结构

```sql
-- 使用记录表（核心表）
CREATE TABLE usage_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,                    -- 用户名（直接识别）
  timestamp DATETIME NOT NULL,               -- 使用时间
  input_tokens INTEGER NOT NULL,             -- 输入 token
  output_tokens INTEGER NOT NULL,            -- 输出 token
  cache_creation_tokens INTEGER DEFAULT 0,   -- 缓存创建 token
  cache_read_tokens INTEGER DEFAULT 0,       -- 缓存读取 token
  total_tokens INTEGER GENERATED ALWAYS AS   -- 总 token（计算列）
    (input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens) STORED,
  model TEXT,                                -- 模型名称
  session_id TEXT,                           -- 会话ID
  interaction_hash TEXT,                     -- 交互哈希（去重）
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 日统计汇总表（优化查询性能）
CREATE TABLE daily_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  date DATE NOT NULL,
  total_input_tokens INTEGER DEFAULT 0,
  total_output_tokens INTEGER DEFAULT 0,
  total_cache_tokens INTEGER DEFAULT 0,
  session_count INTEGER DEFAULT 0,
  interaction_count INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(username, date)
);

-- 用户列表（自动维护）
CREATE TABLE users (
  username TEXT PRIMARY KEY,
  first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
  total_usage INTEGER DEFAULT 0,
  session_count INTEGER DEFAULT 0
);

-- 创建索引优化查询
CREATE INDEX idx_usage_username_time ON usage_records(username, timestamp DESC);
CREATE INDEX idx_usage_interaction ON usage_records(interaction_hash);
CREATE INDEX idx_usage_timestamp ON usage_records(timestamp DESC);
CREATE INDEX idx_daily_stats_date ON daily_stats(date DESC);
CREATE INDEX idx_daily_stats_username ON daily_stats(username);

-- 创建触发器自动更新用户表
CREATE TRIGGER update_user_stats 
AFTER INSERT ON usage_records
BEGIN
  INSERT INTO users (username, total_usage, session_count)
  VALUES (NEW.username, NEW.total_tokens, 1)
  ON CONFLICT(username) DO UPDATE SET
    last_seen = CURRENT_TIMESTAMP,
    total_usage = total_usage + NEW.total_tokens,
    session_count = session_count + 
      CASE WHEN NEW.session_id NOT IN (
        SELECT DISTINCT session_id FROM usage_records 
        WHERE username = NEW.username AND id < NEW.id
      ) THEN 1 ELSE 0 END;
END;

-- 创建视图方便查询
CREATE VIEW user_rankings AS
SELECT 
  username,
  total_usage,
  session_count,
  RANK() OVER (ORDER BY total_usage DESC) as rank,
  first_seen,
  last_seen
FROM users
ORDER BY total_usage DESC;

CREATE VIEW recent_activity AS
SELECT 
  username,
  COUNT(*) as activity_count,
  SUM(total_tokens) as total_tokens,
  MAX(timestamp) as last_activity
FROM usage_records
WHERE timestamp > datetime('now', '-7 days')
GROUP BY username
ORDER BY total_tokens DESC;
```

## 2. 服务端实现 (Node.js for Render)

### 2.1 项目结构

```
server/
├── package.json
├── index.js              # 入口文件
├── db/
│   ├── init.js          # 数据库初始化
│   └── queries.js       # 数据库查询
├── routes/
│   ├── usage.js         # 使用数据接收
│   ├── stats.js         # 统计查询
│   └── dashboard.js     # Dashboard 路由
├── utils/
│   ├── aggregation.js   # 数据聚合
│   └── database.js      # SQLite 连接
└── public/
    ├── index.html       # Dashboard 页面
    ├── style.css        # 样式
    └── app.js           # 前端逻辑
```

### 2.2 服务端核心代码

```javascript
// server/index.js
import express from 'express';
import cors from 'cors';
import path from 'path';
import { Database } from './utils/database.js';
import usageRoutes from './routes/usage.js';
import statsRoutes from './routes/stats.js';

const app = express();
const db = new Database();

// 初始化数据库
await db.init();

// 中间件
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// API 路由（无需认证）
app.use('/api/usage', usageRoutes);
app.use('/api/stats', statsRoutes);

// 健康检查
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    database: db.isReady() ? 'connected' : 'disconnected'
  });
});

// 错误处理
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
```

### 2.3 数据库管理

```javascript
// server/utils/database.js
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';
import fs from 'fs/promises';

export class Database {
  constructor() {
    // Render Disk 挂载路径
    this.dbPath = process.env.DB_PATH || '/data/stats.db';
    this.db = null;
  }

  async init() {
    // 确保数据目录存在
    const dir = path.dirname(this.dbPath);
    await fs.mkdir(dir, { recursive: true });

    // 打开数据库
    this.db = await open({
      filename: this.dbPath,
      driver: sqlite3.Database
    });

    // 启用 WAL 模式提升并发性能
    await this.db.exec('PRAGMA journal_mode = WAL');
    await this.db.exec('PRAGMA synchronous = NORMAL');

    // 初始化表结构
    await this.initTables();
    
    console.log('Database initialized at:', this.dbPath);
  }

  async initTables() {
    // 创建表的 SQL（从上面的设计）
    const initSQL = `
      -- 使用记录表
      CREATE TABLE IF NOT EXISTS usage_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        timestamp DATETIME NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_creation_tokens INTEGER DEFAULT 0,
        cache_read_tokens INTEGER DEFAULT 0,
        total_tokens INTEGER GENERATED ALWAYS AS 
          (input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens) STORED,
        model TEXT,
        session_id TEXT,
        interaction_hash TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      -- 其他表和索引...
    `;

    await this.db.exec(initSQL);
  }

  // 插入使用记录
  async insertUsageRecord(record) {
    const sql = `
      INSERT INTO usage_records (
        username, timestamp, input_tokens, output_tokens,
        cache_creation_tokens, cache_read_tokens,
        model, session_id, interaction_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    return await this.db.run(sql, [
      record.username,
      record.timestamp,
      record.input_tokens,
      record.output_tokens,
      record.cache_creation_tokens || 0,
      record.cache_read_tokens || 0,
      record.model,
      record.session_id,
      record.interaction_hash
    ]);
  }

  // 批量插入（优化性能）
  async insertBatch(records) {
    const stmt = await this.db.prepare(`
      INSERT OR IGNORE INTO usage_records (
        username, timestamp, input_tokens, output_tokens,
        cache_creation_tokens, cache_read_tokens,
        model, session_id, interaction_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const record of records) {
      await stmt.run(
        record.username,
        record.timestamp,
        record.input_tokens,
        record.output_tokens,
        record.cache_creation_tokens || 0,
        record.cache_read_tokens || 0,
        record.model,
        record.session_id,
        record.interaction_hash
      );
    }

    await stmt.finalize();
  }

  // 获取统计数据
  async getStats(period = '7d') {
    const periodMap = {
      '1d': '1 day',
      '7d': '7 days',
      '30d': '30 days',
      'all': '100 years'
    };

    const sql = `
      SELECT 
        COUNT(DISTINCT username) as user_count,
        COUNT(*) as record_count,
        SUM(total_tokens) as total_tokens,
        SUM(input_tokens) as total_input,
        SUM(output_tokens) as total_output,
        COUNT(DISTINCT session_id) as session_count
      FROM usage_records
      WHERE timestamp > datetime('now', '-${periodMap[period] || '7 days'}')
    `;

    return await this.db.get(sql);
  }

  // 获取用户排行
  async getUserRankings(limit = 20) {
    const sql = `
      SELECT * FROM user_rankings
      LIMIT ?
    `;

    return await this.db.all(sql, [limit]);
  }

  // 获取最近记录
  async getRecentRecords(limit = 100) {
    const sql = `
      SELECT * FROM usage_records
      ORDER BY timestamp DESC
      LIMIT ?
    `;

    return await this.db.all(sql, [limit]);
  }

  // 获取用户统计
  async getUserStats(username) {
    const sql = `
      SELECT 
        username,
        COUNT(*) as record_count,
        SUM(total_tokens) as total_tokens,
        COUNT(DISTINCT session_id) as session_count,
        MIN(timestamp) as first_use,
        MAX(timestamp) as last_use
      FROM usage_records
      WHERE username = ?
      GROUP BY username
    `;

    return await this.db.get(sql, [username]);
  }

  isReady() {
    return this.db !== null;
  }
}
```

### 2.4 API 路由

```javascript
// server/routes/usage.js
import { Router } from 'express';
import { Database } from '../utils/database.js';

const router = Router();
const db = new Database();

// 提交使用数据（无需认证）
router.post('/submit', async (req, res) => {
  try {
    const { username, usage } = req.body;

    // 基础验证
    if (!username || !usage) {
      return res.status(400).json({ error: 'Missing username or usage data' });
    }

    // 处理单条或批量数据
    const records = Array.isArray(usage) ? usage : [usage];
    
    // 转换数据格式
    const dbRecords = records.map(record => ({
      username,
      timestamp: record.timestamp,
      input_tokens: record.tokens?.input || 0,
      output_tokens: record.tokens?.output || 0,
      cache_creation_tokens: record.tokens?.cache_creation || 0,
      cache_read_tokens: record.tokens?.cache_read || 0,
      model: record.model,
      session_id: record.session_id,
      interaction_hash: record.interaction_hash
    }));

    // 批量插入
    await db.insertBatch(dbRecords);

    res.json({ 
      success: true, 
      message: 'Data submitted successfully',
      count: dbRecords.length 
    });
  } catch (error) {
    console.error('Usage submission error:', error);
    res.status(500).json({ error: 'Failed to submit usage data' });
  }
});

export default router;
```

```javascript
// server/routes/stats.js
import { Router } from 'express';
import { Database } from '../utils/database.js';

const router = Router();
const db = new Database();

// 获取总体统计
router.get('/overview', async (req, res) => {
  try {
    const { period = '7d' } = req.query;
    const stats = await db.getStats(period);
    const rankings = await db.getUserRankings(10);
    const recent = await db.getRecentRecords(20);

    res.json({
      period,
      stats,
      rankings,
      recent
    });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

// 获取用户排行榜
router.get('/rankings', async (req, res) => {
  try {
    const { limit = 50 } = req.query;
    const rankings = await db.getUserRankings(parseInt(limit));
    res.json(rankings);
  } catch (error) {
    console.error('Rankings error:', error);
    res.status(500).json({ error: 'Failed to get rankings' });
  }
});

// 获取特定用户统计
router.get('/user/:username', async (req, res) => {
  try {
    const { username } = req.params;
    const stats = await db.getUserStats(username);
    
    if (!stats) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(stats);
  } catch (error) {
    console.error('User stats error:', error);
    res.status(500).json({ error: 'Failed to get user stats' });
  }
});

// 获取趋势数据
router.get('/trends', async (req, res) => {
  try {
    const sql = `
      SELECT 
        DATE(timestamp) as date,
        COUNT(DISTINCT username) as users,
        SUM(total_tokens) as tokens
      FROM usage_records
      WHERE timestamp > datetime('now', '-30 days')
      GROUP BY DATE(timestamp)
      ORDER BY date DESC
    `;

    const trends = await db.db.all(sql);
    res.json(trends);
  } catch (error) {
    console.error('Trends error:', error);
    res.status(500).json({ error: 'Failed to get trends' });
  }
});

export default router;
```

## 3. CLI 客户端设计

### 3.1 简化的配置

```javascript
// CLI 配置 ~/.claude/stats-config.json
{
  "username": "john_doe",           // 用户自选的用户名
  "serverUrl": "https://your-app.onrender.com",
  "enabled": true                   // 是否启用上传
}
```

### 3.2 Hook 脚本

```javascript
// hooks/count_tokens.js
#!/usr/bin/env node

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { homedir } from 'os';
import https from 'https';

const CONFIG_PATH = path.join(homedir(), '.claude', 'stats-config.json');

async function main() {
  try {
    // 加载配置
    if (!existsSync(CONFIG_PATH)) {
      // 未配置，静默退出
      process.exit(0);
    }

    const config = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
    
    if (!config.enabled) {
      process.exit(0);
    }

    // 收集使用数据
    const usage = await collectUsageData();
    if (!usage) {
      process.exit(0);
    }

    // 直接发送到服务器（无需认证）
    await sendToServer(config, usage);

    process.exit(0);
  } catch (error) {
    // 静默失败
    process.exit(0);
  }
}

async function sendToServer(config, usage) {
  const data = JSON.stringify({
    username: config.username,
    usage: usage
  });

  return new Promise((resolve, reject) => {
    const url = new URL(config.serverUrl + '/api/usage/submit');
    
    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      },
      timeout: 5000
    };

    const req = https.request(options, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve());
    });

    req.on('error', () => resolve());
    req.on('timeout', () => {
      req.destroy();
      resolve();
    });

    req.write(data);
    req.end();
  });
}

// 收集使用数据的函数（保持原有逻辑）
async function collectUsageData() {
  // ... 原有的数据收集逻辑
}

main();
```

### 3.3 CLI 命令

```javascript
// bin/cli.js
#!/usr/bin/env node

import { Command } from 'commander';
import inquirer from 'inquirer';
import { readFile, writeFile } from 'fs/promises';
import chalk from 'chalk';
import open from 'open';

const program = new Command();

program
  .name('claude-stats')
  .description('Simple Claude Code usage statistics')
  .version('1.0.0');

// 初始化
program
  .command('init')
  .description('Initialize configuration')
  .action(async () => {
    console.log(chalk.blue('Claude Stats 配置'));
    
    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'username',
        message: '请输入您的用户名:',
        validate: input => input.length > 0
      },
      {
        type: 'input',
        name: 'serverUrl',
        message: '服务器地址:',
        default: 'https://your-app.onrender.com'
      }
    ]);

    const config = {
      username: answers.username,
      serverUrl: answers.serverUrl.replace(/\/$/, ''), // 移除尾部斜杠
      enabled: true
    };

    // 保存配置
    const configPath = path.join(homedir(), '.claude', 'stats-config.json');
    await writeFile(configPath, JSON.stringify(config, null, 2));

    console.log(chalk.green('✅ 配置已保存'));
    console.log(chalk.gray(`用户名: ${config.username}`));
    console.log(chalk.gray(`服务器: ${config.serverUrl}`));
  });

// 查看统计
program
  .command('stats')
  .description('View your statistics')
  .action(async () => {
    const config = await loadConfig();
    if (!config) {
      console.log(chalk.red('请先运行 claude-stats init 进行配置'));
      return;
    }

    try {
      const response = await fetch(
        `${config.serverUrl}/api/stats/user/${config.username}`
      );
      
      if (!response.ok) {
        throw new Error('Failed to fetch stats');
      }

      const stats = await response.json();
      
      console.log(chalk.blue(`📊 ${config.username} 的使用统计`));
      console.log(chalk.gray('─'.repeat(40)));
      console.log(`总 token 数: ${chalk.yellow(stats.total_tokens.toLocaleString())}`);
      console.log(`会话次数: ${chalk.yellow(stats.session_count)}`);
      console.log(`首次使用: ${chalk.yellow(stats.first_use)}`);
      console.log(`最近使用: ${chalk.yellow(stats.last_use)}`);
    } catch (error) {
      console.error(chalk.red('获取统计失败:'), error.message);
    }
  });

// 打开 Dashboard
program
  .command('dashboard')
  .description('Open web dashboard')
  .action(async () => {
    const config = await loadConfig();
    if (!config) {
      console.log(chalk.red('请先运行 claude-stats init 进行配置'));
      return;
    }

    const url = config.serverUrl;
    console.log(chalk.blue(`正在打开 Dashboard: ${url}`));
    await open(url);
  });

// 启用/禁用
program
  .command('toggle')
  .description('Enable or disable tracking')
  .action(async () => {
    const config = await loadConfig();
    if (!config) {
      console.log(chalk.red('请先运行 claude-stats init 进行配置'));
      return;
    }

    config.enabled = !config.enabled;
    await saveConfig(config);
    
    console.log(config.enabled 
      ? chalk.green('✅ 跟踪已启用')
      : chalk.yellow('⏸ 跟踪已禁用')
    );
  });

program.parse();
```

## 4. Dashboard 界面

### 4.1 简洁的 Dashboard

```html
<!-- server/public/index.html -->
<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Claude Stats Dashboard</title>
  <link rel="stylesheet" href="style.css">
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
</head>
<body>
  <div class="container">
    <header>
      <h1>Claude Code 使用统计</h1>
      <div class="controls">
        <select id="period">
          <option value="1d">今天</option>
          <option value="7d" selected>最近7天</option>
          <option value="30d">最近30天</option>
          <option value="all">全部</option>
        </select>
        <button id="refresh">刷新</button>
      </div>
    </header>

    <!-- 统计卡片 -->
    <div class="stats-grid">
      <div class="stat-card">
        <h3>总 token 数</h3>
        <p id="total-tokens">-</p>
      </div>
      <div class="stat-card">
        <h3>活跃用户</h3>
        <p id="user-count">-</p>
      </div>
      <div class="stat-card">
        <h3>会话数</h3>
        <p id="session-count">-</p>
      </div>
      <div class="stat-card">
        <h3>交互次数</h3>
        <p id="record-count">-</p>
      </div>
    </div>

    <!-- 排行榜 -->
    <div class="rankings">
      <h2>用户排行榜</h2>
      <table id="rankings-table">
        <thead>
          <tr>
            <th>排名</th>
            <th>用户名</th>
            <th>总 token 数</th>
            <th>会话数</th>
            <th>最后活动</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>

    <!-- 趋势图 -->
    <div class="chart-container">
      <h2>使用趋势</h2>
      <canvas id="trend-chart"></canvas>
    </div>

    <!-- 最近活动 -->
    <div class="recent-activity">
      <h2>最近活动</h2>
      <table id="activity-table">
        <thead>
          <tr>
            <th>时间</th>
            <th>用户</th>
            <th>模型</th>
            <th>输入</th>
            <th>输出</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>
  </div>

  <script src="app.js"></script>
</body>
</html>
```

### 4.2 前端 JavaScript

```javascript
// server/public/app.js
class Dashboard {
  constructor() {
    this.chart = null;
    this.init();
  }

  async init() {
    await this.loadData();
    this.setupEventListeners();
    this.startAutoRefresh();
  }

  async loadData() {
    const period = document.getElementById('period').value;
    
    try {
      const response = await fetch(`/api/stats/overview?period=${period}`);
      const data = await response.json();
      
      this.updateStats(data.stats);
      this.updateRankings(data.rankings);
      this.updateRecentActivity(data.recent);
      await this.updateTrendChart();
    } catch (error) {
      console.error('Failed to load data:', error);
    }
  }

  updateStats(stats) {
    document.getElementById('total-tokens').textContent = 
      this.formatNumber(stats.total_tokens || 0);
    document.getElementById('user-count').textContent = 
      stats.user_count || 0;
    document.getElementById('session-count').textContent = 
      stats.session_count || 0;
    document.getElementById('record-count').textContent = 
      stats.record_count || 0;
  }

  updateRankings(rankings) {
    const tbody = document.querySelector('#rankings-table tbody');
    tbody.innerHTML = '';
    
    rankings.forEach(user => {
      const row = tbody.insertRow();
      row.innerHTML = `
        <td>${user.rank}</td>
        <td>${user.username}</td>
        <td>${this.formatNumber(user.total_usage)}</td>
        <td>${user.session_count}</td>
        <td>${this.formatTime(user.last_seen)}</td>
      `;
    });
  }

  updateRecentActivity(records) {
    const tbody = document.querySelector('#activity-table tbody');
    tbody.innerHTML = '';
    
    records.forEach(record => {
      const row = tbody.insertRow();
      row.innerHTML = `
        <td>${this.formatTime(record.timestamp)}</td>
        <td>${record.username}</td>
        <td>${record.model || 'unknown'}</td>
        <td>${this.formatNumber(record.input_tokens)}</td>
        <td>${this.formatNumber(record.output_tokens)}</td>
      `;
    });
  }

  async updateTrendChart() {
    const response = await fetch('/api/stats/trends');
    const trends = await response.json();
    
    const ctx = document.getElementById('trend-chart').getContext('2d');
    
    if (this.chart) {
      this.chart.destroy();
    }
    
    this.chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: trends.map(t => t.date),
        datasets: [{
          label: '每日 token 数',
          data: trends.map(t => t.tokens),
          borderColor: 'rgb(75, 192, 192)',
          tension: 0.1
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false
      }
    });
  }

  setupEventListeners() {
    document.getElementById('refresh').addEventListener('click', () => {
      this.loadData();
    });
    
    document.getElementById('period').addEventListener('change', () => {
      this.loadData();
    });
  }

  startAutoRefresh() {
    setInterval(() => {
      this.loadData();
    }, 60000); // 每分钟刷新
  }

  formatNumber(num) {
    return new Intl.NumberFormat('zh-CN').format(num);
  }

  formatTime(timestamp) {
    if (!timestamp) return '-';
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now - date;
    
    if (diff < 3600000) {
      return `${Math.floor(diff / 60000)} 分钟前`;
    } else if (diff < 86400000) {
      return `${Math.floor(diff / 3600000)} 小时前`;
    } else {
      return date.toLocaleDateString('zh-CN');
    }
  }
}

// 启动
document.addEventListener('DOMContentLoaded', () => {
  new Dashboard();
});
```

## 5. 部署配置

### 5.1 Render 配置

```yaml
# render.yaml
services:
  - type: web
    name: claude-stats
    env: node
    buildCommand: npm install
    startCommand: npm start
    disk:
      name: sqlite-data
      mountPath: /data
      sizeGB: 1  # 1GB 足够存储大量数据
    envVars:
      - key: NODE_ENV
        value: production
      - key: DB_PATH
        value: /data/stats.db
```

### 5.2 package.json

```json
{
  "name": "claude-stats-server",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "start": "node index.js",
    "dev": "nodemon index.js"
  },
  "dependencies": {
    "express": "^4.18.0",
    "sqlite3": "^5.1.6",
    "sqlite": "^5.1.1",
    "cors": "^2.8.5"
  },
  "engines": {
    "node": ">=18.0.0"
  }
}
```

## 6. 使用流程

### 6.1 服务端部署

1. 将服务端代码推送到 GitHub
2. 在 Render 创建 Web Service
3. 添加 Disk 挂载到 `/data`
4. 部署完成，获得 URL

### 6.2 客户端配置

```bash
# 安装 CLI
npm install -g claude-stats

# 初始化配置
claude-stats init
> 用户名: john_doe
> 服务器: https://your-app.onrender.com

# 安装 Hook（自动）
✅ Hook 已安装
✅ 开始跟踪使用情况
```

### 6.3 查看数据

```bash
# 命令行查看
claude-stats stats

# 打开 Dashboard
claude-stats dashboard
# 或直接访问 https://your-app.onrender.com
```

## 总结

这个简化方案的特点：

1. **无需认证**: 只用 username 识别用户
2. **SQLite 数据库**: 简单可靠，使用 Render Disk 持久化
3. **极简部署**: 一个服务 + 一个磁盘
4. **开放访问**: Dashboard 无需登录，直接查看
5. **低成本**: Render 免费层 + 1GB 磁盘足够使用

核心简化：
- 移除所有认证逻辑
- 移除团队概念
- 简化数据结构
- 保留核心统计功能

这样的设计适合内部团队使用，简单直接，易于维护。