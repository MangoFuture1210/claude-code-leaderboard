import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 获取数据存储目录
 * @returns {string} 数据目录路径
 */
export const getDataDir = () => {
  if (process.env.DATA_DIR) {
    return process.env.DATA_DIR;
  }
  // 未设置时使用源代码目录（警告：会在重新部署时丢失）
  return path.join(__dirname, '..', 'data');
};

/**
 * 检查是否使用持久化存储
 * @returns {boolean} true 如果使用持久化存储
 */
export const isUsingPersistentStorage = () => {
  return !!process.env.DATA_DIR;
};

/**
 * 获取存储配置信息
 * @returns {Object} 配置信息
 */
export const getStorageConfig = () => {
  const isPersistent = isUsingPersistentStorage();
  const dataDir = getDataDir();
  
  return {
    persistent_storage: isPersistent,
    data_dir: dataDir,
    warning: isPersistent ? null : '数据存储在源代码目录，重新部署将丢失所有数据！请设置 DATA_DIR 环境变量并挂载持久化磁盘。',
    environment_variable: process.env.DATA_DIR || null
  };
};