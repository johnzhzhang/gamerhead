# 使用Node.js 20官方镜像
FROM node:20-slim

# 安装 FFmpeg 用于服务端视频拼接
# fonts-liberation：字幕按 Arial 字宽排版，Liberation Sans 与 Arial 等宽兼容。
# 不装的话 fontconfig 会把 Arial 映射到更宽的 DejaVu Sans Bold，行宽估算就不准了。
RUN apt-get update && apt-get install -y ffmpeg fonts-liberation --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# 设置工作目录
WORKDIR /app

# 复制package文件
COPY package*.json ./

# 安装所有依赖（包括devDependencies用于构建）
RUN npm install

# 复制所有源代码
COPY . .

# 构建前端资源
RUN npm run build

# 生产环境只保留必要依赖
RUN npm prune --production

# 暴露端口
EXPOSE 8080

# 设置环境变量
ENV NODE_ENV=production
ENV PORT=8080

# 启动应用
CMD ["node", "server.js"]
