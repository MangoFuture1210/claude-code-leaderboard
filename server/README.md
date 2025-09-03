# Claude Stats Server

简单的 Claude Code 使用统计服务器，支持数据收集、存储和可视化展示。

## 功能特性

- 📊 实时数据收集和统计
- 👥 用户排行榜
- 📈 使用趋势图表
- 💾 SQLite 本地存储
- 🎨 美观的 Dashboard 界面
- 🚀 支持 Render 一键部署

## 本地开发

### 安装依赖

```bash
npm install
```

### 启动服务器

```bash
npm start
# 或开发模式
npm run dev
```

服务器将在 http://localhost:3000 启动

### 目录结构

```
server/
├── index.js          # 主入口
├── db/
│   └── database.js   # SQLite 数据库管理
├── routes/
│   ├── usage.js      # 数据提交 API
│   └── stats.js      # 统计查询 API
├── public/           # Dashboard 静态文件
│   ├── index.html
│   ├── css/
│   └── js/
└── data/            # SQLite 数据库文件（自动创建）
```

## API 接口

### 提交使用数据
```
POST /api/usage/submit
Content-Type: application/json

{
  "username": "john_doe",
  "usage": {
    "timestamp": "2024-01-01T12:00:00Z",
    "tokens": {
      "input": 1000,
      "output": 500,
      "cache_creation": 100,
      "cache_read": 50
    },
    "model": "claude-3-opus",
    "session_id": "abc123",
    "interaction_hash": "xyz789"
  }
}
```

### 获取统计概览
```
GET /api/stats/overview?period=7d
```

### 获取用户统计
```
GET /api/stats/user/:username
```

### 获取排行榜
```
GET /api/stats/rankings?limit=50
```

### 获取趋势数据
```
GET /api/stats/trends?days=30
```

## 部署到 Render

### 1. 准备代码

将 server 目录推送到 GitHub 仓库：

```bash
cd server
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/your-username/claude-stats-server.git
git push -u origin main
```

### 2. 在 Render 创建服务

1. 登录 [Render Dashboard](https://dashboard.render.com)
2. 点击 "New +" -> "Web Service"
3. 连接你的 GitHub 仓库
4. 配置服务：
   - **Name**: claude-stats
   - **Environment**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`

### 3. 添加持久化磁盘

1. 在服务设置中，找到 "Disks" 部分
2. 点击 "Add Disk"
3. 配置磁盘：
   - **Name**: sqlite-data
   - **Mount Path**: `/data`
   - **Size**: 1 GB

### 4. 设置环境变量

添加以下环境变量：

```
NODE_ENV=production
DB_PATH=/data/stats.db
PORT=3000
```

### 5. 部署

点击 "Create Web Service"，Render 会自动构建和部署你的服务。

部署完成后，你将获得一个 URL，如：`https://claude-stats.onrender.com`

## 环境变量

| 变量名 | 描述 | 默认值 |
|--------|------|--------|
| PORT | 服务器端口 | 3000 |
| DB_PATH | SQLite 数据库路径 | ./data/stats.db |
| NODE_ENV | 运行环境 | development |

## 数据库架构

### usage_records 表
存储所有使用记录，包含用户名、时间戳、令牌数量等信息。

### daily_stats 表
按日聚合的统计数据，优化查询性能。

### users 表
用户统计信息，通过触发器自动维护。

### 视图
- `user_rankings`: 用户排行榜视图
- `recent_activity`: 最近活动视图

## 注意事项

1. **无认证机制**：服务器接受所有数据提交，适合内部使用
2. **数据去重**：基于 interaction_hash 字段去重
3. **批量提交**：支持单条或批量（最多1000条）数据提交
4. **自动聚合**：每次提交后自动更新日统计

## License

MIT