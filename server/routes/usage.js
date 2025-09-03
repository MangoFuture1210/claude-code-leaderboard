import { Router } from 'express';
import db from '../db/database.js';

const router = Router();

// 提交使用数据 (无需认证)
router.post('/submit', async (req, res) => {
  try {
    const { username, usage } = req.body;

    // 基础验证
    if (!username || !usage) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        details: 'Both username and usage data are required'
      });
    }

    // 验证用户名格式
    if (typeof username !== 'string' || username.length < 1 || username.length > 50) {
      return res.status(400).json({ 
        error: 'Invalid username',
        details: 'Username must be between 1 and 50 characters'
      });
    }

    // 处理单条或批量数据
    const records = Array.isArray(usage) ? usage : [usage];
    
    // 验证记录数量
    if (records.length === 0) {
      return res.status(400).json({ 
        error: 'No records to submit'
      });
    }

    if (records.length > 1000) {
      return res.status(400).json({ 
        error: 'Too many records',
        details: 'Maximum 1000 records per request'
      });
    }

    // 转换并验证数据格式
    const dbRecords = [];
    for (const record of records) {
      // 验证必需字段
      if (!record.timestamp || !record.tokens) {
        continue; // 跳过无效记录
      }

      // 确保 tokens 是对象
      const tokens = record.tokens || {};
      
      dbRecords.push({
        username,
        timestamp: record.timestamp,
        input_tokens: parseInt(tokens.input) || 0,
        output_tokens: parseInt(tokens.output) || 0,
        cache_creation_tokens: parseInt(tokens.cache_creation) || 0,
        cache_read_tokens: parseInt(tokens.cache_read) || 0,
        model: record.model || 'unknown',
        session_id: record.session_id || null,
        interaction_hash: record.interaction_hash || record.interaction_id || null
      });
    }

    if (dbRecords.length === 0) {
      return res.status(400).json({ 
        error: 'No valid records to submit'
      });
    }

    // 批量插入数据
    const result = await db.insertBatch(dbRecords);
    
    // 异步更新日统计（不影响响应）
    db.updateDailyStats().catch(error => {
      console.error('Failed to update daily stats:', error);
    });

    res.json({ 
      success: true,
      message: 'Data submitted successfully',
      inserted: result.inserted,
      skipped: result.total - result.inserted,
      total: result.total
    });

  } catch (error) {
    console.error('Usage submission error:', error);
    res.status(500).json({ 
      error: 'Failed to submit usage data',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// 获取服务器信息
router.get('/info', (req, res) => {
  res.json({
    version: '1.0.0',
    accepting_submissions: true,
    max_batch_size: 1000,
    supported_models: ['claude-3-opus', 'claude-3-sonnet', 'claude-3-haiku', 'unknown']
  });
});

export default router;