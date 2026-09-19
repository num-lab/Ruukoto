#!/usr/bin/env bash
# Linux 受限执行探针编排。
#
# 在 Linux 容器内运行 probe.py 的多个变体，验证受限执行方案的边界：
#   plain       —— 最小 docker run + 工作区挂载（基线）
#   restricted  —— 推荐的任务配置：--network none + 非 root + drop caps + no-new-privileges
#   identity    —— 控制面状态文件由 root 持有（0600），任务进程用另一 uid 访问 → EACCES
#   control-plane TCP 探针 —— 宿主只绑回环的控制面端口，容器（默认桥接）不可达
#
# 用法：bash run-probes.sh [工作目录]
# 结果写入 results/linux-isolation-report.json / .md
#
# 运行环境说明：本脚本在 macOS 的 Docker Desktop（Linux VM）上验证容器边界本身；
# 目标 Linux 服务器的发行版、内核、rootless 运行时等宿主前提属于未验证项，
# 由脚本自动记录容器 uname 与环境信息。

set -uo pipefail

BASE="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="$BASE/../../results"
mkdir -p "$OUT_DIR"
STAMP="$(date +%Y-%m-%dT%H:%M:%S)"
IMAGE="python:3.13-slim"
WORK="$(mktemp -d)"
REPORT_JSON="$OUT_DIR/linux-isolation-report.json"
REPORT_MD="$OUT_DIR/linux-isolation-report.md"

echo "== Linux 受限执行探针 ($STAMP) =="
echo "工作目录: $WORK"

# 宿主控制面：只绑 127.0.0.1 的 TCP 监听（模拟后台宿主控制接口）
CP_PORT=18973
python3 - <<EOF &
import socket, time
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", $CP_PORT))
s.listen(5)
while True:
    try:
        c, _ = s.accept(); c.close()
    except OSError:
        break
EOF
CP_PID=$!
trap 'kill $CP_PID 2>/dev/null; rm -rf "$WORK"' EXIT
sleep 0.5

mkdir -p "$WORK/workspace"
echo "host-secret" > "$WORK/host-only-secret.txt"

run_variant() {
  local name="$1"; shift
  echo "--- 变体: $name ---"
  docker run --rm \
    -v "$WORK/workspace:/workspace" \
    -v "$BASE/probe.py:/probes/probe.py:ro" \
    "$@" "$IMAGE" python3 /probes/probe.py "$name" --tcp-probe "$CP_PORT" 2>&1 |
    grep '^{"probe"'
}

{
  echo "=== 变体 plain（默认 docker run，root，默认桥接网络）==="
  run_variant plain
  echo "=== 变体 restricted（--network none --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges）==="
  run_variant restricted --network none --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges
} > "$WORK/probes.jsonl" 2>&1

# identity 变体：root 启动容器并在容器内创建 root 持有的 0600 状态文件，
# 再以 uid 1000 exec 访问 —— 验证"不同系统身份"的内核边界。
echo "--- 变体 identity ---"
CID=$(docker run -d \
  -v "$BASE/probe.py:/probes/probe.py:ro" \
  "$IMAGE" sleep 60)
docker exec "$CID" sh -c 'umask 077 && echo backend-state > /backend-state.txt && chown 0:0 /backend-state.txt'
docker exec "$CID" sh -c 'test -r /backend-state.txt' \
  && echo '{"probe":"identity.root-reads-own-state","expect":"pass","result":"pass","consistent":true,"detail":"root 可读自己的状态文件"}' >> "$WORK/probes.jsonl"
docker exec --user 1000:1000 "$CID" sh -c 'cat /backend-state.txt 2>&1' >/dev/null 2>&1 \
  && echo '{"probe":"identity.task-uid-reads-backend-state","expect":"fail","result":"fail","consistent":false,"detail":"uid 1000 竟然可读控制面状态!"}' >> "$WORK/probes.jsonl" \
  || echo '{"probe":"identity.task-uid-reads-backend-state","expect":"fail","result":"pass","consistent":true,"detail":"uid 1000 读取控制面状态被内核拒绝（EACCES）"}' >> "$WORK/probes.jsonl"
docker exec --user 1000:1000 "$CID" sh -c 'echo pwn > /backend-state.txt 2>&1' >/dev/null 2>&1 \
  && echo '{"probe":"identity.task-uid-writes-backend-state","expect":"fail","result":"fail","consistent":false,"detail":"uid 1000 竟然可写控制面状态!"}' >> "$WORK/probes.jsonl" \
  || echo '{"probe":"identity.task-uid-writes-backend-state","expect":"fail","result":"pass","consistent":true,"detail":"uid 1000 写控制面状态被内核拒绝（EACCES）"}' >> "$WORK/probes.jsonl"
docker exec "$CID" sh -c 'id' >> "$WORK/probes.jsonl"
docker rm -f "$CID" >/dev/null

# 容器环境信息（记录内核与发行版，用于报告）
docker run --rm "$IMAGE" sh -c 'uname -sr; cat /etc/os-release | head -2' > "$WORK/env.txt" 2>&1

# 宿主信息
{
  echo "宿主: $(uname -sr)"
  echo "容器引擎: $(docker --version)"
} > "$WORK/host.txt"

# 汇总 JSON
python3 - "$WORK" "$STAMP" "$REPORT_JSON" <<'EOF'
import json, sys, pathlib
work, stamp, out = pathlib.Path(sys.argv[1]), sys.argv[2], pathlib.Path(sys.argv[3])
probes = []
for line in (work / "probes.jsonl").read_text().splitlines():
    line = line.strip()
    if line.startswith('{"probe"'):
        probes.append(json.loads(line))
env = (work / "env.txt").read_text().strip()
host = (work / "host.txt").read_text().strip()
inconsistent = [p for p in probes if p.get("consistent") is False]
doc = {
  "timestamp": stamp,
  "host": host,
  "container_env": env,
  "caveat": "在 Docker Desktop（macOS 上的 Linux VM）验证容器边界本身；目标服务器的宿主前提（发行版、内核版本、rootless 运行时、sysctl）未验证。",
  "probes": probes,
  "inconsistent": inconsistent,
}
out.write_text(json.dumps(doc, ensure_ascii=False, indent=2))
print(f"探针总数: {len(probes)}，不一致: {len(inconsistent)}")
for p in probes:
    mark = "OK " if p.get("consistent", False) else "!!!"
    print(f"{mark} [{p.get('result','?'):>4}] {p.get('probe','?')} —— {p.get('detail','')[:80]}")
EOF

# Markdown 报告
python3 - "$WORK" "$STAMP" "$REPORT_MD" <<'EOF'
import sys, pathlib, json
work, stamp, out = pathlib.Path(sys.argv[1]), sys.argv[2], pathlib.Path(sys.argv[3])
probes = []
for line in (work / "probes.jsonl").read_text().splitlines():
    line = line.strip()
    if line.startswith('{"probe"'):
        probes.append(json.loads(line))
env = (work / "env.txt").read_text().strip()
host = (work / "host.txt").read_text().strip()
lines = [
  "# Linux 受限执行探针报告",
  "",
  f"- 时间：{stamp}",
  f"- {host}",
  f"- 容器环境：{env.splitlines()[0] if env else '?'} / {env.splitlines()[-1] if env else '?'}",
  "- 注意：本次在 Docker Desktop（macOS 上的 Linux VM）中验证容器边界本身；",
  "  目标 Linux 服务器的宿主前提（发行版、内核、rootless 运行时）未验证，见 issue 记录。",
  "",
  "| 探针 | 预期 | 结果 | 说明 |",
  "| --- | --- | --- | --- |",
]
for p in probes:
    if "probe" not in p:
        continue
    lines.append(f"| {p['probe']} | {p['expect']} | {p['result']} | {p['detail'].replace('|','/')} |")
out.write_text("\n".join(lines) + "\n")
EOF

echo "== 完成 =="
echo "JSON: $REPORT_JSON"
echo "MD:   $REPORT_MD"
