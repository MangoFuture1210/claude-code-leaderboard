# Claude Stats - 团队使用统计系统

简单、无认证的 Claude Code 使用统计系统，适合团队内部使用。

## 🎯 特性

- 📊 自动跟踪 Claude Code 使用数据
- 🚀 无需登录认证，通过用户名识别
- 📈 美观的 Web Dashboard 实时展示
- 💾 SQLite 数据库，易于部署
- 🔧 一键安装配置
- 🏢 支持团队自建服务器

## 🚀 快速开始

### 前提条件

需要先部署服务器（见下方部署说明）或使用团队已有的服务器地址。

### 1. 安装客户端

```bash
# 使用 npx（推荐）
npx claude-stats init

# 或全局安装
npm install -g claude-stats
claude-stats init
```

### 2. 配置

```bash
claude-stats init

# 配置示例
> 用户名: john_doe
> 服务器地址: https://your-team-server.com  # 必须提供服务器地址
> 启用跟踪: Yes

# ✅ 完成！数据会自动上传到配置的服务器
```

### 3. 查看统计

```bash
# 命令行查看
claude-stats stats

# 打开 Web Dashboard
claude-stats dashboard
# 或直接访问: https://claude-code-leaderboard.onrender.com
```

## 📊 使用方法

### CLI 命令

| 命令 | 说明 |
|------|------|
| `claude-stats init` | 初始化配置并安装 Hook |
| `claude-stats stats` | 查看个人统计 |
| `claude-stats stats -u <user>` | 查看指定用户统计 |
| `claude-stats dashboard` | 打开 Web Dashboard |
| `claude-stats toggle` | 启用/禁用跟踪 |
| `claude-stats config --show` | 显示配置 |
| `claude-stats config --edit` | 编辑配置 |
| `claude-stats reset` | 重置配置 |

### Web Dashboard 功能

访问你的服务器地址查看：
- 📊 实时统计数据
- 🏆 用户排行榜
- 📈 使用趋势图表
- 🕐 最近活动记录

## 🏗 系统架构

```
用户 Claude Code → Hook 触发 → 客户端 CLI → 服务器 API → SQLite → Dashboard
```

### 项目结构

```
claude-code-leaderboard/
├── server/          # 服务端（已部署到 Render）
│   ├── index.js     # Express 服务器
│   ├── db/          # SQLite 数据库
│   ├── routes/      # API 路由
│   └── public/      # Dashboard 前端
│
└── client/          # 客户端 CLI 工具
    ├── bin/         # CLI 入口
    ├── src/         # 命令实现
    └── hooks/       # Claude Hook 脚本
```

## 🔧 开发者指南

### 本地开发

#### 服务端
```bash
cd server
npm install
npm start
# 访问 http://localhost:3000
```

#### 客户端
```bash
cd client
npm install
npm link  # 本地全局安装
claude-stats init
```

## 🖥️ 部署服务器

团队需要先部署自己的服务器，以下是几种部署方式：

#### 方式一：Render 部署（推荐）
1. Fork 此仓库到你的 GitHub
2. 在 [Render](https://render.com) 创建新的 Web Service
3. 连接你的 GitHub 仓库，设置：
   - **Root Directory**: `server`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
4. 添加持久化磁盘（Persistent Disk）：
   - **Name**: `stats-data`
   - **Mount Path**: `/data`
   - **Size**: 1GB (免费套餐足够)
5. 添加环境变量：
   ```
   NODE_ENV=production
   DB_PATH=/data/stats.db
   ```
6. 部署完成后，记录服务器 URL（如 `https://your-app.onrender.com`）
7. 客户端配置时选择自定义服务器并输入你的服务器地址

#### 方式二：本地部署
```bash
# 克隆仓库
git clone https://github.com/your-fork/claude-code-leaderboard.git
cd claude-code-leaderboard/server

# 安装依赖
npm install

# 启动服务器
npm start

# 服务器运行在 http://localhost:3000
```

#### 方式三：Docker 部署
```bash
cd server
docker build -t claude-stats-server .
docker run -p 3000:3000 -v ./data:/data claude-stats-server
```

## 📡 API 接口

服务器提供以下 API 端点（无需认证）：

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/usage/submit` | POST | 提交使用数据 |
| `/api/stats/overview` | GET | 获取总体统计 |
| `/api/stats/user/:username` | GET | 获取用户统计 |
| `/api/stats/rankings` | GET | 获取排行榜 |
| `/api/stats/trends` | GET | 获取趋势数据 |
| `/health` | GET | 健康检查 |

### 数据提交格式

```json
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

## 🛠 技术栈

- **服务端**: Node.js + Express + SQLite
- **客户端**: Node.js CLI (Commander.js)
- **前端**: HTML + CSS + Chart.js
- **部署**: Render + Persistent Disk
- **数据收集**: Claude Code Stop Hook

## ❓ 常见问题

### Q: 如何确认 Hook 是否安装成功？
A: 检查 `~/.claude/settings.json` 文件中是否有 `claude_stats_hook.js` 的配置。

### Q: 数据多久同步一次？
A: 每次 Claude Code 会话结束时自动同步。

### Q: 如何修改用户名或服务器地址？
A: 运行 `claude-stats config --edit` 修改配置。

### Q: 服务器返回 500 错误？
A: 可能是数据库初始化问题，稍等片刻让服务器重启，或检查 `/health` 端点。

### Q: 没有服务器地址怎么办？
A: 必须先部署服务器或从团队管理员获取服务器地址，客户端无法在没有服务器的情况下工作。

## 🔒 隐私说明

- ✅ 只收集使用统计，不收集代码内容
- ✅ 数据存储在独立的 SQLite 数据库
- ✅ 可随时禁用跟踪：`claude-stats toggle`
- ✅ 可完全卸载：`claude-stats reset`

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

主要改进方向：
- [ ] 添加用户认证机制
- [ ] 支持数据导出功能
- [ ] 添加更多统计维度
- [ ] 支持团队分组功能
- [ ] 添加数据删除功能

## 📄 License

MIT

## 🙏 致谢

- 原项目基于 [claude-code-leaderboard](https://github.com/grp06/claude-code-leaderboard)
- 感谢 Claude 团队提供的 Hook 机制