# Claude Stats - 团队使用统计系统

简单、无认证的 Claude Code 使用统计系统，适合团队内部使用。

## 🎯 特性

- 📊 **智能数据收集** - v3 Hook 优化性能，确保 100% 准确的使用统计
- 🚀 无需登录认证，通过用户名识别
- 📈 美观的 Web Dashboard 实时展示
- 💾 SQLite 数据库，易于部署
- 🔧 一键安装配置
- 🏢 支持团队自建服务器
- 🔄 **状态管理** - 智能去重，防止数据丢失
- 🛡️ **故障恢复** - 自动重试机制，确保数据完整性
- ⚡ **性能优化** - v3 处理速度提升 4-5 倍，支持大数据量

## 🚀 快速开始

### 前提条件

需要先部署服务器（见下方部署说明）或使用团队已有的服务器地址。

### 1. 安装客户端

```bash
# 克隆仓库
git clone https://github.com/your-fork/claude-code-leaderboard.git
cd claude-code-leaderboard

# 重要：进入 client 目录
cd client

# 安装依赖
npm install

# 全局安装客户端
npm link

# 初始化配置
claude-stats init
```

或者使用 npx（如果已发布到 npm）：
```bash
npx claude-stats init
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
| `claude-stats init` | 初始化配置并安装 v3 Hook |
| `claude-stats stats` | 查看个人统计 |
| `claude-stats stats -u <user>` | 查看指定用户统计 |
| `claude-stats dashboard` | 打开 Web Dashboard |
| `claude-stats toggle` | 启用/禁用跟踪 |
| `claude-stats config --show` | 显示配置 |
| `claude-stats config --edit` | 编辑配置 |
| `claude-stats reset` | 重置配置 |
| `claude-stats hook-version` | 查看 Hook 版本信息 |
| `claude-stats upgrade-to-v3` | 升级到 v3 Hook（推荐） |
| `claude-stats cleanup` | 清理状态文件 |
| `claude-stats debug` | 查看调试信息 |

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

## 🚀 Hook 系统

### v3 Hook（最新版本）

#### 主要优化
- **动态批次大小**: 根据数据量自动调整（100/500/1000条）
- **超时保护**: 防止处理大量数据时卡死（5分钟总超时）
- **进度报告**: 实时显示处理进度和速度
- **性能提升**: 处理速度提升 4-5 倍
- **更好的错误恢复**: 精确记录失败数据，支持断点续传

#### 性能对比
- **旧版**: 处理 20,000 条数据可能卡死
- **v3**: 处理 20,000 条数据约需 45 秒（~450条/秒）

### 核心特性
- **完整数据收集**: 收集所有未处理的使用数据
- **智能状态管理**: 记录已处理的数据，避免重复统计
- **自动重试机制**: 网络失败时自动重试
- **原子写入**: 防止状态文件损坏
- **文件锁机制**: 防止并发冲突

### 升级指南

**新用户**: 直接运行 `claude-stats init`，会自动安装 v3

**现有用户**: 
1. 更新代码: `git pull`
2. 升级到 v3: `claude-stats upgrade-to-v3`

### 调试功能

```bash
# 查看 Hook 版本
claude-stats hook-version

# 开启调试模式
CLAUDE_STATS_DEBUG=true claude-stats debug --logs

# 清理状态文件（如遇问题）
claude-stats cleanup
```

## ❓ 常见问题

### Q: 如何确认 Hook 是否安装成功？
A: 运行 `claude-stats hook-version` 查看版本信息，或检查 `~/.claude/settings.json`。

### Q: v3 Hook 有什么优势？
A: v3 大幅提升性能，处理速度快 4-5 倍，支持超大数据量，不会卡死。

### Q: 如何升级到 v3？
A: 运行 `claude-stats upgrade-to-v3` 即可一键升级。

### Q: 数据多久同步一次？
A: 每次 Claude Code 会话结束时自动同步所有未处理的数据。

### Q: 如何修改用户名或服务器地址？
A: 运行 `claude-stats config --edit` 修改配置。

### Q: 服务器返回 500 错误？
A: 可能是数据库初始化问题，稍等片刻让服务器重启，或检查 `/health` 端点。

### Q: 没有服务器地址怎么办？
A: 必须先部署服务器或从团队管理员获取服务器地址，客户端无法在没有服务器的情况下工作。

### Q: 如何排查数据收集问题？
A: 
```bash
# 开启调试模式查看详细日志
CLAUDE_STATS_DEBUG=true claude-stats debug --logs

# 检查状态文件
claude-stats debug

# 如有问题，清理状态重新开始
claude-stats cleanup
```

## 🔒 隐私说明

- ✅ 只收集使用统计，不收集代码内容
- ✅ 数据存储在独立的 SQLite 数据库
- ✅ 可随时禁用跟踪：`claude-stats toggle`
- ✅ 可完全卸载：`claude-stats reset`

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

### 版本历史

- **v3.0** (Latest) - 性能优化版本
  - ✅ 动态批次大小，智能调整处理策略
  - ✅ 超时保护，防止大数据量卡死
  - ✅ 进度报告，实时显示处理状态
  - ✅ 性能提升 4-5 倍，支持 20,000+ 条数据
  - ✅ 包含 v2 所有功能

- **v1.0 & v2.0** - 早期版本
  - ❌ 只收集最新记录，存在数据丢失
  - ❌ 无状态管理
  - ❌ 无重试机制

### 潜在改进方向

- **功能增强**
  - 添加可选的用户认证机制
  - 支持数据导出（CSV/JSON）
  - 更详细的统计维度（按模型、按时间段等）
  - 数据管理功能（清理、归档）
  
- **性能优化**
  - Dashboard 缓存机制
  - 数据库查询优化
  - 大规模部署支持
  
- **部署支持**
  - 更多云平台部署指南（Vercel、Railway等）
  - Kubernetes 部署配置
  - 自动化部署脚本

### 开发指南

1. Fork 仓库
2. 创建功能分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'Add some amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 创建 Pull Request

## 📄 License

MIT

## 🙏 致谢

- 原项目基于 [claude-code-leaderboard](https://github.com/grp06/claude-code-leaderboard)
- 感谢 Claude 团队提供的 Hook 机制