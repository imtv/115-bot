# 使用官方轻量级 Node.js 镜像
FROM node:18-alpine

# 设置容器内工作目录
WORKDIR /app

# 1. 先只复制 package.json，利用 Docker 缓存层机制加速构建
COPY package.json ./

# 2. 在构建过程中自动安装依赖 (这是你最需要的一步)
# --production 参数表示只安装运行所需的依赖，减少体积
RUN npm install --production --registry=https://registry.npmmirror.com

# 3. 复制所有源代码到容器中
COPY . .

# 创建数据目录（确保权限正确）
RUN mkdir -p data && chown -R node:node /app

# 暴露端口
EXPOSE 3000

# 切换到非 root 用户运行（安全最佳实践）
USER node

# 启动命令
CMD ["npm", "start"]