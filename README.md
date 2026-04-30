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
| `claude-stats upgrade-to-v3` | 升级到 v3 Hook（传统方式） |
| `claude-stats upgrade-hook` | 通用 Hook 升级工具（推荐） |
| `claude-stats cleanup` | 清理状态文件 |
| `claude-stats debug` | 查看调试信息 |
| `claude-stats codex sync` | 同步本机 Codex 使用数据 |
| `claude-stats codex hook install` | 安装 Codex Stop Hook 自动同步 |
| `claude-stats codex hook status` | 查看 Codex Stop Hook 状态 |
| `claude-stats codex hook uninstall` | 移除 Codex Stop Hook 自动同步 |

### Codex 兼容同步（实验性）

Codex 同步会读取本机 `~/.codex/sessions` 下的 rollout 元数据，只提取 `token_count` 事件中的 token 统计，不上传对话内容。

Token 数量来自 Codex 自己生成的 rollout JSONL；模型名称会尽量从 Codex 本地状态库 `~/.codex/state_5.sqlite` 的 `threads.model` 补全，例如把 `openai` 细化为 `gpt-5.5`。如果该数据库不可用，同步仍会继续，只是模型名称可能退回到较粗的标签。

```bash
# 预览将同步的数据，不上传
claude-stats codex sync --dry-run

# 同步到已配置的服务器
claude-stats codex sync
```

### Codex Stop Hook 自动同步（实验性）

Codex 支持官方 Hook 机制。安装后，客户端会启用 `codex_hooks`，并在 `~/.codex/hooks.json` 中注册 `Stop` Hook，在每次 Codex agent turn 结束后自动执行小批量同步。

```bash
# 安装自动同步 Hook
claude-stats codex hook install

# 查看 Hook 状态
claude-stats codex hook status

# 移除 Hook（默认保留 codex_hooks feature 开启状态）
claude-stats codex hook uninstall

# 如果你确定不再需要任何 Codex Hook，也可以同时关闭 feature
claude-stats codex hook uninstall --disable-feature
```

自动同步命令会使用锁文件避免并发运行，并写入简洁日志到 `~/.claude/codex-sync.log`。日志只包含记录数量、成功/失败和耗时，不包含对话内容。

安装 Hook 后，新的 Codex turn 会在后续 `Stop` 事件触发同步；Hook 命令会在成功时输出 Codex 要求的 JSON。已经打开的 Codex 会话如果没有立即触发，可以重启 Codex 或开启一个新会话让配置重新加载。同步是去重的，重复触发不会重复计入。多个 Codex Desktop/CLI 会话并发触发时，锁文件会确保只有一个同步进程实际运行，其余会安全退出并等待后续 Stop 事件补偿。

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
- **共享模块架构**: 消除代码重复，遵循 DRY 原则（d20a85d 更新）

#### 性能对比
- **旧版**: 处理 20,000 条数据可能卡死
- **v3**: 处理 20,000 条数据约需 45 秒（~450条/秒）

#### 共享模块架构
最新版本（d20a85d 提交）引入了共享模块架构：
- 独立的 `shared/data-collector.js` 模块
- Hook v3 从 776 行减少到 636 行（-140 行）
- 代码重复消除，维护性大幅提升

### 核心特性
- **完整数据收集**: 收集所有未处理的使用数据
- **智能状态管理**: 记录已处理的数据，避免重复统计
- **自动重试机制**: 网络失败时自动重试
- **原子写入**: 防止状态文件损坏
- **文件锁机制**: 防止并发冲突

### 升级指南

#### 新用户
直接运行 `claude-stats init`，会自动安装最新的 v3 Hook（包含共享模块）

#### 现有用户升级
有两种升级方式：

**方式一：通用升级工具（推荐）**
```bash
# 更新代码
git pull

# 使用新的通用升级命令
claude-stats upgrade-hook --latest
```

**方式二：传统升级**
```bash
# 更新代码  
git pull

# 使用传统升级命令
claude-stats upgrade-to-v3 --force
```

#### 升级场景说明

| 当前版本 | 推荐命令 | 说明 |
|---------|----------|------|
| 未安装 | `claude-stats init` | 全新安装，自动使用最新版 |
| v2 | `claude-stats upgrade-hook` | 升级到 v3 最新版 |
| v3（旧版） | `claude-stats upgrade-hook --latest` | 更新到包含共享模块的最新版 |
| v3（最新） | `claude-stats upgrade-hook --force` | 强制重新安装 |

#### 升级特性

**`claude-stats upgrade-hook` 新特性**:
- ✅ 智能版本检测和升级路径选择
- ✅ 自动安装共享模块（`~/.claude/shared/`）
- ✅ 支持版本降级（`--target v2`）
- ✅ 自动备份和故障恢复机制
- ✅ 详细的升级进度和结果报告

**升级选项**:
```bash
# 升级到默认最新版本
claude-stats upgrade-hook

# 升级到指定版本
claude-stats upgrade-hook --target v2
claude-stats upgrade-hook --target v3

# 升级到最新版本（包含所有更新）
claude-stats upgrade-hook --latest

# 强制升级（即使版本相同）
claude-stats upgrade-hook --force
```

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

### Q: 如何升级到最新的 v3？
A: 推荐使用 `claude-stats upgrade-hook --latest` 升级到包含共享模块的最新版本。传统方式：`claude-stats upgrade-to-v3 --force`。

### Q: upgrade-hook 和 upgrade-to-v3 有什么区别？
A: `upgrade-hook` 是新的通用升级工具，支持：
- 任意版本间的升级/降级
- 智能检测当前版本和升级路径
- 自动安装共享模块（d20a85d 更新）
- 备份和故障恢复机制
- 更详细的升级信息展示

### Q: 我之前安装了 v3，需要重新升级吗？
A: 如果是最近的版本可能缺少共享模块，建议运行 `claude-stats upgrade-hook --latest` 更新到最新架构。

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

- **v3.0** (Latest) - 性能优化版本 + 共享模块架构
  - ✅ 动态批次大小，智能调整处理策略
  - ✅ 超时保护，防止大数据量卡死
  - ✅ 进度报告，实时显示处理状态
  - ✅ 性能提升 4-5 倍，支持 20,000+ 条数据
  - ✅ **共享模块架构**（d20a85d 更新）: 代码重复消除，维护性提升
  - ✅ **通用升级工具**: `claude-stats upgrade-hook` 支持智能升级
  - ✅ 包含 v2 所有功能

- **v1.0 & v2.0** - 早期版本
  - ❌ 只收集最新记录，存在数据丢失
  - ❌ 无状态管理
  - ❌ 无重试机制

#### 最新更新（d20a85d 提交）
- **共享模块架构重构**
  - 创建 `shared/data-collector.js` 独立模块
  - Hook v3 代码从 776 行精简到 636 行（-18% 代码量）
  - 消除函数重复，遵循 DRY 原则
  - 提升代码维护性和可扩展性
  
- **增强升级工具**
  - 新增 `claude-stats upgrade-hook` 通用升级命令
  - 支持版本间任意升级/降级
  - 自动处理共享模块依赖
  - 完善的备份和恢复机制

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
