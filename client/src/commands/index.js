import chalk from 'chalk';
import inquirer from 'inquirer';
import open from 'open';
import path from 'path';
import { homedir } from 'os';
import { readFile, writeFile, unlink, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { loadConfig, saveConfig, CONFIG_PATH } from '../utils/config.js';
import { installHook, uninstallHook } from '../utils/hook-manager.js';

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
  
  // 默认服务器地址
  const DEFAULT_SERVER_URL = 'https://claude-code-leaderboard.onrender.com';
  
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
      type: 'confirm',
      name: 'useCustomServer',
      message: '使用自定义服务器？（否则使用公共服务器）',
      default: false
    },
    {
      type: 'input',
      name: 'serverUrl',
      message: '服务器地址:',
      default: existingConfig?.serverUrl || DEFAULT_SERVER_URL,
      when: answers => answers.useCustomServer,
      validate: input => {
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
      message: '立即启用数据跟踪？',
      default: true
    }
  ]);
  
  // 保存配置
  const config = {
    username: answers.username,
    serverUrl: answers.serverUrl || DEFAULT_SERVER_URL,
    enabled: answers.enabled,
    createdAt: new Date().toISOString()
  };
  
  await saveConfig(config);
  
  // 安装 Hook
  console.log();
  console.log(chalk.gray('正在安装 Hook...'));
  
  try {
    await installHook(config);
    console.log(chalk.green('✓ Hook 安装成功'));
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
    
    console.log(`${chalk.gray('总令牌数:')} ${chalk.yellow(formatNumber(stats.totalTokens))}`);
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
    const DEFAULT_SERVER_URL = 'https://claude-code-leaderboard.onrender.com';
    const isCustomServer = config.serverUrl !== DEFAULT_SERVER_URL;
    
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
        type: 'confirm',
        name: 'useCustomServer',
        message: '使用自定义服务器？',
        default: isCustomServer
      },
      {
        type: 'input',
        name: 'serverUrl',
        message: '服务器地址:',
        default: config.serverUrl,
        when: answers => answers.useCustomServer,
        validate: input => {
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
      serverUrl: answers.serverUrl || (answers.useCustomServer === false ? DEFAULT_SERVER_URL : config.serverUrl),
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