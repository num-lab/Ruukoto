#!/bin/bash
# issue 02 真实环境冒烟（macOS 本机）：真实 bin/pty/文件/socket/SQLite；模型不打桩，
# 只放一个结构合法但指向死端口的 models.json（本冒烟不提交任务，不发生模型调用）。
# 覆盖 runTui → ensureBackend 的生产默认路径（spawnArgv 由 argv[1] 推导、默认产品目录）。
# TUI 退出用延迟 SIGTERM（TUI 的 SIGTERM 处理即 app.quit，与 Ctrl+C 空草稿退出同路径）。
set -u
REPO=$(cd "$(dirname "$0")/../.." && pwd)
BIN="$REPO/bin/ruukoto-dev.mjs"
step() { echo "== $1"; }
fail() { echo "FAIL: $1"; kill_tui; exit 1; }
kill_tui() { pkill -TERM -f "ruukoto-dev\.mjs\$" 2>/dev/null; true; }

run_tui_round() {
  # $1=HOME；stdout 为 TUI 输出；返回码即 TUI 退出码
  local CONTROL_DIR="$1/.ruukoto-dev-agent/control"
  HOME="$1" python3 "$REPO/.scratch/agent-direction/pty-run.py" "$BIN" 2>&1
}

HOME_DIR=$(mktemp -d /tmp/ruukoto-smoke02-XXXXXX)
AGENT_DIR="$HOME_DIR/.ruukoto-dev-agent/agent"
CONTROL_DIR="$HOME_DIR/.ruukoto-dev-agent/control"
SOCK="$CONTROL_DIR/control.sock"

mkdir -p "$AGENT_DIR"
cat > "$AGENT_DIR/models.json" <<'JSON'
{
  "providers": {
    "mock": {
      "name": "Mock", "baseUrl": "http://127.0.0.1:9/v1", "apiKey": "mock-key",
      "api": "openai-completions",
      "models": [{ "id": "mock-model", "name": "Mock Model", "reasoning": false,
        "input": ["text"], "cost": {"input":0,"output":0,"cacheRead":0,"cacheWrite":0},
        "contextWindow": 200000, "maxTokens": 1024 }]
    }
  }
}
JSON

step "1 首次打开 TUI（pty）→ 按需拉起 → Ctrl+C 路径退出，后台不停"
OUT=$(run_tui_round "$HOME_DIR"); STATUS=$?
[ ${STATUS} -eq 0 ] || fail "TUI 进程退出码 ${STATUS}：$(echo "$OUT" | tr -d '\r' | tail -3)"
echo "$OUT" | grep -q "已按需拉起 ruukoto-dev 后台" || fail "未见按需拉起提示"
echo "$OUT" | grep -q "已退出 TUI；后台任务继续运行" || fail "未见退出提示"
[ -S "$SOCK" ] || fail "TUI 退出后 socket 应仍在（后台未停）"
[ -f "$CONTROL_DIR/spawn.log" ] || fail "缺 spawn.log"
OUT2=$(HOME="$HOME_DIR" node "$BIN" status 2>&1) || fail "status 命令失败（后台应在运行）"
echo "  拉起提示 ✓ 退出提示 ✓ socket 存活 ✓ spawn.log ✓ status ✓"

step "2 再次打开 TUI → 复用运行中的后台（不再拉起）"
OUT=$(run_tui_round "$HOME_DIR")
[ $? -eq 0 ] || fail "第二次 TUI 退出码非零"
echo "$OUT" | grep -q "已按需拉起" && fail "已在运行不应重复拉起"
echo "  未重复拉起，正常进入并退出 ✓"

step "3 显式停止只经本产品 socket（ruukoto-dev stop）"
HOME="$HOME_DIR" node "$BIN" stop || fail "stop 非零退出"
for i in $(seq 1 50); do [ -S "$SOCK" ] || break; sleep 0.2; done
[ -S "$SOCK" ] && fail "stop 后 socket 仍在"
echo "  stop ✓ socket 已消失 ✓"

step "4 停止后重开 TUI → 再次按需拉起（实例锁接管；升级换新代码同路径）"
OUT=$(run_tui_round "$HOME_DIR")
echo "$OUT" | grep -q "已按需拉起 ruukoto-dev 后台" || fail "停止后重开未按需拉起"
[ -S "$SOCK" ] || fail "重拉起后 socket 应在"
HOME="$HOME_DIR" node "$BIN" stop >/dev/null 2>&1 || fail "第二次 stop 失败"
echo "  重拉起 ✓ 再停止 ✓"

step "5 启动失败明确状态：空档案根（无 models.json）→ 非零退出 + 日志尾部"
FAIL_HOME=$(mktemp -d /tmp/ruukoto-smoke02-fail-XXXXXX)
OUT=$(GRACE=16 HOME="$FAIL_HOME" python3 "$REPO/.scratch/agent-direction/pty-run.py" "$BIN" 2>&1); STATUS=$?
[ ${STATUS} -eq 0 ] && fail "无模型配置应非零退出"
echo "$OUT" | grep -q "后台启动失败" || fail "未见『后台启动失败』状态"
echo "$OUT" | grep -q "未找到可用模型" || fail "失败状态未附实际错误"
echo "  非零退出（${STATUS}）+ 启动失败状态 + 实际错误（spawn.log 尾部）✓"

kill_tui
rm -rf "$HOME_DIR" "$FAIL_HOME"
echo "ALL SMOKE PASS"
