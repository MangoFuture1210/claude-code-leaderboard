import { Router } from 'express';
import db from '../db/database.js';
import { calculateCost } from '../utils/pricing.js';

const router = Router();

// 获取总体统计概览
router.get('/overview', async (req, res) => {
  try {
    const { period = '7d' } = req.query;
    
    // 获取统计数据
    const stats = await db.getStats(period);
    const rankings = await db.getUserRankings(10);
    const recent = await db.getRecentRecords(20);

    // 计算排行榜中每个用户的成本
    const rankingsWithCost = await Promise.all(rankings.map(async user => ({
      ...user,
      total_cost: await calculateCost({
        input_tokens: user.total_input_tokens || 0,
        output_tokens: user.total_output_tokens || 0,
        cache_creation_tokens: user.total_cache_creation_tokens || 0,
        cache_read_tokens: user.total_cache_read_tokens || 0,
        model: user.primary_model || 'claude-3-5-sonnet-20241022'
      })
    })));

    // 计算最近活动的成本
    const recentWithCost = await Promise.all(recent.map(async record => ({
      ...record,
      cost: await calculateCost(record)
    })));

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

export default router;