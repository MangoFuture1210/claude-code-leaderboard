import { loadCachedPricing } from './fetchPricing.js';

// 缓存的价格数据
let cachedPrices = null;
let lastLoadTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5分钟内存缓存

// 默认价格（备用）
const DEFAULT_PRICES = {
  // Claude 3 Opus
  'claude-3-opus-20240229': {
    input: 15.00,
    output: 75.00,
    cache_write: 18.75,  // 25% more than input
    cache_read: 1.50     // 10% of input price
  },
  'claude-opus-4-1-20250805': {
    input: 15.00,
    output: 75.00,
    cache_write: 18.75,
    cache_read: 1.50
  },
  
  // Claude 3.5 Sonnet
  'claude-3-5-sonnet-20241022': {
    input: 3.00,
    output: 15.00,
    cache_write: 3.75,   // 25% more than input
    cache_read: 0.30     // 10% of input price
  },
  'claude-3-5-sonnet-20240620': {
    input: 3.00,
    output: 15.00,
    cache_write: 3.75,
    cache_read: 0.30
  },
  
  // Claude 3 Sonnet
  'claude-3-sonnet-20240229': {
    input: 3.00,
    output: 15.00,
    cache_write: 3.75,
    cache_read: 0.30
  },
  
  // Claude 3.5 Haiku
  'claude-3-5-haiku-20241022': {
    input: 1.00,
    output: 5.00,
    cache_write: 1.25,
    cache_read: 0.10
  },
  
  // Claude 3 Haiku
  'claude-3-haiku-20240307': {
    input: 0.25,
    output: 1.25,
    cache_write: 0.30,
    cache_read: 0.03
  },
  
  // Default pricing for unknown models
  'default': {
    input: 3.00,
    output: 15.00,
    cache_write: 3.75,
    cache_read: 0.30
  }
};

/**
 * 加载最新价格
 */
async function loadPrices() {
  const now = Date.now();
  
  // 使用内存缓存
  if (cachedPrices && (now - lastLoadTime) < CACHE_TTL) {
    return cachedPrices;
  }
  
  try {
    // 尝试加载文件缓存
    const cached = await loadCachedPricing();
    if (cached && cached.prices) {
      cachedPrices = cached.prices;
      lastLoadTime = now;
      return cached.prices;
    }
  } catch (error) {
    console.log('Could not load cached pricing, using defaults:', error.message);
  }
  
  // 使用默认价格
  cachedPrices = DEFAULT_PRICES;
  lastLoadTime = now;
  return DEFAULT_PRICES;
}

/**
 * Get pricing for a specific model
 * @param {string} model - Model name
 * @returns {Object} Pricing object
 */
async function getModelPricing(model) {
  const prices = await loadPrices();
  
  if (!model) return prices.default || DEFAULT_PRICES.default;
  
  // Try exact match first
  if (prices[model]) {
    return prices[model];
  }
  
  // Try to match by model family
  const modelLower = model.toLowerCase();
  
  // 尝试从缓存价格中匹配
  for (const [key, value] of Object.entries(prices)) {
    if (modelLower.includes(key.toLowerCase()) || 
        key.toLowerCase().includes(modelLower)) {
      return value;
    }
  }
  
  // 使用模式匹配
  if (modelLower.includes('opus-4')) {
    return prices['claude-opus-4'] || DEFAULT_PRICES['claude-opus-4-1-20250805'];
  }
  if (modelLower.includes('opus')) {
    return prices['claude-3-opus'] || DEFAULT_PRICES['claude-3-opus-20240229'];
  }
  if (modelLower.includes('3-5-sonnet') || modelLower.includes('3.5-sonnet')) {
    return prices['claude-3-5-sonnet'] || DEFAULT_PRICES['claude-3-5-sonnet-20241022'];
  }
  if (modelLower.includes('sonnet')) {
    return prices['claude-3-sonnet'] || DEFAULT_PRICES['claude-3-sonnet-20240229'];
  }
  if (modelLower.includes('3-5-haiku') || modelLower.includes('3.5-haiku')) {
    return prices['claude-3-5-haiku'] || DEFAULT_PRICES['claude-3-5-haiku-20241022'];
  }
  if (modelLower.includes('haiku')) {
    return prices['claude-3-haiku'] || DEFAULT_PRICES['claude-3-haiku-20240307'];
  }
  
  return prices.default || DEFAULT_PRICES.default;
}

/**
 * Calculate cost in USD for token usage
 * @param {Object} usage - Token usage object
 * @param {number} usage.input_tokens - Input tokens
 * @param {number} usage.output_tokens - Output tokens
 * @param {number} usage.cache_creation_tokens - Cache creation tokens
 * @param {number} usage.cache_read_tokens - Cache read tokens
 * @param {string} usage.model - Model name
 * @returns {Promise<number>} Cost in USD
 */
async function calculateCost(usage) {
  const pricing = await getModelPricing(usage.model);
  
  const inputCost = (usage.input_tokens || 0) * pricing.input / 1000000;
  const outputCost = (usage.output_tokens || 0) * pricing.output / 1000000;
  const cacheWriteCost = (usage.cache_creation_tokens || 0) * pricing.cache_write / 1000000;
  const cacheReadCost = (usage.cache_read_tokens || 0) * pricing.cache_read / 1000000;
  
  return inputCost + outputCost + cacheWriteCost + cacheReadCost;
}

/**
 * Format cost as USD string
 * @param {number} cost - Cost in USD
 * @returns {string} Formatted cost string
 */
function formatCost(cost) {
  if (cost < 0.01) {
    return `$${cost.toFixed(4)}`;
  } else if (cost < 1) {
    return `$${cost.toFixed(3)}`;
  } else if (cost < 10) {
    return `$${cost.toFixed(2)}`;
  } else {
    return `$${cost.toFixed(2)}`;
  }
}

export { calculateCost, formatCost, getModelPricing, DEFAULT_PRICES as API_PRICES };