# Claude Stats - 团队使用统计系统

简单、无认证的 Claude Code 使用统计系统，适合团队内部使用。

## 🎯 特性

- 📊 自动跟踪 Claude Code 使用数据
- 🚀 无需登录认证，通过用户名识别
- 📈 美观的 Web Dashboard 实时展示
- 💾 SQLite 数据库，易于部署
- 🔧 一键安装配置

## 📁 项目结构

```
claude-stats/
├── server/          # 服务端 - 部署到 Render
│   ├── index.js     # Express 服务器
│   ├── db/          # SQLite 数据库
│   ├── routes/      # API 路由
│   └── public/      # Dashboard 前端
│
└── client/          # 客户端 - CLI 工具
    ├── bin/         # CLI 入口
    ├── src/         # 命令实现
    └── hooks/       # Claude Hook 脚本
```

## 🚀 快速开始

### 1. 部署服务端

#### 本地运行
```bash
cd server
npm install
npm start
# 访问 http://localhost:3000
```

#### 部署到 Render
1. Fork 或 Clone 此仓库
2. 将 `server` 目录推送到 GitHub
3. 在 [Render](https://render.com) 创建 Web Service
4. 添加 Disk：
   - Mount Path: `/data`
   - Size: 1GB
5. 设置环境变量：
   ```
   NODE_ENV=production
   DB_PATH=/data/stats.db
   ```

### 2. 安装客户端

```bash
cd client
npm install -g .

# 或直接使用 npx
npx claude-stats init
```

### 3. 配置客户端

```bash
claude-stats init

# 输入配置信息
> 用户名: john_doe
> 服务器: https://your-app.onrender.com
> 启用跟踪: Yes
```

## 📊 使用方法

### CLI 命令

```bash
# 查看个人统计
claude-stats stats

# 打开 Dashboard
claude-stats dashboard

# 启用/禁用跟踪
claude-stats toggle

# 查看配置
claude-stats config --show

# 重置配置
claude-stats reset
```

### Web Dashboard

访问服务器地址即可查看：
- 实时统计数据
- 用户排行榜
- 使用趋势图表
- 最近活动记录

## 🔧 API 接口

### 提交数据
```http
POST /api/usage/submit
Content-Type: application/json

{
  "username": "john_doe",
  "usage": {
    "timestamp": "2024-01-01T12:00:00Z",
    "tokens": {
      "input": 1000,
      "output": 500
    },
    "model": "claude-3-opus"
  }
}
```

### 获取统计
```http
GET /api/stats/overview?period=7d
GET /api/stats/user/:username
GET /api/stats/rankings
GET /api/stats/trends
```

## 🏗 技术栈

- **服务端**: Node.js + Express + SQLite
- **客户端**: Node.js CLI
- **前端**: HTML + CSS + Chart.js
- **部署**: Render + Persistent Disk

## 📝 设计理念

- **无认证**: 适合内部团队使用，通过用户名识别
- **简单部署**: SQLite 数据库，无需外部依赖
- **自动跟踪**: Hook 集成，无需手动操作
- **实时展示**: Dashboard 自动刷新，查看即时数据

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📄 License

MIT