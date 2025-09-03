# 团队版 Claude Stats 设计方案

## 架构概述

部署到 Render 的团队共享版本，使用 Supabase 作为数据库，支持团队成员数据汇总和分析。

## 系统架构

```
┌──────────────────────────────────────────────────────┐
│                  团队成员环境 (多个)                    │
│  ┌─────────────┐      ┌──────────────────┐          │
│  │ Claude Code │─────▶│ Stop Hook        │          │
│  └─────────────┘      │(count_tokens.js) │          │
│                       └────────┬──────────┘          │
│                                │                      │
│  ┌──────────────────────────────▼─────────────────┐  │
│  │          CLI Client (claude-team-stats)        │  │
│  │  • 数据收集  • 团队认证  • 批量上传  • 缓存     │  │
│  └──────────────────────────────┬─────────────────┘  │
└─────────────────────────────────┼────────────────────┘
                                  │ HTTPS
                    ┌─────────────▼──────────────┐
                    │    Render Server           │
                    │  (Node.js + Express)       │
                    ├────────────────────────────┤
                    │  • API 端点                │
                    │  • 团队认证                │
                    │  • 数据聚合                │
                    │  • Dashboard 服务          │
                    └─────────────┬──────────────┘
                                  │
                    ┌─────────────▼──────────────┐
                    │     Supabase Database      │
                    │   (PostgreSQL + Auth)      │
                    └────────────────────────────┘
```

## 1. 数据库设计 (Supabase)

### 1.1 数据表结构

```sql
-- 团队表
CREATE TABLE teams (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE,
  api_key VARCHAR(255) NOT NULL UNIQUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()),
  settings JSONB DEFAULT '{}'::jsonb
);

-- 团队成员表
CREATE TABLE team_members (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  username VARCHAR(255) NOT NULL,
  email VARCHAR(255),
  machine_id VARCHAR(255) NOT NULL, -- 用于识别不同设备
  api_token VARCHAR(255) NOT NULL UNIQUE,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()),
  last_seen_at TIMESTAMP WITH TIME ZONE,
  UNIQUE(team_id, username),
  UNIQUE(team_id, machine_id)
);

-- 使用记录表
CREATE TABLE usage_records (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  member_id UUID NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_creation_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0,
  model VARCHAR(100),
  session_id VARCHAR(255),
  interaction_hash VARCHAR(255),
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW())
);

-- 日统计汇总表（Material View 优化查询）
CREATE MATERIALIZED VIEW daily_stats AS
SELECT 
  team_id,
  member_id,
  DATE(timestamp) as date,
  COUNT(DISTINCT session_id) as session_count,
  SUM(input_tokens) as total_input_tokens,
  SUM(output_tokens) as total_output_tokens,
  SUM(cache_creation_tokens) as total_cache_creation_tokens,
  SUM(cache_read_tokens) as total_cache_read_tokens,
  COUNT(*) as interaction_count
FROM usage_records
GROUP BY team_id, member_id, DATE(timestamp);

-- 创建索引
CREATE INDEX idx_usage_team_time ON usage_records(team_id, timestamp DESC);
CREATE INDEX idx_usage_member_time ON usage_records(member_id, timestamp DESC);
CREATE INDEX idx_usage_interaction ON usage_records(interaction_hash);
CREATE INDEX idx_members_team ON team_members(team_id);

-- RLS (Row Level Security) 策略
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_records ENABLE ROW LEVEL SECURITY;

-- 团队成员只能看到自己团队的数据
CREATE POLICY "Team members can view own team data" ON usage_records
  FOR SELECT USING (
    team_id IN (
      SELECT team_id FROM team_members 
      WHERE api_token = current_setting('app.api_token')::VARCHAR
    )
  );
```

### 1.2 Supabase 配置

```javascript
// server/config/supabase.js
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY; // 服务端使用 service key

export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false
  }
});

// 数据库操作封装
export class Database {
  // 创建团队
  async createTeam(name) {
    const apiKey = this.generateApiKey();
    const { data, error } = await supabase
      .from('teams')
      .insert({ name, api_key: apiKey })
      .select()
      .single();
    
    if (error) throw error;
    return data;
  }

  // 添加团队成员
  async addTeamMember(teamId, username, machineId) {
    const apiToken = this.generateApiToken();
    const { data, error } = await supabase
      .from('team_members')
      .insert({
        team_id: teamId,
        username,
        machine_id: machineId,
        api_token: apiToken
      })
      .select()
      .single();
    
    if (error) throw error;
    return data;
  }

  // 批量插入使用记录
  async insertUsageRecords(records) {
    const { data, error } = await supabase
      .from('usage_records')
      .insert(records)
      .select();
    
    if (error) throw error;
    return data;
  }

  // 生成 API Key
  generateApiKey() {
    return `team_${crypto.randomBytes(32).toString('hex')}`;
  }

  generateApiToken() {
    return `member_${crypto.randomBytes(32).toString('hex')}`;
  }
}
```

## 2. 服务端实现 (Node.js for Render)

### 2.1 项目结构

```
server/
├── package.json
├── index.js              # 入口文件
├── config/
│   ├── supabase.js      # Supabase 配置
│   └── env.js           # 环境变量
├── middleware/
│   ├── auth.js          # 认证中间件
│   ├── rateLimit.js     # 速率限制
│   └── validation.js    # 数据验证
├── routes/
│   ├── usage.js         # 使用数据 API
│   ├── stats.js         # 统计 API
│   ├── teams.js         # 团队管理 API
│   └── dashboard.js     # Dashboard 路由
├── services/
│   ├── aggregation.js   # 数据聚合服务
│   └── cache.js         # 缓存服务
└── public/
    ├── dashboard.html    # Dashboard 页面
    ├── css/
    └── js/
```

### 2.2 服务端代码

```javascript
// server/index.js
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { Database } from './config/supabase.js';
import { authMiddleware } from './middleware/auth.js';
import { rateLimiter } from './middleware/rateLimit.js';
import usageRoutes from './routes/usage.js';
import statsRoutes from './routes/stats.js';
import teamsRoutes from './routes/teams.js';

const app = express();
const db = new Database();

// 中间件
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(rateLimiter);

// 静态文件 (Dashboard)
app.use(express.static('public'));

// API 路由
app.use('/api/usage', authMiddleware, usageRoutes);
app.use('/api/stats', authMiddleware, statsRoutes);
app.use('/api/teams', teamsRoutes);

// 健康检查
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// 错误处理
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
```

### 2.3 认证中间件

```javascript
// server/middleware/auth.js
import { supabase } from '../config/supabase.js';

export async function authMiddleware(req, res, next) {
  const apiToken = req.headers['x-api-token'];
  
  if (!apiToken) {
    return res.status(401).json({ error: 'API token required' });
  }

  try {
    // 验证 token 并获取成员信息
    const { data: member, error } = await supabase
      .from('team_members')
      .select('*, teams(*)')
      .eq('api_token', apiToken)
      .eq('is_active', true)
      .single();

    if (error || !member) {
      return res.status(401).json({ error: 'Invalid API token' });
    }

    // 更新最后访问时间
    await supabase
      .from('team_members')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', member.id);

    // 附加到请求对象
    req.member = member;
    req.team = member.teams;
    
    next();
  } catch (error) {
    console.error('Auth error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
}
```

### 2.4 使用数据 API

```javascript
// server/routes/usage.js
import { Router } from 'express';
import { supabase } from '../config/supabase.js';
import { validateUsageData } from '../middleware/validation.js';

const router = Router();

// 提交使用数据
router.post('/submit', validateUsageData, async (req, res) => {
  try {
    const { usage } = req.body;
    const { member, team } = req;

    // 批量处理使用记录
    const records = usage.map(item => ({
      team_id: team.id,
      member_id: member.id,
      timestamp: item.timestamp,
      input_tokens: item.tokens.input,
      output_tokens: item.tokens.output,
      cache_creation_tokens: item.tokens.cache_creation || 0,
      cache_read_tokens: item.tokens.cache_read || 0,
      model: item.model,
      session_id: item.session_id,
      interaction_hash: item.interaction_hash,
      metadata: item.metadata || {}
    }));

    // 去重：检查 interaction_hash
    const hashes = records.map(r => r.interaction_hash).filter(Boolean);
    if (hashes.length > 0) {
      const { data: existing } = await supabase
        .from('usage_records')
        .select('interaction_hash')
        .in('interaction_hash', hashes);
      
      const existingHashes = new Set(existing?.map(e => e.interaction_hash) || []);
      const newRecords = records.filter(r => 
        !r.interaction_hash || !existingHashes.has(r.interaction_hash)
      );

      if (newRecords.length === 0) {
        return res.json({ 
          success: true, 
          message: 'All records already exist',
          submitted: 0 
        });
      }

      // 插入新记录
      const { data, error } = await supabase
        .from('usage_records')
        .insert(newRecords)
        .select();

      if (error) throw error;

      res.json({ 
        success: true, 
        submitted: data.length,
        total: records.length
      });
    } else {
      // 没有 hash 的记录直接插入
      const { data, error } = await supabase
        .from('usage_records')
        .insert(records)
        .select();

      if (error) throw error;

      res.json({ 
        success: true, 
        submitted: data.length 
      });
    }
  } catch (error) {
    console.error('Usage submission error:', error);
    res.status(500).json({ error: 'Failed to submit usage data' });
  }
});

export default router;
```

### 2.5 统计 API

```javascript
// server/routes/stats.js
import { Router } from 'express';
import { supabase } from '../config/supabase.js';

const router = Router();

// 获取团队统计
router.get('/team', async (req, res) => {
  try {
    const { team } = req;
    const { period = '7d' } = req.query;

    // 计算时间范围
    const startDate = getStartDate(period);

    // 获取团队统计
    const { data, error } = await supabase
      .from('usage_records')
      .select('*')
      .eq('team_id', team.id)
      .gte('timestamp', startDate.toISOString())
      .order('timestamp', { ascending: false });

    if (error) throw error;

    // 聚合统计
    const stats = aggregateStats(data);

    // 获取成员排行
    const { data: memberStats } = await supabase
      .from('daily_stats')
      .select('*, team_members(username)')
      .eq('team_id', team.id)
      .gte('date', startDate.toISOString().split('T')[0]);

    const leaderboard = aggregateMemberStats(memberStats);

    res.json({
      team: team.name,
      period,
      stats,
      leaderboard,
      details: data.slice(0, 100) // 最近100条
    });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

// 获取个人统计
router.get('/member', async (req, res) => {
  try {
    const { member } = req;
    const { period = '7d' } = req.query;

    const startDate = getStartDate(period);

    const { data, error } = await supabase
      .from('usage_records')
      .select('*')
      .eq('member_id', member.id)
      .gte('timestamp', startDate.toISOString())
      .order('timestamp', { ascending: false });

    if (error) throw error;

    const stats = aggregateStats(data);

    res.json({
      username: member.username,
      period,
      stats,
      recent: data.slice(0, 50)
    });
  } catch (error) {
    console.error('Member stats error:', error);
    res.status(500).json({ error: 'Failed to get member stats' });
  }
});

// 辅助函数
function getStartDate(period) {
  const now = new Date();
  switch(period) {
    case '1d': return new Date(now - 24 * 60 * 60 * 1000);
    case '7d': return new Date(now - 7 * 24 * 60 * 60 * 1000);
    case '30d': return new Date(now - 30 * 24 * 60 * 60 * 1000);
    default: return new Date(now - 7 * 24 * 60 * 60 * 1000);
  }
}

function aggregateStats(records) {
  return records.reduce((acc, record) => ({
    totalInputTokens: acc.totalInputTokens + record.input_tokens,
    totalOutputTokens: acc.totalOutputTokens + record.output_tokens,
    totalCacheTokens: acc.totalCacheTokens + record.cache_creation_tokens + record.cache_read_tokens,
    sessionCount: new Set([...acc.sessions, record.session_id]).size,
    interactionCount: acc.interactionCount + 1
  }), {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheTokens: 0,
    sessions: new Set(),
    interactionCount: 0
  });
}

export default router;
```

## 3. CLI 客户端改造

### 3.1 配置文件

```javascript
// CLI 配置 ~/.claude/team-stats.json
{
  "teamId": "uuid",
  "teamName": "MyTeam",
  "username": "john_doe",
  "machineId": "auto-generated-machine-id",
  "apiToken": "member_xxx",
  "serverUrl": "https://your-app.onrender.com",
  "cacheDir": "~/.claude/cache",
  "syncInterval": 300000 // 5分钟同步一次
}
```

### 3.2 Hook 脚本改造

```javascript
// hooks/count_tokens_team.js
#!/usr/bin/env node

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { homedir } from 'os';
import https from 'https';

const CONFIG_PATH = path.join(homedir(), '.claude', 'team-stats.json');
const CACHE_PATH = path.join(homedir(), '.claude', 'cache', 'pending.json');

async function main() {
  try {
    // 加载配置
    if (!existsSync(CONFIG_PATH)) {
      console.log('Team stats not configured. Run: claude-team-stats init');
      process.exit(0);
    }

    const config = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
    
    // 收集使用数据
    const usage = await collectUsageData();
    if (!usage) {
      process.exit(0);
    }

    // 添加到缓存
    await addToCache(usage);

    // 尝试同步（不阻塞）
    syncInBackground(config).catch(() => {
      // 静默失败，下次再试
    });

    process.exit(0);
  } catch (error) {
    // 静默失败，不影响 Claude Code
    process.exit(0);
  }
}

async function addToCache(usage) {
  let cache = [];
  
  if (existsSync(CACHE_PATH)) {
    try {
      cache = JSON.parse(await readFile(CACHE_PATH, 'utf-8'));
    } catch {}
  }

  cache.push(usage);

  // 限制缓存大小
  if (cache.length > 1000) {
    cache = cache.slice(-1000);
  }

  await writeFile(CACHE_PATH, JSON.stringify(cache), 'utf-8');
}

async function syncInBackground(config) {
  // 读取缓存
  if (!existsSync(CACHE_PATH)) return;
  
  const cache = JSON.parse(await readFile(CACHE_PATH, 'utf-8'));
  if (cache.length === 0) return;

  // 发送到服务器
  const response = await postToServer(config, '/api/usage/submit', {
    usage: cache
  });

  if (response.success) {
    // 清空已发送的缓存
    await writeFile(CACHE_PATH, '[]', 'utf-8');
  }
}

function postToServer(config, endpoint, data) {
  return new Promise((resolve, reject) => {
    const url = new URL(config.serverUrl + endpoint);
    const payload = JSON.stringify(data);

    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'X-API-Token': config.apiToken
      },
      timeout: 5000
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve({ success: false });
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });

    req.write(payload);
    req.end();
  });
}

main();
```

### 3.3 CLI 命令

```javascript
// bin/cli.js
#!/usr/bin/env node

import { Command } from 'commander';
import { init, sync, stats, config } from '../src/commands/index.js';

const program = new Command();

program
  .name('claude-team-stats')
  .description('Team statistics for Claude Code usage')
  .version('1.0.0');

// 初始化
program
  .command('init')
  .description('Initialize team configuration')
  .option('-t, --team <name>', 'Team name')
  .option('-u, --username <name>', 'Your username')
  .option('-s, --server <url>', 'Server URL')
  .action(init);

// 手动同步
program
  .command('sync')
  .description('Manually sync cached data')
  .action(sync);

// 查看统计
program
  .command('stats')
  .description('View statistics')
  .option('-p, --period <period>', 'Time period (1d, 7d, 30d)', '7d')
  .option('-t, --team', 'Show team stats', false)
  .action(stats);

// 配置管理
program
  .command('config')
  .description('Manage configuration')
  .option('-g, --get <key>', 'Get config value')
  .option('-s, --set <key=value>', 'Set config value')
  .action(config);

program.parse();
```

## 4. Dashboard 实现

### 4.1 简易 Dashboard

```html
<!-- server/public/dashboard.html -->
<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Claude Team Stats Dashboard</title>
  <link rel="stylesheet" href="/css/dashboard.css">
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
</head>
<body>
  <div class="container">
    <header>
      <h1>Claude Code 团队使用统计</h1>
      <div class="controls">
        <select id="period-selector">
          <option value="1d">今天</option>
          <option value="7d" selected>最近7天</option>
          <option value="30d">最近30天</option>
        </select>
        <button id="refresh-btn">刷新</button>
      </div>
    </header>

    <!-- 总览卡片 -->
    <section class="stats-cards">
      <div class="card">
        <h3>总令牌数</h3>
        <p class="value" id="total-tokens">-</p>
      </div>
      <div class="card">
        <h3>团队成员</h3>
        <p class="value" id="active-members">-</p>
      </div>
      <div class="card">
        <h3>今日使用</h3>
        <p class="value" id="today-usage">-</p>
      </div>
      <div class="card">
        <h3>活跃会话</h3>
        <p class="value" id="session-count">-</p>
      </div>
    </section>

    <!-- 趋势图表 -->
    <section class="charts">
      <div class="chart-container">
        <h2>使用趋势</h2>
        <canvas id="trend-chart"></canvas>
      </div>
      <div class="chart-container">
        <h2>成员排行</h2>
        <canvas id="member-chart"></canvas>
      </div>
    </section>

    <!-- 数据表格 -->
    <section class="data-table">
      <h2>最近使用记录</h2>
      <table id="usage-table">
        <thead>
          <tr>
            <th>时间</th>
            <th>用户</th>
            <th>模型</th>
            <th>输入令牌</th>
            <th>输出令牌</th>
            <th>总计</th>
          </tr>
        </thead>
        <tbody id="usage-tbody">
          <!-- 动态生成 -->
        </tbody>
      </table>
    </section>
  </div>

  <script src="/js/dashboard.js"></script>
</body>
</html>
```

### 4.2 Dashboard JavaScript

```javascript
// server/public/js/dashboard.js
class Dashboard {
  constructor() {
    this.apiToken = this.getApiToken();
    this.charts = {};
    this.init();
  }

  async init() {
    // 从 URL 参数获取 token 或提示输入
    if (!this.apiToken) {
      this.apiToken = prompt('请输入您的 API Token:');
      if (this.apiToken) {
        localStorage.setItem('apiToken', this.apiToken);
      }
    }

    await this.loadData();
    this.setupEventListeners();
    this.initCharts();
    
    // 自动刷新
    setInterval(() => this.loadData(), 60000);
  }

  getApiToken() {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get('token') || localStorage.getItem('apiToken');
  }

  async loadData() {
    const period = document.getElementById('period-selector').value;
    
    try {
      const response = await fetch(`/api/stats/team?period=${period}`, {
        headers: {
          'X-API-Token': this.apiToken
        }
      });

      if (!response.ok) {
        throw new Error('Failed to load data');
      }

      const data = await response.json();
      this.updateUI(data);
    } catch (error) {
      console.error('Error loading data:', error);
      alert('加载数据失败，请检查 API Token');
    }
  }

  updateUI(data) {
    // 更新统计卡片
    document.getElementById('total-tokens').textContent = 
      this.formatNumber(data.stats.totalInputTokens + data.stats.totalOutputTokens);
    document.getElementById('active-members').textContent = 
      data.leaderboard.length;
    document.getElementById('session-count').textContent = 
      data.stats.sessionCount;

    // 更新图表
    this.updateCharts(data);

    // 更新表格
    this.updateTable(data.details);
  }

  updateCharts(data) {
    // 趋势图
    if (this.charts.trend) {
      // 按日期聚合数据
      const dailyData = this.aggregateByDate(data.details);
      
      this.charts.trend.data.labels = Object.keys(dailyData);
      this.charts.trend.data.datasets[0].data = Object.values(dailyData).map(d => d.input);
      this.charts.trend.data.datasets[1].data = Object.values(dailyData).map(d => d.output);
      this.charts.trend.update();
    }

    // 成员排行图
    if (this.charts.member) {
      const topMembers = data.leaderboard.slice(0, 10);
      
      this.charts.member.data.labels = topMembers.map(m => m.username);
      this.charts.member.data.datasets[0].data = topMembers.map(m => m.totalTokens);
      this.charts.member.update();
    }
  }

  updateTable(records) {
    const tbody = document.getElementById('usage-tbody');
    tbody.innerHTML = '';

    records.slice(0, 20).forEach(record => {
      const row = tbody.insertRow();
      row.innerHTML = `
        <td>${new Date(record.timestamp).toLocaleString('zh-CN')}</td>
        <td>${record.username || 'Unknown'}</td>
        <td>${record.model}</td>
        <td>${this.formatNumber(record.input_tokens)}</td>
        <td>${this.formatNumber(record.output_tokens)}</td>
        <td>${this.formatNumber(record.input_tokens + record.output_tokens)}</td>
      `;
    });
  }

  initCharts() {
    // 趋势图
    const trendCtx = document.getElementById('trend-chart').getContext('2d');
    this.charts.trend = new Chart(trendCtx, {
      type: 'line',
      data: {
        labels: [],
        datasets: [{
          label: '输入令牌',
          data: [],
          borderColor: 'rgb(75, 192, 192)',
          backgroundColor: 'rgba(75, 192, 192, 0.2)'
        }, {
          label: '输出令牌',
          data: [],
          borderColor: 'rgb(255, 99, 132)',
          backgroundColor: 'rgba(255, 99, 132, 0.2)'
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false
      }
    });

    // 成员排行图
    const memberCtx = document.getElementById('member-chart').getContext('2d');
    this.charts.member = new Chart(memberCtx, {
      type: 'bar',
      data: {
        labels: [],
        datasets: [{
          label: '总令牌数',
          data: [],
          backgroundColor: 'rgba(54, 162, 235, 0.5)'
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: 'y'
      }
    });
  }

  setupEventListeners() {
    document.getElementById('refresh-btn').addEventListener('click', () => {
      this.loadData();
    });

    document.getElementById('period-selector').addEventListener('change', () => {
      this.loadData();
    });
  }

  formatNumber(num) {
    return new Intl.NumberFormat('zh-CN').format(num);
  }

  aggregateByDate(records) {
    const result = {};
    
    records.forEach(record => {
      const date = new Date(record.timestamp).toLocaleDateString('zh-CN');
      if (!result[date]) {
        result[date] = { input: 0, output: 0 };
      }
      result[date].input += record.input_tokens;
      result[date].output += record.output_tokens;
    });

    return result;
  }
}

// 初始化
document.addEventListener('DOMContentLoaded', () => {
  new Dashboard();
});
```

## 5. 部署到 Render

### 5.1 环境变量配置

```env
# Render 环境变量
NODE_ENV=production
PORT=3000

# Supabase
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_SERVICE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...

# 其他配置
RATE_LIMIT_WINDOW=60000
RATE_LIMIT_MAX=100
```

### 5.2 package.json

```json
{
  "name": "claude-team-stats-server",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "start": "node index.js",
    "dev": "nodemon index.js",
    "build": "echo 'No build step required'"
  },
  "dependencies": {
    "express": "^4.18.0",
    "@supabase/supabase-js": "^2.39.0",
    "cors": "^2.8.5",
    "helmet": "^7.0.0",
    "express-rate-limit": "^7.0.0",
    "dotenv": "^16.0.0"
  },
  "engines": {
    "node": ">=18.0.0"
  }
}
```

### 5.3 Render 配置

```yaml
# render.yaml
services:
  - type: web
    name: claude-team-stats
    env: node
    buildCommand: npm install
    startCommand: npm start
    envVars:
      - key: NODE_ENV
        value: production
      - key: SUPABASE_URL
        sync: false
      - key: SUPABASE_SERVICE_KEY
        sync: false
```

## 6. 使用流程

### 6.1 团队管理员设置

```bash
# 1. 创建团队（通过 API 或 Supabase Dashboard）
POST /api/teams/create
{
  "name": "MyCompany"
}

# 返回
{
  "teamId": "uuid",
  "apiKey": "team_xxx"
}
```

### 6.2 团队成员设置

```bash
# 1. 安装 CLI
npm install -g claude-team-stats

# 2. 初始化
claude-team-stats init
> 输入服务器 URL: https://your-app.onrender.com
> 输入团队 API Key: team_xxx
> 输入您的用户名: john_doe

# 3. 自动安装 Hook
✅ Hook 已安装
✅ 配置已保存

# 4. 正常使用 Claude Code
# 数据会自动收集并上传
```

### 6.3 查看统计

```bash
# 命令行查看
claude-team-stats stats --team

# 或访问 Dashboard
https://your-app.onrender.com/dashboard?token=member_xxx
```

## 总结

这个方案的优势：

1. **云端部署**: 部署到 Render，团队共享
2. **Supabase 数据库**: 强大的 PostgreSQL + 实时功能
3. **团队协作**: 支持多成员数据汇总
4. **简易 Dashboard**: Web 界面查看统计
5. **离线缓存**: 网络故障时本地缓存，恢复后自动同步
6. **安全认证**: API Token 机制，RLS 数据隔离

实施步骤：
1. 设置 Supabase 项目和数据库
2. 开发并部署服务端到 Render
3. 改造 CLI 客户端
4. 团队成员安装和配置