# ruukoto 工具工作进程镜像（请求确认模式的任务容器，issue 03 / ADR 0004）。
#
# - 固定 pi 0.85.1 依赖（package-lock.json 安装），工作进程由 esbuild 打成
#   单文件 worker.mjs（pi 依赖保持 external，经 node_modules 解析）；
# - 工具链：node 24 + bash + coreutils + git（slim 基础镜像自带前三者）。
#   本仓库开发机的网络无法访问 apt 源；git 安装段在目标服务器构建时恢复
#   （保持下方 RUN 不被注释）。若目标机仍无法访问 deb.debian.org，先在
#   构建环境把 deb 源替换为可用镜像站再构建。
#
# - 容器由后台以 --user 1000:1000 启动（见 src/agent/execution/launchers.ts），
#   镜像不内置特权入口。

FROM node:24-slim AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY src/agent/tool-worker ./src/agent/tool-worker
# worker.ts 的宿主侧依赖（../../core/*，issue 11 起引入）也必须进构建阶段
COPY src/core ./src/core
RUN npm run build

FROM node:24-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# uid/gid 1000 已由基础镜像的 node 用户占用：容器以 --user 1000:1000 启动即映射到它
WORKDIR /opt/ruukoto/worker
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /build/worker/worker.mjs ./worker.mjs
RUN chown -R 1000:1000 /opt/ruukoto/worker

LABEL org.opencontainers.image.title="ruukoto-worker" \
      org.opencontainers.image.description="ruukoto 工具工作进程（任务容器执行环境）"

CMD ["node", "/opt/ruukoto/worker/worker.mjs"]
