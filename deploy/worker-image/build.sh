#!/usr/bin/env bash
# 构建固定工具工作进程镜像（可信身份在部署时执行；项目命令无权构建/修改）。
set -euo pipefail
cd "$(dirname "$0")/../.."
TAG="${RUUKOTO_WORKER_IMAGE_TAG:-0.85.1}"
docker build -t "ruukoto-worker:${TAG}" -t ruukoto-worker:latest -f deploy/worker-image/Dockerfile .
echo "built ruukoto-worker:${TAG} (+latest)"
