import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import path from 'path';
import { fileURLToPath } from 'url';
import db from './db/database.js';  // 导入单例
import usageRoutes from './routes/usage.js';
import statsRoutes from './routes/stats.js';
import { initPricingUpdater } from './utils/fetchPricing.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;

// 初始化数据库
await db.init();

// 初始化价格更新器
initPricingUpdater();

// 中间件
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(morgan('combined'));

// 静态文件服务 (Dashboard)
app.use(express.static(path.join(__dirname, 'public')));

// API 路由
app.use('/api/usage', usageRoutes);
app.use('/api/stats', statsRoutes);

// 健康检查
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    timestamp: new Date().toISOString(),
    database: db.isReady() ? 'connected' : 'disconnected',
    uptime: process.uptime()
  });
});

// 404 处理
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    res.status(404).json({ error: 'API endpoint not found' });
  } else {
    res.status(404).send('Page not found');
  }
});

// 错误处理
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// 启动服务器
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});

// 优雅关闭
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing gracefully...');
  await db.close();
  process.exit(0);
});