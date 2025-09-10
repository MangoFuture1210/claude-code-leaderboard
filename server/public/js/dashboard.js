class Dashboard {
  constructor() {
    this.charts = {};
    this.data = {};
    this.initAttempts = 0;  // 记录初始化尝试次数
    this.startTime = Date.now();  // 记录开始时间
    this.init();
  }

  async init() {
    console.log(`[Dashboard] Init attempt #${++this.initAttempts} at ${this.getElapsedTime()}ms`);
    
    // 检查 Chart.js 是否真正就绪
    if (typeof Chart === 'undefined') {
      console.error('[Dashboard] Chart.js not loaded, retrying in 100ms...');
      setTimeout(() => this.init(), 100);
      return;
    }
    
    console.log('[Dashboard] Chart.js is available');
    
    await this.checkStorageConfig();
    this.setupEventListeners();
    
    // 尝试多种初始化策略
    await this.initChartsWithRetry();
    
    // 加载数据
    console.log(`[Dashboard] Loading data at ${this.getElapsedTime()}ms`);
    await this.loadData();
    
    // 设置自动刷新
    setInterval(() => {
      console.log(`[Dashboard] Auto-refresh at ${this.getElapsedTime()}ms`);
      this.loadData();
    }, 60000);
  }

  async initChartsWithRetry() {
    console.log(`[Dashboard] Attempting chart init at ${this.getElapsedTime()}ms`);
    
    // 如果图表已经初始化，直接返回
    if (this.charts.trend && this.charts.user) {
      console.log('[Dashboard] Charts already initialized, skipping');
      return;
    }
    
    // 防止并发初始化
    if (this.initializingCharts) {
      console.log('[Dashboard] Chart initialization already in progress, skipping');
      return;
    }
    this.initializingCharts = true;
    
    const trendCanvas = document.getElementById('trend-chart');
    const userCanvas = document.getElementById('user-chart');
    
    // 检查 Canvas 元素
    if (!trendCanvas || !userCanvas) {
      console.error('[Dashboard] Canvas elements not found, retrying...');
      await new Promise(resolve => setTimeout(resolve, 100));
      return this.initChartsWithRetry();
    }
    
    // 检查 Canvas 尺寸（0尺寸说明还没渲染）
    const trendRect = trendCanvas.getBoundingClientRect();
    const userRect = userCanvas.getBoundingClientRect();
    
    console.log('[Dashboard] Canvas dimensions:', {
      trend: { width: trendRect.width, height: trendRect.height },
      user: { width: userRect.width, height: userRect.height }
    });
    
    if (trendRect.width === 0 || trendRect.height === 0) {
      console.warn('[Dashboard] Canvas has zero dimensions, waiting for render...');
      await new Promise(resolve => requestAnimationFrame(resolve));
      return this.initChartsWithRetry();
    }
    
    // 检查是否有其他实例已经创建了图表
    const existingTrendChart = Chart.getChart('trend-chart');
    const existingUserChart = Chart.getChart('user-chart');
    
    if (existingTrendChart) {
      console.log('[Dashboard] Found existing trend chart, destroying it');
      existingTrendChart.destroy();
    }
    
    if (existingUserChart) {
      console.log('[Dashboard] Found existing user chart, destroying it');
      existingUserChart.destroy();
    }
    
    // 清理本实例的引用
    this.charts.trend = null;
    this.charts.user = null;
    
    // 初始化图表
    try {
      this.initCharts();
      console.log(`[Dashboard] Charts initialized successfully at ${this.getElapsedTime()}ms`);
      
      // 验证图表对象
      console.log('[Dashboard] Chart objects created:', {
        trend: !!this.charts.trend,
        user: !!this.charts.user,
        trendReady: this.charts.trend?.canvas ? 'yes' : 'no',
        userReady: this.charts.user?.canvas ? 'yes' : 'no'
      });
      
      // 初始化成功，清除标志
      this.initializingCharts = false;
    } catch (error) {
      console.error('[Dashboard] Chart initialization failed:', error);
      this.initializingCharts = false;
      
      // 如果是 Canvas 已被占用的错误，说明图表已经存在，不需要重试
      if (error.message && error.message.includes('Canvas is already in use')) {
        console.error('[Dashboard] Canvas already in use, charts likely already initialized');
        // 标记为已初始化，防止后续重试
        this.charts.trend = Chart.getChart('trend-chart');
        this.charts.user = Chart.getChart('user-chart');
        console.log('[Dashboard] Retrieved existing charts:', {
          trend: !!this.charts.trend,
          user: !!this.charts.user
        });
        return;
      }
      
      // 其他错误，重试
      console.log('[Dashboard] Retrying chart initialization in 100ms...');
      await new Promise(resolve => setTimeout(resolve, 100));
      return this.initChartsWithRetry();
    }
  }

  async checkStorageConfig() {
    try {
      const response = await fetch('/api/stats/config');
      const config = await response.json();
      
      if (!config.persistent_storage) {
        // 显示警告横幅
        const warningBanner = document.getElementById('storage-warning');
        if (warningBanner) {
          warningBanner.style.display = 'block';
          document.body.classList.add('has-warning');
        }
      }
    } catch (error) {
      console.error('Failed to check storage config:', error);
    }
  }

  async loadData() {
    const period = this.getCurrentPeriod();
    console.log('[Dashboard] Loading data with period:', period);
    
    try {
      // 并行加载所有数据
      const [overview, trends] = await Promise.all([
        fetch(`/api/stats/overview?period=${period}`).then(r => r.json()),
        fetch('/api/stats/trends?days=30').then(r => r.json())
      ]);
      
      console.log('[Dashboard] API Response - Overview:', overview);
      console.log('[Dashboard] API Response - Trends:', trends);
      
      this.data = { overview, trends };
      console.log('[Dashboard] Data stored, calling updateUI');
      this.updateUI();
      this.updateCharts();
      this.updateLastUpdated();
    } catch (error) {
      console.error('Failed to load data:', error);
      this.showError('加载数据失败，请稍后重试');
    }
  }

  getCurrentPeriod() {
    const activeTab = document.querySelector('.time-tab.active');
    return activeTab ? activeTab.dataset.period : '7d';
  }

  updateUI() {
    console.log('[Dashboard] updateUI called with data:', this.data);
    
    if (!this.data || !this.data.overview) {
      console.error('[Dashboard] No data available for updateUI');
      return;
    }
    
    const { overview } = this.data;
    console.log('[Dashboard] Overview data structure:', {
      hasStats: !!overview.stats,
      hasRankings: !!overview.rankings,
      hasRecent: !!overview.recent,
      statsKeys: overview.stats ? Object.keys(overview.stats) : [],
      rankingsCount: overview.rankings ? overview.rankings.length : 0,
      recentCount: overview.recent ? overview.recent.length : 0
    });
    
    // 更新统计卡片
    this.updateStatCard('total-tokens', overview.stats?.totalTokens);
    this.updateStatCard('user-count', overview.stats?.userCount);
    this.updateStatCard('session-count', overview.stats?.sessionCount);
    this.updateStatCard('record-count', overview.stats?.recordCount);
    
    // 更新排行榜
    console.log('[Dashboard] Calling updateRankings with:', overview.rankings);
    this.updateRankings(overview.rankings);
    
    // 更新最近活动
    console.log('[Dashboard] Calling updateActivity with:', overview.recent);
    this.updateActivity(overview.recent);
    
    // 更新图表
    this.updateCharts();
  }

  updateStatCard(id, value) {
    const element = document.getElementById(id);
    if (element) {
      element.textContent = this.formatNumber(value || 0);
    }
  }

  updateRankings(rankings) {
    console.log('[Dashboard] updateRankings called with:', rankings);
    const tbody = document.getElementById('rankings-tbody');
    
    if (!tbody) {
      console.error('[Dashboard] rankings-tbody element not found!');
      return;
    }
    
    if (!rankings || rankings.length === 0) {
      console.log('[Dashboard] No rankings data, showing placeholder');
      tbody.innerHTML = '<tr><td colspan="6" class="loading">暂无数据</td></tr>';
      return;
    }
    
    console.log('[Dashboard] Processing', rankings.length, 'ranking items');
    
    tbody.innerHTML = rankings.map((user, index) => {
      const rankBadge = this.getRankBadge(index + 1);  // 使用索引作为排名
      const lastSeenText = this.formatTime(user.last_activity);  // 改为 last_activity
      const costText = this.formatCost(user.total_cost);
      
      return `
        <tr>
          <td>${rankBadge}</td>
          <td><strong>${this.escapeHtml(user.username)}</strong></td>
          <td>${this.formatNumber(user.total_tokens)}</td>
          <td>${costText}</td>
          <td>${user.session_count}</td>
          <td>${lastSeenText}</td>
        </tr>
      `;
    }).join('');
  }

  updateActivity(records) {
    console.log('[Dashboard] updateActivity called with:', records);
    const tbody = document.getElementById('activity-tbody');
    
    if (!tbody) {
      console.error('[Dashboard] activity-tbody element not found!');
      return;
    }
    
    if (!records || records.length === 0) {
      console.log('[Dashboard] No activity records, showing placeholder');
      tbody.innerHTML = '<tr><td colspan="7" class="loading">暂无活动</td></tr>';
      return;
    }
    
    console.log('[Dashboard] Processing', records.length, 'activity records');
    
    tbody.innerHTML = records.map(record => {
      const timeText = this.formatTime(record.timestamp);
      const modelName = this.formatModel(record.model);
      const costText = this.formatCost(record.cost);
      
      return `
        <tr>
          <td>${timeText}</td>
          <td>${this.escapeHtml(record.username)}</td>
          <td>${modelName}</td>
          <td>${this.formatNumber(record.input_tokens)}</td>
          <td>${this.formatNumber(record.output_tokens)}</td>
          <td><strong>${this.formatNumber(record.total_tokens)}</strong></td>
          <td>${costText}</td>
        </tr>
      `;
    }).join('');
  }

  initCharts() {
    // 趋势图
    const trendCanvas = document.getElementById('trend-chart');
    if (!trendCanvas) {
      throw new Error('trend-chart canvas not found!');
    }
    
    const trendCtx = trendCanvas.getContext('2d');
    this.charts.trend = new Chart(trendCtx, {
      type: 'line',
      data: {
        labels: [],
        datasets: [{
          label: '每日 token 数',
          data: [],
          borderColor: '#667eea',
          backgroundColor: 'rgba(102, 126, 234, 0.1)',
          tension: 0.3,
          fill: true,
          pointRadius: 6,  // 增大点的大小
          pointHoverRadius: 8,  // 鼠标悬停时点更大
          pointBackgroundColor: '#667eea',  // 点的填充色
          pointBorderColor: '#fff',  // 点的边框色
          pointBorderWidth: 2  // 点的边框宽度
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: {
          duration: 0  // 禁用动画，确保立即显示
        },
        plugins: {
          legend: {
            display: false
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            ticks: {
              callback: value => this.formatNumber(value)
            }
          }
        }
      }
    });

    // 用户分布图
    const userCanvas = document.getElementById('user-chart');
    if (!userCanvas) {
      throw new Error('user-chart canvas not found!');
    }
    
    const userCtx = userCanvas.getContext('2d');
    this.charts.user = new Chart(userCtx, {
      type: 'doughnut',
      data: {
        labels: [],
        datasets: [{
          data: [],
          backgroundColor: [
            '#667eea',
            '#764ba2',
            '#f093fb',
            '#f5576c',
            '#4facfe',
            '#00f2fe'
          ]
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: {
          duration: 0  // 禁用动画
        },
        plugins: {
          legend: {
            position: 'right',
            labels: {
              padding: 10,
              font: {
                size: 11
              }
            }
          }
        }
      }
    });
  }

  updateCharts() {
    const startUpdate = Date.now();
    console.log(`[Dashboard] updateCharts called at ${this.getElapsedTime()}ms`);
    
    const { trends, overview } = this.data;
    
    // 详细记录更新条件
    const conditions = {
      hasTrendChart: !!this.charts.trend,
      hasTrendsData: !!trends?.trends,
      trendsLength: trends?.trends?.length || 0,
      hasUserChart: !!this.charts.user,
      hasRankings: !!overview?.rankings,
      rankingsLength: overview?.rankings?.length || 0
    };
    console.log('[Dashboard] Update conditions:', conditions);
    
    // 更新趋势图
    if (this.charts.trend && trends?.trends) {
      try {
        const sortedTrends = [...trends.trends].reverse();
        
        // 记录数据更新前的状态
        const beforeState = {
          labelsCount: this.charts.trend.data.labels.length,
          dataCount: this.charts.trend.data.datasets[0].data.length
        };
        
        this.charts.trend.data.labels = sortedTrends.map(t => 
          new Date(t.date).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
        );
        this.charts.trend.data.datasets[0].data = sortedTrends.map(t => t.tokens);
        
        // 记录数据更新后的状态
        const afterState = {
          labelsCount: this.charts.trend.data.labels.length,
          dataCount: this.charts.trend.data.datasets[0].data.length,
          firstLabel: this.charts.trend.data.labels[0],
          lastLabel: this.charts.trend.data.labels[this.charts.trend.data.labels.length - 1],
          firstData: this.charts.trend.data.datasets[0].data[0],
          lastData: this.charts.trend.data.datasets[0].data[this.charts.trend.data.datasets[0].data.length - 1]
        };
        
        console.log('[Dashboard] Trend data state:', { before: beforeState, after: afterState });
        
        // 强制立即更新，不使用动画
        this.charts.trend.update('none');
        
        // 尝试强制渲染
        if (this.charts.trend.render) {
          this.charts.trend.render();
        }
        
        console.log(`[Dashboard] Trend chart updated in ${Date.now() - startUpdate}ms`);
      } catch (error) {
        console.error('[Dashboard] Trend chart update error:', error);
      }
    } else {
      console.warn('[Dashboard] Trend chart NOT updated - conditions not met');
    }
    
    // 更新用户分布图
    if (this.charts.user && overview?.rankings) {
      try {
        const topUsers = overview.rankings.slice(0, 5);
        const othersTotal = overview.rankings.slice(5).reduce((sum, u) => sum + u.total_usage, 0);
        
        this.charts.user.data.labels = [
          ...topUsers.map(u => u.username),
          othersTotal > 0 ? '其他' : null
        ].filter(Boolean);
        
        this.charts.user.data.datasets[0].data = [
          ...topUsers.map(u => u.total_usage),
          othersTotal > 0 ? othersTotal : null
        ].filter(v => v !== null);
        
        this.charts.user.update('none');
        
        if (this.charts.user.render) {
          this.charts.user.render();
        }
        
        console.log(`[Dashboard] User chart updated`);
      } catch (error) {
        console.error('[Dashboard] User chart update error:', error);
      }
    } else {
      console.warn('[Dashboard] User chart NOT updated - conditions not met');
    }
    
    console.log(`[Dashboard] updateCharts completed at ${this.getElapsedTime()}ms, took ${Date.now() - startUpdate}ms`);
  }

  setupEventListeners() {
    // 时间选择按钮事件
    document.querySelectorAll('.time-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        // 移除所有active类
        document.querySelectorAll('.time-tab').forEach(t => t.classList.remove('active'));
        // 给当前点击的按钮添加active类
        tab.classList.add('active');
        // 加载数据
        this.loadData();
      });
    });
  }

  updateLastUpdated() {
    const element = document.getElementById('last-updated');
    const now = new Date();
    element.textContent = `最后更新: ${now.toLocaleTimeString('zh-CN')}`;
  }

  formatNumber(num) {
    if (num === null || num === undefined) return '0';
    if (num >= 1000000) {
      return (num / 1000000).toFixed(1) + 'M';
    }
    if (num >= 1000) {
      return (num / 1000).toFixed(1) + 'K';
    }
    return num.toLocaleString('zh-CN');
  }

  formatTime(timestamp) {
    if (!timestamp) return '-';
    
    try {
      // 处理 SQLite 返回的 UTC 时间字符串
      let dateStr = timestamp;
      
      // 处理 SQLite 格式 "YYYY-MM-DD HH:MM:SS" -> ISO 格式
      if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(timestamp)) {
        dateStr = timestamp.replace(' ', 'T') + 'Z';
      }
      // 处理 ISO 格式但没有时区 "YYYY-MM-DD'T'HH:MM:SS"
      else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(timestamp)) {
        dateStr = timestamp + 'Z';
      }
      // 处理完整的 ISO 8601 格式（包含毫秒和/或时区）
      // 支持格式：
      // - 2025-01-10T12:30:45Z (UTC)
      // - 2025-01-10T12:30:45.123Z (带毫秒)
      // - 2025-01-10T12:30:45+08:00 (时区偏移)
      // - 2025-01-10T12:30:45.123+05:30 (带毫秒和时区偏移)
      else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.test(timestamp)) {
        dateStr = timestamp;
      }
      
      const date = new Date(dateStr);
      
      // 验证日期解析是否成功
      if (isNaN(date.getTime())) {
        console.warn('[Dashboard] Invalid timestamp:', timestamp);
        return '时间格式错误';
      }
      
      const now = new Date();
      const diff = now - date;
      
      // 相对时间显示
      if (diff < 60000) {
        return '刚刚';
      }
      if (diff < 3600000) {
        return `${Math.floor(diff / 60000)} 分钟前`;
      }
      if (diff < 86400000) {
        return `${Math.floor(diff / 3600000)} 小时前`;
      }
      if (diff < 604800000) {
        return `${Math.floor(diff / 86400000)} 天前`;
      }
      
      // 使用本地时区显示日期
      return date.toLocaleDateString('zh-CN');
      
    } catch (error) {
      console.error('[Dashboard] Error parsing timestamp:', timestamp, error);
      return '解析错误';
    }
  }

  formatModel(model) {
    if (!model) return 'Unknown';

    const parts = model.split('-');

    // 去掉末尾的日期后缀（20xx开头的8位数字），其他的都保留
    const cleanedParts = parts.filter(
      (part, idx) =>
        !(idx === parts.length - 1 && /^20\d{6}$/.test(part))
    );

    // 转成友好显示
    return cleanedParts
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  formatCost(cost) {
    if (cost === null || cost === undefined) return '$0.00';
    
    if (cost < 0.01) {
      return `$${cost.toFixed(4)}`;
    } else if (cost < 1) {
      return `$${cost.toFixed(3)}`;
    } else {
      return `$${cost.toFixed(2)}`;
    }
  }

  getRankBadge(rank) {
    if (rank === 1) {
      return '<span class="rank-badge gold">1</span>';
    }
    if (rank === 2) {
      return '<span class="rank-badge silver">2</span>';
    }
    if (rank === 3) {
      return '<span class="rank-badge bronze">3</span>';
    }
    return rank;
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  showError(message) {
    // 可以实现一个 toast 通知
    console.error(message);
  }
  
  getElapsedTime() {
    return Date.now() - this.startTime;
  }
}

// 启动策略：使用 DOMContentLoaded 或 立即执行
console.log('[Page] Script loaded');

if (document.readyState === 'loading') {
  // DOM 还在加载，等待 DOMContentLoaded
  document.addEventListener('DOMContentLoaded', () => {
    console.log('[Page] DOMContentLoaded fired');
    window.dashboard = new Dashboard();
  });
} else {
  // DOM 已经加载完成，立即执行
  console.log('[Page] DOM already loaded, initializing immediately');
  window.dashboard = new Dashboard();
}