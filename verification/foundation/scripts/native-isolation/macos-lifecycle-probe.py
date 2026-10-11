#!/usr/bin/env python3
"""Seatbelt 后代回收夹具；回执只作漏记对照，不加入宿主累积集合。"""
import ctypes
import errno
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

SELF = str(Path(__file__).resolve())
PYTHON = str(Path(sys.executable).resolve())


class BsdInfo(ctypes.Structure):
    # Note: 见 .agents/notes/implemented/architecture/2026-10-10-native-execution-sandbox.md
    _fields_ = [(name, ctypes.c_uint32) for name in (
        "flags", "status", "xstatus", "pid", "ppid", "uid", "gid", "ruid", "rgid", "svuid", "svgid", "reserved")]
    _fields_ += [("comm", ctypes.c_char * 16), ("name", ctypes.c_char * 32)]
    _fields_ += [(name, ctypes.c_uint32) for name in ("nfiles", "pgid", "jobc", "tdev", "tpgid")]
    _fields_ += [("nice", ctypes.c_int32), ("start_sec", ctypes.c_uint64), ("start_usec", ctypes.c_uint64)]


class UniqueInfo(ctypes.Structure):
    _fields_ = [("uuid", ctypes.c_ubyte * 16), ("uniqueid", ctypes.c_uint64), ("parent_uniqueid", ctypes.c_uint64),
                ("pidversion", ctypes.c_int32), ("parent_pidversion", ctypes.c_int32),
                ("reserved2", ctypes.c_uint64), ("reserved3", ctypes.c_uint64)]


class ProcessInfo(ctypes.Structure):
    _fields_ = [("bsd", BsdInfo), ("unique", UniqueInfo)]


def identity(pid):
    lib = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
    lib.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
    info = ProcessInfo()
    count = lib.proc_pidinfo(pid, 18, 0, ctypes.byref(info), ctypes.sizeof(info))
    if count == 0 and ctypes.get_errno() == errno.ESRCH:
        return None
    if count != ctypes.sizeof(info):
        raise OSError(ctypes.get_errno(), f"proc_pidinfo({pid}) returned {count}")
    return {"pid": info.bsd.pid, "ppid": info.bsd.ppid, "pgid": info.bsd.pgid,
            "start": [info.bsd.start_sec, info.bsd.start_usec], "zombie": info.bsd.status == 5,
            "uniqueid": info.unique.uniqueid, "pidversion": info.unique.pidversion}


def same_process(left, right):
    return (left is not None and right is not None and left["pid"] == right["pid"]
            and left["start"] == right["start"] and left["uniqueid"] == right["uniqueid"])


def audited_signal(actual, sig):
    lib = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
    lib.proc_signal_with_audittoken.argtypes = [ctypes.c_void_p, ctypes.c_int]
    token = (ctypes.c_uint32 * 8)()
    token[5], token[7] = actual["pid"], actual["pidversion"]
    return lib.proc_signal_with_audittoken(ctypes.byref(token), sig)


def signal_identity(expected, sig):
    actual = identity(expected["pid"])
    if actual is None or actual["zombie"]:
        return "exited"
    if not same_process(expected, actual):
        return "identity-changed"
    result = audited_signal(actual, sig)
    if result == 0:
        return "signalled"
    if result == errno.ESRCH:
        current = identity(expected["pid"])
        if current is None or current["zombie"]:
            return "exited"
        return "signal-raced-with-exec" if same_process(expected, current) else "identity-changed"
    raise OSError(result, "proc_signal_with_audittoken")


def owner_processes():
    result = subprocess.run(["/bin/ps", "-axo", "pid=,uid="], capture_output=True, text=True, timeout=3)
    if result.returncode:
        raise RuntimeError(f"同 UID 快照失败: {result.returncode}")
    processes = []
    for line in result.stdout.splitlines():
        pid, uid = map(int, line.split())
        if uid == os.getuid():
            actual = identity(pid)
            if actual is not None and not actual["zombie"]:
                processes.append(actual)
    return processes


class TreeObserver:
    def __init__(self, root, baseline=None):
        self.root = root
        self.members = {root["pid"]: root}
        self.errors = []
        self.samples = 0
        self.maximum_gap = 0
        self.last_sample = time.monotonic()
        self.baseline = baseline if baseline is not None else owner_processes()

    def sample(self):
        now = time.monotonic()
        self.maximum_gap = max(self.maximum_gap, now - self.last_sample)
        self.last_sample = now
        self.samples += 1
        try:
            result = subprocess.run(["/bin/ps", "-axo", "pid=,ppid=,pgid="],
                                    capture_output=True, text=True, timeout=3)
            if result.returncode:
                raise RuntimeError(f"ps returned {result.returncode}")
            rows = [tuple(map(int, line.split())) for line in result.stdout.splitlines()]
            live_parents = set()
            group_trusted = False
            for pid, known in self.members.items():
                actual = identity(pid)
                if same_process(known, actual) and not actual["zombie"]:
                    live_parents.add(pid)
                    group_trusted |= actual["pgid"] == self.root["pgid"]
                elif actual is not None and not actual["zombie"]:
                    self.errors.append(f"PID {pid} 身份改变")
            changed = True
            while changed:
                changed = False
                for pid, ppid, pgid in rows:
                    if pid in live_parents or (ppid not in live_parents and not (group_trusted and pgid == self.root["pgid"])):
                        continue
                    actual = identity(pid)
                    if actual is None or actual["zombie"]:
                        continue
                    if actual["ppid"] != ppid or actual["pgid"] != pgid:
                        self.errors.append(f"PID {pid} 快照期间关系变化")
                        continue
                    prior = self.members.get(pid)
                    if prior is not None and not same_process(prior, actual):
                        self.errors.append(f"PID {pid} 被复用")
                        continue
                    self.members[pid] = actual
                    live_parents.add(pid)
                    changed = True
        except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired) as error:
            self.errors.append(str(error))

    def observe(self, seconds):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            self.sample()
            time.sleep(0.01)

    def stop(self):
        self.sample()
        results = {}
        for sig in (signal.SIGTERM, signal.SIGKILL):
            witnesses = [identity(pid) for pid in self.members]
            if any(same_process(self.members[item["pid"]], item) and item["pgid"] == self.root["pgid"]
                   and not item["zombie"] for item in witnesses if item is not None):
                try:
                    os.killpg(self.root["pgid"], sig)
                except ProcessLookupError:
                    pass
            for pid, expected in self.members.items():
                results[pid] = signal_identity(expected, sig)
            self.observe(0.1)
        alive = []
        for pid, expected in self.members.items():
            actual = identity(pid)
            if actual is not None and not actual["zombie"]:
                alive.append({"pid": pid, "same_identity": same_process(expected, actual)})
        orphans = []
        try:
            for actual in owner_processes():
                if actual["ppid"] != 1 or actual["start"] < self.root["start"] or actual["pid"] in self.members:
                    continue
                if not any(same_process(actual, prior) for prior in self.baseline):
                    orphans.append(actual)
        except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired) as error:
            self.errors.append(f"停止后未知孤儿核实失败: {error}")
        return {"signals": results, "alive": alive, "unknown_new_orphans": orphans, "samples": self.samples,
                "maximum_gap_seconds": round(self.maximum_gap, 4), "observation_errors": self.errors}


def receipt(workspace, event):
    with (Path(workspace) / "receipts").open("a") as output:
        output.write(json.dumps(event) + "\n")


def heartbeat(workspace, name, secret, port, ignore):
    if ignore:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
    event = {"started": True, "name": name, "pid": os.getpid(), "pgid": os.getpgrp(), "sid": os.getsid(0),
             "identity": identity(os.getpid())}
    try:
        Path(secret).read_bytes()
        event["file_errno"] = None
    except OSError as error:
        event["file_errno"] = error.errno
    import socket
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=2):
            event["network_errno"] = None
    except OSError as error:
        event["network_errno"] = error.errno
    receipt(workspace, event)
    with (Path(workspace) / name).open("a", buffering=1) as output:
        end = time.monotonic() + 15
        while time.monotonic() < end:
            output.write("heartbeat\n")
            time.sleep(0.025)


def fixture(workspace, case, secret, port, node, executable):
    receipt(workspace, {"started": True, "worker": os.getpid(), "case": case})
    args = [executable, "-I", SELF, "--heartbeat", workspace, "heartbeat", secret, str(port),
            "0" if case == "normal" else "1"]
    actions = [(os.POSIX_SPAWN_OPEN, fd, "/dev/null", os.O_WRONLY, 0) for fd in (1, 2)]
    if case in ("missed-intermediate", "observation-interrupted"):
        while not (Path(workspace) / "go").exists():
            time.sleep(0.001)
    if case in ("short-intermediate", "missed-intermediate", "observation-interrupted"):
        middle = os.fork()
        if middle == 0:
            attrs = {} if case == "short-intermediate" else {"setsid": True}
            child = os.posix_spawn(executable, args, os.environ, file_actions=actions, **attrs)
            receipt(workspace, {"intermediate": os.getpid(), "spawned": child})
            os._exit(0)
        os.waitpid(middle, 0)
    elif case in ("node-detached", "node-detached-short-parent"):
        script = """const fs=require('fs'),cp=require('child_process');
try {const p=cp.spawn('/bin/bash',['-c','exec "$@"','probe',...JSON.parse(process.argv[1])],{cwd:process.argv[3],detached:true,stdio:'pipe'});p.on('error',e=>fs.appendFileSync(process.argv[2],JSON.stringify({denied:e.code,errno:e.errno})+'\\n'));if(process.argv[4]==='hold')setInterval(()=>{},1000);else{p.stdout.destroy();p.stderr.destroy();p.unref();}}
catch(e){fs.appendFileSync(process.argv[2],JSON.stringify({denied:e.code,errno:e.errno})+'\\n');process.exitCode=1;}"""
        subprocess.Popen([node, "-e", script, json.dumps(args), str(Path(workspace) / "receipts"), workspace,
                          "hold" if case == "node-detached" else "release"])
    elif case == "direct-setsid":
        child = os.fork()
        if child == 0:
            try:
                os.setsid()
                os.execv(executable, args)
            except OSError as error:
                receipt(workspace, {"denied": "direct-setsid", "errno": error.errno})
                os._exit(0)
    else:
        attrs = {"setpgroup": 0} if case == "spawn-setpgroup" else {"setsid": True} if case == "spawn-setsid" else {}
        child = os.posix_spawn(executable, args, os.environ, file_actions=actions, **attrs)
        receipt(workspace, {"spawned": child})
    if case == "parent-crash":
        time.sleep(0.12)
        os._exit(23)
    if case != "startup-window":
        receipt(workspace, {"ready": True})
    time.sleep(15)


def read_receipts(workspace):
    path = Path(workspace) / "receipts"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line]


def run_case(policy, base, environment, secret, port, node, case, record):
    workspace = base / case
    workspace.mkdir()
    processes = []
    all_receipts = []
    targets = []
    details = []
    try:
        for label, restricted in (("control", False), ("restricted", True)):
            target = workspace / label
            target.mkdir()
            targets.append(target)
            command = [PYTHON, "-I", SELF, "--fixture", str(target), case, secret, str(port), node, PYTHON]
            if restricted:
                command = ["/usr/bin/sandbox-exec", "-p", policy, *command]
            baseline = owner_processes()
            process = subprocess.Popen(command, cwd=target, env=environment, start_new_session=True,
                                       stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
            processes.append(process)
            root = identity(process.pid)
            if root is None:
                raise RuntimeError("worker 在身份登记前退出")
            observer = TreeObserver(root, baseline)
            observer.observe(0.18)
            if case in ("missed-intermediate", "observation-interrupted"):
                (target / "go").touch()
                # 故意覆盖短命父进程；回执只核对漏记，不能修补生产观察集合。
                time.sleep(0.25)
                if case == "observation-interrupted":
                    observer.errors.append("测试注入观察中断，无法排除集合外后代")
            observer.observe(0.2)
            events = read_receipts(target)
            all_receipts.extend((target, event) for event in events if "name" in event)
            started = any(event.get("worker") == process.pid for event in events)
            denied = [event for event in events if "denied" in event]
            beats = [event for event in events if "name" in event]
            ready = any(event.get("ready") is True for event in events)
            parent_exit_before_stop = process.poll()
            if not started or (not beats and not denied):
                raise RuntimeError(f"{label} 未完整启动: {events}; {process.stderr.read() if process.poll() is not None else ''}")
            if denied:
                if not restricted or case != "direct-setsid":
                    raise RuntimeError(f"对照或非预期方式启动被拒绝: {denied}")
                valid = all(event["errno"] == errno.EPERM for event in denied)
                stopped = observer.stop()
                detail = {"label": label, "started": started, "result": "DENIED", "denied": denied,
                          "valid_denial": valid, "stop": stopped}
            else:
                before = [(target / event["name"]).stat().st_size for event in beats]
                observer.observe(0.15)
                running = all((target / event["name"]).stat().st_size > size for event, size in zip(beats, before))
                stopped = observer.stop()
                sizes = [(target / event["name"]).stat().st_size for event in beats]
                time.sleep(0.15)
                child_details = []
                for event, size in zip(beats, sizes):
                    actual = identity(event["pid"])
                    alive = actual is not None and not actual["zombie"]
                    grows = (target / event["name"]).stat().st_size > size
                    child_details.append({**event, "tree_accumulated": event["pid"] in observer.members,
                                          "alive_after_stop": alive, "heartbeat_grows_after_stop": grows})
                verified = not stopped["alive"] and not stopped["unknown_new_orphans"] and not stopped["observation_errors"]
                detail = {"label": label, "started": started, "running_heartbeat_control": running,
                          "result": "STOPPED" if verified else "UNVERIFIED", "occupancy_retained": not verified,
                          "worker_ready_before_stop": ready, "parent_exit_before_stop": parent_exit_before_stop,
                          "children": child_details, "stop": stopped}
                if not verified:
                    marker = target / "occupancy-held"
                    marker.write_text(json.dumps({"result": "UNVERIFIED", "workspace": str(target),
                                                  "report": "task.tool_process_unreaped", "replace_worker": False}) + "\n")
                    detail["occupancy_marker"] = str(marker)
            details.append(detail)
            process.wait(timeout=3)
        control, restricted = details
        valid_control = control.get("running_heartbeat_control") is True
        if case == "direct-setsid":
            passed = valid_control and restricted["result"] == "DENIED" and restricted["valid_denial"]
        elif case in ("missed-intermediate", "observation-interrupted", "node-detached-short-parent"):
            passed = valid_control and restricted["result"] == "UNVERIFIED" and restricted["occupancy_retained"] and any(
                not child["tree_accumulated"] and child["alive_after_stop"] and child["heartbeat_grows_after_stop"]
                for child in restricted["children"])
            passed &= bool(restricted["stop"]["unknown_new_orphans"])
        else:
            passed = valid_control and restricted["result"] == "STOPPED"
            passed &= all(not child["alive_after_stop"] and not child["heartbeat_grows_after_stop"]
                          for child in restricted["children"])
        if case == "startup-window":
            passed &= not restricted["worker_ready_before_stop"]
        if case == "parent-crash":
            passed &= restricted["parent_exit_before_stop"] == 23
        if "children" in restricted:
            passed &= all(child["file_errno"] in (errno.EPERM, errno.EACCES)
                          and child["network_errno"] in (errno.EPERM, errno.EACCES) for child in restricted["children"])
            passed &= all(child["file_errno"] is None and child["network_errno"] is None for child in control["children"])
        record(f"lifecycle.{case}", passed, {"control": control, "restricted": restricted})
        return passed
    except Exception as error:
        record(f"lifecycle.{case}", False, {"error": str(error), "partial_results": details}, unavailable=True)
        return False
    finally:
        cleanup = []
        for process in processes:
            if process.poll() is None:
                root = identity(process.pid)
                if root is not None:
                    observer = TreeObserver(root)
                    observer.stop()
                process.wait(timeout=3)
        receipts_complete = True
        all_receipts = []
        for target in targets:
            try:
                all_receipts.extend((target, event) for event in read_receipts(target) if "name" in event)
            except (OSError, json.JSONDecodeError):
                # 无法完整读取夹具回执时保留现场，不猜测未登记后代的身份。
                receipts_complete = False
        for target, event in all_receipts:
            actual = identity(event["pid"])
            if actual is not None and not actual["zombie"]:
                # 回执来自受测虚拟夹具，清理前仍核实命令及微秒出生时间。
                command = subprocess.run(["/bin/ps", "-p", str(event["pid"]), "-o", "command="],
                                         capture_output=True, text=True, timeout=3)
                if SELF in command.stdout and str(target) in command.stdout:
                    cleanup.append(signal_identity(event["identity"], signal.SIGKILL))
                else:
                    cleanup.append("identity-unverified")
        time.sleep(0.15)
        clean = receipts_complete
        for _, event in all_receipts:
            actual = identity(event["pid"])
            clean &= actual is None or actual["zombie"]
        record(f"lifecycle.{case}-fixture-cleanup", clean,
               {"signals": cleanup, "fixture_cleanup_only": True, "receipts_complete": receipts_complete}, unavailable=not clean)


def probe(policy, workspace, environment, secret, port, node, record):
    outcomes = {}
    for case in ("normal", "ignore-term", "spawn-setpgroup", "spawn-setsid", "node-detached", "node-detached-short-parent", "direct-setsid",
                 "short-intermediate", "missed-intermediate", "observation-interrupted", "startup-window",
                 "parent-crash", "mode-change", "grants-change"):
        outcomes[case] = run_case(policy, workspace, environment, secret, port, node, case, record)
    process = subprocess.Popen([PYTHON, "-I", "-c", "import time;time.sleep(5)"])
    try:
        actual = identity(process.pid)
        stale = {**actual, "start": [actual["start"][0], actual["start"][1] + 1]}
        result = signal_identity(stale, signal.SIGKILL)
        record("lifecycle.pid-reuse-identity-guard", result == "identity-changed" and process.poll() is None,
               {"actual": actual, "stale_identity": stale, "signal_result": result,
                "unrelated_process_alive": process.poll() is None,
                "scope": "真实 PID 的确定性出生时间不匹配；未强迫内核回卷 PID"})
        wrong_version = {**actual, "pidversion": actual["pidversion"] + 1}
        result = audited_signal(wrong_version, signal.SIGKILL)
        record("lifecycle.kernel-pidversion-guard", result == errno.ESRCH and process.poll() is None,
               {"errno": result, "unrelated_process_alive": process.poll() is None,
                "scope": "内核审计令牌拒绝错误 pidversion，防止查询与发信号间的 PID 复用"})
    finally:
        process.kill()
        process.wait()
    return outcomes


if __name__ == "__main__":
    if sys.argv[1] == "--heartbeat":
        heartbeat(sys.argv[2], sys.argv[3], sys.argv[4], int(sys.argv[5]), sys.argv[6] == "1")
    elif sys.argv[1] == "--fixture":
        fixture(sys.argv[2], sys.argv[3], sys.argv[4], int(sys.argv[5]), sys.argv[6], sys.argv[7])
