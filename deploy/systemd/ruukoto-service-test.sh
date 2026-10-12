#!/usr/bin/env bash
# ruukoto-service-test 的最小启动程序（agent-direction issue 09）。
# root 拥有；以单元配置的测试账户运行（无网络、无业务凭据、Restart=no，见单元文件）。
# 每次启动记录 InvocationID 与递增计数作为辅助观察——systemd 的 InvocationID 与
# 命令结果才是主要执行证据，状态文件由测试账户可写，不能作为授权依据。
set -euo pipefail

STATE_DIR=/var/lib/ruukoto-service-test
mkdir -p "$STATE_DIR"
echo "$(date -u +%FT%TZ) ${INVOCATION_ID:-unknown}" >> "$STATE_DIR/starts.log"
COUNT=$(wc -l < "$STATE_DIR/starts.log" | tr -d ' ')
echo "$COUNT" > "$STATE_DIR/count"

# 常驻直到被 stop/restart（sleep 由 systemd 直接监控，无子进程游离）
exec /usr/bin/sleep infinity
