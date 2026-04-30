#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { 
  initCommand, 
  statsCommand, 
  dashboardCommand, 
  toggleCommand,
  configCommand,
  resetCommand,
  hookVersionCommand,
  updateHookToV3Command,
  upgradeHookCommand,
  cleanupCommand,
  debugCommand,
  codexSyncCommand,
  codexHookInstallCommand,
  codexHookStatusCommand,
  codexHookUninstallCommand
} from '../src/commands/index.js';
import { normalizeServerUrl } from '../src/utils/config.js';

const program = new Command();

program
  .name('claude-stats')
  .description('Claude Code usage statistics tracking')
  .version('1.0.0');

// 初始化配置
program
  .command('init')
  .description('Initialize configuration and install hook')
  .action(initCommand);

// 查看统计
program
  .command('stats')
  .description('View your usage statistics')
  .option('-u, --user <username>', 'View specific user stats')
  .action(statsCommand);

// 打开 Dashboard
program
  .command('dashboard')
  .description('Open web dashboard in browser')
  .action(dashboardCommand);

// 启用/禁用跟踪
program
  .command('toggle')
  .description('Enable or disable usage tracking')
  .action(toggleCommand);

// 配置管理
program
  .command('config')
  .description('View or update configuration')
  .option('-s, --show', 'Show current configuration')
  .option('-e, --edit', 'Edit configuration')
  .action(configCommand);

// 重置配置
program
  .command('reset')
  .description('Reset configuration and remove hook')
  .option('-f, --force', 'Skip confirmation')
  .action(resetCommand);

// Hook 版本信息
program
  .command('hook-version')
  .description('Show installed hook version information')
  .action(hookVersionCommand);

// 升级到 Hook v3
program
  .command('upgrade-to-v3')
  .description('Upgrade hook to v3 with optimized performance')
  .option('-f, --force', 'Force upgrade even if already on v3')
  .action(updateHookToV3Command);

// 通用 Hook 升级命令
program
  .command('upgrade-hook')
  .description('Upgrade hook to specified version or latest')
  .option('--target <version>', 'Target version to upgrade to (v2, v3, v4)', 'v4')
  .option('-f, --force', 'Force upgrade even if already on target version')
  .option('-l, --latest', 'Upgrade to latest version including shared modules')
  .action(upgradeHookCommand);

// 清理状态文件
program
  .command('cleanup')
  .description('Clean up state files and reset collection progress')
  .option('-f, --force', 'Skip confirmation')
  .action(cleanupCommand);

// 调试信息
program
  .command('debug')
  .description('Show debug information and state files status')
  .option('-l, --logs', 'Show recent log entries')
  .action(debugCommand);

// Codex 兼容命令
const codex = program
  .command('codex')
  .description('Codex compatibility commands');

codex
  .command('sync')
  .description('Sync Codex token usage from local rollout metadata')
  .option('--sessions-dir <path>', 'Override Codex sessions directory')
  .option('--batch-size <number>', 'Records to submit per request', '100')
  .option('--max-records <number>', 'Maximum records to submit in one run')
  .option('--quiet', 'Suppress progress output for hook usage')
  .option('--hook-output-json', 'Emit valid Codex hook JSON on successful quiet runs')
  .option('--dry-run', 'Parse and summarize without submitting data')
  .action(codexSyncCommand);

const codexHook = codex
  .command('hook')
  .description('Install or manage Codex Stop Hook auto-sync');

codexHook
  .command('install')
  .description('Install Codex Stop Hook auto-sync')
  .action(codexHookInstallCommand);

codexHook
  .command('status')
  .description('Show Codex Stop Hook auto-sync status')
  .action(codexHookStatusCommand);

codexHook
  .command('uninstall')
  .description('Remove Codex Stop Hook auto-sync')
  .option('--disable-feature', 'Also set codex_hooks = false in Codex config')
  .action(codexHookUninstallCommand);

// 默认命令 - 显示帮助或状态
program
  .action(async () => {
    const { checkConfig } = await import('../src/utils/config.js');
    const config = await checkConfig();
    
    if (!config) {
      console.log(chalk.yellow('⚠️  Claude Stats 未配置'));
      console.log(chalk.gray('运行 `claude-stats init` 开始配置'));
    } else {
      console.log(chalk.blue('📊 Claude Stats'));
      console.log(chalk.gray('─'.repeat(40)));
      console.log(`用户名: ${chalk.cyan(config.username)}`);
      console.log(`服务器: ${chalk.cyan(normalizeServerUrl(config.serverUrl))}`);
      console.log(`状态: ${config.enabled ? chalk.green('✓ 启用') : chalk.red('✗ 禁用')}`);
      console.log();
      console.log(chalk.gray('运行 `claude-stats --help` 查看所有命令'));
    }
  });

// 主函数
async function main() {
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    if (error.code === 'commander.help' || error.code === 'commander.helpDisplayed') {
      process.exit(0);
    }
    if (error.code === 'commander.unknownCommand' || error.code === 'commander.unknownOption') {
      console.error(chalk.red('错误:'), error.message);
      process.exit(1);
    }
    console.error(chalk.red('错误:'), error.message);
    process.exit(1);
  }
}

// 错误处理
program.exitOverride();

// 运行主函数
main();
