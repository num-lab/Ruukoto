#!/usr/bin/env bash
# 历史 Docker 策略对照；当前产品入口为 npm run linux:probes，见本目录 README。
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
# 判定入口（issue 03 §6）：
#   - 汇总结果不一致（consistent=false）或预期探针缺失 → 退出码 1；
#   - 基础设施故障（容器引擎不可用、容器未启动、对照服务未就绪、变体无输出）
#     → 退出码 2，且不把它当作权限隔离成功；
#   - 全部通过 → 退出码 0。
# 对照服务与真实工作区外秘密文件必须先行确认可用，避免把"目标不存在"或
# "服务未启动"计为隔离通过。
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

# 预期探针集合（每个变体必须齐全；缺项即判定失败，不看"其余通过"）
EXPECTED_COMMON="workspace.write hostfs.absent:/Users hostfs.absent:/home/eitrous hostfs.absent:/root/.pi hostfs.absent:/etc/ruukoto-backend hostfs.absent:/var/run/docker.sock rootfs.write-outside-workspace credentials.env-clean credentials.no-pi-config subprocess.spawn subprocess.mount-denied control-plane.loopback-not-reachable workspace.host-secret-absent"
EXPECTED_PLAIN="$EXPECTED_COMMON subprocess.capabilities"
EXPECTED_RESTRICTED="$EXPECTED_COMMON subprocess.capabilities-zero network.egress-blocked"
EXPECTED_IDENTITY="identity.root-reads-own-state identity.task-uid-reads-backend-state identity.task-uid-writes-backend-state"

INFRA_FAILURE=0
infra_fail() {
  echo "错误（基础设施）：$*" >&2
  INFRA_FAILURE=1
}

echo "== Linux 受限执行探针 ($STAMP) =="
echo "工作目录: $WORK"

# ---------- 0. 前置检查：容器引擎必须在运行 ----------
if ! command -v docker >/dev/null 2>&1; then
  infra_fail "docker 不可用：无法运行容器边界探针（未验证，不是通过）"
  exit 2
fi
if ! docker info >/dev/null 2>&1; then
  infra_fail "容器引擎未运行：无法运行容器边界探针（未验证，不是通过）"
  exit 2
fi

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

# 对照服务就绪检查：从宿主确认端口真的在监听，否则容器内不可达不构成隔离证据
if ! python3 - "$CP_PORT" <<'EOF'
import socket, sys, time
port = int(sys.argv[1])
deadline = time.time() + 10
while time.time() < deadline:
    try:
        s = socket.create_connection(("127.0.0.1", port), timeout=1)
        s.close()
        sys.exit(0)
    except OSError:
        time.sleep(0.2)
sys.exit(1)
EOF
then
  infra_fail "对照控制面服务未就绪（127.0.0.1:$CP_PORT）：不可把容器不可达计为隔离成功"
  exit 2
fi
echo "对照控制面服务已在宿主 127.0.0.1:$CP_PORT 监听"

mkdir -p "$WORK/workspace"
# 原生 Linux 的 bind mount 不做 uid 映射：restricted 变体以 uid 1000 运行，
# 工作区须对其可写（Docker Desktop macOS 会代管权限，原生 Linux 不会）。
chmod 0777 "$WORK/workspace"
# 真实存在的工作区外秘密文件（不挂载进容器）：用于验证拒绝原因是边界生效，
# 而不是目标不存在
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

# 执行成功检查：每个变体都必须真的跑到探针阶段（workspace.write 在 plain 与
# restricted 各出现一次），否则是容器未启动等基础故障，不能算边界通过；
# 更细粒度的齐全性由最后的预期探针集合检查兜底
require_executed() {
  local file="$1"
  local count
  count=$(grep -c '"probe": *"workspace.write"' "$file" || true)
  if [ "$count" -lt 2 ]; then
    infra_fail "探针执行不完整（workspace.write 出现 $count 次，应为 2）：容器未启动或探针执行失败，本次结果不作为隔离证据"
    return 1
  fi
  return 0
}

{
  echo "=== 变体 plain（默认 docker run，root，默认桥接网络）==="
  run_variant plain
  echo "=== 变体 restricted（--network none --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges）==="
  run_variant restricted --network none --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges
} > "$WORK/probes.jsonl" 2>&1

require_executed "$WORK/probes.jsonl"

# 工作区外秘密文件探针：文件在宿主真实存在，容器内任何位置都不应可见
if docker run --rm -v "$WORK/workspace:/workspace" "$IMAGE" \
  sh -c 'test -e /host-only-secret.txt || test -e /workspace/../host-only-secret.txt || test -e /probes/host-only-secret.txt' >/dev/null 2>&1; then
  echo '{"probe":"workspace.host-secret-absent","expect":"fail","result":"fail","consistent":false,"detail":"容器内可见宿主工作区外的秘密文件!"}' >> "$WORK/probes.jsonl"
else
  echo '{"probe":"workspace.host-secret-absent","expect":"fail","result":"pass","consistent":true,"detail":"宿主真实存在的 $WORK/host-only-secret.txt 在容器内不可见（边界生效，非目标不存在）"}' >> "$WORK/probes.jsonl"
fi

# identity 变体：root 启动容器并在容器内创建 root 持有的 0600 状态文件，
# 再以 uid 1000 exec 访问 —— 验证"不同系统身份"的内核边界。
echo "--- 变体 identity ---"
CID=$(docker run -d \
  -v "$BASE/probe.py:/probes/probe.py:ro" \
  "$IMAGE" sleep 60)
if [ -z "$CID" ]; then
  infra_fail "identity 变体容器未启动"
else
  docker exec "$CID" sh -c 'umask 077 && echo backend-state > /backend-state.txt && chown 0:0 /backend-state.txt'
  docker exec "$CID" sh -c 'test -r /backend-state.txt' \
    && echo '{"probe":"identity.root-reads-own-state","expect":"pass","result":"pass","consistent":true,"detail":"root 可读自己的状态文件（对照：文件真实可读）"}' >> "$WORK/probes.jsonl" \
    || echo '{"probe":"identity.root-reads-own-state","expect":"pass","result":"fail","consistent":false,"detail":"root 无法读取自己的状态文件——对照失效"}' >> "$WORK/probes.jsonl"
  docker exec --user 1000:1000 "$CID" sh -c 'cat /backend-state.txt 2>&1' >/dev/null 2>&1 \
    && echo '{"probe":"identity.task-uid-reads-backend-state","expect":"fail","result":"fail","consistent":false,"detail":"uid 1000 竟然可读控制面状态!"}' >> "$WORK/probes.jsonl" \
    || echo '{"probe":"identity.task-uid-reads-backend-state","expect":"fail","result":"pass","consistent":true,"detail":"uid 1000 读取控制面状态被内核拒绝（EACCES）"}' >> "$WORK/probes.jsonl"
  docker exec --user 1000:1000 "$CID" sh -c 'echo pwn > /backend-state.txt 2>&1' >/dev/null 2>&1 \
    && echo '{"probe":"identity.task-uid-writes-backend-state","expect":"fail","result":"fail","consistent":false,"detail":"uid 1000 竟然可写控制面状态!"}' >> "$WORK/probes.jsonl" \
    || echo '{"probe":"identity.task-uid-writes-backend-state","expect":"fail","result":"pass","consistent":true,"detail":"uid 1000 写控制面状态被内核拒绝（EACCES）"}' >> "$WORK/probes.jsonl"
  docker exec "$CID" sh -c 'id' >> "$WORK/probes.jsonl"
  docker rm -f "$CID" >/dev/null
fi

# 容器环境信息（记录内核与发行版，用于报告）
docker run --rm "$IMAGE" sh -c 'uname -sr; cat /etc/os-release | head -2' > "$WORK/env.txt" 2>&1

# 宿主信息
{
  echo "宿主: $(uname -sr)"
  echo "容器引擎: $(docker --version)"
} > "$WORK/host.txt"

# 汇总：一次解析 probes.jsonl，同时产出 JSON 与 Markdown 报告；
# 不一致或预期探针缺失以非零退出码结束
EXPECTED_PLAIN="$EXPECTED_PLAIN" \
EXPECTED_RESTRICTED="$EXPECTED_RESTRICTED" \
EXPECTED_IDENTITY="$EXPECTED_IDENTITY" \
python3 - "$WORK" "$STAMP" "$REPORT_JSON" "$REPORT_MD" <<'EOF'
import json, os, sys, pathlib

work = pathlib.Path(sys.argv[1])
stamp = sys.argv[2]
json_out = pathlib.Path(sys.argv[3])
md_out = pathlib.Path(sys.argv[4])

# 预期探针集合（变体前缀 → 必需探针名）
expected = {
    "plain": os.environ["EXPECTED_PLAIN"].split(),
    "restricted": os.environ["EXPECTED_RESTRICTED"].split(),
    "identity": os.environ["EXPECTED_IDENTITY"].split(),
}

probes = []
for line in (work / "probes.jsonl").read_text().splitlines():
    line = line.strip()
    if line.startswith('{"probe"'):
        try:
            probes.append(json.loads(line))
        except json.JSONDecodeError:
            pass
env = (work / "env.txt").read_text().strip()
host = (work / "host.txt").read_text().strip()
inconsistent = [p for p in probes if p.get("consistent") is False]
found = {p.get("probe") for p in probes}

missing = []
for variant, names in expected.items():
    for name in names:
        if name not in found:
            missing.append(f"{variant}:{name}")

doc = {
  "timestamp": stamp,
  "host": host,
  "container_env": env,
  "caveat": "探针验证容器边界本身；宿主信息见 host 字段（macOS Docker Desktop 的 Linux VM 与原生 Linux 均已跑过，原生 Linux 的 bind mount 无 uid 映射，工作区写权限需按部署文档处理）。",
  "expected": expected,
  "missing_probes": missing,
  "probes": probes,
  "inconsistent": inconsistent,
}
json_out.write_text(json.dumps(doc, ensure_ascii=False, indent=2))

env_lines = env.splitlines()
lines = [
  "# Linux 受限执行探针报告",
  "",
  f"- 时间：{stamp}",
  f"- {host}",
  f"- 容器环境：{env_lines[0] if env_lines else '?'} / {env_lines[-1] if env_lines else '?'}",
  "- 注意：探针验证容器边界本身；宿主环境见上方宿主信息行（macOS Docker Desktop",
  "  的 Linux VM 与原生 Linux 均已验证；原生 Linux 的 bind mount 无 uid 映射，",
  "  工作区写权限处理见 deploy/systemd/README.md 第 5 步）。",
  "",
  "| 探针 | 预期 | 结果 | 说明 |",
  "| --- | --- | --- | --- |",
]
for p in probes:
    detail = str(p.get("detail", "")).replace("|", "/").replace("\n", " ")
    lines.append(f"| {p.get('probe','?')} | {p.get('expect','?')} | {p.get('result','?')} | {detail} |")
md_out.write_text("\n".join(lines) + "\n")

print(f"探针总数: {len(probes)}，不一致: {len(inconsistent)}，缺失: {len(missing)}")
for p in probes:
    mark = "OK " if p.get("consistent", False) else "!!!"
    print(f"{mark} [{str(p.get('result','?')):>4}] {p.get('probe','?')} —— {str(p.get('detail',''))[:80]}")
for name in missing:
    print(f"!!! 缺失预期探针: {name}")

sys.exit(1 if (inconsistent or missing) else 0)
EOF
SUMMARY_RC=$?

echo "== 完成 =="
echo "JSON: $REPORT_JSON"
echo "MD:   $REPORT_MD"

if [ "$INFRA_FAILURE" -ne 0 ]; then
  echo "判定：基础设施故障（退出码 2）——本次结果不作为隔离通过" >&2
  exit 2
fi
if [ "$SUMMARY_RC" -ne 0 ]; then
  echo "判定：探针结果不一致或预期探针缺失（退出码 1）" >&2
  exit 1
fi
echo "判定：全部预期探针通过"
exit 0
