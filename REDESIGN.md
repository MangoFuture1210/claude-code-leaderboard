# 项目重构设计方案

## 概述

将 Claude Code Leaderboard 从依赖 Twitter 认证和外部 API 改为自建服务器方案，实现完全自主的数据收集和展示系统。

## 架构设计

### 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                        用户环境                               │
│  ┌──────────────┐     ┌─────────────────┐                  │
│  │ Claude Code  │────▶│ Stop Hook       │                  │
│  └──────────────┘     │ (count_tokens.js)│                  │
│                       └────────┬─────────┘                  │
│                                │                            │
│  ┌──────────────────────────────▼──────────────────────┐    │
│  │            CLI Client (claude-code-stats)           │    │
│  │  • 数据收集  • 用户注册  • 本地缓存  • 数据上传      │    │
│  └──────────────────────────────┬──────────────────────┘    │
└─────────────────────────────────┼─────────────────────────────┘
                                  │ HTTP/WebSocket
                    ┌─────────────▼─────────────┐
                    │      Local Server         │
                    │   http://localhost:7632   │
                    ├───────────────────────────┤
                    │  • 用户管理               │
                    │  • 数据接收               │
                    │  • 统计分析               │
                    │  • Web Dashboard          │
                    │  • 实时排行榜             │
                    └───────────┬───────────────┘
                                │
                    ┌───────────▼───────────────┐
                    │    SQLite Database        │
                    │  ~/.claude-stats/data.db  │
                    └───────────────────────────┘
```

## 详细设计

### 1. CLI 客户端改造

#### 1.1 简化的用户识别机制

```javascript
// 用户配置 ~/.claude/stats-config.json
{
  "userId": "uuid-v4",           // 自动生成的用户ID
  "username": "user_chosen_name", // 用户自选的显示名
  "apiKey": "generated-api-key",  // 本地生成的 API Key
  "serverUrl": "http://localhost:7632",
  "autoStart": true,              // 是否自动启动本地服务器
  "privateMode": false            // 是否参与公共排行榜
}
```

#### 1.2 Hook 脚本改造

```javascript
// hooks/count_tokens.js 简化版
#!/usr/bin/env node

import { sendToLocalServer } from './utils.js';

async function main() {
  const usage = await collectUsageData();
  const config = await loadConfig();
  
  // 直接发送到本地服务器
  await sendToLocalServer({
    userId: config.userId,
    apiKey: config.apiKey,
    usage: usage,
    timestamp: new Date().toISOString()
  });
}
```

#### 1.3 主要命令重设计

```bash
# 初始化（首次使用）
claude-stats init
# - 生成用户 ID
# - 设置用户名
# - 启动本地服务器
# - 安装 Hook

# 启动/停止服务器
claude-stats server start
claude-stats server stop
claude-stats server status

# 查看统计
claude-stats stats        # 命令行显示
claude-stats dashboard    # 打开 Web 界面

# 数据管理
claude-stats export       # 导出数据
claude-stats import       # 导入数据
claude-stats reset        # 重置所有数据
```

### 2. 本地服务器设计

#### 2.1 技术栈

- **框架**: Express.js / Fastify
- **数据库**: SQLite (轻量级，无需安装)
- **实时通信**: WebSocket (Socket.io)
- **前端**: 简单的 HTML + Chart.js

#### 2.2 API 设计

```javascript
// API 端点
POST   /api/usage           // 提交使用数据
GET    /api/stats/:userId   // 获取用户统计
GET    /api/leaderboard     // 获取排行榜
GET    /api/trends          // 获取趋势数据
WS     /ws/realtime         // 实时数据推送

// 管理端点
POST   /api/users/register  // 注册新用户
PUT    /api/users/profile   // 更新用户信息
DELETE /api/users/:userId   // 删除用户
```

#### 2.3 数据库设计

```sql
-- 用户表
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  api_key TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  settings JSON
);

-- 使用记录表
CREATE TABLE usage_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  timestamp TIMESTAMP NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_creation_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0,
  model TEXT,
  session_id TEXT,
  metadata JSON,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- 日统计表（优化查询性能）
CREATE TABLE daily_stats (
  user_id TEXT NOT NULL,
  date DATE NOT NULL,
  total_input_tokens INTEGER DEFAULT 0,
  total_output_tokens INTEGER DEFAULT 0,
  total_cache_tokens INTEGER DEFAULT 0,
  session_count INTEGER DEFAULT 0,
  PRIMARY KEY (user_id, date)
);

-- 创建索引
CREATE INDEX idx_usage_user_time ON usage_records(user_id, timestamp);
CREATE INDEX idx_daily_stats_date ON daily_stats(date);
```

#### 2.4 服务器实现

```javascript
// server/index.js
import express from 'express';
import sqlite3 from 'sqlite3';
import { Server } from 'socket.io';
import cors from 'cors';

class LocalStatsServer {
  constructor(config) {
    this.app = express();
    this.db = new sqlite3.Database(config.dbPath);
    this.setupMiddleware();
    this.setupRoutes();
    this.setupWebSocket();
  }

  setupMiddleware() {
    this.app.use(cors());
    this.app.use(express.json());
    this.app.use(express.static('public')); // Dashboard UI
  }

  setupRoutes() {
    // 数据提交
    this.app.post('/api/usage', this.handleUsageSubmit);
    
    // 统计查询
    this.app.get('/api/stats/:userId', this.getUserStats);
    this.app.get('/api/leaderboard', this.getLeaderboard);
    
    // Dashboard
    this.app.get('/', (req, res) => {
      res.sendFile('dashboard.html');
    });
  }

  async handleUsageSubmit(req, res) {
    const { userId, apiKey, usage } = req.body;
    
    // 验证 API Key
    if (!await this.validateApiKey(userId, apiKey)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    // 存储数据
    await this.storeUsage(userId, usage);
    
    // 广播实时更新
    this.broadcast('usage-update', { userId, usage });
    
    res.json({ success: true });
  }
}
```

### 3. Web Dashboard 设计

#### 3.1 界面布局

```html
<!-- public/dashboard.html -->
<!DOCTYPE html>
<html>
<head>
  <title>Claude Stats Dashboard</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <script src="/socket.io/socket.io.js"></script>
</head>
<body>
  <div class="container">
    <!-- 个人统计 -->
    <section id="personal-stats">
      <h2>我的使用统计</h2>
      <div class="stat-cards">
        <div class="card">今日令牌: <span id="today-tokens">0</span></div>
        <div class="card">本周令牌: <span id="week-tokens">0</span></div>
        <div class="card">总计令牌: <span id="total-tokens">0</span></div>
      </div>
      <canvas id="usage-chart"></canvas>
    </section>

    <!-- 实时排行榜 -->
    <section id="leaderboard">
      <h2>实时排行榜</h2>
      <table id="leaderboard-table">
        <!-- 动态生成 -->
      </table>
    </section>

    <!-- 趋势分析 -->
    <section id="trends">
      <h2>使用趋势</h2>
      <canvas id="trend-chart"></canvas>
    </section>
  </div>
</body>
</html>
```

#### 3.2 实时更新

```javascript
// public/dashboard.js
const socket = io();

socket.on('usage-update', (data) => {
  // 更新统计数字
  updateStats(data);
  
  // 更新图表
  updateCharts(data);
  
  // 更新排行榜
  updateLeaderboard(data);
});

// 图表配置
const usageChart = new Chart(ctx, {
  type: 'line',
  data: {
    labels: [], // 时间轴
    datasets: [{
      label: '令牌使用量',
      data: [],
      borderColor: 'rgb(75, 192, 192)',
      tension: 0.1
    }]
  },
  options: {
    responsive: true,
    plugins: {
      legend: { position: 'top' },
      title: { display: true, text: '使用趋势' }
    }
  }
});
```

### 4. 数据流程

#### 4.1 数据收集流程

```
1. Claude Code 会话结束
2. Stop Hook 触发
3. count_tokens.js 执行
   - 扫描 .jsonl 文件
   - 提取使用数据
   - 生成去重哈希
4. 发送到本地服务器
5. 服务器验证并存储
6. 广播实时更新
7. Dashboard 自动刷新
```

#### 4.2 数据聚合策略

```javascript
// 实时聚合
class StatsAggregator {
  constructor() {
    this.realtimeBuffer = new Map();
    this.aggregateInterval = 5000; // 5秒聚合一次
  }

  addUsage(userId, usage) {
    if (!this.realtimeBuffer.has(userId)) {
      this.realtimeBuffer.set(userId, []);
    }
    this.realtimeBuffer.get(userId).push(usage);
  }

  async aggregate() {
    for (const [userId, usages] of this.realtimeBuffer) {
      const aggregated = this.aggregateUsages(usages);
      await this.updateDailyStats(userId, aggregated);
      this.broadcast('stats-update', { userId, stats: aggregated });
    }
    this.realtimeBuffer.clear();
  }
}
```

### 5. 隐私和安全

#### 5.1 数据隐私

- **本地存储**: 所有数据存储在用户本地
- **可选共享**: 用户可选择是否参与公共排行榜
- **匿名模式**: 支持匿名使用，仅显示 ID
- **数据加密**: 敏感数据本地加密存储

#### 5.2 安全措施

```javascript
// API Key 生成和验证
class Security {
  generateApiKey() {
    return crypto.randomBytes(32).toString('hex');
  }

  async validateApiKey(userId, apiKey) {
    const user = await this.db.getUser(userId);
    return user && crypto.timingSafeEqual(
      Buffer.from(user.apiKey),
      Buffer.from(apiKey)
    );
  }

  // 速率限制
  rateLimiter = {
    maxRequests: 100,
    windowMs: 60000, // 1分钟
    storage: new Map()
  };
}
```

### 6. 扩展功能

#### 6.1 数据导出/导入

```javascript
// 支持多种格式
class DataExporter {
  async exportJSON(userId) {
    const data = await this.getAllUserData(userId);
    return JSON.stringify(data, null, 2);
  }

  async exportCSV(userId) {
    const records = await this.getUserRecords(userId);
    return this.convertToCSV(records);
  }

  async exportMarkdown(userId) {
    const stats = await this.getUserStats(userId);
    return this.generateMarkdownReport(stats);
  }
}
```

#### 6.2 插件系统

```javascript
// 支持自定义分析插件
class PluginSystem {
  constructor() {
    this.plugins = new Map();
  }

  register(name, plugin) {
    this.plugins.set(name, plugin);
  }

  async process(data) {
    for (const [name, plugin] of this.plugins) {
      if (plugin.enabled) {
        data = await plugin.process(data);
      }
    }
    return data;
  }
}

// 示例插件：成本计算
class CostCalculatorPlugin {
  process(data) {
    const costPerMillion = 0.003; // $3 per million tokens
    data.estimatedCost = (data.totalTokens / 1000000) * costPerMillion;
    return data;
  }
}
```

#### 6.3 团队功能

```javascript
// 团队统计（可选功能）
class TeamStats {
  async createTeam(name, ownerId) {
    return await this.db.createTeam({ name, ownerId });
  }

  async addMember(teamId, userId) {
    return await this.db.addTeamMember(teamId, userId);
  }

  async getTeamStats(teamId) {
    const members = await this.db.getTeamMembers(teamId);
    const stats = await Promise.all(
      members.map(m => this.getUserStats(m.userId))
    );
    return this.aggregateTeamStats(stats);
  }
}
```

### 7. 迁移计划

#### 7.1 第一阶段：核心功能

1. 实现本地服务器基础架构
2. 简化用户注册流程
3. 保留现有 Hook 机制
4. 实现基础数据存储

#### 7.2 第二阶段：功能完善

1. 添加 Web Dashboard
2. 实现实时更新
3. 添加数据导出功能
4. 优化性能

#### 7.3 第三阶段：扩展功能

1. 插件系统
2. 团队功能
3. 高级分析
4. 自定义报告

### 8. 技术优势

1. **无外部依赖**: 不依赖 Twitter 或其他外部服务
2. **数据主权**: 用户完全控制自己的数据
3. **离线可用**: 本地服务器，无需互联网
4. **易于部署**: 一键启动，无需配置
5. **可扩展性**: 插件系统支持自定义功能

### 9. 用户体验优化

#### 9.1 首次使用流程

```bash
$ npx claude-stats

欢迎使用 Claude Stats! 
让我们快速设置您的环境...

1. 请输入您的用户名: [用户输入]
2. 是否自动启动本地服务器? (Y/n): Y
3. 是否参与匿名排行榜? (y/N): N

✅ 设置完成！
- 用户ID: abc123
- 服务器: http://localhost:7632
- Dashboard: http://localhost:7632/dashboard

Hook 已安装，将自动跟踪您的 Claude Code 使用情况。
```

#### 9.2 日常使用

```bash
# 查看今日统计
$ claude-stats today
今日使用: 45,230 tokens
- 输入: 23,450
- 输出: 21,780
- 会话: 12 次

# 查看趋势
$ claude-stats trend
本周趋势: ↑ 23% 
日均使用: 38,450 tokens

# 打开 Dashboard
$ claude-stats dashboard
正在打开 http://localhost:7632/dashboard...
```

## 总结

这个重构方案将项目从依赖外部服务转变为完全自主的本地解决方案，主要优势：

1. **简化架构**: 移除 OAuth 复杂性
2. **数据自主**: 用户完全控制数据
3. **易于使用**: 一键安装和启动
4. **功能丰富**: 实时统计和可视化
5. **可扩展**: 支持插件和自定义功能

建议的实施步骤：
1. 先实现核心的本地服务器和数据存储
2. 保留并简化现有的 Hook 机制
3. 逐步添加 Dashboard 和实时功能
4. 最后实现扩展功能