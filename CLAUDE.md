# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目架构

这是一个简化的 Claude Code 使用统计系统，分为独立的服务端和客户端。

### 目录结构

```
claude-code-leaderboard/
├── server/                 # 服务端 (部署到 Render)
│   ├── index.js           # Express 主入口
│   ├── db/
│   │   └── database.js    # SQLite 数据库管理 (单例模式)
│   ├── routes/
│   │   ├── usage.js       # 数据提交 API
│   │   └── stats.js       # 统计查询 API
│   └── public/            # Web Dashboard
│       ├── index.html
│       ├── css/style.css
│       └── js/dashboard.js
│
└── client/                 # 客户端 CLI
    ├── bin/cli.js         # CLI 入口
    ├── src/
    │   ├── commands/      # 命令实现
    │   └── utils/         # 工具函数
    └── hooks/
        └── count_tokens.js # Claude Hook 脚本
```

## 开发指南

### 本地开发

```bash
# 服务端开发
cd server
npm install
npm start  # 启动在 http://localhost:3000

# 客户端开发  
cd client
npm install
npm link   # 本地全局安装
claude-stats init
```

### 服务端

#### 核心组件
- **Express 服务器**: 处理 API 请求和提供 Dashboard
- **SQLite 数据库**: 使用单例模式，存储在 `/data/stats.db` (生产) 或 `./data/stats.db` (本地)
- **无认证**: 通过 username 字段识别用户

#### API 端点
- `POST /api/usage/submit` - 提交使用数据（无需认证）
- `GET /api/stats/overview` - 获取总览统计
- `GET /api/stats/user/:username` - 获取用户统计
- `GET /api/stats/rankings` - 获取排行榜
- `GET /api/stats/trends` - 获取趋势数据

#### 部署到 Render
1. 推送代码到 GitHub
2. 在 Render 创建 Web Service
3. 添加 Disk: `/data` (1GB)
4. 环境变量: `DB_PATH=/data/stats.db`

### 客户端

#### 配置
- 配置文件: `~/.claude/stats-config.json`
- Hook 脚本: `~/.claude/claude_stats_hook.js`
- 服务器地址: 在 `stats-config.json` 中配置 `serverUrl`

#### Hook 机制
1. 在 Claude Code Stop Hook 中注册
2. 每次会话结束时自动执行
3. 扫描 `.jsonl` 文件提取使用数据
4. 发送到服务器（静默失败，不阻塞）

#### Token 计算
- 从 Claude Code 的 `.jsonl` 文件中解析
- 提取字段: `input_tokens`, `output_tokens`, `cache_creation_tokens`, `cache_read_tokens`
- 使用 SHA256 生成交互哈希去重

## 常见命令

### 服务端
```bash
npm start              # 启动服务器
npm run init-db        # 初始化数据库
```

### 客户端
```bash
claude-stats init      # 初始化配置
claude-stats stats     # 查看统计
claude-stats dashboard # 打开 Dashboard
claude-stats toggle    # 启用/禁用跟踪
claude-stats reset     # 重置配置
```

## 注意事项

1. **数据库单例**: 服务端使用单例模式，所有模块共享同一个数据库实例
2. **无认证设计**: 适合内部团队使用，不适合公开部署
3. **静默失败**: Hook 脚本失败不会影响 Claude Code 运行
4. **服务器地址**: 可通过客户端配置文件自定义服务器地址

## 故障排查

### 服务器 500 错误
- 检查数据库是否初始化: `curl <your-server-url>/health`
- 确认使用正确的数据库单例实例
- 检查 DATA_DIR 环境变量是否正确配置
- 验证数据目录权限是否正确

### Hook 不触发
- 检查 `~/.claude/settings.json` 中的 Hook 配置
- 确认 Hook 脚本有执行权限
- 运行 `claude-stats test` 测试 Hook 功能

### 统计数据不显示
- 确认用户名正确
- 检查是否有数据提交成功
- 访问 Dashboard 查看是否有数据
- 查看价格信息: `curl <your-server-url>/api/stats/pricing`

### 成本计算异常
- 确认价格数据已更新: 检查 `/data/pricing.json` 或 `./data/pricing.json`
- 验证模型名称是否在价格表中存在
- 检查服务器日志了解价格获取状态