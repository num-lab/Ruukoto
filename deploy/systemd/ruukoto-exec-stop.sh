#!/usr/bin/env bash
# 受保护的提权停止入口（root 拥有 0700，仅后台账户经 sudoers 调用）。
# 用法：ruukoto-exec-stop <unitName>（仅接受 ruukoto-exec-* 形态）
set -euo pipefail

if [ "$#" -ne 1 ] || ! [[ "$1" =~ ^ruukoto-exec-[a-z0-9_-]+$ ]]; then
  echo "用法：ruukoto-exec-stop <ruukoto-exec-... 单元名>" >&2
  exit 64
fi

/usr/bin/systemctl stop "$1" || true
# 查询失败不证明退出；状态与 systemctl 的退出码必须同时成立。
# Note: 见 .agents/notes/implemented/bug-fix/2026-10-11-preserve-unverified-worker-stop.md
status=0
state=$(/usr/bin/systemctl is-active "$1") || status=$?
if { [ "$status" -eq 3 ] && [[ "$state" == inactive || "$state" == failed ]]; } || { [ "$status" -eq 4 ] && [ "$state" == unknown ]; }; then
  exit 0
fi
echo "[ruukoto:execution] 无法核实 $1 已退出；保留占用，核实后恢复" >&2
exit 1
