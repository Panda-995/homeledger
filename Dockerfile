FROM node:22-slim

# 时区可被环境变量覆盖
ENV TZ=Asia/Shanghai \
    NODE_ENV=production \
    PORT=5111 \
    DATA_DIR=/data

WORKDIR /app

# 先装依赖，利用镜像层缓存；lockfile 一并拷入 + npm ci，保证依赖版本可复现
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# 再拷贝源码（--chown 一步到位，避免事后 chown -R 把整层应用文件复制一遍）
COPY --chown=node:node . .

# 数据卷：所有账本数据都在这里，备份=拷走这一个目录
# 注意：chown 只对具名卷/镜像内目录生效；bind mount（./data:/data）的属主沿用宿主机，
#       NAS 上需 chown 1000:1000 ./data 或在 compose 里加 user
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]

USER node

EXPOSE 5111

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5111)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--no-warnings", "server.js"]
