# ruukoto 工具工作进程镜像（请求确认模式的任务容器，issue 03 / ADR 0004）。
#
# - 固定 pi 0.85.1 依赖（package-lock.json 安装），工作进程由 esbuild 打成
#   单文件 worker.mjs（pi 依赖保持 external，经 node_modules 解析）；
# - 工具链：node 24 + bash + coreutils（slim 基础镜像自带）。
#   本仓库开发机的网络无法访问 apt 源，git 未装入；在目标服务器（可访问
#   apt）构建时，把下方注释的 git 安装步骤恢复即可：
#
#     RUN apt-get update \
#      && apt-get install -y --no-install-recommends git ca-certificates \
#      && rm -rf /var/lib/apt/lists/*
#
# - 容器由后台以 --user 1000:1000 启动（见 src/agent/execution/launchers.ts），
#   镜像不内置特权入口。

FROM node:24-slim AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY src/agent/tool-worker ./src/agent/tool-worker
RUN npx esbuild src/agent/tool-worker/worker.ts \
      --bundle --format=esm --platform=node --target=node24 \
      --external:@earendil-works/* \
      --outfile=worker.mjs

FROM node:24-slim
# uid/gid 1000 已由基础镜像的 node 用户占用：容器以 --user 1000:1000 启动即映射到它
WORKDIR /opt/ruukoto/worker
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /build/worker.mjs ./worker.mjs
RUN chown -R 1000:1000 /opt/ruukoto/worker

LABEL org.opencontainers.image.title="ruukoto-worker" \
      org.opencontainers.image.description="ruukoto 工具工作进程（任务容器执行环境）"

CMD ["node", "/opt/ruukoto/worker/worker.mjs"]
