import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class Database {
  constructor() {
    // 在 Render 上使用 /data 目录，本地使用项目目录
    this.dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'stats.db');
    this.db = null;
  }

  async init() {
    try {
      // 确保数据目录存在
      const dir = path.dirname(this.dbPath);
      await fs.mkdir(dir, { recursive: true });

      // 打开数据库连接
      this.db = await open({
        filename: this.dbPath,
        driver: sqlite3.Database
      });

      // 启用 WAL 模式以提升并发性能
      await this.db.exec('PRAGMA journal_mode = WAL');
      await this.db.exec('PRAGMA synchronous = NORMAL');
      await this.db.exec('PRAGMA busy_timeout = 5000');

      // 初始化表结构
      await this.initTables();
      
      console.log('Database initialized at:', this.dbPath);
      return true;
    } catch (error) {
      console.error('Database initialization failed:', error);
      throw error;
    }
  }

  async initTables() {
    // 创建使用记录表
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS usage_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        timestamp DATETIME NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_creation_tokens INTEGER DEFAULT 0,
        cache_read_tokens INTEGER DEFAULT 0,
        total_tokens INTEGER GENERATED ALWAYS AS 
          (input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens) STORED,
        model TEXT,
        session_id TEXT,
        interaction_hash TEXT UNIQUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 创建日统计表
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS daily_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        date DATE NOT NULL,
        total_input_tokens INTEGER DEFAULT 0,
        total_output_tokens INTEGER DEFAULT 0,
        total_cache_tokens INTEGER DEFAULT 0,
        session_count INTEGER DEFAULT 0,
        interaction_count INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(username, date)
      )
    `);

    // 创建用户表
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
        total_usage INTEGER DEFAULT 0,
        session_count INTEGER DEFAULT 0
      )
    `);

    // 创建索引
    await this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_usage_username_time 
        ON usage_records(username, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_usage_interaction 
        ON usage_records(interaction_hash);
      CREATE INDEX IF NOT EXISTS idx_usage_timestamp 
        ON usage_records(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_daily_stats_date 
        ON daily_stats(date DESC);
      CREATE INDEX IF NOT EXISTS idx_daily_stats_username 
        ON daily_stats(username);
    `);

    // 创建触发器自动维护用户表
    await this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS update_user_stats 
      AFTER INSERT ON usage_records
      BEGIN
        INSERT INTO users (username, total_usage, session_count)
        VALUES (NEW.username, NEW.total_tokens, 1)
        ON CONFLICT(username) DO UPDATE SET
          last_seen = CURRENT_TIMESTAMP,
          total_usage = total_usage + NEW.total_tokens,
          session_count = session_count + 
            CASE WHEN NEW.session_id NOT IN (
              SELECT DISTINCT session_id FROM usage_records 
              WHERE username = NEW.username AND id < NEW.id
            ) THEN 1 ELSE 0 END;
      END;
    `);

    // 创建视图
    await this.db.exec(`
      CREATE VIEW IF NOT EXISTS user_rankings AS
      SELECT 
        username,
        total_usage,
        session_count,
        RANK() OVER (ORDER BY total_usage DESC) as rank,
        first_seen,
        last_seen
      FROM users
      ORDER BY total_usage DESC;
    `);

    await this.db.exec(`
      CREATE VIEW IF NOT EXISTS recent_activity AS
      SELECT 
        username,
        COUNT(*) as activity_count,
        SUM(total_tokens) as total_tokens,
        MAX(timestamp) as last_activity
      FROM usage_records
      WHERE timestamp > datetime('now', '-7 days')
      GROUP BY username
      ORDER BY total_tokens DESC;
    `);
  }

  // 插入单条使用记录
  async insertUsageRecord(record) {
    const sql = `
      INSERT OR IGNORE INTO usage_records (
        username, timestamp, input_tokens, output_tokens,
        cache_creation_tokens, cache_read_tokens,
        model, session_id, interaction_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    try {
      const result = await this.db.run(sql, [
        record.username,
        record.timestamp,
        record.input_tokens,
        record.output_tokens,
        record.cache_creation_tokens || 0,
        record.cache_read_tokens || 0,
        record.model,
        record.session_id,
        record.interaction_hash
      ]);
      
      return { success: true, inserted: result.changes > 0 };
    } catch (error) {
      console.error('Insert error:', error);
      return { success: false, error: error.message };
    }
  }

  // 批量插入使用记录
  async insertBatch(records) {
    const stmt = await this.db.prepare(`
      INSERT OR IGNORE INTO usage_records (
        username, timestamp, input_tokens, output_tokens,
        cache_creation_tokens, cache_read_tokens,
        model, session_id, interaction_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let inserted = 0;
    let failed = 0;

    for (const record of records) {
      try {
        const result = await stmt.run(
          record.username,
          record.timestamp,
          record.input_tokens,
          record.output_tokens,
          record.cache_creation_tokens || 0,
          record.cache_read_tokens || 0,
          record.model,
          record.session_id,
          record.interaction_hash
        );
        if (result.changes > 0) inserted++;
      } catch (error) {
        console.error('Batch insert error:', error);
        failed++;
      }
    }

    await stmt.finalize();
    
    return { inserted, failed, total: records.length };
  }

  // 获取总体统计
  async getStats(period = '7d') {
    const periodMap = {
      '1d': '1 day',
      '7d': '7 days',
      '30d': '30 days',
      'all': '100 years'
    };

    const sql = `
      SELECT 
        COUNT(DISTINCT username) as user_count,
        COUNT(*) as record_count,
        COALESCE(SUM(total_tokens), 0) as total_tokens,
        COALESCE(SUM(input_tokens), 0) as total_input,
        COALESCE(SUM(output_tokens), 0) as total_output,
        COUNT(DISTINCT session_id) as session_count
      FROM usage_records
      WHERE timestamp > datetime('now', '-${periodMap[period] || '7 days'}')
    `;

    return await this.db.get(sql);
  }

  // 获取用户排行榜
  async getUserRankings(limit = 20) {
    const sql = `
      SELECT * FROM user_rankings
      LIMIT ?
    `;

    return await this.db.all(sql, [limit]);
  }

  // 获取最近记录
  async getRecentRecords(limit = 100) {
    const sql = `
      SELECT 
        username, timestamp, model,
        input_tokens, output_tokens, total_tokens,
        session_id
      FROM usage_records
      ORDER BY timestamp DESC
      LIMIT ?
    `;

    return await this.db.all(sql, [limit]);
  }

  // 获取用户统计
  async getUserStats(username) {
    const sql = `
      SELECT 
        username,
        COUNT(*) as record_count,
        COALESCE(SUM(total_tokens), 0) as total_tokens,
        COALESCE(SUM(input_tokens), 0) as total_input,
        COALESCE(SUM(output_tokens), 0) as total_output,
        COUNT(DISTINCT session_id) as session_count,
        MIN(timestamp) as first_use,
        MAX(timestamp) as last_use
      FROM usage_records
      WHERE username = ?
      GROUP BY username
    `;

    return await this.db.get(sql, [username]);
  }

  // 获取趋势数据
  async getTrends(days = 30) {
    const sql = `
      SELECT 
        DATE(timestamp) as date,
        COUNT(DISTINCT username) as users,
        COALESCE(SUM(total_tokens), 0) as tokens,
        COUNT(*) as interactions
      FROM usage_records
      WHERE timestamp > datetime('now', '-${days} days')
      GROUP BY DATE(timestamp)
      ORDER BY date DESC
    `;

    return await this.db.all(sql);
  }

  // 更新日统计
  async updateDailyStats() {
    const sql = `
      INSERT INTO daily_stats (username, date, total_input_tokens, 
        total_output_tokens, total_cache_tokens, session_count, interaction_count)
      SELECT 
        username,
        DATE(timestamp) as date,
        SUM(input_tokens),
        SUM(output_tokens),
        SUM(cache_creation_tokens + cache_read_tokens),
        COUNT(DISTINCT session_id),
        COUNT(*)
      FROM usage_records
      WHERE DATE(timestamp) = DATE('now')
      GROUP BY username, DATE(timestamp)
      ON CONFLICT(username, date) DO UPDATE SET
        total_input_tokens = excluded.total_input_tokens,
        total_output_tokens = excluded.total_output_tokens,
        total_cache_tokens = excluded.total_cache_tokens,
        session_count = excluded.session_count,
        interaction_count = excluded.interaction_count
    `;

    await this.db.exec(sql);
  }

  isReady() {
    return this.db !== null;
  }

  async close() {
    if (this.db) {
      await this.db.close();
      this.db = null;
    }
  }
}

// 导出单例
export default new Database();