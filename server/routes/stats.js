import { Router } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import db from '../db/database.js';
import { calculateCost } from '../utils/pricing.js';
import { getStorageConfig, getDataDir } from '../utils/dataDir.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const router = Router();

// 获取总体统计概览
router.get('/overview', async (req, res) => {
  try {
    const { period = '7d' } = req.query;
    
    console.log('Getting overview stats for period:', period);
    
    // 获取统计数据
    const stats = await db.getStats(period);
    console.log('Stats result:', stats);
    
    const rankings = await db.getUserRankings(10);
    console.log('Rankings count:', rankings?.length || 0);
    
    const recent = await db.getRecentRecords(20);
    console.log('Recent records count:', recent?.length || 0);

    // 计算排行榜中每个用户的成本 - 按实际使用的模型计算
    const rankingsWithCost = await Promise.all(rankings.map(async user => {
      try {
        // 获取该用户的所有记录，按模型分组计算
        const userRecords = await db.db.all(`
          SELECT 
            model,
            SUM(input_tokens) as total_input_tokens,
            SUM(output_tokens) as total_output_tokens,
            SUM(cache_creation_tokens) as total_cache_creation_tokens,
            SUM(cache_read_tokens) as total_cache_read_tokens
          FROM usage_records 
          WHERE username = ?
          GROUP BY model
        `, [user.username]);
        
        // 按模型分别计算成本，然后求和
        let totalCost = 0;
        for (const record of userRecords) {
          const recordCost = await calculateCost({
            input_tokens: record.total_input_tokens || 0,
            output_tokens: record.total_output_tokens || 0,
            cache_creation_tokens: record.total_cache_creation_tokens || 0,
            cache_read_tokens: record.total_cache_read_tokens || 0,
            model: record.model
          });
          totalCost += recordCost;
        }
        
        return { ...user, total_cost: totalCost };
      } catch (error) {
        console.error('Error calculating cost for user:', user.username, error);
        return { ...user, total_cost: 0 };
      }
    }));

    // 计算最近活动的成本（添加错误处理）
    const recentWithCost = await Promise.all(recent.map(async record => {
      try {
        const cost = await calculateCost(record);
        return { ...record, cost };
      } catch (error) {
        console.error('Error calculating cost for record:', error);
        return { ...record, cost: 0 };
      }
    }));

    res.json({
      period,
      stats: {
        userCount: stats.user_count,
        recordCount: stats.record_count,
        totalTokens: stats.total_tokens,
        totalInput: stats.total_input,
        totalOutput: stats.total_output,
        sessionCount: stats.session_count
      },
      rankings: rankingsWithCost,
      recent: recentWithCost
    });
  } catch (error) {
    console.error('Overview stats error:', error);
    res.status(500).json({ 
      error: 'Failed to get overview stats'
    });
  }
});

// 获取用户排行榜
router.get('/rankings', async (req, res) => {
  try {
    const { limit = 50 } = req.query;
    const rankings = await db.getUserRankings(parseInt(limit) || 50);
    
    res.json({
      rankings,
      total: rankings.length,
      generated: new Date().toISOString()
    });
  } catch (error) {
    console.error('Rankings error:', error);
    res.status(500).json({ 
      error: 'Failed to get rankings'
    });
  }
});

// 获取特定用户统计
router.get('/user/:username', async (req, res) => {
  try {
    const { username } = req.params;
    
    // 验证用户名
    if (!username || username.length > 50) {
      return res.status(400).json({ 
        error: 'Invalid username'
      });
    }

    const stats = await db.getUserStats(username);
    
    if (!stats) {
      return res.status(404).json({ 
        error: 'User not found',
        username
      });
    }

    res.json({
      username: stats.username,
      stats: {
        totalTokens: stats.total_tokens,
        totalInput: stats.total_input,
        totalOutput: stats.total_output,
        sessionCount: stats.session_count,
        recordCount: stats.record_count,
        firstUse: stats.first_use,
        lastUse: stats.last_use
      }
    });
  } catch (error) {
    console.error('User stats error:', error);
    res.status(500).json({ 
      error: 'Failed to get user stats'
    });
  }
});

// 获取趋势数据
router.get('/trends', async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const trends = await db.getTrends(parseInt(days) || 30);
    
    res.json({
      trends: trends.map(item => ({
        date: item.date,
        users: item.users,
        tokens: item.tokens,
        interactions: item.interactions
      })),
      period: `${days} days`,
      generated: new Date().toISOString()
    });
  } catch (error) {
    console.error('Trends error:', error);
    res.status(500).json({ 
      error: 'Failed to get trends'
    });
  }
});

// 获取实时活动
router.get('/activity', async (req, res) => {
  try {
    const { limit = 50 } = req.query;
    const recent = await db.getRecentRecords(parseInt(limit) || 50);
    
    res.json({
      activity: recent,
      count: recent.length,
      generated: new Date().toISOString()
    });
  } catch (error) {
    console.error('Activity error:', error);
    res.status(500).json({ 
      error: 'Failed to get activity'
    });
  }
});

// 获取存储配置
router.get('/config', async (req, res) => {
  try {
    const config = getStorageConfig();
    res.json(config);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get configuration',
      message: error.message
    });
  }
});

// 获取按模型分组的统计数据
router.get('/models', async (req, res) => {
  try {
    const modelStats = await db.db.all(`
      SELECT 
        model,
        COUNT(*) as sessions,
        SUM(input_tokens) as total_input_tokens,
        SUM(output_tokens) as total_output_tokens,
        SUM(cache_creation_tokens) as total_cache_write_tokens,
        SUM(cache_read_tokens) as total_cache_read_tokens,
        SUM(total_tokens) as total_all_tokens
      FROM usage_records 
      GROUP BY model
      ORDER BY total_all_tokens DESC
    `);
    
    // 计算每个模型的成本
    const modelsWithCost = await Promise.all(modelStats.map(async stat => {
      try {
        const cost = await calculateCost({
          input_tokens: stat.total_input_tokens || 0,
          output_tokens: stat.total_output_tokens || 0,
          cache_creation_tokens: stat.total_cache_write_tokens || 0,
          cache_read_tokens: stat.total_cache_read_tokens || 0,
          model: stat.model
        });
        return { ...stat, total_cost: cost };
      } catch (error) {
        console.error('Error calculating cost for model:', stat.model, error);
        return { ...stat, total_cost: 0 };
      }
    }));
    
    // 计算总计
    const totals = modelsWithCost.reduce((acc, model) => ({
      total_sessions: acc.total_sessions + model.sessions,
      total_tokens: acc.total_tokens + model.total_all_tokens,
      total_cost: acc.total_cost + model.total_cost
    }), { total_sessions: 0, total_tokens: 0, total_cost: 0 });
    
    res.json({
      models: modelsWithCost,
      totals,
      generated: new Date().toISOString()
    });
  } catch (error) {
    console.error('Model stats error:', error);
    res.status(500).json({ 
      error: 'Failed to get model stats'
    });
  }
});

// 调试端点 - 检查数据库状态
router.get('/debug', async (req, res) => {
  try {
    // 直接执行简单查询
    const tables = await db.db.all(`
      SELECT name FROM sqlite_master 
      WHERE type='table' 
      ORDER BY name
    `);
    
    const userCount = await db.db.get('SELECT COUNT(*) as count FROM users');
    const recordCount = await db.db.get('SELECT COUNT(*) as count FROM usage_records');
    const viewTest = await db.db.all('SELECT * FROM user_rankings LIMIT 3');
    
    // 获取数据目录和文件路径
    const dataDir = getDataDir();
    const pricingPath = path.join(dataDir, 'pricing.json');
    
    let pricingExists = false;
    try {
      await fs.access(pricingPath);
      pricingExists = true;
    } catch (e) {
      pricingExists = false;
    }
    
    // 获取存储配置
    const storageConfig = getStorageConfig();
    
    res.json({
      environment: {
        DATA_DIR: process.env.DATA_DIR || 'not set (using source directory)',
        data_directory: dataDir,
        persistent_storage: storageConfig.persistent_storage,
        database_file: db.dbPath,
        pricing_file: pricingPath,
        pricing_exists: pricingExists
      },
      database: {
        tables: tables.map(t => t.name),
        user_count: userCount?.count || 0,
        record_count: recordCount?.count || 0,
        view_working: viewTest.length > 0
      },
      storage_warning: storageConfig.warning,
      sample_data: viewTest
    });
  } catch (error) {
    res.status(500).json({
      error: error.message,
      stack: error.stack
    });
  }
});

export default router;