#!/usr/bin/env bash
# 受保护的提权启动入口（root 拥有 0700，仅后台账户经 sudoers 调用）。
#
# 用法：ruukoto-exec-launch <taskId>
# 以固定执行账户（ruukoto-exec，uid/gid 见部署）启动工具工作进程，
# systemd 单元名按任务派生，KillMode=control-group。
#
# 参数校验固定到任务 id 形态：不接受任何可注入 systemd-run 的选项，
# 不拼 Shell 字符串，任务 id 之外的参数一律拒绝。
set -euo pipefail

if [ "$#" -ne 1 ] || ! [[ "$1" =~ ^[a-z0-9_-]+$ ]]; then
  echo "用法：ruukoto-exec-launch <taskId>（仅小写字母/数字/_/-）" >&2
  exit 64
fi

TASK_ID="$1"
WORKER="${RUUKOTO_WORKER_PATH:-/opt/ruukoto/worker/worker.mjs}"
UNIT="ruukoto-exec-${TASK_ID}"

exec /usr/bin/systemd-run \
  --pipe --wait --quiet \
  --uid "${RUUKOTO_EXEC_UID:-1002}" --gid "${RUUKOTO_EXEC_GID:-1002}" \
  --unit "$UNIT" \
  --property KillMode=control-group \
  /usr/bin/node "$WORKER"
