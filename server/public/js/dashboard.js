class Dashboard {
  constructor() {
    this.charts = {};
    this.data = {};
    this.init();
  }

  async init() {
    await this.checkStorageConfig();
    await this.loadData();
    this.setupEventListeners();
    this.initCharts();
    
    // 自动刷新每60秒
    setInterval(() => this.loadData(), 60000);
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
    const period = document.getElementById('period').value;
    const refreshBtn = document.getElementById('refresh-btn');
    
    refreshBtn.classList.add('loading');
    
    try {
      // 并行加载所有数据
      const [overview, trends] = await Promise.all([
        fetch(`/api/stats/overview?period=${period}`).then(r => r.json()),
        fetch('/api/stats/trends?days=30').then(r => r.json())
      ]);
      
      this.data = { overview, trends };
      this.updateUI();
      this.updateLastUpdated();
    } catch (error) {
      console.error('Failed to load data:', error);
      this.showError('加载数据失败，请稍后重试');
    } finally {
      refreshBtn.classList.remove('loading');
    }
  }

  updateUI() {
    const { overview } = this.data;
    
    // 更新统计卡片
    this.updateStatCard('total-tokens', overview.stats.totalTokens);
    this.updateStatCard('user-count', overview.stats.userCount);
    this.updateStatCard('session-count', overview.stats.sessionCount);
    this.updateStatCard('record-count', overview.stats.recordCount);
    
    // 更新排行榜
    this.updateRankings(overview.rankings);
    
    // 更新最近活动
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
    const tbody = document.getElementById('rankings-tbody');
    
    if (!rankings || rankings.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="loading">暂无数据</td></tr>';
      return;
    }
    
    tbody.innerHTML = rankings.map((user, index) => {
      const rankBadge = this.getRankBadge(user.rank);
      const lastSeenText = this.formatTime(user.last_seen);
      const costText = this.formatCost(user.total_cost);
      
      return `
        <tr>
          <td>${rankBadge}</td>
          <td><strong>${this.escapeHtml(user.username)}</strong></td>
          <td>${this.formatNumber(user.total_usage)}</td>
          <td>${costText}</td>
          <td>${user.session_count}</td>
          <td>${lastSeenText}</td>
        </tr>
      `;
    }).join('');
  }

  updateActivity(records) {
    const tbody = document.getElementById('activity-tbody');
    
    if (!records || records.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="loading">暂无活动</td></tr>';
      return;
    }
    
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
    const trendCtx = document.getElementById('trend-chart').getContext('2d');
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
          fill: true
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
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
    const userCtx = document.getElementById('user-chart').getContext('2d');
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
    const { trends, overview } = this.data;
    
    // 更新趋势图
    if (this.charts.trend && trends?.trends) {
      const sortedTrends = [...trends.trends].reverse();
      this.charts.trend.data.labels = sortedTrends.map(t => 
        new Date(t.date).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
      );
      this.charts.trend.data.datasets[0].data = sortedTrends.map(t => t.tokens);
      this.charts.trend.update();
    }
    
    // 更新用户分布图
    if (this.charts.user && overview?.rankings) {
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
      
      this.charts.user.update();
    }
  }

  setupEventListeners() {
    document.getElementById('refresh-btn').addEventListener('click', () => {
      this.loadData();
    });
    
    document.getElementById('period').addEventListener('change', () => {
      this.loadData();
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
    
    // 处理 SQLite 返回的 UTC 时间字符串
    // 如果时间戳不包含时区信息，添加 'Z' 表示 UTC
    let dateStr = timestamp;
    if (!timestamp.includes('Z') && !timestamp.includes('+') && !timestamp.includes('-')) {
      // 如果没有时区标识，假设是 UTC 时间
      dateStr = timestamp.replace(' ', 'T') + 'Z';
    }
    
    const date = new Date(dateStr);
    const now = new Date();
    const diff = now - date;
    
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
    
    return date.toLocaleDateString('zh-CN');
  }

  formatModel(model) {
    if (!model) return 'Unknown';
    
    // 移除日期后缀，清理格式并转为友好显示
    const cleaned = model
        .replace(/-\d{8}$/, '')          // 移除日期后缀 (如 -20250514)
        .replace(/^claude-/, '')         // 移除 claude- 前缀
        .replace(/-/g, ' ')              // 连字符替换为空格
        .replace(/\b\w/g, l => l.toUpperCase()); // 首字母大写
    
    return cleaned || model;
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
}

// 启动 Dashboard
document.addEventListener('DOMContentLoaded', () => {
  new Dashboard();
});