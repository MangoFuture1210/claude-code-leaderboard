// 共享的模型配置文件 - 可在客户端和服务端使用
// 这个文件与 server/config/models.js 保持同步

export const MODEL_PATTERNS = [
  // Claude 4 系列
  {
    pattern: /claude-sonnet-4-\d{8}/i,
    name: 'Claude 4 Sonnet',
    category: 'claude-4'
  },
  {
    pattern: /claude-opus-4-\d{8}/i,
    name: 'Claude 4 Opus', 
    category: 'claude-4'
  },
  {
    pattern: /claude-haiku-4-\d{8}/i,
    name: 'Claude 4 Haiku',
    category: 'claude-4'
  },

  // Claude 3.5 系列
  {
    pattern: /claude-3\.5-sonnet-\d{8}/i,
    name: 'Claude 3.5 Sonnet',
    category: 'claude-3.5'
  },
  {
    pattern: /claude-3\.5-haiku-\d{8}/i,
    name: 'Claude 3.5 Haiku',
    category: 'claude-3.5'
  },

  // Claude 3 系列
  {
    pattern: /claude-3-opus-\d{8}/i,
    name: 'Claude 3 Opus',
    category: 'claude-3'
  },
  {
    pattern: /claude-3-sonnet-\d{8}/i,
    name: 'Claude 3 Sonnet',
    category: 'claude-3'
  },
  {
    pattern: /claude-3-haiku-\d{8}/i,
    name: 'Claude 3 Haiku', 
    category: 'claude-3'
  },

  // 通用匹配 (fallback patterns)
  {
    pattern: /claude.*sonnet.*4/i,
    name: 'Claude 4 Sonnet',
    category: 'claude-4'
  },
  {
    pattern: /claude.*opus.*4/i,
    name: 'Claude 4 Opus',
    category: 'claude-4'
  },
  {
    pattern: /claude.*haiku.*4/i,
    name: 'Claude 4 Haiku',
    category: 'claude-4'
  },
  {
    pattern: /claude.*3\.5.*sonnet/i,
    name: 'Claude 3.5 Sonnet',
    category: 'claude-3.5'
  },
  {
    pattern: /claude.*3\.5.*haiku/i,
    name: 'Claude 3.5 Haiku',
    category: 'claude-3.5'
  }
];

/**
 * 标准化模型名称
 * @param {string} rawModel - 原始模型名称
 * @returns {object} 包含标准化名称和元数据的对象
 */
export function normalizeModelName(rawModel) {
  if (!rawModel) {
    return {
      name: 'Unknown',
      category: 'unknown',
      original: rawModel
    };
  }

  // 查找匹配的模式
  for (const config of MODEL_PATTERNS) {
    if (config.pattern.test(rawModel)) {
      return {
        name: config.name,
        category: config.category,
        original: rawModel
      };
    }
  }

  // 如果没有匹配的模式，返回原始名称
  return {
    name: rawModel,
    category: 'other',
    original: rawModel
  };
}

/**
 * 简化版格式化函数，用于前端显示
 * @param {string} model - 模型名称
 * @returns {string} 格式化后的显示名称
 */
export function formatModelName(model) {
  if (!model) return 'Unknown';
  
  const modelInfo = normalizeModelName(model);
  return modelInfo.name;
}