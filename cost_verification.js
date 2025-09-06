// 成本验证脚本
const pricing = {
  "claude-opus-4-1-20250805": {
    input: 15, output: 75, cache_write: 18.75, cache_read: 1.5
  },
  "claude-sonnet-4-20250514": {
    input: 3, output: 15, cache_write: 3.75, cache_read: 0.3
  }
};

// 来自API的数据
const apiData = {
  "claude-opus-4-1-20250805": {
    input_tokens: 98,
    output_tokens: 32702,
    cache_creation_tokens: 195739,
    cache_read_tokens: 3006267,
    api_cost: 10.63362675
  },
  "claude-sonnet-4-20250514": {
    input_tokens: 200,
    output_tokens: 7942,
    cache_creation_tokens: 236123,
    cache_read_tokens: 1328135,
    api_cost: 1.40363175
  }
};

console.log("=== 成本验证计算 ===\n");

let totalCalculatedCost = 0;
let totalApiCost = 0;

for (const [model, data] of Object.entries(apiData)) {
  const prices = pricing[model];
  
  // 手动计算成本
  const calculatedCost = 
    (data.input_tokens * prices.input / 1000000) +
    (data.output_tokens * prices.output / 1000000) +
    (data.cache_creation_tokens * prices.cache_write / 1000000) +
    (data.cache_read_tokens * prices.cache_read / 1000000);
  
  console.log(`${model}:`);
  console.log(`  输入tokens: ${data.input_tokens.toLocaleString()} × $${prices.input}/1M = $${(data.input_tokens * prices.input / 1000000).toFixed(6)}`);
  console.log(`  输出tokens: ${data.output_tokens.toLocaleString()} × $${prices.output}/1M = $${(data.output_tokens * prices.output / 1000000).toFixed(6)}`);
  console.log(`  缓存创建: ${data.cache_creation_tokens.toLocaleString()} × $${prices.cache_write}/1M = $${(data.cache_creation_tokens * prices.cache_write / 1000000).toFixed(6)}`);
  console.log(`  缓存读取: ${data.cache_read_tokens.toLocaleString()} × $${prices.cache_read}/1M = $${(data.cache_read_tokens * prices.cache_read / 1000000).toFixed(6)}`);
  console.log(`  手动计算总计: $${calculatedCost.toFixed(8)}`);
  console.log(`  API显示成本: $${data.api_cost.toFixed(8)}`);
  console.log(`  差异: $${Math.abs(calculatedCost - data.api_cost).toFixed(8)} (${Math.abs((calculatedCost - data.api_cost) / data.api_cost * 100).toFixed(4)}%)`);
  console.log("");
  
  totalCalculatedCost += calculatedCost;
  totalApiCost += data.api_cost;
}

console.log("=== 总计验证 ===");
console.log(`手动计算总成本: $${totalCalculatedCost.toFixed(8)}`);
console.log(`API显示总成本: $${totalApiCost.toFixed(8)}`);
console.log(`总差异: $${Math.abs(totalCalculatedCost - totalApiCost).toFixed(8)} (${Math.abs((totalCalculatedCost - totalApiCost) / totalApiCost * 100).toFixed(4)}%)`);
console.log(`匹配程度: ${Math.abs(totalCalculatedCost - totalApiCost) < 0.001 ? '✅ 完全匹配' : '❌ 有差异'}`);