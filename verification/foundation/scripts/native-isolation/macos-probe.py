#!/usr/bin/env python3
"""虚拟材料 Seatbelt 探针：0=全部通过，1=边界失败，2=对照或启动不可用。"""
import ctypes
import errno
import json
import os
from pathlib import Path
import platform
import runpy
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
        elif operation == "sysv-shm":
            lib = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
            lib.shmat.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_int]
            lib.shmat.restype = ctypes.c_void_p
            lib.shmdt.argtypes = [ctypes.c_void_p]
            address = lib.shmat(value, None, 0)
            if address == ctypes.c_void_p(-1).value:
                raise OSError(ctypes.get_errno(), "shmat")
            try:
                if ctypes.string_at(address, 13) != b"virtual-sysv\n":
                    raise RuntimeError("SysV 虚拟共享内存内容不匹配")
            finally:
                if lib.shmdt(address) < 0:
                    raise OSError(ctypes.get_errno(), "shmdt")
        elif operation == "sysv-sem":
            lib = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
            lib.semctl.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_int]
            if lib.semctl(value, 0, 5) < 0:
                raise OSError(ctypes.get_errno(), "semctl(GETVAL)")
        elif operation == "sysv-msg":
            class Message(ctypes.Structure):
                _fields_ = [("kind", ctypes.c_long), ("payload", ctypes.c_char * 16)]
            lib = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
            lib.msgsnd.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int]
            message = Message(1, b"virtual-sysv")
            if lib.msgsnd(value, ctypes.byref(message), 12, 0o4000) < 0:
                raise OSError(ctypes.get_errno(), "msgsnd")
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
        elif operation == "setuid-other":
            os.setuid(value)
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


def main():
    output = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parents[2] / "results"
    output.mkdir(parents=True, exist_ok=True)
    report = {"timestamp": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "platform": platform.platform(),
              "kernel": platform.release(), "machine": platform.machine(), "python": PYTHON,
              "policy_scope": "deny-default 文件/网络/IPC 策略；生命周期为原 PGID 与任务存活期进程树累积，逐 PID 核实微秒出生时间。",
              "limitations": ["仅当前 macOS 版本；未验证产品 WorkerLauncher、审批、恢复及 SubAgent 集成。",
                              "宿主工具链仅测试 --version 启动，不等价于真实 Git 操作或编译验收。",
                              "STOPPED 只证明本次夹具的原 PGID 与累积集合；漏记或观察中断返回 UNVERIFIED 并保留占用。",
                              "posix_spawn 属性位的集合外残留按拥有者接受范围单列；夹具清理不改写停止结论。",
                              "PID 复用使用真实 PID 的确定性出生时间不匹配；未强迫内核回卷 PID。",
                              "missing_probes=0 仅代表本脚本列举的探针无缺失，不代表覆盖工单全部要求。",
                              "创建硬链接拒绝不覆盖预存别名；预存只读文件硬链接的真实绕过另见 native-macos-preexisting-hardlink-report。",
                              "失败只否决被测策略，不据此宣称所有 Seatbelt 策略都不可能。"], "probes": []}
    infrastructure = False
    temporary = None

    def record(name, passed, detail, unavailable=False):
        nonlocal infrastructure
        infrastructure |= unavailable
        report["probes"].append({"probe": name, "pass": passed, "unavailable": unavailable, "detail": detail})
        retained = (isinstance(detail, dict) and detail.get("restricted", {}).get("occupancy_retained")
                    or unavailable and name.startswith("lifecycle."))
        if temporary is not None and Path(temporary).exists() and retained:
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
            stage = "profile-parse" if result.returncode == 65 else "launch"
            return {"stage": stage, "rc": result.returncode, "detail": result.stderr.strip()[:240]}
        if result.returncode != 0 or len(lines) != 2 or "ok" not in lines[1]:
            return {"stage": "probe-incomplete", "rc": result.returncode, "detail": result.stderr.strip()[:240]}
        return {"stage": "operation", "started": True, **lines[1]}

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
            data_alias = Path("/System/Volumes/Data") / str(root).lstrip("/")
            if not os.path.samefile(data_alias / "owner/material", secret / "material"):
                raise RuntimeError("Data 卷别名未指向同一虚拟资料，不能判定该拒绝")
            report["path_normalization"] = {"requested": temporary, "canonical": str(root), "alias": aliases,
                                            "data_volume_alias": str(data_alias), "data_volume_same_identity": True,
                                            "temporary_materials_cleaned_after_run": False}
            q = lambda path: json.dumps(str(path))
            runtime_roots = {"/System/Library", "/usr/lib", "/usr/share", "/usr/bin", "/bin",
                             str(Path(sys.prefix).resolve()), str(Path(SELF).parent), "/Library/Developer/CommandLineTools",
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
            sysv_objects = []
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
                                   ("system-data-alias", data_alias / "owner/material"),
                                   ("parent-traversal", workspace / ".." / "owner" / "material")):
                    pair(f"files.{name}.read-denied", "read", str(path), False, candidate)
                    pair(f"files.{name}.write-denied", "write", str(path), False, candidate)
                pair("files.readonly-symlink-write-denied", "write", str(workspace / "readonly-alias"), False, candidate)
                pair("files.hardlink-source-denied", "link", [str(secret / "material"), str(workspace / "hardlink")], False, candidate)
                pair("files.readonly-hardlink-source-denied", "link", [str(ro / "material"), str(workspace / "readonly-hardlink")], False, candidate)
                pair("files.shared-git-hardlink-source-denied", "link", [str(git / "material"), str(workspace / "shared-git-hardlink")], False, candidate)
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
                lib.shmat.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_int]
                lib.shmat.restype = ctypes.c_void_p
                lib.shmdt.argtypes = [ctypes.c_void_p]
                lib.semctl.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_int]
                for kind, create_args in (("shm", (0, 128, 0o600)), ("sem", (0, 1, 0o600)), ("msg", (0, 0o600))):
                    identifier = getattr(lib, kind + "get")(*create_args)
                    if identifier < 0:
                        record(f"ipc.sysv-{kind}-denied", False, {"creation_errno": ctypes.get_errno()}, unavailable=True)
                        continue
                    sysv_objects.append((kind, identifier))
                    if kind == "shm":
                        address = lib.shmat(identifier, None, 0)
                        if address == ctypes.c_void_p(-1).value:
                            record("ipc.sysv-shm-denied", False, {"control_attach_errno": ctypes.get_errno()}, unavailable=True)
                            continue
                        ctypes.memmove(address, b"virtual-sysv\n", 13)
                        if lib.shmdt(address) < 0:
                            raise OSError(ctypes.get_errno(), "对照 shmdt")
                    pair(f"ipc.sysv-{kind}-denied", "sysv-" + kind, identifier, False, candidate)
                for name, executable in tools.items():
                    if executable:
                        pair(f"toolchain.{name}", "command", [executable, "--version"], True, candidate)
                    else:
                        record(f"toolchain.{name}", False, "宿主未安装工具", unavailable=True)
                pair("lifecycle.setpgid-syscall-denied", "setpgid", None, False, candidate)
                pair("lifecycle.setsid-syscall-denied", "setsid", None, False, candidate)
                different_uid = 65534 if os.getuid() != 65534 else 65533
                identity_control = launch("setuid-other", different_uid)
                identity_restricted = launch("setuid-other", different_uid, candidate)
                record("lifecycle.owner-uid-change-os-denied",
                       all(result.get("started") is True and result.get("errno") == errno.EPERM
                           for result in (identity_control, identity_restricted)),
                       {"control": identity_control, "restricted": identity_restricted,
                        "scope": "宿主非特权身份本身不能换 UID；此项不计作 Seatbelt 特有拒绝"})
                queue = select.kqueue()
                try:
                    try:
                        queue.control([select.kevent(victim.pid, filter=select.KQ_FILTER_PROC, flags=select.KQ_EV_ADD,
                                                    fflags=select.KQ_NOTE_FORK | select.KQ_NOTE_TRACK)], 0, 0)
                        record("lifecycle.kqueue-descendant-tracking", False,
                               "NOTE_TRACK 可注册，但尚未证明后代事件完整性", unavailable=True)
                    except OSError as error:
                        record("lifecycle.kqueue-descendant-tracking", error.errno == errno.ENOTSUP,
                               {"result": "KNOWN_UNSUPPORTED", "errno": error.errno,
                                "used_for_stop_verification": False})
                finally:
                    queue.close()
                lifecycle = runpy.run_path(str(Path(SELF).with_name("macos-lifecycle-probe.py")))
                outcomes = lifecycle["probe"](candidate, workspace, clean_env, str(secret / "material"), tcp.getsockname()[1], tools["node"], record)
                if outcomes["mode-change"]:
                    pair("lifecycle.mode-change-rebuild-readonly", "write", str(workspace / "material"), False, readonly)
                if outcomes["grants-change"]:
                    reduced = profile((workspace, ro, git, private_tmp), (workspace, private_tmp))
                    pair("lifecycle.grants-change-rebuild-reduced", "write", str(rw / "material"), False, reduced)
                    pair("lifecycle.grants-change-rebuild-expanded", "write", str(rw / "material"), True, candidate)
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
                for kind, identifier in sysv_objects:
                    result = lib.semctl(identifier, 0, 0) if kind == "sem" else getattr(lib, kind + "ctl")(identifier, 0, None)
                    record(f"ipc.sysv-{kind}-cleanup", result == 0, {"rc": result, "errno": ctypes.get_errno() if result else None}, unavailable=result != 0)
        finally:
            if "retained_probe_materials" not in report:
                shutil.rmtree(temporary)
                report["path_normalization"]["temporary_materials_cleaned_after_run"] = True
    required = {
        "probe.profile-parse-classification", "probe.launch-failure-classification",
        "legacy.canonical-write", "legacy.grandchild-file-denial", "legacy.noncanonical-rule-demonstration",
        "legacy.canonical-file-star",
        "files.readonly-symlink-write-denied", "files.hardlink-source-denied",
        "files.readonly-hardlink-source-denied", "files.shared-git-hardlink-source-denied",
        "subagent.assigned-read", "subagent.sibling-read-denied", "subagent.assigned-write-denied",
        "network.loopback-denied", "network.unix-in-workspace-denied", "network.grandchild-loopback-denied",
        "credentials.environment-scrubbed", "credentials.descriptor-closed",
        "control-plane.signal-denied", "control-plane.pidpath-denied", "control-plane.process-environment-denied",
        "ipc.mach-lookup-denied", "ipc.shared-memory-denied", "ipc.sysv-shm-denied", "ipc.sysv-sem-denied", "ipc.sysv-msg-denied",
        "lifecycle.setpgid-syscall-denied", "lifecycle.setsid-syscall-denied",
        "lifecycle.kqueue-descendant-tracking", "lifecycle.pid-reuse-identity-guard", "lifecycle.kernel-pidversion-guard", "lifecycle.owner-uid-change-os-denied",
        "lifecycle.mode-change-rebuild-readonly", "lifecycle.grants-change-rebuild-reduced", "lifecycle.grants-change-rebuild-expanded",
    }
    required.update(f"legacy.canonical-read-{style}" for style in ("literal", "subpath", "regex"))
    required.update(f"files.{name}.{operation}" for name in ("workspace", "grant-ro", "grant-rw", "shared-git")
                    for operation in ("read", "write"))
    required.update(f"files.{name}.{operation}-denied" for name in ("outside", "symlink", "tmp-alias", "system-data-alias", "parent-traversal")
                    for operation in ("read", "write"))
    required.update(f"toolchain.{name}" for name in ("node", "git", "clang"))
    required.update(f"lifecycle.{name}{suffix}" for name in (
        "normal", "ignore-term", "spawn-setpgroup", "spawn-setsid", "node-detached", "node-detached-short-parent", "direct-setsid", "short-intermediate",
        "missed-intermediate", "observation-interrupted", "startup-window", "parent-crash", "mode-change", "grants-change")
        for suffix in ("", "-fixture-cleanup"))
    report["missing_probes"] = sorted(required - {probe["probe"] for probe in report["probes"]})
    for missing in report["missing_probes"]:
        record(missing, False, "必测项未运行", unavailable=True)
    report["status"] = "unavailable" if infrastructure else "passed" if all(p["pass"] for p in report["probes"]) else "failed"
    report["summary"] = {"total": len(report["probes"]), "passed": sum(p["pass"] for p in report["probes"]),
                         "failed": sum(not p["pass"] and not p["unavailable"] for p in report["probes"]),
                         "unavailable": sum(p["unavailable"] for p in report["probes"])}
    json_path, md_path = output / "native-macos-stage1-report.json", output / "native-macos-stage1-report.md"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    lines = ["# macOS 原生沙箱真实探针", "", f"时间：{report['timestamp']}",
             f"环境：{report['platform']} / {report['kernel']} / {report['machine']}",
             f"结果：{report['status']}。本记录不能替代完整产品验收。", "", report["policy_scope"], "",
             f"通过 {report['summary']['passed']} / {report['summary']['total']}；失败 {report['summary']['failed']}；"
             f"不可用 {report['summary']['unavailable']}；缺失 {len(report['missing_probes'])}。", "",
             *report["limitations"], "", "| 探针 | 结果 | 证据 |", "| --- | --- | --- |"]
    for probe in report["probes"]:
        detail = json.dumps(probe["detail"], ensure_ascii=False).replace("|", "\\|")
        outcome = "PASS" if probe["pass"] else "UNAVAILABLE" if probe["unavailable"] else "FAIL"
        if isinstance(probe["detail"], dict):
            stopped = probe["detail"].get("restricted", {}).get("result")
            if stopped is not None:
                outcome += " · " + stopped
                if stopped == "UNVERIFIED":
                    outcome += " · 占用保留"
        lines.append(f"| {probe['probe']} | {outcome} | {detail} |")
    md_path.write_text("\n".join(lines) + "\n")
    print(f"判定：{report['status']}；报告 {json_path} / {md_path}")
    return 2 if infrastructure else 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--attempt":
        attempt(sys.argv[2], json.loads(sys.argv[3]))
    else:
        sys.exit(main())
