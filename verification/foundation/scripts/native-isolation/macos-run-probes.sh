#!/usr/bin/env bash
# 真实边界失败返回 1，基础设施或启动失败返回 2。
set -euo pipefail
if ! command -v python3 >/dev/null 2>&1; then
  echo "基础设施：python3 不可用" >&2
  exit 2
fi
BASE="$(cd "$(dirname "$0")" && pwd -P)"
exec python3 "$BASE/macos-probe.py" "${1:-$BASE/../../results}"
