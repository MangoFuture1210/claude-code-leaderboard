FROM node:18-alpine

WORKDIR /app

# 复制 package files
COPY package*.json ./

# 安装生产依赖
RUN npm ci --only=production

# 复制源代码
COPY . .

# 创建数据目录
RUN mkdir -p /data

# 暴露端口
EXPOSE 3000

# 设置环境变量
ENV NODE_ENV=production
ENV DB_PATH=/data/stats.db

# 启动服务
CMD ["node", "index.js"]