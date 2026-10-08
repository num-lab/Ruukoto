#!/usr/bin/env python3
"""虚拟材料 Seatbelt 探针：0=全部通过，1=边界失败，2=对照或启动不可用。"""
import ctypes
import errno
import json
import os
from pathlib import Path
import platform
import select
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import uuid

SBX = "/usr/bin/sandbox-exec"
SELF = str(Path(__file__).resolve())
PYTHON = str(Path(sys.executable).resolve())


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def attempt(operation, value):
    emit({"started": True})
    try:
        detail = "操作完成"
        if operation == "read":
            Path(value).read_bytes()
        elif operation == "write":
            Path(value).write_text("virtual-written\n")
        elif operation == "link":
            os.link(value[0], value[1])
        elif operation == "tcp":
            with socket.create_connection(("127.0.0.1", value), timeout=2):
                pass
        elif operation == "unix":
            with socket.socket(socket.AF_UNIX) as client:
                client.settimeout(2)
                client.connect(value)
        elif operation == "signal":
            os.kill(value, signal.SIGUSR1)
        elif operation == "pidpath":
            lib = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
            buffer = ctypes.create_string_buffer(4096)
            if lib.proc_pidpath(value, buffer, len(buffer)) <= 0:
                raise OSError(ctypes.get_errno(), "proc_pidpath")
        elif operation == "procargs":
            lib = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
            mib = (ctypes.c_int * 3)(1, 49, value)
            size = ctypes.c_size_t(65536)
            buffer = ctypes.create_string_buffer(size.value)
            if lib.sysctl(mib, 3, buffer, ctypes.byref(size), None, 0) < 0:
                raise OSError(ctypes.get_errno(), "sysctl(KERN_PROCARGS2)")
            if b"virtual-owner-token" not in buffer.raw[:size.value]:
                raise RuntimeError("对照进程参数未含虚拟凭据")
        elif operation == "mach":
            lib = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
            port = ctypes.c_uint()
            boot = ctypes.c_uint.in_dll(lib, "bootstrap_port").value
            rc = lib.bootstrap_look_up(boot, value.encode(), ctypes.byref(port))
            emit({"ok": rc == 0, "mach_code": rc, "detail": "bootstrap_look_up"})
            return
        elif operation == "shm":
            lib = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
            lib.shm_open.argtypes = [ctypes.c_char_p, ctypes.c_int]
            fd = lib.shm_open(value.encode(), os.O_RDONLY)
            if fd < 0:
                raise OSError(ctypes.get_errno(), "shm_open")
            os.close(fd)
        elif operation == "env":
            emit({"ok": os.environ.get("RUUKOTO_VIRTUAL_OWNER_TOKEN") == value,
                  "detail": "只检查测试注入的虚拟环境变量"})
            return
        elif operation == "fd":
            emit({"ok": os.read(value, 128) == b"virtual-fd-token\n",
                  "detail": "只检查测试注入的虚拟描述符"})
            return
        elif operation == "setpgid":
            os.setpgid(0, 0)
        elif operation == "setsid":
            os.setsid()
        elif operation == "command":
            result = subprocess.run(value, capture_output=True, text=True, timeout=10)
            if result.returncode:
                raise RuntimeError(f"命令返回 {result.returncode}: {result.stderr[:160]}")
            detail = result.stdout.strip()[:160]
        else:
            raise RuntimeError(f"未知操作 {operation}")
        emit({"ok": True, "detail": detail})
    except OSError as error:
        emit({"ok": False, "errno": error.errno, "detail": str(error)})
    except Exception as error:
        emit({"ok": False, "error": str(error)})


def heartbeat(path, forbidden_path, port):
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    record = {"pid": os.getpid(), "pgid": os.getpgrp(), "sid": os.getsid(0)}
    try:
        Path(forbidden_path).read_bytes()
        record["file_denial_errno"] = None
    except OSError as error:
        record["file_denial_errno"] = error.errno
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=2):
            record["network_denial_errno"] = None
    except OSError as error:
        record["network_denial_errno"] = error.errno
    end = time.monotonic() + 15
    with open(path, "a", buffering=1) as output:
        while time.monotonic() < end:
            output.write(json.dumps(record) + "\n")
            time.sleep(0.05)


def lifecycle_worker(workspace, executable, forbidden_path, port):
    children = []
    for name, attrs in (("normal", {}), ("setpgroup", {"setpgroup": 0}), ("setsid", {"setsid": True})):
        path = str(Path(workspace) / f"heartbeat-{name}")
        actions = [(os.POSIX_SPAWN_OPEN, fd, "/dev/null", os.O_WRONLY, 0) for fd in (1, 2)]
        pid = os.posix_spawn(executable, [executable, "-I", SELF, "--heartbeat", path, forbidden_path, str(port)],
                             os.environ, file_actions=actions, **attrs)
        child = {"name": name, "pid": pid, "path": path}
        children.append(child)
        emit({"spawned": child})
    emit({"started": True, "pid": os.getpid(), "pgid": os.getpgrp(),
          "sid": os.getsid(0), "children": children})
    time.sleep(15)


def lifecycle_probe(policy, workspace, environment, forbidden_path, port, record):
    def pid_exited(pid):
        state = subprocess.run(["/bin/ps", "-p", str(pid), "-o", "stat="],
                               capture_output=True, text=True, timeout=3)
        return state.returncode != 0 or state.stdout.strip().startswith("Z")

    process = subprocess.Popen([SBX, "-p", policy, PYTHON, "-I", SELF, "--lifecycle", str(workspace),
                                PYTHON, forbidden_path, str(port)],
                               start_new_session=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True, cwd=workspace, env=environment)
    children = []
    receipts_complete = False
    try:
        ready, _, _ = select.select([process.stdout], [], [], 10)
        if not ready:
            raise RuntimeError("生命周期 worker 未报告启动")
        while True:
            line = process.stdout.readline()
            if not line:
                raise RuntimeError("生命周期 worker 在启动回执前退出")
            header = json.loads(line)
            if "spawned" in header:
                children.append(header["spawned"])
            elif header.get("started") is True:
                if header.get("children") != children or len(children) != 3:
                    raise RuntimeError("完整启动回执与逐个 spawn 回执不一致")
                receipts_complete = True
                break
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and not all(Path(c["path"]).exists() for c in children):
            time.sleep(0.05)
        details = []
        for child in children:
            initial = json.loads(Path(child["path"]).read_text().splitlines()[0])
            if initial["pid"] != child["pid"]:
                raise RuntimeError("心跳 PID 与可信 spawn 回执不一致")
            details.append({"name": child["name"], **initial})
            for kind in ("file", "network"):
                code = initial[f"{kind}_denial_errno"]
                record(f"lifecycle.{child['name']}-{kind}-inheritance", code in (errno.EPERM, errno.EACCES),
                       {"pid": child["pid"], "errno": code, "control": "主探针已证明同一虚拟目标可访问"})
        before = [Path(c["path"]).stat().st_size for c in children]
        time.sleep(0.2)
        if not all(Path(c["path"]).stat().st_size > size for c, size in zip(children, before)):
            raise RuntimeError("停止前后代心跳对照未持续增长")
        os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=5)
        time.sleep(0.15)
        sizes = [Path(c["path"]).stat().st_size for c in children]
        time.sleep(0.5)
        for child, detail, size in zip(children, details, sizes):
            detail["heartbeat_grows_after_group_kill"] = Path(child["path"]).stat().st_size > size
            detail["pid_exited"] = pid_exited(child["pid"])
            detail.update(worker_pgid=header["pgid"], worker_sid=header["sid"])
            record(f"lifecycle.stop-{child['name']}-descendant",
                   not detail["heartbeat_grows_after_group_kill"] and detail["pid_exited"], detail)
    except Exception as error:
        stderr = process.stderr.read(240) if process.poll() is not None else ""
        record("lifecycle.actual-descendant-stop", False, f"{error}; {stderr}", unavailable=True)
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=5)
        for child in children:
            try:
                identity = subprocess.run(["/bin/ps", "-p", str(child["pid"]), "-o", "command="],
                                          capture_output=True, text=True, timeout=3)
                if SELF in identity.stdout and child["path"] in identity.stdout:
                    os.kill(child["pid"], signal.SIGKILL)
                elif identity.returncode == 0 and identity.stdout.strip():
                    record("lifecycle.cleanup-identity", False, f"PID {child['pid']} 身份已改变，拒绝向它发信号", unavailable=True)
            except ProcessLookupError:
                pass
        paths = [Path(child["path"]) for child in children if Path(child["path"]).exists()]
        sizes = [path.stat().st_size for path in paths]
        time.sleep(0.2)
        frozen = all(path.stat().st_size == size for path, size in zip(paths, sizes))
        exited = all(pid_exited(child["pid"]) for child in children)
        cleaned = frozen and exited and receipts_complete
        record("lifecycle.probe-cleanup", cleaned,
               {"heartbeat_frozen": frozen, "captured_pids_exited": exited,
                "all_spawn_receipts_verified": receipts_complete}, unavailable=not cleaned)


def main():
    output = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parents[2] / "results"
    output.mkdir(parents=True, exist_ok=True)
    report = {"timestamp": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "platform": platform.platform(),
              "kernel": platform.release(), "machine": platform.machine(), "python": PYTHON,
              "policy_scope": "候选 deny-default 文件/网络/IPC 策略；生命周期候选为 syscall 拒绝 + PGID 回收。",
              "limitations": ["仅当前 macOS 版本；未验证产品 WorkerLauncher、审批、恢复及 SubAgent 集成。",
                              "宿主工具链仅测试 --version 启动，不等价于真实 Git 操作或编译验收。",
                              "未实测 SysV IPC、生命周期启动窗口、父进程异常及模式或授予范围变化时的回收。",
                              "missing_probes=0 仅代表本脚本列举的探针无缺失，不代表覆盖工单全部要求。",
                              "失败只否决被测策略，不据此宣称所有 Seatbelt 策略都不可能。"], "probes": []}
    infrastructure = False
    temporary = None

    def record(name, passed, detail, unavailable=False):
        nonlocal infrastructure
        infrastructure |= unavailable
        report["probes"].append({"probe": name, "pass": passed, "unavailable": unavailable, "detail": detail})
        if temporary is not None and Path(temporary).exists() and (
                name.startswith("lifecycle.cleanup") or name == "lifecycle.actual-descendant-stop" or
                name == "lifecycle.probe-cleanup" and not passed):
            report["retained_probe_materials"] = str(Path(temporary).resolve())
        print(f"{'PASS' if passed else 'UNAVAILABLE' if unavailable else 'FAIL'} {name}: {detail}")

    def launch(operation, value, policy=None, grandchild=False):
        command = [PYTHON, "-I", SELF, "--attempt", operation, json.dumps(value)]
        if grandchild:
            command = ["/bin/sh", "-c", 'exec /bin/sh -c \'exec "$@"\' probe "$@"', "probe", *command]
        environment = clean_env if policy else {**clean_env, "RUUKOTO_VIRTUAL_OWNER_TOKEN": "virtual-owner-token"}
        if policy:
            command = [SBX, "-p", policy, *command]
        if operation == "fd":
            os.lseek(fake_fd, 0, os.SEEK_SET)
        try:
            result = subprocess.run(command, capture_output=True, text=True, timeout=12, cwd=workspace,
                                    env=environment, pass_fds=() if policy else (fake_fd,))
        except (OSError, subprocess.TimeoutExpired) as error:
            return {"stage": "launch", "detail": str(error)}
        try:
            lines = [json.loads(line) for line in result.stdout.splitlines()]
        except json.JSONDecodeError:
            lines = []
        if not lines or lines[0].get("started") is not True:
            stage = "profile-parse" if "syntax" in result.stderr or "unbound variable" in result.stderr else "launch"
            return {"stage": stage, "rc": result.returncode, "detail": result.stderr.strip()[:240]}
        if result.returncode != 0 or len(lines) != 2 or "ok" not in lines[1]:
            return {"stage": "probe-incomplete", "rc": result.returncode, "detail": result.stderr.strip()[:240]}
        return {"stage": "operation", **lines[1]}

    def pair(name, operation, value, expected, policy, grandchild=False, denial=(errno.EPERM, errno.EACCES)):
        control = launch(operation, value)
        if control.get("ok") is not True:
            record(name, False, {"control": control}, unavailable=True)
            return
        if operation == "link":
            Path(value[1]).unlink()
        restricted = launch(operation, value, policy, grandchild)
        if restricted.get("stage") != "operation":
            record(name, False, {"control": control, "restricted": restricted}, unavailable=True)
            return
        passed = restricted["ok"] is expected
        if not expected and denial is not None:
            passed &= restricted.get("errno") in denial or restricted.get("mach_code") == 1100
        record(name, passed, {"control": control, "restricted": restricted})

    if sys.platform != "darwin" or not os.access(SBX, os.X_OK):
        record("sandbox.available", False, "需要 macOS 与 /usr/bin/sandbox-exec", unavailable=True)
    else:
        temporary = tempfile.mkdtemp(prefix="ruukoto-native-macos-", dir="/tmp")
        try:
            root = Path(temporary).resolve()
            workspace, ro, rw, git, secret, private_tmp = (root / name for name in
                                                         ("workspace", "grant-ro", "grant-rw", "shared-git", "owner", "tmp"))
            for directory in (workspace, ro, rw, git, secret, private_tmp, workspace / "assigned"):
                directory.mkdir()
                (directory / "material").write_text("virtual-material\n")
            (workspace / "escape").symlink_to(secret / "material")
            (workspace / "readonly-alias").symlink_to(ro / "material")
            (secret / "fd-material").write_text("virtual-fd-token\n")
            fake_fd = os.open(secret / "fd-material", os.O_RDONLY)
            os.set_inheritable(fake_fd, True)
            clean_env = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(private_tmp),
                         "TMPDIR": str(private_tmp), "GIT_CONFIG_NOSYSTEM": "1"}
            aliases = str(root).replace("/private/tmp/", "/tmp/")
            report["path_normalization"] = {"requested": temporary, "canonical": str(root), "alias": aliases,
                                            "temporary_materials_cleaned_after_run": False}
            q = lambda path: json.dumps(str(path))
            runtime_roots = {"/System", "/usr/lib", "/usr/share", "/usr/bin", "/bin",
                             str(Path(sys.prefix).resolve()), str(Path(SELF).parent), "/Library/Developer",
                             "/private/var/select"}
            tools = {name: str(Path(shutil.which(name)).resolve()) if shutil.which(name) else None
                     for name in ("node", "git", "clang")}
            if tools["clang"]:
                selected = subprocess.run(["/usr/bin/xcrun", "--find", "clang"], capture_output=True, text=True, timeout=5)
                if selected.returncode == 0:
                    tools["clang"] = str(Path(selected.stdout.strip()).resolve())
            for executable in tools.values():
                if executable and not executable.startswith("/usr/bin/"):
                    runtime_roots.add(str(Path(executable).resolve().parent.parent))
                if executable:
                    dependencies = subprocess.run(["/usr/bin/otool", "-L", executable], capture_output=True, text=True, timeout=5)
                    for line in dependencies.stdout.splitlines()[1:]:
                        library = line.strip().split(" (", 1)[0]
                        if library.startswith("/") and Path(library).exists():
                            runtime_roots.update((str(Path(library).parent), str(Path(library).resolve().parent)))
            if Path("/Applications/Xcode.app").exists():
                runtime_roots.add("/Applications/Xcode.app")
            report["runtime_readonly_roots"] = sorted(runtime_roots)
            runtime_read = "\n".join(f"(allow file-read* (subpath {q(path)}))" for path in sorted(runtime_roots))
            ancestors = {"/dev"} | {str(parent) for path in (*runtime_roots, str(workspace), str(ro), str(rw), str(git), str(private_tmp))
                         for parent in Path(path).parents}
            parent_metadata = "\n".join(f"(allow file-read-metadata (literal {q(path)}))" for path in sorted(ancestors))

            def profile(read_paths, write_paths):
                reads = "\n".join(f"(allow file-read* (subpath {q(path)}))" for path in read_paths)
                writes = "\n".join(f"(allow file-write* (subpath {q(path)}))" for path in write_paths)
                return f'''(version 1)
(deny default)
(allow process-exec process-fork sysctl-read)
(deny sysctl-read (sysctl-name-regex #"^kern\\.proc.*"))
(allow signal (target self) (target same-sandbox))
(deny process-info*)
(allow process-info* (target self))
(allow file-read* (literal "/"))
(allow file-read* file-write* (literal "/dev/null"))
(deny syscall-unix (syscall-number SYS_setsid SYS_setpgid))
{parent_metadata}
{runtime_read}
{reads}
{writes}
'''

            candidate = profile((workspace, ro, rw, git, private_tmp), (workspace, rw, private_tmp))
            readonly = profile((workspace / "assigned", private_tmp), (private_tmp,))
            report["candidate_profile"] = candidate
            victim = subprocess.Popen([PYTHON, "-I", "-c", "import signal,time; signal.signal(signal.SIGUSR1,signal.SIG_IGN); print('ready',flush=True); time.sleep(60)"],
                                      stdout=subprocess.PIPE, text=True,
                                      env={**clean_env, "RUUKOTO_VIRTUAL_OWNER_TOKEN": "virtual-owner-token"})
            tcp, unix = socket.socket(), socket.socket(socket.AF_UNIX)
            lib = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
            lib.shm_open.argtypes = [ctypes.c_char_p, ctypes.c_int]
            mach_port = ctypes.c_uint()
            task = ctypes.c_uint.in_dll(lib, "mach_task_self_").value
            boot = ctypes.c_uint.in_dll(lib, "bootstrap_port").value
            mach_name = "org.ruukoto.native.probe." + uuid.uuid4().hex
            shm_name = "/ruukoto-probe-" + uuid.uuid4().hex[:12]
            shm_fd = -1
            try:
                if victim.stdout.readline().strip() != "ready":
                    raise RuntimeError("虚拟进程未就绪")
                tcp.bind(("127.0.0.1", 0))
                tcp.listen(128)
                unix.bind(str(workspace / "control.sock"))
                unix.listen(128)
                parsed = launch("read", str(secret / "material"), "(version 1)(undefined-probe-rule)")
                record("probe.profile-parse-classification", parsed.get("stage") == "profile-parse", parsed)
                not_started = launch("read", str(secret / "material"), "(version 1)(allow default)(deny process-exec)")
                record("probe.launch-failure-classification", not_started.get("stage") == "launch", not_started)
                for style, expression in (("literal", f'(literal {q(secret / "material")})'),
                                          ("subpath", f'(subpath {q(secret)})'),
                                          ("regex", f'(regex {q("^" + str(secret) + "/")})')):
                    legacy = f"(version 1)(allow default)(deny file-read* {expression})"
                    pair(f"legacy.canonical-read-{style}", "read", str(secret / "material"), False, legacy)
                pair("legacy.canonical-write", "write", str(secret / "material"), False,
                     f"(version 1)(allow default)(deny file-write* (subpath {q(secret)}))")
                pair("legacy.canonical-file-star", "read", str(secret / "material"), False,
                     f"(version 1)(allow default)(deny file* (literal {q(secret / 'material')}))")
                pair("legacy.grandchild-file-denial", "read", str(secret / "material"), False,
                     f"(version 1)(allow default)(deny file-read* (literal {q(secret / 'material')}))", grandchild=True)
                if aliases != str(root):
                    pair("legacy.noncanonical-rule-demonstration", "read", str(secret / "material"), True,
                         f"(version 1)(allow default)(deny file-read* (subpath {q(Path(aliases) / 'owner')}))")
                for name, path, writable in (("workspace", workspace, True), ("grant-ro", ro, False),
                                             ("grant-rw", rw, True), ("shared-git", git, False)):
                    pair(f"files.{name}.read", "read", str(path / "material"), True, candidate)
                    pair(f"files.{name}.write", "write", str(path / "material"), writable, candidate)
                for name, path in (("outside", secret / "material"), ("symlink", workspace / "escape"),
                                   ("tmp-alias", Path(aliases) / "owner" / "material"),
                                   ("parent-traversal", workspace / ".." / "owner" / "material")):
                    pair(f"files.{name}.read-denied", "read", str(path), False, candidate)
                    pair(f"files.{name}.write-denied", "write", str(path), False, candidate)
                pair("files.readonly-symlink-write-denied", "write", str(workspace / "readonly-alias"), False, candidate)
                pair("files.hardlink-source-denied", "link", [str(secret / "material"), str(workspace / "hardlink")], False, candidate)
                pair("subagent.assigned-read", "read", str(workspace / "assigned" / "material"), True, readonly)
                pair("subagent.sibling-read-denied", "read", str(workspace / "material"), False, readonly)
                pair("subagent.assigned-write-denied", "write", str(workspace / "assigned" / "material"), False, readonly)
                pair("network.loopback-denied", "tcp", tcp.getsockname()[1], False, candidate)
                pair("network.unix-in-workspace-denied", "unix", str(workspace / "control.sock"), False, candidate)
                pair("network.grandchild-loopback-denied", "tcp", tcp.getsockname()[1], False, candidate, grandchild=True)
                pair("credentials.environment-scrubbed", "env", "virtual-owner-token", False, candidate, denial=None)
                pair("credentials.descriptor-closed", "fd", fake_fd, False, candidate, denial=(errno.EBADF,))
                pair("control-plane.signal-denied", "signal", victim.pid, False, candidate)
                pair("control-plane.pidpath-denied", "pidpath", victim.pid, False, candidate)
                pair("control-plane.process-environment-denied", "procargs", victim.pid, False, candidate)
                rc = lib.mach_port_allocate(task, 1, ctypes.byref(mach_port))
                rc |= lib.mach_port_insert_right(task, mach_port.value, mach_port.value, 20)
                rc |= lib.bootstrap_register(boot, mach_name.encode(), mach_port.value)
                if rc:
                    record("ipc.mach-lookup-denied", False, f"自建 Mach 服务注册失败: {rc}", unavailable=True)
                else:
                    pair("ipc.mach-lookup-denied", "mach", mach_name, False, candidate)
                # macOS arm64 的 shm_open 是可变参数函数，mode 必须按可变参数 ABI 传递。
                shm_fd = lib.shm_open(shm_name.encode(), os.O_CREAT | os.O_EXCL | os.O_RDWR, ctypes.c_uint(0o600))
                if shm_fd < 0:
                    record("ipc.shared-memory-denied", False, f"shm_open 对照失败 errno={ctypes.get_errno()}", unavailable=True)
                else:
                    os.ftruncate(shm_fd, 16)
                    pair("ipc.shared-memory-denied", "shm", shm_name, False, candidate)
                for name, executable in tools.items():
                    if executable:
                        pair(f"toolchain.{name}", "command", [executable, "--version"], True, candidate)
                    else:
                        record(f"toolchain.{name}", False, "宿主未安装工具", unavailable=True)
                pair("lifecycle.setpgid-syscall-denied", "setpgid", None, False, candidate)
                pair("lifecycle.setsid-syscall-denied", "setsid", None, False, candidate)
                queue = select.kqueue()
                try:
                    try:
                        queue.control([select.kevent(victim.pid, filter=select.KQ_FILTER_PROC, flags=select.KQ_EV_ADD,
                                                    fflags=select.KQ_NOTE_FORK | select.KQ_NOTE_TRACK)], 0, 0)
                        record("lifecycle.kqueue-descendant-tracking", False,
                               "NOTE_TRACK 可注册，但尚未证明后代事件完整性", unavailable=True)
                    except OSError as error:
                        record("lifecycle.kqueue-descendant-tracking", False,
                               f"NOTE_TRACK 未支持 errno={error.errno}，无法用它补齐后代跟踪")
                finally:
                    queue.close()
                lifecycle_probe(candidate, workspace, clean_env, str(secret / "material"), tcp.getsockname()[1], record)
            except Exception as error:
                record("probe.controller", False, str(error), unavailable=True)
            finally:
                victim.kill()
                victim.wait()
                tcp.close()
                unix.close()
                os.close(fake_fd)
                if mach_port.value:
                    lib.bootstrap_register(boot, mach_name.encode(), 0)
                    lib.mach_port_destroy(task, mach_port.value)
                if shm_fd >= 0:
                    os.close(shm_fd)
                    lib.shm_unlink(shm_name.encode())
        finally:
            if "retained_probe_materials" not in report:
                shutil.rmtree(temporary)
                report["path_normalization"]["temporary_materials_cleaned_after_run"] = True
    required = {
        "probe.profile-parse-classification", "probe.launch-failure-classification",
        "legacy.canonical-write", "legacy.grandchild-file-denial", "legacy.noncanonical-rule-demonstration",
        "legacy.canonical-file-star",
        "files.readonly-symlink-write-denied", "files.hardlink-source-denied",
        "subagent.assigned-read", "subagent.sibling-read-denied", "subagent.assigned-write-denied",
        "network.loopback-denied", "network.unix-in-workspace-denied", "network.grandchild-loopback-denied",
        "credentials.environment-scrubbed", "credentials.descriptor-closed",
        "control-plane.signal-denied", "control-plane.pidpath-denied", "control-plane.process-environment-denied",
        "ipc.mach-lookup-denied", "ipc.shared-memory-denied",
        "lifecycle.setpgid-syscall-denied", "lifecycle.setsid-syscall-denied",
        "lifecycle.kqueue-descendant-tracking", "lifecycle.probe-cleanup",
    }
    required.update(f"legacy.canonical-read-{style}" for style in ("literal", "subpath", "regex"))
    required.update(f"files.{name}.{operation}" for name in ("workspace", "grant-ro", "grant-rw", "shared-git")
                    for operation in ("read", "write"))
    required.update(f"files.{name}.{operation}-denied" for name in ("outside", "symlink", "tmp-alias", "parent-traversal")
                    for operation in ("read", "write"))
    required.update(f"toolchain.{name}" for name in ("node", "git", "clang"))
    required.update(f"lifecycle.stop-{name}-descendant" for name in ("normal", "setpgroup", "setsid"))
    required.update(f"lifecycle.{name}-{kind}-inheritance" for name in ("normal", "setpgroup", "setsid")
                    for kind in ("file", "network"))
    report["missing_probes"] = sorted(required - {probe["probe"] for probe in report["probes"]})
    for missing in report["missing_probes"]:
        record(missing, False, "必测项未运行", unavailable=True)
    report["status"] = "unavailable" if infrastructure else "passed" if all(p["pass"] for p in report["probes"]) else "failed"
    report["summary"] = {"total": len(report["probes"]), "passed": sum(p["pass"] for p in report["probes"]),
                         "failed": sum(not p["pass"] and not p["unavailable"] for p in report["probes"]),
                         "unavailable": sum(p["unavailable"] for p in report["probes"])}
    json_path, md_path = output / "native-macos-report.json", output / "native-macos-report.md"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    lines = ["# macOS 原生沙箱真实探针", "", f"时间：{report['timestamp']}",
             f"环境：{report['platform']} / {report['kernel']} / {report['machine']}",
             f"结果：{report['status']}。本记录不能替代完整产品验收。", "", report["policy_scope"], "",
             f"通过 {report['summary']['passed']} / {report['summary']['total']}；失败 {report['summary']['failed']}；"
             f"不可用 {report['summary']['unavailable']}；缺失 {len(report['missing_probes'])}。", "",
             *report["limitations"], "", "| 探针 | 结果 | 证据 |", "| --- | --- | --- |"]
    for probe in report["probes"]:
        detail = json.dumps(probe["detail"], ensure_ascii=False).replace("|", "\\|")
        lines.append(f"| {probe['probe']} | {'PASS' if probe['pass'] else 'UNAVAILABLE' if probe['unavailable'] else 'FAIL'} | {detail} |")
    md_path.write_text("\n".join(lines) + "\n")
    print(f"判定：{report['status']}；报告 {json_path} / {md_path}")
    return 2 if infrastructure else 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--attempt":
        attempt(sys.argv[2], json.loads(sys.argv[3]))
    elif len(sys.argv) > 1 and sys.argv[1] == "--heartbeat":
        heartbeat(sys.argv[2], sys.argv[3], int(sys.argv[4]))
    elif len(sys.argv) > 1 and sys.argv[1] == "--lifecycle":
        lifecycle_worker(sys.argv[2], sys.argv[3], sys.argv[4], int(sys.argv[5]))
    else:
        sys.exit(main())
