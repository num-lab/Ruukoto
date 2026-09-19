#!/usr/bin/env python3
"""
受限执行边界探针（在容器内运行）。

对工单要求的五类隔离逐项探测：文件、子进程、网络、凭据、后台控制接口。
每项输出一行 JSON：{"probe": 名称, "expect": "fail"|"pass", "result": "fail"|"pass", "detail": "..."}

expect=fail 表示安全要求是"该操作必须失败"；result 与 expect 一致才算通过。
用法：python3 probe.py <variant> [--tcp-probe PORT]
variant: plain | restricted | identity-victim
"""

import json
import os
import socket
import subprocess
import sys
import time

variant = sys.argv[1]
tcp_port = None
if "--tcp-probe" in sys.argv:
    tcp_port = int(sys.argv[sys.argv.index("--tcp-probe") + 1])

results = []


def record(probe, expect, attempt_succeeded, detail):
    """expect: 'pass'/'fail' —— 安全要求下该尝试应有的结果。
    attempt_succeeded: 尝试是否真的成功了。result 与 expect 一致 = 边界符合要求。"""
    result = "pass" if attempt_succeeded else "fail"
    results.append({
        "probe": probe,
        "expect": expect,
        "result": result,
        "consistent": result == expect,
        "detail": detail,
    })


def run(cmd, timeout=8):
    try:
        p = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
        return p.returncode, (p.stdout + p.stderr).strip()[:200]
    except subprocess.TimeoutExpired:
        return 124, "timeout"


# ---------- 文件隔离 ----------
rc, detail = run("touch /workspace/.probe-write")
record("workspace.write", "pass", rc == 0, f"touch /workspace: {detail}")

for host_path in ["/Users", "/home/eitrous", "/root/.pi", "/etc/ruukoto-backend", "/var/run/docker.sock"]:
    rc, _ = run(f"test -e {host_path}")
    record(f"hostfs.absent:{host_path}", "fail", rc == 0, "宿主路径在容器内不可见" if rc != 0 else "路径可见!")

if variant == "plain":
    # root 容器写的是容器自身的文件系统层，宿主隔离由 hostfs.absent 探针保证
    rc, detail = run("touch /etc/escape-write")
    record("rootfs.write-outside-workspace", "pass", rc == 0,
           "root 容器可写容器层（宿主隔离见 hostfs.absent.*）" if rc == 0 else "被拒绝")
else:
    rc, detail = run("touch /etc/escape-write")
    record("rootfs.write-outside-workspace", "fail", rc == 0, detail)

# ---------- 凭据隔离 ----------
rc, detail = run("env | grep -iE 'api_key|apikey|token|secret|sk-' || true")
record("credentials.env-clean", "pass", detail == "", "环境变量无凭据" if not detail else f"发现可疑变量: {detail}")

rc, _ = run("test -e $HOME/.pi || test -e /root/.pi")
record("credentials.no-pi-config", "fail", rc == 0, "容器内无 ~/.pi 配置与凭据" if rc != 0 else "发现 ~/.pi!")

# ---------- 子进程 ----------
rc, detail = run("sh -c 'echo subprocess-ok'")
record("subprocess.spawn", "pass", rc == 0, detail)

rc, detail = run("cat /proc/self/status | grep CapEff")
cap_eff = detail.split()[-1] if detail else "?"
record("subprocess.capabilities", "pass", True, f"CapEff={cap_eff} ({variant})")

rc, detail = run("mount -t tmpfs none /mnt 2>&1")
record("subprocess.mount-denied", "fail", rc == 0, detail or "mount 被拒绝")

# ---------- 网络 ----------
def tcp_connect(host, port, timeout=3):
    try:
        s = socket.create_connection((host, port), timeout=timeout)
        s.close()
        return True
    except OSError:
        return False

if variant == "restricted":
    ok_egress = tcp_connect("1.1.1.1", 443, 2)
    record("network.egress-blocked", "fail", ok_egress, "--network none 下外网 1.1.1.1:443 不可达" if not ok_egress else "外网可达!")

if tcp_port:
    rc, detail = run("ip route | grep default || cat /proc/net/route")
    gateway = None
    for line in detail.splitlines():
        parts = line.split()
        if len(parts) > 2 and parts[1] == "00000000":
            gw_hex = parts[2]
            gateway = ".".join(str(int(gw_hex[i:i+2], 16)) for i in (6, 4, 2, 0))
            break
    loopback_ok = tcp_connect("127.0.0.1", tcp_port, 2)
    record("control-plane.loopback-not-reachable", "fail", loopback_ok,
           "宿主回环监听的控制面端口从容器不可达" if not loopback_ok else "容器内 127.0.0.1 可达控制面!")
    if gateway:
        gw_ok = tcp_connect(gateway, tcp_port, 2)
        record("control-plane.gateway-loopback-service", "fail", gw_ok,
               f"网关 {gateway}:{tcp_port} 不可达（宿主只绑回环时的预期）" if not gw_ok else "经网关可达宿主回环服务——宿主配置异常")

# ---------- 输出 ----------
for r in results:
    print(json.dumps(r, ensure_ascii=False))
