#!/usr/bin/env bash
# 受保护的提权停止入口（root 拥有 0700，仅后台账户经 sudoers 调用）。
# 用法：ruukoto-exec-stop <unitName>（仅接受 ruukoto-exec-* 形态）
set -euo pipefail

if [ "$#" -ne 1 ] || ! [[ "$1" =~ ^ruukoto-exec-[a-z0-9_-]+$ ]]; then
  echo "用法：ruukoto-exec-stop <ruukoto-exec-... 单元名>" >&2
  exit 64
fi

/usr/bin/systemctl stop "$1" || true
exec /usr/bin/systemctl is-active "$1"
