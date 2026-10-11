#!/usr/bin/env python3
"""Linux bubblewrap 边界候选的真实探针；退出 0=通过，1=失败，2=不可验证。

python3 linux-native-probes.py [--bwrap /path/to/bwrap] [--output-dir DIR]
只创建临时虚拟资料和服务；不安装依赖、不修改系统策略、不触及在线实例。
这是第一阶段验证工具，未接入 WorkerLauncher；结果不代表产品已完成替换。
"""

import argparse
from contextlib import ExitStack
import ctypes
import datetime
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import time
import uuid


BOUNDARIES = [
    "workspace.read", "workspace.write", "workspace.identity", "grant.read", "grant.read-only",
    "grant.read-write", "subagent.read", "subagent.identity", "subagent.read-only",
    "subagent.ungranted-sibling", "git.shared-read", "git.shared-read-only",
    "host.secret-read", "host.secret-write", "host.control-read",
    "host.symlink", "host.parent-alias", "host.proc-root-alias",
    "credentials.environment", "credentials.inherited-fd",
    "control.loopback", "network.host-interface", "control.unix-private",
    "control.unix-workspace", "control.unix-abstract", "control.sysv-ipc",
    "control.posix-shm", "control.host-pid", "subprocess.secret-read",
    "subprocess.loopback", "toolchain.node", "toolchain.git",
    "stop.detached-descendant", "stop.launch-window", "stop.parent-crash",
    "namespace.user", "namespace.mnt", "namespace.net", "namespace.pid",
    "namespace.ipc", "namespace.uts", "namespace.cgroup", "network.udp",
    "stop.user-scope-cgroup", "stop.mode-change", "mode.rebuild", "stop.grant-change", "grant.rebuild-narrowed",
    "control.socketpair-sendto", "control.socketpair-sendmsg", "toolchain.node-child", "toolchain.cc",
]


def run(argv, **kwargs):
    return subprocess.run(argv, capture_output=True, text=True, timeout=10, **kwargs)


def row(name, passed, detail):
    return {"probe": name, "status": "pass" if passed else "fail", "detail": detail}


def inaccessible(action, evidence=None):
    try:
        action()
        return False
    except OSError as exc:
        if evidence is not None:
            evidence["errno"] = exc.errno
        if exc.errno in (errno.EACCES, errno.EPERM, errno.ENOENT, errno.EROFS,
                         errno.ECONNREFUSED, errno.ENETUNREACH, errno.ESRCH,
                         errno.EINVAL, errno.EFAULT, errno.EBADF):
            return True
        raise


def connect(address, family=socket.AF_INET):
    with socket.socket(family, socket.SOCK_STREAM) as client:
        client.settimeout(1)
        client.connect(address)


def inner(fixture):
    """真正进入 bwrap 后才打印 started；启动失败不能算拒绝操作成功。"""
    print(json.dumps({"started": True,
                      "apparmor_profile": Path("/proc/self/attr/current").read_text().strip()}), flush=True)
    rows = []

    for name, host_identity in fixture["namespaces"].items():
        identity = os.readlink(f"/proc/self/ns/{name}")
        rows.append(row("namespace." + name, identity != host_identity,
                        f"started=true，宿主 {host_identity}，沙箱 {identity}"))

    def check(name, action, allowed=False):
        try:
            operation = {}
            denied = inaccessible(action, operation)
            rows.append(row(name, denied != allowed,
                            f"started=true，操作{'被拒绝' if denied else '成功'}，errno={operation.get('errno')}"))
        except Exception as exc:
            rows.append(row(name, False, f"探针异常：{type(exc).__name__}: {exc}"))

    work = Path(fixture["workspace"])
    for name, target in [("workspace.identity", work), ("subagent.identity", Path(fixture["read_root"]))]:
        identity = target.stat()
        rows.append(row(name, [identity.st_dev, identity.st_ino] == fixture[name],
                        f"dev={identity.st_dev}, ino={identity.st_ino}"))
    check("workspace.read", lambda: (work / "input.txt").read_text(), True)
    check("workspace.write", lambda: (work / "output.txt").write_text("sandbox"), True)
    check("grant.read", lambda: Path(fixture["read_grant"]).read_text(), True)
    check("grant.read-only", lambda: Path(fixture["read_grant"]).write_text("changed"))
    check("grant.read-write", lambda: Path(fixture["write_grant"]).write_text("sandbox"), True)
    check("subagent.read", lambda: Path(fixture["read_root"]).read_text(), True)
    check("subagent.read-only", lambda: Path(fixture["read_root"]).write_text("changed"))
    check("subagent.ungranted-sibling", lambda: Path(fixture["read_sibling"]).read_text())
    check("git.shared-read", lambda: Path(fixture["shared_git"]).read_text(), True)
    check("git.shared-read-only", lambda: Path(fixture["shared_git"]).write_text("changed"))
    check("host.secret-read", lambda: Path(fixture["secret"]).read_text())
    check("host.secret-write", lambda: Path(fixture["secret"]).write_text("changed"))
    check("host.control-read", lambda: Path(fixture["control"]).read_text())
    check("host.symlink", lambda: (work / "host-link").read_text())
    check("host.parent-alias", lambda: (work / ".." / "private" / "secret").read_text())
    check("host.proc-root-alias", lambda: Path(
        f"/proc/{fixture['host_pid']}/root{fixture['secret']}").read_text())
    rows.append(row("credentials.environment", not any(key in os.environ for key in fixture["env_keys"]),
                    "仅检查专为本次运行设置的虚拟凭据变量"))
    check("credentials.inherited-fd", lambda: os.read(fixture["fd"], 1))
    check("control.loopback", lambda: connect(("127.0.0.1", fixture["port"])))
    check("network.host-interface", lambda: connect((fixture["host_ip"], fixture["port"])))
    check("network.udp", lambda: send_udp((fixture["host_ip"], fixture["udp_port"])))
    check("control.unix-private", lambda: connect(fixture["unix_private"], socket.AF_UNIX))
    check("control.unix-workspace", lambda: connect(fixture["unix_workspace"], socket.AF_UNIX))
    for name, sendmsg in [("control.socketpair-sendto", False), ("control.socketpair-sendmsg", True)]:
        check(name, lambda sendmsg=sendmsg: send_socketpair(fixture["unix_datagram"], sendmsg))
    check("control.unix-abstract", lambda: connect("\0" + fixture["unix_abstract"], socket.AF_UNIX))
    check("control.sysv-ipc", lambda: attach_shm(fixture["shmid"]))
    check("control.posix-shm", lambda: Path(fixture["posix_shm"]).read_text())
    check("control.host-pid", lambda: os.kill(fixture["host_pid"], 0))
    for name, operation, target in [("subprocess.secret-read", "read", fixture["secret"]),
                                     ("subprocess.loopback", "connect", str(fixture["port"]))]:
        result = run(["/bin/sh", "-c",
                      'exec sh -c \'exec python3 /probe.py --child-operation "$1" --target "$2"\' sh "$1" "$2"',
                      "sh", operation, target])
        rows.append(child_result(name, result.stdout, result.stderr, result.returncode))
    for name, command in [("toolchain.node", ["node", "-e", "process.stdout.write('node-ok')"]),
                          ("toolchain.node-child", ["node", "-e", "const r=require('child_process').spawnSync('sh',['-c','printf child-ok']); if(r.status!==0)process.exit(1); process.stdout.write(r.stdout)"]),
                          ("toolchain.git", ["git", "--version"])]:
        result = run(command)
        rows.append(row(name, result.returncode == 0, (result.stdout + result.stderr).strip()))
    source = Path("/tmp/native-probe.c")
    binary = "/tmp/native-probe-cc"
    source.write_text("int main(void) { return 0; }\n")
    compile_result = run(["cc", str(source), "-o", binary])
    result = run([binary]) if compile_result.returncode == 0 else compile_result
    rows.append(row("toolchain.cc", result.returncode == 0,
                    f"started=true，C 编译退出 {compile_result.returncode}，执行退出 {result.returncode}，{result.stderr.strip()}"))
    for item in rows:
        print(json.dumps(item, ensure_ascii=False), flush=True)


LIBC = ctypes.CDLL(None, use_errno=True)
LIBC.shmat.restype = ctypes.c_void_p


def attach_shm(shmid):
    address = LIBC.shmat(shmid, None, 0)
    if address == ctypes.c_void_p(-1).value:
        raise OSError(ctypes.get_errno(), "shmat")
    LIBC.shmdt(ctypes.c_void_p(address))


def send_udp(address):
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as client:
        client.sendto(b"virtual-probe-only", address)


def send_socketpair(address, sendmsg=False):
    client, peer = socket.socketpair(socket.AF_UNIX, socket.SOCK_DGRAM)
    with client, peer:
        if sendmsg:
            client.sendmsg([b"virtual-pair-only"], [], 0, address)
        else:
            client.sendto(b"virtual-pair-only", address)


def seccomp_filter(machine):
    architectures = {"x86_64": (0xC000003E, [41, 42, 44, 46, 307, 425]),
                     "aarch64": (0xC00000B7, [198, 203, 206, 211, 269, 425])}
    if machine not in architectures:
        raise RuntimeError(f"seccomp 不支持架构 {machine}，拒绝无过滤启动")
    architecture, syscalls = architectures[machine]
    # 先核实 audit arch 并拒绝 x32；保留 socketpair，阻断路径 socket 与 io_uring 建网绕过。
    instructions = [(0x20, 0, 0, 4), (0x15, 1, 0, architecture), (0x06, 0, 0, 0x80000000),
                    (0x20, 0, 0, 0), (0x45, 0, 1, 0x40000000), (0x06, 0, 0, 0x80000000)]
    for syscall in syscalls:
        instructions += [(0x15, 0, 1, syscall), (0x06, 0, 0, 0x00050000 | errno.EPERM)]
    instructions.append((0x06, 0, 0, 0x7FFF0000))
    return b"".join(struct.pack("<HBBI", *item) for item in instructions)


def heartbeat(target):
    # setsid、双重 fork 和忽略 TERM 同时覆盖脱离原进程组的后代。
    if os.fork():
        return
    os.setsid()
    if os.fork():
        os._exit(0)
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    while True:
        with open(target, "a") as output:
            output.write(f"{os.getpid()}\n")
            output.flush()
        time.sleep(0.05)


def child_operation(operation, target):
    print(json.dumps({"started": True}), flush=True)
    try:
        if operation == "read":
            Path(target).read_text()
        else:
            connect(("127.0.0.1", int(target)))
    except OSError as exc:
        allowed_errors = (errno.EACCES, errno.EPERM, errno.ENOENT) if operation == "read" else (
            errno.EACCES, errno.EPERM, errno.ECONNREFUSED, errno.ENETUNREACH, errno.EHOSTUNREACH)
        print(json.dumps({"errno": exc.errno, "denied": exc.errno in allowed_errors}), flush=True)
    else:
        print(json.dumps({"denied": False, "errno": None}), flush=True)


def child_result(name, stdout, stderr, code):
    started, _ = collect(stdout)
    if not started or code != 0:
        return {"probe": name, "status": "unavailable", "detail": f"子探针未完整执行（退出 {code}）：{stderr.strip()}"}
    for line in stdout.splitlines():
        try:
            evidence = json.loads(line)
        except json.JSONDecodeError:
            continue
        if "denied" in evidence:
            return row(name, evidence["denied"] is True, f"子探针已启动，errno={evidence.get('errno')}，退出 {code}")
    return {"probe": name, "status": "unavailable", "detail": "子探针已启动但没有操作结果"}


def heartbeat_processes(target):
    """只终止同一宿主 UID、argv 含本次唯一心跳路径的探针进程。"""
    processes = {}
    marker = os.fsencode(target)
    for entry in Path("/proc").iterdir():
        if not entry.name.isdecimal() or int(entry.name) == os.getpid():
            continue
        try:
            uid = next(line.split()[1] for line in (entry / "status").read_text().splitlines()
                       if line.startswith("Uid:"))
            if int(uid) != os.getuid():
                continue
            command = (entry / "cmdline").read_bytes().split(b"\0")
            if marker in command and b"--heartbeat" in command:
                processes[int(entry.name)] = (entry / "stat").read_text().rsplit(")", 1)[1].split()[19]
        except OSError as exc:
            if exc.errno not in (errno.ENOENT, errno.ESRCH):
                raise
    return processes


def cleanup_heartbeat(target):
    deadline = time.monotonic() + 3
    killed = set()
    while time.monotonic() < deadline:
        processes = heartbeat_processes(target)
        for pid, start_time in processes.items():
            descriptor = None
            try:
                descriptor = os.pidfd_open(pid)
                # pidfd 固定实际进程，再复核 argv、UID 和启动时刻，避免 PID 重用误杀。
                if heartbeat_processes(target).get(pid) == start_time:
                    signal.pidfd_send_signal(descriptor, signal.SIGKILL)
                    killed.add(pid)
            except ProcessLookupError:
                pass
            finally:
                if descriptor is not None:
                    os.close(descriptor)
        time.sleep(0.1)
        if not heartbeat_processes(target):
            before = target.stat().st_size if target.exists() else 0
            time.sleep(0.3)
            after = target.stat().st_size if target.exists() else 0
            if before == after and not heartbeat_processes(target):
                return {"stopped": True, "killed_host_pids": sorted(killed), "bytes": [before, after]}
    return {"stopped": False, "killed_host_pids": sorted(killed)}


def sandbox_args(bwrap, fixture, script, write_grant=True, seccomp_fd=None):
    args = [bwrap, "--unshare-all", "--die-with-parent", "--new-session", "--clearenv",
            "--cap-drop", "ALL", "--ro-bind", "/usr", "/usr"]
    for target in ("/bin", "/sbin", "/lib", "/lib64"):
        if Path(target).exists():
            if Path(target).is_symlink():
                args += ["--symlink", os.readlink(target), target]
            else:
                args += ["--ro-bind", target, target]
    if Path("/etc/alternatives/cc").exists():
        args += ["--symlink", str(Path("/etc/alternatives/cc").resolve()), "/etc/alternatives/cc"]
    args += ["--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
             "--dir", "/sandbox-home", "--setenv", "HOME", "/sandbox-home",
             "--setenv", "PATH", "/usr/local/bin:/usr/bin:/bin",
             "--setenv", "LANG", "C.UTF-8", "--ro-bind", str(script), "/probe.py",
             "--bind", fixture["workspace"], fixture["workspace"],
             "--ro-bind", fixture["read_grant"], fixture["read_grant"],
             "--ro-bind", fixture["read_root"], fixture["read_root"],
             "--ro-bind", str(Path(fixture["shared_git"]).parent), str(Path(fixture["shared_git"]).parent),
             "--chdir", fixture["workspace"]]
    if write_grant:
        args += ["--bind", fixture["write_grant"], fixture["write_grant"]]
    if seccomp_fd is not None:
        args += ["--seccomp", str(seccomp_fd)]
    return args


def scope_stop(script, target, evidence):
    """user scope 的 cgroup.kill 独立于 PID namespace 回收整组脱离后代。"""
    unit = "ruukoto-native-stop-" + uuid.uuid4().hex + ".scope"
    systemd_env = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8",
                   "XDG_RUNTIME_DIR": f"/run/user/{os.getuid()}"}
    marker = Path(str(target) + ".scope")
    command = ["systemd-run", "--user", "--scope", "--quiet", "--unit", unit,
               "--property", "Delegate=yes", "python3", str(script),
               "--heartbeat", str(target), "--scope-marker", str(marker)]
    child = subprocess.Popen(command, env=systemd_env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and (not marker.exists() or not target.exists()):
            time.sleep(0.05)
        if not marker.exists() or not target.exists():
            raise RuntimeError("user scope 未实际启动心跳")
        info = json.loads(marker.read_text())
        cgroup = Path("/sys/fs/cgroup") / info["cgroup"].lstrip("/")
        if not info["started"] or cgroup.name != unit:
            raise RuntimeError("user scope 身份与启动标记不匹配")
        before = target.stat().st_size
        time.sleep(0.2)
        if target.stat().st_size <= before:
            raise RuntimeError("user scope 的脱离后代未持续写入")
        members = heartbeat_processes(target)
        for pid in members:
            identity = Path(f"/proc/{pid}/cgroup").read_text().strip().split(":", 2)[2]
            if identity != info["cgroup"]:
                raise RuntimeError("心跳后代不在本次 scope 中，不能核实整单元回收")
        with (cgroup / "cgroup.events").open() as events:
            (cgroup / "cgroup.kill").write_text("1")
            child.wait(timeout=5)
            time.sleep(0.2)
            before = target.stat().st_size
            time.sleep(0.3)
            after = target.stat().st_size
            remaining = heartbeat_processes(target)
            try:
                events.seek(0)
                populated = events.read().strip()
            except OSError as exc:
                # systemd 可在 scope 清空后移除 cgroup；已删除的 events 描述符返回 ENODEV。
                if exc.errno != errno.ENODEV or cgroup.exists():
                    raise
                populated = "populated 0（scope 已移除）"
        evidence["scope_stop"] = {**info, "unit": unit, "member_host_pids": list(members),
                                   "bytes": [before, after], "cgroup_events": populated,
                                   "remaining_host_pids": list(remaining), "mechanism": "cgroup.kill"}
        return row("stop.user-scope-cgroup", before == after and not remaining and "populated 0" in populated,
                   f"started=true，cgroup.kill 后心跳 {before}→{after}，{populated}，残留 PID={list(remaining)}")
    finally:
        run(["systemctl", "--user", "kill", "--kill-whom=all", "--signal=KILL", unit], env=systemd_env)
        if child.poll() is None:
            child.wait(timeout=5)


def collect(output, code=0):
    documents = []
    for line in output.splitlines():
        try:
            documents.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return code == 0 and any(item.get("started") for item in documents), [item for item in documents if "probe" in item]


def decision(rows, infrastructure_ok=True):
    if not infrastructure_ok or any(item["status"] == "unavailable" for item in rows):
        return 2
    return 1 if any(item["status"] == "fail" for item in rows) else 0


def main(options):
    rows = []
    evidence = {}
    bwrap = shutil.which(options.bwrap)
    script = Path(__file__).resolve()
    evidence["probe_sha256"] = hashlib.sha256(script.read_bytes()).hexdigest()
    cleanup_safe = True
    with ExitStack() as temporary:
        root = Path(tempfile.mkdtemp(prefix="ruukoto-native-linux-")).resolve()
        # 无法核实后代停止时保留资料，不能用删除心跳文件掩盖仍活动的进程。
        temporary.callback(lambda: shutil.rmtree(root) if cleanup_safe else None)
        for directory in ("workspace", "private", "read-grant", "write-grant", "subagent", "shared-git"):
            (root / directory).mkdir()
        fixture = {
            "workspace": str(root / "workspace"), "secret": str(root / "private" / "secret"),
            "control": str(root / "private" / "owner-token"),
            "read_grant": str(root / "read-grant" / "file"),
            "write_grant": str(root / "write-grant" / "file"),
            "read_root": str(root / "subagent" / "allowed"),
            "read_sibling": str(root / "subagent" / "sibling"),
            "shared_git": str(root / "shared-git" / "HEAD"),
            "unix_private": str(root / "private" / "socket"),
            "unix_workspace": str(root / "workspace" / "host-control.socket"),
            "unix_datagram": str(root / "workspace" / "host-datagram.socket"),
            "unix_abstract": "ruukoto-native-" + uuid.uuid4().hex,
            "env_keys": ["RUUKOTO_OWNER_TOKEN", "AWS_SECRET_ACCESS_KEY", "SSH_AUTH_SOCK", "DBUS_SESSION_BUS_ADDRESS"],
            "namespaces": {name: os.readlink(f"/proc/self/ns/{name}")
                           for name in ("user", "mnt", "net", "pid", "ipc", "uts", "cgroup")},
        }
        for name in ("secret", "control", "read_grant", "write_grant", "read_root", "read_sibling", "shared_git"):
            Path(fixture[name]).write_text("virtual-fixture-only")
        (root / "workspace" / "input.txt").write_text("workspace")
        (root / "workspace" / "host-link").symlink_to(fixture["secret"])
        for name, target in [("workspace.identity", root / "workspace"), ("subagent.identity", Path(fixture["read_root"]))]:
            identity = target.stat()
            fixture[name] = [identity.st_dev, identity.st_ino]
        sockets = []
        victim = subprocess.Popen(["/bin/sleep", "120"])
        fixture["host_pid"] = victim.pid
        shmid = LIBC.shmget(0, 1, 0o600)
        fixture["shmid"] = shmid
        posix = Path("/dev/shm") / ("ruukoto-native-" + uuid.uuid4().hex)
        descriptor = os.open(fixture["secret"], os.O_RDONLY)
        protected_descriptor = fcntl.fcntl(descriptor, fcntl.F_DUPFD_CLOEXEC, 100)
        os.close(descriptor)
        descriptor = protected_descriptor
        fixture["fd"] = descriptor
        try:
            posix.write_text("virtual-ipc-fixture")
            fixture["posix_shm"] = str(posix)
            attach_shm(shmid)
            route = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            try:
                # connect 只查询路由，不发送 UDP 数据；测试服务仍由本脚本创建。
                route.connect(("192.0.2.1", 9))
                fixture["host_ip"] = route.getsockname()[0]
            finally:
                route.close()
            for name, address, family in [
                ("tcp", ("0.0.0.0", 0), socket.AF_INET),
                ("unix_private", fixture["unix_private"], socket.AF_UNIX),
                ("unix_workspace", fixture["unix_workspace"], socket.AF_UNIX),
                ("unix_abstract", "\0" + fixture["unix_abstract"], socket.AF_UNIX),
            ]:
                server = socket.socket(family, socket.SOCK_STREAM)
                server.bind(address)
                server.listen(64)
                sockets.append(server)
                if name == "tcp":
                    fixture["port"] = server.getsockname()[1]
            udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            udp.bind(("0.0.0.0", 0))
            udp.settimeout(1)
            sockets.append(udp)
            fixture["udp_port"] = udp.getsockname()[1]
            datagram = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
            datagram.bind(fixture["unix_datagram"])
            datagram.settimeout(1)
            sockets.append(datagram)
            # 先实际访问全部敏感目标、额外授予和自建服务；对照失败即不可验证。
            for name in ("secret", "control", "read_grant", "write_grant", "read_root", "read_sibling", "shared_git"):
                assert Path(fixture[name]).read_text() == "virtual-fixture-only"
                Path(fixture[name]).write_text("virtual-fixture-only")
            assert (root / "workspace" / "host-link").read_text() == "virtual-fixture-only"
            assert (root / "workspace" / ".." / "private" / "secret").read_text() == "virtual-fixture-only"
            assert Path(f"/proc/{victim.pid}/root{fixture['secret']}").read_text() == "virtual-fixture-only"
            assert os.read(descriptor, 1) == b"v"
            os.lseek(descriptor, 0, os.SEEK_SET)
            connect(("127.0.0.1", fixture["port"]))
            connect((fixture["host_ip"], fixture["port"]))
            send_udp((fixture["host_ip"], fixture["udp_port"]))
            assert udp.recv(64) == b"virtual-probe-only", "宿主 UDP 对照未收到数据"
            for sendmsg in (False, True):
                send_socketpair(fixture["unix_datagram"], sendmsg)
                assert datagram.recv(64) == b"virtual-pair-only", "宿主 socketpair 对照未收到数据"
            for name in ("unix_private", "unix_workspace"):
                connect(fixture[name], socket.AF_UNIX)
            connect("\0" + fixture["unix_abstract"], socket.AF_UNIX)
            os.kill(victim.pid, 0)
            source = root / "private" / "host-control.c"
            binary = root / "private" / "host-control-cc"
            source.write_text("int main(void) { return 0; }\n")
            assert run(["cc", str(source), "-o", str(binary)]).returncode == 0, "宿主 C 编译对照失败"
            assert run([str(binary)]).returncode == 0, "宿主 C 执行对照失败"
            rows.append(row("controls.fixtures-and-services", True,
                            "虚拟敏感文件可读写，符号链接/父路径/proc 别名可读；TCP/UDP、文件及 abstract Unix socket、socketpair datagram、FD、SysV/POSIX IPC、宿主 PID 与 C 编译执行对照有效"))
            target = root / "workspace" / "control.heartbeat"
            ready = Path(str(target) + ".ready")
            if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
                raise RuntimeError("安全回收探针需要 Python pidfd API；未启动心跳，不按裸 PID 发送信号")
            control = subprocess.Popen([sys.executable, str(script), "--heartbeat", str(target), "--launch-ready", str(ready)],
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline and not ready.exists():
                    time.sleep(0.05)
                assert ready.exists(), "未沙箱启动窗口握手未出现"
                assert not target.exists(), "等待初始化时提前启动后代"
                Path(str(ready) + ".release").write_text("release")
                while time.monotonic() < deadline and (not target.exists() or target.stat().st_size < 4):
                    time.sleep(0.05)
                assert target.exists(), "未沙箱心跳未启动"
                before = target.stat().st_size
                time.sleep(0.2)
                assert target.stat().st_size > before, "未沙箱心跳未持续写入"
                control.kill()
                control.wait(timeout=5)
                before = target.stat().st_size
                time.sleep(0.2)
                assert target.stat().st_size > before, "未沙箱后代没有脱离主进程继续执行"
            finally:
                if control.poll() is None:
                    control.kill()
                    control.wait(timeout=5)
                try:
                    cleanup = cleanup_heartbeat(target)
                except Exception as exc:
                    cleanup = {"stopped": False, "reason": f"{type(exc).__name__}: {exc}"}
                evidence["control_heartbeat_cleanup"] = cleanup
                if not cleanup["stopped"]:
                    cleanup_safe = False
                    evidence["retained_fixture_root"] = str(root)
                    raise RuntimeError("未沙箱对照后代无法核实停止，保留临时资料")
            rows.append(row("controls.detached-heartbeat-cleanup", True,
                            "初始化 ready→release 后心跳实际启动；双重 fork + setsid + 忽略 TERM 的未沙箱后代在主进程 SIGKILL 后继续写入；宿主按唯一 argv 核实并回收后心跳冻结"))
            target = root / "workspace" / "scope.heartbeat"
            try:
                rows.append(scope_stop(script, target, evidence))
            except Exception as exc:
                rows.append({"probe": "stop.user-scope-cgroup", "status": "unavailable",
                             "detail": f"{type(exc).__name__}: {exc}"})
            finally:
                try:
                    cleanup = cleanup_heartbeat(target)
                except Exception as exc:
                    cleanup = {"stopped": False, "reason": f"{type(exc).__name__}: {exc}"}
                evidence["scope_cleanup"] = cleanup
                if not cleanup["stopped"]:
                    cleanup_safe = False
                    evidence["retained_fixture_root"] = str(root)
                    raise RuntimeError("scope 后代无法核实停止，保留临时资料")
            evidence["prerequisites"] = {
                "formal_bwrap_path": "/usr/bin/bwrap", "formal_bwrap_available": os.access("/usr/bin/bwrap", os.X_OK),
                "selected_bwrap": bwrap, "user_systemd": run(["systemctl", "--user", "is-system-running"]).stdout.strip(),
                "cgroup_v2": Path("/sys/fs/cgroup/cgroup.controllers").exists(),
            }
            profile = Path("/etc/apparmor.d/ruukoto-bwrap")
            evidence["prerequisites"]["profile_file"] = profile.read_text() if profile.exists() else "missing"
            try:
                evidence["prerequisites"]["loaded_profiles"] = Path("/sys/kernel/security/apparmor/profiles").read_text()
            except OSError as exc:
                evidence["prerequisites"]["loaded_profiles"] = f"unreadable: errno={exc.errno}；实际 user namespace 启动另行验证"
            if not bwrap:
                raise FileNotFoundError("/usr/bin/bwrap 未安装或指定路径不可执行；管理员按 deploy/native/README.md 安装并加载 profile")
            evidence["bwrap_version"] = run([bwrap, "--version"]).stdout.strip()
            env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8"}
            env.update({key: "virtual-sentinel-only" for key in fixture["env_keys"]})
            seccomp = None if options.namespace_only else temporary.enter_context(tempfile.TemporaryFile())
            passed_fds = (descriptor,) if options.inherit_fixture_fd else ()
            if seccomp:
                seccomp.write(seccomp_filter(platform.machine()))
                seccomp.seek(0)
                passed_fds += (seccomp.fileno(),)
            evidence["launch_policy"] = {"seccomp": not options.namespace_only,
                "denied_syscalls": ["socket", "connect", "sendto", "sendmsg", "sendmmsg", "io_uring_setup"] if seccomp else [],
                "inherited_fixture_fd": options.inherit_fixture_fd, "passed_fds": list(passed_fds)}
            args = sandbox_args(bwrap, fixture, script, seccomp_fd=seccomp.fileno() if seccomp else None)
            probe = run(args + ["python3", "/probe.py", "--inner", json.dumps(fixture)],
                        env=env, pass_fds=passed_fds)
            evidence["launch"] = {"exit_code": probe.returncode, "stderr": probe.stderr,
                                  "argv": args, "stdout": probe.stdout}
            started, inner_rows = collect(probe.stdout, probe.returncode)
            if not started:
                evidence["capability_diagnostics"] = []
                for namespace in ("user", "pid", "ipc", "net"):
                    isolated = sandbox_args(bwrap, fixture, script)
                    isolated[isolated.index("--unshare-all")] = "--unshare-" + namespace
                    result = run(isolated + ["/bin/true"], env=env)
                    evidence["capability_diagnostics"].append({"namespace": namespace,
                        "exit_code": result.returncode, "stderr": result.stderr})
                if shutil.which("unshare"):
                    result = run(["unshare", "-Ur", "/bin/true"], env=env)
                    evidence["unshare_uid_map"] = {"exit_code": result.returncode, "stderr": result.stderr}
                if shutil.which("systemd-run"):
                    unit = "ruukoto-native-capability-" + uuid.uuid4().hex
                    systemd_env = {"PATH": env["PATH"], "LANG": env["LANG"],
                                   "XDG_RUNTIME_DIR": f"/run/user/{os.getuid()}"}
                    result = run(["systemd-run", "--user", "--wait", "--pipe", "--quiet", "--collect",
                                  "--unit", unit] + sandbox_args(bwrap, fixture, script) + ["/bin/true"], env=systemd_env)
                    evidence["user_systemd_launch"] = {"exit_code": result.returncode,
                                                        "stderr": result.stderr, "unit": unit}
                raise RuntimeError(f"bwrap 探针未完整执行（退出 {probe.returncode}）：{probe.stderr.strip()}")
            rows.extend(inner_rows)
            for label, action in [("stop.detached-descendant", "kill"),
                                  ("stop.launch-window", "immediate"),
                                  ("stop.parent-crash", "parent"),
                                  ("stop.mode-change", "mode"),
                                  ("stop.grant-change", "grant")]:
                target = root / "workspace" / (label + ".heartbeat")
                ready = Path(str(target) + ".ready")
                command = args + ["python3", "/probe.py", "--heartbeat", str(target), "--launch-ready", str(ready)]
                if seccomp:
                    seccomp.seek(0)
                if action == "parent":
                    # exec 前的 parent 故障：父进程被 SIGKILL，bwrap 必须整单元停掉。
                    parent_code = f"import subprocess,sys,time; p=subprocess.Popen(sys.argv[1:],pass_fds={passed_fds!r}); print(p.pid,flush=True); time.sleep(30)"
                    child = subprocess.Popen(["python3", "-c", parent_code] + command,
                                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env, pass_fds=passed_fds)
                else:
                    child = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                             text=True, env=env, pass_fds=passed_fds)
                deadline = time.monotonic() + 5
                try:
                    while time.monotonic() < deadline and not ready.exists():
                        time.sleep(0.05)
                    if not ready.exists() or json.loads(ready.read_text()).get("started") is not True:
                        raise RuntimeError("本次 sandbox 未实际进入初始化窗口，不能验证启动或停止")
                    if action != "immediate":
                        Path(str(ready) + ".release").write_text("release")
                        while time.monotonic() < deadline and (not target.exists() or target.stat().st_size < 4):
                            time.sleep(0.05)
                        if not target.exists() or target.stat().st_size < 4:
                            raise RuntimeError("后代心跳未实际启动")
                        before = target.stat().st_size
                        time.sleep(0.2)
                        assert target.stat().st_size > before, "心跳对照未持续写入"
                    child.kill()
                    child.wait(timeout=5)
                    time.sleep(0.3)
                    before = target.stat().st_size if target.exists() else 0
                    time.sleep(0.4)
                    after = target.stat().st_size if target.exists() else 0
                    remaining = heartbeat_processes(target)
                    stopped = before == after and not remaining
                    rows.append(row(label, stopped,
                                    f"started=true，SIGKILL 后心跳字节数 {before}→{after}，残留本次探针 PID={list(remaining)}"))
                    evidence.setdefault("native_stop", {})[label] = {
                        "started": True, "bytes": [before, after], "remaining_host_pids": list(remaining),
                        "initialization_released": action != "immediate", "mechanism": "PID namespace + die-with-parent"}
                    if action in ("mode", "grant"):
                        if not stopped:
                            raise RuntimeError("旧执行停止未核实，拒绝建立替代执行环境")
                        rebuild = sandbox_args(bwrap, fixture, script, write_grant=action == "mode",
                                               seccomp_fd=seccomp.fileno() if seccomp else None)
                        if seccomp:
                            seccomp.seek(0)
                        result = run(rebuild + ["python3", "/probe.py", "--grant-check", fixture["write_grant"],
                                                "--expect-grant", "write" if action == "mode" else "none"], env=env, pass_fds=passed_fds)
                        started, rebuilt_rows = collect(result.stdout, result.returncode)
                        evidence.setdefault("rebuild", {})[label] = {"stdout": result.stdout,
                            "stderr": result.stderr, "exit_code": result.returncode, "old_unit_stopped": stopped}
                        if not started or not rebuilt_rows:
                            raise RuntimeError("替代沙箱未完整启动，不能核实模式/授予变化")
                        rows.extend(rebuilt_rows)
                finally:
                    if child.poll() is None:
                        child.kill()
                        child.wait(timeout=5)
                    try:
                        cleanup = cleanup_heartbeat(target)
                    except Exception as exc:
                        cleanup = {"stopped": False, "reason": f"{type(exc).__name__}: {exc}"}
                    evidence.setdefault("heartbeat_cleanup", {})[label] = cleanup
                    child.stdout.close()
                    child.stderr.close()
                    if not cleanup["stopped"]:
                        cleanup_safe = False
                        evidence["retained_fixture_root"] = str(root)
                        raise RuntimeError("原生后代无法核实停止，保留临时资料")
        except Exception as exc:
            evidence["unavailable_reason"] = f"{type(exc).__name__}: {exc}"
        finally:
            os.close(descriptor)
            victim.kill()
            victim.wait(timeout=5)
            if shmid >= 0:
                LIBC.shmctl(shmid, 0, None)
            posix.unlink(missing_ok=True)
            for server in sockets:
                server.close()

    found = {item["probe"] for item in rows}
    for name in BOUNDARIES:
        if name not in found:
            rows.append({"probe": name, "status": "unavailable",
                         "detail": evidence.get("unavailable_reason", "探针结果缺失")})
    environment = {"platform": platform.platform(), "uid": os.getuid(), "gid": os.getgid()}
    for target in ("/proc/self/attr/current", "/sys/module/apparmor/parameters/enabled", "/etc/os-release"):
        source = Path(target)
        environment[target] = source.read_text().strip() if source.exists() else "missing"
    for name in ("kernel/unprivileged_userns_clone", "kernel/apparmor_restrict_unprivileged_userns", "user/max_user_namespaces"):
        source = Path("/proc/sys") / name
        environment[name] = source.read_text().strip() if source.exists() else "missing"
    report = {"timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "environment": environment, "evidence": evidence, "probes": rows,
              "controller_status": "unavailable" if "unavailable_reason" in evidence else "pass",
              "exit_code": decision(rows, "unavailable_reason" not in evidence),
              "limitations": ["尚未接入产品；未验证 WorkerLauncher、审批消费或任务占用恢复。模式/授予变化仅验证控制器先停旧单元、再启动替代沙箱。",
                              "工作区中的宿主 Unix socket 必须不可达；纯文件 bind 与网络 namespace 不足时此项将失败。",
                              "启动窗口使用 sandbox Python 的 ready 握手和延迟初始化；不代表完整产品启动竞态已通过。"]}
    options.output_dir.mkdir(parents=True, exist_ok=True)
    report_name = "native-linux-namespace-only-report" if options.namespace_only else "native-linux-current-report"
    (options.output_dir / (report_name + ".json")).write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    counts = {status: sum(item["status"] == status for item in rows if item["probe"] in BOUNDARIES)
              for status in ("pass", "fail", "unavailable")}
    lines = ["# Linux 原生边界验证", "", f"环境：{environment['platform']}，UID={environment['uid']}，GID={environment['gid']}",
             f"时间：{report['timestamp']}", f"判定退出码：{report['exit_code']}（0=通过，1=失败，2=不可验证）", "",
             f"真实边界：{counts['pass']} 项 pass、{counts['fail']} 项 fail、{counts['unavailable']} 项 unavailable；对照成功不计为边界通过。", "",
             "| 探针 | 结果 | 说明 |", "| --- | --- | --- |"]
    for item in rows:
        detail = item["detail"].replace("|", "/").replace("\n", " ")
        lines.append(f"| {item['probe']} | {item['status']} | {detail} |")
    lines += ["", "验证边界："] + [f"- {item}" for item in report["limitations"]]
    if "prerequisites" in evidence:
        prerequisites = evidence["prerequisites"]
        lines += ["", "运行前置：", "",
                  f"- 正式 `/usr/bin/bwrap` 可用：{prerequisites['formal_bwrap_available']}；实际选择 `{prerequisites['selected_bwrap']}`。",
                  f"- user systemd：{prerequisites['user_systemd']}；cgroup v2：{prerequisites['cgroup_v2']}。",
                  "- AppArmor profile 文件与实际启动输出保存在 JSON；进程必须实际完成完整 namespace 的 started 握手。",
                  f"- 策略：{json.dumps(evidence.get('launch_policy', {}), ensure_ascii=False)}。",
                  f"- 本次探针 SHA-256：`{evidence['probe_sha256']}`。"]
    if "capability_diagnostics" in evidence:
        lines += ["", "启动前置诊断：", "", "| 尝试 | 退出码 | 实际错误 |", "| --- | --- | --- |"]
        diagnostics = [("bwrap --unshare-" + item["namespace"], item) for item in evidence["capability_diagnostics"]]
        diagnostics += [(name, evidence[name]) for name in ("unshare_uid_map", "user_systemd_launch") if name in evidence]
        for name, result in diagnostics:
            detail = result["stderr"].strip().replace("|", "/").replace("\n", " ")
            lines.append(f"| {name} | {result['exit_code']} | {detail} |")
        lines += ["", "系统策略的记录值见 JSON environment；本脚本没有改 sysctl、AppArmor 或全局安装包。"]
    (options.output_dir / (report_name + ".md")).write_text("\n".join(lines) + "\n")
    print(json.dumps({"exit_code": report["exit_code"], "counts": {
        value: sum(item["status"] == value for item in rows) for value in ("pass", "fail", "unavailable")},
        "unavailable_reason": evidence.get("unavailable_reason")}, ensure_ascii=False))
    return report["exit_code"]


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bwrap", default="/usr/bin/bwrap")
    parser.add_argument("--namespace-only", action="store_true")
    parser.add_argument("--inherit-fixture-fd", action="store_true")
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--inner")
    parser.add_argument("--heartbeat")
    parser.add_argument("--launch-ready")
    parser.add_argument("--scope-marker")
    parser.add_argument("--grant-check")
    parser.add_argument("--expect-grant", choices=("none", "write"))
    parser.add_argument("--child-operation", choices=("read", "connect"))
    parser.add_argument("--target")
    parser.add_argument("--self-check", action="store_true")
    options = parser.parse_args()
    if options.self_check:
        def verdict(bytecode, architecture, syscall):
            instructions = list(struct.iter_unpack("<HBBI", bytecode))
            index, accumulator = 0, 0
            while index < len(instructions):
                code, yes, no, value = instructions[index]
                if code == 0x20:
                    accumulator = architecture if value == 4 else syscall
                elif code == 0x06:
                    return value
                else:
                    matches = accumulator == value if code == 0x15 else bool(accumulator & value)
                    index += yes if matches else no
                index += 1
            raise AssertionError("过滤器缺少返回")

        for machine, architecture, sockets, socketpair, write in (
            ("x86_64", 0xC000003E, [41, 42, 44, 46, 307, 425], 53, 1),
            ("aarch64", 0xC00000B7, [198, 203, 206, 211, 269, 425], 199, 64),
        ):
            bytecode = seccomp_filter(machine)
            for syscall in sockets:
                assert verdict(bytecode, architecture, syscall) == 0x00050000 | errno.EPERM
            for syscall in (socketpair, write):
                assert verdict(bytecode, architecture, syscall) == 0x7FFF0000
            assert verdict(bytecode, architecture ^ 1, sockets[0]) == 0x80000000
            assert verdict(bytecode, architecture, 0x40000000 | sockets[0]) == 0x80000000
        try:
            seccomp_filter("unsupported")
        except RuntimeError:
            pass
        else:
            raise AssertionError("未知架构不能无过滤放行")
        assert decision([{"status": "unavailable"}]) == 2
        assert decision([{"status": "fail"}]) == 1
        assert decision([{"status": "pass"}]) == 0
        assert decision([{"status": "pass"} for _ in BOUNDARIES], infrastructure_ok=False) == 2
        assert collect("bwrap: Operation not permitted")[0] is False
        assert collect('{"started":true}\n{"probe":"workspace.write","status":"pass"}')[0] is True
        assert collect('{"started":true}\n{"probe":"workspace.write","status":"pass"}', 1)[0] is False
        assert child_result("test", "", "python3: not found", 127)["status"] == "unavailable"
        assert child_result("test", '{"started":true}', "", 1)["status"] == "unavailable"
        assert child_result("test", '{"started":true}\n{"denied":true,"errno":13}', "crash", 1)["status"] == "unavailable"
        assert child_result("test", '{"started":true}\n{"denied":true,"errno":13}', "", 0)["status"] == "pass"
        print("启动判定与 x86_64/aarch64 seccomp syscall、socketpair、arch/x32 护栏自检通过")
    elif options.inner:
        inner(json.loads(options.inner))
    elif options.heartbeat:
        print(json.dumps({"started": True}), flush=True)
        if options.scope_marker:
            cgroup = Path("/proc/self/cgroup").read_text().strip().split(":", 2)[2]
            Path(options.scope_marker).write_text(json.dumps({"started": True, "cgroup": cgroup}))
        if options.launch_ready:
            Path(options.launch_ready).write_text(json.dumps({"started": True}))
            while not Path(options.launch_ready + ".release").exists():
                time.sleep(0.05)
        heartbeat(options.heartbeat)
        time.sleep(30)
    elif options.grant_check:
        print(json.dumps({"started": True}), flush=True)
        results = []
        for operation in (lambda: Path(options.grant_check).read_text(),
                          lambda: Path(options.grant_check).write_text("rebuild-only-virtual-fixture")):
            operation_evidence = {}
            denied = inaccessible(operation, operation_evidence)
            results.append({"denied": denied, "errno": operation_evidence.get("errno")})
        expected = options.expect_grant == "none"
        name = "grant.rebuild-narrowed" if expected else "mode.rebuild"
        print(json.dumps(row(name, all(item["denied"] == expected for item in results),
                             f"started=true，旧单元已停止，替代沙箱读/写：{results}"), ensure_ascii=False), flush=True)
    elif options.child_operation:
        child_operation(options.child_operation, options.target)
    elif sys.platform != "linux":
        parser.error("必须在真实 Linux 环境运行；其他平台不能作为 Linux 边界证据")
    else:
        options.output_dir = options.output_dir or Path(__file__).resolve().parents[2] / "results"
        sys.exit(main(options))
