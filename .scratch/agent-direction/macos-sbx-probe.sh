#!/usr/bin/env bash
# 工单 03 旧入口：改用规范化路径、有效对照及实际 errno 的完整探针。
# 旧 /tmp 规则与实际 /private/tmp 路径不匹配，不能据此否决 Seatbelt 文件机制。
# 退出 0=所有候选边界通过，1=真实边界失败，2=基础设施或探针未启动。
set -euo pipefail
BASE="$(cd "$(dirname "$0")" && pwd -P)"
exec bash "$BASE/../../verification/foundation/scripts/native-isolation/macos-run-probes.sh" "$@"
