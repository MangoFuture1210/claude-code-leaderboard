# Claude Stats Client

Claude Code 使用统计跟踪客户端，自动收集并上传使用数据到统计服务器。

## 功能特性

- 📊 自动跟踪 Claude Code 使用数据
- 🔧 简单的命令行配置
- 📈 查看个人使用统计
- 🌐 访问 Web Dashboard
- 🔒 可随时启用/禁用跟踪

## 安装

### 全局安装

```bash
npm install -g claude-stats
```

### 或使用 npx（推荐）

```bash
npx claude-stats init
```

## 快速开始

### 1. 初始化配置

```bash
claude-stats init
```

系统会提示您输入：
- **用户名**: 用于识别您的数据（建议使用英文）
- **服务器地址**: 统计服务器的 URL
- **是否启用**: 是否立即启用跟踪

### 2. 查看统计

```bash
# 查看自己的统计
claude-stats stats

# 查看其他用户的统计
claude-stats stats -u username
```

### 3. 打开 Dashboard

```bash
claude-stats dashboard
```

## 命令说明

### `claude-stats init`
初始化配置并安装 Hook

### `claude-stats stats [options]`
查看使用统计
- `-u, --user <username>`: 查看指定用户的统计

### `claude-stats dashboard`
在浏览器中打开 Dashboard

### `claude-stats toggle`
启用或禁用数据跟踪

### `claude-stats config [options]`
管理配置
- `-s, --show`: 显示当前配置
- `-e, --edit`: 编辑配置

### `claude-stats reset [options]`
重置配置并移除 Hook
- `-f, --force`: 跳过确认

## 工作原理

1. **Hook 安装**: 在 Claude Code 的 Stop Hook 中注册脚本
2. **数据收集**: Claude Code 会话结束时自动触发 Hook
3. **数据提取**: 从 `.jsonl` 文件中提取令牌使用信息
4. **数据上传**: 将数据发送到配置的服务器
5. **去重机制**: 基于交互哈希避免重复提交

## 配置文件

配置保存在 `~/.claude/stats-config.json`：

```json
{
  "username": "your_username",
  "serverUrl": "<your-server-url>",
  "enabled": true,
  "createdAt": "2024-01-01T00:00:00.000Z"
}
```

## Hook 脚本

Hook 脚本安装在 `~/.claude/claude_stats_hook.js`，在每次 Claude Code 会话结束时自动执行。

## 隐私说明

### 收集的数据
- 令牌使用量（输入/输出/缓存）
- 使用时间戳
- 模型名称
- 会话 ID（用于统计）

### 不收集的数据
- 您的提示内容
- Claude 的响应内容
- 您的代码或文件

## 故障排除

### Hook 未触发
1. 检查 `~/.claude/settings.json` 中是否正确注册了 Hook
2. 确认 Hook 脚本有执行权限：`ls -la ~/.claude/claude_stats_hook.js`

### 数据未上传
1. 检查服务器是否正常运行
2. 验证服务器地址是否正确：`claude-stats config -s`
3. 确认跟踪已启用：`claude-stats toggle`

### 重新安装
```bash
# 重置所有配置
claude-stats reset

# 重新初始化
claude-stats init
```

## 开发

### 目录结构

```
client/
├── bin/
│   └── cli.js          # CLI 入口
├── src/
│   ├── commands/       # 命令实现
│   ├── utils/          # 工具函数
│   └── index.js        # 主入口
└── hooks/
    └── count_tokens.js # Hook 脚本模板
```

### 本地测试

```bash
# 安装依赖
npm install

# 测试 CLI
node bin/cli.js --help

# 链接到全局
npm link
```

## 服务器

客户端可以连接到任何部署的统计服务器：
- 配置地址：在初始化时设置或编辑 `~/.claude/stats-config.json`
- Dashboard：直接访问服务器地址查看
- API 端点：
  - `POST /api/usage/submit`: 提交使用数据
  - `GET /api/stats/user/:username`: 获取用户统计
  - `GET /api/stats/rankings`: 获取排行榜
  - `GET /api/stats/pricing`: 获取价格信息

## License

MIT