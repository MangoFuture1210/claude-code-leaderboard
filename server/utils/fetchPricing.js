import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 获取数据存储路径（Render Disk 或本地）
const getDataPath = () => {
  return process.env.DB_PATH ? '/data' : path.join(__dirname, '..', 'data');
};

/**
 * 从 Anthropic 官网获取最新价格
 * 简化版本：使用硬编码的价格模板，定期检查页面是否有变化
 */
async function fetchPricingFromWeb() {
  try {
    console.log('Fetching pricing from Anthropic website...');
    
    // 获取网页内容
    const response = await fetch('https://www.anthropic.com/pricing', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml'
      }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const html = await response.text();
    const $ = cheerio.load(html);
    
    // 当前已知的价格结构（2025年1月）
    // 由于网页结构复杂，使用半自动方式：检查关键价格点是否存在
    const prices = {};
    
    // 查找包含价格的文本（通常格式为 $X.XX 或 $X）
    const priceTexts = [];
    $('*').each((i, elem) => {
      const text = $(elem).text();
      // 匹配价格模式
      const matches = text.match(/\$\d+(?:\.\d+)?(?:\s*\/\s*(?:M|million|MTok))?/gi);
      if (matches) {
        priceTexts.push(...matches);
      }
    });
    
    // 基于已知的价格顺序和模型映射
    // 这是一个简化方案：如果网页价格格式不变，我们可以通过价格数值识别模型
    const knownPrices = {
      '15': 'opus_input',      // Opus: $15 input
      '75': 'opus_output',     // Opus: $75 output
      '3': 'sonnet_input',     // Sonnet: $3 input
      '15': 'sonnet_output',   // Sonnet: $15 output
      '1': 'haiku_input',      // Haiku 3.5: $1 input
      '5': 'haiku_output',     // Haiku 3.5: $5 output
      '0.25': 'haiku3_input',  // Haiku 3: $0.25 input
      '1.25': 'haiku3_output'  // Haiku 3: $1.25 output
    };
    
    // 从页面提取的价格中尝试识别模型
    const extractedPrices = new Set(priceTexts.map(p => {
      const match = p.match(/\$(\d+(?:\.\d+)?)/);
      return match ? parseFloat(match[1]) : null;
    }).filter(p => p !== null));
    
    console.log('Found prices on page:', Array.from(extractedPrices));
    
    // 使用默认价格结构（最新已知价格，2025年1月）
    // 如果页面结构变化太大，至少我们有备用价格
    prices['claude-3-opus'] = {
      input: 15.00,
      output: 75.00,
      cache_write: 18.75,  // 输入价格的 125%
      cache_read: 1.50     // 输入价格的 10%
    };
    
    prices['claude-3-5-sonnet'] = {
      input: 3.00,
      output: 15.00,
      cache_write: 3.75,
      cache_read: 0.30
    };
    
    prices['claude-3-sonnet'] = {
      input: 3.00,
      output: 15.00,
      cache_write: 3.75,
      cache_read: 0.30
    };
    
    prices['claude-3-5-haiku'] = {
      input: 1.00,
      output: 5.00,
      cache_write: 1.25,
      cache_read: 0.10
    };
    
    prices['claude-3-haiku'] = {
      input: 0.25,
      output: 1.25,
      cache_write: 0.30,
      cache_read: 0.03
    };
    
    // 检查页面是否包含预期的价格值（验证）
    const expectedPrices = [15, 75, 3, 1, 5, 0.25, 1.25];
    const foundExpected = expectedPrices.filter(p => extractedPrices.has(p));
    
    if (foundExpected.length > 0) {
      console.log(`Verified ${foundExpected.length} expected prices on page`);
    } else {
      console.log('Warning: Could not verify prices on page, using defaults');
    }
    
    return prices;
  } catch (error) {
    console.error('Error fetching pricing:', error);
    return null;
  }
}

/**
 * 标准化模型名称
 */
function normalizeModelName(name) {
  const lowerName = name.toLowerCase();
  
  // 映射规则
  if (lowerName.includes('opus') && lowerName.includes('3')) {
    return 'claude-3-opus';
  }
  if (lowerName.includes('sonnet') && (lowerName.includes('3.5') || lowerName.includes('3-5'))) {
    return 'claude-3-5-sonnet';
  }
  if (lowerName.includes('sonnet') && lowerName.includes('3')) {
    return 'claude-3-sonnet';
  }
  if (lowerName.includes('haiku') && (lowerName.includes('3.5') || lowerName.includes('3-5'))) {
    return 'claude-3-5-haiku';
  }
  if (lowerName.includes('haiku') && lowerName.includes('3')) {
    return 'claude-3-haiku';
  }
  if (lowerName.includes('opus') && lowerName.includes('4')) {
    return 'claude-opus-4';
  }
  
  // 如果无法识别，返回原始名称的简化版本
  return name.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();
}

/**
 * 保存价格到文件
 */
async function savePricing(prices) {
  const dataPath = getDataPath();
  const pricingFile = path.join(dataPath, 'pricing.json');
  
  const data = {
    updated: new Date().toISOString(),
    source: 'https://www.anthropic.com/pricing',
    prices: prices,
    version: '2025-01-simplified'
  };
  
  try {
    await fs.writeFile(pricingFile, JSON.stringify(data, null, 2));
    console.log('Pricing data saved to:', pricingFile);
    return true;
  } catch (error) {
    console.error('Error saving pricing data:', error);
    return false;
  }
}

/**
 * 加载缓存的价格
 */
export async function loadCachedPricing() {
  const dataPath = getDataPath();
  const pricingFile = path.join(dataPath, 'pricing.json');
  
  try {
    const data = await fs.readFile(pricingFile, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    console.log('No cached pricing found, will use defaults');
    return null;
  }
}

/**
 * 更新价格（主函数）
 */
export async function updatePricing() {
  console.log(`[${new Date().toISOString()}] Starting pricing update...`);
  
  const prices = await fetchPricingFromWeb();
  
  if (prices && Object.keys(prices).length > 0) {
    await savePricing(prices);
    console.log('Pricing updated successfully');
    return prices;
  } else {
    console.log('Failed to fetch pricing, keeping existing data');
    return null;
  }
}

/**
 * 初始化定时更新
 */
export function initPricingUpdater() {
  // 启动时立即更新一次
  updatePricing().catch(console.error);
  
  // 每2小时更新一次
  setInterval(() => {
    updatePricing().catch(console.error);
  }, 2 * 60 * 60 * 1000);
  
  console.log('Pricing updater initialized (updates every 2 hours)');
}

// 如果直接运行此文件，执行一次更新
if (import.meta.url === `file://${process.argv[1]}`) {
  updatePricing().then(() => {
    console.log('Manual pricing update completed');
    process.exit(0);
  });
}