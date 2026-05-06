import chalk from 'chalk';
import inquirer from 'inquirer';
import open from 'open';
import path from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { appendFile, open as openFile, readFile, writeFile, unlink, mkdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { loadConfig, saveConfig, CONFIG_PATH, normalizeServerUrl } from '../utils/config.js';
import { installHook, uninstallHook, getCurrentHookVersion, cleanupStateFiles } from '../utils/hook-manager.js';
import { collectCodexUsageData, getCodexSessionsDir } from '../../hooks/shared/codex-collector.js';
import {
  getCodexDir,
  getCodexHookStatus,
  installCodexStopHook,
  uninstallCodexStopHook
} from '../utils/codex-hook-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_CLI_PATH = path.resolve(__dirname, '..', '..', 'bin', 'cli.js');
const CODEX_SYNC_LOCK_STALE_MS = 30 * 60 * 1000;

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
  
  // 安装 Hook (使用 v4)
  console.log();
  console.log(chalk.gray('正在安装 Hook v4...'));

  try {
    await installHook(config, 'v4');
    console.log(chalk.green('✓ Hook v4 安装成功'));
    console.log(chalk.gray('  包含: 增量扫描、Set去重、节流机制、预算制发送'));
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
  console.log(chalk.gray(`访问 ${chalk.cyan(normalizeServerUrl(config.serverUrl))} 查看 Dashboard`));
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
    
    const response = await fetch(`${normalizeServerUrl(config.serverUrl)}/api/stats/user/${username}`);
    
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
  
  const dashboardUrl = normalizeServerUrl(config.serverUrl);
  console.log(chalk.blue(`正在打开 Dashboard: ${dashboardUrl}`));
  
  try {
    await open(dashboardUrl);
    console.log(chalk.green('✓ Dashboard 已在浏览器中打开'));
  } catch (error) {
    console.error(chalk.red('✗ 无法打开浏览器'));
    console.log(chalk.gray(`请手动访问: ${chalk.cyan(dashboardUrl)}`));
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

async function sendUsageBatch(config, entries) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  let response;
  try {
    response = await fetch(`${normalizeServerUrl(config.serverUrl)}/api/usage/submit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'claude-stats-codex-sync/1.0'
      },
      signal: controller.signal,
      body: JSON.stringify({
        username: config.username,
        usage: entries
      })
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return await response.json();
}

async function loadCodexState(statePath) {
  try {
    if (!existsSync(statePath)) {
      return {
        version: '1.0.0',
        recentHashes: {},
        lastSyncAt: null
      };
    }

    const content = await readFile(statePath, 'utf-8');
    const state = JSON.parse(content);
    return {
      version: '1.0.0',
      recentHashes: state.recentHashes || {},
      lastSyncAt: state.lastSyncAt || null
    };
  } catch {
    return {
      version: '1.0.0',
      recentHashes: {},
      lastSyncAt: null
    };
  }
}

async function saveCodexState(statePath, state) {
  await writeFile(statePath, JSON.stringify(state, null, 2), 'utf-8');
}

function getCodexSyncPaths() {
  const configDir = path.dirname(CONFIG_PATH);
  return {
    statePath: path.join(configDir, 'codex-stats-state.json'),
    lockPath: path.join(configDir, 'codex-sync.lock'),
    logPath: path.join(configDir, 'codex-sync.log')
  };
}

function maybePrintCodexHookOutput(options) {
  if (options.hookOutputJson) {
    console.log('{}');
  }
}

export function isCodexHookOutputMode(options = {}) {
  return Boolean(options.quiet && options.hookOutputJson);
}

export function parsePositiveInteger(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function appendCodexSyncLog(logPath, entry) {
  try {
    await mkdir(path.dirname(logPath), { recursive: true });
    await appendFile(logPath, JSON.stringify({
      timestamp: new Date().toISOString(),
      ...entry
    }) + '\n', 'utf-8');
  } catch {
    // Logging should never prevent sync.
  }
}

export function limitCodexSyncEntries(entries, maxRecords) {
  const max = parsePositiveInteger(maxRecords);
  return max ? entries.slice(0, max) : entries;
}

export async function acquireCodexSyncLock(lockPath) {
  await mkdir(path.dirname(lockPath), { recursive: true });

  if (existsSync(lockPath)) {
    try {
      const lockData = JSON.parse(await readFile(lockPath, 'utf-8'));
      const age = Date.now() - new Date(lockData.timestamp).getTime();
      if (!Number.isFinite(age) || age > CODEX_SYNC_LOCK_STALE_MS) {
        await unlink(lockPath).catch(() => {});
      } else {
        return null;
      }
    } catch {
      await unlink(lockPath).catch(() => {});
    }
  }

  try {
    const fd = await openFile(lockPath, 'wx');
    await fd.writeFile(JSON.stringify({
      pid: process.pid,
      timestamp: new Date().toISOString()
    }));
    await fd.close();
  } catch (error) {
    if (error.code === 'EEXIST') return null;
    throw error;
  }

  return async () => {
    await unlink(lockPath).catch(() => {});
  };
}

function updateCodexStateHashes(state, entries) {
  for (const entry of entries) {
    const dayKey = entry.timestamp.split('T')[0];
    if (!state.recentHashes[dayKey]) {
      state.recentHashes[dayKey] = [];
    }
    state.recentHashes[dayKey].push(entry.interaction_hash);
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const cutoffKey = cutoff.toISOString().split('T')[0];

  for (const dayKey of Object.keys(state.recentHashes)) {
    if (dayKey < cutoffKey) {
      delete state.recentHashes[dayKey];
    }
  }

  state.lastSyncAt = new Date().toISOString();
}

export async function codexSyncCommand(options = {}) {
  const startedAt = Date.now();
  const config = await loadConfig();

  if (!config) {
    maybePrintCodexHookOutput(options);
    if (!options.quiet) {
      console.log(chalk.red('❌ 未找到配置'));
      console.log(chalk.gray('请先运行 `claude-stats init` 进行配置'));
    }
    return;
  }

  if (!config.enabled) {
    maybePrintCodexHookOutput(options);
    if (!options.quiet) {
      console.log(chalk.yellow('⚠️  数据跟踪当前已禁用'));
      console.log(chalk.gray('运行 `claude-stats toggle` 启用后再同步'));
    }
    return;
  }

  const sessionsDir = options.sessionsDir || getCodexSessionsDir();
  const { statePath, lockPath, logPath } = getCodexSyncPaths();
  const releaseLock = await acquireCodexSyncLock(lockPath);

  if (!releaseLock) {
    await appendCodexSyncLog(logPath, {
      status: 'skipped',
      reason: 'lock-active'
    });

      if (!options.quiet) {
        console.log(chalk.yellow('⚠️  Codex sync is already running'));
      }
      maybePrintCodexHookOutput(options);
    return;
  }

  const state = await loadCodexState(statePath);
  let entries = [];
  let inserted = 0;
  let skipped = 0;

  try {
    if (!options.quiet) {
      console.log(chalk.blue('🤖 Codex 使用数据同步'));
      console.log(chalk.gray('─'.repeat(40)));
      console.log(`${chalk.gray('Sessions:')} ${sessionsDir}`);
    }

    entries = await collectCodexUsageData(state, { sessionsDir });
    entries = limitCodexSyncEntries(entries, options.maxRecords);

    if (entries.length === 0) {
      await appendCodexSyncLog(logPath, {
        status: 'success',
        records: 0,
        inserted: 0,
        skipped: 0,
        durationMs: Date.now() - startedAt
      });

      if (!options.quiet) {
        console.log(chalk.green('✓ 没有新的 Codex 使用记录需要同步'));
      }
      maybePrintCodexHookOutput(options);
      return;
    }

    const totalTokens = entries.reduce((sum, entry) => {
      const tokens = entry.tokens || {};
      return sum + (tokens.input || 0) + (tokens.output || 0) +
        (tokens.cache_creation || 0) + (tokens.cache_read || 0);
    }, 0);

    if (!options.quiet) {
      console.log(`${chalk.gray('待同步记录:')} ${chalk.cyan(entries.length)}`);
      console.log(`${chalk.gray('Token 总数:')} ${chalk.yellow(formatNumber(totalTokens))}`);
    }

    if (options.dryRun) {
      if (!options.quiet) {
        console.log(chalk.yellow('Dry run: 未发送数据，也未更新同步状态'));
      }
      maybePrintCodexHookOutput(options);
      return;
    }

    const batchSize = parsePositiveInteger(options.batchSize, 100);

    for (let index = 0; index < entries.length; index += batchSize) {
      const batch = entries.slice(index, index + batchSize);
      const batchNumber = Math.floor(index / batchSize) + 1;
      const batchTotal = Math.ceil(entries.length / batchSize);
      if (!options.quiet) {
        console.log(chalk.gray(`正在发送批次 ${batchNumber}/${batchTotal} (${batch.length} 条)...`));
      }

      const result = await sendUsageBatch(config, batch);
      inserted += result.inserted || 0;
      skipped += result.skipped || 0;
    }

    updateCodexStateHashes(state, entries);
    await saveCodexState(statePath, state);

    await appendCodexSyncLog(logPath, {
      status: 'success',
      records: entries.length,
      inserted,
      skipped,
      durationMs: Date.now() - startedAt
    });

    if (options.hookOutputJson) {
      maybePrintCodexHookOutput(options);
    } else if (options.quiet) {
      console.log(`Codex sync complete: inserted=${inserted} skipped=${skipped} records=${entries.length}`);
    } else {
      console.log(chalk.green('✓ Codex 使用数据同步完成'));
      console.log(`${chalk.gray('新增:')} ${chalk.green(inserted)}`);
      console.log(`${chalk.gray('跳过:')} ${chalk.yellow(skipped)}`);
    }
  } catch (error) {
    await appendCodexSyncLog(logPath, {
      status: 'error',
      records: entries.length,
      inserted,
      skipped,
      durationMs: Date.now() - startedAt,
      error: error.message
    });
    if (isCodexHookOutputMode(options)) {
      maybePrintCodexHookOutput(options);
      return;
    }
    throw error;
  } finally {
    await releaseLock();
  }
}

export async function codexHookInstallCommand() {
  const config = await loadConfig();

  if (!config) {
    console.log(chalk.red('❌ 未找到配置'));
    console.log(chalk.gray('请先运行 `claude-stats init` 进行配置'));
    return;
  }

  if (!config.enabled) {
    console.log(chalk.yellow('⚠️  数据跟踪当前已禁用'));
    console.log(chalk.gray('运行 `claude-stats toggle` 启用后再安装 Codex Hook'));
    return;
  }

  const result = await installCodexStopHook({
    cliPath: CLIENT_CLI_PATH,
    codexDir: getCodexDir()
  });
  const { statePath, lockPath, logPath } = getCodexSyncPaths();

  console.log(chalk.green('✓ Codex Stop Hook 已安装'));
  console.log(`${chalk.gray('配置文件:')} ${result.configPath}`);
  console.log(`${chalk.gray('Hook 文件:')} ${result.hooksPath}`);
  console.log(`${chalk.gray('命令:')} ${result.command}`);
  console.log(`${chalk.gray('状态文件:')} ${statePath}`);
  console.log(`${chalk.gray('锁文件:')} ${lockPath}`);
  console.log(`${chalk.gray('日志文件:')} ${logPath}`);
}

export async function codexHookStatusCommand() {
  const status = await getCodexHookStatus({
    cliPath: CLIENT_CLI_PATH,
    codexDir: getCodexDir()
  });
  const { statePath, lockPath, logPath } = getCodexSyncPaths();

  console.log(chalk.blue('🤖 Codex Hook 状态'));
  console.log(chalk.gray('─'.repeat(40)));
  console.log(`${chalk.gray('codex_hooks:')} ${status.featureEnabled ? chalk.green('enabled') : chalk.yellow('disabled')}`);
  console.log(`${chalk.gray('Stop Hook:')} ${status.hookInstalled ? chalk.green('installed') : chalk.yellow('not installed')}`);
  console.log(`${chalk.gray('配置文件:')} ${status.configPath}`);
  console.log(`${chalk.gray('Hook 文件:')} ${status.hooksPath}`);
  console.log(`${chalk.gray('命令:')} ${status.command || '-'}`);
  console.log(`${chalk.gray('超时:')} ${status.timeout || '-'}`);
  console.log(`${chalk.gray('状态消息:')} ${status.statusMessage || '-'}`);
  console.log(`${chalk.gray('状态文件:')} ${statePath}`);
  console.log(`${chalk.gray('锁文件:')} ${lockPath}`);
  console.log(`${chalk.gray('日志文件:')} ${logPath}`);
}

export async function codexHookUninstallCommand(options = {}) {
  const result = await uninstallCodexStopHook({
    codexDir: getCodexDir(),
    disableFeature: Boolean(options.disableFeature)
  });

  if (result.removed) {
    console.log(chalk.green('✓ Codex Stop Hook 已移除'));
  } else {
    console.log(chalk.yellow('⚠️  未找到已安装的 Codex Stop Hook'));
  }

  if (result.featureDisabled) {
    console.log(chalk.green('✓ codex_hooks feature 已禁用'));
  }

  console.log(`${chalk.gray('配置文件:')} ${result.configPath}`);
  console.log(`${chalk.gray('Hook 文件:')} ${result.hooksPath}`);
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

// 升级到 Hook v3
export async function updateHookToV3Command(options = {}) {
  const config = await loadConfig();
  
  if (!config) {
    console.log(chalk.red('❌ 未找到配置'));
    console.log(chalk.gray('请先运行 `claude-stats init` 进行配置'));
    return;
  }
  
  const currentVersion = await getCurrentHookVersion();
  
  if (currentVersion?.version === 'v3' && !options.force) {
    console.log(chalk.yellow('⚠️  已经是 v3 版本'));
    console.log(chalk.gray('使用 --force 强制更新到最新版'));
    return;
  }
  
  console.log(chalk.blue('🚀 升级 Hook 到 v3'));
  console.log();
  console.log(chalk.gray('v3 版本优化:'));
  console.log('  - 动态批次大小：根据数据量自动调整（100/500/1000条）');
  console.log('  - 超时保护：防止处理大量数据时卡死');
  console.log('  - 进度报告：实时显示处理进度');
  console.log('  - 性能优化：处理速度提升 4-5 倍');
  console.log('  - 更好的错误恢复：精确记录失败数据');
  console.log();
  console.log(chalk.yellow('📊 性能对比:'));
  console.log('  v2: 处理 20,000 条数据可能卡死');
  console.log('  v3: 处理 20,000 条数据约需 45 秒');
  console.log();
  
  const { confirm } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirm',
      message: '确定要升级到 v3 吗？',
      default: true
    }
  ]);
  
  if (!confirm) {
    console.log(chalk.gray('升级已取消'));
    return;
  }
  
  try {
    console.log(chalk.gray('正在升级...'));
    await installHook(config, 'v3');
    console.log(chalk.green('✓ 成功升级到 v3'));
    console.log();
    console.log(chalk.green('🎉 恭喜！您现在使用的是最新优化版本'));
  } catch (error) {
    console.error(chalk.red('✗ 升级失败:'), error.message);
  }
}

// 通用 Hook 升级命令
export async function upgradeHookCommand(options = {}) {
  const config = await loadConfig();
  
  if (!config) {
    console.log(chalk.red('❌ 未找到配置'));
    console.log(chalk.gray('请先运行 `claude-stats init` 进行配置'));
    return;
  }
  
  const currentVersion = await getCurrentHookVersion();
  const targetVersion = options.target || 'v4';
  const isLatest = options.latest || !options.target;
  
  console.log(chalk.blue(`🚀 Hook 升级工具`));
  console.log(chalk.gray('─'.repeat(40)));
  
  // 显示当前状态
  if (currentVersion) {
    console.log(`${chalk.gray('当前版本:')} ${chalk.cyan(currentVersion.version)}`);
    console.log(`${chalk.gray('安装时间:')} ${formatDate(currentVersion.installedAt)}`);
  } else {
    console.log(`${chalk.gray('当前版本:')} ${chalk.yellow('未安装')}`);
  }
  
  console.log(`${chalk.gray('目标版本:')} ${chalk.cyan(targetVersion)}`);
  console.log();
  
  // 版本检查
  if (currentVersion?.version === targetVersion && !options.force && !isLatest) {
    console.log(chalk.yellow(`⚠️  已经是 ${targetVersion} 版本`));
    console.log(chalk.gray('使用 --force 强制更新或 --latest 更新到最新版本'));
    return;
  }
  
  // 显示版本特性
  const versionFeatures = getVersionFeatures(targetVersion);
  if (versionFeatures) {
    console.log(chalk.gray(`${targetVersion} 版本特性:`));
    versionFeatures.forEach(feature => console.log(`  - ${feature}`));
    console.log();
  }
  
  // 确认升级
  const upgradeMessage = isLatest 
    ? `确定要升级到最新版本 (${targetVersion}) 吗？`
    : `确定要升级到 ${targetVersion} 吗？`;
    
  const { confirm } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirm',
      message: upgradeMessage,
      default: true
    }
  ]);
  
  if (!confirm) {
    console.log(chalk.gray('升级已取消'));
    return;
  }
  
  try {
    console.log(chalk.gray('正在备份当前配置...'));
    await backupCurrentHook();
    
    console.log(chalk.gray(`正在升级到 ${targetVersion}...`));
    await installHook(config, targetVersion, { 
      force: options.force,
      latest: isLatest 
    });
    
    console.log(chalk.green(`✓ 成功升级到 ${targetVersion}`));
    
    if (isLatest) {
      console.log(chalk.green('✓ 已更新到最新版本，包含所有共享模块'));
    }
    
    console.log();
    console.log(chalk.green('🎉 Hook 升级完成！'));
    console.log(chalk.gray('新的 Hook 将在下次 Claude Code 会话结束时生效'));
    
  } catch (error) {
    console.error(chalk.red('✗ 升级失败:'), error.message);
    console.log(chalk.yellow('正在尝试恢复...'));
    
    try {
      await restoreHookBackup();
      console.log(chalk.green('✓ 已恢复到之前的版本'));
    } catch (restoreError) {
      console.error(chalk.red('✗ 恢复失败:'), restoreError.message);
      console.log(chalk.gray('请手动运行 `claude-stats init` 重新安装'));
    }
  }
}

// 获取版本特性描述
function getVersionFeatures(version) {
  const features = {
    'v2': [
      '基础数据收集和上传',
      '简单的错误处理',
      '适合小量数据处理'
    ],
    'v3': [
      '动态批次大小：根据数据量自动调整（100/500/1000条）',
      '超时保护：防止处理大量数据时卡死',
      '进度报告：实时显示处理进度',
      '性能优化：处理速度提升 4-5 倍',
      '更好的错误恢复：精确记录失败数据',
      '共享模块架构：消除代码重复'
    ],
    'v4': [
      '增量扫描：基于 byte offset 只读新增内容，避免全量扫描',
      'Set 去重：O(1) 哈希查找，替代 Array.includes O(n)',
      '节流机制：30 秒内重复触发直接退出',
      '预算制发送：总共最多 10 秒，无重试，超时立即停止',
      '快速失败锁：1 秒锁超时，避免长时间等待',
      '自动迁移：首次运行自动从 v3 state 迁移'
    ]
  };
  
  return features[version] || null;
}

// 备份当前 Hook
async function backupCurrentHook() {
  const hookPath = path.join(homedir(), '.claude', 'claude_stats_hook.js');
  const backupPath = path.join(homedir(), '.claude', 'claude_stats_hook.js.backup');
  
  if (existsSync(hookPath)) {
    await writeFile(backupPath, await readFile(hookPath));
  }
}

// 恢复 Hook 备份
async function restoreHookBackup() {
  const hookPath = path.join(homedir(), '.claude', 'claude_stats_hook.js');
  const backupPath = path.join(homedir(), '.claude', 'claude_stats_hook.js.backup');
  
  if (existsSync(backupPath)) {
    await writeFile(hookPath, await readFile(backupPath));
    await unlink(backupPath);
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
