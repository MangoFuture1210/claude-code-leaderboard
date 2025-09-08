import chalk from 'chalk';
import inquirer from 'inquirer';
import open from 'open';
import path from 'path';
import { homedir } from 'os';
import { readFile, writeFile, unlink, mkdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { loadConfig, saveConfig, CONFIG_PATH } from '../utils/config.js';
import { installHook, uninstallHook, getCurrentHookVersion, cleanupStateFiles } from '../utils/hook-manager.js';

// 初始化配置
export async function initCommand() {
  console.log(chalk.blue('🚀 Claude Stats 配置'));
  console.log(chalk.gray('─'.repeat(40)));
  
  // 检查是否已配置
  const existingConfig = await loadConfig();
  if (existingConfig) {
    console.log(chalk.yellow('⚠️  已存在配置'));
    const { overwrite } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'overwrite',
        message: '是否覆盖现有配置？',
        default: false
      }
    ]);
    
    if (!overwrite) {
      console.log(chalk.gray('配置已取消'));
      return;
    }
  }
  
  // 收集配置信息
  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'username',
      message: '请输入您的用户名:',
      default: existingConfig?.username || process.env.USER || 'anonymous',
      validate: input => {
        if (input.length < 1 || input.length > 50) {
          return '用户名长度应在 1-50 个字符之间';
        }
        if (!/^[a-zA-Z0-9_-]+$/.test(input)) {
          return '用户名只能包含字母、数字、下划线和连字符';
        }
        return true;
      }
    },
    {
      type: 'input',
      name: 'serverUrl',
      message: '请输入服务器地址:',
      default: existingConfig?.serverUrl,
      validate: input => {
        if (!input || input.trim() === '') {
          return '服务器地址不能为空';
        }
        try {
          new URL(input);
          return true;
        } catch {
          return '请输入有效的 URL 地址（如 https://your-server.com）';
        }
      }
    },
    {
      type: 'confirm',
      name: 'enabled',
      message: '立即启用数据跟踪？',
      default: true
    }
  ]);
  
  // 保存配置
  const config = {
    username: answers.username,
    serverUrl: answers.serverUrl,
    enabled: answers.enabled,
    createdAt: new Date().toISOString()
  };
  
  await saveConfig(config);
  
  // 安装 Hook (直接使用 v2)
  console.log();
  console.log(chalk.gray('正在安装 Hook v2...'));
  
  try {
    await installHook(config, 'v2');
    console.log(chalk.green('✓ Hook v2 安装成功'));
    console.log(chalk.gray('  包含: 状态管理、批量收集、重试逻辑'));
  } catch (error) {
    console.error(chalk.red('✗ Hook 安装失败:'), error.message);
    console.log(chalk.yellow('您可以稍后手动重试'));
  }
  
  // 完成
  console.log();
  console.log(chalk.green('✅ 配置完成！'));
  console.log();
  console.log(chalk.gray('配置信息:'));
  console.log(`  用户名: ${chalk.cyan(config.username)}`);
  console.log(`  服务器: ${chalk.cyan(config.serverUrl)}`);
  console.log(`  状态: ${config.enabled ? chalk.green('启用') : chalk.yellow('禁用')}`);
  console.log();
  console.log(chalk.gray('现在 Claude Code 的使用数据将自动跟踪并上传'));
  console.log(chalk.gray(`访问 ${chalk.cyan(config.serverUrl)} 查看 Dashboard`));
}

// 查看统计
export async function statsCommand(options) {
  const config = await loadConfig();
  
  if (!config) {
    console.log(chalk.red('❌ 未找到配置'));
    console.log(chalk.gray('请先运行 `claude-stats init` 进行配置'));
    return;
  }
  
  const username = options.user || config.username;
  
  try {
    console.log(chalk.gray('正在获取统计数据...'));
    
    const response = await fetch(`${config.serverUrl}/api/stats/user/${username}`);
    
    if (!response.ok) {
      if (response.status === 404) {
        console.log(chalk.yellow(`⚠️  用户 "${username}" 暂无数据`));
        return;
      }
      throw new Error(`HTTP ${response.status}`);
    }
    
    const data = await response.json();
    const stats = data.stats;
    
    console.log();
    console.log(chalk.blue(`📊 ${data.username} 的使用统计`));
    console.log(chalk.gray('─'.repeat(40)));
    console.log();
    
    console.log(`${chalk.gray('总 token 数:')} ${chalk.yellow(formatNumber(stats.totalTokens))}`);
    console.log(`  ${chalk.gray('├─ 输入:')} ${formatNumber(stats.totalInput)}`);
    console.log(`  ${chalk.gray('└─ 输出:')} ${formatNumber(stats.totalOutput)}`);
    console.log();
    console.log(`${chalk.gray('会话次数:')} ${chalk.cyan(stats.sessionCount)}`);
    console.log(`${chalk.gray('交互次数:')} ${chalk.cyan(stats.recordCount)}`);
    console.log();
    console.log(`${chalk.gray('首次使用:')} ${formatDate(stats.firstUse)}`);
    console.log(`${chalk.gray('最近使用:')} ${formatDate(stats.lastUse)}`);
    
  } catch (error) {
    console.error(chalk.red('❌ 获取统计失败:'), error.message);
    console.log(chalk.gray('请检查服务器是否正常运行'));
  }
}

// 打开 Dashboard
export async function dashboardCommand() {
  const config = await loadConfig();
  
  if (!config) {
    console.log(chalk.red('❌ 未找到配置'));
    console.log(chalk.gray('请先运行 `claude-stats init` 进行配置'));
    return;
  }
  
  console.log(chalk.blue(`正在打开 Dashboard: ${config.serverUrl}`));
  
  try {
    await open(config.serverUrl);
    console.log(chalk.green('✓ Dashboard 已在浏览器中打开'));
  } catch (error) {
    console.error(chalk.red('✗ 无法打开浏览器'));
    console.log(chalk.gray(`请手动访问: ${chalk.cyan(config.serverUrl)}`));
  }
}

// 启用/禁用跟踪
export async function toggleCommand() {
  const config = await loadConfig();
  
  if (!config) {
    console.log(chalk.red('❌ 未找到配置'));
    console.log(chalk.gray('请先运行 `claude-stats init` 进行配置'));
    return;
  }
  
  config.enabled = !config.enabled;
  await saveConfig(config);
  
  if (config.enabled) {
    console.log(chalk.green('✓ 数据跟踪已启用'));
  } else {
    console.log(chalk.yellow('⏸ 数据跟踪已禁用'));
  }
}

// 配置管理
export async function configCommand(options) {
  const config = await loadConfig();
  
  if (!config) {
    console.log(chalk.red('❌ 未找到配置'));
    console.log(chalk.gray('请先运行 `claude-stats init` 进行配置'));
    return;
  }
  
  if (options.show || !options.edit) {
    // 显示配置
    console.log(chalk.blue('📋 当前配置'));
    console.log(chalk.gray('─'.repeat(40)));
    console.log(JSON.stringify(config, null, 2));
    console.log();
    console.log(chalk.gray(`配置文件: ${CONFIG_PATH}`));
    return;
  }
  
  if (options.edit) {
    // 编辑配置
    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'username',
        message: '用户名:',
        default: config.username,
        validate: input => {
          if (input.length < 1 || input.length > 50) {
            return '用户名长度应在 1-50 个字符之间';
          }
          if (!/^[a-zA-Z0-9_-]+$/.test(input)) {
            return '用户名只能包含字母、数字、下划线和连字符';
          }
          return true;
        }
      },
      {
        type: 'input',
        name: 'serverUrl',
        message: '服务器地址:',
        default: config.serverUrl,
        validate: input => {
          if (!input || input.trim() === '') {
            return '服务器地址不能为空';
          }
          try {
            new URL(input);
            return true;
          } catch {
            return '请输入有效的 URL 地址';
          }
        }
      },
      {
        type: 'confirm',
        name: 'enabled',
        message: '启用跟踪:',
        default: config.enabled
      }
    ]);
    
    const newConfig = {
      ...config,
      username: answers.username,
      serverUrl: answers.serverUrl,
      enabled: answers.enabled,
      updatedAt: new Date().toISOString()
    };
    
    await saveConfig(newConfig);
    console.log(chalk.green('✓ 配置已更新'));
  }
}

// 重置配置
export async function resetCommand(options) {
  const config = await loadConfig();
  
  if (!config) {
    console.log(chalk.yellow('⚠️  没有找到配置'));
    return;
  }
  
  if (!options.force) {
    const { confirm } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: '确定要重置配置并移除 Hook 吗？',
        default: false
      }
    ]);
    
    if (!confirm) {
      console.log(chalk.gray('操作已取消'));
      return;
    }
  }
  
  try {
    // 卸载 Hook
    console.log(chalk.gray('正在移除 Hook...'));
    await uninstallHook();
    console.log(chalk.green('✓ Hook 已移除'));
    
    // 删除配置文件
    console.log(chalk.gray('正在删除配置...'));
    if (existsSync(CONFIG_PATH)) {
      await unlink(CONFIG_PATH);
    }
    console.log(chalk.green('✓ 配置已删除'));
    
    console.log();
    console.log(chalk.green('✅ 重置完成'));
    console.log(chalk.gray('运行 `claude-stats init` 重新配置'));
    
  } catch (error) {
    console.error(chalk.red('❌ 重置失败:'), error.message);
  }
}

// 工具函数
function formatNumber(num) {
  if (num === null || num === undefined) return '0';
  return num.toLocaleString('zh-CN');
}

function formatDate(dateStr) {
  if (!dateStr) return '-';
  const date = new Date(dateStr);
  return date.toLocaleString('zh-CN');
}

// Hook 版本信息
export async function hookVersionCommand() {
  const version = await getCurrentHookVersion();
  
  if (!version) {
    console.log(chalk.yellow('⚠️  未安装 Hook'));
    console.log(chalk.gray('请先运行 `claude-stats init` 进行配置'));
    return;
  }
  
  console.log(chalk.blue('📦 Hook 版本信息'));
  console.log(chalk.gray('─'.repeat(40)));
  console.log(`${chalk.gray('版本:')} ${chalk.cyan(version.version)}`);
  console.log(`${chalk.gray('安装时间:')} ${formatDate(version.installedAt)}`);
  
  if (version.features) {
    console.log(`${chalk.gray('功能:')}`);
    version.features.forEach(f => {
      console.log(`  - ${f}`);
    });
  }
}

// 更新 Hook 到 v2
export async function updateHookToV2Command() {
  const config = await loadConfig();
  
  if (!config) {
    console.log(chalk.red('❌ 未找到配置'));
    console.log(chalk.gray('请先运行 `claude-stats init` 进行配置'));
    return;
  }
  
  const currentVersion = await getCurrentHookVersion();
  
  if (currentVersion?.version === 'v2') {
    console.log(chalk.yellow('⚠️  已经是 v2 版本'));
    return;
  }
  
  console.log(chalk.blue('🔧 更新 Hook 到 v2'));
  console.log();
  console.log(chalk.gray('v2 版本特性:'));
  console.log('  - 状态管理：记录已处理的数据，避免重复');
  console.log('  - 批量收集：一次性收集所有未处理记录');
  console.log('  - 重试逻辑：发送失败自动重试');
  console.log('  - 原子写入：防止状态文件损坏');
  console.log('  - 文件锁：防止并发冲突');
  console.log();
  
  const { confirm } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirm',
      message: '确定要更新到 v2 吗？',
      default: true
    }
  ]);
  
  if (!confirm) {
    console.log(chalk.gray('更新已取消'));
    return;
  }
  
  try {
    console.log(chalk.gray('正在更新...'));
    await installHook(config, 'v2');
    console.log(chalk.green('✓ 成功更新到 v2'));
  } catch (error) {
    console.error(chalk.red('✗ 更新失败:'), error.message);
  }
}

// 清理状态文件
export async function cleanupCommand(options) {
  if (!options.force) {
    const { confirm } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: '确定要清理所有状态文件吗？这将重置收集进度',
        default: false
      }
    ]);
    
    if (!confirm) {
      console.log(chalk.gray('清理已取消'));
      return;
    }
  }
  
  console.log(chalk.gray('正在清理状态文件...'));
  const cleaned = await cleanupStateFiles();
  console.log(chalk.green(`✓ 清理了 ${cleaned} 个文件`));
}

// 调试模式
export async function debugCommand(options) {
  const config = await loadConfig();
  
  if (!config) {
    console.log(chalk.red('❌ 未找到配置'));
    return;
  }
  
  const STATE_FILE = path.join(homedir(), '.claude', 'stats-state.json');
  const BUFFER_FILE = path.join(homedir(), '.claude', 'stats-state.buffer.json');
  const LOG_FILE = path.join(homedir(), '.claude', 'stats-debug.log');
  
  console.log(chalk.blue('🔍 调试信息'));
  console.log(chalk.gray('─'.repeat(40)));
  
  // 检查状态文件
  if (existsSync(STATE_FILE)) {
    try {
      const state = JSON.parse(await readFile(STATE_FILE, 'utf-8'));
      const hashCount = Object.values(state.recentHashes).flat().length;
      console.log(`${chalk.gray('状态文件:')} ${chalk.green('存在')}`);
      console.log(`  ${chalk.gray('已处理记录:')} ${hashCount}`);
      console.log(`  ${chalk.gray('最后清理:')} ${formatDate(state.lastCleanup)}`);
    } catch {
      console.log(`${chalk.gray('状态文件:')} ${chalk.red('损坏')}`);
    }
  } else {
    console.log(`${chalk.gray('状态文件:')} ${chalk.yellow('不存在')}`);
  }
  
  // 检查缓冲文件
  if (existsSync(BUFFER_FILE)) {
    try {
      const buffer = JSON.parse(await readFile(BUFFER_FILE, 'utf-8'));
      console.log(`${chalk.gray('缓冲文件:')} ${chalk.green('存在')}`);
      console.log(`  ${chalk.gray('待发送:')} ${buffer.pendingEntries?.length || 0} 条`);
      console.log(`  ${chalk.gray('重试次数:')} ${buffer.retryCount || 0}`);
    } catch {
      console.log(`${chalk.gray('缓冲文件:')} ${chalk.red('损坏')}`);
    }
  } else {
    console.log(`${chalk.gray('缓冲文件:')} ${chalk.gray('不存在')}`);
  }
  
  // 检查日志文件
  if (existsSync(LOG_FILE)) {
    const stat = await stat(LOG_FILE);
    console.log(`${chalk.gray('日志文件:')} ${chalk.green('存在')}`);
    console.log(`  ${chalk.gray('大小:')} ${(stat.size / 1024).toFixed(2)} KB`);
    
    if (options.logs) {
      console.log();
      console.log(chalk.gray('最近日志:'));
      const logs = await readFile(LOG_FILE, 'utf-8');
      const lines = logs.trim().split('\n').slice(-10);
      lines.forEach(line => {
        try {
          const log = JSON.parse(line);
          const level = log.level === 'error' ? chalk.red(log.level) :
                       log.level === 'warn' ? chalk.yellow(log.level) :
                       chalk.gray(log.level);
          console.log(`  [${level}] ${log.message}`);
        } catch {
          console.log(`  ${line}`);
        }
      });
    }
  } else {
    console.log(`${chalk.gray('日志文件:')} ${chalk.gray('不存在')}`);
  }
  
  console.log();
  console.log(chalk.gray('提示: 设置 CLAUDE_STATS_DEBUG=true 环境变量启用日志'));
}